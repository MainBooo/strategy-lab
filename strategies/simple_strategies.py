from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from strategies.common import (
    COMMISSION_SIDE, TradeSlotGate, add_atr, htf_trend_signal, load_candles, resample_candles, save_run,
    filter_signals_by_direction, passes_volume_filter, simulate_exit,
)
from strategies.param_schema import parse_params


def _rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _execute(df: pd.DataFrame, signals: list[dict], rr: float, stop_atr: float, *,
             direction: str = "both", volume_filter: bool = False, volume_multiplier: float = 1.5,
             trailing_stop_atr: float = 0, breakeven_at_r: float = 0, max_holding_bars: int = 0,
             max_concurrent_trades: int = 1, reentry_cooldown_bars: int = 0) -> pd.DataFrame:
    signals = filter_signals_by_direction(signals, direction)
    if volume_filter:
        signals = [s for s in signals if passes_volume_filter(df, max(0, s["entry_i"] - 1), volume_multiplier)]
    trades = []
    gate = TradeSlotGate(max_concurrent_trades, reentry_cooldown_bars)
    for signal in sorted(signals, key=lambda x: x["entry_i"]):
        i = signal["entry_i"]
        if i >= len(df) or not gate.admit(i):
            continue
        side = signal["side"]
        entry = float(df.at[i, "open"])
        # ATR at bar i needs bar i's own high/low, which aren't known yet at
        # bar i's open (this is the entry bar) - sizing the default
        # stop/take off it is look-ahead bias. The last fully closed bar
        # (i-1) is what would actually be available when this order is
        # placed live, matching the i-1 convention already used elsewhere in
        # this function (passes_volume_filter, signal_time).
        atr = float(df.at[i - 1, "atr"]) if i > 0 else float("nan")
        if not np.isfinite(atr) or atr <= 0:
            continue
        if side == "long":
            stop = signal.get("stop", entry - stop_atr * atr)
            risk = entry - stop
            take = entry + rr * risk
        else:
            stop = signal.get("stop", entry + stop_atr * atr)
            risk = stop - entry
            take = entry - rr * risk
        if risk <= 0 or risk / entry > 0.03:
            continue
        exit_i, exit_price, reason = simulate_exit(
            df, i, side, stop, take, entry=entry,
            trailing_stop_atr=trailing_stop_atr, breakeven_at_r=breakeven_at_r, max_holding_bars=max_holding_bars,
        )
        gate.register(exit_i)
        gross = exit_price / entry - 1 if side == "long" else entry / exit_price - 1
        trades.append({
            "side": side,
            "signal_time": signal.get("signal_time", df.at[i-1, "begin"]),
            "entry_time": df.at[i, "begin"],
            "exit_time": df.at[exit_i, "begin"],
            "entry_price": entry,
            "stop_price": stop,
            "take_price": take,
            "exit_price": exit_price,
            "net_return": gross - 2 * COMMISSION_SIDE,
            "exit_reason": reason,
            "bars_held": exit_i - i + 1,
        })
    return pd.DataFrame(trades)


