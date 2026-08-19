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
      cancelable: true,
      touches: [],
      changedTouches: [],
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

// This fake deliberately reproduces the Lightweight Charts boundary failure
// mode: direct conversions return null outside the pane, and timeToCoordinate
// also refuses timestamps that are not exact candle times. The Drawing Engine
// must bridge those gaps through continuous logical/price coordinates.
function makeBoundaryManager() {
  const container = new FakeTarget();
  const navigationOptions = [];
  const candles = Array.from({ length: 10 }, (_, i) => ({
    time: 1000 + i * 60,
    open: 190 + i, high: 210 + i, low: 170 + i, close: 200 + i,
  }));
  const candleTimes = new Set(candles.map((c) => c.time));
  const visible = { from: 2, to: 6 };
  const toLogical = (time) => (time - 1000) / 60;
  const toTime = (logical) => 1000 + logical * 60;
  const toX = (logical) => (logical - visible.from) / (visible.to - visible.from) * container.clientWidth;
  const timeScale = {
    getVisibleLogicalRange: () => ({ ...visible }),
    coordinateToLogical(x) {
      if (x < 0 || x > container.clientWidth) return null;
      return visible.from + (x / container.clientWidth) * (visible.to - visible.from);
    },
    logicalToCoordinate(logical) {
      const x = toX(logical);
      return x < 0 || x > container.clientWidth ? null : x;
    },
    coordinateToTime(x) {
      if (x < 0 || x > container.clientWidth) return null;
      return toTime(visible.from + (x / container.clientWidth) * (visible.to - visible.from));
    },
    timeToCoordinate(time) {
      if (!candleTimes.has(time)) return null;
      const x = toX(toLogical(time));
      return x < 0 || x > container.clientWidth ? null : x;
    },
  };
  const chart = {
    timeScale: () => timeScale,
    applyOptions: (opts) => navigationOptions.push(JSON.parse(JSON.stringify(opts))),
  };
  const series = {
    attachPrimitive(primitive) { primitive.attached({ requestUpdate() {} }); },
    detachPrimitive() {},
    coordinateToPrice(y) {
      if (y < 0 || y > container.clientHeight) return null;
      return 300 - y / 2;
    },
    priceToCoordinate(price) {
      const y = (300 - price) * 2;
      return y < 0 || y > container.clientHeight ? null : y;
    },
  };
  const core = { container, chart, candleSeries: series, candles };
  const manager = new DrawingManager(core);
  return { manager, container, chart, navigationOptions, candles, visible };
}

function send(target, type, x, y, time, pointerType = "touch", pointerId = 1) {
  return target.dispatch(type, { clientX: x, clientY: y, timeStamp: time, pointerType, pointerId });
}

function makeTouch(identifier, x, y) {
  return { identifier, clientX: x, clientY: y };
}

