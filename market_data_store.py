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

import sqlite3
import time
from pathlib import Path

_DB_PATH: Path | None = None

SCHEMA_VERSION = 1

NATIVE_TIMEFRAMES = ("1m", "10m", "60m", "1d", "1w", "1mo")


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
        conn.commit()
    finally:
        conn.close()


def upsert_candles(ticker: str, board: str, timeframe: str, rows: list[dict],
                    market: str = "shares", engine: str = "stock") -> int:
    """Inserts candles, ignoring rows already present (dedup on the
    (ticker, board, timeframe, ts) primary key). Returns rows actually
    added (not total rows passed in)."""
    if not rows:
        return 0
    conn = _connect()
    try:
        before = conn.total_changes
        conn.executemany(
            """INSERT OR IGNORE INTO candles
               (ticker, board, market, engine, timeframe, ts, open, high, low, close, volume, value, num_trades)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
            f"SELECT ts, open, high, low, close, volume FROM candles WHERE {where} "
            f"ORDER BY ts DESC LIMIT ?",
            (*params, int(limit)),
        ).fetchall()
        rows = list(reversed(rows))
        return [
            {"time": r["ts"], "open": r["open"], "high": r["high"], "low": r["low"],
             "close": r["close"], "volume": r["volume"]}
            for r in rows
        ]
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
