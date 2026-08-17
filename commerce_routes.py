from __future__ import annotations

"""HTTP surface for custom strategy orders, one-time billing and admin.

This module is registered as a child of the existing auth blueprint from
``auth_routes.py``.  It deliberately reuses the existing Flask/Jinja/session/
CSRF stack instead of introducing a second web framework or SPA.
"""

import time
from datetime import datetime

from flask import Blueprint, jsonify, render_template, request

import auth
import auth_db
import backtests_db as bdb
import commerce_db as cdb
import strategy_presets_db as spdb
from billing_providers import BillingProviderError
from billing_service import (
    create_custom_strategy_checkout, create_support_checkout,
    handle_yookassa_webhook, sync_pending_for_user,
)
from csrf import csrf_protect
from strategies.param_schema import full_presets, full_schema, parse_params
from strategies.simple_strategies import RUNNERS, STRATEGY_CATALOG

commerce_bp = Blueprint("commerce", __name__)
_PORTFOLIOS = None

ORDER_STATUS_LABELS = {
    "NEW": "Заявка получена", "REVIEWING": "Оцениваем задачу", "NEEDS_INFO": "Нужно уточнение",
    "WAITING_PAYMENT": "Ожидает оплаты", "PAID": "Оплачено", "IN_PROGRESS": "В разработке",
    "READY": "Стратегия готова", "COMPLETED": "Завершено", "CANCELLED": "Отменено",
}

ALLOWED_TRANSITIONS = {
    "NEW": {"REVIEWING", "NEEDS_INFO", "CANCELLED"},
    "REVIEWING": {"NEEDS_INFO", "CANCELLED"},
    "NEEDS_INFO": {"REVIEWING", "CANCELLED"},
    "WAITING_PAYMENT": {"CANCELLED"},
    "PAID": {"IN_PROGRESS"},
    "IN_PROGRESS": set(),
    "READY": {"COMPLETED"},
    "COMPLETED": set(),
    "CANCELLED": set(),
}

TIMEFRAMES = {"1m", "10m", "15m", "30m", "1h", "4h", "1d", "other"}
DIRECTIONS = {"long", "short"}


def configure(portfolios_store) -> None:
    global _PORTFOLIOS
    _PORTFOLIOS = portfolios_store
    cdb.init_db(portfolios_store.path.parent / "commerce.db")


def _is_admin() -> bool:
    user = auth.current_user()
    return bool(user and user.get("is_admin"))


def _portfolio_accessible(portfolio: dict | None) -> bool:
    if not portfolio:
        return False
    owner = portfolio.get("user_id")
    return owner is None or owner == auth.current_user_id()


def _private_access(strategy: dict | None) -> bool:
    return bool(strategy and (_is_admin() or strategy.get("owner_user_id") == auth.current_user_id()))


def _runner_ids() -> set[str]:
    # false_breakout/head_shoulders are special-cased by app.run_strategy and
    # therefore are not both required to appear in RUNNERS.
    return set(STRATEGY_CATALOG) | set(RUNNERS) | {"false_breakout", "head_shoulders"}


def _strategy_resolution(strategy_id: str) -> tuple[str, dict | None] | None:
    if strategy_id in STRATEGY_CATALOG:
        return strategy_id, None
    private = cdb.get_private_strategy(strategy_id)
    if private and _private_access(private) and private["runner_strategy_id"] in _runner_ids():
        return private["runner_strategy_id"], private
    return None


def _strategy_meta(strategy_id: str, private: dict) -> dict:
    runner = private["runner_strategy_id"]
    base = STRATEGY_CATALOG.get(runner) or {}
    return {
        "name": private["name"],
        "category": "Мои стратегии",
        "summary": "Приватная стратегия, реализованная по вашей заявке.",
        "visual": base.get("visual") or "индивидуальная торговая логика",
        "params": full_schema(runner),
        "presets": full_presets(runner),
        "visibility": "PRIVATE",
        "source": "CUSTOM_ORDER",
        "runner_strategy_id": runner,
        "private": True,
    }


def _enriched_system_catalog() -> dict:
    return {
        sid: {**meta, "params": full_schema(sid), "presets": full_presets(sid), "visibility": "PUBLIC", "source": "SYSTEM"}
        for sid, meta in STRATEGY_CATALOG.items()
    }


