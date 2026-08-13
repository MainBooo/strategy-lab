from __future__ import annotations

"""One-time payment providers for Strategy Lab.

The interface mirrors the proven ReputationOS billing boundary, but contains
no Plan/Subscription/workspace logic.  Strategy Lab only creates one-time
CUSTOM_STRATEGY and SUPPORT payments.
"""

import os
import uuid
from dataclasses import dataclass

import requests


class BillingProviderError(RuntimeError):
    pass


@dataclass
class ProviderPayment:
    id: str
    status: str
    confirmation_url: str | None
    payload: dict


class PaymentProvider:
    name = "MOCK"

    def create_payment(self, *, payment: dict, description: str, metadata: dict[str, str], return_url: str) -> ProviderPayment:
        raise NotImplementedError

    def get_payment(self, provider_payment_id: str) -> dict:
        raise NotImplementedError


class MockPaymentProvider(PaymentProvider):
    name = "MOCK"

    def create_payment(self, *, payment: dict, description: str, metadata: dict[str, str], return_url: str) -> ProviderPayment:
        provider_id = payment.get("provider_payment_id") or f"mock_{uuid.uuid4().hex}"
        payload = {
            "id": provider_id,
            "status": "pending",
            "amount": {"value": f"{int(payment['amount'])}.00", "currency": payment.get("currency", "RUB")},
            "metadata": metadata,
            "confirmation": {"confirmation_url": f"{return_url}{'&' if '?' in return_url else '?'}mock=1"},
        }
        return ProviderPayment(provider_id, "pending", payload["confirmation"]["confirmation_url"], payload)

    def get_payment(self, provider_payment_id: str) -> dict:
        # Mock state transitions are driven by the test/dev webhook payload;
        # there is no remote service to query.
        return {"id": provider_payment_id, "status": "pending"}


class YooKassaPaymentProvider(PaymentProvider):
    name = "YOOKASSA"
    API = "https://api.yookassa.ru/v3/payments"

    def __init__(self) -> None:
        self.shop_id = (os.environ.get("YOOKASSA_SHOP_ID") or "").strip()
        self.secret_key = (os.environ.get("YOOKASSA_SECRET_KEY") or "").strip()
        if not self.shop_id or not self.secret_key:
            raise BillingProviderError("YooKassa credentials are not configured")

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        try:
            response = requests.request(method, url, auth=(self.shop_id, self.secret_key), timeout=15, **kwargs)
        except requests.RequestException as exc:
            raise BillingProviderError("YooKassa is temporarily unavailable") from exc
        if not response.ok:
            # Do not surface provider bodies: they may contain identifiers or
            # implementation details that are not useful to end users.
            raise BillingProviderError(f"YooKassa API error: HTTP {response.status_code}")
        return response

    def create_payment(self, *, payment: dict, description: str, metadata: dict[str, str], return_url: str) -> ProviderPayment:
        body = {
            "amount": {"value": f"{int(payment['amount'])}.00", "currency": payment.get("currency", "RUB")},
            "capture": True,
            "description": description[:128],
            "confirmation": {"type": "redirect", "return_url": return_url},
            "metadata": metadata,
        }
        response = self._request(
            "POST", self.API,
            headers={"Content-Type": "application/json", "Idempotence-Key": payment["idempotency_key"]},
            json=body,
        )
        data = response.json()
        confirmation = data.get("confirmation") or {}
        confirmation_url = confirmation.get("confirmation_url") or confirmation.get("redirect_url")
        return ProviderPayment(str(data["id"]), str(data.get("status") or "pending"), confirmation_url, data)

    def get_payment(self, provider_payment_id: str) -> dict:
        return self._request("GET", f"{self.API}/{provider_payment_id}").json()


def create_payment_provider() -> PaymentProvider:
    provider = (os.environ.get("BILLING_PROVIDER") or "mock").strip().lower()
    if provider == "yookassa":
        return YooKassaPaymentProvider()
    return MockPaymentProvider()
