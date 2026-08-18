from __future__ import annotations

import contextlib
import fcntl
import json
import os
import threading
import time
import uuid
from pathlib import Path


class JobStore:
    """Filesystem-backed job status store.

    Gunicorn runs multiple worker *processes*; a poll request can land on a
    different process than the one running the job's background thread, so
    status cannot live in memory. Each job is one JSON file on disk instead,
    written atomically (temp file + os.replace) so readers never see a
    half-written file. Cancellation uses a separate ``<job_id>.cancel``
    sentinel file to avoid the cancel endpoint and the worker thread racing
    on the same job file.
    """

    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._recover_interrupted()

    def _lock_for(self, job_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(job_id, threading.Lock())

    def _path(self, job_id: str) -> Path:
        return self.dir / f"{job_id}.json"

    def _cancel_path(self, job_id: str) -> Path:
        return self.dir / f"{job_id}.cancel"

    def _recover_interrupted(self) -> None:
        # A job left "queued"/"running" on disk belonged to a worker thread
        # that died with its process (restart/crash) - it will never update
        # again, so mark it failed instead of leaving the frontend polling
        # forever after a service restart.
        for path in self.dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if data.get("status") in ("queued", "running"):
                data["status"] = "failed"
                data["error"] = {
                    "message": "Расчёт был прерван перезапуском сервиса. Запустите заново.",
                    "ticker": None,
                    "stage": data.get("stage"),
                    "code": "interrupted",
                }
                data["updated_at"] = time.time()
                self._write(path, data)

    def _write(self, path: Path, data: dict) -> None:
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def create(self, portfolio_id: str | None, portfolio_name: str, total: int, kind: str = "portfolio_run", extra: dict | None = None) -> dict:
        job_id = uuid.uuid4().hex[:16]
        data = {
            "job_id": job_id,
            "kind": kind,
            "portfolio_id": portfolio_id,
            "portfolio_name": portfolio_name,
            "status": "queued",
            "total": total,
            "completed": 0,
            "current_ticker": None,
            "percent": 0,
            "stage": "В очереди",
            "error": None,
            "errors": [],
            "result": None,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        if extra:
            data.update(extra)
        self._write(self._path(job_id), data)
        return data

    def get(self, job_id: str) -> dict | None:
        path = self._path(job_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def update(self, job_id: str, **fields) -> None:
        with self._lock_for(job_id):
            data = self.get(job_id) or {"job_id": job_id}
            data.update(fields)
            data["updated_at"] = time.time()
            self._write(self._path(job_id), data)

    @contextlib.contextmanager
    def portfolio_lock(self, portfolio_id: str | None, kind: str):
        """Serialize find-active-then-create for one portfolio+kind across processes.

        Gunicorn runs multiple worker *processes*, so an in-memory
        threading.Lock can't stop two near-simultaneous requests (double
        click, two tabs) from both seeing "no active job" and both creating
        one. flock() on a per-portfolio lock file is a real cross-process
        mutex; hold it around the whole find-then-create sequence at the
        call site, not just around ``create``.
        """
        if not portfolio_id:
            yield
            return
        lock_path = self.dir / f".lock_{portfolio_id}_{kind}"
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def find_active_for_portfolio(self, portfolio_id: str, kind: str | None = None) -> dict | None:
        candidates = []
        for path in self.dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if data.get("portfolio_id") != portfolio_id or data.get("status") not in ("queued", "running"):
                continue
            if kind is not None and data.get("kind") != kind:
                continue
            candidates.append(data)
        candidates.sort(key=lambda d: d.get("created_at", 0), reverse=True)
        return candidates[0] if candidates else None

    def request_cancel(self, job_id: str) -> bool:
        if self.get(job_id) is None:
            return False
        self._cancel_path(job_id).write_text("1", encoding="utf-8")
        return True

    def is_cancel_requested(self, job_id: str) -> bool:
        return self._cancel_path(job_id).exists()

    def clear_cancel(self, job_id: str) -> None:
        try:
            self._cancel_path(job_id).unlink()
        except OSError:
            pass
