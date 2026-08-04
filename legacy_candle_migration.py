from __future__ import annotations

"""One-off importer: pulls candles already sitting in the old CSV
locations (data/*.csv from the portfolio pipeline, data/chart_cache/*.csv
from the old per-request chart cache) into market_data_store, so history a
user already downloaded before this migration isn't silently discarded or
re-fetched from MOEX again.

Idempotent (upsert dedups on the (ticker, board, timeframe, ts) primary
key) and additive-only - never deletes the source CSVs, they stay exactly
where the older code paths still expect them.
"""

import re
from pathlib import Path

import pandas as pd

import market_data_store as store
from timeframes import TIMEFRAME_TO_MOEX_INTERVAL

_INTERVAL_TO_TIMEFRAME = {v: k for k, v in TIMEFRAME_TO_MOEX_INTERVAL.items() if k != "1h"}

# Portfolio pipeline: TICKER_<N>m_FROM_TILL.csv (app.py FILENAME_RE), always
# TQBR board (the only catalog this app maintains, moex_catalog.py).
_PORTFOLIO_FILE_RE = re.compile(r"^([A-Z0-9]+)_(\d+)m_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$")
# Old chart_cache: TICKER__BOARD__INTERVAL__FROM__TILL.csv (candle_api.py, pre-DB).
_CHART_CACHE_FILE_RE = re.compile(r"^([A-Z0-9]+)__([A-Z]+)__(\d+)__(\d{4}-\d{2}-\d{2})__(\d{4}-\d{2}-\d{2})\.csv$")


def _import_csv(path: Path, ticker: str, board: str, timeframe: str) -> int:
    try:
        df = pd.read_csv(path)
    except (pd.errors.EmptyDataError, OSError):
        return 0
    if "begin" not in df.columns or df.empty:
        return 0
    df["begin"] = pd.to_datetime(df["begin"], errors="coerce")
    df = df.dropna(subset=["begin", "open", "high", "low", "close"])
    if df.empty:
        return 0
    has_volume = "volume" in df.columns
    has_value = "value" in df.columns
    # itertuples (not iterrows) - iterrows boxes every row into a Series,
    # which made this crawl on the largest CSVs (a year of 10m candles);
    # itertuples yields plain namedtuples, roughly an order of magnitude
    # faster for a loop this size.
    rows = [
        {
            "ts": int(t.begin.timestamp()),
            "open": float(t.open), "high": float(t.high), "low": float(t.low), "close": float(t.close),
            "volume": float(t.volume) if has_volume and pd.notna(t.volume) else 0,
            "value": float(t.value) if has_value and pd.notna(t.value) else None,
        }
        for t in df.itertuples(index=False)
    ]
    added = store.upsert_candles(ticker, board, timeframe, rows)
    store.update_sync_state(ticker, board, timeframe, status="completed", mark_synced=True)
    return added


def migrate(data_dir: Path) -> dict:
    """Returns a summary dict for logging: files scanned/imported and rows added."""
    summary = {"files_scanned": 0, "files_imported": 0, "rows_added": 0, "skipped": []}

    for path in sorted(data_dir.glob("*.csv")):
        m = _PORTFOLIO_FILE_RE.match(path.name)
        if not m:
            continue
        summary["files_scanned"] += 1
        ticker, minutes, _from, _till = m.groups()
        timeframe = _INTERVAL_TO_TIMEFRAME.get(int(minutes))
        if timeframe is None:
            summary["skipped"].append(path.name)
            continue
        added = _import_csv(path, ticker, "TQBR", timeframe)
        if added:
            summary["files_imported"] += 1
            summary["rows_added"] += added

    cache_dir = data_dir / "chart_cache"
    if cache_dir.is_dir():
        for path in sorted(cache_dir.glob("*.csv")):
            m = _CHART_CACHE_FILE_RE.match(path.name)
            if not m:
                continue
            summary["files_scanned"] += 1
            ticker, board, interval, _from, _till = m.groups()
            timeframe = _INTERVAL_TO_TIMEFRAME.get(int(interval))
            if timeframe is None:
                summary["skipped"].append(path.name)
                continue
            added = _import_csv(path, ticker, board, timeframe)
            if added:
                summary["files_imported"] += 1
                summary["rows_added"] += added

    return summary


def migrate_if_empty(data_dir: Path) -> dict | None:
    """Runs the import only the first time (DB has zero candles) so
    restarts don't re-scan every CSV on every boot."""
    if store.total_candle_count() > 0:
        return None
    return migrate(data_dir)
