from __future__ import annotations

"""Market Replay engine: bar-by-bar historical playback with manual trading.

Anti-look-ahead guarantee: every read path here (visible_state) only ever
queries candles up to the session's revealed watermark - store.get_candles
with `before=start_ts` for pre-start context, and get_candles_ascending
bounded by `limit=reveal_index` for anything at/after start. There is no
code path that hands the frontend a candle, indicator input, or price the
replay clock hasn't reached yet, so indicators/autoscale/labels computed
client-side from this data are automatically look-ahead-safe too - they
never see data to be safe from in the first place.

State (cash, position, realized P&L) lives entirely in replay_db.py rows,
not in a Python object here, so any gunicorn worker process can serve any
request for a session (same reasoning as jobs.py/PortfolioStore/backtests_db).
"""

import calendar

import market_data_store as store
import replay_db as db
from timeframes import NATIVE_TIMEFRAMES

DEFAULT_HISTORY_CONTEXT = 300


class ReplayError(Exception):
    pass


def _snapshot(session: dict) -> dict:
    return {
        "reveal_index": session["reveal_index"],
        "cash": session["cash"],
        "position_side": session["position_side"],
        "position_qty_lots": session["position_qty_lots"],
        "position_qty_shares": session["position_qty_shares"],
        "position_avg_price": session["position_avg_price"],
        "position_stop_loss": session["position_stop_loss"],
        "position_take_profit": session["position_take_profit"],
        "position_entry_commission": session["position_entry_commission"],
        "realized_pnl": session["realized_pnl"],
        "trade_watermark": db.max_trade_id(session["id"]),
    }


def _push_undo(session: dict) -> None:
    db.push_undo(session["id"], _snapshot(session))


def date_to_ts(date_str: str, hour: int = 0, minute: int = 0) -> int:
    y, m, d = (int(x) for x in date_str.split("-"))
    return calendar.timegm((y, m, d, int(hour), int(minute), 0, 0, 0, 0))


def create_session(*, symbol: str, timeframe: str, start_date: str, start_hour: int,
                    start_minute: int, starting_balance: float, commission_rate: float, slippage_bps: float,
                    speed: float, lot_size: float) -> dict:
    if timeframe not in NATIVE_TIMEFRAMES:
        raise ReplayError(f"Для Market Replay нужен базовый таймфрейм из: {', '.join(NATIVE_TIMEFRAMES)}")
    start_ts = date_to_ts(start_date, start_hour, start_minute)
    session = db.create_session(symbol=symbol.upper(), timeframe=timeframe, lot_size=lot_size,
                                 start_ts=start_ts, starting_balance=starting_balance,
                                 commission_rate=commission_rate, slippage_bps=slippage_bps, speed=speed)
    return visible_state(session)


def visible_state(session: dict, *, context_bars: int = DEFAULT_HISTORY_CONTEXT) -> dict:
    history = store.get_candles(session["symbol"], session["timeframe"],
                                 before=session["start_ts"], limit=context_bars)
    revealed = store.get_candles_ascending(session["symbol"], session["timeframe"],
                                            ts_from=session["start_ts"], limit=session["reveal_index"]) \
        if session["reveal_index"] > 0 else []
    total_available = store.count_candles_from(session["symbol"], session["timeframe"],
                                                 ts_from=session["start_ts"])
    current_bar = revealed[-1] if revealed else None
    equity = _equity(session, current_bar["close"] if current_bar else None)
    return {
        "session": public_session(session),
        "history": history,
        "revealed": revealed,
        "current_time": current_bar["time"] if current_bar else session["start_ts"],
        "current_price": current_bar["close"] if current_bar else None,
        "reveal_index": session["reveal_index"],
        "total_available": total_available,
        "percent": round(100 * session["reveal_index"] / total_available, 2) if total_available else 0,
        "finished": total_available > 0 and session["reveal_index"] >= total_available,
        "can_step_back": bool(session["undo_stack_json"] and session["undo_stack_json"] != "[]"),
        "equity": equity,
        "unrealized_pnl": equity["unrealized_pnl"],
    }


def _equity(session: dict, mark_price: float | None) -> dict:
    """total = cash + cost_basis_reserved_at_entry + unrealized_pnl. The
    entry cost basis was already deducted from cash when the position was
    opened (see _open_or_add), so adding it back plus the mark-to-market
    delta reconstructs current net worth without double-counting."""
    unrealized = 0.0
    cost_basis = 0.0
    position_value = 0.0
    if mark_price is not None and session["position_side"] and session["position_qty_shares"]:
        sign = 1 if session["position_side"] == "long" else -1
        unrealized = (mark_price - session["position_avg_price"]) * session["position_qty_shares"] * sign
        cost_basis = session["position_avg_price"] * session["position_qty_shares"]
        position_value = mark_price * session["position_qty_shares"]
    return {
        "cash": session["cash"],
        "position_value": position_value,
        "unrealized_pnl": unrealized,
        "total": session["cash"] + cost_basis + unrealized,
        "realized_pnl": session["realized_pnl"],
    }


