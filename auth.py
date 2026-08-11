from __future__ import annotations

"""Session/identity helpers shared between auth_routes.py (the HTTP
surface: register/login/logout/account pages) and app.py (which needs to
know "who is making this request" to stamp/check ownership on backtests
and portfolios, without importing the route-registration module itself).
"""

from functools import wraps

from flask import g, jsonify, request, session

import auth_db

SESSION_USER_KEY = "user_id"


def current_user() -> dict | None:
    """Cached per-request (via flask.g) - a route that calls this more than
    once doesn't re-hit SQLite each time. Returns None for an anonymous
    request, or for a session referencing a since-deactivated account (a
    stale "remember me" cookie must not resurrect a disabled login)."""
    if "current_user" in g:
        return g.current_user
    user_id = session.get(SESSION_USER_KEY)
    user = auth_db.get_by_id(user_id) if user_id else None
    if user and not user.get("is_active"):
        user = None
    g.current_user = user
    return user


def current_user_id() -> str | None:
    user = current_user()
    return user["id"] if user else None


def log_in(user: dict, remember: bool) -> None:
    session.clear()
    session[SESSION_USER_KEY] = user["id"]
    session.permanent = bool(remember)
    auth_db.touch_last_login(user["id"])


def log_out() -> None:
    session.clear()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_user() is None:
            if request.path.startswith("/api/") or request.path.startswith("/account/api/"):
                return jsonify({"error": "Требуется вход в аккаунт."}), 401
            from flask import redirect, url_for
            return redirect(url_for("auth.login_page", next=request.full_path))
        return view(*args, **kwargs)
    return wrapped
