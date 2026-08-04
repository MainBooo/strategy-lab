from __future__ import annotations

"""Persistent storage for Market Replay sessions (SQLite, storage/replay.db).

Session state lives entirely in the DB - not in a Python object in one
gunicorn worker's memory - for the same reason JobStore/PortfolioStore/
backtests_db do the same: multiple worker processes serve requests for the
same session, so in-memory state would be invisible to whichever worker
handles the next poll/step. Same connection style as backtests_db.py.
"""

import json
import sqlite3
import time
import uuid
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS replay_sessions (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    board TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT 'shares',
    engine TEXT NOT NULL DEFAULT 'stock',
    timeframe TEXT NOT NULL,
    lot_size INTEGER NOT NULL DEFAULT 1,
    start_ts INTEGER NOT NULL,
    reveal_index INTEGER NOT NULL DEFAULT 0,
    speed REAL NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'paused',
    starting_balance REAL NOT NULL,
    cash REAL NOT NULL,
    commission_rate REAL NOT NULL DEFAULT 0.0005,
    slippage_bps REAL NOT NULL DEFAULT 0,
    position_side TEXT,
    position_qty_lots INTEGER NOT NULL DEFAULT 0,
    position_qty_shares INTEGER NOT NULL DEFAULT 0,
    position_avg_price REAL,
    position_stop_loss REAL,
    position_take_profit REAL,
    position_entry_commission REAL NOT NULL DEFAULT 0,
    realized_pnl REAL NOT NULL DEFAULT 0,
    undo_stack_json TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_ticker ON replay_sessions(ticker);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_status ON replay_sessions(status);

CREATE TABLE IF NOT EXISTS replay_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    side TEXT NOT NULL,
    action TEXT NOT NULL,
    qty_lots INTEGER NOT NULL,
    qty_shares INTEGER NOT NULL,
    fill_price REAL NOT NULL,
    commission REAL NOT NULL,
    realized_pnl REAL,
    stop_loss REAL,
    take_profit REAL,
    exit_reason TEXT,
    bar_ts INTEGER NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY(session_id) REFERENCES replay_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_replay_trades_session ON replay_trades(session_id);
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
    """Additive, idempotent - CREATE TABLE IF NOT EXISTS is a no-op on an
    already-existing table, so a new column needs an explicit ALTER TABLE.
    Safe on every startup: skipped once the column is present."""
    existing = {row[1] for row in conn.execute("PRAGMA table_info(replay_sessions)")}
    if "position_entry_commission" not in existing:
        conn.execute("ALTER TABLE replay_sessions ADD COLUMN position_entry_commission REAL NOT NULL DEFAULT 0")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def new_session_id() -> str:
    return "replay_" + uuid.uuid4().hex[:16]


def create_session(*, ticker: str, board: str, timeframe: str, lot_size: int, start_ts: int,
                    starting_balance: float, commission_rate: float, slippage_bps: float,
                    speed: float, market: str = "shares", engine: str = "stock") -> dict:
    sid = new_session_id()
    now = time.time()
    with _connect() as conn:
        conn.execute(
            """INSERT INTO replay_sessions
               (id, ticker, board, market, engine, timeframe, lot_size, start_ts, reveal_index, speed,
                status, starting_balance, cash, commission_rate, slippage_bps, realized_pnl,
                undo_stack_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'paused', ?, ?, ?, ?, 0, '[]', ?, ?)""",
            (sid, ticker, board, market, engine, timeframe, lot_size, start_ts, speed,
             starting_balance, starting_balance, commission_rate, slippage_bps, now, now),
        )
    return get_session(sid)


def get_session(session_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM replay_sessions WHERE id=?", (session_id,)).fetchone()
        return dict(row) if row else None


def list_sessions(status: str | None = None, limit: int = 50) -> list[dict]:
    with _connect() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM replay_sessions WHERE status=? ORDER BY updated_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM replay_sessions ORDER BY updated_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]


_UPDATABLE = {
    "reveal_index", "speed", "status", "cash", "commission_rate", "slippage_bps",
    "position_side", "position_qty_lots", "position_qty_shares", "position_avg_price",
    "position_stop_loss", "position_take_profit", "position_entry_commission",
    "realized_pnl", "undo_stack_json",
}


def update_session(session_id: str, **fields) -> dict | None:
    bad = set(fields) - _UPDATABLE
    if bad:
        raise ValueError(f"Cannot update columns: {bad}")
    if not fields:
        return get_session(session_id)
    fields = {**fields, "updated_at": time.time()}
    set_clause = ", ".join(f"{k}=?" for k in fields)
    with _connect() as conn:
        conn.execute(f"UPDATE replay_sessions SET {set_clause} WHERE id=?", (*fields.values(), session_id))
    return get_session(session_id)


def delete_session(session_id: str) -> bool:
    with _connect() as conn:
        conn.execute("DELETE FROM replay_trades WHERE session_id=?", (session_id,))
        cur = conn.execute("DELETE FROM replay_sessions WHERE id=?", (session_id,))
        return cur.rowcount > 0


def push_undo(session_id: str, snapshot: dict, max_depth: int = 200) -> None:
    session = get_session(session_id)
    if session is None:
        return
    stack = json.loads(session["undo_stack_json"] or "[]")
    stack.append(snapshot)
    if len(stack) > max_depth:
        stack = stack[-max_depth:]
    update_session(session_id, undo_stack_json=json.dumps(stack))


def pop_undo(session_id: str) -> dict | None:
    session = get_session(session_id)
    if session is None:
        return None
    stack = json.loads(session["undo_stack_json"] or "[]")
    if not stack:
        return None
    snapshot = stack.pop()
    update_session(session_id, undo_stack_json=json.dumps(stack))
    return snapshot


def add_trade(session_id: str, *, side: str, action: str, qty_lots: int, qty_shares: int,
              fill_price: float, commission: float, bar_ts: int, realized_pnl: float | None = None,
              stop_loss: float | None = None, take_profit: float | None = None,
              exit_reason: str | None = None) -> int:
    with _connect() as conn:
        cur = conn.execute(
            """INSERT INTO replay_trades
               (session_id, side, action, qty_lots, qty_shares, fill_price, commission, realized_pnl,
                stop_loss, take_profit, exit_reason, bar_ts, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, side, action, qty_lots, qty_shares, fill_price, commission, realized_pnl,
             stop_loss, take_profit, exit_reason, bar_ts, time.time()),
        )
        return cur.lastrowid


def list_trades(session_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM replay_trades WHERE session_id=? ORDER BY id ASC", (session_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def max_trade_id(session_id: str) -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(id),0) AS m FROM replay_trades WHERE session_id=?", (session_id,)
        ).fetchone()
        return row["m"]


def delete_trades_after(session_id: str, watermark: int) -> None:
    """Used when undoing (step back) past an action that recorded a trade
    (manual fill or an auto stop/take) - the trade must be un-recorded, not
    just hidden, so re-stepping forward regenerates it fresh instead of
    duplicating it. Watermark-based (trade autoincrement id), not time-based,
    so it stays precise even when multiple trades land on the same bar."""
    with _connect() as conn:
        conn.execute("DELETE FROM replay_trades WHERE session_id=? AND id>?", (session_id, watermark))