def _order_payload(raw: dict) -> tuple[dict | None, str | None]:
    def text(key: str, max_len: int) -> str:
        return str(raw.get(key) or "").strip()[:max_len]

    timeframes = [str(x) for x in (raw.get("timeframes") or []) if str(x) in TIMEFRAMES]
    directions = [str(x) for x in (raw.get("directions") or []) if str(x) in DIRECTIONS]
    if not timeframes:
        return None, "Выберите хотя бы один таймфрейм."
    if not directions:
        return None, "Выберите Long и/или Short."
    contact = text("contact", 254)
    if not contact:
        return None, "Укажите контакт для связи."
    freeform = text("freeform_description", 12000)
    entry = text("entry_rules", 8000)
    exit_rules = text("exit_rules", 8000)
    if not (freeform or entry or exit_rules):
        return None, "Опишите торговую идею, условия входа или выхода."
    return {
        "title": text("title", 160) or None,
        "market": text("market", 500) or "Binance Spot",
        "symbols": text("symbols", 1000) or None,
        "timeframes": timeframes,
        "directions": directions,
        "entry_rules": entry or None,
        "exit_rules": exit_rules or None,
        "stop_loss_rules": text("stop_loss_rules", 4000) or None,
        "take_profit_rules": text("take_profit_rules", 4000) or None,
        "position_sizing_rules": text("position_sizing_rules", 4000) or None,
        "additional_rules": text("additional_rules", 8000) or None,
        "freeform_description": freeform or None,
        "contact": contact,
        # Attachment storage is intentionally prepared in the schema but not
        # exposed yet: the current app has no general private file-serving
        # infrastructure and silently adding one would increase attack surface.
        "attachments": [],
    }, None


def _safe_order(order: dict) -> dict:
    result = dict(order)
    result["status_label"] = ORDER_STATUS_LABELS.get(result.get("status"), result.get("status"))
    return result


# ---------------------------------------------------------------- catalog --
# These rules are registered before app.py's legacy system-only versions. They
# preserve the old response for anonymous/system users and add private records
# only when owner/admin access is proven server-side.

@commerce_bp.get("/api/strategies")
def api_strategies_with_private():
    result = _enriched_system_catalog()
    user = auth.current_user()
    if user:
        rows = cdb.list_private_strategies_admin() if _is_admin() else cdb.list_private_strategies_for_user(user["id"])
        for row in rows:
            result[row["id"]] = _strategy_meta(row["id"], row)
    return jsonify(result)


@commerce_bp.route("/api/strategy-presets/<strategy_id>", methods=["GET", "PUT", "DELETE"])
def strategy_preset_with_private(strategy_id):
    resolution = _strategy_resolution(strategy_id)
    if not resolution:
        return jsonify({"error": "Неизвестная стратегия"}), 404
    runner_id, private = resolution
    if private and not auth.current_user():
        return jsonify({"error": "Требуется вход в аккаунт."}), 401
    user_key = auth.current_user_id() or "local"
    storage_key = strategy_id
    if request.method == "GET":
        preset = spdb.get_preset(user_key, storage_key)
        return jsonify(preset or {"strategy_id": storage_key, "parameters": None, "updated_at": None})
    # Existing app routes historically did not use CSRF here. For the new
    # private surface we require the same token used by account routes.
    if private:
        sent = request.headers.get("X-CSRF-Token", "")
        from flask import session
        import hmac
        expected = session.get("csrf_token", "")
        if not expected or not sent or not hmac.compare_digest(sent, expected):
            return jsonify({"error": "Сессия устарела. Обновите страницу и попробуйте снова."}), 403
    if request.method == "DELETE":
        spdb.delete_preset(user_key, storage_key)
        return jsonify({"ok": True})
    raw = request.get_json(force=True) or {}
    if not isinstance(raw.get("parameters"), dict):
        return jsonify({"error": "parameters должен быть объектом"}), 400
    cleaned = parse_params(runner_id, raw["parameters"])
    return jsonify(spdb.save_preset(user_key, storage_key, cleaned))


