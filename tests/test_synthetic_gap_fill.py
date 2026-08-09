from __future__ import annotations

"""Tests for candle_api._fill_synthetic_gaps - the "критическое уточнение"
gap-fill that keeps a native intraday timeline (10m in particular) advancing
every bucket during an active session even when MOEX has no real trade for
a given interval, instead of stalling the chart at the last real trade.

All tests fix "now" via a datetime subclass swapped into candle_api's own
`datetime` name (imported with `from datetime import datetime`), and stub
out market_ticker.get_prices so no real network call happens."""

import calendar
import time
from datetime import datetime, timedelta

import pytest

import candle_api
import market_data_store as store
import market_ticker


def _msk(y, m, d, hh, mm, ss=0) -> int:
    """Same naive-MSK-wall-as-UTC convention as market_data_sync._rows_from_moex."""
    return calendar.timegm((y, m, d, hh, mm, ss, 0, 0, 0))


class _FixedNow(datetime):
    # UTC 07:30 -> Monday 2025-01-06 10:30 MSK; minus the 15-min source
    # delay baseline = delayed exchange time 10:15 -> last CLOSED 10m
    # bucket is 10:10 (the 10:00 bucket's very next neighbour), so a
    # ticker whose latest stored candle is the 10:00-10:10 bar has exactly
    # one confirmed-closed-but-missing bucket (10:10-10:20) to gap-fill.
    _fixed = datetime(2025, 1, 6, 7, 30, 0)

    @classmethod
    def utcnow(cls):
        return cls._fixed


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    store.init_db(tmp_path / "candles.db")
    monkeypatch.setattr(candle_api, "datetime", _FixedNow)
    monkeypatch.setattr(market_ticker, "get_prices", lambda tickers=None: {"prices": {}, "stale": False, "error": None})
    yield tmp_path


def _seed_real_candle(ticker, board, tf, ts, close):
    store.upsert_candles(ticker, board, tf, [
        {"ts": ts, "open": close, "high": close, "low": close, "close": close, "volume": 100},
    ])


def test_no_gap_when_next_bucket_not_yet_closed():
    """Latest real candle is already the last CLOSED 10m bucket (10:10) at
    the fixed delayed exchange time (10:15) - the next bucket (10:20) isn't
    confirmed closed yet, so nothing should be filled."""
    ts = _msk(2025, 1, 6, 10, 10)
    _seed_real_candle("AAAA", "TQBR", "10m", ts, 100.0)
    candle_api._fill_synthetic_gaps("AAAA", "TQBR", "10m", "shares", "stock", sync_ok=True)
    cov = store.coverage("AAAA", "TQBR", "10m")
    assert cov["candle_count"] == 1, "no bucket has closed past the already-stored latest bar yet"


def test_synthetic_flat_candle_fills_confirmed_empty_bucket():
    """Latest real candle is the 10:00-10:10 bar; at the fixed delayed
    exchange time (10:15) the very next bucket (10:10-10:20) is already
    closed but MOEX never reported a trade for it - must be gap-filled."""
    ts = _msk(2025, 1, 6, 10, 0)
    _seed_real_candle("SCFT", "TQBR", "10m", ts, 55.5)
    candle_api._fill_synthetic_gaps("SCFT", "TQBR", "10m", "shares", "stock", sync_ok=True)
    cov = store.coverage("SCFT", "TQBR", "10m")
    assert cov["candle_count"] == 2
    candles = store.get_candles("SCFT", "TQBR", "10m", ts_from=ts, ts_to=ts + 3600, limit=10)
    synth = candles[-1]
    assert synth["time"] == _msk(2025, 1, 6, 10, 10)
    assert synth["isSynthetic"] is True
    assert synth["open"] == synth["high"] == synth["low"] == synth["close"] == 55.5
    assert synth["volume"] == 0


