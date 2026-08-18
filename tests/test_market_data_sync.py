from __future__ import annotations

import pytest

import binance_client
import binance_market_data
import market_data_store as store
import market_data_sync as sync
from tests.binance_fixtures import fake_klines_request


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path):
    store.init_db(tmp_path / "candles.db")
    yield tmp_path


def test_initial_sync_persists_candles_and_marks_completed(monkeypatch):
    monkeypatch.setattr(binance_market_data, "request", fake_klines_request([]))

    result = sync.sync_native_timeframe("BTCUSDT", "1d", mode="initial",
                                         from_date="2025-01-01", till_date="2025-01-05")
    assert result["status"] == "completed"
    assert result["rows_added"] == 5
    state = store.get_sync_state("BTCUSDT", "1d")
    assert state["status"] == "completed"
    assert state["candle_count"] == 5


def test_full_backfill_from_earliest_plausible_date_marks_backfilled(monkeypatch):
    monkeypatch.setattr(binance_market_data, "request", fake_klines_request([]))

    sync.sync_native_timeframe("BTCUSDT", "1d", mode="initial",
                                from_date=sync.EARLIEST_PLAUSIBLE_DATE, till_date="2017-01-05")
    state = store.get_sync_state("BTCUSDT", "1d")
    assert state["backfilled_complete"] == 1


def test_malformed_klines_response_fails_loudly_instead_of_marking_backfilled(monkeypatch):
    """A malformed/non-list 200 response used to be silently treated as
    'zero rows in this window' by fetch_klines_page, and zero rows on an
    initial backward backfill reads as 'reached the true start of history' -
    permanently marking the symbol backfilled_complete even though the
    response was just broken, not an honest empty answer."""
    monkeypatch.setattr(binance_market_data, "request", lambda path, params=None, timeout=15, max_retries=5: {"unexpected": "shape"})

    result = sync.sync_native_timeframe("BTCUSDT", "1d", mode="initial",
                                         from_date=sync.EARLIEST_PLAUSIBLE_DATE, till_date="2017-01-05")
    assert result["status"] == "failed"
    state = store.get_sync_state("BTCUSDT", "1d")
    assert state["backfilled_complete"] == 0


def test_continue_mode_resumes_from_last_stored_bar(monkeypatch):
    calls = []
    monkeypatch.setattr(binance_market_data, "request", fake_klines_request(calls))

    sync.sync_native_timeframe("BTCUSDT", "1d", mode="initial",
                                from_date="2025-01-01", till_date="2025-01-05")
    n_after_first = len(calls)
    sync.sync_native_timeframe("BTCUSDT", "1d", mode="continue", till_date="2025-01-10")

    # Second sync's startTime must be near the last stored bar (2025-01-05),
    # not a full re-fetch from 2025-01-01 - resuming, not restarting.
    new_calls = calls[n_after_first:]
    assert new_calls
    from datetime import datetime, timezone
    resumed_from = datetime.fromtimestamp(int(new_calls[0]["startTime"]) / 1000, tz=timezone.utc)
    assert resumed_from.date().isoformat() >= "2025-01-04"


def test_retry_recovers_from_transient_failures(monkeypatch):
    """Exercises the real retry loop inside binance_client.request (not a
    test double standing in for it) by faking the transport one level down."""
    import requests

    class _FakeResponse:
        def __init__(self, status_code=200, json_data=None):
            self.status_code = status_code
            self._json_data = json_data if json_data is not None else []
            self.headers = {}

        def json(self):
            return self._json_data

    attempts = {"n": 0}

    def flaky_get(self, url, params=None, timeout=None):
        attempts["n"] += 1
        if attempts["n"] < 3:
            return _FakeResponse(500)
        rows = fake_klines_request([])(  # reuse the row-building logic for one page
            "/api/v3/klines", params=params
        )
        return _FakeResponse(200, rows)

    monkeypatch.setattr(requests.Session, "get", flaky_get)
    monkeypatch.setattr(binance_client.time, "sleep", lambda *_a, **_kw: None)
    # Force a fresh session so the monkeypatched Session.get is actually used.
    binance_client._session = None

    result = sync.sync_native_timeframe("BTCUSDT", "1d", mode="initial",
                                         from_date="2025-01-01", till_date="2025-01-03")
    assert result["status"] == "completed"
    assert result["rows_added"] == 3
    # 2 transient 500s + 1 successful page = 3 transport calls; the key
    # assertion is that the sync survived the first 2 failures via its own
    # retry loop, not a test double standing in for it.
    assert attempts["n"] == 3


def test_exhausted_retries_marks_job_failed_not_crashed(monkeypatch):
    import requests

    def always_fails(self, url, params=None, timeout=None):
        raise requests.ConnectionError("Binance unreachable")
    monkeypatch.setattr(requests.Session, "get", always_fails)
    monkeypatch.setattr(binance_client.time, "sleep", lambda *_a, **_kw: None)
    binance_client._session = None

    result = sync.sync_native_timeframe("BTCUSDT", "1d", mode="initial",
                                         from_date="2025-01-01", till_date="2025-01-03")
    assert result["status"] == "failed"
    assert result["error"]
    state = store.get_sync_state("BTCUSDT", "1d")
    assert state["status"] == "failed"
    assert state["last_error"]


def test_cancellation_keeps_partial_progress(monkeypatch):
    """Cancelling mid-sync must not discard candles already fetched and
    written - resuming later should continue, not start over."""
    def fake(path, params=None, timeout=15, max_retries=5):
        # A full 1000-row page every call (1s spacing) so the pagination
        # loop's "short page = done" termination never fires on its own -
        # only should_cancel can end this sync, exercising real cancellation
        # instead of relying on the range running out first.
        start_ms = int(params["startTime"])
        return [
            [start_ms + i * 1000, 100, 100, 100, 100, 10, start_ms + i * 1000 + 999, 1.0, 1, 1.0, 1.0, "0"]
            for i in range(1000)
        ]

    monkeypatch.setattr(binance_market_data, "request", fake)

    calls = {"n": 0}
    def cancel_after_two():
        calls["n"] += 1
        return calls["n"] > 2

    result = sync.sync_native_timeframe("BTCUSDT", "1d", mode="initial",
                                         from_date="2025-01-01", till_date="2025-01-10",
                                         should_cancel=cancel_after_two)
    assert result["status"] == "canceled"
    assert result["rows_added"] >= 1
    cov = store.coverage("BTCUSDT", "1d")
    assert cov["candle_count"] == result["rows_added"]


def test_upsert_deduplicates_on_primary_key():
    rows = [{"ts": 1000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 10}]
    added_first = store.upsert_candles("BTCUSDT", "1d", rows)
    added_second = store.upsert_candles("BTCUSDT", "1d", rows)
    assert added_first == 1
    assert added_second == 0
    assert store.coverage("BTCUSDT", "1d")["candle_count"] == 1
