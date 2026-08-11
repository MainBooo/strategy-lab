from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from strategies.common import (
    COMMISSION_SIDE, TradeSlotGate, add_atr, load_candles, save_run,
    passes_volume_filter, simulate_exit,
)
from strategies.param_schema import parse_params


def _touch_indices(values: pd.Series, level: float, tolerance: float, separation: int) -> list[int]:
    raw = np.flatnonzero(((values - level).abs() <= tolerance).to_numpy())
    if len(raw) == 0:
        return []
    accepted = [int(raw[0])]
    for idx in raw[1:]:
        if int(idx) - accepted[-1] >= separation:
            accepted.append(int(idx))
    return accepted


def run_false_breakout(source: Path, raw_params: dict, results_dir: Path) -> dict:
    params = parse_params("false_breakout", raw_params)

    df = add_atr(load_candles(source, raw_params.get("date_from"), raw_params.get("date_till")), params["atr_period"])
    df["atr_ma50"] = df["atr"].rolling(50, min_periods=50).mean()

    trades = []
    used_levels: list[tuple[str, float]] = []
    gate = TradeSlotGate(params["max_concurrent_trades"], params["reentry_cooldown_bars"])
    i = params["lookback"] + max(params["atr_period"], 50)

    while i < len(df) - 3:
        atr = float(df.at[i, "atr"])
        if not np.isfinite(atr) or atr <= 0:
            i += 1
            continue

        if params["atr_filter"]:
            atr_mean = float(df.at[i, "atr_ma50"])
            if not np.isfinite(atr_mean) or atr < atr_mean:
                i += 1
                continue

        window_start = max(0, i - min(params["lookback"], params["max_level_age"]))
        window = df.iloc[window_start:i]
        support = float(window["low"].min())
        resistance = float(window["high"].max())
        tolerance = params["touch_tolerance_atr"] * atr

        support_indices = _touch_indices(
            window["low"], support, tolerance, params["min_touch_separation"]
        )
        resistance_indices = _touch_indices(
            window["high"], resistance, tolerance, params["min_touch_separation"]
        )

        signal = None

        support_used = any(
            side == "long" and abs(level - support) <= tolerance
            for side, level in used_levels
        )
        resistance_used = any(
            side == "short" and abs(level - resistance) <= tolerance
            for side, level in used_levels
        )

        if (
            len(support_indices) >= params["min_touches"]
            and not support_used
            and df.at[i, "low"] < support
        ):
            depth = (support - float(df.at[i, "low"])) / atr
            if params["min_depth_atr"] <= depth <= params["max_depth_atr"]:
                extreme = float(df.at[i, "low"])
                for j in range(i, min(i + params["return_window"], len(df) - 3) + 1):
                    extreme = min(extreme, float(df.at[j, "low"]))
                    if df.at[j, "close"] > support:
                        signal = ("long", support, j, extreme, depth)
                        break

        if (
            signal is None
            and len(resistance_indices) >= params["min_touches"]
            and not resistance_used
            and df.at[i, "high"] > resistance
        ):
            depth = (float(df.at[i, "high"]) - resistance) / atr
            if params["min_depth_atr"] <= depth <= params["max_depth_atr"]:
                extreme = float(df.at[i, "high"])
                for j in range(i, min(i + params["return_window"], len(df) - 3) + 1):
                    extreme = max(extreme, float(df.at[j, "high"]))
                    if df.at[j, "close"] < resistance:
                        signal = ("short", resistance, j, extreme, depth)
                        break

        if signal is None:
            i += 1
            continue

        side, level, return_i, extreme, depth = signal

        if params["direction"] in ("long", "short") and side != params["direction"]:
            i += 1
            continue
        if params["volume_filter"] and not passes_volume_filter(df, i, params["volume_multiplier"]):
            i += 1
            continue

        confirm_i = return_i

        if params["confirmation"]:
            confirm_i = return_i + 1
            if side == "long":
                valid = (
                    df.at[confirm_i, "close"] > df.at[confirm_i, "open"]
                    and df.at[confirm_i, "close"] > df.at[return_i, "close"]
                )
            else:
                valid = (
                    df.at[confirm_i, "close"] < df.at[confirm_i, "open"]
                    and df.at[confirm_i, "close"] < df.at[return_i, "close"]
                )
            if not valid:
                i += 1
                continue

        entry_i = confirm_i + 1
        entry = float(df.at[entry_i, "open"])

        if side == "long":
            stop = extreme - params["stop_buffer_atr"] * atr
            risk = entry - stop
            take = entry + params["rr"] * risk
        else:
            stop = extreme + params["stop_buffer_atr"] * atr
            risk = stop - entry
            take = entry - params["rr"] * risk

        risk_pct = risk / entry if entry else 0
        if risk <= 0 or not (params["min_risk_pct"] <= risk_pct <= params["max_risk_pct"]):
            i += 1
            continue
        if not gate.admit(entry_i):
            i = confirm_i + 1
            continue

        exit_i, exit_price, reason = simulate_exit(
            df, entry_i, side, stop, take, entry=entry,
            trailing_stop_atr=params["trailing_stop_atr"], breakeven_at_r=params["breakeven_at_r"],
            max_holding_bars=params["max_holding_bars"],
        )
        gate.register(exit_i)

        gross = exit_price / entry - 1 if side == "long" else entry / exit_price - 1
        net = gross - 2 * COMMISSION_SIDE

        trades.append({
            "side": side,
            "level": level,
            "break_time": df.at[i, "begin"],
            "return_time": df.at[return_i, "begin"],
            "confirmation_time": df.at[confirm_i, "begin"],
            "entry_time": df.at[entry_i, "begin"],
            "exit_time": df.at[exit_i, "begin"],
            "entry_price": entry,
            "stop_price": stop,
            "take_price": take,
            "exit_price": exit_price,
            "depth_atr": depth,
            "risk_pct": risk_pct,
            "net_return": net,
            "exit_reason": reason,
            "bars_held": exit_i - entry_i + 1,
        })

        if params["first_break_only"]:
            used_levels.append((side, level))
        i = confirm_i + 1

    return save_run(
        results_dir,
        "Ложный пробой уровня",
        source.name,
        params,
        pd.DataFrame(trades),
    )
