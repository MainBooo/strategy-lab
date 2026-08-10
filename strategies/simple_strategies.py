from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from strategies.common import (
    COMMISSION_SIDE, add_atr, load_candles, save_run,
    filter_signals_by_direction, passes_volume_filter, simulate_exit, universal_execution_params,
)


def _rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _execute(df: pd.DataFrame, signals: list[dict], rr: float, stop_atr: float, *,
             direction: str = "both", volume_filter: bool = False, volume_multiplier: float = 1.5,
             trailing_stop_atr: float = 0, max_holding_bars: int = 0) -> pd.DataFrame:
    signals = filter_signals_by_direction(signals, direction)
    if volume_filter:
        signals = [s for s in signals if passes_volume_filter(df, max(0, s["entry_i"] - 1), volume_multiplier)]
    trades = []
    available = 0
    for signal in sorted(signals, key=lambda x: x["entry_i"]):
        i = signal["entry_i"]
        if i < available or i >= len(df):
            continue
        side = signal["side"]
        entry = float(df.at[i, "open"])
        atr = float(df.at[i, "atr"])
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
            df, i, side, stop, take,
            trailing_stop_atr=trailing_stop_atr, max_holding_bars=max_holding_bars,
        )
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
        available = exit_i + 1
    return pd.DataFrame(trades)


def run_ema_pullback(source: Path, raw: dict, results_dir: Path) -> dict:
    params = {"fast": int(raw.get("fast", 20)), "slow": int(raw.get("slow", 50)), "rr": float(raw.get("rr", 2)), "stop_atr": float(raw.get("stop_atr", 1.2)), **universal_execution_params(raw)}
    df = add_atr(load_candles(source, raw.get("date_from"), raw.get("date_till")), 14)
    df["ema_fast"] = df["close"].ewm(span=params["fast"], adjust=False).mean()
    df["ema_slow"] = df["close"].ewm(span=params["slow"], adjust=False).mean()
    signals = []
    for i in range(params["slow"] + 2, len(df)-1):
        if df.at[i, "ema_fast"] > df.at[i, "ema_slow"] and df.at[i, "low"] <= df.at[i, "ema_fast"] and df.at[i, "close"] > df.at[i, "ema_fast"] and df.at[i, "close"] > df.at[i, "open"]:
            signals.append({"side":"long","entry_i":i+1,"signal_time":df.at[i,"begin"]})
        elif df.at[i, "ema_fast"] < df.at[i, "ema_slow"] and df.at[i, "high"] >= df.at[i, "ema_fast"] and df.at[i, "close"] < df.at[i, "ema_fast"] and df.at[i, "close"] < df.at[i, "open"]:
            signals.append({"side":"short","entry_i":i+1,"signal_time":df.at[i,"begin"]})
    trades = _execute(df, signals, params["rr"], params["stop_atr"], direction=params["direction"],
                       volume_filter=params["volume_filter"], volume_multiplier=params["volume_multiplier"],
                       trailing_stop_atr=params["trailing_stop_atr"], max_holding_bars=params["max_holding_bars"])
    return save_run(results_dir, "Откат к EMA", source.name, params, trades)


def run_rsi_reversal(source: Path, raw: dict, results_dir: Path) -> dict:
    params = {"period": int(raw.get("period", 14)), "oversold": float(raw.get("oversold", 30)), "overbought": float(raw.get("overbought", 70)), "rr": float(raw.get("rr", 1.5)), "stop_atr": float(raw.get("stop_atr", 1.0)), **universal_execution_params(raw)}
    df = add_atr(load_candles(source, raw.get("date_from"), raw.get("date_till")), 14)
    df["rsi"] = _rsi(df["close"], params["period"])
    signals = []
    for i in range(params["period"] + 2, len(df)-1):
        if df.at[i-1,"rsi"] <= params["oversold"] and df.at[i,"rsi"] > params["oversold"]:
            signals.append({"side":"long","entry_i":i+1,"signal_time":df.at[i,"begin"]})
        elif df.at[i-1,"rsi"] >= params["overbought"] and df.at[i,"rsi"] < params["overbought"]:
            signals.append({"side":"short","entry_i":i+1,"signal_time":df.at[i,"begin"]})
    trades = _execute(df, signals, params["rr"], params["stop_atr"], direction=params["direction"],
                       volume_filter=params["volume_filter"], volume_multiplier=params["volume_multiplier"],
                       trailing_stop_atr=params["trailing_stop_atr"], max_holding_bars=params["max_holding_bars"])
    return save_run(results_dir, "Разворот RSI", source.name, params, trades)


