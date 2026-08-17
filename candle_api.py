from __future__ import annotations

"""Generic OHLCV candle lookup for the "Analysis" chart module, Backtest,
Portfolio Backtest, Optimizer and Market Replay - all of them go through
this one module, backed by the centralized SQLite candle store
(market_data_store.py). A symbol/timeframe/date-range only ever needs to be
fetched from Binance once; every later request (from any browser tab, any
user, any feature) is served straight from the indexed local database - see
docs/HISTORICAL_DATA.md for the unified-pipeline rationale.

Binance Spot trades 24/7: there is no trading-session gating here, and
unlike the old MOEX-era version of this module, no synthetic/gap-fill
candle is ever inserted for a missing bar. A gap in coverage stays a gap;
the frontend/API can report it honestly instead of a fabricated flat bar.
"""

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import market_data_store as store
import market_data_sync as sync
from binance_market_data import aggregate_candles
from timeframes import AGGREGATE_TIMEFRAMES, NATIVE_TIMEFRAMES, canonical

__all__ = ["get_candles", "tick_availability"]

# How long a completed forward-sync stays "fresh enough" before a new
# request to the same (symbol, timeframe) triggers another Binance round
# trip. Finer timeframes go stale faster (intraday bars keep forming).
_FRESHNESS_SECONDS = {
    "1m": 20, "3m": 45, "5m": 90, "15m": 300, "30m": 600,
    "1h": 900, "2h": 1800, "4h": 3600, "1d": 6 * 3600, "1w": 12 * 3600, "1mo": 24 * 3600,
}

# Initial "all history" chart requests are deliberately page-sized. The
# frontend may ask for a generous limit, but returning thousands of bars
# makes fitContent hit the time-scale compression floor on narrow/mobile
# charts and visually leaves only a short recent fragment. The chart engine
# already has cursor-based lazy loading to the left, so start with a useful
# recent window and let older history arrive only when needed. Explicit
# custom ranges and `before` pagination are never capped here.
_INITIAL_PAGE_LIMIT = {
    "1m": 1200, "3m": 1200, "5m": 1200, "10m": 1000, "15m": 900, "30m": 900,
    "1h": 800, "2h": 700, "4h": 600, "1d": 500, "1w": 260, "1mo": 120,
}

# Bounds how far back a single /api/candles request will backfill from
# Binance when the requested from_date reaches further back than what's
# cached. Every timeframe is windowed: even daily/weekly/monthly history is
# fetched progressively instead of making a cold chart download the
# symbol's entire lifetime before it can render. Repeated scroll-left
# requests extend the contiguous cached range one window at a time.
_BACKFILL_WINDOW_DAYS = {
    "1m": 14, "3m": 20, "5m": 30, "15m": 90, "30m": 180,
    "1h": 220, "2h": 365, "4h": 365 * 2, "1d": 365 * 8, "1w": 365 * 8, "1mo": 365 * 8,
}
# Belt-and-suspenders page cap on top of the window bound, in case a bounded
# window unexpectedly contains far more data than typical - never the
# primary bounding mechanism, just a hang guard.
_BACKFILL_MAX_PAGES = {
    "1m": 80, "3m": 80, "5m": 80, "15m": 80, "30m": 80,
    "1h": 80, "2h": 60, "4h": 60, "1d": 40, "1w": 20, "1mo": 20,
}


def _date_to_ts(d: str) -> int:
    y, m, day = (int(x) for x in d.split("-"))
    return int(datetime(y, m, day, tzinfo=timezone.utc).timestamp())


def _ensure_coverage(symbol: str, timeframe: str, from_date: str, till_date: str) -> None:
    from_ts = _date_to_ts(from_date)
    till_ts = _date_to_ts(till_date) + 86399
    window_days = _BACKFILL_WINDOW_DAYS.get(timeframe)
    max_pages = _BACKFILL_MAX_PAGES.get(timeframe)

    def _bounded_from(anchor_date: str) -> str:
        """The oldest date worth asking Binance for in one backfill call
        ending at `anchor_date`, given the timeframe's window bound - never
        older than what the caller actually requested (`from_date`)."""
        if window_days is None:
            return from_date
        anchor = date.fromisoformat(anchor_date)
        bounded = (anchor - timedelta(days=window_days)).isoformat()
        return max(bounded, from_date)

    # Serialize on (symbol, timeframe): a 6-tile chart layout or a
    # multi-symbol backtest kickoff can otherwise fire several requests for
    # the *same* missing range at once, each seeing "no coverage" and each
    # starting its own redundant Binance download. Whichever request gets
    # here first does the real sync; the rest block, then fall through to
    # the (now warm) freshness check below and skip re-fetching.
    lock = store.sync_lock(symbol, timeframe)
    with lock:
        cov = store.coverage(symbol, timeframe)

        if cov["candle_count"] == 0:
            # Cold symbol: prioritize the *recent* end first (what a fresh
            # chart actually needs to show immediately) rather than
            # ascending-from-from_date, which for a bounded window would
            # otherwise cache an old fragment and leave "today" empty.
            sync.sync_native_timeframe(symbol, timeframe, mode="initial",
                                        from_date=_bounded_from(till_date), till_date=till_date,
                                        max_pages=max_pages)
            return

        state = store.get_sync_state(symbol, timeframe) or {}
        if from_ts < (cov["earliest_ts"] or from_ts) and not state.get("backfilled_complete"):
            older_till = datetime.fromtimestamp(cov["earliest_ts"], tz=timezone.utc).date().isoformat()
            sync.sync_native_timeframe(symbol, timeframe, mode="initial",
                                        from_date=_bounded_from(older_till), till_date=older_till,
                                        max_pages=max_pages)

        fresh_enough = bool(state.get("last_synced_at")) and \
            (__import__("time").time() - state["last_synced_at"]) < _FRESHNESS_SECONDS.get(timeframe, 3600)
        if till_ts > (cov["latest_ts"] or 0) and not fresh_enough:
            sync.sync_native_timeframe(symbol, timeframe, mode="continue", till_date=till_date)


