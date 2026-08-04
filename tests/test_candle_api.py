from __future__ import annotations

import calendar
import time

import pytest

import candle_api
import market_data_store as store


def _moex_json(from_date: str, till_date: str, freq_minutes: int = 24 * 60) -> dict:
    """Builds one page of MOEX-shaped candles.json data covering [from_date,
    till_date] at freq_minutes spacing - enough for a single-page fake."""
    start = calendar.timegm(time.strptime(from_date, "%Y-%m-%d"))
    end = calendar.timegm(time.strptime(till_date, "%Y-%m-%d")) + 86399
    step = freq_minutes * 60
    columns = ["open", "close", "high", "low", "value", "volume", "begin", "end"]
    rows = []
    ts = start
    i = 0
    while ts <= end:
        begin = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts))
        rows.append([100 + i, 100.5 + i, 101 + i, 99 + i, 12345.0, 1000 + i, begin, begin])
        ts += step
        i += 1
    return {"columns": columns, "data": rows}


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path):
    store.init_db(tmp_path / "candles.db")
    yield tmp_path


def _patch_fetch(monkeypatch, calls, *, freq_minutes=24 * 60):
    """Fakes market_data_sync._fetch_page: first call per sync (start=0)
    returns one page of data, any later call (start>0) returns empty so the
    pagination loop in market_data_sync.sync_native_timeframe terminates -
    exactly like the real MOEX endpoint does once a page comes back empty."""
    import market_data_sync as sync

    def _fake(session, *, engine, market, board, ticker, interval, from_date, till_date, start):
        calls.append((ticker, board, interval, from_date, till_date, start))
        if start > 0:
            return {"columns": [], "data": []}
        return _moex_json(from_date, till_date, freq_minutes=freq_minutes)

    monkeypatch.setattr(sync, "_fetch_page", _fake)


def test_unknown_timeframe_rejected(tmp_path):
    with pytest.raises(ValueError):
        candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="3d",
                                from_date="2025-01-01", till_date="2025-01-10", limit=100)


def test_get_candles_downloads_and_returns_unix_seconds(monkeypatch, tmp_path):
    calls = []
    _patch_fetch(monkeypatch, calls)
    result = candle_api.get_candles(tmp_path, ticker="sber", board="TQBR", timeframe="1d",
                                     from_date="2025-01-01", till_date="2025-01-10", limit=100)
    assert calls, "a never-before-seen ticker/timeframe must trigger a MOEX fetch"
    assert len(result["candles"]) == 10
    first = result["candles"][0]
    assert first["time"] == calendar.timegm(time.strptime("2025-01-01", "%Y-%m-%d"))
    assert first["open"] == 100
    assert result["nextCursor"] is None
    assert result["hasOlder"] is False


def test_second_overlapping_request_reuses_local_store(monkeypatch, tmp_path):
    calls = []
    _patch_fetch(monkeypatch, calls)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-01", till_date="2025-01-10", limit=100)
    n_after_first = len(calls)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-03", till_date="2025-01-08", limit=100)
    assert len(calls) == n_after_first, "a fully-covered sub-range must not trigger another MOEX fetch"


def test_request_outside_cached_range_extends_with_one_more_fetch(monkeypatch, tmp_path):
    calls = []
    _patch_fetch(monkeypatch, calls)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-05", till_date="2025-01-10", limit=100)
    n_after_first = len(calls)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-01", till_date="2025-01-10", limit=100)
    new_calls = calls[n_after_first:]
    assert new_calls, "requesting an earlier from_date must fetch the missing older slice"
    assert new_calls[0][3] == "2025-01-01"  # fetch started at the earlier requested date


def test_repeat_sync_is_deduped_not_duplicated(monkeypatch, tmp_path):
    """Same series synced twice from scratch must not produce duplicate
    rows in storage - the DB primary key enforces this even if a caller
    forces a re-fetch of an already-covered window."""
    calls = []
    _patch_fetch(monkeypatch, calls)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-01", till_date="2025-01-10", limit=100)
    import market_data_sync as sync
    sync.sync_native_timeframe("SBER", "TQBR", "1d", mode="initial",
                                from_date="2025-01-01", till_date="2025-01-10")
    cov = store.coverage("SBER", "TQBR", "1d")
    assert cov["candle_count"] == 10


def test_limit_truncates_and_sets_next_cursor(monkeypatch, tmp_path):
    calls = []
    _patch_fetch(monkeypatch, calls)
    result = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                                     from_date="2025-01-01", till_date="2025-01-10", limit=3)
    assert len(result["candles"]) == 3
    assert result["nextCursor"] == result["candles"][0]["time"]
    assert result["hasOlder"] is True


def test_before_cursor_pages_into_older_history(monkeypatch, tmp_path):
    calls = []
    _patch_fetch(monkeypatch, calls)
    full = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                                   from_date="2025-01-01", till_date="2025-01-10", limit=100)
    cutoff = full["candles"][5]["time"]
    older = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                                    from_date="2025-01-01", till_date="2025-01-10", limit=100, before=cutoff)
    assert all(c["time"] < cutoff for c in older["candles"])
    assert len(older["candles"]) == 5


def test_no_duplicate_bars_across_overlapping_syncs(monkeypatch, tmp_path):
    """Regression guard for the exact 'giant duplicated store' failure mode
    the new schema's primary key exists to prevent."""
    calls = []
    _patch_fetch(monkeypatch, calls)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-01", till_date="2025-01-05", limit=100)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-01", till_date="2025-01-10", limit=100)
    result = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                                     from_date="2025-01-01", till_date="2025-01-10", limit=100)
    times = [c["time"] for c in result["candles"]]
    assert len(times) == len(set(times)), "no timestamp should appear twice"


def test_tick_availability_is_honest():
    info = candle_api.tick_availability("sber")
    assert info["ticker"] == "SBER"
    assert info["available"] is False
    assert info["reason"]
