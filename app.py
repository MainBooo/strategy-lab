from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date,timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pandas as pd
from flask import Flask,jsonify,render_template,request,send_file,Response

import backtests_db as bdb
from downloader import download_moex_candles
from jobs import JobStore
from market_ticker import get_market_ticker,get_prices
from moex_catalog import load_catalog,security_by_ticker
from optimizer import run_batch,run_optimizer
from portfolio_engine import simulate_portfolio
from portfolio_store import PortfolioStore
from sectors import PRESET_LABELS,SECURITY_PRESETS,is_liquid,sector_for
from strategies.common import load_candles
from strategies.false_breakout import run_false_breakout
from strategies.head_shoulders import run_head_shoulders
from strategies.simple_strategies import RUNNERS,STRATEGY_CATALOG

BASE_DIR=Path(__file__).resolve().parent; DATA_DIR=BASE_DIR/"data"; RESULTS_DIR=BASE_DIR/"results"; STORAGE=BASE_DIR/"storage"
LOGS_DIR=Path(os.environ.get("MOEX_LAB_LOGS_DIR") or BASE_DIR/"logs")
DATA_DIR.mkdir(exist_ok=True);RESULTS_DIR.mkdir(exist_ok=True);STORAGE.mkdir(exist_ok=True);LOGS_DIR.mkdir(parents=True,exist_ok=True)
CATALOG_FILE=STORAGE/"securities_TQBR.json"; PORTFOLIOS=PortfolioStore(STORAGE/"portfolios.json")
JOBS=JobStore(STORAGE/"jobs")
bdb.init_db(STORAGE/"backtests.db")
# Real single-ticker backtests on a year of 10m candles take ~5-6s; 60s gives
# a wide safety margin so this only trips on a genuine hang, not normal load.
PORTFOLIO_INSTRUMENT_TIMEOUT=60
MIN_CANDLES=30
DATA_FRESHNESS_DAYS=3
FILENAME_RE=re.compile(r"^([A-Z0-9]+)_(\d+)m_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$")
app=Flask(__name__)

_handler=RotatingFileHandler(LOGS_DIR/"app.log",maxBytes=5_000_000,backupCount=3,encoding="utf-8")
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
app.logger.addHandler(_handler)
app.logger.setLevel(logging.INFO)


def catalog(refresh=False): return load_catalog(CATALOG_FILE,"TQBR",refresh)

def ticker_from_file(name:str)->str: return Path(name).name.split("_")[0].upper()

def lot_size_for(ticker:str)->int: return int(security_by_ticker(catalog(),ticker).get("LOTSIZE") or 1)

def run_strategy(strategy:str,source:Path,params:dict):
    ticker=ticker_from_file(source.name); params=dict(params or {}); params.setdefault("lot_size",lot_size_for(ticker)); params.setdefault("lot_count",1); params.setdefault("starting_capital",1_000_000)
    if strategy=="false_breakout": return run_false_breakout(source,params,RESULTS_DIR)
    if strategy=="head_shoulders": return run_head_shoulders(source,params,RESULTS_DIR)
    if strategy in RUNNERS: return RUNNERS[strategy](source,params,RESULTS_DIR)
    raise ValueError("Неизвестная стратегия")


# ---------------------------------------------------------------- catalog --

def _local_data_index()->dict[str,dict]:
    """ticker -> best local CSV (latest covered date, tie-broken by mtime)."""
    idx:dict[str,dict]={}
    for p in DATA_DIR.glob("*.csv"):
        m=FILENAME_RE.match(p.name)
        ticker=m.group(1) if m else ticker_from_file(p.name)
        interval=int(m.group(2)) if m else None
        till=m.group(4) if m else None
        mtime=p.stat().st_mtime
        cur=idx.get(ticker)
        if cur is None or (till or "")>(cur["till"] or "") or ((till or "")==(cur["till"] or "") and mtime>cur["mtime"]):
            idx[ticker]={"file":p.name,"interval":interval,"till":till,"mtime":mtime}
    return idx

def _data_status(till:str|None)->str:
    if not till:return "none"
    try:till_date=date.fromisoformat(till)
    except ValueError:return "fresh"
    return "fresh" if (date.today()-till_date).days<=DATA_FRESHNESS_DAYS else "stale"

def enriched_catalog(refresh=False)->list[dict]:
    items=catalog(refresh); idx=_local_data_index(); out=[]
    for item in items:
        ticker=str(item.get("SECID",""))
        local=idx.get(ticker)
        out.append({**item,
                     "SECTOR":sector_for(ticker),
                     "IS_LIQUID":is_liquid(ticker),
                     "DATA_STATUS":_data_status(local["till"] if local else None),
                     "DATA_UPDATED_AT":local["till"] if local else None})
    return out

def _find_reusable_file(ticker:str,interval:int,till_date:str)->str|None:
    idx=_local_data_index()
    local=idx.get(ticker)
    if not local or local.get("interval")!=interval or not local.get("till"):
        return None
    if (date.fromisoformat(till_date)-date.fromisoformat(local["till"])).days<=DATA_FRESHNESS_DAYS:
        return local["file"]
    return None

def _inspect_csv(path:Path)->tuple[int,float|None]:
    try:df=pd.read_csv(path,sep=None,engine="python")
    except Exception:return 0,None
    df.columns=[str(c).strip().lower() for c in df.columns]
    close_col="close" if "close" in df.columns else ("<close>" if "<close>" in df.columns else None)
    last_close=None
    if close_col and not df.empty:
        try:
            numeric=pd.to_numeric(df[close_col],errors="coerce").dropna()
            if len(numeric):last_close=float(numeric.iloc[-1])
        except (IndexError,ValueError):pass
    return len(df),last_close


@app.get("/")
def index():
    return render_template("index.html",
        defaults={"from_date":(date.today()-timedelta(days=365)).isoformat(),"till_date":date.today().isoformat()},
        strategies=STRATEGY_CATALOG,security_presets=SECURITY_PRESETS,preset_labels=PRESET_LABELS)

