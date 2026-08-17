from __future__ import annotations

"""Binance Spot instrument catalog, built from GET /api/v3/exchangeInfo.

Replaces moex_catalog.py. Filters in Binance's exchangeInfo response are an
array of {"filterType": ..., ...} objects whose SET and ORDER vary by
symbol/permission set - this module looks each one up BY TYPE, never by a
fixed array index, exactly per the migration spec (a symbol missing an
optional filter, e.g. no MIN_NOTIONAL, is normal, not an error).
"""

import json
import logging
import os
import time
import uuid
from pathlib import Path

from binance_client import BinanceAPIError, request

log = logging.getLogger(__name__)

EXCHANGE_INFO_PATH = "/api/v3/exchangeInfo"

# The quote assets surfaced as UI filter chips (spec section 4) - USDT is the
# default/primary one for an ordinary user. Any other quote asset present in
# exchangeInfo is still returned in the full catalog, just not pinned here.
KNOWN_QUOTE_ASSETS = ("USDT", "USDC", "BTC", "FDUSD", "EUR")

# In-process refresh guard: exchangeInfo is a large (multi-MB) response for
# ~2000+ symbols; a burst of concurrent "no catalog cached yet" requests
# should collapse onto a single Binance round trip, not each fire their own.
_refresh_lock_holder = {"lock": None}


def _get_filter(filters: list[dict], filter_type: str) -> dict | None:
    for f in filters or []:
        if f.get("filterType") == filter_type:
            return f
    return None


def _normalize_symbol(entry: dict) -> dict:
    filters = entry.get("filters") or []
    price_filter = _get_filter(filters, "PRICE_FILTER")
    lot_filter = _get_filter(filters, "LOT_SIZE")
    market_lot_filter = _get_filter(filters, "MARKET_LOT_SIZE")
    # Binance renamed MIN_NOTIONAL -> NOTIONAL on newer symbols; both carry a
    # "minNotional" field, so either satisfies this lookup transparently.
    notional_filter = _get_filter(filters, "NOTIONAL") or _get_filter(filters, "MIN_NOTIONAL")

    def _num(value) -> float | None:
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    return {
        "symbol": entry.get("symbol"),
        "baseAsset": entry.get("baseAsset"),
        "quoteAsset": entry.get("quoteAsset"),
        "status": entry.get("status"),
        "isSpotTradingAllowed": bool(entry.get("isSpotTradingAllowed", True)),
        "baseAssetPrecision": entry.get("baseAssetPrecision"),
        "quoteAssetPrecision": entry.get("quoteAssetPrecision") or entry.get("quotePrecision"),
        "tickSize": _num(price_filter.get("tickSize")) if price_filter else None,
        "minPrice": _num(price_filter.get("minPrice")) if price_filter else None,
        "maxPrice": _num(price_filter.get("maxPrice")) if price_filter else None,
        "stepSize": _num(lot_filter.get("stepSize")) if lot_filter else None,
        "minQty": _num(lot_filter.get("minQty")) if lot_filter else None,
        "maxQty": _num(lot_filter.get("maxQty")) if lot_filter else None,
        "marketStepSize": _num(market_lot_filter.get("stepSize")) if market_lot_filter else None,
        "minNotional": _num(notional_filter.get("minNotional")) if notional_filter else None,
    }


def fetch_exchange_info() -> list[dict]:
    """One call, no pagination - Binance returns the full symbol list in a
    single exchangeInfo response."""
    payload = request(EXCHANGE_INFO_PATH, timeout=30)
    symbols = payload.get("symbols", []) if isinstance(payload, dict) else []
    out = []
    for entry in symbols:
        if entry.get("isSpotTradingAllowed") is False:
            continue
        normalized = _normalize_symbol(entry)
        if normalized["symbol"]:
            out.append(normalized)
    out.sort(key=lambda s: (s["quoteAsset"] != "USDT", s["symbol"]))
    return out


def save_catalog(path: Path) -> list[dict]:
    items = fetch_exchange_info()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp_path, path)
    return items


# Cached catalogs older than this are still served (stale-but-usable) if a
# background refresh is impossible right now, but a foreground load past
# this age triggers a refresh attempt first.
_CATALOG_TTL_SECONDS = 6 * 3600


def load_catalog(path: Path, refresh: bool = False) -> list[dict]:
    if not refresh and path.exists():
        try:
            if time.time() - path.stat().st_mtime < _CATALOG_TTL_SECONDS:
                return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Catalog cache at %s unreadable (%s), refetching", path, exc)

    try:
        return save_catalog(path)
    except (BinanceAPIError, OSError):
        log.exception("Failed to refresh Binance catalog")
        if path.exists():
            try:
                stale = json.loads(path.read_text(encoding="utf-8"))
                log.warning("Serving stale cached Binance catalog after refresh failure")
                return stale
            except (json.JSONDecodeError, OSError):
                pass
        raise


def instrument_by_symbol(items: list[dict], symbol: str) -> dict | None:
    symbol = symbol.upper()
    for item in items:
        if str(item.get("symbol", "")).upper() == symbol:
            return item
    return None


def search(items: list[dict], *, query: str | None = None, quote_asset: str | None = None,
           active_only: bool = True) -> list[dict]:
    rows = items
    if active_only:
        rows = [r for r in rows if r.get("status") == "TRADING"]
    if quote_asset:
        quote_asset = quote_asset.upper()
        rows = [r for r in rows if r.get("quoteAsset") == quote_asset]
    if query:
        q = query.upper().strip()
        rows = [r for r in rows if q in str(r.get("symbol", "")) or q in str(r.get("baseAsset", ""))]
    return rows
