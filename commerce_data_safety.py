from __future__ import annotations

"""Last-mile data minimisation for commerce records exposed to UI code."""

import re

import commerce_db as cdb

_original_private_strategy = cdb.create_or_update_private_strategy
_original_admin_payments = cdb.list_payments_admin


def _plain_strategy_name(value: str) -> str:
    # Existing Strategy Library templates treat catalog metadata as trusted
    # markup. Custom names originate with users/admin, so angle brackets and
    # control characters are normalized before the name ever enters the
    # catalog. Keep ordinary punctuation/Cyrillic untouched.
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))
    text = text.replace("<", "‹").replace(">", "›").strip()
    return text[:160] or "Пользовательская стратегия"


def create_or_update_private_strategy(*, order_id: str, owner_user_id: str, name: str,
                                      runner_strategy_id: str) -> dict:
    return _original_private_strategy(
        order_id=order_id, owner_user_id=owner_user_id,
        name=_plain_strategy_name(name), runner_strategy_id=runner_strategy_id,
    )


def list_payments_admin(*, payment_type: str | None = None, status: str | None = None) -> list[dict]:
    rows = _original_admin_payments(payment_type=payment_type, status=status)
    # Provider payload is persisted for reconciliation/audit, but the normal
    # admin payments table does not need to ship that blob to browser JS.
    for row in rows:
        row.pop("raw_payload", None)
    return rows


cdb.create_or_update_private_strategy = create_or_update_private_strategy
cdb.list_payments_admin = list_payments_admin
