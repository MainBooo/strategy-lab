from __future__ import annotations

"""Single entry point for chart-module entitlement checks.

NOTE: this app has since grown real authentication and billing
(auth.py/auth_routes.py, commerce_routes.py/billing_service.py) - the
"no login, no tariffs" premise this module was written under no longer
holds. has_feature() still always returns True for every user, including
anonymous ones, for every chart feature listed below. It is wired into
~16 call sites across app.py as if it were a real entitlement gate;
anyone reading only those call sites (not this docstring) will reasonably
assume chart access is actually plan-gated today. It is not - every
chart feature is unconditionally free. A real entitlement/plan lookup can
replace the body of has_feature() without touching call sites, but until
that happens, do not treat CHART_FEATURES membership as proof any of
these are paid or restricted.
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