function sendTouch(target, type, touches, changedTouches, time) {
  return target.dispatch(type, { touches, changedTouches, timeStamp: time });
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

function pointsFor(tool) {
  const n = TOOL_DEFS[tool].anchorCount;
  if (n === 1) return [{ time: 60, price: 100 }];
  if (n === 3) return [{ time: 40, price: 100 }, { time: 160, price: 180 }, { time: 100, price: 230 }];
  if (n === 4) return [{ time: 20, price: 80 }, { time: 60, price: 200 }, { time: 100, price: 120 }, { time: 140, price: 220 }];
  if (n === 5) return [{ time: 20, price: 80 }, { time: 60, price: 200 }, { time: 100, price: 120 }, { time: 140, price: 220 }, { time: 180, price: 140 }];
  if (n === 6) return [{ time: 20, price: 80 }, { time: 60, price: 200 }, { time: 100, price: 120 }, { time: 140, price: 220 }, { time: 180, price: 140 }, { time: 220, price: 240 }];
  if (n < 0) return [{ time: 40, price: 100 }, { time: 100, price: 180 }, { time: 160, price: 120 }];
  return [{ time: 40, price: 100 }, { time: 160, price: 180 }];
}

function boundaryPointsFor(tool) {
  const n = TOOL_DEFS[tool].anchorCount;
  if (n === 1) return [{ time: 1180, price: 200 }];
  if (n === 3) return [{ time: 1180, price: 180 }, { time: 1240, price: 220 }, { time: 1300, price: 160 }];
  if (n === 4) return [{ time: 1180, price: 140 }, { time: 1210, price: 220 }, { time: 1240, price: 160 }, { time: 1270, price: 220 }];
  if (n === 5) return [{ time: 1180, price: 140 }, { time: 1210, price: 220 }, { time: 1240, price: 160 }, { time: 1270, price: 220 }, { time: 1300, price: 180 }];
  if (n === 6) return [{ time: 1180, price: 140 }, { time: 1210, price: 220 }, { time: 1240, price: 160 }, { time: 1270, price: 220 }, { time: 1300, price: 180 }, { time: 1330, price: 240 }];
  if (n < 0) return [{ time: 1180, price: 180 }, { time: 1240, price: 220 }, { time: 1300, price: 170 }];
  return [{ time: 1180, price: 180 }, { time: 1240, price: 220 }];
}

function assertFiniteDrawing(drawing, label = drawing.type) {
  assert.ok(drawing, `${label}: drawing missing`);
  for (const [index, point] of drawing.points.entries()) {
    assert.ok(Number.isFinite(point.time), `${label}: point ${index} time invalid: ${point.time}`);
    assert.ok(Number.isFinite(point.price), `${label}: point ${index} price invalid: ${point.price}`);
  }
}

function renderOps(env) {
  env.manager.primitive._view.update();
  return env.manager.primitive._view._ops;
}

function findBodyPoint(env, drawing, pointerType = "touch") {
  if (drawing.type === "text" || drawing.type === "note") {
    const point = env.manager.pixelToPoint(200, 200);
    drawing._lastBox = { x1: 190, y1: 180, x2: 270, y2: 220 };
    if (point.time === drawing.points[0].time && point.price === drawing.points[0].price) return { x: 230, y: 200 };
    // Normal identity-runtime fixtures keep their historical text box.
    drawing._lastBox = { x1: 55, y1: 80, x2: 150, y2: 120 };
    return { x: 100, y: 100 };
  }
  for (let y = 10; y <= 390; y += 5) {
    for (let x = 10; x <= 790; x += 5) {
      const hit = env.manager.hitTest(x, y, { pointerType });
      if (hit && hit.id === drawing.id && hit.handle == null) return { x, y };
    }
  }
  throw new Error(`${drawing.type}: no body hit point found for ${pointerType}`);
}

function touchDragDrawing(env, drawing, start, dx = 30, dy = 25, touchId = 41, pointerId = 1) {
  const t0 = makeTouch(touchId, start.x, start.y);
  const touchStart = sendTouch(env.container, "touchstart", [t0], [t0], 1000);
  const pointerDown = send(env.container, "pointerdown", start.x, start.y, 1010, "touch", pointerId);
  const t1 = makeTouch(touchId, start.x + dx, start.y + dy);
  const touchMove = sendTouch(windowTarget, "touchmove", [t1], [t1], 1060);
  const pointerMove = send(windowTarget, "pointermove", start.x + dx, start.y + dy, 1070, "touch", pointerId);
  const pointerUp = send(windowTarget, "pointerup", start.x + dx, start.y + dy, 1100, "touch", pointerId);
  const touchEnd = sendTouch(windowTarget, "touchend", [], [t1], 1110);
  return { touchStart, pointerDown, touchMove, pointerMove, pointerUp, touchEnd };
}

const allTools = [
  "trend_line", "ray", "extended_line", "horizontal_line", "horizontal_ray", "vertical_line",
  "parallel_channel", "fib_retracement", "fib_extension", "rectangle", "circle",
  "polyline", "text", "note", "price_range", "time_range", "long_position", "short_position",
  "triangle", "price_date_range", "freehand", "measure", "pitchfork", "gann_fan", "xabcd_pattern",
  "pitchfork_schiff", "pitchfork_modified_schiff", "abcd_pattern", "triangle_pattern",
  "three_drives_pattern", "head_shoulders_pattern",
  "elliott_impulse_wave", "elliott_correction_wave", "cyclic_lines", "sine_line",
  "anchored_vwap", "highlighter", "arrow", "arrow_mark_up", "arrow_mark_down",
  "arrow_mark_left", "arrow_mark_right", "rotated_rectangle",
];
assert.deepStrictEqual(Object.keys(TOOL_DEFS).sort(), allTools.slice().sort());
// "measure" is the one ephemeral tool - it never becomes a real entry in
// env.manager.drawings (see its own dedicated test below), so every loop
// below that does env.manager.addDrawing(tool, ...) to exercise persisted-
// object editing/hit-testing/boundary behavior must skip it. "anchored_vwap"
// is skipped for a different reason: its rendered body is a computed price
// series from core.candles (empty in makeManager's identity-conversion fake
// environment), so it has no hittable "body" distinct from its handle the
// way every other tool's fixed geometry does - findBodyPoint() would spin
// forever looking for one. It gets its own dedicated test with real candle
// data below instead.
const persistentTools = allTools.filter((tool) => tool !== "measure" && tool !== "anchored_vwap");
for (const tool of allTools) {
  assert.ok(TOOL_DEFS[tool].creationGesture, `${tool} missing creationGesture`);
  assert.ok(TOOL_DEFS[tool].completion, `${tool} missing completion`);
  assert.ok("anchorCount" in TOOL_DEFS[tool], `${tool} missing anchorCount`);
}
assert.strictEqual(TOOL_DEFS.circle.semanticShape, "ellipse");
assert.strictEqual(TOOL_DEFS.circle.label, "Эллипс");
assert.strictEqual(TOOL_DEFS.measure.ephemeral, true);

// Fixed two-point tools: first touch-drag-release is a complete object.
for (const pointerType of ["touch", "mouse", "pen"]) {
  for (const tool of [
    "trend_line", "ray", "extended_line", "fib_retracement", "rectangle",
    "circle", "price_range", "time_range", "long_position", "short_position",
    "price_date_range", "gann_fan", "cyclic_lines", "sine_line", "arrow",
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
for (const tool of ["parallel_channel", "fib_extension", "triangle", "pitchfork", "pitchfork_schiff", "pitchfork_modified_schiff"]) {
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

// XABCD, Triangle Pattern and Head & Shoulders are the three 5-anchor
// tools: same staged-commit mechanics as the 3-anchor tools above (first
// drag places the first two anchors, then three more taps place the
// rest), just with a longer tail of single taps before anchorCount is
// reached.
for (const tool of ["xabcd_pattern", "triangle_pattern", "head_shoulders_pattern"]) {
  const env = makeManager();
  env.manager.setTool(tool);
  drag(env, 20, 60, 60, 180, 1000);
  assert.strictEqual(env.manager.drawings.length, 0);
  assert.strictEqual(env.manager.draft.points.length, 2);
  tap(env, 100, 100, 1800);
  assert.strictEqual(env.manager.draft.points.length, 3);
  tap(env, 140, 200, 2000);
  assert.strictEqual(env.manager.draft.points.length, 4);
  tap(env, 180, 120, 2200);
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.strictEqual(env.manager.drawings[0].points.length, 5);
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, null);
  assertFiniteDrawing(env.manager.drawings[0]);
}

// ABCD and Elliott Correction are the two 4-anchor tools: same mechanics,
// one shorter tail (drag places the first two anchors, two more taps
// place the rest).
for (const tool of ["abcd_pattern", "elliott_correction_wave"]) {
  const env = makeManager();
  env.manager.setTool(tool);
  drag(env, 20, 60, 60, 180, 1000);
  assert.strictEqual(env.manager.drawings.length, 0);
  assert.strictEqual(env.manager.draft.points.length, 2);
  tap(env, 100, 100, 1800);
  assert.strictEqual(env.manager.draft.points.length, 3);
  tap(env, 140, 200, 2000);
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.strictEqual(env.manager.drawings[0].points.length, 4);
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, null);
  assertFiniteDrawing(env.manager.drawings[0]);
}

// Three Drives and Elliott Impulse are the two 6-anchor tools: same
// mechanics, one longer tail (drag places the first two anchors, four
// more taps place the rest).
for (const tool of ["three_drives_pattern", "elliott_impulse_wave"]) {
  const env = makeManager();
  env.manager.setTool(tool);
  drag(env, 20, 60, 60, 180, 1000);
  assert.strictEqual(env.manager.drawings.length, 0);
  assert.strictEqual(env.manager.draft.points.length, 2);
  tap(env, 100, 100, 1800);
  assert.strictEqual(env.manager.draft.points.length, 3);
  tap(env, 140, 200, 2000);
  assert.strictEqual(env.manager.draft.points.length, 4);
  tap(env, 180, 120, 2200);
  assert.strictEqual(env.manager.draft.points.length, 5);
  tap(env, 220, 220, 2400);
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.strictEqual(env.manager.drawings[0].points.length, 6);
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, null);
  assertFiniteDrawing(env.manager.drawings[0]);
}

// One-anchor tools commit on release.
for (const tool of ["horizontal_line", "vertical_line", "text", "note", "anchored_vwap", "arrow_mark_up"]) {
  const env = makeManager();
  env.manager.setTool(tool);
  tap(env, 70, 90, 1000);
  assert.strictEqual(env.manager.drawings.length, 1, `${tool} did not commit`);
  assert.strictEqual(env.manager.drawings[0].points.length, 1);
  assert.strictEqual(env.manager.draft, null);
}

// Freehand: continuously samples points during one drag (not a fixed
// anchor count like every other tool) and discards a no-movement click
// instead of leaving a dangling 1-point stroke.
{
  const env = makeManager();
  env.manager.setTool("freehand");
  tap(env, 40, 40, 1000);
  assert.strictEqual(env.manager.drawings.length, 0, "freehand: no-drag tap must not create a stroke");
  assert.strictEqual(env.manager.draft, null, "freehand: no-drag tap must not leave a dangling draft");
  assert.strictEqual(env.manager.activeTool, "freehand", "freehand: tool should stay armed after a no-op click");

  const down = send(env.container, "pointerdown", 40, 40, 2000);
  send(windowTarget, "pointermove", 70, 60, 2020);
  send(windowTarget, "pointermove", 110, 90, 2040);
  send(windowTarget, "pointermove", 160, 130, 2060);
  send(windowTarget, "pointerup", 160, 130, 2080);
  assert.ok(down.defaultPrevented, "freehand: drawing did not own pointerdown");
  assert.strictEqual(env.manager.drawings.length, 1, "freehand: drag did not commit a stroke");
  const stroke = env.manager.drawings[0];
  assert.strictEqual(stroke.type, "freehand");
  assert.ok(stroke.points.length >= 3, `freehand: expected multiple sampled points, got ${stroke.points.length}`);
  assertFiniteDrawing(stroke);
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, null, "freehand: tool should disarm after a completed stroke");

  const ops = renderOps(env);
  const strokeOp = ops.find((op) => op.d && op.d.id === stroke.id);
  assert.ok(strokeOp, "freehand: no render op produced for the stroke");
  assert.strictEqual(strokeOp.kind, "polyline", "freehand should reuse polyline's paint/hit-test op kind");
}

// Highlighter: identical drag-release sampling mechanics to freehand above
// (same "freehand-drag"/"drag-release" TOOL_DEFS entry) - only its own
// render op kind (and default thick/translucent styling) differ.
{
  const env = makeManager();
  env.manager.setTool("highlighter");
  tap(env, 40, 40, 1000);
  assert.strictEqual(env.manager.drawings.length, 0, "highlighter: no-drag tap must not create a stroke");
  assert.strictEqual(env.manager.draft, null, "highlighter: no-drag tap must not leave a dangling draft");
  assert.strictEqual(env.manager.activeTool, "highlighter", "highlighter: tool should stay armed after a no-op click");

  const down = send(env.container, "pointerdown", 40, 40, 2000);
  send(windowTarget, "pointermove", 70, 60, 2020);
  send(windowTarget, "pointermove", 110, 90, 2040);
  send(windowTarget, "pointermove", 160, 130, 2060);
  send(windowTarget, "pointerup", 160, 130, 2080);
  assert.ok(down.defaultPrevented, "highlighter: drawing did not own pointerdown");
  assert.strictEqual(env.manager.drawings.length, 1, "highlighter: drag did not commit a stroke");
  const stroke = env.manager.drawings[0];
  assert.strictEqual(stroke.type, "highlighter");
  assert.ok(stroke.points.length >= 3, `highlighter: expected multiple sampled points, got ${stroke.points.length}`);
  assertFiniteDrawing(stroke);
  assert.strictEqual(env.manager.draft, null);
  assert.strictEqual(env.manager.activeTool, null, "highlighter: tool should disarm after a completed stroke");

  const ops = renderOps(env);
  const strokeOp = ops.find((op) => op.d && op.d.id === stroke.id);
  assert.ok(strokeOp, "highlighter: no render op produced for the stroke");
  assert.strictEqual(strokeOp.kind, "highlighter", "highlighter should get its own paint op kind, not freehand's polyline");
  assert.strictEqual(strokeOp.width, 14, "highlighter: default width should stay thick even mid-draft");
}

// Anchored VWAP: the one tool whose rendered body is a computed price
// series (cumulative volume-weighted typical price from the anchor bar to
// the latest candle) rather than fixed geometry - needs real candle+volume
// data to exercise properly, unlike every other tool's identity-conversion
// fake environment.
{
  const container = new FakeTarget();
  const timeScale = { coordinateToTime: (x) => x, timeToCoordinate: (time) => time };
  const chart = { timeScale: () => timeScale, applyOptions: () => {} };
  const series = {
    attachPrimitive(p) { p.attached({ requestUpdate() {} }); },
    detachPrimitive() {},
    coordinateToPrice: (y) => y,
    priceToCoordinate: (price) => price,
  };
  const candles = [
    { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: 160, open: 11, high: 13, low: 10, close: 12, volume: 200 },
    { time: 220, open: 12, high: 14, low: 11, close: 13, volume: 300 },
  ];
  const core = { container, chart, candleSeries: series, candles };
  const manager = new DrawingManager(core);
  const env = { manager, container };

  manager.setTool("anchored_vwap");
  tap(env, 160, 11, 1000);
  assert.strictEqual(manager.drawings.length, 1, "anchored_vwap did not commit");
  const drawing = manager.drawings[0];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(drawing.points)), [{ time: 160, price: 11 }]);

  // Anchored at candle index 1 (time 160): VWAP over candles[1..2].
  // candles[1]: typical (13+10+12)/3 = 11.6667, vol 200
  // candles[2]: typical (14+11+13)/3 = 12.6667, vol 300
  // cum after [1]: pv=2333.33, v=200 -> 11.6667
  // cum after [2]: pv=2333.33+3800=6133.33, v=500 -> 12.2667
  const vwapOp = renderOps(env).find((op) => op.kind === "anchored_vwap");
  assert.ok(vwapOp, "anchored_vwap: no render op produced");
  assert.strictEqual(vwapOp.points.length, 2, "anchored_vwap: expected one point per candle from the anchor bar onward");
  assert.ok(Math.abs(vwapOp.points[0].y - 11.6667) < 0.01, `anchored_vwap: first VWAP value off (${vwapOp.points[0].y})`);
  assert.ok(Math.abs(vwapOp.points[1].y - 12.2667) < 0.01, `anchored_vwap: second VWAP value off (${vwapOp.points[1].y})`);

  // Hit-testing: the anchor handle, and a point along the computed line
  // (not one of the raw anchor/candle points) both resolve to this drawing.
  const handleHit = manager.hitTest(160, 11, { pointerType: "mouse" });
  assert.strictEqual(handleHit && handleHit.handle, 0, "anchored_vwap: handle hit-test failed");
  manager.select(drawing.id);
  const midX = (vwapOp.points[0].x + vwapOp.points[1].x) / 2, midY = (vwapOp.points[0].y + vwapOp.points[1].y) / 2;
  const bodyHit = manager.hitTest(midX, midY, { pointerType: "mouse" });
  assert.ok(bodyHit && bodyHit.id === drawing.id && bodyHit.handle == null, "anchored_vwap: body hit-test failed along the computed VWAP line");

  // An anchor placed after every candle has no series to compute - must not
  // crash and must not render a body.
  const afterEnv = { manager, container };
  manager.removeDrawing(drawing.id);
  manager.setTool("anchored_vwap");
  tap(afterEnv, 500, 20, 2000);
  assert.doesNotThrow(() => renderOps(afterEnv), "anchored_vwap: render must not throw for an anchor past the last candle");
  assert.strictEqual(renderOps(afterEnv).some((op) => op.kind === "anchored_vwap"), false, "anchored_vwap: no body should render past the last candle");
}

