from __future__ import annotations

"""Minimal CSRF defense for the account/auth endpoints - see auth_routes.py.

SESSION_COOKIE_SAMESITE=Lax (set in app.py) already blocks the classic
cross-site form/fetch CSRF for state-changing requests in modern browsers,
but the spec calls for not relying on SameSite alone. This adds a second,
independent layer for the endpoints this app newly introduces (register/
login/logout/account settings/account deletion): a random per-session
token, exposed to the page and required back as a header on every
state-changing request. A cross-site attacker can trick a browser into
*sending* a request with cookies attached, but cannot read this page (or
any header/token in it) to forge the header value - that's what actually
stops the forgery, independent of the cookie's SameSite attribute.

Deliberately scoped to the new auth/account surface only, not retrofitted
onto the pre-existing portfolio/backtest API - see the audit report for why.
"""

import hmac
import secrets
from functools import wraps

from flask import jsonify, request, session

SESSION_KEY = "csrf_token"


def ensure_csrf_token() -> str:
    token = session.get(SESSION_KEY)
    if not token:
        token = secrets.token_urlsafe(32)
        session[SESSION_KEY] = token
    return token


def csrf_protect(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            sent = request.headers.get("X-CSRF-Token", "")
            expected = session.get(SESSION_KEY, "")
            if not expected or not sent or not hmac.compare_digest(sent, expected):
                return jsonify({"error": "Сессия устарела. Обновите страницу и попробуйте снова."}), 403
        return view(*args, **kwargs)
    return wrapped
