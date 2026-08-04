from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from strategies.common import COMMISSION_SIDE, add_atr, load_candles, save_run


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
    params = {
        "lookback": int(raw_params.get("lookback", 80)),
        "atr_period": int(raw_params.get("atr_period", 14)),
        "min_touches": int(raw_params.get("min_touches", 3)),
        "touch_tolerance_atr": float(raw_params.get("touch_tolerance_atr", 0.15)),
        "min_depth_atr": float(raw_params.get("min_depth_atr", 0.25)),
        "max_depth_atr": float(raw_params.get("max_depth_atr", 0.70)),
        "return_window": int(raw_params.get("return_window", 2)),
        "stop_buffer_atr": float(raw_params.get("stop_buffer_atr", 0.05)),
        "rr": float(raw_params.get("rr", 2.0)),
        "confirmation": bool(raw_params.get("confirmation", True)),
        "min_risk_pct": float(raw_params.get("min_risk_pct", 0.0025)),
        "max_risk_pct": float(raw_params.get("max_risk_pct", 0.015)),
        "min_touch_separation": int(raw_params.get("min_touch_separation", 10)),
        "max_level_age": int(raw_params.get("max_level_age", 150)),
        "first_break_only": bool(raw_params.get("first_break_only", True)),
        "atr_filter": bool(raw_params.get("atr_filter", False)),
    }

    df = add_atr(load_candles(source, raw_params.get("date_from"), raw_params.get("date_till")), params["atr_period"])
    df["atr_ma50"] = df["atr"].rolling(50, min_periods=50).mean()

    trades = []
    used_levels: list[tuple[str, float]] = []
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

        exit_i = len(df) - 1
        exit_price = float(df.at[exit_i, "close"])
        reason = "end_of_period"

        for k in range(entry_i, len(df)):
            high, low = float(df.at[k, "high"]), float(df.at[k, "low"])
            if side == "long":
                hit_stop, hit_take = low <= stop, high >= take
            else:
                hit_stop, hit_take = high >= stop, low <= take

            if hit_stop:
                exit_i, exit_price, reason = k, stop, "stop"
                break
            if hit_take:
                exit_i, exit_price, reason = k, take, "take"
                break

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
        i = exit_i + 1

    return save_run(
        results_dir,
        "Ложный пробой уровня",
        source.name,
        params,
        pd.DataFrame(trades),
    )