// Anchored VWAP with zero candles (every other tool's makeManager() fake
// environment) must not throw either - just render nothing.
{
  const env = makeManager();
  env.manager.setTool("anchored_vwap");
  tap(env, 70, 90, 1000);
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.doesNotThrow(() => renderOps(env), "anchored_vwap: render must not throw with zero candles");
}

// Cyclic Lines regression: unlike every other 2-anchor tool, its render
// path (cyclicLineTimes) reads both anchors' *time* fields directly
// rather than going through toPixels() first - a naive implementation
// crashed reading points[1].time in the exact window between pointerdown
// and the *first* pointermove, before DrawingManager._draftPreviewPoint
// exists at all (draft.points is length 1 and there is no synthesized
// preview point yet for DrawingPaneView.update() to append - see its own
// `preview ? draft.points.concat([preview]) : draft.points` branch).
// On production this window is real: lightweight-charts repaints
// independent of pointer movement (live ticks, crosshair-following
// redraws), so a render frame genuinely lands there; the unit-test
// helpers don't hit it unless a render is forced with no pointermove
// yet, which is exactly what this test does. Confirmed live on
// production before this test existed.
{
  const env = makeManager();
  env.manager.setTool("cyclic_lines");
  send(env.container, "pointerdown", 40, 40, 1000);
  assert.strictEqual(env.manager.draft.points.length, 1, "cyclic_lines: expected single point right after pointerdown");
  assert.strictEqual(env.manager._draftPreviewPoint, null, "cyclic_lines: no preview point should exist before the first pointermove");
  assert.doesNotThrow(() => renderOps(env), "cyclic_lines: render must not throw with only one anchor placed and no preview yet");

  send(windowTarget, "pointermove", 100, 40, 1040);
  send(windowTarget, "pointerup", 100, 40, 1060);
  assert.strictEqual(env.manager.drawings.length, 1);
  const xs = renderOps(env).find((op) => op.kind === "cyclic_lines" && op.d.type === "cyclic_lines").xs;
  assert.ok(Array.isArray(xs) && xs.length > 0, "cyclic_lines: expected at least one repeated line");
}

