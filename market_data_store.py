from __future__ import annotations

"""Centralized OHLCV candle storage (SQLite) - the single source of truth
for Charts, Backtest, Portfolio Backtest, Optimizer and Market Replay.

Schema identifies a series by (venue, market_type, symbol, timeframe) -
venue="binance", market_type="spot" today, kept as real columns (not
hardcoded into the table name) so a future venue/market type doesn't need
another migration. Connection style: short-lived per-call connections, WAL
mode, so multiple gunicorn worker processes share the file safely without a
connection pool.

No synthetic/fabricated candles: unlike the old MOEX-era store, there is no
"insert a flat placeholder for a missing bar" path here. A gap in coverage
stays a gap - see candle_api.py's coverage tracking instead.
"""

import os
import sqlite3
import threading
import time
from pathlib import Path

_DB_PATH: Path | None = None

SCHEMA_VERSION = 1

DEFAULT_VENUE = "binance"
DEFAULT_MARKET_TYPE = "spot"

# Per (symbol, timeframe) locks so concurrent requests for the same series
# (e.g. opening a 6-tile chart layout, which fires up to 6 /api/candles
# calls at once, or several browser tabs on the same symbol) serialize onto
# a single Binance sync instead of each firing its own redundant download -
# see candle_api._ensure_coverage(). Only guards against duplicate work
# *within this process*; sync_state.status="running" (checked by the same
# call site) is the cross-process backstop since gunicorn runs multiple
# workers.
_sync_locks: dict[tuple, threading.Lock] = {}
_sync_locks_guard = threading.Lock()


def sync_lock(symbol: str, timeframe: str) -> threading.Lock:
    key = (symbol, timeframe)
    with _sync_locks_guard:
        lock = _sync_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _sync_locks[key] = lock
        return lock


def cache_config() -> dict:
    """Bounded-cache settings, read from the environment on every call so a
    changed env var (or a test) takes effect without a process restart -
    these are checked at most a few times per request, never in a hot loop."""
    def _bool(name: str, default: str) -> bool:
        return os.environ.get(name, default).strip().lower() not in ("0", "false", "no", "")

    def _float(name: str, default: str) -> float:
        try:
            return float(os.environ.get(name, default))
        except ValueError:
            return float(default)

    return {
        "enabled": _bool("MARKET_CACHE_ENABLED", "true"),
        "max_gb": _float("MARKET_CACHE_MAX_GB", "40"),
        "ttl_days": _float("MARKET_CACHE_TTL_DAYS", "7"),
    }


