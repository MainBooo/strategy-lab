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
from datetime import date, datetime, timedelta
from pathlib import Path

import market_data_store as store
import market_data_sync as sync
import market_ticker
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


# Initial "all history" chart requests are deliberately page-sized. The
# frontend may ask for a generous limit (historically 5000), but returning
# thousands of bars makes fitContent hit the time-scale compression floor on
# narrow/mobile charts and visually leaves only a short recent fragment. The
# chart engine already has cursor-based lazy loading to the left, so start
# with a useful recent window and let older history arrive only when needed.
# Explicit custom ranges and `before` pagination are never capped here.
_INITIAL_PAGE_LIMIT = {
    "1m": 1200,
    "10m": 1000,
    "30m": 900,
    "60m": 800,
    "4h": 600,
    "1d": 500,
    "1w": 260,
    "1mo": 120,
}

# Bounds how far back a single /api/candles request will backfill from MOEX
# when the requested from_date reaches further back than what's cached.
# Every timeframe is windowed: even daily/weekly/monthly history is fetched
# progressively instead of making a cold chart download the instrument's
# entire lifetime before it can render. Repeated scroll-left requests extend
# the contiguous cached range one window at a time.
#
# MOEX candles.json only paginates forward (ascending from `from`, via
# `start`), with no descending/reverse option. Bounding the window adjacent
# to the cached range therefore matters: a raw page-count cutoff from 2000
# would fetch the oldest fragment first and leave a hole before recent data.
_BACKFILL_WINDOW_DAYS = {
    "1m": 14,
    "10m": 45,
    "60m": 220,
    "1d": 730,
    "1w": 365 * 5,
    "1mo": 365 * 10,
}
# Belt-and-suspenders page cap on top of the window bound, in case a bounded
# window unexpectedly contains far more data than typical (e.g. a data
# anomaly) - never the primary bounding mechanism, just a hang guard.
_BACKFILL_MAX_PAGES = {"1m": 80, "10m": 80, "60m": 120, "1d": 40, "1w": 20, "1mo": 20}


def _ensure_coverage(ticker: str, board: str, timeframe: str, from_date: str, till_date: str,
                      market: str, engine: str) -> None:
    from_ts = _date_to_ts(from_date)
    till_ts = _date_to_ts(till_date) + 86399
    window_days = _BACKFILL_WINDOW_DAYS.get(timeframe)
    max_pages = _BACKFILL_MAX_PAGES.get(timeframe)

    def _bounded_from(anchor_date: str) -> str:
        """The oldest date worth asking MOEX for in one backfill call ending
        at `anchor_date`, given the timeframe's window bound - never older
        than what the caller actually requested (`from_date`)."""
        if window_days is None:
            return from_date
        anchor = date.fromisoformat(anchor_date)
        bounded = (anchor - timedelta(days=window_days)).isoformat()
        return max(bounded, from_date)

    # Serialize on (ticker, board, timeframe): a 6-tile chart layout or a
    # multi-ticker backtest kickoff can otherwise fire several requests for
    # the *same* missing range at once, each seeing "no coverage" and each
    # starting its own redundant MOEX download. Whichever request gets here
    # first does the real sync; the rest block, then fall through to the
    # (now warm) freshness check below and skip re-fetching.
    lock = store.sync_lock(ticker, board, timeframe)
    with lock:
        cov = store.coverage(ticker, board, timeframe)

        if cov["candle_count"] == 0:
            # Cold ticker: prioritize the *recent* end first (what a fresh
            # chart actually needs to show immediately) rather than
            # ascending-from-from_date, which for a bounded window would
            # otherwise cache an old fragment and leave "today" empty.
            sync.sync_native_timeframe(ticker, board, timeframe, market=market, engine=engine,
                                        mode="initial", from_date=_bounded_from(till_date), till_date=till_date,
                                        max_pages=max_pages)
            return

        state = store.get_sync_state(ticker, board, timeframe) or {}
        if from_ts < (cov["earliest_ts"] or from_ts) and not state.get("backfilled_complete"):
            older_till = date.fromtimestamp(cov["earliest_ts"]).isoformat()
            sync.sync_native_timeframe(ticker, board, timeframe, market=market, engine=engine,
                                        mode="initial", from_date=_bounded_from(older_till), till_date=older_till,
                                        max_pages=max_pages)

        fresh_enough = bool(state.get("last_synced_at")) and \
            (time.time() - state["last_synced_at"]) < _FRESHNESS_SECONDS.get(timeframe, 3600)
        sync_status = state.get("status")
        if till_ts > (cov["latest_ts"] or 0) and not fresh_enough:
            result = sync.sync_native_timeframe(ticker, board, timeframe, market=market, engine=engine,
                                                 mode="continue", till_date=till_date)
            sync_status = result.get("status")

        # Gap-fill only after the real-data sync attempt above (if any) is
        # accounted for, and only with its actual outcome - a failed sync
        # must surface as "Ошибка обновления", never be smoothed over by a
        # fake flat candle (see the module's "критическое уточнение" spec).
        _fill_synthetic_gaps(ticker, board, timeframe, market, engine, sync_ok=(sync_status != "failed"))


# Native intraday timeframes with a fixed bucket width - the ones the
# "критическое уточнение" spec's gap-fill applies to. 1d/1w/1mo are
# excluded: a day/week/month with zero trades is just a closed session
# (already handled by not calling MOEX for dates outside it), not a
# "формируется свеча" situation inside an otherwise-open session.
_GAP_FILL_BUCKET_SECONDS = {"1m": 60, "10m": 600, "60m": 3600}
# Safety valve so one request can't spin filling years of history after a
# long-dead ticker's cache is touched again - catches up gradually across
# subsequent requests/polls instead of blocking one for a long loop.
_GAP_FILL_MAX_BUCKETS = 60