// Measure: TradingView-style ephemeral ruler (TOOL_DEFS.measure). Unlike
// every persistent two-point tool above, a completed drag must NOT create a
// drawing - it should render a live preview mid-drag, then vanish on
// release while the tool stays armed for another measurement right away.
{
  const env = makeManager();
  env.manager.setTool("measure");
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.TOOL_ARMED);

  const down = send(env.container, "pointerdown", 40, 40, 1000);
  assert.ok(down.defaultPrevented, "measure: drawing did not own pointerdown");
  send(windowTarget, "pointermove", 140, 120, 1040);
  const midDragOps = renderOps(env);
  const liveOp = midDragOps.find((op) => op.kind === "measure_tool");
  assert.ok(liveOp, "measure: no live preview op while dragging");
  assert.strictEqual(env.manager.drawings.length, 0, "measure: must not persist mid-drag");

  send(windowTarget, "pointerup", 140, 120, 1080);
  assert.strictEqual(env.manager.drawings.length, 0, "measure: drag-release must not create a drawing");
  assert.strictEqual(env.manager.draft, null, "measure: stale draft after release");
  assert.strictEqual(env.manager.activeTool, "measure", "measure: tool must re-arm itself for the next measurement");
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.TOOL_ARMED);
  assert.strictEqual(renderOps(env).some((op) => op.kind === "measure_tool"), false, "measure: overlay must disappear on release");

  // Re-armed tool measures again without reselecting it from the toolbar.
  drag(env, 200, 60, 260, 200, 2000);
  assert.strictEqual(env.manager.drawings.length, 0, "measure: second drag must also stay ephemeral");
  assert.strictEqual(env.manager.activeTool, "measure");
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

