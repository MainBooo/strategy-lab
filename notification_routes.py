from __future__ import annotations

import math
import os

import requests
from flask import Blueprint, Response, jsonify, request, send_from_directory

import auth
import notifications_db as ndb
from csrf import csrf_protect
from notification_delivery import email_configured, telegram_configured, web_push_configured

notification_bp = Blueprint("notifications", __name__)
_STATIC_DIR = None


def configure(static_dir) -> None:
    global _STATIC_DIR
    _STATIC_DIR = static_dir


def _json() -> dict:
    return request.get_json(silent=True) or {}


@notification_bp.get("/api/alerts")
@auth.login_required
def list_alerts():
    return jsonify({"alerts": ndb.list_alerts(auth.current_user_id())})


@notification_bp.post("/api/alerts")
@auth.login_required
@csrf_protect
def create_alert():
    p = _json()
    try:
        value = float(p.get("value"))
        if not math.isfinite(value):
            raise ValueError
        alert = ndb.create_alert(
            auth.current_user_id(),
            symbol=str(p.get("symbol") or ""),
            condition=str(p.get("condition") or ""),
            value=value,
            repeat=str(p.get("repeat") or "once"),
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc) or "Некорректные параметры алерта."}), 400
    return jsonify({"alert": alert}), 201


@notification_bp.patch("/api/alerts/<alert_id>")
@auth.login_required
@csrf_protect
def update_alert(alert_id: str):
    try:
        alert = ndb.update_alert(auth.current_user_id(), alert_id, _json())
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    if not alert:
        return jsonify({"error": "Алерт не найден."}), 404
    return jsonify({"alert": alert})


@notification_bp.delete("/api/alerts/<alert_id>")
@auth.login_required
@csrf_protect
def delete_alert(alert_id: str):
    ndb.remove_alert(auth.current_user_id(), alert_id)
    return jsonify({"ok": True})


@notification_bp.get("/api/alerts/events")
@auth.login_required
def alert_events():
    try:
        after = float(request.args.get("after", "0"))
    except ValueError:
        after = 0.0
    return jsonify({"events": ndb.list_events(auth.current_user_id(), after=after)})


@notification_bp.get("/api/notifications/config")
@auth.login_required
def notification_config():
    user_id = auth.current_user_id()
    settings = ndb.get_settings(user_id)
    tg = ndb.get_telegram_link(user_id)
    return jsonify({
        "settings": settings,
        "capabilities": {
            "web_push": web_push_configured(),
            "email": email_configured(),
            "telegram": telegram_configured(),
        },
        "vapid_public_key": os.environ.get("WEB_PUSH_VAPID_PUBLIC_KEY", ""),
        "telegram_bot_username": os.environ.get("TELEGRAM_BOT_USERNAME", ""),
        "telegram_linked": bool(tg),
        "telegram_username": tg.get("username") if tg else None,
        "email": auth.current_user().get("email"),
    })


@notification_bp.patch("/api/notifications/settings")
@auth.login_required
@csrf_protect
def notification_settings():
    p = _json()
    return jsonify({"settings": ndb.update_settings(auth.current_user_id(), p)})


@notification_bp.post("/api/notifications/push/subscribe")
@auth.login_required
@csrf_protect
def push_subscribe():
    p = _json()
    endpoint = str(p.get("endpoint") or "")
    keys = p.get("keys") or {}
    p256dh = str(keys.get("p256dh") or "")
    auth_secret = str(keys.get("auth") or "")
    if not endpoint.startswith("https://") or not p256dh or not auth_secret:
        return jsonify({"error": "Некорректная push-подписка."}), 400
    sub = ndb.upsert_push_subscription(
        auth.current_user_id(), endpoint=endpoint, p256dh=p256dh, auth_secret=auth_secret,
        user_agent=request.headers.get("User-Agent", ""),
    )
    ndb.update_settings(auth.current_user_id(), {"web_push_enabled": True})
    return jsonify({"ok": True, "subscription": sub}), 201


@notification_bp.delete("/api/notifications/push/subscribe")
@auth.login_required
@csrf_protect
def push_unsubscribe():
    endpoint = str(_json().get("endpoint") or "")
    if endpoint:
        ndb.remove_push_subscription(endpoint=endpoint, user_id=auth.current_user_id())
    return jsonify({"ok": True})


@notification_bp.post("/api/notifications/telegram/link")
@auth.login_required
@csrf_protect
def telegram_link():
    username = os.environ.get("TELEGRAM_BOT_USERNAME", "").lstrip("@")
    if not username or not os.environ.get("TELEGRAM_BOT_TOKEN"):
        return jsonify({"error": "Telegram-бот ещё не настроен на сервере."}), 503
    token = ndb.create_telegram_link_token(auth.current_user_id())
    return jsonify({"url": f"https://t.me/{username}?start={token}", "expires_in": 900})


@notification_bp.delete("/api/notifications/telegram/link")
@auth.login_required
@csrf_protect
def telegram_unlink():
    ndb.unlink_telegram(auth.current_user_id())
    return jsonify({"ok": True})


@notification_bp.post("/api/notifications/telegram/webhook/<secret>")
def telegram_webhook(secret: str):
    expected = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
    if not expected or secret != expected:
        return jsonify({"ok": False}), 404
    update = _json()
    message = update.get("message") or {}
    chat = message.get("chat") or {}
    text = str(message.get("text") or "").strip()
    if not text.startswith("/start") or not chat.get("id"):
        return jsonify({"ok": True})
    parts = text.split(maxsplit=1)
    raw = parts[1].strip() if len(parts) > 1 else ""
    user = message.get("from") or {}
    linked_user = ndb.consume_telegram_link_token(raw, str(chat["id"]), str(user.get("username") or "")) if raw else None
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if bot_token:
        text_out = "✅ Strategy Lab подключён. Ценовые алерты будут приходить сюда." if linked_user else "Ссылка недействительна или устарела. Создайте новую в Strategy Lab."
        try:
            requests.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json={"chat_id": chat["id"], "text": text_out}, timeout=8)
        except Exception:
            pass
    return jsonify({"ok": True})


@notification_bp.get("/sw.js")
def service_worker():
    if _STATIC_DIR is None:
        return Response("", status=404)
    response = send_from_directory(str(_STATIC_DIR), "sw.js", mimetype="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response
