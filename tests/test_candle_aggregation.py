from __future__ import annotations

import pytest

import candle_api
import market_data_store as store
from tests.binance_fixtures import fake_klines_request
from binance_market_data import aggregate_candles


def test_aggregate_rolls_up_ohlcv_correctly():
    # Four real 5m bars inside one 10m... use a 20m bucket from four 5m bars
    # to keep the arithmetic simple and distinct from the 10m-from-5m case
    # exercised below.
    candles = [
        {"ts": 0 * 300, "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 10,
         "quote_volume": 1, "num_trades": 1, "taker_buy_base_volume": 1, "taker_buy_quote_volume": 1},
        {"ts": 1 * 300, "open": 100.5, "high": 103, "low": 100, "close": 102, "volume": 20,
         "quote_volume": 1, "num_trades": 1, "taker_buy_base_volume": 1, "taker_buy_quote_volume": 1},
        {"ts": 2 * 300, "open": 102, "high": 102.5, "low": 98, "close": 99, "volume": 5,
         "quote_volume": 1, "num_trades": 1, "taker_buy_base_volume": 1, "taker_buy_quote_volume": 1},
        {"ts": 3 * 300, "open": 99, "high": 99.5, "low": 97, "close": 98, "volume": 15,
         "quote_volume": 1, "num_trades": 1, "taker_buy_base_volume": 1, "taker_buy_quote_volume": 1},
    ]
    bars = aggregate_candles(candles, bucket_seconds=4 * 300)
    assert len(bars) == 1
    bar = bars[0]
    assert bar["ts"] == 0
    assert bar["open"] == 100  # first candle's open
    assert bar["high"] == 103  # max high across all four
    assert bar["low"] == 97  # min low across all four
    assert bar["close"] == 98  # last candle's close
    assert bar["volume"] == 50  # sum of all four


def test_aggregate_splits_at_bucket_boundary():
    candles = [
        {"ts": 0, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1,
         "quote_volume": 0, "num_trades": 0, "taker_buy_base_volume": 0, "taker_buy_quote_volume": 0},
        {"ts": 300, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 1,
         "quote_volume": 0, "num_trades": 0, "taker_buy_base_volume": 0, "taker_buy_quote_volume": 0},
        {"ts": 600, "open": 3, "high": 3, "low": 3, "close": 3, "volume": 1,   # new bucket
         "quote_volume": 0, "num_trades": 0, "taker_buy_base_volume": 0, "taker_buy_quote_volume": 0},
    ]
    bars = aggregate_candles(candles, bucket_seconds=600)
    assert [b["ts"] for b in bars] == [0, 600]
    assert bars[0]["open"] == 1 and bars[0]["close"] == 2
    assert bars[1]["open"] == 3 and bars[1]["close"] == 3


def test_aggregate_no_fabricated_gaps():
    # A gap in the source data (no candles between two real bars far apart)
    # must not produce an empty/synthetic bucket for the missing period -
    # only buckets with real underlying candles appear.
    candles = [
        {"ts": 10 * 3600, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1,
         "quote_volume": 0, "num_trades": 0, "taker_buy_base_volume": 0, "taker_buy_quote_volume": 0},
        {"ts": 18 * 3600, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 1,
         "quote_volume": 0, "num_trades": 0, "taker_buy_base_volume": 0, "taker_buy_quote_volume": 0},
    ]
    bars = aggregate_candles(candles, bucket_seconds=4 * 3600)
    assert len(bars) == 2
    assert bars[0]["ts"] == 8 * 3600
    assert bars[1]["ts"] == 16 * 3600


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path):
    store.init_db(tmp_path / "candles.db")
    yield tmp_path


def test_get_candles_10m_aggregates_from_5m_base(monkeypatch, tmp_path):
    """10m is the one timeframe this app still derives by aggregation
    (backward-compat, no native Binance 10m interval) - built from real 5m
    candles, never synthesized."""
    import binance_market_data
    calls = []
    monkeypatch.setattr(binance_market_data, "request", fake_klines_request(calls, freq_minutes=5))

    result = candle_api.get_candles(tmp_path, symbol="BTCUSDT", timeframe="10m",
                                     from_date="2025-01-01", till_date="2025-01-01", limit=50)
    assert calls, "10m must fetch real 5m candles, not synthesize its own data"
    assert any(c["interval"] == "5m" for c in calls), "10m must fetch its declared 5m base, never another interval"
    assert result["candles"]
    for bar in result["candles"]:
        assert bar["time"] % 600 == 0, "every 10m bucket must be exactly on a UTC 600s boundary"
        assert bar["high"] >= bar["low"]
        assert bar["open"] is not None and bar["close"] is not None
    # A fully-formed bucket sums exactly the two real 5m candles it's built
    # from - verified directly against the native 5m rows actually stored,
    # not a hardcoded guess at their values.
    first_bucket_ts = result["candles"][0]["time"]
    native = store.get_candles("BTCUSDT", "5m", ts_from=first_bucket_ts, ts_to=first_bucket_ts + 599, limit=10)
    assert len(native) == 2
    assert result["candles"][0]["volume"] == pytest.approx(native[0]["volume"] + native[1]["volume"])


def test_limit_and_next_cursor_propagate_through_aggregation(monkeypatch, tmp_path):
    import binance_market_data
    calls = []
    monkeypatch.setattr(binance_market_data, "request", fake_klines_request(calls, freq_minutes=5))

    result = candle_api.get_candles(tmp_path, symbol="BTCUSDT", timeframe="10m",
                                     from_date="2025-01-01", till_date="2025-01-05", limit=2)
    assert len(result["candles"]) == 2
    assert result["nextCursor"] == result["candles"][0]["time"]


def test_native_timeframes_are_never_aggregated(monkeypatch, tmp_path):
    """5m/15m/30m/1h/2h/4h/1d are all native Binance intervals now - unlike
    the old MOEX-era code, none of them should route through the
    aggregation path."""
    from timeframes import AGGREGATE_TIMEFRAMES
    assert set(AGGREGATE_TIMEFRAMES.keys()) == {"10m"}
