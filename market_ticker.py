from __future__ import annotations

import logging
import os
import threading
import time
from datetime import date, datetime, timedelta

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
_cache: dict = {"by_ticker": None, "fetched_at": None, "error": None, "server_received_at": None}

MARKETDATA_COLUMNS = "SECID,BID,OFFER,LAST,LASTTOPREVPRICE,VOLTODAY,NUMTRADES,TRADINGSTATUS,UPDATETIME,TIME,SYSTIME"

# MOEX's own free/anonymous ISS marketdata feed is not real-time: measured
# empirically (2026-08-05, live trading session, 5 liquid tickers - SBER,
# GAZP, LKOH, T, YDEX) at a rock-steady ~900s (15 minute) lag between a
# security's own last-trade TIME and the SYSTIME the row was served with -
# the standard exchange-data delay for a feed without a paid real-time data
# agreement, not a connectivity problem. This is a property of the SOURCE
# (constant, ~every ticker sees roughly the same lag on a fresh trade) and
# must never be confused with LAST_TRADE_AGE below, which is a property of
# the INSTRUMENT (how long ago its own last trade happened - can be minutes
# for a blue chip or hours for an illiquid name with no trades at all). Two
# tickers with the exact same healthy source connection can show wildly
# different "age" numbers just because one of them isn't trading right now -
# see docs/DYNAMIC_MARKET_DATA.md, "source delay vs last-trade age".
SOURCE_DELAY_MS = 900_000  # 15 minutes - the measured free-tier baseline above


def realtime_config() -> dict:
    def _int(name: str, default: str) -> int:
        try:
            return int(os.environ.get(name, default))
        except ValueError:
            return int(default)

    return {
        "enabled": os.environ.get("REALTIME_ENABLED", "true").strip().lower() not in ("0", "false", "no", ""),
        "poll_interval_ms": _int("REALTIME_POLL_INTERVAL_MS", "45000"),
        "source_delay_ms": _int("REALTIME_SOURCE_DELAY_MS", str(SOURCE_DELAY_MS)),
        # How far a ticker's own last-trade age is allowed to exceed the
        # source delay baseline before it stops being "just the normal
        # source lag" and starts being reported as "нет сделок" (illiquid /
        # no new prints) instead - see _classify_status.
        "no_trade_threshold_ms": _int("REALTIME_NO_TRADE_THRESHOLD_MS", "1200000"),  # 20 min: 5 min past baseline
    }


def is_trading_session(now_utc: datetime | None = None) -> bool:
    """Weekday + MSK session-hours check (no tzdata dependency: MSK is a
    fixed UTC+3 offset, Russia doesn't observe DST). Deliberately does NOT
    know about exchange holidays - there is no MOEX holiday calendar wired
    into this integration yet, so a public holiday that falls on a weekday
    is (honestly, not silently) a known gap: both the realtime badge and
    candle_api's synthetic gap-fill will treat it as a trading day. Shared
    by market_ticker (badge/status) and candle_api (gap-fill session
    bounds) so the two can never disagree about what "market open" means."""
    now = now_utc or datetime.utcnow()
    msk = now + timedelta(hours=3)
    if msk.weekday() >= 5:
        return False
    minutes = msk.hour * 60 + msk.minute
    return 10 * 60 <= minutes <= 23 * 60 + 50


def _parse_hms_today(hms: str | None, ref_date: date) -> datetime | None:
    """MOEX's TIME/UPDATETIME columns are wall-clock MSK "HH:MM:SS" with no
    date - combine with the given reference date (from that row's own
    SYSTIME, not our local clock, so a request straddling MSK midnight still
    pairs the trade time with the right calendar day)."""
    if not hms:
        return None
    try:
        h, m, s = (int(x) for x in hms.split(":"))
        return datetime(ref_date.year, ref_date.month, ref_date.day, h, m, s)
    except (ValueError, TypeError):
        return None


