from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta

import requests

from sectors import SECURITY_PRESETS

log = logging.getLogger(__name__)

MARKETDATA_URL = (
    "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json"
)
# The scrolling tape shows the same liquid-blue-chip set already used for the
# "ТОП-20" catalog preset, so the two stay consistent without a second list.
TAPE_TICKERS = SECURITY_PRESETS["top20"]

_TRADING_INTERVAL_SEC = 45
_CLOSED_INTERVAL_SEC = 300

_lock = threading.Lock()
# One cache for the whole TQBR board (not just the tape's 20 tickers) so any
# portfolio instrument can look up a real last price without a second,
# per-ticker MOEX request - still exactly one grouped fetch per refresh.
_cache: dict = {"by_ticker": None, "fetched_at": None, "error": None}


def _is_trading_hours(now_utc: datetime | None = None) -> bool:
    # No tzdata dependency: MSK is a fixed UTC+3 offset (Russia doesn't
    # observe DST), so a plain offset is exact, not an approximation.
    now = now_utc or datetime.utcnow()
    msk = now + timedelta(hours=3)
    if msk.weekday() >= 5:
        return False
    minutes = msk.hour * 60 + msk.minute
    return 10 * 60 <= minutes <= 23 * 60 + 50


def _fetch_snapshot() -> dict[str, dict]:
    session = requests.Session()
    session.headers.update({"User-Agent": "MOEX-Strategy-Lab/3.0"})
    response = session.get(
        MARKETDATA_URL,
        params={
            "iss.only": "marketdata",
            "iss.meta": "off",
            "marketdata.columns": "SECID,LAST,LASTTOPREVPRICE,UPDATETIME,TRADINGSTATUS",
        },
        timeout=10,
    )
    response.raise_for_status()
    block = response.json().get("marketdata", {})
    columns = block.get("columns", [])
    by_ticker: dict[str, dict] = {}
    for values in block.get("data", []):
        item = dict(zip(columns, values))
        secid = str(item.get("SECID") or "")
        if not secid or item.get("LAST") is None:
            continue
        by_ticker[secid] = {
            "ticker": secid,
            "last": round(float(item["LAST"]), 2),
            "change_pct": round(float(item["LASTTOPREVPRICE"]), 2) if item.get("LASTTOPREVPRICE") is not None else None,
            "updated_at": item.get("UPDATETIME"),
            "is_live": item.get("TRADINGSTATUS") == "T",
        }
    return by_ticker


def _refresh_if_stale() -> dict:
    """Returns {by_ticker, cached, stale, error}; refreshes the shared cache
    under a lock, never raises."""
    with _lock:
        now = datetime.utcnow()
        interval = _TRADING_INTERVAL_SEC if _is_trading_hours(now) else _CLOSED_INTERVAL_SEC
        fresh = (
            _cache["by_ticker"] is not None
            and _cache["fetched_at"] is not None
            and (now - _cache["fetched_at"]).total_seconds() < interval
        )
        if fresh:
            return {"by_ticker": _cache["by_ticker"], "cached": True, "stale": False, "error": None}
        try:
            by_ticker = _fetch_snapshot()
            _cache["by_ticker"] = by_ticker
            _cache["fetched_at"] = now
            _cache["error"] = None
            return {"by_ticker": by_ticker, "cached": False, "stale": False, "error": None}
        except Exception as exc:
            log.warning("Market data fetch failed: %s", exc)
            _cache["error"] = str(exc)
            if _cache["by_ticker"] is not None:
                return {"by_ticker": _cache["by_ticker"], "cached": True, "stale": True, "error": str(exc)}
            return {"by_ticker": {}, "cached": False, "stale": False, "error": "Котировки MOEX временно недоступны."}


def get_market_ticker() -> dict:
    """Return {quotes, cached, stale, error} for the scrolling tape - never
    raises. Real MOEX marketdata only, refreshed at most every 30-60s during
    trading hours (300s once the market is closed)."""
    snap = _refresh_if_stale()
    quotes = [snap["by_ticker"][t] for t in TAPE_TICKERS if t in snap["by_ticker"]]
    return {"quotes": quotes, "cached": snap["cached"], "stale": snap["stale"], "error": snap["error"]}


def get_prices(tickers: list[str] | None = None) -> dict:
    """Return {prices: {ticker: quote}, stale, error} for arbitrary tickers
    (e.g. a portfolio's instruments), backed by the same single board-wide
    cache as the tape - no extra MOEX requests are made per ticker."""
    snap = _refresh_if_stale()
    by_ticker = snap["by_ticker"]
    if tickers is not None:
        wanted = {t.upper() for t in tickers}
        by_ticker = {t: q for t, q in by_ticker.items() if t in wanted}
    return {"prices": by_ticker, "stale": snap["stale"], "error": snap["error"]}
