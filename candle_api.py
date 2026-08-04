from __future__ import annotations

"""Generic OHLCV candle lookup for the "Analysis" chart module and Market
Replay, backed by the centralized SQLite candle store (market_data_store.py)
instead of a per-request CSV cache. Candles accumulate across requests -
a ticker/timeframe/date-range only ever needs to be fetched from MOEX once;
every later request (from any browser tab, any user) is served straight
from the indexed local database.

Still separate from the portfolio-builder's data pipeline (DATA_DIR /
FILENAME_RE / _local_data_index in app.py) on purpose: that pipeline is
keyed to a single hardcoded 10-minute interval per portfolio instrument and
its own file-based conventions feed the (already well-tested) backtest
engine. Changing what backtests read from is out of scope here - this
module only serves the chart/replay read path.
"""

import calendar
import time
from datetime import date
from pathlib import Path

import market_data_store as store
import market_data_sync as sync
from timeframes import AGGREGATE_TIMEFRAMES, TIMEFRAME_TO_MOEX_INTERVAL, canonical

# Re-exported for backward compatibility (older tests/callers import these
# from candle_api directly).
__all__ = ["TIMEFRAME_TO_MOEX_INTERVAL", "AGGREGATE_TIMEFRAMES", "get_candles", "tick_availability"]

DEFAULT_MARKET = "shares"
DEFAULT_ENGINE = "stock"

# How long a completed forward-sync stays "fresh enough" before a new
# request to the same (ticker, board, timeframe) triggers another MOEX
# round trip. Finer timeframes go stale faster (intraday bars keep forming).
_FRESHNESS_SECONDS = {
    "1m": 120, "10m": 300, "60m": 900,
    "1d": 6 * 3600, "1w": 12 * 3600, "1mo": 24 * 3600,
}


def _date_to_ts(d: str) -> int:
    # Naive-as-UTC convention (see market_data_sync.py) so this stays
    # consistent with how stored candle timestamps were computed.
    y, m, day = (int(x) for x in d.split("-"))
    return calendar.timegm((y, m, day, 0, 0, 0, 0, 0, 0))


def _ensure_coverage(ticker: str, board: str, timeframe: str, from_date: str, till_date: str,
                      market: str, engine: str) -> None:
    cov = store.coverage(ticker, board, timeframe)
    from_ts = _date_to_ts(from_date)
    till_ts = _date_to_ts(till_date) + 86399

    if cov["candle_count"] == 0:
        sync.sync_native_timeframe(ticker, board, timeframe, market=market, engine=engine,
                                    mode="initial", from_date=from_date, till_date=till_date)
        return

    state = store.get_sync_state(ticker, board, timeframe) or {}
    if from_ts < (cov["earliest_ts"] or from_ts) and not state.get("backfilled_complete"):
        older_till = date.fromtimestamp(cov["earliest_ts"]).isoformat()
        sync.sync_native_timeframe(ticker, board, timeframe, market=market, engine=engine,
                                    mode="initial", from_date=from_date, till_date=older_till)

    fresh_enough = bool(state.get("last_synced_at")) and \
        (time.time() - state["last_synced_at"]) < _FRESHNESS_SECONDS.get(timeframe, 3600)
    if till_ts > (cov["latest_ts"] or 0) and not fresh_enough:
        sync.sync_native_timeframe(ticker, board, timeframe, market=market, engine=engine,
                                    mode="continue", till_date=till_date)


