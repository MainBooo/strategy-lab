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

  const TOOL_DEFS = {
    horizontal_line: { pointsNeeded: 1, label: "Горизонтальный уровень" },
    vertical_line: { pointsNeeded: 1, label: "Вертикальная линия" },
    trend_line: { pointsNeeded: 2, label: "Линия тренда" },
    ray: { pointsNeeded: 2, label: "Луч" },
    rectangle: { pointsNeeded: 2, label: "Прямоугольная зона" },
    price_range: { pointsNeeded: 2, label: "Измерение" },
    text: { pointsNeeded: 1, label: "Текстовая заметка" },
    long_position: { pointsNeeded: 2, label: "Long позиция" },
    short_position: { pointsNeeded: 2, label: "Short позиция" },
  };

  function defaultProperties(type) {
    const base = { color: theme.accent, width: 1, dash: "solid", opacity: 1, label: "" };
    if (type === "rectangle" || type === "price_range") return Object.assign(base, { fill: true });
    if (type === "long_position") return Object.assign(base, { color: theme.up, riskDistance: null, rewardDistance: null, stopOffsetPct: 1, takeOffsetPct: 2, quantity: 100 });
    if (type === "short_position") return Object.assign(base, { color: theme.down, stopOffsetPct: 1, takeOffsetPct: 2, quantity: 100 });
    if (type === "text") return Object.assign(base, { text: "Заметка" });
    return base;
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
      this.drawings = this.drawings.filter((d) => d.id !== id);
      if (this.selectedId === id) this.selectedId = null;
      this._pushHistory(before);
      this._emit({ removed: id });
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
        case "ray": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          let x2 = pix[1].x, y2 = pix[1].y;
          if (d.type === "ray") {
            const dx = pix[1].x - pix[0].x, dy = pix[1].y - pix[0].y;
            const scale = dx !== 0 ? (this.core.container.clientWidth * 2) / Math.max(1, Math.abs(dx)) : 1;
            x2 = pix[0].x + dx * scale; y2 = pix[0].y + dy * scale;
          }
          return pointToSegmentDist(px, py, pix[0].x, pix[0].y, x2, y2) <= tol ? { id: d.id, handle: null } : null;
        }
        case "rectangle":
        case "price_range": {
          if (pix.length < 2 || pix[0].x == null || pix[1].x == null) return null;
          if (handleAt(0)) return { id: d.id, handle: 0 };
          if (handleAt(1)) return { id: d.id, handle: 1 };
          const x1 = Math.min(pix[0].x, pix[1].x), x2 = Math.max(pix[0].x, pix[1].x);
          const y1 = Math.min(pix[0].y, pix[1].y), y2 = Math.max(pix[0].y, pix[1].y);
          return px >= x1 - tol && px <= x2 + tol && py >= y1 - tol && py <= y2 + tol ? { id: d.id, handle: null } : null;
        }
        case "text": {
          if (pix[0] == null || pix[0].x == null) return null;
          const box = d._lastBox;
          if (box && px >= box.x1 && px <= box.x2 && py >= box.y1 && py <= box.y2) return { id: d.id, handle: null };
          return handleAt(0) ? { id: d.id, handle: 0 } : null;
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
      if (this.draft.points.length >= def.pointsNeeded) {
        const points = this.draft.points;
        this.draft = null;
        let properties;
        if (this.activeTool === "long_position" || this.activeTool === "short_position") {
          properties = defaultProperties(this.activeTool);
        }
        this.addDrawing(this.activeTool, points, properties);
        this.activeTool = null;
      }
      this._emit();
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
      const { x, y } = this._relXY(e);
      const hit = this.hitTest(x, y);
      if (hit) {
        const d = this.drawings.find((dd) => dd.id === hit.id);
        if (d && d.type === "text") {
          const next = prompt("Текст заметки", d.properties.text || "");
          if (next != null) this.updateDrawing(d.id, { properties: { text: next } });
        }
      }
    }

    _onKeyDown(e) {
      if (!this._pointerInside && document.activeElement !== this.core.container) return;
      const meta = e.ctrlKey || e.metaKey;
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
      const pix = toPixels(this.manager.core, d.points);
      const color = d.properties.color || theme.accent;
      const width = (selected ? 2 : d.properties.width || 1);
      const alpha = isDraft ? 0.6 : 1;
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
          if (pix[0]?.x != null && pix[1]?.x != null) {
            const dx = pix[1].x - pix[0].x, dy = pix[1].y - pix[0].y;
            const scale = 4000 / Math.max(1, Math.hypot(dx, dy));
            ops.push({ kind: "segment", x1: pix[0].x, y1: pix[0].y, x2: pix[0].x + dx * scale, y2: pix[0].y + dy * scale, color, width, alpha, handles: [pix[0], pix[1]] });
          }
          break;
        case "rectangle":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "rect", x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, fill: d.properties.fill, handles: [pix[0], pix[1]] });
          break;
        case "price_range":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "measure", d, x1: pix[0].x, y1: pix[0].y, x2: pix[1].x, y2: pix[1].y, color, width, alpha, handles: [pix[0], pix[1]] });
          break;
        case "text":
          if (pix[0]?.x != null) ops.push({ kind: "text", d, x: pix[0].x, y: pix[0].y, color, alpha, handle: pix[0] });
          break;
        case "long_position":
        case "short_position":
          if (pix[0]?.x != null && pix[1]?.x != null) ops.push({ kind: "position", d, x1: Math.min(pix[0].x, pix[1].x), x2: Math.max(pix[0].x, pix[1].x), entryY: pix[0].y, alpha, long: d.type === "long_position" });
          break;
      }
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
      const dash = op.selected ? [] : [];
      ctx.setLineDash(dash);
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
