/* Drawing tools for the free-form "Анализ графиков" module: manager,
 * per-tool geometry/hit-testing, a single canvas primitive that renders
 * every drawing, and undo/redo history. Every drawing stores its anchors
 * as {time, price} - pixel coordinates are only ever computed for the
 * current viewport at render/hit-test time, never persisted (so panning
 * or zooming never invalidates a saved drawing).
 *
 * Persistence (autosave to /api/chart-layouts/*) lives in
 * chart-analysis.js, which listens to DrawingManager.onChange(). This
 * file has no network calls of its own. */
(function (global) {
  "use strict";

  const theme = global.ChartEngine.theme;
  const HIT_TOLERANCE_PX = 6;
  const HANDLE_RADIUS_PX = 5;
  // A finger is not a mouse cursor. Keep precise desktop hit-testing, but
  // give touch a TradingView-like forgiving corridor around thin drawings.
  const TOUCH_HIT_TOLERANCE_PX = 18;
  const TOUCH_HANDLE_HIT_RADIUS_PX = 14;
  const WEAK_MAGNET_SNAP_PX = 14;

  const INTERACTION_STATES = Object.freeze({
    NAVIGATE: "NAVIGATE",
    TOOL_ARMED: "TOOL_ARMED",
    PLACING: "PLACING",
    SELECTED: "SELECTED",
    DRAG_OBJECT: "DRAG_OBJECT",
    DRAG_HANDLE: "DRAG_HANDLE",
    TEXT_EDIT: "TEXT_EDIT",
  });
  const POINTER_DRAG_THRESHOLD_PX = 4;
  const TOUCH_DRAG_THRESHOLD_PX = 10;
  const TAP_MAX_MS = 500;
  const DOUBLE_TAP_MS = 360;
  const DOUBLE_TAP_PX = 28;

  // Creation metadata is deliberately richer than anchor count.  The state
  // machine uses it to decide whether a gesture can create a second anchor on
  // release, whether completion is automatic, and how an unfinished object is
  // previewed.  Persistence remains the same {time, price} points model.
  const TOOL_DEFS = {
    horizontal_line: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", editAxis: "price", label: "Горизонтальный уровень" },
    // Unlike horizontal_line (infinite both directions, x is irrelevant to
    // rendering), the ray's anchor time genuinely matters - it's where the
    // line *starts*, extending only rightward - so a whole-object drag must
    // translate both axes (no editAxis restriction), not just price.
    horizontal_ray: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", label: "Горизонтальный луч" },
    vertical_line: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", editAxis: "time", label: "Вертикальная линия" },
    trend_line: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Линия тренда" },
    ray: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Луч" },
    extended_line: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Расширенная линия" },
    parallel_channel: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Параллельный канал" },
    // Same 2-anchor placement/geometry as trend_line - the only difference
    // is a screen-angle label at render time (see trendAngleDegrees()).
    trend_angle: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Угол тренда" },
    // Same 2-anchor placement as trend_line, but the anchors only pick the
    // time range - the line itself (and its deviation bands) is computed
    // live from candle closes in that range (see regressionTrendChannel()),
    // same "live recompute from core.candles" principle anchored_vwap uses.
    regression_trend: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Регрессионный тренд" },
    // Same 3-anchor staged placement as parallel_channel - anchor2 sets a
    // flat (constant-price) boundary instead of a parallel-offset one (see
    // flatBoundaryPoints()).
    flat_top_bottom: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Плоский верх/низ" },
    // 4 anchors, two independent 2-point segments (anchor0-anchor1,
    // anchor2-anchor3) - unlike parallel_channel/flat_top_bottom, the
    // second line isn't derived from the first at all, so it needs its own
    // full pair of anchors. Same drag+2×tap staged placement as
    // double_curve (also 4 anchors, 2 placed by drag).
    disjoint_channel: { pointsNeeded: 4, anchorCount: 4, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Несвязный канал" },
    rectangle: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Прямоугольная зона" },
    circle: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", semanticShape: "ellipse", label: "Эллипс" },
    polyline: { pointsNeeded: -1, anchorCount: -1, creationGesture: "multi-tap", dragStagePoints: 0, completion: "explicit", preview: "next-anchor", label: "Полилиния" },
    price_range: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Диапазон цены" },
    time_range: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Диапазон времени" },
    text: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", label: "Текст" },
    note: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", label: "Заметка" },
    fib_retracement: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Коррекция Фибоначчи" },
    fib_extension: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Расширение Фибоначчи" },
    long_position: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", editHandles: ["start", "end", "stop", "take"], label: "Long позиция" },
    short_position: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", editHandles: ["start", "end", "stop", "take"], label: "Short позиция" },
    triangle: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Треугольник" },
    price_date_range: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Цена и время" },
    // Anchor 0 is the pitchfork's "handle" - anchors 1/2 are the two prongs
    // whose midpoint the median passes through. Same 3-anchor staged
    // placement as parallel_channel/triangle (drag places 0+1, a third tap
    // places 2), just a different geometry at render/hit-test time.
    pitchfork: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Вилы Эндрюса" },
    // Same 3-anchor placement/geometry family as pitchfork above - only the
    // median line's two defining points differ (see PITCHFORK_VARIANTS
    // below), so these share pitchforkSegments() rather than duplicating
    // the parallel-teeth construction.
    pitchfork_schiff: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Вилы Шиффа" },
    pitchfork_modified_schiff: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Модифицированные вилы Шиффа" },
    // Anchor 0 is the fan's origin, anchor 1 defines the "1x1" (45 degree)
    // angle - every other ray (1x8..8x1) is the same origin at a slope
    // that's a fixed ratio of that 1x1 slope, measured in real bars (not
    // raw pixels) so it stays correct across zoom levels - see
    // gannBaseline()/GANN_RATIOS below.
    gann_fan: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Веер Ганна" },
    // 5 anchors placed X-A-B-C-D (drag places X+A, three more taps place
    // B/C/D) - reuses the generic anchorCount completion path exactly like
    // triangle/pitchfork, just with 5 points instead of 3. Renders as a
    // labeled zigzag with per-leg retracement/extension ratios (see the
    // "xabcd" render case) rather than TradingView's full harmonic-pattern
    // auto-classification (Gartley/Bat/Butterfly/Crab naming) - that's a
    // separate, much larger piece of work left for a future session.
    xabcd_pattern: { pointsNeeded: 5, anchorCount: 5, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Паттерн XABCD" },
    // Same labeled-zigzag-with-leg-ratios rendering as xabcd_pattern above,
    // just 4 anchors (no X) - shares the "xabcd" render/hit-test code via
    // PATTERN_LABELS below rather than duplicating it.
    abcd_pattern: { pointsNeeded: 4, anchorCount: 4, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Паттерн ABCD" },
    // 5 anchors placed 1-2-3-4-5, same staged placement as xabcd_pattern.
    // Renders the zigzag plus two boundary rays (1->3 and 2->4, each
    // extended rightward) - the converging/diverging trendlines a triangle
    // chart pattern is actually marked by, not just the raw swing points.
    triangle_pattern: { pointsNeeded: 5, anchorCount: 5, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Паттерн треугольник" },
    // 6 anchors placed 0-1-A-2-B-3 (three "drives" 0->1->2->3, corrective
    // retracements A/B between them) - same labeled-zigzag-with-leg-ratios
    // rendering as xabcd_pattern/abcd_pattern, just a longer point count
    // and different labels (see PATTERN_LABELS).
    three_drives_pattern: { pointsNeeded: 6, anchorCount: 6, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Паттерн три драйва" },
    // 5 anchors placed Left Shoulder - trough - Head - trough - Right
    // Shoulder, same staged placement/zigzag+boundary rendering family as
    // triangle_pattern, but exactly one boundary line (the neckline,
    // through the two troughs at anchor1/anchor3) instead of two.
    head_shoulders_pattern: { pointsNeeded: 5, anchorCount: 5, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Паттерн голова и плечи" },
    // 6 anchors placed 0-1-2-3-4-5 (the classic 5-wave impulse, numbered
    // from its own starting point) - same labeled-zigzag-with-leg-ratios
    // rendering as three_drives_pattern, just different labels.
    elliott_impulse_wave: { pointsNeeded: 6, anchorCount: 6, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Волна Эллиотта (импульс)" },
    // 4 anchors placed 0-A-B-C (the 3-wave ABC correction) - same family
    // as elliott_impulse_wave, just a shorter point count/label set.
    elliott_correction_wave: { pointsNeeded: 4, anchorCount: 4, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Волна Эллиотта (коррекция)" },
    // 2 anchors define one cycle: anchor1.time - anchor0.time is the
    // repeat interval, redrawn as a series of vertical lines spanning the
    // whole visible pane (both directions from anchor0) - see
    // cyclicLineTimes() below. Unlike every other 2-anchor tool here, the
    // rendered object isn't "the segment between the two points" at all.
    cyclic_lines: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Циклические линии" },
    // 2 anchors, one full sine period drawn between them, oscillating
    // perpendicular to the anchor0->anchor1 baseline (pane-pixel space) -
    // see sineLineSamples() below. TradingView's own amplitude convention
    // for this tool isn't independently documented anywhere verifiable;
    // this uses a fixed fraction of the baseline length so the wave scales
    // naturally with how far apart the two anchors are placed.
    sine_line: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Синусоида" },
    // Single anchor - unlike every other tool here, this one isn't fixed
    // geometry at all: it's a computed price series (cumulative
    // volume-weighted typical price from the anchor bar to the latest
    // candle, see anchoredVwapSeries() below), recomputed from live
    // core.candles every frame exactly like cyclic_lines recomputes from
    // the live visible range - so it stays live as new candles/ticks
    // arrive with no separate update wiring of its own. Volume Profile
    // (the other half of this ТЗ line item) is implemented separately
    // below as volume_profile - see its own comment there.
    anchored_vwap: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", label: "Привязанный VWAP" },
    // Fixed Range Volume Profile - 2 anchors define a *time* range (their
    // own price component is ignored, same simplification real TradingView
    // makes: the profile's price axis always spans the full high/low of
    // whatever candles fall inside that time window, not whatever price the
    // user happened to click at). Computed histogram, not fixed geometry -
    // see volumeProfileBuckets() below - so like anchored_vwap it needs
    // real core.candles data and gets its own dedicated test rather than
    // running through the generic identity-conversion fixture loops.
    volume_profile: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Профиль объёма (диапазон)" },
    // TradingView's real "Measure" (Alt+drag, or its own rail tool): a
    // temporary ruler overlay showing the same price-delta/%/bars/duration
    // math as price_date_range, but which never becomes a persistent drawing
    // object - see the `ephemeral` flag, read by _finishDraft() below, which
    // skips addDrawing() entirely and re-arms the tool instead. Unlike
    // price_range/time_range/price_date_range (kept as-is - TradingView has
    // those too, as ordinary persistent line tools), this one is additive.
    measure: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", ephemeral: true, label: "Измерение" },
    // Unlike every other tool, points aren't placed one anchor per tap/drag -
    // they're continuously sampled from pointer position while the button is
    // held (see the "drag-release" branches in _onPointerMove/
    // _finishCreatePointer/_finishDraft below). completion:"drag-release" is
    // a third completion mode alongside the existing "anchor-count"/
    // "explicit" ones.
    freehand: { pointsNeeded: -1, anchorCount: -1, creationGesture: "freehand-drag", dragStagePoints: 0, completion: "drag-release", preview: "none", label: "Кисть" },
    // TradingView's Highlighter: same continuous drag-release sampling as
    // freehand above (see completion:"drag-release" handling in
    // _onPointerMove/_finishCreatePointer/_finishDraft) - only its default
    // stroke width/opacity/cap style differ (see defaultProperties() and the
    // "highlighter" render case), which is why TradingView itself ships it
    // as a separate rail tool rather than a freehand preset.
    highlighter: { pointsNeeded: -1, anchorCount: -1, creationGesture: "freehand-drag", dragStagePoints: 0, completion: "drag-release", preview: "none", label: "Маркер" },
    // TradingView's Arrow: identical 2-anchor placement to trend_line, only
    // the render/hit-test differ - a plain segment plus a triangular head at
    // anchor 1 (the direction the user dragged toward). See the "arrow" case
    // in _hitDrawing (shares trend_line's finite-segment test) and _buildOp/
    // _drawOp (adds the head).
    arrow: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Стрелка" },
    // TradingView's 4 "Arrow Mark" tools: one anchor, a small fixed-size
    // glyph pointing a constant screen-space direction (not derived from any
    // drag, unlike `arrow` above) - see ARROW_MARK_DIR below for the 4
    // directions and arrowMarkBodyCenter() for the shared hit-test math.
    arrow_mark_up: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", label: "Стрелка вверх" },
    arrow_mark_down: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", label: "Стрелка вниз" },
    arrow_mark_left: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", label: "Стрелка влево" },
    arrow_mark_right: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", label: "Стрелка вправо" },
    // TradingView's Rotated Rectangle: anchor0->anchor1 is one edge (sets
    // length + angle), anchor2's perpendicular signed distance from that
    // edge sets the rectangle's width - a real rotated quad in pane-pixel
    // space, unlike `rectangle` (always axis-aligned). Same 3-anchor staged
    // placement as triangle/pitchfork; see rotatedRectCorners() below.
    rotated_rectangle: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Повёрнутый прямоугольник" },
    // TradingView's Path: same free-form multi-tap placement/geometry as
    // polyline (shares its "polyline"/"freehand"/"highlighter"/"path"
    // render+hit-test case below) - TradingView itself treats Path and
    // Polyline as near-identical tools (straight segments between clicks),
    // a distinction this codebase doesn't need to model beyond giving Path
    // its own rail button/label.
    path: { pointsNeeded: -1, anchorCount: -1, creationGesture: "multi-tap", dragStagePoints: 0, completion: "explicit", preview: "next-anchor", label: "Путь" },
    // TradingView's Curve: a quadratic Bezier. anchor0/anchor1 are the two
    // endpoints (staged drag, as usual); anchor2 is the Bezier *control*
    // point - the curve bulges toward it but does not pass through it
    // (standard Bezier vocabulary; TradingView's own "drag to bow through
    // this point" feel isn't independently documented anywhere verifiable,
    // same caveat as sine_line's amplitude above). See
    // quadraticBezierSamples() below.
    curve: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Кривая" },
    // TradingView's Arc: a true circular arc, not a Bezier - anchor0/
    // anchor1/anchor2 are 3 points literally *on* the arc (unlike Curve's
    // control-point convention above), matching what "arc" actually means
    // geometrically. See arcSamples()/circumcircle() below; falls back to
    // a straight anchor0->anchor1 segment when the 3 anchors are
    // (near-)collinear, since no finite circle passes through them.
    arc: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Дуга" },
    // TradingView's Double Curve: a cubic Bezier S-curve. anchor0/anchor1
    // are the two endpoints, anchor2/anchor3 are its two independent
    // control points - same control-point convention as Curve above, just
    // cubic instead of quadratic. See cubicBezierSamples() below.
    double_curve: { pointsNeeded: 4, anchorCount: 4, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Двойная кривая" },
    // Fibonacci family, part 1 (the other half - Fib Channel/Wedge/Spiral/
    // Pitchfan/Trend-Based Fib Time - is a separate, larger follow-up, see
    // the parity matrix "Дальше"). Fib Time Zone: anchor0->anchor1's time
    // span is the base interval; vertical lines are drawn at anchor0.time +
    // interval*F for each Fibonacci number F (0,1,2,3,5,8,13...) - see
    // fibTimeZoneMarks() below, the same "recompute from the live visible
    // range every frame" principle cyclic_lines already uses.
    fib_time_zone: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Временные зоны Фибоначчи" },
    // Fib Speed Resistance Fan: same 2-anchor placement as gann_fan, but
    // the fan rays go from anchor0 through fractional-*price* points at
    // anchor1's time (Fibonacci ratios of the anchor0->anchor1 price
    // range) rather than Gann's fixed angle-ratio baseline - see
    // fibFanSegments() below, reuses gann_fan's own render/hit-test op
    // shape (segments with label/major) unchanged.
    fib_speed_resistance_fan: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Веер скорости Фибоначчи" },
    // Fib Circles: concentric rings centered at anchor0, radii = Fibonacci
    // ratios of the anchor0->anchor1 pixel distance - see fibCircles()
    // below.
    fib_circles: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Круги Фибоначчи" },
    // Fib Arcs: same Fibonacci-ratio radii as Fib Circles above, but
    // centered at anchor1 (the move's end point, TradingView's own
    // convention - distinct from Fib Circles' anchor0 center) and drawn as
    // half-circles facing away from anchor0, not full rings - see
    // fibArcSamples() below.
    fib_arcs: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Дуги Фибоначчи" },
    // Fibonacci family, part 2 (Fib Spiral/Pitchfan - genuinely new
    // geometry, not a drop-in extension of anything already written - are
    // left for a future session, see the parity matrix "Дальше"). Fib
    // Channel: same 3-anchor placement as parallel_channel (anchor2's
    // perpendicular price offset from the anchor0-anchor1 line), but draws
    // one level line per FIB_RETRACEMENT_LEVELS fraction of that offset
    // instead of just the two boundary lines - see fibChannelSegments()
    // below.
    fib_channel: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Канал Фибоначчи" },
    // Fib Wedge: same 3-anchor placement as triangle/pitchfork - anchor0 is
    // the wedge's shared vertex, anchor1/anchor2 its two diverging edges.
    // Draws a narrowing series of connecting lines from the vertex outward
    // at each FIB_RETRACEMENT_LEVELS fraction - see fibWedgeSegments()
    // below.
    fib_wedge: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Клин Фибоначчи" },
    // Trend-Based Fib Time: identical Fibonacci-number math to
    // fib_time_zone above, but zones project forward from anchor1 (the
    // end of the trend leg) rather than anchor0 - TradingView's own
    // distinction between the two tools ("Time Zone" counts from where you
    // started, "Trend-Based Fib Time" counts from where the move ended).
    // See trendBasedFibTimeMarks() below; reuses fib_time_zone's own
    // render/hit-test op shape unchanged.
    trend_based_fib_time: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Временные зоны по тренду" },
    // Fibonacci family, part 3 - the last two, genuinely new geometry
    // rather than a drop-in extension of anything already written (this
    // closes the family 9/9). Fib Pitchfan: same 3-anchor placement as
    // pitchfork (anchor0 = handle, anchor1/anchor2 = prongs), but instead
    // of a single median + 2 parallel teeth, fans a ray from anchor0
    // through each FIB_PITCHFAN_RATIOS fraction of the anchor1->anchor2
    // segment - see fibPitchfanSegments() below.
    fib_pitchfan: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Веер Фибоначчи (Pitchfan)" },
    // Fib Spiral: a logarithmic "golden spiral" centered at anchor0;
    // anchor1 sets the starting radius/angle. See fibSpiralSamples()
    // below.
    fib_spiral: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Спираль Фибоначчи" },
  };

  /** Unit direction each Arrow Mark glyph points in pane-pixel space -
   * screen-space constants (y grows downward), not tied to price/time. */
  const ARROW_MARK_DIR = {
    arrow_mark_up: { x: 0, y: -1 },
    arrow_mark_down: { x: 0, y: 1 },
    arrow_mark_left: { x: -1, y: 0 },
    arrow_mark_right: { x: 1, y: 0 },
  };
  // Glyph length (tip to tail) and the hit-test body circle's radius/offset -
  // the offset pushes the body hit-test center past ARROW_MARK anchor's own
  // handle radius so a whole-object body hit is reachable distinctly from
  // the handle (mirrors how horizontal_line's line body is hittable well
  // away from its single handle).
  const ARROW_MARK_LEN_PX = 24;
  const ARROW_MARK_HIT_RADIUS_PX = 14;
  /** Center of an Arrow Mark's hit-test circle, offset from its anchor pixel
   * toward the tail (opposite the direction it points) - shared by
   * _hitDrawing and _buildOp/_drawOp so hit-testing and rendering agree. */
  function arrowMarkBodyCenter(anchorPix, type) {
    const dir = ARROW_MARK_DIR[type];
    return { x: anchorPix.x - dir.x * ARROW_MARK_LEN_PX * 0.75, y: anchorPix.y - dir.y * ARROW_MARK_LEN_PX * 0.75 };
  }

  /** The 4 corners of a rotated-rectangle drawing in pane-pixel space:
   * pix[0]/pix[1] are one edge (sets length + angle), pix[2]'s perpendicular
   * signed distance from that edge sets the rectangle's width. Shared by
   * _hitDrawing and _buildOp so hit-testing and rendering never drift. null
   * if the edge is degenerate (zero on-screen length) or any anchor is
   * off-viewport. */
  function rotatedRectCorners(pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null || !pix[2] || pix[2].x == null) return null;
    const dx = pix[1].x - pix[0].x, dy = pix[1].y - pix[0].y;
    const len = Math.hypot(dx, dy);
    if (!len) return null;
    const nx = -dy / len, ny = dx / len;
    const dist = (pix[2].x - pix[0].x) * nx + (pix[2].y - pix[0].y) * ny;
    const ox = nx * dist, oy = ny * dist;
    return [
      { x: pix[0].x, y: pix[0].y },
      { x: pix[1].x, y: pix[1].y },
      { x: pix[1].x + ox, y: pix[1].y + oy },
      { x: pix[0].x + ox, y: pix[0].y + oy },
    ];
  }

  // Minimum on-screen movement (px) between two sampled freehand points -
  // keeps the stored point count (and therefore render/hit-test cost, and
  // saved-drawing payload size) bounded instead of one point per pointermove
  // event, which can fire far more often than is visually meaningful.
  const FREEHAND_SAMPLE_MIN_DIST_PX = 6;

  const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_EXTENSION_LEVELS = [0, 0.618, 1, 1.272, 1.618, 2.618];

  /** TradingView's classic 9-ray Gann Fan set, labeled by their traditional
   * "1x8".."8x1" angle names. `r` is the multiple of the fan's own 1x1
   * slope (anchor0->anchor1, in real price-per-bar - see gannBaseline()),
   * not a raw pixel-space angle, so the fan looks the same at any zoom. */
  const GANN_RATIOS = [
    { r: 1 / 8, label: "1×8" }, { r: 1 / 4, label: "1×4" }, { r: 1 / 3, label: "1×3" },
    { r: 1 / 2, label: "1×2" }, { r: 1, label: "1×1" }, { r: 2, label: "2×1" },
    { r: 3, label: "3×1" }, { r: 4, label: "4×1" }, { r: 8, label: "8×1" },
  ];
  // Bars to extend a Gann ray past its origin before clipping to the pane -
  // just needs to be larger than any realistic on-screen bar count.
  const GANN_FAR_BARS = 100000;

  /** Price-per-bar slope of a Gann Fan's 1x1 ray, in *logical bar* units
   * (via timeToLogical) rather than raw elapsed time - matches
   * TradingView's own bar-based Gann angles, and keeps the fan's angles
   * stable across session gaps (weekends/holidays) the same way the rest
   * of this file's logical<->time machinery does. 0 for a degenerate
   * same-bar anchor pair (mirrors lerpPriceAtTime's zero-span fallback). */
  function gannBaseline(core, d) {
    const l0 = timeToLogical(core, d.points[0].time);
    const l1 = timeToLogical(core, d.points[1].time);
    const dl = l1 - l0;
    return dl ? (d.points[1].price - d.points[0].price) / dl : 0;
  }
  /** Pixel point far along one Gann ray (origin + GANN_FAR_BARS bars, at
   * the price the given ratio's slope implies) - only ever used as the far
   * endpoint fed to clipParametricLineToRect's "ray" mode, never rendered
   * itself, so it doesn't matter that it's usually off-screen. */
  function gannFarPixel(core, d, baseline, ratio) {
    const l0 = timeToLogical(core, d.points[0].time);
    const farTime = logicalToTime(core, l0 + GANN_FAR_BARS);
    const farPrice = d.points[0].price + baseline * ratio * GANN_FAR_BARS;
    if (!finite(farTime) || !finite(farPrice)) return null;
    return toPixels(core, [{ time: farTime, price: farPrice }])[0];
  }
  /** The 9 clipped Gann Fan ray segments in pane-pixel space, ready to draw
   * or hit-test - shared by _hitDrawing and DrawingPaneView._buildOp so the
   * two never drift apart. Returns [] if pix[0]/pix[1] aren't both visible. */
  function gannSegments(core, d, pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null) return [];
    const baseline = gannBaseline(core, d);
    const segs = [];
    for (const g of GANN_RATIOS) {
      const far = gannFarPixel(core, d, baseline, g.r);
      if (!far || far.x == null) continue;
      const clipped = clipParametricLineToRect(pix[0], far, paneWidth(core), paneHeight(core), "ray");
      if (clipped) segs.push(Object.assign({ label: g.label, major: g.r === 1 }, clipped));
    }
    return segs;
  }

  /** TradingView's classic Fib Speed Resistance Fan ratio set - the same
   * fractions fib_retracement uses, applied to the anchor0->anchor1
   * *price* range (see fibFanSegments() below) rather than to time. */
  const FIB_FAN_RATIOS = [
    { r: 0, label: "0" }, { r: 0.236, label: "23.6" }, { r: 0.382, label: "38.2" },
    { r: 0.5, label: "50" }, { r: 0.618, label: "61.8" }, { r: 0.786, label: "78.6" }, { r: 1, label: "100" },
  ];

  /** Fib Speed Resistance Fan's rays (pane-pixel space): from anchor0
   * through the point at anchor1's *time* whose price is anchor0's price
   * offset by each Fibonacci ratio of the anchor0->anchor1 price range,
   * extended as a ray to the pane edge (same clipParametricLineToRect
   * "ray" mode ray/pitchfork/gann_fan already use). Unlike Gann Fan's
   * angle-ratio baseline (gannBaseline/GANN_RATIOS above), these rays fan
   * out to fractional *price* heights at a fixed time - the classic Speed
   * Resistance Fan definition (fan lines to fractional retracement levels
   * of the move's price range, not fractions of a 45-degree bar-angle).
   * Shared by _hitDrawing and _buildOp; reuses gann_fan's own render op
   * shape (segments with label/major) unchanged. Returns [] if pix[0]/
   * pix[1] aren't both visible. */
  function fibFanSegments(core, d, pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null) return [];
    const segs = [];
    for (const f of FIB_FAN_RATIOS) {
      const price = d.points[0].price + (d.points[1].price - d.points[0].price) * f.r;
      const targetPix = toPixels(core, [{ time: d.points[1].time, price }])[0];
      if (!targetPix || targetPix.x == null) continue;
      const clipped = clipParametricLineToRect(pix[0], targetPix, paneWidth(core), paneHeight(core), "ray");
      if (clipped) segs.push(Object.assign({ label: f.label, major: f.r === 0.5 }, clipped));
    }
    return segs;
  }

  /** Andrews' Pitchfork variant -> tool type, and vice versa: all three
   * variants share the exact same 3-anchor placement and "two teeth
   * parallel to the median" construction (pitchforkSegments below) -
   * they differ *only* in which two model points define the median line:
   *  - standard:        anchor0                    -> midpoint(anchor1, anchor2)
   *  - schiff:           midpoint(anchor0, anchor1) -> midpoint(anchor1, anchor2)
   *  - modified_schiff:  midpoint(anchor0, anchor1) -> anchor2
   * (Schiff shifts the whole fork's angle by starting the median later;
   * Modified Schiff shifts it further by aiming at anchor2 itself instead
   * of the anchor1/2 midpoint.) */
  const PITCHFORK_VARIANT = { pitchfork: "standard", pitchfork_schiff: "schiff", pitchfork_modified_schiff: "modified_schiff" };

  /** The two *model* points (real time/price, not pixels) that define a
   * pitchfork variant's median line - see PITCHFORK_VARIANT above for the
   * three definitions. Kept in model space (like the rest of this file's
   * geometry) rather than pixel space so a variant's median endpoint that
   * isn't one of the three raw anchors (the schiff/modified_schiff
   * midpoints) still projects correctly through toPixels(). */
  function pitchforkMedianModelPoints(variant, d) {
    const midPt = (a, b) => ({ time: (a.time + b.time) / 2, price: (a.price + b.price) / 2 });
    const [p0, p1, p2] = d.points;
    if (variant === "schiff") return [midPt(p0, p1), midPt(p1, p2)];
    if (variant === "modified_schiff") return [midPt(p0, p1), p2];
    return [p0, midPt(p1, p2)];
  }

  /** Andrews' Pitchfork's median ray and its two teeth (rays through
   * anchor1/anchor2, parallel to the median) - all three computed directly
   * in pane-pixel space so "parallel" means exactly what it looks like on
   * screen, matching how every other ray tool (ray/extended_line/
   * horizontal_ray) already clips in pixel space. Shared by _hitDrawing
   * and _buildOp like gannSegments() above, across all three variants. */
  function pitchforkSegments(core, d, pix, variant) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null || !pix[2] || pix[2].x == null) return [];
    const [m0, m1] = pitchforkMedianModelPoints(variant, d);
    const [pixM0, pixM1] = toPixels(core, [m0, m1]);
    if (!pixM0 || pixM0.x == null || !pixM1 || pixM1.x == null) return [];
    const w = paneWidth(core), h = paneHeight(core);
    const dx = pixM1.x - pixM0.x, dy = pixM1.y - pixM0.y;
    const median = clipParametricLineToRect(pixM0, pixM1, w, h, "ray");
    const tooth1 = clipParametricLineToRect(pix[1], { x: pix[1].x + dx, y: pix[1].y + dy }, w, h, "ray");
    const tooth2 = clipParametricLineToRect(pix[2], { x: pix[2].x + dx, y: pix[2].y + dy }, w, h, "ray");
    return [median, tooth1, tooth2].filter(Boolean);
  }

  // Fib Pitchfan's ratio set - like FIB_CIRCLE_LEVELS/FIB_EXTENSION_LEVELS,
  // goes past both 0 and 1 (the fan keeps projecting beyond the
  // anchor1-anchor2 range, not just between the two prongs). 0.5 is
  // included deliberately - see fibPitchfanSegments() below for why it's
  // not an arbitrary choice.
  const FIB_PITCHFAN_RATIOS = [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618];

  /** Fib Pitchfan's fan-ray segments (pane-pixel space): from anchor0
   * through the point at each FIB_PITCHFAN_RATIOS fraction along
   * anchor1->anchor2 (interpolated in real time+price, so a ratio outside
   * [0,1] correctly extrapolates past whichever prong), extended to the
   * pane edge - reuses gann_fan's exact ray-clipping + render op shape
   * (fib_speed_resistance_fan already reuses the same op for its own,
   * differently-sourced fan). At ratio 0.5 the target point is literally
   * midpoint(anchor1, anchor2) - the same point the standard pitchfork's
   * own median aims at (see pitchforkMedianModelPoints' "standard" case
   * above) - not a coincidence, both tools share that definition in
   * TradingView. Shared by _hitDrawing and _buildOp. [] if any anchor is
   * off-screen. */
  function fibPitchfanSegments(core, d, pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null || !pix[2] || pix[2].x == null) return [];
    const [p1, p2] = [d.points[1], d.points[2]];
    const segs = [];
    for (const level of FIB_PITCHFAN_RATIOS) {
      const target = { time: p1.time + (p2.time - p1.time) * level, price: p1.price + (p2.price - p1.price) * level };
      const targetPix = toPixels(core, [target])[0];
      if (!targetPix || targetPix.x == null) continue;
      const clipped = clipParametricLineToRect(pix[0], targetPix, paneWidth(core), paneHeight(core), "ray");
      if (clipped) segs.push(Object.assign({ label: `${(level * 100).toFixed(1)}%`, major: level === 0.5 }, clipped));
    }
    return segs;
  }

  /** Vertex labels for the labeled-zigzag pattern tools (xabcd_pattern/
   * abcd_pattern/three_drives_pattern/elliott_impulse_wave/
   * elliott_correction_wave) - the render/hit-test code itself is
   * identical for all five (see the "xabcd" op kind), only the label text
   * and point count differ. Three Drives' 0/1/A/2/B/3 is the classic
   * labeling (drives 0->1->2->3, corrective retracements A/B between
   * them) - same "labeled zigzag + per-leg ratio" reading as XABCD/ABCD,
   * just without the harmonic-pattern auto-classification either. Elliott
   * impulse (0-1-2-3-4-5) and correction (0-A-B-C) are the same reading
   * again, just Elliott's own numbering/lettering convention - no wave-
   * rule validation (alternation, Wave 3 never shortest, etc.), just the
   * labeled skeleton and leg ratios like every other tool in this family. */
  const PATTERN_LABELS = {
    xabcd_pattern: ["X", "A", "B", "C", "D"],
    abcd_pattern: ["A", "B", "C", "D"],
    three_drives_pattern: ["0", "1", "A", "2", "B", "3"],
    elliott_impulse_wave: ["0", "1", "2", "3", "4", "5"],
    elliott_correction_wave: ["0", "A", "B", "C"],
  };

  /** Vertex labels + boundary-line anchor pairs for the "zigzag plus
   * extended trendline(s)" pattern tools - triangle_pattern's two
   * converging/diverging sides (through anchor0/anchor2 and
   * anchor1/anchor3), head_shoulders_pattern's single neckline (through
   * the two troughs, anchor1/anchor3 of its 5-point LS-trough-Head-trough-
   * RS skeleton). Shared by _hitDrawing and _buildOp via
   * patternBoundarySegments() below - only the pairs list differs per
   * type, the ray-clipping itself is identical. */
  const PATTERN_BOUNDARY_LABELS = {
    triangle_pattern: ["1", "2", "3", "4", "5"],
    head_shoulders_pattern: ["ЛП", "1", "Г", "2", "ПП"],
  };
  const PATTERN_BOUNDARY_PAIRS = {
    triangle_pattern: [[0, 2], [1, 3]],
    head_shoulders_pattern: [[1, 3]],
  };

  /** One anchor-pair's line, extended rightward (pane-pixel space, same
   * ray-clipping every other "extends to the pane edge" tool here uses -
   * ray/pitchfork/gann_fan). */
  function extendedRaySegment(core, pix, i, j) {
    if (!pix[i] || pix[i].x == null || !pix[j] || pix[j].x == null) return null;
    return clipParametricLineToRect(pix[i], pix[j], paneWidth(core), paneHeight(core), "ray");
  }

  /** All of a pattern type's boundary-line segments - the actual
   * converging/diverging trendlines (Triangle Pattern) or neckline (Head &
   * Shoulders) the zigzag skeleton is marked by, not just the raw swing
   * points themselves. */
  function patternBoundarySegments(core, pix, type) {
    return (PATTERN_BOUNDARY_PAIRS[type] || []).map(([i, j]) => extendedRaySegment(core, pix, i, j)).filter(Boolean);
  }

  // Hard cap on repeated cyclic-line count - only matters as a safety net
  // against a pathological near-zero interval (anchors placed almost on
  // the same bar), never hit by an ordinary placement.
  const CYCLIC_LINES_MAX = 300;

  /** Every repeat-time (real time, not pixels) of a Cyclic Lines drawing's
   * interval (anchor1.time - anchor0.time) that falls within the pane's
   * *currently visible* time span, extended one interval past each edge so
   * a partially-visible line at the boundary still renders. Recomputed
   * every frame from the live visible range (via coordinateToLogicalSafe
   * at the pane's two edges) rather than cached, so panning/zooming always
   * shows the right set of lines - the interval itself is the only thing
   * anchored to the drawing's own model points. */
  function cyclicLineTimes(core, d) {
    // Draft preview mid-drag only has anchor0 placed (no preview point yet,
    // or the preview point failed its own finite-time/price check in
    // DrawingPaneView.update()) - points[1] is genuinely absent then, not
    // just an edge case to special-case away.
    if (!d.points[0] || !d.points[1]) return [];
    const dt = d.points[1].time - d.points[0].time;
    if (!dt) return [];
    const w = paneWidth(core);
    const l0 = coordinateToLogicalSafe(core, 0);
    const l1 = coordinateToLogicalSafe(core, w);
    if (!finite(l0) || !finite(l1)) return [];
    const t0 = logicalToTime(core, l0), t1 = logicalToTime(core, l1);
    if (!finite(t0) || !finite(t1)) return [];
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    let kMin = Math.floor((lo - d.points[0].time) / dt) - 1;
    let kMax = Math.ceil((hi - d.points[0].time) / dt) + 1;
    if (kMax - kMin > CYCLIC_LINES_MAX) kMax = kMin + CYCLIC_LINES_MAX;
    const times = [];
    for (let k = kMin; k <= kMax; k++) times.push(d.points[0].time + k * dt);
    return times;
  }

  /** Cyclic Lines' pixel x-coordinates, ready to draw or hit-test - every
   * repeat that actually lands inside the pane (some of cyclicLineTimes'
   * candidates round to just outside it, at the edges). */
  function cyclicLineXs(core, d) {
    const w = paneWidth(core);
    return cyclicLineTimes(core, d)
      .map((t) => timeToCoordinateSafe(core, t))
      .filter((x) => finite(x) && x >= 0 && x <= w);
  }

  // Fixed, generously long Fibonacci sequence for Fib Time Zone - unlike
  // Cyclic Lines' fixed-interval repeats (which need a dynamic, viewport-
  // dependent count), Fibonacci-scaled zones grow exponentially, so a
  // bounded static list comfortably covers any realistic zoom level/anchor
  // spacing without needing per-frame recomputation of how many terms are
  // needed.
  const FIB_TIME_ZONE_SEQUENCE = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946, 17711, 28657, 46368, 75025];

  /** Fib Time Zone's vertical-line x-positions + Fibonacci-number labels
   * (pane-pixel space), filtered to whatever's currently visible - shared
   * by _hitDrawing and _buildOp. [] for a degenerate zero-interval pair
   * (anchors on the same bar). */
  function fibTimeZoneMarks(core, d) {
    if (!d.points[0] || !d.points[1]) return [];
    const interval = d.points[1].time - d.points[0].time;
    if (!interval) return [];
    const w = paneWidth(core);
    const marks = [];
    for (const f of FIB_TIME_ZONE_SEQUENCE) {
      const x = timeToCoordinateSafe(core, d.points[0].time + interval * f);
      if (finite(x) && x >= 0 && x <= w) marks.push({ x, label: String(f) });
    }
    return marks;
  }

  /** Trend-Based Fib Time's vertical-line marks: identical math to
   * fibTimeZoneMarks() above, but zones project forward from anchor1 (the
   * end of the trend leg) rather than anchor0 - see TOOL_DEFS.
   * trend_based_fib_time's own comment for why. Shared by _hitDrawing and
   * _buildOp; reuses fib_time_zone's own render/hit-test op shape
   * unchanged. */
  function trendBasedFibTimeMarks(core, d) {
    if (!d.points[0] || !d.points[1]) return [];
    const interval = d.points[1].time - d.points[0].time;
    if (!interval) return [];
    const w = paneWidth(core);
    const marks = [];
    for (const f of FIB_TIME_ZONE_SEQUENCE) {
      const x = timeToCoordinateSafe(core, d.points[1].time + interval * f);
      if (finite(x) && x >= 0 && x <= w) marks.push({ x, label: String(f) });
    }
    return marks;
  }

  // Sine Line's amplitude as a fraction of the anchor0->anchor1 baseline's
  // own pixel length, so the wave scales with how far apart the two
  // anchors are placed rather than a fixed pixel constant that would look
  // proportionally tiny or huge depending on placement.
  const SINE_LINE_AMPLITUDE_RATIO = 0.12;
  const SINE_LINE_SAMPLES = 64;

  /** One full sine period's sampled polyline (pane-pixel space) from
   * anchor0 to anchor1, oscillating perpendicular to the anchor0->anchor1
   * baseline - the general shape a "Sine Line" tool is expected to draw
   * (a wave riding along the trend the two anchors define), not something
   * verified pixel-for-pixel against a live TradingView instance. Returns
   * null for a degenerate zero-length baseline. */
  function sineLineSamples(pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null) return null;
    const dx = pix[1].x - pix[0].x, dy = pix[1].y - pix[0].y;
    const len = Math.hypot(dx, dy);
    if (!len) return null;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux; // perpendicular unit vector
    const amplitude = len * SINE_LINE_AMPLITUDE_RATIO;
    const points = [];
    for (let i = 0; i <= SINE_LINE_SAMPLES; i++) {
      const t = i / SINE_LINE_SAMPLES;
      const offset = amplitude * Math.sin(2 * Math.PI * t);
      points.push({ x: pix[0].x + dx * t + nx * offset, y: pix[0].y + dy * t + ny * offset });
    }
    return points;
  }

  // Fib Spiral's growth: a "golden spiral" multiplies its radius by the
  // golden ratio (~1.618) every quarter turn (90 degrees) - the standard
  // logarithmic-spiral definition tied to Fibonacci. FIB_SPIRAL_TURNS caps
  // how many full turns get sampled/drawn (an unbounded log spiral has no
  // natural stopping point) - not verified pixel-for-pixel against a live
  // TradingView instance, same caveat as sine_line's amplitude above.
  const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
  const FIB_SPIRAL_TURNS = 3;
  const FIB_SPIRAL_SAMPLES_PER_TURN = 48;

  /** Fib Spiral's sampled polyline (pane-pixel space): a logarithmic
   * spiral centered at anchor0. anchor1 sets both the starting radius
   * (its pixel distance from anchor0) and starting angle; the spiral
   * always winds in the direction of increasing angle from there, for
   * FIB_SPIRAL_TURNS full turns, radius growing by GOLDEN_RATIO every
   * quarter turn. Shared by _hitDrawing and _buildOp. null for a
   * degenerate zero-distance anchor pair. */
  function fibSpiralSamples(pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null) return null;
    const r0 = Math.hypot(pix[1].x - pix[0].x, pix[1].y - pix[0].y);
    if (!r0) return null;
    const angle0 = Math.atan2(pix[1].y - pix[0].y, pix[1].x - pix[0].x);
    const b = Math.log(GOLDEN_RATIO) / (Math.PI / 2); // r *= GOLDEN_RATIO every quarter turn
    const totalAngle = FIB_SPIRAL_TURNS * 2 * Math.PI;
    const steps = FIB_SPIRAL_TURNS * FIB_SPIRAL_SAMPLES_PER_TURN;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const theta = (totalAngle * i) / steps;
      const r = r0 * Math.exp(b * theta);
      const a = angle0 + theta;
      points.push({ x: pix[0].x + r * Math.cos(a), y: pix[0].y + r * Math.sin(a) });
    }
    return points;
  }

  const BEZIER_SAMPLES = 32;

  /** Quadratic Bezier sample points (pane-pixel space) from p0 to p1 -
   * `control` is the literal Bezier control point (the curve bulges toward
   * it, never passes through it). Shared by _hitDrawing and _buildOp for
   * the "curve" tool. */
  function quadraticBezierSamples(p0, control, p1, steps = BEZIER_SAMPLES) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, mt = 1 - t;
      out.push({
        x: mt * mt * p0.x + 2 * mt * t * control.x + t * t * p1.x,
        y: mt * mt * p0.y + 2 * mt * t * control.y + t * t * p1.y,
      });
    }
    return out;
  }

  /** Cubic Bezier sample points (pane-pixel space) from p0 to p1 via two
   * literal control points c1/c2 - same control-point convention as
   * quadraticBezierSamples above. Shared by _hitDrawing and _buildOp for
   * the "double_curve" tool. */
  function cubicBezierSamples(p0, c1, c2, p1, steps = BEZIER_SAMPLES + 8) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, mt = 1 - t;
      const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
      out.push({
        x: a * p0.x + b * c1.x + c * c2.x + e * p1.x,
        y: a * p0.y + b * c1.y + c * c2.y + e * p1.y,
      });
    }
    return out;
  }

  /** Circumcircle (center + radius) of 3 pane-pixel points via the
   * standard determinant formula, or null if they're (near-)collinear
   * (no finite circle fits). Shared by arcSamples() below. */
  function circumcircle(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return null;
    const aa = a.x * a.x + a.y * a.y, bb = b.x * b.x + b.y * b.y, cc = c.x * c.x + c.y * c.y;
    const ux = (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / d;
    const uy = (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / d;
    return { x: ux, y: uy, r: Math.hypot(a.x - ux, a.y - uy) };
  }

  /** Sampled points (pane-pixel space) along the circular arc from p0 to
   * p1 that passes through pOn - all 3 are literally anchors *on* the arc
   * (TradingView's own "Arc" semantics, distinct from Curve's control-
   * point convention above). Picks whichever of the two possible sweep
   * directions between p0 and p1 actually passes through pOn. Falls back
   * to the straight p0->p1 segment if the 3 points are (near-)collinear -
   * no finite circle fits, and the geometric limit of an ever-flatter arc
   * *is* a straight line anyway. Shared by _hitDrawing and _buildOp. */
  function arcSamples(p0, pOn, p1, steps = BEZIER_SAMPLES + 8) {
    const circ = circumcircle(p0, pOn, p1);
    if (!circ) return [p0, p1];
    const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const a0 = Math.atan2(p0.y - circ.y, p0.x - circ.x);
    const a1raw = Math.atan2(p1.y - circ.y, p1.x - circ.x);
    const aMraw = Math.atan2(pOn.y - circ.y, pOn.x - circ.x);
    const ccwSpan = norm(a1raw - a0); // increasing-angle distance a0 -> a1
    const ccwToM = norm(aMraw - a0);
    // If pOn lies on the increasing-angle sweep from a0 to a1, take that
    // sweep; otherwise pOn is on the complementary (decreasing-angle) arc.
    const span = ccwToM <= ccwSpan ? ccwSpan : -(2 * Math.PI - ccwSpan);
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + span * (i / steps);
      out.push({ x: circ.x + circ.r * Math.cos(a), y: circ.y + circ.r * Math.sin(a) });
    }
    return out;
  }

  // Fib Circles/Arcs' ratio set - TradingView's own extension-style levels
  // (goes past 100%, unlike fib_retracement's 0-100% set) since a
  // "circle"/"arc" naturally keeps growing outward past the move itself.
  const FIB_CIRCLE_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];

  /** Sampled points (pane-pixel space) around a circle centered at
   * `center` with the given radius, from startAngle to endAngle (radians)
   * - shared by fibCircles() (a full turn) and fibArcSamples() (a half
   * turn) below. */
  function circleArcSamples(center, radius, startAngle, endAngle, steps = 48) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const a = startAngle + (endAngle - startAngle) * (i / steps);
      out.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
    }
    return out;
  }

  /** Fib Circles' concentric ring radii (pane-pixel space, logical/CSS
   * units - not yet scaled for bitmap draw), centered at anchor0: each
   * FIB_CIRCLE_LEVELS ratio of the anchor0->anchor1 pixel distance.
   * Shared by _hitDrawing and _buildOp. [] for a degenerate zero-distance
   * pair. */
  function fibCircles(pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null) return [];
    const dist = Math.hypot(pix[1].x - pix[0].x, pix[1].y - pix[0].y);
    if (!dist) return [];
    return FIB_CIRCLE_LEVELS.map((level) => ({ level, radius: dist * level }));
  }

  /** Fib Arcs' half-circle rings (pane-pixel space): same FIB_CIRCLE_LEVELS
   * radii as fibCircles() above, but centered at anchor1 (the move's end
   * point - TradingView's own convention, distinct from Fib Circles'
   * anchor0 center) and each sampled only across the half facing away from
   * anchor0 (the direction price would continue "into"), not a full ring.
   * Shared by _hitDrawing and _buildOp. [] for a degenerate zero-distance
   * pair. */
  function fibArcSamples(pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null) return [];
    const dist = Math.hypot(pix[1].x - pix[0].x, pix[1].y - pix[0].y);
    if (!dist) return [];
    const angle = Math.atan2(pix[1].y - pix[0].y, pix[1].x - pix[0].x);
    return FIB_CIRCLE_LEVELS.map((level) => ({
      level,
      points: circleArcSamples(pix[1], dist * level, angle - Math.PI / 2, angle + Math.PI / 2),
    }));
  }

  /** Anchored VWAP's price path: cumulative volume-weighted typical price
   * ((high+low+close)/3) from the anchor bar to the latest candle -
   * recomputed from the live core.candles array every call (never
   * cached), so it stays live as new candles/ticks arrive with no
   * separate update wiring of its own, same principle cyclic_lines uses
   * for its visible range. Falls back to the bar's own typical price for
   * a run with zero cumulative volume (no volume data), avoiding a
   * divide-by-zero rather than producing NaN. */
  function anchoredVwapSeries(core, d) {
    const candles = core.candles || [];
    if (!candles.length) return [];
    const anchorTime = d.points[0].time;
    let startIdx = candles.findIndex((c) => c.time >= anchorTime);
    if (startIdx < 0) startIdx = candles.length - 1;
    let cumPV = 0, cumV = 0;
    const series = [];
    for (let i = startIdx; i < candles.length; i++) {
      const c = candles[i];
      const typical = (c.high + c.low + c.close) / 3;
      const vol = c.volume || 0;
      cumPV += typical * vol;
      cumV += vol;
      series.push({ time: c.time, price: cumV ? cumPV / cumV : typical });
    }
    return series;
  }

  /** Anchored VWAP's price path in pane-pixel space, with any point whose
   * time/price failed to project (off the edge of what the chart library
   * can currently resolve) dropped rather than breaking the polyline. */
  function anchoredVwapPixels(core, d) {
    return toPixels(core, anchoredVwapSeries(core, d)).filter((p) => p.x != null && p.y != null);
  }

  // Fixed Range Volume Profile's row count - TradingView's own default for
  // this tool. A fixed count (not a fixed price-height) means the
  // histogram always has the same visual density regardless of how wide a
  // price range the selected time window happens to span.
  const VOLUME_PROFILE_ROWS = 24;

  /** Fixed Range Volume Profile's bucketed volume-by-price histogram: rows
   * are equal price-height buckets spanning the full high/low range of
   * every candle whose time falls within [anchor0.time, anchor1.time]
   * (order-independent - which anchor was placed first doesn't matter).
   * Each candle's volume is split across every bucket its own [low,high]
   * range overlaps, weighted by the fraction of that candle's range inside
   * the bucket - a real bar is rarely a single price, so naively dumping
   * its whole volume onto whichever row contains its close would bunch
   * volume unrealistically; TradingView's own algorithm spreads it across
   * the bar's actual range the same way. A zero-range candle (high===low)
   * goes entirely to the single bucket containing that price. Recomputed
   * live from core.candles every call - never cached - same "always
   * current, no separate update wiring" principle anchoredVwapSeries/
   * cyclic_lines already use. Returns buckets=[] if the time range
   * contains no candles. */
  function volumeProfileBuckets(core, d) {
    const candles = core.candles || [];
    if (!candles.length) return { buckets: [], maxVolume: 0 };
    const t0 = Math.min(d.points[0].time, d.points[1].time);
    const t1 = Math.max(d.points[0].time, d.points[1].time);
    const inRange = candles.filter((c) => c.time >= t0 && c.time <= t1);
    if (!inRange.length) return { buckets: [], maxVolume: 0 };
    let lo = Infinity, hi = -Infinity;
    for (const c of inRange) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (!(hi > lo)) hi = lo + Math.max(Math.abs(lo) * 0.001, 0.01); // degenerate flat range - avoid a divide-by-zero
    const step = (hi - lo) / VOLUME_PROFILE_ROWS;
    const volumes = new Array(VOLUME_PROFILE_ROWS).fill(0);
    for (const c of inRange) {
      const vol = c.volume || 0;
      if (!vol) continue;
      if (c.high <= c.low) {
        const idx = Math.min(VOLUME_PROFILE_ROWS - 1, Math.max(0, Math.floor((c.low - lo) / step)));
        volumes[idx] += vol;
        continue;
      }
      const range = c.high - c.low;
      for (let i = 0; i < VOLUME_PROFILE_ROWS; i++) {
        const bLo = lo + i * step, bHi = bLo + step;
        const overlap = Math.min(c.high, bHi) - Math.max(c.low, bLo);
        if (overlap > 0) volumes[i] += vol * (overlap / range);
      }
    }
    let maxVolume = 0;
    const buckets = volumes.map((volume, i) => {
      if (volume > maxVolume) maxVolume = volume;
      return { price0: lo + i * step, price1: lo + (i + 1) * step, volume };
    });
    return { buckets, maxVolume };
  }

  /** Volume Profile's buckets projected to pane-pixel space (y only - the
   * bars themselves are drawn relative to the drawing's own x1/x2 handles,
   * not a price coordinate). isPoc marks the Point of Control - the single
   * highest-volume row, TradingView's own name for it, conventionally
   * drawn distinct from the rest of the histogram. null if there's nothing
   * to draw (no candles in range, or every bucket landed off-screen). */
  function volumeProfilePixels(core, d) {
    const { buckets, maxVolume } = volumeProfileBuckets(core, d);
    if (!buckets.length || !maxVolume) return null;
    const pix = buckets
      .map((b) => ({
        y0: priceToCoordinateSafe(core, b.price0),
        y1: priceToCoordinateSafe(core, b.price1),
        volume: b.volume,
        isPoc: b.volume === maxVolume,
      }))
      .filter((b) => b.y0 != null && b.y1 != null);
    return pix.length ? { buckets: pix, maxVolume } : null;
  }

  /** A drawing's own properties.levels (edited via the Properties panel)
   * override the tool's built-in default set; null/empty means "unedited",
   * i.e. every fib placed before per-drawing levels existed. */
  function fibLevels(d, defaults) {
    const custom = d.properties.levels;
    return Array.isArray(custom) && custom.length ? custom : defaults;
  }
  /** TradingView's own "Reverse": swaps which anchor is treated as 0% vs
   * 100%, without moving either anchor point itself. */
  function fibRetracementPrice(d, level) {
    const [a, b] = d.properties.reverse ? [d.points[1], d.points[0]] : [d.points[0], d.points[1]];
    return a.price + (b.price - a.price) * level;
  }
  function fibExtensionBase(d) {
    return d.properties.reverse ? (d.points[0].price - d.points[1].price) : (d.points[1].price - d.points[0].price);
  }

  function defaultProperties(type) {
    const base = { color: theme.accent, width: 1, dash: "solid", opacity: 1, label: "", showPrice: false, visibleTimeframes: null };
    if (type === "rectangle" || type === "price_range" || type === "circle" || type === "time_range" || type === "parallel_channel" || type === "triangle" || type === "price_date_range" || type === "rotated_rectangle" || type === "flat_top_bottom" || type === "disjoint_channel" || type === "regression_trend") return Object.assign(base, { fill: true });
    // Highlighter: thick, translucent, round-capped stroke by default -
    // TradingView's own visual distinction from freehand's thin ink line.
    if (type === "highlighter") return Object.assign(base, { color: "#ffeb3b", width: 14, opacity: 0.35 });
    if (type === "long_position") return Object.assign(base, { color: theme.up, riskDistance: null, rewardDistance: null, stopOffsetPct: 1, takeOffsetPct: 2, quantity: 100 });
    if (type === "short_position") return Object.assign(base, { color: theme.down, stopOffsetPct: 1, takeOffsetPct: 2, quantity: 100 });
    if (type === "text") return Object.assign(base, { text: "Заметка" });
    if (type === "note") return Object.assign(base, { text: "Заметка", color: "#ffce54" });
    // levels: null means "use the tool's own default set" (FIB_RETRACEMENT_
    // LEVELS / FIB_EXTENSION_LEVELS below) - only a drawing whose levels the
    // user actually edited carries its own array, so every fib placed before
    // this existed keeps behaving exactly as before. reverse swaps which
    // anchor is 0% vs 100% (TradingView's own "Reverse"); extendLeft draws
    // each level line from the pane's left edge instead of from the anchor.
    if (type === "fib_retracement" || type === "fib_extension") return Object.assign(base, { color: theme.accent, levels: null, reverse: false, extendLeft: false });
    return base;
  }

  /** Linear interpolation of a trend line's price at an arbitrary time -
   * used by the parallel-channel tool to compute the offset line without
   * needing a third stored point pair. Callers already guard against a
   * zero-width line (p0.time === p1.time) being drawn in the first place. */
  function lerpPriceAtTime(p0, p1, time) {
    const span = p1.time - p0.time;
    if (!span) return p0.price;
    const t = (time - p0.time) / span;
    return p0.price + (p1.price - p0.price) * t;
  }

  /** Fib Channel's level-line endpoints (pane-pixel space): same 3-anchor
   * geometry parallel_channel already uses (anchor2's perpendicular price
   * offset from the anchor0-anchor1 line via lerpPriceAtTime), but instead
   * of just the two boundary lines, draws one segment per
   * fibLevels()/FIB_RETRACEMENT_LEVELS fraction of that offset -
   * anchor0-anchor1 itself is level 0, the parallel offset line is level
   * 1, every other level lerps between them. Segments span only
   * anchor0.time to anchor1.time (not extended to the pane edge),
   * matching parallel_channel's own scope. Shared by _hitDrawing and
   * _buildOp. [] if any anchor is off-screen. */
  function fibChannelSegments(core, d, pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null || !pix[2] || pix[2].x == null) return [];
    const offsetPrice = d.points[2].price - lerpPriceAtTime(d.points[0], d.points[1], d.points[2].time);
    const segs = [];
    for (const level of fibLevels(d, FIB_RETRACEMENT_LEVELS)) {
      const q0 = { time: d.points[0].time, price: d.points[0].price + offsetPrice * level };
      const q1 = { time: d.points[1].time, price: d.points[1].price + offsetPrice * level };
      const [p0, p1] = toPixels(core, [q0, q1]);
      if (p0?.x != null && p1?.x != null) segs.push({ x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, label: `${(level * 100).toFixed(1)}%`, level });
    }
    return segs;
  }

  /** Fib Wedge's level-line endpoints (pane-pixel space): anchor0 is the
   * wedge's shared vertex, anchor1/anchor2 its two diverging edges (same
   * 3-anchor placement as triangle/pitchfork). For each fibLevels()/
   * FIB_RETRACEMENT_LEVELS fraction L (L=0 skipped - it degenerates to a
   * single point at the vertex, nothing to draw), connects the point at
   * fraction L along anchor0->anchor1 to the point at fraction L along
   * anchor0->anchor2 - a narrowing series of connecting lines from the
   * vertex outward, the wedge's own Fibonacci silhouette. Shared by
   * _hitDrawing and _buildOp. [] if any anchor is off-screen. */
  function fibWedgeSegments(core, d, pix) {
    if (!pix[0] || pix[0].x == null || !pix[1] || pix[1].x == null || !pix[2] || pix[2].x == null) return [];
    const segs = [];
    for (const level of fibLevels(d, FIB_RETRACEMENT_LEVELS)) {
      if (!level) continue;
      const ax = pix[0].x + (pix[1].x - pix[0].x) * level, ay = pix[0].y + (pix[1].y - pix[0].y) * level;
      const bx = pix[0].x + (pix[2].x - pix[0].x) * level, by = pix[0].y + (pix[2].y - pix[0].y) * level;
      segs.push({ x1: ax, y1: ay, x2: bx, y2: by, label: `${(level * 100).toFixed(1)}%`, level });
    }
    return segs;
  }

  /** Flat Top/Bottom's flat boundary endpoints (model space, {time,price}):
   * same time span as anchor0->anchor1 (parallel_channel's own scope), but
   * held at a single constant price - anchor2's - rather than
   * parallel_channel's price-offset line, so this edge is genuinely
   * horizontal regardless of anchor2's own time. Shared by _hitDrawing and
   * _buildOp. */
  function flatBoundaryPoints(d) {
    return [
      { time: d.points[0].time, price: d.points[2].price },
      { time: d.points[1].time, price: d.points[2].price },
    ];
  }

  /** Trend Angle's on-screen slope in degrees, in the same pane-pixel
   * space every other on-screen angle in this file is computed in (arrow's
   * head orientation, gann_fan's ray ordering) - positive for a line that
   * rises left-to-right (screen y grows downward, hence the negation),
   * matching TradingView's own sign convention. Computed fresh from the
   * CURRENT pixel projection every render, never stored - the same reason
   * TradingView's own angle reading changes as you zoom/pan: it's a visual
   * angle on screen, not a fixed geometric property of the two anchors. */
  function trendAngleDegrees(p0, p1) {
    return (-Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
  }

  // TradingView's own default deviation multiplier for Regression Trend's
  // upper/lower channel bands.
  const REGRESSION_TREND_DEVIATIONS = 2;

  /** Regression Trend's mid/upper/lower boundary points (model space):
   * ordinary-least-squares linear regression of every candle's close whose
   * time falls within [min(anchor0.time,anchor1.time), max(...)] (order-
   * independent, same range scoping volumeProfileBuckets uses), plus
   * parallel bands at +-REGRESSION_TREND_DEVIATIONS standard deviations of
   * the regression residuals - TradingView's own definition of the tool.
   * Recomputed live from core.candles every call - never cached - the same
   * "always current, no separate update wiring" principle
   * anchoredVwapSeries/cyclicLineTimes/volumeProfileBuckets already use.
   * null if the range holds fewer than 2 candles (no meaningful
   * regression) or spans a single timestamp (would divide by zero). */
  function regressionTrendChannel(core, d) {
    const candles = core.candles || [];
    if (candles.length < 2) return null;
    const t0 = Math.min(d.points[0].time, d.points[1].time);
    const t1 = Math.max(d.points[0].time, d.points[1].time);
    const inRange = candles.filter((c) => c.time >= t0 && c.time <= t1);
    if (inRange.length < 2) return null;
    const n = inRange.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const c of inRange) {
      sumX += c.time; sumY += c.close; sumXY += c.time * c.close; sumXX += c.time * c.time;
    }
    const denom = n * sumXX - sumX * sumX;
    if (!denom) return null;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    let sumSqResid = 0;
    for (const c of inRange) {
      const resid = c.close - (slope * c.time + intercept);
      sumSqResid += resid * resid;
    }
    const stddev = Math.sqrt(sumSqResid / n);
    const mid = [
      { time: t0, price: slope * t0 + intercept },
      { time: t1, price: slope * t1 + intercept },
    ];
    const offset = stddev * REGRESSION_TREND_DEVIATIONS;
    return {
      mid,
      upper: mid.map((p) => ({ time: p.time, price: p.price + offset })),
      lower: mid.map((p) => ({ time: p.time, price: p.price - offset })),
    };
  }

  /** regressionTrendChannel()'s three boundaries projected to pane-pixel
   * space, each a possibly-shorter-than-2 array (a boundary with only one
   * endpoint currently resolvable isn't drawable) - null propagates
   * straight through when the underlying regression itself is null (too
   * little data in range). */
  function regressionTrendPixels(core, d) {
    const ch = regressionTrendChannel(core, d);
    if (!ch) return null;
    const proj = (pts) => toPixels(core, pts).filter((p) => p.x != null && p.y != null);
    return { mid: proj(ch.mid), upper: proj(ch.upper), lower: proj(ch.lower) };
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  /** Canvas setLineDash() pattern for the Properties panel's "стиль линии"
   * field - values match what the panel's <select> writes to
   * d.properties.dash ("solid" is the pre-existing default from
   * defaultProperties() and was already being stored, just never read by
   * the renderer until now). */
  function dashPattern(style) {
    if (style === "dashed") return [7, 5];
    if (style === "dotted") return [2, 4];
    return [];
  }

  /** Human-readable span for the time-range tool's label - picks the
   * coarsest unit that keeps the number readable (days once it's >=1 day,
   * otherwise hours/minutes), matching how the rest of the app formats
   * durations (e.g. RealtimeIndicator's fmtDelay). */
  function fmtDuration(seconds) {
    if (seconds < 3600) return `${Math.round(seconds / 60)} мин.`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} ч.`;
    return `${(seconds / 86400).toFixed(1)} дн.`;
  }

  // ------------------------------------------------------------- geometry --

  /** True if (px,py) is inside (or on) the triangle (x1,y1)-(x2,y2)-(x3,y3),
   * via the standard same-sign-barycentric test. Used so clicking anywhere
   * inside a filled triangle selects it, matching rectangle/circle's
   * filled-interior hit-testing rather than only the 3 edges. */
  function pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
    const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
    const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
    const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function finite(value) {
    return Number.isFinite(value);
  }

  function finitePoint(point) {
    return !!point
      && (point.time == null || finite(point.time))
      && (point.price == null || finite(point.price));
  }

  /**
   * Drawings use continuous logical coordinates while a pointer is moving.
   * Lightweight Charts' public time conversion may return null outside the
   * plotted range (and timeToCoordinate may return null for a timestamp that
   * is between real bars), so time<->logical interpolation is owned here.
   * The stored model stays {time, price}; logical values are transient only.
   */
  function timeToLogical(core, time) {
    if (!finite(time)) return null;
    const candles = (core && core.candles) || [];
    if (!candles.length) return time;
    if (candles.length === 1) return time === candles[0].time ? 0 : (time - candles[0].time);

    let lo = 0, hi = candles.length - 1;
    if (time <= candles[0].time) {
      const span = candles[1].time - candles[0].time;
      return span ? (time - candles[0].time) / span : 0;
    }
    if (time >= candles[hi].time) {
      const span = candles[hi].time - candles[hi - 1].time;
      return span ? hi + (time - candles[hi].time) / span : hi;
    }
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= time) lo = mid; else hi = mid;
    }
    const span = candles[hi].time - candles[lo].time;
    return span ? lo + (time - candles[lo].time) / span : lo;
  }

  function logicalToTime(core, logical) {
    if (!finite(logical)) return null;
    const candles = (core && core.candles) || [];
    if (!candles.length) return logical;
    if (candles.length === 1) return candles[0].time + logical;
    const last = candles.length - 1;
    if (logical <= 0) {
      const span = candles[1].time - candles[0].time;
      return candles[0].time + logical * (span || 1);
    }
    if (logical >= last) {
      const span = candles[last].time - candles[last - 1].time;
      return candles[last].time + (logical - last) * (span || 1);
    }
    const left = Math.floor(logical);
    const right = Math.min(last, left + 1);
    const frac = logical - left;
    return candles[left].time + (candles[right].time - candles[left].time) * frac;
  }

  function logicalCoordinatePair(core) {
    const ts = core && core.chart && core.chart.timeScale && core.chart.timeScale();
    if (!ts) return null;
    let range = null;
    if (typeof ts.getVisibleLogicalRange === "function") {
      try { range = ts.getVisibleLogicalRange(); } catch (err) { range = null; }
    }
    if (range && finite(range.from) && finite(range.to) && range.to !== range.from
      && typeof ts.logicalToCoordinate === "function") {
      const l1 = range.from + (range.to - range.from) * 0.25;
      const l2 = range.from + (range.to - range.from) * 0.75;
      let x1 = null, x2 = null;
      try { x1 = ts.logicalToCoordinate(l1); x2 = ts.logicalToCoordinate(l2); } catch (err) { /* fallback below */ }
      if (finite(x1) && finite(x2) && x2 !== x1) return { l1, l2, x1, x2, range };
    }
    return range && finite(range.from) && finite(range.to) && range.to !== range.from
      ? { range }
      : null;
  }

  function coordinateToLogicalSafe(core, x) {
    if (!finite(x)) return null;
    const ts = core.chart.timeScale();
    if (typeof ts.coordinateToLogical === "function") {
      try {
        const direct = ts.coordinateToLogical(x);
        if (finite(direct)) return direct;
      } catch (err) { /* use the boundary-safe fallbacks */ }
    }
    if (typeof ts.coordinateToTime === "function") {
      try {
        const time = ts.coordinateToTime(x);
        if (finite(time)) {
          const logical = timeToLogical(core, time);
          if (finite(logical)) return logical;
        }
      } catch (err) { /* use the boundary-safe fallbacks */ }
    }
    const pair = logicalCoordinatePair(core);
    if (pair && finite(pair.x1) && finite(pair.x2)) {
      return pair.l1 + (x - pair.x1) * (pair.l2 - pair.l1) / (pair.x2 - pair.x1);
    }
    if (pair && pair.range) {
      const width = core.container && core.container.clientWidth;
      if (finite(width) && width > 0) {
        return pair.range.from + (x / width) * (pair.range.to - pair.range.from);
      }
    }
    // Runtime tests and data-less charts use identity conversions. This is a
    // safe last resort only when there is no candle domain to interpolate.
    return ((core.candles || []).length === 0) ? x : null;
  }

  function logicalToCoordinateSafe(core, logical) {
    if (!finite(logical)) return null;
    const ts = core.chart.timeScale();
    if (typeof ts.logicalToCoordinate === "function") {
      try {
        const direct = ts.logicalToCoordinate(logical);
        if (finite(direct)) return direct;
      } catch (err) { /* use the boundary-safe fallbacks */ }
    }
    const pair = logicalCoordinatePair(core);
    if (pair && finite(pair.x1) && finite(pair.x2)) {
      return pair.x1 + (logical - pair.l1) * (pair.x2 - pair.x1) / (pair.l2 - pair.l1);
    }
    if (pair && pair.range) {
      const width = core.container && core.container.clientWidth;
      if (finite(width) && width > 0) {
        return (logical - pair.range.from) / (pair.range.to - pair.range.from) * width;
      }
    }
    return ((core.candles || []).length === 0) ? logical : null;
  }

  function coordinateToPriceSafe(core, y) {
    if (!finite(y)) return null;
    const series = core.candleSeries;
    try {
      const direct = series.coordinateToPrice(y);
      if (finite(direct)) return direct;
    } catch (err) { /* extrapolate from valid pane samples */ }

    const height = core.container && core.container.clientHeight;
    if (!finite(height) || height <= 0) return null;
    const sample = (yy) => {
      try {
        const price = series.coordinateToPrice(yy);
        return finite(price) ? price : null;
      } catch (err) { return null; }
    };
    const pad = Math.max(1, Math.min(24, height / 4));
    let y1, y2;
    if (y < 0) { y1 = 0; y2 = pad; }
    else if (y > height) { y1 = height - pad; y2 = height; }
    else { y1 = height * 0.25; y2 = height * 0.75; }
    const p1 = sample(y1), p2 = sample(y2);
    if (!finite(p1) || !finite(p2) || y2 === y1) return null;
    return p1 + (y - y1) * (p2 - p1) / (y2 - y1);
  }

  function priceToCoordinateSafe(core, price) {
    if (!finite(price)) return null;
    const series = core.candleSeries;
    try {
      const direct = series.priceToCoordinate(price);
      if (finite(direct)) return direct;
    } catch (err) { /* invert valid pane samples */ }

    const height = core.container && core.container.clientHeight;
    if (!finite(height) || height <= 0) return null;
    const sample = (yy) => {
      try {
        const p = series.coordinateToPrice(yy);
        return finite(p) ? p : null;
      } catch (err) { return null; }
    };
    const candidates = [[0, Math.min(height, 24)], [height * 0.25, height * 0.75], [Math.max(0, height - 24), height]];
    for (const [y1, y2] of candidates) {
      const p1 = sample(y1), p2 = sample(y2);
      if (!finite(p1) || !finite(p2) || p2 === p1) continue;
      return y1 + (price - p1) * (y2 - y1) / (p2 - p1);
    }
    return null;
  }

  function pointerToDrawingCoordinate(core, x, y) {
    if (!finite(x) || !finite(y)) return null;
    const logical = coordinateToLogicalSafe(core, x);
    const price = coordinateToPriceSafe(core, y);
    if (!finite(logical) || !finite(price)) return null;
    const time = logicalToTime(core, logical);
    return finite(time) ? { logical, time, price } : null;
  }

  function timeToCoordinateSafe(core, time) {
    if (!finite(time)) return null;
    const ts = core.chart.timeScale();
    if (typeof ts.timeToCoordinate === "function") {
      try {
        const direct = ts.timeToCoordinate(time);
        if (finite(direct)) return direct;
      } catch (err) { /* map through logical space */ }
    }
    const logical = timeToLogical(core, time);
    return finite(logical) ? logicalToCoordinateSafe(core, logical) : null;
  }

  /** Converts model points to continuous pixel coordinates, including points outside the viewport. */
  function toPixels(core, points) {
    return points.map((p) => ({
      x: p && p.time != null ? timeToCoordinateSafe(core, p.time) : null,
      y: p && p.price != null ? priceToCoordinateSafe(core, p.price) : null,
    }));
  }

  /** The DrawingLayerPrimitive paints on the *main pane's own canvas* -
   * which does not extend under the price-scale gutter (right) or
   * time-scale strip (bottom) - even though core.container.clientWidth/
   * clientHeight cover the whole chart host, gutter and strip included.
   * Any drawing that "extends to the edge" (ray, extended_line, the
   * Fibonacci tools' level lines, a time_range's full-height box, a
   * horizontal_ray) needs to clip against *this*, not the container's raw
   * size - clipping against the container silently draws part of the
   * shape past the pane canvas's own boundary, which is simply never
   * rendered there (confirmed directly: a ray anchored near the right
   * edge measurably extended past the pane canvas's actual pixel width).
   * Whatever anchor sits well inside the pane still looks fine either way,
   * which is why this went unnoticed - only the portion reaching toward
   * the gutter/strip was ever affected. */
  function paneWidth(core) {
    const total = (core.container && core.container.clientWidth) || 0;
    let gutter = 0;
    try { gutter = core.chart.priceScale("right").width() || 0; } catch (err) { /* use 0 */ }
    return Math.max(0, total - gutter);
  }
  function paneHeight(core) {
    const total = (core.container && core.container.clientHeight) || 0;
    let timeAxis = 0;
    try { timeAxis = core.chart.timeScale().height() || 0; } catch (err) { /* use 0 */ }
    return Math.max(0, total - timeAxis);
  }

  /** Liang-Barsky clipping for a segment, ray or infinite line. Model geometry is never clamped. */
  function clipParametricLineToRect(p0, p1, width, height, mode) {
    if (!p0 || !p1 || !finite(p0.x) || !finite(p0.y) || !finite(p1.x) || !finite(p1.y)
      || !finite(width) || !finite(height) || width < 0 || height < 0) return null;
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    if (dx === 0 && dy === 0) {
      return p0.x >= 0 && p0.x <= width && p0.y >= 0 && p0.y <= height
        ? { x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y }
        : null;
    }
    let tMin = mode === "line" ? -Infinity : 0;
    let tMax = mode === "segment" ? 1 : Infinity;
    const p = [-dx, dx, -dy, dy];
    const q = [p0.x, width - p0.x, p0.y, height - p0.y];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return null;
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) tMin = Math.max(tMin, t);
      else tMax = Math.min(tMax, t);
      if (tMin > tMax) return null;
    }
    if (!finite(tMin) || !finite(tMax)) return null;
    return {
      x1: p0.x + tMin * dx,
      y1: p0.y + tMin * dy,
      x2: p0.x + tMax * dx,
      y2: p0.y + tMax * dy,
    };
  }

  // --------------------------------------------------------------- drawing --

  class DrawingManager {
    constructor(chartCore) {
      this.core = chartCore;
      this.chart = chartCore.chart;
      this.series = chartCore.candleSeries;
      this.drawings = [];
      // Multiselect (ТЗ "Multiselect (Ctrl/Cmd click), Grouping объектов"):
      // selectedIds is the real state now, insertion-ordered. selectedId
      // below is a compatibility accessor - every pre-multiselect call site
      // (addDrawing/removeDrawing/undo/redo/loadDrawings/hitTest/
      // selectionAnchor and both chart-analysis.js/chart-tile.js) keeps
      // reading/assigning `this.selectedId`/`dm.selectedId` exactly as
      // before and gets single-selection behavior unchanged; only the new
      // multiselect-aware call sites (select()'s additive option, the
      // group-drag branch in _applyDrag, the *Selection() methods below)
      // touch selectedIds directly.
      this.selectedIds = new Set();
      this.hoverId = null;
      this.activeTool = null;
      this.draft = null;
      this.magnetMode = "off";
      // Per-tool-type {color,width,dash,opacity} the app layer can seed
      // (see chart-analysis.js's "Сделать стилем по умолчанию" button and
      // its localStorage-backed moexlab_tool_style_defaults) - applied in
      // addDrawing() below new drawings' own defaultProperties() but above
      // an explicit `properties` argument, so a user's saved style becomes
      // the starting point for every new drawing of that tool without this
      // engine module knowing anything about localStorage itself.
      this.styleOverrides = {};
      // Set by ChartTile whenever the tile's timeframe changes (see
      // setTimeframe() in chart-tile.js) - read by _buildOp's "видимость на
      // таймфреймах" filter above. null means "not tracked yet"; a drawing
      // with no visibleTimeframes restriction still paints regardless.
      this.currentTimeframe = null;
      this._undoStack = [];
      this._redoStack = [];
      this._listeners = new Set();
      this._dragState = null;
      this._pointerInside = false;
      this.interactionState = INTERACTION_STATES.NAVIGATE;
      this.keepDrawing = false;
      this._pointerSession = null;
      this._emptyPointerTap = null;
      this._lastDrawingTap = null;
      this._draftPreviewPoint = null;
      this._domCleanup = null;
      this._baseTouchAction = "";
      this._chartNavigationLocked = false;
      // Touch Events are deliberately NOT a second interaction pipeline.
      // This set only remembers which native Safari touch sequence started on
      // a drawing/handle so touchstart/touchmove can suppress page scrolling.
      // Pointer Events remain authoritative for selection, state, geometry,
      // history and persistence.
      this._ownedTouchIds = new Set();
      this._destroyed = false;

      this.primitive = new DrawingLayerPrimitive(this);
      this.series.attachPrimitive(this.primitive);
      this._bindDom();
      this.onChange(() => this.primitive.requestUpdate());
    }

    /** Compatibility accessor - see the constructor's comment on
     * selectedIds. Reads the first (oldest-added) id in the set, which for
     * every single-selection call site is simply "the selected id" since
     * the set only ever holds one member there. */
    get selectedId() {
      return this.selectedIds.size ? this.selectedIds.values().next().value : null;
    }
    set selectedId(id) {
      this.selectedIds = new Set(id ? [id] : []);
    }

    // ---- tool lifecycle ----
    setTool(type) {
      if (this._pointerSession) this._endPointerSession({ rollback: true });
      this.activeTool = type || null;
      this.draft = null;
      this._draftPreviewPoint = null;
      this._dragState = null;
      this._emptyPointerTap = null;
      this._lastDrawingTap = null;
      this._syncInteractionMode();
      this._emit({ toolChanged: true });
    }

    cancelDraft() {
      if (this._pointerSession) this._endPointerSession({ rollback: true });
      this.draft = null;
      this._draftPreviewPoint = null;
      this._lastDrawingTap = null;
      this._syncInteractionMode();
      this._emit({ draftCanceled: true });
    }

    // ---- CRUD (with undo/redo) ----
    _snapshot() {
      return JSON.stringify(this.drawings);
    }

    _pushHistory(before) {
      this._undoStack.push(before);
      if (this._undoStack.length > 100) this._undoStack.shift();
      this._redoStack = [];
    }

    addDrawing(type, points, properties) {
      const before = this._snapshot();
      const d = {
        id: uid(),
        type,
        points: points.map((p) => ({ time: p.time ?? null, price: p.price ?? null })),
        properties: Object.assign(defaultProperties(type), this.styleOverrides[type] || {}, properties || {}),
        locked: false,
        hidden: false,
        zIndex: this.drawings.length,
      };
      this.drawings.push(d);
      this._pushHistory(before);
      this.selectedId = d.id;
      this._syncInteractionMode();
      this._emit({ created: d.id });
      return d;
    }

    updateDrawing(id, patch) {
      const d = this.drawings.find((x) => x.id === id);
      if (!d) return;
      const before = this._snapshot();
      if (patch.points) d.points = patch.points;
      if (patch.properties) d.properties = Object.assign({}, d.properties, patch.properties);
      if ("locked" in patch) d.locked = patch.locked;
      if ("hidden" in patch) d.hidden = patch.hidden;
      if ("zIndex" in patch) d.zIndex = patch.zIndex;
      this._pushHistory(before);
      this._emit({ updated: id });
    }

    removeDrawing(id) {
      const before = this._snapshot();
      const removedDrawing = this.drawings.find((d) => d.id === id);
      this.drawings = this.drawings.filter((d) => d.id !== id);
      // .delete(), not the old "if it was THE selection, clear it" check -
      // with multiselect this id may be one of several selected, and the
      // others must stay selected.
      this.selectedIds.delete(id);
      this._syncInteractionMode();
      this._pushHistory(before);
      // The removed drawing's _backendId travels in the event because it's
      // about to be gone from this.drawings - the listener (ChartTile,
      // chart-tile.js) needs it to actually delete the backend row, and
      // can't look it up afterward.
      this._emit({ removed: id, removedBackendId: removedDrawing && removedDrawing._backendId });
    }

    duplicateDrawing(id) {
      const d = this.drawings.find((x) => x.id === id);
      if (!d) return;
      const offset = 20; // px worth of time, approximated below via a small bar shift
      const points = d.points.map((p) => ({ time: p.time, price: p.price }));
      const copy = this.addDrawing(d.type, points, JSON.parse(JSON.stringify(d.properties)));
      return copy;
    }

    /** What clicking `id` should actually select: just itself if
     * ungrouped, or every drawing sharing its properties.groupId if
     * grouped - TradingView's own behavior (clicking any one member of a
     * group selects the whole group). Shared by select() below and
     * duplicateSelection()'s remap logic doesn't need this - it works from
     * the already-resolved selectedIds instead. */
    _selectionUnit(id) {
      const d = this.drawings.find((x) => x.id === id);
      const gid = d && d.properties && d.properties.groupId;
      if (!gid) return [id];
      return this.drawings.filter((x) => x.properties && x.properties.groupId === gid).map((x) => x.id);
    }

    /** additive (Ctrl/Cmd-click, see _onPointerDown) toggles this id's
     * selection unit in/out of the existing selection instead of replacing
     * it; a non-additive click always replaces. A grouped id's "unit" is
     * every member of its group (_selectionUnit above), so both the toggle
     * and the replace operate on the whole group at once, never a lone
     * member. */
    select(id, { additive = false } = {}) {
      if (!id) {
        this.selectedIds = new Set();
      } else {
        const unit = this._selectionUnit(id);
        if (additive) {
          const next = new Set(this.selectedIds);
          const allPresent = unit.every((uid_) => next.has(uid_));
          unit.forEach((uid_) => (allPresent ? next.delete(uid_) : next.add(uid_)));
          this.selectedIds = next;
        } else {
          this.selectedIds = new Set(unit);
        }
      }
      if (!this.activeTool && !this._pointerSession) this._syncInteractionMode();
      this._emit();
    }

    /** Duplicates every currently selected drawing (Ctrl/Cmd+D with
     * multiselect - see _onKeyDown) and selects the new copies, mirroring
     * TradingView's own "duplicate selection" result. A duplicated group
     * becomes its own new group (remapped to a fresh id per distinct
     * source groupId) rather than merging into the original group - a
     * plain per-id duplicateDrawing() loop would silently do the latter,
     * since properties (groupId included) are copied verbatim. */
    duplicateSelection() {
      const ids = [...this.selectedIds];
      if (!ids.length) return [];
      const groupRemap = new Map();
      const copies = [];
      for (const id of ids) {
        const src = this.drawings.find((x) => x.id === id);
        if (!src) continue;
        const copy = this.duplicateDrawing(id);
        if (!copy) continue;
        const gid = src.properties && src.properties.groupId;
        if (gid) {
          if (!groupRemap.has(gid)) groupRemap.set(gid, uid());
          copy.properties = Object.assign({}, copy.properties, { groupId: groupRemap.get(gid) });
        }
        copies.push(copy);
      }
      this.selectedIds = new Set(copies.map((c) => c.id));
      this._emit({ updated: copies.map((c) => c.id) });
      return copies;
    }

    /** Assigns a fresh groupId (stored in properties, same opaque JSON blob
     * every other per-drawing style already persists through - no backend
     * schema change needed) to every currently selected drawing, so a
     * later click on any one of them selects them all (_selectionUnit
     * above) and a whole-object drag on any one moves them all together
     * (_applyDrag's group-drag branch). No-op under 2 selected - grouping
     * a single object isn't meaningful. One history entry for the whole
     * operation, not one per drawing. */
    groupSelection() {
      const ids = [...this.selectedIds];
      if (ids.length < 2) return;
      const before = this._snapshot();
      const gid = uid();
      for (const id of ids) {
        const d = this.drawings.find((x) => x.id === id);
        if (d) d.properties = Object.assign({}, d.properties, { groupId: gid });
      }
      this._pushHistory(before);
      this._emit({ updated: ids });
    }

    /** Clears groupId from every currently selected drawing that has one -
     * a selection spanning several different groups (or a mix of grouped
     * and ungrouped) ungroups all of them at once, not just the "primary"
     * one. No history entry (and no re-render trigger) if nothing in the
     * selection was actually grouped. */
    ungroupSelection() {
      const ids = [...this.selectedIds];
      if (!ids.length) return;
      const before = this._snapshot();
      let changed = false;
      for (const id of ids) {
        const d = this.drawings.find((x) => x.id === id);
        if (d && d.properties && d.properties.groupId) {
          const props = Object.assign({}, d.properties);
          delete props.groupId;
          d.properties = props;
          changed = true;
        }
      }
      if (changed) { this._pushHistory(before); this._emit({ updated: ids }); }
    }

    undo() {
      if (!this._undoStack.length) return;
      const before = this._undoStack.pop();
      this._redoStack.push(this._snapshot());
      this.drawings = JSON.parse(before);
      this.selectedId = null;
      this._syncInteractionMode();
      this._emit({ history: true });
    }

    redo() {
      if (!this._redoStack.length) return;
      const next = this._redoStack.pop();
      this._undoStack.push(this._snapshot());
      this.drawings = JSON.parse(next);
      this.selectedId = null;
      this._syncInteractionMode();
      this._emit({ history: true });
    }

    onChange(cb) {
      this._listeners.add(cb);
      return () => this._listeners.delete(cb);
    }

    _emit(detail) {
      this._listeners.forEach((cb) => cb(this, detail || {}));
    }

    /** Fires every real pane redraw (see DrawingLayerPrimitive.updateAllViews)
     * - much more frequent than onChange, and deliberately separate from it:
     * the floating toolbar needs repositioning on pan/zoom/live-tick too,
     * none of which are a DrawingManager "change". */
    onViewUpdate(cb) {
      (this._viewUpdateListeners || (this._viewUpdateListeners = new Set())).add(cb);
      return () => this._viewUpdateListeners && this._viewUpdateListeners.delete(cb);
    }

    _notifyViewUpdate() {
      if (this._viewUpdateListeners) this._viewUpdateListeners.forEach((cb) => cb(this));
    }

    loadDrawings(rows) {
      this.drawings = rows.map((r) => ({
        id: r.id, type: r.type, points: r.points, properties: r.properties,
        locked: r.locked, hidden: r.hidden, zIndex: r.z_index || 0,
        // Without this, editing a drawing that was loaded (not created this
        // session) would find _backendId undefined in _persistDrawing and
        // POST a duplicate row instead of PATCHing the existing one - the
        // local `id` IS the backend row id for anything that came from
        // loadDrawings (see charts_db.py), same value, just also under the
        // name _persistDrawing actually checks for.
        _backendId: r.id,
      }));
      this._undoStack = []; this._redoStack = [];
      this.selectedId = null;
      this._syncInteractionMode();
      this._emit({ loaded: true });
    }

    // ---- hit testing ----
    hitTest(px, py, { pointerType = "mouse" } = {}) {
      const sorted = this.drawings.filter((d) => !d.hidden).sort((a, b) => b.zIndex - a.zIndex);
      const touch = pointerType === "touch";
      const hitOptions = {
        tol: touch ? TOUCH_HIT_TOLERANCE_PX : HIT_TOLERANCE_PX,
        handleRadius: touch ? TOUCH_HANDLE_HIT_RADIUS_PX : HANDLE_RADIUS_PX + 3,
      };
      // TradingView semantics: resize/edit handles belong only to the selected
      // object. An unselected object is first grabbed as a whole, even if the
      // initial finger-down happens exactly over one of its hidden anchors.
      // With multiselect, that only applies while exactly one object is
      // selected - a multi-object selection is whole-object-drag-only (see
      // _applyDrag's group-drag branch), so no member exposes resize
      // handles then, same as if nothing were selected.
      const singleSelected = this.selectedIds.size === 1 ? this.selectedId : null;
      if (singleSelected) {
        const sel = sorted.find((d) => d.id === singleSelected);
        if (sel) {
          const hit = this._hitDrawing(sel, px, py, Object.assign({ allowHandles: true }, hitOptions));
          if (hit) return hit;
        }
      }
      for (const d of sorted) {
        if (d.id === singleSelected) continue;
        const hit = this._hitDrawing(d, px, py, Object.assign({ allowHandles: false }, hitOptions));
        if (hit) return hit;
      }
      return null;
    }

    _hitDrawing(d, px, py, { tol = HIT_TOLERANCE_PX, handleRadius = HANDLE_RADIUS_PX + 3, allowHandles = true } = {}) {
      const pix = toPixels(this.core, d.points);
      const handleAt = (i) => allowHandles && pix[i] && pix[i].x != null && Math.hypot(px - pix[i].x, py - pix[i].y) <= handleRadius;

      switch (d.type) {
        case "horizontal_line": {
          if (pix[0] == null || pix[0].y == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          return Math.abs(py - pix[0].y) <= tol ? { id: d.id, handle: null } : null;
        }
        case "horizontal_ray": {
          if (pix[0] == null || pix[0].x == null || pix[0].y == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          return px >= pix[0].x - tol && Math.abs(py - pix[0].y) <= tol ? { id: d.id, handle: null } : null;
        }
        case "vertical_line": {
          if (pix[0] == null || pix[0].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          return Math.abs(px - pix[0].x) <= tol ? { id: d.id, handle: null } : null;
        }
        case "trend_line":
        case "trend_angle":
        case "arrow":
        case "ray":
        case "extended_line": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          let segment = { x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y };
          if (d.type === "ray" || d.type === "extended_line") {
            segment = clipParametricLineToRect(
              pix[0], pix[1], paneWidth(this.core), paneHeight(this.core),
              d.type === "ray" ? "ray" : "line",
            );
            if (!segment) return null;
          }
          return pointToSegmentDist(px, py, segment.x1, segment.y1, segment.x2, segment.y2) <= tol ? { id: d.id, handle: null } : null;
        }
        case "parallel_channel": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          if (pointToSegmentDist(px, py, pix[0].x, pix[0].y, pix[1].x, pix[1].y) <= tol) return { id: d.id, handle: null };
          const offsetPrice = d.points[2].price - lerpPriceAtTime(d.points[0], d.points[1], d.points[2].time);
          const q0 = { time: d.points[0].time, price: d.points[0].price + offsetPrice };
          const q1 = { time: d.points[1].time, price: d.points[1].price + offsetPrice };
          const [pq0, pq1] = toPixels(this.core, [q0, q1]);
          if (pq0.x != null && pq1.x != null && pointToSegmentDist(px, py, pq0.x, pq0.y, pq1.x, pq1.y) <= tol) return { id: d.id, handle: null };
          return null;
        }
        case "flat_top_bottom": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          if (pointToSegmentDist(px, py, pix[0].x, pix[0].y, pix[1].x, pix[1].y) <= tol) return { id: d.id, handle: null };
          const [fq0, fq1] = toPixels(this.core, flatBoundaryPoints(d));
          if (fq0.x != null && fq1.x != null && pointToSegmentDist(px, py, fq0.x, fq0.y, fq1.x, fq1.y) <= tol) return { id: d.id, handle: null };
          return null;
        }
        case "disjoint_channel": {
          if (pix.length < 4 || pix[0].x == null || pix[1].x == null || pix[2].x == null || pix[3].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          if (handleAt(3)) return { id: d.id, handle: 3 };
          if (pointToSegmentDist(px, py, pix[0].x, pix[0].y, pix[1].x, pix[1].y) <= tol) return { id: d.id, handle: null };
          if (pointToSegmentDist(px, py, pix[2].x, pix[2].y, pix[3].x, pix[3].y) <= tol) return { id: d.id, handle: null };
          return null;
        }
        case "regression_trend": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const ch = regressionTrendPixels(this.core, d);
          if (!ch) return null;
          for (const seg of [ch.mid, ch.upper, ch.lower]) {
            if (seg.length === 2 && pointToSegmentDist(px, py, seg[0].x, seg[0].y, seg[1].x, seg[1].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "rectangle":
        case "price_range":
        case "price_date_range":
        case "time_range": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const x1 = Math.min(pix[0].x, pix[1].x), x2 = Math.max(pix[0].x, pix[1].x);
          const y1 = d.type === "time_range" ? 0 : Math.min(pix[0].y, pix[1].y);
          const y2 = d.type === "time_range" ? paneHeight(this.core) : Math.max(pix[0].y, pix[1].y);
          return px >= x1 - tol && px <= x2 + tol && py >= y1 - tol && py <= y2 + tol ? { id: d.id, handle: null } : null;
        }
        case "triangle": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          if (pointInTriangle(px, py, pix[0].x, pix[0].y, pix[1].x, pix[1].y, pix[2].x, pix[2].y)) return { id: d.id, handle: null };
          const edges = [[0, 1], [1, 2], [2, 0]];
          for (const [a, b] of edges) {
            if (pointToSegmentDist(px, py, pix[a].x, pix[a].y, pix[b].x, pix[b].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "arrow_mark_up":
        case "arrow_mark_down":
        case "arrow_mark_left":
        case "arrow_mark_right": {
          if (pix[0] == null || pix[0].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          const c = arrowMarkBodyCenter(pix[0], d.type);
          return Math.hypot(px - c.x, py - c.y) <= ARROW_MARK_HIT_RADIUS_PX ? { id: d.id, handle: null } : null;
        }
        case "rotated_rectangle": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          const c = rotatedRectCorners(pix);
          if (!c) return null;
          if (pointInTriangle(px, py, c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y)) return { id: d.id, handle: null };
          if (pointInTriangle(px, py, c[0].x, c[0].y, c[2].x, c[2].y, c[3].x, c[3].y)) return { id: d.id, handle: null };
          for (let i = 0; i < 4; i++) {
            const a = c[i], b = c[(i + 1) % 4];
            if (pointToSegmentDist(px, py, a.x, a.y, b.x, b.y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "curve":
        case "arc": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          const samples = d.type === "curve" ? quadraticBezierSamples(pix[0], pix[2], pix[1]) : arcSamples(pix[0], pix[2], pix[1]);
          for (let i = 0; i < samples.length - 1; i++) {
            if (pointToSegmentDist(px, py, samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "double_curve": {
          if (pix.length < 4 || pix[0].x == null || pix[1].x == null || pix[2].x == null || pix[3].x == null) return null;
          for (let i = 0; i < 4; i++) if (handleAt(i)) return { id: d.id, handle: i };
          const samples = cubicBezierSamples(pix[0], pix[2], pix[3], pix[1]);
          for (let i = 0; i < samples.length - 1; i++) {
            if (pointToSegmentDist(px, py, samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "circle": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const cx = (pix[0].x + pix[1].x) / 2, cy = (pix[0].y + pix[1].y) / 2;
          const rx = Math.abs(pix[1].x - pix[0].x) / 2, ry = Math.abs(pix[1].y - pix[0].y) / 2;
          if (!rx || !ry) return null;
          // Inside the ellipse counts as a hit (matches rectangle's filled-box
          // behavior) rather than only the boundary ring.
          const norm = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
          return norm <= 1.15 ? { id: d.id, handle: null } : null;
        }
        case "polyline":
        case "freehand":
        case "highlighter":
        case "path":
        // XABCD/ABCD/Three Drives/Elliott Wave anchors are a plain zigzag
        // for hit-testing purposes - same "handle at any vertex, else
        // distance to any leg" test as polyline/freehand, just always a
        // fixed point count (6, 5, 4, or 6 again for Elliott impulse).
        case "xabcd_pattern":
        case "abcd_pattern":
        case "three_drives_pattern":
        case "elliott_impulse_wave":
        case "elliott_correction_wave": {
          if (pix.length < 2) return null;
          for (let i = 0; i < pix.length; i++) if (handleAt(i)) return { id: d.id, handle: i };
          for (let i = 0; i < pix.length - 1; i++) {
            if (pix[i].x == null || pix[i + 1].x == null) continue;
            if (pointToSegmentDist(px, py, pix[i].x, pix[i].y, pix[i + 1].x, pix[i + 1].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        // Triangle Pattern / Head & Shoulders: zigzag hit-test (as above)
        // plus their boundary line(s) - two converging/diverging sides for
        // Triangle Pattern, one neckline for Head & Shoulders (see
        // PATTERN_BOUNDARY_PAIRS).
        case "triangle_pattern":
        case "head_shoulders_pattern": {
          if (pix.length < 2) return null;
          for (let i = 0; i < pix.length; i++) if (handleAt(i)) return { id: d.id, handle: i };
          for (let i = 0; i < pix.length - 1; i++) {
            if (pix[i].x == null || pix[i + 1].x == null) continue;
            if (pointToSegmentDist(px, py, pix[i].x, pix[i].y, pix[i + 1].x, pix[i + 1].y) <= tol) return { id: d.id, handle: null };
          }
          for (const seg of patternBoundarySegments(this.core, pix, d.type)) {
            if (pointToSegmentDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "pitchfork":
        case "pitchfork_schiff":
        case "pitchfork_modified_schiff": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          for (const seg of pitchforkSegments(this.core, d, pix, PITCHFORK_VARIANT[d.type])) {
            if (pointToSegmentDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "gann_fan": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          for (const seg of gannSegments(this.core, d, pix)) {
            if (pointToSegmentDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "cyclic_lines": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const h = paneHeight(this.core);
          for (const x of cyclicLineXs(this.core, d)) {
            if (Math.abs(px - x) <= tol && py >= 0 && py <= h) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_time_zone": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const h = paneHeight(this.core);
          for (const m of fibTimeZoneMarks(this.core, d)) {
            if (Math.abs(px - m.x) <= tol && py >= 0 && py <= h) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_speed_resistance_fan": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          for (const seg of fibFanSegments(this.core, d, pix)) {
            if (pointToSegmentDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_circles": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const dist = Math.hypot(px - pix[0].x, py - pix[0].y);
          for (const ring of fibCircles(pix)) {
            if (Math.abs(dist - ring.radius) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_arcs": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          for (const arc of fibArcSamples(pix)) {
            for (let i = 0; i < arc.points.length - 1; i++) {
              if (pointToSegmentDist(px, py, arc.points[i].x, arc.points[i].y, arc.points[i + 1].x, arc.points[i + 1].y) <= tol) return { id: d.id, handle: null };
            }
          }
          return null;
        }
        case "trend_based_fib_time": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const h = paneHeight(this.core);
          for (const m of trendBasedFibTimeMarks(this.core, d)) {
            if (Math.abs(px - m.x) <= tol && py >= 0 && py <= h) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_channel": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          for (const seg of fibChannelSegments(this.core, d, pix)) {
            if (pointToSegmentDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_wedge": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          if (pointToSegmentDist(px, py, pix[0].x, pix[0].y, pix[1].x, pix[1].y) <= tol) return { id: d.id, handle: null };
          if (pointToSegmentDist(px, py, pix[0].x, pix[0].y, pix[2].x, pix[2].y) <= tol) return { id: d.id, handle: null };
          for (const seg of fibWedgeSegments(this.core, d, pix)) {
            if (pointToSegmentDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "sine_line": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const samples = sineLineSamples(pix);
          if (!samples) return null;
          for (let i = 0; i < samples.length - 1; i++) {
            if (pointToSegmentDist(px, py, samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_pitchfan": {
          if (pix.length < 3 || pix[0].x == null || pix[1].x == null || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          for (const seg of fibPitchfanSegments(this.core, d, pix)) {
            if (pointToSegmentDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_spiral": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const samples = fibSpiralSamples(pix);
          if (!samples) return null;
          for (let i = 0; i < samples.length - 1; i++) {
            if (pointToSegmentDist(px, py, samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "anchored_vwap": {
          if (pix[0] == null || pix[0].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          const vwapPix = anchoredVwapPixels(this.core, d);
          for (let i = 0; i < vwapPix.length - 1; i++) {
            if (pointToSegmentDist(px, py, vwapPix[i].x, vwapPix[i].y, vwapPix[i + 1].x, vwapPix[i + 1].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "volume_profile": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const profile = volumeProfilePixels(this.core, d);
          if (!profile) return null;
          const x1 = Math.min(pix[0].x, pix[1].x), x2 = Math.max(pix[0].x, pix[1].x);
          let yTop = Infinity, yBottom = -Infinity;
          for (const b of profile.buckets) {
            yTop = Math.min(yTop, b.y0, b.y1);
            yBottom = Math.max(yBottom, b.y0, b.y1);
          }
          return px >= x1 - tol && px <= x2 + tol && py >= yTop - tol && py <= yBottom + tol ? { id: d.id, handle: null } : null;
        }
        case "text":
        case "note": {
          if (pix[0] == null || pix[0].x == null) return null;
          const box = d._lastBox;
          if (box && px >= box.x1 - tol && px <= box.x2 + tol && py >= box.y1 - tol && py <= box.y2 + tol) return { id: d.id, handle: null };
          return handleAt(0) ? { id: d.id, handle: 0 } : null;
        }
        case "fib_retracement": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const x1 = d.properties.extendLeft ? 0 : Math.min(pix[0].x, pix[1].x);
          const x2 = paneWidth(this.core);
          for (const level of fibLevels(d, FIB_RETRACEMENT_LEVELS)) {
            const price = fibRetracementPrice(d, level);
            const y = priceToCoordinateSafe(this.core, price);
            if (y != null && px >= x1 - tol && px <= x2 && Math.abs(py - y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_extension": {
          if (pix.length < 3 || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          const x1 = d.properties.extendLeft ? 0 : pix[2].x;
          const x2 = paneWidth(this.core);
          const base = fibExtensionBase(d);
          for (const level of fibLevels(d, FIB_EXTENSION_LEVELS)) {
            const price = d.points[2].price + base * level;
            const y = priceToCoordinateSafe(this.core, price);
            if (y != null && px >= x1 - tol && px <= x2 && Math.abs(py - y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "long_position":
        case "short_position": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          const x1 = Math.min(pix[0].x, pix[1].x), x2 = Math.max(pix[0].x, pix[1].x);
          const entryY = pix[0].y;
          const stopY = priceToCoordinateSafe(this.core, positionStopPrice(d));
          const takeY = priceToCoordinateSafe(this.core, positionTakePrice(d));
          if (allowHandles && Math.hypot(px - x1, py - entryY) <= handleRadius) return { id: d.id, handle: "start" };
          if (allowHandles && Math.hypot(px - x2, py - entryY) <= handleRadius) return { id: d.id, handle: "end" };
          if (allowHandles && stopY != null && Math.hypot(px - (x1 + x2) / 2, py - stopY) <= handleRadius) return { id: d.id, handle: "stop" };
          if (allowHandles && takeY != null && Math.hypot(px - (x1 + x2) / 2, py - takeY) <= handleRadius) return { id: d.id, handle: "take" };
          const yTop = Math.min(entryY, stopY ?? entryY, takeY ?? entryY);
          const yBottom = Math.max(entryY, stopY ?? entryY, takeY ?? entryY);
          return px >= x1 - tol && px <= x2 + tol && py >= yTop - tol && py <= yBottom + tol ? { id: d.id, handle: null } : null;
        }
        default:
          return null;
      }
    }

    // ---- snap ----
    // magnetMode: "off" | "weak" | "strong". TradingView distinguishes the
    // two - Strong always pulls an anchor onto the nearest OHLC value on the
    // bar under the pointer, Weak only pulls it in when the pointer is
    // already close (in screen space, not price space, so it behaves the
    // same at any zoom level) to a candidate value, otherwise the anchor
    // stays exactly where placed. Previously this was a single boolean
    // (effectively always "strong" when on), so there was no way to get
    // free placement near candles without disabling snapping everywhere.
    snapPoint(time, price) {
      if (this.magnetMode !== "weak" && this.magnetMode !== "strong") return { time, price };
      const candle = this._nearestCandle(time);
      if (!candle) return { time, price };
      const candidates = [candle.open, candle.high, candle.low, candle.close];
      let best = price, bestDist = Infinity;
      for (const c of candidates) {
        const d = Math.abs(c - price);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (this.magnetMode === "weak") {
        const yRaw = priceToCoordinateSafe(this.core, price);
        const yBest = priceToCoordinateSafe(this.core, best);
        if (yRaw == null || yBest == null || Math.abs(yRaw - yBest) > WEAK_MAGNET_SNAP_PX) return { time, price };
      }
      return { time: candle.time, price: best };
    }

    _nearestCandle(time) {
      const candles = this.core.candles;
      if (!candles.length) return null;
      let lo = 0, hi = candles.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candles[mid].time < time) lo = mid + 1; else hi = mid;
      }
      if (lo > 0 && Math.abs(candles[lo - 1].time - time) < Math.abs(candles[lo].time - time)) return candles[lo - 1];
      return candles[lo];
    }

    // ---- pixel <-> time/price helpers for callers (toolbar, properties panel) ----
    _pointerToDrawingCoordinate(px, py) {
      return pointerToDrawingCoordinate(this.core, px, py);
    }

    pixelToPoint(px, py) {
      const point = this._pointerToDrawingCoordinate(px, py);
      return point ? { time: point.time, price: point.price } : { time: null, price: null };
    }

    /** Screen-pixel anchor for the floating toolbar (ТЗ "Floating toolbar
     * при выборе"): the topmost model point across every selected drawing
     * (a single selection is just the n=1 case of the same reduction),
     * converted the same way the pane view converts every drawing's points
     * for painting (toPixels). Good enough for every tool type without
     * needing per-type bounding-box math - lines/rectangles/ranges/channels
     * all use their corner/anchor points as model points, so "topmost
     * point" already sits at or very near the shape's actual visual top.
     * horizontal_line/vertical_line only have one coordinate (no time or no
     * price respectively) - falls back to pane-center-x / near-top-y so the
     * toolbar still lands somewhere sane instead of null. */
    selectionAnchor() {
      const ids = [...this.selectedIds];
      if (!ids.length) return null;
      let top = null;
      for (const id of ids) {
        const d = this.drawings.find((x) => x.id === id);
        if (!d) continue;
        const both = toPixels(this.core, d.points).filter((p) => p && p.x != null && p.y != null);
        if (!both.length) continue;
        const candidate = both.reduce((t, p) => (p.y < t.y ? p : t));
        if (!top || candidate.y < top.y) top = candidate;
      }
      if (top) return top;
      // Every selected drawing's points are all one-axis-only
      // (horizontal_line/vertical_line) - same graceful degradation the
      // single-selection path always used, just against the first one that
      // has anything at all to fall back on.
      for (const id of ids) {
        const d = this.drawings.find((x) => x.id === id);
        if (!d) continue;
        const pix = toPixels(this.core, d.points);
        const withY = pix.find((p) => p && p.y != null);
        if (withY) return { x: paneWidth(this.core) / 2, y: withY.y };
        const withX = pix.find((p) => p && p.x != null);
        if (withX) return { x: withX.x, y: 40 };
      }
      return null;
    }

    /** Pane canvas size in the same pixel space as selectionAnchor()/
     * toPixels() - the floating toolbar clamps itself inside this, not
     * core.container's full clientWidth/Height (see paneWidth/paneHeight's
     * own doc comment above: the gutter/strip live outside the pane). */
    paneSize() { return { width: paneWidth(this.core), height: paneHeight(this.core) }; }

    // ---- Pointer Events interaction state machine ----
    _bindDom() {
      const el = this.core.container;
      el.style.position = el.style.position || "relative";
      el.tabIndex = el.tabIndex >= 0 ? el.tabIndex : 0;
      this._baseTouchAction = el.style.touchAction || "";

      const onPointerEnter = () => { this._pointerInside = true; };
      const onPointerLeave = () => { if (!this._pointerSession) this._pointerInside = false; };
      const onPointerDown = (e) => this._onPointerDown(e);
      const onPointerMove = (e) => this._onPointerMove(e);
      const onPointerUp = (e) => this._onPointerUp(e);
      const onPointerCancel = (e) => this._onPointerCancel(e);
      const onLostPointerCapture = (e) => this._onLostPointerCapture(e);
      const onTouchStart = (e) => this._onTouchStartGuard(e);
      const onTouchMove = (e) => this._onTouchMoveGuard(e);
      const onTouchEnd = (e) => this._onTouchEndGuard(e);
      const onDblClick = (e) => this._onDblClick(e);
      const onKeyDown = (e) => this._onKeyDown(e);

      el.addEventListener("pointerenter", onPointerEnter);
      el.addEventListener("pointerleave", onPointerLeave);
      el.addEventListener("pointerdown", onPointerDown, { capture: true });
      global.addEventListener("pointermove", onPointerMove, { capture: true });
      global.addEventListener("pointerup", onPointerUp, { capture: true });
      global.addEventListener("pointercancel", onPointerCancel, { capture: true });
      el.addEventListener("lostpointercapture", onLostPointerCapture);
      // Safari may latch native page scrolling before a pointerdown handler can
      // dynamically switch touch-action. These non-passive Touch Events do
      // browser-gesture suppression only; they never mutate drawing geometry.
      el.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
      global.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
      global.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
      global.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });
      el.addEventListener("dblclick", onDblClick);
      el.addEventListener("keydown", onKeyDown);

      this._domCleanup = () => {
        el.removeEventListener("pointerenter", onPointerEnter);
        el.removeEventListener("pointerleave", onPointerLeave);
        el.removeEventListener("pointerdown", onPointerDown, true);
        global.removeEventListener("pointermove", onPointerMove, true);
        global.removeEventListener("pointerup", onPointerUp, true);
        global.removeEventListener("pointercancel", onPointerCancel, true);
        el.removeEventListener("lostpointercapture", onLostPointerCapture);
        el.removeEventListener("touchstart", onTouchStart, true);
        global.removeEventListener("touchmove", onTouchMove, true);
        global.removeEventListener("touchend", onTouchEnd, true);
        global.removeEventListener("touchcancel", onTouchEnd, true);
        el.removeEventListener("dblclick", onDblClick);
        el.removeEventListener("keydown", onKeyDown);
        this._domCleanup = null;
      };
      this._syncInteractionMode();
    }

    _relXY(e) {
      const rect = this.core.container.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _eventTime(e) {
      return e && Number.isFinite(e.timeStamp) ? e.timeStamp : Date.now();
    }

    _touchHitOwnsGesture(touch) {
      if (!touch) return false;
      if (this.activeTool) return true;
      const pos = this._relXY(touch);
      return !!this.hitTest(pos.x, pos.y, { pointerType: "touch" });
    }

    _preventTouchDefault(e) {
      if (e && e.cancelable !== false && e.preventDefault) e.preventDefault();
    }

    _onTouchStartGuard(e) {
      const touches = Array.from((e && e.touches) || []);
      const changed = Array.from((e && e.changedTouches) || []);
      if (!changed.length) return;

      // Preserve chart pinch/zoom when a gesture starts as multi-touch on an
      // empty chart. Once one touch already belongs to a drawing, however,
      // the whole native sequence stays suppressed until that owned touch ends.
      if (!this._ownedTouchIds.size && touches.length > 1) return;

      for (const touch of changed) {
        const id = touch && touch.identifier;
        if (id == null || this._ownedTouchIds.has(id)) continue;
        if (!this._ownedTouchIds.size && this._touchHitOwnsGesture(touch)) {
          this._ownedTouchIds.add(id);
        }
      }
      if (this._ownedTouchIds.size) this._preventTouchDefault(e);
    }

    _onTouchMoveGuard(e) {
      if (!this._ownedTouchIds.size) return;
      const touches = Array.from((e && e.touches) || []);
      const changed = Array.from((e && e.changedTouches) || []);
      const belongsToDrawing = touches.concat(changed).some((touch) => touch && this._ownedTouchIds.has(touch.identifier));
      if (belongsToDrawing) this._preventTouchDefault(e);
    }

    _onTouchEndGuard(e) {
      const changed = Array.from((e && e.changedTouches) || []);
      for (const touch of changed) {
        if (touch && touch.identifier != null) this._ownedTouchIds.delete(touch.identifier);
      }
    }

    _clearTouchOwnership() {
      this._ownedTouchIds.clear();
    }

    _setInteractionState(next) {
      this.interactionState = next;
    }

    _setNavigationLocked(locked) {
      locked = !!locked;
      if (this._chartNavigationLocked === locked) return;
      this._chartNavigationLocked = locked;
      const el = this.core && this.core.container;
      if (el) el.style.touchAction = locked ? "none" : (this._baseTouchAction || "");
      if (this.chart && typeof this.chart.applyOptions === "function") {
        this.chart.applyOptions(locked
          ? { handleScroll: false, handleScale: false }
          : { handleScroll: true, handleScale: true });
      }
    }

    _syncInteractionMode() {
      const ownsGesture = !!(this._pointerSession && this._pointerSession.owned);
      this._setNavigationLocked(!!this.activeTool || ownsGesture);
      if (this._pointerSession) return;
      if (this.activeTool) this._setInteractionState(this.draft ? INTERACTION_STATES.PLACING : INTERACTION_STATES.TOOL_ARMED);
      else if (this.selectedId) this._setInteractionState(INTERACTION_STATES.SELECTED);
      else this._setInteractionState(INTERACTION_STATES.NAVIGATE);
    }

    _capturePointer(e) {
      const el = this.core.container;
      if (el.setPointerCapture) {
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* capture can fail during teardown */ }
      }
    }

    _releasePointer(pointerId) {
      const el = this.core && this.core.container;
      if (!el || pointerId == null || !el.releasePointerCapture) return;
      try { el.releasePointerCapture(pointerId); } catch (err) { /* already released */ }
    }

    _claimPointer(e, session) {
      this._pointerSession = Object.assign({
        pointerId: e.pointerId,
        pointerType: e.pointerType || "mouse",
        owned: true,
        startedAt: this._eventTime(e),
        moved: false,
      }, session || {});
      this._capturePointer(e);
      this._setNavigationLocked(true);
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }

    _rollbackPointerSession(session) {
      if (!session) return;
      if (session.kind === "create") {
        this.drawings = JSON.parse(session.drawingsBefore);
        this._undoStack = session.undoBefore.slice();
        this._redoStack = session.redoBefore.slice();
        this.draft = session.draftBefore ? JSON.parse(JSON.stringify(session.draftBefore)) : null;
        this.activeTool = session.activeToolBefore;
        this.selectedId = session.selectedBefore;
      } else if (session.kind === "edit" && session.drawingBefore) {
        const d = this.drawings.find((item) => item.id === session.drawingBefore.id);
        if (d) {
          d.points = JSON.parse(JSON.stringify(session.drawingBefore.points));
          d.properties = JSON.parse(JSON.stringify(session.drawingBefore.properties));
        }
      }
    }

    _endPointerSession({ rollback = false, emit = false } = {}) {
      const session = this._pointerSession;
      if (!session) return;
      this._pointerSession = null;
      if (rollback) this._rollbackPointerSession(session);
      this._dragState = null;
      this._draftPreviewPoint = null;
      this._releasePointer(session.pointerId);
      if (session.pointerType === "touch") this._clearTouchOwnership();
      this._syncInteractionMode();
      if (emit) this._emit({ pointerCanceled: rollback });
    }

    _isDoublePlacementTap(e, pos, def) {
      if (!def || def.completion !== "explicit" || !this.draft || this.draft.points.length < 2) return false;
      const prev = this._lastDrawingTap;
      if (!prev || prev.tool !== this.activeTool || prev.pointerType !== (e.pointerType || "mouse")) return false;
      const dt = this._eventTime(e) - prev.time;
      return dt >= 0 && dt <= DOUBLE_TAP_MS
        && Math.hypot(pos.x - prev.x, pos.y - prev.y) <= DOUBLE_TAP_PX;
    }

    _recordPlacementTap(e, pos, tool) {
      this._lastDrawingTap = {
        time: this._eventTime(e),
        x: pos.x,
        y: pos.y,
        tool,
        pointerType: e.pointerType || "mouse",
      };
    }

    _onPointerDown(e) {
      if (e.isPrimary === false || this._pointerSession) return;
      // The floating toolbar (chart-tile.js) is deliberately painted right
      // on top of the selected drawing's own anchor point, so a press on one
      // of its buttons lands at pixel coordinates that would otherwise
      // hit-test straight onto that same drawing below it - without this,
      // clicking e.g. "Удалить" would also claim the pointer for an edit/
      // drag session on the drawing an instant before the button's own
      // click handler removes it.
      if (e.target && e.target.closest && e.target.closest(".ca-float-toolbar")) return;
      const pos = this._relXY(e);

      if (this.activeTool) {
        const def = TOOL_DEFS[this.activeTool];
        const draftBefore = this.draft ? JSON.parse(JSON.stringify(this.draft)) : null;
        const anchorsBefore = draftBefore ? draftBefore.points.length : 0;
        const tool = this.activeTool;
        this._claimPointer(e, {
          kind: "create",
          tool,
          startX: pos.x,
          startY: pos.y,
          anchorsBefore,
          activeToolBefore: tool,
          selectedBefore: this.selectedId,
          draftBefore,
          drawingsBefore: this._snapshot(),
          undoBefore: this._undoStack.slice(),
          redoBefore: this._redoStack.slice(),
          provisionalIndex: null,
          completedByDoubleTap: false,
        });

        if (this._isDoublePlacementTap(e, pos, def)) {
          this._pointerSession.completedByDoubleTap = true;
          this._finishDraft();
          this._lastDrawingTap = null;
          return;
        }

        this._placePoint(pos.x, pos.y, { deferFinish: true });
        if (anchorsBefore > 0 && this.draft) {
          this._pointerSession.provisionalIndex = this.draft.points.length - 1;
        }
        this._setInteractionState(INTERACTION_STATES.PLACING);
        return;
      }

      const hit = this.hitTest(pos.x, pos.y, { pointerType: e.pointerType || "mouse" });
      if (hit) {
        const d = this.drawings.find((item) => item.id === hit.id);
        // Ctrl/Cmd-click toggles this object (or its whole group - see
        // _selectionUnit) in/out of the existing selection instead of
        // replacing it (ТЗ "Multiselect (Ctrl/Cmd click)"). A plain
        // (non-additive) mousedown on an object that's already part of the
        // current multi-selection must NOT collapse it down to just that
        // one - that's the gesture that starts a whole-group drag (see the
        // isGroupDrag check in _onPointerMove), and replacing the
        // selection here would zero out selectedIds.size before the drag
        // even begins, silently degrading it to a single-object drag.
        const additive = !!(e.ctrlKey || e.metaKey);
        const preserveMultiSelection = !additive && this.selectedIds.size > 1 && this.selectedIds.has(hit.id);
        if (!preserveMultiSelection) this.select(hit.id, { additive });
        this._claimPointer(e, {
          kind: d && !d.locked ? "edit" : "select",
          hit,
          startX: pos.x,
          startY: pos.y,
          historyBefore: this._snapshot(),
          drawingBefore: d ? {
            id: d.id,
            points: JSON.parse(JSON.stringify(d.points)),
            properties: JSON.parse(JSON.stringify(d.properties)),
          } : null,
        });
        return;
      }

      // Empty Cursor-mode gesture belongs to Lightweight Charts. We only keep
      // enough information to distinguish a stationary outside tap from pan.
      this._emptyPointerTap = {
        pointerId: e.pointerId,
        x: pos.x,
        y: pos.y,
        startedAt: this._eventTime(e),
      };
    }

    _movementThreshold(pointerType) {
      return pointerType === "touch" ? TOUCH_DRAG_THRESHOLD_PX : POINTER_DRAG_THRESHOLD_PX;
    }

    _updateDraftPointAt(index, x, y) {
      if (!this.draft || index == null || !this.draft.points[index]) return;
      const coordinate = this._pointerToDrawingCoordinate(x, y);
      if (!coordinate) return;
      let { time, price } = coordinate;
      ({ time, price } = this.snapPoint(time, price));
      if (!finite(time) || !finite(price)) return;
      this.draft.points[index] = { time, price };
      this._emit();
    }

    _onPointerMove(e) {
      const session = this._pointerSession;
      if (session && session.pointerId === e.pointerId) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        const pos = this._relXY(e);
        const distance = Math.hypot(pos.x - session.startX, pos.y - session.startY);
        if (distance > this._movementThreshold(session.pointerType)) session.moved = true;

        if (session.kind === "create") {
          const createDef = TOOL_DEFS[session.tool];
          if (createDef && createDef.completion === "drag-release") {
            // Freehand doesn't rubber-band a single next anchor like every
            // other tool - it appends a new point to the draft whenever the
            // pointer has moved far enough from the last sampled one.
            const last = session.freehandLastSample;
            if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) >= FREEHAND_SAMPLE_MIN_DIST_PX) {
              this._placePoint(pos.x, pos.y, { deferFinish: true });
              session.freehandLastSample = { x: pos.x, y: pos.y };
            }
            return;
          }
          if (session.provisionalIndex != null) this._updateDraftPointAt(session.provisionalIndex, pos.x, pos.y);
          else if (this.draft) {
            this._draftPreviewPoint = { x: pos.x, y: pos.y };
            this._emit();
          }
          return;
        }

        if (session.kind === "edit" && session.moved) {
          if (!this._dragState) {
            const d = this.drawings.find((item) => item.id === session.hit.id);
            if (!d) return;
            // Whole-object drag (no handle) on a member of a multi-object
            // selection moves every selected drawing together, not just
            // the one under the pointer - captures each member's own
            // pre-drag points here so _applyDrag can translate all of them
            // by the same delta. Handle-drag (resize) is always
            // single-object - hitTest never exposes handles while more
            // than one thing is selected (see its own comment).
            const isGroupDrag = session.hit.handle == null && this.selectedIds.size > 1 && this.selectedIds.has(session.hit.id);
            this._dragState = {
              id: session.hit.id,
              handle: session.hit.handle,
              startX: session.startX,
              startY: session.startY,
              startCoordinate: this._pointerToDrawingCoordinate(session.startX, session.startY),
              origPoints: JSON.parse(JSON.stringify(session.drawingBefore.points)),
              origProps: JSON.parse(JSON.stringify(session.drawingBefore.properties)),
              beforeSnapshot: session.historyBefore,
              groupOrigPoints: isGroupDrag ? new Map([...this.selectedIds].map((sid) => {
                const sd = this.drawings.find((x) => x.id === sid);
                return [sid, sd ? JSON.parse(JSON.stringify(sd.points)) : null];
              })) : null,
            };
            this._setInteractionState(session.hit.handle == null
              ? INTERACTION_STATES.DRAG_OBJECT
              : INTERACTION_STATES.DRAG_HANDLE);
          }
          this._applyDrag(pos.x, pos.y);
        }
        return;
      }

      const candidate = this._emptyPointerTap;
      if (candidate && candidate.pointerId === e.pointerId) {
        const pos = this._relXY(e);
        if (Math.hypot(pos.x - candidate.x, pos.y - candidate.y) > this._movementThreshold(e.pointerType || "mouse")) {
          this._emptyPointerTap = null;
        }
        return;
      }

      if ((e.pointerType || "mouse") === "mouse" && this._pointerInside) {
        const pos = this._relXY(e);
        const hit = this.hitTest(pos.x, pos.y);
        const nextHover = hit ? hit.id : null;
        if (nextHover !== this.hoverId) {
          this.hoverId = nextHover;
          this._emit({ hover: true });
        }
      }
    }

    _finishCreatePointer(e, session) {
      const pos = this._relXY(e);
      const def = TOOL_DEFS[session.tool];
      if (!def) return;

      if (session.completedByDoubleTap) return;

      if (def.completion === "drag-release") {
        // A real drag sampled >=2 points (see the _onPointerMove branch
        // above) and finishes normally; a plain click with no movement only
        // ever placed the one pointerdown point, which _finishDraft's own
        // guard refuses to turn into a drawing - cancelDraft() (not just
        // leaving it) so the tool stays cleanly armed for another attempt
        // instead of a dangling 1-point draft sitting around like an
        // unfinished polyline.
        if (this.draft && this.draft.points.length >= 2) this._finishDraft();
        else this.cancelDraft();
        return;
      }

      if (session.anchorsBefore === 0 && session.moved && def.dragStagePoints >= 2 && this.draft) {
        this._placePoint(pos.x, pos.y, { deferFinish: true });
      }

      if (def.anchorCount > 0 && this.draft && this.draft.points.length >= def.anchorCount) {
        this._finishDraft();
      } else if (def.completion === "explicit" && !session.moved && this.draft) {
        this._recordPlacementTap(e, pos, session.tool);
      } else if (def.completion !== "explicit") {
        this._lastDrawingTap = null;
      }
    }

    _finishEditPointer(session) {
      if (!this._dragState) return;
      const { id, groupOrigPoints } = this._dragState;
      const before = this._dragState.beforeSnapshot;
      // A group drag moved every member's points, not just id's - every
      // one of them needs its own persistence save (chart-tile.js's
      // _onDrawingsChanged), so `updated` carries the whole list instead
      // of the single id every other drag still uses.
      const updated = groupOrigPoints && groupOrigPoints.size > 1 ? [...groupOrigPoints.keys()] : id;
      this._dragState = null;
      if (before != null) this._pushHistory(before);
      this._emit({ updated, pointerDrag: true });
    }

    _onPointerUp(e) {
      const session = this._pointerSession;
      if (session && session.pointerId === e.pointerId) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        if (session.kind === "create") this._finishCreatePointer(e, session);
        else if (session.kind === "edit") this._finishEditPointer(session);
        this._endPointerSession();
        return;
      }

      const candidate = this._emptyPointerTap;
      if (!candidate || candidate.pointerId !== e.pointerId) return;
      const pos = this._relXY(e);
      if (this._eventTime(e) - candidate.startedAt <= TAP_MAX_MS
        && Math.hypot(pos.x - candidate.x, pos.y - candidate.y) <= this._movementThreshold(e.pointerType || "mouse")) {
        // Strong invariant: an empty-chart tap in Cursor mode only deselects.
        this.select(null);
      }
      this._emptyPointerTap = null;
    }

    _onPointerCancel(e) {
      const session = this._pointerSession;
      if (session && session.pointerId === e.pointerId) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        this._endPointerSession({ rollback: true, emit: true });
        return;
      }
      if (this._emptyPointerTap && this._emptyPointerTap.pointerId === e.pointerId) this._emptyPointerTap = null;
    }

    _onLostPointerCapture(e) {
      const session = this._pointerSession;
      if (session && session.pointerId === e.pointerId) this._endPointerSession({ rollback: true, emit: true });
    }

    _placePoint(x, y, { deferFinish = false } = {}) {
      const type = this.draft ? this.draft.type : this.activeTool;
      const def = TOOL_DEFS[type];
      if (!def) return null;
      const coordinate = this._pointerToDrawingCoordinate(x, y);
      if (!coordinate) return null;
      let { time, price } = coordinate;
      ({ time, price } = this.snapPoint(time, price));
      if (!finite(time) || !finite(price)) return null;
      this.draft = this.draft || { type, points: [] };
      this.draft.points.push({ time, price });
      this._draftPreviewPoint = null;
      this._setInteractionState(INTERACTION_STATES.PLACING);
      if (!deferFinish && def.anchorCount > 0 && this.draft.points.length >= def.anchorCount) {
        return this._finishDraft();
      }
      this._emit();
      return null;
    }

    _finishDraft() {
      if (!this.draft) return null;
      const def = TOOL_DEFS[this.draft.type];
      if (!def) return null;
      if ((def.completion === "explicit" || def.completion === "drag-release") && this.draft.points.length < 2) return null;
      if (def.anchorCount > 0 && this.draft.points.length < def.anchorCount) return null;

      // An ephemeral tool (currently only "measure") never creates a
      // drawing object or a history entry - the whole point is a
      // TradingView-style ruler that vanishes on release. Re-arm the same
      // tool immediately (ignoring keepDrawing, which doesn't apply here)
      // so the next drag can measure again without reselecting it.
      if (def.ephemeral) {
        const type = this.draft.type;
        this.draft = null;
        this._draftPreviewPoint = null;
        this.activeTool = type;
        this._syncInteractionMode();
        this._emit({ measured: true });
        return null;
      }

      const points = this.draft.points.map((point) => ({ time: point.time, price: point.price }));
      const type = this.draft.type;
      let properties;
      if (type === "long_position" || type === "short_position") properties = defaultProperties(type);
      if (type === "text" || type === "note") {
        properties = defaultProperties(type);
        this._setInteractionState(INTERACTION_STATES.TEXT_EDIT);
        if (typeof global.prompt === "function") {
          const next = global.prompt(type === "text" ? "Текст" : "Текст заметки", properties.text || "");
          if (next != null) properties.text = next;
        }
      }

      this.draft = null;
      this._draftPreviewPoint = null;
      this.activeTool = this.keepDrawing ? type : null;
      const drawing = this.addDrawing(type, points, properties);
      this._lastDrawingTap = null;
      this._syncInteractionMode();
      return drawing;
    }

    _translatePoints(origPoints, deltaLogical, deltaPrice, editAxis) {
      const translated = [];
      for (const point of origPoints) {
        let time = point.time, price = point.price;
        if (editAxis !== "price" && time != null) {
          const logical = timeToLogical(this.core, time);
          if (!finite(logical)) return null;
          time = logicalToTime(this.core, logical + deltaLogical);
        }
        if (editAxis !== "time" && price != null) price += deltaPrice;
        const next = { time, price };
        if (!finitePoint(next)) return null;
        translated.push(next);
      }
      return translated;
    }

    _applyDrag(x, y) {
      const { id, handle, origPoints, origProps, startCoordinate, groupOrigPoints } = this._dragState || {};
      if (!id) return;
      const d = this.drawings.find((dd) => dd.id === id);
      if (!d) return;
      const current = this._pointerToDrawingCoordinate(x, y);
      const start = startCoordinate || (this._dragState && this._pointerToDrawingCoordinate(this._dragState.startX, this._dragState.startY));
      // A transient conversion failure is a skipped preview frame, never a
      // geometry reset. The pointer session/state remains owned until up/cancel.
      if (!current || !start) return;

      const deltaLogical = current.logical - start.logical;
      const deltaPrice = current.price - start.price;
      if (!finite(deltaLogical) || !finite(deltaPrice)) return;

      if (d.type === "long_position" || d.type === "short_position") {
        if (handle === "start" || handle === "end") {
          const idx = handle === "start" ? 0 : 1;
          const pts = origPoints.map((p) => ({ time: p.time, price: p.price }));
          pts[idx] = { time: current.time, price: origPoints[idx].price };
          if (pts.every(finitePoint)) d.points = pts;
        } else if (handle === "stop" || handle === "take") {
          const entry = origPoints[0].price;
          if (!finite(entry) || entry === 0) return;
          const pct = Math.abs(current.price - entry) / Math.abs(entry) * 100;
          if (!finite(pct)) return;
          d.properties = Object.assign({}, origProps, handle === "stop" ? { stopOffsetPct: pct } : { takeOffsetPct: pct });
        } else {
          const pts = this._translatePoints(origPoints, deltaLogical, deltaPrice, null);
          if (pts) d.points = pts;
        }
      } else if (handle != null) {
        let snapped = this.snapPoint(current.time, current.price);
        if (!snapped || !finite(snapped.time) || !finite(snapped.price)) return;
        const pts = origPoints.map((p) => ({ time: p.time, price: p.price }));
        const editAxis = TOOL_DEFS[d.type] && TOOL_DEFS[d.type].editAxis;
        pts[handle] = editAxis === "price" ? { time: pts[handle].time, price: snapped.price }
          : editAxis === "time" ? { time: snapped.time, price: pts[handle].price }
          : { time: snapped.time, price: snapped.price };
        if (pts.every(finitePoint)) d.points = pts;
      } else {
        const editAxis = TOOL_DEFS[d.type] && TOOL_DEFS[d.type].editAxis;
        const pts = this._translatePoints(origPoints, deltaLogical, deltaPrice, editAxis);
        if (pts) d.points = pts;
        // Multi-object whole-drag: every other selected drawing (not the
        // one already handled above) rides the same delta, each through
        // its own editAxis so e.g. a grouped horizontal_line stays
        // horizontal even while a trend_line member moves freely.
        if (groupOrigPoints) {
          for (const [gid, gPoints] of groupOrigPoints) {
            if (gid === id || !gPoints) continue;
            const gd = this.drawings.find((x) => x.id === gid);
            if (!gd) continue;
            const gEditAxis = TOOL_DEFS[gd.type] && TOOL_DEFS[gd.type].editAxis;
            const gpts = this._translatePoints(gPoints, deltaLogical, deltaPrice, gEditAxis);
            if (gpts) gd.points = gpts;
          }
        }
      }
      // Preview-only notification. Persistence receives one {updated:id} on
      // pointerup, never one network save trigger per pointermove. UI panels
      // also ignore this marker so a finger drag cannot rebuild the DOM on
      // every frame.
      this._emit({ preview: true });
    }

    handleEscape() {
      const def = this.draft && TOOL_DEFS[this.draft.type];
      if (def && def.completion === "explicit" && this.draft.points.length >= 2) {
        this._finishDraft();
        return "finished";
      }
      this.setTool(null);
      return "canceled";
    }

    _onDblClick(e) {
      if (e.target && e.target.closest && e.target.closest(".ca-float-toolbar")) return;
      if (this.activeTool && this.draft && TOOL_DEFS[this.draft.type].completion === "explicit") {
        if (e.preventDefault) e.preventDefault();
        this._finishDraft();
        return;
      }
      const { x, y } = this._relXY(e);
      const hit = this.hitTest(x, y);
      if (hit) {
        const d = this.drawings.find((dd) => dd.id === hit.id);
        if (d && (d.type === "text" || d.type === "note") && typeof global.prompt === "function") {
          const next = global.prompt("Текст заметки", d.properties.text || "");
          if (next != null) this.updateDrawing(d.id, { properties: { text: next } });
        }
      }
    }

    _onKeyDown(e) {
      if (!this._pointerInside && document.activeElement !== this.core.container) return;
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === "Enter" && this.draft && TOOL_DEFS[this.draft.type].completion === "explicit") {
        e.preventDefault(); this._finishDraft(); return;
      }
      if (e.key === "Escape") { e.preventDefault(); this.handleEscape(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedIds.size) {
        e.preventDefault();
        // Loop over removeDrawing(), not a batch method - one undo-stack
        // entry per drawing (an N-object delete takes N undos to fully
        // revert) rather than rewriting removeDrawing's own well-tested
        // single-id snapshot/backend-delete contract for the multi case.
        for (const id of [...this.selectedIds]) this.removeDrawing(id);
        return;
      }
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
      if (meta && e.key.toLowerCase() === "g" && e.shiftKey && this.selectedIds.size) { e.preventDefault(); this.ungroupSelection(); return; }
      if (meta && e.key.toLowerCase() === "g" && this.selectedIds.size > 1) { e.preventDefault(); this.groupSelection(); return; }
      if (meta && e.key.toLowerCase() === "d" && this.selectedIds.size) { e.preventDefault(); this.duplicateSelection(); }
    }

    destroy() {
      this._destroyed = true;
      if (this._pointerSession) this._endPointerSession({ rollback: true });
      if (this._domCleanup) this._domCleanup();
      this._emptyPointerTap = null;
      this._lastDrawingTap = null;
      this.activeTool = null;
      this.draft = null;
      this._clearTouchOwnership();
      this._setNavigationLocked(false);
      this.series.detachPrimitive(this.primitive);
    }

    /** ChartCore.setSeriesType() removes the old price series and creates a
     * new one (lightweight-charts has no in-place type change) - the
     * drawing layer's primitive has to move to whichever series is current,
     * or every priceToCoordinate() call here would resolve against an
     * already-destroyed series. Drawing coordinates themselves (price/time)
     * are series-independent, so nothing about the drawings changes. */
    rebindSeries(newSeries) {
      // The old series is already disposed by ChartCore.removeSeries() by
      // the time this fires (lightweight-charts has no in-place type
      // change), which already tore down whatever it held on the primitive -
      // detachPrimitive() on it would throw, so this only ever attaches to
      // the new one.
      this.series = newSeries;
      this.series.attachPrimitive(this.primitive);
      this.primitive.requestUpdate();
    }
  }

  function positionStopPrice(d) {
    const entry = d.points[0].price;
    const long = d.type === "long_position";
    const off = (d.properties.stopOffsetPct || 0) / 100 * entry;
    return long ? entry - off : entry + off;
  }
  function positionTakePrice(d) {
    const entry = d.points[0].price;
    const long = d.type === "long_position";
    const off = (d.properties.takeOffsetPct || 0) / 100 * entry;
    return long ? entry + off : entry - off;
  }

  // ------------------------------------------------------------ rendering --

  class DrawingLayerPrimitive {
    constructor(manager) {
      this.manager = manager;
      this._view = new DrawingPaneView(manager);
      this._requestUpdate = null;
    }
    attached(params) { this._requestUpdate = params && params.requestUpdate; }
    requestUpdate() { this._requestUpdate && this._requestUpdate(); }
    // Fires on every real pane redraw (pan/zoom/resize/live tick) - the
    // floating toolbar's position hook (chart-tile.js) piggybacks on this
    // instead of its own RAF/event-listener loop, so it always matches
    // exactly what got painted this frame.
    updateAllViews() { this._view.update(); this.manager._notifyViewUpdate && this.manager._notifyViewUpdate(); }
    paneViews() { return [this._view]; }
  }

  class DrawingPaneView {
    constructor(manager) {
      this.manager = manager;
      this._ops = [];
    }

    update() {
      const m = this.manager;
      const ops = [];
      for (const d of m.drawings) {
        if (d.hidden) continue;
        this._buildOp(d, ops, m.selectedIds.has(d.id), d.id === m.hoverId);
      }
      if (m.draft && m.draft.points.length) {
        const preview = m._draftPreviewPoint ? m.pixelToPoint(m._draftPreviewPoint.x, m._draftPreviewPoint.y) : null;
        const points = preview && finite(preview.time) && finite(preview.price) ? m.draft.points.concat([preview]) : m.draft.points;
        this._buildOp({ id: "__draft__", type: m.draft.type, points, properties: defaultProperties(m.draft.type) }, ops, false, false, true);
      }
      this._ops = ops;
    }

    _buildOp(d, ops, selected, hovered, isDraft) {
      // "Видимость на таймфреймах" (Stage 7): a drawing with a non-empty
      // visibleTimeframes list only paints while the tile showing it is on
      // one of those timeframes - null/empty means "all timeframes" (the
      // default, matching every drawing created before this existed).
      if (d.properties.visibleTimeframes && d.properties.visibleTimeframes.length
        && !d.properties.visibleTimeframes.includes(this.manager.currentTimeframe)) return;
      const pix = toPixels(this.manager.core, d.points);
      const color = d.properties.color || theme.accent;
      const width = (selected ? 2 : d.properties.width || 1);
      const opacity = d.properties.opacity != null ? Number(d.properties.opacity) : 1;
      const alpha = isDraft ? 0.6 : opacity;
      const dash = dashPattern(d.properties.dash);
      const startLen = ops.length;
      switch (d.type) {
        case "horizontal_line":
          if (pix[0]?.y != null) ops.push({ kind: "hline", y: pix[0].y, color, width, alpha, handle: pix[0], label: d.properties.label });
          break;
        case "horizontal_ray":
          if (pix[0]?.x != null && pix[0]?.y != null) {
            ops.push({ kind: "segment", x1: pix[0].x, y1: pix[0].y, x2: paneWidth(this.manager.core), y2: pix[0].y, color, width, alpha, handles: [pix[0]] });
          }
          break;
        case "vertical_line":
          if (pix[0]?.x != null) ops.push({ kind: "vline", x: pix[0].x, color, width, alpha, handle: pix[0] });
          break;
        case "trend_line":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "segment", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        case "trend_angle":
          if (pix[0]?.x != null && pix[1]?.x != null) {
            ops.push({
              kind: "trend_angle", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y,
              angle: trendAngleDegrees(pix[0], pix[1]), color, width, alpha, handles: [pix[0], pix[1]],
            });
          }
          break;
        case "arrow":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "arrow", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        case "arrow_mark_up":
        case "arrow_mark_down":
        case "arrow_mark_left":
        case "arrow_mark_right":
          if (pix[0]?.x != null) ops.push({ kind: "arrow_mark", dir: ARROW_MARK_DIR[d.type], x: pix[0].x, y: pix[0].y, color, alpha, handle: pix[0] });
          break;
        case "ray":
        case "extended_line":
          if (pix[0]?.x != null && pix[1]?.x != null) {
            const clipped = clipParametricLineToRect(
              pix[0], pix[1], paneWidth(this.manager.core), paneHeight(this.manager.core),
              d.type === "ray" ? "ray" : "line",
            );
            if (clipped) ops.push({ kind: "segment", ...clipped, color, width, alpha, handles: [pix[0], pix[1]] });
          }
          break;
        case "parallel_channel":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[2]?.x != null) {
            const offsetPrice = d.points[2].price - lerpPriceAtTime(d.points[0], d.points[1], d.points[2].time);
            const q0 = { time: d.points[0].time, price: d.points[0].price + offsetPrice };
            const q1 = { time: d.points[1].time, price: d.points[1].price + offsetPrice };
            const [pq0, pq1] = toPixels(this.manager.core, [q0, q1]);
            ops.push({
              kind: "channel", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y,
              ox1: pq0?.x, oy1: pq0?.y, ox2: pq1?.x, oy2: pq1?.y,
              color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1], pix[2]],
            });
          }
          break;
        case "flat_top_bottom":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[2]?.x != null) {
            const [fq0, fq1] = toPixels(this.manager.core, flatBoundaryPoints(d));
            ops.push({
              kind: "channel", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y,
              ox1: fq0?.x, oy1: fq0?.y, ox2: fq1?.x, oy2: fq1?.y,
              color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1], pix[2]],
            });
          }
          break;
        // Two genuinely independent segments (not derived from each other,
        // unlike parallel_channel/flat_top_bottom) - reuses the "channel"
        // render kind directly since its shape (line1, optional line2 +
        // quad fill between) doesn't assume the two lines are parallel.
        case "disjoint_channel":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[2]?.x != null && pix[3]?.x != null) {
            ops.push({
              kind: "channel", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y,
              ox1: pix[2].x, oy1: pix[2].y, ox2: pix[3].x, oy2: pix[3].y,
              color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1], pix[2], pix[3]],
            });
          }
          break;
        case "regression_trend": {
          const ch = regressionTrendPixels(this.manager.core, d);
          if (ch) ops.push({ kind: "regression_trend", mid: ch.mid, upper: ch.upper, lower: ch.lower, color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1]] });
          break;
        }
        case "rectangle":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "rect", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1]] });
          break;
        case "circle":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "ellipse", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1]] });
          break;
        case "polyline":
        case "freehand":
        case "path":
          if (pix.length >= 2 && pix.every((p) => p.x != null && p.y != null)) ops.push({ kind: "polyline", points: pix, color, width, alpha, handles: pix });
          break;
        case "curve":
        case "arc":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[2]?.x != null) {
            const samples = d.type === "curve" ? quadraticBezierSamples(pix[0], pix[2], pix[1]) : arcSamples(pix[0], pix[2], pix[1]);
            ops.push({ kind: "bezier", points: samples, color, width, alpha, handles: [pix[0], pix[1], pix[2]] });
          }
          break;
        case "double_curve":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[2]?.x != null && pix[3]?.x != null) {
            ops.push({ kind: "bezier", points: cubicBezierSamples(pix[0], pix[2], pix[3], pix[1]), color, width, alpha, handles: [pix[0], pix[1], pix[2], pix[3]] });
          }
          break;
        case "highlighter":
          if (pix.length >= 2 && pix.every((p) => p.x != null && p.y != null)) ops.push({ kind: "highlighter", points: pix, color, width: d.properties.width || 14, alpha, handles: pix });
          break;
        case "rotated_rectangle": {
          const corners = rotatedRectCorners(pix);
          if (corners) ops.push({ kind: "rotated_rect", corners, color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1], pix[2]] });
          break;
        }
        case "triangle":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[2]?.x != null) {
            ops.push({
              kind: "triangle", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, x3: pix[2].x, y3: pix[2].y,
              color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1], pix[2]],
            });
          }
          break;
        case "price_range":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "measure", d, x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        // Ephemeral ruler tool (TOOL_DEFS.measure) - only ever seen here as
        // the "__draft__" op (it never becomes a real entry in
        // this.drawings, see _finishDraft's `ephemeral` branch), so pix[1]
        // is missing until the pointer has actually moved past the first
        // anchor; skip the op rather than draw a zero-size box.
        case "measure":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "measure_tool", d, x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha });
          break;
        case "price_date_range":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "price_date_range", d, x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        case "time_range":
          if (pix[0]?.x != null && pix[1]?.x != null) {
            ops.push({
              kind: "timerange", d, x1: pix[0].x, x2: pix[1].x, color, width, alpha,
              handles: [pix[0], pix[1]], h: paneHeight(this.manager.core),
            });
          }
          break;
        case "text":
          if (pix[0]?.x != null && pix[0]?.y != null) ops.push({ kind: "text", d, x: pix[0].x, y: pix[0].y, color, alpha, handle: pix[0] });
          break;
        case "note":
          if (pix[0]?.x != null && pix[0]?.y != null) ops.push({ kind: "note", d, x: pix[0].x, y: pix[0].y, color, alpha, handle: pix[0] });
          break;
        case "fib_retracement":
          if (pix[0]?.x != null && pix[1]?.x != null) {
            ops.push({
              kind: "fib", d, x1: d.properties.extendLeft ? 0 : Math.min(pix[0].x, pix[1].x), color, width, alpha,
              handles: [pix[0], pix[1]], levels: fibLevels(d, FIB_RETRACEMENT_LEVELS),
              priceAt: (level) => fibRetracementPrice(d, level),
              w: paneWidth(this.manager.core),
            });
          }
          break;
        case "fib_extension":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[2]?.x != null) {
            const base = fibExtensionBase(d);
            ops.push({
              kind: "fib", d, x1: d.properties.extendLeft ? 0 : pix[2].x, color, width, alpha,
              handles: [pix[0], pix[1], pix[2]], levels: fibLevels(d, FIB_EXTENSION_LEVELS),
              priceAt: (level) => d.points[2].price + base * level,
              w: paneWidth(this.manager.core),
            });
          }
          break;
        case "long_position":
        case "short_position":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[0]?.y != null) ops.push({ kind: "position", d, x1: Math.min(pix[0].x, pix[1].x), x2: Math.max(pix[0].x, pix[1].x), entryY: pix[0].y, alpha, long: d.type === "long_position" });
          break;
        case "pitchfork":
        case "pitchfork_schiff":
        case "pitchfork_modified_schiff": {
          const segs = pitchforkSegments(this.manager.core, d, pix, PITCHFORK_VARIANT[d.type]);
          if (segs.length) ops.push({ kind: "pitchfork", segments: segs, color, width, alpha, handles: [pix[0], pix[1], pix[2]] });
          break;
        }
        case "gann_fan": {
          const segs = gannSegments(this.manager.core, d, pix);
          if (segs.length) ops.push({ kind: "gann_fan", segments: segs, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "cyclic_lines": {
          const xs = cyclicLineXs(this.manager.core, d);
          if (xs.length) ops.push({ kind: "cyclic_lines", xs, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "fib_time_zone": {
          const marks = fibTimeZoneMarks(this.manager.core, d);
          if (marks.length) ops.push({ kind: "fib_time_zone", marks, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "fib_speed_resistance_fan": {
          const segs = fibFanSegments(this.manager.core, d, pix);
          if (segs.length) ops.push({ kind: "gann_fan", segments: segs, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "fib_circles": {
          const rings = fibCircles(pix);
          if (rings.length) ops.push({ kind: "fib_circles", cx: pix[0].x, cy: pix[0].y, rings, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "fib_arcs": {
          const arcs = fibArcSamples(pix);
          if (arcs.length) ops.push({ kind: "fib_arcs", arcs, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "trend_based_fib_time": {
          const marks = trendBasedFibTimeMarks(this.manager.core, d);
          if (marks.length) ops.push({ kind: "fib_time_zone", marks, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "fib_channel": {
          const segs = fibChannelSegments(this.manager.core, d, pix);
          if (segs.length) ops.push({ kind: "fib_channel", segments: segs, color, width, alpha, handles: [pix[0], pix[1], pix[2]] });
          break;
        }
        case "fib_wedge": {
          const segs = fibWedgeSegments(this.manager.core, d, pix);
          if (segs.length) {
            ops.push({
              kind: "fib_wedge",
              edge1: { x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y },
              edge2: { x1: pix[0].x, y1: pix[0].y, x2: pix[2].x, y2: pix[2].y },
              segments: segs, color, width, alpha, handles: [pix[0], pix[1], pix[2]],
            });
          }
          break;
        }
        case "sine_line": {
          const samples = sineLineSamples(pix);
          if (samples) ops.push({ kind: "sine_line", samples, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "fib_pitchfan": {
          const segs = fibPitchfanSegments(this.manager.core, d, pix);
          if (segs.length) ops.push({ kind: "gann_fan", segments: segs, color, width, alpha, handles: [pix[0], pix[1], pix[2]] });
          break;
        }
        case "fib_spiral": {
          const samples = fibSpiralSamples(pix);
          if (samples) ops.push({ kind: "fib_spiral", samples, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        }
        case "anchored_vwap": {
          const vwapPix = anchoredVwapPixels(this.manager.core, d);
          if (pix[0]?.x != null && vwapPix.length >= 2) {
            ops.push({ kind: "anchored_vwap", points: vwapPix, handle: pix[0], color, width, alpha });
          }
          break;
        }
        case "volume_profile": {
          if (pix[0]?.x == null || pix[1]?.x == null) break;
          const profile = volumeProfilePixels(this.manager.core, d);
          if (profile) {
            let yTop = Infinity, yBottom = -Infinity;
            for (const b of profile.buckets) {
              yTop = Math.min(yTop, b.y0, b.y1);
              yBottom = Math.max(yBottom, b.y0, b.y1);
            }
            ops.push({
              kind: "volume_profile", d,
              x1: pix[0].x, x2: pix[1].x, yTop, yBottom,
              buckets: profile.buckets, maxVolume: profile.maxVolume,
              color, alpha, handles: [pix[0], pix[1]],
            });
          }
          break;
        }
        case "xabcd_pattern":
        case "abcd_pattern":
        case "three_drives_pattern":
        case "elliott_impulse_wave":
        case "elliott_correction_wave":
          if (pix.length >= TOOL_DEFS[d.type].anchorCount && pix.every((p) => p.x != null && p.y != null)) {
            ops.push({ kind: "xabcd", points: pix, dpoints: d.points, labels: PATTERN_LABELS[d.type], color, width, alpha, handles: pix });
          }
          break;
        case "triangle_pattern":
        case "head_shoulders_pattern":
          if (pix.length >= TOOL_DEFS[d.type].anchorCount && pix.every((p) => p.x != null && p.y != null)) {
            ops.push({
              kind: "pattern_boundary", points: pix, labels: PATTERN_BOUNDARY_LABELS[d.type],
              boundary: patternBoundarySegments(this.manager.core, pix, d.type), color, width, alpha, handles: pix,
            });
          }
          break;
      }
      // Applies to every op this call just pushed (almost always exactly
      // one) without needing every individual ops.push() above to remember
      // to include it - dash/d weren't set per-case, showPrice reads d
      // directly at draw time.
      for (let i = startLen; i < ops.length; i++) {
        ops[i].dash = dash;
        ops[i].d = ops[i].d || d;
        // Every selected drawing gets the highlight outline (selected
        // width/color above already applies to all of them too), but
        // resize/edit handles are drawn only while exactly one thing is
        // selected - matches hitTest's own "handles belong only to a lone
        // selection" rule (a multi-object selection is whole-object-drag-
        // only), so a drawn handle is never one the pointer can't actually
        // grab.
        ops[i].showHandles = !!(isDraft || (selected && this.manager.selectedIds.size === 1));
        if (selected) ops[i].selected = true;
        if (hovered) ops[i].hovered = true;
      }
    }

    renderer() {
      const ops = this._ops;
      return {
        draw: (target) => {
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context;
            const r = scope.horizontalPixelRatio, rv = scope.verticalPixelRatio;
            const w = scope.bitmapSize.width, h = scope.bitmapSize.height;
            ctx.save();
            // Geometry stays in its real off-viewport coordinates; only paint
            // is clipped to this tile's pane. Never expand the overlay/page.
            ctx.beginPath();
            ctx.rect(0, 0, w, h);
            ctx.clip();
            for (const op of ops) this._drawOp(ctx, op, r, rv, w, h);
            ctx.restore();
          });
        },
      };
    }

    _drawOp(ctx, op, r, rv, w, h) {
      ctx.globalAlpha = op.alpha ?? 1;
      ctx.lineWidth = (op.width || 1) * r;
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
      const drawHandle = (...args) => { if (op.showHandles) this._handle(...args); };
      ctx.setLineDash((op.dash || []).map((v) => v * r));
      if (op.hovered && !op.selected) { ctx.shadowColor = op.color; ctx.shadowBlur = 4 * r; }

      switch (op.kind) {
        case "hline":
          ctx.beginPath(); ctx.moveTo(0, op.y * rv); ctx.lineTo(w, op.y * rv); ctx.stroke();
          if (op.handle) drawHandle(ctx, op.handle.x * r, op.handle.y * rv, r);
          if (op.label) this._text(ctx, op.label, 8 * r, op.y * rv - 6 * rv, op.color);
          break;
        case "vline":
          ctx.beginPath(); ctx.moveTo(op.x * r, 0); ctx.lineTo(op.x * r, h); ctx.stroke();
          if (op.handle) drawHandle(ctx, op.handle.x * r, op.handle.y * rv, r);
          break;
        case "segment":
          ctx.beginPath(); ctx.moveTo(op.x1 * r, op.y1 * rv); ctx.lineTo(op.x2 * r, op.y2 * rv); ctx.stroke();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        case "trend_angle":
          ctx.beginPath(); ctx.moveTo(op.x1 * r, op.y1 * rv); ctx.lineTo(op.x2 * r, op.y2 * rv); ctx.stroke();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          if (op.angle != null) {
            this._text(ctx, `${op.angle.toFixed(1)}°`, ((op.x1 + op.x2) / 2) * r, ((op.y1 + op.y2) / 2) * rv - 8 * rv, op.color);
          }
          break;
        case "regression_trend": {
          const drawBoundary = (seg, dash) => {
            if (!seg || seg.length < 2) return;
            ctx.setLineDash((dash || []).map((v) => v * r));
            ctx.beginPath(); ctx.moveTo(seg[0].x * r, seg[0].y * rv); ctx.lineTo(seg[1].x * r, seg[1].y * rv); ctx.stroke();
          };
          if (op.fill && op.upper?.length === 2 && op.lower?.length === 2) {
            ctx.globalAlpha = (op.alpha ?? 1) * 0.14;
            ctx.beginPath();
            ctx.moveTo(op.upper[0].x * r, op.upper[0].y * rv); ctx.lineTo(op.upper[1].x * r, op.upper[1].y * rv);
            ctx.lineTo(op.lower[1].x * r, op.lower[1].y * rv); ctx.lineTo(op.lower[0].x * r, op.lower[0].y * rv);
            ctx.closePath(); ctx.fill();
            ctx.globalAlpha = op.alpha ?? 1;
          }
          drawBoundary(op.mid, []);
          drawBoundary(op.upper, [5, 4]);
          drawBoundary(op.lower, [5, 4]);
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "arrow": {
          const x1 = op.x1 * r, y1 = op.y1 * rv, x2 = op.x2 * r, y2 = op.y2 * rv;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const headLen = 10 * r;
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - headLen * Math.cos(ang - Math.PI / 7), y2 - headLen * Math.sin(ang - Math.PI / 7));
          ctx.lineTo(x2 - headLen * Math.cos(ang + Math.PI / 7), y2 - headLen * Math.sin(ang + Math.PI / 7));
          ctx.closePath();
          ctx.fill();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "arrow_mark": {
          const x = op.x * r, y = op.y * rv, dir = op.dir;
          const len = ARROW_MARK_LEN_PX * r, headLen = 9 * r;
          const tx = x - dir.x * len, ty = y - dir.y * len * (rv / r);
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
          const ang = Math.atan2(y - ty, x - tx);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - headLen * Math.cos(ang - Math.PI / 6), y - headLen * Math.sin(ang - Math.PI / 6));
          ctx.lineTo(x - headLen * Math.cos(ang + Math.PI / 6), y - headLen * Math.sin(ang + Math.PI / 6));
          ctx.closePath();
          ctx.fill();
          drawHandle(ctx, x, y, r);
          break;
        }
        case "rect": {
          const x1 = Math.min(op.x1, op.x2) * r, x2 = Math.max(op.x1, op.x2) * r;
          const y1 = Math.min(op.y1, op.y2) * rv, y2 = Math.max(op.y1, op.y2) * rv;
          if (op.fill) { ctx.globalAlpha = (op.alpha ?? 1) * 0.15; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); ctx.globalAlpha = op.alpha ?? 1; }
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "channel": {
          ctx.beginPath(); ctx.moveTo(op.x1 * r, op.y1 * rv); ctx.lineTo(op.x2 * r, op.y2 * rv); ctx.stroke();
          if (op.ox1 != null && op.ox2 != null) {
            if (op.fill) {
              ctx.globalAlpha = (op.alpha ?? 1) * 0.14;
              ctx.beginPath();
              ctx.moveTo(op.x1 * r, op.y1 * rv); ctx.lineTo(op.x2 * r, op.y2 * rv);
              ctx.lineTo(op.ox2 * r, op.oy2 * rv); ctx.lineTo(op.ox1 * r, op.oy1 * rv);
              ctx.closePath(); ctx.fill();
              ctx.globalAlpha = op.alpha ?? 1;
            }
            ctx.beginPath(); ctx.moveTo(op.ox1 * r, op.oy1 * rv); ctx.lineTo(op.ox2 * r, op.oy2 * rv); ctx.stroke();
          }
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "ellipse": {
          const cx = ((op.x1 + op.x2) / 2) * r, cy = ((op.y1 + op.y2) / 2) * rv;
          const rx = Math.abs(op.x2 - op.x1) / 2 * r, ry = Math.abs(op.y2 - op.y1) / 2 * rv;
          ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          if (op.fill) { ctx.globalAlpha = (op.alpha ?? 1) * 0.15; ctx.fill(); ctx.globalAlpha = op.alpha ?? 1; }
          ctx.stroke();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "polyline":
        // "bezier": Curve/Arc/Double Curve already came in as oversampled
        // points (quadraticBezierSamples/cubicBezierSamples/arcSamples) -
        // painting is identical to polyline's, just a different op.kind so
        // tests/callers can tell a smooth curve from a raw polyline/path.
        case "bezier": {
          ctx.beginPath();
          op.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.stroke();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "highlighter": {
          ctx.save();
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          op.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.stroke();
          ctx.restore();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "rotated_rect": {
          ctx.beginPath();
          op.corners.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.closePath();
          if (op.fill) { ctx.globalAlpha = (op.alpha ?? 1) * 0.15; ctx.fill(); ctx.globalAlpha = op.alpha ?? 1; }
          ctx.stroke();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "timerange": {
          const x1 = Math.min(op.x1, op.x2) * r, x2 = Math.max(op.x1, op.x2) * r;
          ctx.globalAlpha = (op.alpha ?? 1) * 0.12;
          ctx.fillRect(x1, 0, x2 - x1, op.h * rv);
          ctx.globalAlpha = op.alpha ?? 1;
          ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, op.h * rv); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x2, 0); ctx.lineTo(x2, op.h * rv); ctx.stroke();
          const t1 = op.d.points[0].time, t2 = op.d.points[1].time;
          const seconds = Math.abs(t2 - t1);
          const bars = this.manager.core.candles.filter((c) => c.time >= Math.min(t1, t2) && c.time <= Math.max(t1, t2)).length;
          const label = `${fmtDuration(seconds)} · ${bars} бар.`;
          this._text(ctx, label, (x1 + x2) / 2 - 30 * r, 16 * rv, op.color);
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "note": {
          const px = op.x * r, py = op.y * rv;
          ctx.beginPath(); ctx.arc(px, py, 4 * r, 0, Math.PI * 2); ctx.fillStyle = op.color; ctx.fill();
          ctx.font = `${13 * rv}px Inter, sans-serif`;
          ctx.fillText(op.d.properties.text || "", px + 10 * r, py + 4 * rv);
          op.d._lastBox = { x1: op.x - 6, y1: op.y - 10, x2: op.x + 10 + ctx.measureText(op.d.properties.text || "").width / r, y2: op.y + 10 };
          drawHandle(ctx, px, py, r);
          break;
        }
        case "fib": {
          const x2 = op.w * r;
          op.levels.forEach((level) => {
            const price = op.priceAt(level);
            const y = priceToCoordinateSafe(this.manager.core, price);
            if (y == null) return;
            ctx.beginPath(); ctx.moveTo(op.x1 * r, y * rv); ctx.lineTo(x2, y * rv); ctx.stroke();
            this._text(ctx, `${(level * 100).toFixed(1)}% · ${price.toFixed(2)}`, op.x1 * r + 4 * r, y * rv - 4 * rv, op.color);
          });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "measure": {
          const x1 = Math.min(op.x1, op.x2) * r, x2 = Math.max(op.x1, op.x2) * r;
          const y1 = Math.min(op.y1, op.y2) * rv, y2 = Math.max(op.y1, op.y2) * rv;
          const priceA = op.d.points[0].price, priceB = op.d.points[1].price;
          const up = priceB >= priceA;
          ctx.globalAlpha = (op.alpha ?? 1) * 0.18;
          ctx.fillStyle = up ? theme.up : theme.down;
          ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
          ctx.globalAlpha = op.alpha ?? 1;
          ctx.strokeStyle = up ? theme.up : theme.down;
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          const pct = priceA ? ((priceB - priceA) / priceA * 100) : 0;
          const label = `${(priceB - priceA) >= 0 ? "+" : ""}${(priceB - priceA).toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
          this._text(ctx, label, (x1 + x2) / 2 - 40 * r, (y1 + y2) / 2, up ? theme.up : theme.down);
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "triangle": {
          const p1x = op.x1 * r, p1y = op.y1 * rv, p2x = op.x2 * r, p2y = op.y2 * rv, p3x = op.x3 * r, p3y = op.y3 * rv;
          ctx.beginPath(); ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.lineTo(p3x, p3y); ctx.closePath();
          if (op.fill) { ctx.globalAlpha = (op.alpha ?? 1) * 0.15; ctx.fill(); ctx.globalAlpha = op.alpha ?? 1; }
          ctx.stroke();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        // Superset of "measure" (price delta box) and "timerange" (duration
        // band label) - one dragged box shows both the price and the time
        // delta between its two anchors, matching TradingView's combined
        // Price+Date range tool.
        case "price_date_range": {
          const x1 = Math.min(op.x1, op.x2) * r, x2 = Math.max(op.x1, op.x2) * r;
          const y1 = Math.min(op.y1, op.y2) * rv, y2 = Math.max(op.y1, op.y2) * rv;
          const priceA = op.d.points[0].price, priceB = op.d.points[1].price;
          const up = priceB >= priceA;
          ctx.globalAlpha = (op.alpha ?? 1) * 0.15;
          ctx.fillStyle = up ? theme.up : theme.down;
          ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
          ctx.globalAlpha = op.alpha ?? 1;
          ctx.strokeStyle = up ? theme.up : theme.down;
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          const pct = priceA ? ((priceB - priceA) / priceA * 100) : 0;
          const priceLabel = `${(priceB - priceA) >= 0 ? "+" : ""}${(priceB - priceA).toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
          const t1 = op.d.points[0].time, t2 = op.d.points[1].time;
          const seconds = Math.abs(t2 - t1);
          const bars = this.manager.core.candles.filter((c) => c.time >= Math.min(t1, t2) && c.time <= Math.max(t1, t2)).length;
          const timeLabel = `${fmtDuration(seconds)} · ${bars} бар.`;
          const midX = (x1 + x2) / 2 - 40 * r, midY = (y1 + y2) / 2;
          this._text(ctx, priceLabel, midX, midY - 8 * rv, up ? theme.up : theme.down);
          this._text(ctx, timeLabel, midX, midY + 10 * rv, up ? theme.up : theme.down);
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        // TradingView-style ephemeral Measure/ruler: same price+date combo
        // math as price_date_range above, but dashed (not the solid border
        // every persistent drawing uses) and no drag handles - it's gone on
        // pointerup, never a selectable object.
        case "measure_tool": {
          const x1 = Math.min(op.x1, op.x2) * r, x2 = Math.max(op.x1, op.x2) * r;
          const y1 = Math.min(op.y1, op.y2) * rv, y2 = Math.max(op.y1, op.y2) * rv;
          const priceA = op.d.points[0].price, priceB = op.d.points[1].price;
          const up = priceB >= priceA;
          const col = up ? theme.up : theme.down;
          ctx.save();
          ctx.setLineDash([5 * r, 4 * r]);
          ctx.globalAlpha = (op.alpha ?? 1) * 0.14;
          ctx.fillStyle = col;
          ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
          ctx.globalAlpha = op.alpha ?? 1;
          ctx.strokeStyle = col;
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          ctx.restore();
          const pct = priceA ? ((priceB - priceA) / priceA * 100) : 0;
          const priceLabel = `${(priceB - priceA) >= 0 ? "+" : ""}${(priceB - priceA).toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
          const t1 = op.d.points[0].time, t2 = op.d.points[1].time;
          const seconds = Math.abs(t2 - t1);
          const bars = this.manager.core.candles.filter((c) => c.time >= Math.min(t1, t2) && c.time <= Math.max(t1, t2)).length;
          const timeLabel = `${fmtDuration(seconds)} · ${bars} бар.`;
          const midX = (x1 + x2) / 2 - 44 * r, midY = (y1 + y2) / 2;
          this._text(ctx, priceLabel, midX, midY - 8 * rv, col);
          this._text(ctx, timeLabel, midX, midY + 10 * rv, col);
          break;
        }
        case "text":
          ctx.font = `${13 * rv}px Inter, sans-serif`;
          ctx.fillStyle = op.color;
          ctx.fillText(op.d.properties.text || "", op.x * r + 4 * r, op.y * rv);
          op.d._lastBox = { x1: op.x, y1: op.y - 16, x2: op.x + ctx.measureText(op.d.properties.text || "").width / r + 8, y2: op.y + 4 };
          drawHandle(ctx, op.x * r, op.y * rv, r);
          break;
        case "position":
          this._drawPosition(ctx, op, r, rv);
          break;
        case "pitchfork": {
          op.segments.forEach((seg, i) => {
            ctx.beginPath(); ctx.moveTo(seg.x1 * r, seg.y1 * rv); ctx.lineTo(seg.x2 * r, seg.y2 * rv);
            // Median (segment 0) reads as the pitchfork's spine - draw it a
            // touch bolder than the two teeth, same convention TradingView
            // itself uses.
            ctx.lineWidth = ((op.width || 1) + (i === 0 ? 0.5 : 0)) * r;
            ctx.stroke();
          });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "gann_fan": {
          op.segments.forEach((seg) => {
            ctx.beginPath(); ctx.moveTo(seg.x1 * r, seg.y1 * rv); ctx.lineTo(seg.x2 * r, seg.y2 * rv);
            ctx.lineWidth = ((op.width || 1) + (seg.major ? 0.5 : 0)) * r;
            ctx.stroke();
            this._text(ctx, seg.label, seg.x1 * r + 4 * r, seg.y1 * rv - 4 * rv, op.color);
          });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "cyclic_lines":
          op.xs.forEach((x) => { ctx.beginPath(); ctx.moveTo(x * r, 0); ctx.lineTo(x * r, h); ctx.stroke(); });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        case "fib_time_zone":
          op.marks.forEach((m) => {
            ctx.beginPath(); ctx.moveTo(m.x * r, 0); ctx.lineTo(m.x * r, h); ctx.stroke();
            this._text(ctx, m.label, m.x * r + 4 * r, 14 * rv, op.color);
          });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        case "fib_circles": {
          op.rings.forEach((ring) => {
            ctx.beginPath();
            ctx.ellipse(op.cx * r, op.cy * rv, ring.radius * r, ring.radius * rv, 0, 0, Math.PI * 2);
            ctx.stroke();
            this._text(ctx, `${(ring.level * 100).toFixed(1)}%`, op.cx * r + ring.radius * r + 4 * r, op.cy * rv, op.color);
          });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "fib_arcs": {
          op.arcs.forEach((arc) => {
            ctx.beginPath();
            arc.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
            ctx.stroke();
            const mid = arc.points[Math.floor(arc.points.length / 2)];
            this._text(ctx, `${(arc.level * 100).toFixed(1)}%`, mid.x * r + 4 * r, mid.y * rv, op.color);
          });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "fib_channel":
          op.segments.forEach((seg) => {
            ctx.beginPath(); ctx.moveTo(seg.x1 * r, seg.y1 * rv); ctx.lineTo(seg.x2 * r, seg.y2 * rv); ctx.stroke();
            this._text(ctx, seg.label, seg.x2 * r + 4 * r, seg.y2 * rv, op.color);
          });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        case "fib_wedge": {
          ctx.beginPath(); ctx.moveTo(op.edge1.x1 * r, op.edge1.y1 * rv); ctx.lineTo(op.edge1.x2 * r, op.edge1.y2 * rv); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(op.edge2.x1 * r, op.edge2.y1 * rv); ctx.lineTo(op.edge2.x2 * r, op.edge2.y2 * rv); ctx.stroke();
          op.segments.forEach((seg) => {
            ctx.beginPath(); ctx.moveTo(seg.x1 * r, seg.y1 * rv); ctx.lineTo(seg.x2 * r, seg.y2 * rv); ctx.stroke();
            this._text(ctx, seg.label, seg.x2 * r + 4 * r, seg.y2 * rv, op.color);
          });
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "sine_line": {
          ctx.beginPath();
          op.samples.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.stroke();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "fib_spiral": {
          ctx.beginPath();
          op.samples.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.stroke();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "anchored_vwap": {
          ctx.beginPath();
          op.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.stroke();
          if (op.handle) drawHandle(ctx, op.handle.x * r, op.handle.y * rv, r);
          break;
        }
        // Bars grow rightward from the box's own left edge (x1), each row's
        // width a fraction of MAX_BAR_FRACTION of the box width scaled by
        // that row's volume relative to the Point of Control (the
        // highest-volume row, TradingView's own name for it) - the POC row
        // is drawn at full opacity with its own border, every other row at
        // a dimmer fill, and the dashed outline marks the profile's own
        // time-range/price-range box.
        case "volume_profile": {
          const x1 = Math.min(op.x1, op.x2) * r, x2 = Math.max(op.x1, op.x2) * r;
          const yTop = op.yTop * rv, yBottom = op.yBottom * rv;
          const boxWidth = x2 - x1;
          const MAX_BAR_FRACTION = 0.9;
          const maxBarWidth = boxWidth * MAX_BAR_FRACTION;
          ctx.save();
          ctx.setLineDash([5 * r, 4 * r]);
          ctx.globalAlpha = (op.alpha ?? 1) * 0.35;
          ctx.strokeStyle = op.color;
          ctx.strokeRect(x1, yTop, boxWidth, yBottom - yTop);
          ctx.setLineDash([]);
          for (const b of op.buckets) {
            const by0 = Math.min(b.y0, b.y1) * rv, by1 = Math.max(b.y0, b.y1) * rv;
            const barH = Math.max(1, by1 - by0 - 1 * r);
            const barW = maxBarWidth * (b.volume / op.maxVolume);
            ctx.globalAlpha = (op.alpha ?? 1) * (b.isPoc ? 0.85 : 0.35);
            ctx.fillStyle = op.color;
            ctx.fillRect(x1, by0, barW, barH);
            if (b.isPoc) {
              ctx.globalAlpha = op.alpha ?? 1;
              ctx.strokeStyle = op.color;
              ctx.lineWidth = 1.5 * r;
              ctx.strokeRect(x1, by0, barW, barH);
              this._text(ctx, "POC", x1 + barW + 4 * r, (by0 + by1) / 2, op.color);
            }
          }
          ctx.restore();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "xabcd": {
          ctx.beginPath();
          op.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.stroke();
          op.points.forEach((p, i) => this._text(ctx, op.labels[i], p.x * r + 6 * r, p.y * rv - 8 * rv, op.color));
          // Per-leg retracement/extension ratio (curLeg / prevLeg, by price
          // distance) at each interior vertex's outgoing leg - the same
          // "how does this leg relate to the one before it" reading
          // TradingView's XABCD/ABCD shows, without the full Gartley/Bat/
          // Butterfly/Crab pattern-name auto-classification (separate,
          // larger piece of work).
          for (let i = 1; i < op.dpoints.length - 1; i++) {
            const prevLen = Math.abs(op.dpoints[i].price - op.dpoints[i - 1].price);
            const curLen = Math.abs(op.dpoints[i + 1].price - op.dpoints[i].price);
            if (!prevLen) continue;
            const pct = `${(curLen / prevLen * 100).toFixed(1)}%`;
            const mx = (op.points[i].x + op.points[i + 1].x) / 2 * r;
            const my = (op.points[i].y + op.points[i + 1].y) / 2 * rv;
            this._text(ctx, pct, mx, my, op.color);
          }
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        // Triangle Pattern's two converging/diverging sides or Head &
        // Shoulders' single neckline - zigzag skeleton with per-vertex
        // labels, plus the boundary line(s) drawn a touch fainter so the
        // real swing points stay the visual focus (same relative-emphasis
        // convention pitchfork's median/teeth already use).
        case "pattern_boundary": {
          ctx.beginPath();
          op.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.stroke();
          op.points.forEach((p, i) => this._text(ctx, op.labels[i], p.x * r + 6 * r, p.y * rv - 8 * rv, op.color));
          ctx.save();
          ctx.globalAlpha = (op.alpha ?? 1) * 0.7;
          op.boundary.forEach((seg) => {
            ctx.beginPath(); ctx.moveTo(seg.x1 * r, seg.y1 * rv); ctx.lineTo(seg.x2 * r, seg.y2 * rv); ctx.stroke();
          });
          ctx.restore();
          op.handles.forEach((p) => p && drawHandle(ctx, p.x * r, p.y * rv, r));
          break;
        }
      }
      // "Показ цены" (Stage 7 Properties toggle): kinds that already print
      // their own price-derived label unconditionally (measure/fib/
      // timerange/position) are skipped - this only adds one where nothing
      // would otherwise show the object's price.
      if (op.d && op.d.properties.showPrice && ["hline", "segment", "rect", "channel", "ellipse"].includes(op.kind)) {
        const pts = op.d.points;
        const lastPt = pts[pts.length - 1];
        const y = lastPt && lastPt.price != null ? priceToCoordinateSafe(this.manager.core, lastPt.price) : null;
        if (y != null) {
          const label = lastPt.price.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          this._text(ctx, label, w - 62 * r, y * rv - 6 * rv, op.color);
        }
      }
      ctx.shadowBlur = 0;
    }

    _handle(ctx, x, y, r) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#0c1019";
      ctx.strokeStyle = ctx.strokeStyle || theme.accent;
      ctx.lineWidth = 1.5 * r;
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_RADIUS_PX * r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    _text(ctx, text, x, y, color) {
      ctx.save();
      ctx.font = "11px Inter, sans-serif";
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    _drawPosition(ctx, op, r, rv) {
      const d = op.d;
      const entry = d.points[0].price;
      const stop = positionStopPrice(d);
      const take = positionTakePrice(d);
      const core = this.manager.core;
      const yEntry = op.entryY;
      const yStop = priceToCoordinateSafe(core, stop);
      const yTake = priceToCoordinateSafe(core, take);
      if (yStop == null || yTake == null) return;
      const x1 = op.x1 * r, x2 = op.x2 * r;

      ctx.globalAlpha = 0.16;
      ctx.fillStyle = theme.up;
      ctx.fillRect(x1, Math.min(yEntry, yTake) * rv, x2 - x1, Math.abs(yEntry - yTake) * rv);
      ctx.fillStyle = theme.down;
      ctx.fillRect(x1, Math.min(yEntry, yStop) * rv, x2 - x1, Math.abs(yEntry - yStop) * rv);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.5 * r;
      ctx.beginPath(); ctx.moveTo(x1, yEntry * rv); ctx.lineTo(x2, yEntry * rv); ctx.stroke();
      ctx.strokeStyle = theme.up; ctx.beginPath(); ctx.moveTo(x1, yTake * rv); ctx.lineTo(x2, yTake * rv); ctx.stroke();
      ctx.strokeStyle = theme.down; ctx.beginPath(); ctx.moveTo(x1, yStop * rv); ctx.lineTo(x2, yStop * rv); ctx.stroke();

      const riskAbs = Math.abs(entry - stop), rewardAbs = Math.abs(take - entry);
      const rr = riskAbs ? (rewardAbs / riskAbs) : 0;
      const takePct = entry ? (rewardAbs / entry * 100) : 0;
      const stopPct = entry ? (riskAbs / entry * 100) : 0;
      this._text(ctx, `Цель: ${rewardAbs.toFixed(2)} (${takePct.toFixed(2)}%)`, x1 + 6 * r, yTake * rv - 6 * rv, theme.up);
      this._text(ctx, `Стоп: ${riskAbs.toFixed(2)} (${stopPct.toFixed(2)}%)  R/R ${rr.toFixed(2)}`, x1 + 6 * r, yStop * rv + 14 * rv, theme.down);
      if (op.showHandles) {
        const midX = (x1 + x2) / 2;
        this._handle(ctx, x1, yEntry * rv, r);
        this._handle(ctx, x2, yEntry * rv, r);
        this._handle(ctx, midX, yStop * rv, r);
        this._handle(ctx, midX, yTake * rv, r);
      }
    }
  }

  global.ChartEngine.Drawings = {
    DrawingManager,
    TOOL_DEFS,
    INTERACTION_STATES,
    defaultProperties,
    positionStopPrice,
    positionTakePrice,
    FIB_RETRACEMENT_LEVELS,
    FIB_EXTENSION_LEVELS,
  };
})(window);
