from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "static" / "chart-engine" / "drawings.js"
INTERACTIONS = ROOT / "static" / "chart-mobile-interactions.js"
POLISH = ROOT / "static" / "chart-editor-polish.js"
TILE = ROOT / "static" / "chart-engine" / "chart-tile.js"
ANALYSIS = ROOT / "static" / "chart-analysis.js"
RUNTIME = ROOT / "tests" / "chart_drawing_runtime.test.js"


def source(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_drawing_engine_owns_one_pointer_event_pipeline():
    js = source(ENGINE)
    for event in ("pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"):
        assert f'addEventListener("{event}"' in js
    assert 'addEventListener("mousedown"' not in js
    assert 'addEventListener("touchstart"' not in js
    assert 'addEventListener("touchmove"' not in js
    assert 'addEventListener("touchend"' not in js
    assert "setTimeout(" not in js


def test_mobile_module_no_longer_monkey_patches_drawing_manager_input():
    js = source(INTERACTIONS)
    assert "dmProto._bindDom" not in js
    assert "DrawingManager.prototype._bindDom" not in js
    assert "originalSetTool" not in js
    assert "originalCancelDraft" not in js
    assert "_tvKeepDrawingIntegrated" not in js
    assert 'addEventListener("touchstart"' not in js


def test_explicit_interaction_states_and_tool_metadata_cover_all_17_tools():
    js = source(ENGINE)
    for state in (
        "NAVIGATE", "TOOL_ARMED", "PLACING", "SELECTED",
        "DRAG_OBJECT", "DRAG_HANDLE", "TEXT_EDIT",
    ):
        assert f'{state}: "{state}"' in js

    tools = (
        "trend_line", "ray", "extended_line", "horizontal_line", "vertical_line",
        "parallel_channel", "fib_retracement", "fib_extension", "rectangle",
        "circle", "polyline", "text", "note", "price_range", "time_range",
        "long_position", "short_position",
    )
    for tool in tools:
        match = re.search(rf"{tool}:\s*\{{([^}}]+)\}}", js)
        assert match, tool
        body = match.group(1)
        assert "anchorCount:" in body
        assert "creationGesture:" in body
        assert "completion:" in body
        assert "preview:" in body


def test_two_point_tools_support_drag_release_via_metadata_not_tool_specific_if_chains():
    js = source(ENGINE)
    for tool in (
        "trend_line", "ray", "extended_line", "fib_retracement", "rectangle",
        "circle", "price_range", "time_range", "long_position", "short_position",
    ):
        match = re.search(rf"{tool}:\s*\{{([^}}]+)\}}", js)
        assert match and 'creationGesture: "tap-or-drag"' in match.group(1)
        assert "dragStagePoints: 2" in match.group(1)

    finish = js[js.index("_finishCreatePointer"): js.index("_finishEditPointer")]
    assert "session.tool ===" not in finish
    assert "def.dragStagePoints >= 2" in finish


def test_outside_cursor_tap_has_strict_deselect_only_path():
    js = source(ENGINE)
    marker = "// Strong invariant: an empty-chart tap in Cursor mode only deselects."
    start = js.index(marker)
    body = js[start: js.index("this._emptyPointerTap = null;", start)]
    assert "this.select(null)" in body
    assert "_placePoint" not in body
    assert "_applyDrag" not in body
    assert "updateDrawing" not in body


def test_tap_drag_threshold_and_pointer_cancel_rollback_are_native_engine_behavior():
    js = source(ENGINE)
    assert "TOUCH_DRAG_THRESHOLD_PX = 10" in js
    assert "POINTER_DRAG_THRESHOLD_PX = 4" in js
    assert "distance > this._movementThreshold" in js
    assert '_endPointerSession({ rollback: true, emit: true })' in js
    assert "_rollbackPointerSession" in js


def test_dynamic_touch_ownership_preserves_cursor_navigation():
    js = source(ENGINE)
    assert 'el.style.touchAction = locked ? "none"' in js
    assert "{ handleScroll: false, handleScale: false }" in js
    assert "{ handleScroll: true, handleScale: true }" in js
    empty = js[js.index("// Empty Cursor-mode gesture belongs to Lightweight Charts."):
               js.index("_movementThreshold(pointerType)")]
    assert "preventDefault" not in empty
    assert "stopPropagation" not in empty


def test_keep_drawing_and_completion_are_engine_owned():
    engine = source(ENGINE)
    mobile = source(INTERACTIONS)
    start = engine.index("    _finishDraft() {")
    finish = engine[start: engine.index("    _applyDrag", start)]
    assert "this.activeTool = this.keepDrawing ? type : null" in finish
    assert "this.draft = null" in finish
    assert "_tvKeepDrawingIntegrated" not in mobile


def test_circle_persistence_id_is_retained_but_ui_semantics_are_ellipse():
    engine = source(ENGINE)
    mobile = source(INTERACTIONS)
    analysis = source(ANALYSIS)
    assert 'circle: {' in engine
    assert 'semanticShape: "ellipse"' in engine
    assert 'label: "Эллипс"' in engine
    assert '{ id: "circle", label: "Эллипс"' in mobile
    assert '{ id: "circle", label: "Эллипс"' in analysis
    assert 'case "circle"' in engine
    assert 'kind: "ellipse"' in engine


def test_polyline_has_mobile_safe_explicit_completion():
    js = source(ENGINE)
    assert 'polyline: { pointsNeeded: -1, anchorCount: -1' in js
    assert 'completion: "explicit"' in js
    assert "_isDoublePlacementTap" in js
    assert "this.draft.points.length < 2" in js
    assert "handleEscape()" in js
    assert 'return "finished"' in js


def test_mobile_escape_delegates_to_engine_lifecycle():
    js = source(INTERACTIONS)
    assert "dm.handleEscape()" in js
    assert re.search(r"if \(dm && \(dm\.draft \|\| dm\.activeTool\)\).*?dm\.handleEscape\(\)", js, re.S)


def test_tool_activation_cancels_previous_draft_and_other_tiles():
    js = source(INTERACTIONS)
    assert "deactivateEveryTool(page, { deselectActive: true })" in js
    assert "dm.setTool(null)" in js
    assert "dm.setTool(toolId)" in js


def test_fullscreen_and_rail_regressions_remain_covered():
    js = source(INTERACTIONS)
    assert 'global.matchMedia("(max-width: 620px)")' in js
    assert "singleTile" in js
    assert "page._fsCtrl.toggle()" in js
    assert 'document.addEventListener("pointerdown", onDocumentPointerDown, true)' in js
    assert 'rail.addEventListener("pointerup", onRailPointerUp)' in js
    assert "rail.contains(target)" in js
    assert re.search(r"\.tv-flyout-item\s*\{[^}]*min-height:44px", js, re.S)
    assert "touch-action:manipulation" in js


def test_tile_activation_and_destruction_follow_pointer_engine_lifecycle():
    js = source(TILE)
    assert 'container.addEventListener("pointerdown", this._activatePointerHandler, true)' in js
    assert 'this.el.removeEventListener("pointerdown", this._activatePointerHandler, true)' in js
    destroy = re.search(r"\n    destroy\(\) \{(.*?)\n    \}", js, re.S)
    assert destroy
    body = destroy.group(1)
    assert "this.drawingMgr.destroy()" in body
    assert body.index("this.drawingMgr.destroy()") < body.index("this.core.destroy()")


def test_legacy_polish_layer_has_no_runtime_handlers():
    js = source(POLISH)
    assert "addEventListener" not in js
    assert "setTimeout" not in js
    assert "DrawingManager.prototype" not in js
    assert "(function" not in js


def test_event_level_runtime_regression_suite_exists():
    js = source(RUNTIME)
    for scenario in (
        "Current Ray regression",
        "Tool A -> Tool B",
        "Pointer cancel",
        "Outside tap is a byte-for-byte",
        "Two managers never share",
        "Keep Drawing",
    ):
        assert scenario in js
    for pointer_type in ('"touch"', '"mouse"', '"pen"'):
        assert pointer_type in js



def test_crud_and_history_keep_explicit_interaction_state_in_sync():
    js = source(ENGINE)
    assert js.count("this._syncInteractionMode();") >= 10
    assert re.search(r"addDrawing\(type, points, properties\).*?this\.selectedId = d\.id;\s*this\._syncInteractionMode\(\);", js, re.S)
    assert re.search(r"removeDrawing\(id\).*?this\._syncInteractionMode\(\);", js, re.S)
    assert re.search(r"undo\(\).*?this\.selectedId = null;\s*this\._syncInteractionMode\(\);", js, re.S)
    assert re.search(r"redo\(\).*?this\.selectedId = null;\s*this\._syncInteractionMode\(\);", js, re.S)
    assert re.search(r"loadDrawings\(rows\).*?this\.selectedId = null;\s*this\._syncInteractionMode\(\);", js, re.S)


def test_mobile_escape_claims_event_before_delegating_to_engine():
    js = source(INTERACTIONS)
    marker = "if (dm && (dm.draft || dm.activeTool))"
    start = js.index(marker)
    body = js[start: js.index("refreshTradingViewRail(page)", start)]
    assert body.index("event.preventDefault()") < body.index("event.stopPropagation()") < body.index("dm.handleEscape()")



def test_touch_object_editing_and_textual_editor_contracts():
    drawings = Path("static/chart-engine/drawings.js").read_text()
    analysis = Path("static/chart-analysis.js").read_text()
    mobile = Path("static/chart-mobile-interactions.js").read_text()

    assert "TOUCH_HIT_TOLERANCE_PX = 18" in drawings
    assert 'pointerType: e.pointerType || "mouse"' in drawings
    assert "allowHandles: false" in drawings
    assert "this._emit({ preview: true })" in drawings
    assert "detail.preview || detail.hover" in analysis

    assert 'const isTextual = d.type === "text" || d.type === "note"' in analysis
    assert 'textarea id="propText"' in analysis
    assert "textInput.onchange" in analysis
    assert "textInput.oninput" not in analysis
    assert "data-tv-obj-edit-text" in mobile
    assert 'const isTextual = drawing.type === "text" || drawing.type === "note"' in mobile