def run_inside_bar(source: Path, raw: dict, results_dir: Path) -> dict:
    params = {"rr": float(raw.get("rr", 2)), "max_wait": int(raw.get("max_wait", 3)), **universal_execution_params(raw)}
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
    trades = _execute(df, signals, params["rr"], 1.0, direction=params["direction"],
                       volume_filter=params["volume_filter"], volume_multiplier=params["volume_multiplier"],
                       trailing_stop_atr=params["trailing_stop_atr"], max_holding_bars=params["max_holding_bars"])
    return save_run(results_dir, "Внутренний бар", source.name, params, trades)


def run_pin_bar(source: Path, raw: dict, results_dir: Path) -> dict:
    params = {"wick_ratio": float(raw.get("wick_ratio", 2.5)), "lookback": int(raw.get("lookback", 20)), "rr": float(raw.get("rr", 2)), "stop_atr": float(raw.get("stop_atr", 0.2)), **universal_execution_params(raw)}
    df = add_atr(load_candles(source, raw.get("date_from"), raw.get("date_till")), 14)
    signals=[]
    for i in range(params["lookback"], len(df)-1):
        o,c,h,l = map(float,[df.at[i,"open"],df.at[i,"close"],df.at[i,"high"],df.at[i,"low"]])
        body=max(abs(c-o),1e-9); upper=h-max(o,c); lower=min(o,c)-l
        if lower/body >= params["wick_ratio"] and l <= df.iloc[i-params["lookback"]:i+1]["low"].min():
            signals.append({"side":"long","entry_i":i+1,"stop":l-params["stop_atr"]*float(df.at[i,"atr"]),"signal_time":df.at[i,"begin"]})
        elif upper/body >= params["wick_ratio"] and h >= df.iloc[i-params["lookback"]:i+1]["high"].max():
            signals.append({"side":"short","entry_i":i+1,"stop":h+params["stop_atr"]*float(df.at[i,"atr"]),"signal_time":df.at[i,"begin"]})
    trades = _execute(df, signals, params["rr"], params["stop_atr"], direction=params["direction"],
                       volume_filter=params["volume_filter"], volume_multiplier=params["volume_multiplier"],
                       trailing_stop_atr=params["trailing_stop_atr"], max_holding_bars=params["max_holding_bars"])
    return save_run(results_dir, "Пин-бар", source.name, params, trades)


def run_breakout_retest(source: Path, raw: dict, results_dir: Path) -> dict:
    params = {"lookback":int(raw.get("lookback",50)),"retest_bars":int(raw.get("retest_bars",5)),"rr":float(raw.get("rr",2)),"stop_atr":float(raw.get("stop_atr",0.3)), **universal_execution_params(raw)}
    df=add_atr(load_candles(source, raw.get("date_from"), raw.get("date_till")),14); signals=[]
    i=params["lookback"]
    while i < len(df)-params["retest_bars"]-2:
        high=float(df.iloc[i-params["lookback"]:i]["high"].max()); low=float(df.iloc[i-params["lookback"]:i]["low"].min())
        if df.at[i,"close"]>high:
            for j in range(i+1,i+params["retest_bars"]+1):
                if df.at[j,"low"]<=high and df.at[j,"close"]>high:
                    signals.append({"side":"long","entry_i":j+1,"stop":high-params["stop_atr"]*float(df.at[j,"atr"]),"signal_time":df.at[j,"begin"]}); i=j; break
        elif df.at[i,"close"]<low:
            for j in range(i+1,i+params["retest_bars"]+1):
                if df.at[j,"high"]>=low and df.at[j,"close"]<low:
                    signals.append({"side":"short","entry_i":j+1,"stop":low+params["stop_atr"]*float(df.at[j,"atr"]),"signal_time":df.at[j,"begin"]}); i=j; break
        i+=1
    trades = _execute(df, signals, params["rr"], params["stop_atr"], direction=params["direction"],
                       volume_filter=params["volume_filter"], volume_multiplier=params["volume_multiplier"],
                       trailing_stop_atr=params["trailing_stop_atr"], max_holding_bars=params["max_holding_bars"])
    return save_run(results_dir,"Пробой с ретестом",source.name,params,trades)


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