@commerce_bp.patch("/api/portfolios/<portfolio_id>/strategies")
def portfolio_strategies_with_private(portfolio_id):
    portfolio = _PORTFOLIOS.get(portfolio_id) if _PORTFOLIOS else None
    if not _portfolio_accessible(portfolio):
        return jsonify({"error": "Портфель не найден"}), 404
    payload = request.get_json(force=True) or {}
    raw_map = payload.get("ticker_strategies")
    if not isinstance(raw_map, dict):
        return jsonify({"error": "ticker_strategies должен быть объектом"}), 400
    valid_tickers = {str(i.get("ticker")) for i in portfolio.get("instruments", [])}
    cleaned_map: dict[str, list[dict]] = {}
    has_private = False
    for ticker, assignments in raw_map.items():
        ticker = str(ticker).upper()
        if ticker not in valid_tickers:
            return jsonify({"error": f"{ticker} отсутствует в портфеле"}), 400
        if not isinstance(assignments, list):
            return jsonify({"error": f"Стратегии {ticker} должны быть списком"}), 400
        cleaned_rows = []
        for assignment in assignments:
            if not isinstance(assignment, dict):
                return jsonify({"error": "Некорректное назначение стратегии"}), 400
            strategy_id = str(assignment.get("strategy_id") or "")
            resolution = _strategy_resolution(strategy_id)
            if not resolution:
                return jsonify({"error": f"Стратегия «{strategy_id}» недоступна"}), 403
            runner_id, private = resolution
            if private:
                has_private = True
            cleaned_rows.append({
                "strategy_id": strategy_id,
                "parameters": parse_params(runner_id, assignment.get("parameters") or {}),
                "enabled": assignment.get("enabled") is not False,
            })
        cleaned_map[ticker] = cleaned_rows
    # A legacy/unowned portfolio is shared. Never persist a private strategy
    # into it because another visitor could then learn that private id/name.
    if has_private and portfolio.get("user_id") != auth.current_user_id():
        return jsonify({"error": "Приватную стратегию можно назначить только своему портфелю."}), 403
    updated = _PORTFOLIOS.set_ticker_strategies(portfolio_id, None, cleaned_map)
    return jsonify(updated)


@commerce_bp.post("/api/portfolios/<portfolio_id>/backtest")
def portfolio_backtest_with_private(portfolio_id):
    """Translate owner-visible private aliases to their registered runner.

    The actual job creation/execution remains app.py's existing backtest path;
    this wrapper only resolves access-controlled aliases before handing the
    request to it, so there is no second backtest engine.
    """
    portfolio = _PORTFOLIOS.get(portfolio_id) if _PORTFOLIOS else None
    if not _portfolio_accessible(portfolio):
        return jsonify({"error": "Портфель не найден"}), 404
    payload = request.get_json(force=True) or {}
    explicit = payload.get("assignments")
    if explicit is None:
        requested = [str(t).upper() for t in (payload.get("tickers") or [i.get("ticker") for i in portfolio.get("instruments", [])])]
        explicit = []
        stored = portfolio.get("ticker_strategies") or {}
        default_id = portfolio.get("default_strategy_id") or portfolio.get("strategy") or "false_breakout"
        for ticker in requested:
            rows = [dict(x) for x in (stored.get(ticker) or []) if isinstance(x, dict) and x.get("enabled") is not False]
            if not rows:
                rows = [{"strategy_id": default_id, "parameters": {}}]
            for row in rows:
                explicit.append({"ticker": ticker, **row})
    if not isinstance(explicit, list):
        return jsonify({"error": "assignments должен быть списком"}), 400
    translated = []
    for row in explicit:
        if not isinstance(row, dict):
            return jsonify({"error": "Некорректное назначение стратегии"}), 400
        strategy_id = str(row.get("strategy_id") or "")
        resolution = _strategy_resolution(strategy_id)
        if not resolution:
            return jsonify({"error": f"Стратегия «{strategy_id}» недоступна"}), 403
        runner_id, _private = resolution
        translated.append({**row, "strategy_id": runner_id})
    # Flask caches parsed JSON on the request object. Mutating this dict makes
    # app.py's original view receive the trusted translated assignments.
    payload["assignments"] = translated
    import app as app_module
    return app_module.portfolio_backtest(portfolio_id)


# -------------------------------------------------------------- user flow --

@commerce_bp.get("/account/strategies")
@auth.login_required
def account_strategies_page():
    return render_template("account.html", initial_tab="strategies")


@commerce_bp.post("/api/custom-strategy-orders")
@auth.login_required
@csrf_protect
def create_custom_strategy_order():
    payload, error = _order_payload(request.get_json(silent=True) or {})
    if error:
        return jsonify({"error": error}), 400
    order = cdb.create_order(auth.current_user_id(), payload)
    return jsonify(_safe_order(order)), 201


@commerce_bp.get("/account/api/strategy-orders")
@auth.login_required
def account_strategy_orders():
    return jsonify({"orders": [_safe_order(x) for x in cdb.list_orders_for_user(auth.current_user_id())]})


