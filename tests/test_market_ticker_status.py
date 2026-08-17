from __future__ import annotations

"""Tests for market_ticker's honest realtime-status classification
(live/stale/disconnected - spec section 27). Binance Spot is 24/7, so
unlike the old MOEX integration there is no "market_closed" state and no
fixed source-delay baseline - status is purely a function of how old the
last successful REST snapshot is, and whether the requested symbol actually
has a quote in it."""

from datetime import datetime, timezone

import pytest

import market_ticker


def test_fetch_error_with_no_quote_is_disconnected():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error="boom", has_quote=False, age_ms=1000, cfg=cfg)
    assert status == "disconnected"


def test_fetch_error_with_cached_quote_falls_through_to_age(monkeypatch):
    """A transient fetch error doesn't itself force 'disconnected' if a
    quote is still available (served from cache) and that snapshot isn't
    old enough yet to be considered stale."""
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error="boom", has_quote=True, age_ms=1000, cfg=cfg)
    assert status == "live"


def test_missing_quote_is_disconnected():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error=None, has_quote=False, age_ms=1000, cfg=cfg)
    assert status == "disconnected"


def test_fresh_quote_is_live():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error=None, has_quote=True, age_ms=1000, cfg=cfg)
    assert status == "live"


def test_aged_past_stale_threshold_is_stale():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error=None, has_quote=True,
                                             age_ms=cfg["stale_after_ms"] + 1, cfg=cfg)
    assert status == "stale"


def test_aged_past_disconnected_threshold_is_disconnected():
    cfg = market_ticker.realtime_config()
    status = market_ticker._classify_status(fetch_error=None, has_quote=True,
                                             age_ms=cfg["disconnected_after_ms"] + 1, cfg=cfg)
    assert status == "disconnected"


def test_get_realtime_exposes_symbol_and_config(monkeypatch):
    fixed_now = datetime(2025, 1, 6, 7, 30, 0, tzinfo=timezone.utc)

    class _Fixed(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now

    monkeypatch.setattr(market_ticker, "datetime", _Fixed)
    monkeypatch.setattr(market_ticker, "_refresh_if_stale", lambda: {
        "by_symbol": {"BTCUSDT": {
            "symbol": "BTCUSDT", "lastPrice": "63950.81", "priceChangePercent": "1.33",
            "priceChange": "840.55", "bidPrice": "63950.80", "askPrice": "63950.82",
            "highPrice": "63990.0", "lowPrice": "62716.0", "volume": "10818.33",
            "quoteVolume": "685796751.71", "count": 1680226, "openTime": 0, "closeTime": 0,
        }},
        "cached": True, "stale": False, "error": None,
    })
    market_ticker._cache["fetched_at"] = fixed_now

    data = market_ticker.get_realtime("btcusdt")
    assert data["symbol"] == "BTCUSDT"
    assert data["venue"] == "binance"
    assert data["market_type"] == "spot"
    assert data["last"] == pytest.approx(63950.81)
    assert data["status"] == "live"
    assert data["error"] is None


def test_get_realtime_unknown_symbol_is_disconnected(monkeypatch):
    monkeypatch.setattr(market_ticker, "_refresh_if_stale", lambda: {
        "by_symbol": {}, "cached": False, "stale": False, "error": None,
    })
    data = market_ticker.get_realtime("NOPEUSDT")
    assert data["status"] == "disconnected"
    assert data["last"] is None
