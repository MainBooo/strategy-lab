from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from datetime import date,timedelta,timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pandas as pd
from flask import Flask,jsonify,render_template,request,send_file,Response

import backtest_candles
import backtests_db as bdb
import binance_catalog
import charts_db as cdb
import market_data_store as mds
import market_data_sync as mds_sync
import replay_db as rdb
import replay_engine
from candle_api import get_candles,tick_availability
from feature_flags import has_feature
from downloader import download_binance_candles
from jobs import JobStore
from market_ticker import get_instrument_info,get_market_ticker,get_prices,get_realtime,realtime_config
from optimizer import run_batch,run_optimizer
from portfolio_engine import simulate_portfolio
from portfolio_store import PortfolioStore
from rate_limit import BoundedConcurrency,SlidingWindowLimiter,client_ip
import auth
import auth_db
import auth_routes
from sectors import PRESET_LABELS,QUOTE_ASSET_PRESETS,is_liquid,sector_for
from strategies.common import load_candles
from strategies.false_breakout import run_false_breakout
from strategies.head_shoulders import run_head_shoulders
from strategies.simple_strategies import RUNNERS,STRATEGY_CATALOG
from strategies.param_schema import full_schema,full_presets
import strategy_presets_db as spdb
from timeframes import ALL_TIMEFRAMES,NATIVE_TIMEFRAMES,BACKTEST_TIMEFRAMES,canonical,backtest_timeframe_label

BASE_DIR=Path(__file__).resolve().parent; DATA_DIR=BASE_DIR/"data"; RESULTS_DIR=BASE_DIR/"results"; STORAGE=BASE_DIR/"storage"
# STRATEGY_LAB_LOGS_DIR is the current name; MOEX_LAB_LOGS_DIR is read as a
# fallback so an existing production deployment's env var keeps working
# across this migration without an immediate manual rename.
LOGS_DIR=Path(os.environ.get("STRATEGY_LAB_LOGS_DIR") or os.environ.get("MOEX_LAB_LOGS_DIR") or BASE_DIR/"logs")
BACKTEST_CACHE_DIR=DATA_DIR/"backtest_cache"
DATA_DIR.mkdir(exist_ok=True);RESULTS_DIR.mkdir(exist_ok=True);STORAGE.mkdir(exist_ok=True);LOGS_DIR.mkdir(parents=True,exist_ok=True)
BACKTEST_CACHE_DIR.mkdir(exist_ok=True)
CATALOG_FILE=STORAGE/"binance_instruments.json"; PORTFOLIOS=PortfolioStore(STORAGE/"portfolios.json")
JOBS=JobStore(STORAGE/"jobs")
bdb.init_db(STORAGE/"backtests.db")
cdb.init_db(STORAGE/"charts.db")
spdb.init_db(STORAGE/"strategy_presets.db")
auth_db.init_db(STORAGE/"users.db")
auth_routes.configure(PORTFOLIOS)

# The candle cache (re-fetchable from Binance, unlike backtests/charts/replay
# data above) lives in its own directory, outside both the frontend source
# tree and STORAGE's "real user data" files, so a size-bounded cache can be
# cleared/relocated without touching anything a user would consider "their
# data". MARKET_CACHE_PATH can point this at any directory (e.g. a larger
# disk). Deliberately a NEW filename (binance_candles.db, not the old
# market_data.db) - the old file holds MOEX-schema rows that must never be
# reinterpreted as Binance data; it is left untouched on disk as a legacy
# backup, never read or moved by this process.
MARKET_CACHE_DIR=Path(os.environ.get("MARKET_CACHE_PATH") or (BASE_DIR/"cache"/"market-data"))
MARKET_CACHE_DIR.mkdir(parents=True,exist_ok=True)
mds.init_db(MARKET_CACHE_DIR/"binance_candles.db")
# Same reasoning as the candle cache above: replay_sessions' old schema
# (ticker/board/market/engine columns) is MOEX-specific and incompatible
# with the new symbol-only schema - a fresh file avoids either crashing on
# the old columns or silently misreading old MOEX replay sessions as if
# they were Binance ones. Old storage/replay.db is left untouched.
rdb.init_db(STORAGE/"replay_binance.db")

_CACHE_EVICTION_INTERVAL_SECONDS=6*3600
def _market_cache_eviction_loop():
    while True:
        try:
            mds.evict_if_needed(logger=logging.getLogger(__name__))
        except Exception:
            logging.getLogger(__name__).exception("Market data cache eviction loop failed")
        time.sleep(_CACHE_EVICTION_INTERVAL_SECONDS)
threading.Thread(target=_market_cache_eviction_loop,daemon=True).start()

CHART_SCREENSHOTS_DIR=STORAGE/"chart_screenshots"; CHART_SCREENSHOTS_DIR.mkdir(exist_ok=True)
# Legacy MOEX CSV -> market_data.db auto-import (legacy_candle_migration.py)
# is deliberately NOT run against the new Binance-schema store - those CSVs
# are old Russian-equity candles, never Binance data, and importing them
# here would corrupt the new schema with rows that only look superficially
# similar. The old CSVs and the old market_data.db stay on disk untouched,
# reachable only by that now-legacy, no-longer-invoked module.
# Every chart-layout/drawing/request row carries a user id - the "switched
# on later without another migration" this comment used to promise before
# accounts existed. A logged-in user now gets their own private namespace;
# an anonymous visitor still shares the single "local" namespace exactly
# like every visitor did before accounts existed (see charts_db.py and
# feature_flags.py docstrings) - not a per-anonymous-visitor namespace,
# since chart layouts never had a session concept to key one on before.
def _effective_user_id()->str:
    return auth.current_user_id() or "local"
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

# Accounts (see auth.py/auth_db.py) need a signed session cookie, which
# needs a stable SECRET_KEY - without one, every process restart would
# silently log every visitor out as the key regenerates. Falls back to a
# random per-process key (sessions just won't survive a restart) instead of
# refusing to start, since a dev checkout or the test suite has no .env -
# but it's loud about it so a real deployment notices the missing config
# instead of quietly losing sessions on every deploy. See .env.example.
_secret_key=os.environ.get("SECRET_KEY")
if not _secret_key:
    _secret_key=secrets.token_hex(32)
    logging.getLogger(__name__).warning(
        "SECRET_KEY is not set - using a random per-process key. Every restart will "
        "log all users out. Set SECRET_KEY in the environment for production (see .env.example)."
    )
app.secret_key=_secret_key
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Only demand HTTPS-only cookies when the app itself is told it's
    # behind a TLS-terminating proxy (see deploy/) - forcing Secure on a
    # plain-HTTP dev server would silently break every login (the browser
    # drops a Secure cookie sent over http://).
    SESSION_COOKIE_SECURE=os.environ.get("FORCE_HTTPS_COOKIES","").strip().lower() in ("1","true","yes"),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)

app.register_blueprint(auth_routes.auth_bp)

@app.context_processor
def _inject_auth_context():
    from csrf import ensure_csrf_token
    return {"csrf_token":ensure_csrf_token(),"current_user":auth.current_user()}

# Free public server, single box, 2 gunicorn workers x 4 threads (see
# moex-strategy-lab.service) - a handful of concurrent heavy computations
# (backtest/optimize/portfolio run/market-data sync) is expected, but
# unbounded concurrent heavy jobs would starve every other request on the
# box. HEAVY_OPS caps how many run at once; HEAVY_TRIGGER_LIMITER caps how
# often one IP can even ask to start one, so a user double/triple-clicking
# (or a script looping) a "Запустить" button can't spin up dozens of jobs
# before the first ones even finish. Both are in-process, not shared across
# the 2 workers - see rate_limit.py's module docstring for why that's an
# accepted, documented tradeoff for this deployment.
HEAVY_OPS=BoundedConcurrency(int(os.environ.get("MAX_CONCURRENT_HEAVY_JOBS","3")))
HEAVY_BUSY_MESSAGE="Сервер сейчас занят другими тяжёлыми расчётами. Попробуйте повторить запрос через несколько секунд."
HEAVY_TRIGGER_LIMITER=SlidingWindowLimiter(max_requests=20,window_seconds=60)
RATE_LIMIT_MESSAGE="Слишком много запросов. Подождите немного и повторите."

def _heavy_trigger_ok()->bool:
    return HEAVY_TRIGGER_LIMITER.allow(client_ip(request))

def heavy_sync(view):
    """For a heavy endpoint that computes synchronously in the request
    thread (unlike the job-queue endpoints, which acquire/release HEAVY_OPS
    around their background thread instead - see _run_heavy_job below)."""
    @wraps(view)
    def wrapped(*args,**kwargs):
        if not _heavy_trigger_ok():return jsonify({"error":RATE_LIMIT_MESSAGE}),429
        if not HEAVY_OPS.try_acquire():return jsonify({"error":HEAVY_BUSY_MESSAGE}),503
        try:return view(*args,**kwargs)
        finally:HEAVY_OPS.release()
    return wrapped

