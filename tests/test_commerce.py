from __future__ import annotations

import re

import pytest

import app as app_module
import auth_db
import auth_routes
import backtests_db as bdb
import commerce_db as cdb
from billing_providers import YooKassaPaymentProvider
from portfolio_store import PortfolioStore
from rate_limit import SlidingWindowLimiter


@pytest.fixture()
def client(tmp_path, monkeypatch):
    auth_db.init_db(tmp_path / "users.db")
    bdb.init_db(tmp_path / "backtests.db")
    portfolios = PortfolioStore(tmp_path / "portfolios.json")
    monkeypatch.setattr(app_module, "PORTFOLIOS", portfolios)
    auth_routes.configure(portfolios)
    monkeypatch.setenv("BILLING_PROVIDER", "mock")
    monkeypatch.delenv("YOOKASSA_SHOP_ID", raising=False)
    monkeypatch.delenv("YOOKASSA_SECRET_KEY", raising=False)
    monkeypatch.setattr(auth_routes, "LOGIN_LIMITER", SlidingWindowLimiter(max_requests=1000, window_seconds=60))
    monkeypatch.setattr(auth_routes, "REGISTER_LIMITER", SlidingWindowLimiter(max_requests=1000, window_seconds=60))
    monkeypatch.setattr(auth_routes, "ACCOUNT_ACTION_LIMITER", SlidingWindowLimiter(max_requests=1000, window_seconds=60))
    app_module.app.testing = True
    with app_module.app.test_client() as c:
        c.portfolios = portfolios
        yield c


def _csrf(client, path="/login"):
    resp = client.get(path)
    match = re.search(r'name="csrf-token" content="([^"]+)"', resp.get_data(as_text=True))
    assert match, f"no csrf meta tag found on {path}"
    return match.group(1)


def _register(client, email="user@example.com", password="password123", name="Test User"):
    token = _csrf(client, "/register")
    return client.post("/api/auth/register", json={"display_name": name, "email": email, "password": password}, headers={"X-CSRF-Token": token})


def _login(client, email="user@example.com", password="password123"):
    token = _csrf(client, "/login")
    return client.post("/api/auth/login", json={"email": email, "password": password, "remember": True}, headers={"X-CSRF-Token": token})


def _logout(client):
    token = _csrf(client, "/")
    return client.post("/api/auth/logout", headers={"X-CSRF-Token": token})


def _promote(email: str, value: int = 1):
    with auth_db._connect() as conn:
        conn.execute("UPDATE users SET is_admin=? WHERE email=?", (value, auth_db.normalize_email(email)))


def _valid_order_payload(**overrides):
    payload = {
        "title": "Пробой утреннего диапазона",
        "market": "Binance Spot",
        "symbols": "BTCUSDT",
        "timeframes": ["10m"],
        "directions": ["long"],
        "entry_rules": "Вход после подтверждённого пробоя диапазона.",
        "exit_rules": "Выход по стопу или тейку.",
        "stop_loss_rules": "За минимумом диапазона.",
        "take_profit_rules": "2R",
        "position_sizing_rules": "Риск 1%.",
        "additional_rules": "Без входов после 17:00.",
        "freeform_description": "Тестовая приватная идея.",
        "contact": "owner@example.com",
    }
    payload.update(overrides)
    return payload


def _create_order(client, **overrides):
    token = _csrf(client, "/")
    return client.post("/api/custom-strategy-orders", json=_valid_order_payload(**overrides), headers={"X-CSRF-Token": token})


def _quote(client, order_id: str, price=7900):
    token = _csrf(client, "/")
    return client.post(f"/api/admin/strategy-orders/{order_id}/quote", json={"quoted_price": price}, headers={"X-CSRF-Token": token})


def _send_offer(client, order_id: str):
    token = _csrf(client, "/")
    return client.post(f"/api/admin/strategy-orders/{order_id}/send-offer", json={}, headers={"X-CSRF-Token": token})


def _checkout(client, order_id: str, **extra):
    token = _csrf(client, "/")
    body = {"order_id": order_id, **extra}
    return client.post("/api/billing/custom-strategy/create-payment", json=body, headers={"X-CSRF-Token": token})


# -------------------------------------------------------------- orders ----

def test_order_create_valid_and_invalid_fields(client):
    assert _register(client, email="owner@example.com").status_code == 201
    good = _create_order(client)
    assert good.status_code == 201
    assert good.get_json()["status"] == "NEW"
    bad = _create_order(client, timeframes=[], directions=[])
    assert bad.status_code == 400


