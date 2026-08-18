from __future__ import annotations

import contextlib
import fcntl
import json
import logging
import os
import time
import uuid
from pathlib import Path

log = logging.getLogger(__name__)

SCHEMA_VERSION = 4


def _positive_capital(value, fallback: float) -> float:
    """`value or fallback` only guards 0/None - a negative starting_capital
    passed validation and made every backtest reject every trade for
    insufficient cash, returning a meaningless zero-trade/0%-return summary
    instead of a clear validation error."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    return n if n > 0 else fallback


class PortfolioStore:
    """JSON-file portfolio storage with an additive, backward-compatible schema.

    v1 portfolios had a single ``strategy``/``params`` pair applied to every
    instrument. v2 added ``default_strategy_id`` (v1's ``strategy`` renamed)
    plus a ``ticker_strategies`` override map of at most one strategy per
    ticker (``{TICKER: {strategy_id, parameters}}``). v3 turns each of those
    values into a *list* of assignments (``{TICKER: [{strategy_id,
    parameters, enabled}, ...]}``) so one instrument can carry several
    strategies (or all of them) at once - a v2 single-dict override becomes
    a one-element list. ``_migrate_one`` normalizes on read so older files
    load with the new fields already filled in, and persists that once with
    a backup of the pre-migration file.
    """

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text("[]", encoding="utf-8")
        self._lock_path = self.path.with_name(f".{self.path.name}.lock")
        self._migrate_if_needed()

    @contextlib.contextmanager
    def _locked(self):
        """Cross-process mutex around one read-modify-write cycle.

        Gunicorn runs multiple worker *processes*; every mutator here reads
        the whole file, mutates in memory, then overwrites it - with no
        locking, two near-simultaneous requests (a background job's
        mark_backtested() landing right after a user's replace(), say) can
        both read the same snapshot and whichever _write() lands second
        silently discards the other's change. flock() on a lock file that's
        never itself replaced (unlike self.path, which os.replace() swaps
        the inode of) is a real mutex across processes, not just threads.
        """
        fd = os.open(self._lock_path, os.O_CREAT | os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def _read_raw(self) -> list[dict]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []

    def _write(self, items: list[dict]) -> None:
        tmp = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex[:8]}.tmp")
        tmp.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    @staticmethod
    def _migrate_one(p: dict) -> tuple[dict, bool]:
        changed = False
        if "default_strategy_id" not in p:
            p["default_strategy_id"] = p.get("strategy") or "false_breakout"
            changed = True
        if "strategy" not in p:
            # Keep the old key populated too, for any external tooling/backup
            # diffing that still expects it.
            p["strategy"] = p["default_strategy_id"]
            changed = True
        if "ticker_strategies" not in p:
            p["ticker_strategies"] = {}
            changed = True
        if "params" not in p:
            p["params"] = {}
            changed = True
        if "created_at" not in p:
            p["created_at"] = time.time()
            changed = True
        if "updated_at" not in p:
            p["updated_at"] = p["created_at"]
            changed = True
        if "last_backtest_at" not in p:
            p["last_backtest_at"] = None
            changed = True
        # v3 -> v4: accounts (see auth_db.py) - every portfolio predating
        # this migration was created in the app's original single-operator,
        # no-login era, so it stays unowned/shared (None) rather than being
        # guessed into belonging to whichever user happens to look at it
        # first. Only portfolios created after this ship with a real owner.
        if "user_id" not in p:
            p["user_id"] = None
            changed = True
        # v2 -> v3: {ticker: {strategy_id, parameters}} -> {ticker: [{strategy_id, parameters, enabled}]}
        ts = p.get("ticker_strategies") or {}
        for ticker, value in list(ts.items()):
            if isinstance(value, dict):
                value.setdefault("enabled", True)
                ts[ticker] = [value]
                changed = True
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict) and "enabled" not in item:
                        item["enabled"] = True; changed = True
        p["ticker_strategies"] = ts
        if "schema_version" not in p or p["schema_version"] != SCHEMA_VERSION:
            p["schema_version"] = SCHEMA_VERSION
            changed = True
        for instrument in p.get("instruments", []):
            if "lot_size" not in instrument:
                instrument["lot_size"] = 1; changed = True
            if "lot_count" not in instrument:
                instrument["lot_count"] = 1; changed = True
        return p, changed

    def _migrate_if_needed(self) -> None:
        items = self._read_raw()
        if not items:
            return
        migrated = []
        any_changed = False
        for p in items:
            new_p, changed = self._migrate_one(dict(p))
            migrated.append(new_p)
            any_changed = any_changed or changed
        if any_changed:
            backup_path = self.path.with_name(f"{self.path.stem}.pre-v{SCHEMA_VERSION}-migration.json")
            if not backup_path.exists():
                try:
                    backup_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
                    log.info("Portfolio schema migration: backed up pre-migration data to %s", backup_path)
                except OSError:
                    log.exception("Could not write portfolio migration backup, aborting migration write")
                    return
            self._write(migrated)
            log.info("Portfolio schema migration: normalized %d portfolio(s) to schema v%d", len(migrated), SCHEMA_VERSION)

    def _read(self) -> list[dict]:
        return self._read_raw()

    def list(self) -> list[dict]:
        return self._read()

    def get(self, portfolio_id: str) -> dict | None:
        return next((x for x in self._read() if x.get("id") == portfolio_id), None)

    def create(self, payload: dict, user_id: str | None = None) -> dict:
        with self._locked():
            items = self._read()
            now = time.time()
            default_strategy = str(payload.get("default_strategy_id") or payload.get("strategy") or "false_breakout")
            portfolio = {
                "id": uuid.uuid4().hex[:12],
                "name": str(payload.get("name") or "Новый портфель"),
                "starting_capital": _positive_capital(payload.get("starting_capital"), 10_000),
                "strategy": default_strategy,
                "default_strategy_id": default_strategy,
                "ticker_strategies": payload.get("ticker_strategies") or {},
                "params": payload.get("params") or {},
                "instruments": payload.get("instruments") or [],
                "created_at": now,
                "updated_at": now,
                "last_backtest_at": None,
                "schema_version": SCHEMA_VERSION,
                # None = unowned/shared, same as every portfolio created before
                # accounts existed - only set when a logged-in user's session
                # created this portfolio (see app.py's create_portfolio route).
                "user_id": user_id,
            }
            items.append(portfolio)
            self._write(items)
            return portfolio

    def update(self, portfolio_id: str, **fields) -> dict | None:
        with self._locked():
            items = self._read()
            for p in items:
                if p.get("id") == portfolio_id:
                    p.update(fields)
                    p["updated_at"] = time.time()
                    self._write(items)
                    return p
            return None

    def add_instruments(self, portfolio_id: str, instruments: list[dict]) -> dict | None:
        with self._locked():
            items = self._read()
            for p in items:
                if p.get("id") == portfolio_id:
                    existing = {str(i["ticker"]): i for i in p.get("instruments", [])}
                    for inst in instruments:
                        existing[str(inst["ticker"])] = inst
                    p["instruments"] = list(existing.values())
                    p["updated_at"] = time.time()
                    self._write(items)
                    return p
            return None

    def update_instrument_file(self, portfolio_id: str, ticker: str, filename: str) -> dict | None:
        """Point one existing instrument at a freshly-downloaded data file,
        leaving its lot_count/lot_size and every other field untouched -
        unlike add_instruments, which replaces the whole instrument dict."""
        with self._locked():
            items = self._read()
            for p in items:
                if p.get("id") == portfolio_id:
                    for inst in p.get("instruments", []):
                        if str(inst.get("ticker")) == str(ticker):
                            inst["file"] = filename
                            p["updated_at"] = time.time()
                            self._write(items)
                            return p
                    return None
            return None

    def remove_instruments(self, portfolio_id: str, tickers: list[str]) -> dict | None:
        with self._locked():
            items = self._read()
            remove_set = {str(t).upper() for t in tickers}
            for p in items:
                if p.get("id") == portfolio_id:
                    p["instruments"] = [i for i in p.get("instruments", []) if str(i["ticker"]).upper() not in remove_set]
                    for t in remove_set:
                        p.get("ticker_strategies", {}).pop(t, None)
                    p["updated_at"] = time.time()
                    self._write(items)
                    return p
            return None

    def set_ticker_strategies(self, portfolio_id: str, default_strategy_id: str | None, ticker_strategies: dict | None) -> dict | None:
        with self._locked():
            items = self._read()
            for p in items:
                if p.get("id") == portfolio_id:
                    if default_strategy_id:
                        p["default_strategy_id"] = default_strategy_id
                        p["strategy"] = default_strategy_id
                    if ticker_strategies is not None:
                        p["ticker_strategies"] = ticker_strategies
                    p["updated_at"] = time.time()
                    self._write(items)
                    return p
            return None

    def replace(self, portfolio_id: str, payload: dict) -> dict | None:
        """Full-portfolio save used by the editor's explicit "Сохранить
        изменения" action - overwrites the editable fields atomically in one
        write instead of several piecemeal PATCH calls, so there is one
        well-defined moment the portfolio changes rather than a sequence of
        partial autosaves."""
        with self._locked():
            items = self._read()
            for p in items:
                if p.get("id") == portfolio_id:
                    if "name" in payload:
                        p["name"] = str(payload["name"] or p["name"])
                    if "starting_capital" in payload:
                        p["starting_capital"] = _positive_capital(payload["starting_capital"], p["starting_capital"])
                    if "instruments" in payload:
                        p["instruments"] = payload["instruments"] or []
                    if "default_strategy_id" in payload and payload["default_strategy_id"]:
                        p["default_strategy_id"] = payload["default_strategy_id"]
                        p["strategy"] = payload["default_strategy_id"]
                    if "ticker_strategies" in payload:
                        p["ticker_strategies"] = payload["ticker_strategies"] or {}
                    if "params" in payload:
                        p["params"] = payload["params"] or {}
                    p["updated_at"] = time.time()
                    self._write(items)
                    return p
            return None

    def mark_backtested(self, portfolio_id: str) -> None:
        with self._locked():
            items = self._read()
            for p in items:
                if p.get("id") == portfolio_id:
                    p["last_backtest_at"] = time.time()
                    self._write(items)
                    return

    def delete(self, portfolio_id: str) -> bool:
        with self._locked():
            items = self._read()
            filtered = [x for x in items if x.get("id") != portfolio_id]
            if len(filtered) == len(items):
                return False
            self._write(filtered)
            return True
