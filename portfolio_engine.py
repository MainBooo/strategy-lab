from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path

import pandas as pd
from pandas.errors import EmptyDataError

log = logging.getLogger(__name__)


def _group_drawdown(trades: pd.DataFrame, starting_capital: float) -> float:
    """Worst dip (%) of one (ticker[, strategy]) group's own cumulative P&L,
    relative to total portfolio starting capital. Normalizing against the
    group's own peak P&L instead would divide by a near-zero value early on
    and produce meaningless four-digit percentages, so total capital is the
    stable, comparable-across-groups denominator (same units as the
    portfolio-level max_drawdown_pct)."""
    if starting_capital <= 0:
        return 0.0
    ordered = trades.sort_values("exit_time")
    cum = ordered["pnl_rub"].cumsum()
    if cum.empty:
        return 0.0
    running_peak = cum.cummax()
    worst_dip_rub = float((cum - running_peak).min())
    return worst_dip_rub / starting_capital * 100


def simulate_portfolio(portfolio: dict, run_results: list[dict], results_dir: Path) -> dict:
    """run_results[i] is one independent (ticker[, strategy_id]) trade stream:
    ``{"ticker","trades_path", "strategy_id"(optional), "lots"(optional),
    "lot_size"(optional)}``. When a ticker carries several strategies, each
    is its own stream competing for the same shared capital pool - they are
    never merged into one trade sequence. ``lots``/``lot_size`` fall back to
    ``portfolio["instruments"]`` when omitted, for the older single-strategy
    callers that don't pass them explicitly."""
    events=[]
    starting=float(portfolio.get("starting_capital",10_000))
    lot_map={str(x["ticker"]):int(x.get("lot_count",1)) for x in portfolio.get("instruments",[])}
    # lot_size is a Binance stepSize (e.g. 0.00001 for BTCUSDT), not a MOEX
    # LOTSIZE - must stay float; int()-casting would truncate any stepSize
    # below 1 to 0 and silently force whole-unit position sizes downstream.
    size_map={str(x["ticker"]):float(x.get("lot_size",1)) for x in portfolio.get("instruments",[])}
    has_strategy_dim=any(item.get("strategy_id") for item in run_results)

    for item in run_results:
        # A strategy run that found zero trades writes a header-less (0-byte)
        # trades.csv, which pandas treats as EmptyDataError rather than an
        # empty frame. Zero trades is a legitimate outcome, not a failure -
        # skip the group's contribution instead of crashing the whole batch.
        try:
            trades=pd.read_csv(item["trades_path"])
        except EmptyDataError:
            continue
        except (OSError, pd.errors.ParserError) as exc:
            log.warning("Unreadable trades file for %s at %s: %s",item.get("ticker"),item["trades_path"],exc)
            continue
        if trades.empty: continue
        ticker=item["ticker"]; strategy_id=item.get("strategy_id")
        label=f"{ticker}::{strategy_id}" if strategy_id else ticker
        lot_count=max(1,int(item.get("lots") if item.get("lots") is not None else lot_map.get(ticker,1)))
        lot_size=max(1e-12,float(item.get("lot_size") if item.get("lot_size") is not None else size_map.get(ticker,1)))
        fixed_shares=lot_count*lot_size
        # strategies.common.save_run persists the *actual* per-trade quantity
        # it priced each fill at (risk-based sizing when the strategy has
        # risk_per_trade_pct set, else the same fixed_shares below) as a
        # "position_shares" column. Reusing it here keeps this equity curve
        # consistent with the per-trade blotter and the per-instrument
        # summary card instead of silently re-flattening every trade back to
        # one fixed lot count when risk-based sizing was actually used.
        has_position_shares="position_shares" in trades.columns
        for idx,row in trades.iterrows():
            trade_id=f"{label}_{idx}_{uuid.uuid4().hex[:5]}"
            shares=float(row["position_shares"]) if has_position_shares and pd.notna(row["position_shares"]) else fixed_shares
            events.append((pd.to_datetime(row["entry_time"]),1,"entry",trade_id,ticker,strategy_id,shares,row.to_dict()))
            events.append((pd.to_datetime(row["exit_time"]),0,"exit",trade_id,ticker,strategy_id,shares,row.to_dict()))

    events.sort(key=lambda x:(x[0],x[1]))
    cash=starting; open_positions={}; realized=0.0; rejected=0; rows=[]; curve=[]
    for ts,_,kind,trade_id,ticker,strategy_id,shares,row in events:
        if kind=="entry":
            notional=shares*float(row["entry_price"])
            if notional>cash:
                rejected+=1; continue
            cash-=notional
            open_positions[trade_id]={"notional":notional,"ticker":ticker,"shares":shares,"row":row}
        else:
            pos=open_positions.pop(trade_id,None)
            if not pos: continue
            pnl=pos["notional"]*float(row["net_return"])
            cash+=pos["notional"]+pnl; realized+=pnl
            rows.append({"ticker":ticker,"strategy_id":strategy_id,"entry_time":row["entry_time"],"exit_time":row["exit_time"],"side":row.get("side"),"shares":shares,"entry_price":row["entry_price"],"exit_price":row["exit_price"],"net_return":row["net_return"],"pnl_rub":pnl,"capital_after_rub":cash})
        open_value=sum(p["notional"] for p in open_positions.values())
        curve.append({"time":ts,"cash":cash,"open_notional":open_value,"equity":cash+open_value})

    run_id="portfolio_"+uuid.uuid4().hex[:10]; run_dir=results_dir/run_id; run_dir.mkdir(parents=True,exist_ok=True)
    trades_df=pd.DataFrame(rows); curve_df=pd.DataFrame(curve)
    final=cash+sum(p["notional"] for p in open_positions.values())
    max_dd=0.0
    if not curve_df.empty:
        max_dd=float((curve_df["equity"]/curve_df["equity"].cummax()-1).min())
    by_ticker=[]
    if not trades_df.empty:
        group_cols=["ticker","strategy_id"] if has_strategy_dim else ["ticker"]
        for key,g in trades_df.groupby(group_cols,dropna=False):
            key_ticker,key_strategy=(key,None) if not has_strategy_dim else key
            by_ticker.append({"ticker":key_ticker,"strategy_id":key_strategy,"trades":len(g),
                               "pnl_rub":round(float(g["pnl_rub"].sum()),2),
                               "win_rate":round(float((g["pnl_rub"]>0).mean())*100,2),
                               "max_drawdown_pct":round(_group_drawdown(g,starting),3)})

    win_rate=0.0; profit_factor=None
    if not trades_df.empty:
        win_rate=round(float((trades_df["pnl_rub"]>0).mean())*100,2)
        gross_profit=float(trades_df.loc[trades_df["pnl_rub"]>0,"pnl_rub"].sum())
        gross_loss=-float(trades_df.loc[trades_df["pnl_rub"]<=0,"pnl_rub"].sum())
        profit_factor=round(gross_profit/gross_loss,3) if gross_loss>0 else None

    # Approximate, non-annualized-by-trading-calendar Sharpe on the equity
    # curve's step returns (bar frequency varies by instrument/interval, so
    # this is a rough risk-adjusted-return indicator, not a textbook figure).
    sharpe_ratio=0.0
    capital_utilization_pct=0.0
    if not curve_df.empty:
        step_returns=curve_df["equity"].pct_change().dropna()
        if len(step_returns)>1 and step_returns.std()>0:
            sharpe_ratio=round(float(step_returns.mean()/step_returns.std()*(252**0.5)),3)
        capital_utilization_pct=round(float(curve_df["open_notional"].mean()/starting*100),2)

    summary={"run_id":run_id,"portfolio_id":portfolio.get("id"),"portfolio_name":portfolio.get("name"),
             "starting_capital_rub":starting,"final_capital_rub":round(final,2),
             "return_pct":round((final/starting-1)*100,3),"max_drawdown_pct":round(max_dd*100,3),
             "trades":len(trades_df),"win_rate":win_rate,"profit_factor":profit_factor,
             "sharpe_ratio":sharpe_ratio,"capital_utilization_pct":capital_utilization_pct,
             "rejected_for_capital":rejected,"open_positions_end":len(open_positions),"by_ticker":by_ticker,
             "equity_curve":[{"time":str(c["time"]),"equity":round(c["equity"],2)} for c in curve[::max(1,len(curve)//200)]] if curve else []}
    trades_df.to_csv(run_dir/"portfolio_trades.csv",index=False); curve_df.to_csv(run_dir/"equity_curve.csv",index=False)
    (run_dir/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    return summary