def test_order_owner_can_read_other_user_cannot(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    assert client.get(f"/account/api/strategy-orders/{order['id']}").status_code == 200
    _logout(client)
    _register(client, email="intruder@example.com")
    assert client.get(f"/account/api/strategy-orders/{order['id']}").status_code == 404


def test_admin_notes_never_leak_to_owner(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    _promote("owner@example.com")
    token = _csrf(client, "/")
    assert client.post(f"/api/admin/strategy-orders/{order['id']}/notes", json={"admin_notes": "Секретная внутренняя заметка"}, headers={"X-CSRF-Token": token}).status_code == 200
    _promote("owner@example.com", 0)
    user_view = client.get(f"/account/api/strategy-orders/{order['id']}").get_json()
    assert "admin_notes" not in user_view
    assert "Секретная" not in str(user_view)


# --------------------------------------------------------------- admin ----

def test_admin_access_anonymous_user_admin(client):
    assert client.get("/admin", follow_redirects=False).status_code == 302
    _register(client, email="user@example.com")
    assert client.get("/admin").status_code == 403
    assert client.get("/api/admin/dashboard").status_code == 403
    _promote("user@example.com")
    assert client.get("/admin").status_code == 200
    assert client.get("/api/admin/dashboard").status_code == 200


def test_quote_requires_admin_and_price_is_locked_after_payment(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    assert _quote(client, order["id"]).status_code == 403
    _promote("owner@example.com")
    assert _quote(client, order["id"], 7900).status_code == 200
    assert _send_offer(client, order["id"]).status_code == 200
    _promote("owner@example.com", 0)
    payment = _checkout(client, order["id"]).get_json()
    provider_id = cdb.get_payment(payment["payment_id"])["provider_payment_id"]
    assert client.post("/api/billing/yookassa/webhook", json={"event": "payment.succeeded", "object": {"id": provider_id}}).status_code == 200
    _promote("owner@example.com")
    assert _quote(client, order["id"], 12000).status_code == 409


# ------------------------------------------------------------- billing ----

def test_custom_payment_amount_comes_only_from_database(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    _promote("owner@example.com")
    _quote(client, order["id"], 7900); _send_offer(client, order["id"])
    _promote("owner@example.com", 0)
    resp = _checkout(client, order["id"], amount=1)
    assert resp.status_code == 200
    payment = cdb.get_payment(resp.get_json()["payment_id"])
    assert payment["amount"] == 7900


def test_cannot_pay_before_quote_or_cancelled(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    assert _checkout(client, order["id"]).status_code == 400
    cdb.update_order_admin(order["id"], status="CANCELLED", cancelled_at=1)
    assert _checkout(client, order["id"]).status_code == 400


def test_cannot_pay_another_users_order(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    _promote("owner@example.com"); _quote(client, order["id"]); _send_offer(client, order["id"]); _promote("owner@example.com", 0)
    _logout(client); _register(client, email="other@example.com")
    assert _checkout(client, order["id"]).status_code == 404


def test_checkout_is_idempotent_for_same_pending_order(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    _promote("owner@example.com"); _quote(client, order["id"]); _send_offer(client, order["id"]); _promote("owner@example.com", 0)
    first = _checkout(client, order["id"]).get_json()
    second = _checkout(client, order["id"]).get_json()
    assert first["payment_id"] == second["payment_id"]
    assert first["confirmation_url"] == second["confirmation_url"]
    rows = [p for p in cdb.list_payments_admin() if p["order_id"] == order["id"] and p["status"] == "PENDING"]
    assert len(rows) == 1


def test_payment_succeeded_duplicate_is_idempotent_and_does_not_regress_order(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    _promote("owner@example.com"); _quote(client, order["id"]); _send_offer(client, order["id"]); _promote("owner@example.com", 0)
    checkout = _checkout(client, order["id"]).get_json()
    payment = cdb.get_payment(checkout["payment_id"])
    payload = {"event": "payment.succeeded", "object": {"id": payment["provider_payment_id"]}}
    assert client.post("/api/billing/yookassa/webhook", json=payload).status_code == 200
    assert cdb.get_payment(payment["id"])["status"] == "SUCCEEDED"
    assert cdb.get_order(order["id"], include_private=True)["status"] == "PAID"
    cdb.update_order_admin(order["id"], status="IN_PROGRESS", started_at=2)
    assert client.post("/api/billing/yookassa/webhook", json=payload).status_code == 200
    assert cdb.get_order(order["id"], include_private=True)["status"] == "IN_PROGRESS"


def test_payment_canceled_is_idempotent_and_order_stays_payable(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json()
    _promote("owner@example.com"); _quote(client, order["id"]); _send_offer(client, order["id"]); _promote("owner@example.com", 0)
    checkout = _checkout(client, order["id"]).get_json(); payment = cdb.get_payment(checkout["payment_id"])
    payload = {"event": "payment.canceled", "object": {"id": payment["provider_payment_id"]}}
    assert client.post("/api/billing/yookassa/webhook", json=payload).status_code == 200
    assert client.post("/api/billing/yookassa/webhook", json=payload).status_code == 200
    assert cdb.get_payment(payment["id"])["status"] == "CANCELED"
    assert cdb.get_order(order["id"], include_private=True)["status"] == "WAITING_PAYMENT"
    retry = _checkout(client, order["id"])
    assert retry.status_code == 200
    assert retry.get_json()["payment_id"] != payment["id"]


def test_unknown_webhook_is_acknowledged_without_creating_payment(client):
    resp = client.post("/api/billing/yookassa/webhook", json={"event": "payment.succeeded", "object": {"id": "unknown-provider-id"}})
    assert resp.status_code == 200
    assert resp.get_json().get("unknown") is True
    assert cdb.list_payments_admin() == []


def test_support_amount_validation_and_type(client):
    _register(client, email="supporter@example.com")
    token = _csrf(client, "/")
    assert client.post("/api/billing/support/create-payment", json={"amount": 50}, headers={"X-CSRF-Token": token}).status_code == 400
    ok = client.post("/api/billing/support/create-payment", json={"amount": 500}, headers={"X-CSRF-Token": token})
    assert ok.status_code == 200
    payment = cdb.get_payment(ok.get_json()["payment_id"])
    assert payment["type"] == "SUPPORT" and payment["amount"] == 500


def test_pending_sync_endpoint_exists_and_is_csrf_protected(client):
    _register(client, email="owner@example.com")
    assert client.post("/api/billing/yookassa/sync", json={}).status_code == 403
    token = _csrf(client, "/")
    resp = client.post("/api/billing/yookassa/sync", json={}, headers={"X-CSRF-Token": token})
    assert resp.status_code == 200 and resp.get_json()["synced"] == 0


def test_portfolio_strategy_assignment_and_backtest_require_csrf(client):
    """These two commerce_routes.py routes touch a user's (possibly paid,
    private) strategy assignments but historically had no CSRF check at all,
    unlike every sibling route - see csrf.py."""
    _register(client, email="csrfcheck@example.com")
    uid = auth_db.get_by_email("csrfcheck@example.com")["id"]
    portfolio = client.portfolios.create({"name":"P","instruments":[{"ticker":"SBER","file":"x.csv","lot_size":1,"lot_count":1}]}, user_id=uid)
    assert client.patch(f"/api/portfolios/{portfolio['id']}/strategies", json={"ticker_strategies":{}}).status_code == 403
    assert client.post(f"/api/portfolios/{portfolio['id']}/backtest", json={"tickers":["SBER"]}).status_code == 403
    token = _csrf(client, "/")
    ok = client.patch(f"/api/portfolios/{portfolio['id']}/strategies", json={"ticker_strategies":{}}, headers={"X-CSRF-Token": token})
    assert ok.status_code == 200


def test_public_strategy_preset_save_requires_csrf(client):
    """Only the private-strategy branch enforced CSRF here before; a public/
    system strategy preset save (the common case) had none."""
    _register(client, email="presetcsrf@example.com")
    assert client.put("/api/strategy-presets/false_breakout", json={"parameters": {}}).status_code == 403
    token = _csrf(client, "/")
    ok = client.put("/api/strategy-presets/false_breakout", json={"parameters": {}}, headers={"X-CSRF-Token": token})
    assert ok.status_code == 200


# ------------------------------------------------------ private strategy ---

def _paid_order(client):
    order = _create_order(client).get_json()
    _promote("owner@example.com"); _quote(client, order["id"]); _send_offer(client, order["id"]); _promote("owner@example.com", 0)
    checkout = _checkout(client, order["id"]).get_json(); payment = cdb.get_payment(checkout["payment_id"])
    client.post("/api/billing/yookassa/webhook", json={"event": "payment.succeeded", "object": {"id": payment["provider_payment_id"]}})
    return order


def test_private_strategy_owner_admin_visibility_and_other_user_hidden(client):
    _register(client, email="owner@example.com")
    order = _paid_order(client)
    _promote("owner@example.com")
    token = _csrf(client, "/")
    linked = client.post(f"/api/admin/strategy-orders/{order['id']}/link-strategy", json={"runner_strategy_id": "false_breakout", "name": "Моя приватная стратегия"}, headers={"X-CSRF-Token": token})
    assert linked.status_code == 200
    strategy_id = linked.get_json()["strategy"]["id"]
    _promote("owner@example.com", 0)
    owner_catalog = client.get("/api/strategies").get_json()
    assert strategy_id in owner_catalog
    assert owner_catalog[strategy_id]["visibility"] == "PRIVATE"

    _logout(client); _register(client, email="other@example.com")
    assert strategy_id not in client.get("/api/strategies").get_json()

    _logout(client); _login(client, email="owner@example.com"); _promote("owner@example.com")
    assert strategy_id in client.get("/api/strategies").get_json()


def test_private_strategy_cannot_be_assigned_by_other_user(client):
    _register(client, email="owner@example.com")
    owner_id = auth_db.get_by_email("owner@example.com")["id"]
    order = _paid_order(client)
    _promote("owner@example.com")
    token = _csrf(client, "/")
    linked = client.post(f"/api/admin/strategy-orders/{order['id']}/link-strategy", json={"runner_strategy_id": "false_breakout", "name": "Secret"}, headers={"X-CSRF-Token": token}).get_json()
    strategy_id = linked["strategy"]["id"]
    _promote("owner@example.com", 0)
    owner_portfolio = client.portfolios.create({"name":"Owner P","instruments":[{"ticker":"SBER","file":"x.csv","lot_size":1,"lot_count":1}]}, user_id=owner_id)
    token = _csrf(client, "/")
    ok = client.patch(f"/api/portfolios/{owner_portfolio['id']}/strategies", json={"ticker_strategies":{"SBER":[{"strategy_id":strategy_id,"parameters":{},"enabled":True}]}}, headers={"X-CSRF-Token": token})
    assert ok.status_code == 200

    _logout(client); _register(client, email="other@example.com")
    other_id = auth_db.get_by_email("other@example.com")["id"]
    other_portfolio = client.portfolios.create({"name":"Other P","instruments":[{"ticker":"SBER","file":"x.csv","lot_size":1,"lot_count":1}]}, user_id=other_id)
    other_token = _csrf(client, "/")
    # With a valid CSRF token supplied, this must still 403 on the private-
    # strategy ownership check itself, not just on the (separately tested)
    # missing-token path.
    resp = client.patch(f"/api/portfolios/{other_portfolio['id']}/strategies", json={"ticker_strategies":{"SBER":[{"strategy_id":strategy_id,"parameters":{},"enabled":True}]}}, headers={"X-CSRF-Token": other_token})
    assert resp.status_code == 403


def test_linking_private_strategy_requires_paid_order(client):
    _register(client, email="owner@example.com")
    order = _create_order(client).get_json(); _promote("owner@example.com")
    token = _csrf(client, "/")
    resp = client.post(f"/api/admin/strategy-orders/{order['id']}/link-strategy", json={"runner_strategy_id":"false_breakout"}, headers={"X-CSRF-Token": token})
    assert resp.status_code == 409


# ------------------------------------------------------ provider contract --

def test_yookassa_provider_uses_redirect_and_idempotence_key(monkeypatch):
    monkeypatch.setenv("YOOKASSA_SHOP_ID", "shop")
    monkeypatch.setenv("YOOKASSA_SECRET_KEY", "secret")
    captured = {}

    class Response:
        ok = True
        status_code = 200
        def json(self):
            return {"id":"yk_1","status":"pending","confirmation":{"confirmation_url":"https://yookassa.test/pay"}}

    def fake_request(method, url, **kwargs):
        captured.update({"method": method, "url": url, **kwargs})
        return Response()

    monkeypatch.setattr("billing_providers.requests.request", fake_request)
    provider = YooKassaPaymentProvider()
    payment = {"id":"local1","amount":7900,"currency":"RUB","idempotency_key":"idem-123"}
    result = provider.create_payment(payment=payment, description="Разработка стратегии", metadata={"payment_id":"local1"}, return_url="https://example.test/result")
    assert result.confirmation_url == "https://yookassa.test/pay"
    assert captured["headers"]["Idempotence-Key"] == "idem-123"
    assert captured["json"]["amount"] == {"value":"7900.00","currency":"RUB"}
    assert captured["json"]["capture"] is True
    assert captured["json"]["confirmation"]["type"] == "redirect"


# ------------------------------------------------------------- price alerts --

def test_create_alert_rejects_unknown_symbol(client):
    """notifications_db.create_alert only checked length/emptiness of
    `symbol`, not whether it's a real instrument - a typo'd symbol used to be
    accepted with 201 and then sit "active" forever, never able to fire since
    the price snapshot never has a quote for it. app.py wires a real
    catalog-backed validator in production; here we stub one directly."""
    auth_routes.configure(client.portfolios, symbol_exists=lambda s: s == "BTCUSDT")
    _register(client, email="alerts@example.com")
    token = _csrf(client, "/")
    bad = client.post("/api/alerts", json={"symbol": "NOTREAL", "condition": "price_above", "value": 100}, headers={"X-CSRF-Token": token})
    assert bad.status_code == 400
    good = client.post("/api/alerts", json={"symbol": "BTCUSDT", "condition": "price_above", "value": 100}, headers={"X-CSRF-Token": token})
    assert good.status_code == 201
