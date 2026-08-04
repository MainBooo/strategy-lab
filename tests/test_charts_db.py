from __future__ import annotations

import charts_db as cdb


def test_create_and_get_layout(tmp_path):
    cdb.init_db(tmp_path / "charts.db")
    layout = cdb.create_layout(
        "user1", context="analysis", name="Основной", symbol="SBER", board="TQBR",
        timeframe="1d", visible_from=None, visible_to=None, chart_type="candles",
        settings={"showVolume": True}, indicators=[{"type": "rsi", "params": {"period": 14}}],
    )
    fetched = cdb.get_layout(layout["id"], "user1")
    assert fetched["name"] == "Основной"
    assert fetched["settings"] == {"showVolume": True}
    assert fetched["indicators"] == [{"type": "rsi", "params": {"period": 14}}]
    assert fetched["schema_version"] == 1


def test_layout_ownership_isolation(tmp_path):
    cdb.init_db(tmp_path / "charts.db")
    layout = cdb.create_layout("user1", context="analysis", name="A", symbol="SBER", board="TQBR",
                                timeframe="1d", visible_from=None, visible_to=None, chart_type="candles",
                                settings={}, indicators=[])
    assert cdb.get_layout(layout["id"], "user2") is None
    assert cdb.list_layouts("user2") == []
    assert cdb.update_layout(layout["id"], "user2", name="Hijacked") is None
    assert cdb.delete_layout(layout["id"], "user2") is False
    # original owner is unaffected by the attempted cross-user writes
    assert cdb.get_layout(layout["id"], "user1")["name"] == "A"


def test_default_layout_exclusive_per_symbol(tmp_path):
    cdb.init_db(tmp_path / "charts.db")
    first = cdb.create_layout("user1", context="analysis", name="First", symbol="SBER", board="TQBR",
                               timeframe="1d", visible_from=None, visible_to=None, chart_type="candles",
                               settings={}, indicators=[], is_default=True)
    second = cdb.create_layout("user1", context="analysis", name="Second", symbol="SBER", board="TQBR",
                                timeframe="1d", visible_from=None, visible_to=None, chart_type="candles",
                                settings={}, indicators=[], is_default=True)
    assert cdb.get_layout(first["id"], "user1")["is_default"] is False
    assert cdb.get_layout(second["id"], "user1")["is_default"] is True
    # a default for a different symbol doesn't clear this one
    cdb.create_layout("user1", context="analysis", name="Other symbol", symbol="GAZP", board="TQBR",
                       timeframe="1d", visible_from=None, visible_to=None, chart_type="candles",
                       settings={}, indicators=[], is_default=True)
    assert cdb.get_layout(second["id"], "user1")["is_default"] is True


def test_drawing_crud_and_cascade_delete(tmp_path):
    cdb.init_db(tmp_path / "charts.db")
    layout = cdb.create_layout("user1", context="analysis", name="A", symbol="SBER", board="TQBR",
                                timeframe="1d", visible_from=None, visible_to=None, chart_type="candles",
                                settings={}, indicators=[])
    drawing = cdb.create_drawing(layout["id"], "user1", type="trend_line", symbol="SBER", timeframe="1d",
                                  points=[{"time": 1, "price": 100}, {"time": 2, "price": 110}],
                                  properties={"color": "#7c8cff"})
    assert drawing is not None
    updated = cdb.update_drawing(drawing["id"], "user1", points=[{"time": 1, "price": 101}, {"time": 2, "price": 111}], locked=True)
    assert updated["points"][0]["price"] == 101
    assert updated["locked"] is True
    assert len(cdb.list_drawings(layout["id"], "user1")) == 1

    cdb.delete_layout(layout["id"], "user1")
    assert cdb.list_drawings(layout["id"], "user1") == []
    assert cdb.get_drawing(drawing["id"], "user1") is None


def test_create_drawing_rejects_unknown_layout(tmp_path):
    cdb.init_db(tmp_path / "charts.db")
    assert cdb.create_drawing("layout_nope", "user1", type="text", symbol="SBER", timeframe="1d",
                               points=[{"time": 1, "price": 100}], properties={}) is None


def test_strategy_request_roundtrip(tmp_path):
    cdb.init_db(tmp_path / "charts.db")
    layout = cdb.create_layout("user1", context="analysis", name="A", symbol="SBER", board="TQBR",
                                timeframe="1d", visible_from=None, visible_to=None, chart_type="candles",
                                settings={}, indicators=[])
    req = cdb.create_strategy_request(
        "user1", layout_id=layout["id"], symbol="SBER", idea_description="Пробой канала",
        drawings_snapshot=[{"type": "trend_line"}], indicators=[{"type": "rsi"}],
    )
    assert req["status"] == "new"
    assert req["idea_description"] == "Пробой канала"
    assert req["drawings_snapshot"] == [{"type": "trend_line"}]
    assert cdb.get_strategy_request(req["id"], "other_user") is None
    assert len(cdb.list_strategy_requests("user1")) == 1
