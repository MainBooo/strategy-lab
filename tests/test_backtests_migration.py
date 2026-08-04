from __future__ import annotations

import sqlite3

import backtests_db as bdb


def test_fresh_db_has_signal_datetime_column(tmp_path):
    bdb.init_db(tmp_path / "backtests.db")
    with sqlite3.connect(tmp_path / "backtests.db") as conn:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(backtest_trades)")}
    assert "signal_datetime" in cols


def test_migration_adds_column_to_pre_existing_table(tmp_path):
    """Simulates a database created before signal_datetime existed."""
    path = tmp_path / "backtests.db"
    pre_migration_schema = bdb.SCHEMA.replace(",\n    signal_datetime TEXT", "")
    assert "signal_datetime" not in pre_migration_schema
    with sqlite3.connect(path) as conn:
        conn.executescript(pre_migration_schema)

    bdb.init_db(path)  # should add the column, not fail on "already exists" tables

    with sqlite3.connect(path) as conn:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(backtest_trades)")}
    assert "signal_datetime" in cols


def test_migration_is_idempotent(tmp_path):
    path = tmp_path / "backtests.db"
    bdb.init_db(path)
    bdb.init_db(path)  # second call must not raise "duplicate column"
    with sqlite3.connect(path) as conn:
        cols = [row[1] for row in conn.execute("PRAGMA table_info(backtest_trades)")]
    assert cols.count("signal_datetime") == 1


def test_add_trades_persists_signal_datetime(tmp_path):
    bdb.init_db(tmp_path / "backtests.db")
    run_id = bdb.new_run_id()
    bdb.create_run(run_id, None, "p", None, None, 1_000_000, 1, {})
    result_id = bdb.add_result(run_id, ticker="SBER", strategy_id="ema_pullback", status="ok")
    bdb.add_trades(run_id, result_id, "SBER", "ema_pullback", [{
        "direction": "long", "entry_datetime": "2025-01-01 10:00:00", "entry_price": 100,
        "exit_datetime": "2025-01-01 11:00:00", "exit_price": 101, "exit_reason": "take",
        "signal_datetime": "2025-01-01 09:50:00",
    }])
    trades, total = bdb.list_trades(run_id)
    assert total == 1
    assert trades[0]["signal_datetime"] == "2025-01-01 09:50:00"
