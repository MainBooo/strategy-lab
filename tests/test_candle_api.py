from __future__ import annotations

import pandas as pd
import pytest

import candle_api


def _fake_download_factory(call_log):
    def _fake_download(ticker, board, interval, from_date, till_date, output_path):
        call_log.append((ticker, board, interval, from_date, till_date))
        dates = pd.date_range(from_date, till_date, freq="D")
        df = pd.DataFrame({
            "begin": dates,
            "open": [100 + i for i in range(len(dates))],
            "high": [101 + i for i in range(len(dates))],
            "low": [99 + i for i in range(len(dates))],
            "close": [100.5 + i for i in range(len(dates))],
            "volume": [1000 + i for i in range(len(dates))],
        })
        df.to_csv(output_path, index=False)
        return {"rows": len(df)}
    return _fake_download


@pytest.fixture(autouse=True)
def _isolate_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(candle_api, "TIMEFRAME_TO_MOEX_INTERVAL", candle_api.TIMEFRAME_TO_MOEX_INTERVAL)
    yield tmp_path


def test_unknown_timeframe_rejected(tmp_path):
    with pytest.raises(ValueError):
        candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="3d",
                                from_date="2025-01-01", till_date="2025-01-10", limit=100)


def test_get_candles_downloads_and_returns_unix_seconds(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(candle_api, "download_moex_candles", _fake_download_factory(calls))
    result = candle_api.get_candles(tmp_path, ticker="sber", board="TQBR", timeframe="1d",
                                     from_date="2025-01-01", till_date="2025-01-10", limit=100)
    assert len(calls) == 1
    assert len(result["candles"]) == 10
    first = result["candles"][0]
    assert first["time"] == int(pd.Timestamp("2025-01-01").timestamp())
    assert first["open"] == 100
    assert result["nextCursor"] is None


def test_second_overlapping_request_reuses_cache(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(candle_api, "download_moex_candles", _fake_download_factory(calls))
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-01", till_date="2025-01-10", limit=100)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-03", till_date="2025-01-08", limit=100)
    assert len(calls) == 1, "a fully-covered sub-range must not trigger a second download"


def test_request_outside_cached_range_extends_and_redownloads(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(candle_api, "download_moex_candles", _fake_download_factory(calls))
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-05", till_date="2025-01-10", limit=100)
    candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                            from_date="2025-01-01", till_date="2025-01-10", limit=100)
    assert len(calls) == 2
    assert calls[1][3] == "2025-01-01"  # span grew to cover the earlier from_date


def test_limit_truncates_and_sets_next_cursor(tmp_path, monkeypatch):
    monkeypatch.setattr(candle_api, "download_moex_candles", _fake_download_factory([]))
    result = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                                     from_date="2025-01-01", till_date="2025-01-10", limit=3)
    assert len(result["candles"]) == 3
    assert result["nextCursor"] == result["candles"][0]["time"]


def test_before_cursor_pages_into_older_history(tmp_path, monkeypatch):
    monkeypatch.setattr(candle_api, "download_moex_candles", _fake_download_factory([]))
    full = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                                   from_date="2025-01-01", till_date="2025-01-10", limit=100)
    cutoff = full["candles"][5]["time"]
    older = candle_api.get_candles(tmp_path, ticker="SBER", board="TQBR", timeframe="1d",
                                    from_date="2025-01-01", till_date="2025-01-10", limit=100, before=cutoff)
    assert all(c["time"] < cutoff for c in older["candles"])
    assert len(older["candles"]) == 5
