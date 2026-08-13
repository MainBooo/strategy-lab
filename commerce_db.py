from __future__ import annotations

"""SQLite persistence for Strategy Lab commerce features.

The application intentionally keeps user/auth, backtests, charts and commerce
in separate SQLite files.  Commerce data is stored in ``storage/commerce.db``
and is created additively with ``CREATE TABLE IF NOT EXISTS`` only; no existing
Strategy Lab tables are dropped or rewritten.

Money is stored as whole RUB integers.  Strategy implementation quotes and the
support presets are whole-ruble amounts, so this avoids floating point money
without introducing a decimal dependency.  The YooKassa adapter serialises the
value as ``1234.00``.
"""

import json
import sqlite3
import time
import uuid
from pathlib import Path

ORDER_STATUSES = (
    "NEW", "REVIEWING", "NEEDS_INFO", "WAITING_PAYMENT", "PAID",
    "IN_PROGRESS", "READY", "COMPLETED", "CANCELLED",
)
PAYMENT_TYPES = ("CUSTOM_STRATEGY", "SUPPORT")
PAYMENT_STATUSES = ("PENDING", "SUCCEEDED", "CANCELED")

SCHEMA = """
CREATE TABLE IF NOT EXISTS custom_strategy_orders (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    title TEXT,
    market TEXT,
    symbols TEXT,
    timeframes TEXT NOT NULL DEFAULT '[]',
    directions TEXT NOT NULL DEFAULT '[]',
    entry_rules TEXT,
    exit_rules TEXT,
    stop_loss_rules TEXT,
    take_profit_rules TEXT,
    position_sizing_rules TEXT,
    additional_rules TEXT,
    freeform_description TEXT,
    contact TEXT NOT NULL,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'NEW',
    quoted_price INTEGER,
    currency TEXT NOT NULL DEFAULT 'RUB',
    admin_notes TEXT,
    strategy_id TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    quoted_at REAL,
    paid_at REAL,
    started_at REAL,
    completed_at REAL,
    cancelled_at REAL
);
CREATE INDEX IF NOT EXISTS idx_custom_orders_user ON custom_strategy_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_orders_status ON custom_strategy_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_orders_public ON custom_strategy_orders(public_id);

CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    user_id TEXT,
    order_id TEXT,
    provider TEXT NOT NULL,
    provider_payment_id TEXT UNIQUE,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RUB',
    status TEXT NOT NULL DEFAULT 'PENDING',
    confirmation_url TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    raw_payload TEXT,
    created_at REAL NOT NULL,
    paid_at REAL,
    cancelled_at REAL,
    FOREIGN KEY(order_id) REFERENCES custom_strategy_orders(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_type_status ON payments(type, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_custom_order_payment
    ON payments(order_id)
    WHERE type='CUSTOM_STRATEGY' AND status='PENDING' AND order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS private_strategies (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    custom_order_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    runner_strategy_id TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'PRIVATE',
    source TEXT NOT NULL DEFAULT 'CUSTOM_ORDER',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    FOREIGN KEY(custom_order_id) REFERENCES custom_strategy_orders(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_private_strategies_owner ON private_strategies(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id TEXT PRIMARY KEY,
    admin_user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_data TEXT,
    after_data TEXT,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_entity ON admin_audit_log(entity_type, entity_id, created_at DESC);
"""

_DB_PATH: Path | None = None


def init_db(path: Path) -> None:
    global _DB_PATH
    _DB_PATH = Path(path)
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(SCHEMA)
        conn.commit()


