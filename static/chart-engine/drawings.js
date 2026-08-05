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

  // pointsNeeded: -1 means "unbounded" (polyline) - finished explicitly via
  // dblclick or Enter, not by reaching a fixed count (see _placePoint).
  const TOOL_DEFS = {
    horizontal_line: { pointsNeeded: 1, label: "Горизонтальный уровень" },
    vertical_line: { pointsNeeded: 1, label: "Вертикальная линия" },
    trend_line: { pointsNeeded: 2, label: "Линия тренда" },
    ray: { pointsNeeded: 2, label: "Луч" },
    extended_line: { pointsNeeded: 2, label: "Расширенная линия" },
    parallel_channel: { pointsNeeded: 3, label: "Параллельный канал" },
    rectangle: { pointsNeeded: 2, label: "Прямоугольная зона" },
    circle: { pointsNeeded: 2, label: "Окружность" },
    polyline: { pointsNeeded: -1, label: "Полилиния" },
    price_range: { pointsNeeded: 2, label: "Измерение" },
    time_range: { pointsNeeded: 2, label: "Диапазон времени" },
    text: { pointsNeeded: 1, label: "Текстовая заметка" },
    note: { pointsNeeded: 1, label: "Заметка" },
    fib_retracement: { pointsNeeded: 2, label: "Коррекция Фибоначчи" },
    fib_extension: { pointsNeeded: 3, label: "Расширение Фибоначчи" },
    long_position: { pointsNeeded: 2, label: "Long позиция" },
    short_position: { pointsNeeded: 2, label: "Short позиция" },
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

      this.primitive = new DrawingLayerPrimitive(this);
      this.series.attachPrimitive(this.primitive);
      this._bindDom();
      this.onChange(() => this.primitive.requestUpdate());
    }

    // ---- tool lifecycle ----
    setTool(type) {
      this.activeTool = type;
      this.draft = null;
      this._emit();
    }

    cancelDraft() {
      this.draft = null;
      this._emit();
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
      this.selectedId = id;
      this._emit();
    }

    undo() {
      if (!this._undoStack.length) return;
      const before = this._undoStack.pop();
      this._redoStack.push(this._snapshot());
      this.drawings = JSON.parse(before);
      this._emit({ history: true });
    }

    redo() {
      if (!this._redoStack.length) return;
      const next = this._redoStack.pop();
      this._undoStack.push(this._snapshot());
      this.drawings = JSON.parse(next);
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
      this._emit({ loaded: true });
    }

    // ---- hit testing ----
    hitTest(px, py) {
      const sorted = this.drawings.filter((d) => !d.hidden).sort((a, b) => b.zIndex - a.zIndex);
      // selected drawing gets priority so its own handles are grabbable even under overlaps
      if (this.selectedId) {
        const sel = sorted.find((d) => d.id === this.selectedId);
        if (sel) {
          const hit = this._hitDrawing(sel, px, py);
          if (hit) return hit;
        }
      }
      for (const d of sorted) {
        const hit = this._hitDrawing(d, px, py);
        if (hit) return hit;
      }
      return null;
    }

    _hitDrawing(d, px, py) {
      const pix = toPixels(this.core, d.points);
      const tol = HIT_TOLERANCE_PX;
      const handleAt = (i) => (pix[i] && pix[i].x != null && Math.hypot(px - pix[i].x, py - pix[i].y) <= HANDLE_RADIUS_PX + 3);

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
          if (box && px >= box.x1 && px <= box.x2 && py >= box.y1 && py <= box.y2) return { id: d.id, handle: null };
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
          if (Math.hypot(px - x1, py - entryY) <= HANDLE_RADIUS_PX + 3) return { id: d.id, handle: "start" };
          if (Math.hypot(px - x2, py - entryY) <= HANDLE_RADIUS_PX + 3) return { id: d.id, handle: "end" };
          if (stopY != null && Math.hypot(px - (x1 + x2) / 2, py - stopY) <= HANDLE_RADIUS_PX + 3) return { id: d.id, handle: "stop" };
          if (takeY != null && Math.hypot(px - (x1 + x2) / 2, py - takeY) <= HANDLE_RADIUS_PX + 3) return { id: d.id, handle: "take" };
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

    // ---- DOM wiring: click-to-place, drag-to-edit, keyboard shortcuts ----
    _bindDom() {
      const el = this.core.container;
      el.style.position = el.style.position || "relative";
      el.tabIndex = el.tabIndex >= 0 ? el.tabIndex : 0;

      el.addEventListener("mouseenter", () => { this._pointerInside = true; });
      el.addEventListener("mouseleave", () => { this._pointerInside = false; });

      el.addEventListener("mousedown", (e) => this._onMouseDown(e));
      window.addEventListener("mousemove", (e) => this._onMouseMove(e));
      window.addEventListener("mouseup", (e) => this._onMouseUp(e));
      el.addEventListener("dblclick", (e) => this._onDblClick(e));
      el.addEventListener("keydown", (e) => this._onKeyDown(e));
    }

    _relXY(e) {
      const rect = this.core.container.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _onMouseDown(e) {
      const { x, y } = this._relXY(e);
      if (this.activeTool) {
        this._placePoint(x, y);
        return;
      }
      const hit = this.hitTest(x, y);
      if (hit) {
        this.select(hit.id);
        const d = this.drawings.find((dd) => dd.id === hit.id);
        if (d && !d.locked) {
          this._dragState = { id: hit.id, handle: hit.handle, startX: x, startY: y, origPoints: JSON.parse(JSON.stringify(d.points)), origProps: JSON.parse(JSON.stringify(d.properties)) };
        }
      } else {
        this.select(null);
      }
    }

    _placePoint(x, y) {
      const def = TOOL_DEFS[this.activeTool];
      if (!def) return;
      let { time, price } = this.pixelToPoint(x, y);
      if (time == null || price == null) return;
      ({ time, price } = this.snapPoint(time, price));
      this.draft = this.draft || { type: this.activeTool, points: [] };
      this.draft.points.push({ time, price });
      // Unbounded tools (polyline, pointsNeeded === -1) never auto-finish on
      // point count - only _finishDraft() (dblclick/Enter) closes them, so
      // an arbitrary number of vertices can be placed first.
      if (def.pointsNeeded > 0 && this.draft.points.length >= def.pointsNeeded) {
        this._finishDraft();
      }
      this._emit();
    }

    /** Commits the in-progress draft as a real drawing. Used both by the
     * fixed-point-count auto-finish in _placePoint() and by the explicit
     * dblclick/Enter finish for unbounded tools (polyline) - requires at
     * least 2 points there, since a single-point "polyline" isn't a line. */
    _finishDraft() {
      if (!this.draft) return;
      const def = TOOL_DEFS[this.draft.type];
      if (def.pointsNeeded < 0 && this.draft.points.length < 2) return;
      const points = this.draft.points;
      const type = this.draft.type;
      this.draft = null;
      let properties;
      if (type === "long_position" || type === "short_position") properties = defaultProperties(type);
      this.addDrawing(type, points, properties);
      this.activeTool = null;
    }

    _onMouseMove(e) {
      const { x, y } = this._relXY(e);
      if (this._dragState) {
        this._applyDrag(x, y);
        return;
      }
      if (!this._pointerInside) { this.hoverId = null; return; }
      if (this.activeTool && this.draft) { this._draftPreviewPoint = { x, y }; this._emit(); return; }
      const hit = this.hitTest(x, y);
      const newHover = hit ? hit.id : null;
      if (newHover !== this.hoverId) { this.hoverId = newHover; this._emit(); }
    }

    _applyDrag(x, y) {
      const { id, handle, startX, startY, origPoints, origProps } = this._dragState;
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
          const dt = time - this.pixelToPoint(startX, startY).time;
          d.points = origPoints.map((p) => ({ time: p.time + dt, price: p.price }));
        }
      } else if (handle != null) {
        const snapped = this.snapPoint(time, price);
        const pts = origPoints.slice();
        pts[handle] = d.type === "horizontal_line" ? { time: pts[handle].time, price: snapped.price }
          : d.type === "vertical_line" ? { time: snapped.time, price: pts[handle].price }
          : snapped;
        d.points = pts;
      } else {
        // whole-shape drag: translate all points by the same time/price delta
        const start = this.pixelToPoint(startX, startY);
        const dt = time - start.time, dp = price - start.price;
        d.points = origPoints.map((p) => ({ time: p.time != null ? p.time + dt : null, price: p.price != null ? p.price + dp : null }));
      }
      this._emit();
    }

    _onMouseUp() {
      if (this._dragState) {
        const id = this._dragState.id;
        const d = this.drawings.find((dd) => dd.id === id);
        this._dragState = null;
        if (d) this._pushHistory(this._snapshot()); // coalesce: history already reflects final state, this just closes the drag
        this._emit();
      }
    }

    _onDblClick(e) {
      // Mid-draft (polyline): double-click both places one last vertex at
      // the cursor (matching the click that triggered it) and immediately
      // finishes the shape, rather than requiring a separate confirm step.
      if (this.activeTool && this.draft && TOOL_DEFS[this.draft.type].pointsNeeded < 0) {
        this._finishDraft();
        this._emit();
        return;
      }
      const { x, y } = this._relXY(e);
      const hit = this.hitTest(x, y);
      if (hit) {
        const d = this.drawings.find((dd) => dd.id === hit.id);
        if (d && (d.type === "text" || d.type === "note")) {
          const next = prompt("Текст заметки", d.properties.text || "");
          if (next != null) this.updateDrawing(d.id, { properties: { text: next } });
        }
      }
    }

    _onKeyDown(e) {
      if (!this._pointerInside && document.activeElement !== this.core.container) return;
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === "Enter" && this.draft && TOOL_DEFS[this.draft.type].pointsNeeded < 0) {
        e.preventDefault(); this._finishDraft(); this._emit(); return;
      }
      if (e.key === "Escape") { this.draft = null; this.activeTool = null; this._emit(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedId) {
        e.preventDefault(); this.removeDrawing(this.selectedId); return;
      }
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
      if (meta && e.key.toLowerCase() === "d" && this.selectedId) { e.preventDefault(); this.duplicateDrawing(this.selectedId); return; }
    }

    destroy() {
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
      for (let i = startLen; i < ops.length; i++) { ops[i].dash = dash; ops[i].d = ops[i].d || d; }
      if (ops.length && selected) ops[ops.length - 1].selected = true;
      if (ops.length && hovered) ops[ops.length - 1].hovered = true;
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
      ctx.setLineDash((op.dash || []).map((v) => v * r));
      if (op.hovered && !op.selected) { ctx.shadowColor = op.color; ctx.shadowBlur = 4 * r; }

      switch (op.kind) {
        case "hline":
          ctx.beginPath(); ctx.moveTo(0, op.y * rv); ctx.lineTo(w, op.y * rv); ctx.stroke();
          this._handle(ctx, w - 10 * r, op.y * rv, r);
          if (op.label) this._text(ctx, op.label, 8 * r, op.y * rv - 6 * rv, op.color);
          break;
        case "vline":
          ctx.beginPath(); ctx.moveTo(op.x * r, 0); ctx.lineTo(op.x * r, h); ctx.stroke();
          this._handle(ctx, op.x * r, 16 * rv, r);
          break;
        case "segment":
          ctx.beginPath(); ctx.moveTo(op.x1 * r, op.y1 * rv); ctx.lineTo(op.x2 * r, op.y2 * rv); ctx.stroke();
          op.handles.forEach((p) => p && this._handle(ctx, p.x * r, p.y * rv, r));
          break;
        case "rect": {
          const x1 = Math.min(op.x1, op.x2) * r, x2 = Math.max(op.x1, op.x2) * r;
          const y1 = Math.min(op.y1, op.y2) * rv, y2 = Math.max(op.y1, op.y2) * rv;
          if (op.fill) { ctx.globalAlpha = (op.alpha ?? 1) * 0.15; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); ctx.globalAlpha = op.alpha ?? 1; }
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          op.handles.forEach((p) => p && this._handle(ctx, p.x * r, p.y * rv, r));
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
          op.handles.forEach((p) => p && this._handle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "ellipse": {
          const cx = ((op.x1 + op.x2) / 2) * r, cy = ((op.y1 + op.y2) / 2) * rv;
          const rx = Math.abs(op.x2 - op.x1) / 2 * r, ry = Math.abs(op.y2 - op.y1) / 2 * rv;
          ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          if (op.fill) { ctx.globalAlpha = (op.alpha ?? 1) * 0.15; ctx.fill(); ctx.globalAlpha = op.alpha ?? 1; }
          ctx.stroke();
          op.handles.forEach((p) => p && this._handle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "polyline": {
          ctx.beginPath();
          op.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x * r, p.y * rv); else ctx.lineTo(p.x * r, p.y * rv); });
          ctx.stroke();
          op.handles.forEach((p) => p && this._handle(ctx, p.x * r, p.y * rv, r));
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
          op.handles.forEach((p) => p && this._handle(ctx, p.x * r, op.h * rv / 2, r));
          break;
        }
        case "note": {
          const px = op.x * r, py = op.y * rv;
          ctx.beginPath(); ctx.arc(px, py, 4 * r, 0, Math.PI * 2); ctx.fillStyle = op.color; ctx.fill();
          ctx.font = `${13 * rv}px Inter, sans-serif`;
          ctx.fillText(op.d.properties.text || "", px + 10 * r, py + 4 * rv);
          op.d._lastBox = { x1: op.x - 6, y1: op.y - 10, x2: op.x + 10 + ctx.measureText(op.d.properties.text || "").width / r, y2: op.y + 10 };
          this._handle(ctx, px, py, r);
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
          op.handles.forEach((p) => p && this._handle(ctx, p.x * r, p.y * rv, r));
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
          op.handles.forEach((p) => p && this._handle(ctx, p.x * r, p.y * rv, r));
          break;
        }
        case "text":
          ctx.font = `${13 * rv}px Inter, sans-serif`;
          ctx.fillStyle = op.color;
          ctx.fillText(op.d.properties.text || "", op.x * r + 4 * r, op.y * rv);
          op.d._lastBox = { x1: op.x, y1: op.y - 16, x2: op.x + ctx.measureText(op.d.properties.text || "").width / r + 8, y2: op.y + 4 };
          this._handle(ctx, op.x * r, op.y * rv, r);
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
    }
  }

  global.ChartEngine.Drawings = {
    DrawingManager,
    TOOL_DEFS,
    defaultProperties,
    positionStopPrice,
    positionTakePrice,
  };
})(window);