@app.get("/api/securities")
def securities():
    refresh=request.args.get("refresh")=="1"
    try:return jsonify(enriched_catalog(refresh))
    except Exception:
        app.logger.exception("Failed to load MOEX securities catalog (refresh=%s)",refresh)
        return jsonify({"error":"Справочник MOEX временно недоступен. Попробуйте позже."}),500

@app.get("/api/market-ticker")
def market_ticker_endpoint():
    return jsonify(get_market_ticker())

@app.get("/api/market/prices")
def market_prices():
    raw=request.args.get("tickers","")
    tickers=[t.strip().upper() for t in raw.split(",") if t.strip()] or None
    return jsonify(get_prices(tickers))

@app.get("/api/market/price/<ticker>")
def market_price_single(ticker):
    result=get_prices([ticker])
    quote=result["prices"].get(ticker.upper())
    if not quote:
        return jsonify({"ticker":ticker.upper(),"last":None,"error":result["error"] or "Цена недоступна"}),404
    return jsonify({**quote,"stale":result["stale"]})

@app.get("/api/strategies")
def strategies(): return jsonify(STRATEGY_CATALOG)

@app.get("/api/files")
def files():
    items=[]
    for p in sorted(DATA_DIR.glob("*.csv"),key=lambda x:x.stat().st_mtime,reverse=True):
        t=ticker_from_file(p.name); sec=security_by_ticker(catalog(),t)
        items.append({"name":p.name,"ticker":t,"shortname":sec.get("SHORTNAME",t),"lot_size":int(sec.get("LOTSIZE") or 1),"size_kb":round(p.stat().st_size/1024,1)})
    return jsonify(items)

@app.post("/api/download-batch")
def download_batch():
    payload=request.get_json(force=True); tickers=[str(x).upper() for x in payload.get("tickers",[]) if str(x).strip()]
    if not tickers:return jsonify({"error":"Не выбраны инструменты"}),400
    rows=[]
    for ticker in tickers:
        filename=f"{ticker}_{int(payload.get('interval',10))}m_{payload['from_date']}_{payload['till_date']}.csv"
        info=download_moex_candles(ticker,str(payload.get("board","TQBR")),int(payload.get("interval",10)),str(payload["from_date"]),str(payload["till_date"]),DATA_DIR/filename)
        sec=security_by_ticker(catalog(),ticker);rows.append({"ticker":ticker,"file":filename,"lot_size":int(sec.get("LOTSIZE") or 1),**info})
    return jsonify({"ok":True,"rows":rows})

@app.post("/api/backtest")
def backtest():
    p=request.get_json(force=True); source=DATA_DIR/Path(str(p["file"])).name
    if not source.exists():return jsonify({"error":"Файл не найден"}),404
    try:return jsonify({"ok":True,**run_strategy(str(p["strategy"]),source,p.get("params",{}))})
    except Exception as exc:return jsonify({"error":str(exc)}),400

@app.post("/api/batch-backtest")
def batch_backtest():
    p=request.get_json(force=True); files=[DATA_DIR/Path(x).name for x in p.get("files",[])]
    rows=[]
    try:
        for source in files:
            result=run_strategy(p.get("strategy","false_breakout"),source,p.get("params",{}));rows.append({"file":source.name,**result["summary"]})
        return jsonify({"ok":True,"rows":rows})
    except Exception as exc:return jsonify({"error":str(exc)}),400

@app.post("/api/optimize")
def optimize():
    p=request.get_json(force=True); source=DATA_DIR/Path(str(p["file"])).name
    try:return jsonify({"ok":True,**run_optimizer(source,p.get("ranges",{}),RESULTS_DIR)})
    except Exception as exc:return jsonify({"error":str(exc)}),400

@app.get("/api/portfolios")
def portfolios(): return jsonify(PORTFOLIOS.list())

@app.post("/api/portfolios")
def create_portfolio(): return jsonify(PORTFOLIOS.create(request.get_json(force=True)))

@app.get("/api/portfolios/<portfolio_id>")
def get_portfolio(portfolio_id):
    portfolio=PORTFOLIOS.get(portfolio_id)
    if not portfolio:return jsonify({"error":"Портфель не найден"}),404
    return jsonify(portfolio)

def _validate_portfolio_payload(payload:dict)->str|None:
    """Returns an error message, or None if the payload is acceptable."""
    instruments=payload.get("instruments")
    if instruments is not None:
        if not isinstance(instruments,list):return "Некорректный список инструментов"
        for inst in instruments:
            if not isinstance(inst,dict) or not inst.get("ticker") or not inst.get("file"):
                return "У каждого инструмента должны быть тикер и файл данных"
            if int(inst.get("lot_count") or 0)<0:return f"Количество лотов {inst['ticker']} не может быть отрицательным"
    ts=payload.get("ticker_strategies")
    if ts is not None:
        if not isinstance(ts,dict):return "Некорректный формат назначения стратегий"
        for ticker,assignments in ts.items():
            if not isinstance(assignments,list):return f"Стратегии {ticker} должны быть списком"
            for a in assignments:
                sid=a.get("strategy_id") if isinstance(a,dict) else None
                if sid and sid not in STRATEGY_CATALOG:return f"Неизвестная стратегия «{sid}» у {ticker}"
    return None

@app.put("/api/portfolios/<portfolio_id>")
def put_portfolio(portfolio_id):
    if not PORTFOLIOS.get(portfolio_id):return jsonify({"error":"Портфель не найден"}),404
    payload=request.get_json(force=True) or {}
    err=_validate_portfolio_payload(payload)
    if err:return jsonify({"error":err}),400
    portfolio=PORTFOLIOS.replace(portfolio_id,payload)
    return jsonify(portfolio)

@app.delete("/api/portfolios/<portfolio_id>")
def delete_portfolio(portfolio_id): return jsonify({"ok":PORTFOLIOS.delete(portfolio_id)})

