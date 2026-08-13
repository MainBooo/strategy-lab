from __future__ import annotations

import logging
import os
from decimal import Decimal, InvalidOperation
from urllib.parse import urlencode

import commerce_db as cdb
from billing_providers import BillingProviderError, MockPaymentProvider, create_payment_provider

log = logging.getLogger(__name__)

SUPPORT_MIN_RUB = 100
SUPPORT_MAX_RUB = 100_000


def _return_url(payment_id: str, payment_type: str) -> str:
    configured = (os.environ.get("YOOKASSA_RETURN_URL") or "").strip()
    base = configured or "https://strategylab.generationweb.ru/account/payments/result"
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}{urlencode({'payment_id': payment_id, 'type': payment_type})}"


def _metadata(payment: dict) -> dict[str, str]:
    data = {
        "payment_id": payment["id"],
        "payment_type": payment["type"],
    }
    if payment.get("user_id"):
        data["user_id"] = str(payment["user_id"])
    if payment.get("order_id"):
        data["order_id"] = str(payment["order_id"])
    return data


def _checkout(payment: dict, description: str) -> dict:
    provider = create_payment_provider()
    # A previous request may have created the local row but died before the
    # browser received confirmation_url. Reusing the same row means the same
    # Idempotence-Key is sent to YooKassa again and cannot create a duplicate
    # remote charge.
    if payment.get("confirmation_url") and payment.get("provider_payment_id"):
        return {"payment_id": payment["id"], "confirmation_url": payment["confirmation_url"]}
    remote = provider.create_payment(
        payment=payment,
        description=description,
        metadata=_metadata(payment),
        return_url=_return_url(payment["id"], payment["type"]),
    )
    updated = cdb.set_payment_provider_result(
        payment["id"], provider_payment_id=remote.id,
        confirmation_url=remote.confirmation_url, raw_payload=remote.payload,
    )
    if not updated or not updated.get("confirmation_url"):
        raise BillingProviderError("Платёж создан, но YooKassa не вернула ссылку для оплаты")
    return {"payment_id": updated["id"], "confirmation_url": updated["confirmation_url"]}


def create_custom_strategy_checkout(user_id: str, order_id: str) -> dict:
    order = cdb.get_order_for_user(order_id, user_id)
    if not order:
        raise LookupError("Заявка не найдена")
    if order["status"] != "WAITING_PAYMENT":
        raise ValueError("Эта заявка сейчас не ожидает оплату")
    amount = order.get("quoted_price")
    if not isinstance(amount, int) or amount <= 0:
        raise ValueError("Для заявки ещё не назначена стоимость")
    provider = create_payment_provider()
    payment = cdb.create_payment(
        payment_type="CUSTOM_STRATEGY", user_id=user_id, order_id=order["id"],
        provider=provider.name, amount=amount,
    )
    return _checkout(payment, f"Разработка стратегии #{order['public_id']} — Strategy Lab")


def create_support_checkout(user_id: str, amount: int) -> dict:
    try:
        amount = int(amount)
    except (TypeError, ValueError) as exc:
        raise ValueError("Некорректная сумма") from exc
    if amount < SUPPORT_MIN_RUB or amount > SUPPORT_MAX_RUB:
        raise ValueError(f"Сумма поддержки должна быть от {SUPPORT_MIN_RUB} до {SUPPORT_MAX_RUB} ₽")
    provider = create_payment_provider()
    payment = cdb.create_payment(
        payment_type="SUPPORT", user_id=user_id, order_id=None,
        provider=provider.name, amount=amount,
    )
    return _checkout(payment, "Поддержка разработки Strategy Lab")


def _money_matches(payment: dict, remote: dict) -> bool:
    amount = remote.get("amount") or {}
    try:
        remote_value = Decimal(str(amount.get("value")))
    except (InvalidOperation, TypeError):
        return False
    return remote_value == Decimal(int(payment["amount"])) and str(amount.get("currency") or "") == payment["currency"]


def _metadata_matches(payment: dict, remote: dict) -> bool:
    metadata = remote.get("metadata") or {}
    if str(metadata.get("payment_id") or "") != payment["id"]:
        return False
    if str(metadata.get("payment_type") or "") != payment["type"]:
        return False
    if payment.get("order_id") and str(metadata.get("order_id") or "") != payment["order_id"]:
        return False
    if payment.get("user_id") and str(metadata.get("user_id") or "") != payment["user_id"]:
        return False
    return True


def _apply_verified_remote(payment: dict, remote: dict) -> dict:
    if str(remote.get("id") or "") != str(payment.get("provider_payment_id") or ""):
        raise ValueError("provider payment id mismatch")
    status = str(remote.get("status") or "")
    if status == "succeeded":
        if not _money_matches(payment, remote) or not _metadata_matches(payment, remote):
            raise ValueError("YooKassa payment verification failed")
        updated, already = cdb.apply_succeeded(payment["id"], remote)
        return {"ok": True, "status": "SUCCEEDED", "already_processed": already, "payment": updated}
    if status == "canceled":
        updated, already = cdb.apply_canceled(payment["id"], remote)
        return {"ok": True, "status": "CANCELED", "already_processed": already, "payment": updated}
    return {"ok": True, "status": "PENDING", "payment": payment}


def handle_yookassa_webhook(payload: dict) -> dict:
    event = str((payload or {}).get("event") or "")
    obj = (payload or {}).get("object") or {}
    provider_payment_id = str(obj.get("id") or "")
    if not provider_payment_id:
        raise ValueError("object.id is required")
    if event not in ("payment.succeeded", "payment.canceled"):
        return {"ok": True, "ignored": True}
    payment = cdb.get_payment_by_provider_id(provider_payment_id)
    if not payment:
        # Unknown provider IDs are acknowledged so YooKassa does not retry
        # forever, but no local state is created from an unsolicited callback.
        log.warning("YooKassa webhook for unknown payment id=%s", provider_payment_id)
        return {"ok": True, "unknown": True}

    provider = create_payment_provider()
    if isinstance(provider, MockPaymentProvider):
        # Test/dev only: construct the remote representation from the local
        # trusted amount/metadata while taking only the state/id from the mock
        # callback. Production never follows this branch.
        remote = {
            "id": provider_payment_id,
            "status": "succeeded" if event == "payment.succeeded" else "canceled",
            "amount": {"value": f"{int(payment['amount'])}.00", "currency": payment["currency"]},
            "metadata": _metadata(payment),
        }
    else:
        # Do not trust the public webhook body as proof of payment. Query the
        # provider over authenticated server-to-server API and verify amount,
        # currency and metadata before changing local state.
        remote = provider.get_payment(provider_payment_id)
    return _apply_verified_remote(payment, remote)


def sync_pending_for_user(user_id: str) -> dict:
    provider = create_payment_provider()
    if isinstance(provider, MockPaymentProvider):
        return {"synced": 0}
    synced = 0
    for payment in cdb.list_pending_payments_for_user(user_id, limit=10):
        try:
            remote = provider.get_payment(payment["provider_payment_id"])
            result = _apply_verified_remote(payment, remote)
            if result.get("status") in ("SUCCEEDED", "CANCELED"):
                synced += 1
        except Exception:
            log.exception("Pending payment sync failed for payment=%s", payment["id"])
    return {"synced": synced}
