from __future__ import annotations

"""Incremental Binance Spot klines sync into market_data_store.

Resumes from the last stored bar, retries transient Binance/network errors
with backoff (handled inside binance_client), and writes each page straight
into SQLite as it arrives - so an interrupted sync leaves real, usable
partial data behind instead of nothing.
"""

import time
from datetime import date, datetime, timedelta, timezone

import market_data_store as store
from binance_client import BinanceAPIError
from binance_market_data import fetch_klines_range
from timeframes import NATIVE_TIMEFRAMES, canonical

# Binance Spot launched mid-2017; a safe lower bound for "give me everything
# you have" that also matches the migration spec's "deep history" intent
# without pretending data exists before the exchange did.
EARLIEST_PLAUSIBLE_DATE = "2017-01-01"


class SyncCanceled(Exception):
    pass


def _date_to_ms(d: str) -> int:
    y, m, day = (int(x) for x in d.split("-"))
    return int(datetime(y, m, day, tzinfo=timezone.utc).timestamp() * 1000)


def _resolve_range(symbol: str, timeframe: str, *, mode: str, from_date: str | None,
                    till_date: str | None) -> tuple[str, str]:
    till = till_date or date.today().isoformat()
    if from_date:
        return from_date, till
    cov = store.coverage(symbol, timeframe)
    if mode in ("continue", "update") and cov["latest_ts"]:
        # Small 1-day overlap so an interrupted last page is safely re-fetched
        # (idempotent thanks to the PK-based dedup in upsert_candles).
        resume = datetime.fromtimestamp(cov["latest_ts"], tz=timezone.utc).date() - timedelta(days=1)
        return resume.isoformat(), till
    return EARLIEST_PLAUSIBLE_DATE, till


def sync_native_timeframe(symbol: str, timeframe: str, *, mode: str = "continue",
                           from_date: str | None = None, till_date: str | None = None,
                           progress_cb=None, should_cancel=None, max_pages: int | None = None) -> dict:
    """Fetches and stores one (symbol, timeframe) native series.
    Returns {"rows_added", "pages_fetched", "status", "error"}.

    `max_pages`, if given, stops the fetch loop after that many Binance
    pages even if `span_till` hasn't been reached yet, returning status
    "partial" instead of "completed" - a safety valve for callers invoked
    synchronously inside a request (candle_api._ensure_coverage's lazy-scroll
    backfill), so a wide from_date can't turn one /api/candles call into an
    unbounded multi-year crawl. Callers that really do want a full
    unattended backfill (the data-management "download history" job) simply
    don't pass it."""
    timeframe = canonical(timeframe)
    if timeframe not in NATIVE_TIMEFRAMES:
        raise ValueError(f"{timeframe} is not a native Binance timeframe (aggregate on read instead)")
    symbol = symbol.upper()
    span_from, span_till = _resolve_range(symbol, timeframe, mode=mode, from_date=from_date, till_date=till_date)
    start_ms = _date_to_ms(span_from)
    end_ms = _date_to_ms(span_till) + 86_399_000  # inclusive through the end of till_date, in ms

    store.update_sync_state(symbol, timeframe, status="running")
    started_at = time.time()

    rows_added = 0
    status = "completed"
    error_msg = None
    pages = 0

    def _on_page(page: list[dict]) -> None:
        nonlocal rows_added
        added = store.upsert_candles(symbol, timeframe, page)
        rows_added += added
        if progress_cb:
            progress_cb(pages=meta_holder["pages"], rows_added=rows_added, span_from=span_from, span_till=span_till)

    meta_holder = {"pages": 0}

    try:
        def _wrapped_on_page(page: list[dict]) -> None:
            meta_holder["pages"] += 1
            _on_page(page)

        result = fetch_klines_range(
            symbol, timeframe, start_ms=start_ms, end_ms=end_ms,
            max_pages=max_pages, should_cancel=should_cancel, on_page=_wrapped_on_page,
        )
        pages = result["pages_fetched"]
        status = result["status"]
    except SyncCanceled:
        status = "canceled"
    except BinanceAPIError as exc:
        status = "failed"
        error_msg = str(exc)
    except Exception as exc:  # noqa: BLE001 - surfaced to the job/UI, not silently swallowed
        status = "failed"
        error_msg = str(exc)
    finally:
        store.update_sync_state(symbol, timeframe, status=status, last_error=error_msg,
                                 mark_synced=(status == "completed"))
        # A bounded (max_pages-aware, windowed) backfill call's own span_from
        # rarely reaches EARLIEST_PLAUSIBLE_DATE directly - it's a chunk
        # right below whatever's already cached. Zero rows added on an
        # "initial" (backward) call is just as conclusive: Binance had
        # nothing in that whole window, so the symbol's real history doesn't
        # extend into it - there's nothing older to find by asking again.
        # Scoped to mode=="initial" only; a "continue" (forward freshness)
        # call legitimately sees rows_added==0 all the time (no new closed
        # bar yet) and must never be mistaken for "reached the start".
        if status == "completed" and mode == "initial" and (span_from <= EARLIEST_PLAUSIBLE_DATE or rows_added == 0):
            store.mark_backfilled(symbol, timeframe)
        store.log_sync_event(symbol, timeframe, started_at=started_at, finished_at=time.time(),
                              status=status, rows_added=rows_added, pages_fetched=pages, retries=0,
                              error=error_msg)
    return {"rows_added": rows_added, "pages_fetched": pages, "status": status, "error": error_msg}