def _start_heavy_job(target,*args,**kwargs)->bool:
    """Non-blocking HEAVY_OPS acquire + background thread launch for the
    job-queue endpoints. Returns False (nothing started, slot not held) if
    the server is already at MAX_CONCURRENT_HEAVY_JOBS - the caller must
    respond with HEAVY_BUSY_MESSAGE in that case."""
    if not HEAVY_OPS.try_acquire():return False
    HEAVY_OPS.run_in_background(target,*args,**kwargs)
    return True


@app.errorhandler(Exception)
def _handle_unexpected_error(exc):
    """Last-resort catch for routes without their own try/except (most
    already return a specific {"error": ...} JSON on failure). Without this,
    an unhandled exception falls through to Flask's default 500 page, which
    with debug=False is a bare "Internal Server Error" - not useful to a
    public-beta user and not distinguishable from any other failure. Real
    HTTP errors (404 from abort(), etc.) pass through unchanged; only genuine
    unexpected exceptions get the generic message + full traceback in the
    server log."""
    from werkzeug.exceptions import HTTPException
    if isinstance(exc, HTTPException):
        return exc
    app.logger.exception("Unhandled error on %s %s", request.method, request.path)
    message = "Внутренняя ошибка сервера. Мы уже знаем о таких ошибках по логам — попробуйте повторить запрос позже."
    if request.path.startswith("/api/"):
        return jsonify({"error": message}), 500
    return message, 500


def catalog(refresh=False): return binance_catalog.load_catalog(CATALOG_FILE,refresh)

def ticker_from_file(name:str)->str: return Path(name).name.split("_")[0].upper()

def instrument_for(symbol:str)->dict|None: return binance_catalog.instrument_by_symbol(catalog(),symbol)

# lot_size/lot_count keep their historical names (and the `shares = lot_count
# * lot_size` formula throughout portfolio_engine.py/strategies/common.py is
# UNCHANGED) but now mean something different: lot_size is the symbol's
# Binance stepSize (the exchange's minimum quantity increment) instead of a
# MOEX LOTSIZE, and lot_count is how many of that increment to hold instead
# of how many round lots. `shares = lot_count * lot_size` is therefore still
# exactly the position's base-asset quantity, already floored to stepSize by
# construction (lot_count is always an integer) - this is spec's required
# "floor to stepSize, never round(2)" without touching the money-math code.
def step_size_for(symbol:str)->float:
    inst=instrument_for(symbol)
    step=inst.get("stepSize") if inst else None
    return float(step) if step and step>0 else 1.0

def run_strategy(strategy:str,source:Path,params:dict):
    ticker=ticker_from_file(source.name); params=dict(params or {}); params.setdefault("lot_size",step_size_for(ticker)); params.setdefault("lot_count",1); params.setdefault("starting_capital",10_000)
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

def enriched_catalog(refresh=False,quote_asset:str|None=None)->list[dict]:
    items=binance_catalog.search(catalog(refresh),quote_asset=quote_asset); idx=_local_data_index(); out=[]
    for item in items:
        symbol=str(item.get("symbol",""))
        local=idx.get(symbol)
        out.append({**item,
                     "SECTOR":sector_for(item.get("quoteAsset")),
                     "IS_LIQUID":is_liquid(item.get("status")),
                     "DATA_STATUS":_data_status(local["till"] if local else None),
                     "DATA_UPDATED_AT":local["till"] if local else None})
    return out

def _instrument_file_range(filename:str|None)->tuple[str,str]|None:
    """(from_date,till_date) actually covered by an instrument's pinned CSV,
    read straight from the TICKER_Nm_FROM_TILL.csv filename - the ground
    truth for "is there data for this period", independent of the catalog's
    DATA_STATUS freshness heuristic (which only tracks how recently the file
    was refreshed, not what range it covers)."""
    if not filename:return None
    m=FILENAME_RE.match(Path(filename).name)
    if not m:return None
    return m.group(3),m.group(4)

def _pinned_file_interval(filename:str|None)->int|None:
    """Interval-minutes baked into an instrument's pinned CSV filename
    (TICKER_Nm_FROM_TILL.csv) - the native granularity backtest_candles'
    get_or_build_source() compares the requested backtest timeframe against
    to decide whether that pinned file can be used as-is."""
    if not filename:return None
    m=FILENAME_RE.match(Path(filename).name)
    return int(m.group(2)) if m else None

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


def _enriched_strategy_catalog()->dict:
    return {sid:{**meta,"params":full_schema(sid),"presets":full_presets(sid)} for sid,meta in STRATEGY_CATALOG.items()}


@app.get("/")
def index():
    return render_template("index.html",
        defaults={"from_date":(date.today()-timedelta(days=365)).isoformat(),"till_date":date.today().isoformat()},
        # No static ticker->list presets exist for a dynamic Binance catalog
        # (spec: don't hand-roll the whole catalog) - quote_asset_presets
        # names the filter chips instead; the frontend catalog UI still
        # needs to switch from consuming security_presets to fetching
        # /api/securities?quoteAsset=... itself (tracked as follow-up work).
        strategies=_enriched_strategy_catalog(),security_presets={},preset_labels=PRESET_LABELS,
        quote_asset_presets=QUOTE_ASSET_PRESETS,realtime_config=realtime_config())

@app.get("/api/securities")
def securities():
    refresh=request.args.get("refresh")=="1"
    quote_asset=(request.args.get("quoteAsset") or request.args.get("quote_asset") or "").strip().upper() or None
    try:return jsonify(enriched_catalog(refresh,quote_asset=quote_asset))
    except Exception:
        app.logger.exception("Failed to load Binance instrument catalog (refresh=%s)",refresh)
        return jsonify({"error":"Справочник инструментов Binance временно недоступен. Попробуйте позже."}),500

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

@app.get("/api/market/realtime")
def market_realtime():
    """Normalized realtime/latency block for the chart indicator - see
    market_ticker.get_realtime() and docs/DYNAMIC_MARKET_DATA.md."""
    ticker=(request.args.get("ticker") or request.args.get("symbol") or "").strip().upper()
    if not ticker:return jsonify({"error":"Не указан тикер"}),400
    return jsonify(get_realtime(ticker))

@app.get("/api/securities/<ticker>/info")
def security_info(ticker):
    return jsonify(get_instrument_info(ticker.strip().upper()))

@app.get("/api/instruments/<symbol>/info")
def instrument_info(symbol):
    """Crypto-neutral name for /api/securities/<ticker>/info - same handler,
    same response shape. New frontend code should call this one."""
    return jsonify(get_instrument_info(symbol.strip().upper()))

@app.get("/api/strategies")
def strategies(): return jsonify(_enriched_strategy_catalog())

@app.get("/api/files")
def files():
    items=[]
    for p in sorted(DATA_DIR.glob("*.csv"),key=lambda x:x.stat().st_mtime,reverse=True):
        t=ticker_from_file(p.name); inst=instrument_for(t) or {}
        items.append({"name":p.name,"ticker":t,"shortname":inst.get("baseAsset",t),"lot_size":step_size_for(t),"size_kb":round(p.stat().st_size/1024,1)})
    return jsonify(items)

@app.post("/api/download-batch")
@heavy_sync
def download_batch():
    payload=request.get_json(force=True) or {}
    tickers=[str(x).upper() for x in payload.get("tickers",[]) if str(x).strip()]
    if not tickers:return jsonify({"error":"Не выбраны инструменты"}),400
    if not payload.get("from_date") or not payload.get("till_date"):
        return jsonify({"error":"Не указан диапазон дат"}),400
    rows=[]
    for ticker in tickers:
        filename=f"{ticker}_{int(payload.get('interval',10))}m_{payload['from_date']}_{payload['till_date']}.csv"
        if not FILENAME_RE.match(filename):
            # Ticker/date fields feed straight into a filesystem path below;
            # rejecting anything that doesn't match the plain
            # TICKER_Nm_YYYY-MM-DD_YYYY-MM-DD.csv shape blocks path
            # traversal via "../" or separators smuggled through those fields.
            return jsonify({"error":f"Некорректные параметры запроса для {ticker}"}),400
        info=download_binance_candles(ticker,int(payload.get("interval",10)),str(payload["from_date"]),str(payload["till_date"]),DATA_DIR/filename)
        rows.append({"ticker":ticker,"file":filename,"lot_size":step_size_for(ticker),**info})
    return jsonify({"ok":True,"rows":rows})

@app.post("/api/backtest")
@heavy_sync
def backtest():
    p=request.get_json(force=True) or {}
    if not p.get("file"):return jsonify({"error":"Не указан файл с данными"}),400
    if not p.get("strategy"):return jsonify({"error":"Не указана стратегия"}),400
    source=DATA_DIR/Path(str(p["file"])).name
    if not source.exists():return jsonify({"error":"Файл не найден"}),404
    try:return jsonify({"ok":True,**run_strategy(str(p["strategy"]),source,p.get("params",{}))})
    except Exception as exc:return jsonify({"error":str(exc)}),400

@app.post("/api/batch-backtest")
@heavy_sync
def batch_backtest():
    p=request.get_json(force=True); files=[DATA_DIR/Path(x).name for x in p.get("files",[])]
    rows=[]
    try:
        for source in files:
            result=run_strategy(p.get("strategy","false_breakout"),source,p.get("params",{}));rows.append({"file":source.name,**result["summary"]})
        return jsonify({"ok":True,"rows":rows})
    except Exception as exc:return jsonify({"error":str(exc)}),400

