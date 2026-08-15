from __future__ import annotations

"""Delivery adapters for Strategy Lab alert events.

All channel credentials stay server-side in environment variables. Delivery
failures are isolated per channel: a broken Telegram/SMTP/Web Push endpoint
must never prevent the other channels from being attempted.
"""

import json
import logging
import os
import smtplib
import ssl
from email.message import EmailMessage

import requests

import auth_db
import notifications_db as ndb

log = logging.getLogger(__name__)

CONDITION_LABELS = {
    "price_above": "Цена выше",
    "price_below": "Цена ниже",
    "cross_up": "Пересечение снизу вверх",
    "cross_down": "Пересечение сверху вниз",
}


def _fmt(value: float) -> str:
    return f"{float(value):,.2f}".replace(",", " ")


def _message(event: dict) -> tuple[str, str]:
    title = f"🔔 {event['symbol']} · ценовой алерт"
    body = f"{CONDITION_LABELS.get(event['condition'], event['condition'])} {_fmt(event['threshold'])}. Сейчас {_fmt(event['price'])}."
    return title, body


def web_push_configured() -> bool:
    return bool(os.environ.get("WEB_PUSH_VAPID_PUBLIC_KEY") and os.environ.get("WEB_PUSH_VAPID_PRIVATE_KEY"))


def telegram_configured() -> bool:
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_BOT_USERNAME"))


def email_configured() -> bool:
    return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_FROM"))


def _send_push_payload(user_id: str, payload: dict) -> int:
    """Send one visible push payload to every active subscription for a user.

    Used by both real alert events and the explicit self-test button. Expired
    endpoints are removed immediately so one stale iPhone/browser subscription
    cannot poison later deliveries.
    """
    if not web_push_configured():
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        log.error("pywebpush is not installed; web push disabled")
        return 0

    data = json.dumps(payload, ensure_ascii=False)
    sent = 0
    subject = os.environ.get("WEB_PUSH_VAPID_SUBJECT", "mailto:admin@generationweb.ru")
    for sub in ndb.list_push_subscriptions(user_id):
        info = {
            "endpoint": sub["endpoint"],
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth_secret"]},
        }
        try:
            webpush(
                subscription_info=info,
                data=data,
                vapid_private_key=os.environ["WEB_PUSH_VAPID_PRIVATE_KEY"],
                vapid_claims={"sub": subject},
                ttl=300,
            )
            sent += 1
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                ndb.remove_push_subscription(subscription_id=sub["id"])
            log.warning("Web push failed for %s (%s): %s", sub["id"], status, exc)
        except Exception:
            log.exception("Unexpected web push failure for %s", sub["id"])
    return sent


def send_test_web_push(user_id: str) -> int:
    """User-initiated delivery test; does not create or mutate a price alert."""
    return _send_push_payload(user_id, {
        "title": "✅ Strategy Lab · уведомления работают",
        "body": "Тестовое push-уведомление доставлено. Ценовые алерты смогут приходить даже когда приложение закрыто.",
        "tag": "strategy-lab-push-test",
        "url": "/?tab=charts",
        "kind": "push-test",
    })


def send_web_push(event: dict) -> int:
    title, body = _message(event)
    sent = _send_push_payload(event["user_id"], {
        "title": title,
        "body": body,
        "tag": f"strategy-lab-alert-{event['alert_id']}",
        "url": "/?tab=charts",
        "symbol": event["symbol"],
        "eventId": event["id"],
    })
    if sent:
        ndb.mark_delivery(event["id"], channel="web_push")
    return sent


def send_telegram(event: dict) -> bool:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        return False
    link = ndb.get_telegram_link(event["user_id"])
    if not link:
        return False
    title, body = _message(event)
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": link["chat_id"], "text": f"{title}\n{body}", "disable_web_page_preview": True},
            timeout=10,
        )
        r.raise_for_status()
        ndb.mark_delivery(event["id"], channel="telegram")
        return True
    except Exception as exc:
        ndb.mark_delivery(event["id"], channel="telegram", error=str(exc))
        log.warning("Telegram alert delivery failed: %s", exc)
        return False


def send_email(event: dict) -> bool:
    host = os.environ.get("SMTP_HOST")
    sender = os.environ.get("SMTP_FROM")
    if not host or not sender:
        return False
    user = auth_db.get_by_id(event["user_id"])
    if not user or not user.get("email"):
        return False
    title, body = _message(event)
    msg = EmailMessage()
    msg["Subject"] = f"Strategy Lab: {event['symbol']} — сработал алерт"
    msg["From"] = sender
    msg["To"] = user["email"]
    msg.set_content(f"{title}\n\n{body}\n\nStrategy Lab\nhttps://strategylab.generationweb.ru")

    port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ.get("SMTP_USERNAME") or ""
    password = os.environ.get("SMTP_PASSWORD") or ""
    use_ssl = os.environ.get("SMTP_SSL", "").strip().lower() in ("1", "true", "yes")
    try:
        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=15, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(host, port, timeout=15)
            server.ehlo()
            if os.environ.get("SMTP_STARTTLS", "true").strip().lower() not in ("0", "false", "no"):
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
        with server:
            if username:
                server.login(username, password)
            server.send_message(msg)
        ndb.mark_delivery(event["id"], channel="email")
        return True
    except Exception as exc:
        ndb.mark_delivery(event["id"], channel="email", error=str(exc))
        log.warning("Email alert delivery failed: %s", exc)
        return False


def dispatch_event(event: dict) -> dict:
    settings = ndb.get_settings(event["user_id"])
    result = {"web_push": 0, "telegram": False, "email": False}
    errors = []
    try:
        if settings["web_push_enabled"]:
            result["web_push"] = send_web_push(event)
    except Exception as exc:
        errors.append(f"push: {exc}"); log.exception("Push dispatch failed")
    try:
        if settings["telegram_enabled"]:
            result["telegram"] = send_telegram(event)
    except Exception as exc:
        errors.append(f"telegram: {exc}"); log.exception("Telegram dispatch failed")
    try:
        if settings["email_enabled"]:
            result["email"] = send_email(event)
    except Exception as exc:
        errors.append(f"email: {exc}"); log.exception("Email dispatch failed")
    if errors:
        ndb.mark_delivery(event["id"], channel="web_push", error="; ".join(errors))
    return result
