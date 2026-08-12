from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"{label}: source fragment not found")
    return text.replace(old, new, 1)


# Keep CRUD/history transitions aligned with the explicit interaction state.
engine_path = ROOT / "static" / "chart-engine" / "drawings.js"
engine = engine_path.read_text(encoding="utf-8")
engine = replace_once(
    engine,
    "      this.selectedId = d.id;\n      this._emit({ created: d.id });",
    "      this.selectedId = d.id;\n      this._syncInteractionMode();\n      this._emit({ created: d.id });",
    "addDrawing state sync",
)
engine = replace_once(
    engine,
    "      if (this.selectedId === id) this.selectedId = null;\n      this._pushHistory(before);",
    "      if (this.selectedId === id) this.selectedId = null;\n      this._syncInteractionMode();\n      this._pushHistory(before);",
    "removeDrawing state sync",
)
engine = replace_once(
    engine,
    "      this._redoStack.push(this._snapshot());\n      this.drawings = JSON.parse(before);\n      this._emit({ history: true });",
    "      this._redoStack.push(this._snapshot());\n      this.drawings = JSON.parse(before);\n      this.selectedId = null;\n      this._syncInteractionMode();\n      this._emit({ history: true });",
    "undo state sync",
)
engine = replace_once(
    engine,
    "      this._undoStack.push(this._snapshot());\n      this.drawings = JSON.parse(next);\n      this._emit({ history: true });",
    "      this._undoStack.push(this._snapshot());\n      this.drawings = JSON.parse(next);\n      this.selectedId = null;\n      this._syncInteractionMode();\n      this._emit({ history: true });",
    "redo state sync",
)
engine = replace_once(
    engine,
    "      this._undoStack = []; this._redoStack = [];\n      this._emit({ loaded: true });",
    "      this._undoStack = []; this._redoStack = [];\n      this.selectedId = null;\n      this._syncInteractionMode();\n      this._emit({ loaded: true });",
    "load state sync",
)
engine_path.write_text(engine, encoding="utf-8")


# The UI-level Escape handler owns the capture-phase key event and delegates
# exactly once to the engine lifecycle.
mobile_path = ROOT / "static" / "chart-mobile-interactions.js"
mobile = mobile_path.read_text(encoding="utf-8")
mobile = replace_once(
    mobile,
    "      if (dm && (dm.draft || dm.activeTool)) {\n        event.preventDefault();\n        dm.handleEscape();",
    "      if (dm && (dm.draft || dm.activeTool)) {\n        event.preventDefault();\n        event.stopPropagation();\n        dm.handleEscape();",
    "mobile Escape ownership",
)
mobile_path.write_text(mobile, encoding="utf-8")


# Correct static contracts written by the main transformation script.
tests_path = ROOT / "tests" / "test_chart_drawing_interactions.py"
tests = tests_path.read_text(encoding="utf-8")
tests = tests.replace(
    '    finish = engine[engine.index("_finishDraft()"): engine.index("_applyDrag", engine.index("_finishDraft()"))]',
    '    start = engine.index("    _finishDraft() {")\n    finish = engine[start: engine.index("    _applyDrag", start)]',
)
tests = tests.replace(
    r'assert re.search(r"\.tv-flyout-item\s*\{{[^}}]*min-height:44px", js, re.S)',
    r'assert re.search(r"\.tv-flyout-item\s*\{[^}]*min-height:44px", js, re.S)',
)
tests = tests.replace(
    'container.addEventListener("pointerdown", this._activatePointerHandler)',
    'container.addEventListener("pointerdown", this._activatePointerHandler, true)',
)
tests = tests.replace(
    'container.removeEventListener("pointerdown", this._activatePointerHandler)',
    'this.el.removeEventListener("pointerdown", this._activatePointerHandler, true)',
)
tests += '''


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
'''
tests_path.write_text(tests, encoding="utf-8")


# Extend the executable Pointer Events harness with state-history regressions.
runtime_path = ROOT / "tests" / "chart_drawing_runtime.test.js"
runtime = runtime_path.read_text(encoding="utf-8")
marker = 'console.log("chart drawing runtime tests: PASS");'
extra = r'''
// CRUD/history transitions keep explicit interaction state authoritative.
{
  const env = makeManager();
  const d = env.manager.addDrawing("rectangle", [{ time: 20, price: 20 }, { time: 80, price: 80 }]);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.SELECTED);
  env.manager.removeDrawing(d.id);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.NAVIGATE);

  const d2 = env.manager.addDrawing("trend_line", [{ time: 10, price: 10 }, { time: 50, price: 50 }]);
  assert.strictEqual(env.manager.selectedId, d2.id);
  env.manager.undo();
  assert.strictEqual(env.manager.selectedId, null);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.NAVIGATE);
  env.manager.redo();
  assert.strictEqual(env.manager.selectedId, null);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.NAVIGATE);

  env.manager.loadDrawings([{ id: "loaded", type: "horizontal_line", points: [{ time: 30, price: 30 }], properties: {}, locked: false, hidden: false, z_index: 0 }]);
  assert.strictEqual(env.manager.selectedId, null);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.NAVIGATE);
}

'''
if marker not in runtime:
    raise RuntimeError("runtime PASS marker not found")
runtime_path.write_text(runtime.replace(marker, extra + marker, 1), encoding="utf-8")

print("drawing engine integration polish applied")
