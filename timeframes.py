from __future__ import annotations

"""Single source of truth for chart/replay timeframe definitions, shared by
candle_api.py, market_data_sync.py and app.py so the "which timeframes exist
and how are they derived" answer never drifts between modules."""

# Timeframes MOEX ISS serves natively (its own interval codes: minutes for
# 1/10/60, then 24=day, 7=week, 31=month).
TIMEFRAME_TO_MOEX_INTERVAL = {
    "1m": 1, "10m": 10, "60m": 60, "1h": 60,
    "1d": 24, "1w": 7, "1mo": 31,
}

# Canonical native timeframes actually stored in market_data_store (avoids
# storing "1h" as a duplicate of "60m").
NATIVE_TIMEFRAMES = ("1m", "10m", "60m", "1d", "1w", "1mo")

# Timeframes MOEX does not expose directly - built by honestly aggregating a
# native ("base") timeframe already stored locally. bucket_seconds must be an
# exact multiple of the base timeframe's own interval so bucket boundaries
# always land on a real base-candle boundary. MOEX ISS has no native 5/15
# minute interval codes (only 1/10/60), so 5m and 15m can only ever be built
# by aggregating 1m - never from 10m, since 15 is not an exact multiple of
# 10. This is why 5m/15m (and 1m itself) are commonly "unavailable" for
# tickers that only ever had 10m data downloaded - that is expected, honest
# behaviour, not a bug.
AGGREGATE_TIMEFRAMES = {
    "5m": {"base": "1m", "bucket_seconds": 5 * 60},
    "15m": {"base": "1m", "bucket_seconds": 15 * 60},
    "30m": {"base": "10m", "bucket_seconds": 30 * 60},
    "4h": {"base": "60m", "bucket_seconds": 4 * 60 * 60},
}

ALL_TIMEFRAMES = ("1m", "5m", "10m", "15m", "30m", "60m", "4h", "1d", "1mo")

# The 8 timeframes offered on the backtest-configuration screen, in display
# order, with the exact Russian labels the UI shows. Distinct from
# ALL_TIMEFRAMES (which also serves the chart/market-data UI and includes
# "1mo") because the backtest screen's own spec fixes this exact list.
BACKTEST_TIMEFRAMES = ("1m", "5m", "10m", "15m", "30m", "60m", "4h", "1d")
BACKTEST_TIMEFRAME_LABELS = {
    "1m": "1 минута", "5m": "5 минут", "10m": "10 минут", "15m": "15 минут",
    "30m": "30 минут", "60m": "1 час", "4h": "4 часа", "1d": "1 день",
}


def canonical(timeframe: str) -> str:
    return "60m" if timeframe == "1h" else timeframe


def moex_interval(timeframe: str) -> int:
    return TIMEFRAME_TO_MOEX_INTERVAL[timeframe]


def backtest_timeframe_label(timeframe: str) -> str:
    return BACKTEST_TIMEFRAME_LABELS.get(canonical(timeframe), timeframe)