def public_session(session: dict) -> dict:
    """Session row minus the internal undo-stack JSON blob."""
    return {k: v for k, v in session.items() if k != "undo_stack_json"}


def _require_session(session_id: str) -> dict:
    session = db.get_session(session_id)
    if session is None:
        raise ReplayError("Сессия не найдена")
    return session


def step(session_id: str, bars: int = 1) -> dict:
    session = _require_session(session_id)
    for _ in range(max(1, min(bars, 500))):
        session = db.get_session(session_id)
        total = store.count_candles_from(session["symbol"], session["timeframe"],
                                           ts_from=session["start_ts"])
        if session["reveal_index"] >= total:
            break
        _push_undo(session)
        new_index = session["reveal_index"] + 1
        new_bar = store.get_candles_ascending(session["symbol"], session["timeframe"],
                                               ts_from=session["start_ts"], limit=new_index)[-1]
        session = db.update_session(session_id, reveal_index=new_index)
        _check_stop_take(session, new_bar)
    return visible_state(db.get_session(session_id))


def step_back(session_id: str) -> dict:
    session = _require_session(session_id)
    snapshot = db.pop_undo(session_id)
    if snapshot is None:
        raise ReplayError("Некуда возвращаться")
    watermark = snapshot.pop("trade_watermark", None)
    if watermark is not None:
        db.delete_trades_after(session_id, watermark)
    db.update_session(session_id, **snapshot)
    return visible_state(db.get_session(session_id))


def goto(session_id: str, target_date: str, target_hour: int = 0, target_minute: int = 0) -> dict:
    session = _require_session(session_id)
    target_ts = date_to_ts(target_date, target_hour, target_minute)
    if target_ts < session["start_ts"]:
        raise ReplayError("Дата раньше начала сессии")
    total = store.count_candles_from(session["symbol"], session["timeframe"],
                                      ts_from=session["start_ts"])
    all_bars = store.get_candles_ascending(session["symbol"], session["timeframe"],
                                            ts_from=session["start_ts"], limit=total) if total else []
    count = 0
    for c in all_bars:
        if c["time"] > target_ts:
            break
        count += 1
    _push_undo(session)
    db.update_session(session_id, reveal_index=count)
    session = db.get_session(session_id)
    # Re-evaluate stop/take across every bar we just jumped over, in order,
    # so a level crossed mid-jump is still honoured instead of silently skipped.
    if count > 0:
        crossed = store.get_candles_ascending(session["symbol"], session["timeframe"],
                                               ts_from=session["start_ts"], limit=count)
        for c in crossed:
            session = db.get_session(session_id)
            if not session["position_side"]:
                break
            _check_stop_take(session, c)
    return visible_state(db.get_session(session_id))


def reset(session_id: str) -> dict:
    session = _require_session(session_id)
    db.delete_trades_after(session_id, 0)
    db.update_session(session_id, reveal_index=0, cash=session["starting_balance"], position_side=None,
                       position_qty_lots=0, position_qty_shares=0, position_avg_price=None,
                       position_stop_loss=None, position_take_profit=None, position_entry_commission=0,
                       realized_pnl=0, undo_stack_json="[]")
    return visible_state(db.get_session(session_id))


def _apply_slippage(price: float, direction: int, slippage_bps: float) -> float:
    return price * (1 + direction * slippage_bps / 10000.0)


def _check_stop_take(session: dict, bar: dict) -> None:
    if not session["position_side"] or session["position_qty_shares"] <= 0:
        return
    side = session["position_side"]
    sl, tp = session["position_stop_loss"], session["position_take_profit"]
    hit_price, reason = None, None
    if side == "long":
        if sl is not None and bar["low"] <= sl:
            hit_price, reason = sl, "stop"
        elif tp is not None and bar["high"] >= tp:
            hit_price, reason = tp, "take"
    else:
        if sl is not None and bar["high"] >= sl:
            hit_price, reason = sl, "stop"
        elif tp is not None and bar["low"] <= tp:
            hit_price, reason = tp, "take"
    if hit_price is not None:
        _reduce(session, lots=session["position_qty_lots"], fill_price=hit_price, bar_ts=bar["time"],
                exit_reason=reason)