def _fetch_snapshot() -> tuple[dict[str, dict], datetime]:
    session = requests.Session()
    session.headers.update({"User-Agent": "MOEX-Strategy-Lab/3.0"})
    response = session.get(
        MARKETDATA_URL,
        params={"iss.only": "marketdata", "iss.meta": "off", "marketdata.columns": MARKETDATA_COLUMNS},
        timeout=10,
    )
    response.raise_for_status()
    server_received_at = datetime.utcnow()
    block = response.json().get("marketdata", {})
    columns = block.get("columns", [])
    by_ticker: dict[str, dict] = {}
    for values in block.get("data", []):
        item = dict(zip(columns, values))
        secid = str(item.get("SECID") or "")
        if not secid or item.get("LAST") is None:
            continue
        sys_dt = None
        if item.get("SYSTIME"):
            try:
                sys_dt = datetime.strptime(item["SYSTIME"], "%Y-%m-%d %H:%M:%S")
            except ValueError:
                sys_dt = None
        ref_date = sys_dt.date() if sys_dt else (server_received_at + timedelta(hours=3)).date()
        # TIME = this security's own last-trade wall-clock time (falls back to
        # UPDATETIME - last quote/bid-ask update - for names with a live book
        # but no fresh print, so a real-time indicator doesn't read "no data"
        # for an instrument that's simply not trading this instant).
        market_dt = _parse_hms_today(item.get("TIME") or item.get("UPDATETIME"), ref_date)
        # Backend's own clock vs the market event time, not MOEX's own
        # SYSTIME vs TIME - see docs/DYNAMIC_MARKET_DATA.md ("why backend
        # clock, not SYSTIME") for why this avoids trusting a second remote
        # clock for the number actually shown to users.
        delay_ms = None
        if market_dt is not None:
            market_dt_utc = market_dt - timedelta(hours=3)
            delay_ms = max(0, round((server_received_at - market_dt_utc).total_seconds() * 1000))
        last_price = float(item["LAST"])
        change_pct = float(item["LASTTOPREVPRICE"]) if item.get("LASTTOPREVPRICE") is not None else None
        # LASTTOPREVPRICE is MOEX's own "vs previous day's official close"
        # percentage (not the tick-to-tick LASTCHANGEPRCNT) - deriving the
        # absolute figure from it keeps both numbers referring to the same
        # baseline instead of mixing two different MOEX change concepts.
        change_abs = round(last_price - last_price / (1 + change_pct / 100), 2) if change_pct not in (None, -100) else None
        by_ticker[secid] = {
            "ticker": secid,
            "last": round(last_price, 2),
            "change_pct": round(change_pct, 2) if change_pct is not None else None,
            "change_abs": change_abs,
            "bid": item.get("BID"),
            "offer": item.get("OFFER"),
            "vol_today": item.get("VOLTODAY"),
            "num_trades": item.get("NUMTRADES"),
            "updated_at": item.get("UPDATETIME"),
            "market_time": item.get("TIME") or item.get("UPDATETIME"),
            "market_timestamp": market_dt.isoformat() if market_dt else None,
            "delay_ms": delay_ms,
            "is_live": item.get("TRADINGSTATUS") == "T",
            "trading_status": item.get("TRADINGSTATUS"),
        }
    return by_ticker, server_received_at


