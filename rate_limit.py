from __future__ import annotations

"""Minimal, dependency-free protection for a free public server against
accidental self-inflicted overload: a per-IP sliding-window request limiter
and a process-wide semaphore bounding how many heavy computations (backtest/
optimize/portfolio-run/market-data-sync) can run at once.

Deliberately not Redis/flask-limiter: this is a 2-worker single-box
deployment (see moex-strategy-lab.service), and a corporate-grade
distributed limiter would be solving a problem this app doesn't have. Both
limiters are in-process (per gunicorn worker, not shared across the 2
workers) - good enough to stop one browser tab or one runaway script from
saturating the box, not a defense against a determined distributed attacker.
That tradeoff is intentional; see docs.
"""

import threading
import time
from collections import defaultdict, deque


class SlidingWindowLimiter:
    """Per-key (typically per-IP) cap on requests within a rolling window."""

    def __init__(self, max_requests: int, window_seconds: float):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > self.window_seconds:
                q.popleft()
            if len(q) >= self.max_requests:
                return False
            q.append(now)
            return True

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


class BoundedConcurrency:
    """Caps how many heavy operations run at once, process-wide. Backed by a
    plain Semaphore (not a queue) - a rejected request fails fast with a
    clear "server busy" message instead of piling up waiters, which is the
    simplest thing that prevents an accidental pile of expensive jobs from
    taking the box down."""

    def __init__(self, max_concurrent: int):
        self._sem = threading.Semaphore(max(1, max_concurrent))

    def try_acquire(self) -> bool:
        return self._sem.acquire(blocking=False)

    def release(self) -> None:
        self._sem.release()

    def run_in_background(self, target, *args, **kwargs) -> None:
        """Spawns target(*args, **kwargs) in a daemon thread that releases
        the slot (already acquired by the caller via try_acquire()) when it
        finishes, success or failure."""
        def _wrapped():
            try:
                target(*args, **kwargs)
            finally:
                self.release()
        threading.Thread(target=_wrapped, daemon=True).start()


def client_ip(request) -> str:
    """Best-effort client identity for the per-IP limiter. This app's nginx
    vhosts set X-Forwarded-For to $proxy_add_x_forwarded_for, which APPENDS
    the real peer address to whatever the client already sent rather than
    replacing it - so the trustworthy value is the LAST entry (the one
    nginx itself added), never the first (fully attacker-controlled; taking
    it would make the limiter trivially bypassable by sending a random
    X-Forwarded-For per request)."""
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.remote_addr or "unknown"
