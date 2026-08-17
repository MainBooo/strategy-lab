from __future__ import annotations

"""Shared Binance-mocking helpers for the market-data test suite.

Fakes the transport-level `request()` call so tests exercise the REAL
pagination/retry/aggregation logic in market_data_sync.py/
binance_market_data.py/candle_api.py against a fake response, instead of
mocking those modules' own internals. No test in this suite makes a real
network call.

IMPORTANT: patch it as `monkeypatch.setattr(binance_market_data, "request",
fake_klines_request(...))` - NOT `binance_client.request`.
binance_market_data.py does `from binance_client import request` (a
name-bound import), so it holds its own reference to the function object;
patching binance_client's own attribute afterward does not affect the name
binance_market_data already bound at import time.
"""

import calendar
import time

MAX_PAGE_ROWS = 1000


def _date_to_ms(date_str: str) -> int:
    return calendar.timegm(time.strptime(date_str, "%Y-%m-%d")) * 1000


def fake_klines_request(calls: list[dict], *, freq_minutes: int = 24 * 60,
                         price_start: float = 100.0, fail_first_n: int = 0):
    """Returns a function with binance_client.request's signature
    (path, params=None, timeout=..., max_retries=...) that fabricates
    real-shaped Binance kline rows spaced `freq_minutes` apart, honoring
    startTime/endTime/limit exactly like the real endpoint - so the
    pagination loop in binance_market_data.fetch_klines_range terminates
    naturally on a short page, the same real logic a live sync would hit.

    `fail_first_n`, if set, raises a BinanceAPIError-like transient error
    for the first N calls (simulating retries) before succeeding - use with
    a monkeypatched RETRY_BASE_DELAY/time.sleep to keep the test fast.
    """
    from binance_client import BinanceAPIError

    state = {"n": 0}

    def _fake(path, params=None, timeout=15, max_retries=5):
        state["n"] += 1
        calls.append(dict(params or {}))
        if state["n"] <= fail_first_n:
            raise BinanceAPIError("Binance временно недоступен (мок)")
        params = params or {}
        start_ms = int(params["startTime"])
        end_ms = int(params.get("endTime") or start_ms + 10 ** 15)
        limit = int(params.get("limit", MAX_PAGE_ROWS))
        step_ms = freq_minutes * 60 * 1000
        rows = []
        ts = start_ms
        i = 0
        while ts <= end_ms and len(rows) < limit:
            o = price_start + i
            rows.append([
                ts, o, o + 1, o - 1, o + 0.5, 1000 + i,
                ts + step_ms - 1, 12345.0 + i, 10 + i, 5.0, 6000.0, "0",
            ])
            ts += step_ms
            i += 1
        return rows

    return _fake


def seed_candles(symbol: str, timeframe: str, from_date: str, till_date: str, *,
                  freq_minutes: int = 24 * 60, price_start: float = 100.0) -> int:
    """Directly upserts fabricated candles into market_data_store, bypassing
    the network path entirely - for tests that only care about read-path
    behavior (aggregation, cursor pagination) and don't need to exercise
    the sync/HTTP layer at all."""
    import market_data_store as store

    start_ms = _date_to_ms(from_date)
    end_ms = _date_to_ms(till_date) + 86_399_000
    step_ms = freq_minutes * 60 * 1000
    rows = []
    ts = start_ms
    i = 0
    while ts <= end_ms:
        o = price_start + i
        rows.append({
            "ts": ts // 1000, "open": o, "high": o + 1, "low": o - 1, "close": o + 0.5,
            "volume": 1000 + i, "quote_volume": 12345.0 + i, "num_trades": 10 + i,
            "taker_buy_base_volume": 5.0, "taker_buy_quote_volume": 6000.0,
        })
        ts += step_ms
        i += 1
    return store.upsert_candles(symbol, timeframe, rows)
