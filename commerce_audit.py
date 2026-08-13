from __future__ import annotations

"""Privacy boundary for commerce admin audit records.

Auditability is useful for price/status/link actions, but a trading strategy
can itself be valuable confidential information. This wrapper deliberately
allows only operational fields into AdminAuditLog and patches commerce_db's
audit function before commerce routes are registered.
"""

import commerce_db as cdb
import commerce_user_search  # noqa: F401 - installs cross-store admin search

_original_audit = cdb.audit
_ALLOWED = {
    "status", "quoted_price", "currency", "strategy_id", "runner_strategy_id",
    "quoted_at", "paid_at", "started_at", "completed_at", "cancelled_at",
    "changed", "has_notes",
}


def _clean(value: dict | None) -> dict | None:
    if value is None:
        return None
    return {k: value.get(k) for k in _ALLOWED if k in value}


def safe_audit(admin_user_id: str, action: str, entity_type: str, entity_id: str,
               before: dict | None, after: dict | None) -> None:
    _original_audit(admin_user_id, action, entity_type, entity_id, _clean(before), _clean(after))


cdb.audit = safe_audit
