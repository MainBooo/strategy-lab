from __future__ import annotations

"""Binance Spot realtime market data (REST layer).

Binance Spot trades 24/7 - there is no trading-session gating, no
"market_closed" status, and no fixed source-delay concept here (unlike the
old MOEX ISS free-tier feed, which had a measured constant ~15 minute lag).
Live candle/price streaming for open charts is handled by the frontend
connecting directly to Binance's public WebSocket
(wss://data-stream.binance.vision) - this module provides the REST-based
snapshot data used for initial page load, the ticker tape, watchlist
quotes, and the WS-unavailable fallback path.

Honest realtime statuses (see realtime_config/get_realtime): "live" (a
Binance kline/ticker event arrived recently), "stale" (nothing new for a
while - connection likely degraded), "connecting" / "disconnected" (frontend
WS lifecycle states, not something this REST layer itself reports), never
"market_closed" or a fixed "delayed" MOEX-style baseline.
"""

import logging
import os
import threading
from datetime import datetime, timezone

from binance_client import BinanceAPIError
from binance_market_data import fetch_price, fetch_ticker_24hr

log = logging.getLogger(__name__)

_TICKER_REFRESH_SEC = 5
_lock = threading.Lock()
_cache: dict = {"by_symbol": None, "fetched_at": None, "error": None}

# Shown on the scrolling tape / used as a fallback list if the 24hr-ticker
# endpoint is temporarily unavailable when building the "top by volume" set
# (spec section 28).
FALLBACK_TAPE_SYMBOLS = (
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
    "DOGEUSDT", "ADAUSDT", "LINKUSDT",
)

# A ticker is considered "stale" (not necessarily wrong, but old enough that
# the UI should say so) once its own snapshot age passes this, and
# "disconnected" once the whole feed itself has been failing this long.
STALE_AFTER_MS = 30_000
DISCONNECTED_AFTER_MS = 120_000


def realtime_config() -> dict:
    def _bool(name: str, default: str) -> bool:
        return os.environ.get(name, default).strip().lower() not in ("0", "false", "no", "")

    def _int(name: str, default: str) -> int:
        try:
            return int(os.environ.get(name, default))
        except ValueError:
            return int(default)

    return {
        "enabled": _bool("REALTIME_ENABLED", "true"),
        "ws_base": os.environ.get("BINANCE_WS_BASE", "wss://data-stream.binance.vision:443"),
        "stale_after_ms": _int("REALTIME_STALE_AFTER_MS", str(STALE_AFTER_MS)),
        "disconnected_after_ms": _int("REALTIME_DISCONNECTED_AFTER_MS", str(DISCONNECTED_AFTER_MS)),
    }


def _refresh_if_stale(symbols: list[str] | None = None) -> dict:
    """Returns {by_symbol, cached, stale, error}; refreshes the shared
    24hr-ticker cache under a lock, never raises. The lock means concurrent
    requests (tape + watchlist + portfolio, all polling around the same
    moment) collapse onto a single in-flight Binance round trip instead of
    each firing their own."""
    with _lock:
        now = datetime.now(timezone.utc)
        fresh = (
            _cache["by_symbol"] is not None
            and _cache["fetched_at"] is not None
            and (now - _cache["fetched_at"]).total_seconds() < _TICKER_REFRESH_SEC
        )
        if fresh:
            return {"by_symbol": _cache["by_symbol"], "cached": True, "stale": False, "error": None}
        try:
            rows = fetch_ticker_24hr(symbols=None)  # whole-market snapshot, one request covers everyone
            by_symbol = {str(r.get("symbol")): r for r in rows if r.get("symbol")}
            _cache["by_symbol"] = by_symbol
            _cache["fetched_at"] = now
            _cache["error"] = None
            return {"by_symbol": by_symbol, "cached": False, "stale": False, "error": None}
        except BinanceAPIError as exc:
            log.warning("Binance 24hr ticker fetch failed: %s", exc)
            _cache["error"] = str(exc)
            if _cache["by_symbol"] is not None:
                return {"by_symbol": _cache["by_symbol"], "cached": True, "stale": True, "error": str(exc)}
            return {"by_symbol": {}, "cached": False, "stale": False,
                     "error": "Не удалось получить данные Binance."}


def _normalize_quote(row: dict) -> dict:
    def _f(key, default=None):
        try:
            return float(row.get(key))
        except (TypeError, ValueError):
            return default

    return {
        "symbol": row.get("symbol"),
        "last": _f("lastPrice"),
        "change_pct": _f("priceChangePercent"),
        "change_abs": _f("priceChange"),
        "bid": _f("bidPrice"),
        "offer": _f("askPrice"),
        "high": _f("highPrice"),
        "low": _f("lowPrice"),
        "volume": _f("volume"),
        "quote_volume": _f("quoteVolume"),
        "num_trades": row.get("count"),
        "open_time": row.get("openTime"),
        "close_time": row.get("closeTime"),
    }


