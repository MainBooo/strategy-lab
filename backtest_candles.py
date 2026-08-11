from __future__ import annotations

"""Bridges the honest, timeframe-generic candle pipeline (candle_api.py /
market_data_store.py) into the backtest engine (app.py + strategies/*),
which only ever reads OHLCV from a pinned per-instrument CSV file at
whatever granularity happened to be downloaded for it (almost always 10m).

This module never re-implements aggregation - it only loops candle_api's
own cursor pagination to pull a full date range, then writes it out as a
CSV in the exact column shape strategies/common.py's load_candles() already
understands. Strategies themselves are never touched: they keep reading a
Path, unaware whether it points at the original pinned file or an honestly
materialized alternate-timeframe cache.
"""

from datetime import datetime
from pathlib import Path

import candle_api
from timeframes import canonical

_MAX_PAGES = 200  # generous cap against a runaway loop; a realistic
# backtest date range at 1m granularity is at most tens of thousands of
# bars, comfortably under _MAX_PAGES * a several-thousand-candle page size.

_INTERVAL_TO_TIMEFRAME = {1: "1m", 10: "10m", 60: "60m", 1440: "1d"}


def interval_to_timeframe(interval_minutes: int | None) -> str | None:
    """Maps the portfolio-builder pipeline's plain interval-minutes int
    (FILENAME_RE's `(\\d+)m` group) onto the canonical timeframe strings
    this module and candle_api share."""
    if interval_minutes is None:
        return None
    return _INTERVAL_TO_TIMEFRAME.get(int(interval_minutes))


def fetch_full_range(*, ticker: str, board: str, timeframe: str, date_from: str, date_till: str,
                      market: str = "shares", engine: str = "stock", page_limit: int = 5000) -> dict:
    """Honestly pulls every candle candle_api can produce for [date_from,
    date_till] at `timeframe` - native fetch (auto-syncing from MOEX ISS)
    or aggregation from a strictly finer native base, per candle_api's own
    AGGREGATE_TIMEFRAMES. Never fabricates a candle: an empty result means
    MOEX genuinely has nothing there (or the timeframe can't be derived for
    this ticker at all).

    Returns {"candles": [...] (ascending, unix-seconds), "covered": bool}.
    covered=True only when the pull reached back to date_from without
    truncation; a ticker with SOME but not all of the requested range is
    covered=False, same "partial gap" concept /data-coverage already
    reports for the legacy pinned-file check.
    """
    pages: list[list[dict]] = []
    before: int | None = None
    reached_start = False
    for _ in range(_MAX_PAGES):
        page = candle_api.get_candles(
            None, ticker=ticker, board=board, timeframe=timeframe,
            from_date=date_from, till_date=date_till, limit=page_limit,
            before=before, market=market, engine=engine,
        )
        candles = page.get("candles") or []
        if candles:
            pages.append(candles)
        if not page.get("hasOlder"):
            reached_start = True
            break
        before = candles[0]["time"] if candles else before
        if before is None:
            break
    merged: dict[int, dict] = {}
    for page in pages:
        for c in page:
            merged[int(c["time"])] = c
    ordered = [merged[t] for t in sorted(merged)]
    return {"candles": ordered, "covered": bool(ordered) and reached_start}


def materialize_csv(candles: list[dict], dest_path: Path) -> Path:
    """Writes candles (unix-seconds, ascending) as a CSV strategies/common.py's
    load_candles() can read as-is: header `datetime,open,high,low,close,volume`.
    Uses datetime.utcfromtimestamp - NOT fromtimestamp() (would depend on the
    host's local timezone) - matching the "naive MSK wall-clock stored as if
    it were UTC" convention already used end-to-end by candle_api.py,
    market_data_sync.py and the frontend's parseNaiveDatetime()."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["datetime,open,high,low,close,volume"]
    for c in candles:
        dt = datetime.utcfromtimestamp(int(c["time"])).strftime("%Y-%m-%d %H:%M:%S")
        lines.append(f"{dt},{c['open']},{c['high']},{c['low']},{c['close']},{c.get('volume', 0)}")
    dest_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return dest_path


def _infer_range_from_csv(path: Path) -> tuple[str, str] | None:
    """Honest fallback date range when the caller didn't pin one down: the
    first/last datetime values actually present in a pinned-file CSV - read
    straight from the file's own content (not the filename, which only
    records what was *requested* at download time), so a backtest run left
    without an explicit period still gets a real, bounded range to build an
    alternate timeframe on instead of refusing outright.

    Pinned files keep MOEX's own column order (`open,close,high,low,value,
    volume,begin,end` - see strategies/common.py's load_candles() aliasing),
    not materialize_csv()'s own `datetime,...` shape, so the datetime column
    must be located by header name rather than assumed to be first."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    if not lines:
        return None
    header = [h.strip().lower() for h in lines[0].split(",")]
    try:
        idx = header.index("begin") if "begin" in header else header.index("datetime")
    except ValueError:
        return None
    rows = [ln.split(",") for ln in lines[1:] if ln.strip()]
    rows = [r for r in rows if len(r) > idx]
    if not rows:
        return None
    first = rows[0][idx].strip()
    last = rows[-1][idx].strip()
    return (first[:10], last[:10])


def get_or_build_source(*, ticker: str, board: str, timeframe: str, date_from: str | None,
                         date_till: str | None, cache_dir: Path, native_file: Path | None,
                         native_file_interval: int | None) -> Path | None:
    """Single entry point shared by backtest execution, the pre-flight
    availability check and the trade-chart candles endpoint.

    Fast path: if the requested timeframe is exactly the granularity the
    portfolio's pinned file already has, returns native_file unchanged -
    byte-identical to the pre-existing behaviour, zero regression risk for
    the overwhelmingly common case (10m) and every run made before this
    feature existed.

    Otherwise pulls an honest candle set via fetch_full_range() and
    materializes it into cache_dir. A run with no explicit date_from/
    date_till (the backtest screen's period picker is optional) falls back
    to the pinned native file's own range rather than refusing - matching
    what a same-timeframe run would silently do by reading the whole file.
    Returns None when there is genuinely no data to run on (caller turns
    this into the "недоступно" block)."""
    tf = canonical(timeframe or "10m")
    native_tf = interval_to_timeframe(native_file_interval)
    if native_file is not None and native_tf and canonical(native_tf) == tf and native_file.exists():
        return native_file

    if (not date_from or not date_till) and native_file is not None and native_file.exists():
        inferred = _infer_range_from_csv(native_file)
        if inferred:
            date_from = date_from or inferred[0]
            date_till = date_till or inferred[1]

    if not date_from or not date_till:
        return None
    result = fetch_full_range(ticker=ticker, board=board, timeframe=tf, date_from=date_from, date_till=date_till)
    if not result["candles"]:
        return None
    dest = cache_dir / f"{ticker.upper()}__{tf}__{date_from}__{date_till}.csv"
    return materialize_csv(result["candles"], dest)
