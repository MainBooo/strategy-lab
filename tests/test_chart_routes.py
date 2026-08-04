from __future__ import annotations

import pytest

import app as app_module
import charts_db as cdb


@pytest.fixture()
def client(tmp_path):
    cdb.init_db(tmp_path / "charts.db")  # repoints the shared module-level _DB_PATH
    app_module.app.testing = True
    with app_module.app.test_client() as c:
        yield c


def test_create_list_get_delete_layout(client):
    resp = client.post("/api/chart-layouts", json={"name": "Основной", "symbol": "SBER", "timeframe": "1d"})
    assert resp.status_code == 201
    layout = resp.get_json()

    resp = client.get(f"/api/chart-layouts?context=analysis&symbol=SBER")
    assert resp.status_code == 200
    assert any(l["id"] == layout["id"] for l in resp.get_json())

    resp = client.get(f"/api/chart-layouts/{layout['id']}")
    assert resp.status_code == 200
    assert resp.get_json()["drawings"] == []

    resp = client.delete(f"/api/chart-layouts/{layout['id']}")
    assert resp.status_code == 200
    assert client.get(f"/api/chart-layouts/{layout['id']}").status_code == 404


def test_create_layout_requires_name(client):
    resp = client.post("/api/chart-layouts", json={"symbol": "SBER"})
    assert resp.status_code == 400


def test_drawing_lifecycle(client):
    layout = client.post("/api/chart-layouts", json={"name": "A", "symbol": "SBER"}).get_json()
    resp = client.post(f"/api/chart-layouts/{layout['id']}/drawings", json={
        "type": "horizontal_line", "points": [{"time": 1700000000, "price": 250.5}], "properties": {"color": "#7c8cff"},
    })
    assert resp.status_code == 201
    drawing = resp.get_json()

    resp = client.put(f"/api/chart-drawings/{drawing['id']}", json={"locked": True})
    assert resp.status_code == 200
    assert resp.get_json()["locked"] is True

    resp = client.delete(f"/api/chart-drawings/{drawing['id']}")
    assert resp.status_code == 200
    assert client.get(f"/api/chart-layouts/{layout['id']}/drawings").get_json() == []


def test_drawing_requires_points_and_type(client):
    layout = client.post("/api/chart-layouts", json={"name": "A", "symbol": "SBER"}).get_json()
    resp = client.post(f"/api/chart-layouts/{layout['id']}/drawings", json={"type": "text"})
    assert resp.status_code == 400


def test_drawing_on_missing_layout_is_404(client):
    resp = client.post("/api/chart-layouts/does-not-exist/drawings", json={
        "type": "text", "points": [{"time": 1, "price": 1}],
    })
    assert resp.status_code == 404


def test_strategy_request_requires_idea(client):
    resp = client.post("/api/chart-strategy-requests", json={"symbol": "SBER"})
    assert resp.status_code == 400
    resp = client.post("/api/chart-strategy-requests", json={"symbol": "SBER", "ideaDescription": "Пробой уровня"})
    assert resp.status_code == 201
    assert resp.get_json()["status"] == "new"


def test_candles_endpoint_validates_symbol(client):
    resp = client.get("/api/candles?timeframe=1d")
    assert resp.status_code == 400


def test_candles_endpoint_returns_mocked_data(client, monkeypatch):
    monkeypatch.setattr(app_module, "get_candles", lambda *a, **k: {"candles": [{"time": 1, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}], "nextCursor": None})
    resp = client.get("/api/candles?symbol=SBER&timeframe=1d&from=2025-01-01&to=2025-01-02")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["symbol"] == "SBER"
    assert len(body["candles"]) == 1


def test_candles_endpoint_rejects_bad_timeframe(client, monkeypatch):
    def _raise(*a, **k):
        raise ValueError("Неизвестный таймфрейм: 3d")
    monkeypatch.setattr(app_module, "get_candles", _raise)
    resp = client.get("/api/candles?symbol=SBER&timeframe=3d&from=2025-01-01&to=2025-01-02")
    assert resp.status_code == 400