def run_ema_pullback(source: Path, raw: dict, results_dir: Path) -> dict:
    """Trend-following pullback entry: price must be trending (fast/slow EMA
    gap above min_trend_strength_atr), have pulled back from a recent swing
    extreme by a bounded depth, touched-or-approached the fast EMA depending
    on touch_mode, and printed a trigger candle back in the trend direction
    - optionally requiring that candle to be a strong impulse bar and/or its
    high/low to be broken out of before the entry fills."""
    params = parse_params("ema_pullback", raw)
    df = load_candles(source, raw.get("date_from"), raw.get("date_till"))
    df = resample_candles(df, params["timeframe"])
    df = add_atr(df, 14)
    df["ema_fast"] = df["close"].ewm(span=params["fast"], adjust=False).mean()
    df["ema_slow"] = df["close"].ewm(span=params["slow"], adjust=False).mean()

    pullback_bars = max(1, params["pullback_bars"])
    gate = TradeSlotGate(params["max_concurrent_trades"], params["reentry_cooldown_bars"])
    trades = []
    start = max(params["slow"] + 2, pullback_bars + 1)

    for i in range(start, len(df) - 1):
        atr = float(df.at[i, "atr"])
        if not np.isfinite(atr) or atr <= 0:
            continue
        fast_i, slow_i = float(df.at[i, "ema_fast"]), float(df.at[i, "ema_slow"])
        gap = fast_i - slow_i
        if abs(gap) / atr < params["min_trend_strength_atr"]:
            continue
        uptrend = gap > 0
        side = "long" if uptrend else "short"
        if params["direction"] in ("long", "short") and side != params["direction"]:
            continue

        window = df.iloc[i - pullback_bars:i]
        if uptrend:
            extreme_idx = int(window["high"].idxmax())
            extreme_price = float(df.at[extreme_idx, "high"])
            current_extreme = float(df.at[i, "low"])
        else:
            extreme_idx = int(window["low"].idxmin())
            extreme_price = float(df.at[extreme_idx, "low"])
            current_extreme = float(df.at[i, "high"])

        ema_gap_at_start = abs(float(df.at[extreme_idx, "ema_fast"]) - float(df.at[extreme_idx, "ema_slow"]))
        if ema_gap_at_start / atr < params["min_ema_distance_atr"]:
            continue

        depth = abs(extreme_price - current_extreme) / atr
        if not (params["pullback_min_depth_atr"] <= depth <= params["pullback_max_depth_atr"]):
            continue

        dist_to_ema = (current_extreme - fast_i) if uptrend else (fast_i - current_extreme)
        if params["touch_mode"] == "must_touch":
            touched = current_extreme <= fast_i if uptrend else current_extreme >= fast_i
        else:
            touched = dist_to_ema <= params["ema_touch_tolerance_atr"] * atr
        if not touched:
            continue

        is_bull_candle = df.at[i, "close"] > df.at[i, "open"]
        if uptrend != is_bull_candle:
            continue
        body = abs(float(df.at[i, "close"]) - float(df.at[i, "open"]))
        if params["impulse_candle_entry"] and body / atr < params["signal_candle_min_size_atr"]:
            continue
        if params["volume_filter"] and not passes_volume_filter(df, i, params["volume_multiplier"]):
            continue

        signal_high, signal_low = float(df.at[i, "high"]), float(df.at[i, "low"])
        entry_i, entry = None, None
        if params["breakout_confirm"]:
            for j in range(i + 1, min(i + 4, len(df) - 1) + 1):
                if uptrend and df.at[j, "high"] > signal_high:
                    entry_i, entry = j, signal_high
                    break
                if not uptrend and df.at[j, "low"] < signal_low:
                    entry_i, entry = j, signal_low
                    break
        elif i + 1 < len(df):
            entry_i, entry = i + 1, float(df.at[i + 1, "open"])
        if entry_i is None or entry_i >= len(df):
            continue

        stop = entry - params["stop_atr"] * atr if uptrend else entry + params["stop_atr"] * atr
        risk = abs(entry - stop)
        if risk <= 0:
            continue
        take = entry + params["rr"] * risk if uptrend else entry - params["rr"] * risk
        if not gate.admit(entry_i):
            continue

        exit_i, exit_price, reason = simulate_exit(
            df, entry_i, side, stop, take, entry=entry,
            trailing_stop_atr=params["trailing_stop_atr"], breakeven_at_r=params["breakeven_at_r"],
            max_holding_bars=params["max_holding_bars"],
        )
        gate.register(exit_i)
        gross = exit_price / entry - 1 if side == "long" else entry / exit_price - 1
        trades.append({
            "side": side,
            "signal_time": df.at[i, "begin"],
            "entry_time": df.at[entry_i, "begin"],
            "exit_time": df.at[exit_i, "begin"],
            "entry_price": entry,
            "stop_price": stop,
            "take_price": take,
            "exit_price": exit_price,
            "pullback_depth_atr": depth,
            "net_return": gross - 2 * COMMISSION_SIDE,
            "exit_reason": reason,
            "bars_held": exit_i - entry_i + 1,
        })

    return save_run(results_dir, "Откат к EMA", source.name, params, pd.DataFrame(trades))


