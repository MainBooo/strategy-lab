const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.style = {};
    this.tabIndex = -1;
    this.clientWidth = 800;
    this.clientHeight = 400;
    this.captured = new Set();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const rows = this.listeners.get(type) || [];
    this.listeners.set(type, rows.filter((item) => item !== fn));
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture(id) { this.captured.add(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  dispatch(type, init = {}) {
    const event = Object.assign({
      type,
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 0,
      clientY: 0,
      timeStamp: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "",
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    }, init);
    for (const fn of (this.listeners.get(type) || []).slice()) fn(event);
    return event;
  }
}

const windowTarget = new FakeTarget();
const documentTarget = { activeElement: null };
windowTarget.ChartEngine = {
  theme: {
    accent: "#7c8cff", up: "#4dd4ac", down: "#ff7081", muted: "#999",
  },
};
windowTarget.prompt = (_label, value) => value === "Заметка" ? "runtime text" : value;
windowTarget.confirm = () => true;

const context = vm.createContext({
  window: windowTarget,
  document: documentTarget,
  console,
  Math,
  Date,
  JSON,
  Object,
  Array,
  Set,
  Map,
  Number,
  String,
  Boolean,
});
vm.runInContext(fs.readFileSync("static/chart-engine/drawings.js", "utf8"), context);

const { DrawingManager, TOOL_DEFS, INTERACTION_STATES } = windowTarget.ChartEngine.Drawings;

function makeManager() {
  const container = new FakeTarget();
  const navigationOptions = [];
  const timeScale = {
    coordinateToTime: (x) => x,
    timeToCoordinate: (time) => time,
  };
  const chart = {
    timeScale: () => timeScale,
    applyOptions: (opts) => navigationOptions.push(JSON.parse(JSON.stringify(opts))),
  };
  const series = {
    attachPrimitive(primitive) { primitive.attached({ requestUpdate() {} }); },
    detachPrimitive() {},
    coordinateToPrice: (y) => y,
    priceToCoordinate: (price) => price,
  };
  const core = { container, chart, candleSeries: series, candles: [] };
  const manager = new DrawingManager(core);
  return { manager, container, chart, navigationOptions };
}

function send(target, type, x, y, time, pointerType = "touch", pointerId = 1) {
  return target.dispatch(type, { clientX: x, clientY: y, timeStamp: time, pointerType, pointerId });
}

function tap(env, x, y, time, pointerType = "touch", pointerId = 1) {
  const down = send(env.container, "pointerdown", x, y, time, pointerType, pointerId);
  const up = send(windowTarget, "pointerup", x, y, time + 40, pointerType, pointerId);
  return { down, up };
}

function drag(env, x1, y1, x2, y2, time, pointerType = "touch", pointerId = 1) {
  const down = send(env.container, "pointerdown", x1, y1, time, pointerType, pointerId);
  const move = send(windowTarget, "pointermove", x2, y2, time + 80, pointerType, pointerId);
  const up = send(windowTarget, "pointerup", x2, y2, time + 120, pointerType, pointerId);
  return { down, move, up };
}

const allTools = [
  "trend_line", "ray", "extended_line", "horizontal_line", "vertical_line",
  "parallel_channel", "fib_retracement", "fib_extension", "rectangle", "circle",
  "polyline", "text", "note", "price_range", "time_range", "long_position", "short_position",
];
assert.deepStrictEqual(Object.keys(TOOL_DEFS).sort(), allTools.slice().sort());
for (const tool of allTools) {
  assert.ok(TOOL_DEFS[tool].creationGesture, `${tool} missing creationGesture`);
  assert.ok(TOOL_DEFS[tool].completion, `${tool} missing completion`);
  assert.ok("anchorCount" in TOOL_DEFS[tool], `${tool} missing anchorCount`);
}
assert.strictEqual(TOOL_DEFS.circle.semanticShape, "ellipse");
assert.strictEqual(TOOL_DEFS.circle.label, "Эллипс");

// Fixed two-point tools: first touch-drag-release is a complete object.
for (const pointerType of ["touch", "mouse", "pen"]) {
  for (const tool of [
    "trend_line", "ray", "extended_line", "fib_retracement", "rectangle",
    "circle", "price_range", "time_range", "long_position", "short_position",
  ]) {
    const env = makeManager();
    env.manager.setTool(tool);
    assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.TOOL_ARMED);
    assert.strictEqual(env.container.style.touchAction, "none");
    const events = drag(env, 40, 50, 180, 160, 1000, pointerType);
    assert.ok(events.down.defaultPrevented, `${tool}/${pointerType}: drawing did not own pointerdown`);
    assert.strictEqual(env.manager.drawings.length, 1, `${tool}/${pointerType}: drag did not commit`);
    assert.strictEqual(env.manager.draft, null, `${tool}/${pointerType}: stale draft`);
    assert.strictEqual(env.manager.activeTool, null, `${tool}/${pointerType}: tool stayed armed`);
    assert.strictEqual(env.manager.drawings[0].points.length, 2);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(env.manager.drawings[0].points)),
      [{ time: 40, price: 50 }, { time: 180, price: 160 }],
    );
    assert.strictEqual(env.container.style.touchAction, "");
  }
}

