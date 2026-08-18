from __future__ import annotations

"""Registration/login/logout + personal cabinet (/account/*) - the HTTP
surface for auth.py's session helpers and auth_db.py's storage. A Flask
Blueprint rather than routes bolted onto app.py directly, purely to keep
this large, self-contained new surface out of an already very large
app.py; nothing here duplicates app.py's own routes.

configure() exists because this module needs the same PortfolioStore
instance app.py already constructed (for "Мои портфели" and for stamping
new portfolios with an owner) without a circular import (app.py imports
this module to register the blueprint).
"""

import re
import secrets
import sqlite3
from functools import wraps
from pathlib import Path

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

import auth
import auth_db
import backtests_db as bdb
import commerce_audit  # noqa: F401 - installs the strict audit privacy boundary
import commerce_routes
import notification_routes
import notification_worker
import notifications_db as notifications_db
from csrf import csrf_protect, ensure_csrf_token
from rate_limit import SlidingWindowLimiter, client_ip

auth_bp = Blueprint("auth", __name__)
# Commerce stays in the existing Flask/Jinja stack. Registering it as a child
# blueprint keeps the large order/billing/admin surface out of app.py while
# preserving the same session, CSRF and template infrastructure.
auth_bp.register_blueprint(commerce_routes.commerce_bp)
# Notifications share the same authenticated session/CSRF boundary but keep
# their routes and delivery concerns out of this already-large auth module.
auth_bp.register_blueprint(notification_routes.notification_bp)

_PORTFOLIOS = None


def configure(portfolios_store, symbol_exists=None) -> None:
    global _PORTFOLIOS
    _PORTFOLIOS = portfolios_store
    commerce_routes.configure(portfolios_store)
    base_dir = Path(__file__).resolve().parent
    notifications_db.init_db(base_dir / "storage" / "notifications.db")
    notification_routes.configure(base_dir / "static", symbol_exists=symbol_exists)
    # Gunicorn imports this module in each worker; notification_worker uses a
    # process-level flock so exactly one worker evaluates alert rules.
    notification_worker.start(base_dir / "storage" / "notification-worker.lock")


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LENGTH = 8
MAX_FIELD_LENGTH = 254
GENERIC_LOGIN_ERROR = "Неверный email или пароль."

LOGIN_LIMITER = SlidingWindowLimiter(max_requests=10, window_seconds=300)
REGISTER_LIMITER = SlidingWindowLimiter(max_requests=8, window_seconds=600)
ACCOUNT_ACTION_LIMITER = SlidingWindowLimiter(max_requests=20, window_seconds=300)


def _rate_limited(limiter_name: str):
    def deco(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            limiter = globals()[limiter_name]
            if not limiter.allow(client_ip(request)):
                return jsonify({"error": "Слишком много попыток. Подождите немного и повторите."}), 429
            return view(*args, **kwargs)
        return wrapped
    return deco


def _safe_next(raw: str | None) -> str:
    if not raw or not raw.startswith("/") or raw.startswith("//") or "\\" in raw:
        return "/"
    return raw


# --------------------------------------------------------------- pages ----

@auth_bp.get("/login")
def login_page():
    if auth.current_user():
        return redirect(_safe_next(request.args.get("next")))
    return render_template("login.html", next_url=_safe_next(request.args.get("next")) if request.args.get("next") else None)


@auth_bp.get("/register")
def register_page():
    if auth.current_user():
        return redirect(_safe_next(request.args.get("next")))
    return render_template("register.html", next_url=_safe_next(request.args.get("next")) if request.args.get("next") else None)


@auth_bp.get("/terms")
def terms_page():
    return render_template("terms.html")


@auth_bp.get("/privacy")
def privacy_page():
    return render_template("privacy.html")


def _account_page(initial_tab: str):
    @auth.login_required
    def _view():
        return render_template("account.html", initial_tab=initial_tab)
    return _view()


@auth_bp.get("/account")
def account_overview_page(): return _account_page("overview")

@auth_bp.get("/account/backtests")
def account_backtests_page(): return _account_page("backtests")

@auth_bp.get("/account/portfolios")
def account_portfolios_page(): return _account_page("portfolios")

@auth_bp.get("/account/favorites")
def account_favorites_page(): return _account_page("favorites")

@auth_bp.get("/account/settings")
def account_settings_page(): return _account_page("settings")


# --------------------------------------------------------- auth actions ---

@auth_bp.post("/api/auth/register")
@_rate_limited("REGISTER_LIMITER")
@csrf_protect
def api_register():
    p = request.get_json(force=True) or {}
    display_name = str(p.get("display_name") or "").strip()
    email = str(p.get("email") or "").strip()
    password = str(p.get("password") or "")

    if not display_name:
        return jsonify({"error": "Укажите имя."}), 400
    if len(display_name) > 80:
        return jsonify({"error": "Имя слишком длинное."}), 400
    if len(email) > MAX_FIELD_LENGTH or not _EMAIL_RE.match(email):
        return jsonify({"error": "Некорректный email."}), 400
    if len(password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"Пароль должен быть не короче {MIN_PASSWORD_LENGTH} символов."}), 400
    if len(password) > 256:
        return jsonify({"error": "Пароль слишком длинный."}), 400

    if auth_db.get_by_email(email):
        return jsonify({"error": "Этот email уже зарегистрирован."}), 400

    password_hash = generate_password_hash(password)
    try:
        user = auth_db.create_user(email, password_hash, display_name)
    except sqlite3.IntegrityError:
        return jsonify({"error": "Этот email уже зарегистрирован."}), 400

    auth.log_in(user, remember=True)
    return jsonify({"ok": True, "display_name": user["display_name"]}), 201