def place_order(session_id: str, action: str, lots: int, stop_loss: float | None = None,
                 take_profit: float | None = None) -> dict:
    if lots <= 0:
        raise ReplayError("Количество лотов должно быть больше нуля")
    session = _require_session(session_id)
    state = visible_state(session)
    price = state["current_price"]
    if price is None:
        raise ReplayError("Нет текущей цены - сделайте хотя бы один шаг воспроизведения")
    _push_undo(session)
    bar_ts = state["current_time"]
    if action == "buy":
        if session["position_side"] == "short":
            raise ReplayError("Сначала закройте короткую позицию (Close)")
        fill = _apply_slippage(price, +1, session["slippage_bps"])
        _open_or_add(session, side="long", lots=lots, fill_price=fill, bar_ts=bar_ts,
                     stop_loss=stop_loss, take_profit=take_profit)
    elif action == "short":
        if session["position_side"] == "long":
            raise ReplayError("Сначала закройте длинную позицию (Close)")
        fill = _apply_slippage(price, -1, session["slippage_bps"])
        _open_or_add(session, side="short", lots=lots, fill_price=fill, bar_ts=bar_ts,
                     stop_loss=stop_loss, take_profit=take_profit)
    elif action == "sell":
        if session["position_side"] != "long":
            raise ReplayError("Нет длинной позиции для продажи")
        fill = _apply_slippage(price, -1, session["slippage_bps"])
        _reduce(session, lots=lots, fill_price=fill, bar_ts=bar_ts, exit_reason="manual")
    elif action == "close":
        if not session["position_side"]:
            raise ReplayError("Нет открытой позиции")
        direction = -1 if session["position_side"] == "long" else +1
        fill = _apply_slippage(price, direction, session["slippage_bps"])
        _reduce(session, lots=session["position_qty_lots"], fill_price=fill, bar_ts=bar_ts, exit_reason="manual")
    else:
        raise ReplayError(f"Неизвестное действие: {action}")
    return visible_state(db.get_session(session_id))


def _open_or_add(session: dict, *, side: str, lots: int, fill_price: float, bar_ts: int,
                  stop_loss: float | None, take_profit: float | None) -> None:
    lot_size = session["lot_size"]
    shares = lots * lot_size
    commission = fill_price * shares * session["commission_rate"]
    existing_shares = session["position_qty_shares"]
    if session["position_side"] == side and existing_shares > 0:
        total_shares = existing_shares + shares
        new_avg = (session["position_avg_price"] * existing_shares + fill_price * shares) / total_shares
        new_lots = session["position_qty_lots"] + lots
        action = "add"
    else:
        total_shares, new_avg, new_lots, action = shares, fill_price, lots, "open"
    notional = fill_price * shares
    new_cash = session["cash"] - notional - commission
    if new_cash < 0:
        raise ReplayError("Недостаточно средств для этой сделки")
    total_entry_commission = (session["position_entry_commission"] or 0) + commission
    db.update_session(session["id"], cash=new_cash, position_side=side, position_qty_lots=new_lots,
                       position_qty_shares=total_shares, position_avg_price=new_avg,
                       position_stop_loss=stop_loss if stop_loss is not None else session["position_stop_loss"],
                       position_take_profit=take_profit if take_profit is not None else session["position_take_profit"],
                       position_entry_commission=total_entry_commission)
    db.add_trade(session["id"], side=side, action=action, qty_lots=lots, qty_shares=shares,
                 fill_price=fill_price, commission=commission, bar_ts=bar_ts,
                 stop_loss=stop_loss, take_profit=take_profit)


def _reduce(session: dict, *, lots: int, fill_price: float, bar_ts: int, exit_reason: str) -> None:
    lot_size = session["lot_size"]
    shares_to_close = min(lots * lot_size, session["position_qty_shares"])
    lots_closed = shares_to_close // lot_size
    side = session["position_side"]
    avg = session["position_avg_price"]
    sign = 1 if side == "long" else -1
    gross_pnl = (fill_price - avg) * shares_to_close * sign
    commission_exit = fill_price * shares_to_close * session["commission_rate"]
    # The entry commission was already deducted from cash when the position
    # was opened/added to (see _open_or_add) - it must not be deducted from
    # cash again here. It IS allocated (proportionally, by shares) into this
    # trade's realized_pnl though, so the P&L shown to the user reflects the
    # true round-trip cost, not just the exit leg's commission.
    existing_shares = session["position_qty_shares"]
    entry_commission_total = session["position_entry_commission"] or 0
    entry_commission_allocated = entry_commission_total * (shares_to_close / existing_shares) if existing_shares else 0
    returned_cash = avg * shares_to_close + (fill_price - avg) * shares_to_close * sign
    new_cash = session["cash"] + returned_cash - commission_exit
    remaining_shares = session["position_qty_shares"] - shares_to_close
    remaining_lots = session["position_qty_lots"] - lots_closed
    remaining_entry_commission = entry_commission_total - entry_commission_allocated
    net_trade_pnl = gross_pnl - commission_exit - entry_commission_allocated
    new_realized = session["realized_pnl"] + net_trade_pnl
    if remaining_shares <= 0:
        db.update_session(session["id"], cash=new_cash, position_side=None, position_qty_lots=0,
                           position_qty_shares=0, position_avg_price=None, position_stop_loss=None,
                           position_take_profit=None, position_entry_commission=0, realized_pnl=new_realized)
    else:
        db.update_session(session["id"], cash=new_cash, position_qty_lots=remaining_lots,
                           position_qty_shares=remaining_shares,
                           position_entry_commission=remaining_entry_commission, realized_pnl=new_realized)
    db.add_trade(session["id"], side=side, action=("close" if remaining_shares <= 0 else "reduce"),
                 qty_lots=lots_closed, qty_shares=shares_to_close, fill_price=fill_price, commission=commission_exit,
                 realized_pnl=net_trade_pnl, bar_ts=bar_ts,
                 stop_loss=session["position_stop_loss"], take_profit=session["position_take_profit"],
                 exit_reason=exit_reason)