@commerce_bp.get("/account/api/strategy-orders/<order_id>")
@auth.login_required
def account_strategy_order(order_id):
    order = cdb.get_order_for_user(order_id, auth.current_user_id())
    if not order:
        return jsonify({"error": "Заявка не найдена"}), 404
    return jsonify(_safe_order(order))


@commerce_bp.get("/account/api/private-strategies")
@auth.login_required
def account_private_strategies():
    rows = cdb.list_private_strategies_for_user(auth.current_user_id())
    return jsonify({"strategies": rows})


@commerce_bp.get("/account/api/commerce-context")
def commerce_context():
    user = auth.current_user()
    return jsonify({
        "authenticated": bool(user),
        "is_admin": bool(user and user.get("is_admin")),
        "email": user.get("email") if user else None,
    })


@commerce_bp.post("/api/billing/custom-strategy/create-payment")
@auth.login_required
@csrf_protect
def custom_strategy_payment():
    payload = request.get_json(silent=True) or {}
    order_id = str(payload.get("order_id") or "")
    if not order_id:
        return jsonify({"error": "order_id обязателен"}), 400
    # No amount field is accepted: billing_service reads quoted_price from DB.
    try:
        return jsonify(create_custom_strategy_checkout(auth.current_user_id(), order_id))
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except (ValueError, BillingProviderError) as exc:
        return jsonify({"error": str(exc)}), 400


@commerce_bp.post("/api/billing/support/create-payment")
@auth.login_required
@csrf_protect
def support_payment():
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(create_support_checkout(auth.current_user_id(), payload.get("amount")))
    except (ValueError, BillingProviderError) as exc:
        return jsonify({"error": str(exc)}), 400


@commerce_bp.post("/api/billing/yookassa/webhook")
def yookassa_webhook():
    try:
        result = handle_yookassa_webhook(request.get_json(silent=True) or {})
        return jsonify({k: v for k, v in result.items() if k != "payment"}), 200
    except (ValueError, BillingProviderError):
        # Invalid/forged provider state is not acknowledged as a successful
        # local transition. No strategy/order data is logged here.
        return jsonify({"error": "payment verification failed"}), 400


@commerce_bp.post("/api/billing/yookassa/sync")
@auth.login_required
@csrf_protect
def sync_pending_payments():
    return jsonify(sync_pending_for_user(auth.current_user_id()))


@commerce_bp.get("/account/api/payments/<payment_id>/status")
@auth.login_required
def account_payment_status(payment_id):
    payment = cdb.get_payment_for_user(payment_id, auth.current_user_id())
    if not payment:
        return jsonify({"error": "Платёж не найден"}), 404
    return jsonify({
        "id": payment["id"], "type": payment["type"], "status": payment["status"],
        "amount": payment["amount"], "currency": payment["currency"], "order_id": payment.get("order_id"),
    })


@commerce_bp.get("/account/payments/result")
@auth.login_required
def payment_result_page():
    return render_template("payment_result.html", payment_id=request.args.get("payment_id"), payment_type=request.args.get("type"))


# --------------------------------------------------------------- admin UI --

def _admin_page(section: str, entity_id: str | None = None):
    return render_template("admin.html", initial_section=section, initial_entity_id=entity_id)


@commerce_bp.get("/admin")
@auth.admin_required
def admin_home():
    return _admin_page("overview")


@commerce_bp.get("/admin/strategy-orders")
@auth.admin_required
def admin_orders_page():
    return _admin_page("orders")


@commerce_bp.get("/admin/strategy-orders/<order_id>")
@auth.admin_required
def admin_order_page(order_id):
    return _admin_page("orders", order_id)


@commerce_bp.get("/admin/payments")
@auth.admin_required
def admin_payments_page():
    return _admin_page("payments")


@commerce_bp.get("/admin/users")
@auth.admin_required
def admin_users_page():
    return _admin_page("users")


# -------------------------------------------------------------- admin API --

@commerce_bp.get("/api/admin/dashboard")
@auth.admin_required
def admin_dashboard():
    stats = cdb.dashboard_stats()
    stats["users"] = len(auth_db.list_users())
    return jsonify(stats)


def _date_ts(raw: str | None, end: bool = False) -> float | None:
    if not raw:
        return None
    try:
        dt = datetime.strptime(raw, "%Y-%m-%d")
        return dt.timestamp() + (86399 if end else 0)
    except ValueError:
        return None