@app.delete("/api/portfolios/<portfolio_id>/instruments")
def portfolio_remove_instruments(portfolio_id):
    p=request.get_json(force=True) or {}
    tickers=[str(t).upper() for t in p.get("tickers",[])]
    if not tickers:return jsonify({"error":"Не указаны тикеры"}),400
    portfolio=PORTFOLIOS.remove_instruments(portfolio_id,tickers)
    if not portfolio:return jsonify({"error":"Портфель не найден"}),404
    return jsonify(portfolio)

@app.patch("/api/portfolios/<portfolio_id>/strategies")
def portfolio_set_strategies(portfolio_id):
    p=request.get_json(force=True) or {}
    portfolio=PORTFOLIOS.set_ticker_strategies(portfolio_id,p.get("default_strategy_id"),p.get("ticker_strategies"))
    if not portfolio:return jsonify({"error":"Портфель не найден"}),404
    return jsonify(portfolio)


# ------------------------------------------------------- portfolio build --

def _execute_build_job(job_id:str,payload:dict)->None:
    tickers=payload["tickers"]; total=len(tickers)
    interval=int(payload.get("interval",10))
    from_date=str(payload.get("from_date") or (date.today()-timedelta(days=365)).isoformat())
    till_date=str(payload.get("till_date") or date.today().isoformat())
    board=str(payload.get("board","TQBR"))
    allocation=payload.get("allocation") or {"mode":"equal_lots"}
    starting_capital=float(payload.get("starting_capital") or 1_000_000)

    JOBS.update(job_id,status="running",stage="Проверяем локальные данные")
    prepared=[]; errors=[]
    try:
        for idx,ticker in enumerate(tickers,start=1):
            if JOBS.is_cancel_requested(job_id):
                app.logger.info("Build job %s cancelled by user before %s",job_id,ticker)
                JOBS.update(job_id,status="failed",stage="Отменено",
                            error={"message":"Формирование портфеля отменено пользователем.","ticker":ticker,"stage":"cancel","code":"cancelled"})
                JOBS.clear_cancel(job_id)
                return

            JOBS.update(job_id,current_ticker=ticker,stage="Проверяем локальные данные",
                        percent=round((idx-1)/total*100) if total else 0,errors=errors)

            filename=_find_reusable_file(ticker,interval,till_date)
            if not filename:
                JOBS.update(job_id,stage=f"Загружаем котировки: {ticker}")
                try:
                    filename=f"{ticker}_{interval}m_{from_date}_{till_date}.csv"
                    download_moex_candles(ticker,board,interval,from_date,till_date,DATA_DIR/filename)
                    app.logger.info("Build job %s: downloaded %s (%s)",job_id,ticker,filename)
                except Exception as exc:
                    app.logger.exception("Build job %s: download failed for %s",job_id,ticker)
                    errors.append({"ticker":ticker,"stage":"download","code":"download_error","message":f"Не удалось загрузить {ticker}: {exc}"})
                    JOBS.update(job_id,completed=idx,percent=round(idx/total*100) if total else 100,errors=errors)
                    continue

            JOBS.update(job_id,stage=f"Проверяем качество данных: {ticker}")
            rows,last_close=_inspect_csv(DATA_DIR/filename)
            if rows<MIN_CANDLES:
                errors.append({"ticker":ticker,"stage":"validate","code":"insufficient_data",
                                "message":f"Недостаточно данных по {ticker}: {rows} свечей (нужно от {MIN_CANDLES})"})
                JOBS.update(job_id,completed=idx,percent=round(idx/total*100) if total else 100,errors=errors)
                continue

            prepared.append({"ticker":ticker,"file":filename,"lot_size":lot_size_for(ticker),"_last_close":last_close})
            JOBS.update(job_id,completed=idx,percent=round(idx/total*100) if total else 100,errors=errors)

        if not prepared:
            JOBS.update(job_id,status="failed",stage="Нет данных для портфеля",
                         error={"message":"Не удалось подготовить ни одного инструмента.","ticker":None,"stage":"validate","code":"no_instruments"},
                         errors=errors)
            return

        JOBS.update(job_id,stage="Сохраняем инструменты",current_ticker=None)
        mode=str(allocation.get("mode","equal_lots"))
        manual_lots=allocation.get("lots") or {}
        n=len(prepared)
        for item in prepared:
            lot_size=max(1,int(item["lot_size"]))
            last_close=item.pop("_last_close",None)
            if mode=="manual":
                lot_count=max(1,int(manual_lots.get(item["ticker"],1)))
            elif mode=="equal_capital":
                per_ticker_capital=starting_capital/n
                lot_count=max(1,int(per_ticker_capital//(lot_size*last_close))) if last_close and last_close>0 else 1
            else:
                lot_count=max(1,int(allocation.get("lots_per_instrument",1)))
            item["lot_count"]=lot_count

        JOBS.update(job_id,stage="Формируем портфель")
        portfolio_id=payload.get("portfolio_id")
        if portfolio_id and PORTFOLIOS.get(portfolio_id):
            portfolio=PORTFOLIOS.add_instruments(portfolio_id,prepared)
        else:
            portfolio=PORTFOLIOS.create({
                "name":payload.get("name") or "Новый портфель",
                "starting_capital":starting_capital,
                "default_strategy_id":payload.get("default_strategy_id") or "false_breakout",
                "instruments":prepared,
            })

        JOBS.update(job_id,status="completed",stage="Готово",percent=100,completed=total,
                     portfolio_id=portfolio["id"],
                     result={"portfolio_id":portfolio["id"],"portfolio_name":portfolio["name"],
                              "instruments":len(portfolio["instruments"]),"added":len(prepared)},
                     errors=errors)
    except Exception:
        app.logger.exception("Build job %s crashed",job_id)
        JOBS.update(job_id,status="failed",stage="Внутренняя ошибка",
                     error={"message":"Внутренняя ошибка формирования портфеля. Подробности в логах сервера.","ticker":None,"stage":"internal","code":"internal_error"})
    finally:
        JOBS.clear_cancel(job_id)


@app.post("/api/portfolio/build")
def portfolio_build():
    p=request.get_json(force=True) or {}
    tickers=[str(x).upper() for x in p.get("tickers",[]) if str(x).strip()]
    if not tickers:return jsonify({"error":"Не выбраны инструменты"}),400
    portfolio_id=p.get("portfolio_id")
    portfolio_name=p.get("name") or ""
    if portfolio_id:
        existing_portfolio=PORTFOLIOS.get(portfolio_id)
        if not existing_portfolio:return jsonify({"error":"Портфель не найден"}),404
        portfolio_name=existing_portfolio["name"]
        active=JOBS.find_active_for_portfolio(portfolio_id,kind="build")
        if active:return jsonify({"job_id":active["job_id"],"status":active["status"]}),202

    job=JOBS.create(portfolio_id,portfolio_name,len(tickers),kind="build")
    threading.Thread(target=_execute_build_job,args=(job["job_id"],{**p,"tickers":tickers}),daemon=True).start()
    return jsonify({"job_id":job["job_id"],"status":job["status"]}),202


# --------------------------------------------------------- legacy backtest -

def _run_strategy_with_timeout(strategy:str,source:Path,params:dict,timeout:float=PORTFOLIO_INSTRUMENT_TIMEOUT)->dict:
    # run_strategy is pure-Python/pandas CPU work; a worker thread that hangs
    # (e.g. on pathological input) can't be killed, but bounding the wait
    # here still stops one bad ticker from blocking the whole job forever -
    # the orphaned thread finishes on its own and its result is discarded.
    with ThreadPoolExecutor(max_workers=1) as pool:
        future=pool.submit(run_strategy,strategy,source,params)
        try:
            return future.result(timeout=timeout)
        except TimeoutError:
            raise TimeoutError(f"Расчёт не уложился в {timeout:.0f} секунд")


def _execute_portfolio_job(job_id:str,portfolio:dict)->None:
    """Legacy single-strategy run kept for the old /run endpoint."""
    instruments=portfolio.get("instruments",[])
    total=len(instruments)
    JOBS.update(job_id,status="running",stage="Запуск расчёта")
    run_results=[]; ticker_errors=[]
    try:
        for idx,instrument in enumerate(instruments,start=1):
            ticker=str(instrument.get("ticker","?"))
            if JOBS.is_cancel_requested(job_id):
                app.logger.info("Portfolio job %s cancelled by user before %s",job_id,ticker)
                JOBS.update(job_id,status="failed",stage="Отменено",
                            error={"message":"Расчёт отменён пользователем.","ticker":ticker,"stage":"cancel","code":"cancelled"})
                JOBS.clear_cancel(job_id)
                return

            JOBS.update(job_id,current_ticker=ticker,stage=f"Расчёт стратегии: {ticker}",
                        percent=round((idx-1)/total*100) if total else 0)

            source=DATA_DIR/Path(instrument["file"]).name
            if not source.exists():
                app.logger.warning("Portfolio job %s: data file missing for %s (%s)",job_id,ticker,source)
                ticker_errors.append({"ticker":ticker,"stage":"load_data","code":"missing_file",
                                       "message":f"Файл с котировками {ticker} не найден. Скачайте данные заново."})
                JOBS.update(job_id,completed=idx,percent=round(idx/total*100) if total else 100)
                continue

            try:
                started=time.monotonic()
                params=dict(portfolio.get("params",{}))
                params.update({"lot_count":int(instrument.get("lot_count",1)),
                               "lot_size":int(instrument.get("lot_size") or lot_size_for(ticker))})
                result=_run_strategy_with_timeout(portfolio.get("default_strategy_id") or portfolio.get("strategy","false_breakout"),source,params)
                app.logger.info("Portfolio job %s: %s done in %.2fs, trades=%s",
                                 job_id,ticker,time.monotonic()-started,result["summary"]["trades"])
                trades_path=RESULTS_DIR/result["run_id"]/"trades.csv"
                run_results.append({"ticker":ticker,"trades_path":trades_path})
            except TimeoutError as exc:
                app.logger.error("Portfolio job %s: %s timed out: %s",job_id,ticker,exc)
                ticker_errors.append({"ticker":ticker,"stage":"strategy_run","code":"timeout","message":str(exc)})
            except Exception as exc:
                app.logger.exception("Portfolio job %s: %s failed",job_id,ticker)
                ticker_errors.append({"ticker":ticker,"stage":"strategy_run","code":"strategy_error",
                                       "message":f"Не удалось рассчитать {ticker}: {exc}"})

            JOBS.update(job_id,completed=idx,percent=round(idx/total*100) if total else 100)

        if not run_results:
            JOBS.update(job_id,status="failed",stage="Нет данных для расчёта",
                         error={"message":"Ни по одному инструменту не удалось получить результат.",
                                "ticker":None,"stage":"strategy_run","code":"no_results"},
                         ticker_errors=ticker_errors)
            return

        JOBS.update(job_id,stage="Сборка портфеля",current_ticker=None)
        summary=simulate_portfolio(portfolio,run_results,RESULTS_DIR)
        summary["ticker_errors"]=ticker_errors
        PORTFOLIOS.mark_backtested(portfolio["id"])
        JOBS.update(job_id,status="completed",stage="Готово",percent=100,completed=total,result=summary,error=None)
    except Exception:
        app.logger.exception("Portfolio job %s crashed",job_id)
        JOBS.update(job_id,status="failed",stage="Внутренняя ошибка",
                     error={"message":"Внутренняя ошибка расчёта портфеля. Подробности в логах сервера.",
                            "ticker":None,"stage":"internal","code":"internal_error"})
    finally:
        JOBS.clear_cancel(job_id)


@app.post("/api/portfolios/<portfolio_id>/run")
def run_portfolio(portfolio_id):
    portfolio=PORTFOLIOS.get(portfolio_id)
    if not portfolio:return jsonify({"error":"Портфель не найден"}),404
    instruments=portfolio.get("instruments",[])
    if not instruments:return jsonify({"error":"В портфеле нет инструментов"}),400

    existing=JOBS.find_active_for_portfolio(portfolio_id,kind="portfolio_run")
    if existing:return jsonify({"job_id":existing["job_id"],"status":existing["status"]}),202

    job=JOBS.create(portfolio_id,portfolio.get("name",""),len(instruments),kind="portfolio_run")
    threading.Thread(target=_execute_portfolio_job,args=(job["job_id"],portfolio),daemon=True).start()
    return jsonify({"job_id":job["job_id"],"status":job["status"]}),202


# --------------------------------------------- combinatorial ticker×strategy backtest --

def _resolve_combo_assignments(portfolio:dict,tickers:list[str],explicit_assignments:list[dict]|None)->list[dict]:
    """One entry per (ticker,strategy) combination to run independently.

    If the caller supplies ``assignments`` explicitly (used by "Повторить"
    to reproduce a past run exactly), that list is authoritative. Otherwise
    combos are derived from the portfolio's own stored, possibly multi-
    strategy-per-ticker configuration - a ticker with no enabled assignment
    falls back to a single combo using the portfolio's default strategy, so
    older single-strategy portfolios behave exactly as before."""
    if explicit_assignments:
        out=[]
        for a in explicit_assignments:
            ticker=str(a.get("ticker","")).upper()
            if not ticker:continue
            out.append({"ticker":ticker,"strategy_id":a.get("strategy_id"),"parameters":a.get("parameters") or {},"lots":a.get("lots")})
        return out
    instruments_by_ticker={str(i["ticker"]):i for i in portfolio.get("instruments",[])}
    ticker_strategies=portfolio.get("ticker_strategies") or {}
    default_strategy_id=portfolio.get("default_strategy_id") or portfolio.get("strategy") or "false_breakout"
    combos=[]
    for ticker in tickers:
        instrument=instruments_by_ticker.get(ticker)
        default_lots=int(instrument.get("lot_count",1)) if instrument else 1
        assignments=[a for a in (ticker_strategies.get(ticker) or []) if a.get("enabled",True)]
        if not assignments:
            assignments=[{"strategy_id":default_strategy_id,"parameters":{}}]
        for a in assignments:
            combos.append({"ticker":ticker,"strategy_id":a.get("strategy_id") or default_strategy_id,
                            "parameters":a.get("parameters") or {},
                            "lots":a.get("lots") if a.get("lots") is not None else default_lots})
    return combos


def _trade_excursions(candles:pd.DataFrame,entry_time,exit_time,entry_price:float,side:str)->tuple[float|None,float|None]:
    """MAE/MFE (%) computed from the same OHLC candles the backtest already
    used, over the bars actually spanned by the trade - never fabricated."""
    try:
        window=candles[(candles["begin"]>=entry_time)&(candles["begin"]<=exit_time)]
        if window.empty or not entry_price:return None,None
        if side=="long":
            mfe=(float(window["high"].max())-entry_price)/entry_price*100
            mae=(float(window["low"].min())-entry_price)/entry_price*100
        else:
            mfe=(entry_price-float(window["low"].min()))/entry_price*100
            mae=(entry_price-float(window["high"].max()))/entry_price*100
        return round(mae,3),round(mfe,3)
    except Exception:
        return None,None


def _execute_combo_backtest_job(job_id:str,portfolio:dict,combos:list[dict],date_from:str|None,date_till:str|None,run_id:str)->None:
    from strategies.common import COMMISSION_SIDE
    total=len(combos)
    instruments_by_ticker={str(i["ticker"]):i for i in portfolio.get("instruments",[])}
    JOBS.update(job_id,status="running",stage="Запуск бэктеста",total=total)
    run_results=[]; ticker_errors=[]; ticker_meta={}
    ok=0; failed=0; candles_cache:dict[str,pd.DataFrame]={}

    def _candles_for(ticker:str,source:Path)->pd.DataFrame:
        if ticker not in candles_cache:
            try:candles_cache[ticker]=load_candles(source,date_from,date_till)
            except Exception:candles_cache[ticker]=pd.DataFrame()
        return candles_cache[ticker]

    def _record_failure(idx:int,ticker:str,strategy_id:str|None,strategy_name:str,combo:dict,stage:str,code:str,message:str):
        nonlocal failed
        failed+=1
        ticker_errors.append({"ticker":ticker,"strategy_id":strategy_id,"stage":stage,"code":code,"message":message})
        bdb.add_result(run_id,ticker=ticker,strategy_id=strategy_id or "unknown",strategy_name_snapshot=strategy_name,
                        parameters_json=json.dumps(combo.get("parameters") or {},ensure_ascii=False),lots=combo.get("lots"),
                        lot_size=None,starting_price=None,ending_price=None,trades_count=0,profit=None,return_percent=None,
                        win_rate=None,profit_factor=None,max_drawdown=None,status="failed",error_message=message,
                        duration_seconds=None,strategy_run_id=None)
        JOBS.update(job_id,completed=idx,percent=round(idx/total*100) if total else 100)

    try:
        for idx,combo in enumerate(combos,start=1):
            ticker=combo["ticker"]; strategy_id=combo.get("strategy_id")
            strategy_name=STRATEGY_CATALOG.get(strategy_id,{}).get("name",strategy_id or "?")

            if JOBS.is_cancel_requested(job_id):
                app.logger.info("Backtest job %s cancelled by user before %s/%s",job_id,ticker,strategy_id)
                bdb.finish_run(run_id,status="canceled",combinations_ok=ok,combinations_failed=failed,
                                error_message="Отменено пользователем")
                JOBS.update(job_id,status="canceled",stage="Отменено",
                            error={"message":"Бэктест отменён пользователем.","ticker":ticker,"stage":"cancel","code":"cancelled"})
                JOBS.clear_cancel(job_id)
                return

            JOBS.update(job_id,current_ticker=ticker,current_strategy=strategy_name,
                        stage=f"Бэктест: {ticker} — {strategy_name}",percent=round((idx-1)/total*100) if total else 0)

            if not strategy_id or strategy_id not in STRATEGY_CATALOG:
                _record_failure(idx,ticker,strategy_id,strategy_name,combo,"validate","unknown_strategy",f"Стратегия «{strategy_id}» не найдена."); continue
            instrument=instruments_by_ticker.get(ticker)
            if not instrument:
                _record_failure(idx,ticker,strategy_id,strategy_name,combo,"validate","not_in_portfolio",f"{ticker} отсутствует в портфеле."); continue
            source=DATA_DIR/Path(instrument["file"]).name
            if not source.exists():
                _record_failure(idx,ticker,strategy_id,strategy_name,combo,"load_data","missing_file",f"Файл с котировками {ticker} не найден. Скачайте данные заново."); continue

            lots=int(combo.get("lots") if combo.get("lots") is not None else instrument.get("lot_count",1))
            lot_size=int(instrument.get("lot_size") or lot_size_for(ticker))
            params=dict(portfolio.get("params") or {}); params.update(combo.get("parameters") or {})
            params.update({"lot_count":lots,"lot_size":lot_size,"date_from":date_from,"date_till":date_till})

            try:
                started=time.monotonic()
                result=_run_strategy_with_timeout(strategy_id,source,params)
                duration=time.monotonic()-started
                app.logger.info("Backtest job %s: %s (%s) done in %.2fs, trades=%s",job_id,ticker,strategy_id,duration,result["summary"]["trades"])
                trades_path=RESULTS_DIR/result["run_id"]/"trades.csv"
                run_results.append({"ticker":ticker,"strategy_id":strategy_id,"trades_path":trades_path,"lots":lots,"lot_size":lot_size})
                ticker_meta[(ticker,strategy_id)]={"strategy_name":strategy_name,"run_id":result["run_id"]}

                summary=result.get("summary",{})
                trades_df=pd.read_csv(trades_path) if trades_path.exists() else pd.DataFrame()
                starting_price=ending_price=None
                trades_rows=[]
                if not trades_df.empty:
                    starting_price=float(trades_df.iloc[0]["entry_price"]); ending_price=float(trades_df.iloc[-1]["exit_price"])
                    candles=_candles_for(ticker,source)
                    shares=lots*lot_size
                    for _,row in trades_df.iterrows():
                        entry_price=float(row["entry_price"]); side=str(row.get("side","long"))
                        net_return=float(row["net_return"]); gross_return=net_return+2*COMMISSION_SIDE
                        notional=shares*entry_price
                        mae=mfe=None
                        if not candles.empty:
                            mae,mfe=_trade_excursions(candles,pd.to_datetime(row["entry_time"]),pd.to_datetime(row["exit_time"]),entry_price,side)
                        trades_rows.append({
                            "direction":side,"entry_datetime":str(row["entry_time"]),"entry_price":entry_price,
                            "exit_datetime":str(row["exit_time"]),"exit_price":float(row["exit_price"]),
                            "quantity_lots":lots,"quantity_shares":shares,
                            "gross_profit":round(notional*gross_return,2),"commission":round(notional*2*COMMISSION_SIDE,2),
                            "net_profit":round(notional*net_return,2),"return_percent":round(net_return*100,4),
                            "stop_loss":row.get("stop_price"),"take_profit":row.get("take_price"),
                            "exit_reason":row.get("exit_reason"),
                            "signal_metadata":{"mae_pct":mae,"mfe_pct":mfe,"bars_held":row.get("bars_held")},
                        })
                profit=(float(summary["final_capital_rub"])-float(summary["starting_capital_rub"])) if summary.get("final_capital_rub") is not None else None
                result_id=bdb.add_result(run_id,ticker=ticker,strategy_id=strategy_id,strategy_name_snapshot=strategy_name,
                                          parameters_json=json.dumps(params,ensure_ascii=False,default=str),lots=lots,lot_size=lot_size,
                                          starting_price=starting_price,ending_price=ending_price,trades_count=int(summary.get("trades",0)),
                                          profit=profit,return_percent=summary.get("money_return_pct"),win_rate=summary.get("win_rate"),
                                          profit_factor=summary.get("profit_factor"),max_drawdown=summary.get("money_max_drawdown_pct"),
                                          status="ok",error_message=None,duration_seconds=round(duration,3),strategy_run_id=result["run_id"])
                bdb.add_trades(run_id,result_id,ticker,strategy_id,trades_rows)
                ok+=1
                JOBS.update(job_id,completed=idx,percent=round(idx/total*100) if total else 100)
            except TimeoutError as exc:
                app.logger.error("Backtest job %s: %s/%s timed out: %s",job_id,ticker,strategy_id,exc)
                _record_failure(idx,ticker,strategy_id,strategy_name,combo,"strategy_run","timeout",str(exc))
            except Exception as exc:
                app.logger.exception("Backtest job %s: %s/%s failed",job_id,ticker,strategy_id)
                _record_failure(idx,ticker,strategy_id,strategy_name,combo,"strategy_run","strategy_error",f"Не удалось рассчитать {ticker} ({strategy_id}): {exc}")

        if not run_results:
            bdb.finish_run(run_id,status="failed",combinations_ok=0,combinations_failed=failed,
                            error_message="Ни по одной комбинации тикер+стратегия не удалось получить результат.")
            JOBS.update(job_id,status="failed",stage="Нет данных для расчёта",
                         error={"message":"Ни по одной комбинации тикер+стратегия не удалось получить результат.","ticker":None,"stage":"strategy_run","code":"no_results"},
                         ticker_errors=ticker_errors)
            return

        JOBS.update(job_id,stage="Сборка портфельного отчёта",current_ticker=None,current_strategy=None)
        summary=simulate_portfolio(portfolio,run_results,RESULTS_DIR)
        for row in summary.get("by_ticker",[]):
            meta=ticker_meta.get((row["ticker"],row.get("strategy_id")),{})
            row["strategy_name"]=meta.get("strategy_name")
            row["run_id"]=meta.get("run_id")

        by_strategy:dict[str,dict]={}
        for row in summary.get("by_ticker",[]):
            sid=row.get("strategy_id") or "—"
            g=by_strategy.setdefault(sid,{"strategy_id":sid,"strategy_name":row.get("strategy_name") or sid,
                                           "tickers":0,"trades":0,"pnl_rub":0.0,"win_rates":[]})
            g["tickers"]+=1; g["trades"]+=row["trades"]; g["pnl_rub"]+=row["pnl_rub"]; g["win_rates"].append(row["win_rate"])
        summary["by_strategy"]=[{**{k:v for k,v in g.items() if k!="win_rates"},"pnl_rub":round(g["pnl_rub"],2),
                                  "avg_win_rate":round(sum(g["win_rates"])/len(g["win_rates"]),2) if g["win_rates"] else 0}
                                 for g in by_strategy.values()]
        summary["ticker_errors"]=ticker_errors
        summary["combinations_ok"]=ok; summary["combinations_failed"]=failed; summary["run_id_db"]=run_id
        PORTFOLIOS.mark_backtested(portfolio["id"])
        bdb.finish_run(run_id,status="completed_with_errors" if failed else "completed",
                        final_capital=summary["final_capital_rub"],profit=summary["final_capital_rub"]-summary["starting_capital_rub"],
                        return_percent=summary["return_pct"],max_drawdown=summary["max_drawdown_pct"],trades_count=summary["trades"],
                        combinations_ok=ok,combinations_failed=failed)
        JOBS.update(job_id,status="completed_with_errors" if failed else "completed",stage="Готово",percent=100,
                    completed=total,result=summary,error=None)
    except Exception:
        app.logger.exception("Backtest job %s crashed",job_id)
        bdb.finish_run(run_id,status="failed",combinations_ok=ok,combinations_failed=failed,
                        error_message="Внутренняя ошибка бэктеста")
        JOBS.update(job_id,status="failed",stage="Внутренняя ошибка",
                     error={"message":"Внутренняя ошибка бэктеста. Подробности в логах сервера.","ticker":None,"stage":"internal","code":"internal_error"})
    finally:
        JOBS.clear_cancel(job_id)


@app.post("/api/portfolios/<portfolio_id>/backtest")
def portfolio_backtest(portfolio_id):
    portfolio=PORTFOLIOS.get(portfolio_id)
    if not portfolio:return jsonify({"error":"Портфель не найден"}),404
    p=request.get_json(force=True) or {}
    all_tickers=[str(i["ticker"]) for i in portfolio.get("instruments",[])]

    explicit_assignments=p.get("assignments")
    if not explicit_assignments:
        requested=[str(t).upper() for t in (p.get("tickers") or all_tickers)]
        tickers=[t for t in requested if t in all_tickers]
        if not tickers:return jsonify({"error":"Не выбраны инструменты для бэктеста"}),400
    else:
        tickers=None

    combos=_resolve_combo_assignments(portfolio,tickers or [],explicit_assignments)
    if not combos:return jsonify({"error":"Нет ни одной комбинации тикер+стратегия для расчёта"}),400
    for combo in combos:
        if combo["ticker"] not in all_tickers:
            return jsonify({"error":f"{combo['ticker']} отсутствует в портфеле"}),400

    existing=JOBS.find_active_for_portfolio(portfolio_id,kind="backtest")
    if existing:return jsonify({"job_id":existing["job_id"],"status":existing["status"]}),202

    date_from=p.get("date_from"); date_to=p.get("date_to")
    run_id=bdb.new_run_id()
    bdb.create_run(run_id,portfolio_id,portfolio.get("name",""),date_from,date_to,
                    float(portfolio.get("starting_capital") or 1_000_000),len(combos),
                    {"tickers":tickers,"assignments":combos,"date_from":date_from,"date_to":date_to})

    job=JOBS.create(portfolio_id,portfolio.get("name",""),len(combos),kind="backtest",extra={"db_run_id":run_id})
    threading.Thread(target=_execute_combo_backtest_job,args=(job["job_id"],portfolio,combos,date_from,date_to,run_id),daemon=True).start()
    return jsonify({"job_id":job["job_id"],"status":job["status"],"run_id":run_id,"combinations":len(combos)}),202


@app.get("/api/jobs/<job_id>")
def job_status(job_id):
    job=JOBS.get(job_id)
    if not job:return jsonify({"error":"Задача не найдена"}),404
    return jsonify(job)


@app.post("/api/jobs/<job_id>/cancel")
def job_cancel(job_id):
    if not JOBS.request_cancel(job_id):return jsonify({"error":"Задача не найдена"}),404
    return jsonify({"ok":True})

@app.get("/api/result/<run_id>/<filename>")
def result_file(run_id,filename):
    matches=list(RESULTS_DIR.rglob(f"{Path(run_id).name}/{Path(filename).name}"))
    if not matches:return jsonify({"error":"Файл не найден"}),404
    return send_file(matches[0],as_attachment=True)


# ------------------------------------------------------------- backtest history --

def _run_summary_dict(run:dict)->dict:
    return {**run,"configuration":json.loads(run["configuration_json"]) if run.get("configuration_json") else None}

@app.get("/api/backtests")
def list_backtests():
    args=request.args
    try:page=int(args.get("page",1)); page_size=int(args.get("page_size",20))
    except ValueError:return jsonify({"error":"Некорректные параметры пагинации"}),400
    rows,total=bdb.list_runs(portfolio_id=args.get("portfolio_id") or None,ticker=args.get("ticker") or None,
                               strategy_id=args.get("strategy_id") or None,status=args.get("status") or None,
                               date_from=args.get("date_from") or None,date_to=args.get("date_to") or None,
                               page=page,page_size=page_size)
    return jsonify({"items":[_run_summary_dict(r) for r in rows],"total":total,"page":page,"page_size":page_size})

@app.get("/api/backtests/<run_id>")
def get_backtest(run_id):
    run=bdb.get_run(run_id)
    if not run:return jsonify({"error":"Запуск не найден"}),404
    return jsonify({**_run_summary_dict(run),"results":bdb.get_results(run_id)})

@app.get("/api/backtests/<run_id>/results")
def get_backtest_results(run_id):
    if not bdb.get_run(run_id):return jsonify({"error":"Запуск не найден"}),404
    return jsonify(bdb.get_results(run_id))

@app.get("/api/backtests/<run_id>/trades")
def get_backtest_trades(run_id):
    if not bdb.get_run(run_id):return jsonify({"error":"Запуск не найден"}),404
    args=request.args
    try:page=int(args.get("page",1)); page_size=int(args.get("page_size",50))
    except ValueError:return jsonify({"error":"Некорректные параметры пагинации"}),400
    profitable=args.get("profitable")
    profitable_bool={"true":True,"false":False}.get(profitable) if profitable else None
    rows,total=bdb.list_trades(run_id,ticker=args.get("ticker") or None,strategy_id=args.get("strategy_id") or None,
                                 direction=args.get("direction") or None,profitable=profitable_bool,
                                 exit_reason=args.get("exit_reason") or None,date_from=args.get("date_from") or None,
                                 date_to=args.get("date_to") or None,page=page,page_size=page_size)
    return jsonify({"items":rows,"total":total,"page":page,"page_size":page_size})

@app.get("/api/backtests/<run_id>/trades/<int:trade_id>")
def get_backtest_trade(run_id,trade_id):
    trade=bdb.get_trade(trade_id)
    if not trade or trade["backtest_run_id"]!=run_id:return jsonify({"error":"Сделка не найдена"}),404
    trade=dict(trade); trade["signal_metadata"]=json.loads(trade.get("signal_metadata_json") or "{}")
    # A small window of the same OHLC candles used for the backtest, so the
    # trade card can show real context around entry/exit without a chart
    # library - no fabricated data.
    result=next((r for r in bdb.get_results(run_id) if r["ticker"]==trade["ticker"] and r["strategy_id"]==trade["strategy_id"]),None)
    candles_window=[]
    if result and result.get("strategy_run_id"):
        instrument_file=next((i["file"] for p in PORTFOLIOS.list() for i in p.get("instruments",[]) if i["ticker"]==trade["ticker"]),None)
        if instrument_file:
            source=DATA_DIR/Path(instrument_file).name
            if source.exists():
                try:
                    candles=load_candles(source)
                    entry_ts=pd.to_datetime(trade["entry_datetime"]); exit_ts=pd.to_datetime(trade["exit_datetime"])
                    window=candles[(candles["begin"]>=entry_ts-pd.Timedelta(hours=6))&(candles["begin"]<=exit_ts+pd.Timedelta(hours=6))]
                    candles_window=[{"time":str(r["begin"]),"open":r["open"],"high":r["high"],"low":r["low"],"close":r["close"]} for _,r in window.iterrows()]
                except Exception:
                    app.logger.exception("Could not build candle window for trade %s",trade_id)
    trade["candles"]=candles_window[:200]
    return jsonify(trade)

@app.delete("/api/backtests/<run_id>")
def delete_backtest(run_id):
    if not bdb.delete_run(run_id):return jsonify({"error":"Запуск не найден"}),404
    return jsonify({"ok":True})

@app.post("/api/backtests/<run_id>/repeat")
def repeat_backtest(run_id):
    run=bdb.get_run(run_id)
    if not run:return jsonify({"error":"Запуск не найден"}),404
    portfolio=PORTFOLIOS.get(run["portfolio_id"])
    if not portfolio:return jsonify({"error":"Портфель, к которому относится этот запуск, больше не существует"}),404
    config=json.loads(run["configuration_json"]) if run.get("configuration_json") else {}
    assignments=config.get("assignments") or []
    if not assignments:return jsonify({"error":"Не удалось восстановить конфигурацию запуска"}),400

    existing=JOBS.find_active_for_portfolio(portfolio["id"],kind="backtest")
    if existing:return jsonify({"job_id":existing["job_id"],"status":existing["status"]}),202

    new_run_id=bdb.new_run_id()
    bdb.create_run(new_run_id,portfolio["id"],portfolio.get("name",""),config.get("date_from"),config.get("date_to"),
                    float(portfolio.get("starting_capital") or 1_000_000),len(assignments),config)
    job=JOBS.create(portfolio["id"],portfolio.get("name",""),len(assignments),kind="backtest",extra={"db_run_id":new_run_id})
    threading.Thread(target=_execute_combo_backtest_job,
                      args=(job["job_id"],portfolio,assignments,config.get("date_from"),config.get("date_to"),new_run_id),
                      daemon=True).start()
    return jsonify({"job_id":job["job_id"],"status":job["status"],"run_id":new_run_id,"combinations":len(assignments)}),202

@app.get("/api/backtests/<run_id>/export.json")
def export_backtest_json(run_id):
    run=bdb.get_run(run_id)
    if not run:return jsonify({"error":"Запуск не найден"}),404
    results=bdb.get_results(run_id)
    trades,_=bdb.list_trades(run_id,page=1,page_size=100000)
    payload=json.dumps({"run":_run_summary_dict(run),"results":results,"trades":trades},ensure_ascii=False,indent=2,default=str)
    return Response(payload,mimetype="application/json",
                     headers={"Content-Disposition":f'attachment; filename="backtest_{run_id}.json"'})

@app.get("/api/backtests/<run_id>/export.csv")
def export_backtest_csv(run_id):
    if not bdb.get_run(run_id):return jsonify({"error":"Запуск не найден"}),404
    trades,_=bdb.list_trades(run_id,page=1,page_size=100000)
    if not trades:
        return Response("no trades\n",mimetype="text/csv")
    df=pd.DataFrame(trades)
    import io
    buf=io.StringIO(); df.to_csv(buf,index=False)
    return Response(buf.getvalue(),mimetype="text/csv",
                     headers={"Content-Disposition":f'attachment; filename="backtest_{run_id}_trades.csv"'})

if __name__=="__main__":app.run(host="127.0.0.1",port=5050,debug=False)
