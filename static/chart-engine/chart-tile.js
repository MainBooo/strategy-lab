/* One independent chart pane ("tile") for the multi-chart grid in
 * "Анализ графиков". Each tile owns its own ChartCore, IndicatorPaneManager,
 * DrawingManager, RealtimeIndicator, per-tile FullscreenController, AND (as
 * of this rewrite) its own complete settings header - symbol/board/
 * timeframe/chart type/range/indicators/templates/save/order-strategy -
 * instead of those living in one shared toolbar above the whole workspace.
 * A tile's state (ticker/board/timeframe/chartType/rangeMode/fromDate/
 * toDate/layout/drawings/live subscription) is entirely its own; nothing
 * here reads or writes another tile. The one thing that stays workspace-
 * level (chart-analysis.js's Page) is the *drawing toolbar* (tool palette,
 * undo/redo/snap, properties/objects side panel) and the layout switch -
 * those act on whichever tile is "active", a concept this file exposes via
 * setActiveVisual()/the onActivate callback but never tracks itself. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;

  const TIMEFRAMES = [
    { id: "1m", label: "1м" }, { id: "10m", label: "10м" }, { id: "30m", label: "30м" },
    { id: "60m", label: "1ч" }, { id: "4h", label: "4ч" }, { id: "1d", label: "1д" },
    { id: "1w", label: "1н" }, { id: "1mo", label: "1мес" },
  ];
  const TF_LABEL = TIMEFRAMES.reduce((m, t) => (m[t.id] = t.label, m), {});
  const CHART_TYPES = [
    { id: "candles", label: "Свечи" }, { id: "bars", label: "Бары" },
    { id: "line", label: "Линия" }, { id: "area", label: "Область" },
  ];
  /* Live-ticking the current candle (see _onRealtimeUpdate below) only
   * covers timeframes with a fixed bucket width in seconds. A calendar day
   * IS a fixed 86400s width (MSK has no DST - see market_data_sync.py's
   * "naive MSK wall-clock treated as UTC" convention, which this bucketing
   * relies on), so "1d" fits the same math as the intraday buckets and the
   * daily bar ticks live during the session too. 1w/1mo don't: the
   * exchange's trading week/month isn't a fixed multiple of a day (holidays
   * shift boundaries), so their "current bucket" can't be derived this way. */
  const LIVE_TICK_BUCKET_SECONDS = { "1m": 60, "10m": 600, "30m": 1800, "60m": 3600, "4h": 4 * 3600, "1d": 86400 };
  // Rough MOEX trading-session bars/day per timeframe (~10:00-23:50 MSK,
  // ~830 minutes) - only used to translate a "days" quick-range preset into
  // a bar count for setVisibleBarCount(); doesn't need to be exact, just in
  // the right ballpark so "1Г" roughly shows a year, not a week or a decade.
  const BARS_PER_DAY = { "1m": 830, "10m": 83, "30m": 28, "60m": 14, "4h": 3.5, "1d": 1, "1w": 0.2, "1mo": 0.05 };
  const RANGE_PRESETS = [
    { label: "1Д", days: 1 }, { label: "5Д", days: 5 }, { label: "1М", days: 30 }, { label: "3М", days: 90 },
    { label: "6М", days: 182 }, { label: "1Г", days: 365 }, { label: "5Л", days: 365 * 5 },
  ];
  const COMPACT_WIDTH = 640; // px - below this a tile's own header switches to the mobile/compact layout

  let _seq = 0;

  function fmtPrice(n) {
    return n == null ? "—" : n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDateShort(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" });
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
  function toHex(color) {
    if (!color || color[0] === "#") return color || "#7c8cff";
    const m = color.match(/rgba?\((\d+),(\d+),(\d+)/);
    if (!m) return "#7c8cff";
    return "#" + m.slice(1, 4).map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  }

  class ChartTile {
    constructor({ symbol = "SBER", board = "TQBR", timeframe = "1d", chartType = "candles" } = {}) {
      this.id = "tile" + ++_seq;
      this.symbol = symbol;
      this.board = board;
      this.timeframe = timeframe;
      this._initialChartType = chartType;
      // Full-history-by-default (see docs): a fresh tile never starts with
      // fromDate/toDate filled in - see also toConfig()/ChartAnalysisPage's
      // workspace-state restore, which deliberately never persists these
      // three fields, so reload/resize/restore always lands back on "all".
      this.rangeMode = "all"; // "all" | "custom"
      this.fromDate = null;
      this.toDate = null;
      this.layout = null; // persisted chart-layout record for this tile's symbol, if loaded/saved
      this.securities = [];
      this.core = null;
      this.indicatorMgr = null;
      this.drawingMgr = null;
      this.indicator = null; // RealtimeIndicator, own instance per tile
      this.fsCtrl = null;
      this.el = null;
      this._compact = false;
      this._saveTimers = {};
      this._rangeChangeCbs = [];
      this._crosshairCbs = [];
      this._applyingRange = false;
      this._applyingCrosshair = false;
    }

    // ---------------------------------------------------------- wiring ----

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

    setSecurities(list) {
      this.securities = list || [];
      const sel = this.el && this.el.querySelector('[data-role="symbol"]');
      if (!sel) return;
      sel.innerHTML = this.securities.map((s) => `<option value="${s.SECID}">${s.SECID} · ${s.SHORTNAME || ""}</option>`).join("");
      sel.value = this.symbol;
    }

    // ----------------------------------------------------------- mount ----

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
        <div class="ca-tile-header" data-role="header">
          <div class="ca-tile-row1">
            <select class="ca-tile-select ca-tile-select-symbol" data-role="symbol" aria-label="Инструмент"></select>
            <select class="ca-tile-select ca-tile-select-tf" data-role="timeframe" aria-label="Таймфрейм">
              ${TIMEFRAMES.map((t) => `<option value="${t.id}">${t.label}</option>`).join("")}
            </select>
            <span class="ca-tile-price" data-role="price"></span>
            <span class="ca-tile-change" data-role="change"></span>
            <span class="ca-tile-spacer"></span>
            <div class="ca-tile-realtime-slot" data-role="realtimeSlot"></div>
            <button class="ca-tile-btn" data-role="fs" title="Полноэкранный режим плитки" aria-label="Полноэкранный режим плитки">⛶</button>
            <button class="ca-tile-btn ca-tile-close" data-role="close" title="Закрыть плитку" aria-label="Закрыть плитку">✕</button>
          </div>
          <div class="ca-tile-row2" data-role="row2">
            <select class="ca-tile-select ca-tile-select-type" data-role="chartType" aria-label="Тип графика">
              ${CHART_TYPES.map((t) => `<option value="${t.id}">${t.label}</option>`).join("")}
            </select>
            <div class="ca-tile-menu" data-role="rangeMenu">
              <button class="ca-tile-btn2 ca-tile-range-btn" data-role="rangeBtn" aria-haspopup="true">Диапазон: Все ▾</button>
              <div class="ca-popover hidden" data-role="rangePopover"></div>
            </div>
            <div class="ca-tile-overflow" data-role="overflowGroup">
              <select class="ca-tile-select ca-tile-select-board" data-role="board" aria-label="Рынок"><option value="TQBR">TQBR</option></select>
              <div class="ca-tile-menu" data-role="indicatorsMenu">
                <button class="ca-tile-btn2" data-role="indicatorsBtn" aria-haspopup="true">Индикаторы</button>
                <div class="ca-popover hidden" data-role="indicatorsPopover"></div>
              </div>
              <div class="ca-tile-menu" data-role="templatesMenu">
                <button class="ca-tile-btn2" data-role="templatesBtn" aria-haspopup="true">Шаблоны</button>
                <div class="ca-popover hidden" data-role="templatesPopover"></div>
              </div>
              <button class="ca-tile-btn2" data-role="saveBtn">Сохранить</button>
            </div>
            <span class="ca-tile-spacer"></span>
            <div class="ca-tile-menu" data-role="moreMenu">
              <button class="ca-tile-btn icon-btn" data-role="moreBtn" title="Ещё" aria-label="Дополнительные действия" aria-haspopup="true">⋯</button>
              <div class="ca-popover ca-popover-right hidden" data-role="morePopover"></div>
            </div>
          </div>
          <button class="ca-tile-settings-btn hidden" data-role="settingsBtn" aria-label="Настройки графика">⚙ Настройки</button>
        </div>
        <div class="ca-tile-chart-host" data-role="chartHost">
          <button class="ca-tile-live-btn hidden" data-role="live" type="button">К последней цене</button>
        </div>
      `;

      const host = container.querySelector('[data-role="chartHost"]');
      this.core = new CE.ChartCore(host, { showVolume: true });
      if (this._initialChartType && this._initialChartType !== "candles") this.core.setSeriesType(this._initialChartType);
      this.indicatorMgr = new CE.Indicators.PaneManager(this.core);
      this.drawingMgr = new CE.Drawings.DrawingManager(this.core);
      this.core.onSeriesChange((newSeries) => this.drawingMgr.rebindSeries(newSeries));
      this.core.onDataChanged(() => this._updatePriceHeader());
      this.drawingMgr.onChange((mgr, detail) => this._onDrawingsChanged(detail));

      const liveBtn = container.querySelector('[data-role="live"]');
      liveBtn.onclick = (e) => { e.stopPropagation(); this.core.scrollToRealTime(); };
      this.core.onFollowChange((following, count) => {
        liveBtn.classList.toggle("hidden", following);
        liveBtn.textContent = count > 0 ? `К последней цене · +${count}` : "К последней цене";
      });

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
      container.querySelector('[data-role="fs"]').onclick = (e) => { e.stopPropagation(); this.fsCtrl.toggle(); };
      container.querySelector('[data-role="close"]').onclick = (e) => { e.stopPropagation(); if (onClose) onClose(this); };
      if (onActivate) container.addEventListener("mousedown", () => onActivate(this));

      this._bindHeaderControls();
      this._buildRangePopover();
      this._buildIndicatorPopover();
      this._buildTemplatePopover();
      this._buildMorePopover();
      this.setSecurities(this.securities);

      if (global.RealtimeIndicator) {
        this.indicator = new global.RealtimeIndicator(container.querySelector('[data-role="realtimeSlot"]'), {
          compact: () => this._compact,
          onUpdate: (data) => this._onRealtimeUpdate(data),
        });
      }

      this._resizeObserver = new ResizeObserver((entries) => {
        const w = entries[0].contentRect.width;
        this._setCompact(w < COMPACT_WIDTH);
      });
      this._resizeObserver.observe(container);

      this.updateHeader();
      this._loadOrInit();
    }

    // ------------------------------------------------------------ header --

    _bindHeaderControls() {
      const el = this.el;
      el.querySelector('[data-role="symbol"]').onchange = (e) => this._setSymbol(e.target.value);
      el.querySelector('[data-role="timeframe"]').value = this.timeframe;
      el.querySelector('[data-role="timeframe"]').onchange = (e) => {
        this.timeframe = e.target.value;
        this.updateHeader();
        this._reload();
        this._notifyStateChanged();
      };
      el.querySelector('[data-role="chartType"]').onchange = (e) => {
        if (this.core) this.core.setSeriesType(e.target.value);
        this._notifyStateChanged();
      };
      el.querySelector('[data-role="board"]').onchange = (e) => { this.board = e.target.value; this._reload(); this._notifyStateChanged(); };
      el.querySelector('[data-role="saveBtn"]').onclick = () => this._saveAsTemplate();
      el.querySelector('[data-role="settingsBtn"]').onclick = () => this._openSettingsSheet();
    }

    _setCompact(compact) {
      if (compact === this._compact) return;
      this._compact = compact;
      this.el.querySelector('[data-role="header"]').classList.toggle("compact", compact);
      this.el.querySelector('[data-role="settingsBtn"]').classList.toggle("hidden", !compact);
      if (!compact) this._closeSettingsSheet();
    }

    /** Mobile/narrow-tile settings: moves the overflow controls (board,
     * indicators, templates, save) that don't fit inline into a bottom
     * sheet instead of hiding them - chart type and range stay visible
     * inline even when compact (spec: row2 keeps "тип графика; режим;
     * статус"). Same real <select>s and buttons, not a duplicated second
     * set of controls, so there is only ever one source of truth for tile
     * state regardless of viewport. */
    _openSettingsSheet() {
      this._closeSettingsSheet();
      const group = this.el.querySelector('[data-role="overflowGroup"]');
      const sheet = document.createElement("div");
      sheet.className = "ca-sheet-backdrop";
      sheet.innerHTML = `<div class="ca-sheet"><div class="ca-sheet-handle"></div><h4>Настройки графика · ${this.symbol}</h4><div class="ca-sheet-body"></div></div>`;
      document.body.appendChild(sheet);
      sheet.querySelector(".ca-sheet-body").appendChild(group);
      group.classList.add("in-sheet");
      sheet.onclick = (e) => { if (e.target === sheet) this._closeSettingsSheet(); };
      this._sheet = sheet;
    }

    _closeSettingsSheet() {
      if (!this._sheet) return;
      const row2 = this.el.querySelector('[data-role="row2"]');
      const group = this._sheet.querySelector('[data-role="overflowGroup"]');
      group.classList.remove("in-sheet");
      row2.insertBefore(group, row2.querySelector(".ca-tile-spacer"));
      this._sheet.remove();
      this._sheet = null;
    }

    _setSymbol(ticker) {
      this.symbol = ticker;
      this.layout = null;
      this.rangeMode = "all";
      this.fromDate = null;
      this.toDate = null;
      this.updateHeader();
      if (this.indicator) this.indicator.setSymbol(ticker);
      this._loadOrInit();
      this._notifyStateChanged({ symbolChanged: true });
    }

    /** Programmatic symbol change (watchlist click, template load) - same
     * effect as picking it from the select, kept separate so callers don't
     * have to reach into the DOM. */
    selectSymbol(ticker) {
      const sel = this.el && this.el.querySelector('[data-role="symbol"]');
      if (sel) sel.value = ticker;
      this._setSymbol(ticker);
    }

    updateHeader() {
      if (!this.el) return;
      const sym = this.el.querySelector('[data-role="symbol"]'); if (sym) sym.value = this.symbol;
      const tf = this.el.querySelector('[data-role="timeframe"]'); if (tf) tf.value = this.timeframe;
      const ct = this.el.querySelector('[data-role="chartType"]'); if (ct) ct.value = this.core ? this.core.seriesType : this._initialChartType;
      const board = this.el.querySelector('[data-role="board"]'); if (board) board.value = this.board;
      this._updateRangeButtonLabel();
    }

    /** Shows the hovered bar's OHLC while the crosshair is over it (called
     * with `bar`), falling back to the latest bar otherwise (called with no
     * argument, e.g. from onDataChanged). Change % is always vs the bar
     * immediately before whichever bar is currently shown. */
    _updatePriceHeader(bar) {
      if (!this.el || !this.core) return;
      const candles = this.core.candles;
      const priceEl = this.el.querySelector('[data-role="price"]');
      const changeEl = this.el.querySelector('[data-role="change"]');
      if (!candles.length) { priceEl.textContent = ""; changeEl.textContent = ""; return; }
      const target = bar || candles[candles.length - 1];
      const idx = candles.indexOf(target);
      const prev = idx > 0 ? candles[idx - 1] : null;
      priceEl.textContent = fmtPrice(target.close);
      if (prev) {
        const diff = target.close - prev.close;
        const pct = prev.close ? (diff / prev.close) * 100 : 0;
        changeEl.textContent = `${diff >= 0 ? "+" : ""}${fmtPrice(diff)} (${diff >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
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
     * grid by a layout change, so growing the layout back can restore it -
     * and for workspace-state localStorage persistence. Deliberately does
     * NOT include rangeMode/fromDate/toDate: a restored/resized tile always
     * comes back in "full history" mode, never a stale custom range from a
     * previous session (see the constructor's docstring). */
    toConfig() {
      return { symbol: this.symbol, board: this.board, timeframe: this.timeframe, chartType: this.core ? this.core.seriesType : this._initialChartType };
    }

    destroy() {
      this._closeSettingsSheet();
      if (this._resizeObserver) this._resizeObserver.disconnect();
      if (this.indicator) this.indicator.destroy();
      if (this.fsCtrl) this.fsCtrl.destroy();
      if (this.core) this.core.destroy();
      this.core = null;
      this.indicatorMgr = null;
      this.drawingMgr = null;
      this.el = null;
    }

    // ------------------------------------------------------- popovers -----

    _wirePopover(btn, pop, onOpen) {
      btn.onclick = (e) => {
        e.stopPropagation();
        const willOpen = pop.classList.contains("hidden");
        this.el.querySelectorAll(".ca-popover").forEach((p) => p.classList.add("hidden"));
        if (willOpen) {
          pop.classList.remove("hidden");
          if (onOpen) onOpen();
        }
      };
      document.addEventListener("click", (e) => { if (!pop.contains(e.target) && e.target !== btn) pop.classList.add("hidden"); });
    }

    _buildIndicatorPopover() {
      const pop = this.el.querySelector('[data-role="indicatorsPopover"]');
      pop.innerHTML = CE.Indicators.registry.map((def) => `
        <label class="ca-indicator-row">
          <input type="checkbox" data-ind="${def.id}">
          <span>${def.label}</span>
        </label>`).join("");
      pop.querySelectorAll("input[data-ind]").forEach((cb) => {
        cb.onchange = () => {
          const id = cb.dataset.ind;
          const key = "_ind_" + id;
          if (cb.checked) this[key] = this.indicatorMgr.add(id, {});
          else if (this[key]) { this.indicatorMgr.remove(this[key]); this[key] = null; }
        };
      });
      this._wirePopover(this.el.querySelector('[data-role="indicatorsBtn"]'), pop);
    }

    _buildTemplatePopover() {
      const pop = this.el.querySelector('[data-role="templatesPopover"]');
      this._wirePopover(this.el.querySelector('[data-role="templatesBtn"]'), pop, async () => {
        pop.innerHTML = `<div class="muted-note">Загрузка…</div>`;
        const layouts = await CE.api.listLayouts("analysis", this.symbol).catch(() => []);
        pop.innerHTML = layouts.length
          ? layouts.map((l) => `
              <div class="ca-template-row">
                <button class="link-btn ca-template-load" data-id="${l.id}">${l.name}${l.is_default ? " ★" : ""}</button>
                <button class="icon-btn" data-del="${l.id}" title="Удалить">🗑</button>
              </div>`).join("")
          : `<div class="muted-note">Нет сохранённых шаблонов для ${this.symbol}</div>`;
        pop.querySelectorAll(".ca-template-load").forEach((b) => (b.onclick = async () => {
          const l = await CE.api.getLayout(b.dataset.id);
          await this._applyLayout(l);
          pop.classList.add("hidden");
        }));
        pop.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async (e) => {
          e.stopPropagation();
          await CE.api.deleteLayout(b.dataset.del);
          b.closest(".ca-template-row").remove();
        }));
      });
    }

    _buildMorePopover() {
      const pop = this.el.querySelector('[data-role="morePopover"]');
      pop.innerHTML = `
        <button class="link-btn ca-more-item" data-action="order">⚙ Заказать стратегию по разметке</button>
        <button class="link-btn ca-more-item" data-action="snap">🧲 Прилипание к свечам</button>
        <button class="link-btn ca-more-item" data-action="reset-layout">↺ Сбросить график</button>
      `;
      pop.querySelector('[data-action="order"]').onclick = () => { pop.classList.add("hidden"); this._openOrderModal(); };
      pop.querySelector('[data-action="snap"]').onclick = (e) => {
        if (!this.drawingMgr) return;
        this.drawingMgr.snapEnabled = !this.drawingMgr.snapEnabled;
        e.target.classList.toggle("active", this.drawingMgr.snapEnabled);
      };
      pop.querySelector('[data-action="reset-layout"]').onclick = () => { pop.classList.add("hidden"); this.core && this.core.fitContent(); };
      this._wirePopover(this.el.querySelector('[data-role="moreBtn"]'), pop);
    }

    // ---------------------------------------------------------- range -----

    _buildRangePopover() {
      const pop = this.el.querySelector('[data-role="rangePopover"]');
      this._wirePopover(this.el.querySelector('[data-role="rangeBtn"]'), pop, () => this._renderRangePopover());
      this._renderRangePopover();
    }

    _renderRangePopover() {
      const pop = this.el.querySelector('[data-role="rangePopover"]');
      const isCustom = this.rangeMode === "custom";
      pop.innerHTML = `
        <div class="ca-range-presets">
          ${RANGE_PRESETS.map((p) => `<button class="range-preset" data-days="${p.days}">${p.label}</button>`).join("")}
          <button class="range-preset ${!isCustom ? "active" : ""}" data-all="1">Все</button>
        </div>
        <button class="link-btn ca-range-custom-toggle" data-action="custom">Выбрать период…</button>
        <div class="ca-range-custom hidden" data-role="customForm">
          <label>С <input type="date" data-role="rangeFrom" value="${this.fromDate || ""}"></label>
          <label>По <input type="date" data-role="rangeTo" value="${this.toDate || todayISO()}"></label>
          <button class="secondary ca-range-apply" data-action="apply">Применить</button>
        </div>
        ${isCustom ? `<button class="link-btn ca-range-reset" data-action="reset">Сбросить период</button>` : ""}
      `;
      pop.querySelectorAll(".range-preset[data-days]").forEach((b) => (b.onclick = () => { this._applyQuickRange(Number(b.dataset.days)); pop.classList.add("hidden"); }));
      const allBtn = pop.querySelector(".range-preset[data-all]");
      if (allBtn) allBtn.onclick = () => { this._resetRange(); pop.classList.add("hidden"); };
      pop.querySelector('[data-action="custom"]').onclick = (e) => { e.stopPropagation(); pop.querySelector('[data-role="customForm"]').classList.toggle("hidden"); };
      pop.querySelector('[data-action="apply"]').onclick = () => {
        const from = pop.querySelector('[data-role="rangeFrom"]').value;
        const to = pop.querySelector('[data-role="rangeTo"]').value || todayISO();
        if (!from) return;
        this._applyCustomRange(from, to);
        pop.classList.add("hidden");
      };
      const resetBtn = pop.querySelector('[data-action="reset"]');
      if (resetBtn) resetBtn.onclick = () => { this._resetRange(); pop.classList.add("hidden"); };
    }

    _updateRangeButtonLabel() {
      const btn = this.el && this.el.querySelector('[data-role="rangeBtn"]');
      if (!btn) return;
      btn.textContent = this.rangeMode === "custom"
        ? `${fmtDateShort(this.fromDate)} — ${fmtDateShort(this.toDate) || "сегодня"} ▾`
        : "Диапазон: Все ▾";
    }

    /** Quick preset (1Д…5Л): a pure *visual zoom* shortcut, per spec - it
     * never touches rangeMode/fromDate/toDate or stops live updates. If the
     * requested span reaches further back than what's currently loaded,
     * ensureCoverageBack() lazily pages in the missing older bars first
     * (same mechanism as scrolling left) so the zoom doesn't land on empty
     * space. */
    async _applyQuickRange(days) {
      if (!this.core || !this.core.candles.length) return;
      const toTs = this.core.candles[this.core.candles.length - 1].time;
      const fromTs = toTs - days * 86400;
      if (this.core.candles[0].time > fromTs) {
        await this.core.ensureCoverageBack(new Date(fromTs * 1000).toISOString().slice(0, 10));
      }
      const barsPerDay = BARS_PER_DAY[this.timeframe] || 1;
      this.core.setVisibleBarCount(Math.round(days * barsPerDay));
    }

    /** Explicit custom period (the "Выбрать период" form): this DOES set
     * rangeMode/fromDate/toDate and reloads from the API with that window -
     * unlike the quick presets, which only re-zoom already-tail-loaded
     * data. Live ticking keeps working unless `to` is a genuinely past date
     * (see _onRealtimeUpdate) - picking "today" as `to` (the form's own
     * default) behaves exactly like "all" except the loaded window is
     * bounded, per the spec's "custom range doesn't permanently disable
     * new candles" rule. */
    _applyCustomRange(from, to) {
      this.rangeMode = "custom";
      this.fromDate = from;
      this.toDate = to;
      this.updateHeader();
      this._reload();
      this._notifyStateChanged();
    }

    _resetRange() {
      this.rangeMode = "all";
      this.fromDate = null;
      this.toDate = null;
      this.updateHeader();
      this._reload();
      this._notifyStateChanged();
    }

    // ------------------------------------------------------- data load ----

    async _reload() {
      if (!this.core) return;
      const host = this.el.querySelector('[data-role="chartHost"]');
      let status = host.querySelector(".ca-tile-status");
      if (!status) {
        status = document.createElement("div");
        status.className = "ca-tile-status";
        host.appendChild(status);
      }
      status.textContent = "Загрузка свечей…";
      status.classList.remove("hidden");
      try {
        await this.core.load({
          symbol: this.symbol, board: this.board, timeframe: this.timeframe,
          from: this.rangeMode === "custom" ? this.fromDate : null,
          to: this.rangeMode === "custom" ? this.toDate : null,
          limit: 5000,
          onState: (s) => {
            status.textContent = s === "loading" ? "Загрузка свечей…" : s === "empty" ? "Нет данных за выбранный период." : s === "error" ? "Ошибка загрузки свечей." : "";
            status.classList.toggle("hidden", s === "ready");
          },
        });
        this.core.fitContent();
      } catch (err) {
        status.textContent = "Ошибка: " + err.message;
        status.classList.remove("hidden");
      }
      this.updateHeader();
    }

    async _loadOrInit() {
      const layouts = await CE.api.listLayouts("analysis", this.symbol).catch(() => []);
      const def = layouts.find((l) => l.is_default) || layouts[0];
      if (def) await this._applyLayout(def);
      else await this._reload();
    }

    async _applyLayout(layout) {
      this.layout = layout;
      this.symbol = layout.symbol || this.symbol;
      this.timeframe = layout.timeframe || this.timeframe;
      // A saved template is the one legitimate source of a restored custom
      // range - the user chose to persist it explicitly (see the spec's
      // "не восстанавливать случайные даты" rule, which is about *implicit*
      // restoration from localStorage/defaults, not an explicit template).
      if (layout.visible_from && layout.visible_to) {
        this.rangeMode = "custom"; this.fromDate = layout.visible_from; this.toDate = layout.visible_to;
      } else {
        this.rangeMode = "all"; this.fromDate = null; this.toDate = null;
      }
      this.updateHeader();
      if (this.indicator) this.indicator.setSymbol(this.symbol);
      await this._reload();
      if (this.core) this.core.setSeriesType(layout.chart_type || "candles");
      this.updateHeader();
      const full = await CE.api.getLayout(layout.id);
      this.drawingMgr.loadDrawings(full.drawings || []);
      (layout.indicators || []).forEach((ind) => this.indicatorMgr.add(ind.type, ind.params));
      this._notifyStateChanged({ layoutApplied: true });
    }

    async _saveAsTemplate() {
      const name = prompt("Название шаблона", this.layout ? this.layout.name : `${this.symbol} · ${new Date().toLocaleDateString("ru-RU")}`);
      if (!name) return;
      const payload = {
        context: "analysis", name, symbol: this.symbol, board: this.board, timeframe: this.timeframe,
        visibleFrom: this.rangeMode === "custom" ? this.fromDate : null,
        visibleTo: this.rangeMode === "custom" ? this.toDate : null,
        chartType: this.core ? this.core.seriesType : "candles",
        settings: {}, indicators: this.indicatorMgr.list().map((i) => ({ type: i.type, params: i.params })),
      };
      const layout = this.layout && this.layout.name === name
        ? await CE.api.updateLayout(this.layout.id, payload)
        : await CE.api.createLayout(payload);
      this.layout = layout;
      for (const d of this.drawingMgr.drawings) await this._persistDrawing(d);
      this._flashStatus("Шаблон сохранён.");
    }

    async _ensureLayout() {
      if (this.layout) return this.layout;
      this.layout = await CE.api.createLayout({
        context: "analysis", name: `${this.symbol} · автосохранение`, symbol: this.symbol, board: this.board,
        timeframe: this.timeframe, visibleFrom: null, visibleTo: null,
        chartType: this.core ? this.core.seriesType : "candles", settings: {}, indicators: [],
      });
      return this.layout;
    }

    _flashStatus(text) {
      const host = this.el.querySelector('[data-role="chartHost"]');
      let status = host.querySelector(".ca-tile-status");
      if (!status) { status = document.createElement("div"); status.className = "ca-tile-status"; host.appendChild(status); }
      status.textContent = text;
      status.classList.remove("hidden");
      setTimeout(() => { if (status.textContent === text) status.classList.add("hidden"); }, 2000);
    }

    // ----------------------------------------------------- drawings save --

    _onDrawingsChanged(detail) {
      if (detail.loaded || detail.history) return; // bulk operations - nothing to diff/save per-id
      const id = detail.created || detail.updated;
      if (id) this._queueSave(id);
    }

    _queueSave(id) {
      clearTimeout(this._saveTimers[id]);
      this._saveTimers[id] = setTimeout(() => this._flushSave(id), 500);
    }

    async _flushSave(id) {
      const d = this.drawingMgr.drawings.find((x) => x.id === id);
      if (!d) return;
      await this._persistDrawing(d);
    }

    async _persistDrawing(d) {
      const layout = await this._ensureLayout();
      const payload = { type: d.type, symbol: this.symbol, timeframe: this.timeframe, points: d.points, properties: d.properties, locked: d.locked, hidden: d.hidden, zIndex: d.zIndex };
      if (d._backendId) return CE.api.updateDrawing(d._backendId, payload).catch(() => {});
      const created = await CE.api.createDrawing(layout.id, payload).catch(() => null);
      if (created) d._backendId = created.id;
    }

    // ------------------------------------------------------------- live ---

    startRealtime() { if (this.indicator && this.symbol) this.indicator.start(this.symbol); }
    stopRealtime() { if (this.indicator) this.indicator.stop(); }
    showReplayMode() { if (this.indicator) this.indicator.showReplayMode(); }

    /** Ticks this tile's current bar from its own realtime price, using
     * ChartCore.appendCandle() (a targeted series.update(), not setData())
     * so this never re-renders the whole series or touches the visible
     * range/zoom. Skipped for 1w/1mo (see LIVE_TICK_BUCKET_SECONDS) and for
     * a tile deliberately viewing a fixed past window (custom range whose
     * `to` isn't today) - the spec's "custom range doesn't permanently
     * disable new candles" only applies while the window still reaches to
     * the present. */
    _onRealtimeUpdate(data) {
      if (!this.core || data.last == null || data.ticker !== this.symbol) return;
      if (this.rangeMode === "custom" && this.toDate && this.toDate < todayISO()) return;
      const bucketSeconds = LIVE_TICK_BUCKET_SECONDS[this.timeframe];
      if (!bucketSeconds || !data.market_timestamp) return;
      const marketEpoch = Math.floor(Date.parse(data.market_timestamp + "Z") / 1000);
      if (!Number.isFinite(marketEpoch)) return;
      const bucketStart = Math.floor(marketEpoch / bucketSeconds) * bucketSeconds;
      const last = this.core.candles[this.core.candles.length - 1];
      if (!last || bucketStart < last.time) return; // delayed feed catching up to already-shown bars - don't rewrite history
      if (bucketStart === last.time) {
        this.core.appendCandle({
          time: last.time, open: last.open, close: data.last,
          high: Math.max(last.high, data.last), low: Math.min(last.low, data.last), volume: last.volume,
        });
      } else {
        this.core.appendCandle({ time: bucketStart, open: data.last, high: data.last, low: data.last, close: data.last, volume: 0 });
      }
      this.updateHeader();
    }

    // -------------------------------------------------------- more menu ---

    async _openOrderModal() {
      let overlay = document.getElementById("caOrderModal");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "caOrderModal";
        overlay.className = "ca-modal-backdrop";
        document.body.appendChild(overlay);
      }
      overlay.innerHTML = `
        <div class="ca-modal">
          <button class="close-btn" id="caOrderClose" aria-label="Закрыть">×</button>
          <h3>Заказать стратегию по разметке · ${this.symbol}</h3>
          <p class="ca-warning">Разметка графика сама по себе не является формализованной торговой стратегией. Перед разработкой правила будут уточнены и согласованы.</p>
          <label>Описание торговой идеи <textarea id="ordIdea" rows="3"></textarea></label>
          <label>Условия входа <textarea id="ordEntry" rows="2"></textarea></label>
          <label>Условия выхода <textarea id="ordExit" rows="2"></textarea></label>
          <label>Стоп <input id="ordStop"></label>
          <label>Тейк <input id="ordTake"></label>
          <label>Управление позицией <input id="ordMgmt"></label>
          <label>Допустимый риск <input id="ordRisk"></label>
          <label>Комментарий <textarea id="ordComment" rows="2"></textarea></label>
          <label class="toggle"><input type="checkbox" id="ordScreenshot" checked><span>Приложить скриншот текущего графика</span></label>
          <div class="message" id="ordMessage"></div>
          <button class="primary" id="ordSubmit">Отправить заявку</button>
        </div>`;
      overlay.classList.remove("hidden");
      overlay.querySelector("#caOrderClose").onclick = () => overlay.classList.add("hidden");
      overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add("hidden"); };
      overlay.querySelector("#ordSubmit").onclick = () => this._submitOrder(overlay);
    }

    async _submitOrder(overlay) {
      const val = (id) => overlay.querySelector(id).value.trim();
      const msg = overlay.querySelector("#ordMessage");
      if (!val("#ordIdea")) { msg.textContent = "Опишите торговую идею."; return; }
      let screenshotPath = null;
      if (overlay.querySelector("#ordScreenshot").checked) {
        try {
          const canvas = this.core.chart.takeScreenshot();
          const dataUrl = canvas.toDataURL("image/png");
          const up = await CE.api.uploadScreenshot(dataUrl);
          screenshotPath = up.path;
        } catch (e) { /* screenshot is a nice-to-have; submitting without one is fine */ }
      }
      const layout = await this._ensureLayout();
      try {
        await CE.api.createStrategyRequest({
          layoutId: layout.id, symbol: this.symbol, board: this.board, timeframe: this.timeframe,
          visibleFrom: this.fromDate, visibleTo: this.toDate,
          drawingsSnapshot: this.drawingMgr.drawings, indicators: this.indicatorMgr.list(),
          ideaDescription: val("#ordIdea"), entryConditions: val("#ordEntry"), exitConditions: val("#ordExit"),
          stopDescription: val("#ordStop"), takeDescription: val("#ordTake"), positionManagement: val("#ordMgmt"),
          riskTolerance: val("#ordRisk"), comment: val("#ordComment"), screenshotPath,
        });
        msg.textContent = "Заявка отправлена.";
        setTimeout(() => overlay.classList.add("hidden"), 1200);
      } catch (e) {
        msg.textContent = "Ошибка: " + e.message;
      }
    }

    // ------------------------------------------------------------ misc ---

    /** Lets the workspace persist state / react to a tile's own settings
     * changing, without this file knowing anything about localStorage or
     * other tiles. */
    _notifyStateChanged(detail) {
      if (this._onStateChanged) this._onStateChanged(this, detail || {});
    }
    onStateChanged(cb) { this._onStateChanged = cb; }
  }

  CE.ChartTile = ChartTile;
})(window);
