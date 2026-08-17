from __future__ import annotations

"""Crypto-neutral catalog preset filters (spec section 47).

Replaces the old curated Russian-sector ticker lists (banks/oilgas/metals/
it, keyed to specific MOEX tickers) - Binance Spot symbols have no
comparable sector-classification data source available from public market
data alone, so presets here are limited to what can be verified
structurally (quote asset) instead of invented industry categories
(DeFi/L1/Meme) without a reliable metadata source.
"""

# Quote-asset filter chips shown in the instrument catalog/picker - USDT is
# the default/primary choice for an ordinary user (spec section 4).
QUOTE_ASSET_PRESETS = ("USDT", "USDC", "BTC", "FDUSD", "EUR")
DEFAULT_QUOTE_ASSET = "USDT"

PRESET_LABELS: dict[str, str] = {
    "USDT": "USDT-пары",
    "USDC": "USDC-пары",
    "BTC": "BTC-пары",
    "FDUSD": "FDUSD-пары",
    "EUR": "EUR-пары",
    "top_volume": "ТОП по объёму",
    "favorites": "Избранное",
}


def sector_for(quote_asset: str | None) -> str:
    """A symbol's "sector" tag in the crypto-neutral catalog is just its
    quote asset (BTCUSDT -> "USDT") - the only structurally-verifiable
    grouping available without inventing industry metadata."""
    quote_asset = str(quote_asset or "").upper()
    return quote_asset or "Прочее"


def is_liquid(status: str | None) -> bool:
    """"Liquid" here means "Binance itself reports this symbol as actively
    tradable" (status == TRADING) - true 24h-volume-based liquidity ranking
    is a live metric (see market_ticker.get_top_by_volume), not a static
    catalog property."""
    return str(status or "").upper() == "TRADING"
