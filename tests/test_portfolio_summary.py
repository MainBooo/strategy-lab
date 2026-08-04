from __future__ import annotations

import pytest

import app as app_module
import backtests_db as bdb
from portfolio_store import PortfolioStore


@pytest.fixture()
def client(tmp_path, monkeypatch):
    bdb.init_db(tmp_path / "backtests.db")  # repoints the shared module-level _DB_PATH
    monkeypatch.setattr(app_module, "PORTFOLIOS", PortfolioStore(tmp_path / "portfolios.json"))
    app_module.app.testing = True
    with app_module.app.test_client() as c:
        yield c


def _make_portfolio(client) -> str:
    resp = client.post("/api/portfolios", json={"name": "Тестовый портфель"})
    assert resp.status_code == 200
    return resp.get_json()["id"]


def test_summary_404_for_unknown_portfolio(client):
    resp = client.get("/api/portfolios/does-not-exist/summary")
    assert resp.status_code == 404


def test_summary_has_run_false_when_no_backtest_yet(client):
    pid = _make_portfolio(client)
    resp = client.get(f"/api/portfolios/{pid}/summary")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["has_run"] is False
    assert data["portfolio_id"] == pid
    # No fabricated numbers when nothing has run yet.
    assert "final_capital" not in data


def test_summary_reports_latest_completed_run(client):
    pid = _make_portfolio(client)
    bdb.create_run("run_old", pid, "Тестовый портфель", "2025-01-01", "2025-06-01", 1_000_000, 5, {})
    bdb.finish_run("run_old", status="completed", final_capital=1_050_000, profit=50_000,
                    return_percent=5.0, max_drawdown=-2.0, trades_count=12)
    bdb.create_run("run_new", pid, "Тестовый портфель", "2025-06-01", "2025-12-01", 1_050_000, 5, {})
    bdb.finish_run("run_new", status="completed", final_capital=980_000, profit=-70_000,
                    return_percent=-6.67, max_drawdown=-9.5, trades_count=8)

    resp = client.get(f"/api/portfolios/{pid}/summary")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["has_run"] is True
    assert data["run_id"] == "run_new"  # most recent by created_at, not just first inserted
    assert data["final_capital"] == 980_000
    assert data["profit"] == -70_000
    assert data["trades_count"] == 8


def test_summary_ignores_still_running_backtest(client):
    pid = _make_portfolio(client)
    bdb.create_run("run_live", pid, "Тестовый портфель", "2025-01-01", "2025-06-01", 1_000_000, 5, {})
    # never finished - status stays "running"
    resp = client.get(f"/api/portfolios/{pid}/summary")
    assert resp.get_json()["has_run"] is False


def test_summary_does_not_mix_other_portfolios(client):
    pid_a = _make_portfolio(client)
    pid_b = _make_portfolio(client)
    bdb.create_run("run_a", pid_a, "A", None, None, 1_000_000, 1, {})
    bdb.finish_run("run_a", status="completed", final_capital=1_100_000, profit=100_000, return_percent=10.0)

    resp = client.get(f"/api/portfolios/{pid_b}/summary")
    assert resp.get_json()["has_run"] is False
