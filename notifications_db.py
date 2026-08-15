from __future__ import annotations

"""Persistent price-alert and notification-channel storage.

The original browser AlertService stored rules in localStorage and could only
fire while an actively-open chart was polling a symbol.  This DB is the server
source of truth for authenticated users, so rules survive devices/reloads and
can be evaluated by a background worker even when no browser is open.
"""

import hashlib
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

_DB_PATH: Path | None = None
VALID_CONDITIONS = {"price_above", "price_below", "cross_up", "cross_down"}
VALID_REPEAT = {"once", "repeat"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS price_alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    condition TEXT NOT NULL,
    value REAL NOT NULL,
    repeat_mode TEXT NOT NULL DEFAULT 'once',
    enabled INTEGER NOT NULL DEFAULT 1,
    armed INTEGER NOT NULL DEFAULT 1,
    last_price REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    last_triggered_at REAL,
    trigger_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_price_alerts_symbol_enabled ON price_alerts(symbol, enabled);
CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON price_alerts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_settings (
    user_id TEXT PRIMARY KEY,
    web_push_enabled INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 0,
    telegram_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth_secret TEXT NOT NULL,
    user_agent TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS telegram_links (
    user_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL UNIQUE,
    username TEXT,
    linked_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    used_at REAL
);
CREATE INDEX IF NOT EXISTS idx_tg_link_tokens_user ON telegram_link_tokens(user_id);

CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    condition TEXT NOT NULL,
    threshold REAL NOT NULL,
    price REAL NOT NULL,
    created_at REAL NOT NULL,
    web_push_sent INTEGER NOT NULL DEFAULT 0,
    email_sent INTEGER NOT NULL DEFAULT 0,
    telegram_sent INTEGER NOT NULL DEFAULT 0,
    delivery_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_events_user_created ON notification_events(user_id, created_at DESC);
"""


def init_db(path: Path) -> None:
    global _DB_PATH
    _DB_PATH = path
    path.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(SCHEMA)
        conn.commit()


def _connect() -> sqlite3.Connection:
    if _DB_PATH is None:
        raise RuntimeError("notifications_db.init_db() was not called")
    conn = sqlite3.connect(_DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.row_factory = sqlite3.Row
    return conn


def _row_alert(row: sqlite3.Row | None) -> dict | None:
    if not row:
        return None
    d = dict(row)
    d["repeat"] = d.pop("repeat_mode")
    d["enabled"] = bool(d["enabled"])
    d["armed"] = bool(d["armed"])
    return d


def list_alerts(user_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM price_alerts WHERE user_id=? ORDER BY created_at", (user_id,)).fetchall()
    return [_row_alert(r) for r in rows]


def get_alert(user_id: str, alert_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM price_alerts WHERE id=? AND user_id=?", (alert_id, user_id)).fetchone()
    return _row_alert(row)


def create_alert(user_id: str, *, symbol: str, condition: str, value: float, repeat: str = "once") -> dict:
    symbol = symbol.strip().upper()
    if not symbol or len(symbol) > 20:
        raise ValueError("Некорректный тикер")
    if condition not in VALID_CONDITIONS:
        raise ValueError("Некорректное условие")
    if repeat not in VALID_REPEAT:
        repeat = "once"
    alert_id = "al_" + uuid.uuid4().hex
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO price_alerts (id,user_id,symbol,condition,value,repeat_mode,enabled,armed,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1,?,?)",
            (alert_id, user_id, symbol, condition, float(value), repeat, now, now),
        )
    return get_alert(user_id, alert_id)


def update_alert(user_id: str, alert_id: str, patch: dict) -> dict | None:
    allowed = {}
    if "enabled" in patch:
        allowed["enabled"] = 1 if patch["enabled"] else 0
        if patch["enabled"]:
            allowed["armed"] = 1
    if "condition" in patch:
        if patch["condition"] not in VALID_CONDITIONS:
            raise ValueError("Некорректное условие")
        allowed["condition"] = patch["condition"]
        allowed["armed"] = 1
    if "value" in patch:
        allowed["value"] = float(patch["value"])
        allowed["armed"] = 1
    if "repeat" in patch:
        if patch["repeat"] not in VALID_REPEAT:
            raise ValueError("Некорректный режим повтора")
        allowed["repeat_mode"] = patch["repeat"]
    if not allowed:
        return get_alert(user_id, alert_id)
    allowed["updated_at"] = time.time()
    sql = ",".join(f"{k}=?" for k in allowed)
    with _connect() as conn:
        conn.execute(f"UPDATE price_alerts SET {sql} WHERE id=? AND user_id=?", (*allowed.values(), alert_id, user_id))
    return get_alert(user_id, alert_id)


def remove_alert(user_id: str, alert_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM price_alerts WHERE id=? AND user_id=?", (alert_id, user_id))


def enabled_symbols() -> list[str]:
    with _connect() as conn:
        rows = conn.execute("SELECT DISTINCT symbol FROM price_alerts WHERE enabled=1").fetchall()
    return [r["symbol"] for r in rows]


def evaluate_symbol(symbol: str, price: float) -> list[dict]:
    """Atomically evaluate all enabled rules for one symbol.

    For repeatable above/below rules `armed` prevents one notification on every
    45-second poll while the price remains beyond the threshold.  The rule is
    re-armed only after price returns to the opposite side. Cross rules are
    naturally edge-triggered by last_price.
    """
    symbol = symbol.upper()
    price = float(price)
    events: list[dict] = []
    now = time.time()
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute("SELECT * FROM price_alerts WHERE enabled=1 AND symbol=?", (symbol,)).fetchall()
        for row in rows:
            a = dict(row)
            prev = a["last_price"]
            armed = bool(a["armed"])
            threshold = float(a["value"])
            condition = a["condition"]
            hit = False
            next_armed = armed

            if condition == "price_above":
                if price < threshold:
                    next_armed = True
                elif armed:
                    hit = True
                    next_armed = False
            elif condition == "price_below":
                if price > threshold:
                    next_armed = True
                elif armed:
                    hit = True
                    next_armed = False
            elif condition == "cross_up":
                hit = prev is not None and float(prev) < threshold <= price
            elif condition == "cross_down":
                hit = prev is not None and float(prev) > threshold >= price

            if hit:
                enabled = 0 if a["repeat_mode"] == "once" else 1
                conn.execute(
                    "UPDATE price_alerts SET last_price=?,armed=?,enabled=?,last_triggered_at=?,trigger_count=trigger_count+1,updated_at=? WHERE id=?",
                    (price, 1 if next_armed else 0, enabled, now, now, a["id"]),
                )
                event = {
                    "id": "evt_" + uuid.uuid4().hex,
                    "user_id": a["user_id"], "alert_id": a["id"], "symbol": symbol,
                    "condition": condition, "threshold": threshold, "price": price, "created_at": now,
                }
                conn.execute(
                    "INSERT INTO notification_events (id,user_id,alert_id,symbol,condition,threshold,price,created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (event["id"], event["user_id"], event["alert_id"], symbol, condition, threshold, price, now),
                )
                events.append(event)
            else:
                conn.execute(
                    "UPDATE price_alerts SET last_price=?,armed=?,updated_at=? WHERE id=?",
                    (price, 1 if next_armed else 0, now, a["id"]),
                )
        conn.commit()
    return events


def get_settings(user_id: str) -> dict:
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO notification_settings (user_id,web_push_enabled,email_enabled,telegram_enabled,updated_at) VALUES (?,1,0,0,?)",
            (user_id, now),
        )
        row = conn.execute("SELECT * FROM notification_settings WHERE user_id=?", (user_id,)).fetchone()
    d = dict(row)
    for k in ("web_push_enabled", "email_enabled", "telegram_enabled"):
        d[k] = bool(d[k])
    return d


def update_settings(user_id: str, patch: dict) -> dict:
    get_settings(user_id)
    fields = {}
    for key in ("web_push_enabled", "email_enabled", "telegram_enabled"):
        if key in patch:
            fields[key] = 1 if patch[key] else 0
    if fields:
        fields["updated_at"] = time.time()
        sql = ",".join(f"{k}=?" for k in fields)
        with _connect() as conn:
            conn.execute(f"UPDATE notification_settings SET {sql} WHERE user_id=?", (*fields.values(), user_id))
    return get_settings(user_id)


def upsert_push_subscription(user_id: str, *, endpoint: str, p256dh: str, auth_secret: str, user_agent: str = "") -> dict:
    now = time.time()
    with _connect() as conn:
        existing = conn.execute("SELECT id FROM push_subscriptions WHERE endpoint=?", (endpoint,)).fetchone()
        if existing:
            conn.execute(
                "UPDATE push_subscriptions SET user_id=?,p256dh=?,auth_secret=?,user_agent=?,updated_at=? WHERE endpoint=?",
                (user_id, p256dh, auth_secret, user_agent[:500], now, endpoint),
            )
            sid = existing["id"]
        else:
            sid = "ps_" + uuid.uuid4().hex
            conn.execute(
                "INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth_secret,user_agent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (sid, user_id, endpoint, p256dh, auth_secret, user_agent[:500], now, now),
            )
    return {"id": sid, "endpoint": endpoint}


def list_push_subscriptions(user_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM push_subscriptions WHERE user_id=?", (user_id,)).fetchall()
    return [dict(r) for r in rows]


def remove_push_subscription(*, subscription_id: str | None = None, endpoint: str | None = None, user_id: str | None = None) -> None:
    clauses, values = [], []
    if subscription_id:
        clauses.append("id=?"); values.append(subscription_id)
    if endpoint:
        clauses.append("endpoint=?"); values.append(endpoint)
    if user_id:
        clauses.append("user_id=?"); values.append(user_id)
    if not clauses:
        return
    with _connect() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE " + " AND ".join(clauses), values)


def create_telegram_link_token(user_id: str, ttl_seconds: int = 900) -> str:
    raw = secrets.token_urlsafe(24)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    now = time.time()
    with _connect() as conn:
        conn.execute("DELETE FROM telegram_link_tokens WHERE user_id=? OR expires_at<?", (user_id, now))
        conn.execute(
            "INSERT INTO telegram_link_tokens (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)",
            ("tgt_" + uuid.uuid4().hex, user_id, token_hash, now, now + ttl_seconds),
        )
    return raw


def consume_telegram_link_token(raw: str, chat_id: str, username: str = "") -> str | None:
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    now = time.time()
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM telegram_link_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
            (token_hash, now),
        ).fetchone()
        if not row:
            conn.rollback(); return None
        user_id = row["user_id"]
        conn.execute("DELETE FROM telegram_links WHERE user_id=? OR chat_id=?", (user_id, str(chat_id)))
        conn.execute(
            "INSERT INTO telegram_links (user_id,chat_id,username,linked_at) VALUES (?,?,?,?)",
            (user_id, str(chat_id), username[:100], now),
        )
        conn.execute("UPDATE telegram_link_tokens SET used_at=? WHERE id=?", (now, row["id"]))
        conn.execute("INSERT OR IGNORE INTO notification_settings (user_id,web_push_enabled,email_enabled,telegram_enabled,updated_at) VALUES (?,1,0,1,?)", (user_id, now))
        conn.execute("UPDATE notification_settings SET telegram_enabled=1,updated_at=? WHERE user_id=?", (now, user_id))
        conn.commit()
    return user_id


def get_telegram_link(user_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM telegram_links WHERE user_id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def unlink_telegram(user_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM telegram_links WHERE user_id=?", (user_id,))
        conn.execute("UPDATE notification_settings SET telegram_enabled=0,updated_at=? WHERE user_id=?", (time.time(), user_id))


def list_events(user_id: str, *, after: float = 0.0, limit: int = 50) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id,alert_id,symbol,condition,threshold,price,created_at FROM notification_events WHERE user_id=? AND created_at>? ORDER BY created_at ASC LIMIT ?",
            (user_id, float(after), max(1, min(int(limit), 200))),
        ).fetchall()
    return [dict(r) for r in rows]


def mark_delivery(event_id: str, *, channel: str, error: str | None = None) -> None:
    column = {"web_push": "web_push_sent", "email": "email_sent", "telegram": "telegram_sent"}.get(channel)
    if not column:
        return
    with _connect() as conn:
        if error:
            conn.execute("UPDATE notification_events SET delivery_error=? WHERE id=?", (error[:1000], event_id))
        else:
            conn.execute(f"UPDATE notification_events SET {column}=1 WHERE id=?", (event_id,))