def _refresh_if_stale() -> dict:
    """Returns {by_ticker, cached, stale, error, server_received_at};
    refreshes the shared cache under a lock, never raises. The lock also
    means concurrent requests (tape + watchlist + portfolio + chart
    indicator, all polling around the same moment) collapse onto a single
    in-flight MOEX round trip instead of each firing their own - see
    candle_api._ensure_coverage for the equivalent guard on the candle
    cache side."""
    with _lock:
        now = datetime.utcnow()
        interval = _TRADING_INTERVAL_SEC if is_trading_session(now) else _CLOSED_INTERVAL_SEC
        fresh = (
            _cache["by_ticker"] is not None
            and _cache["fetched_at"] is not None
            and (now - _cache["fetched_at"]).total_seconds() < interval
        )
        if fresh:
            return {"by_ticker": _cache["by_ticker"], "cached": True, "stale": False, "error": None,
                    "server_received_at": _cache["server_received_at"]}
        try:
            by_ticker, server_received_at = _fetch_snapshot()
            _cache["by_ticker"] = by_ticker
            _cache["fetched_at"] = now
            _cache["server_received_at"] = server_received_at
            _cache["error"] = None
            return {"by_ticker": by_ticker, "cached": False, "stale": False, "error": None,
                    "server_received_at": server_received_at}
        except Exception as exc:
            log.warning("Market data fetch failed: %s", exc)
            _cache["error"] = str(exc)
            if _cache["by_ticker"] is not None:
                return {"by_ticker": _cache["by_ticker"], "cached": True, "stale": True, "error": str(exc),
                        "server_received_at": _cache["server_received_at"]}
            return {"by_ticker": {}, "cached": False, "stale": False,
                    "error": "Котировки MOEX временно недоступны.", "server_received_at": None}


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


def _classify_status(*, fetch_error: str | None, market_open: bool, last_trade_age_ms: int | None,
                      cfg: dict) -> str:
    """Six honestly-distinct causes, not one ever-growing timer (see
    docs/DYNAMIC_MARKET_DATA.md and the chart-analysis spec's "различать
    реальную задержку / отсутствие сделок / закрытый рынок / ошибку"):

    - "disconnected": the MOEX fetch itself is failing right now - a real
      technical problem, unrelated to any one ticker's trading activity.
    - "market_closed": the exchange session isn't open (checked first,
      before looking at any ticker-specific age, so a closed market is
      never misreported as "нет сделок").
    - "no_trades": market is open, the feed is healthy, but THIS ticker's
      own last trade is older than the source-delay baseline plus a
      tolerance band - i.e. illiquidity, not a source/connectivity issue.
    - "delayed": the normal, expected state - market open, feed healthy,
      last trade age within the tolerance band around the known ~15min
      source lag. This is this integration's steady-state "everything is
      fine" status (see realtime_config's SOURCE_DELAY_MS docstring for why
      it's never "live")."""
    if fetch_error:
        return "disconnected"
    if not market_open:
        return "market_closed"
    if last_trade_age_ms is None or last_trade_age_ms > cfg["no_trade_threshold_ms"]:
        return "no_trades"
    return "delayed"


def get_realtime(ticker: str) -> dict:
    """Normalized realtime block for one ticker - the shape the frontend
    indicator (static/realtime-indicator.js) renders directly. See
    docs/DYNAMIC_MARKET_DATA.md for the field-by-field meaning and why
    status can never be "live" for this integration.

    Exposes source_delay_ms (constant, the source's own advertised lag) and
    last_trade_age_ms (per-ticker, how long since this instrument's own
    last print) as two separate numbers - never collapse them back into one
    "delay" figure, that conflation is exactly what made illiquid names
    like a low-volume second-tier ticker show a misleading multi-hour
    "delay" that was actually just "no one has traded this in a while"."""
    cfg = realtime_config()
    ticker = ticker.upper()
    snap = _refresh_if_stale()
    quote = snap["by_ticker"].get(ticker)
    market_open = is_trading_session()
    response_generated_at = datetime.utcnow()
    last_trade_age_ms = quote["delay_ms"] if quote else None
    # Add the time spent sitting in our own cache since the last real MOEX
    # fetch, so the age reflects "how old is what you're looking at right
    # now", not just the age of the response at the moment we fetched it.
    if last_trade_age_ms is not None and snap.get("server_received_at") is not None:
        last_trade_age_ms += max(0, round((response_generated_at - snap["server_received_at"]).total_seconds() * 1000))
    status = _classify_status(fetch_error=snap["error"] if not quote else None, market_open=market_open,
                               last_trade_age_ms=last_trade_age_ms, cfg=cfg)
    return {
        "source": "MOEX",
        "ticker": ticker,
        "last": quote["last"] if quote else None,
        "change_pct": quote["change_pct"] if quote else None,
        "bid": quote.get("bid") if quote else None,
        "offer": quote.get("offer") if quote else None,
        "market_timestamp": quote["market_timestamp"] if quote else None,
        "market_time": quote["market_time"] if quote else None,
        "server_received_at": snap["server_received_at"].isoformat() if snap.get("server_received_at") else None,
        "response_generated_at": response_generated_at.isoformat(),
        "source_delay_ms": cfg["source_delay_ms"],
        "last_trade_age_ms": last_trade_age_ms,
        "delay_ms": last_trade_age_ms,  # back-compat alias, same value as last_trade_age_ms
        "status": status,
        "market_status": "open" if market_open else "closed",
        "error": snap["error"] if not quote else None,
        "config": cfg,
    }


