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

const { DrawingManager, TOOL_DEFS, INTERACTION_STATES, TEXT_ANNOTATION_TYPES } = windowTarget.ChartEngine.Drawings;

function makeManager() {
  const container = new FakeTarget();
  const navigationOptions = [];
  const visibleRangeCalls = [];
  const timeScale = {
    coordinateToTime: (x) => x,
    timeToCoordinate: (time) => time,
    setVisibleRange: (range) => visibleRangeCalls.push(range),
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
  return { manager, container, chart, navigationOptions, visibleRangeCalls };
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
  if (TEXT_ANNOTATION_TYPES.has(drawing.type)) {
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
  "path", "curve", "arc", "double_curve",
  "fib_time_zone", "fib_speed_resistance_fan", "fib_circles", "fib_arcs",
  "fib_channel", "fib_wedge", "trend_based_fib_time", "fib_pitchfan", "fib_spiral",
  "volume_profile", "trend_angle", "regression_trend", "flat_top_bottom", "disjoint_channel",
  "anchored_text", "price_note", "callout", "comment", "price_label", "signpost", "zoom_area",
];
assert.deepStrictEqual(Object.keys(TOOL_DEFS).sort(), allTools.slice().sort());
// "measure" and "zoom_area" are the two ephemeral tools - neither ever
// becomes a real entry in env.manager.drawings (see their own dedicated
// tests below), so every loop below that does env.manager.addDrawing(tool,
// ...) to exercise persisted-object editing/hit-testing/boundary behavior
// must skip both. "anchored_vwap" "volume_profile" and "regression_trend"
// are skipped for a different reason: all three are computed from
// core.candles (empty in makeManager's identity-conversion fake
// environment) rather than fixed geometry, so they have no hittable "body"
// distinct from their handles the way every other tool's fixed geometry
// does - findBodyPoint() would spin forever looking for one. All three get
// their own dedicated test with real candle data below instead.
const persistentTools = allTools.filter((tool) => tool !== "measure" && tool !== "zoom_area" && tool !== "anchored_vwap" && tool !== "volume_profile" && tool !== "regression_trend");
for (const tool of allTools) {
  assert.ok(TOOL_DEFS[tool].creationGesture, `${tool} missing creationGesture`);
  assert.ok(TOOL_DEFS[tool].completion, `${tool} missing completion`);
  assert.ok("anchorCount" in TOOL_DEFS[tool], `${tool} missing anchorCount`);
}
assert.strictEqual(TOOL_DEFS.circle.semanticShape, "ellipse");
assert.strictEqual(TOOL_DEFS.circle.label, "Эллипс");
assert.strictEqual(TOOL_DEFS.measure.ephemeral, true);
assert.strictEqual(TOOL_DEFS.zoom_area.ephemeral, true);

// Fixed two-point tools: first touch-drag-release is a complete object.
for (const pointerType of ["touch", "mouse", "pen"]) {
  for (const tool of [
    "trend_line", "ray", "extended_line", "fib_retracement", "rectangle",
    "circle", "price_range", "time_range", "long_position", "short_position",
    "price_date_range", "gann_fan", "cyclic_lines", "sine_line", "arrow",
    "volume_profile",
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

// Path/Curve/Arc/Double Curve: each gets the render op kind its own
// TOOL_DEFS comment promises - "path" reuses polyline's raw-segment op,
// "curve"/"arc"/"double_curve" get the shared oversampled "bezier" op kind
// (quadraticBezierSamples/arcSamples/cubicBezierSamples respectively).
{
  const env = makeManager();
  const kindFor = { path: "polyline", curve: "bezier", arc: "bezier", double_curve: "bezier" };
  for (const tool of ["path", "curve", "arc", "double_curve"]) {
    const d = env.manager.addDrawing(tool, pointsFor(tool));
    const ops = renderOps(env);
    const op = ops.find((o) => o.d && o.d.id === d.id);
    assert.ok(op, `${tool}: no render op produced`);
    assert.strictEqual(op.kind, kindFor[tool], `${tool}: unexpected render op kind`);
    assert.ok(op.points.length >= 2, `${tool}: expected a sampled/raw point list, got ${op.points.length}`);
    for (const p of op.points) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${tool}: non-finite sample point`);
    }
  }
}

// Arc: 3 (near-)collinear anchors have no finite circumcircle - must fall
// back to the straight anchor0->anchor1 segment instead of crashing or
// producing a bogus/huge arc.
{
  const env = makeManager();
  const d = env.manager.addDrawing("arc", [{ time: 40, price: 100 }, { time: 100, price: 130 }, { time: 160, price: 160 }]);
  const ops = renderOps(env);
  const op = ops.find((o) => o.d && o.d.id === d.id);
  assert.ok(op, "arc: no render op produced for collinear anchors");
  assert.strictEqual(op.points.length, 2, "arc: collinear anchors should fall back to a straight 2-point segment");
  for (const p of op.points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "arc: non-finite fallback point");
}

// Fibonacci family part 1: Fib Time Zone/Speed Resistance Fan/Circles/Arcs
// each get the render op kind their own TOOL_DEFS comment promises -
// fib_speed_resistance_fan literally reuses gann_fan's op shape, the other
// three get their own kind.
{
  const env = makeManager();
  const kindFor = { fib_time_zone: "fib_time_zone", fib_speed_resistance_fan: "gann_fan", fib_circles: "fib_circles", fib_arcs: "fib_arcs" };
  for (const tool of ["fib_time_zone", "fib_speed_resistance_fan", "fib_circles", "fib_arcs"]) {
    const d = env.manager.addDrawing(tool, pointsFor(tool));
    const ops = renderOps(env);
    const op = ops.find((o) => o.d && o.d.id === d.id);
    assert.ok(op, `${tool}: no render op produced`);
    assert.strictEqual(op.kind, kindFor[tool], `${tool}: unexpected render op kind`);
  }
}

// Fib Circles: concentric rings centered at anchor0, radii strictly
// increasing with FIB_CIRCLE_LEVELS (each ratio of the anchor0->anchor1
// pixel distance) - not just "some rings", the actual nesting order.
{
  const env = makeManager();
  const d = env.manager.addDrawing("fib_circles", [{ time: 40, price: 100 }, { time: 160, price: 220 }]);
  const ops = renderOps(env);
  const op = ops.find((o) => o.d && o.d.id === d.id);
  assert.ok(op.rings.length >= 6, `fib_circles: expected several rings, got ${op.rings.length}`);
  for (let i = 1; i < op.rings.length; i++) {
    assert.ok(op.rings[i].radius > op.rings[i - 1].radius, "fib_circles: ring radii should strictly increase with level");
  }
  assert.deepStrictEqual({ x: op.cx, y: op.cy }, { x: 40, y: 100 }, "fib_circles: center should be anchor0's own pixel (identity-conversion fake environment maps time/price 1:1 to x/y)");
}

// Fib Arcs: half-circle, not a full ring - each arc's first and last
// sample point must be distinct and roughly equidistant from anchor1 (the
// arc's own center), unlike a closed circle whose "ends" would coincide.
{
  const env = makeManager();
  const d = env.manager.addDrawing("fib_arcs", [{ time: 40, price: 100 }, { time: 160, price: 220 }]);
  const ops = renderOps(env);
  const op = ops.find((o) => o.d && o.d.id === d.id);
  assert.ok(op.arcs.length >= 6, `fib_arcs: expected several arcs, got ${op.arcs.length}`);
  const center = { x: 160, y: 220 }; // anchor1, identity-conversion fake environment
  for (const arc of op.arcs) {
    const start = arc.points[0], end = arc.points[arc.points.length - 1];
    assert.notDeepStrictEqual(start, end, "fib_arcs: a half-circle's two ends must not coincide");
    const rStart = Math.hypot(start.x - center.x, start.y - center.y);
    const rEnd = Math.hypot(end.x - center.x, end.y - center.y);
    assert.ok(Math.abs(rStart - rEnd) < 1e-6, "fib_arcs: both ends should sit on the same radius from anchor1");
  }
}

// Fib Channel: level 0 must coincide with anchor0->anchor1 exactly, and
// level 1's line must pass through anchor2 at anchor2's own time - not
// just "some segments", the actual channel geometry parallel_channel's
// own offset math promises.
{
  const env = makeManager();
  const d = env.manager.addDrawing("fib_channel", [{ time: 40, price: 100 }, { time: 160, price: 180 }, { time: 100, price: 230 }]);
  const ops = renderOps(env);
  const op = ops.find((o) => o.d && o.d.id === d.id);
  assert.strictEqual(op.kind, "fib_channel", "fib_channel: unexpected render op kind");
  assert.strictEqual(op.segments.length, 7, "fib_channel: expected one segment per FIB_RETRACEMENT_LEVELS entry");
  const level0 = op.segments.find((s) => s.level === 0);
  assert.deepStrictEqual({ x1: level0.x1, y1: level0.y1, x2: level0.x2, y2: level0.y2 }, { x1: 40, y1: 100, x2: 160, y2: 180 }, "fib_channel: level 0 should coincide with anchor0->anchor1");
  const level1 = op.segments.find((s) => s.level === 1);
  const frac = (100 - level1.x1) / (level1.x2 - level1.x1);
  const priceAtAnchor2Time = level1.y1 + (level1.y2 - level1.y1) * frac;
  assert.ok(Math.abs(priceAtAnchor2Time - 230) < 1e-9, "fib_channel: level 1 line should pass through anchor2");
}

// Fib Wedge: level 0 is skipped (degenerates to the vertex point), and
// level 1's connecting segment must land exactly on anchor1/anchor2 - the
// wedge closes to the full anchor1->anchor2 span at its outermost level.
{
  const env = makeManager();
  const d = env.manager.addDrawing("fib_wedge", [{ time: 40, price: 100 }, { time: 160, price: 180 }, { time: 100, price: 230 }]);
  const ops = renderOps(env);
  const op = ops.find((o) => o.d && o.d.id === d.id);
  assert.strictEqual(op.kind, "fib_wedge", "fib_wedge: unexpected render op kind");
  assert.strictEqual(op.segments.length, 6, "fib_wedge: level 0 should be skipped (degenerates to the vertex point)");
  const level1 = op.segments.find((s) => s.level === 1);
  assert.deepStrictEqual({ x1: level1.x1, y1: level1.y1, x2: level1.x2, y2: level1.y2 }, { x1: 160, y1: 180, x2: 100, y2: 230 }, "fib_wedge: level 1 segment should connect anchor1 to anchor2 exactly");
  assert.deepStrictEqual({ x1: op.edge1.x1, y1: op.edge1.y1, x2: op.edge1.x2, y2: op.edge1.y2 }, { x1: 40, y1: 100, x2: 160, y2: 180 }, "fib_wedge: edge1 should be anchor0->anchor1");
  assert.deepStrictEqual({ x1: op.edge2.x1, y1: op.edge2.y1, x2: op.edge2.x2, y2: op.edge2.y2 }, { x1: 40, y1: 100, x2: 100, y2: 230 }, "fib_wedge: edge2 should be anchor0->anchor2");
}

// Trend Angle: the label carries the on-screen slope in degrees, computed
// straight from the two anchors' pixel projection (identity-conversion
// fake environment, so pixel == {time,price} here) - dx=120, dy=80,
// angle = -atan2(80,120) in degrees.
{
  const env = makeManager();
  env.manager.addDrawing("trend_angle", [{ time: 40, price: 100 }, { time: 160, price: 180 }]);
  const op = renderOps(env).find((o) => o.kind === "trend_angle");
  assert.ok(op, "trend_angle: no render op produced");
  assert.deepStrictEqual({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }, { x1: 40, y1: 100, x2: 160, y2: 180 });
  const expectedAngle = -(Math.atan2(80, 120) * 180) / Math.PI;
  assert.ok(Math.abs(op.angle - expectedAngle) < 1e-9, `trend_angle: angle off (${op.angle} vs ${expectedAngle})`);
}

// Flat Top/Bottom: the slanted edge is anchor0->anchor1 exactly (same as
// parallel_channel's own first edge); the flat edge holds anchor2's price
// constant across anchor0.time/anchor1.time - not a parallel offset, a
// literal horizontal line, unlike parallel_channel's own second edge.
{
  const env = makeManager();
  env.manager.addDrawing("flat_top_bottom", [{ time: 40, price: 100 }, { time: 160, price: 180 }, { time: 100, price: 230 }]);
  const op = renderOps(env).find((o) => o.kind === "channel");
  assert.ok(op, "flat_top_bottom: no render op produced");
  assert.deepStrictEqual({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }, { x1: 40, y1: 100, x2: 160, y2: 180 }, "flat_top_bottom: slanted edge should be anchor0->anchor1 exactly");
  assert.deepStrictEqual({ x1: op.ox1, y1: op.oy1, x2: op.ox2, y2: op.oy2 }, { x1: 40, y1: 230, x2: 160, y2: 230 }, "flat_top_bottom: flat edge should hold anchor2's price at both anchor0/anchor1 times");
  assert.strictEqual(op.handles.length, 3);
}

// Disjoint Channel: both segments are drawn exactly as their own 2 anchors
// - unlike parallel_channel/flat_top_bottom, line2 is NOT derived from
// line1 at all (no parallel offset, no flat-price projection), so this
// locks down that the render path passes anchor2/anchor3 straight through.
{
  const env = makeManager();
  const d = env.manager.addDrawing("disjoint_channel", [{ time: 20, price: 80 }, { time: 60, price: 200 }, { time: 100, price: 120 }, { time: 140, price: 220 }]);
  const op = renderOps(env).find((o) => o.kind === "channel");
  assert.ok(op, "disjoint_channel: no render op produced");
  assert.deepStrictEqual({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }, { x1: 20, y1: 80, x2: 60, y2: 200 }, "disjoint_channel: line1 should be anchor0->anchor1");
  assert.deepStrictEqual({ x1: op.ox1, y1: op.oy1, x2: op.ox2, y2: op.oy2 }, { x1: 100, y1: 120, x2: 140, y2: 220 }, "disjoint_channel: line2 should be anchor2->anchor3, independent of line1");
  assert.strictEqual(op.handles.length, 4);
  assert.strictEqual(d.points.length, 4);
}

// Text annotation family (ТЗ "Text, Anchored Text, Note, Price Note,
// Callout, Comment, Price Label, Signpost") - 6 new 1-anchor types beyond
// text/note, each locked to its own distinguishing render op field:
// anchored_text carries the pane height (its leader line's far end),
// price_note/price_label carry the pane width (their leader/chip's far
// edge) - both computed once by _buildOp, not something the paint step
// has to re-derive.
{
  const env = makeManager();
  const paneW = 800, paneH = 400; // makeManager()'s FakeTarget clientWidth/clientHeight, no gutter/time-axis mocked

  const dAnchoredText = env.manager.addDrawing("anchored_text", [{ time: 40, price: 100 }]);
  const opAnchoredText = renderOps(env).find((o) => o.kind === "anchored_text");
  assert.ok(opAnchoredText, "anchored_text: no render op produced");
  assert.strictEqual(opAnchoredText.x, 40);
  assert.strictEqual(opAnchoredText.y, 100);
  assert.strictEqual(opAnchoredText.h, paneH, "anchored_text: leader line should reach the pane height");

  const dPriceNote = env.manager.addDrawing("price_note", [{ time: 40, price: 100 }]);
  const opPriceNote = renderOps(env).find((o) => o.kind === "price_note");
  assert.ok(opPriceNote, "price_note: no render op produced");
  assert.strictEqual(opPriceNote.w, paneW, "price_note: leader line should reach the pane width (price axis)");
  assert.strictEqual(opPriceNote.d.points[0].price, 100, "price_note: price label should read the anchor's own price");

  env.manager.addDrawing("callout", [{ time: 40, price: 100 }]);
  const opCallout = renderOps(env).find((o) => o.kind === "callout");
  assert.ok(opCallout, "callout: no render op produced");

  env.manager.addDrawing("comment", [{ time: 40, price: 100 }]);
  const opComment = renderOps(env).find((o) => o.kind === "comment");
  assert.ok(opComment, "comment: no render op produced");

  const dPriceLabel = env.manager.addDrawing("price_label", [{ time: 40, price: 100 }]);
  const opPriceLabel = renderOps(env).find((o) => o.kind === "price_label");
  assert.ok(opPriceLabel, "price_label: no render op produced");
  assert.strictEqual(opPriceLabel.w, paneW, "price_label: chip should be positioned relative to the pane width (price axis)");
  assert.strictEqual(opPriceLabel.x, 40, "price_label: drag handle should stay at the literal anchor, not the chip");
  assert.strictEqual(TOOL_DEFS.price_label.editAxis, "price", "price_label: whole-object drag should only move price, like horizontal_line");

  env.manager.addDrawing("signpost", [{ time: 40, price: 100 }]);
  const opSignpost = renderOps(env).find((o) => o.kind === "signpost");
  assert.ok(opSignpost, "signpost: no render op produced");

  // Every one of the 8 text-annotation types shares the same creation-time
  // text prompt, editing UX, and box-based hit-test (see TEXT_ANNOTATION_TYPES
  // in drawings.js) - a fresh drawing of each should already carry the
  // per-type default text defaultProperties() gives it.
  assert.strictEqual(dAnchoredText.properties.text, "Заметка");
  assert.strictEqual(dPriceNote.properties.text, "Заметка");
  assert.strictEqual(dPriceLabel.properties.text, "Метка");
}

// Trend-Based Fib Time: zones must project from anchor1 (the trend's end),
// not anchor0 - the one thing distinguishing it from fib_time_zone, whose
// render op kind it otherwise reuses unchanged.
{
  const env = makeManager();
  const d = env.manager.addDrawing("trend_based_fib_time", [{ time: 40, price: 100 }, { time: 160, price: 180 }]);
  const ops = renderOps(env);
  const op = ops.find((o) => o.d && o.d.id === d.id);
  assert.strictEqual(op.kind, "fib_time_zone", "trend_based_fib_time: should reuse fib_time_zone's render op kind");
  const zone0 = op.marks.find((m) => m.label === "0");
  assert.ok(zone0, "trend_based_fib_time: expected a zone-0 mark");
  assert.strictEqual(zone0.x, 160, "trend_based_fib_time: zone 0 should sit at anchor1 (the trend's end), not anchor0");
  const zone1 = op.marks.find((m) => m.label === "1");
  assert.ok(zone1, "trend_based_fib_time: expected a zone-1 mark");
  assert.strictEqual(zone1.x, 280, "trend_based_fib_time: zone 1 should be one interval past anchor1");
}

// Fib Pitchfan: every ray must originate exactly at anchor0 (the handle),
// and the 50% ray must be collinear with midpoint(anchor1, anchor2) - the
// same point the standard pitchfork's own median aims at - and marked
// major, exactly like gann_fan's own 1x1 ray convention it reuses.
{
  const env = makeManager();
  const d = env.manager.addDrawing("fib_pitchfan", [{ time: 0, price: 0 }, { time: 100, price: 0 }, { time: 100, price: 200 }]);
  const ops = renderOps(env);
  const op = ops.find((o) => o.d && o.d.id === d.id);
  assert.strictEqual(op.kind, "gann_fan", "fib_pitchfan: should reuse gann_fan's render op kind");
  assert.strictEqual(op.segments.length, 7, "fib_pitchfan: expected one segment per FIB_PITCHFAN_RATIOS entry");
  op.segments.forEach((seg) => {
    assert.strictEqual(seg.x1, 0, "fib_pitchfan: every ray should originate at anchor0 (x)");
    assert.strictEqual(seg.y1, 0, "fib_pitchfan: every ray should originate at anchor0 (y)");
  });
  const midSeg = op.segments.find((s) => s.label === "50.0%");
  assert.ok(midSeg, "fib_pitchfan: expected a 50.0% ray");
  assert.ok(midSeg.major, "fib_pitchfan: the 50.0% ray should be marked major (matches the standard pitchfork's median)");
  const cross = (midSeg.x2 - midSeg.x1) * (100 - midSeg.y1) - (midSeg.y2 - midSeg.y1) * (100 - midSeg.x1);
  assert.ok(Math.abs(cross) < 1e-6, "fib_pitchfan: 50.0% ray should pass through midpoint(anchor1, anchor2)");
}

// Fib Spiral: the first sample must land exactly on anchor1 (the starting
// radius/angle), and after exactly one quarter turn the radius must have
// grown by precisely the golden ratio - the defining property of a golden
// spiral, not just "some curve that looks spiral-ish".
{
  const env = makeManager();
  const d = env.manager.addDrawing("fib_spiral", [{ time: 200, price: 200 }, { time: 300, price: 200 }]);
  const ops = renderOps(env);
  const op = ops.find((o) => o.d && o.d.id === d.id);
  assert.strictEqual(op.kind, "fib_spiral", "fib_spiral: unexpected render op kind");
  const samplesPerTurn = 48, turns = 3;
  assert.strictEqual(op.samples.length, turns * samplesPerTurn + 1, "fib_spiral: unexpected sample count");
  assert.ok(Math.abs(op.samples[0].x - 300) < 1e-9 && Math.abs(op.samples[0].y - 200) < 1e-9, "fib_spiral: first sample should land exactly on anchor1");
  const quarterTurn = op.samples[samplesPerTurn / 4];
  const goldenRatio = (1 + Math.sqrt(5)) / 2;
  assert.ok(Math.abs(quarterTurn.x - 200) < 1e-9, "fib_spiral: after a quarter turn, x should return to the center");
  assert.ok(Math.abs(quarterTurn.y - (200 + 100 * goldenRatio)) < 1e-9, "fib_spiral: after a quarter turn, radius should have grown by exactly the golden ratio");
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

// Regression Trend: like anchored_vwap/volume_profile, a computed line
// (OLS regression of candle closes in [anchor0.time, anchor1.time]) plus
// deviation bands rather than fixed geometry - needs real candle data.
// candles: (100,close=10), (160,close=12), (220,close=17) - deliberately
// NOT collinear, so both the regression slope/intercept and the deviation
// (stddev) are exercised, not just the trivial zero-residual case.
// By hand: sumX=480 sumY=39 sumXY=6660 sumXX=84000, n=3
// denom = 3*84000 - 480^2 = 21600
// slope = (3*6660 - 480*39) / 21600 = 1260/21600 = 0.058333...
// intercept = (39 - slope*480) / 3 = 11/3 = 3.666666...
// mid@100 = 9.5, mid@220 = 16.5 (predicted); residuals vs actual closes:
// 10-9.5=0.5, 12-13=-1, 17-16.5=0.5 -> sumSqResid=1.5 -> variance=0.5 ->
// stddev=sqrt(0.5)=0.7071067811865476 -> offset = 2*stddev = 1.4142135624
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
    { time: 100, open: 9, high: 11, low: 9, close: 10, volume: 100 },
    { time: 160, open: 10, high: 13, low: 10, close: 12, volume: 100 },
    { time: 220, open: 12, high: 18, low: 12, close: 17, volume: 100 },
  ];
  const core = { container, chart, candleSeries: series, candles };
  const manager = new DrawingManager(core);
  const env = { manager, container };

  manager.setTool("regression_trend");
  drag(env, 100, 9, 220, 17, 1000);
  assert.strictEqual(manager.drawings.length, 1, "regression_trend did not commit");
  const drawing = manager.drawings[0];

  const op = renderOps(env).find((o) => o.kind === "regression_trend");
  assert.ok(op, "regression_trend: no render op produced");
  assert.strictEqual(op.mid.length, 2);
  assert.ok(Math.abs(op.mid[0].y - 9.5) < 1e-9, `regression_trend: mid@t0 off (${op.mid[0].y})`);
  assert.ok(Math.abs(op.mid[1].y - 16.5) < 1e-9, `regression_trend: mid@t1 off (${op.mid[1].y})`);
  const offset = 2 * Math.sqrt(0.5);
  assert.ok(Math.abs(op.upper[0].y - (9.5 + offset)) < 1e-9, `regression_trend: upper@t0 off (${op.upper[0].y})`);
  assert.ok(Math.abs(op.upper[1].y - (16.5 + offset)) < 1e-9, `regression_trend: upper@t1 off (${op.upper[1].y})`);
  assert.ok(Math.abs(op.lower[0].y - (9.5 - offset)) < 1e-9, `regression_trend: lower@t0 off (${op.lower[0].y})`);
  assert.ok(Math.abs(op.lower[1].y - (16.5 - offset)) < 1e-9, `regression_trend: lower@t1 off (${op.lower[1].y})`);

  // Hit-testing: an anchor handle, and a point along the computed mid
  // line (not one of the raw anchor/candle points) both resolve here.
  const handleHit = manager.hitTest(100, 9, { pointerType: "mouse" });
  assert.strictEqual(handleHit && handleHit.handle, 0, "regression_trend: handle hit-test failed");
  manager.select(drawing.id);
  const midX = (op.mid[0].x + op.mid[1].x) / 2, midY = (op.mid[0].y + op.mid[1].y) / 2;
  const bodyHit = manager.hitTest(midX, midY, { pointerType: "mouse" });
  assert.ok(bodyHit && bodyHit.id === drawing.id && bodyHit.handle == null, "regression_trend: body hit-test failed along the computed mid line");

  // Fewer than 2 candles in the anchored range must not crash and must not
  // render a body - same "no data, no body" contract anchored_vwap uses
  // for an anchor placed past the last candle.
  const singleCandleEnv = { manager: new DrawingManager({ container: new FakeTarget(), chart, candleSeries: series, candles: [candles[0]] }), container };
  singleCandleEnv.manager.setTool("regression_trend");
  drag(singleCandleEnv, 100, 9, 220, 17, 2000);
  assert.doesNotThrow(() => renderOps(singleCandleEnv), "regression_trend: render must not throw with under 2 candles in range");
  assert.strictEqual(renderOps(singleCandleEnv).some((o) => o.kind === "regression_trend"), false, "regression_trend: no body should render with under 2 candles in range");
}

// Regression Trend with zero candles (every other tool's makeManager()
// fake environment) must not throw either - just render nothing.
{
  const env = makeManager();
  env.manager.setTool("regression_trend");
  drag(env, 40, 100, 160, 180, 1000);
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.doesNotThrow(() => renderOps(env), "regression_trend: render must not throw with zero candles");
}

// Volume Profile: like anchored_vwap, a computed histogram rather than
// fixed geometry - needs real candle+volume data. Candle price ranges are
// deliberately chosen to land exactly on VOLUME_PROFILE_ROWS(24) bucket
// boundaries (each candle spans exactly 8 of the 24 buckets) so every
// bucket's volume is hand-computable, not just "some plausible number".
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
    { time: 100, open: 10, high: 11, low: 10, close: 10.5, volume: 100 },
    { time: 160, open: 11, high: 12, low: 11, close: 11.5, volume: 200 },
    { time: 220, open: 12, high: 13, low: 12, close: 12.5, volume: 300 },
    // Decoy: way outside both the time range used below and the price
    // range of the other three - must not affect a single bucket.
    { time: 1000, open: 1000, high: 1001, low: 1000, close: 1000.5, volume: 99999 },
  ];
  const core = { container, chart, candleSeries: series, candles };
  const manager = new DrawingManager(core);
  const env = { manager, container };

  manager.setTool("volume_profile");
  const events = drag(env, 100, 10, 220, 13, 1000, "mouse");
  assert.ok(events.down.defaultPrevented, "volume_profile: drawing did not own pointerdown");
  assert.strictEqual(manager.drawings.length, 1, "volume_profile did not commit");
  const drawing = manager.drawings[0];
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points)),
    [{ time: 100, price: 10 }, { time: 220, price: 13 }],
  );

  const op = renderOps(env).find((o) => o.kind === "volume_profile");
  assert.ok(op, "volume_profile: no render op produced");
  assert.strictEqual(op.buckets.length, 24, "volume_profile: expected all 24 rows to project");
  const totalVolume = op.buckets.reduce((sum, b) => sum + b.volume, 0);
  assert.ok(Math.abs(totalVolume - 600) < 1e-6, `volume_profile: bucket volumes should sum to the 3 in-range candles' 600 total, got ${totalVolume}`);

  // candles[0] (10-11) owns buckets 0-7 at 100/8=12.5 each; candles[1]
  // (11-12) owns buckets 8-15 at 200/8=25 each; candles[2] (12-13) owns
  // buckets 16-23 at 300/8=37.5 each - the POC (max-volume row).
  assert.ok(Math.abs(op.buckets[0].volume - 12.5) < 1e-6, `volume_profile: bucket 0 should be 12.5, got ${op.buckets[0].volume}`);
  assert.ok(Math.abs(op.buckets[8].volume - 25) < 1e-6, `volume_profile: bucket 8 should be 25, got ${op.buckets[8].volume}`);
  assert.ok(Math.abs(op.buckets[23].volume - 37.5) < 1e-6, `volume_profile: bucket 23 should be 37.5, got ${op.buckets[23].volume}`);
  assert.strictEqual(op.buckets[23].isPoc, true, "volume_profile: bucket 23 (highest volume) should be the POC");
  assert.strictEqual(op.buckets[0].isPoc, false, "volume_profile: bucket 0 should not be the POC");
  assert.ok(Math.abs(op.maxVolume - 37.5) < 1e-6, `volume_profile: maxVolume should be 37.5, got ${op.maxVolume}`);
  // The decoy candle's [1000,1001] range must not have stretched the
  // profile's own price axis - the top bucket still ends at price 13.
  assert.ok(Math.abs(op.buckets[23].y1 - 13) < 1e-6, `volume_profile: top bucket edge should stay at 13, decoy candle leaked in (${op.buckets[23].y1})`);

  // Hit-testing: both anchor handles, and a point inside the box (bounding
  // box, not per-bar - any point between the anchors and within the
  // computed price range hits the drawing) resolve to this drawing.
  const handle0 = manager.hitTest(100, 10, { pointerType: "mouse" });
  assert.strictEqual(handle0 && handle0.handle, 0, "volume_profile: handle 0 hit-test failed");
  const handle1 = manager.hitTest(220, 13, { pointerType: "mouse" });
  assert.strictEqual(handle1 && handle1.handle, 1, "volume_profile: handle 1 hit-test failed");
  manager.select(drawing.id);
  const bodyHit = manager.hitTest(160, 12.5, { pointerType: "mouse" });
  assert.ok(bodyHit && bodyHit.id === drawing.id && bodyHit.handle == null, "volume_profile: body (box) hit-test failed");

  // A time range with no candles inside at all must not crash and must not
  // render a body - only the two handles remain hittable.
  const emptyEnv = { manager, container };
  manager.removeDrawing(drawing.id);
  manager.setTool("volume_profile");
  drag(emptyEnv, 500, 10, 600, 13, 2000, "mouse");
  assert.doesNotThrow(() => renderOps(emptyEnv), "volume_profile: render must not throw for a candle-less time range");
  assert.strictEqual(renderOps(emptyEnv).some((o) => o.kind === "volume_profile"), false, "volume_profile: no body should render for a candle-less time range");
}

// Volume Profile with zero candles (every other tool's makeManager() fake
// environment) must not throw either - just render nothing.
{
  const env = makeManager();
  env.manager.setTool("volume_profile");
  drag(env, 40, 50, 180, 160, 1000, "mouse");
  assert.strictEqual(env.manager.drawings.length, 1);
  assert.doesNotThrow(() => renderOps(env), "volume_profile: render must not throw with zero candles");
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

// Zoom tool (area-zoom): TradingView-style ephemeral "magnifier" -
// TOOL_DEFS.zoom_area. Same ephemeral lifecycle as measure above (no
// persistent drawing, re-arms itself), but release must additionally call
// chart.timeScale().setVisibleRange() with the exact (unpadded) time span
// of the dragged box - the fake timeScale's coordinateToTime is identity,
// so drag x-coordinates equal the resulting times one-to-one.
{
  const env = makeManager();
  env.manager.setTool("zoom_area");
  assert.strictEqual(env.manager.interactionState, INTERACTION_STATES.TOOL_ARMED);

  const down = send(env.container, "pointerdown", 40, 40, 1000);
  assert.ok(down.defaultPrevented, "zoom_area: drawing did not own pointerdown");
  send(windowTarget, "pointermove", 140, 120, 1040);
  const liveOp = renderOps(env).find((op) => op.kind === "zoom_area");
  assert.ok(liveOp, "zoom_area: no live preview box while dragging");
  assert.strictEqual(env.manager.drawings.length, 0, "zoom_area: must not persist mid-drag");
  assert.strictEqual(env.visibleRangeCalls.length, 0, "zoom_area: must not zoom before release");

  send(windowTarget, "pointerup", 140, 120, 1080);
  assert.strictEqual(env.manager.drawings.length, 0, "zoom_area: drag-release must not create a drawing");
  assert.strictEqual(env.manager.draft, null, "zoom_area: stale draft after release");
  assert.strictEqual(env.manager.activeTool, "zoom_area", "zoom_area: tool must re-arm itself for the next zoom");
  assert.strictEqual(renderOps(env).some((op) => op.kind === "zoom_area"), false, "zoom_area: overlay must disappear on release");
  assert.strictEqual(env.visibleRangeCalls.length, 1, "zoom_area: must call setVisibleRange exactly once on release");
  // The {from,to} object is built inside the vm sandbox running
  // drawings.js, a different JS realm than this test file's own object
  // literals - deepStrictEqual would fail on prototype identity alone even
  // with matching content (see [[feedback-...]] cross-realm lesson from a
  // prior session), so compare the two fields directly instead.
  assert.strictEqual(env.visibleRangeCalls[0].from, 40, "zoom_area: must zoom to exactly the dragged box's start time, no padding");
  assert.strictEqual(env.visibleRangeCalls[0].to, 140, "zoom_area: must zoom to exactly the dragged box's end time, no padding");

  // Reversed drag (right-to-left) still normalizes from < to.
  drag(env, 260, 200, 200, 60, 2000);
  assert.strictEqual(env.visibleRangeCalls[1].from, 200, "zoom_area: reversed drag must still normalize from<to (from)");
  assert.strictEqual(env.visibleRangeCalls[1].to, 260, "zoom_area: reversed drag must still normalize from<to (to)");
  assert.strictEqual(env.manager.activeTool, "zoom_area", "zoom_area: second drag must also stay ephemeral");

  // Degenerate box (both anchors land on the same time, e.g. a drag that
  // never actually moved) must not call setVisibleRange with a zero-width
  // range at all.
  drag(env, 400, 40, 400, 40, 3000);
  assert.strictEqual(env.visibleRangeCalls.length, 2, "zoom_area: degenerate zero-span box must not trigger a zoom");
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

// Multiselect (ТЗ "Multiselect (Ctrl/Cmd click), Grouping объектов"):
// select(id, {additive}) toggles a whole-set membership in/out instead of
// replacing it, and selectedId (the pre-multiselect single-selection
// compatibility accessor - see the DrawingManager constructor's own
// comment) keeps reading "the" id correctly whenever exactly one is
// selected, null when none are.
{
  const env = makeManager();
  const d1 = env.manager.addDrawing("trend_line", [{ time: 10, price: 10 }, { time: 50, price: 50 }]);
  const d2 = env.manager.addDrawing("trend_line", [{ time: 100, price: 100 }, { time: 150, price: 150 }]);
  env.manager.select(d1.id);
  assert.deepStrictEqual([...env.manager.selectedIds], [d1.id]);
  assert.strictEqual(env.manager.selectedId, d1.id);

  env.manager.select(d2.id, { additive: true });
  assert.deepStrictEqual([...env.manager.selectedIds].sort(), [d1.id, d2.id].sort(), "additive select should add, not replace");

  env.manager.select(d1.id, { additive: true });
  assert.deepStrictEqual([...env.manager.selectedIds], [d2.id], "additive select on an already-selected id should toggle it off");

  env.manager.select(d1.id);
  assert.deepStrictEqual([...env.manager.selectedIds], [d1.id], "a non-additive select should replace the whole selection");

  env.manager.select(null);
  assert.strictEqual(env.manager.selectedIds.size, 0);
  assert.strictEqual(env.manager.selectedId, null);
}

// Ctrl/Cmd-click through the real pointer pipeline (not calling select()
// directly) also adds to the selection instead of replacing it.
{
  const env = makeManager();
  const d1 = env.manager.addDrawing("horizontal_line", [{ time: 0, price: 40 }]);
  const d2 = env.manager.addDrawing("horizontal_line", [{ time: 0, price: 80 }]);
  env.manager.select(d1.id);
  env.container.dispatch("pointerdown", { clientX: 5, clientY: 80, timeStamp: 2000, pointerType: "mouse", pointerId: 1, ctrlKey: true });
  send(windowTarget, "pointerup", 5, 80, 2040, "mouse", 1);
  assert.deepStrictEqual([...env.manager.selectedIds].sort(), [d1.id, d2.id].sort(), "ctrl-click should add the clicked drawing to the existing selection");
}

// Grouping: groupSelection()/ungroupSelection(), and clicking any one
// member of a group selects the whole group (_selectionUnit) - the same
// TradingView behavior a plain click and an additive click both route
// through.
{
  const env = makeManager();
  const d1 = env.manager.addDrawing("trend_line", [{ time: 10, price: 10 }, { time: 50, price: 50 }]);
  const d2 = env.manager.addDrawing("trend_line", [{ time: 100, price: 100 }, { time: 150, price: 150 }]);
  const d3 = env.manager.addDrawing("trend_line", [{ time: 200, price: 200 }, { time: 250, price: 250 }]);

  env.manager.select(d3.id);
  env.manager.groupSelection();
  assert.strictEqual(d3.properties.groupId, undefined, "groupSelection with fewer than 2 selected must be a no-op");

  env.manager.select(null);
  env.manager.select(d1.id, { additive: true });
  env.manager.select(d2.id, { additive: true });
  env.manager.groupSelection();
  assert.ok(d1.properties.groupId, "groupSelection should assign a groupId to every selected drawing");
  assert.strictEqual(d1.properties.groupId, d2.properties.groupId, "grouped drawings should share one groupId");
  assert.ok(!d3.properties.groupId, "an ungrouped drawing outside the selection must not get a groupId");

  env.manager.select(d1.id);
  assert.deepStrictEqual([...env.manager.selectedIds].sort(), [d1.id, d2.id].sort(), "a plain click on one grouped member should select the whole group");

  env.manager.select(d2.id, { additive: true });
  assert.strictEqual(env.manager.selectedIds.size, 0, "additive-clicking a grouped member should toggle the whole group off together");

  env.manager.select(d1.id);
  env.manager.ungroupSelection();
  assert.ok(!d1.properties.groupId && !d2.properties.groupId, "ungroupSelection should clear groupId on every selected member");
  env.manager.select(d1.id);
  assert.deepStrictEqual([...env.manager.selectedIds], [d1.id], "an ungrouped drawing's click no longer pulls in its former group-mate");
}

// duplicateSelection(): copies every selected drawing, selects the new
// copies, and a duplicated group becomes its own new group rather than
// merging into the original (properties, groupId included, are copied
// verbatim by duplicateDrawing() - a naive loop would leave both the
// originals and the copies sharing one groupId).
{
  const env = makeManager();
  const d1 = env.manager.addDrawing("trend_line", [{ time: 10, price: 10 }, { time: 50, price: 50 }]);
  const d2 = env.manager.addDrawing("trend_line", [{ time: 100, price: 100 }, { time: 150, price: 150 }]);
  // addDrawing() auto-selects each new drawing as it's created (single-
  // select, replacing) - reset to no selection before building a fresh
  // multi-selection with additive calls, same as every other block here.
  env.manager.select(null);
  env.manager.select(d1.id, { additive: true });
  env.manager.select(d2.id, { additive: true });
  env.manager.groupSelection();
  const gidBefore = d1.properties.groupId;
  const countBefore = env.manager.drawings.length;

  const copies = env.manager.duplicateSelection();
  assert.strictEqual(copies.length, 2, "duplicateSelection should copy every selected drawing");
  assert.strictEqual(env.manager.drawings.length, countBefore + 2);
  // Array.from(), not copies.map() - copies is an array built inside the vm
  // sandbox (drawings.js runs there), so .map() on it returns another
  // vm-realm array via ArraySpeciesCreate; deepStrictEqual treats that as
  // unequal to an outer-realm array of the same content (different
  // Array.prototype). Array.from(copies, ...), called on the outer
  // identifier, always builds an outer-realm array regardless of the
  // input's realm.
  assert.deepStrictEqual([...env.manager.selectedIds].sort(), Array.from(copies, (c) => c.id).sort(), "duplicateSelection should select the new copies");
  const copyGid = copies[0].properties.groupId;
  assert.ok(copyGid, "duplicated group members should still be grouped");
  assert.notStrictEqual(copyGid, gidBefore, "a duplicated group must become its own new group");
  assert.strictEqual(copies[1].properties.groupId, copyGid, "both copies should share the new group id");
  assert.strictEqual(d1.properties.groupId, gidBefore, "the original group must be untouched by duplication");
  assert.strictEqual(d2.properties.groupId, gidBefore);
}

// Multi-object whole-drag moves every selected drawing together by the
// same delta; handle-drag (resize) stays single-object, and hitTest
// exposes no resize handles at all while more than one thing is selected
// (a multi-selection is whole-object-drag-only).
{
  const env = makeManager();
  const d1 = env.manager.addDrawing("trend_line", [{ time: 10, price: 10 }, { time: 50, price: 50 }]);
  const d2 = env.manager.addDrawing("trend_line", [{ time: 100, price: 100 }, { time: 150, price: 150 }]);
  env.manager.select(null);
  env.manager.select(d1.id, { additive: true });
  env.manager.select(d2.id, { additive: true });

  const handleHit = env.manager.hitTest(10, 10, { pointerType: "mouse" });
  assert.ok(handleHit && handleHit.id === d1.id && handleHit.handle == null, "no drawing should expose a resize handle while multiple are selected");

  const updates = [];
  env.manager.onChange((mgr, detail) => { if (detail.updated && detail.pointerDrag) updates.push(detail.updated); });
  const before1 = JSON.parse(JSON.stringify(d1.points));
  const before2 = JSON.parse(JSON.stringify(d2.points));
  const body = findBodyPoint(env, d1, "mouse");
  drag(env, body.x, body.y, body.x + 20, body.y + 15, 3000, "mouse");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(d1.points)),
    before1.map((p) => ({ time: p.time + 20, price: p.price + 15 })),
    "the dragged drawing itself should move by the drag delta",
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(d2.points)),
    before2.map((p) => ({ time: p.time + 20, price: p.price + 15 })),
    "every other selected drawing should move by the exact same delta",
  );
  assert.strictEqual(updates.length, 1, "group drag should persist once on pointerup, not per drawing");
  // Array.from(), not .slice() - same cross-realm reason as duplicateSelection's
  // assertion above: updates[0] (detail.updated) is `[...groupOrigPoints.keys()]`
  // built inside the vm sandbox, so .slice() on it stays vm-realm.
  assert.deepStrictEqual(Array.from(updates[0]).sort(), [d1.id, d2.id].sort(), "the persisted update should carry every moved drawing's id");
}

// Multi-delete/multi-duplicate/group/ungroup via keyboard (Delete,
// Ctrl+D, Ctrl+G, Ctrl+Shift+G) all operate on the whole selection, not
// just one drawing.
{
  const env = makeManager();
  env.manager._pointerInside = true;
  const d1 = env.manager.addDrawing("trend_line", [{ time: 10, price: 10 }, { time: 50, price: 50 }]);
  const d2 = env.manager.addDrawing("trend_line", [{ time: 100, price: 100 }, { time: 150, price: 150 }]);
  env.manager.select(null);
  env.manager.select(d1.id, { additive: true });
  env.manager.select(d2.id, { additive: true });

  env.container.dispatch("keydown", { key: "g", ctrlKey: true });
  assert.strictEqual(d1.properties.groupId, d2.properties.groupId, "Ctrl+G should group the selection");
  assert.ok(d1.properties.groupId);

  env.container.dispatch("keydown", { key: "d", ctrlKey: true });
  assert.strictEqual(env.manager.drawings.length, 4, "Ctrl+D should duplicate the whole selection");
  assert.strictEqual(env.manager.selectedIds.size, 2, "Ctrl+D should select the new copies");
  const copyIds = [...env.manager.selectedIds];
  assert.notStrictEqual(copyIds[0], d1.id);
  assert.notStrictEqual(copyIds[1], d2.id);

  env.container.dispatch("keydown", { key: "G", ctrlKey: true, shiftKey: true });
  for (const id of copyIds) {
    const d = env.manager.drawings.find((x) => x.id === id);
    assert.ok(!d.properties.groupId, "Ctrl+Shift+G should ungroup every selected drawing");
  }

  env.container.dispatch("keydown", { key: "Delete" });
  assert.strictEqual(env.manager.drawings.length, 2, "Delete should remove every selected drawing, not just one");
  assert.strictEqual(env.manager.selectedIds.size, 0);
}

console.log("chart drawing runtime tests: PASS");