// Touch editing uses a forgiving hit corridor, and hidden handles on an
// unselected object never resize it. First drag moves the whole object; once
// selected, dragging a visible anchor edits only that anchor.
{
  const env = makeManager();
  env.manager.setTool("trend_line");
  drag(env, 20, 20, 120, 120, 1000);
  const drawing = env.manager.drawings[0];
  env.manager.select(null);

  // 16px vertically off y=x is ~11.3px perpendicular: outside the old 6px
  // mouse corridor, inside the touch corridor.
  const touchGrab = drag(env, 70, 86, 100, 116, 2000);
  assert.strictEqual(touchGrab.down.defaultPrevented, true);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points)),
    [{ time: 50, price: 50 }, { time: 150, price: 150 }],
  );

  env.manager.select(null);
  drag(env, 50, 50, 80, 80, 2800); // exact hidden anchor => whole-object move
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points)),
    [{ time: 80, price: 80 }, { time: 180, price: 180 }],
  );

  // The object is now selected, so the same anchor is an explicit edit handle.
  drag(env, 80, 80, 105, 115, 3600);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points)),
    [{ time: 105, price: 115 }, { time: 180, price: 180 }],
  );
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
  for (const tool of persistentTools) {
    const env = makeManager();
    const d = env.manager.addDrawing(tool, pointsFor(tool));
    env.manager.select(d.id);
    const before = JSON.stringify({ points: d.points, properties: d.properties });
    tap(env, 760, 390, 1000);
    assert.strictEqual(JSON.stringify({ points: d.points, properties: d.properties }), before, `${tool}: outside tap mutated object`);
  }
}

// Selected Rectangle body touch drag: Safari guard owns the native gesture,
// then Pointer Events alone transition into DRAG_OBJECT and translate both anchors.
{
  const env = makeManager();
  const d = env.manager.addDrawing("rectangle", [{ time: 40, price: 80 }, { time: 180, price: 220 }]);
  const before = JSON.parse(JSON.stringify(d.points));
  const events = touchDragDrawing(env, d, { x: 100, y: 150 }, 35, 30, 51);
  assert.strictEqual(events.touchStart.defaultPrevented, true);
  assert.strictEqual(events.touchMove.defaultPrevented, true);
  assert.strictEqual(events.pointerDown.defaultPrevented, true);
  assert.strictEqual(events.pointerMove.defaultPrevented, true);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(d.points)),
    before.map((p) => ({ time: p.time + 35, price: p.price + 30 })),
  );
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.SELECTED);
  assert.strictEqual(env.manager._ownedTouchIds.size, 0);
}

// Rectangle handle keeps priority over the selected body and only resizes one anchor.
{
  const env = makeManager();
  const d = env.manager.addDrawing("rectangle", [{ time: 40, price: 80 }, { time: 180, price: 220 }]);
  const before = JSON.parse(JSON.stringify(d.points));
  const t0 = makeTouch(52, 40, 80);
  const start = sendTouch(env.container, "touchstart", [t0], [t0], 1000);
  send(env.container, "pointerdown", 40, 80, 1010);
  const t1 = makeTouch(52, 75, 120);
  sendTouch(windowTarget, "touchmove", [t1], [t1], 1060);
  send(windowTarget, "pointermove", 75, 120, 1070);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_HANDLE);
  send(windowTarget, "pointerup", 75, 120, 1100);
  sendTouch(windowTarget, "touchend", [], [t1], 1110);
  assert.strictEqual(start.defaultPrevented, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.points[0])), { time: 75, price: 120 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.points[1])), before[1]);
}

// Safari touch guard suppresses native scrolling for body hits across every
// drawing type, while Pointer Events remain the only geometry state machine.
for (const tool of persistentTools) {
  const env = makeManager();
  const d = env.manager.addDrawing(tool, pointsFor(tool));
  const start = findBodyPoint(env, d);
  const before = JSON.stringify(d.points);
  const events = touchDragDrawing(env, d, start, 30, 25, 100 + allTools.indexOf(tool));
  assert.strictEqual(events.touchStart.defaultPrevented, true, `${tool}: touchstart not guarded`);
  assert.strictEqual(events.touchMove.defaultPrevented, true, `${tool}: touchmove not guarded`);
  assert.notStrictEqual(JSON.stringify(d.points), before, `${tool}: body drag did not change geometry`);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.SELECTED, `${tool}: did not return to SELECTED`);
  assert.strictEqual(env.manager._ownedTouchIds.size, 0, `${tool}: touch ownership leaked`);
}

// Tap without drag still suppresses Safari page scroll while leaving geometry byte-for-byte unchanged.
{
  const env = makeManager();
  const d = env.manager.addDrawing("rectangle", [{ time: 40, price: 80 }, { time: 180, price: 220 }]);
  const before = JSON.stringify(d.points);
  const t0 = makeTouch(61, 100, 150);
  const start = sendTouch(env.container, "touchstart", [t0], [t0], 1000);
  send(env.container, "pointerdown", 100, 150, 1010);
  const t1 = makeTouch(61, 105, 154);
  const move = sendTouch(windowTarget, "touchmove", [t1], [t1], 1040);
  send(windowTarget, "pointermove", 105, 154, 1050);
  send(windowTarget, "pointerup", 105, 154, 1080);
  sendTouch(windowTarget, "touchend", [], [t1], 1090);
  assert.strictEqual(start.defaultPrevented, true);
  assert.strictEqual(move.defaultPrevented, true);
  assert.strictEqual(JSON.stringify(d.points), before);
}