def _exec_kwargs(params: dict) -> dict:
    """Universal exit/risk kwargs every _execute() caller passes through unchanged."""
    return dict(direction=params["direction"], volume_filter=params["volume_filter"],
                volume_multiplier=params["volume_multiplier"], trailing_stop_atr=params["trailing_stop_atr"],
                breakeven_at_r=params["breakeven_at_r"], max_holding_bars=params["max_holding_bars"],
                max_concurrent_trades=params["max_concurrent_trades"], reentry_cooldown_bars=params["reentry_cooldown_bars"])


def run_rsi_reversal(source: Path, raw: dict, results_dir: Path) -> dict:
    params = parse_params("rsi_reversal", raw)
    df = add_atr(load_candles(source, raw.get("date_from"), raw.get("date_till")), 14)
    df["rsi"] = _rsi(df["close"], params["period"])
    signals = []
    for i in range(params["period"] + 2, len(df)-1):
        if df.at[i-1,"rsi"] <= params["oversold"] and df.at[i,"rsi"] > params["oversold"]:
            signals.append({"side":"long","entry_i":i+1,"signal_time":df.at[i,"begin"]})
        elif df.at[i-1,"rsi"] >= params["overbought"] and df.at[i,"rsi"] < params["overbought"]:
            signals.append({"side":"short","entry_i":i+1,"signal_time":df.at[i,"begin"]})
    trades = _execute(df, signals, params["rr"], params["stop_atr"], **_exec_kwargs(params))
    return save_run(results_dir, "Разворот RSI", source.name, params, trades)


def run_inside_bar(source: Path, raw: dict, results_dir: Path) -> dict:
    params = parse_params("inside_bar", raw)
    df = add_atr(load_candles(source, raw.get("date_from"), raw.get("date_till")), 14)
    signals = []
    for i in range(2, len(df)-params["max_wait"]-1):
        mother = df.iloc[i-1]
        inside = df.iloc[i]
        if inside["high"] < mother["high"] and inside["low"] > mother["low"]:
            for j in range(i+1, i+params["max_wait"]+1):
                if df.at[j,"high"] > mother["high"]:
                    signals.append({"side":"long","entry_i":j+1,"stop":float(mother["low"]),"signal_time":df.at[j,"begin"]}); break
                if df.at[j,"low"] < mother["low"]:
                    signals.append({"side":"short","entry_i":j+1,"stop":float(mother["high"]),"signal_time":df.at[j,"begin"]}); break
    trades = _execute(df, signals, params["rr"], 1.0, **_exec_kwargs(params))
    return save_run(results_dir, "Внутренний бар", source.name, params, trades)


def run_pin_bar(source: Path, raw: dict, results_dir: Path) -> dict:
    params = parse_params("pin_bar", raw)
    df = add_atr(load_candles(source, raw.get("date_from"), raw.get("date_till")), 14)
    signals=[]
    for i in range(params["lookback"], len(df)-1):
        o,c,h,l = map(float,[df.at[i,"open"],df.at[i,"close"],df.at[i,"high"],df.at[i,"low"]])
        body=max(abs(c-o),1e-9); upper=h-max(o,c); lower=min(o,c)-l
        if lower/body >= params["wick_ratio"] and l <= df.iloc[i-params["lookback"]:i+1]["low"].min():
            signals.append({"side":"long","entry_i":i+1,"stop":l-params["stop_atr"]*float(df.at[i,"atr"]),"signal_time":df.at[i,"begin"]})
        elif upper/body >= params["wick_ratio"] and h >= df.iloc[i-params["lookback"]:i+1]["high"].max():
            signals.append({"side":"short","entry_i":i+1,"stop":h+params["stop_atr"]*float(df.at[i,"atr"]),"signal_time":df.at[i,"begin"]})
    trades = _execute(df, signals, params["rr"], params["stop_atr"], **_exec_kwargs(params))
    return save_run(results_dir, "Пин-бар", source.name, params, trades)


def _count_touches(series: pd.Series, level: float, tol: float) -> int:
    return int((series.sub(level).abs() <= tol).sum())