// Tap -> tap remains supported and second anchor can be adjusted before release.
{
  const env = makeManager();
  env.manager.setTool("trend_line");
  tap(env, 20, 30, 1000);
  assert.strictEqual(env.manager.drawings.length, 0);
  assert.strictEqual(env.manager.draft.points.length, 1);
  send(env.container, "pointerdown", 100, 120, 1700);
  send(windowTarget, "pointermove", 150, 180, 1780);
  send(windowTarget, "pointerup", 150, 180, 1820);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(env.manager.drawings[0].points)),
    [{ time: 20, price: 30 }, { time: 150, price: 180 }],
  );
}

// Current Ray regression: release commits direction; outside tap only deselects.
{
  const env = makeManager();
  env.manager.setTool("ray");
  drag(env, 30, 40, 160, 100, 1000);
  const ray = env.manager.drawings[0];
  const before = JSON.stringify({ points: ray.points, properties: ray.properties });
  assert.strictEqual(env.manager.selectedId, ray.id);
  tap(env, 700, 380, 2000);
  assert.strictEqual(env.manager.selectedId, null);
  assert.strictEqual(JSON.stringify({ points: ray.points, properties: ray.properties }), before);
}

// First drag establishes the first line for 3-anchor tools, then the third tap commits.
for (const tool of ["parallel_channel", "fib_extension"]) {
  const env = makeManager();
  env.manager.setTool(tool);
  drag(env, 30, 50, 180, 110, 1000);
  assert.strictEqual(env.manager.drawings.length, 0);
  assert.strictEqual(env.manager.draft.points.length, 2);
  tap(env, 120, 220, 1800);
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.strictEqual(env.manager.drawings[0].points.length, 3);
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, null);
}

// One-anchor tools commit on release.
for (const tool of ["horizontal_line", "vertical_line", "text", "note"]) {
  const env = makeManager();
  env.manager.setTool(tool);
  tap(env, 70, 90, 1000);
  assert.strictEqual(env.manager.drawings.length, 1, `${tool} did not commit`);
  assert.strictEqual(env.manager.drawings[0].points.length, 1);
  assert.strictEqual(env.manager.draft, null);
}

// Tool A -> Tool B cancels an unfinished draft rather than inheriting anchors.
{
  const env = makeManager();
  env.manager.setTool("trend_line");
  tap(env, 20, 20, 1000);
  assert.strictEqual(env.manager.draft.points.length, 1);
  env.manager.setTool("rectangle");
  assert.strictEqual(env.manager.draft, null);
  drag(env, 60, 60, 140, 140, 1700);
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.strictEqual(env.manager.drawings[0].type, "rectangle");
}

// Keep Drawing is native engine state, not a UI prototype override.
{
  const env = makeManager();
  env.manager.keepDrawing = true;
  env.manager.setTool("trend_line");
  drag(env, 20, 20, 100, 100, 1000);
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, "trend_line");
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.TOOL_ARMED);
}

// Polyline: sequential vertices + double-tap completion without a duplicate vertex.
{
  const env = makeManager();
  env.manager.setTool("polyline");
  tap(env, 20, 20, 1000);
  tap(env, 80, 40, 1600);
  tap(env, 140, 90, 2200);
  assert.strictEqual(env.manager.draft.points.length, 3);
  tap(env, 140, 90, 2300); // second tap at same endpoint => explicit finish
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.strictEqual(env.manager.drawings[0].points.length, 3);
  assert.strictEqual(env.manager.activeTool, null);
}

// Escape finishes a valid open polyline, but cancels an insufficient draft.
{
  const env = makeManager();
  env.manager.setTool("polyline");
  tap(env, 10, 10, 1000);
  tap(env, 40, 40, 1600);
  assert.strictEqual(env.manager.handleEscape(), "finished");
  assert.strictEqual(env.manager.drawings.length, 1);

  env.manager.setTool("polyline");
  tap(env, 100, 100, 2400);
  assert.strictEqual(env.manager.handleEscape(), "canceled");
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, null);
}

// Editing is thresholded: a touch tap on a handle never mutates geometry.
{
  const env = makeManager();
  env.manager.setTool("trend_line");
  drag(env, 30, 30, 160, 160, 1000);
  const drawing = env.manager.drawings[0];
  const before = JSON.stringify(drawing.points);
  send(env.container, "pointerdown", 30, 30, 2000);
  send(windowTarget, "pointermove", 35, 34, 2050);
  send(windowTarget, "pointerup", 35, 34, 2080);
  assert.strictEqual(JSON.stringify(drawing.points), before);

  send(env.container, "pointerdown", 30, 30, 2600);
  send(windowTarget, "pointermove", 70, 80, 2680);
  send(windowTarget, "pointerup", 70, 80, 2720);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points[0])),
    { time: 70, price: 80 },
  );
}

