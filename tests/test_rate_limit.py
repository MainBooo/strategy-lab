from __future__ import annotations

import threading
import time

import app as app_module
from rate_limit import BoundedConcurrency, SlidingWindowLimiter, client_ip


def test_sliding_window_limiter_blocks_after_max_then_recovers():
    limiter = SlidingWindowLimiter(max_requests=2, window_seconds=0.05)
    assert limiter.allow("1.2.3.4") is True
    assert limiter.allow("1.2.3.4") is True
    assert limiter.allow("1.2.3.4") is False  # 3rd request within the window is rejected
    time.sleep(0.06)
    assert limiter.allow("1.2.3.4") is True  # window rolled past, slot freed up


def test_sliding_window_limiter_keys_are_independent():
    limiter = SlidingWindowLimiter(max_requests=1, window_seconds=5)
    assert limiter.allow("a") is True
    assert limiter.allow("b") is True  # different key, unaffected by "a"'s usage
    assert limiter.allow("a") is False


def test_client_ip_trusts_last_xff_entry_not_first():
    class FakeRequest:
        headers = {"X-Forwarded-For": "attacker-spoofed, 203.0.113.9"}
        remote_addr = "127.0.0.1"
    assert client_ip(FakeRequest()) == "203.0.113.9"


def test_client_ip_falls_back_to_remote_addr():
    class FakeRequest:
        headers = {}
        remote_addr = "10.0.0.5"
    assert client_ip(FakeRequest()) == "10.0.0.5"


def test_bounded_concurrency_rejects_beyond_capacity():
    sem = BoundedConcurrency(1)
    assert sem.try_acquire() is True
    assert sem.try_acquire() is False  # already at capacity
    sem.release()
    assert sem.try_acquire() is True


def test_bounded_concurrency_run_in_background_releases_on_completion():
    sem = BoundedConcurrency(1)
    assert sem.try_acquire() is True
    done = threading.Event()
    sem.run_in_background(lambda: done.set())
    assert done.wait(timeout=2)
    # give the finally-block release a moment to land after the event fires
    for _ in range(50):
        if sem.try_acquire():
            return
        time.sleep(0.02)
    raise AssertionError("slot was never released after background job finished")


def test_bounded_concurrency_releases_even_if_target_raises():
    sem = BoundedConcurrency(1)
    assert sem.try_acquire() is True
    done = threading.Event()

    def _boom():
        done.set()
        raise RuntimeError("boom")

    sem.run_in_background(_boom)
    assert done.wait(timeout=2)
    for _ in range(50):
        if sem.try_acquire():
            return
        time.sleep(0.02)
    raise AssertionError("slot leaked after background job raised")


def test_heavy_endpoint_returns_503_when_server_busy(tmp_path, monkeypatch):
    app_module.app.testing = True
    monkeypatch.setattr(app_module, "HEAVY_TRIGGER_LIMITER", SlidingWindowLimiter(max_requests=1000, window_seconds=60))
    held = 0
    while app_module.HEAVY_OPS.try_acquire():  # drain every slot, whatever MAX_CONCURRENT_HEAVY_JOBS is
        held += 1
    try:
        with app_module.app.test_client() as c:
            resp = c.post("/api/backtest", json={"file": "does_not_matter.csv", "strategy": "false_breakout"})
        assert resp.status_code == 503
        assert "error" in resp.get_json()
    finally:
        for _ in range(held):
            app_module.HEAVY_OPS.release()
