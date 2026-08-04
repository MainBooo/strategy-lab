/* One independent chart pane ("tile") for the multi-chart grid in
 * "Анализ графиков". Each tile owns its own ChartCore, IndicatorPaneManager,
 * DrawingManager and per-tile FullscreenController, so ticker/timeframe/
 * scale/indicators/drawings never leak between tiles. The shared toolbar in
 * chart-analysis.js only ever touches the *active* tile; ChartTile itself
 * knows nothing about "active" - that concept lives one level up. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;

  const TF_LABEL = { "1m": "1м", "10m": "10м", "30m": "30м", "60m": "1ч", "4h": "4ч", "1d": "1д", "1w": "1н", "1mo": "1мес" };

  let _seq = 0;

  class ChartTile {
    constructor({ symbol = "SBER", board = "TQBR", timeframe = "1d", from, to } = {}) {
      this.id = "tile" + ++_seq;
      this.symbol = symbol;
      this.board = board;
      this.timeframe = timeframe;
      this.to = to || new Date().toISOString().slice(0, 10);
      this.from = from || new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
      this.layout = null; // persisted chart-layout record for this tile's symbol, if loaded/saved
      this.core = null;
      this.indicatorMgr = null;
      this.drawingMgr = null;
      this.fsCtrl = null;
      this.el = null;
      this._rangeChangeCbs = [];
      this._crosshairCbs = [];
      this._applyingRange = false;
      this._applyingCrosshair = false;
    }

    /** Fires with the tile's own visible logical range whenever the user
     * pans/zooms it - used by the workspace to broadcast to other tiles
     * when range sync is enabled. Suppressed while a range is being
     * applied programmatically (applyLogicalRange) to avoid feedback loops. */
    onRangeChange(cb) { this._rangeChangeCbs.push(cb); }
    onCrosshairMove(cb) { this._crosshairCbs.push(cb); }

    applyLogicalRange(range) {
      if (!this.core || !range) return;
      this._applyingRange = true;
      try { this.core.chart.timeScale().setVisibleLogicalRange(range); }
      finally { this._applyingRange = false; }
    }

    applyCrosshair(time, price) {
      if (!this.core) return;
      this._applyingCrosshair = true;
      try {
        if (time == null) this.core.chart.clearCrosshairPosition();
        else this.core.chart.setCrosshairPosition(price ?? 0, time, this.core.candleSeries);
      } finally { this._applyingCrosshair = false; }
    }

    /** Builds the DOM (header + chart host) inside `container` and creates
     * the chart engine instances. `onActivate(tile)` fires on any pointer
     * interaction with the tile (so the workspace can make it the active
     * one). The close button is always rendered - the workspace hides it
     * via CSS (`.ca-tile-grid.layout-1 .ca-tile-close`) when only one tile
     * exists, rather than us tracking tile count here. */
    mount(container, { onActivate, onClose } = {}) {
      this.el = container;
      container.className = "ca-tile";
      container.innerHTML = `
        <div class="ca-tile-header">
          <span class="ca-tile-symbol" data-role="symbol"></span>
          <span class="ca-tile-tf" data-role="tf"></span>
          <span class="ca-tile-ohlc" data-role="ohlc"></span>
          <span class="ca-tile-change" data-role="change"></span>
          <span class="ca-tile-spacer"></span>
          <button class="ca-tile-btn" data-role="fs" title="Полноэкранный режим плитки" aria-label="Полноэкранный режим плитки">⛶</button>
          <button class="ca-tile-btn ca-tile-close" data-role="close" title="Закрыть плитку" aria-label="Закрыть плитку">✕</button>
        </div>
        <div class="ca-tile-chart-host"></div>
      `;
      const host = container.querySelector(".ca-tile-chart-host");
      this.core = new CE.ChartCore(host, { showVolume: true });
      this.indicatorMgr = new CE.Indicators.PaneManager(this.core);
      this.drawingMgr = new CE.Drawings.DrawingManager(this.core);
      this.core.onDataChanged(() => this._updatePriceHeader());
      this.core.chart.subscribeCrosshairMove((param) => {
        const bar = param && param.time != null ? this.core.candleAt(param.time) : null;
        this._updatePriceHeader(bar);
        if (!this._applyingCrosshair) {
          const price = param && param.seriesData && param.seriesData.get(this.core.candleSeries);
          this._crosshairCbs.forEach((cb) => cb(param && param.time, price && price.close));
        }
      });
      this.core.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!this._applyingRange) this._rangeChangeCbs.forEach((cb) => cb(range));
      });

      this.fsCtrl = new CE.Fullscreen.FullscreenController(container, {
        className: "is-fullscreen",
        onChange: () => {
          const btn = container.querySelector('[data-role="fs"]');
          btn.textContent = this.fsCtrl.active ? "⤢" : "⛶";
          btn.title = this.fsCtrl.active ? "Выйти из полноэкранного режима (Esc)" : "Полноэкранный режим плитки";
          requestAnimationFrame(() => this.core && this.core._onResize());
        },
      });
      container.querySelector('[data-role="fs"]').onclick = (e) => {
        e.stopPropagation();
        this.fsCtrl.toggle();
      };
      container.querySelector('[data-role="close"]').onclick = (e) => {
        e.stopPropagation();
        if (onClose) onClose(this);
      };
      if (onActivate) container.addEventListener("mousedown", () => onActivate(this));

      this.updateHeader();
    }

    updateHeader() {
      if (!this.el) return;
      this.el.querySelector('[data-role="symbol"]').textContent = this.symbol;
      this.el.querySelector('[data-role="tf"]').textContent = TF_LABEL[this.timeframe] || this.timeframe;
    }

    /** Shows the hovered bar's OHLC while the crosshair is over it (called
     * with `bar`), falling back to the latest bar otherwise (called with no
     * argument, e.g. from onDataChanged). Change % is always vs the bar
     * immediately before whichever bar is currently shown. */
    _updatePriceHeader(bar) {
      if (!this.el || !this.core) return;
      const candles = this.core.candles;
      const ohlcEl = this.el.querySelector('[data-role="ohlc"]');
      const changeEl = this.el.querySelector('[data-role="change"]');
      if (!candles.length) {
        ohlcEl.textContent = "";
        changeEl.textContent = "";
        return;
      }
      const target = bar || candles[candles.length - 1];
      const idx = candles.indexOf(target);
      const prev = idx > 0 ? candles[idx - 1] : null;
      const fmt = (n) => (n == null ? "—" : n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      ohlcEl.textContent = `ОТКР ${fmt(target.open)}  МАКС ${fmt(target.high)}  МИН ${fmt(target.low)}  ЗАКР ${fmt(target.close)}`;
      if (prev) {
        const diff = target.close - prev.close;
        const pct = prev.close ? (diff / prev.close) * 100 : 0;
        changeEl.textContent = `${diff >= 0 ? "+" : ""}${fmt(diff)} (${diff >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
        changeEl.className = `ca-tile-change ${diff >= 0 ? "pnl-pos" : "pnl-neg"}`;
      } else {
        changeEl.textContent = "";
        changeEl.className = "ca-tile-change";
      }
    }

    setActiveVisual(active) {
      if (this.el) this.el.classList.toggle("active", active);
    }

    /** A plain-data snapshot for archiving a tile that's removed from the
     * grid by a layout change, so growing the layout back can restore it
     * instead of silently discarding the user's setup. */
    toConfig() {
      return { symbol: this.symbol, board: this.board, timeframe: this.timeframe, from: this.from, to: this.to };
    }

    destroy() {
      if (this.fsCtrl) this.fsCtrl.destroy();
      if (this.core) this.core.destroy();
      this.core = null;
      this.indicatorMgr = null;
      this.drawingMgr = null;
      this.el = null;
    }
  }

  CE.ChartTile = ChartTile;
})(window);
