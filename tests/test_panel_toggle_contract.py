from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# The rail (including the "objects" panel-toggle button) lives in
# chart-editor-terminal-mobile-v2.js - see the architecture note at the top
# of chart-mobile-interactions.js for why there are two files here.
RAIL = ROOT / "static" / "chart-editor-terminal-mobile-v2.js"
INTERACTIONS = ROOT / "static" / "chart-mobile-interactions.js"


def rail_source() -> str:
    return RAIL.read_text(encoding="utf-8")


def interactions_source() -> str:
    return INTERACTIONS.read_text(encoding="utf-8")


def test_objects_rail_button_toggles_existing_bottom_panel_source_of_truth():
    js = rail_source()
    start = js.index('else if (action.dataset.slAct === "objects") {')
    end = js.index('else if (action.dataset.slAct === "delete"', start)
    block = js[start:end]

    assert "const opening = Page._bottomCollapsed !== false" in block
    assert "Page._setBottomCollapsed(!opening)" in block
    assert "if (opening)" in block

    for forbidden in ("dm.select(", "dm.setTool(", "dm.removeDrawing(", "dm.updateDrawing("):
        assert forbidden not in block


def test_objects_rail_button_visual_state_follows_panel_state():
    js = rail_source()

    assert 'setPressed("objects", Page._bottomCollapsed === false)' in js
    assert 'data-sl-act="objects"' in js
    assert 'data-tv-action="objects"' in js


def test_panel_state_changes_refresh_rail_without_touching_drawing_engine():
    js = interactions_source()

    assert "const originalSetBottomCollapsed = Page._setBottomCollapsed" in js

    start = js.index('if (typeof Page._setBottomCollapsed === "function") {')
    end = js.index('if (typeof Page._renderProps === "function") {', start)
    hook = js[start:end]
    assert "refreshRail()" in hook
    for forbidden in ("select(", "setTool(", "removeDrawing(", "updateDrawing(", "fitContent("):
        assert forbidden not in hook