def _connect() -> sqlite3.Connection:
    if _DB_PATH is None:
        raise RuntimeError("commerce_db.init_db() was not called")
    conn = sqlite3.connect(_DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def _dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row else None


def _loads(raw: str | None, default):
    try:
        return json.loads(raw) if raw else default
    except (TypeError, json.JSONDecodeError):
        return default


def _public_order(row: dict, *, include_private: bool = False) -> dict:
    result = dict(row)
    result["timeframes"] = _loads(result.get("timeframes"), [])
    result["directions"] = _loads(result.get("directions"), [])
    result["attachments"] = _loads(result.pop("attachments_json", "[]"), [])
    result["payment_status"] = latest_order_payment_status(result["id"])
    if not include_private:
        result.pop("admin_notes", None)
    return result


def _next_public_id(conn: sqlite3.Connection) -> str:
    # Human-friendly number; the UUID primary key remains the security/identity
    # key and every user-facing lookup still applies owner/admin checks.
    row = conn.execute("SELECT COUNT(*) AS n FROM custom_strategy_orders").fetchone()
    n = int(row["n"]) + 1
    while True:
        public_id = f"SL-{n:04d}"
        exists = conn.execute("SELECT 1 FROM custom_strategy_orders WHERE public_id=?", (public_id,)).fetchone()
        if not exists:
            return public_id
        n += 1


def create_order(user_id: str, payload: dict) -> dict:
    now = time.time()
    order_id = uuid.uuid4().hex
    with _connect() as conn:
        public_id = _next_public_id(conn)
        conn.execute(
            """INSERT INTO custom_strategy_orders (
                id,public_id,user_id,title,market,symbols,timeframes,directions,
                entry_rules,exit_rules,stop_loss_rules,take_profit_rules,
                position_sizing_rules,additional_rules,freeform_description,
                contact,attachments_json,status,currency,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'NEW','RUB',?,?)""",
            (
                order_id, public_id, user_id, payload.get("title"), payload.get("market"), payload.get("symbols"),
                json.dumps(payload.get("timeframes") or [], ensure_ascii=False),
                json.dumps(payload.get("directions") or [], ensure_ascii=False),
                payload.get("entry_rules"), payload.get("exit_rules"), payload.get("stop_loss_rules"),
                payload.get("take_profit_rules"), payload.get("position_sizing_rules"), payload.get("additional_rules"),
                payload.get("freeform_description"), payload.get("contact"),
                json.dumps(payload.get("attachments") or [], ensure_ascii=False), now, now,
            ),
        )
        conn.commit()
    return get_order(order_id, include_private=False)


def get_order(order_id_or_public: str, *, include_private: bool = False) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM custom_strategy_orders WHERE id=? OR public_id=?",
            (order_id_or_public, order_id_or_public),
        ).fetchone()
    return _public_order(dict(row), include_private=include_private) if row else None


def get_order_for_user(order_id_or_public: str, user_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM custom_strategy_orders WHERE (id=? OR public_id=?) AND user_id=?",
            (order_id_or_public, order_id_or_public, user_id),
        ).fetchone()
    return _public_order(dict(row), include_private=False) if row else None


def list_orders_for_user(user_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM custom_strategy_orders WHERE user_id=? ORDER BY created_at DESC", (user_id,)
        ).fetchall()
    return [_public_order(dict(r), include_private=False) for r in rows]


def list_orders_admin(*, status: str | None = None, payment_status: str | None = None,
                      query: str | None = None, date_from: float | None = None,
                      date_to: float | None = None) -> list[dict]:
    clauses = ["1=1"]
    args: list[object] = []
    if status:
        clauses.append("o.status=?"); args.append(status)
    if query:
        q = f"%{query.strip()}%"
        clauses.append("(o.public_id LIKE ? OR COALESCE(o.title,'') LIKE ? OR o.user_id LIKE ?)")
        args.extend([q, q, q])
    if date_from is not None:
        clauses.append("o.created_at>=?"); args.append(date_from)
    if date_to is not None:
        clauses.append("o.created_at<=?"); args.append(date_to)
    sql = f"""SELECT o.* FROM custom_strategy_orders o
              WHERE {' AND '.join(clauses)} ORDER BY o.created_at DESC"""
    with _connect() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
    result = [_public_order(r, include_private=True) for r in rows]
    if payment_status:
        result = [r for r in result if r.get("payment_status") == payment_status]
    return result


def latest_order_payment_status(order_id: str) -> str | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT status FROM payments WHERE order_id=? ORDER BY created_at DESC LIMIT 1", (order_id,)
        ).fetchone()
    return row["status"] if row else None


def update_order_admin(order_id: str, **fields) -> dict | None:
    allowed = {
        "status", "quoted_price", "admin_notes", "strategy_id", "quoted_at", "paid_at",
        "started_at", "completed_at", "cancelled_at",
    }
    values = {k: v for k, v in fields.items() if k in allowed}
    if not values:
        return get_order(order_id, include_private=True)
    values["updated_at"] = time.time()
    sets = ",".join(f"{k}=?" for k in values)
    with _connect() as conn:
        cur = conn.execute(f"UPDATE custom_strategy_orders SET {sets} WHERE id=?", (*values.values(), order_id))
        conn.commit()
        if not cur.rowcount:
            return None
    return get_order(order_id, include_private=True)