@commerce_bp.get("/api/admin/strategy-orders")
@auth.admin_required
def admin_orders():
    status = request.args.get("status") or None
    payment_status = request.args.get("payment_status") or None
    if status and status not in cdb.ORDER_STATUSES:
        return jsonify({"error": "Некорректный статус"}), 400
    if payment_status and payment_status not in cdb.PAYMENT_STATUSES:
        return jsonify({"error": "Некорректный статус оплаты"}), 400
    rows = cdb.list_orders_admin(
        status=status, payment_status=payment_status, query=request.args.get("q") or None,
        date_from=_date_ts(request.args.get("date_from")), date_to=_date_ts(request.args.get("date_to"), True),
    )
    # Add user display/email only in the protected admin response.
    for row in rows:
        user = auth_db.get_by_id(row["user_id"])
        row["user"] = {"id": row["user_id"], "display_name": user.get("display_name") if user else "—", "email": user.get("email") if user else "—"}
        row["status_label"] = ORDER_STATUS_LABELS.get(row["status"], row["status"])
    return jsonify({"orders": rows})


@commerce_bp.get("/api/admin/strategy-orders/<order_id>")
@auth.admin_required
def admin_order_detail(order_id):
    order = cdb.get_order(order_id, include_private=True)
    if not order:
        return jsonify({"error": "Заявка не найдена"}), 404
    user = auth_db.get_by_id(order["user_id"])
    order["user"] = {"id": order["user_id"], "display_name": user.get("display_name") if user else "—", "email": user.get("email") if user else "—"}
    order["status_label"] = ORDER_STATUS_LABELS.get(order["status"], order["status"])
    return jsonify(order)


@commerce_bp.post("/api/admin/strategy-orders/<order_id>/quote")
@auth.admin_required
@csrf_protect
def admin_save_quote(order_id):
    order = cdb.get_order(order_id, include_private=True)
    if not order:
        return jsonify({"error": "Заявка не найдена"}), 404
    if order.get("paid_at") or order["status"] in ("PAID", "IN_PROGRESS", "READY", "COMPLETED"):
        return jsonify({"error": "Стоимость оплаченной заявки менять нельзя"}), 409
    try:
        price = int((request.get_json(silent=True) or {}).get("quoted_price"))
    except (TypeError, ValueError):
        return jsonify({"error": "Укажите стоимость в рублях"}), 400
    if price < 100 or price > 5_000_000:
        return jsonify({"error": "Стоимость должна быть от 100 до 5 000 000 ₽"}), 400
    before = dict(order)
    after = cdb.update_order_admin(order["id"], quoted_price=price, quoted_at=time.time())
    cdb.audit(auth.current_user_id(), "SET_QUOTE", "CustomStrategyOrder", order["id"], before, after)
    return jsonify(after)


@commerce_bp.post("/api/admin/strategy-orders/<order_id>/send-offer")
@auth.admin_required
@csrf_protect
def admin_send_offer(order_id):
    order = cdb.get_order(order_id, include_private=True)
    if not order:
        return jsonify({"error": "Заявка не найдена"}), 404
    if not order.get("quoted_price"):
        return jsonify({"error": "Сначала сохраните стоимость"}), 400
    if order.get("paid_at"):
        return jsonify({"error": "Заявка уже оплачена"}), 409
    if order["status"] not in ("NEW", "REVIEWING", "NEEDS_INFO", "WAITING_PAYMENT"):
        return jsonify({"error": "Предложение нельзя отправить в текущем статусе"}), 409
    before = dict(order)
    after = cdb.update_order_admin(order["id"], status="WAITING_PAYMENT", quoted_at=order.get("quoted_at") or time.time())
    cdb.audit(auth.current_user_id(), "SEND_OFFER", "CustomStrategyOrder", order["id"], before, after)
    return jsonify(after)


@commerce_bp.post("/api/admin/strategy-orders/<order_id>/status")
@auth.admin_required
@csrf_protect
def admin_change_status(order_id):
    order = cdb.get_order(order_id, include_private=True)
    if not order:
        return jsonify({"error": "Заявка не найдена"}), 404
    new_status = str((request.get_json(silent=True) or {}).get("status") or "")
    if new_status not in cdb.ORDER_STATUSES:
        return jsonify({"error": "Некорректный статус"}), 400
    if new_status == order["status"]:
        return jsonify(order)
    if new_status not in ALLOWED_TRANSITIONS.get(order["status"], set()):
        return jsonify({"error": f"Переход {order['status']} → {new_status} запрещён"}), 409
    fields = {"status": new_status}
    now = time.time()
    if new_status == "IN_PROGRESS": fields["started_at"] = now
    if new_status == "COMPLETED": fields["completed_at"] = now
    if new_status == "CANCELLED": fields["cancelled_at"] = now
    before = dict(order)
    after = cdb.update_order_admin(order["id"], **fields)
    cdb.audit(auth.current_user_id(), "CHANGE_STATUS", "CustomStrategyOrder", order["id"], before, after)
    return jsonify(after)


