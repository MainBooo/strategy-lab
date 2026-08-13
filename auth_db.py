from __future__ import annotations

"""SQLite-backed user accounts: storage/users.db.

Deliberately separate from backtests.db/charts.db/portfolios.json rather
than folding a users table into one of them - accounts are a distinct
concern (auth, not market/strategy data) and keeping the file separate
means it can be backed up/restored independently, and a future admin/
billing extension never has to share a schema with unrelated app data.

Password reset tokens are stored as a SHA-256 hash, never the raw token -
same reasoning as password_hash: a stolen DB backup must not hand out
usable reset links.
"""

import hashlib
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    last_login_at REAL,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_admin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    used_at REAL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS user_favorites (
    user_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (user_id, ticker),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""

_DB_PATH: Path | None = None
RESET_TOKEN_TTL_SECONDS = 3600  # 1 hour


def init_db(path: Path) -> None:
    global _DB_PATH
    _DB_PATH = path
    path.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(SCHEMA)
        try:
            conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        conn.commit()


def _connect() -> sqlite3.Connection:
    if _DB_PATH is None:
        raise RuntimeError("auth_db.init_db() was not called")
    conn = sqlite3.connect(_DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def create_user(email: str, password_hash: str, display_name: str) -> dict:
    email = normalize_email(email)
    user_id = uuid.uuid4().hex
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at,is_active) VALUES (?,?,?,?,?,?,1)",
            (user_id, email, password_hash, display_name.strip(), now, now),
        )
    return get_by_id(user_id)


def get_by_email(email: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email=?", (normalize_email(email),)).fetchone()
    return dict(row) if row else None


def get_by_id(user_id: str) -> dict | None:
    if not user_id:
        return None
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def list_users() -> list[dict]:
    """Admin-facing user list without ever exposing password/reset hashes."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id,email,display_name,created_at,updated_at,last_login_at,is_active,is_admin FROM users ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def touch_last_login(user_id: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET last_login_at=? WHERE id=?", (time.time(), user_id))


def update_profile(user_id: str, *, display_name: str | None = None) -> dict | None:
    if display_name is None:
        return get_by_id(user_id)
    with _connect() as conn:
        conn.execute("UPDATE users SET display_name=?,updated_at=? WHERE id=?",
                     (display_name.strip(), time.time(), user_id))
    return get_by_id(user_id)


def update_password_hash(user_id: str, new_hash: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET password_hash=?,updated_at=? WHERE id=?",
                     (new_hash, time.time(), user_id))


def deactivate_user(user_id: str) -> None:
    """Soft-delete the login while retaining historical ownership links."""
    with _connect() as conn:
        conn.execute("UPDATE users SET is_active=0,updated_at=? WHERE id=?", (time.time(), user_id))


def create_reset_token(user_id: str) -> str:
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO password_reset_tokens (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)",
            (uuid.uuid4().hex, user_id, token_hash, now, now + RESET_TOKEN_TTL_SECONDS),
        )
    return raw_token


def list_favorites(user_id: str) -> list[str]:
    with _connect() as conn:
        rows = conn.execute("SELECT ticker FROM user_favorites WHERE user_id=? ORDER BY created_at", (user_id,)).fetchall()
    return [r["ticker"] for r in rows]


def add_favorite(user_id: str, ticker: str) -> None:
    with _connect() as conn:
        conn.execute("INSERT OR IGNORE INTO user_favorites (user_id,ticker,created_at) VALUES (?,?,?)",
                     (user_id, ticker.upper(), time.time()))


def remove_favorite(user_id: str, ticker: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM user_favorites WHERE user_id=? AND ticker=?", (user_id, ticker.upper()))


def consume_reset_token(raw_token: str) -> str | None:
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    now = time.time()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
            (token_hash, now),
        ).fetchone()
        if not row:
            return None
        conn.execute("UPDATE password_reset_tokens SET used_at=? WHERE id=?", (now, row["id"]))
        return row["user_id"]
