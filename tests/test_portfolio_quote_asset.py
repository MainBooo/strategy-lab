from __future__ import annotations

import pytest

import app as app_module
import backtests_db as bdb
from portfolio_store import PortfolioStore

FAKE_CATALOG = [
    {"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "status": "TRADING"},
    {"symbol": "ETHUSDT", "baseAsset": "ETH", "quoteAsset": "USDT", "status": "TRADING"},
    {"symbol": "ETHBTC", "baseAsset": "ETH", "quoteAsset": "BTC", "status": "TRADING"},
]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    bdb.init_db(tmp_path / "backtests.db")
    monkeypatch.setattr(app_module, "PORTFOLIOS", PortfolioStore(tmp_path / "portfolios.json"))
    monkeypatch.setattr(app_module, "catalog", lambda refresh=False: FAKE_CATALOG)
    app_module.app.testing = True
    with app_module.app.test_client() as c:
        yield c


def test_quote_asset_conflict_none_for_same_quote(client):
    assert app_module._quote_asset_conflict(["BTCUSDT", "ETHUSDT"]) is None


def test_quote_asset_conflict_detected_for_mixed_quote(client):
    err = app_module._quote_asset_conflict(["BTCUSDT", "ETHBTC"])
    assert err is not None
    assert "USDT" in err and "BTC" in err


def test_quote_asset_conflict_skips_unknown_tickers(client):
    assert app_module._quote_asset_conflict(["BTCUSDT", "DOESNOTEXIST"]) is None


def test_put_portfolio_rejects_mixed_quote_asset_instruments(client):
    resp = client.post("/api/portfolios", json={"name": "Смешанный портфель"})
    pid = resp.get_json()["id"]

    resp = client.put(
        f"/api/portfolios/{pid}",
        json={"instruments": [
            {"ticker": "BTCUSDT", "file": "BTCUSDT_10m_2025-01-01_2025-06-01.csv", "lot_count": 1},
            {"ticker": "ETHBTC", "file": "ETHBTC_10m_2025-01-01_2025-06-01.csv", "lot_count": 1},
        ]},
    )
    assert resp.status_code == 400
    assert "USDT" in resp.get_json()["error"]


def test_put_portfolio_accepts_same_quote_asset_instruments(client):
    resp = client.post("/api/portfolios", json={"name": "Однородный портфель"})
    pid = resp.get_json()["id"]

    resp = client.put(
        f"/api/portfolios/{pid}",
        json={"instruments": [
            {"ticker": "BTCUSDT", "file": "BTCUSDT_10m_2025-01-01_2025-06-01.csv", "lot_count": 1},
            {"ticker": "ETHUSDT", "file": "ETHUSDT_10m_2025-01-01_2025-06-01.csv", "lot_count": 1},
        ]},
    )
    assert resp.status_code == 200
