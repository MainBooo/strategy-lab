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
# always land on a real base-candle boundary.
AGGREGATE_TIMEFRAMES = {
    "30m": {"base": "10m", "bucket_seconds": 30 * 60},
    "4h": {"base": "60m", "bucket_seconds": 4 * 60 * 60},
}

ALL_TIMEFRAMES = ("1m", "10m", "30m", "60m", "4h", "1d", "1mo")


def canonical(timeframe: str) -> str:
    return "60m" if timeframe == "1h" else timeframe


def moex_interval(timeframe: str) -> int:
    return TIMEFRAME_TO_MOEX_INTERVAL[timeframe]
