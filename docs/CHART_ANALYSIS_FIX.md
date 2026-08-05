# Chart black-screen fix

Date: 2026-08-05

## Symptom

The "Анализ" chart tab rendered a solid black tile instead of candles, on
some viewports. Not consistent across all screen sizes — that inconsistency
is what pointed at CSS rather than a data/rendering-library problem.

## Root cause

`static/chart.css`, inside the `@media (max-width: 980px)` breakpoint:

```css
.ca-tile-grid { min-height: unset; }
```

`.ca-tile-grid` is the only element in the chart layout that establishes a
height for the chart tile below it — `.ca-workspace` uses
`align-items: start`, so nothing above it stretches to fill available
space either. Once `min-height` was stripped below 980px width, the grid
(and everything inside it, down to the `<canvas>` lightweight-charts
draws into) collapsed to its content height, which for an empty chart
container is a few pixels. A canvas with near-zero height still paints,
it just paints as a sliver — which reads as "black screen" against the
dark theme.

This affects **every viewport narrower than 980px**: tablet portrait, all
phone sizes, and any desktop window narrowed below that width — not a
mobile-only bug.

## Fix

Replaced `unset` with explicit floors matching each breakpoint's tile
sizing, instead of letting the tile fall back to content height:

```css
@media (max-width: 980px) { .ca-tile-grid { min-height: 440px; } }
@media (max-width: 620px) { .ca-tile-grid { min-height: 360px; } }
```

## Verification

Playwright, all 9 required resolutions (1920×1080 down to 360×800):
chart canvas renders with non-zero, correctly-sized bounds and visible
candles at every size. Screenshots in
`test-results/ui-audit-after-fixes/`. Also verified switching
Portfolio → Charts → Replay → Charts repeatedly does not duplicate
canvases or leave stray realtime-polling requests running.

## Note on scope

Two independent market-data pipelines exist in this codebase:

- **Chart/replay path** (`market_data_store.py` + `market_data_sync.py` +
  `candle_api.py`): SQLite-backed, cache-check-then-MOEX-fetch, already
  dynamic before this session. See [DYNAMIC_MARKET_DATA.md](DYNAMIC_MARKET_DATA.md).
- **Portfolio/backtest path** (`downloader.py`, `DATA_DIR` /
  `_local_data_index` in `app.py`): separate, older, CSV-per-ticker. Also
  already dynamic (auto-downloads on demand, no manual upload step). Left
  as its own pipeline per the code's existing "out of scope, well-tested"
  docstring — only retry/backoff was added to `downloader.py` to bring it
  in line with the chart path's resilience.

## Known unrelated bug (not fixed here)

`replay_engine.py:42`, `KeyError: 'position_entry_commission'` in
`_snapshot()` / `_push_undo()`. Predates this session (seen in logs dated
2026-08-04) — most likely from an uncommitted Market Replay buy/sell
rework already in progress before this session started
(`static/market-replay.js`, `chart-engine/trades.js`, `chart.css` all had
pre-existing uncommitted diffs). Not touched here; flagging for a
follow-up.
