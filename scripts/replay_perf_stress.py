"""Stage 8 performance check: does a long Market Replay session (thousands of
bars stepped at high speed) leak memory or degrade in the browser?

Drives a real session on SBER/TQBR/10m (252k+ candles available) far enough
back in history that there are several thousand bars ahead, then calls the
page's internal _step() directly in a tight loop (bypassing the setInterval
UI delay - this is what "max speed" play effectively does bar-for-bar, just
faster) while sampling JS heap size and DOM node count every N steps.

A healthy result: JS heap grows roughly linearly with revealed-bar count
(expected - the chart keeps all revealed candles in memory, by design) and
DOM node count stays flat (trades list is small; chart itself is canvas).
A leak would show heap or DOM node growth accelerating independent of bar
count, or growing after a step count that produced no new trades.

Heap is read via the DevTools Protocol's Performance.getMetrics() rather
than performance.memory - the latter returns a fixed, coarsely bucketed
value in headless Chromium (privacy-motivated quantization) and is useless
for spotting a leak; CDP's JSHeapUsedSize is the real per-sample figure.

Usage: .venv/bin/python scripts/replay_perf_stress.py
Requires the app running and reachable at http://127.0.0.1:8061/ (port 5060
directly is blocked by Chromium as an "unsafe port").
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:8061"
OUT_PATH = Path(__file__).resolve().parent.parent / "test-results" / "replay-perf-stress.json"
TOTAL_STEPS = 4000
SAMPLE_EVERY = 250


def main() -> int:
    console_errors: list[str] = []
    page_errors: list[str] = []
    samples: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        page.on("console", lambda m: console_errors.append(m.text()) if m.type == "error" else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        page.goto(f"{BASE_URL}/", wait_until="networkidle")
        page.click("[data-tab='replay']")
        page.wait_for_selector("#replayRoot #mrTicker", state="visible", timeout=15000)

        page.fill("#mrTicker", "SBER")
        page.select_option("#mrTimeframe", "10m")
        page.fill("#mrStartDate", "2020-01-10")
        page.fill("#mrStartHour", "10")
        page.fill("#mrStartMinute", "0")
        page.fill("#mrBalance", "1000000")

        page.evaluate("document.querySelector('#mrStart').click()")
        page.wait_for_selector("#mrPlayerRoot:not(.hidden)", timeout=20000)
        time.sleep(0.5)  # let the initial chart render settle before baselining

        cdp = page.context.new_cdp_session(page)
        cdp.send("Performance.enable")

        def heap_used_bytes() -> float | None:
            metrics = {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
            return metrics.get("JSHeapUsedSize")

        def sample(step_no: int) -> dict:
            mem = heap_used_bytes()
            dom_nodes = page.evaluate("() => document.querySelectorAll('*').length")
            revealed = page.evaluate(
                "() => window.MarketReplayPage.state ? window.MarketReplayPage.state.reveal_index : null"
            )
            return {"step": step_no, "heap_bytes": mem, "dom_nodes": dom_nodes, "reveal_index": revealed}

        samples.append(sample(0))
        # A couple of manual trades along the way so the trades list/markers
        # aren't empty for the whole run (that's the realistic usage pattern).
        traded_at = {500, 1500, 3000}

        for i in range(1, TOTAL_STEPS + 1):
            page.evaluate("() => window.MarketReplayPage._step()")
            if i in traded_at:
                has_position = page.evaluate(
                    "() => window.MarketReplayPage.state && window.MarketReplayPage.state.session.position_side"
                )
                action = "close" if has_position else "buy"
                page.evaluate(f"() => window.MarketReplayPage._order('{action}')")
            if i % SAMPLE_EVERY == 0:
                samples.append(sample(i))

        samples.append(sample(TOTAL_STEPS))
        final_dom_nodes = samples[-1]["dom_nodes"]
        overflow = page.evaluate(
            "() => ({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})"
        )
        browser.close()

    heaps = [s["heap_bytes"] for s in samples if s["heap_bytes"] is not None]
    report = {
        "total_steps": TOTAL_STEPS,
        "samples": samples,
        "console_errors": console_errors[:50],
        "page_errors": page_errors[:50],
        "final_dom_nodes": final_dom_nodes,
        "dom_node_growth": final_dom_nodes - samples[0]["dom_nodes"],
        "heap_growth_bytes": (heaps[-1] - heaps[0]) if len(heaps) >= 2 else None,
        "horizontal_overflow": overflow["scrollWidth"] > overflow["clientWidth"] + 1,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False))

    print(json.dumps({k: v for k, v in report.items() if k != "samples"}, indent=2, ensure_ascii=False))
    print(f"\nFull report: {OUT_PATH}")

    ok = not console_errors and not page_errors and not report["horizontal_overflow"] and report["dom_node_growth"] < 200
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