// Empty chart after selection stays owned by Lightweight Charts, including native touch scrolling/pan.
{
  const env = makeManager();
  const d = env.manager.addDrawing("rectangle", [{ time: 40, price: 80 }, { time: 180, price: 220 }]);
  env.manager.select(d.id);
  const t0 = makeTouch(62, 700, 350);
  const start = sendTouch(env.container, "touchstart", [t0], [t0], 1000);
  const down = send(env.container, "pointerdown", 700, 350, 1010);
  const t1 = makeTouch(62, 730, 370);
  const touchMove = sendTouch(windowTarget, "touchmove", [t1], [t1], 1060);
  const pointerMove = send(windowTarget, "pointermove", 730, 370, 1070);
  send(windowTarget, "pointerup", 730, 370, 1100);
  sendTouch(windowTarget, "touchend", [], [t1], 1110);
  assert.strictEqual(start.defaultPrevented, false);
  assert.strictEqual(down.defaultPrevented, false);
  assert.strictEqual(touchMove.defaultPrevented, false);
  assert.strictEqual(pointerMove.defaultPrevented, false);
  assert.strictEqual(env.manager._pointerSession, null);
  assert.strictEqual(env.manager._ownedTouchIds.size, 0);
}

// Pointercancel rolls edited geometry back, releases capture and clears Safari touch ownership.
{
  const env = makeManager();
  const d = env.manager.addDrawing("rectangle", [{ time: 40, price: 80 }, { time: 180, price: 220 }]);
  const before = JSON.stringify(d.points);
  const t0 = makeTouch(63, 100, 150);
  const start = sendTouch(env.container, "touchstart", [t0], [t0], 1000);
  send(env.container, "pointerdown", 100, 150, 1010);
  const t1 = makeTouch(63, 150, 190);
  sendTouch(windowTarget, "touchmove", [t1], [t1], 1050);
  send(windowTarget, "pointermove", 150, 190, 1060);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT);
  send(windowTarget, "pointercancel", 150, 190, 1080);
  sendTouch(windowTarget, "touchcancel", [], [t1], 1090);
  assert.strictEqual(start.defaultPrevented, true);
  assert.strictEqual(JSON.stringify(d.points), before);
  assert.strictEqual(env.container.captured.size, 0);
  assert.strictEqual(env.manager._ownedTouchIds.size, 0);
}

// Two managers never share draft/selection/geometry or Safari touch ownership.
{
  const a = makeManager();
  const b = makeManager();
  const ad = a.manager.addDrawing("rectangle", [{ time: 40, price: 80 }, { time: 180, price: 220 }]);
  a.manager.select(ad.id);
  const t0 = makeTouch(64, 700, 350);
  const startB = sendTouch(b.container, "touchstart", [t0], [t0], 1000);
  const moveB = sendTouch(windowTarget, "touchmove", [makeTouch(64, 730, 370)], [makeTouch(64, 730, 370)], 1050);
  sendTouch(windowTarget, "touchend", [], [makeTouch(64, 730, 370)], 1100);
  assert.strictEqual(startB.defaultPrevented, false);
  assert.strictEqual(moveB.defaultPrevented, false);
  assert.strictEqual(a.manager._ownedTouchIds.size, 0);
  assert.strictEqual(b.manager._ownedTouchIds.size, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ad.points)), [{ time: 40, price: 80 }, { time: 180, price: 220 }]);
}

// Destroy is deterministic: listeners/capture/navigation/touch ownership are cleared.
{
  const env = makeManager();
  const d = env.manager.addDrawing("rectangle", [{ time: 40, price: 80 }, { time: 180, price: 220 }]);
  const t0 = makeTouch(65, 100, 150);
  sendTouch(env.container, "touchstart", [t0], [t0], 1000);
  send(env.container, "pointerdown", 100, 150, 1010);
  assert.ok(env.container.captured.has(1));
  assert.ok(env.manager._ownedTouchIds.has(65));
  env.manager.destroy();
  assert.strictEqual(env.container.captured.size, 0);
  assert.strictEqual(env.container.style.touchAction, "");
  assert.strictEqual(env.manager._ownedTouchIds.size, 0);
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

// -------------------------------------------------------------------------
// Boundary drag regressions. These are intentionally generic: every tool
// passes through the same safe coordinate/translation pipeline.

// TEST 1/2 — Rectangle right edge + pointer outside canvas. The pointer is
// captured, state stays DRAG_OBJECT, geometry remains finite and the visible
// slice still produces a render op even though one anchor is outside.
{
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing("rectangle", boundaryPointsFor("rectangle"));
  const start = findBodyPoint(env, d, "touch");
  const before = JSON.stringify(d.points);
  send(env.container, "pointerdown", start.x, start.y, 5000, "touch", 501);
  const partialX = start.x + 500;
  send(windowTarget, "pointermove", partialX, start.y + 10, 5080, "touch", 501);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT);
  assert.ok(env.container.captured.has(501), "Rectangle: pointer capture lost at chart edge");
  assert.strictEqual(env.manager.selectedId, d.id);
  assert.strictEqual(env.manager.drawings.includes(d), true);
  assert.strictEqual(d.hidden, false);
  assert.notStrictEqual(JSON.stringify(d.points), before);
  assertFiniteDrawing(d, "Rectangle right edge");
  const rectOp = renderOps(env).find((op) => op.kind === "rect" && op.d.id === d.id);
  assert.ok(rectOp, "Rectangle: partially visible geometry disappeared");
  assert.ok(Math.min(rectOp.x1, rectOp.x2) < env.container.clientWidth);
  assert.ok(Math.max(rectOp.x1, rectOp.x2) > env.container.clientWidth);

  // Pointer capture must keep the same drag alive even after the pointer
  // itself goes 150 px beyond the canvas. The whole shape may now be
  // offscreen; that is valid model state, not deletion/invalid geometry.
  send(windowTarget, "pointermove", env.container.clientWidth + 150, start.y + 10, 5100, "touch", 501);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT);
  assert.ok(env.container.captured.has(501), "Rectangle: pointer capture lost outside canvas");
  assert.strictEqual(env.manager.drawings.includes(d), true);
  assert.strictEqual(env.manager.selectedId, d.id);
  assertFiniteDrawing(d, "Rectangle pointer outside canvas");
  send(windowTarget, "pointerup", env.container.clientWidth + 150, start.y + 10, 5120, "touch", 501);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.SELECTED);
  assert.strictEqual(env.container.captured.has(501), false);
}