@app.post("/api/optimize")
@heavy_sync
def optimize():
    p=request.get_json(force=True) or {}
    if not p.get("file"):return jsonify({"error":"Не указан файл с данными"}),400
    source=DATA_DIR/Path(str(p["file"])).name
    if not source.exists():return jsonify({"error":"Файл не найден"}),404
    try:return jsonify({"ok":True,**run_optimizer(source,p.get("ranges",{}),RESULTS_DIR)})
    except Exception as exc:return jsonify({"error":str(exc)}),400

@app.get("/api/portfolios")
def portfolios(): return jsonify([p for p in PORTFOLIOS.list() if _portfolio_accessible(p)])

@app.post("/api/portfolios")
def create_portfolio(): return jsonify(PORTFOLIOS.create(request.get_json(force=True),user_id=auth.current_user_id()))

@app.get("/api/portfolios/<portfolio_id>")
def get_portfolio(portfolio_id):
    portfolio=PORTFOLIOS.get(portfolio_id)
    if not portfolio or not _portfolio_accessible(portfolio):return jsonify({"error":"Портфель не найден"}),404
    return jsonify(portfolio)

@app.get("/api/portfolios/<portfolio_id>/summary")
def portfolio_summary(portfolio_id):
    # There is no live/paper trading account in this app - "portfolio
    # balance" is the ending equity of the most recently *completed*
    # backtest run for this portfolio (backtest_runs.final_capital, already
    # computed by portfolio_engine.simulate_portfolio during that run).
    # Never fabricated: if no completed run exists yet, say so explicitly.
    portfolio=PORTFOLIOS.get(portfolio_id)
    if not portfolio or not _portfolio_accessible(portfolio):return jsonify({"error":"Портфель не найден"}),404
    rows,_=bdb.list_runs(portfolio_id=portfolio_id,status="completed",page=1,page_size=1)
    if not rows:
        rows,_=bdb.list_runs(portfolio_id=portfolio_id,status="completed_with_errors",page=1,page_size=1)
    if not rows:
        return jsonify({"has_run":False,"portfolio_id":portfolio_id,"portfolio_name":portfolio.get("name")})
    run=rows[0]
    return jsonify({
        "has_run":True,"portfolio_id":portfolio_id,"portfolio_name":portfolio.get("name"),
        "run_id":run["id"],"status":run["status"],"date_from":run.get("date_from"),"date_to":run.get("date_to"),
        "completed_at":run.get("completed_at"),
        "initial_capital":run.get("initial_capital"),"final_capital":run.get("final_capital"),
        "profit":run.get("profit"),"return_percent":run.get("return_percent"),"max_drawdown":run.get("max_drawdown"),
        "trades_count":run.get("trades_count"),
    })

def _portfolio_accessible(portfolio:dict,user_id:str|None="__unset__")->bool:
    """A portfolio with no owner (created before accounts existed, or by an
    anonymous visitor) stays visible/editable by anyone - unchanged from
    this app's original single-operator behavior. One with an owner is only
    accessible to that same logged-in user; everyone else gets exactly the
    same "not found" a nonexistent id would produce (see the account-system
    spec's IDOR requirement - existence is not confirmed either way).

    user_id defaults to the current Flask request's session (only valid
    called from a route handler, which always has a request context). A
    background job thread (see _run_heavy) has no request context by the
    time it runs - its call sites must capture auth.current_user_id() in the
    route *before* spawning the thread and pass it through explicitly."""
    if user_id=="__unset__":
        user_id=auth.current_user_id()
    owner=portfolio.get("user_id")
    return owner is None or owner==user_id

def _run_accessible(run:dict,user_id:str|None="__unset__")->bool:
    if user_id=="__unset__":
        user_id=auth.current_user_id()
    owner=run.get("user_id")
    return owner is None or owner==user_id

def _clean_strategy_parameters(strategy_id:str,raw:dict)->tuple[dict,str|None]:
    """Coerces a raw parameters dict to the types declared in that strategy's
    param schema, drops unknown keys, and rejects values that don't fit -
    so the backtest engine never receives NaN/wrong-typed values a UI form
    slipped through, regardless of which endpoint the save came through."""
    schema={f["key"]:f for f in full_schema(strategy_id)}
    cleaned={}
    for key,val in (raw or {}).items():
        field=schema.get(key)
        if not field:continue
        t=field["type"]
        try:
            if t in ("number","slider"):cleaned[key]=float(val)
            elif t=="checkbox":cleaned[key]=bool(val)
            elif t=="select":
                allowed={o["value"] for o in field.get("options",[])}
                if val not in allowed:return {},f"Недопустимое значение параметра «{key}»"
                cleaned[key]=val
            else:cleaned[key]=val
        except (TypeError,ValueError):
            return {},f"Некорректное значение параметра «{key}»"
    return cleaned,None

def _validate_and_clean_ticker_strategies(ts)->tuple[dict|None,str|None]:
    """Validates ticker_strategies (see portfolio_store.py schema v3+) and
    cleans each assignment's `parameters` in place via _clean_strategy_parameters,
    so saved portfolios never carry garbage the backtest engine would choke on."""
    if ts is None:return None,None
    if not isinstance(ts,dict):return None,"Некорректный формат назначения стратегий"
    for ticker,assignments in ts.items():
        if not isinstance(assignments,list):return None,f"Стратегии {ticker} должны быть списком"
        for a in assignments:
            sid=a.get("strategy_id") if isinstance(a,dict) else None
            if not sid or sid not in STRATEGY_CATALOG:return None,f"Неизвестная стратегия «{sid}» у {ticker}"
            cleaned,err=_clean_strategy_parameters(sid,a.get("parameters") or {})
            if err:return None,f"{err} ({sid} у {ticker})"
            a["parameters"]=cleaned
    return ts,None

def _quote_asset_conflict(tickers:list[str])->str|None:
    """Rejects a mixed-quote-asset set of symbols (spec §21). There is no FX
    conversion layer, so a portfolio mixing e.g. BTCUSDT (quote USDT) with
    ETHEUR (quote EUR) would silently sum/compare P&L across two currencies
    as if they were one. Unknown/unrecognized tickers are skipped here (they
    get their own "unknown instrument" error elsewhere) rather than treated
    as a conflict. Returns an error message, or None if every resolvable
    ticker shares one quote asset."""
    items=catalog()
    quote_by_ticker={}
    for t in tickers:
        info=binance_catalog.instrument_by_symbol(items,t)
        if info and info.get("quoteAsset"):quote_by_ticker[t]=info["quoteAsset"]
    quotes=sorted(set(quote_by_ticker.values()))
    if len(quotes)>1:
        detail=", ".join(f"{t} ({q})" for t,q in sorted(quote_by_ticker.items()))
        return (f"Инструменты портфеля торгуются в разных валютах котировки "
                f"({', '.join(quotes)}) - в этой версии нет конвертации курса, "
                f"поэтому смешивать их в одном портфеле нельзя: {detail}")
    return None

def _validate_portfolio_payload(payload:dict)->str|None:
    """Returns an error message, or None if the payload is acceptable."""
    instruments=payload.get("instruments")
    if instruments is not None:
        if not isinstance(instruments,list):return "Некорректный список инструментов"
        for inst in instruments:
            if not isinstance(inst,dict) or not inst.get("ticker") or not inst.get("file"):
                return "У каждого инструмента должны быть тикер и файл данных"
            if int(inst.get("lot_count") or 0)<0:return f"Количество лотов {inst['ticker']} не может быть отрицательным"
        conflict=_quote_asset_conflict([str(i["ticker"]) for i in instruments])
        if conflict:return conflict
    if "ticker_strategies" in payload:
        cleaned,err=_validate_and_clean_ticker_strategies(payload.get("ticker_strategies"))
        if err:return err
        payload["ticker_strategies"]=cleaned
    return None

@app.put("/api/portfolios/<portfolio_id>")
def put_portfolio(portfolio_id):
    existing=PORTFOLIOS.get(portfolio_id)
    if not existing or not _portfolio_accessible(existing):return jsonify({"error":"Портфель не найден"}),404
    payload=request.get_json(force=True) or {}
    err=_validate_portfolio_payload(payload)
    if err:return jsonify({"error":err}),400
    portfolio=PORTFOLIOS.replace(portfolio_id,payload)
    return jsonify(portfolio)

@app.delete("/api/portfolios/<portfolio_id>")
def delete_portfolio(portfolio_id):
    existing=PORTFOLIOS.get(portfolio_id)
    if not existing or not _portfolio_accessible(existing):return jsonify({"error":"Портфель не найден"}),404
    return jsonify({"ok":PORTFOLIOS.delete(portfolio_id)})

@app.delete("/api/portfolios/<portfolio_id>/instruments")
def portfolio_remove_instruments(portfolio_id):
    existing=PORTFOLIOS.get(portfolio_id)
    if not existing or not _portfolio_accessible(existing):return jsonify({"error":"Портфель не найден"}),404
    p=request.get_json(force=True) or {}
    tickers=[str(t).upper() for t in p.get("tickers",[])]
    if not tickers:return jsonify({"error":"Не указаны тикеры"}),400
    portfolio=PORTFOLIOS.remove_instruments(portfolio_id,tickers)
    if not portfolio:return jsonify({"error":"Портфель не найден"}),404
    return jsonify(portfolio)