# check_password_hash (scrypt) is deliberately slow; `or` short-circuits it
# away entirely when the account doesn't exist, so a nonexistent-email
# request returns in microseconds while a wrong-password one for a real
# account takes tens of milliseconds. GENERIC_LOGIN_ERROR hides that in the
# response body but not in latency, letting an attacker enumerate
# valid/active emails purely by timing this endpoint. Hashing against this
# fixed dummy hash on the "no such user" path costs the same time as a real
# check, closing the side channel.
_DUMMY_PASSWORD_HASH = generate_password_hash(secrets.token_hex(32))


@auth_bp.post("/api/auth/login")
@_rate_limited("LOGIN_LIMITER")
@csrf_protect
def api_login():
    p = request.get_json(force=True) or {}
    email = str(p.get("email") or "").strip()
    password = str(p.get("password") or "")
    remember = bool(p.get("remember"))

    user = auth_db.get_by_email(email)
    password_ok = check_password_hash(user["password_hash"] if user else _DUMMY_PASSWORD_HASH, password)
    if not user or not user.get("is_active") or not password_ok:
        return jsonify({"error": GENERIC_LOGIN_ERROR}), 401

    auth.log_in(user, remember)
    return jsonify({"ok": True, "display_name": user["display_name"]})


@auth_bp.post("/api/auth/logout")
@csrf_protect
def api_logout():
    auth.log_out()
    return jsonify({"ok": True})


# -------------------------------------------------------- account JSON ---

@auth_bp.get("/account/api/overview")
@auth.login_required
def api_overview():
    user = auth.current_user()
    backtests_total = bdb.list_runs(user_id=user["id"], owner_scope="mine", page=1, page_size=1)[1]
    recent, _ = bdb.list_runs(user_id=user["id"], owner_scope="mine", page=1, page_size=5)
    portfolios_count = len([p for p in _PORTFOLIOS.list() if p.get("user_id") == user["id"]])
    favorites_count = len(auth_db.list_favorites(user["id"]))
    return jsonify({
        "display_name": user["display_name"],
        "counts": {"backtests": backtests_total, "portfolios": portfolios_count, "favorites": favorites_count},
        "recent_backtests": recent,
    })


@auth_bp.get("/account/api/backtests")
@auth.login_required
def api_account_backtests():
    user = auth.current_user()
    try:
        page = int(request.args.get("page", 1)); page_size = int(request.args.get("page_size", 20))
    except ValueError:
        return jsonify({"error": "Некорректные параметры пагинации"}), 400
    rows, total = bdb.list_runs(user_id=user["id"], owner_scope="mine", page=page, page_size=page_size)
    return jsonify({"rows": rows, "total": total, "page": page, "page_size": page_size})


@auth_bp.get("/account/api/portfolios")
@auth.login_required
def api_account_portfolios():
    user = auth.current_user()
    rows = [p for p in _PORTFOLIOS.list() if p.get("user_id") == user["id"]]
    return jsonify({"portfolios": rows})


@auth_bp.get("/account/api/favorites")
@auth.login_required
def api_favorites_list():
    return jsonify({"favorites": auth_db.list_favorites(auth.current_user_id())})


@auth_bp.post("/account/api/favorites")
@auth.login_required
@csrf_protect
def api_favorites_add():
    p = request.get_json(force=True) or {}
    ticker = str(p.get("ticker") or "").strip().upper()
    if not ticker or len(ticker) > 20:
        return jsonify({"error": "Некорректный тикер"}), 400
    auth_db.add_favorite(auth.current_user_id(), ticker)
    return jsonify({"ok": True}), 201


@auth_bp.delete("/account/api/favorites/<ticker>")
@auth.login_required
@csrf_protect
def api_favorites_remove(ticker):
    auth_db.remove_favorite(auth.current_user_id(), ticker)
    return jsonify({"ok": True})


@auth_bp.post("/account/api/settings/profile")
@auth.login_required
@csrf_protect
@_rate_limited("ACCOUNT_ACTION_LIMITER")
def api_settings_profile():
    p = request.get_json(force=True) or {}
    display_name = str(p.get("display_name") or "").strip()
    if not display_name:
        return jsonify({"error": "Имя не может быть пустым."}), 400
    if len(display_name) > 80:
        return jsonify({"error": "Имя слишком длинное."}), 400
    auth_db.update_profile(auth.current_user_id(), display_name=display_name)
    return jsonify({"ok": True})


@auth_bp.post("/account/api/settings/password")
@auth.login_required
@csrf_protect
@_rate_limited("ACCOUNT_ACTION_LIMITER")
def api_settings_password():
    p = request.get_json(force=True) or {}
    current_password = str(p.get("current_password") or "")
    new_password = str(p.get("new_password") or "")
    user = auth.current_user()
    if not check_password_hash(user["password_hash"], current_password):
        return jsonify({"error": "Текущий пароль неверен."}), 400
    if len(new_password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"Новый пароль должен быть не короче {MIN_PASSWORD_LENGTH} символов."}), 400
    if len(new_password) > 256:
        return jsonify({"error": "Пароль слишком длинный."}), 400
    auth_db.update_password_hash(user["id"], generate_password_hash(new_password))
    auth.log_in(user, remember=True)
    return jsonify({"ok": True})


@auth_bp.post("/account/api/delete")
@auth.login_required
@csrf_protect
@_rate_limited("ACCOUNT_ACTION_LIMITER")
def api_delete_account():
    p = request.get_json(force=True) or {}
    password = str(p.get("password") or "")
    user = auth.current_user()
    if not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Неверный пароль."}), 400
    auth_db.deactivate_user(user["id"])
    auth.log_out()
    return jsonify({"ok": True})
