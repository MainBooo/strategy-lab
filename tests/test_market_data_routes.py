from __future__ import annotations

import calendar
import time

import pytest

import app as app_module
import market_data_store as store
import market_data_sync as sync


@pytest.fixture()
def client(tmp_path, monkeypatch):
    store.init_db(tmp_path / "market_data.db")  # repoints the shared module-level _DB_PATH
    app_module.app.testing = True

    def fake_fetch(session, **kw):
        if kw["start"] > 0:
            return {"columns": [], "data": []}
        start = calendar.timegm(time.strptime(kw["from_date"], "%Y-%m-%d"))
        end = calendar.timegm(time.strptime(kw["till_date"], "%Y-%m-%d")) + 86399
        columns = ["open", "close", "high", "low", "value", "volume", "begin", "end"]
        rows = []
        ts = start
        i = 0
        while ts <= end:
            begin = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts))
            rows.append([100 + i, 100.5 + i, 101 + i, 99 + i, 1.0, 1000, begin, begin])
            ts += 86400
            i += 1
        return {"columns": columns, "data": rows}

    monkeypatch.setattr(sync, "_fetch_page", fake_fetch)
    with app_module.app.test_client() as c:
        yield c


def test_market_data_instruments_lists_catalog_and_coverage(client):
    resp = client.get("/api/market-data/instruments")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "items" in data and "native_timeframes" in data and "all_timeframes" in data
    assert "1m" in data["native_timeframes"]
    assert "30m" not in data["native_timeframes"]  # aggregated, not natively synced


def test_market_data_sync_requires_tickers(client):
    resp = client.post("/api/market-data/sync", json={"tickers": []})
    assert resp.status_code == 400


def test_market_data_sync_rejects_aggregate_timeframe(client):
    resp = client.post("/api/market-data/sync", json={"tickers": ["SBER"], "timeframes": ["30m"]})
    assert resp.status_code == 400
    assert "30m" in resp.get_json()["error"]


def test_market_data_sync_job_runs_and_populates_store(client):
    resp = client.post("/api/market-data/sync", json={
        "tickers": ["SBER"], "timeframes": ["1d"], "mode": "initial", "board": "TQBR",
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

    cov = store.coverage("SBER", "TQBR", "1d")
    assert cov["candle_count"] > 0


def test_market_data_tick_coverage_is_honest(client):
    resp = client.get("/api/market-data/tick-coverage?ticker=sber")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["available"] is False
    assert data["ticker"] == "SBER"


def test_chart_history_alias_matches_candles_endpoint(client):
    resp = client.get("/api/candles?symbol=SBER&timeframe=1d&from=2025-01-01&to=2025-01-05&limit=100")
    assert resp.status_code == 200
    alias = client.get("/api/chart/history?symbol=SBER&timeframe=1d&from=2025-01-01&to=2025-01-05&limit=100")
    assert alias.status_code == 200
    assert alias.get_json()["candles"] == resp.get_json()["candles"]
    assert "hasOlder" in alias.get_json()
    assert "hasNewer" in alias.get_json()
