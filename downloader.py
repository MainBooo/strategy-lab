from __future__ import annotations

"""Materializes a pinned per-instrument CSV for the portfolio-builder
pipeline (app.py's FILENAME_RE / DATA_DIR convention), sourced from the
unified Binance candle store instead of a direct MOEX-specific download.

Reuses backtest_candles.py's already-correct fetch_full_range() (loops
candle_api's cursor pagination, which itself backfills from Binance via
market_data_sync as needed) and materialize_csv() - the same compatibility
layer the backtest/optimizer/trade-chart routes already go through, so a
portfolio instrument's pinned file and every other consumer of that
symbol/timeframe draw from exactly one source of truth (market_data_store),
never a second independent download path.
"""

from datetime import datetime
from pathlib import Path

import backtest_candles


def download_binance_candles(symbol: str, interval_minutes: int, from_date: str, till_date: str,
                              output_path: Path) -> dict:
    timeframe = backtest_candles.interval_to_timeframe(interval_minutes) or f"{interval_minutes}m"
    result = backtest_candles.fetch_full_range(symbol=symbol, timeframe=timeframe, date_from=from_date,
                                                date_till=till_date)
    candles = result["candles"]
    if not candles:
        raise RuntimeError(
            "Binance не вернул свечи. Проверьте символ, таймфрейм и диапазон дат."
        )
    backtest_candles.materialize_csv(candles, output_path)
    return {
        "rows": len(candles),
        "first_bar": datetime.utcfromtimestamp(int(candles[0]["time"])).isoformat(sep=" "),
        "last_bar": datetime.utcfromtimestamp(int(candles[-1]["time"])).isoformat(sep=" "),
    }
