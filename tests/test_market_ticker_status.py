from __future__ import annotations

"""Tests for market_ticker's split between source_delay_ms (constant, the
feed's own advertised lag) and last_trade_age_ms (per-ticker, illiquidity)
- the fix for SCFT/AKMC-style instruments showing a misleading multi-hour
"задержка" that was actually just "no trades in a while", not a source or
connectivity problem."""

from datetime import datetime

import market_ticker


def test_fetch_error_is_always_disconnected():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error="boom", market_open=True, last_trade_age_ms=1000, cfg=cfg)
    assert status == "disconnected"


def test_closed_market_wins_over_trade_age():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error=None, market_open=False, last_trade_age_ms=50_000, cfg=cfg)
    assert status == "market_closed"


def test_healthy_baseline_delay_is_delayed_not_no_trades():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error=None, market_open=True,
                                             last_trade_age_ms=market_ticker.SOURCE_DELAY_MS, cfg=cfg)
    assert status == "delayed"


def test_illiquid_ticker_is_no_trades_not_delayed():
    """The exact SCFT/AKMC symptom: a ticker whose last trade is ~1.7h old
    while the market is open and the feed itself is healthy must be
    reported as "no trades", never as a growing "delay"."""
    cfg = market_ticker.realtime_config()
    age_1h42m = (1 * 3600 + 42 * 60) * 1000
    status = market_ticker._classify_status(fetch_error=None, market_open=True,
                                             last_trade_age_ms=age_1h42m, cfg=cfg)
    assert status == "no_trades"


def test_missing_quote_during_open_market_is_no_trades():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error=None, market_open=True, last_trade_age_ms=None, cfg=cfg)
    assert status == "no_trades"


def test_get_realtime_exposes_both_metrics_separately(monkeypatch):
    fixed_now = datetime(2025, 1, 6, 7, 30, 0)  # Monday, in session

    class _Fixed(datetime):
        @classmethod
        def utcnow(cls):
            return fixed_now

    monkeypatch.setattr(market_ticker, "datetime", _Fixed)
    monkeypatch.setattr(market_ticker, "is_trading_session", lambda now_utc=None: True)
    monkeypatch.setattr(market_ticker, "_refresh_if_stale", lambda: {
        "by_ticker": {"SCFT": {
            "ticker": "SCFT", "last": 55.5, "change_pct": 0.1, "bid": None, "offer": None,
            "market_timestamp": "2025-01-06T04:00:00", "market_time": "07:00:00",
            "delay_ms": 6_120_000,  # 1h42m - illiquid, no recent trade
        }},
        "cached": True, "stale": False, "error": None, "server_received_at": fixed_now,
    })

    data = market_ticker.get_realtime("SCFT")
    assert data["status"] == "no_trades"
    assert data["source_delay_ms"] == market_ticker.SOURCE_DELAY_MS
    assert data["last_trade_age_ms"] == 6_120_000
    assert data["delay_ms"] == data["last_trade_age_ms"], "back-compat alias must match the renamed field"


def test_get_realtime_healthy_liquid_ticker_is_delayed(monkeypatch):
    fixed_now = datetime(2025, 1, 6, 7, 30, 0)

    class _Fixed(datetime):
        @classmethod
        def utcnow(cls):
            return fixed_now

    monkeypatch.setattr(market_ticker, "datetime", _Fixed)
    monkeypatch.setattr(market_ticker, "is_trading_session", lambda now_utc=None: True)
    monkeypatch.setattr(market_ticker, "_refresh_if_stale", lambda: {
        "by_ticker": {"SBER": {
            "ticker": "SBER", "last": 300.0, "change_pct": 0.5, "bid": None, "offer": None,
            "market_timestamp": "2025-01-06T07:15:00", "market_time": "10:15:00",
            "delay_ms": market_ticker.SOURCE_DELAY_MS,
        }},
        "cached": True, "stale": False, "error": None, "server_received_at": fixed_now,
    })

    data = market_ticker.get_realtime("SBER")
    assert data["status"] == "delayed"
