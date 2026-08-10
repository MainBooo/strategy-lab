from __future__ import annotations

import json
import uuid
from pathlib import Path

import numpy as np
import pandas as pd

COMMISSION_SIDE = 0.0005


def load_candles(path: Path, date_from: str | None = None, date_till: str | None = None) -> pd.DataFrame:
    df = pd.read_csv(path, sep=None, engine="python")
    df.columns = [str(c).strip().lower() for c in df.columns]
    aliases = {"<open>":"open","<high>":"high","<low>":"low","<close>":"close","<vol>":"volume","datetime":"begin"}
    df = df.rename(columns={c: aliases.get(c, c) for c in df.columns})
    if "begin" not in df and {"date","time"}.issubset(df.columns):
        ds=df["date"].astype(str).str.replace(r"\D","",regex=True)
        ts=df["time"].astype(str).str.replace(r"\D","",regex=True).str.zfill(6)
        df["begin"]=pd.to_datetime(ds+ts,format="%Y%m%d%H%M%S",errors="coerce")
    for col in ["open","high","low","close","volume"]:
        if col in df: df[col]=pd.to_numeric(df[col],errors="coerce")
    df["begin"]=pd.to_datetime(df["begin"],errors="coerce")
    df=df.dropna(subset=["begin","open","high","low","close"]).sort_values("begin").drop_duplicates("begin").reset_index(drop=True)
    if date_from:
        df=df[df["begin"]>=pd.to_datetime(date_from)]
    if date_till:
        df=df[df["begin"]<=pd.to_datetime(date_till)+pd.Timedelta(days=1)]
    return df.reset_index(drop=True)


def add_atr(df: pd.DataFrame, period: int=14) -> pd.DataFrame:
    out=df.copy(); prev=out["close"].shift(1)
    tr=np.maximum(out["high"]-out["low"],np.maximum((out["high"]-prev).abs(),(out["low"]-prev).abs()))
    out["atr"]=tr.rolling(period,min_periods=period).mean(); return out


_TIMEFRAME_MINUTES = {"10m": 10, "30m": 30, "60m": 60, "4h": 240, "1d": 1440}


def native_bar_minutes(df: pd.DataFrame) -> float:
    """Median spacing between candles, in minutes - used to detect the
    source file's real granularity instead of trusting a filename."""
    if len(df) < 2:
        return 10.0
    delta = df["begin"].diff().dt.total_seconds().median() / 60
    return float(delta) if np.isfinite(delta) and delta > 0 else 10.0


def resample_candles(df: pd.DataFrame, timeframe: str | None) -> pd.DataFrame:
    """Roll already-loaded candles up to a coarser timeframe by honest OHLCV
    aggregation (pandas resample), mirroring candle_api.py's chart-side
    aggregation but on the strategies' pandas frames. A no-op (returns df
    unchanged) whenever the requested timeframe is at or below the source
    file's own granularity - you cannot manufacture 30m bars out of 60m data,
    so the strategy silently keeps running on native bars instead of erroring."""
    target = _TIMEFRAME_MINUTES.get(timeframe or "")
    if not target:
        return df
    native = native_bar_minutes(df)
    if target <= native + 0.01:
        return df
    rule = f"{int(round(target))}min"
    agg = {"open": "first", "high": "max", "low": "min", "close": "last"}
    if "volume" in df.columns:
        agg["volume"] = "sum"
    out = (
        df.set_index("begin")
        .resample(rule, label="left", closed="left")
        .agg(agg)
        .dropna(subset=["open", "high", "low", "close"])
        .reset_index()
    )
    return out


def htf_trend_signal(df: pd.DataFrame, factor: int = 6, ema_period: int = 50) -> np.ndarray:
    """+1/-1/0 per-bar higher-timeframe trend direction, built by resampling
    to `factor`x the base bar size, running an EMA on those coarser bars, and
    forward-filling each base bar with the sign of (HTF close - HTF EMA) of
    the higher-timeframe bar it belongs to. Used by breakout_retest's
    htf_trend_filter to require alignment with the bigger-picture trend
    without needing a second data file."""
    base = df.set_index("begin")
    native = native_bar_minutes(df)
    rule = f"{max(1, int(round(native * factor)))}min"
    htf_close = base["close"].resample(rule, label="left", closed="left").last().dropna()
    if len(htf_close) < 2:
        return np.zeros(len(df))
    htf_ema = htf_close.ewm(span=max(2, ema_period), adjust=False).mean()
    trend = np.sign(htf_close - htf_ema)
    aligned = trend.reindex(base.index, method="ffill").fillna(0)
    return aligned.to_numpy()


