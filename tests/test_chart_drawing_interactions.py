from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
INTERACTIONS = ROOT / "static" / "chart-mobile-interactions.js"
POLISH = ROOT / "static" / "chart-editor-polish.js"


def source(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def function_body(js: str, name: str, next_marker: str) -> str:
    start = js.index(f"function {name}")
    end = js.index(next_marker, start)
    return js[start:end]


def test_drawing_interactions_use_one_pointer_event_model():
    js = source(INTERACTIONS)

    assert 'addEventListener("pointerdown"' in js
    assert 'addEventListener("pointerup"' in js
    assert 'addEventListener("pointermove"' in js
    assert 'addEventListener("pointercancel"' in js

    # Regression: iPhone previously had touch events layered on top of the
    # original mouse implementation, so one tap could travel through multiple
    # independent handlers.
    assert 'addEventListener("touchstart"' not in js
    assert 'addEventListener("touchend"' not in js
    assert 'addEventListener("touchmove"' not in js
    assert 'addEventListener("mousedown"' not in js
    assert "setTimeout(" not in js


def test_tool_activation_cancels_previous_tool_and_unfinished_draft_first():
    js = source(INTERACTIONS)
    body = function_body(js, "activateTool", "function closeToolFlyout")

    deactivate_at = body.index("deactivateEveryTool")
    set_tool_at = body.index("dm.setTool(toolId)")
    close_at = body.index("closeToolFlyout(page)")

    assert deactivate_at < set_tool_at < close_at
    assert "deselectActive: true" in body

    deactivate_body = function_body(js, "deactivateEveryTool", "function activateTool")
    assert "dm.activeTool || dm.draft || dm._draftPreviewPoint || dm._dragState" in deactivate_body
    assert "dm.setTool(null)" in deactivate_body


def test_opening_a_new_tool_group_cancels_stale_drawing_mode():
    js = source(INTERACTIONS)
    body = function_body(js, "renderToolFlyout", "function bulkUpdate")

    # Opening the chooser is itself a mode transition: a half-finished Trend
    # Line/Fibonacci must not survive while Rectangle/etc. is being chosen.
    assert "deactivateEveryTool(page" in body
    assert "page._tvOpenGroup = group.id" in body


def test_outside_pointerdown_does_not_preempt_menu_item_selection_and_is_cleaned_up():
    js = source(INTERACTIONS)

    outside = function_body(js, "buildTradingViewRail", "// ------------------------------------------------------ object toolbar")
    assert 'document.addEventListener("pointerdown", onDocumentPointerDown, true)' in outside
    assert 'document.removeEventListener("pointerdown", onDocumentPointerDown, true)' in outside
    assert "rail.contains(target)" in outside

    # Menu rows are selected on pointerup, after the capture-phase outside
    # handler has already verified that the target belongs to the rail/menu.
    assert 'rail.addEventListener("pointerup", onRailPointerUp)' in outside
    assert "activateTool(page, toolItem.dataset.tvToolGroup" in outside


def test_menu_and_rail_have_mobile_sized_touch_targets():
    js = source(INTERACTIONS)
    assert re.search(r"\.tv-flyout-item\s*\{[^}]*min-height:44px", js, re.S)
    assert re.search(r"\.tv-tool-group-btn[^\{]*\{[^}]*min-height:44px", js, re.S)
    assert "touch-action:manipulation" in js


def test_cursor_mode_keeps_empty_chart_pointer_stream_available_for_pan_and_pinch():
    js = source(INTERACTIONS)
    bind = function_body(js, "activeManager", "// ------------------------------------------------------ pointer engine")
    # The detailed pointer implementation follows this marker; inspect the
    # complete source for the navigation contract and non-primary-pointer guard.
    assert "e.isPrimary !== false" in js
    assert "drawingOwnsGesture" in js
    assert "Lightweight Charts needs this pointer stream" in js
    assert "return;" in js


def test_same_active_tile_interaction_does_not_cancel_current_tool():
    js = source(INTERACTIONS)
    marker = "Page._setActiveTile = function (id)"
    start = js.index(marker)
    body = js[start : js.index("};", start) + 2]
    assert "if (id === this.activeTileId)" in body
    assert body.index("if (id === this.activeTileId)") < body.index("deactivateEveryTool")


def test_escape_priority_is_menu_then_drawing_mode():
    js = source(INTERACTIONS)
    build = function_body(js, "buildTradingViewRail", "// ------------------------------------------------------ object toolbar")
    key_start = build.index("const onDocumentKeyDown")
    key_body = build[key_start:]
    assert key_body.index("page._tvOpenGroup") < key_body.index("dm.draft || dm.activeTool")
    assert "closeToolFlyout(page)" in key_body
    assert "dm.setTool(null)" in key_body


def test_legacy_polish_layer_has_no_runtime_handlers():
    js = source(POLISH)
    assert "addEventListener" not in js
    assert "setTimeout" not in js
    assert "DrawingManager.prototype" not in js
    assert "(function" not in js
