from __future__ import annotations

"""Persistence for chart layouts, drawings and strategy-order requests.

Mirrors the style of backtests_db.py (short-lived sqlite3 connections,
WAL mode, dict rows) rather than introducing a new ORM. Kept in its own
database file so the existing backtests.db schema is untouched.

Every row carries a user_id. There is currently no authentication in
this app (single operator, no login) so the app always passes the same
constant user id (see app.py: CURRENT_USER_ID). The column exists so
real per-user ownership checks can be turned on later without another
migration - right now list/get calls still take user_id and filter by
it, they just always receive the same value.
"""

import json
import sqlite3
import time
import uuid
from pathlib import Path

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS chart_layouts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT 'analysis',
    name TEXT NOT NULL,
    symbol TEXT,
    board TEXT,
    timeframe TEXT,
    visible_from TEXT,
    visible_to TEXT,
    chart_type TEXT NOT NULL DEFAULT 'candles',
    settings_json TEXT,
    indicators_json TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layouts_user ON chart_layouts(user_id);
CREATE INDEX IF NOT EXISTS idx_layouts_symbol ON chart_layouts(symbol);

CREATE TABLE IF NOT EXISTS chart_drawings (
    id TEXT PRIMARY KEY,
    layout_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    symbol TEXT,
    timeframe TEXT,
    points_json TEXT NOT NULL,
    properties_json TEXT,
    locked INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    z_index INTEGER NOT NULL DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    FOREIGN KEY(layout_id) REFERENCES chart_layouts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drawings_layout ON chart_drawings(layout_id);

CREATE TABLE IF NOT EXISTS chart_strategy_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    layout_id TEXT,
    symbol TEXT,
    board TEXT,
    timeframe TEXT,
    visible_from TEXT,
    visible_to TEXT,
    drawings_snapshot_json TEXT,
    indicators_json TEXT,
    idea_description TEXT,
    entry_conditions TEXT,
    exit_conditions TEXT,
    stop_description TEXT,
    take_description TEXT,
    position_management TEXT,
    risk_tolerance TEXT,
    comment TEXT,
    screenshot_path TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_user ON chart_strategy_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON chart_strategy_requests(status);
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
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


# --------------------------------------------------------------- layouts --

def create_layout(user_id: str, *, context: str, name: str, symbol: str | None, board: str | None,
                   timeframe: str | None, visible_from: str | None, visible_to: str | None,
                   chart_type: str, settings: dict | None, indicators: list | None,
                   is_default: bool = False) -> dict:
    layout_id = new_id("layout")
    now = time.time()
    if is_default:
        _clear_default(user_id, symbol)
    with _connect() as conn:
        conn.execute(
            "INSERT INTO chart_layouts (id,user_id,context,name,symbol,board,timeframe,visible_from,visible_to,"
            "chart_type,settings_json,indicators_json,is_default,schema_version,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (layout_id, user_id, context, name, symbol, board, timeframe, visible_from, visible_to,
             chart_type or "candles", json.dumps(settings or {}, ensure_ascii=False),
             json.dumps(indicators or [], ensure_ascii=False), int(bool(is_default)), SCHEMA_VERSION, now, now),
        )
    return get_layout(layout_id, user_id)


def _clear_default(user_id: str, symbol: str | None) -> None:
    with _connect() as conn:
        conn.execute("UPDATE chart_layouts SET is_default=0 WHERE user_id=? AND symbol=?", (user_id, symbol))


def update_layout(layout_id: str, user_id: str, **fields) -> dict | None:
    existing = get_layout(layout_id, user_id)
    if not existing:
        return None
    allowed = {"name", "symbol", "board", "timeframe", "visible_from", "visible_to", "chart_type"}
    sets, params = [], []
    for key in allowed:
        if key in fields:
            sets.append(f"{key}=?"); params.append(fields[key])
    if "settings" in fields:
        sets.append("settings_json=?"); params.append(json.dumps(fields["settings"] or {}, ensure_ascii=False))
    if "indicators" in fields:
        sets.append("indicators_json=?"); params.append(json.dumps(fields["indicators"] or [], ensure_ascii=False))
    if "is_default" in fields and fields["is_default"]:
        _clear_default(user_id, fields.get("symbol", existing["symbol"]))
        sets.append("is_default=1")
    if not sets:
        return existing
    sets.append("updated_at=?"); params.append(time.time())
    params += [layout_id, user_id]
    with _connect() as conn:
        conn.execute(f"UPDATE chart_layouts SET {','.join(sets)} WHERE id=? AND user_id=?", params)
    return get_layout(layout_id, user_id)


def get_layout(layout_id: str, user_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM chart_layouts WHERE id=? AND user_id=?", (layout_id, user_id)).fetchone()
    if not row:
        return None
    return _layout_dict(row)


def list_layouts(user_id: str, *, context: str | None = None, symbol: str | None = None) -> list[dict]:
    where = ["user_id=?"]; params: list = [user_id]
    if context:
        where.append("context=?"); params.append(context)
    if symbol:
        where.append("symbol=?"); params.append(symbol)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM chart_layouts WHERE {' AND '.join(where)} ORDER BY updated_at DESC", params
        ).fetchall()
    return [_layout_dict(r) for r in rows]