class TradeSlotGate:
    """Sequential admission control shared by every strategy's signal loop:
    caps how many trades can be open at once (max_concurrent_trades) and
    enforces a cooldown after each exit before a new entry is allowed
    (reentry_cooldown_bars). Defaults (1 slot, 0 cooldown) reproduce the old
    "one trade at a time, re-enter immediately after exit" behaviour exactly,
    so existing saved configs are unaffected."""

    def __init__(self, max_concurrent: int = 1, cooldown_bars: int = 0):
        self.max_concurrent = max(1, int(max_concurrent or 1))
        self.cooldown_bars = max(0, int(cooldown_bars or 0))
        self._open_exits: list[int] = []
        self._blocked_until = 0

    def admit(self, entry_i: int) -> bool:
        still_open = []
        for exit_i in self._open_exits:
            if exit_i < entry_i:
                self._blocked_until = max(self._blocked_until, exit_i + 1 + self.cooldown_bars)
            else:
                still_open.append(exit_i)
        self._open_exits = still_open
        if entry_i < self._blocked_until:
            return False
        return len(self._open_exits) < self.max_concurrent

    def register(self, exit_i: int) -> None:
        self._open_exits.append(exit_i)


def universal_execution_params(raw: dict) -> dict:
    """Direction/volume/trailing-stop/max-holding/breakeven/risk knobs shared
    by every strategy.

    Defaults reproduce the old, unfiltered behaviour exactly (both
    directions, no volume filter, no trailing stop, no forced time exit, no
    breakeven, one trade at a time, no cooldown, fixed lot sizing) so
    existing saved ticker_strategies configs and historical runs are
    unaffected.
    """
    return {
        "direction": str(raw.get("direction", "both") or "both"),
        "volume_filter": bool(raw.get("volume_filter", False)),
        "volume_multiplier": float(raw.get("volume_multiplier", 1.5)),
        "trailing_stop_atr": float(raw.get("trailing_stop_atr", 0) or 0),
        "breakeven_at_r": float(raw.get("breakeven_at_r", 0) or 0),
        "max_holding_bars": int(raw.get("max_holding_bars", 0) or 0),
        "risk_per_trade_pct": float(raw.get("risk_per_trade_pct", 0) or 0),
        "max_concurrent_trades": int(raw.get("max_concurrent_trades", 1) or 1),
        "reentry_cooldown_bars": int(raw.get("reentry_cooldown_bars", 0) or 0),
    }


def filter_signals_by_direction(signals: list[dict], direction: str) -> list[dict]:
    if direction not in ("long", "short"):
        return signals
    return [s for s in signals if s.get("side") == direction]


def passes_volume_filter(df: pd.DataFrame, i: int, multiplier: float, window: int = 20) -> bool:
    if "volume" not in df.columns:
        return True
    avg = df["volume"].iloc[max(0, i - window):i].mean()
    if not np.isfinite(avg) or avg <= 0:
        return True
    return float(df.at[i, "volume"]) >= avg * multiplier


def simulate_exit(df: pd.DataFrame, entry_i: int, side: str, stop: float, take: float, *,
                   entry: float | None = None, trailing_stop_atr: float = 0,
                   breakeven_at_r: float = 0, max_holding_bars: int = 0,
                   atr_col: str = "atr") -> tuple[int, float, str]:
    """Walk bars forward from entry_i, applying an optional break-even move,
    ATR trailing stop and forced time exit, on top of the plain stop/take
    check shared by every strategy's exit loop. Stop is checked before take
    on a bar where both are touched (conservative assumption, unchanged).

    break-even and trailing both only ever tighten the stop (max() on longs,
    min() on shorts) and are evaluated using the current bar's favourable
    extreme before that bar's stop/take check, same lookahead convention the
    trailing stop already used."""
    exit_i = len(df) - 1
    exit_price = float(df.at[exit_i, "close"])
    reason = "end_of_period"
    trail_extreme = None
    initial_risk = abs(entry - stop) if (breakeven_at_r and entry is not None) else 0
    moved_to_breakeven = False
    for k in range(entry_i, len(df)):
        high, low = float(df.at[k, "high"]), float(df.at[k, "low"])
        if initial_risk and not moved_to_breakeven:
            favorable = (high - entry) if side == "long" else (entry - low)
            if favorable >= breakeven_at_r * initial_risk:
                stop = max(stop, entry) if side == "long" else min(stop, entry)
                moved_to_breakeven = True
        if trailing_stop_atr and atr_col in df.columns:
            atr_k = float(df.at[k, atr_col])
            if np.isfinite(atr_k) and atr_k > 0:
                if side == "long":
                    trail_extreme = high if trail_extreme is None else max(trail_extreme, high)
                    stop = max(stop, trail_extreme - trailing_stop_atr * atr_k)
                else:
                    trail_extreme = low if trail_extreme is None else min(trail_extreme, low)
                    stop = min(stop, trail_extreme + trailing_stop_atr * atr_k)
        hit_stop = low <= stop if side == "long" else high >= stop
        hit_take = high >= take if side == "long" else low <= take
        if hit_stop:
            exit_i, exit_price, reason = k, stop, "breakeven" if (moved_to_breakeven and abs(stop-entry)<1e-9) else "stop"
            break
        if hit_take:
            exit_i, exit_price, reason = k, take, "take"
            break
        if max_holding_bars and (k - entry_i + 1) >= max_holding_bars:
            exit_i, exit_price, reason = k, float(df.at[k, "close"]), "max_holding"
            break
    return exit_i, exit_price, reason


