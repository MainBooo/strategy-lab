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


def summarize(trades: pd.DataFrame, params: dict | None=None) -> dict:
    params=params or {}
    starting_capital=float(params.get("starting_capital",1_000_000))
    lot_size=max(1,int(params.get("lot_size",1)))
    lot_count=max(1,int(params.get("lot_count",1)))
    shares=lot_size*lot_count
    if trades.empty:
        return {"trades":0,"wins":0,"losses":0,"win_rate":0,"profit_factor":0,"average_trade_pct":0,"compounded_return_pct":0,"max_drawdown_pct":0,"starting_capital_rub":starting_capital,"final_capital_rub":starting_capital,"lot_size":lot_size,"lot_count":lot_count,"shares_per_trade":shares,"rejected_for_capital":0}
    winners=trades.loc[trades["net_return"]>0,"net_return"]; losers=trades.loc[trades["net_return"]<=0,"net_return"]
    gross_loss=-losers.sum(); pf=float(winners.sum()/gross_loss) if gross_loss>0 else None
    equity_full=(1+trades["net_return"]).cumprod(); drawdown=equity_full/equity_full.cummax()-1
    capital=starting_capital; rejected=0; money_rows=[]
    for _,row in trades.sort_values("entry_time").iterrows():
        notional=shares*float(row["entry_price"])
        if notional>capital:
            rejected+=1; continue
        pnl=notional*float(row["net_return"]); capital+=pnl
        money_rows.append(capital)
    money_dd=0.0
    if money_rows:
        s=pd.Series(money_rows); money_dd=float((s/s.cummax()-1).min())
    return {"trades":int(len(trades)),"wins":int((trades["net_return"]>0).sum()),"losses":int((trades["net_return"]<=0).sum()),"win_rate":round(float((trades["net_return"]>0).mean())*100,2),"profit_factor":None if pf is None else round(pf,3),"average_trade_pct":round(float(trades["net_return"].mean())*100,4),"compounded_return_pct":round(float(equity_full.iloc[-1]-1)*100,3),"max_drawdown_pct":round(float(drawdown.min())*100,3),"money_max_drawdown_pct":round(money_dd*100,3),"starting_capital_rub":round(starting_capital,2),"final_capital_rub":round(capital,2),"money_return_pct":round((capital/starting_capital-1)*100,3),"lot_size":lot_size,"lot_count":lot_count,"shares_per_trade":shares,"rejected_for_capital":rejected}


def save_run(results_dir: Path,strategy_name: str,source_file: str,params: dict,trades: pd.DataFrame) -> dict:
    run_id=uuid.uuid4().hex[:12]; run_dir=results_dir/run_id; run_dir.mkdir(parents=True,exist_ok=True)
    summary=summarize(trades,params); summary.update({"run_id":run_id,"strategy":strategy_name,"source_file":source_file,"params":params})
    trades.to_csv(run_dir/"trades.csv",index=False)
    (run_dir/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    return {"run_id":run_id,"summary":summary,"files":["trades.csv","summary.json"]}