def _connect() -> sqlite3.Connection:
    if _DB_PATH is None:
        raise RuntimeError("market_data_store.init_db() was not called")
    conn = sqlite3.connect(_DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db(path: Path) -> None:
    global _DB_PATH
    _DB_PATH = Path(path)
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = _connect()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS candles (
                venue TEXT NOT NULL DEFAULT 'binance',
                market_type TEXT NOT NULL DEFAULT 'spot',
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                ts INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL DEFAULT 0,
                quote_volume REAL,
                num_trades INTEGER,
                taker_buy_base_volume REAL,
                taker_buy_quote_volume REAL,
                PRIMARY KEY (venue, market_type, symbol, timeframe, ts)
            );
            CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_ts
                ON candles(symbol, timeframe, ts);

            CREATE TABLE IF NOT EXISTS sync_state (
                venue TEXT NOT NULL DEFAULT 'binance',
                market_type TEXT NOT NULL DEFAULT 'spot',
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                earliest_ts INTEGER,
                latest_ts INTEGER,
                candle_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'idle',
                progress_pct REAL NOT NULL DEFAULT 0,
                last_synced_at REAL,
                last_accessed_at REAL,
                last_error TEXT,
                backfilled_complete INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL,
                PRIMARY KEY (venue, market_type, symbol, timeframe)
            );

            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                started_at REAL NOT NULL,
                finished_at REAL,
                status TEXT NOT NULL,
                rows_added INTEGER NOT NULL DEFAULT 0,
                pages_fetched INTEGER NOT NULL DEFAULT 0,
                retries INTEGER NOT NULL DEFAULT 0,
                error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sync_log_symbol
                ON sync_log(symbol, timeframe, started_at);
            """
        )
        conn.commit()
        # DELETEs only free pages back to SQLite's own freelist, not to the
        # OS, unless auto_vacuum is on - without it, evict_if_needed() below
        # could delete every row and the .db file would never actually
        # shrink. auto_vacuum can only be turned on via a one-time VACUUM,
        # guarded by the pragma read below so it's a no-op on later restarts.
        mode = conn.execute("PRAGMA auto_vacuum").fetchone()[0]
        if mode != 2:  # 2 = incremental
            conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
            conn.execute("VACUUM")
    finally:
        conn.close()


def touch_access(symbol: str, timeframe: str, *, venue: str = DEFAULT_VENUE,
                  market_type: str = DEFAULT_MARKET_TYPE) -> None:
    """Marks a series as just-read, for LRU eviction ordering. Best-effort:
    a lock timeout here should never fail the candle request it's attached
    to, so failures are swallowed rather than propagated."""
    conn = _connect()
    try:
        conn.execute(
            """INSERT INTO sync_state (venue, market_type, symbol, timeframe, last_accessed_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(venue, market_type, symbol, timeframe) DO UPDATE SET last_accessed_at=excluded.last_accessed_at""",
            (venue, market_type, symbol, timeframe, time.time(), time.time()),
        )
        conn.commit()
    except sqlite3.Error:
        pass
    finally:
        conn.close()


def db_size_bytes() -> int:
    if _DB_PATH is None or not _DB_PATH.exists():
        return 0
    total = _DB_PATH.stat().st_size
    for suffix in ("-wal", "-shm"):
        p = _DB_PATH.with_name(_DB_PATH.name + suffix)
        if p.exists():
            total += p.stat().st_size
    return total


def _delete_series(conn: sqlite3.Connection, venue: str, market_type: str, symbol: str, timeframe: str) -> int:
    cur = conn.execute(
        "DELETE FROM candles WHERE venue=? AND market_type=? AND symbol=? AND timeframe=?",
        (venue, market_type, symbol, timeframe),
    )
    conn.execute(
        "DELETE FROM sync_state WHERE venue=? AND market_type=? AND symbol=? AND timeframe=?",
        (venue, market_type, symbol, timeframe),
    )
    return cur.rowcount


def evict_if_needed(logger=None) -> dict:
    """Bounds local disk usage of the candle cache: first drops series idle
    longer than MARKET_CACHE_TTL_DAYS, then - if still over
    MARKET_CACHE_MAX_GB - drops the least-recently-accessed remaining series
    one at a time until back under budget. Evicted data isn't lost, just no
    longer local: candle_api re-fetches it from Binance on the next request
    for that range. No-op when MARKET_CACHE_ENABLED=false (unlimited growth,
    today's pre-existing behavior)."""
    cfg = cache_config()
    if not cfg["enabled"]:
        return {"enabled": False}
    conn = _connect()
    evicted: list[dict] = []
    try:
        cutoff = time.time() - cfg["ttl_days"] * 86400
        idle = conn.execute(
            "SELECT venue, market_type, symbol, timeframe FROM sync_state "
            "WHERE COALESCE(last_accessed_at, updated_at) < ? AND status != 'running'",
            (cutoff,),
        ).fetchall()
        for row in idle:
            rows = _delete_series(conn, row["venue"], row["market_type"], row["symbol"], row["timeframe"])
            if rows:
                evicted.append({"symbol": row["symbol"], "timeframe": row["timeframe"], "reason": "ttl", "rows": rows})
        conn.commit()

        max_bytes = cfg["max_gb"] * (1024 ** 3)
        guard = 0
        while db_size_bytes() > max_bytes and guard < 10000:
            guard += 1
            row = conn.execute(
                "SELECT venue, market_type, symbol, timeframe FROM sync_state WHERE status != 'running' "
                "ORDER BY COALESCE(last_accessed_at, updated_at) ASC LIMIT 1"
            ).fetchone()
            if not row:
                break
            rows = _delete_series(conn, row["venue"], row["market_type"], row["symbol"], row["timeframe"])
            conn.commit()
            evicted.append({"symbol": row["symbol"], "timeframe": row["timeframe"], "reason": "size", "rows": rows})
            conn.execute("PRAGMA incremental_vacuum")
            conn.commit()

        if evicted:
            conn.execute("PRAGMA incremental_vacuum")
            conn.commit()
    except sqlite3.Error as exc:
        if logger:
            logger.exception("Market data cache eviction failed")
        return {"enabled": True, "error": str(exc), "evicted": evicted}
    finally:
        conn.close()
    if evicted and logger:
        logger.info("Market data cache eviction removed %d series (%s)", len(evicted),
                    ", ".join(f"{e['symbol']}/{e['timeframe']}:{e['reason']}" for e in evicted[:10]))
    return {"enabled": True, "evicted": evicted, "size_bytes": db_size_bytes(), "max_bytes": int(max_bytes)}


def cache_stats() -> dict:
    cfg = cache_config()
    conn = _connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS n, SUM(candle_count) AS candles FROM sync_state").fetchone()
        oldest = conn.execute(
            "SELECT symbol, timeframe, last_accessed_at FROM sync_state "
            "WHERE status != 'running' ORDER BY COALESCE(last_accessed_at, updated_at) ASC LIMIT 1"
        ).fetchone()
        return {
            "config": cfg,
            "size_bytes": db_size_bytes(),
            "max_bytes": int(cfg["max_gb"] * (1024 ** 3)),
            "series_count": row["n"] or 0,
            "candle_count": row["candles"] or 0,
            "oldest_accessed": dict(oldest) if oldest else None,
            "path": str(_DB_PATH),
        }
    finally:
        conn.close()


def upsert_candles(symbol: str, timeframe: str, rows: list[dict], *, venue: str = DEFAULT_VENUE,
                    market_type: str = DEFAULT_MARKET_TYPE) -> int:
    """Inserts real Binance candles. An existing row at the same
    (venue, market_type, symbol, timeframe, ts) primary key IS overwritten
    when Binance's own values differ from what's stored - this is what lets
    the still-forming current-interval candle actually keep updating
    (higher/lower/close/volume as trades continue) on every poll instead of
    freezing at whatever it looked like on its first sync. The WHERE guard
    on the DO UPDATE means a byte-identical re-fetch performs no write at
    all (total_changes stays flat), so the return value still means "rows
    added or meaningfully changed", not "rows touched"."""
    if not rows:
        return 0
    conn = _connect()
    try:
        before = conn.total_changes
        conn.executemany(
            """INSERT INTO candles
               (venue, market_type, symbol, timeframe, ts, open, high, low, close, volume,
                quote_volume, num_trades, taker_buy_base_volume, taker_buy_quote_volume)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(venue, market_type, symbol, timeframe, ts) DO UPDATE SET
                    open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
                    volume=excluded.volume, quote_volume=excluded.quote_volume,
                    num_trades=excluded.num_trades, taker_buy_base_volume=excluded.taker_buy_base_volume,
                    taker_buy_quote_volume=excluded.taker_buy_quote_volume
               WHERE candles.open IS NOT excluded.open OR candles.high IS NOT excluded.high
                  OR candles.low IS NOT excluded.low OR candles.close IS NOT excluded.close
                  OR candles.volume IS NOT excluded.volume OR candles.quote_volume IS NOT excluded.quote_volume
                  OR candles.num_trades IS NOT excluded.num_trades""",
            [
                (venue, market_type, symbol, timeframe, int(r["ts"]),
                 float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                 float(r.get("volume") or 0), r.get("quote_volume"), r.get("num_trades"),
                 r.get("taker_buy_base_volume"), r.get("taker_buy_quote_volume"))
                for r in rows
            ],
        )
        added = conn.total_changes - before
        conn.commit()
        return added
    finally:
        conn.close()


def coverage(symbol: str, timeframe: str, *, venue: str = DEFAULT_VENUE,
             market_type: str = DEFAULT_MARKET_TYPE) -> dict:
    """Live-computed coverage (authoritative, cheap thanks to the index)."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT MIN(ts) AS earliest, MAX(ts) AS latest, COUNT(*) AS n "
            "FROM candles WHERE venue=? AND market_type=? AND symbol=? AND timeframe=?",
            (venue, market_type, symbol, timeframe),
        ).fetchone()
        return {
            "earliest_ts": row["earliest"],
            "latest_ts": row["latest"],
            "candle_count": row["n"] or 0,
        }
    finally:
        conn.close()


def get_candles(symbol: str, timeframe: str, *, venue: str = DEFAULT_VENUE, market_type: str = DEFAULT_MARKET_TYPE,
                 ts_from: int | None = None, ts_to: int | None = None, before: int | None = None,
                 limit: int = 5000) -> list[dict]:
    """Returns up to `limit` candles ascending by time, newest-first window
    when `before` is given (for backward pagination), else bounded by
    [ts_from, ts_to]."""
    conn = _connect()
    try:
        clauses = ["venue=?", "market_type=?", "symbol=?", "timeframe=?"]
        params: list = [venue, market_type, symbol, timeframe]
        if ts_from is not None:
            clauses.append("ts>=?"); params.append(int(ts_from))
        if ts_to is not None:
            clauses.append("ts<=?"); params.append(int(ts_to))
        if before is not None:
            clauses.append("ts<?"); params.append(int(before))
        where = " AND ".join(clauses)
        rows = conn.execute(
            f"SELECT ts, open, high, low, close, volume, quote_volume, num_trades, "
            f"taker_buy_base_volume, taker_buy_quote_volume FROM candles WHERE {where} "
            f"ORDER BY ts DESC LIMIT ?",
            (*params, int(limit)),
        ).fetchall()
        rows = list(reversed(rows))
        return [
            {"time": r["ts"], "open": r["open"], "high": r["high"], "low": r["low"],
             "close": r["close"], "volume": r["volume"], "quoteVolume": r["quote_volume"],
             "numTrades": r["num_trades"], "takerBuyBaseVolume": r["taker_buy_base_volume"],
             "takerBuyQuoteVolume": r["taker_buy_quote_volume"]}
            for r in rows
        ]
    finally:
        conn.close()


def get_candles_ascending(symbol: str, timeframe: str, *, ts_from: int, limit: int,
                           venue: str = DEFAULT_VENUE, market_type: str = DEFAULT_MARKET_TYPE) -> list[dict]:
    """Earliest `limit` candles at/after ts_from, ascending - the shape
    Market Replay needs to answer "what are the first N bars from my replay
    start point" via a single indexed query instead of loading everything."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT ts, open, high, low, close, volume, quote_volume, num_trades, "
            "taker_buy_base_volume, taker_buy_quote_volume FROM candles "
            "WHERE venue=? AND market_type=? AND symbol=? AND timeframe=? AND ts>=? ORDER BY ts ASC LIMIT ?",
            (venue, market_type, symbol, timeframe, int(ts_from), int(limit)),
        ).fetchall()
        return [
            {"time": r["ts"], "open": r["open"], "high": r["high"], "low": r["low"],
             "close": r["close"], "volume": r["volume"], "quoteVolume": r["quote_volume"],
             "numTrades": r["num_trades"], "takerBuyBaseVolume": r["taker_buy_base_volume"],
             "takerBuyQuoteVolume": r["taker_buy_quote_volume"]}
            for r in rows
        ]
    finally:
        conn.close()


def count_candles_from(symbol: str, timeframe: str, *, ts_from: int, venue: str = DEFAULT_VENUE,
                        market_type: str = DEFAULT_MARKET_TYPE) -> int:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM candles WHERE venue=? AND market_type=? AND symbol=? AND timeframe=? AND ts>=?",
            (venue, market_type, symbol, timeframe, int(ts_from)),
        ).fetchone()
        return row["n"] or 0
    finally:
        conn.close()


def update_sync_state(symbol: str, timeframe: str, *, venue: str = DEFAULT_VENUE, market_type: str = DEFAULT_MARKET_TYPE,
                       status: str | None = None, progress_pct: float | None = None,
                       last_error: str | None = None, mark_synced: bool = False) -> None:
    cov = coverage(symbol, timeframe, venue=venue, market_type=market_type)
    conn = _connect()
    try:
        existing = conn.execute(
            "SELECT status FROM sync_state WHERE venue=? AND market_type=? AND symbol=? AND timeframe=?",
            (venue, market_type, symbol, timeframe),
        ).fetchone()
        final_status = status if status is not None else (existing["status"] if existing else "idle")
        conn.execute(
            """INSERT INTO sync_state (venue, market_type, symbol, timeframe, earliest_ts, latest_ts,
                                        candle_count, status, progress_pct, last_synced_at, last_error, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(venue, market_type, symbol, timeframe) DO UPDATE SET
                    earliest_ts=excluded.earliest_ts, latest_ts=excluded.latest_ts,
                    candle_count=excluded.candle_count, status=excluded.status,
                    progress_pct=excluded.progress_pct,
                    last_synced_at=COALESCE(excluded.last_synced_at, sync_state.last_synced_at),
                    last_error=excluded.last_error, updated_at=excluded.updated_at""",
            (venue, market_type, symbol, timeframe, cov["earliest_ts"], cov["latest_ts"],
             cov["candle_count"], final_status, progress_pct or 0,
             time.time() if mark_synced else None, last_error, time.time()),
        )
        conn.commit()
    finally:
        conn.close()


def mark_backfilled(symbol: str, timeframe: str, *, venue: str = DEFAULT_VENUE,
                     market_type: str = DEFAULT_MARKET_TYPE) -> None:
    """Records that a sync has already requested the full plausible history
    for this series, so candle_api never re-triggers a backward sync once
    Binance has told us (via a short/empty page) that there's nothing older."""
    conn = _connect()
    try:
        conn.execute(
            "UPDATE sync_state SET backfilled_complete=1, updated_at=? "
            "WHERE venue=? AND market_type=? AND symbol=? AND timeframe=?",
            (time.time(), venue, market_type, symbol, timeframe),
        )
        conn.commit()
    finally:
        conn.close()


def get_sync_state(symbol: str, timeframe: str, *, venue: str = DEFAULT_VENUE,
                    market_type: str = DEFAULT_MARKET_TYPE) -> dict | None:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM sync_state WHERE venue=? AND market_type=? AND symbol=? AND timeframe=?",
            (venue, market_type, symbol, timeframe),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_instruments_status() -> list[dict]:
    """One row per symbol with per-timeframe coverage, for the data-management UI."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT venue, market_type, symbol, timeframe, earliest_ts, latest_ts, candle_count, "
            "status, progress_pct, last_synced_at, last_error FROM sync_state "
            "ORDER BY symbol, timeframe"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def log_sync_event(symbol: str, timeframe: str, *, started_at: float, finished_at: float | None,
                    status: str, rows_added: int = 0, pages_fetched: int = 0, retries: int = 0,
                    error: str | None = None) -> None:
    conn = _connect()
    try:
        conn.execute(
            """INSERT INTO sync_log (symbol, timeframe, started_at, finished_at, status,
                                      rows_added, pages_fetched, retries, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (symbol, timeframe, started_at, finished_at, status, rows_added, pages_fetched, retries, error),
        )
        conn.commit()
    finally:
        conn.close()


def recent_sync_log(symbol: str | None = None, limit: int = 50) -> list[dict]:
    conn = _connect()
    try:
        if symbol:
            rows = conn.execute(
                "SELECT * FROM sync_log WHERE symbol=? ORDER BY started_at DESC LIMIT ?",
                (symbol, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM sync_log ORDER BY started_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def total_candle_count() -> int:
    conn = _connect()
    try:
        return conn.execute("SELECT COUNT(*) AS n FROM candles").fetchone()["n"]
    finally:
        conn.close()