// Whole-object drag translates both anchors; horizontal/vertical preserve their semantic axis.
{
  const env = makeManager();
  env.manager.setTool("trend_line");
  drag(env, 20, 20, 120, 120, 1000);
  const drawing = env.manager.drawings[0];
  send(env.container, "pointerdown", 70, 70, 2000);
  send(windowTarget, "pointermove", 100, 100, 2080);
  send(windowTarget, "pointerup", 100, 100, 2120);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points)),
    [{ time: 50, price: 50 }, { time: 150, price: 150 }],
  );

  const h = makeManager();
  h.manager.setTool("horizontal_line");
  tap(h, 40, 100, 1000);
  const hp = JSON.parse(JSON.stringify(h.manager.drawings[0].points[0]));
  send(h.container, "pointerdown", 300, 100, 1800);
  send(windowTarget, "pointermove", 340, 140, 1880);
  send(windowTarget, "pointerup", 340, 140, 1920);
  assert.strictEqual(h.manager.drawings[0].points[0].time, hp.time);
  assert.strictEqual(h.manager.drawings[0].points[0].price, hp.price + 40);

  const v = makeManager();
  v.manager.setTool("vertical_line");
  tap(v, 100, 80, 1000);
  const vp = JSON.parse(JSON.stringify(v.manager.drawings[0].points[0]));
  send(v.container, "pointerdown", 100, 250, 1800);
  send(windowTarget, "pointermove", 150, 290, 1880);
  send(windowTarget, "pointerup", 150, 290, 1920);
  assert.strictEqual(v.manager.drawings[0].points[0].time, vp.time + 50);
  assert.strictEqual(v.manager.drawings[0].points[0].price, vp.price);
}

// Pointer cancel rolls creation/edit state back and releases capture.
{
  const env = makeManager();
  env.manager.setTool("trend_line");
  send(env.container, "pointerdown", 20, 20, 1000);
  send(windowTarget, "pointermove", 120, 120, 1080);
  send(windowTarget, "pointercancel", 120, 120, 1100);
  assert.strictEqual(env.manager.drawings.length, 0);
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, "trend_line");
  assert.strictEqual(env.container.captured.size, 0);
}

// Cursor empty drag stays available to the chart; stationary empty tap only deselects.
{
  const env = makeManager();
  const d = env.manager.addDrawing("rectangle", [{ time: 20, price: 20 }, { time: 80, price: 80 }]);
  env.manager.select(d.id);
  const down = send(env.container, "pointerdown", 600, 300, 1000);
  const move = send(windowTarget, "pointermove", 680, 350, 1080);
  const up = send(windowTarget, "pointerup", 680, 350, 1120);
  assert.strictEqual(down.defaultPrevented, false);
  assert.strictEqual(move.defaultPrevented, false);
  assert.strictEqual(up.defaultPrevented, false);
  assert.strictEqual(env.manager.selectedId, d.id);

  tap(env, 700, 380, 1800);
  assert.strictEqual(env.manager.selectedId, null);
}

// Outside tap is a byte-for-byte geometry/properties no-op for every editable drawing type.
{
  const pointsFor = (tool) => {
    const n = TOOL_DEFS[tool].anchorCount;
    if (n === 1) return [{ time: 30, price: 60 }];
    if (n === 3) return [{ time: 20, price: 30 }, { time: 90, price: 100 }, { time: 120, price: 170 }];
    if (n < 0) return [{ time: 20, price: 30 }, { time: 60, price: 90 }, { time: 100, price: 40 }];
    return [{ time: 20, price: 30 }, { time: 100, price: 120 }];
  };
  for (const tool of allTools) {
    const env = makeManager();
    const d = env.manager.addDrawing(tool, pointsFor(tool));
    env.manager.select(d.id);
    const before = JSON.stringify({ points: d.points, properties: d.properties });
    tap(env, 760, 390, 1000);
    assert.strictEqual(JSON.stringify({ points: d.points, properties: d.properties }), before, `${tool}: outside tap mutated object`);
  }
}

// Two managers never share draft/selection/geometry state.
{
  const a = makeManager();
  const b = makeManager();
  a.manager.setTool("trend_line");
  drag(a, 20, 20, 100, 100, 1000);
  assert.strictEqual(a.manager.drawings.length, 1);
  assert.strictEqual(b.manager.drawings.length, 0);
  assert.strictEqual(b.manager.activeTool, null);
  assert.strictEqual(b.manager.draft, null);
}

// Destroy is deterministic: listeners/capture/navigation ownership are cleared.
{
  const env = makeManager();
  env.manager.setTool("trend_line");
  send(env.container, "pointerdown", 20, 20, 1000);
  assert.ok(env.container.captured.has(1));
  env.manager.destroy();
  assert.strictEqual(env.container.captured.size, 0);
  assert.strictEqual(env.container.style.touchAction, "");
  assert.strictEqual(env.manager._domCleanup, null);
}


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

console.log("chart drawing runtime tests: PASS");
