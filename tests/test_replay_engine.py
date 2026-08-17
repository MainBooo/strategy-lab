from __future__ import annotations

import pytest

import market_data_store as store
import replay_db as db
import replay_engine as engine

SYMBOL, TF = "BTCUSDT", "1m"
BASE_TS = engine.date_to_ts("2025-06-02", 10, 0)  # a Monday, 10:00


def _seed(bars: list[dict]):
    """bars: list of {open,high,low,close,volume} - ts auto-assigned one
    minute apart starting at BASE_TS."""
    rows = [{"ts": BASE_TS + i * 60, **b} for i, b in enumerate(bars)]
    store.upsert_candles(SYMBOL, TF, rows)


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path):
    store.init_db(tmp_path / "candles.db")
    db.init_db(tmp_path / "replay.db")
    yield tmp_path


def _new_session(**overrides):
    params = dict(symbol=SYMBOL, timeframe=TF, start_date="2025-06-02", start_hour=10,
                  start_minute=0, starting_balance=100_000, commission_rate=0.0, slippage_bps=0,
                  speed=1, lot_size=1)
    params.update(overrides)
    return engine.create_session(**params)


def test_no_lookahead_before_any_step():
    _seed([{"open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 10} for _ in range(5)])
    state = _new_session()
    assert state["revealed"] == []
    assert state["current_price"] is None
    assert all(c["time"] < BASE_TS for c in state["history"])


def test_step_reveals_bars_in_order_and_never_future():
    _seed([
        {"open": 100, "high": 101, "low": 99, "close": 100 + i, "volume": 10}
        for i in range(5)
    ])
    state = _new_session()
    sid = state["session"]["id"]
    s1 = engine.step(sid)
    assert len(s1["revealed"]) == 1
    assert s1["revealed"][0]["time"] == BASE_TS
    assert s1["current_price"] == 100
    assert all(c["time"] <= s1["current_time"] for c in s1["revealed"])
    s2 = engine.step(sid)
    assert len(s2["revealed"]) == 2
    assert s2["current_price"] == 101
    # No bar beyond what's been revealed should ever be visible.
    assert s2["current_time"] < BASE_TS + 3 * 60


def test_step_past_end_of_data_stops_cleanly():
    _seed([{"open": 100, "high": 101, "low": 99, "close": 100, "volume": 10} for _ in range(2)])
    state = _new_session()
    sid = state["session"]["id"]
    engine.step(sid, bars=10)  # more than available
    final = engine.step(sid)  # calling again once exhausted must not crash
    assert final["finished"] is True
    assert final["reveal_index"] == 2


def test_buy_then_sell_pnl_and_commission():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},   # bar 0: buy here at close=100
        {"open": 100, "high": 100, "low": 100, "close": 110, "volume": 10},   # bar 1: sell here at close=110
    ])
    state = _new_session(commission_rate=0.001, lot_size=1)
    sid = state["session"]["id"]
    engine.step(sid)  # reveal bar 0, price=100
    after_buy = engine.place_order(sid, "buy", 10)  # 10 shares @ 100
    assert after_buy["session"]["position_side"] == "long"
    assert after_buy["session"]["position_qty_shares"] == 10
    expected_commission_buy = 100 * 10 * 0.001  # 1.0
    assert after_buy["session"]["cash"] == pytest.approx(100_000 - 1000 - expected_commission_buy)

    engine.step(sid)  # reveal bar 1, price=110
    after_sell = engine.place_order(sid, "close", 10)
    gross_pnl = (110 - 100) * 10  # 100
    commission_sell = 110 * 10 * 0.001  # 1.1
    expected_realized = gross_pnl - expected_commission_buy - commission_sell
    assert after_sell["session"]["position_side"] is None
    assert after_sell["session"]["realized_pnl"] == pytest.approx(expected_realized)
    expected_cash = 100_000 - expected_commission_buy - commission_sell + gross_pnl
    assert after_sell["session"]["cash"] == pytest.approx(expected_cash)


def test_short_then_cover_pnl():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},
        {"open": 100, "high": 100, "low": 100, "close": 90, "volume": 10},  # price drops -> short profits
    ])
    state = _new_session(commission_rate=0, lot_size=1)
    sid = state["session"]["id"]
    engine.step(sid)
    engine.place_order(sid, "short", 5)  # short 5 @ 100
    engine.step(sid)
    result = engine.place_order(sid, "close", 5)  # cover @ 90
    expected_pnl = (100 - 90) * 5  # short profits when price falls
    assert result["session"]["realized_pnl"] == pytest.approx(expected_pnl)


