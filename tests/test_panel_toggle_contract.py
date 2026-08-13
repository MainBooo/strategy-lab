from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INTERACTIONS = ROOT / "static" / "chart-mobile-interactions.js"


def source() -> str:
    return INTERACTIONS.read_text(encoding="utf-8")


def test_objects_rail_button_toggles_existing_bottom_panel_source_of_truth():
    js = source()
    start = js.index('} else if (action === "objects") {')
    end = js.index('} else if (action === "remove-all") {', start)
    block = js[start:end]

    assert "const opening = page._bottomCollapsed !== false" in block
    assert "page._setBottomCollapsed(!opening)" in block
    assert "if (opening)" in block

    for forbidden in ("dm.select(", "dm.setTool(", "dm.removeDrawing(", "dm.updateDrawing("):
        assert forbidden not in block


def test_objects_rail_button_visual_state_follows_panel_state():
    js = source()

    assert "const panelOpen = page._bottomCollapsed === false" in js
    assert 'objects.classList.toggle("active", panelOpen)' in js
    assert 'objects.setAttribute("aria-pressed", panelOpen ? "true" : "false")' in js
    assert 'data-tv-action="objects"' in js
    assert 'aria-pressed="false">☷</button>' in js


def test_panel_state_changes_refresh_rail_without_touching_drawing_engine():
    js = source()

    assert "const originalSetBottomCollapsed = Page._setBottomCollapsed" in js
    assert "refreshTradingViewRail(this)" in js

    start = js.index('if (typeof Page._setBottomCollapsed === "function") {')
    end = js.index('if (typeof Page._renderProps === "function") {', start)
    hook = js[start:end]
    for forbidden in ("select(", "setTool(", "removeDrawing(", "updateDrawing(", "fitContent("):
        assert forbidden not in hook