def summarize(trades: pd.DataFrame, params: dict | None=None) -> dict:
    params=params or {}
    starting_capital=float(params.get("starting_capital",1_000_000))
    lot_size=max(1,int(params.get("lot_size",1)))
    lot_count=max(1,int(params.get("lot_count",1)))
    shares=lot_size*lot_count
    risk_per_trade_pct=float(params.get("risk_per_trade_pct",0) or 0)
    if trades.empty:
        return {"trades":0,"wins":0,"losses":0,"win_rate":0,"profit_factor":0,"average_trade_pct":0,"compounded_return_pct":0,"max_drawdown_pct":0,"starting_capital_rub":starting_capital,"final_capital_rub":starting_capital,"lot_size":lot_size,"lot_count":lot_count,"shares_per_trade":shares,"rejected_for_capital":0}
    winners=trades.loc[trades["net_return"]>0,"net_return"]; losers=trades.loc[trades["net_return"]<=0,"net_return"]
    gross_loss=-losers.sum(); pf=float(winners.sum()/gross_loss) if gross_loss>0 else None
    equity_full=(1+trades["net_return"]).cumprod(); drawdown=equity_full/equity_full.cummax()-1
    capital=starting_capital; rejected=0; money_rows=[]
    has_stop=risk_per_trade_pct>0 and "stop_price" in trades.columns
    for _,row in trades.sort_values("entry_time").iterrows():
        trade_shares=shares
        if has_stop and pd.notna(row.get("stop_price")) and float(row["entry_price"])>0:
            stop_dist_pct=abs(float(row["entry_price"])-float(row["stop_price"]))/float(row["entry_price"])
            if stop_dist_pct>0:
                risk_amount=capital*risk_per_trade_pct
                sized=int(risk_amount/(stop_dist_pct*float(row["entry_price"])))
                lots=max(1,sized//lot_size)
                trade_shares=lots*lot_size
        notional=trade_shares*float(row["entry_price"])
        if notional>capital:
            rejected+=1; continue
        pnl=notional*float(row["net_return"]); capital+=pnl
        money_rows.append(capital)
    money_dd=0.0
    if money_rows:
        s=pd.Series(money_rows); money_dd=float((s/s.cummax()-1).min())
    return {"trades":int(len(trades)),"wins":int((trades["net_return"]>0).sum()),"losses":int((trades["net_return"]<=0).sum()),"win_rate":round(float((trades["net_return"]>0).mean())*100,2),"profit_factor":None if pf is None else round(pf,3),"average_trade_pct":round(float(trades["net_return"].mean())*100,4),"compounded_return_pct":round(float(equity_full.iloc[-1]-1)*100,3),"max_drawdown_pct":round(float(drawdown.min())*100,3),"money_max_drawdown_pct":round(money_dd*100,3),"starting_capital_rub":round(starting_capital,2),"final_capital_rub":round(capital,2),"money_return_pct":round((capital/starting_capital-1)*100,3),"lot_size":lot_size,"lot_count":lot_count,"shares_per_trade":shares,"risk_based_sizing":has_stop,"rejected_for_capital":rejected}


def save_run(results_dir: Path,strategy_name: str,source_file: str,params: dict,trades: pd.DataFrame) -> dict:
    run_id=uuid.uuid4().hex[:12]; run_dir=results_dir/run_id; run_dir.mkdir(parents=True,exist_ok=True)
    summary=summarize(trades,params); summary.update({"run_id":run_id,"strategy":strategy_name,"source_file":source_file,"params":params})
    trades.to_csv(run_dir/"trades.csv",index=False)
    (run_dir/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    return {"run_id":run_id,"summary":summary,"files":["trades.csv","summary.json"]}
