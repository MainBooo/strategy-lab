from __future__ import annotations

"""Centralized OHLCV candle storage (SQLite) for the chart/replay modules.

Replaces the old per-request CSV cache (`data/chart_cache/*.csv`) with a
single indexed database so historical candles accumulate across requests
instead of being re-downloaded from MOEX every time a chart is opened.
Only "native" MOEX timeframes are stored (1m/10m/60m/1d/1w/1mo) - 30m/4h
stay derived on read via honest OHLCV aggregation (see candle_api.py),
same approach the old cache used, just now aggregating indexed SQL rows
instead of re-parsing a CSV file each time.

Connection style mirrors backtests_db.py / charts_db.py: short-lived
per-call connections, WAL mode, so multiple gunicorn worker processes can
share the file safely without a connection pool.
"""

import os
import sqlite3
import threading
import time
from pathlib import Path

_DB_PATH: Path | None = None

SCHEMA_VERSION = 1

NATIVE_TIMEFRAMES = ("1m", "10m", "60m", "1d", "1w", "1mo")

# Per (ticker, board, timeframe) locks so concurrent requests for the same
# series (e.g. opening a 6-tile chart layout, which fires up to 6 /api/candles
# calls at once, or several browser tabs on the same ticker) serialize onto a
# single MOEX sync instead of each firing its own redundant download - see
# candle_api._ensure_coverage(). Only guards against duplicate work *within
# this process*; sync_state.status="running" (checked by the same call site)
# is the cross-process backstop since gunicorn runs multiple workers.
_sync_locks: dict[tuple, threading.Lock] = {}
_sync_locks_guard = threading.Lock()


def sync_lock(ticker: str, board: str, timeframe: str) -> threading.Lock:
    key = (ticker, board, timeframe)
    with _sync_locks_guard:
        lock = _sync_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _sync_locks[key] = lock
        return lock


