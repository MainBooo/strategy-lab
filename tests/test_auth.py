from __future__ import annotations

import re

import pytest

import app as app_module
import auth_db
import auth_routes
import backtests_db as bdb
from portfolio_store import PortfolioStore
from rate_limit import SlidingWindowLimiter


@pytest.fixture()
def client(tmp_path, monkeypatch):
    auth_db.init_db(tmp_path / "users.db")
    bdb.init_db(tmp_path / "backtests.db")
    portfolios = PortfolioStore(tmp_path / "portfolios.json")
    monkeypatch.setattr(app_module, "PORTFOLIOS", portfolios)
    auth_routes.configure(portfolios)
    # Fresh, generous limiters per test - the real module-level limiters are
    # process-wide singletons and would otherwise accumulate hits across
    # every test in this file (all requests share the test client's
    # 127.0.0.1 "IP"), tripping later tests with an unrelated 429.
    monkeypatch.setattr(auth_routes, "LOGIN_LIMITER", SlidingWindowLimiter(max_requests=1000, window_seconds=60))
    monkeypatch.setattr(auth_routes, "REGISTER_LIMITER", SlidingWindowLimiter(max_requests=1000, window_seconds=60))
    monkeypatch.setattr(auth_routes, "ACCOUNT_ACTION_LIMITER", SlidingWindowLimiter(max_requests=1000, window_seconds=60))
    app_module.app.testing = True
    with app_module.app.test_client() as c:
        yield c


def _csrf(client, path="/login"):
    resp = client.get(path)
    match = re.search(r'name="csrf-token" content="([^"]+)"', resp.get_data(as_text=True))
    assert match, f"no csrf meta tag found on {path}"
    return match.group(1)


def _register(client, email="user@example.com", password="password123", name="Test User"):
    token = _csrf(client, "/register")
    return client.post("/api/auth/register", json={
        "display_name": name, "email": email, "password": password,
    }, headers={"X-CSRF-Token": token})


def _login(client, email="user@example.com", password="password123"):
    token = _csrf(client, "/login")
    return client.post("/api/auth/login", json={
        "email": email, "password": password, "remember": True,
    }, headers={"X-CSRF-Token": token})


def _logout(client):
    token = _csrf(client, "/")
    return client.post("/api/auth/logout", headers={"X-CSRF-Token": token})


# --------------------------------------------------------- registration ---

def test_register_valid_logs_in_immediately(client):
    resp = _register(client)
    assert resp.status_code == 201
    assert resp.get_json()["ok"] is True
    # session already authenticated - private page is reachable, no redirect
    assert client.get("/account").status_code == 200


def test_register_duplicate_email_rejected(client):
    assert _register(client, email="dup@example.com").status_code == 201
    _logout(client)
    resp = _register(client, email="dup@example.com", name="Second Person")
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_register_duplicate_email_case_and_whitespace_insensitive(client):
    assert _register(client, email="  Mixed@Example.com ").status_code == 201
    _logout(client)
    resp = _register(client, email="mixed@example.com", name="Someone Else")
    assert resp.status_code == 400


def test_register_invalid_email_rejected(client):
    resp = _register(client, email="not-an-email")
    assert resp.status_code == 400


def test_register_short_password_rejected(client):
    resp = _register(client, password="short")
    assert resp.status_code == 400


def test_register_missing_name_rejected(client):
    resp = _register(client, name="   ")
    assert resp.status_code == 400


# ------------------------------------------------------------------ login -

def test_login_valid(client):
    _register(client, email="valid@example.com")
    _logout(client)
    resp = _login(client, email="valid@example.com")
    assert resp.status_code == 200


def test_login_wrong_password_generic_message(client):
    _register(client, email="known@example.com")
    _logout(client)
    resp = _login(client, email="known@example.com", password="totally-wrong")
    assert resp.status_code == 401
    assert resp.get_json()["error"] == auth_routes.GENERIC_LOGIN_ERROR


def test_login_unknown_email_same_generic_message(client):
    resp = _login(client, email="nobody-registered@example.com")
    assert resp.status_code == 401
    assert resp.get_json()["error"] == auth_routes.GENERIC_LOGIN_ERROR


# ----------------------------------------------------------------- logout -

