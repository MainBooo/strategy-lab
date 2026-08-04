from __future__ import annotations

import pytest

import app as app_module
import market_data_store as store
import replay_db as db

TICKER, BOARD, TF = "SBER", "TQBR", "10m"
BASE_TS = 1780308000  # 2026-06-01 10:00 UTC-as-naive


@pytest.fixture()
def client(tmp_path):
    store.init_db(tmp_path / "market_data.db")
    db.init_db(tmp_path / "replay.db")
    app_module.app.testing = True
    rows = [{"ts": BASE_TS + i * 600, "open": 100, "high": 101, "low": 99, "close": 100 + i * 0.1, "volume": 10}
            for i in range(20)]
    store.upsert_candles(TICKER, BOARD, TF, rows)
    with app_module.app.test_client() as c:
        yield c


def _create_session(client, **overrides):
    payload = {
        "ticker": TICKER, "board": BOARD, "timeframe": TF,
        "start_date": "2026-06-01", "start_hour": 10, "start_minute": 0,
        "starting_balance": 100000, "commission_rate": 0, "slippage_bps": 0, "speed": 1,
    }
    payload.update(overrides)
    return client.post("/api/replay/sessions", json=payload)


def test_create_session_requires_ticker(client):
    resp = _create_session(client, ticker="")
    assert resp.status_code == 400


def test_create_session_rejects_aggregate_timeframe(client):
    resp = _create_session(client, timeframe="4h")
    assert resp.status_code == 400


def test_full_session_lifecycle_via_http(client):
    resp = _create_session(client)
    assert resp.status_code == 201
    data = resp.get_json()
    sid = data["session"]["id"]
    assert data["revealed"] == []  # nothing revealed yet - future hidden at creation

    resp = client.get(f"/api/replay/sessions/{sid}")
    assert resp.status_code == 200

    resp = client.post(f"/api/replay/sessions/{sid}/step")
    assert resp.status_code == 200
    step1 = resp.get_json()
    assert len(step1["revealed"]) == 1
    price = step1["current_price"]

    resp = client.post(f"/api/replay/sessions/{sid}/order", json={"action": "buy", "lots": 1})
    assert resp.status_code == 200
    assert resp.get_json()["session"]["position_side"] == "long"

    resp = client.get(f"/api/replay/sessions/{sid}/trades")
    assert resp.status_code == 200
    assert len(resp.get_json()) == 1

    resp = client.post(f"/api/replay/sessions/{sid}/step")
    assert resp.status_code == 200

    resp = client.post(f"/api/replay/sessions/{sid}/back")
    assert resp.status_code == 200

    resp = client.post(f"/api/replay/sessions/{sid}/order", json={"action": "close", "lots": 1})
    assert resp.status_code == 200
    assert resp.get_json()["session"]["position_side"] is None

    resp = client.delete(f"/api/replay/sessions/{sid}")
    assert resp.status_code == 200
    assert client.get(f"/api/replay/sessions/{sid}").status_code == 404


def test_order_without_position_rejected_with_400(client):
    sid = _create_session(client).get_json()["session"]["id"]
    client.post(f"/api/replay/sessions/{sid}/step")
    resp = client.post(f"/api/replay/sessions/{sid}/order", json={"action": "close", "lots": 1})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_unknown_session_returns_404_not_500(client):
    assert client.post("/api/replay/sessions/does-not-exist/step").status_code == 404
    assert client.post("/api/replay/sessions/does-not-exist/order", json={"action": "buy", "lots": 1}).status_code == 404
    assert client.get("/api/replay/sessions/does-not-exist/trades").status_code == 404


def test_list_sessions_excludes_undo_stack_internal_field(client):
    _create_session(client)
    resp = client.get("/api/replay/sessions")
    assert resp.status_code == 200
    items = resp.get_json()
    assert len(items) == 1
    assert "undo_stack_json" not in items[0]
