from __future__ import annotations

from contextlib import nullcontext

import candle_api
import market_data_sync as sync
import market_data_store as store


def _stub_native_store(monkeypatch):
    seen = {}

    monkeypatch.setattr(candle_api, "_ensure_coverage", lambda *args, **kwargs: None)
    monkeypatch.setattr(store, "touch_access", lambda *args, **kwargs: None)
    monkeypatch.setattr(store, "coverage", lambda *args, **kwargs: {
        "earliest_ts": 1,
        "latest_ts": 9_999_999_999,
        "candle_count": 10_000,
    })
    monkeypatch.setattr(store, "get_sync_state", lambda *args, **kwargs: {"backfilled_complete": 1})

    def fake_get_candles(ticker, board, timeframe, *, ts_from=None, ts_to=None, before=None, limit=5000):
        seen["limit"] = limit
        seen["before"] = before
        # Two rows are enough to exercise the response path; the contract we
        # care about here is the limit passed into the indexed store query.
        return [
            {"time": 1_700_000_000, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
            {"time": 1_700_086_400, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 2},
        ]

    monkeypatch.setattr(store, "get_candles", fake_get_candles)
    return seen


def test_all_history_daily_initial_request_is_page_sized(monkeypatch):
    seen = _stub_native_store(monkeypatch)

    candle_api.get_candles(
        None,
        ticker="SBER",
        board="TQBR",
        timeframe="1d",
        from_date=sync.EARLIEST_PLAUSIBLE_DATE,
        till_date="2026-08-13",
        limit=5000,
    )

    assert seen["limit"] == 500
    assert seen["before"] is None


def test_explicit_custom_range_keeps_requested_limit(monkeypatch):
    seen = _stub_native_store(monkeypatch)

    candle_api.get_candles(
        None,
        ticker="SBER",
        board="TQBR",
        timeframe="1d",
        from_date="2020-01-01",
        till_date="2026-08-13",
        limit=5000,
    )

    assert seen["limit"] == 5000


def test_before_cursor_keeps_pagination_page_size(monkeypatch):
    seen = _stub_native_store(monkeypatch)

    candle_api.get_candles(
        None,
        ticker="SBER",
        board="TQBR",
        timeframe="1d",
        from_date=sync.EARLIEST_PLAUSIBLE_DATE,
        till_date="2026-08-13",
        before=1234567890,
        limit=2000,
    )

    assert seen["limit"] == 2000
    assert seen["before"] == 1234567890


def test_bounded_all_history_page_keeps_cursor_until_backfill_is_complete(monkeypatch):
    first = 1_700_000_000
    candles = [
        {"time": first, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        {"time": first + 86400, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 2},
    ]

    monkeypatch.setattr(candle_api, "_ensure_coverage", lambda *args, **kwargs: None)
    monkeypatch.setattr(store, "touch_access", lambda *args, **kwargs: None)
    monkeypatch.setattr(store, "get_candles", lambda *args, **kwargs: candles)
    monkeypatch.setattr(store, "coverage", lambda *args, **kwargs: {
        "earliest_ts": first,
        "latest_ts": candles[-1]["time"],
        "candle_count": len(candles),
    })
    monkeypatch.setattr(store, "get_sync_state", lambda *args, **kwargs: {"backfilled_complete": 0})

    result = candle_api.get_candles(
        None,
        ticker="SBER",
        board="TQBR",
        timeframe="1d",
        from_date=sync.EARLIEST_PLAUSIBLE_DATE,
        till_date="2026-08-13",
        limit=5000,
    )

    # Only two rows were returned (far below the 500-row initial page cap),
    # but the bounded cache is not fully backfilled yet, so scrolling left
    # must still be offered and trigger the next older window.
    assert result["nextCursor"] == first
    assert result["hasOlder"] is True


def test_history_cursor_stops_at_real_start_after_backfill_complete(monkeypatch):
    first = 1_000_000_000
    candles = [
        {"time": first, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        {"time": first + 86400, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 2},
    ]

    monkeypatch.setattr(candle_api, "_ensure_coverage", lambda *args, **kwargs: None)
    monkeypatch.setattr(store, "touch_access", lambda *args, **kwargs: None)
    monkeypatch.setattr(store, "get_candles", lambda *args, **kwargs: candles)
    monkeypatch.setattr(store, "coverage", lambda *args, **kwargs: {
        "earliest_ts": first,
        "latest_ts": candles[-1]["time"],
        "candle_count": len(candles),
    })
    monkeypatch.setattr(store, "get_sync_state", lambda *args, **kwargs: {"backfilled_complete": 1})

    result = candle_api.get_candles(
        None,
        ticker="SBER",
        board="TQBR",
        timeframe="1d",
        from_date=sync.EARLIEST_PLAUSIBLE_DATE,
        till_date="2026-08-13",
        limit=5000,
    )

    assert result["nextCursor"] is None
    assert result["hasOlder"] is False


def test_aggregated_initial_request_uses_its_own_page_limit(monkeypatch):
    seen = {}

    def fake_aggregated(**kwargs):
        seen.update(kwargs)
        return {"candles": [], "nextCursor": None, "hasOlder": False, "hasNewer": False,
                "actualFrom": None, "actualTill": None}

    monkeypatch.setattr(candle_api, "_get_aggregated_candles", fake_aggregated)

    candle_api.get_candles(
        None,
        ticker="SBER",
        board="TQBR",
        timeframe="4h",
        from_date=sync.EARLIEST_PLAUSIBLE_DATE,
        till_date="2026-08-13",
        limit=5000,
    )

    assert seen["limit"] == 600


def test_cold_daily_history_sync_starts_from_recent_window(monkeypatch):
    calls = []

    monkeypatch.setattr(store, "sync_lock", lambda *args, **kwargs: nullcontext())
    monkeypatch.setattr(store, "coverage", lambda *args, **kwargs: {
        "earliest_ts": None,
        "latest_ts": None,
        "candle_count": 0,
    })

    def fake_sync(*args, **kwargs):
        calls.append((args, kwargs))
        return {"status": "completed", "rows_added": 0, "pages_fetched": 0, "error": None}

    monkeypatch.setattr(sync, "sync_native_timeframe", fake_sync)

    candle_api._ensure_coverage(
        "SBER", "TQBR", "1d", sync.EARLIEST_PLAUSIBLE_DATE, "2026-08-13", "shares", "stock"
    )

    assert len(calls) == 1
    _args, kwargs = calls[0]
    assert kwargs["from_date"] == "2024-08-13"
    assert kwargs["till_date"] == "2026-08-13"
    assert kwargs["max_pages"] == 40
