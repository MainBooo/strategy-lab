from __future__ import annotations

from pathlib import Path

from commerce_audit import _clean
from commerce_data_safety import _plain_strategy_name


ROOT = Path(__file__).resolve().parents[1]


def test_all_requested_metrika_events_are_present():
    source = (ROOT / "static" / "commerce.js").read_text(encoding="utf-8")
    expected = {
        "custom_strategy_cta_click",
        "custom_strategy_order_open",
        "custom_strategy_order_submit",
        "custom_strategy_quote_view",
        "custom_strategy_payment_click",
        "custom_strategy_payment_success",
        "support_click",
        "support_amount_select",
        "support_checkout_start",
        "support_success",
    }
    missing = sorted(event for event in expected if f'track("{event}"' not in source)
    assert missing == []


def test_admin_audit_whitelist_drops_strategy_secrets_and_contact():
    raw = {
        "status": "REVIEWING",
        "quoted_price": 7900,
        "entry_rules": "secret entry rules",
        "exit_rules": "secret exit rules",
        "freeform_description": "valuable trading system",
        "contact": "private@example.com",
        "admin_notes": "internal note",
        "raw_payload": {"provider": "secret"},
    }
    cleaned = _clean(raw)
    assert cleaned == {"status": "REVIEWING", "quoted_price": 7900}
    serialized = repr(cleaned)
    assert "secret entry" not in serialized
    assert "private@example.com" not in serialized
    assert "internal note" not in serialized


def test_private_strategy_name_cannot_inject_html_into_legacy_catalog():
    name = _plain_strategy_name('<img src=x onerror=alert(1)> Моя стратегия')
    assert "<" not in name and ">" not in name
    assert "Моя стратегия" in name
