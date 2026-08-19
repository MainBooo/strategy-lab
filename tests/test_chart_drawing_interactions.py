from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "static" / "chart-engine" / "drawings.js"
INTERACTIONS = ROOT / "static" / "chart-mobile-interactions.js"
POLISH = ROOT / "static" / "chart-editor-polish.js"
TILE = ROOT / "static" / "chart-engine" / "chart-tile.js"
RAIL = ROOT / "static" / "chart-editor-terminal-mobile-v2.js"
RUNTIME = ROOT / "tests" / "chart_drawing_runtime.test.js"


def source(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_drawing_engine_owns_pointer_pipeline_with_touch_guard_only_for_native_scroll():
    js = source(ENGINE)
    for event in ("pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"):
        assert f'addEventListener("{event}"' in js
    assert 'addEventListener("mousedown"' not in js
    for event in ("touchstart", "touchmove", "touchend", "touchcancel"):
        assert f'addEventListener("{event}"' in js
    assert "passive: false" in js
    assert "setTimeout(" not in js

    start = js[js.index("    _onTouchStartGuard(e) {"):js.index("    _onTouchMoveGuard(e) {")]
    move = js[js.index("    _onTouchMoveGuard(e) {"):js.index("    _onTouchEndGuard(e) {")]
    for body in (start, move):
        assert "_preventTouchDefault" in body
        for forbidden in ("_applyDrag(", "_placePoint(", "updateDrawing(", "_pushHistory(", "_emit(", "this.select("):
            assert forbidden not in body
    assert "this._ownedTouchIds.add" in start
    assert "this.hitTest" not in move


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
        match = re.search(rf"\b{tool}:\s*\{{([^}}]+)\}}", js)
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
        match = re.search(rf"\b{tool}:\s*\{{([^}}]+)\}}", js)
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
    assert "this._ownedTouchIds = new Set()" in js
    assert 'el.addEventListener("touchstart", onTouchStart, { capture: true, passive: false })' in js
    assert 'global.addEventListener("touchmove", onTouchMove, { capture: true, passive: false })' in js
    assert 'return !!this.hitTest(pos.x, pos.y, { pointerType: "touch" });' in js
    assert "touches.length > 1" in js
    assert "if (session.pointerType === \"touch\") this._clearTouchOwnership();" in js

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
    rail = source(RAIL)
    assert 'circle: {' in engine
    assert 'semanticShape: "ellipse"' in engine
    assert 'label: "Эллипс"' in engine
    assert '["circle","Эллипс"]' in rail
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
    """The rail lives in chart-editor-terminal-mobile-v2.js, but cross-tile
    draft cancellation stays engine-adjacent logic in chart-mobile-
    interactions.js (deactivateEveryTool, walking every tile's manager) -
    exposed via ChartDrawingUI so the rail can call it before arming a new
    tool, instead of only cancelling the active tile's own manager."""
    interactions = source(INTERACTIONS)
    rail = source(RAIL)
    assert "function deactivateEveryTool(page" in interactions
    assert "dm.setTool(null)" in interactions
    assert "global.ChartDrawingUI = {" in interactions
    assert "deactivateEveryTool: (page, opts) => deactivateEveryTool(page || Page, opts)" in interactions
    assert "g.ChartDrawingUI?.deactivateEveryTool(Page, { deselectActive: true })" in rail
    assert "drawingManager()?.setTool(" in rail


def test_fullscreen_regressions_remain_covered():
    js = source(INTERACTIONS)
    assert 'global.matchMedia("(max-width: 620px)")' in js
    assert "singleTile" in js
    assert "page._fsCtrl.toggle()" in js


def test_rail_regressions_remain_covered():
    """The rail itself (tool groups, its picker/flyout, outside-click-to-
    close, touch target sizing) lives in chart-editor-terminal-mobile-v2.js
    now - see the architecture note at the top of chart-mobile-
    interactions.js."""
    js = source(RAIL)
    assert 'rail.onclick = (event) => {' in js
    assert "event.target.closest(\"[data-sl-tool]\")" in js
    assert 'rail.contains(event.target)' in js
    assert "picker.classList.add(\"hidden\")" in js
    assert re.search(r"\.sl-draw-group,#chartsRoot \.sl-rail-action\{[^}]*min-height:44px", js, re.S)
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
        "Selected Rectangle body touch drag",
        "Rectangle handle keeps priority",
        "Safari touch guard suppresses native scrolling",
        "Tap without drag",
        "Empty chart after selection",
        "Pointercancel rolls edited geometry back",
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
    body = js[start: js.index("refreshRail()", start)]
    assert body.index("event.preventDefault()") < body.index("event.stopPropagation()") < body.index("dm.handleEscape()")


def test_touch_object_editing_and_textual_editor_contracts():
    drawings = Path("static/chart-engine/drawings.js").read_text()
    analysis = Path("static/chart-analysis.js").read_text()
    tile = Path("static/chart-engine/chart-tile.js").read_text()

    assert "TOUCH_HIT_TOLERANCE_PX = 18" in drawings
    assert 'pointerType: e.pointerType || "mouse"' in drawings
    assert "allowHandles: false" in drawings
    assert "this._emit({ preview: true })" in drawings
    assert "detail.preview || detail.hover" in analysis

    assert "const isTextual = CE.Drawings.TEXT_ANNOTATION_TYPES.has(d.type)" in analysis
    assert 'textarea id="propText"' in analysis
    assert "textInput.onchange" in analysis
    assert "textInput.oninput" not in analysis
    # The edit-text shortcut for textual drawings now lives on the floating
    # per-selection toolbar (ChartTile._renderFloatToolbar), not the old bar
    # pinned to a fixed spot at the top of the workspace.
    assert 'data-act="edittext"' in tile
    assert "const isTextual = CE.Drawings.TEXT_ANNOTATION_TYPES.has(d.type)" in tile
    assert "focusText" in tile


def test_boundary_drag_uses_one_continuous_coordinate_pipeline_for_every_tool():
    js = source(ENGINE)
    for helper in (
        "timeToLogical", "logicalToTime", "coordinateToLogicalSafe",
        "logicalToCoordinateSafe", "coordinateToPriceSafe", "priceToCoordinateSafe",
        "pointerToDrawingCoordinate", "timeToCoordinateSafe",
    ):
        assert f"function {helper}" in js
    assert "_pointerToDrawingCoordinate(px, py)" in js
    assert "startCoordinate: this._pointerToDrawingCoordinate" in js
    assert "deltaLogical = current.logical - start.logical" in js
    assert "deltaPrice = current.price - start.price" in js
    assert "_translatePoints(origPoints, deltaLogical, deltaPrice, editAxis)" in js
    assert "getVisibleLogicalRange" in js
    assert "coordinateToLogical" in js

    start = js.index("    _applyDrag(x, y) {")
    apply_drag = js[start:js.index("    handleEscape()", start)]
    # General boundary handling must not grow into Rectangle/Fib/etc. hacks.
    for tool in (
        "rectangle", "trend_line", "ray", "extended_line", "parallel_channel",
        "fib_retracement", "fib_extension", "circle", "polyline", "text", "note",
        "price_range", "time_range", "horizontal_line", "vertical_line",
    ):
        assert f'd.type === "{tool}"' not in apply_drag
    # Long/Short already have semantic stop/take handles; their special branch
    # is permitted, but boundary conversion remains shared before that branch.
    assert 'd.type === "long_position" || d.type === "short_position"' in apply_drag


def test_boundary_drag_never_writes_invalid_geometry_or_deletes_on_transient_conversion_failure():
    js = source(ENGINE)
    start = js.index("    _applyDrag(x, y) {")
    apply_drag = js[start:js.index("    handleEscape()", start)]
    translate_start = js.index("    _translatePoints(")
    translate = js[translate_start:start]

    assert "if (!current || !start) return;" in apply_drag
    assert "finite(deltaLogical)" in apply_drag
    assert "finite(deltaPrice)" in apply_drag
    assert "pts.every(finitePoint)" in apply_drag
    assert "finitePoint(next)" in translate
    for forbidden in ("removeDrawing(", "hidden = true", "hidden=true", "splice(", "drawings = []"):
        assert forbidden not in apply_drag
    # No blanket viewport clamp in model mutation. pointToSegmentDist may clamp
    # its local projection parameter, so scope this contract to drag code only.
    assert "Math.max(0, Math.min" not in apply_drag
    assert "clientWidth" not in apply_drag
    assert "clientHeight" not in apply_drag


def test_pointer_capture_survives_pointerleave_and_only_real_cancel_rolls_back():
    js = source(ENGINE)
    assert "el.setPointerCapture(e.pointerId)" in js
    assert 'global.addEventListener("pointermove", onPointerMove, { capture: true })' in js
    assert 'global.addEventListener("pointerup", onPointerUp, { capture: true })' in js
    assert 'global.addEventListener("pointercancel", onPointerCancel, { capture: true })' in js
    leave = re.search(r"const onPointerLeave = \(\) => \{([^}]+)\};", js)
    assert leave
    assert "_endPointerSession" not in leave.group(1)
    assert "_pointerSession" in leave.group(1)
    cancel_start = js.index("    _onPointerCancel(e) {")
    cancel = js[cancel_start:js.index("    _onLostPointerCapture", cancel_start)]
    assert '_endPointerSession({ rollback: true, emit: true })' in cancel


def test_renderer_extrapolates_model_coordinates_then_clips_paint_to_tile_viewport():
    js = source(ENGINE)
    assert "function toPixels(core, points)" in js
    assert "timeToCoordinateSafe(core, p.time)" in js
    assert "priceToCoordinateSafe(core, p.price)" in js
    assert "Returns null if off-screen" not in js
    assert "clipParametricLineToRect" in js
    assert 'd.type === "ray" ? "ray" : "line"' in js
    assert "const scale = 4000" not in js
    assert "ctx.rect(0, 0, w, h);" in js
    assert "ctx.clip();" in js
    # Clipping belongs to paint, not to persisted drawing geometry.
    drag_start = js.index("    _applyDrag(x, y) {")
    drag = js[drag_start:js.index("    handleEscape()", drag_start)]
    assert "ctx.clip" not in drag


def test_safari_touch_guard_stays_geometry_free_after_boundary_fix():
    js = source(ENGINE)
    start = js[js.index("    _onTouchStartGuard(e) {"):js.index("    _onTouchMoveGuard(e) {")]
    move = js[js.index("    _onTouchMoveGuard(e) {"):js.index("    _onTouchEndGuard(e) {")]
    assert "_touchHitOwnsGesture" in start
    assert "_touchHitOwnsGesture" not in move
    assert "hitTest" not in move
    for body in (start, move):
        for geometry_call in (
            "_pointerToDrawingCoordinate", "pixelToPoint", "_applyDrag", "_translatePoints",
            "snapPoint", "updateDrawing", "_pushHistory", "this.select",
        ):
            assert geometry_call not in body


def test_drag_preview_has_no_per_move_persistence_or_history_work():
    js = source(ENGINE)
    start = js.index("    _applyDrag(x, y) {")
    apply_drag = js[start:js.index("    handleEscape()", start)]
    assert "this._emit({ preview: true })" in apply_drag
    for forbidden in ("_pushHistory", "updateDrawing", "localStorage", "fetch(", "XMLHttpRequest"):
        assert forbidden not in apply_drag
    finish_start = js.index("    _finishEditPointer(session) {")
    finish = js[finish_start:js.index("    _onPointerUp(e)", finish_start)]
    assert "this._pushHistory(before)" in finish
    # `updated` is `id` for a single-object drag, or every group member's
    # id for a multi-object group drag (ТЗ "Multiselect (Ctrl/Cmd click),
    # Grouping объектов") - each needs its own persistence save.
    assert 'this._emit({ updated, pointerDrag: true })' in finish
    assert "groupOrigPoints" in finish


def test_runtime_suite_covers_boundary_matrix_and_multi_tile_isolation():
    js = source(RUNTIME)
    for scenario in (
        "Rectangle right edge + pointer outside canvas",
        "Rectangle left/top/bottom boundaries",
        "Handle drag can cross an edge",
        "all 34 tools use the same boundary-safe body translation",
        "Trend Line anchors may both be outside",
        "Extended Line is clipped mathematically",
        "axis-specific infinite lines",
        "named complex-tool regressions",
        "empty-chart pointer that leaves the pane",
        "pointercancel outside is a real cancel",
        "Invalid transient coordinates skip only that preview frame",
        "multi-tile isolation",
    ):
        assert scenario in js
    for edge in ('"right"', '"left"', '"top"', '"bottom"'):
        assert edge in js
    for pointer_type in ('"touch"', '"mouse"', '"pen"'):
        assert pointer_type in js
    assert "assertFiniteDrawing" in js
    assert "makeBoundaryManager" in js
    assert "getVisibleLogicalRange" in js
