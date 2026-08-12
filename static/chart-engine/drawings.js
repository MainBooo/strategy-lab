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
    vertical_line: { pointsNeeded: 1, anchorCount: 1, creationGesture: "tap", dragStagePoints: 0, completion: "anchor-count", preview: "none", editAxis: "time", label: "Вертикальная линия" },
    trend_line: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Линия тренда" },
    ray: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Луч" },
    extended_line: { pointsNeeded: 2, anchorCount: 2, creationGesture: "tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Расширенная линия" },
    parallel_channel: { pointsNeeded: 3, anchorCount: 3, creationGesture: "staged-tap-or-drag", dragStagePoints: 2, completion: "anchor-count", preview: "next-anchor", label: "Параллельный канал" },
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
  };

  const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_EXTENSION_LEVELS = [0, 0.618, 1, 1.272, 1.618, 2.618];

  function defaultProperties(type) {
    const base = { color: theme.accent, width: 1, dash: "solid", opacity: 1, label: "", showPrice: false, visibleTimeframes: null };
    if (type === "rectangle" || type === "price_range" || type === "circle" || type === "time_range" || type === "parallel_channel") return Object.assign(base, { fill: true });
    if (type === "long_position") return Object.assign(base, { color: theme.up, riskDistance: null, rewardDistance: null, stopOffsetPct: 1, takeOffsetPct: 2, quantity: 100 });
    if (type === "short_position") return Object.assign(base, { color: theme.down, stopOffsetPct: 1, takeOffsetPct: 2, quantity: 100 });
    if (type === "text") return Object.assign(base, { text: "Заметка" });
    if (type === "note") return Object.assign(base, { text: "Заметка", color: "#ffce54" });
    if (type === "fib_retracement" || type === "fib_extension") return Object.assign(base, { color: theme.accent });
    return base;
  }

  /** Linear interpolation of a trend line's price at an arbitrary time -
   * used by the parallel-channel tool to compute the offset line without
   * needing a third stored point pair. Callers already guard against a
   * zero-width line (p0.time === p1.time) being drawn in the first place
   * (a degenerate click), so this never divides by zero in practice; if it
   * did, the NaN is caught by the pix[i]?.x != null guards at render time. */
  function lerpPriceAtTime(p0, p1, time) {
    const span = p1.time - p0.time;
    if (!span) return p0.price;
    const t = (time - p0.time) / span;
    return p0.price + (p1.price - p0.price) * t;
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

  function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  /** Converts a drawing's {time,price} points to pixel space for the current viewport. Returns null if off-screen. */
  function toPixels(core, points) {
    const ts = core.chart.timeScale();
    return points.map((p) => ({
      x: p.time != null ? ts.timeToCoordinate(p.time) : null,
      y: p.price != null ? core.candleSeries.priceToCoordinate(p.price) : null,
    }));
  }

  // --------------------------------------------------------------- drawing --

  class DrawingManager {
    constructor(chartCore) {
      this.core = chartCore;
      this.chart = chartCore.chart;
      this.series = chartCore.candleSeries;
      this.drawings = [];
      this.selectedId = null;
      this.hoverId = null;
      this.activeTool = null;
      this.draft = null;
      this.snapEnabled = false;
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
      this._destroyed = false;

      this.primitive = new DrawingLayerPrimitive(this);
      this.series.attachPrimitive(this.primitive);
      this._bindDom();
      this.onChange(() => this.primitive.requestUpdate());
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
        properties: Object.assign(defaultProperties(type), properties || {}),
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
      if (this.selectedId === id) this.selectedId = null;
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

    select(id) {
      this.selectedId = id || null;
      if (!this.activeTool && !this._pointerSession) this._syncInteractionMode();
      this._emit();
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
      if (this.selectedId) {
        const sel = sorted.find((d) => d.id === this.selectedId);
        if (sel) {
          const hit = this._hitDrawing(sel, px, py, Object.assign({ allowHandles: true }, hitOptions));
          if (hit) return hit;
        }
      }
      for (const d of sorted) {
        if (d.id === this.selectedId) continue;
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
        case "vertical_line": {
          if (pix[0] == null || pix[0].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          return Math.abs(px - pix[0].x) <= tol ? { id: d.id, handle: null } : null;
        }
        case "trend_line":
        case "ray":
        case "extended_line": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          let x1 = pix[0].x, y1 = pix[0].y, x2 = pix[1].x, y2 = pix[1].y;
          if (d.type === "ray" || d.type === "extended_line") {
            const dx = pix[1].x - pix[0].x, dy = pix[1].y - pix[0].y;
            const scale = dx !== 0 ? (this.core.container.clientWidth * 2) / Math.max(1, Math.abs(dx)) : 1;
            x2 = pix[0].x + dx * scale; y2 = pix[0].y + dy * scale;
            if (d.type === "extended_line") { x1 = pix[0].x - dx * scale; y1 = pix[0].y - dy * scale; }
          }
          return pointToSegmentDist(px, py, x1, y1, x2, y2) <= tol ? { id: d.id, handle: null } : null;
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
        case "rectangle":
        case "price_range":
        case "time_range": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const x1 = Math.min(pix[0].x, pix[1].x), x2 = Math.max(pix[0].x, pix[1].x);
          const y1 = d.type === "time_range" ? 0 : Math.min(pix[0].y, pix[1].y);
          const y2 = d.type === "time_range" ? this.core.container.clientHeight : Math.max(pix[0].y, pix[1].y);
          return px >= x1 - tol && px <= x2 + tol && py >= y1 - tol && py <= y2 + tol ? { id: d.id, handle: null } : null;
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
        case "polyline": {
          if (pix.length < 2) return null;
          for (let i = 0; i < pix.length; i++) if (handleAt(i)) return { id: d.id, handle: i };
          for (let i = 0; i < pix.length - 1; i++) {
            if (pix[i].x == null || pix[i + 1].x == null) continue;
            if (pointToSegmentDist(px, py, pix[i].x, pix[i].y, pix[i + 1].x, pix[i + 1].y) <= tol) return { id: d.id, handle: null };
          }
          return null;
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
          const x1 = Math.min(pix[0].x, pix[1].x);
          const x2 = this.core.container.clientWidth;
          for (const level of FIB_RETRACEMENT_LEVELS) {
            const price = d.points[0].price + (d.points[1].price - d.points[0].price) * level;
            const y = this.series.priceToCoordinate(price);
            if (y != null && px >= x1 - tol && px <= x2 && Math.abs(py - y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "fib_extension": {
          if (pix.length < 3 || pix[2].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          if (handleAt(2)) return { id: d.id, handle: 2 };
          const x1 = pix[2].x;
          const x2 = this.core.container.clientWidth;
          const base = d.points[1].price - d.points[0].price;
          for (const level of FIB_EXTENSION_LEVELS) {
            const price = d.points[2].price + base * level;
            const y = this.series.priceToCoordinate(price);
            if (y != null && px >= x1 - tol && px <= x2 && Math.abs(py - y) <= tol) return { id: d.id, handle: null };
          }
          return null;
        }
        case "long_position":
        case "short_position": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          const x1 = Math.min(pix[0].x, pix[1].x), x2 = Math.max(pix[0].x, pix[1].x);
          const entryY = pix[0].y;
          const stopY = this.series.priceToCoordinate(positionStopPrice(d));
          const takeY = this.series.priceToCoordinate(positionTakePrice(d));
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
    snapPoint(time, price) {
      if (!this.snapEnabled) return { time, price };
      const candle = this._nearestCandle(time);
      if (!candle) return { time, price };
      const candidates = [candle.open, candle.high, candle.low, candle.close];
      let best = price, bestDist = Infinity;
      for (const c of candidates) {
        const d = Math.abs(c - price);
        if (d < bestDist) { bestDist = d; best = c; }
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
    pixelToPoint(px, py) {
      const time = this.chart.timeScale().coordinateToTime(px);
      const price = this.series.coordinateToPrice(py);
      return { time, price };
    }

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
      const onDblClick = (e) => this._onDblClick(e);
      const onKeyDown = (e) => this._onKeyDown(e);

      el.addEventListener("pointerenter", onPointerEnter);
      el.addEventListener("pointerleave", onPointerLeave);
      el.addEventListener("pointerdown", onPointerDown, { capture: true });
      global.addEventListener("pointermove", onPointerMove, { capture: true });
      global.addEventListener("pointerup", onPointerUp, { capture: true });
      global.addEventListener("pointercancel", onPointerCancel, { capture: true });
      el.addEventListener("lostpointercapture", onLostPointerCapture);
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
        this.select(hit.id);
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
      let { time, price } = this.pixelToPoint(x, y);
      if (time == null || price == null) return;
      ({ time, price } = this.snapPoint(time, price));
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
            this._dragState = {
              id: session.hit.id,
              handle: session.hit.handle,
              startX: session.startX,
              startY: session.startY,
              origPoints: JSON.parse(JSON.stringify(session.drawingBefore.points)),
              origProps: JSON.parse(JSON.stringify(session.drawingBefore.properties)),
              beforeSnapshot: session.historyBefore,
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
      const id = this._dragState.id;
      const before = this._dragState.beforeSnapshot;
      this._dragState = null;
      if (before != null) this._pushHistory(before);
      this._emit({ updated: id, pointerDrag: true });
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
      let { time, price } = this.pixelToPoint(x, y);
      if (time == null || price == null) return null;
      ({ time, price } = this.snapPoint(time, price));
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
      if (def.completion === "explicit" && this.draft.points.length < 2) return null;
      if (def.anchorCount > 0 && this.draft.points.length < def.anchorCount) return null;

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

    _applyDrag(x, y) {
      const { id, handle, startX, startY, origPoints, origProps } = this._dragState || {};
      if (!id) return;
      const d = this.drawings.find((dd) => dd.id === id);
      if (!d) return;
      const { time, price } = this.pixelToPoint(x, y);
      if (time == null || price == null) return;

      if (d.type === "long_position" || d.type === "short_position") {
        if (handle === "start") d.points = [{ time, price: origPoints[0].price }, origPoints[1]];
        else if (handle === "end") d.points = [origPoints[0], { time, price: origPoints[1].price }];
        else if (handle === "stop" || handle === "take") {
          const entry = origPoints[0].price;
          const pct = Math.abs(price - entry) / entry * 100;
          d.properties = Object.assign({}, origProps, handle === "stop" ? { stopOffsetPct: pct } : { takeOffsetPct: pct });
        } else {
          const start = this.pixelToPoint(startX, startY);
          const dt = time - start.time;
          const dp = price - start.price;
          d.points = origPoints.map((p) => ({
            time: p.time != null ? p.time + dt : null,
            price: p.price != null ? p.price + dp : null,
          }));
        }
      } else if (handle != null) {
        const snapped = this.snapPoint(time, price);
        const pts = origPoints.slice();
        const editAxis = TOOL_DEFS[d.type] && TOOL_DEFS[d.type].editAxis;
        pts[handle] = editAxis === "price" ? { time: pts[handle].time, price: snapped.price }
          : editAxis === "time" ? { time: snapped.time, price: pts[handle].price }
          : snapped;
        d.points = pts;
      } else {
        const start = this.pixelToPoint(startX, startY);
        const dt = time - start.time, dp = price - start.price;
        const editAxis = TOOL_DEFS[d.type] && TOOL_DEFS[d.type].editAxis;
        d.points = origPoints.map((p) => ({
          time: p.time == null ? null : (editAxis === "price" ? p.time : p.time + dt),
          price: p.price == null ? null : (editAxis === "time" ? p.price : p.price + dp),
        }));
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
      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedId) {
        e.preventDefault(); this.removeDrawing(this.selectedId); return;
      }
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
      if (meta && e.key.toLowerCase() === "d" && this.selectedId) { e.preventDefault(); this.duplicateDrawing(this.selectedId); }
    }

    destroy() {
      this._destroyed = true;
      if (this._pointerSession) this._endPointerSession({ rollback: true });
      if (this._domCleanup) this._domCleanup();
      this._emptyPointerTap = null;
      this._lastDrawingTap = null;
      this.activeTool = null;
      this.draft = null;
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
    updateAllViews() { this._view.update(); }
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
        this._buildOp(d, ops, d.id === m.selectedId, d.id === m.hoverId);
      }
      if (m.draft && m.draft.points.length) {
        const preview = m._draftPreviewPoint ? m.pixelToPoint(m._draftPreviewPoint.x, m._draftPreviewPoint.y) : null;
        const points = preview ? m.draft.points.concat([preview]) : m.draft.points;
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
        case "vertical_line":
          if (pix[0]?.x != null) ops.push({ kind: "vline", x: pix[0].x, color, width, alpha, handle: pix[0] });
          break;
        case "trend_line":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "segment", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        case "ray":
        case "extended_line":
          if (pix[0]?.x != null && pix[1]?.x != null) {
            const dx = pix[1].x - pix[0].x, dy = pix[1].y - pix[0].y;
            const scale = 4000 / Math.max(1, Math.hypot(dx, dy));
            const x2 = pix[0].x + dx * scale, y2 = pix[0].y + dy * scale;
            const x1 = d.type === "extended_line" ? pix[0].x - dx * scale : pix[0].x;
            const y1 = d.type === "extended_line" ? pix[0].y - dy * scale : pix[0].y;
            ops.push({ kind: "segment", x1, y1, x2, y2, color, width, alpha, handles: [pix[0], pix[1]] });
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
        case "rectangle":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "rect", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1]] });
          break;
        case "circle":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "ellipse", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1]] });
          break;
        case "polyline":
          if (pix.length >= 2 && pix.every((p) => p.x != null)) ops.push({ kind: "polyline", points: pix, color, width, alpha, handles: pix });
          break;
        case "price_range":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "measure", d, x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        case "time_range":
          if (pix[0]?.x != null && pix[1]?.x != null) {
            ops.push({
              kind: "timerange", d, x1: pix[0].x, x2: pix[1].x, color, width, alpha,
              handles: [pix[0], pix[1]], h: this.manager.core.container.clientHeight,
            });
          }
          break;
        case "text":
          if (pix[0]?.x != null) ops.push({ kind: "text", d, x: pix[0].x, y: pix[0].y, color, alpha, handle: pix[0] });
          break;
        case "note":
          if (pix[0]?.x != null) ops.push({ kind: "note", d, x: pix[0].x, y: pix[0].y, color, alpha, handle: pix[0] });
          break;
        case "fib_retracement":
          if (pix[0]?.x != null && pix[1]?.x != null) {
            ops.push({
              kind: "fib", d, x1: Math.min(pix[0].x, pix[1].x), color, width, alpha,
              handles: [pix[0], pix[1]], levels: FIB_RETRACEMENT_LEVELS,
              priceAt: (level) => d.points[0].price + (d.points[1].price - d.points[0].price) * level,
              w: this.manager.core.container.clientWidth,
            });
          }
          break;
        case "fib_extension":
          if (pix[0]?.x != null && pix[1]?.x != null && pix[2]?.x != null) {
            const base = d.points[1].price - d.points[0].price;
            ops.push({
              kind: "fib", d, x1: pix[2].x, color, width, alpha,
              handles: [pix[0], pix[1], pix[2]], levels: FIB_EXTENSION_LEVELS,
              priceAt: (level) => d.points[2].price + base * level,
              w: this.manager.core.container.clientWidth,
            });
          }
          break;
        case "long_position":
        case "short_position":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "position", d, x1: Math.min(pix[0].x, pix[1].x), x2: Math.max(pix[0].x, pix[1].x), entryY: pix[0].y, alpha, long: d.type === "long_position" });
          break;
      }
      // Applies to every op this call just pushed (almost always exactly
      // one) without needing every individual ops.push() above to remember
      // to include it - dash/d weren't set per-case, showPrice reads d
      // directly at draw time.
      for (let i = startLen; i < ops.length; i++) {
        ops[i].dash = dash;
        ops[i].d = ops[i].d || d;
        ops[i].showHandles = !!(selected || isDraft);
        if (selected) ops[i].selected = true;
        if (hovered) ops[i].hovered = true;
      }
    }

    renderer() {
      const ops = this._ops;
      const core = this.manager.core;
      return {
        draw: (target) => {
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context;
            const r = scope.horizontalPixelRatio, rv = scope.verticalPixelRatio;
            const w = scope.bitmapSize.width, h = scope.bitmapSize.height;
            ctx.save();
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
        case "polyline": {
          ctx.beginPath();
          op.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
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
            const y = this.manager.core.candleSeries.priceToCoordinate(price);
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
      }
      // "Показ цены" (Stage 7 Properties toggle): kinds that already print
      // their own price-derived label unconditionally (measure/fib/
      // timerange/position) are skipped - this only adds one where nothing
      // would otherwise show the object's price.
      if (op.d && op.d.properties.showPrice && ["hline", "segment", "rect", "channel", "ellipse"].includes(op.kind)) {
        const pts = op.d.points;
        const lastPt = pts[pts.length - 1];
        const y = lastPt && lastPt.price != null ? this.manager.core.candleSeries.priceToCoordinate(lastPt.price) : null;
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
      const yStop = core.candleSeries.priceToCoordinate(stop);
      const yTake = core.candleSeries.priceToCoordinate(take);
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
  };
})(window);
