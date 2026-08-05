# UI cleanup: storage UI, step badges, checkboxes, top bar

Date: 2026-08-05

## Storage UI removed

Removed the "Хранилище данных" button + its modal wiring from
`templates/index.html`. Backend routes (`/api/market-data/*` in `app.py`)
and `static/market-data-manager.js` were left intact but unlinked —
per spec, admin/maintenance functionality stays available, just not
exposed as a new user-facing surface. `GET /api/market-data/cache-stats`
(added this session, see [DYNAMIC_MARKET_DATA.md](DYNAMIC_MARKET_DATA.md))
follows the same pattern: exists, not linked from any UI.

## Step badges

Raw badges `"01"` / `"PORT"` / `"02"` / `"03"` / `"RESULT"` / `"HISTORY"`
in the step indicator (`templates/index.html`) replaced with plain
Russian labels: "Шаг 1", "Портфели", "Шаг 2", "Шаг 3", "Итог", "История".

## Checkbox redesign

Every `<input type="checkbox">` in the app (catalog filters, portfolio
editor tables, indicator/template popovers, drawing properties, trade-chart
toggles — ~20 instances across the codebase) previously rendered as the
bare browser-default checkbox, inconsistent with the rest of the design
system. Replaced with a single global rule in `static/styles.css`
(right after the existing `.toggle` rule):

- `appearance: none` custom box, 19×19px, rounded corners, subtle border
- Checked state: gradient fill (`--accent` → `--accent-2`) matching the
  app's other accent surfaces, with an animated checkmark
- Checkmark drawn as a bordered pseudo-element rather than a background
  image/SVG — avoids a known iOS Safari issue where `appearance:none`
  checkboxes mishandle small SVG background checkmarks
- `:focus-visible`, `:disabled`, `.error`/`:invalid` states covered

One rule covers every checkbox in the app — no per-page overrides needed.
Verified visually via screenshot across the pages listed above.

## Top bar compaction

`templates/index.html` header (`<header class="hero">`) restructured into
two wrapper divs — `.hero-title` (eyebrow + `<h1>` + subtitle) and
`.hero-meta` (balance widget + status chip) — needed so mobile can lay
subtitle/balance/status out compactly instead of stacking every element
full-height.

Mobile changes (≤520px): smaller `<h1>` via `clamp()`, subtitle paragraph
hidden, balance/status chips tightened. Measured header height (top of
page to top of the tab nav, Portfolio tab): **491px → 213px, a 56.6%
reduction** (target was 40–50%). Desktop header also tightened (smaller
`<h1>`, reduced vertical padding) but stays fully legible — not subject
to the same aggressive cut as mobile.

## Verification

Playwright across all 9 required resolutions (1920×1080, 1440×900,
1366×768, 1024×768, 820×1180, 430×932, 390×844, 375×812, 360×800):
no storage button present, step labels render as plain text, checkboxes
render with the new custom style, header height reduction confirmed at
mobile widths, no console errors, no horizontal scroll at any size.
Screenshots in `test-results/ui-audit-after-fixes/`.