def run_breakout_retest(source: Path, raw: dict, results_dir: Path) -> dict:
    """Range breakout, validated by prior touches and a bounded break size,
    then a retest of the broken level (with optional false-wick tolerance
    and a confirming close) before entering either at market or via a
    resting limit order near the level."""
    params = parse_params("breakout_retest", raw)
    df = load_candles(source, raw.get("date_from"), raw.get("date_till"))
    df = resample_candles(df, params["timeframe"])
    df = add_atr(df, 14)
    if params["ema_filter"]:
        df["ema_filter_line"] = df["close"].ewm(span=max(2, params["ema_filter_period"]), adjust=False).mean()
    if params["atr_filter"]:
        df["atr_ma50"] = df["atr"].rolling(50, min_periods=50).mean()
    htf_trend = htf_trend_signal(df) if params["htf_trend_filter"] else None

    lookback = max(5, params["lookback"])
    retest_bars = max(1, params["retest_bars"])
    confirm_bars = max(0, params["confirm_bars"])
    gate = TradeSlotGate(params["max_concurrent_trades"], params["reentry_cooldown_bars"])
    trades = []
    n = len(df)
    i = lookback

    while i < n - 3:
        atr = float(df.at[i, "atr"])
        if not np.isfinite(atr) or atr <= 0:
            i += 1
            continue

        window = df.iloc[i - lookback:i]
        high_level = float(window["high"].max())
        low_level = float(window["low"].min())

        side = level = break_size = None
        if df.at[i, "close"] > high_level:
            side, level = "long", high_level
            break_size = (float(df.at[i, "close"]) - level) / atr
        elif df.at[i, "close"] < low_level:
            side, level = "short", low_level
            break_size = (level - float(df.at[i, "close"])) / atr
        if side is None or not (params["min_break_atr"] <= break_size <= params["max_break_atr"]):
            i += 1
            continue

        touches = _count_touches(window["high"] if side == "long" else window["low"], level, params["retest_tolerance_atr"] * atr)
        if touches < params["min_touches"]:
            i += 1
            continue

        break_end_i = i
        if confirm_bars:
            ok = True
            for b in range(confirm_bars):
                idx = i + b
                if idx >= n or (side == "long") != (df.at[idx, "close"] > level):
                    ok = False
                    break
            if not ok:
                i += 1
                continue
            break_end_i = i + confirm_bars - 1

        if params["direction"] in ("long", "short") and side != params["direction"]:
            i = break_end_i + 1
            continue
        if params["volume_filter"] and not passes_volume_filter(df, i, params["volume_multiplier"]):
            i = break_end_i + 1
            continue
        if params["atr_filter"]:
            atr_mean = float(df.at[i, "atr_ma50"])
            if not (np.isfinite(atr_mean) and atr >= atr_mean):
                i = break_end_i + 1
                continue
        if htf_trend is not None:
            trend_sign = htf_trend[i]
            if (side == "long" and trend_sign < 0) or (side == "short" and trend_sign > 0):
                i = break_end_i + 1
                continue
        if params["ema_filter"]:
            ema_val = float(df.at[i, "ema_filter_line"])
            if (side == "long") != (float(df.at[i, "close"]) >= ema_val):
                i = break_end_i + 1
                continue

        retest_tol = params["retest_tolerance_atr"] * atr
        touch_i = None
        for j in range(break_end_i + 1, min(break_end_i + retest_bars, n - 3) + 1):
            if side == "long":
                pierced = float(df.at[j, "low"]) < level - retest_tol
                near = float(df.at[j, "low"]) <= level + retest_tol
                held = float(df.at[j, "close"]) > level - retest_tol
            else:
                pierced = float(df.at[j, "high"]) > level + retest_tol
                near = float(df.at[j, "high"]) >= level - retest_tol
                held = float(df.at[j, "close"]) < level + retest_tol
            if near and held and (params["allow_false_wick"] or not pierced):
                touch_i = j
                break
        if touch_i is None:
            i = break_end_i + 1
            continue

        ready_i = touch_i
        if params["require_confirm_close"]:
            confirm_i = touch_i + 1
            if confirm_i >= n - 1:
                i = break_end_i + 1
                continue
            confirmed = (float(df.at[confirm_i, "close"]) > level) if side == "long" else (float(df.at[confirm_i, "close"]) < level)
            if not confirmed:
                i = break_end_i + 1
                continue
            ready_i = confirm_i

        entry_i = entry = None
        if params["entry_mode"] == "limit":
            offset = params["entry_offset_atr"] * atr
            limit_price = (level - offset) if side == "long" else (level + offset)
            for j in range(ready_i, min(ready_i + retest_bars, n - 2) + 1):
                if side == "long" and float(df.at[j, "low"]) <= limit_price:
                    entry_i, entry = j, limit_price
                    break
                if side == "short" and float(df.at[j, "high"]) >= limit_price:
                    entry_i, entry = j, limit_price
                    break
        elif ready_i + 1 < n:
            entry_i, entry = ready_i + 1, float(df.at[ready_i + 1, "open"])
        if entry_i is None or entry_i >= n:
            i = break_end_i + 1
            continue

        if abs(entry - level) / atr > params["max_entry_distance_atr"]:
            i = break_end_i + 1
            continue

        stop = level - params["stop_atr"] * atr if side == "long" else level + params["stop_atr"] * atr
        risk = abs(entry - stop)
        if risk <= 0:
            i = break_end_i + 1
            continue
        take = entry + params["rr"] * risk if side == "long" else entry - params["rr"] * risk

        if not gate.admit(entry_i):
            i = break_end_i + 1
            continue

        exit_i, exit_price, reason = simulate_exit(
            df, entry_i, side, stop, take, entry=entry,
            trailing_stop_atr=params["trailing_stop_atr"], breakeven_at_r=params["breakeven_at_r"],
            max_holding_bars=params["max_holding_bars"],
        )
        gate.register(exit_i)
        gross = exit_price / entry - 1 if side == "long" else entry / exit_price - 1
        trades.append({
            "side": side,
            "level": level,
            "break_size_atr": break_size,
            "break_time": df.at[i, "begin"],
            "retest_time": df.at[touch_i, "begin"],
            "entry_time": df.at[entry_i, "begin"],
            "exit_time": df.at[exit_i, "begin"],
            "entry_price": entry,
            "stop_price": stop,
            "take_price": take,
            "exit_price": exit_price,
            "net_return": gross - 2 * COMMISSION_SIDE,
            "exit_reason": reason,
            "bars_held": exit_i - entry_i + 1,
        })
        i = break_end_i + 1

    return save_run(results_dir, "Пробой с ретестом", source.name, params, pd.DataFrame(trades))