// TEST 3 — Rectangle left/top/bottom boundaries keep the drag session alive.
for (const edge of ["left", "top", "bottom"]) {
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing("rectangle", boundaryPointsFor("rectangle"));
  const start = findBodyPoint(env, d, "touch");
  const target = edge === "left" ? { x: -50, y: start.y + 20 }
    : edge === "top" ? { x: start.x + 20, y: -20 }
      : { x: start.x + 20, y: 420 };
  send(env.container, "pointerdown", start.x, start.y, 5200, "touch", 510 + ["left", "top", "bottom"].indexOf(edge));
  send(windowTarget, "pointermove", target.x, target.y, 5280, "touch", 510 + ["left", "top", "bottom"].indexOf(edge));
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT, `Rectangle ${edge}: state reset`);
  assertFiniteDrawing(d, `Rectangle ${edge}`);
  assert.strictEqual(env.manager.selectedId, d.id);
  send(windowTarget, "pointerup", target.x, target.y, 5320, "touch", 510 + ["left", "top", "bottom"].indexOf(edge));
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.SELECTED);
}

// TEST 4 — Handle drag can cross an edge without invalidating the opposite anchor.
{
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing("rectangle", boundaryPointsFor("rectangle"));
  const untouched = JSON.parse(JSON.stringify(d.points[1]));
  send(env.container, "pointerdown", 200, 240, 5400, "touch", 520);
  send(windowTarget, "pointermove", -50, 220, 5480, "touch", 520);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_HANDLE);
  assertFiniteDrawing(d, "Rectangle handle outside");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.points[1])), untouched);
  assert.ok(renderOps(env).some((op) => op.kind === "rect"), "Rectangle handle: visible part disappeared");
  send(windowTarget, "pointerup", -50, 220, 5520, "touch", 520);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.SELECTED);
}

function runBoundaryBodyCase(tool, edge, pointerType, serial) {
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing(tool, boundaryPointsFor(tool));
  const start = findBodyPoint(env, d, pointerType);
  const before = JSON.stringify(d.points);
  const target = edge === "right" ? { x: 850, y: start.y + 30 }
    : edge === "left" ? { x: -50, y: start.y + 30 }
      : edge === "top" ? { x: start.x + 30, y: -20 }
        : { x: start.x + 30, y: 420 };
  const pointerId = 600 + serial;
  send(env.container, "pointerdown", start.x, start.y, 6000 + serial * 10, pointerType, pointerId);
  send(windowTarget, "pointermove", target.x, target.y, 6080 + serial * 10, pointerType, pointerId);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT, `${tool}/${edge}/${pointerType}: drag state lost`);
  assert.strictEqual(env.manager.selectedId, d.id, `${tool}/${edge}/${pointerType}: selection lost`);
  assert.strictEqual(env.manager.drawings.includes(d), true, `${tool}/${edge}/${pointerType}: drawing removed`);
  assert.strictEqual(d.hidden, false, `${tool}/${edge}/${pointerType}: drawing hidden`);
  assert.ok(env.container.captured.has(pointerId), `${tool}/${edge}/${pointerType}: pointer capture lost`);
  assertFiniteDrawing(d, `${tool}/${edge}/${pointerType}`);
  assert.notStrictEqual(JSON.stringify(d.points), before, `${tool}/${edge}/${pointerType}: geometry did not move`);
  send(windowTarget, "pointerup", target.x, target.y, 6120 + serial * 10, pointerType, pointerId);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.SELECTED, `${tool}/${edge}/${pointerType}: did not finish SELECTED`);
}

// TEST 5 — all 34 tools use the same boundary-safe body translation. Every
// edge is covered on touch; right-edge ownership is also verified for mouse
// and stylus/pen so there is no platform-specific geometry path.
{
  let serial = 0;
  for (const tool of persistentTools) {
    for (const edge of ["right", "left", "top", "bottom"]) runBoundaryBodyCase(tool, edge, "touch", serial++);
    for (const pointerType of ["mouse", "pen"]) runBoundaryBodyCase(tool, "right", pointerType, serial++);
  }
}

// TEST 6 — Trend Line anchors may both be outside while the segment crosses the viewport.
{
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing("trend_line", [
    { time: 1060, price: 180 }, // x=-200
    { time: 1420, price: 220 }, // x=1000
  ]);
  const op = renderOps(env).find((item) => item.kind === "segment" && item.d.id === d.id);
  assert.ok(op, "Trend Line crossing viewport was dropped because anchors are outside");
  assertFiniteDrawing(d, "Trend Line outside anchors");
}

// TEST 7 — Extended Line is clipped mathematically, not by anchor visibility
// or a fixed arbitrary extension length. Both anchors are left of the pane.
{
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing("extended_line", [
    { time: 1000, price: 220 },
    { time: 1060, price: 210 },
  ]);
  const op = renderOps(env).find((item) => item.kind === "segment" && item.d.id === d.id);
  assert.ok(op, "Extended Line with offscreen anchors did not intersect-render");
  for (const value of [op.x1, op.y1, op.x2, op.y2]) assert.ok(Number.isFinite(value));
  assert.ok(op.x1 >= 0 && op.x1 <= env.container.clientWidth);
  assert.ok(op.x2 >= 0 && op.x2 <= env.container.clientWidth);
  assert.ok(op.y1 >= 0 && op.y1 <= env.container.clientHeight);
  assert.ok(op.y2 >= 0 && op.y2 <= env.container.clientHeight);
}