def delete_layout(layout_id: str, user_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM chart_layouts WHERE id=? AND user_id=?", (layout_id, user_id))
        conn.execute("DELETE FROM chart_drawings WHERE layout_id=?", (layout_id,))
        return cur.rowcount > 0


def _layout_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["settings"] = json.loads(d.pop("settings_json") or "{}")
    d["indicators"] = json.loads(d.pop("indicators_json") or "[]")
    d["is_default"] = bool(d["is_default"])
    return d


# -------------------------------------------------------------- drawings --

def create_drawing(layout_id: str, user_id: str, *, type: str, symbol: str | None, timeframe: str | None,
                    points: list, properties: dict | None, locked: bool = False, hidden: bool = False,
                    z_index: int = 0) -> dict | None:
    if not get_layout(layout_id, user_id):
        return None
    drawing_id = new_id("drawing")
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO chart_drawings (id,layout_id,user_id,type,symbol,timeframe,points_json,properties_json,"
            "locked,hidden,z_index,schema_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (drawing_id, layout_id, user_id, type, symbol, timeframe, json.dumps(points, ensure_ascii=False),
             json.dumps(properties or {}, ensure_ascii=False), int(bool(locked)), int(bool(hidden)), z_index,
             SCHEMA_VERSION, now, now),
        )
    return get_drawing(drawing_id, user_id)


def update_drawing(drawing_id: str, user_id: str, **fields) -> dict | None:
    existing = get_drawing(drawing_id, user_id)
    if not existing:
        return None
    sets, params = [], []
    if "points" in fields:
        sets.append("points_json=?"); params.append(json.dumps(fields["points"], ensure_ascii=False))
    if "properties" in fields:
        sets.append("properties_json=?"); params.append(json.dumps(fields["properties"] or {}, ensure_ascii=False))
    for key in ("locked", "hidden", "z_index"):
        if key in fields:
            sets.append(f"{key}=?"); params.append(int(fields[key]) if key != "z_index" else fields[key])
    if not sets:
        return existing
    sets.append("updated_at=?"); params.append(time.time())
    params += [drawing_id, user_id]
    with _connect() as conn:
        conn.execute(f"UPDATE chart_drawings SET {','.join(sets)} WHERE id=? AND user_id=?", params)
    return get_drawing(drawing_id, user_id)


def get_drawing(drawing_id: str, user_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM chart_drawings WHERE id=? AND user_id=?", (drawing_id, user_id)).fetchone()
    return _drawing_dict(row) if row else None


def list_drawings(layout_id: str, user_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM chart_drawings WHERE layout_id=? AND user_id=? ORDER BY z_index,created_at",
            (layout_id, user_id),
        ).fetchall()
    return [_drawing_dict(r) for r in rows]


def delete_drawing(drawing_id: str, user_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM chart_drawings WHERE id=? AND user_id=?", (drawing_id, user_id))
        return cur.rowcount > 0


def _drawing_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["points"] = json.loads(d.pop("points_json") or "[]")
    d["properties"] = json.loads(d.pop("properties_json") or "{}")
    d["locked"] = bool(d["locked"])
    d["hidden"] = bool(d["hidden"])
    return d


# ------------------------------------------------------ strategy requests --

def create_strategy_request(user_id: str, **fields) -> dict:
    request_id = new_id("chartreq")
    now = time.time()
    cols = ["layout_id", "symbol", "board", "timeframe", "visible_from", "visible_to", "idea_description",
             "entry_conditions", "exit_conditions", "stop_description", "take_description",
             "position_management", "risk_tolerance", "comment", "screenshot_path"]
    values = [fields.get(c) for c in cols]
    with _connect() as conn:
        conn.execute(
            f"INSERT INTO chart_strategy_requests (id,user_id,{','.join(cols)},drawings_snapshot_json,"
            f"indicators_json,status,created_at,updated_at) VALUES (?,?,{','.join('?' * len(cols))},?,?,?,?,?)",
            [request_id, user_id, *values,
             json.dumps(fields.get("drawings_snapshot") or [], ensure_ascii=False, default=str),
             json.dumps(fields.get("indicators") or [], ensure_ascii=False),
             "new", now, now],
        )
    return get_strategy_request(request_id, user_id)


def get_strategy_request(request_id: str, user_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM chart_strategy_requests WHERE id=? AND user_id=?", (request_id, user_id)
        ).fetchone()
    return _request_dict(row) if row else None


def list_strategy_requests(user_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM chart_strategy_requests WHERE user_id=? ORDER BY created_at DESC", (user_id,)
        ).fetchall()
    return [_request_dict(r) for r in rows]


def _request_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["drawings_snapshot"] = json.loads(d.pop("drawings_snapshot_json") or "[]")
    d["indicators"] = json.loads(d.pop("indicators_json") or "[]")
    return d
