from __future__ import annotations

import pytest

import app as app_module


@pytest.fixture()
def client():
    app_module.app.testing = True
    with app_module.app.test_client() as c:
        yield c


def test_backtest_missing_file_returns_400_not_500(client):
    resp = client.post("/api/backtest", json={"strategy": "false_breakout"})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_backtest_missing_strategy_returns_400_not_500(client):
    resp = client.post("/api/backtest", json={"file": "SBER_10m_2025-01-01_2026-01-01.csv"})
    assert resp.status_code == 400


def test_backtest_empty_body_returns_400_not_500(client):
    resp = client.post("/api/backtest", json={})
    assert resp.status_code == 400


def test_optimize_missing_file_returns_400_not_500(client):
    resp = client.post("/api/optimize", json={})
    assert resp.status_code == 400


def test_download_batch_missing_date_range_returns_400_not_500(client):
    resp = client.post("/api/download-batch", json={"tickers": ["SBER"]})
    assert resp.status_code == 400
    assert "error" in resp.get_json()