@app.get("/api/portfolios/<portfolio_id>/data-coverage")
@heavy_sync
def portfolio_data_coverage(portfolio_id):
    """Whether each instrument's pinned data file actually covers the
    requested backtest period - checked against the real file range, not the
    catalog freshness label, so this never reports "no data" for a period
    that is already sitting in the CSV. Used right before a backtest run;
    portfolio creation/editing no longer surfaces data readiness at all.

    An optional ?timeframe= additionally checks whether that timeframe can
    honestly be served for each ticker (native data or aggregation from a
    strictly finer native base - see backtest_candles.py/timeframes.py).
    Omitted or "10m" (the pinned-file default): zero extra cost, identical
    to the pre-existing period-only behaviour. Any other value can trigger a
    real Binance sync attempt to know for sure - that is the only honest way to
    ever report a timeframe as unavailable rather than "not yet checked",
    which is why this route now carries @heavy_sync like the sibling
    download-data endpoint."""
    portfolio=PORTFOLIOS.get(portfolio_id)
    if not portfolio or not _portfolio_accessible(portfolio):return jsonify({"error":"Портфель не найден"}),404
    date_from=(request.args.get("date_from") or "").strip() or None
    date_to=(request.args.get("date_to") or "").strip() or None
    tickers_param=request.args.get("tickers")
    wanted=({t.strip().upper() for t in tickers_param.split(",") if t.strip()} if tickers_param else None)
    timeframe=(request.args.get("timeframe") or "").strip() or None
    check_timeframe=bool(timeframe) and canonical(timeframe)!=canonical("10m")
    tf_label=backtest_timeframe_label(timeframe) if timeframe else None

    items=[]
    for inst in portfolio.get("instruments",[]):
        ticker=str(inst.get("ticker"))
        if wanted is not None and ticker.upper() not in wanted:continue
        filename=inst.get("file")
        exists=bool(filename) and (DATA_DIR/Path(filename).name).exists()
        file_range=_instrument_file_range(filename) if exists else None
        missing_from=missing_to=None
        if not exists:
            covered=False
            missing_from,missing_to=date_from,date_to
        else:
            ffrom,ftill=file_range
            lo=date_from or ffrom;hi=date_to or ftill
            if hi<ffrom or lo>ftill:
                # requested window doesn't overlap the file at all
                covered=False
                missing_from,missing_to=date_from,date_to
            else:
                gap_from=date_from if(date_from and date_from<ffrom) else None
                gap_to=date_to if(date_to and date_to>ftill) else None
                covered=not(gap_from or gap_to)
                if not covered:
                    missing_from=gap_from or None
                    missing_to=gap_to or None
                    if gap_from and not gap_to:missing_to=ffrom
                    if gap_to and not gap_from:missing_from=ftill
        item={"ticker":ticker,"covered":covered,
              "file_from":file_range[0] if file_range else None,
              "file_till":file_range[1] if file_range else None,
              "missing_from":missing_from,"missing_to":missing_to}
        if check_timeframe:
            result=backtest_candles.fetch_full_range(
                symbol=ticker,timeframe=canonical(timeframe),
                date_from=date_from or (file_range[0] if file_range else None) or "",
                date_till=date_to or (file_range[1] if file_range else None) or "",
            )
            available=bool(result["candles"])
            item["timeframe_available"]=available
            item["timeframe_reason"]=None if available else f"Для {ticker} отсутствуют данные, необходимые для тестирования на {tf_label}."
        items.append(item)
    return jsonify({"items":items})

@app.post("/api/portfolios/<portfolio_id>/instruments/<ticker>/download-data")
@heavy_sync
def portfolio_instrument_download_data(portfolio_id,ticker):
    """Fetch just the missing history for one instrument already in a saved
    portfolio, triggered from the backtest tab's data-gap prompt. Merges with
    whatever range is already covered so the new file supersedes the old one
    without losing history, then repoints the instrument at it - lot_count,
    lot_size and everything else about the instrument stays untouched."""
    portfolio=PORTFOLIOS.get(portfolio_id)
    if not portfolio or not _portfolio_accessible(portfolio):return jsonify({"error":"Портфель не найден"}),404
    ticker=str(ticker).upper()
    instrument=next((i for i in portfolio.get("instruments",[]) if str(i.get("ticker")).upper()==ticker),None)
    if not instrument:return jsonify({"error":f"{ticker} отсутствует в портфеле"}),404

    p=request.get_json(force=True) or {}
    date_from=str(p.get("date_from") or "").strip()
    date_to=str(p.get("date_to") or "").strip()
    if not date_from or not date_to:return jsonify({"error":"Не указан период для загрузки"}),400
    try:
        date.fromisoformat(date_from);date.fromisoformat(date_to)
    except ValueError:return jsonify({"error":"Некорректный формат даты"}),400
    if date_from>date_to:return jsonify({"error":"Начало периода позже его окончания"}),400

    existing_range=_instrument_file_range(instrument.get("file"))
    existing_exists=bool(instrument.get("file")) and (DATA_DIR/Path(instrument["file"]).name).exists()
    if existing_range and existing_exists:
        from_date=min(date_from,existing_range[0]);till_date=max(date_to,existing_range[1])
    else:
        from_date,till_date=date_from,date_to

    interval=10
    filename=f"{ticker}_{interval}m_{from_date}_{till_date}.csv"
    if not FILENAME_RE.match(filename):
        # Same path-traversal guard as /api/download-batch - ticker/dates feed
        # straight into a filesystem path below.
        return jsonify({"error":f"Некорректные параметры запроса для {ticker}"}),400

    try:
        info=download_binance_candles(ticker,interval,from_date,till_date,DATA_DIR/filename)
    except Exception as exc:
        app.logger.exception("Instrument data download failed for %s in portfolio %s",ticker,portfolio_id)
        return jsonify({"error":f"Не удалось загрузить {ticker}: {exc}"}),502

    if info.get("rows",0)<MIN_CANDLES:
        return jsonify({"error":f"Недостаточно данных по {ticker}: {info.get('rows',0)} свечей (нужно от {MIN_CANDLES})"}),502

    updated=PORTFOLIOS.update_instrument_file(portfolio_id,ticker,filename)
    if not updated:return jsonify({"error":"Портфель не найден"}),404
    return jsonify({"ok":True,"ticker":ticker,"file":filename,"from":from_date,"till":till_date,"rows":info.get("rows")})

@app.patch("/api/portfolios/<portfolio_id>/strategies")
def portfolio_set_strategies(portfolio_id):
    existing=PORTFOLIOS.get(portfolio_id)
    if not existing or not _portfolio_accessible(existing):return jsonify({"error":"Портфель не найден"}),404
    p=request.get_json(force=True) or {}
    cleaned,err=_validate_and_clean_ticker_strategies(p.get("ticker_strategies"))
    if err:return jsonify({"error":err}),400
    portfolio=PORTFOLIOS.set_ticker_strategies(portfolio_id,p.get("default_strategy_id"),cleaned)
    if not portfolio:return jsonify({"error":"Портфель не найден"}),404
    return jsonify(portfolio)

@app.get("/api/strategy-presets/<strategy_id>")
def get_strategy_preset(strategy_id):
    if strategy_id not in STRATEGY_CATALOG:return jsonify({"error":"Неизвестная стратегия"}),404
    preset=spdb.get_preset(_effective_user_id(),strategy_id)
    return jsonify(preset or {"strategy_id":strategy_id,"parameters":None,"updated_at":None})

@app.put("/api/strategy-presets/<strategy_id>")
def put_strategy_preset(strategy_id):
    if strategy_id not in STRATEGY_CATALOG:return jsonify({"error":"Неизвестная стратегия"}),404
    p=request.get_json(force=True) or {}
    if not isinstance(p.get("parameters"),dict):return jsonify({"error":"parameters должен быть объектом"}),400
    cleaned,err=_clean_strategy_parameters(strategy_id,p["parameters"])
    if err:return jsonify({"error":err}),400
    return jsonify(spdb.save_preset(_effective_user_id(),strategy_id,cleaned))

@app.delete("/api/strategy-presets/<strategy_id>")
def delete_strategy_preset(strategy_id):
    if strategy_id not in STRATEGY_CATALOG:return jsonify({"error":"Неизвестная стратегия"}),404
    spdb.delete_preset(_effective_user_id(),strategy_id)
    return jsonify({"ok":True})


# ------------------------------------------------------- portfolio build --

