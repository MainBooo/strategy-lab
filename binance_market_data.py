from __future__ import annotations

"""Historical OHLCV candles from Binance Spot public REST (GET /api/v3/klines),
normalized into Strategy Lab's internal candle shape and paginated safely.

Binance kline row shape (per interval, ascending by open time):
  [openTime_ms, open, high, low, close, volume, closeTime_ms, quoteVolume,
   numTrades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore]

Internal normalized dict (unix SECONDS, matching market_data_store's schema):
  {"ts", "open", "high", "low", "close", "volume", "quote_volume",
   "num_trades", "taker_buy_base_volume", "taker_buy_quote_volume"}
"""

import logging
import time

from binance_client import BinanceAPIError, request
from timeframes import AGGREGATE_TIMEFRAMES, binance_interval

log = logging.getLogger(__name__)

KLINES_PATH = "/api/v3/klines"
MAX_LIMIT_PER_PAGE = 1000
PAGE_SLEEP_SECONDS = 0.1


class SyncCanceled(Exception):
    pass


def _row_to_candle(row: list) -> dict | None:
    try:
        return {
            "ts": int(row[0]) // 1000,
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
            "quote_volume": float(row[7]),
            "num_trades": int(row[8]),
            "taker_buy_base_volume": float(row[9]),
            "taker_buy_quote_volume": float(row[10]),
        }
    except (IndexError, TypeError, ValueError):
        return None


def fetch_klines_page(symbol: str, timeframe: str, *, start_ms: int | None = None,
                       end_ms: int | None = None, limit: int = MAX_LIMIT_PER_PAGE) -> list[dict]:
    params = {
        "symbol": symbol.upper(),
        "interval": binance_interval(timeframe),
        "limit": min(limit, MAX_LIMIT_PER_PAGE),
    }
    if start_ms is not None:
        params["startTime"] = int(start_ms)
    if end_ms is not None:
        params["endTime"] = int(end_ms)
    rows = request(KLINES_PATH, params=params)
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows:
        candle = _row_to_candle(row)
        if candle is not None:
            out.append(candle)
    return out


def fetch_klines_range(symbol: str, timeframe: str, *, start_ms: int, end_ms: int,
                        max_pages: int | None = None, should_cancel=None,
                        on_page=None) -> dict:
    """Forward-paginates klines from start_ms to end_ms (inclusive), 1000
    bars per Binance page, advancing next_start = last_open_time_ms + 1 each
    time - never re-requesting a page already seen. Guards against:
      - an empty page (stop - nothing more in range);
      - a page whose last candle doesn't advance the cursor (stop - would
        otherwise spin forever on a malformed/duplicate response);
      - exceeding max_pages (stops early, status="partial" - a safety valve
        for callers invoked synchronously inside a web request).

    `on_page(page: list[dict])`, if given, is called with each page's
    candles as they arrive (so a caller can write them to storage
    incrementally - an interrupted deep backfill then leaves real, usable
    partial data behind instead of nothing, same property the old MOEX sync
    had). Returns {"rows_fetched", "pages_fetched", "status"} - no `status`
    other than "completed"/"partial"/"canceled" is ever returned.
    """
    cursor = int(start_ms)
    pages = 0
    rows_fetched = 0
    status = "completed"
    seen_last_ts: int | None = None

    while cursor <= end_ms:
        if should_cancel and should_cancel():
            status = "canceled"
            break
        page = fetch_klines_page(symbol, timeframe, start_ms=cursor, end_ms=end_ms)
        pages += 1
        if not page:
            break
        rows_fetched += len(page)
        if on_page:
            on_page(page)
        last_open_ms = page[-1]["ts"] * 1000
        if seen_last_ts is not None and last_open_ms <= seen_last_ts:
            # Cursor failed to advance - would loop forever on a
            # misbehaving/duplicate response. Stop, keep what we have.
            log.warning("Binance klines cursor did not advance for %s/%s at %s - stopping page loop",
                        symbol, timeframe, last_open_ms)
            break
        seen_last_ts = last_open_ms
        cursor = last_open_ms + 1
        if max_pages is not None and pages >= max_pages:
            status = "partial"
            break
        if len(page) < MAX_LIMIT_PER_PAGE:
            # Short page = Binance has nothing more in this range.
            break
        time.sleep(PAGE_SLEEP_SECONDS)

    return {"rows_fetched": rows_fetched, "pages_fetched": pages, "status": status}


def aggregate_candles(candles: list[dict], bucket_seconds: int) -> list[dict]:
    """Rolls up already-sorted-ascending native candles into `bucket_seconds`
    buckets, bucketed strictly on UTC open time: open=first, high=max,
    low=min, close=last, volume/quote_volume/num_trades=sum. Used for the
    10m-from-5m backward-compat aggregation (AGGREGATE_TIMEFRAMES)."""
    result: list[dict] = []
    current: dict | None = None
    for c in candles:
        key = (int(c["ts"]) // bucket_seconds) * bucket_seconds
        if current is None or current["ts"] != key:
            if current is not None:
                result.append(current)
            current = {
                "ts": key, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"],
                "volume": c["volume"], "quote_volume": c.get("quote_volume") or 0,
                "num_trades": c.get("num_trades") or 0,
                "taker_buy_base_volume": c.get("taker_buy_base_volume") or 0,
                "taker_buy_quote_volume": c.get("taker_buy_quote_volume") or 0,
            }
        else:
            current["high"] = max(current["high"], c["high"])
            current["low"] = min(current["low"], c["low"])
            current["close"] = c["close"]
            current["volume"] += c["volume"]
            current["quote_volume"] += c.get("quote_volume") or 0
            current["num_trades"] += c.get("num_trades") or 0
            current["taker_buy_base_volume"] += c.get("taker_buy_base_volume") or 0
            current["taker_buy_quote_volume"] += c.get("taker_buy_quote_volume") or 0
    if current is not None:
        result.append(current)
    return result


def fetch_ticker_24hr(symbols: list[str] | None = None) -> list[dict]:
    params = {}
    if symbols:
        if len(symbols) == 1:
            params["symbol"] = symbols[0].upper()
        else:
            import json as _json
            params["symbols"] = _json.dumps([s.upper() for s in symbols])
    payload = request("/api/v3/ticker/24hr", params=params or None, timeout=20)
    return payload if isinstance(payload, list) else ([payload] if isinstance(payload, dict) else [])


def fetch_price(symbol: str | None = None) -> dict | list[dict]:
    params = {"symbol": symbol.upper()} if symbol else None
    return request("/api/v3/ticker/price", params=params, timeout=10)


def fetch_server_time() -> int:
    payload = request("/api/v3/time", timeout=10)
    return int(payload.get("serverTime", 0)) if isinstance(payload, dict) else 0
