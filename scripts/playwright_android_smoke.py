"""Focused Android-sized responsive smoke for Strategy Lab.

Reuses the main responsive scenario and adds a regression check for the
phone chart workspace top edge. The chart terminal must stay anchored inside
the visible viewport even when the page was scrolled before switching tabs.
"""
from __future__ import annotations

import os

from playwright.sync_api import sync_playwright

from playwright_responsive_smoke import BASE_URL, run_viewport

ANDROID_VIEWPORTS = [
    ("android-360x780", 360, 780),
    ("android-360x800", 360, 800),
    ("android-393x873", 393, 873),
    ("android-412x915", 412, 915),
    ("android-landscape-780x360", 780, 360),
    ("android-landscape-873x393", 873, 393),
    ("android-landscape-915x412", 915, 412),
]


def check_scroll_to_charts(browser, label: str, width: int, height: int) -> list[str]:
    issues: list[str] = []
    context = browser.new_context(
        viewport={"width": width, "height": height},
        has_touch=True,
        is_mobile=True,
        ignore_https_errors=True,
    )
    page = context.new_page()
    try:
        page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
        page.evaluate("() => window.scrollTo(0, Math.min(900, document.documentElement.scrollHeight - innerHeight))")
        page.wait_for_timeout(120)
        page.locator('.tab[data-tab="charts"]:visible').first.click(timeout=12_000)
        page.wait_for_timeout(350)
        geom = page.locator("#chartsRoot").first.evaluate(
            "el => { const r=el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,vh:innerHeight}; }"
        )
        if geom["top"] < -1:
            issues.append(f"chart root starts above visual viewport after scrolled tab switch: top={geom['top']:.1f}")
        toolbar = page.locator("#caToolbar").first
        if toolbar.count() and toolbar.is_visible():
            top = toolbar.evaluate("el => el.getBoundingClientRect().top")
            if top < 0:
                issues.append(f"chart toolbar is hidden above viewport: top={top:.1f}")
    except Exception as exc:
        issues.append(f"scroll-switch scenario exception: {exc}")
    finally:
        context.close()
    return issues


def main() -> int:
    total = 0
    print(f"Android smoke against {BASE_URL}")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for label, width, height in ANDROID_VIEWPORTS:
            result = run_viewport(browser, label, width, height)
            issues = list(result["issues"])
            issues.extend(check_scroll_to_charts(browser, label, width, height))
            total += len(issues)
            status = "OK" if not issues else f"{len(issues)} issue(s)"
            print(f"[{status}] {label}")
            for issue in issues:
                print(f"  - {issue}")
        browser.close()
    print(f"Android responsive smoke: {len(ANDROID_VIEWPORTS)} viewports, {total} issues")
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())
