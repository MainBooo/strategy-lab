from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from strategies.common import COMMISSION_SIDE, load_candles, save_run


def _pivots(df: pd.DataFrame, span: int):
    highs, lows = df["high"].to_numpy(), df["low"].to_numpy()
    items = []

    for i in range(span, len(df) - span):
        hw = highs[i-span:i+span+1]
        lw = lows[i-span:i+span+1]
        if highs[i] == hw.max() and (hw == highs[i]).sum() == 1:
            items.append({"kind":"peak", "i":i, "confirm_i":i+span, "price":float(highs[i])})
        if lows[i] == lw.min() and (lw == lows[i]).sum() == 1:
            items.append({"kind":"trough", "i":i, "confirm_i":i+span, "price":float(lows[i])})

    items.sort(key=lambda x: x["i"])
    cleaned = []
    for item in items:
        if not cleaned or cleaned[-1]["kind"] != item["kind"]:
            cleaned.append(item)
        else:
            prev = cleaned[-1]
            better = item["price"] > prev["price"] if item["kind"] == "peak" else item["price"] < prev["price"]
            if better:
                cleaned[-1] = item
    return cleaned


def _line(x1, y1, x2, y2, x):
    return y2 if x2 == x1 else y1 + (y2-y1) * (x-x1) / (x2-x1)


def run_head_shoulders(source: Path, raw_params: dict, results_dir: Path) -> dict:
    params = {
        "pivot_span": int(raw_params.get("pivot_span", 3)),
        "shoulder_tolerance": float(raw_params.get("shoulder_tolerance", 0.03)),
        "head_min_distance": float(raw_params.get("head_min_distance", 0.01)),
        "stop_pct": float(raw_params.get("stop_pct", 0.02)),
        "take_pct": float(raw_params.get("take_pct", 0.05)),
        "max_breakout_bars": int(raw_params.get("max_breakout_bars", 30)),
    }

    df = load_candles(source, raw_params.get("date_from"), raw_params.get("date_till"))
    pivots = _pivots(df, params["pivot_span"])
    signals = []

    for j in range(len(pivots)-4):
        a,b,c,d,e = pivots[j:j+5]
        kinds = [x["kind"] for x in (a,b,c,d,e)]

        if kinds == ["peak","trough","peak","trough","peak"]:
            shoulder_diff = abs(a["price"]-e["price"]) / ((a["price"]+e["price"])/2)
            valid = (
                shoulder_diff <= params["shoulder_tolerance"]
                and c["price"] >= max(a["price"],e["price"]) * (1+params["head_min_distance"])
            )
            side = "short"
        elif kinds == ["trough","peak","trough","peak","trough"]:
            shoulder_diff = abs(a["price"]-e["price"]) / ((a["price"]+e["price"])/2)
            valid = (
                shoulder_diff <= params["shoulder_tolerance"]
                and c["price"] <= min(a["price"],e["price"]) * (1-params["head_min_distance"])
            )
            side = "long"
        else:
            continue

        if not valid:
            continue

        for k in range(max(e["confirm_i"], e["i"]+1), min(len(df)-2, e["i"]+params["max_breakout_bars"])+1):
            neck = _line(b["i"],b["price"],d["i"],d["price"],k)
            prev = _line(b["i"],b["price"],d["i"],d["price"],k-1)

            crossed = (
                df.at[k-1,"close"] >= prev and df.at[k,"close"] < neck
                if side == "short"
                else df.at[k-1,"close"] <= prev and df.at[k,"close"] > neck
            )
            if crossed:
                signals.append((k+1, side, df.at[k,"begin"]))
                break

    trades = []
    available_from = 0
    for entry_i, side, signal_time in sorted(signals):
        if entry_i < available_from or entry_i >= len(df):
            continue

        entry = float(df.at[entry_i,"open"])
        if side == "long":
            stop, take = entry*(1-params["stop_pct"]), entry*(1+params["take_pct"])
        else:
            stop, take = entry*(1+params["stop_pct"]), entry*(1-params["take_pct"])

        exit_i = len(df)-1
        exit_price = float(df.at[exit_i,"close"])
        reason = "end_of_period"

        for k in range(entry_i, len(df)):
            high, low = float(df.at[k,"high"]), float(df.at[k,"low"])
            hit_stop = low <= stop if side == "long" else high >= stop
            hit_take = high >= take if side == "long" else low <= take
            if hit_stop:
                exit_i, exit_price, reason = k, stop, "stop"
                break
            if hit_take:
                exit_i, exit_price, reason = k, take, "take"
                break

        gross = exit_price/entry-1 if side == "long" else entry/exit_price-1
        trades.append({
            "side": side,
            "signal_time": signal_time,
            "entry_time": df.at[entry_i,"begin"],
            "exit_time": df.at[exit_i,"begin"],
            "entry_price": entry,
            "exit_price": exit_price,
            "net_return": gross - 2*COMMISSION_SIDE,
            "exit_reason": reason,
            "bars_held": exit_i-entry_i+1,
        })
        available_from = exit_i+1

    return save_run(
        results_dir,
        "Голова и плечи",
        source.name,
        params,
        pd.DataFrame(trades),
    )
