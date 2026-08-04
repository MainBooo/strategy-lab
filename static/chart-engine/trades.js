/* Trade visualization layer: entry/exit markers, the entry<->exit
 * connector, per-trade levels (entry/stop/take/exit clipped to the
 * trade's own lifetime) and risk/reward zones. Rendered with a single
 * canvas Series Primitive (TradeOverlayPrimitive) rather than one DOM
 * node per trade, so a run with hundreds of trades stays cheap to pan
 * and zoom. Markers use lightweight-charts' own createSeriesMarkers
 * plugin. Everything here only reads {entryTime,entryPrice,exitTime,
 * exitPrice,stopLoss,takeProfit,direction,exitReason} - it never
 * recomputes a trade, it only draws what the backend already decided. */
(function (global) {
  "use strict";

  const theme = global.ChartEngine.theme;

  const EXIT_LABEL = { take: "TP", stop: "SL", end_of_period: "END" };
  const EXIT_COLOR = { take: theme.up, stop: theme.down, end_of_period: theme.muted };

  function isLong(trade) {
    return String(trade.direction).toLowerCase() === "long";
  }

  function tradeColor(trade) {
    return Number(trade.net_profit) >= 0 ? theme.up : theme.down;
  }

  /** Builds the marker list for createSeriesMarkers, given the trades currently meant to be visible. */
  function buildMarkers(trades, { showLabels, showExits } = {}) {
    const markers = [];
    for (const t of trades) {
      const long = isLong(t);
      markers.push({
        time: t.entry_time,
        position: long ? "belowBar" : "aboveBar",
        color: tradeColor(t),
        shape: long ? "arrowUp" : "arrowDown",
        text: showLabels ? (long ? "L" : "S") + (t.number ? ` #${t.number}` : "") : "",
        id: `entry_${t.id}`,
      });
      if (showExits && t.exit_time) {
        const label = EXIT_LABEL[t.exit_reason] || (t.exit_reason ? String(t.exit_reason).toUpperCase() : "EXIT");
        markers.push({
          time: t.exit_time,
          position: long ? "aboveBar" : "belowBar",
          color: EXIT_COLOR[t.exit_reason] || theme.accent,
          shape: "circle",
          text: showLabels ? label : "",
          id: `exit_${t.id}`,
        });
      }
    }
    return markers.sort((a, b) => a.time - b.time);
  }

  class TradeOverlayPaneView {
    constructor(source) {
      this._source = source;
      this._segments = [];
      this._zones = [];
    }

    update() {
      const src = this._source;
      const series = src.series;
      const ts = src.chart.timeScale();
      const x = (time) => ts.timeToCoordinate(time);
      const y = (price) => series.priceToCoordinate(price);

      this._segments = [];
      this._zones = [];

      for (const t of src.trades) {
        if (t.exit_time == null) continue;
        const x1 = x(t.entry_time), x2 = x(t.exit_time);
        if (x1 == null || x2 == null) continue;
        const y1 = y(t.entry_price), y2 = y(t.exit_price);
        const selected = src.selectedId === t.id;
        this._segments.push({
          kind: "connector", x1, y1, x2, y2, color: tradeColor(t), selected,
        });
      }

      const sel = src.trades.find((t) => t.id === src.selectedId);
      if (sel) {
        const x1 = x(sel.entry_time);
        const x2 = sel.exit_time != null ? x(sel.exit_time) : x1 + 60;
        if (x1 != null && x2 != null) {
          const entryY = y(sel.entry_price);
          if (sel.stop_loss != null) {
            const stopY = y(sel.stop_loss);
            if (entryY != null && stopY != null) {
              this._segments.push({ kind: "level", x1, x2, y: stopY, color: theme.down, label: `Стоп ${fmtPrice(sel.stop_loss)}` });
              this._zones.push({ x1, x2, yTop: Math.min(entryY, stopY), yBottom: Math.max(entryY, stopY), color: "rgba(255,112,129,.14)" });
            }
          }
          if (sel.take_profit != null) {
            const takeY = y(sel.take_profit);
            if (entryY != null && takeY != null) {
              this._segments.push({ kind: "level", x1, x2, y: takeY, color: theme.up, label: `Тейк ${fmtPrice(sel.take_profit)}` });
              this._zones.push({ x1, x2, yTop: Math.min(entryY, takeY), yBottom: Math.max(entryY, takeY), color: "rgba(77,212,172,.14)" });
            }
          }
          if (entryY != null) this._segments.push({ kind: "level", x1, x2, y: entryY, color: theme.accent, label: `Вход ${fmtPrice(sel.entry_price)}` });
        }
      }
    }

    renderer() {
      const segments = this._segments;
      const zones = this._zones;
      return {
        draw: (target) => {
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context;
            const r = scope.horizontalPixelRatio, rv = scope.verticalPixelRatio;
            ctx.save();
            for (const z of zones) {
              ctx.fillStyle = z.color;
              ctx.fillRect(z.x1 * r, z.yTop * rv, (z.x2 - z.x1) * r, (z.yBottom - z.yTop) * rv);
            }
            for (const s of segments) {
              if (s.kind === "connector") {
                ctx.strokeStyle = s.color;
                ctx.lineWidth = (s.selected ? 2 : 1) * r;
                ctx.globalAlpha = s.selected ? 1 : 0.45;
                ctx.setLineDash(s.selected ? [] : [4 * r, 3 * r]);
                ctx.beginPath();
                ctx.moveTo(s.x1 * r, s.y1 * rv);
                ctx.lineTo(s.x2 * r, s.y2 * rv);
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.setLineDash([]);
              } else if (s.kind === "level") {
                ctx.strokeStyle = s.color;
                ctx.lineWidth = 1.5 * r;
                ctx.setLineDash([2 * r, 2 * r]);
                ctx.beginPath();
                ctx.moveTo(s.x1 * r, s.y * rv);
                ctx.lineTo(s.x2 * r, s.y * rv);
                ctx.stroke();
                ctx.setLineDash([]);
                if (s.label) {
                  ctx.font = `${11 * rv}px Inter, sans-serif`;
                  ctx.fillStyle = s.color;
                  ctx.fillText(s.label, (s.x2 + 6) * r, s.y * rv + 4 * rv);
                }
              }
            }
            ctx.restore();
          });
        },
      };
    }
  }

  function fmtPrice(p) {
    return Number(p).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  }

  class TradeOverlayPrimitive {
    constructor(chart, series) {
      this.chart = chart;
      this.series = series;
      this.trades = [];
      this.selectedId = null;
      this._paneViews = [new TradeOverlayPaneView(this)];
      this._requestUpdate = null;
    }
    attached(params) { this._requestUpdate = params && params.requestUpdate; }
    setTrades(trades) { this.trades = trades; this._requestUpdate && this._requestUpdate(); }
    setSelected(id) { this.selectedId = id; this._requestUpdate && this._requestUpdate(); }
    updateAllViews() { this._paneViews.forEach((v) => v.update()); }
    paneViews() { return this._paneViews; }
  }

  /** Filters + selection state for the trades shown on one chart; drives markers, overlay and the linked table. */
  class TradeSelectionManager {
    constructor() {
      this.allTrades = [];
      this.filtered = [];
      this.selectedId = null;
      this._listeners = new Set();
    }
    setTrades(trades) {
      this.allTrades = trades;
      this._reapply();
    }
    setFilters(predicate) {
      this._predicate = predicate;
      this._reapply();
    }
    _reapply() {
      this.filtered = this._predicate ? this.allTrades.filter(this._predicate) : this.allTrades.slice();
      if (this.selectedId != null && !this.filtered.some((t) => t.id === this.selectedId)) this.selectedId = null;
      this._emit();
    }
    select(id) {
      this.selectedId = id;
      this._emit();
    }
    selectedTrade() {
      return this.filtered.find((t) => t.id === this.selectedId) || null;
    }
    next() {
      const i = this.filtered.findIndex((t) => t.id === this.selectedId);
      if (this.filtered.length) this.select(this.filtered[(i + 1) % this.filtered.length].id);
    }
    prev() {
      const i = this.filtered.findIndex((t) => t.id === this.selectedId);
      if (this.filtered.length) this.select(this.filtered[(i - 1 + this.filtered.length) % this.filtered.length].id);
    }
    onChange(cb) {
      this._listeners.add(cb);
      return () => this._listeners.delete(cb);
    }
    _emit() {
      this._listeners.forEach((cb) => cb(this));
    }
  }

  global.ChartEngine.Trades = {
    buildMarkers,
    TradeOverlayPrimitive,
    TradeSelectionManager,
    EXIT_LABEL,
    EXIT_COLOR,
    fmtPrice,
  };
})(window);