STRATEGY_CATALOG = {
    "false_breakout": {"name":"Ложный пробой 2R","category":"Уровни","summary":"Прокол уровня и быстрый возврат за него.","visual":"уровень → прокол → возврат → вход","primary":True},
    "head_shoulders": {"name":"Голова и плечи","category":"Паттерны","summary":"Разворотная фигура с пробоем линии шеи.","visual":"плечо / голова / плечо → пробой"},
    "breakout_retest": {"name":"Пробой с ретестом","category":"Уровни","summary":"Выход из диапазона и проверка уровня с обратной стороны.","visual":"пробой → ретест → продолжение"},
    "ema_pullback": {"name":"Откат к EMA","category":"Тренд","summary":"Вход по тренду после возврата к быстрой EMA.","visual":"EMA20 > EMA50 → откат → импульс"},
    "rsi_reversal": {"name":"Разворот RSI","category":"Осцилляторы","summary":"Возврат RSI из зон перепроданности или перекупленности.","visual":"RSI < 30 → возврат; RSI > 70 → возврат"},
    "inside_bar": {"name":"Внутренний бар","category":"Price Action","summary":"Сжатие диапазона и последующий выход.","visual":"mother bar → inside bar → breakout"},
    "pin_bar": {"name":"Пин-бар","category":"Price Action","summary":"Свеча с длинной тенью у локального экстремума.","visual":"длинная тень → отказ цены → вход"},
}

RUNNERS = {
    "breakout_retest": run_breakout_retest,
    "ema_pullback": run_ema_pullback,
    "rsi_reversal": run_rsi_reversal,
    "inside_bar": run_inside_bar,
    "pin_bar": run_pin_bar,
}
