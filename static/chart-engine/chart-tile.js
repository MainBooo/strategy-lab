/* One independent chart pane ("tile") for the multi-chart grid in
 * "Анализ графиков". Each tile owns its own ChartCore, IndicatorPaneManager,
 * DrawingManager, RealtimeIndicator, per-tile FullscreenController, and its
 * own full state (ticker/board/timeframe/chartType/rangeMode/fromDate/
 * toDate/indicators/drawings/zoom/displayOptions/live subscription) -
 * nothing here reads or writes another tile.
 *
 * As of the Stage-2 toolbar unification, a tile's own header is
 * deliberately minimal (identity tag + per-tile fullscreen + close) - every
 * *command* (ticker/timeframe/chart type/indicators/templates/save/
 * settings/range/board/snapshot/order-strategy) now lives in the single
 * workspace toolbar (chart-analysis.js) and is applied to whichever tile is
 * "active" via the public methods below (setTimeframe/setChartType/
 * selectSymbol/applyQuickRange/setBoard/saveAsTemplate/...). This file still
 * owns all of that state and logic - only the *chrome that triggers it*
 * moved up a level, so multiple disconnected control rows don't exist. */
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
    { id: "baseline", label: "Базовая линия" }, { id: "heikin_ashi", label: "Heikin Ashi" },
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

  class ChartTile {
    constructor({ symbol = "SBER", board = "TQBR", timeframe = "1d", chartType = "candles", displayOptions = null } = {}) {
      this.id = "tile" + ++_seq;
      this.symbol = symbol;
      this.board = board;
      this.timeframe = timeframe;
      this._initialChartType = chartType;
      this._initialDisplayOptions = displayOptions || null;
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
      this._saveTimers = {};
      this._rangeChangeCbs = [];
      this._crosshairCbs = [];
      this._priceUpdateCbs = [];
      this._liveTickCbs = [];
      this._applyingRange = false;
      this._applyingCrosshair = false;
    }

    // ---------------------------------------------------------- wiring ----

    onRangeChange(cb) { this._rangeChangeCbs.push(cb); }
    onCrosshairMove(cb) { this._crosshairCbs.push(cb); }
    /** Fires on every price header refresh (live tick, crosshair hover, new
     * data) with {price, diff, pct, bar} - the workspace toolbar's price/
     * change display subscribes to this on every tile and only renders it
     * when the tile is the active one. */
    onPriceUpdate(cb) { this._priceUpdateCbs.push(cb); }
    /** Fires only on a genuine realtime feed tick (symbol, lastPrice) -
     * unlike onPriceUpdate(), never on crosshair hover. This is the correct
     * hook for anything that must react to an actual price change, e.g. the
     * alerts service (see alert-service.js): evaluating price-cross
     * conditions on mouse movement would fire alerts just from a user
     * scrubbing the chart with their cursor. */
    onLiveTick(cb) { this._liveTickCbs.push(cb); }

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
    }

    // ----------------------------------------------------------- mount ----

    /** Builds the DOM (minimal identity header + chart host) inside
     * `container` and creates the chart engine instances. `onActivate(tile)`
     * fires on any pointer interaction with the tile (so the workspace can
     * make it the active one). The close button is always rendered - the
     * workspace hides it via CSS (`.ca-tile-grid.layout-1 .ca-tile-close`)
     * when only one tile exists, rather than us tracking tile count here. */
    mount(container, { onActivate, onClose } = {}) {
      this.el = container;
      container.className = "ca-tile";
      container.innerHTML = `
        <div class="ca-tile-header" data-role="header">
          <span class="ca-tile-tag" data-role="tag"></span>
          <div class="ca-tile-realtime-slot" data-role="realtimeSlot"></div>
          <span class="ca-tile-spacer"></span>
          <button class="ca-tile-btn" data-role="fs" title="Полноэкранный режим плитки" aria-label="Полноэкранный режим плитки">⛶</button>
          <button class="ca-tile-btn ca-tile-close" data-role="close" title="Закрыть плитку" aria-label="Закрыть плитку">✕</button>
        </div>
        <div class="ca-tile-chart-host" data-role="chartHost">
          <button class="ca-tile-live-btn hidden" data-role="live" type="button">К последней цене</button>
        </div>
      `;

      const host = container.querySelector('[data-role="chartHost"]');
      this.core = new CE.ChartCore(host, { showVolume: true });
      if (this._initialDisplayOptions) this.core.setDisplayOptions(this._initialDisplayOptions);
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

      this.updateHeader();
      this._loadOrInit();

      if (global.RealtimeIndicator) {
        this.indicator = new global.RealtimeIndicator(container.querySelector('[data-role="realtimeSlot"]'), {
          compact: () => true,
          onUpdate: (data) => this._onRealtimeUpdate(data),
        });
      }
    }

    // ------------------------------------------------------------ header --

    updateHeader() {
      if (this.drawingMgr) this.drawingMgr.currentTimeframe = this.timeframe;
      if (!this.el) return;
      const tag = this.el.querySelector('[data-role="tag"]');
      if (tag) tag.textContent = `${this.symbol} · ${TF_LABEL[this.timeframe] || this.timeframe}`;
    }

    /** Shows the hovered bar's OHLC while the crosshair is over it (called
     * with `bar`), falling back to the latest bar otherwise (called with no
     * argument, e.g. from onDataChanged). Change % is always vs the bar
     * immediately before whichever bar is currently shown. Fires
     * onPriceUpdate() instead of writing to its own DOM - the global
     * toolbar owns the price/change display now. */
    _updatePriceHeader(bar) {
      if (!this.core) return;
      const candles = this.core.candles;
      if (!candles.length) { this._priceUpdateCbs.forEach((cb) => cb(this, null)); return; }
      const target = bar || candles[candles.length - 1];
      const idx = candles.indexOf(target);
      const prev = idx > 0 ? candles[idx - 1] : null;
      const diff = prev ? target.close - prev.close : null;
      const pct = prev && prev.close ? (diff / prev.close) * 100 : null;
      this._priceUpdateCbs.forEach((cb) => cb(this, { price: target.close, diff, pct }));
    }

    setActiveVisual(active) {
      if (this.el) this.el.classList.toggle("active", active);
    }

    /** A plain-data snapshot for archiving a tile that's removed from the
     * grid by a layout change, so growing the layout back can restore it -
     * and for workspace-state localStorage persistence. Deliberately does
     * NOT include rangeMode/fromDate/toDate: a restored/resized tile always
     * comes back in "full history" mode, never a stale custom range from a
     * previous session (see the constructor's docstring). displayOptions
     * (per-tile chart-appearance settings) DOES persist - it's a display
     * preference, not a transient viewport range. */
    toConfig() {
      return {
        symbol: this.symbol, board: this.board, timeframe: this.timeframe,
        chartType: this.core ? this.core.seriesType : this._initialChartType,
        displayOptions: this.core ? this.core.displayOptions : this._initialDisplayOptions,
      };
    }

    destroy() {
      if (this.indicator) this.indicator.destroy();
      if (this.fsCtrl) this.fsCtrl.destroy();
      if (this.core) this.core.destroy();
      this.core = null;
      this.indicatorMgr = null;
      this.drawingMgr = null;
      this.el = null;
    }

    // ------------------------------------------------ public commands -----
    // (called by the workspace toolbar on whichever tile is active)

    setTimeframe(tf) {
      if (tf === this.timeframe) return;
      this.timeframe = tf;
      this.updateHeader();
      this._reload();
      this._notifyStateChanged();
    }

    setChartType(type) {
      if (this.core) this.core.setSeriesType(type);
      this._notifyStateChanged();
    }

    setBoard(board) {
      if (board === this.board) return;
      this.board = board;
      this._reload();
      this._notifyStateChanged();
    }

    /** Programmatic symbol change (watchlist click, global ticker select,
     * template load). */
    selectSymbol(ticker) {
      this._setSymbol(ticker);
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

    listTimeframes() { return TIMEFRAMES; }
    listChartTypes() { return CHART_TYPES; }
    listRangePresets() { return RANGE_PRESETS; }

    // ---------------------------------------------------------- range -----

    /** Quick preset (1Д…5Л): a pure *visual zoom* shortcut, per spec - it
     * never touches rangeMode/fromDate/toDate or stops live updates. If the
     * requested span reaches further back than what's currently loaded,
     * ensureCoverageBack() lazily pages in the missing older bars first
     * (same mechanism as scrolling left) so the zoom doesn't land on empty
     * space. */
    async applyQuickRange(days) {
      if (!this.core || !this.core.candles.length) return;
      const toTs = this.core.candles[this.core.candles.length - 1].time;
      const fromTs = toTs - days * 86400;
      if (this.core.candles[0].time > fromTs) {
        await this.core.ensureCoverageBack(new Date(fromTs * 1000).toISOString().slice(0, 10));
      }
      const barsPerDay = BARS_PER_DAY[this.timeframe] || 1;
      this.core.setVisibleBarCount(Math.round(days * barsPerDay));
    }

    /** Explicit custom period: this DOES set rangeMode/fromDate/toDate and
     * reloads from the API with that window - unlike the quick presets,
     * which only re-zoom already-tail-loaded data. Live ticking keeps
     * working unless `to` is a genuinely past date (see _onRealtimeUpdate) -
     * picking "today" as `to` behaves exactly like "all" except the loaded
     * window is bounded. */
    applyCustomRange(from, to) {
      this.rangeMode = "custom";
      this.fromDate = from;
      this.toDate = to || todayISO();
      this._reload();
      this._notifyStateChanged();
    }

    resetRange() {
      this.rangeMode = "all";
      this.fromDate = null;
      this.toDate = null;
      this._reload();
      this._notifyStateChanged();
    }

    rangeLabel() {
      return this.rangeMode === "custom"
        ? `${fmtDateShort(this.fromDate)} — ${fmtDateShort(this.toDate) || "сегодня"}`
        : "Все";
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

    async saveAsTemplate(name) {
      name = name || prompt("Название шаблона", this.layout ? this.layout.name : `${this.symbol} · ${new Date().toLocaleDateString("ru-RU")}`);
      if (!name) return null;
      const payload = {
        context: "analysis", name, symbol: this.symbol, board: this.board, timeframe: this.timeframe,
        visibleFrom: this.rangeMode === "custom" ? this.fromDate : null,
        visibleTo: this.rangeMode === "custom" ? this.toDate : null,
        chartType: this.core ? this.core.seriesType : "candles",
        settings: this.core ? this.core.displayOptions : {}, indicators: this.indicatorMgr.list().map((i) => ({ type: i.type, params: i.params })),
      };
      const layout = this.layout && this.layout.name === name
        ? await CE.api.updateLayout(this.layout.id, payload)
        : await CE.api.createLayout(payload);
      this.layout = layout;
      for (const d of this.drawingMgr.drawings) await this._persistDrawing(d);
      this._flashStatus("Шаблон сохранён.");
      return layout;
    }

    async listTemplates() {
      return CE.api.listLayouts("analysis", this.symbol).catch(() => []);
    }

    async loadTemplate(id) {
      const l = await CE.api.getLayout(id);
      await this._applyLayout(l);
    }

    async deleteTemplate(id) {
      await CE.api.deleteLayout(id);
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
      if (detail.removed) {
        clearTimeout(this._saveTimers[detail.removed]);
        delete this._saveTimers[detail.removed];
        // Was never persisted (deleted before its debounced create/update
        // ever flushed) - nothing to delete server-side.
        if (detail.removedBackendId) CE.api.deleteDrawing(detail.removedBackendId).catch(() => {});
        return;
      }
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
      this._liveTickCbs.forEach((cb) => cb(this.symbol, data.last));
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
    // (order-strategy request, snapshot-attached idea submission - reached
    // from the workspace toolbar's overflow menu, acts on this tile)

    async openOrderModal() {
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