def _msk_wall_in_session(dt: datetime) -> bool:
    """Same weekday/hours rule as market_ticker.is_trading_session, but
    applied directly to a naive MSK-wall-clock value with no +3h shift -
    stored candle timestamps already ARE naive MSK wall time treated as UTC
    (see market_data_sync._rows_from_moex), so re-applying is_trading_session
    (which expects genuine UTC and adds 3h itself) here would double-shift
    the bucket into the wrong session window. Doesn't know about exchange
    holidays for the same honestly-disclosed reason as is_trading_session."""
    if dt.weekday() >= 5:
        return False
    minutes = dt.hour * 60 + dt.minute
    return 10 * 60 <= minutes <= 23 * 60 + 50


def _fill_synthetic_gaps(ticker: str, board: str, timeframe: str, market: str, engine: str, *,
                          sync_ok: bool) -> None:
    """Keeps a native intraday timeline advancing on schedule during an
    active session even when MOEX genuinely has no candle for a completed
    bucket (an illiquid name with no trades in that interval): inserts a
    flat, explicitly-marked synthetic candle at the previous close with
    zero volume, so a 10-minute chart still gets a new bar every 10 minutes
    of trading time instead of silently stalling at the last real trade -
    which is what previously made a merely-illiquid ticker's realtime badge
    climb to a misleading "1.7 hours" instead of showing "нет сделок 1 ч 42
    мин". A real candle for the same bucket, whenever MOEX does report one,
    always overwrites the synthetic placeholder (see store.upsert_candles).

    Deliberately never fills:
    - before the ticker has at least one real stored candle (cold ticker -
      handled by the early return in _ensure_coverage before this is called);
    - when the immediately-preceding sync attempt failed (sync_ok=False) -
      an unknown gap must read as "Ошибка обновления", not silently as "no
      trades";
    - buckets whose own wall-clock start falls outside the trading session
      (weekend/pre-market/after-hours - checked per-bucket, not just "now",
      so a request made *during* a session never back-fills the overnight
      gap before it as if it were empty trading time);
    - while the instrument itself is reported as suspended by the realtime
      board feed (best-effort - a failed/unknown lookup never blocks a fill
      it would otherwise be safe to do)."""
    bucket = _GAP_FILL_BUCKET_SECONDS.get(timeframe)
    if bucket is None or not sync_ok:
        return
    cov = store.coverage(ticker, board, timeframe)
    if not cov["latest_ts"]:
        return  # cold ticker - nothing stored to extend forward from

    now_utc = datetime.utcnow()
    delayed_msk_wall = now_utc + timedelta(hours=3) - timedelta(milliseconds=market_ticker.SOURCE_DELAY_MS)
    last_closed_bucket = (calendar.timegm(delayed_msk_wall.timetuple()) // bucket) * bucket

    next_ts = cov["latest_ts"] + bucket
    if next_ts > last_closed_bucket:
        return  # nothing the source-delay cutoff confirms is closed yet

    try:
        quote = market_ticker.get_prices([ticker])["prices"].get(ticker)
        if quote and quote.get("trading_status") not in (None, "T"):
            return  # instrument temporarily suspended - leave a real gap, don't guess
    except Exception:
        pass  # best-effort only - a lookup failure must never block a fill

    latest_rows = store.get_candles(ticker, board, timeframe, ts_from=cov["latest_ts"],
                                     ts_to=cov["latest_ts"], limit=1)
    if not latest_rows:
        return
    prev_close = latest_rows[0]["close"]

    rows = []
    ts = next_ts
    steps = 0
    while ts <= last_closed_bucket and steps < _GAP_FILL_MAX_BUCKETS:
        if _msk_wall_in_session(datetime.utcfromtimestamp(ts)):
            rows.append({"ts": ts, "open": prev_close, "high": prev_close, "low": prev_close, "close": prev_close})
        ts += bucket
        steps += 1
    if rows:
        store.upsert_synthetic_candles(ticker, board, timeframe, rows, market=market, engine=engine)


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
                        till_date=till_date, limit=limit * factor + factor, before=before,
                        market=market, engine=engine, _cap_initial=False)
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
                 engine: str = DEFAULT_ENGINE, _cap_initial: bool = True) -> dict:
    """Returns {"candles": [...], "nextCursor": int|None, "hasOlder": bool,
    "hasNewer": bool, "actualFrom": int|None, "actualTill": int|None} -
    unix-seconds OHLCV, ascending.

    `data_dir` is accepted (and ignored) for backward compatibility with
    existing call sites; candle data lives in the SQLite store now, not on
    a per-request filesystem path.

    from_date/till_date bound the window we're willing to serve; `before`
    (unix seconds), if given, additionally caps the latest bar returned so
    the frontend can page further into the past without re-fetching bars
    it already has. An implicit all-history initial request is page-capped;
    explicit ranges and pagination keep the caller's requested limit.
    """
    ticker = ticker.upper()
    if _cap_initial and before is None and from_date <= sync.EARLIEST_PLAUSIBLE_DATE:
        limit = min(limit, _INITIAL_PAGE_LIMIT.get(timeframe, 500))
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
    store.touch_access(ticker, board, canon_tf)

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
