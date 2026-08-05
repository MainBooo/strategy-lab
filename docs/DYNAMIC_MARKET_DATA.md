# Dynamic market data: bounded cache + realtime indicator

Date: 2026-08-05

## Bounded candle cache

The chart/replay candle store (`market_data_store.py`) already downloaded
from MOEX on demand and cached indefinitely on disk. This session added a
size/age bound so the cache doesn't grow forever, plus per-key locking so
concurrent requests for the same series (e.g. a 6-tile chart layout, or
several browser tabs on the same ticker) don't each fire a redundant MOEX
download.

### Config (env vars, all optional)

| Var | Default | Meaning |
|---|---|---|
| `MARKET_CACHE_ENABLED` | `true` | `false` = unlimited growth, today's old behavior |
| `MARKET_CACHE_MAX_GB` | `40` | Size budget for the candle DB file |
| `MARKET_CACHE_TTL_DAYS` | `7` | Series idle longer than this are dropped first |
| `MARKET_CACHE_PATH` | `<app>/cache/market-data` | Directory holding `market_data.db` |

Read fresh on every call (`market_data_store.cache_config()`), not cached
at import time — a changed env var takes effect on the next check without
a process restart.

### Eviction algorithm (`evict_if_needed`)

1. Drop any `(ticker, board, timeframe)` series whose `last_accessed_at`
   (falling back to `updated_at`) is older than `MARKET_CACHE_TTL_DAYS`.
2. If still over `MARKET_CACHE_MAX_GB`, drop the least-recently-accessed
   remaining series one at a time (`PRAGMA incremental_vacuum` after each)
   until under budget.

Eviction never loses data permanently — `candle_api._ensure_coverage`
just re-fetches an evicted range from MOEX the next time it's requested.
Runs once at process startup and then every 6 hours on a daemon thread
(`app.py`, `_market_cache_eviction_loop`). A diagnostic-only endpoint,
`GET /api/market-data/cache-stats`, reports current size/series count/
oldest-accessed series — not linked from any UI.

### Why `auto_vacuum=INCREMENTAL` + one-time `VACUUM`

SQLite `DELETE` only returns pages to its own internal freelist, not to
the OS, unless auto_vacuum is on — without it, eviction could delete
every row and the `.db` file would never actually shrink on disk. Turning
auto_vacuum on requires a one-time full `VACUUM`; guarded by reading the
pragma first so it only runs once per database, not on every restart.

### Cache location migration

Moved from `storage/market_data.db` to `cache/market-data/market_data.db`
(configurable via `MARKET_CACHE_PATH`) — a cache with a bounded/evictable
lifecycle belongs outside the persistent `storage/` tree. `app.py` does a
one-time auto-migration on startup (moves the file + its `-wal`/`-shm`
siblings if the old path exists and the new one doesn't).

### Per-key sync lock

`market_data_store.sync_lock(ticker, board, timeframe)` returns a
`threading.Lock` from an in-process dict, held around
`candle_api._ensure_coverage`. Guards against duplicate work *within one
process* only — `sync_state.status="running"`, checked at the same call
site, is the cross-process backstop since gunicorn runs multiple worker
processes.

## Realtime indicator

### What MOEX's free feed actually gives you

Measured live during trading hours (2026-08-05, ~12:30 MSK, SBER / GAZP /
LKOH / T / YDEX, 45 samples over ~2.5 min, zero fetch errors): the
anonymous ISS `marketdata.json` endpoint has a **rock-steady ~900-second
(~15 minute) delay** between a security's own last-trade `TIME` and the
moment the response is served. This is MOEX's standard delay for a feed
without a paid real-time data agreement — not a bug, not a connectivity
problem, and not something a retry/backoff loop can improve. RTT to MOEX
from this VPS is unrelated and much smaller (median ~30ms).

Because of that fixed baseline, `market_ticker.realtime_config()` sets its
status thresholds *relative to ~900s*, not to generic near-real-time
defaults (which would misreport every single quote as stale):

| Var | Default | Meaning |
|---|---|---|
| `REALTIME_ENABLED` | `true` | Master on/off for the indicator |
| `REALTIME_POLL_INTERVAL_MS` | `45000` | Frontend poll cadence |
| `REALTIME_WARNING_DELAY_MS` | `1200000` (20 min) | ~5 min past baseline |
| `REALTIME_STALE_DELAY_MS` | `2400000` (40 min) | |
| `REALTIME_DISCONNECTED_DELAY_MS` | `3600000` (60 min) | Also used on fetch failure |

Given the ~900s baseline, `_classify_status` in `market_ticker.py` always
returns `"delayed"` during market hours under normal conditions — this
integration can truthfully never show "live" for a free/anonymous feed,
and the indicator says so rather than pretending otherwise.

### Why backend clock, not MOEX's own SYSTIME

`delay_ms` is computed as *this server's* clock minus the market event's
own wall-clock `TIME` (`market_ticker._fetch_snapshot`), not MOEX's
`SYSTIME` minus `TIME`. Trusting `SYSTIME` would mean trusting a second
remote clock for the exact number shown to the user; using the backend's
own `datetime.utcnow()` means the delay figure only depends on clocks we
control (this server + the security's own trade timestamp).

### Endpoint

`GET /api/market/realtime?ticker=X` → `market_ticker.get_realtime()`.
Response shape (also documented inline at `market_ticker.py:214`):
`source, ticker, last, change_pct, bid, offer, market_timestamp,
market_time, server_received_at, response_generated_at, delay_ms, status,
market_status, error, config`.

### Frontend

`static/realtime-indicator.js` — `RealtimeIndicator` class, polling
widget wired into `static/chart-analysis.js` (instantiated per active
chart tile if `window.RealtimeIndicator` is present). Status colors:
`delayed / warning / stale / disconnected / market_closed / no_trades /
connecting / replay`. Tooltip shows source, market time, server-received
time, displayed time, and delay. Polling stops when the browser tab loses
focus and resumes (with an immediate fetch) when it regains it — verified
no duplicate polling requests accumulate across repeated
Portfolio → Charts → Replay tab switches. `showReplayMode()` swaps the
indicator into a static "replay" state so Market Replay (which plays back
historical bars, not live data) doesn't show a misleading live delay.

`window.REALTIME_CONFIG` is injected server-side into
`templates/index.html` from `app.py:index()` so the frontend's status
thresholds always match the backend's, without a second round trip.