def create_payment(*, payment_type: str, user_id: str | None, order_id: str | None,
                   provider: str, amount: int) -> dict:
    if payment_type not in PAYMENT_TYPES:
        raise ValueError("unsupported payment type")
    if amount <= 0:
        raise ValueError("amount must be positive")
    now = time.time()
    with _connect() as conn:
        if payment_type == "CUSTOM_STRATEGY" and order_id:
            existing = conn.execute(
                "SELECT * FROM payments WHERE order_id=? AND type='CUSTOM_STRATEGY' AND status='PENDING' ORDER BY created_at DESC LIMIT 1",
                (order_id,),
            ).fetchone()
            if existing:
                return dict(existing)
        payment_id = uuid.uuid4().hex
        key = uuid.uuid4().hex
        try:
            conn.execute(
                """INSERT INTO payments
                   (id,type,user_id,order_id,provider,amount,currency,status,idempotency_key,created_at)
                   VALUES (?,?,?,?,?,?,'RUB','PENDING',?,?)""",
                (payment_id, payment_type, user_id, order_id, provider, int(amount), key, now),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            if payment_type == "CUSTOM_STRATEGY" and order_id:
                row = conn.execute(
                    "SELECT * FROM payments WHERE order_id=? AND type='CUSTOM_STRATEGY' AND status='PENDING' ORDER BY created_at DESC LIMIT 1",
                    (order_id,),
                ).fetchone()
                if row:
                    return dict(row)
            raise
    return get_payment(payment_id)


def get_payment(payment_id: str) -> dict | None:
    with _connect() as conn:
        return _dict(conn.execute("SELECT * FROM payments WHERE id=?", (payment_id,)).fetchone())


def get_payment_for_user(payment_id: str, user_id: str) -> dict | None:
    with _connect() as conn:
        return _dict(conn.execute("SELECT * FROM payments WHERE id=? AND user_id=?", (payment_id, user_id)).fetchone())


def get_payment_by_provider_id(provider_payment_id: str) -> dict | None:
    with _connect() as conn:
        return _dict(conn.execute("SELECT * FROM payments WHERE provider_payment_id=?", (provider_payment_id,)).fetchone())


def set_payment_provider_result(payment_id: str, *, provider_payment_id: str | None,
                                confirmation_url: str | None, raw_payload: dict | None = None) -> dict | None:
    with _connect() as conn:
        conn.execute(
            "UPDATE payments SET provider_payment_id=?,confirmation_url=?,raw_payload=? WHERE id=?",
            (provider_payment_id, confirmation_url,
             json.dumps(raw_payload, ensure_ascii=False, default=str) if raw_payload is not None else None,
             payment_id),
        )
        conn.commit()
    return get_payment(payment_id)


def apply_succeeded(payment_id: str, raw_payload: dict) -> tuple[dict | None, bool]:
    """Atomically marks a payment succeeded and advances an order once.

    Returns ``(payment, already_processed)``.  Critically, an order is only
    moved from WAITING_PAYMENT to PAID; READY/COMPLETED are never regressed by
    a delayed or duplicate webhook.
    """
    now = time.time()
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM payments WHERE id=?", (payment_id,)).fetchone()
        if not row:
            conn.rollback(); return None, False
        if row["status"] == "SUCCEEDED":
            conn.rollback(); return dict(row), True
        conn.execute(
            "UPDATE payments SET status='SUCCEEDED',paid_at=?,cancelled_at=NULL,raw_payload=? WHERE id=?",
            (now, json.dumps(raw_payload, ensure_ascii=False, default=str), payment_id),
        )
        if row["type"] == "CUSTOM_STRATEGY" and row["order_id"]:
            conn.execute(
                """UPDATE custom_strategy_orders
                   SET status='PAID',paid_at=COALESCE(paid_at,?),updated_at=?
                   WHERE id=? AND status='WAITING_PAYMENT'""",
                (now, now, row["order_id"]),
            )
        conn.commit()
    return get_payment(payment_id), False


def apply_canceled(payment_id: str, raw_payload: dict) -> tuple[dict | None, bool]:
    now = time.time()
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM payments WHERE id=?", (payment_id,)).fetchone()
        if not row:
            conn.rollback(); return None, False
        if row["status"] == "CANCELED":
            conn.rollback(); return dict(row), True
        if row["status"] == "SUCCEEDED":
            # Never downgrade a confirmed successful payment because a stale
            # or out-of-order cancellation event arrived later.
            conn.rollback(); return dict(row), True
        conn.execute(
            "UPDATE payments SET status='CANCELED',cancelled_at=?,raw_payload=? WHERE id=?",
            (now, json.dumps(raw_payload, ensure_ascii=False, default=str), payment_id),
        )
        conn.commit()
    return get_payment(payment_id), False


def list_pending_payments_for_user(user_id: str, limit: int = 10) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT * FROM payments WHERE user_id=? AND status='PENDING' AND provider_payment_id IS NOT NULL
               ORDER BY created_at DESC LIMIT ?""",
            (user_id, int(limit)),
        ).fetchall()
    return [dict(r) for r in rows]


def list_payments_admin(*, payment_type: str | None = None, status: str | None = None) -> list[dict]:
    clauses = ["1=1"]
    args: list[object] = []
    if payment_type:
        clauses.append("type=?"); args.append(payment_type)
    if status:
        clauses.append("status=?"); args.append(status)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM payments WHERE {' AND '.join(clauses)} ORDER BY created_at DESC", args
        ).fetchall()
    return [dict(r) for r in rows]


def create_or_update_private_strategy(*, order_id: str, owner_user_id: str, name: str,
                                      runner_strategy_id: str) -> dict:
    now = time.time()
    with _connect() as conn:
        existing = conn.execute("SELECT * FROM private_strategies WHERE custom_order_id=?", (order_id,)).fetchone()
        if existing:
            strategy_id = existing["id"]
            conn.execute(
                "UPDATE private_strategies SET name=?,runner_strategy_id=?,updated_at=? WHERE id=?",
                (name, runner_strategy_id, now, strategy_id),
            )
        else:
            strategy_id = "usr_" + uuid.uuid4().hex[:16]
            conn.execute(
                """INSERT INTO private_strategies
                   (id,owner_user_id,custom_order_id,name,runner_strategy_id,visibility,source,created_at,updated_at)
                   VALUES (?,?,?,?,?,'PRIVATE','CUSTOM_ORDER',?,?)""",
                (strategy_id, owner_user_id, order_id, name, runner_strategy_id, now, now),
            )
        conn.execute(
            "UPDATE custom_strategy_orders SET strategy_id=?,status='READY',completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=?",
            (strategy_id, now, now, order_id),
        )
        conn.commit()
    return get_private_strategy(strategy_id)


def get_private_strategy(strategy_id: str) -> dict | None:
    with _connect() as conn:
        return _dict(conn.execute("SELECT * FROM private_strategies WHERE id=?", (strategy_id,)).fetchone())


def list_private_strategies_for_user(user_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM private_strategies WHERE owner_user_id=? ORDER BY created_at DESC", (user_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def list_private_strategies_admin() -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM private_strategies ORDER BY created_at DESC").fetchall()]


def audit(admin_user_id: str, action: str, entity_type: str, entity_id: str,
          before: dict | None, after: dict | None) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO admin_audit_log (id,admin_user_id,action,entity_type,entity_id,before_data,after_data,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (
                uuid.uuid4().hex, admin_user_id, action, entity_type, entity_id,
                json.dumps(before, ensure_ascii=False, default=str) if before is not None else None,
                json.dumps(after, ensure_ascii=False, default=str) if after is not None else None,
                time.time(),
            ),
        )
        conn.commit()


def dashboard_stats() -> dict:
    now = time.time()
    last_30 = now - 30 * 86400
    with _connect() as conn:
        order_counts = {r["status"]: r["n"] for r in conn.execute(
            "SELECT status,COUNT(*) AS n FROM custom_strategy_orders GROUP BY status"
        ).fetchall()}
        pay = conn.execute(
            """SELECT
                 COUNT(*) AS payments,
                 COALESCE(SUM(CASE WHEN type='CUSTOM_STRATEGY' AND status='SUCCEEDED' THEN amount ELSE 0 END),0) AS strategies_total,
                 COALESCE(SUM(CASE WHEN type='SUPPORT' AND status='SUCCEEDED' THEN amount ELSE 0 END),0) AS support_total,
                 COALESCE(SUM(CASE WHEN type='SUPPORT' AND status='SUCCEEDED' AND paid_at>=? THEN amount ELSE 0 END),0) AS support_30d
               FROM payments""",
            (last_30,),
        ).fetchone()
        orders_total = conn.execute("SELECT COUNT(*) AS n FROM custom_strategy_orders").fetchone()["n"]
    return {
        "orders_total": orders_total,
        "orders_by_status": order_counts,
        "payments": int(pay["payments"]),
        "strategies_total": int(pay["strategies_total"]),
        "support_total": int(pay["support_total"]),
        "support_30d": int(pay["support_30d"]),
    }


def user_commerce_summary(user_id: str) -> dict:
    with _connect() as conn:
        orders = conn.execute("SELECT COUNT(*) AS n FROM custom_strategy_orders WHERE user_id=?", (user_id,)).fetchone()["n"]
        paid = conn.execute(
            "SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE user_id=? AND type='CUSTOM_STRATEGY' AND status='SUCCEEDED'",
            (user_id,),
        ).fetchone()["n"]
        strategies = conn.execute("SELECT COUNT(*) AS n FROM private_strategies WHERE owner_user_id=?", (user_id,)).fetchone()["n"]
    return {"orders": int(orders), "paid_strategies_rub": int(paid), "private_strategies": int(strategies)}