def _execute_build_job(job_id:str,payload:dict)->None:
    tickers=payload["tickers"]; total=len(tickers)
    interval=int(payload.get("interval",10))
    from_date=str(payload.get("from_date") or (date.today()-timedelta(days=365)).isoformat())
    till_date=str(payload.get("till_date") or date.today().isoformat())
    allocation=payload.get("allocation") or {"mode":"equal_capital"}
    starting_capital=float(payload.get("starting_capital") or 10_000)

    conflict=_quote_asset_conflict(tickers)
    if conflict:
        JOBS.update(job_id,status="failed",stage="Разные валюты котировки",
                     error={"message":conflict,"ticker":None,"stage":"validate","code":"mixed_quote_asset"})
        return

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
                    if not FILENAME_RE.match(filename):
                        # Same guard as /api/download-batch - filename feeds
                        # straight into a filesystem path below.
                        raise ValueError(f"Некорректный тикер или диапазон дат для {ticker}")
                    download_binance_candles(ticker,interval,from_date,till_date,DATA_DIR/filename)
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

            prepared.append({"ticker":ticker,"file":filename,"lot_size":step_size_for(ticker),"_last_close":last_close})
            JOBS.update(job_id,completed=idx,percent=round(idx/total*100) if total else 100,errors=errors)

        if not prepared:
            JOBS.update(job_id,status="failed",stage="Нет данных для портфеля",
                         error={"message":"Не удалось подготовить ни одного инструмента.","ticker":None,"stage":"validate","code":"no_instruments"},
                         errors=errors)
            return

        JOBS.update(job_id,stage="Сохраняем инструменты",current_ticker=None)
        # "equal_lots" (a fixed round-lot count per instrument) doesn't map
        # onto crypto - default is "equal_capital" (spec §22: equal weights/
        # equal capital/manual). lot_size here is the symbol's Binance
        # stepSize (a small float, e.g. 0.00001 for BTCUSDT) - it must never
        # be int()-cast or floored to a minimum of 1 the way a MOEX LOTSIZE
        # was; lot_count (an integer count of that step) is what actually
        # gets floored, giving shares=lot_count*lot_size floored to stepSize.
        mode=str(allocation.get("mode","equal_capital"))
        manual_lots=allocation.get("lots") or {}
        n=len(prepared)
        for item in prepared:
            lot_size=max(1e-12,float(item["lot_size"]))
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
        existing_portfolio=PORTFOLIOS.get(portfolio_id) if portfolio_id else None
        if existing_portfolio and not _portfolio_accessible(existing_portfolio,payload.get("user_id")):
            JOBS.update(job_id,status="failed",stage="Портфель не найден",
                         error={"message":"Портфель не найден.","ticker":None,"stage":"validate","code":"not_found"},
                         errors=errors)
            return
        if existing_portfolio:
            existing_tickers=[str(i.get("ticker")) for i in existing_portfolio.get("instruments",[]) if i.get("ticker")]
            conflict=_quote_asset_conflict(existing_tickers+[item["ticker"] for item in prepared])
            if conflict:
                JOBS.update(job_id,status="failed",stage="Разные валюты котировки",
                             error={"message":conflict,"ticker":None,"stage":"validate","code":"mixed_quote_asset"},
                             errors=errors)
                return
            portfolio=PORTFOLIOS.add_instruments(portfolio_id,prepared)
        else:
            portfolio=PORTFOLIOS.create({
                "name":payload.get("name") or "Новый портфель",
                "starting_capital":starting_capital,
                "default_strategy_id":payload.get("default_strategy_id") or "false_breakout",
                "instruments":prepared,
            },user_id=payload.get("user_id"))

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
    user_id=auth.current_user_id()
    if portfolio_id:
        existing_portfolio=PORTFOLIOS.get(portfolio_id)
        if not existing_portfolio or not _portfolio_accessible(existing_portfolio,user_id):
            return jsonify({"error":"Портфель не найден"}),404
        portfolio_name=existing_portfolio["name"]
        active=JOBS.find_active_for_portfolio(portfolio_id,kind="build")
        if active:return jsonify({"job_id":active["job_id"],"status":active["status"]}),202

    if not _heavy_trigger_ok():return jsonify({"error":RATE_LIMIT_MESSAGE}),429
    job=JOBS.create(portfolio_id,portfolio_name,len(tickers),kind="build")
    if not _start_heavy_job(_execute_build_job,job["job_id"],{**p,"tickers":tickers,"user_id":user_id}):
        JOBS.update(job["job_id"],status="failed",stage="Сервер занят",
                     error={"message":HEAVY_BUSY_MESSAGE,"ticker":None,"stage":"busy","code":"server_busy"})
        return jsonify({"error":HEAVY_BUSY_MESSAGE}),503
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
                               "lot_size":float(instrument.get("lot_size") or step_size_for(ticker))})
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
    if not portfolio or not _portfolio_accessible(portfolio):return jsonify({"error":"Портфель не найден"}),404
    instruments=portfolio.get("instruments",[])
    if not instruments:return jsonify({"error":"В портфеле нет инструментов"}),400

    existing=JOBS.find_active_for_portfolio(portfolio_id,kind="portfolio_run")
    if existing:return jsonify({"job_id":existing["job_id"],"status":existing["status"]}),202

    if not _heavy_trigger_ok():return jsonify({"error":RATE_LIMIT_MESSAGE}),429
    job=JOBS.create(portfolio_id,portfolio.get("name",""),len(instruments),kind="portfolio_run")
    if not _start_heavy_job(_execute_portfolio_job,job["job_id"],portfolio):
        JOBS.update(job["job_id"],status="failed",stage="Сервер занят",
                     error={"message":HEAVY_BUSY_MESSAGE,"ticker":None,"stage":"busy","code":"server_busy"})
        return jsonify({"error":HEAVY_BUSY_MESSAGE}),503
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


def _execute_combo_backtest_job(job_id:str,portfolio:dict,combos:list[dict],date_from:str|None,date_till:str|None,run_id:str,timeframe:str|None=None)->None:
    from strategies.common import COMMISSION_SIDE
    tf=timeframe or "10m"
    tf_label=backtest_timeframe_label(tf)
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
            native_file=DATA_DIR/Path(instrument["file"]).name if instrument.get("file") else None
            source=backtest_candles.get_or_build_source(
                symbol=ticker,timeframe=tf,date_from=date_from,date_till=date_till,
                cache_dir=BACKTEST_CACHE_DIR,native_file=native_file,
                native_file_interval=_pinned_file_interval(instrument.get("file")),
            )
            if source is None:
                _record_failure(idx,ticker,strategy_id,strategy_name,combo,"load_data","timeframe_unavailable",
                                 f"Для {ticker} отсутствуют данные, необходимые для тестирования на {tf_label}."); continue

            lots=int(combo.get("lots") if combo.get("lots") is not None else instrument.get("lot_count",1))
            lot_size=float(instrument.get("lot_size") or step_size_for(ticker))
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
                            "signal_datetime":str(row["signal_time"]) if pd.notna(row.get("signal_time")) else None,
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
    if not portfolio or not _portfolio_accessible(portfolio):return jsonify({"error":"Портфель не найден"}),404
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

    timeframe=str(p.get("timeframe") or "10m")
    if canonical(timeframe) not in {canonical(t) for t in BACKTEST_TIMEFRAMES}:
        return jsonify({"error":f"Неизвестный таймфрейм: {timeframe}"}),400

    existing=JOBS.find_active_for_portfolio(portfolio_id,kind="backtest")
    if existing:return jsonify({"job_id":existing["job_id"],"status":existing["status"]}),202

    date_from=p.get("date_from"); date_to=p.get("date_to")
    run_id=bdb.new_run_id()
    bdb.create_run(run_id,portfolio_id,portfolio.get("name",""),date_from,date_to,
                    float(portfolio.get("starting_capital") or 10_000),len(combos),
                    {"tickers":tickers,"assignments":combos,"date_from":date_from,"date_to":date_to,"timeframe":timeframe},
                    user_id=auth.current_user_id(),timeframe=timeframe)

    if not _heavy_trigger_ok():return jsonify({"error":RATE_LIMIT_MESSAGE}),429
    job=JOBS.create(portfolio_id,portfolio.get("name",""),len(combos),kind="backtest",extra={"db_run_id":run_id})
    if not _start_heavy_job(_execute_combo_backtest_job,job["job_id"],portfolio,combos,date_from,date_to,run_id,timeframe):
        JOBS.update(job["job_id"],status="failed",stage="Сервер занят",
                     error={"message":HEAVY_BUSY_MESSAGE,"ticker":None,"stage":"busy","code":"server_busy"})
        bdb.finish_run(run_id,status="failed",error_message=HEAVY_BUSY_MESSAGE)
        return jsonify({"error":HEAVY_BUSY_MESSAGE}),503
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
                               page=page,page_size=page_size,user_id=auth.current_user_id(),owner_scope="mixed")
    return jsonify({"items":[_run_summary_dict(r) for r in rows],"total":total,"page":page,"page_size":page_size})

@app.get("/api/backtests/<run_id>")
def get_backtest(run_id):
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Запуск не найден"}),404
    return jsonify({**_run_summary_dict(run),"results":bdb.get_results(run_id)})

@app.get("/api/backtests/<run_id>/results")
def get_backtest_results(run_id):
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Запуск не найден"}),404
    return jsonify(bdb.get_results(run_id))

