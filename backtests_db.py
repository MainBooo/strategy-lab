from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS backtest_runs (
    id TEXT PRIMARY KEY,
    portfolio_id TEXT,
    portfolio_name_snapshot TEXT,
    started_at REAL,
    completed_at REAL,
    date_from TEXT,
    date_to TEXT,
    status TEXT NOT NULL,
    initial_capital REAL,
    final_capital REAL,
    profit REAL,
    return_percent REAL,
    max_drawdown REAL,
    trades_count INTEGER DEFAULT 0,
    combinations_count INTEGER DEFAULT 0,
    combinations_ok INTEGER DEFAULT 0,
    combinations_failed INTEGER DEFAULT 0,
    error_message TEXT,
    configuration_json TEXT,
    created_at REAL NOT NULL,
    user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_portfolio ON backtest_runs(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_runs_created ON backtest_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON backtest_runs(status);

CREATE TABLE IF NOT EXISTS backtest_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backtest_run_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_name_snapshot TEXT,
    parameters_json TEXT,
    lots INTEGER,
    lot_size INTEGER,
    starting_price REAL,
    ending_price REAL,
    trades_count INTEGER DEFAULT 0,
    profit REAL,
    return_percent REAL,
    win_rate REAL,
    profit_factor REAL,
    max_drawdown REAL,
    status TEXT NOT NULL,
    error_message TEXT,
    duration_seconds REAL,
    strategy_run_id TEXT,
    FOREIGN KEY(backtest_run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_results_run ON backtest_results(backtest_run_id);
CREATE INDEX IF NOT EXISTS idx_results_ticker ON backtest_results(ticker);
CREATE INDEX IF NOT EXISTS idx_results_strategy ON backtest_results(strategy_id);

CREATE TABLE IF NOT EXISTS backtest_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backtest_run_id TEXT NOT NULL,
    backtest_result_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    direction TEXT,
    entry_datetime TEXT,
    entry_price REAL,
    exit_datetime TEXT,
    exit_price REAL,
    quantity_lots INTEGER,
    quantity_shares INTEGER,
    gross_profit REAL,
    commission REAL,
    net_profit REAL,
    return_percent REAL,
    stop_loss REAL,
    take_profit REAL,
    exit_reason TEXT,
    signal_metadata_json TEXT,
    signal_datetime TEXT,
    FOREIGN KEY(backtest_run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(backtest_result_id) REFERENCES backtest_results(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trades_run ON backtest_trades(backtest_run_id);
CREATE INDEX IF NOT EXISTS idx_trades_result ON backtest_trades(backtest_result_id);
CREATE INDEX IF NOT EXISTS idx_trades_ticker ON backtest_trades(ticker);
"""

_DB_PATH: Path | None = None


def init_db(path: Path) -> None:
    global _DB_PATH
    _DB_PATH = path
    path.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(SCHEMA)
        _migrate_add_columns(conn)


def _migrate_add_columns(conn: sqlite3.Connection) -> None:
    """Additive, idempotent migrations for tables created before a column existed.

    SQLite's CREATE TABLE IF NOT EXISTS is a no-op on an already-existing
    table, so new nullable columns need an explicit ALTER TABLE here. Safe
    to run on every startup: ALTER TABLE ADD COLUMN is skipped once the
    column is present, nothing is ever dropped or rewritten.
    """
    existing = {row[1] for row in conn.execute("PRAGMA table_info(backtest_trades)")}
    if "signal_datetime" not in existing:
        conn.execute("ALTER TABLE backtest_trades ADD COLUMN signal_datetime TEXT")

    # user_id predates accounts (see auth_db.py) - added nullable so every
    # run created before accounts existed stays exactly as it was (NULL =
    # legacy/system record, per the account-system spec's explicit
    # instruction not to guess an owner for pre-existing data), while new
    # runs from a logged-in user get a real value going forward.
    runs_existing = {row[1] for row in conn.execute("PRAGMA table_info(backtest_runs)")}
    if "user_id" not in runs_existing:
        conn.execute("ALTER TABLE backtest_runs ADD COLUMN user_id TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_user ON backtest_runs(user_id)")


def _connect() -> sqlite3.Connection:
    # Short-lived connection per call rather than one shared across gunicorn
    # threads/processes - WAL + a busy timeout lets concurrent readers and a
    # writer coexist without "database is locked" under gthread workers.
    conn = sqlite3.connect(_DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def new_run_id() -> str:
    return "run_" + uuid.uuid4().hex[:16]


def create_run(run_id: str, portfolio_id: str | None, portfolio_name: str, date_from: str | None,
                date_to: str | None, initial_capital: float, combinations_count: int, configuration: dict,
                user_id: str | None = None) -> None:
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO backtest_runs (id,portfolio_id,portfolio_name_snapshot,started_at,date_from,date_to,"
            "status,initial_capital,combinations_count,configuration_json,created_at,user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, portfolio_id, portfolio_name, now, date_from, date_to, "running",
             initial_capital, combinations_count, json.dumps(configuration, ensure_ascii=False), now, user_id),
        )


def finish_run(run_id: str, *, status: str, final_capital: float | None = None, profit: float | None = None,
                return_percent: float | None = None, max_drawdown: float | None = None, trades_count: int = 0,
                combinations_ok: int = 0, combinations_failed: int = 0, error_message: str | None = None) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE backtest_runs SET status=?,completed_at=?,final_capital=?,profit=?,return_percent=?,"
            "max_drawdown=?,trades_count=?,combinations_ok=?,combinations_failed=?,error_message=? WHERE id=?",
            (status, time.time(), final_capital, profit, return_percent, max_drawdown, trades_count,
             combinations_ok, combinations_failed, error_message, run_id),
        )


def add_result(run_id: str, **fields) -> int:
    cols = ["backtest_run_id","ticker","strategy_id","strategy_name_snapshot","parameters_json","lots","lot_size",
            "starting_price","ending_price","trades_count","profit","return_percent","win_rate","profit_factor",
            "max_drawdown","status","error_message","duration_seconds","strategy_run_id"]
    values = [run_id] + [fields.get(c) for c in cols[1:]]
    with _connect() as conn:
        cur = conn.execute(f"INSERT INTO backtest_results ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", values)
        return cur.lastrowid


def add_trades(run_id: str, result_id: int, ticker: str, strategy_id: str, trades: list[dict]) -> None:
    if not trades:
        return
    cols = ["backtest_run_id","backtest_result_id","ticker","strategy_id","direction","entry_datetime","entry_price",
            "exit_datetime","exit_price","quantity_lots","quantity_shares","gross_profit","commission","net_profit",
            "return_percent","stop_loss","take_profit","exit_reason","signal_metadata_json","signal_datetime"]
    rows = []
    for t in trades:
        rows.append((run_id, result_id, ticker, strategy_id, t.get("direction"), t.get("entry_datetime"),
                      t.get("entry_price"), t.get("exit_datetime"), t.get("exit_price"), t.get("quantity_lots"),
                      t.get("quantity_shares"), t.get("gross_profit"), t.get("commission"), t.get("net_profit"),
                      t.get("return_percent"), t.get("stop_loss"), t.get("take_profit"), t.get("exit_reason"),
                      json.dumps(t.get("signal_metadata") or {}, ensure_ascii=False, default=str),
                      t.get("signal_datetime")))
    with _connect() as conn:
        conn.executemany(f"INSERT INTO backtest_trades ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", rows)


def list_runs(*, portfolio_id: str | None = None, ticker: str | None = None, strategy_id: str | None = None,
              status: str | None = None, date_from: str | None = None, date_to: str | None = None,
              page: int = 1, page_size: int = 20, user_id: str | None = None,
              owner_scope: str = "mixed") -> tuple[list[dict], int]:
    """owner_scope controls how user_id is applied:
    - "mixed" (default - the main app's shared history view): rows owned by
      user_id, plus every legacy/global row (user_id IS NULL) - a logged-in
      user sees their own runs mixed with the pre-accounts shared history,
      exactly what an anonymous visitor already saw before accounts
      existed. With user_id=None (anonymous request), only the legacy/
      global rows show, same as today.
    - "mine" (the personal cabinet's "Мои бэктесты"): strictly user_id's own
      rows, never someone else's and never unowned legacy rows.
    """
    page = max(1, page); page_size = max(1, min(200, page_size))
    where = ["1=1"]; params: list = []
    base = "FROM backtest_runs r"
    if ticker or strategy_id:
        base += " WHERE r.id IN (SELECT backtest_run_id FROM backtest_results WHERE 1=1"
        if ticker:
            base += " AND ticker=?"; params.append(ticker.upper())
        if strategy_id:
            base += " AND strategy_id=?"; params.append(strategy_id)
        base += ")"
        where = []
    if portfolio_id:
        where.append("r.portfolio_id=?"); params.append(portfolio_id)
    if status:
        where.append("r.status=?"); params.append(status)
    if date_from:
        where.append("date(r.created_at,'unixepoch')>=date(?)"); params.append(date_from)
    if date_to:
        where.append("date(r.created_at,'unixepoch')<=date(?)"); params.append(date_to)
    if owner_scope == "mine":
        where.append("r.user_id=?"); params.append(user_id)
    elif user_id is not None:
        where.append("(r.user_id=? OR r.user_id IS NULL)"); params.append(user_id)
    else:
        where.append("r.user_id IS NULL")
    clause = (" WHERE " if "WHERE" not in base else " AND ") + " AND ".join(where) if where else ""
    with _connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) {base}{clause}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT r.* {base}{clause} ORDER BY r.created_at DESC LIMIT ? OFFSET ?",
            params + [page_size, (page - 1) * page_size],
        ).fetchall()
    return [dict(r) for r in rows], total


def get_run(run_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM backtest_runs WHERE id=?", (run_id,)).fetchone()
    return dict(row) if row else None


def get_results(run_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM backtest_results WHERE backtest_run_id=? ORDER BY ticker,strategy_id", (run_id,)).fetchall()
    return [dict(r) for r in rows]


def list_trades(run_id: str, *, ticker: str | None = None, strategy_id: str | None = None,
                 direction: str | None = None, profitable: bool | None = None, exit_reason: str | None = None,
                 date_from: str | None = None, date_to: str | None = None,
                 page: int = 1, page_size: int = 50) -> tuple[list[dict], int]:
    page = max(1, page); page_size = max(1, min(500, page_size))
    where = ["backtest_run_id=?"]; params: list = [run_id]
    if ticker:
        where.append("ticker=?"); params.append(ticker.upper())
    if strategy_id:
        where.append("strategy_id=?"); params.append(strategy_id)
    if direction:
        where.append("direction=?"); params.append(direction)
    if profitable is True:
        where.append("net_profit>0")
    elif profitable is False:
        where.append("net_profit<=0")
    if exit_reason:
        where.append("exit_reason=?"); params.append(exit_reason)
    if date_from:
        where.append("date(entry_datetime)>=date(?)"); params.append(date_from)
    if date_to:
        where.append("date(entry_datetime)<=date(?)"); params.append(date_to)
    clause = " WHERE " + " AND ".join(where)
    with _connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM backtest_trades{clause}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM backtest_trades{clause} ORDER BY entry_datetime LIMIT ? OFFSET ?",
            params + [page_size, (page - 1) * page_size],
        ).fetchall()
    return [dict(r) for r in rows], total


def get_trade(trade_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM backtest_trades WHERE id=?", (trade_id,)).fetchone()
    return dict(row) if row else None


def delete_run(run_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM backtest_runs WHERE id=?", (run_id,))
        conn.execute("DELETE FROM backtest_results WHERE backtest_run_id=?", (run_id,))
        conn.execute("DELETE FROM backtest_trades WHERE backtest_run_id=?", (run_id,))
        return cur.rowcount > 0
