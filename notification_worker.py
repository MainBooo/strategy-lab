from __future__ import annotations

"""Single-leader background evaluator for persistent price alerts.

Strategy Lab runs multiple gunicorn workers. Each imports app.py, so starting a
plain daemon thread in every process would duplicate notifications. A Linux
flock elects one process as the evaluator leader; if that worker dies, another
process can become leader after restart. SQLite's atomic evaluate_symbol is a
second safety layer against duplicate threshold transitions.
"""

import fcntl
import logging
import os
import threading
import time
from pathlib import Path

import notifications_db as ndb
from market_ticker import get_prices
from notification_delivery import dispatch_event

log = logging.getLogger(__name__)
_started = False
_start_lock = threading.Lock()


def start(lock_path: Path) -> None:
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    if os.environ.get("ALERT_WORKER_ENABLED", "true").strip().lower() in ("0", "false", "no", ""):
        log.info("Price alert worker disabled by ALERT_WORKER_ENABLED")
        return
    thread = threading.Thread(target=_run, args=(lock_path,), name="price-alert-worker", daemon=True)
    thread.start()


def _run(lock_path: Path) -> None:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = open(lock_path, "a+")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log.info("Another process owns the price-alert worker lock; staying passive")
        lock_file.close()
        return

    interval = max(15, int(os.environ.get("ALERT_POLL_INTERVAL_SECONDS", "45")))
    log.info("Price alert worker started (interval=%ss)", interval)
    while True:
        started = time.monotonic()
        try:
            symbols = ndb.enabled_symbols()
            if symbols:
                snapshot = get_prices(symbols)
                if snapshot.get("error") and not snapshot.get("prices"):
                    log.warning("Alert evaluation skipped: market prices unavailable: %s", snapshot.get("error"))
                else:
                    for symbol, quote in snapshot.get("prices", {}).items():
                        price = quote.get("last")
                        if price is None:
                            continue
                        events = ndb.evaluate_symbol(symbol, float(price))
                        for event in events:
                            try:
                                dispatch_event(event)
                            except Exception:
                                log.exception("Alert event dispatch failed: %s", event.get("id"))
        except Exception:
            log.exception("Price alert worker iteration failed")
        elapsed = time.monotonic() - started
        time.sleep(max(1.0, interval - elapsed))