@app.get("/api/backtests/<run_id>/candles")
def get_backtest_candles(run_id):
    """Candles for the trade chart: the exact source the backtest engine
    actually read for this ticker - the pinned native file when the run was
    10m (byte-identical to the pre-existing behaviour), or the same honest
    aggregate/native-fetch backtest_candles.py built for a non-10m run -
    never a fresh ad-hoc fetch at a different granularity, so the chart can
    never disagree with the trades drawn on top of it."""
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Запуск не найден"}),404
    ticker=(request.args.get("ticker") or "").strip().upper()
    if not ticker:return jsonify({"error":"Не указан тикер"}),400
    portfolio=PORTFOLIOS.get(run["portfolio_id"])
    instrument_file=next((i["file"] for i in (portfolio or {}).get("instruments",[]) if i["ticker"]==ticker),None)
    native_file=DATA_DIR/Path(instrument_file).name if instrument_file else None
    tf=canonical(str(run.get("timeframe") or "10m"))
    source=backtest_candles.get_or_build_source(
        symbol=ticker,timeframe=tf,date_from=run.get("date_from"),date_till=run.get("date_to"),
        cache_dir=BACKTEST_CACHE_DIR,native_file=native_file,
        native_file_interval=_pinned_file_interval(instrument_file),
    )
    if source is None:
        return jsonify({"error":f"Котировки {ticker} на таймфрейме {backtest_timeframe_label(tf)} недоступны"}),404
    try:
        candles=load_candles(source,run.get("date_from"),run.get("date_to"))
    except Exception as exc:
        app.logger.exception("Failed to load candles for run %s/%s",run_id,ticker)
        return jsonify({"error":f"Не удалось прочитать котировки {ticker}: {exc}"}),500
    rows=[{"time":int(r["begin"].timestamp()),"open":float(r["open"]),"high":float(r["high"]),
           "low":float(r["low"]),"close":float(r["close"]),"volume":float(r["volume"]) if "volume" in candles.columns and pd.notna(r.get("volume")) else 0}
          for _,r in candles.iterrows()]
    return jsonify({"symbol":ticker,"candles":rows,"nextCursor":None})

@app.get("/api/backtests/<run_id>/trades")
def get_backtest_trades(run_id):
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Запуск не найден"}),404
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
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Сделка не найдена"}),404
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
        native_file=DATA_DIR/Path(instrument_file).name if instrument_file else None
        source=backtest_candles.get_or_build_source(
            symbol=trade["ticker"],timeframe=canonical(str(run.get("timeframe") or "10m")),
            date_from=run.get("date_from"),date_till=run.get("date_to"),cache_dir=BACKTEST_CACHE_DIR,
            native_file=native_file,native_file_interval=_pinned_file_interval(instrument_file),
        )
        if source is not None:
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
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Запуск не найден"}),404
    if not bdb.delete_run(run_id):return jsonify({"error":"Запуск не найден"}),404
    return jsonify({"ok":True})

@app.post("/api/backtests/<run_id>/repeat")
def repeat_backtest(run_id):
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Запуск не найден"}),404
    portfolio=PORTFOLIOS.get(run["portfolio_id"])
    if not portfolio or not _portfolio_accessible(portfolio):
        return jsonify({"error":"Портфель, к которому относится этот запуск, больше не существует"}),404
    config=json.loads(run["configuration_json"]) if run.get("configuration_json") else {}
    assignments=config.get("assignments") or []
    if not assignments:return jsonify({"error":"Не удалось восстановить конфигурацию запуска"}),400

    existing=JOBS.find_active_for_portfolio(portfolio["id"],kind="backtest")
    if existing:return jsonify({"job_id":existing["job_id"],"status":existing["status"]}),202

    timeframe=config.get("timeframe") or "10m"
    new_run_id=bdb.new_run_id()
    bdb.create_run(new_run_id,portfolio["id"],portfolio.get("name",""),config.get("date_from"),config.get("date_to"),
                    float(portfolio.get("starting_capital") or 10_000),len(assignments),config,
                    user_id=auth.current_user_id(),timeframe=timeframe)
    if not _heavy_trigger_ok():return jsonify({"error":RATE_LIMIT_MESSAGE}),429
    job=JOBS.create(portfolio["id"],portfolio.get("name",""),len(assignments),kind="backtest",extra={"db_run_id":new_run_id})
    if not _start_heavy_job(_execute_combo_backtest_job,job["job_id"],portfolio,assignments,
                             config.get("date_from"),config.get("date_to"),new_run_id,timeframe):
        JOBS.update(job["job_id"],status="failed",stage="Сервер занят",
                     error={"message":HEAVY_BUSY_MESSAGE,"ticker":None,"stage":"busy","code":"server_busy"})
        bdb.finish_run(new_run_id,status="failed",error_message=HEAVY_BUSY_MESSAGE)
        return jsonify({"error":HEAVY_BUSY_MESSAGE}),503
    return jsonify({"job_id":job["job_id"],"status":job["status"],"run_id":new_run_id,"combinations":len(assignments)}),202

@app.get("/api/backtests/<run_id>/export.json")
def export_backtest_json(run_id):
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Запуск не найден"}),404
    results=bdb.get_results(run_id)
    trades,_=bdb.list_trades(run_id,page=1,page_size=100000)
    payload=json.dumps({"run":_run_summary_dict(run),"results":results,"trades":trades},ensure_ascii=False,indent=2,default=str)
    return Response(payload,mimetype="application/json",
                     headers={"Content-Disposition":f'attachment; filename="backtest_{run_id}.json"'})

@app.get("/api/backtests/<run_id>/export.csv")
def export_backtest_csv(run_id):
    run=bdb.get_run(run_id)
    if not run or not _run_accessible(run):return jsonify({"error":"Запуск не найден"}),404
    trades,_=bdb.list_trades(run_id,page=1,page_size=100000)
    if not trades:
        return Response("no trades\n",mimetype="text/csv")
    df=pd.DataFrame(trades)
    import io
    buf=io.StringIO(); df.to_csv(buf,index=False)
    return Response(buf.getvalue(),mimetype="text/csv",
                     headers={"Content-Disposition":f'attachment; filename="backtest_{run_id}_trades.csv"'})


# ----------------------------------------------------------------- charts --

def _forbidden_feature(feature:str):
    return jsonify({"error":f"Функция «{feature}» недоступна."}),403

@app.get("/api/candles")
def api_candles():
    if not has_feature(_effective_user_id(),"CHART_ANALYSIS_ACCESS"):return _forbidden_feature("CHART_ANALYSIS_ACCESS")
    args=request.args
    symbol=(args.get("symbol") or args.get("ticker") or "").strip().upper()
    if not symbol:return jsonify({"error":"Не указан символ"}),400
    timeframe=args.get("timeframe","1d")
    till_date=args.get("to") or date.today().isoformat()
    # No `from` = "give me the tail of the full available history" (the
    # "Анализ графиков" default): the actual bar count is still bounded by
    # `limit` below via market_data_store.get_candles' ORDER BY ts DESC, so
    # this doesn't fetch more than requested - it only removes the old
    # 365-day floor that used to make hasOlder/nextCursor falsely report
    # "no more history" past a year back. candle_api._ensure_coverage caps
    # how much it'll backfill from Binance in a single request regardless
    # (see market_data_sync.sync_native_timeframe's max_pages).
    from_date=args.get("from") or mds_sync.EARLIEST_PLAUSIBLE_DATE
    try:
        # utcfromtimestamp, not fromtimestamp: a numeric cursor must resolve
        # to the same UTC calendar date regardless of the server's local
        # timezone - Binance is 24/7 UTC end to end, no MSK/local convention
        # applies here.
        from_date=date.fromtimestamp(int(from_date),tz=timezone.utc).isoformat() if from_date.isdigit() else from_date
        till_date=date.fromtimestamp(int(till_date),tz=timezone.utc).isoformat() if till_date.isdigit() else till_date
    except (ValueError,OSError):
        return jsonify({"error":"Некорректный диапазон дат"}),400
    try:limit=max(50,min(20000,int(args.get("limit",5000))))
    except ValueError:return jsonify({"error":"Некорректный limit"}),400
    before=args.get("before")
    try:before=int(before) if before else None
    except ValueError:return jsonify({"error":"Некорректный курсор before"}),400
    try:
        result=get_candles(DATA_DIR,symbol=symbol,timeframe=timeframe,from_date=from_date,
                             till_date=till_date,limit=limit,before=before)
    except ValueError as exc:
        return jsonify({"error":str(exc)}),400
    except Exception as exc:
        app.logger.exception("Candle lookup failed for %s/%s",symbol,timeframe)
        return jsonify({"error":f"Не удалось загрузить свечи {symbol}: {exc}"}),502
    return jsonify({"symbol":symbol,"timeframe":timeframe,**result})

@app.get("/api/chart/history")
def api_chart_history():
    """Spec-named alias for /api/candles - same handler, same response
    shape (candles, nextCursor, hasOlder, hasNewer, actualFrom/Till)."""
    return api_candles()

@app.get("/api/market-data/cache-stats")
def market_data_cache_stats():
    """Diagnostic-only, not linked from any user-facing page: bounded-cache
    size/config introspection for ops (see docs/DYNAMIC_MARKET_DATA.md)."""
    return jsonify(mds.cache_stats())

@app.get("/api/market-data/tick-coverage")
def market_data_tick_coverage():
    ticker=(request.args.get("ticker") or request.args.get("symbol") or "").strip().upper()
    if not ticker:return jsonify({"error":"Не указан символ"}),400
    return jsonify(tick_availability(ticker))

