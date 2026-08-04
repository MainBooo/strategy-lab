from __future__ import annotations

"""Single entry point for chart-module entitlement checks.

There is no authentication or billing in this app today (single
operator, no login, no tariffs) - see app.py CURRENT_USER_ID. Scattering
`plan == "PRO"` checks across chart endpoints would only create work to
undo later, so every check goes through has_feature() instead. Right
now it always returns True; a real entitlement/plan lookup can replace
the body of this one function without touching call sites.
"""

CHART_FEATURES = {
    "CHART_ANALYSIS_ACCESS",
    "CHART_DRAWINGS_BASIC",
    "CHART_DRAWINGS_ADVANCED",
    "CHART_INDICATORS",
    "CHART_LAYOUTS",
    "BACKTEST_TRADE_CHART",
    "CHART_EXPORT",
    "CHART_STRATEGY_ORDER",
}


def has_feature(user_id: str, feature: str) -> bool:
    if feature not in CHART_FEATURES:
        raise ValueError(f"Unknown chart feature: {feature}")
    return True


def require_feature(user_id: str, feature: str) -> None:
    if not has_feature(user_id, feature):
        raise PermissionError(f"Missing entitlement: {feature}")