def test_real_candle_replaces_synthetic_without_duplicate():
    ts = _msk(2025, 1, 6, 10, 0)
    _seed_real_candle("AKMC", "TQBR", "10m", ts, 20.0)
    candle_api._fill_synthetic_gaps("AKMC", "TQBR", "10m", "shares", "stock", sync_ok=True)
    gap_ts = _msk(2025, 1, 6, 10, 10)
    before = store.get_candles("AKMC", "TQBR", "10m", ts_from=gap_ts, ts_to=gap_ts, limit=1)[0]
    assert before["isSynthetic"] is True

    # MOEX later reports a real trade for that same bucket.
    added = store.upsert_candles("AKMC", "TQBR", "10m", [
        {"ts": gap_ts, "open": 20.0, "high": 20.8, "low": 19.9, "close": 20.5, "volume": 300},
    ])
    assert added == 1, "a real candle must overwrite the synthetic placeholder, not be ignored"

    after = store.get_candles("AKMC", "TQBR", "10m", ts_from=gap_ts, ts_to=gap_ts, limit=1)[0]
    assert after["isSynthetic"] is False
    assert after["close"] == 20.5
    assert after["volume"] == 300
    assert store.coverage("AKMC", "TQBR", "10m")["candle_count"] == 2, "no duplicate row for the same bucket"


def test_forming_candle_updates_in_place_not_frozen():
    """Regression guard for the 'last candle never updates' bug: re-syncing
    the SAME still-forming bucket with new OHLCV from MOEX must update the
    existing row, not silently drop the new values."""
    ts = _msk(2025, 1, 6, 10, 0)
    added1 = store.upsert_candles("SBER", "TQBR", "10m", [
        {"ts": ts, "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 500},
    ])
    added2 = store.upsert_candles("SBER", "TQBR", "10m", [
        {"ts": ts, "open": 100, "high": 102, "low": 99, "close": 101.8, "volume": 900},
    ])
    assert added1 == 1
    assert added2 == 1, "an actual value change on the same bucket must count as an update"
    row = store.get_candles("SBER", "TQBR", "10m", ts_from=ts, ts_to=ts, limit=1)[0]
    assert row["close"] == 101.8
    assert row["volume"] == 900


def test_identical_reinsert_is_a_true_noop():
    rows = [{"ts": 1000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 10}]
    added_first = store.upsert_candles("SBER", "TQBR", "1d", rows)
    added_second = store.upsert_candles("SBER", "TQBR", "1d", rows)
    assert added_first == 1
    assert added_second == 0
    assert store.coverage("SBER", "TQBR", "1d")["candle_count"] == 1


def test_no_fill_when_last_sync_failed():
    ts = _msk(2025, 1, 6, 10, 0)
    _seed_real_candle("AKHT", "TQBR", "10m", ts, 30.0)
    candle_api._fill_synthetic_gaps("AKHT", "TQBR", "10m", "shares", "stock", sync_ok=False)
    assert store.coverage("AKHT", "TQBR", "10m")["candle_count"] == 1, \
        "a failed sync must never be papered over with a fake flat candle"


def test_no_fill_outside_trading_session():
    """Latest real candle is the session's last bucket (23:50-00:00 MSK);
    the next bucket (00:00-00:10) is after the session closes - must stay a
    genuine gap, never a synthetic bar, even though the source-delay cutoff
    at this fixed "now" has long since confirmed it closed."""
    ts = _msk(2025, 1, 6, 23, 50)
    _seed_real_candle("AKCN", "TQBR", "10m", ts, 12.0)

    class _LateNow(datetime):
        _fixed = datetime(2025, 1, 6, 21, 30, 0)  # UTC -> 2025-01-07 00:30 MSK, well past close+delay

        @classmethod
        def utcnow(cls):
            return cls._fixed

    import candle_api as capi
    orig = capi.datetime
    capi.datetime = _LateNow
    try:
        candle_api._fill_synthetic_gaps("AKCN", "TQBR", "10m", "shares", "stock", sync_ok=True)
    finally:
        capi.datetime = orig
    assert store.coverage("AKCN", "TQBR", "10m")["candle_count"] == 1, \
        "the only candidate buckets (00:00, 00:10 MSK) are after session close - must not be synthesized"


def test_no_fill_when_instrument_suspended(monkeypatch):
    ts = _msk(2025, 1, 6, 10, 0)
    _seed_real_candle("SUSP", "TQBR", "10m", ts, 40.0)
    monkeypatch.setattr(market_ticker, "get_prices",
                         lambda tickers=None: {"prices": {"SUSP": {"trading_status": "S"}}, "stale": False, "error": None})
    candle_api._fill_synthetic_gaps("SUSP", "TQBR", "10m", "shares", "stock", sync_ok=True)
    assert store.coverage("SUSP", "TQBR", "10m")["candle_count"] == 1