@app.get("/api/market-data/instruments")
def market_data_instruments():
    if not has_feature(_effective_user_id(),"CHART_ANALYSIS_ACCESS"):return _forbidden_feature("CHART_ANALYSIS_ACCESS")
    q=(request.args.get("q") or "").strip().upper()
    quote_asset=(request.args.get("quoteAsset") or request.args.get("quote_asset") or "").strip().upper() or None
    items_map:dict[str,dict]={}
    for it in binance_catalog.search(catalog(),quote_asset=quote_asset):
        symbol=str(it.get("symbol","")).strip()
        if not symbol:continue
        items_map[symbol]={"symbol":symbol,"base":it.get("baseAsset"),"quote":it.get("quoteAsset"),
                            "status":it.get("status"),"pricePrecision":it.get("quoteAssetPrecision"),
                            "quantityPrecision":it.get("baseAssetPrecision"),"stepSize":it.get("stepSize"),
                            "tickSize":it.get("tickSize"),"minNotional":it.get("minNotional"),
                            "timeframes":{},"last_synced_at":None}
    for r in mds.list_instruments_status():
        entry=items_map.setdefault(r["symbol"],{"symbol":r["symbol"],"base":None,"quote":None,"status":None,
                                                  "timeframes":{},"last_synced_at":None})
        entry["timeframes"][r["timeframe"]]={"candle_count":r["candle_count"],"earliest_ts":r["earliest_ts"],
                                              "latest_ts":r["latest_ts"],"status":r["status"],
                                              "progress_pct":r["progress_pct"],"last_error":r["last_error"]}
        if r["last_synced_at"] and (entry["last_synced_at"] is None or r["last_synced_at"]>entry["last_synced_at"]):
            entry["last_synced_at"]=r["last_synced_at"]
    items=list(items_map.values())
    if q:
        items=[it for it in items if q in it["symbol"] or q in str(it.get("base") or "")]
    items.sort(key=lambda it:(0 if it["timeframes"] else 1,it["symbol"]))
    return jsonify({"items":items,"native_timeframes":list(NATIVE_TIMEFRAMES),"all_timeframes":list(ALL_TIMEFRAMES)})

def _execute_market_data_sync_job(job_id:str,symbols:list[str],timeframes:list[str],mode:str)->None:
    total=len(symbols)*len(timeframes)
    JOBS.update(job_id,status="running",stage="Загрузка…",total=total)
    completed=0; errors=[]
    for symbol in symbols:
        if JOBS.is_cancel_requested(job_id):
            JOBS.update(job_id,status="canceled",stage="Остановлено пользователем");return
        for tf in timeframes:
            if JOBS.is_cancel_requested(job_id):
                JOBS.update(job_id,status="canceled",stage="Остановлено пользователем");return
            JOBS.update(job_id,current_ticker=f"{symbol} {tf}",stage=f"{symbol} · {tf}: подключение к Binance…")
            def _progress(pages,rows_added,span_from,span_till,_symbol=symbol,_tf=tf):
                JOBS.update(job_id,stage=f"{_symbol} · {_tf}: страница {pages}, +{rows_added} свечей")
            try:
                result=mds_sync.sync_native_timeframe(symbol,tf,mode=mode,progress_cb=_progress,
                    should_cancel=lambda:JOBS.is_cancel_requested(job_id))
                if result["status"]=="failed":
                    errors.append({"symbol":symbol,"timeframe":tf,"error":result["error"]})
                elif result["status"]=="canceled":
                    JOBS.update(job_id,status="canceled",stage="Остановлено пользователем");return
            except Exception as exc:
                app.logger.exception("market-data sync failed for %s/%s",symbol,tf)
                errors.append({"symbol":symbol,"timeframe":tf,"error":str(exc)})
            completed+=1
            JOBS.update(job_id,completed=completed,percent=round(100*completed/total,1) if total else 100)
    JOBS.update(job_id,status=("completed_with_errors" if errors else "completed"),
                stage="Готово",errors=errors,percent=100)

@app.post("/api/market-data/sync")
def market_data_sync_start():
    if not has_feature(_effective_user_id(),"CHART_ANALYSIS_ACCESS"):return _forbidden_feature("CHART_ANALYSIS_ACCESS")
    p=request.get_json(force=True) or {}
    tickers=[str(t).strip().upper() for t in p.get("tickers",[]) if str(t).strip()]
    if not tickers:return jsonify({"error":"Не выбраны инструменты"}),400
    timeframes=[str(t) for t in p.get("timeframes",[])] or list(NATIVE_TIMEFRAMES)
    bad_tf=[t for t in timeframes if t not in NATIVE_TIMEFRAMES]
    if bad_tf:return jsonify({"error":f"Эти таймфреймы не загружаются напрямую (агрегируются на лету): {', '.join(bad_tf)}"}),400
    mode=str(p.get("mode","initial")) if p.get("mode") in ("initial","continue","update") else "initial"
    total=len(tickers)*len(timeframes)
    label=f"Загрузка данных: {', '.join(tickers[:3])}{'…' if len(tickers)>3 else ''}"
    if not _heavy_trigger_ok():return jsonify({"error":RATE_LIMIT_MESSAGE}),429
    job=JOBS.create(None,label,total,kind="market_data_sync",
                     extra={"tickers":tickers,"timeframes":timeframes,"mode":mode})
    if not _start_heavy_job(_execute_market_data_sync_job,job["job_id"],tickers,timeframes,mode):
        JOBS.update(job["job_id"],status="failed",stage="Сервер занят",
                     error={"message":HEAVY_BUSY_MESSAGE,"ticker":None,"stage":"busy","code":"server_busy"})
        return jsonify({"error":HEAVY_BUSY_MESSAGE}),503
    return jsonify({"job_id":job["job_id"],"status":job["status"]}),202


# ------------------------------------------------------------ market replay --

def _replay_error(exc:replay_engine.ReplayError,code:int=400):
    return jsonify({"error":str(exc)}),code

@app.post("/api/replay/sessions")
def replay_create():
    if not has_feature(_effective_user_id(),"CHART_ANALYSIS_ACCESS"):return _forbidden_feature("CHART_ANALYSIS_ACCESS")
    p=request.get_json(force=True) or {}
    symbol=str(p.get("symbol") or p.get("ticker") or "").strip().upper()
    if not symbol:return jsonify({"error":"Не указан символ"}),400
    try:
        state=replay_engine.create_session(
            symbol=symbol,timeframe=str(p.get("timeframe","1m")),
            start_date=str(p.get("start_date")),start_hour=int(p.get("start_hour",10)),
            start_minute=int(p.get("start_minute",0)),
            starting_balance=float(p.get("starting_balance",10_000)),
            commission_rate=float(p.get("commission_rate",0.0005)),
            slippage_bps=float(p.get("slippage_bps",0)),speed=float(p.get("speed",1)),
            lot_size=float(p.get("lot_size") or step_size_for(symbol)))
    except replay_engine.ReplayError as exc:return _replay_error(exc)
    except (ValueError,TypeError) as exc:return jsonify({"error":f"Некорректные параметры: {exc}"}),400
    return jsonify(state),201

@app.get("/api/replay/sessions")
def replay_list():
    status=request.args.get("status")
    return jsonify([replay_engine.public_session(s) for s in rdb.list_sessions(status=status)])

@app.get("/api/replay/sessions/<session_id>")
def replay_get(session_id):
    session=rdb.get_session(session_id)
    if not session:return jsonify({"error":"Сессия не найдена"}),404
    return jsonify(replay_engine.visible_state(session))

@app.delete("/api/replay/sessions/<session_id>")
def replay_delete(session_id):
    if not rdb.delete_session(session_id):return jsonify({"error":"Сессия не найдена"}),404
    return jsonify({"ok":True})

@app.post("/api/replay/sessions/<session_id>/step")
def replay_step(session_id):
    p=request.get_json(silent=True) or {}
    try:return jsonify(replay_engine.step(session_id,bars=int(p.get("bars",1))))
    except replay_engine.ReplayError as exc:return _replay_error(exc,404 if "не найдена" in str(exc) else 400)

@app.post("/api/replay/sessions/<session_id>/back")
def replay_back(session_id):
    try:return jsonify(replay_engine.step_back(session_id))
    except replay_engine.ReplayError as exc:return _replay_error(exc,404 if "не найдена" in str(exc) else 400)

@app.post("/api/replay/sessions/<session_id>/goto")
def replay_goto(session_id):
    p=request.get_json(force=True) or {}
    try:
        return jsonify(replay_engine.goto(session_id,str(p.get("date")),int(p.get("hour",0)),int(p.get("minute",0))))
    except replay_engine.ReplayError as exc:return _replay_error(exc,404 if "не найдена" in str(exc) else 400)
    except (ValueError,TypeError) as exc:return jsonify({"error":f"Некорректная дата: {exc}"}),400

@app.post("/api/replay/sessions/<session_id>/reset")
def replay_reset(session_id):
    try:return jsonify(replay_engine.reset(session_id))
    except replay_engine.ReplayError as exc:return _replay_error(exc,404 if "не найдена" in str(exc) else 400)