// Ray uses the same viewport intersection helper.
{
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing("ray", [
    { time: 1000, price: 220 },
    { time: 1060, price: 210 },
  ]);
  assert.ok(renderOps(env).some((item) => item.kind === "segment" && item.d.id === d.id));
}

// TEST 8/9 — axis-specific infinite lines preserve their semantic axis at boundaries.
for (const tool of ["horizontal_line", "vertical_line"]) {
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing(tool, boundaryPointsFor(tool));
  const before = JSON.parse(JSON.stringify(d.points[0]));
  const start = findBodyPoint(env, d, "touch");
  const target = tool === "horizontal_line" ? { x: 850, y: start.y - 40 } : { x: -50, y: start.y + 40 };
  send(env.container, "pointerdown", start.x, start.y, 9000, "touch", 900);
  send(windowTarget, "pointermove", target.x, target.y, 9080, "touch", 900);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT);
  assertFiniteDrawing(d, `${tool} boundary`);
  if (tool === "horizontal_line") assert.strictEqual(d.points[0].time, before.time);
  else assert.strictEqual(d.points[0].price, before.price);
  send(windowTarget, "pointerup", target.x, target.y, 9120, "touch", 900);
}

// TEST 10/11/12/13 — named complex-tool regressions beyond the all-tools matrix.
for (const tool of ["polyline", "fib_retracement", "fib_extension", "text", "note", "long_position", "short_position", "circle"]) {
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing(tool, boundaryPointsFor(tool));
  const start = findBodyPoint(env, d, "touch");
  send(env.container, "pointerdown", start.x, start.y, 9200, "touch", 920 + allTools.indexOf(tool));
  send(windowTarget, "pointermove", 850, start.y + 25, 9280, "touch", 920 + allTools.indexOf(tool));
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT, `${tool}: named boundary regression`);
  assertFiniteDrawing(d, `${tool}: named boundary regression`);
  send(windowTarget, "pointerup", 850, start.y + 25, 9320, "touch", 920 + allTools.indexOf(tool));
}

// TEST 14 — an empty-chart pointer that leaves the pane is never claimed by DrawingManager.
{
  const env = makeBoundaryManager();
  const down = send(env.container, "pointerdown", 700, 350, 9400, "touch", 940);
  const move = send(windowTarget, "pointermove", 850, 430, 9480, "touch", 940);
  const up = send(windowTarget, "pointerup", 850, 430, 9520, "touch", 940);
  assert.strictEqual(down.defaultPrevented, false);
  assert.strictEqual(move.defaultPrevented, false);
  assert.strictEqual(up.defaultPrevented, false);
  assert.strictEqual(env.manager._pointerSession, null);
  assert.strictEqual(env.container.captured.size, 0);
}

// TEST 15 — pointercancel outside is a real cancel and rolls back; pointerleave alone is not.
{
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing("rectangle", boundaryPointsFor("rectangle"));
  const before = JSON.stringify(d.points);
  const start = findBodyPoint(env, d, "touch");
  send(env.container, "pointerdown", start.x, start.y, 9600, "touch", 960);
  send(windowTarget, "pointermove", 780, start.y + 20, 9680, "touch", 960);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT);
  env.container.dispatch("pointerleave", { pointerId: 960, pointerType: "touch" });
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT, "pointerleave canceled drag");
  assert.ok(env.container.captured.has(960));
  send(windowTarget, "pointermove", 850, start.y + 20, 9700, "touch", 960);
  assertFiniteDrawing(d, "pointerleave continuation");
  send(windowTarget, "pointercancel", 850, start.y + 20, 9720, "touch", 960);
  assert.strictEqual(JSON.stringify(d.points), before);
  assert.strictEqual(env.container.captured.size, 0);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.SELECTED);
}

// Invalid transient coordinates skip only that preview frame; they never write
// NaN/null/undefined into model geometry or terminate an existing drag.
{
  const env = makeBoundaryManager();
  const d = env.manager.addDrawing("rectangle", boundaryPointsFor("rectangle"));
  const start = findBodyPoint(env, d, "touch");
  send(env.container, "pointerdown", start.x, start.y, 9800, "touch", 980);
  send(windowTarget, "pointermove", 760, start.y + 20, 9880, "touch", 980);
  const lastValid = JSON.stringify(d.points);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT);
  send(windowTarget, "pointermove", NaN, NaN, 9900, "touch", 980);
  assert.strictEqual(JSON.stringify(d.points), lastValid);
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT);
  assertFiniteDrawing(d, "invalid transient frame");
  send(windowTarget, "pointerup", 760, start.y + 20, 9920, "touch", 980);
}

// TEST 16 — multi-tile isolation: A can own an outside boundary drag while B
// remains navigation-capable and completely unchanged.
{
  const a = makeBoundaryManager();
  const b = makeBoundaryManager();
  const ad = a.manager.addDrawing("rectangle", boundaryPointsFor("rectangle"));
  const bd = b.manager.addDrawing("trend_line", boundaryPointsFor("trend_line"));
  b.manager.select(null);
  const bBefore = JSON.stringify(bd.points);
  const start = findBodyPoint(a, ad, "touch");
  send(a.container, "pointerdown", start.x, start.y, 10000, "touch", 1000);
  send(windowTarget, "pointermove", 850, start.y + 20, 10080, "touch", 1000);
  assert.strictEqual(a.manager.interactionState, INTERACTION_STATES.DRAG_OBJECT);
  assert.strictEqual(b.manager._pointerSession, null);
  assert.strictEqual(JSON.stringify(bd.points), bBefore);
  assert.strictEqual(b.manager._ownedTouchIds.size, 0);
  send(windowTarget, "pointerup", 850, start.y + 20, 10120, "touch", 1000);
  assert.strictEqual(a.manager.interactionState, INTERACTION_STATES.SELECTED);
}

console.log("chart drawing runtime tests: PASS");