def test_logout_blocks_private_route(client):
    _register(client, email="logout@example.com")
    assert client.get("/account").status_code == 200
    resp = _logout(client)
    assert resp.status_code == 200
    resp = client.get("/account", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["Location"].startswith("/login")


def test_anonymous_account_api_returns_401_not_500(client):
    resp = client.get("/account/api/overview")
    assert resp.status_code == 401


# ------------------------------------------------------------------- csrf -

def test_state_changing_request_without_csrf_header_rejected(client):
    _register(client, email="csrf@example.com")
    resp = client.post("/account/api/settings/profile", json={"display_name": "New Name"})
    assert resp.status_code == 403


def test_csrf_header_required_on_login_too(client):
    resp = client.post("/api/auth/login", json={"email": "x@example.com", "password": "whatever1"})
    assert resp.status_code == 403


# ------------------------------------------------------------ open redirect

def test_login_rejects_external_next_url(client):
    resp = client.get("/login?next=https://evil.example/steal")
    assert resp.status_code == 200
    # server never echoes the external URL back into the page as the redirect target
    assert "https://evil.example" not in resp.get_data(as_text=True)


def test_login_rejects_protocol_relative_next_url(client):
    resp = client.get("/login?next=//evil.example")
    assert "//evil.example" not in resp.get_data(as_text=True)


def test_login_allows_safe_internal_next_url(client):
    resp = client.get("/login?next=/account/backtests")
    assert "/account/backtests" in resp.get_data(as_text=True)


# ------------------------------------------------------------------- idor -

def test_user_cannot_see_another_users_private_portfolio(client):
    _register(client, email="owner@example.com")
    resp = client.post("/api/portfolios", json={"name": "Owner's portfolio"})
    portfolio_id = resp.get_json()["id"]
    assert resp.get_json()["user_id"] is not None
    _logout(client)

    _register(client, email="intruder@example.com")
    resp = client.get(f"/api/portfolios/{portfolio_id}")
    assert resp.status_code == 404
    resp = client.put(f"/api/portfolios/{portfolio_id}", json={"name": "Hijacked"})
    assert resp.status_code == 404
    resp = client.delete(f"/api/portfolios/{portfolio_id}")
    assert resp.status_code == 404
    # doesn't even show up in the intruder's own portfolio list
    listed_ids = [p["id"] for p in client.get("/api/portfolios").get_json()]
    assert portfolio_id not in listed_ids


def test_user_cannot_see_another_users_private_backtest(client):
    _register(client, email="ownerb@example.com")
    resp = client.post("/api/portfolios", json={"name": "P"})
    portfolio_id = resp.get_json()["id"]
    owner_id = auth_db.get_by_email("ownerb@example.com")["id"]
    bdb.create_run("run_owned", portfolio_id, "P", None, None, 1_000_000, 1, {}, user_id=owner_id)
    bdb.finish_run("run_owned", status="completed", final_capital=1_100_000)
    _logout(client)

    _register(client, email="intruderb@example.com")
    for path in (
        "/api/backtests/run_owned",
        "/api/backtests/run_owned/results",
        "/api/backtests/run_owned/trades",
        "/api/backtests/run_owned/export.json",
        "/api/backtests/run_owned/export.csv",
    ):
        resp = client.get(path)
        assert resp.status_code == 404, f"{path} leaked another user's backtest"
    assert client.delete("/api/backtests/run_owned").status_code == 404

    # and it must not appear in the intruder's own "Мои бэктесты"
    resp = client.get("/account/api/backtests")
    assert all(row["id"] != "run_owned" for row in resp.get_json()["rows"])


def test_legacy_unowned_backtest_stays_visible_to_everyone(client):
    """user_id=NULL rows (created before accounts existed) are not IDOR'd
    away - see the migration's explicit "stay shared" decision."""
    resp = client.post("/api/portfolios", json={"name": "Legacy"})  # anonymous -> user_id None
    portfolio_id = resp.get_json()["id"]
    bdb.create_run("run_legacy", portfolio_id, "Legacy", None, None, 1_000_000, 1, {})  # user_id defaults None
    bdb.finish_run("run_legacy", status="completed")

    assert client.get("/api/backtests/run_legacy").status_code == 200
    _register(client, email="anyone@example.com")
    assert client.get("/api/backtests/run_legacy").status_code == 200


# -------------------------------------------------------------- favorites -

def test_favorites_round_trip(client):
    _register(client, email="fav@example.com")
    token = _csrf(client, "/")
    resp = client.post("/account/api/favorites", json={"ticker": "sber"}, headers={"X-CSRF-Token": token})
    assert resp.status_code == 201
    resp = client.get("/account/api/favorites")
    assert resp.get_json()["favorites"] == ["SBER"]
    resp = client.delete("/account/api/favorites/SBER", headers={"X-CSRF-Token": token})
    assert resp.status_code == 200
    assert client.get("/account/api/favorites").get_json()["favorites"] == []


# --------------------------------------------------------- password change

def test_password_change_requires_correct_current_password(client):
    _register(client, email="pwchange@example.com", password="original123")
    token = _csrf(client, "/")
    resp = client.post("/account/api/settings/password", json={
        "current_password": "wrong-current", "new_password": "newpassword123",
    }, headers={"X-CSRF-Token": token})
    assert resp.status_code == 400
    _logout(client)
    # old password still works - nothing was changed
    assert _login(client, email="pwchange@example.com", password="original123").status_code == 200


def test_password_change_then_login_with_new_password(client):
    _register(client, email="pwchange2@example.com", password="original123")
    token = _csrf(client, "/")
    resp = client.post("/account/api/settings/password", json={
        "current_password": "original123", "new_password": "brandnewpass123",
    }, headers={"X-CSRF-Token": token})
    assert resp.status_code == 200
    _logout(client)
    assert _login(client, email="pwchange2@example.com", password="original123").status_code == 401
    assert _login(client, email="pwchange2@example.com", password="brandnewpass123").status_code == 200


# ------------------------------------------------------- account deletion -

def test_account_deletion_requires_correct_password_and_deactivates(client):
    _register(client, email="delete@example.com", password="deleteme123")
    token = _csrf(client, "/")
    resp = client.post("/account/api/delete", json={"password": "wrong"}, headers={"X-CSRF-Token": token})
    assert resp.status_code == 400

    resp = client.post("/account/api/delete", json={"password": "deleteme123"}, headers={"X-CSRF-Token": token})
    assert resp.status_code == 200
    # logged out as a side effect
    assert client.get("/account", follow_redirects=False).status_code == 302
    # deactivated account can no longer log in
    resp = _login(client, email="delete@example.com", password="deleteme123")
    assert resp.status_code == 401
