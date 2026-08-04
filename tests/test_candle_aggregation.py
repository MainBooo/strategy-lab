from __future__ import annotations

import pandas as pd
import pytest

import candle_api


def test_aggregate_rolls_up_ohlcv_correctly():
    # Four real 1h bars inside one 4h bucket (14:00-18:00), MOEX-style.
    candles = [
        {"time": 0 * 3600, "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 10},
        {"time": 1 * 3600, "open": 100.5, "high": 103, "low": 100, "close": 102, "volume": 20},
        {"time": 2 * 3600, "open": 102, "high": 102.5, "low": 98, "close": 99, "volume": 5},
        {"time": 3 * 3600, "open": 99, "high": 99.5, "low": 97, "close": 98, "volume": 15},
    ]
    bars = candle_api._aggregate(candles, bucket_seconds=4 * 3600)
    assert len(bars) == 1
    bar = bars[0]
    assert bar["time"] == 0
    assert bar["open"] == 100  # first candle's open
    assert bar["high"] == 103  # max high across all four
    assert bar["low"] == 97  # min low across all four
    assert bar["close"] == 98  # last candle's close
    assert bar["volume"] == 50  # sum of all four


def test_aggregate_splits_at_bucket_boundary():
    candles = [
        {"time": 0, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        {"time": 1800, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 1},
        {"time": 3600, "open": 3, "high": 3, "low": 3, "close": 3, "volume": 1},  # new 1h bucket
    ]
    bars = candle_api._aggregate(candles, bucket_seconds=3600)
    assert [b["time"] for b in bars] == [0, 3600]
    assert bars[0]["open"] == 1 and bars[0]["close"] == 2
    assert bars[1]["open"] == 3 and bars[1]["close"] == 3


def test_aggregate_no_fabricated_gaps():
    # A trading-hours gap (no candles between 12:00 and 14:00, e.g. no
    # off-session data) must not produce an empty/synthetic bucket for the
    # missing period - only buckets with real underlying candles appear.
    candles = [
        {"time": 10 * 3600, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        {"time": 18 * 3600, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 1},
    ]
    bars = candle_api._aggregate(candles, bucket_seconds=4 * 3600)
    assert len(bars) == 2
    assert bars[0]["time"] == 8 * 3600
    assert bars[1]["time"] == 16 * 3600


def _fake_minute_download_factory(call_log, minutes_per_bar=60):
    def _fake_download(ticker, board, interval, from_date, till_date, output_path):
        call_log.append((ticker, board, interval, from_date, till_date))
        assert interval == 60  # the 4h aggregate must fetch its declared 60m base, never a different one
        start = pd.Timestamp(from_date) + pd.Timedelta(hours=9)  # arbitrary session start
        end = pd.Timestamp(till_date) + pd.Timedelta(hours=21)
        times = pd.date_range(start, end, freq=f"{minutes_per_bar}min")
        df = pd.DataFrame({
            "begin": times,
            "open": [100 + i * 0.1 for i in range(len(times))],
            "high": [100.5 + i * 0.1 for i in range(len(times))],
            "low": [99.5 + i * 0.1 for i in range(len(times))],
            "close": [100.2 + i * 0.1 for i in range(len(times))],
            "volume": [1000] * len(times),
        })
        df.to_csv(output_path, index=False)
        return {"rows": len(df)}
    return _fake_download


def test_get_candles_4h_aggregates_from_60m_base(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(candle_api, "download_moex_candles", _fake_minute_download_factory(calls))
    result = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="4h",
                                     from_date="2025-01-01", till_date="2025-01-02", limit=100)
    assert calls, "4h must fetch real 60m candles, not synthesize its own data"
    assert result["candles"]
    for bar in result["candles"]:
        assert bar["time"] % (4 * 3600) == 0, "every 4h bucket must be exactly on a 4h boundary"
        assert bar["high"] >= bar["low"]
        assert bar["open"] is not None and bar["close"] is not None


def test_get_candles_30m_aggregates_from_10m_base(tmp_path, monkeypatch):
    def _fake_download(ticker, board, interval, from_date, till_date, output_path):
        assert interval == 10
        start = pd.Timestamp(from_date) + pd.Timedelta(hours=10)
        end = pd.Timestamp(till_date) + pd.Timedelta(hours=18)
        times = pd.date_range(start, end, freq="10min")
        df = pd.DataFrame({
            "begin": times,
            "open": [200] * len(times), "high": [201] * len(times),
            "low": [199] * len(times), "close": [200.5] * len(times), "volume": [500] * len(times),
        })
        df.to_csv(output_path, index=False)
        return {"rows": len(df)}
    monkeypatch.setattr(candle_api, "download_moex_candles", _fake_download)
    result = candle_api.get_candles(tmp_path, ticker="GAZP", board="TQBR", timeframe="30m",
                                     from_date="2025-01-01", till_date="2025-01-01", limit=50)
    assert result["candles"]
    for bar in result["candles"]:
        assert bar["time"] % 1800 == 0
        # A fully-formed bucket sums exactly three real 10m candles (500
        # each); only the very last bucket may be short if the requested
        # window cuts off mid-bucket - never fabricated, always a real sum.
        assert bar["volume"] in (500, 1000, 1500)
    assert result["candles"][0]["volume"] == 1500


def test_limit_and_next_cursor_propagate_through_aggregation(tmp_path, monkeypatch):
    monkeypatch.setattr(candle_api, "download_moex_candles", _fake_minute_download_factory([]))
    result = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="4h",
                                     from_date="2025-01-01", till_date="2025-01-05", limit=2)
    assert len(result["candles"]) == 2
    assert result["nextCursor"] == result["candles"][0]["time"]