def _aggregate(candles: list[dict], bucket_seconds: int) -> list[dict]:
    """Rolls up already-sorted-ascending OHLCV candles into `bucket_seconds`
    buckets: open=first, high=max, low=min, close=last, volume=sum. Since
    input is sorted ascending and bucket keys are non-decreasing with time,
    a single forward pass suffices - no bucket is ever revisited."""
    result: list[dict] = []
    current: dict | None = None
    for c in candles:
        key = (int(c["time"]) // bucket_seconds) * bucket_seconds
        if current is None or current["time"] != key:
            if current is not None:
                result.append(current)
            current = {"time": key, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"], "volume": c["volume"]}
        else:
            current["high"] = max(current["high"], c["high"])
            current["low"] = min(current["low"], c["low"])
            current["close"] = c["close"]
            current["volume"] += c["volume"]
    if current is not None:
        result.append(current)
    return result


def _get_aggregated_candles(*, ticker: str, board: str, timeframe: str, from_date: str, till_date: str,
                             limit: int, before: int | None, market: str, engine: str) -> dict:
    agg = AGGREGATE_TIMEFRAMES[timeframe]
    base_interval_seconds = TIMEFRAME_TO_MOEX_INTERVAL[agg["base"]] * 60
    factor = agg["bucket_seconds"] // base_interval_seconds
    base = get_candles(None, ticker=ticker, board=board, timeframe=agg["base"], from_date=from_date,
                        till_date=till_date, limit=limit * factor + factor, before=before, market=market, engine=engine)
    bars = _aggregate(base["candles"], agg["bucket_seconds"])
    # The oldest bucket can be partial if the base fetch was truncated
    # mid-bucket (base["nextCursor"] set): drop it instead of showing a
    # short/misleading bar. The lazy-load-older path re-requests it, this
    # time together with the rest of its base candles, on the next page.
    if base["nextCursor"] is not None and bars:
        bars = bars[1:]
    truncated = len(bars) > limit
    bars = bars[-limit:] if limit else bars
    next_cursor = bars[0]["time"] if bars and (truncated or base["nextCursor"] is not None) else None
    return {
        "candles": bars, "nextCursor": next_cursor,
        "hasOlder": next_cursor is not None,
        "hasNewer": base.get("hasNewer", False),
        "actualFrom": bars[0]["time"] if bars else None,
        "actualTill": bars[-1]["time"] if bars else None,
    }


def get_candles(data_dir: Path | None, *, ticker: str, board: str, timeframe: str, from_date: str, till_date: str,
                 limit: int, before: int | None = None, market: str = DEFAULT_MARKET,
                 engine: str = DEFAULT_ENGINE) -> dict:
    """Returns {"candles": [...], "nextCursor": int|None, "hasOlder": bool,
    "hasNewer": bool, "actualFrom": int|None, "actualTill": int|None} -
    unix-seconds OHLCV, ascending.

    `data_dir` is accepted (and ignored) for backward compatibility with
    existing call sites; candle data lives in the SQLite store now, not on
    a per-request filesystem path.

    from_date/till_date bound the window we're willing to serve; `before`
    (unix seconds), if given, additionally caps the latest bar returned so
    the frontend can page further into the past without re-fetching bars
    it already has.
    """
    ticker = ticker.upper()
    if timeframe in AGGREGATE_TIMEFRAMES:
        return _get_aggregated_candles(ticker=ticker, board=board, timeframe=timeframe, from_date=from_date,
                                        till_date=till_date, limit=limit, before=before, market=market, engine=engine)
    if timeframe not in TIMEFRAME_TO_MOEX_INTERVAL:
        raise ValueError(f"Неизвестный таймфрейм: {timeframe}")
    canon_tf = canonical(timeframe)

    _ensure_coverage(ticker, board, canon_tf, from_date, till_date, market, engine)

    from_ts = _date_to_ts(from_date)
    till_ts = _date_to_ts(till_date) + 86399
    candles = store.get_candles(ticker, board, canon_tf, ts_from=from_ts, ts_to=till_ts, before=before, limit=limit)

    cov = store.coverage(ticker, board, canon_tf)
    next_cursor = candles[0]["time"] if len(candles) == limit else None
    has_newer = bool(candles) and cov["latest_ts"] is not None and candles[-1]["time"] < cov["latest_ts"]
    return {
        "candles": candles,
        "nextCursor": next_cursor,
        "hasOlder": next_cursor is not None,
        "hasNewer": has_newer,
        "actualFrom": candles[0]["time"] if candles else None,
        "actualTill": candles[-1]["time"] if candles else None,
    }


def tick_availability(ticker: str) -> dict:
    """Honest tick-data availability report. MOEX ISS does not expose a
    historical trade-by-trade (tick) archive through this integration -
    only OHLCV candles - so this always reports unavailable rather than
    silently faking tick playback from candles."""
    return {
        "ticker": ticker.upper(),
        "available": False,
        "earliest": None,
        "latest": None,
        "reason": "Исторические тиковые данные (сделка за сделкой) недоступны через MOEX ISS "
                  "в этой интеграции - только агрегированные OHLCV-свечи. Market Replay "
                  "воспроизводит историю по свечам минимального доступного таймфрейма (1 минута).",
    }