def _get_aggregated_candles(*, symbol: str, timeframe: str, from_date: str, till_date: str,
                             limit: int, before: int | None) -> dict:
    agg = AGGREGATE_TIMEFRAMES[timeframe]
    base_interval_seconds = _NATIVE_INTERVAL_SECONDS[agg["base"]]
    factor = agg["bucket_seconds"] // base_interval_seconds
    base = get_candles(None, symbol=symbol, timeframe=agg["base"], from_date=from_date, till_date=till_date,
                        limit=limit * factor + factor, before=before, _cap_initial=False)
    base_candles = [
        {"ts": c["time"], "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"],
         "volume": c["volume"], "quote_volume": c.get("quoteVolume") or 0, "num_trades": c.get("numTrades") or 0,
         "taker_buy_base_volume": c.get("takerBuyBaseVolume") or 0, "taker_buy_quote_volume": c.get("takerBuyQuoteVolume") or 0}
        for c in base["candles"]
    ]
    aggregated = aggregate_candles(base_candles, agg["bucket_seconds"])
    bars = [
        {"time": c["ts"], "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"],
         "volume": c["volume"], "quoteVolume": c["quote_volume"], "numTrades": c["num_trades"],
         "takerBuyBaseVolume": c["taker_buy_base_volume"], "takerBuyQuoteVolume": c["taker_buy_quote_volume"]}
        for c in aggregated
    ]
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


_NATIVE_INTERVAL_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800, "1mo": 2592000,
}


def get_candles(data_dir: Path | None, *, symbol: str, timeframe: str, from_date: str, till_date: str,
                 limit: int, before: int | None = None, _cap_initial: bool = True) -> dict:
    """Returns {"candles": [...], "nextCursor": int|None, "hasOlder": bool,
    "hasNewer": bool, "actualFrom": int|None, "actualTill": int|None} -
    unix-seconds OHLCV, ascending.

    `data_dir` is accepted (and ignored) for backward compatibility with
    existing call sites; candle data lives in the SQLite store now, not on
    a per-request filesystem path.

    from_date/till_date bound the window we're willing to serve; `before`
    (unix seconds), if given, additionally caps the latest bar returned so
    the frontend can page further into the past without re-fetching bars it
    already has. An implicit all-history initial request is page-capped;
    explicit ranges and pagination keep the caller's requested limit.
    """
    symbol = symbol.upper()
    is_all_history = from_date <= sync.EARLIEST_PLAUSIBLE_DATE
    if _cap_initial and before is None and is_all_history:
        limit = min(limit, _INITIAL_PAGE_LIMIT.get(timeframe, 500))
    if timeframe in AGGREGATE_TIMEFRAMES:
        return _get_aggregated_candles(symbol=symbol, timeframe=timeframe, from_date=from_date,
                                        till_date=till_date, limit=limit, before=before)
    canon_tf = canonical(timeframe)
    if canon_tf not in NATIVE_TIMEFRAMES:
        raise ValueError(f"Неизвестный таймфрейм: {timeframe}")

    _ensure_coverage(symbol, canon_tf, from_date, till_date)

    from_ts = _date_to_ts(from_date)
    till_ts = _date_to_ts(till_date) + 86399
    candles = store.get_candles(symbol, canon_tf, ts_from=from_ts, ts_to=till_ts, before=before, limit=limit)
    store.touch_access(symbol, canon_tf)

    cov = store.coverage(symbol, canon_tf)
    state = store.get_sync_state(symbol, canon_tf) or {}
    page_is_full = len(candles) == limit
    cached_older_exists = bool(candles) and cov["earliest_ts"] is not None and cov["earliest_ts"] < candles[0]["time"]
    uncached_older_may_exist = bool(candles) and is_all_history and not state.get("backfilled_complete") \
        and from_ts < candles[0]["time"]
    has_older = page_is_full or (is_all_history and (cached_older_exists or uncached_older_may_exist))
    next_cursor = candles[0]["time"] if candles and has_older else None
    has_newer = bool(candles) and cov["latest_ts"] is not None and candles[-1]["time"] < cov["latest_ts"]
    return {
        "candles": candles,
        "nextCursor": next_cursor,
        "hasOlder": next_cursor is not None,
        "hasNewer": has_newer,
        "actualFrom": candles[0]["time"] if candles else None,
        "actualTill": candles[-1]["time"] if candles else None,
    }


def tick_availability(symbol: str) -> dict:
    """Honest tick-data availability report. Binance's public klines
    endpoint exposes only aggregated OHLCV candles, not a historical
    trade-by-trade (tick) archive - so this always reports unavailable
    rather than silently faking tick playback from candles."""
    return {
        "symbol": symbol.upper(),
        "available": False,
        "earliest": None,
        "latest": None,
        "reason": "Исторические тиковые данные (сделка за сделкой) недоступны через публичный Binance "
                  "market-data API в этой интеграции - только агрегированные OHLCV-свечи. Market Replay "
                  "воспроизводит историю по свечам минимального доступного таймфрейма (1 минута).",
    }