@commerce_bp.post("/api/admin/strategy-orders/<order_id>/notes")
@auth.admin_required
@csrf_protect
def admin_notes(order_id):
    order = cdb.get_order(order_id, include_private=True)
    if not order:
        return jsonify({"error": "Заявка не найдена"}), 404
    notes = str((request.get_json(silent=True) or {}).get("admin_notes") or "").strip()[:12000]
    before = {"admin_notes": order.get("admin_notes")}
    after = cdb.update_order_admin(order["id"], admin_notes=notes or None)
    cdb.audit(auth.current_user_id(), "UPDATE_NOTES", "CustomStrategyOrder", order["id"], before, {"admin_notes": after.get("admin_notes")})
    return jsonify(after)


@commerce_bp.get("/api/admin/strategy-runners")
@auth.admin_required
def admin_strategy_runners():
    rows = []
    for sid in sorted(_runner_ids()):
        rows.append({"id": sid, "name": (STRATEGY_CATALOG.get(sid) or {}).get("name") or sid})
    return jsonify({"runners": rows})


@commerce_bp.post("/api/admin/strategy-orders/<order_id>/link-strategy")
@auth.admin_required
@csrf_protect
def admin_link_strategy(order_id):
    order = cdb.get_order(order_id, include_private=True)
    if not order:
        return jsonify({"error": "Заявка не найдена"}), 404
    if order["status"] not in ("PAID", "IN_PROGRESS", "READY"):
        return jsonify({"error": "Стратегию можно привязать после оплаты"}), 409
    payload = request.get_json(silent=True) or {}
    runner_id = str(payload.get("runner_strategy_id") or "")
    if runner_id not in _runner_ids():
        return jsonify({"error": "Реализация стратегии не зарегистрирована в движке"}), 400
    name = str(payload.get("name") or order.get("title") or f"Стратегия {order['public_id']}").strip()[:160]
    before = dict(order)
    strategy = cdb.create_or_update_private_strategy(
        order_id=order["id"], owner_user_id=order["user_id"], name=name, runner_strategy_id=runner_id,
    )
    after = cdb.get_order(order["id"], include_private=True)
    cdb.audit(auth.current_user_id(), "LINK_STRATEGY", "CustomStrategyOrder", order["id"], before, after)
    return jsonify({"order": after, "strategy": strategy})


@commerce_bp.get("/api/admin/payments")
@auth.admin_required
def admin_payments():
    payment_type = request.args.get("type") or None
    status = request.args.get("status") or None
    if payment_type and payment_type not in cdb.PAYMENT_TYPES:
        return jsonify({"error": "Некорректный тип платежа"}), 400
    if status and status not in cdb.PAYMENT_STATUSES:
        return jsonify({"error": "Некорректный статус"}), 400
    rows = cdb.list_payments_admin(payment_type=payment_type, status=status)
    for row in rows:
        user = auth_db.get_by_id(row["user_id"]) if row.get("user_id") else None
        row["user"] = {"display_name": user.get("display_name"), "email": user.get("email")} if user else None
        if row.get("order_id"):
            order = cdb.get_order(row["order_id"], include_private=True)
            row["order_public_id"] = order.get("public_id") if order else None
    return jsonify({"payments": rows})


@commerce_bp.get("/api/admin/users")
@auth.admin_required
def admin_users():
    portfolios = _PORTFOLIOS.list() if _PORTFOLIOS else []
    result = []
    for user in auth_db.list_users():
        backtests_total = bdb.list_runs(user_id=user["id"], owner_scope="mine", page=1, page_size=1)[1]
        summary = cdb.user_commerce_summary(user["id"])
        result.append({
            "id": user["id"], "display_name": user["display_name"], "email": user["email"],
            "registered_at": user.get("created_at"), "is_active": bool(user.get("is_active")), "is_admin": bool(user.get("is_admin")),
            "portfolios": sum(1 for p in portfolios if p.get("user_id") == user["id"]),
            "backtests": backtests_total, **summary,
        })
    return jsonify({"users": result})
