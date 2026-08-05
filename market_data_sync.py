from __future__ import annotations

"""Incremental MOEX ISS candle sync into market_data_store.

Unlike downloader.py (which always re-downloads and re-writes a full CSV
for whatever range is requested), this module resumes from the last stored
bar, retries transient MOEX/network errors with backoff, and writes each
page straight into SQLite as it arrives - so an interrupted sync leaves
real, usable partial data behind instead of nothing.
"""

import calendar
import time
from datetime import date, timedelta

import requests

import market_data_store as store
from timeframes import TIMEFRAME_TO_MOEX_INTERVAL, NATIVE_TIMEFRAMES, canonical

BASE_URL = (
    "https://iss.moex.com/iss/engines/{engine}/markets/{market}/"
    "boards/{board}/securities/{ticker}/candles.json"
)

EARLIEST_PLAUSIBLE_DATE = "2000-01-01"
MAX_RETRIES = 5
RETRY_BASE_DELAY = 1.0
RETRY_MAX_DELAY = 30.0
PAGE_SLEEP = 0.08


class SyncCanceled(Exception):
    pass


def _fetch_page(session, *, engine, market, board, ticker, interval, from_date, till_date, start):
    last_exc = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = session.get(
                BASE_URL.format(engine=engine, market=market, board=board, ticker=ticker),
                params={
                    "from": from_date, "till": till_date, "interval": interval,
                    "start": start, "iss.only": "candles", "iss.meta": "off",
                },
                timeout=60,
            )
            if resp.status_code == 429 or resp.status_code >= 500:
                raise requests.HTTPError(f"MOEX temporary error {resp.status_code}", response=resp)
            resp.raise_for_status()
            return resp.json().get("candles", {})
        except (requests.RequestException,) as exc:
            last_exc = exc
            if attempt == MAX_RETRIES - 1:
                raise
            delay = min(RETRY_MAX_DELAY, RETRY_BASE_DELAY * (2 ** attempt))
            time.sleep(delay)
    raise last_exc  # pragma: no cover - unreachable, loop always returns or raises


def _resolve_range(ticker: str, board: str, timeframe: str, *, mode: str,
                    from_date: str | None, till_date: str | None) -> tuple[str, str]:
    till = till_date or date.today().isoformat()
    if from_date:
        return from_date, till
    cov = store.coverage(ticker, board, timeframe)
    if mode in ("continue", "update") and cov["latest_ts"]:
        # Small 1-day overlap so an interrupted last page is safely re-fetched
        # (idempotent thanks to the PK-based dedup in upsert_candles).
        resume = date.fromtimestamp(cov["latest_ts"]) - timedelta(days=1)
        return resume.isoformat(), till
    return EARLIEST_PLAUSIBLE_DATE, till


