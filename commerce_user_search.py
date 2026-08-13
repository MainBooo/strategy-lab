from __future__ import annotations

"""Cross-store admin search for commerce orders.

Users and commerce intentionally live in separate SQLite files, so there is no
foreign-database SQL join. This small adapter keeps the stores independent and
adds the requested display-name/email search in Python for the low-volume admin
MVP.
"""

import auth_db
import commerce_db as cdb

_original_list_orders_admin = cdb.list_orders_admin


def list_orders_admin(*, status: str | None = None, payment_status: str | None = None,
                      query: str | None = None, date_from: float | None = None,
                      date_to: float | None = None) -> list[dict]:
    rows = _original_list_orders_admin(
        status=status, payment_status=payment_status, query=None,
        date_from=date_from, date_to=date_to,
    )
    q = (query or "").strip().lower()
    if not q:
        return rows
    result = []
    for row in rows:
        user = auth_db.get_by_id(row.get("user_id"))
        haystack = " ".join([
            str(row.get("public_id") or ""), str(row.get("title") or ""), str(row.get("user_id") or ""),
            str((user or {}).get("display_name") or ""), str((user or {}).get("email") or ""),
        ]).lower()
        if q in haystack:
            result.append(row)
    return result


cdb.list_orders_admin = list_orders_admin