def cache_config() -> dict:
    """Bounded-cache settings, read from the environment on every call so a
    changed env var (or a test) takes effect without a process restart -
    these are checked at most a few times per request, never in a hot loop.
    See docs/DYNAMIC_MARKET_DATA.md for the meaning of each variable."""
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
                ticker TEXT NOT NULL,
                board TEXT NOT NULL,
                market TEXT NOT NULL DEFAULT 'shares',
                engine TEXT NOT NULL DEFAULT 'stock',
                timeframe TEXT NOT NULL,
                ts INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL DEFAULT 0,
                value REAL,
                num_trades INTEGER,
                is_synthetic INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (ticker, board, timeframe, ts)
            );
            CREATE INDEX IF NOT EXISTS idx_candles_ticker_tf_ts
                ON candles(ticker, timeframe, ts);

            CREATE TABLE IF NOT EXISTS sync_state (
                ticker TEXT NOT NULL,
                board TEXT NOT NULL,
                market TEXT NOT NULL DEFAULT 'shares',
                engine TEXT NOT NULL DEFAULT 'stock',
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
                PRIMARY KEY (ticker, board, timeframe)
            );

            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT NOT NULL,
                board TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                started_at REAL NOT NULL,
                finished_at REAL,
                status TEXT NOT NULL,
                rows_added INTEGER NOT NULL DEFAULT 0,
                pages_fetched INTEGER NOT NULL DEFAULT 0,
                retries INTEGER NOT NULL DEFAULT 0,
                error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sync_log_ticker
                ON sync_log(ticker, timeframe, started_at);
            """
        )
        # sync_state predates last_accessed_at; older DBs need it added once.
        try:
            conn.execute("ALTER TABLE sync_state ADD COLUMN last_accessed_at REAL")
        except sqlite3.OperationalError:
            pass  # column already exists
        # candles predates is_synthetic (gap-fill for illiquid intraday
        # buckets - see candle_api._fill_synthetic_gaps); older DBs need it
        # added once, defaulting existing rows to 0 (real).
        try:
            conn.execute("ALTER TABLE candles ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # column already exists
        conn.commit()
        # DELETEs only free pages back to SQLite's own freelist, not to the
        # OS, unless auto_vacuum is on - without it, evict_if_needed() below
        # could delete every row and the .db file would never actually
        # shrink. auto_vacuum can only be turned on via a one-time VACUUM
        # (cheap here - low tens of MB - and only runs once per DB, guarded
        # by the pragma read below so it's a no-op on every later restart).
        mode = conn.execute("PRAGMA auto_vacuum").fetchone()[0]
        if mode != 2:  # 2 = incremental
            conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
            conn.execute("VACUUM")
    finally:
        conn.close()


def touch_access(ticker: str, board: str, timeframe: str) -> None:
    """Marks a series as just-read, for LRU eviction ordering. Best-effort:
    a lock timeout here should never fail the candle request it's attached
    to, so failures are swallowed rather than propagated."""
    conn = _connect()
    try:
        conn.execute(
            """INSERT INTO sync_state (ticker, board, timeframe, last_accessed_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(ticker, board, timeframe) DO UPDATE SET last_accessed_at=excluded.last_accessed_at""",
            (ticker, board, timeframe, time.time(), time.time()),
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


def _delete_series(conn: sqlite3.Connection, ticker: str, board: str, timeframe: str) -> int:
    cur = conn.execute("DELETE FROM candles WHERE ticker=? AND board=? AND timeframe=?", (ticker, board, timeframe))
    conn.execute("DELETE FROM sync_state WHERE ticker=? AND board=? AND timeframe=?", (ticker, board, timeframe))
    return cur.rowcount


def evict_if_needed(logger=None) -> dict:
    """Bounds local disk usage of the candle cache: first drops series idle
    longer than MARKET_CACHE_TTL_DAYS, then - if still over
    MARKET_CACHE_MAX_GB - drops the least-recently-accessed remaining series
    one at a time until back under budget. Evicted data isn't lost, just no
    longer local: candle_api re-fetches it from MOEX on the next request for
    that range. No-op when MARKET_CACHE_ENABLED=false (unlimited growth,
    today's pre-existing behavior)."""
    cfg = cache_config()
    if not cfg["enabled"]:
        return {"enabled": False}
    conn = _connect()
    evicted: list[dict] = []
    try:
        cutoff = time.time() - cfg["ttl_days"] * 86400
        idle = conn.execute(
            "SELECT ticker, board, timeframe FROM sync_state WHERE COALESCE(last_accessed_at, updated_at) < ? "
            "AND status != 'running'",
            (cutoff,),
        ).fetchall()
        for row in idle:
            rows = _delete_series(conn, row["ticker"], row["board"], row["timeframe"])
            if rows:
                evicted.append({"ticker": row["ticker"], "board": row["board"], "timeframe": row["timeframe"],
                                 "reason": "ttl", "rows": rows})
        conn.commit()

        max_bytes = cfg["max_gb"] * (1024 ** 3)
        guard = 0
        while db_size_bytes() > max_bytes and guard < 10000:
            guard += 1
            row = conn.execute(
                "SELECT ticker, board, timeframe FROM sync_state WHERE status != 'running' "
                "ORDER BY COALESCE(last_accessed_at, updated_at) ASC LIMIT 1"
            ).fetchone()
            if not row:
                break
            rows = _delete_series(conn, row["ticker"], row["board"], row["timeframe"])
            conn.commit()
            evicted.append({"ticker": row["ticker"], "board": row["board"], "timeframe": row["timeframe"],
                             "reason": "size", "rows": rows})
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
                    ", ".join(f"{e['ticker']}/{e['timeframe']}:{e['reason']}" for e in evicted[:10]))
    return {"enabled": True, "evicted": evicted, "size_bytes": db_size_bytes(), "max_bytes": int(max_bytes)}


def cache_stats() -> dict:
    cfg = cache_config()
    conn = _connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS n, SUM(candle_count) AS candles FROM sync_state").fetchone()
        oldest = conn.execute(
            "SELECT ticker, board, timeframe, last_accessed_at FROM sync_state "
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


def upsert_candles(ticker: str, board: str, timeframe: str, rows: list[dict],
                    market: str = "shares", engine: str = "stock") -> int:
    """Inserts real MOEX candles. Unlike a plain INSERT OR IGNORE, an
    existing row at the same (ticker, board, timeframe, ts) primary key IS
    overwritten when MOEX's own values differ from what's stored - this is
    what lets the still-forming current-interval candle actually keep
    updating (higher/lower/close as trades continue) on every poll instead
    of freezing at whatever it looked like on its first sync, and lets a
    real candle replace a synthetic no-trade placeholder inserted earlier by
    candle_api._fill_synthetic_gaps for the same interval. The `WHERE`
    guard on the DO UPDATE means a byte-identical re-fetch performs no write
    at all (total_changes stays flat), so the return value still means
    "rows added or meaningfully changed", not "rows touched". Always stamps
    is_synthetic=0 - real MOEX data, by definition, is never synthetic."""
    if not rows:
        return 0
    conn = _connect()
    try:
        before = conn.total_changes
        conn.executemany(
            """INSERT INTO candles
               (ticker, board, market, engine, timeframe, ts, open, high, low, close, volume, value, num_trades, is_synthetic)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
               ON CONFLICT(ticker, board, timeframe, ts) DO UPDATE SET
                    open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
                    volume=excluded.volume, value=excluded.value, num_trades=excluded.num_trades,
                    is_synthetic=0
               WHERE candles.open IS NOT excluded.open OR candles.high IS NOT excluded.high
                  OR candles.low IS NOT excluded.low OR candles.close IS NOT excluded.close
                  OR candles.volume IS NOT excluded.volume OR candles.value IS NOT excluded.value
                  OR candles.num_trades IS NOT excluded.num_trades OR candles.is_synthetic != 0""",
            [
                (ticker, board, market, engine, timeframe, int(r["ts"]),
                 float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                 float(r.get("volume") or 0), r.get("value"), r.get("num_trades"))
                for r in rows
            ],
        )
        added = conn.total_changes - before
        conn.commit()
        return added
    finally:
        conn.close()


def upsert_synthetic_candles(ticker: str, board: str, timeframe: str, rows: list[dict],
                              market: str = "shares", engine: str = "stock") -> int:
    """Inserts flat no-trade placeholder candles for confirmed-empty
    intraday buckets (see candle_api._fill_synthetic_gaps) - always
    INSERT OR IGNORE, on purpose: this must never overwrite a row that's
    already real (or already synthetic - re-running the fill is a no-op for
    buckets it already covered). Only upsert_candles (the real-data path)
    is ever allowed to replace a synthetic row."""
    if not rows:
        return 0
    conn = _connect()
    try:
        before = conn.total_changes
        conn.executemany(
            """INSERT OR IGNORE INTO candles
               (ticker, board, market, engine, timeframe, ts, open, high, low, close, volume, value, num_trades, is_synthetic)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
            [
                (ticker, board, market, engine, timeframe, int(r["ts"]),
                 float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
                 0.0, 0.0, 0)
                for r in rows
            ],
        )
        added = conn.total_changes - before
        conn.commit()
        return added
    finally:
        conn.close()


def coverage(ticker: str, board: str, timeframe: str) -> dict:
    """Live-computed coverage (authoritative, cheap thanks to the index)."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT MIN(ts) AS earliest, MAX(ts) AS latest, COUNT(*) AS n "
            "FROM candles WHERE ticker=? AND board=? AND timeframe=?",
            (ticker, board, timeframe),
        ).fetchone()
        return {
            "earliest_ts": row["earliest"],
            "latest_ts": row["latest"],
            "candle_count": row["n"] or 0,
        }
    finally:
        conn.close()


def get_candles(ticker: str, board: str, timeframe: str, *, ts_from: int | None = None,
                 ts_to: int | None = None, before: int | None = None, limit: int = 5000) -> list[dict]:
    """Returns up to `limit` candles ascending by time, newest-first window
    when `before` is given (for backward pagination), else bounded by
    [ts_from, ts_to]."""
    conn = _connect()
    try:
        clauses = ["ticker=?", "board=?", "timeframe=?"]
        params: list = [ticker, board, timeframe]
        if ts_from is not None:
            clauses.append("ts>=?"); params.append(int(ts_from))
        if ts_to is not None:
            clauses.append("ts<=?"); params.append(int(ts_to))
        if before is not None:
            clauses.append("ts<?"); params.append(int(before))
        where = " AND ".join(clauses)
        rows = conn.execute(
            f"SELECT ts, open, high, low, close, volume, is_synthetic FROM candles WHERE {where} "
            f"ORDER BY ts DESC LIMIT ?",
            (*params, int(limit)),
        ).fetchall()
        rows = list(reversed(rows))
        return [
            {"time": r["ts"], "open": r["open"], "high": r["high"], "low": r["low"],
             "close": r["close"], "volume": r["volume"], "isSynthetic": bool(r["is_synthetic"])}
            for r in rows
        ]
    finally:
        conn.close()


def get_candles_ascending(ticker: str, board: str, timeframe: str, *, ts_from: int, limit: int) -> list[dict]:
    """Earliest `limit` candles at/after ts_from, ascending - the shape
    Market Replay needs to answer "what are the first N bars from my replay
    start point" via a single indexed query instead of loading everything."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT ts, open, high, low, close, volume, is_synthetic FROM candles "
            "WHERE ticker=? AND board=? AND timeframe=? AND ts>=? ORDER BY ts ASC LIMIT ?",
            (ticker, board, timeframe, int(ts_from), int(limit)),
        ).fetchall()
        return [
            {"time": r["ts"], "open": r["open"], "high": r["high"], "low": r["low"],
             "close": r["close"], "volume": r["volume"], "isSynthetic": bool(r["is_synthetic"])}
            for r in rows
        ]
    finally:
        conn.close()


def count_candles_from(ticker: str, board: str, timeframe: str, *, ts_from: int) -> int:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM candles WHERE ticker=? AND board=? AND timeframe=? AND ts>=?",
            (ticker, board, timeframe, int(ts_from)),
        ).fetchone()
        return row["n"] or 0
    finally:
        conn.close()


def update_sync_state(ticker: str, board: str, timeframe: str, *, market: str = "shares",
                       engine: str = "stock", status: str | None = None,
                       progress_pct: float | None = None, last_error: str | None = None,
                       mark_synced: bool = False) -> None:
    cov = coverage(ticker, board, timeframe)
    conn = _connect()
    try:
        existing = conn.execute(
            "SELECT status FROM sync_state WHERE ticker=? AND board=? AND timeframe=?",
            (ticker, board, timeframe),
        ).fetchone()
        final_status = status if status is not None else (existing["status"] if existing else "idle")
        conn.execute(
            """INSERT INTO sync_state (ticker, board, market, engine, timeframe, earliest_ts, latest_ts,
                                        candle_count, status, progress_pct, last_synced_at, last_error, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(ticker, board, timeframe) DO UPDATE SET
                    earliest_ts=excluded.earliest_ts, latest_ts=excluded.latest_ts,
                    candle_count=excluded.candle_count, status=excluded.status,
                    progress_pct=excluded.progress_pct,
                    last_synced_at=COALESCE(excluded.last_synced_at, sync_state.last_synced_at),
                    last_error=excluded.last_error, updated_at=excluded.updated_at""",
            (ticker, board, market, engine, timeframe, cov["earliest_ts"], cov["latest_ts"],
             cov["candle_count"], final_status, progress_pct or 0,
             time.time() if mark_synced else None, last_error, time.time()),
        )
        conn.commit()
    finally:
        conn.close()


def mark_backfilled(ticker: str, board: str, timeframe: str) -> None:
    """Records that a sync has already requested the full plausible history
    for this series, so candle_api never re-triggers a backward sync once
    MOEX has told us (via an empty page) that there's nothing older."""
    conn = _connect()
    try:
        conn.execute(
            "UPDATE sync_state SET backfilled_complete=1, updated_at=? "
            "WHERE ticker=? AND board=? AND timeframe=?",
            (time.time(), ticker, board, timeframe),
        )
        conn.commit()
    finally:
        conn.close()


def get_sync_state(ticker: str, board: str, timeframe: str) -> dict | None:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM sync_state WHERE ticker=? AND board=? AND timeframe=?",
            (ticker, board, timeframe),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_instruments_status() -> list[dict]:
    """One row per ticker with per-timeframe coverage, for the data-management UI."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT ticker, board, timeframe, earliest_ts, latest_ts, candle_count, "
            "status, progress_pct, last_synced_at, last_error FROM sync_state "
            "ORDER BY ticker, timeframe"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def log_sync_event(ticker: str, board: str, timeframe: str, *, started_at: float, finished_at: float | None,
                    status: str, rows_added: int = 0, pages_fetched: int = 0, retries: int = 0,
                    error: str | None = None) -> None:
    conn = _connect()
    try:
        conn.execute(
            """INSERT INTO sync_log (ticker, board, timeframe, started_at, finished_at, status,
                                      rows_added, pages_fetched, retries, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (ticker, board, timeframe, started_at, finished_at, status, rows_added, pages_fetched, retries, error),
        )
        conn.commit()
    finally:
        conn.close()


def recent_sync_log(ticker: str | None = None, limit: int = 50) -> list[dict]:
    conn = _connect()
    try:
        if ticker:
            rows = conn.execute(
                "SELECT * FROM sync_log WHERE ticker=? ORDER BY started_at DESC LIMIT ?",
                (ticker, limit),
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
