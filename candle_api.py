from __future__ import annotations

"""Generic OHLCV candle lookup for the "Analysis" chart module.

Separate from the portfolio-builder's data pipeline (DATA_DIR /
FILENAME_RE / _local_data_index in app.py) on purpose: that pipeline is
keyed to a single hardcoded 10-minute interval per portfolio instrument
and its filename regex only understands "<TICKER>_<minutes>m_..." names.
Bolting multi-timeframe (including day/week/month, which MOEX addresses
with non-"m" interval codes) onto that regex would risk the existing
portfolio/backtest flow. This module keeps its own cache directory and
reuses downloader.download_moex_candles + strategies.common.load_candles
for the actual fetch/parse - it does not reimplement candle downloading.
"""

import re
import time
from pathlib import Path

import pandas as pd

from downloader import download_moex_candles
from strategies.common import load_candles

TIMEFRAME_TO_MOEX_INTERVAL = {
    "1m": 1, "10m": 10, "60m": 60, "1h": 60,
    "1d": 24, "1w": 7, "1mo": 31,
}

_CACHE_FILE_RE = re.compile(r"^([A-Z0-9]+)__([A-Z]+)__(\d+)__(\d{4}-\d{2}-\d{2})__(\d{4}-\d{2}-\d{2})\.csv$")


def _cache_dir(data_dir: Path) -> Path:
    d = data_dir / "chart_cache"
    d.mkdir(exist_ok=True)
    return d


def _cache_path(cache_dir: Path, ticker: str, board: str, interval: int, from_date: str, till_date: str) -> Path:
    return cache_dir / f"{ticker}__{board}__{interval}__{from_date}__{till_date}.csv"


def _find_cached(cache_dir: Path, ticker: str, board: str, interval: int) -> tuple[Path, str, str] | None:
    """Newest cache file for (ticker, board, interval), or None."""
    best = None
    for p in cache_dir.glob(f"{ticker}__{board}__{interval}__*.csv"):
        m = _CACHE_FILE_RE.match(p.name)
        if not m:
            continue
        cached_from, cached_till = m.group(4), m.group(5)
        if best is None or cached_till > best[2]:
            best = (p, cached_from, cached_till)
    return best


def get_candles(data_dir: Path, *, ticker: str, board: str, timeframe: str, from_date: str, till_date: str,
                 limit: int, before: int | None = None) -> dict:
    """Returns {"candles": [...], "nextCursor": int|None} - unix-seconds OHLCV.

    from_date/till_date bound the window we're willing to serve; `before`
    (unix seconds), if given, additionally caps the latest bar returned so
    the frontend can page further into the past without re-fetching bars
    it already has.
    """
    if timeframe not in TIMEFRAME_TO_MOEX_INTERVAL:
        raise ValueError(f"Неизвестный таймфрейм: {timeframe}")
    interval = TIMEFRAME_TO_MOEX_INTERVAL[timeframe]
    ticker = ticker.upper()
    cache_dir = _cache_dir(data_dir)

    cached = _find_cached(cache_dir, ticker, board, interval)
    source: Path
    if cached and cached[1] <= from_date and cached[2] >= till_date:
        source = cached[0]
    else:
        span_from = min(from_date, cached[1]) if cached else from_date
        span_till = max(till_date, cached[2]) if cached else till_date
        source = _cache_path(cache_dir, ticker, board, interval, span_from, span_till)
        download_moex_candles(ticker, board, interval, span_from, span_till, source)
        if cached and cached[0] != source:
            cached[0].unlink(missing_ok=True)

    df = load_candles(source, from_date, till_date)
    if before is not None:
        df = df[df["begin"] < pd.to_datetime(before, unit="s")]
    truncated = len(df) > limit
    df = df.tail(limit)

    candles = [
        {
            "time": int(row["begin"].timestamp()),
            "open": float(row["open"]), "high": float(row["high"]),
            "low": float(row["low"]), "close": float(row["close"]),
            "volume": float(row["volume"]) if "volume" in df.columns and pd.notna(row.get("volume")) else 0,
        }
        for _, row in df.iterrows()
    ]
    next_cursor = candles[0]["time"] if candles and truncated else None
    return {"candles": candles, "nextCursor": next_cursor}