def sync_native_timeframe(ticker: str, board: str, timeframe: str, *, market: str = "shares",
                           engine: str = "stock", mode: str = "continue", from_date: str | None = None,
                           till_date: str | None = None, progress_cb=None, should_cancel=None,
                           max_pages: int | None = None) -> dict:
    """Fetches and stores one (ticker, board, timeframe) native series.
    Returns {"rows_added", "pages_fetched", "status", "error"}.

    `max_pages`, if given, stops the fetch loop after that many MOEX pages
    even if `span_till` hasn't been reached yet, returning status "partial"
    instead of "completed" - a safety valve for callers invoked synchronously
    inside a request (candle_api._ensure_coverage's lazy-scroll backfill),
    so a wide from_date (e.g. "give me the full history") can't turn one
    /api/candles call into an unbounded multi-year MOEX crawl. Callers that
    really do want a full unattended backfill (the admin sync job) simply
    don't pass it."""
    timeframe = canonical(timeframe)
    if timeframe not in NATIVE_TIMEFRAMES:
        raise ValueError(f"{timeframe} is not a native MOEX timeframe (aggregate on read instead)")
    interval = TIMEFRAME_TO_MOEX_INTERVAL[timeframe]
    span_from, span_till = _resolve_range(ticker, board, timeframe, mode=mode, from_date=from_date, till_date=till_date)

    store.update_sync_state(ticker, board, timeframe, market=market, engine=engine, status="running")
    started_at = time.time()
    session = requests.Session()
    session.headers.update({"User-Agent": "MOEX-Strategy-Lab/1.0", "Accept": "application/json"})

    rows_added = 0
    pages = 0
    retries_total = 0
    columns = None
    start = 0
    status = "completed"
    error_msg = None
    try:
        while True:
            if should_cancel and should_cancel():
                status = "canceled"
                raise SyncCanceled()
            batch_json = _fetch_page(session, engine=engine, market=market, board=board, ticker=ticker,
                                      interval=interval, from_date=span_from, till_date=span_till, start=start)
            if columns is None:
                columns = batch_json.get("columns", [])
            data = batch_json.get("data", [])
            pages += 1
            if not data:
                break
            rows = _rows_from_moex(columns, data)
            added = store.upsert_candles(ticker, board, timeframe, rows, market=market, engine=engine)
            rows_added += added
            start += len(data)
            if progress_cb:
                progress_cb(pages=pages, rows_added=rows_added, span_from=span_from, span_till=span_till)
            if max_pages is not None and pages >= max_pages:
                status = "partial"
                break
            time.sleep(PAGE_SLEEP)
    except SyncCanceled:
        pass
    except Exception as exc:  # noqa: BLE001 - surfaced to the job/UI, not silently swallowed
        status = "failed"
        error_msg = str(exc)
    finally:
        store.update_sync_state(ticker, board, timeframe, market=market, engine=engine, status=status,
                                 last_error=error_msg, mark_synced=(status == "completed"))
        # A bounded (max_pages-aware, windowed) backfill call's own span_from
        # rarely reaches EARLIEST_PLAUSIBLE_DATE directly - it's a chunk
        # right below whatever's already cached. Zero rows added on an
        # "initial" (backward) call is just as conclusive: MOEX had nothing
        # in that whole window, so the ticker's real history doesn't extend
        # into it - there's nothing older to find by asking again. Scoped to
        # mode=="initial" only; a "continue" (forward freshness) call
        # legitimately sees rows_added==0 all the time (market closed, no
        # new bar yet) and must never be mistaken for "reached the start".
        if status == "completed" and mode == "initial" and (span_from <= EARLIEST_PLAUSIBLE_DATE or rows_added == 0):
            store.mark_backfilled(ticker, board, timeframe)
        store.log_sync_event(ticker, board, timeframe, started_at=started_at, finished_at=time.time(),
                              status=status, rows_added=rows_added, pages_fetched=pages, retries=retries_total,
                              error=error_msg)
    return {"rows_added": rows_added, "pages_fetched": pages, "status": status, "error": error_msg}


def _rows_from_moex(columns: list[str], data: list[list]) -> list[dict]:
    idx = {c: i for i, c in enumerate(columns)}
    out = []
    for row in data:
        try:
            begin_raw = row[idx["begin"]]
            # Matches pandas' Timestamp(naive).timestamp() convention used
            # elsewhere in this codebase: the naive "YYYY-MM-DD HH:MM:SS"
            # string is treated AS IF it were UTC (it is actually MSK wall
            # time) so epoch seconds stay consistent with candle_api.py and
            # the frontend's UTC-formatted display. Using time.mktime here
            # instead would silently shift every bar by the server's local
            # UTC offset.
            ts = calendar.timegm(time.strptime(begin_raw, "%Y-%m-%d %H:%M:%S"))
            out.append({
                "ts": ts,
                "open": row[idx["open"]], "high": row[idx["high"]],
                "low": row[idx["low"]], "close": row[idx["close"]],
                "volume": row[idx.get("volume", -1)] if "volume" in idx else 0,
                "value": row[idx["value"]] if "value" in idx else None,
            })
        except (KeyError, TypeError, ValueError):
            continue
    return out