def get_top_by_volume(*, quote_asset: str = "USDT", limit: int = 20) -> dict:
    """Top `limit` active symbols by 24h quote volume for the given quote
    asset - drives the ticker tape (spec section 28). Falls back to
    FALLBACK_TAPE_SYMBOLS if the 24hr endpoint is unavailable."""
    snap = _refresh_if_stale()
    if not snap["by_symbol"]:
        return {"quotes": [], "cached": False, "stale": False, "error": snap["error"],
                "fallback": list(FALLBACK_TAPE_SYMBOLS)}
    quote_asset = quote_asset.upper()
    rows = [
        row for symbol, row in snap["by_symbol"].items()
        if symbol.endswith(quote_asset) and float(row.get("quoteVolume") or 0) > 0
    ]
    rows.sort(key=lambda r: float(r.get("quoteVolume") or 0), reverse=True)
    quotes = [_normalize_quote(r) for r in rows[:limit]]
    return {"quotes": quotes, "cached": snap["cached"], "stale": snap["stale"], "error": snap["error"]}


def get_market_ticker() -> dict:
    """Back-compat name for the scrolling-tape data source (spec keeps this
    endpoint name where reasonable) - top USDT pairs by 24h volume."""
    return get_top_by_volume(quote_asset="USDT", limit=20)


def get_prices(symbols: list[str] | None = None) -> dict:
    """Return {prices: {symbol: quote}, stale, error} for arbitrary symbols
    (e.g. a portfolio's instruments), backed by the same single
    whole-market cache as the tape - no extra Binance requests per symbol."""
    snap = _refresh_if_stale()
    by_symbol = snap["by_symbol"]
    if symbols is not None:
        wanted = {s.upper() for s in symbols}
        by_symbol = {s: q for s, q in by_symbol.items() if s in wanted}
    return {"prices": {s: _normalize_quote(q) for s, q in by_symbol.items()}, "stale": snap["stale"], "error": snap["error"]}


def _classify_status(*, fetch_error: str | None, has_quote: bool, age_ms: int | None, cfg: dict) -> str:
    """Three honestly-distinct REST-snapshot states (spec section 27) - the
    frontend's own WebSocket lifecycle (connecting/live/stale/disconnected)
    takes precedence whenever a live WS connection is open; this is only the
    REST-fallback/initial-load classification:

    - "disconnected": the Binance fetch itself is failing right now with no
      usable quote to fall back on, OR the cached snapshot is old enough
      that treating it as live would be dishonest, OR there's simply no
      quote for this symbol at all.
    - "stale": the feed has a quote, but it's aged past stale_after_ms -
      still shown, but flagged as possibly outdated.
    - "live": a healthy, recent quote. Binance Spot is 24/7, so unlike the
      old MOEX integration there is no separate "market_closed" state."""
    if fetch_error and not has_quote:
        return "disconnected"
    if age_ms is not None and age_ms > cfg["disconnected_after_ms"]:
        return "disconnected"
    if age_ms is not None and age_ms > cfg["stale_after_ms"]:
        return "stale"
    if not has_quote:
        return "disconnected"
    return "live"


def get_realtime(symbol: str) -> dict:
    """Normalized realtime block for one symbol - the shape the frontend
    indicator (static/realtime-indicator.js) renders directly. status is a
    REST-snapshot-age classification only; the frontend's own WebSocket
    lifecycle (connecting/live/stale/disconnected) takes precedence whenever
    a live WS connection is open - see spec section 27."""
    cfg = realtime_config()
    symbol = symbol.upper()
    snap = _refresh_if_stale()
    quote = snap["by_symbol"].get(symbol)
    now = datetime.now(timezone.utc)
    age_ms = None
    if _cache["fetched_at"] is not None:
        age_ms = max(0, round((now - _cache["fetched_at"]).total_seconds() * 1000))

    status = _classify_status(fetch_error=snap["error"], has_quote=quote is not None, age_ms=age_ms, cfg=cfg)

    normalized = _normalize_quote(quote) if quote else None
    return {
        "source": "binance",
        "venue": "binance",
        "market_type": "spot",
        "symbol": symbol,
        "last": normalized["last"] if normalized else None,
        "change_pct": normalized["change_pct"] if normalized else None,
        "bid": normalized["bid"] if normalized else None,
        "offer": normalized["offer"] if normalized else None,
        "age_ms": age_ms,
        "status": status,
        "error": snap["error"] if not quote else None,
        "config": cfg,
    }


def get_instrument_info(symbol: str) -> dict:
    """Full per-instrument detail block for the watchlist's instrument
    panel - combines a 24hr-ticker snapshot with locally-stored history
    coverage (market_data_store.coverage) rather than a second Binance
    round trip for "how much history do we actually have"."""
    import market_data_store as mds

    symbol = symbol.upper()
    try:
        rows = fetch_ticker_24hr(symbols=[symbol])
    except BinanceAPIError as exc:
        return {"symbol": symbol, "error": str(exc)}
    if not rows:
        return {"symbol": symbol, "error": "Инструмент не найден"}
    row = rows[0]
    quote = _normalize_quote(row)
    cov = mds.coverage(symbol, "1d")

    return {
        "symbol": symbol,
        "price": quote["last"],
        "open": row.get("openPrice"),
        "high": quote["high"],
        "low": quote["low"],
        "change_pct": quote["change_pct"],
        "volume": quote["volume"],
        "quote_volume": quote["quote_volume"],
        "num_trades": quote["num_trades"],
        "history_from": cov["earliest_ts"],
        "history_to": cov["latest_ts"],
        "history_candle_count": cov["candle_count"],
    }