@app.post("/api/replay/sessions/<session_id>/order")
def replay_order(session_id):
    p=request.get_json(force=True) or {}
    try:
        return jsonify(replay_engine.place_order(session_id,str(p.get("action")),int(p.get("lots",1)),
            stop_loss=float(p["stop_loss"]) if p.get("stop_loss") not in (None,"") else None,
            take_profit=float(p["take_profit"]) if p.get("take_profit") not in (None,"") else None))
    except replay_engine.ReplayError as exc:return _replay_error(exc,404 if "не найдена" in str(exc) else 400)
    except (ValueError,TypeError) as exc:return jsonify({"error":f"Некорректные параметры ордера: {exc}"}),400

@app.get("/api/replay/sessions/<session_id>/trades")
def replay_trades(session_id):
    if not rdb.get_session(session_id):return jsonify({"error":"Сессия не найдена"}),404
    return jsonify(rdb.list_trades(session_id))


@app.get("/api/chart-layouts")
def list_chart_layouts():
    if not has_feature(_effective_user_id(),"CHART_LAYOUTS"):return _forbidden_feature("CHART_LAYOUTS")
    return jsonify(cdb.list_layouts(_effective_user_id(),context=request.args.get("context"),symbol=request.args.get("symbol")))

@app.post("/api/chart-layouts")
def create_chart_layout():
    if not has_feature(_effective_user_id(),"CHART_LAYOUTS"):return _forbidden_feature("CHART_LAYOUTS")
    p=request.get_json(force=True) or {}
    if not p.get("name"):return jsonify({"error":"Укажите название шаблона"}),400
    layout=cdb.create_layout(_effective_user_id(),context=p.get("context","analysis"),name=p["name"],symbol=p.get("symbol"),
                               board=p.get("board"),timeframe=p.get("timeframe"),visible_from=p.get("visibleFrom"),
                               visible_to=p.get("visibleTo"),chart_type=p.get("chartType","candles"),
                               settings=p.get("settings"),indicators=p.get("indicators"),is_default=bool(p.get("isDefault")))
    return jsonify(layout),201

@app.get("/api/chart-layouts/<layout_id>")
def get_chart_layout(layout_id):
    if not has_feature(_effective_user_id(),"CHART_LAYOUTS"):return _forbidden_feature("CHART_LAYOUTS")
    layout=cdb.get_layout(layout_id,_effective_user_id())
    if not layout:return jsonify({"error":"Шаблон не найден"}),404
    return jsonify({**layout,"drawings":cdb.list_drawings(layout_id,_effective_user_id())})

@app.put("/api/chart-layouts/<layout_id>")
def update_chart_layout(layout_id):
    if not has_feature(_effective_user_id(),"CHART_LAYOUTS"):return _forbidden_feature("CHART_LAYOUTS")
    p=request.get_json(force=True) or {}
    layout=cdb.update_layout(layout_id,_effective_user_id(),name=p.get("name"),symbol=p.get("symbol"),board=p.get("board"),
                               timeframe=p.get("timeframe"),visible_from=p.get("visibleFrom"),visible_to=p.get("visibleTo"),
                               chart_type=p.get("chartType"),settings=p.get("settings"),indicators=p.get("indicators"),
                               is_default=p.get("isDefault"))
    if not layout:return jsonify({"error":"Шаблон не найден"}),404
    return jsonify(layout)

@app.delete("/api/chart-layouts/<layout_id>")
def delete_chart_layout(layout_id):
    if not has_feature(_effective_user_id(),"CHART_LAYOUTS"):return _forbidden_feature("CHART_LAYOUTS")
    if not cdb.delete_layout(layout_id,_effective_user_id()):return jsonify({"error":"Шаблон не найден"}),404
    return jsonify({"ok":True})


@app.get("/api/chart-layouts/<layout_id>/drawings")
def list_chart_drawings(layout_id):
    if not has_feature(_effective_user_id(),"CHART_DRAWINGS_BASIC"):return _forbidden_feature("CHART_DRAWINGS_BASIC")
    if not cdb.get_layout(layout_id,_effective_user_id()):return jsonify({"error":"Шаблон не найден"}),404
    return jsonify(cdb.list_drawings(layout_id,_effective_user_id()))

@app.post("/api/chart-layouts/<layout_id>/drawings")
def create_chart_drawing(layout_id):
    if not has_feature(_effective_user_id(),"CHART_DRAWINGS_BASIC"):return _forbidden_feature("CHART_DRAWINGS_BASIC")
    p=request.get_json(force=True) or {}
    if not p.get("type") or not p.get("points"):return jsonify({"error":"Не указан тип или точки объекта"}),400
    drawing=cdb.create_drawing(layout_id,_effective_user_id(),type=p["type"],symbol=p.get("symbol"),timeframe=p.get("timeframe"),
                                 points=p["points"],properties=p.get("properties"),locked=bool(p.get("locked")),
                                 hidden=bool(p.get("hidden")),z_index=int(p.get("zIndex",0)))
    if not drawing:return jsonify({"error":"Шаблон не найден"}),404
    return jsonify(drawing),201

@app.put("/api/chart-drawings/<drawing_id>")
def update_chart_drawing(drawing_id):
    if not has_feature(_effective_user_id(),"CHART_DRAWINGS_BASIC"):return _forbidden_feature("CHART_DRAWINGS_BASIC")
    p=request.get_json(force=True) or {}
    fields={}
    if "points" in p:fields["points"]=p["points"]
    if "properties" in p:fields["properties"]=p["properties"]
    if "locked" in p:fields["locked"]=p["locked"]
    if "hidden" in p:fields["hidden"]=p["hidden"]
    if "zIndex" in p:fields["z_index"]=p["zIndex"]
    drawing=cdb.update_drawing(drawing_id,_effective_user_id(),**fields)
    if not drawing:return jsonify({"error":"Объект не найден"}),404
    return jsonify(drawing)

@app.delete("/api/chart-drawings/<drawing_id>")
def delete_chart_drawing(drawing_id):
    if not has_feature(_effective_user_id(),"CHART_DRAWINGS_BASIC"):return _forbidden_feature("CHART_DRAWINGS_BASIC")
    if not cdb.delete_drawing(drawing_id,_effective_user_id()):return jsonify({"error":"Объект не найден"}),404
    return jsonify({"ok":True})


@app.post("/api/chart-screenshot")
def upload_chart_screenshot():
    """Stores a data: URL PNG exported by chart.takeScreenshot() so a strategy
    request can reference it as a file path instead of inlining megabytes of
    base64 into the request row."""
    if not has_feature(_effective_user_id(),"CHART_EXPORT"):return _forbidden_feature("CHART_EXPORT")
    p=request.get_json(force=True) or {}
    data_url=p.get("dataUrl","")
    if not data_url.startswith("data:image/png;base64,"):return jsonify({"error":"Ожидается PNG data URL"}),400
    import base64,uuid as _uuid
    raw=base64.b64decode(data_url.split(",",1)[1])
    if len(raw)>8_000_000:return jsonify({"error":"Скриншот слишком большой"}),400
    name=f"{_uuid.uuid4().hex[:16]}.png"
    (CHART_SCREENSHOTS_DIR/name).write_bytes(raw)
    return jsonify({"path":f"chart_screenshots/{name}"}),201

@app.get("/api/chart-screenshot/<name>")
def get_chart_screenshot(name):
    path=CHART_SCREENSHOTS_DIR/Path(name).name
    if not path.exists():return jsonify({"error":"Файл не найден"}),404
    return send_file(path)


@app.post("/api/chart-strategy-requests")
def create_chart_strategy_request():
    if not has_feature(_effective_user_id(),"CHART_STRATEGY_ORDER"):return _forbidden_feature("CHART_STRATEGY_ORDER")
    p=request.get_json(force=True) or {}
    if not (p.get("ideaDescription") or "").strip():return jsonify({"error":"Опишите торговую идею"}),400
    layout_id=p.get("layoutId")
    if layout_id and not cdb.get_layout(layout_id,_effective_user_id()):return jsonify({"error":"Шаблон не найден"}),404
    req=cdb.create_strategy_request(_effective_user_id(),layout_id=layout_id,symbol=p.get("symbol"),board=p.get("board"),
                                      timeframe=p.get("timeframe"),visible_from=p.get("visibleFrom"),visible_to=p.get("visibleTo"),
                                      drawings_snapshot=p.get("drawingsSnapshot"),indicators=p.get("indicators"),
                                      idea_description=p.get("ideaDescription"),entry_conditions=p.get("entryConditions"),
                                      exit_conditions=p.get("exitConditions"),stop_description=p.get("stopDescription"),
                                      take_description=p.get("takeDescription"),position_management=p.get("positionManagement"),
                                      risk_tolerance=p.get("riskTolerance"),comment=p.get("comment"),
                                      screenshot_path=p.get("screenshotPath"))
    return jsonify(req),201

@app.get("/api/chart-strategy-requests")
def list_chart_strategy_requests():
    if not has_feature(_effective_user_id(),"CHART_STRATEGY_ORDER"):return _forbidden_feature("CHART_STRATEGY_ORDER")
    return jsonify(cdb.list_strategy_requests(_effective_user_id()))


if __name__=="__main__":app.run(host="127.0.0.1",port=5050,debug=False)
