# Responsive audit — Strategy Lab

Branch: `agent/responsive-layout-audit`

## Root causes found

1. **Breakpoints were fragmented across multiple late CSS layers.** `styles.css`, `chart.css`, `home-hero.css`, and `home-hero-polish.css` use overlapping 520/620/720/820/900/980/1100/1180px thresholds. The hero files are imported from `auth.css`, which is loaded after `chart.css`, so some late rules can silently change the effective mobile mode.
2. **The application phone navigation stopped at 620px.** Portrait phones were handled, but modern phone landscape viewports such as 844×390 and 932×430 fell back to desktop/tablet top tabs.
3. **The chart terminal had a short-height dead zone.** At `max-width: 980px`, multi-chart CSS imposed a `min-height: 440px`; the smaller 220px rule only applied below 620px. A phone at 844×390 therefore received a chart minimum taller than the whole viewport before toolbar/navigation/panels were counted.
4. **Properties / Objects stayed in normal flex flow.** Its persisted height could consume a large part of the chart. The JS default only collapsed it for `window.innerWidth <= 620`, so first-load phone landscape could start with the panel open.
5. **`charts-active` reset shell padding after the original phone-nav rule.** The chart terminal uses `body.charts-active .shell { padding: 0; }`; because of order/specificity this could remove space reserved for the fixed mobile bottom navigation.
6. **Toolbar fitting relied too much on shrinking.** The overflow controller correctly collapses secondary `[data-key]` actions, but ticker/timeframe/type/layout/fullscreen and some identity controls are exempt. Existing phone CSS reduced controls to roughly 30px rather than changing the layout mode.
7. **Several fullscreen/drawer surfaces still used `100vh`.** The shared trade-chart fullscreen already had `100dvh`, but the chart workspace/tile and watchlist mobile drawer were not consistently using dynamic/small viewport units and safe areas.
8. **Global `body { overflow-x: hidden; }` can hide symptoms.** The new responsive layer fixes shrink constraints and scroll ownership at component level instead of depending on that global clipping rule.
9. **The existing Playwright audit was useful but incomplete for this task.** It used an old default host and did not include 320px, the requested landscape matrix, nav duplication checks, panel-toggle consistency, chart-instance preservation on orientation, or touch-target assertions.

## Existing architecture intentionally preserved

- `ChartCore` already has a `ResizeObserver` and calls Lightweight Charts `resize()`; no chart recreation is needed for responsive changes.
- `FullscreenController` changes presentation of the existing element and keeps the same chart/drawing instances.
- `DrawingManager` already has Pointer Events, touch hit tolerances, drag thresholds, and persisted time/price coordinates.
- `_bottomCollapsed` remains the single source of truth for Properties / Objects. The phone bottom sheet is presentation-only; no `mobilePanelOpen` state was introduced.
- Watchlist mobile drawer continues to use the existing `WatchlistSidebar` behavior.

## Implementation

### `static/responsive.css`

A single late-loaded responsive policy now defines:

- compact desktop/tablet sizing up to 1180px;
- tablet behavior through 900px;
- phone UI at `max-width: 620px`;
- phone UI also for short landscape viewports: `max-width: 960px` **and** `max-height: 520px`;
- compact-phone refinements at 480px and 360px.

Phone chart behavior:

- desktop tabs hidden; existing bottom navigation retained;
- `100svh` / `100dvh` chart terminal sizing;
- safe-area padding on fixed navigation, fullscreen surfaces, drawers, and sheets;
- toolbar keeps priority controls readable while secondary actions remain governed by the existing overflow controller;
- drawing rail has a 44px footprint with touch-sized controls and its own vertical scrolling on short screens;
- Properties / Objects is removed from flex flow and shown as an overlay sheet when the existing state is open;
- drawing rail stays above that sheet so the same Objects toggle can close it again;
- phone chart grid pixel minimums are removed so flexbox uses the actual remaining viewport;
- Replay controls receive touch targets and a viewport-relative chart height.

### `static/chart-editor-polish.js`

The former compatibility shim is now a small viewport coordinator. It does not own chart state. It:

- adds `viewport-fit=cover` to the existing viewport meta at runtime;
- uses the same viewport query as the CSS phone mode;
- collapses the existing Properties / Objects state when entering phone UI without overwriting the persisted desktop preference;
- triggers existing chart resize and toolbar-overflow recalculation after resize/orientation changes;
- listens to `visualViewport.resize` for Safari browser-chrome height changes.

### `scripts/playwright_responsive_smoke.py`

Adds the full requested matrix:

- 320×568
- 360×800
- 375×812
- 390×844
- 393×852
- 402×874
- 430×932
- 844×390
- 852×393
- 932×430
- 768×1024
- 820×1180
- 1024×1366
- 1280×720
- 1440×900
- 1920×1080

Checks include:

- document horizontal overflow;
- phone bottom navigation vs desktop tab exclusivity;
- chart root/host dimensions;
- toolbar viewport bounds;
- drawing rail width and touch target size;
- Properties / Objects toggle and JS/CSS source-of-truth agreement;
- default phone panel collapse;
- portrait → landscape → portrait resize;
- preservation of the same `ChartCore` instance across orientation simulation;
- ability to leave Charts and return to Portfolio;
- Market Replay touch target/overflow smoke;
- screenshots for representative phone portrait, phone landscape, tablet, and desktop.

## Validation / test deployment

The branch must be visually verified on the VPS before merge.

```bash
cd /opt/moex-strategy-lab-v3

git fetch origin
git switch agent/responsive-layout-audit
git pull --ff-only origin agent/responsive-layout-audit

# Syntax checks for the changed executable files
node --check static/chart-editor-polish.js
.venv/bin/python -m py_compile scripts/playwright_responsive_smoke.py

# Existing safe deploy helper: backup, Python syntax checks, nginx validation,
# restart only moex-strategy-lab, reload nginx, then health check.
sudo ./deploy/update.sh

# Run the responsive matrix against the test deployment / production host
# currently serving this branch.
BASE_URL=https://strategylab.generationweb.ru \
  .venv/bin/python scripts/playwright_responsive_smoke.py

# Inspect report + representative screenshots
cat test-results/responsive-smoke/report.json
ls -lah test-results/responsive-smoke/
```

Do not merge to `main` until the screenshots and real iPhone/iPad interaction pass visual review.
