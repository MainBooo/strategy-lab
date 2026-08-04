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
