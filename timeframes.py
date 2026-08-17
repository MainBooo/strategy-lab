from __future__ import annotations

"""Single source of truth for chart/replay/backtest timeframe definitions,
shared by candle_api.py, market_data_sync.py, binance_market_data.py and
app.py so the "which timeframes exist and how are they derived" answer
never drifts between modules.

Binance Spot klines natively serve every timeframe Strategy Lab needs
except one: there is no native 10-minute interval. Since 10m is used
pervasively by existing strategies/saved configs, it stays supported as a
derived (aggregated) timeframe - built from two native 5m candles, bucketed
on UTC open time (see binance_market_data.aggregate_candles). Every other
timeframe (5m/15m/30m/1h/2h/4h/1d/1w/1mo) is fetched directly from Binance,
never synthetically aggregated - the old MOEX-era "aggregate almost
everything from 1m/10m/60m" approach no longer applies.

"60m" is kept only as a backward-compatible alias for "1h" (old saved
portfolios/backtests may reference it); canonical() maps it to "1h" so
storage/lookups never juggle two names for the same series.
"""

# Binance kline interval strings for each native timeframe this app stores.
# "1mo" -> "1M" is Binance's own capitalization for "1 month" (lowercase "1m"
# is already taken by "1 minute").
BINANCE_INTERVAL = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1d", "1w": "1w", "1mo": "1M",
}

# Canonical native timeframes actually stored in market_data_store - fetched
# directly from Binance, never derived.
NATIVE_TIMEFRAMES = ("1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo")

# Timeframes with no native Binance interval, built by honestly aggregating a
# native base timeframe already stored locally. bucket_seconds must be an
# exact multiple of the base timeframe's own interval so bucket boundaries
# always land on a real base-candle boundary.
AGGREGATE_TIMEFRAMES = {
    "10m": {"base": "5m", "bucket_seconds": 10 * 60},
}

ALL_TIMEFRAMES = ("1m", "3m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo")

# The timeframes offered on the backtest-configuration screen, in display
# order, with the exact Russian labels the UI shows. Distinct from
# ALL_TIMEFRAMES (which also serves the chart/market-data UI) because the
# backtest screen's own spec fixes this exact list.
BACKTEST_TIMEFRAMES = ("1m", "5m", "10m", "15m", "30m", "1h", "4h", "1d")
BACKTEST_TIMEFRAME_LABELS = {
    "1m": "1 минута", "5m": "5 минут", "10m": "10 минут", "15m": "15 минут",
    "30m": "30 минут", "1h": "1 час", "4h": "4 часа", "1d": "1 день",
}

_LEGACY_ALIASES = {"60m": "1h"}


def canonical(timeframe: str) -> str:
    return _LEGACY_ALIASES.get(timeframe, timeframe)


def binance_interval(timeframe: str) -> str:
    return BINANCE_INTERVAL[canonical(timeframe)]


def backtest_timeframe_label(timeframe: str) -> str:
    return BACKTEST_TIMEFRAME_LABELS.get(canonical(timeframe), timeframe)