_STATUS_LABELS = {"T": "Торги идут", "S": "Приостановлены", "N": "Торги закрыты", "C": "Закрытие"}


def get_instrument_info(ticker: str, board: str = "TQBR") -> dict:
    """Full per-instrument detail block for the watchlist's "Сведения об
    инструменте" panel (Stage 11) - one MOEX ISS call to the per-security
    board endpoint returns both the `securities` (name/lot/board) and
    `marketdata` (day OHLC/volume/status) blocks together, so this never
    needs the separate whole-board fetch _fetch_snapshot() uses for the
    watchlist's bulk quotes. History range comes from the local candle
    store (market_data_store.coverage) rather than another MOEX round trip -
    it's already the source of truth for what this app can actually chart,
    which is more useful here than MOEX's own listed-history dates. """
    import market_data_store as mds

    ticker = ticker.upper()
    url = f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/{board}/securities/{ticker}.json"
    try:
        session = requests.Session()
        session.headers.update({"User-Agent": "MOEX-Strategy-Lab/3.0"})
        resp = session.get(url, params={"iss.meta": "off"}, timeout=10)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:
        return {"ticker": ticker, "board": board, "error": str(exc)}

    sec_block = payload.get("securities") or {}
    md_block = payload.get("marketdata") or {}
    sec_rows = sec_block.get("data") or []
    md_rows = md_block.get("data") or []
    if not sec_rows:
        return {"ticker": ticker, "board": board, "error": "Инструмент не найден"}
    sec = dict(zip(sec_block["columns"], sec_rows[0]))
    md = dict(zip(md_block["columns"], md_rows[0])) if md_rows else {}

    lot_size = sec.get("LOTSIZE") or 1
    last = md.get("LAST") or sec.get("PREVPRICE")
    cov = mds.coverage(ticker, board, "1d")

    return {
        "ticker": ticker,
        "board": board,
        "name": sec.get("SECNAME") or sec.get("SHORTNAME") or ticker,
        "shortname": sec.get("SHORTNAME"),
        "isin": sec.get("ISIN"),
        "board_title": sec.get("BOARDNAME"),
        "currency": sec.get("CURRENCYID") or sec.get("FACEUNIT"),
        "lot_size": lot_size,
        "lot_value": round(last * lot_size, 2) if last is not None else None,
        "price": last,
        "open": md.get("OPEN"),
        "high": md.get("HIGH"),
        "low": md.get("LOW"),
        "prev_price": sec.get("PREVPRICE"),
        "volume": md.get("VOLTODAY"),
        "value": md.get("VALTODAY"),
        "change_pct": md.get("LASTCHANGEPRCNT"),
        "trading_status": md.get("TRADINGSTATUS"),
        "trading_status_label": _STATUS_LABELS.get(md.get("TRADINGSTATUS"), md.get("TRADINGSTATUS")),
        "history_from": cov["earliest_ts"],
        "history_to": cov["latest_ts"],
        "history_candle_count": cov["candle_count"],
    }
