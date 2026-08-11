"""UI audit driver for MOEX Strategy Lab V3 (Этап 6 of the chart/replay spec).

Drives a real Chromium browser (Playwright) across the required desktop/
tablet/mobile viewports and the 12 required pages/scenarios, saving one
screenshot per (viewport, scenario) into test-results/ui-audit/ and
collecting automated checks: horizontal overflow (scrollWidth vs viewport
width), uncaught JS errors, console errors (ignoring the known-benign
favicon 404), and HTTP 5xx responses.

Usage: .venv/bin/python scripts/playwright_ui_audit.py
Requires the app already running (systemctl status moex-strategy-lab) and
reachable at BASE_URL - port 5060 directly is blocked by Chromium as an
"unsafe port", so this goes through the nginx proxy on the public
server_name instead. Requires "127.0.0.1 moex.generationweb.ru" in
/etc/hosts (DNS for the domain isn't provisioned yet).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = "http://moex.generationweb.ru"
OUT_DIR = Path(__file__).resolve().parent.parent / "test-results" / "ui-audit"

VIEWPORTS = [
    ("desktop-1920x1080", 1920, 1080),
    ("desktop-1440x900", 1440, 900),
    ("desktop-1366x768", 1366, 768),
    ("tablet-1024x768", 1024, 768),
    ("tablet-820x1180", 820, 1180),
    ("mobile-430x932", 430, 932),
    ("mobile-390x844", 390, 844),
    ("mobile-375x812", 375, 812),
    ("mobile-360x800", 360, 800),
]

BENIGN_CONSOLE_SUBSTRINGS = ("favicon.ico",)

report: list[dict] = []


class ScenarioCtx:
    def __init__(self, page, name: str):
        self.page = page
        self.name = name
        self.console_errors: list[str] = []
        self.page_errors: list[str] = []
        self.bad_responses: list[str] = []
        self._console_cb = lambda msg: (
            self.console_errors.append(msg.text())
            if msg.type == "error" and not any(s in msg.text() for s in BENIGN_CONSOLE_SUBSTRINGS)
            else None
        )
        self._page_err_cb = lambda exc: self.page_errors.append(str(exc))
        self._response_cb = lambda resp: (
            self.bad_responses.append(f"{resp.status} {resp.url}") if resp.status >= 500 else None
        )
        page.on("console", self._console_cb)
        page.on("pageerror", self._page_err_cb)
        page.on("response", self._response_cb)

    def detach(self):
        self.page.remove_listener("console", self._console_cb)
        self.page.remove_listener("pageerror", self._page_err_cb)
        self.page.remove_listener("response", self._response_cb)

    def finish(self, viewport_label: str, viewport_width: int, out_path: Path):
        overflow = self.page.evaluate(
            "() => ({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})"
        )
        issues = []
        if overflow["scrollWidth"] > overflow["clientWidth"] + 1:
            issues.append(f"horizontal overflow: scrollWidth={overflow['scrollWidth']} > clientWidth={overflow['clientWidth']}")
        if self.console_errors:
            issues.extend(f"console error: {e[:200]}" for e in self.console_errors)
        if self.page_errors:
            issues.extend(f"JS exception: {e[:200]}" for e in self.page_errors)
        if self.bad_responses:
            issues.extend(f"HTTP 5xx: {r}" for r in self.bad_responses)
        self.page.screenshot(path=str(out_path), full_page=False)
        report.append({"viewport": viewport_label, "scenario": self.name, "issues": issues, "screenshot": str(out_path.name)})
        self.detach()
        status = "OK" if not issues else f"{len(issues)} ISSUE(S)"
        print(f"  [{status}] {self.name}")
        for i in issues:
            print(f"      - {i}")


def run_scenario(page, viewport_dir: Path, name: str, viewport_width: int, action):
    ctx = ScenarioCtx(page, name)
    try:
        action(page)
        page.wait_for_timeout(300)
    except Exception as exc:  # noqa: BLE001 - recorded as an issue, not a crash of the whole audit
        ctx.console_errors.append(f"scenario action raised: {exc}")
    ctx.finish(viewport_dir.name, viewport_width, viewport_dir / f"{name}.png")


def click_tab(page, tab):
    # Since the mobile bottom nav was added, .tab[data-tab=...] matches two
    # elements (desktop top bar + phone bottom bar) at every viewport - only
    # one is ever display:visible at a time via CSS. Playwright's plain
    # page.click()/wait_for_selector() (not the strict locator API) always
    # resolve to the first DOM match regardless of visibility, so on phone
    # widths - where the top bar is the hidden one - they'd wait forever on
    # an element that by design never becomes visible. `:visible` filters to
    # whichever of the two is actually on screen at the current viewport.
    sel = f'.tab[data-tab="{tab}"]:visible'
    page.wait_for_selector(sel, state="visible", timeout=10000)
    page.click(sel, timeout=10000)
    page.wait_for_timeout(400)


def scenario_home(page):
    page.goto(BASE_URL, wait_until="networkidle")
    click_tab(page, "portfolio")


# The "Хранилище данных" button + its scenario pair below were removed from
# scripts/playwright_ui_audit.py because the feature itself was deliberately
# unlinked from the UI (see docs/UI_CLEANUP.md, 2026-08-05) - the backend
# routes and static/market-data-manager.js still exist for admin/maintenance
# use, just with no user-facing entry point, so #openMarketDataManager no
# longer exists in templates/index.html and this scenario would always fail.


def scenario_backtest_auto(page):
    click_tab(page, "backtest")


def scenario_backtest_history(page):
    click_tab(page, "backtest")
    page.evaluate("() => window.scrollTo(0, document.body.scrollHeight * 0.4)")
    page.wait_for_timeout(300)


def scenario_result_card(page):
    click_tab(page, "backtest")
    page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(300)
    row = page.query_selector(".history-row, .backtest-history-row, tr[data-run-id]")
    if row:
        row.click()
        page.wait_for_timeout(500)


def scenario_close_modal(page):
    for sel in ["#tvClose", ".trade-viewer-backdrop", "body"]:
        el = page.query_selector(sel)
        if el and sel != "body":
            try:
                el.click()
                break
            except Exception:
                continue
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)


def scenario_chart_single(page):
    click_tab(page, "charts")
    page.evaluate("() => { if (window.ChartAnalysisPage) window.ChartAnalysisPage._setLayout('1'); }")
    page.wait_for_timeout(500)


def scenario_chart_grid(page):
    click_tab(page, "charts")
    page.evaluate("() => { if (window.ChartAnalysisPage) window.ChartAnalysisPage._setLayout('4'); }")
    page.wait_for_timeout(600)


def scenario_chart_fullscreen(page):
    click_tab(page, "charts")
    page.evaluate("() => { if (window.ChartAnalysisPage) window.ChartAnalysisPage._setLayout('1'); }")
    page.wait_for_timeout(300)
    page.click("#caFullscreenBtn")
    page.wait_for_timeout(500)


def scenario_exit_fullscreen(page):
    # The documented primary exit path is the toggle button itself (Escape
    # is the secondary path - see fullscreen.js docstring). Headless
    # Chromium's Fullscreen API can succeed on requestFullscreen() without
    # a real OS window manager backing it, so relying on native Escape
    # handling alone is flaky in this environment; click-to-toggle is what
    # a real user does most of the time anyway.
    # The same fake-fullscreen quirk also breaks a plain .click(): the
    # viewport itself never actually resizes, so the button's on-screen
    # position (computed for a true fullscreen layout) ends up past what
    # Playwright still thinks are the viewport bounds, and its actionability
    # check waits forever for "element is outside of the viewport" to
    # resolve. A raw DOM click via evaluate() sidesteps that check, same as
    # the data-management modal case above.
    page.evaluate(
        "() => (document.querySelector('#caFullscreenBtn.icon-btn.active') "
        "|| document.querySelector('#caFullscreenBtn'))?.click()"
    )
    page.wait_for_timeout(300)


def scenario_market_replay(page):
    click_tab(page, "replay")
    page.wait_for_timeout(300)


def scenario_portfolio(page):
    click_tab(page, "portfolio")
    header = page.query_selector(".accordion-header, .portfolio-card .accordion-header")
    if header:
        header.click()
        page.wait_for_timeout(400)


def scenario_trades_table(page):
    click_tab(page, "backtest")
    page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(300)
    row = page.query_selector(".history-row, tr[data-run-id]")
    if row:
        row.click()
        page.wait_for_timeout(400)
        tab_btn = page.query_selector('[data-tv-tab="trades"], .tv-subtab[data-tab="trades"]')
        if tab_btn:
            tab_btn.click()
            page.wait_for_timeout(400)


def scenario_modals_forms(page):
    click_tab(page, "charts")
    page.evaluate("() => { if (window.ChartAnalysisPage) window.ChartAnalysisPage._setLayout('1'); }")
    page.wait_for_timeout(300)
    btn = page.query_selector("#caOrderBtn")
    if btn:
        btn.click()
        page.wait_for_timeout(400)


SCENARIOS = [
    ("01-home", scenario_home),
    ("03-backtest-auto", scenario_backtest_auto),
    ("04-backtest-history", scenario_backtest_history),
    ("05-result-card", scenario_result_card),
    ("05b-result-card-closed", scenario_close_modal),
    ("06-chart-single", scenario_chart_single),
    ("07-chart-grid", scenario_chart_grid),
    ("08-chart-fullscreen", scenario_chart_fullscreen),
    ("08b-chart-fullscreen-exited", scenario_exit_fullscreen),
    ("09-market-replay", scenario_market_replay),
    ("10-portfolio", scenario_portfolio),
    ("11-trades-table", scenario_trades_table),
    ("12-modals-forms", scenario_modals_forms),
]


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for label, width, height in VIEWPORTS:
            if only and only not in label:
                continue
            print(f"\n=== {label} ({width}x{height}) ===")
            viewport_dir = OUT_DIR / label
            viewport_dir.mkdir(parents=True, exist_ok=True)
            page = browser.new_page(viewport={"width": width, "height": height})
            for name, action in SCENARIOS:
                run_scenario(page, viewport_dir, name, width, action)
            page.close()
        browser.close()

    summary_path = OUT_DIR / "report.json"
    summary_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    total_issues = sum(len(r["issues"]) for r in report)
    print(f"\n{'=' * 60}\nTotal checks: {len(report)}, total issues: {total_issues}")
    print(f"Report: {summary_path}")
    if total_issues:
        by_scenario: dict[str, int] = {}
        for r in report:
            if r["issues"]:
                by_scenario[r["scenario"]] = by_scenario.get(r["scenario"], 0) + len(r["issues"])
        print("Issues by scenario:")
        for k, v in sorted(by_scenario.items(), key=lambda kv: -kv[1]):
            print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
