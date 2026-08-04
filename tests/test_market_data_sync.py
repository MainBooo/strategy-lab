from __future__ import annotations

import calendar
import time

import pytest
import requests

import market_data_store as store
import market_data_sync as sync


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path):
    store.init_db(tmp_path / "candles.db")
    yield tmp_path


def _page(from_date: str, till_date: str, freq_minutes: int = 24 * 60) -> dict:
    start = calendar.timegm(time.strptime(from_date, "%Y-%m-%d"))
    end = calendar.timegm(time.strptime(till_date, "%Y-%m-%d")) + 86399
    step = freq_minutes * 60
    columns = ["open", "close", "high", "low", "value", "volume", "begin", "end"]
    rows = []
    ts = start
    i = 0
    while ts <= end:
        begin = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts))
        rows.append([100 + i, 100.5 + i, 101 + i, 99 + i, 1.0, 1000, begin, begin])
        ts += step
        i += 1
    return {"columns": columns, "data": rows}


def test_initial_sync_persists_candles_and_marks_completed(monkeypatch):
    def fake_fetch(session, **kw):
        return _page(kw["from_date"], kw["till_date"]) if kw["start"] == 0 else {"columns": [], "data": []}
    monkeypatch.setattr(sync, "_fetch_page", fake_fetch)

    result = sync.sync_native_timeframe("SBER", "TQBR", "1d", mode="initial",
                                         from_date="2025-01-01", till_date="2025-01-05")
    assert result["status"] == "completed"
    assert result["rows_added"] == 5
    state = store.get_sync_state("SBER", "TQBR", "1d")
    assert state["status"] == "completed"
    assert state["candle_count"] == 5


def test_full_backfill_from_earliest_plausible_date_marks_backfilled(monkeypatch):
    def fake_fetch(session, **kw):
        return _page(kw["from_date"], kw["till_date"]) if kw["start"] == 0 else {"columns": [], "data": []}
    monkeypatch.setattr(sync, "_fetch_page", fake_fetch)

    sync.sync_native_timeframe("SBER", "TQBR", "1d", mode="initial",
                                from_date=sync.EARLIEST_PLAUSIBLE_DATE, till_date="2025-01-05")
    state = store.get_sync_state("SBER", "TQBR", "1d")
    assert state["backfilled_complete"] == 1


def test_continue_mode_resumes_from_last_stored_bar(monkeypatch):
    page_starts = []  # one entry per sync_native_timeframe call (its first, start=0 page)

    def fake_fetch(session, **kw):
        if kw["start"] == 0:
            page_starts.append(kw["from_date"])
            return _page(kw["from_date"], kw["till_date"])
        return {"columns": [], "data": []}
    monkeypatch.setattr(sync, "_fetch_page", fake_fetch)

    sync.sync_native_timeframe("SBER", "TQBR", "1d", mode="initial",
                                from_date="2025-01-01", till_date="2025-01-05")
    sync.sync_native_timeframe("SBER", "TQBR", "1d", mode="continue", till_date="2025-01-10")

    # Second sync's from_date must be near the last stored bar (2025-01-05),
    # not a full re-fetch from 2025-01-01 - resuming, not restarting.
    assert len(page_starts) == 2
    assert page_starts[1] >= "2025-01-04"


class _FakeResponse:
    def __init__(self, status_code=200, json_data=None):
        self.status_code = status_code
        self._json_data = json_data or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def json(self):
        return self._json_data


def test_retry_recovers_from_transient_failures(monkeypatch):
    """Exercises the real retry loop inside _fetch_page (not a test double
    standing in for it) by faking the transport one level down."""
    attempts = {"n": 0}

    def flaky_get(self, url, params=None, timeout=None):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise requests.ConnectionError("transient network blip")
        page = _page(params["from"], params["till"]) if params["start"] == 0 else {"columns": [], "data": []}
        return _FakeResponse(200, {"candles": page})
    monkeypatch.setattr(requests.Session, "get", flaky_get)
    monkeypatch.setattr(sync.time, "sleep", lambda *_a, **_kw: None)  # skip real backoff delay in the test

    result = sync.sync_native_timeframe("SBER", "TQBR", "1d", mode="initial",
                                         from_date="2025-01-01", till_date="2025-01-03")
    assert result["status"] == "completed"
    # 2 transient failures + 1 successful page-1 fetch + 1 terminating empty
    # page (page 2) = 4 total transport calls; the key assertion is that the
    # sync survived the first 2 failures via its own retry loop, not a test
    # double standing in for it.
    assert attempts["n"] == 4
    assert result["rows_added"] == 3


def test_exhausted_retries_marks_job_failed_not_crashed(monkeypatch):
    def always_fails(self, url, params=None, timeout=None):
        raise requests.ConnectionError("MOEX unreachable")
    monkeypatch.setattr(requests.Session, "get", always_fails)
    monkeypatch.setattr(sync.time, "sleep", lambda *_a, **_kw: None)

    result = sync.sync_native_timeframe("SBER", "TQBR", "1d", mode="initial",
                                         from_date="2025-01-01", till_date="2025-01-03")
    assert result["status"] == "failed"
    assert result["error"]
    state = store.get_sync_state("SBER", "TQBR", "1d")
    assert state["status"] == "failed"
    assert state["last_error"]


def test_cancellation_keeps_partial_progress(monkeypatch):
    """Cancelling mid-sync must not discard candles already fetched and
    written - resuming later should continue, not start over."""
    pages = {"n": 0}

    def fake_fetch(session, **kw):
        pages["n"] += 1
        # Emit one bar per page so we can observe partial progress.
        day = 1 + kw["start"]
        return {
            "columns": ["open", "close", "high", "low", "value", "volume", "begin", "end"],
            "data": [[100, 100, 100, 100, 1.0, 10, f"2025-01-{day:02d} 10:00:00", f"2025-01-{day:02d} 10:00:00"]],
        }
    monkeypatch.setattr(sync, "_fetch_page", fake_fetch)

    calls = {"n": 0}
    def cancel_after_two():
        calls["n"] += 1
        return calls["n"] > 2

    result = sync.sync_native_timeframe("SBER", "TQBR", "1d", mode="initial",
                                         from_date="2025-01-01", till_date="2025-01-10",
                                         should_cancel=cancel_after_two)
    assert result["status"] == "canceled"
    assert result["rows_added"] >= 1
    cov = store.coverage("SBER", "TQBR", "1d")
    assert cov["candle_count"] == result["rows_added"]


def test_upsert_deduplicates_on_primary_key():
    rows = [{"ts": 1000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 10}]
    added_first = store.upsert_candles("SBER", "TQBR", "1d", rows)
    added_second = store.upsert_candles("SBER", "TQBR", "1d", rows)
    assert added_first == 1
    assert added_second == 0
    assert store.coverage("SBER", "TQBR", "1d")["candle_count"] == 1