def test_stop_loss_auto_triggers_on_bar_range():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},  # buy here
        {"open": 99, "high": 99.5, "low": 94, "close": 96, "volume": 10},    # low pierces stop=95
    ])
    state = _new_session(commission_rate=0, lot_size=1)
    sid = state["session"]["id"]
    engine.step(sid)
    engine.place_order(sid, "buy", 10, stop_loss=95)
    after = engine.step(sid)  # this bar's low=94 <= stop=95 -> auto-close at 95
    assert after["session"]["position_side"] is None
    trades = db.list_trades(sid)
    assert trades[-1]["exit_reason"] == "stop"
    assert trades[-1]["fill_price"] == 95
    assert after["session"]["realized_pnl"] == pytest.approx((95 - 100) * 10)


def test_take_profit_auto_triggers_on_bar_range():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},
        {"open": 101, "high": 108, "low": 100.5, "close": 105, "volume": 10},  # high pierces take=107
    ])
    state = _new_session(commission_rate=0, lot_size=1)
    sid = state["session"]["id"]
    engine.step(sid)
    engine.place_order(sid, "buy", 10, take_profit=107)
    after = engine.step(sid)
    trades = db.list_trades(sid)
    assert trades[-1]["exit_reason"] == "take"
    assert trades[-1]["fill_price"] == 107
    assert after["session"]["position_side"] is None


def test_step_back_restores_state_and_removes_trade():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},
        {"open": 100, "high": 100, "low": 100, "close": 105, "volume": 10},
    ])
    state = _new_session(commission_rate=0, lot_size=1)
    sid = state["session"]["id"]
    engine.step(sid)
    before_trade_cash = engine.visible_state(db.get_session(sid))["session"]["cash"]
    engine.place_order(sid, "buy", 10)
    assert db.get_session(sid)["position_side"] == "long"
    reverted = engine.step_back(sid)
    assert reverted["session"]["position_side"] is None
    assert reverted["session"]["cash"] == pytest.approx(before_trade_cash)
    assert db.list_trades(sid) == []


def test_step_back_across_bar_boundary():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},
        {"open": 100, "high": 100, "low": 100, "close": 101, "volume": 10},
        {"open": 100, "high": 100, "low": 100, "close": 102, "volume": 10},
    ])
    state = _new_session()
    sid = state["session"]["id"]
    engine.step(sid); engine.step(sid); engine.step(sid)
    assert db.get_session(sid)["reveal_index"] == 3
    back1 = engine.step_back(sid)
    assert back1["reveal_index"] == 2
    assert back1["current_price"] == 101


