"""Responsive smoke test for Strategy Lab.

Runs the agreed phone / landscape / tablet / desktop viewport matrix against a
running deployment. It checks document overflow, mutually exclusive navigation,
chart geometry, toolbar bounds, Properties/Objects toggle consistency, touch
controls and resize/orientation behavior without recreating ChartCore.

Usage:
    BASE_URL=https://strategylab.generationweb.ru .venv/bin/python scripts/playwright_responsive_smoke.py

The script is intentionally deployment-agnostic: point BASE_URL at a test deploy
of the branch before merging it to main.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "https://strategylab.generationweb.ru").rstrip("/")
OUT_DIR = Path(__file__).resolve().parent.parent / "test-results" / "responsive-smoke"

VIEWPORTS = [
    ("phone-320x568", 320, 568),
    ("phone-360x800", 360, 800),
    ("phone-375x812", 375, 812),
    ("phone-390x844", 390, 844),
    ("phone-393x852", 393, 852),
    ("phone-402x874", 402, 874),
    ("phone-430x932", 430, 932),
    ("phone-landscape-844x390", 844, 390),
    ("phone-landscape-852x393", 852, 393),
    ("phone-landscape-932x430", 932, 430),
    ("tablet-768x1024", 768, 1024),
    ("tablet-820x1180", 820, 1180),
    ("tablet-1024x1366", 1024, 1366),
    ("desktop-1280x720", 1280, 720),
    ("desktop-1440x900", 1440, 900),
    ("desktop-1920x1080", 1920, 1080),
]

SCREENSHOT_LABELS = {
    "phone-390x844",
    "phone-landscape-844x390",
    "tablet-820x1180",
    "desktop-1440x900",
}

PHONE_QUERY = "(max-width: 620px), (max-width: 960px) and (max-height: 520px)"
BENIGN_CONSOLE = ("favicon.ico",)


def compact_phone(width: int, height: int) -> bool:
    return width <= 620 or (width <= 960 and height <= 520)


def visible(page: Page, selector: str) -> bool:
    locator = page.locator(selector)
    return locator.count() > 0 and locator.first.is_visible()


def click_tab(page: Page, tab: str) -> None:
    locator = page.locator(f'.tab[data-tab="{tab}"]:visible').first
    locator.wait_for(state="visible", timeout=12_000)
    locator.click(timeout=12_000)
    page.wait_for_timeout(250)


def rect(page: Page, selector: str) -> dict | None:
    return page.locator(selector).first.evaluate(
        "el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; }"
    ) if page.locator(selector).count() else None


def check_document_overflow(page: Page, issues: list[str]) -> None:
    dims = page.evaluate(
        "() => ({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,bw:document.body.scrollWidth})"
    )
    if dims["sw"] > dims["cw"] + 1:
        issues.append(f"document horizontal overflow: {dims['sw']} > {dims['cw']}")


def check_navigation(page: Page, phone: bool, issues: list[str]) -> None:
    mobile = visible(page, ".mobile-bottom-nav")
    desktop = visible(page, ".app-primary-tabs")
    if phone and not mobile:
        issues.append("mobile bottom navigation is not visible in phone UI")
    if phone and desktop:
        issues.append("desktop tabs are visible together with phone navigation")
    if not phone and mobile:
        issues.append("mobile bottom navigation is visible outside phone UI")
    if not phone and not desktop:
        issues.append("desktop/tablet navigation is not visible")


def check_chart(page: Page, width: int, height: int, phone: bool, issues: list[str]) -> None:
    click_tab(page, "charts")
    page.locator("#chartsRoot").wait_for(state="visible", timeout=12_000)
    page.wait_for_timeout(500)

    root = rect(page, "#chartsRoot")
    toolbar = rect(page, "#caToolbar")
    chart = rect(page, ".ca-tile-chart-host")
    if not root or root["width"] < min(260, width * 0.7) or root["height"] < min(180, height * 0.45):
        issues.append(f"chart root has unreasonable geometry: {root}")
    if not chart or chart["width"] < min(210, width * 0.55) or chart["height"] < 120:
        issues.append(f"chart host is too small: {chart}")
    if toolbar and (toolbar["x"] < -1 or toolbar["right"] > width + 1):
        issues.append(f"chart toolbar escapes viewport: {toolbar}")

    if phone:
        rail = rect(page, "#caTools")
        tool = rect(page, "#caTools .tv-tool-group-btn")
        if rail and rail["width"] > 48:
            issues.append(f"drawing rail is too wide for phone UI: {rail['width']:.1f}px")
        if tool and tool["height"] < 42:
            issues.append(f"drawing touch target is too small: {tool['height']:.1f}px")
        state = page.evaluate(
            "() => window.ChartAnalysisPage ? ({js:window.ChartAnalysisPage._bottomCollapsed,css:document.querySelector('#caBottom')?.classList.contains('collapsed')}) : null"
        )
        if state and state["js"] != state["css"]:
            issues.append(f"panel JS/CSS state mismatch before toggle: {state}")
        if state and state["js"] is not True:
            issues.append("Properties/Objects panel is not collapsed by default in phone UI")

    panel_button = page.locator('#caTools [data-tv-action="objects"]')
    if panel_button.count() and panel_button.first.is_visible():
        before = page.evaluate("() => window.ChartAnalysisPage?._bottomCollapsed")
        panel_button.first.click()
        page.wait_for_timeout(180)
        after = page.evaluate(
            "() => ({js:window.ChartAnalysisPage?._bottomCollapsed,css:document.querySelector('#caBottom')?.classList.contains('collapsed')})"
        )
        if after["js"] == before:
            issues.append("Properties/Objects toggle did not change existing panel state")
        if after["js"] != after["css"]:
            issues.append(f"panel JS/CSS state mismatch after toggle: {after}")
        panel_button.first.click()
        page.wait_for_timeout(120)
    else:
        issues.append("drawing rail Properties/Objects toggle is not available")

    page.evaluate("() => { window.__responsiveSmokeFsCore = window.ChartAnalysisPage?.tiles?.[0]?.core || null; document.querySelector('#caFullscreenBtn')?.click(); }")
    page.wait_for_timeout(220)
    fs_active = page.evaluate("() => document.querySelector('#chartsRoot')?.classList.contains('is-fullscreen')")
    fs_same_core = page.evaluate("() => !!window.__responsiveSmokeFsCore && window.ChartAnalysisPage?.tiles?.[0]?.core === window.__responsiveSmokeFsCore")
    if not fs_active:
        issues.append("workspace fullscreen did not enter")
    if not fs_same_core:
        issues.append("ChartCore was recreated while entering fullscreen")
    page.evaluate("() => document.querySelector('#caFullscreenBtn')?.click()")
    page.wait_for_timeout(220)
    fs_left = page.evaluate("() => !document.querySelector('#chartsRoot')?.classList.contains('is-fullscreen')")
    fs_same_core_after = page.evaluate("() => !!window.__responsiveSmokeFsCore && window.ChartAnalysisPage?.tiles?.[0]?.core === window.__responsiveSmokeFsCore")
    if not fs_left:
        issues.append("workspace fullscreen did not exit")
    if not fs_same_core_after:
        issues.append("ChartCore was recreated while exiting fullscreen")

    check_document_overflow(page, issues)


def check_orientation_without_recreation(page: Page, width: int, height: int, issues: list[str]) -> None:
    if width > 430 or height < width:
        return
    page.evaluate(
        "() => { window.__responsiveSmokeCore = window.ChartAnalysisPage?.tiles?.[0]?.core || null; }"
    )
    initial = rect(page, ".ca-tile-chart-host")
    page.set_viewport_size({"width": height, "height": width})
    page.wait_for_timeout(350)
    landscape = rect(page, ".ca-tile-chart-host")
    same_core = page.evaluate(
        "() => !!window.__responsiveSmokeCore && window.ChartAnalysisPage?.tiles?.[0]?.core === window.__responsiveSmokeCore"
    )
    if not same_core:
        issues.append("ChartCore was recreated during orientation simulation")
    if initial and landscape and abs(initial["width"] - landscape["width"]) < 20 and abs(initial["height"] - landscape["height"]) < 20:
        issues.append("chart geometry did not react to portrait -> landscape resize")
    check_document_overflow(page, issues)

    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_timeout(350)
    restored = rect(page, ".ca-tile-chart-host")
    same_core_back = page.evaluate(
        "() => !!window.__responsiveSmokeCore && window.ChartAnalysisPage?.tiles?.[0]?.core === window.__responsiveSmokeCore"
    )
    if not same_core_back:
        issues.append("ChartCore was recreated during landscape -> portrait resize")
    if initial and restored and abs(initial["width"] - restored["width"]) > 30:
        issues.append(f"chart width did not restore after orientation: {initial['width']:.1f} -> {restored['width']:.1f}")


def run_viewport(browser, label: str, width: int, height: int) -> dict:
    phone = compact_phone(width, height)
    context = browser.new_context(
        viewport={"width": width, "height": height},
        has_touch=width <= 1024,
        is_mobile=phone,
        ignore_https_errors=True,
    )
    page = context.new_page()
    console_errors: list[str] = []
    page_errors: list[str] = []
    bad_responses: list[str] = []
    page.on(
        "console",
        lambda msg: console_errors.append(msg.text)
        if msg.type == "error" and not any(x in msg.text for x in BENIGN_CONSOLE)
        else None,
    )
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("response", lambda response: bad_responses.append(f"{response.status} {response.url}") if response.status >= 500 else None)

    issues: list[str] = []
    try:
        page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)
        page.wait_for_timeout(250)
        check_document_overflow(page, issues)
        check_navigation(page, phone, issues)
        check_chart(page, width, height, phone, issues)
        if phone:
            check_orientation_without_recreation(page, width, height, issues)

        click_tab(page, "portfolio")
        if not visible(page, "#tab-portfolio"):
            issues.append("could not return from Charts to Portfolio")
        check_document_overflow(page, issues)

        click_tab(page, "replay")
        page.wait_for_timeout(250)
        for selector in (".mr-transport button", ".mr-order-buttons button"):
            target = page.locator(selector).first
            if target.count() and target.is_visible():
                h = target.evaluate("el => el.getBoundingClientRect().height")
                if phone and h < 42:
                    issues.append(f"touch target too small in Replay ({selector}): {h:.1f}px")
        check_document_overflow(page, issues)

        if label in SCREENSHOT_LABELS:
            click_tab(page, "charts")
            page.wait_for_timeout(300)
            out = OUT_DIR / f"{label}-charts.png"
            page.screenshot(path=str(out), full_page=False)
    except Exception as exc:
        issues.append(f"scenario exception: {exc}")

    issues.extend(f"console error: {x[:220]}" for x in console_errors)
    issues.extend(f"page error: {x[:220]}" for x in page_errors)
    issues.extend(f"HTTP 5xx: {x}" for x in bad_responses)
    result = {"viewport": label, "width": width, "height": height, "phone_ui": phone, "issues": issues}
    context.close()
    return result


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for label, width, height in VIEWPORTS:
            result = run_viewport(browser, label, width, height)
            results.append(result)
            status = "OK" if not result["issues"] else f"{len(result['issues'])} issue(s)"
            print(f"[{status}] {label}")
            for issue in result["issues"]:
                print(f"  - {issue}")
        browser.close()

    report_path = OUT_DIR / "report.json"
    report_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(len(row["issues"]) for row in results)
    print(f"Responsive smoke: {len(results)} viewports, {total} issues")
    print(f"Report: {report_path}")
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())
