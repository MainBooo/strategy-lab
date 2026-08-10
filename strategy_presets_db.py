from __future__ import annotations

"""Persistence for a user's personal "Мои настройки" parameter preset per
strategy, saved from the Strategy Library card. Mirrors charts_db.py's style
(short-lived sqlite3 connections, WAL mode, dict rows) and its user_id
convention - _effective_user_id() in app.py returns "local" for anonymous
visitors, the same shared namespace every other anonymous-safe table uses.
"""

import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS strategy_user_presets (
    user_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (user_id, strategy_id)
);
"""

_DB_PATH: Path | None = None


def init_db(path: Path) -> None:
    global _DB_PATH
    _DB_PATH = path
    path.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(SCHEMA)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _row_dict(row: sqlite3.Row) -> dict:
    return {
        "strategy_id": row["strategy_id"],
        "parameters": json.loads(row["parameters_json"]),
        "updated_at": row["updated_at"],
    }


def get_preset(user_id: str, strategy_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM strategy_user_presets WHERE user_id=? AND strategy_id=?",
            (user_id, strategy_id),
        ).fetchone()
    return _row_dict(row) if row else None


def list_presets(user_id: str) -> dict[str, dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM strategy_user_presets WHERE user_id=?", (user_id,)
        ).fetchall()
    return {row["strategy_id"]: _row_dict(row) for row in rows}


def save_preset(user_id: str, strategy_id: str, parameters: dict) -> dict:
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO strategy_user_presets (user_id,strategy_id,parameters_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?) "
            "ON CONFLICT(user_id,strategy_id) DO UPDATE SET parameters_json=excluded.parameters_json,updated_at=excluded.updated_at",
            (user_id, strategy_id, json.dumps(parameters, ensure_ascii=False), now, now),
        )
    return get_preset(user_id, strategy_id)


def delete_preset(user_id: str, strategy_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM strategy_user_presets WHERE user_id=? AND strategy_id=?",
            (user_id, strategy_id),
        )
    return cur.rowcount > 0
