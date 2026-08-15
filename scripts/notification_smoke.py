#!/usr/bin/env python3
"""Offline smoke test for server-side alert transition semantics."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

# When this file is executed directly, Python puts ./scripts (not the
# repository root) on sys.path. Add the project root explicitly so the smoke
# test works exactly as documented: `.venv/bin/python scripts/notification_smoke.py`.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import notifications_db as ndb


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        ndb.init_db(Path(tmp) / "notifications.db")
        uid = "u1"

        once = ndb.create_alert(uid, symbol="SBER", condition="price_above", value=300, repeat="once")
        assert ndb.evaluate_symbol("SBER", 299) == []
        events = ndb.evaluate_symbol("SBER", 301)
        assert len(events) == 1 and events[0]["alert_id"] == once["id"]
        assert ndb.evaluate_symbol("SBER", 302) == []
        assert ndb.get_alert(uid, once["id"])["enabled"] is False

        repeat = ndb.create_alert(uid, symbol="GAZP", condition="price_above", value=150, repeat="repeat")
        assert len(ndb.evaluate_symbol("GAZP", 151)) == 1
        assert ndb.evaluate_symbol("GAZP", 152) == []  # no spam while still above
        assert ndb.evaluate_symbol("GAZP", 149) == []  # re-arm
        assert len(ndb.evaluate_symbol("GAZP", 151)) == 1
        assert ndb.get_alert(uid, repeat["id"])["trigger_count"] == 2

        cross = ndb.create_alert(uid, symbol="LKOH", condition="cross_down", value=5000, repeat="repeat")
        assert ndb.evaluate_symbol("LKOH", 5100) == []
        assert len(ndb.evaluate_symbol("LKOH", 4999)) == 1
        assert ndb.evaluate_symbol("LKOH", 4900) == []
        assert ndb.evaluate_symbol("LKOH", 5100) == []
        assert len(ndb.evaluate_symbol("LKOH", 4990)) == 1
        assert ndb.get_alert(uid, cross["id"])["trigger_count"] == 2

    print("notification smoke: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
