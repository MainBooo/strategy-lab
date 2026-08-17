from __future__ import annotations

import time

import pytest

import app as app_module
import binance_market_data
import market_data_store as store
from tests.binance_fixtures import fake_klines_request


@pytest.fixture()
def client(tmp_path, monkeypatch):
    store.init_db(tmp_path / "market_data.db")  # repoints the shared module-level _DB_PATH
    app_module.app.testing = True
    monkeypatch.setattr(binance_market_data, "request", fake_klines_request([]))
    with app_module.app.test_client() as c:
        yield c


def test_market_data_instruments_lists_catalog_and_coverage(client):
    resp = client.get("/api/market-data/instruments")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "items" in data and "native_timeframes" in data and "all_timeframes" in data
    assert "1m" in data["native_timeframes"]
    assert "10m" not in data["native_timeframes"]  # aggregated, not natively synced


def test_market_data_sync_requires_tickers(client):
    resp = client.post("/api/market-data/sync", json={"tickers": []})
    assert resp.status_code == 400


def test_market_data_sync_rejects_aggregate_timeframe(client):
    resp = client.post("/api/market-data/sync", json={"tickers": ["BTCUSDT"], "timeframes": ["10m"]})
    assert resp.status_code == 400
    assert "10m" in resp.get_json()["error"]


def test_market_data_sync_job_runs_and_populates_store(client):
    resp = client.post("/api/market-data/sync", json={
        "tickers": ["BTCUSDT"], "timeframes": ["1d"], "mode": "initial",
    })
    assert resp.status_code == 202
    job_id = resp.get_json()["job_id"]

    for _ in range(50):
        job = client.get(f"/api/jobs/{job_id}").get_json()
        if job["status"] in ("completed", "completed_with_errors", "failed"):
            break
        time.sleep(0.05)
    assert job["status"] == "completed"
    assert job["completed"] == 1

    cov = store.coverage("BTCUSDT", "1d")
    assert cov["candle_count"] > 0


def test_market_data_tick_coverage_is_honest(client):
    resp = client.get("/api/market-data/tick-coverage?symbol=btcusdt")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["available"] is False
    assert data["symbol"] == "BTCUSDT"


def test_chart_history_alias_matches_candles_endpoint(client):
    resp = client.get("/api/candles?symbol=BTCUSDT&timeframe=1d&from=2025-01-01&to=2025-01-05&limit=100")
    assert resp.status_code == 200
    alias = client.get("/api/chart/history?symbol=BTCUSDT&timeframe=1d&from=2025-01-01&to=2025-01-05&limit=100")
    assert alias.status_code == 200
    assert alias.get_json()["candles"] == resp.get_json()["candles"]
    assert "hasOlder" in alias.get_json()
    assert "hasNewer" in alias.get_json()