def test_step_back_with_nothing_to_undo_raises():
    _seed([{"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10}])
    state = _new_session()
    sid = state["session"]["id"]
    with pytest.raises(engine.ReplayError):
        engine.step_back(sid)


def test_cannot_buy_without_any_price_yet():
    _seed([{"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10}])
    state = _new_session()
    sid = state["session"]["id"]
    with pytest.raises(engine.ReplayError):
        engine.place_order(sid, "buy", 1)


def test_reset_restores_starting_balance_and_clears_trades():
    _seed([{"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10} for _ in range(3)])
    state = _new_session(starting_balance=50_000)
    sid = state["session"]["id"]
    engine.step(sid)
    engine.place_order(sid, "buy", 1)
    engine.reset(sid)
    session = db.get_session(sid)
    assert session["reveal_index"] == 0
    assert session["cash"] == 50_000
    assert session["position_side"] is None
    assert db.list_trades(sid) == []


def test_goto_jumps_and_honours_stop_crossed_mid_jump():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},   # 10:00
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},   # 10:01 buy here after step
        {"open": 99, "high": 99, "low": 90, "close": 95, "volume": 10},       # 10:02 stop should trigger
        {"open": 95, "high": 96, "low": 94, "close": 95, "volume": 10},       # 10:03
    ])
    state = _new_session(commission_rate=0)
    sid = state["session"]["id"]
    engine.step(sid)  # reveal bar0
    engine.place_order(sid, "buy", 10, stop_loss=95)
    result = engine.goto(sid, "2025-06-02", 10, 3)  # jump to bar index 3 (10:03)
    assert result["reveal_index"] == 4
    assert result["session"]["position_side"] is None  # stop must have fired during the jump
    trades = db.list_trades(sid)
    assert any(t["exit_reason"] == "stop" for t in trades)


def test_session_state_persists_across_reload():
    """Simulates a page reload: fetching by id later must see exactly what
    was last saved, since replay state lives in SQLite, not process memory."""
    _seed([{"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10} for _ in range(3)])
    state = _new_session()
    sid = state["session"]["id"]
    engine.step(sid)
    engine.place_order(sid, "buy", 5)
    reloaded = engine.visible_state(db.get_session(sid))
    assert reloaded["session"]["position_qty_shares"] == 5
    assert reloaded["reveal_index"] == 1


def test_insufficient_funds_rejected():
    _seed([{"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10}])
    state = _new_session(starting_balance=500, commission_rate=0)
    sid = state["session"]["id"]
    engine.step(sid)
    with pytest.raises(engine.ReplayError):
        engine.place_order(sid, "buy", 100)  # 100 shares * 100 = 10000 > 500 balance


def test_partial_sell_leaves_remainder_open_with_prorated_entry_commission():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},  # buy 10 here
        {"open": 100, "high": 100, "low": 100, "close": 110, "volume": 10},  # sell 4 here
    ])
    state = _new_session(commission_rate=0.001, lot_size=1)
    sid = state["session"]["id"]
    engine.step(sid)
    after_buy = engine.place_order(sid, "buy", 10)
    entry_commission = after_buy["session"]["position_entry_commission"]
    assert entry_commission == pytest.approx(100 * 10 * 0.001)

    engine.step(sid)
    after_sell = engine.place_order(sid, "sell", 4)  # partial: close 4 of 10 shares
    session = after_sell["session"]
    assert session["position_side"] == "long"  # position stays open
    assert session["position_qty_shares"] == 6
    assert session["position_avg_price"] == pytest.approx(100)  # avg entry price unchanged on a reduce

    commission_exit = 110 * 4 * 0.001
    entry_commission_allocated = entry_commission * (4 / 10)
    expected_realized = (110 - 100) * 4 - commission_exit - entry_commission_allocated
    assert session["realized_pnl"] == pytest.approx(expected_realized)
    assert session["position_entry_commission"] == pytest.approx(entry_commission - entry_commission_allocated)

    trades = db.list_trades(sid)
    assert trades[-1]["action"] == "reduce"
    assert trades[-1]["qty_shares"] == 4

    # Closing the remainder must not raise and must fully flatten the position.
    engine.step(sid)
    final = engine.place_order(sid, "close", 6)
    assert final["session"]["position_side"] is None
    assert final["session"]["position_qty_shares"] == 0


def test_add_to_existing_long_position_computes_weighted_average_price():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},  # buy 10 @ 100
        {"open": 100, "high": 100, "low": 100, "close": 120, "volume": 10},  # buy 10 more @ 120
    ])
    state = _new_session(commission_rate=0, lot_size=1)
    sid = state["session"]["id"]
    engine.step(sid)
    engine.place_order(sid, "buy", 10)
    engine.step(sid)
    after = engine.place_order(sid, "buy", 10)
    session = after["session"]
    assert session["position_qty_shares"] == 20
    assert session["position_qty_lots"] == 20
    assert session["position_avg_price"] == pytest.approx((100 * 10 + 120 * 10) / 20)  # 110

    trades = db.list_trades(sid)
    assert trades[-1]["action"] == "add"


def test_add_to_existing_short_position_computes_weighted_average_price():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},  # short 10 @ 100
        {"open": 100, "high": 100, "low": 100, "close": 80, "volume": 10},   # short 10 more @ 80
    ])
    state = _new_session(commission_rate=0, lot_size=1)
    sid = state["session"]["id"]
    engine.step(sid)
    engine.place_order(sid, "short", 10)
    engine.step(sid)
    after = engine.place_order(sid, "short", 10)
    session = after["session"]
    assert session["position_side"] == "short"
    assert session["position_qty_shares"] == 20
    assert session["position_avg_price"] == pytest.approx((100 * 10 + 80 * 10) / 20)  # 90


def test_slippage_widens_fill_against_the_trader_on_both_sides():
    _seed([
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},
        {"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10},
    ])
    state = _new_session(commission_rate=0, slippage_bps=100, lot_size=1)  # 100 bps = 1%
    sid = state["session"]["id"]
    engine.step(sid)
    after_buy = engine.place_order(sid, "buy", 1)  # buy fills worse: price * 1.01
    trades = db.list_trades(sid)
    assert trades[-1]["fill_price"] == pytest.approx(101)
    assert after_buy["session"]["position_avg_price"] == pytest.approx(101)

    after_close = engine.place_order(sid, "close", 1)  # sell-to-close fills worse: price * 0.99
    trades = db.list_trades(sid)
    assert trades[-1]["fill_price"] == pytest.approx(99)
    # Round trip at the same bar price still loses money purely to slippage.
    assert after_close["session"]["realized_pnl"] == pytest.approx((99 - 101) * 1)


def test_cannot_short_while_long_or_buy_while_short():
    _seed([{"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10} for _ in range(2)])
    state = _new_session()
    sid = state["session"]["id"]
    engine.step(sid)
    engine.place_order(sid, "buy", 1)
    with pytest.raises(engine.ReplayError):
        engine.place_order(sid, "short", 1)


def test_sell_without_long_position_rejected():
    _seed([{"open": 100, "high": 100, "low": 100, "close": 100, "volume": 10}])
    state = _new_session()
    sid = state["session"]["id"]
    engine.step(sid)
    with pytest.raises(engine.ReplayError):
        engine.place_order(sid, "sell", 1)
