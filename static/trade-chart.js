/* BacktestChartAdapter: wires the shared chart engine into the existing
 * trade-viewer modal (templates/index.html #tvChartView). Candles come
 * from /api/backtests/<run>/candles - the exact local file+range the
 * backtest engine read, never a fresh MOEX fetch - so the chart can
 * never disagree with the trades table. This module never recomputes a
 * trade; it only renders what backtests_db already has. */
(function (global) {
  "use strict";

  const parseNaive = global.ChartEngine.parseNaiveDatetime;

  // Same 24x24, 2px-stroke line-icon language as the "Анализ графиков"
  // toolbar (chart-analysis.js's ICN.expand) - kept as a local literal
  // rather than a shared import since that file doesn't expose ICN on
  // ChartEngine and duplicating two small SVG strings is cheaper than
  // wiring a new shared module for it.
  const ICN_EXPAND = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
  const ICN_COMPRESS = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M13 21v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>';
  const ICN_SETTINGS = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  const ICN_CLOSE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const ICN_CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  const ICN_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

  // Single source of truth for the "display toggle" checkboxes - each
  // renders TWICE (the normal toolbar row, and the fullscreen settings
  // popover) but drives the exact same state change, so there is only one
  // place that knows what a toggle does. See _wireDisplayToggles().
  const DISPLAY_TOGGLES = [
    { id: "tcShowAll", label: "Показывать все сделки", checked: true, kind: "filter" },
    { id: "tcOnlySelected", label: "Только выбранная сделка", checked: false, kind: "filter" },
    { id: "tcShowMarkers", label: "Маркеры", checked: true, kind: "filter" },
    { id: "tcShowConnectors", label: "Линии вход–выход", checked: true, kind: "filter" },
    { id: "tcShowStopLoss", label: "Stop-loss", checked: true, kind: "filter" },
    { id: "tcShowTakeProfit", label: "Take-profit", checked: true, kind: "filter" },
    { id: "tcShowResultLabels", label: "Подписи результата", checked: true, kind: "filter" },
    { id: "tcShowRsi", label: "RSI(14)", checked: false, kind: "indicator", indicator: "rsi" },
    { id: "tcShowAtr", label: "ATR(14)", checked: false, kind: "indicator", indicator: "atr" },
  ];

  const TradeChart = {
    run: null,
    core: null,
    indicatorMgr: null,
    overlay: null,
    markersHandle: null,
    selection: null,
    ticker: null,
    container: null,
    fsCtrl: null,
    _built: false,
    _candlesCache: {},
    _tradesCache: {},

    setRun(run) {
      this.run = run;
      this.ticker = null;
      this._candlesCache = {};
      this._tradesCache = {};
      if (this.core) {
        this.core.destroy();
        this.core = null;
        this.indicatorMgr = null;
        this.overlay = null;
        this.markersHandle = null;
      }
      if (this.fsCtrl) {
        this.fsCtrl.destroy();
        this.fsCtrl = null;
      }
      this._built = false;
    },

    activate(container) {
      this.container = container;
      if (!this._built) this._build(container);
      if (!this.ticker) {
        const tickers = [...new Set((this.run.results || []).map((r) => r.ticker))];
        if (tickers.length) this.selectTicker(tickers[0]);
      }
    },

    focusTrade(tradeId) {
      const id = Number(tradeId);
      // The trade might belong to a ticker other than the one currently shown.
      const already = this.selection && this.selection.allTrades.find((t) => t.id === id);
      const go = () => {
        this.selection.select(id);
        const t = this.selection.selectedTrade();
        if (t) this.core.setVisibleRange(t.entry_time, t.exit_time || t.entry_time);
      };
      if (already) { go(); return; }
      const run = this.run;
      const result = (run.results || []).find((r) => (this._tradesCache[r.ticker] || []).some((t) => t.id === id));
      if (result) { this.selectTicker(result.ticker).then(go); return; }
      // Not cached yet - fetch just this trade to learn its ticker, then load that ticker.
      fetch(`/api/backtests/${run.id}/trades/${id}`).then((r) => r.json()).then((t) => {
        if (t && t.ticker) this.selectTicker(t.ticker).then(go);
      });
    },

    _build(container) {
      const toggleRow = (suffix) => DISPLAY_TOGGLES.map((t) =>
        `<label class="toggle"><input type="checkbox" id="${t.id}${suffix}" ${t.checked ? "checked" : ""}><span>${t.label}</span></label>`
      ).join("");

      container.innerHTML = `
        <div class="tc-head">
          <span class="tc-head-title">График сделок</span>
          <button class="icon-btn" id="tcFullscreenBtn" title="Полноэкранный режим" aria-label="Полноэкранный режим графика">${ICN_EXPAND}</button>
        </div>
        <div class="tc-toolbar">
          <label>Тикер <select id="tcTicker"></select></label>
          <label>Стратегия <select id="tcStrategy"><option value="">Все стратегии</option></select></label>
          <label>Направление <select id="tcDirection"><option value="">Все</option><option value="long">Long</option><option value="short">Short</option></select></label>
          <label>Результат <select id="tcResult"><option value="">Все сделки</option><option value="true">Прибыльные</option><option value="false">Убыточные</option></select></label>
          <label>Причина выхода <select id="tcExitReason"><option value="">Все причины</option><option value="take">Take-profit</option><option value="stop">Stop-loss</option><option value="breakeven">Breakeven</option><option value="max_holding">Макс. удержание</option><option value="end_of_period">Конец периода</option></select></label>
          <label>С даты <input id="tcDateFrom" type="date"></label>
          <label>По дату <input id="tcDateTo" type="date"></label>
          <label>№ сделки <input id="tcTradeNumber" type="number" min="1" placeholder="любая"></label>
          <button class="secondary" id="tcClearFilters" title="Сбросить фильтры сделок">Сбросить фильтры</button>
          <button class="secondary" id="tcHideAll" title="Скрыть все сделки на графике">Скрыть сделки</button>
          <button class="secondary" id="tcResetRange" title="Вернуть масштаб графика к общему диапазону тестирования">К общему диапазону</button>
        </div>
        <div class="tc-toolbar">${toggleRow("")}</div>
        <div class="tc-nav">
          <button class="secondary" id="tcPrev">← Предыдущая сделка</button>
          <span id="tcCounter" class="muted-note">—</span>
          <button class="secondary" id="tcNext">Следующая сделка →</button>
        </div>
        <div class="tc-status" id="tcStatus"></div>
        <div id="tcChartWrap" class="tc-chart-wrap">
          <div id="tcChartHost" class="tc-chart-host"></div>
          <div class="tc-fs-overlay" id="tcFsOverlay">
            <div class="tc-fs-top">
              <span class="tc-fs-ticker" id="tcFsTicker">—</span>
              <div class="tc-fs-actions">
                <button class="tc-fs-btn" id="tcFsSettingsBtn" title="Настройки отображения" aria-label="Настройки отображения" aria-haspopup="true">${ICN_SETTINGS}</button>
                <button class="tc-fs-btn" id="tcFsCloseBtn" title="Выйти из полноэкранного режима (Esc)" aria-label="Выйти из полноэкранного режима">${ICN_CLOSE}</button>
              </div>
              <div class="tc-fs-settings hidden" id="tcFsSettings">
                <div class="tc-fs-settings-actions">
                  <button class="secondary" id="tcFsHideAll">Скрыть сделки</button>
                  <button class="secondary" id="tcFsResetRange">К общему диапазону</button>
                </div>
                ${toggleRow("Fs")}
              </div>
            </div>
            <div class="tc-fs-bottom hidden" id="tcFsBottom">
              <button class="tc-fs-nav-btn" id="tcFsPrev" aria-label="Предыдущая сделка">${ICN_CHEVRON_LEFT}</button>
              <span class="tc-fs-counter" id="tcFsCounter">—</span>
              <button class="tc-fs-nav-btn" id="tcFsNext" aria-label="Следующая сделка">${ICN_CHEVRON_RIGHT}</button>
            </div>
          </div>
        </div>
        <div id="tcCard" class="tc-card hidden"></div>
      `;
      this.core = new global.ChartEngine.ChartCore(container.querySelector("#tcChartHost"), { showVolume: true });
      this.indicatorMgr = new global.ChartEngine.Indicators.PaneManager(this.core);
      this.overlay = new global.ChartEngine.Trades.TradeOverlayPrimitive(this.core.chart, this.core.candleSeries);
      this.core.candleSeries.attachPrimitive(this.overlay);
      this.markersHandle = global.LightweightCharts.createSeriesMarkers(this.core.candleSeries, []);
      this.selection = new global.ChartEngine.Trades.TradeSelectionManager();
      this.selection.onChange(() => this._onSelectionChange());

      const strategies = (this.run.results || []).reduce((acc, r) => {
        if (r.strategy_id && !acc.some((x) => x.id === r.strategy_id)) acc.push({ id: r.strategy_id, name: r.strategy_name_snapshot || r.strategy_id });
        return acc;
      }, []);
      container.querySelector("#tcStrategy").innerHTML += strategies.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
      container.querySelector("#tcTicker").innerHTML = [...new Set((this.run.results || []).map((r) => r.ticker))]
        .map((t) => `<option value="${t}">${t}</option>`).join("");
      container.querySelector("#tcTicker").onchange = (e) => this.selectTicker(e.target.value);

      ["tcStrategy", "tcDirection", "tcResult", "tcExitReason", "tcDateFrom", "tcDateTo", "tcTradeNumber"].forEach((id) => {
        container.querySelector("#" + id).addEventListener("input", () => this._applyFilters());
      });
      this._wireDisplayToggles(container);
      container.querySelector("#tcPrev").onclick = () => this.selection.prev();
      container.querySelector("#tcNext").onclick = () => this.selection.next();
      container.querySelector("#tcFsPrev").onclick = () => this.selection.prev();
      container.querySelector("#tcFsNext").onclick = () => this.selection.next();
      container.querySelector("#tcClearFilters").onclick = () => this._clearFilters();
      container.querySelector("#tcHideAll").onclick = () => this._hideAllTrades();
      container.querySelector("#tcResetRange").onclick = () => this._resetRange();
      container.querySelector("#tcFsHideAll").onclick = () => { this._hideAllTrades(); this._closeFsSettings(); };
      container.querySelector("#tcFsResetRange").onclick = () => { this._resetRange(); this._closeFsSettings(); };

      this.core.chart.subscribeClick((param) => this._onChartClick(param));
      // Any interaction with the chart itself (pan/zoom/click-to-select)
      // should dismiss an open settings popover rather than leaving it
      // stranded on top of the candles the user is trying to look at.
      container.querySelector("#tcChartHost").addEventListener("click", () => this._closeFsSettings());

      container.querySelector("#tcFsSettingsBtn").onclick = (e) => {
        e.stopPropagation();
        const panel = container.querySelector("#tcFsSettings");
        const willOpen = panel.classList.contains("hidden");
        if (willOpen) this._syncFsSettings();
        panel.classList.toggle("hidden", !willOpen);
        container.querySelector("#tcFsSettingsBtn").classList.toggle("active", willOpen);
      };
      container.querySelector("#tcFsCloseBtn").onclick = () => this.fsCtrl.exit();

      container.querySelector("#tcFullscreenBtn").onclick = () => this.fsCtrl.toggle();
      // The fullscreen target is ONLY the chart + its compact overlay
      // (#tcChartWrap) - deliberately NOT `container`, which also holds
      // the filter row, the 9-toggle row, the big prev/next nav and the
      // trade-detail card. Those stay outside the fullscreen element
      // entirely (rather than hidden-but-present inside it), so fullscreen
      // never has to fight a few hundred px of chrome for height; the same
      // ChartCore instance just gets a bigger box to resize into.
      this.fsCtrl = new global.ChartEngine.Fullscreen.FullscreenController(container.querySelector("#tcChartWrap"), {
        className: "is-fullscreen",
        onChange: (active) => this._onFullscreenChange(active),
      });

      this._built = true;
    },

    _wireDisplayToggles(container) {
      DISPLAY_TOGGLES.forEach((t) => {
        const main = container.querySelector("#" + t.id);
        const fs = container.querySelector("#" + t.id + "Fs");
        const onToggle = (checked) => {
          if (t.kind === "indicator") this._toggleIndicator(t.indicator, checked);
          else this._applyFilters();
        };
        main.addEventListener("change", (e) => { fs.checked = e.target.checked; onToggle(e.target.checked); });
        fs.addEventListener("change", (e) => { main.checked = e.target.checked; onToggle(e.target.checked); });
      });
    },

    _syncFsSettings() {
      DISPLAY_TOGGLES.forEach((t) => {
        const main = this.container.querySelector("#" + t.id);
        const fs = this.container.querySelector("#" + t.id + "Fs");
        if (main && fs) fs.checked = main.checked;
      });
    },

    _closeFsSettings() {
      const panel = this.container.querySelector("#tcFsSettings");
      const btn = this.container.querySelector("#tcFsSettingsBtn");
      if (panel) panel.classList.add("hidden");
      if (btn) btn.classList.remove("active");
    },

    _clearFilters() {
      const el = (id) => this.container.querySelector("#" + id);
      ["tcStrategy", "tcDirection", "tcResult", "tcExitReason", "tcDateFrom", "tcDateTo", "tcTradeNumber"].forEach((id) => {
        const node = el(id);
        if (node) node.value = "";
      });
      el("tcShowAll").checked = true;
      el("tcShowAllFs").checked = true;
      el("tcOnlySelected").checked = false;
      el("tcOnlySelectedFs").checked = false;
      this.selection.select(null);
      this._applyFilters();
      this._resetRange();
    },

    _hideAllTrades() {
      const showAll = this.container.querySelector("#tcShowAll");
      const showAllFs = this.container.querySelector("#tcShowAllFs");
      showAll.checked = false;
      if (showAllFs) showAllFs.checked = false;
      this.selection.select(null);
      this._applyFilters();
    },

    _resetRange() {
      const trades = this.selection.filtered;
      if (!trades.length) { this.core.fitContent(); return; }
      const from = Math.min(...trades.map((t) => t.entry_time));
      const to = Math.max(...trades.map((t) => t.exit_time || t.entry_time));
      this.core.setVisibleRange(from, to);
    },

    _onFullscreenChange(active) {
      const btn = this.container.querySelector("#tcFullscreenBtn");
      if (btn) {
        btn.innerHTML = active ? ICN_COMPRESS : ICN_EXPAND;
        btn.title = active ? "Выйти из полноэкранного режима (Esc)" : "Полноэкранный режим графика";
        btn.setAttribute("aria-label", btn.title);
        btn.classList.toggle("active", active);
      }
      if (!active) this._closeFsSettings();
      else { this._updateFsOverlay(); this._updateFsNav(); }
      // Fewer, tighter TP/SL level labels once the chart is the whole
      // screen and trade density is what the user came here to read.
      if (this.overlay) this.overlay.setDisplayOptions({ compact: active });
      // The chart host's box changes size with the fullscreen CSS toggle;
      // the host already has a ResizeObserver (chart-engine/core.js) but
      // nudging it explicitly avoids a one-frame stale layout, same as
      // chart-analysis.js's workspace fullscreen handler. No visible range
      // is touched here - only the pixel box changes, so zoom/scroll
      // position survive enter/exit untouched (state lives entirely in
      // the one ChartCore/TradeSelectionManager, never rebuilt).
      requestAnimationFrame(() => this.core && this.core._onResize());
    },

    /** Ticker (+ active strategy filter, if any) shown top-left of the
     * fullscreen overlay - the only chart identity label left once the
     * full filter row is out of view. */
    _updateFsOverlay() {
      const el = (id) => this.container.querySelector("#" + id);
      const label = el("tcFsTicker");
      if (!label) return;
      const strategySel = el("tcStrategy");
      const strategyName = strategySel && strategySel.value ? strategySel.selectedOptions[0].textContent : "";
      label.textContent = strategyName ? `${this.ticker || "—"} · ${strategyName}` : (this.ticker || "—");
    },

    /** Compact "‹  i / n  ›" nav pill - hidden entirely when there's
     * nothing to page through, so an empty ticker doesn't leave a dead
     * control floating over the chart. */
    _updateFsNav() {
      const bottom = this.container.querySelector("#tcFsBottom");
      if (!bottom) return;
      const total = this.selection.filtered.length;
      bottom.classList.toggle("hidden", total === 0);
      if (!total) return;
      const i = this.selection.filtered.findIndex((t) => t.id === this.selection.selectedId);
      this.container.querySelector("#tcFsCounter").textContent = `${i >= 0 ? i + 1 : "—"} / ${total}`;
    },

    _toggleIndicator(type, on) {
      const key = "_ind_" + type;
      if (on) this[key] = this.indicatorMgr.add(type, {});
      else if (this[key]) { this.indicatorMgr.remove(this[key]); this[key] = null; }
    },

    async selectTicker(ticker) {
      this.ticker = ticker;
      this.container.querySelector("#tcTicker").value = ticker;
      this._updateFsOverlay();
      const status = this.container.querySelector("#tcStatus");
      status.textContent = "Загрузка свечей…";
      try {
        const [candles, trades] = await Promise.all([this._loadCandles(ticker), this._loadTrades(ticker)]);
        this.core.setCandlesDirect(candles);
        this.selection.setTrades(trades);
        this._applyFilters();
        // A single local file can span years of intraday candles while the
        // trades cluster in a narrow window; fitContent() would zoom out to
        // the whole file and (at very high bar counts) can hit lightweight-
        // charts' minimum bar spacing before reaching a zoom level that
        // fits everything, hiding the very trades the chart exists to show.
        // Framing the trade span instead is what the user actually wants.
        if (trades.length) {
          const from = Math.min(...trades.map((t) => t.entry_time));
          const to = Math.max(...trades.map((t) => t.exit_time || t.entry_time));
          this.core.setVisibleRange(from, to);
        } else {
          this.core.fitContent();
        }
        status.textContent = candles.length ? "" : "Нет свечей для этого тикера в диапазоне запуска.";
      } catch (err) {
        status.textContent = "Ошибка загрузки: " + err.message;
      }
    },

    async _loadCandles(ticker) {
      if (this._candlesCache[ticker]) return this._candlesCache[ticker];
      const res = await fetch(`/api/backtests/${this.run.id}/candles?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "не удалось загрузить свечи");
      this._candlesCache[ticker] = data.candles || [];
      return this._candlesCache[ticker];
    },

    async _loadTrades(ticker) {
      if (this._tradesCache[ticker]) return this._tradesCache[ticker];
      let page = 1, all = [], total = Infinity;
      while (all.length < total && page < 40) {
        const res = await fetch(`/api/backtests/${this.run.id}/trades?ticker=${encodeURIComponent(ticker)}&page=${page}&page_size=500`);
        const data = await res.json();
        total = data.total; all = all.concat(data.items); page++;
        if (!data.items.length) break;
      }
      const normalized = all.map((t, i) => ({
        ...t,
        number: i + 1,
        entry_time: parseNaive(t.entry_datetime),
        exit_time: t.exit_datetime ? parseNaive(t.exit_datetime) : null,
      }));
      this._tradesCache[ticker] = normalized;
      return normalized;
    },

    _applyFilters() {
      const el = (id) => this.container.querySelector("#" + id);
      const strategyId = el("tcStrategy").value;
      const direction = el("tcDirection").value;
      const profitable = el("tcResult").value;
      const exitReason = el("tcExitReason").value;
      const dateFrom = el("tcDateFrom").value;
      const dateTo = el("tcDateTo").value;
      const number = el("tcTradeNumber").value;
      this.selection.setFilters((t) => {
        if (strategyId && t.strategy_id !== strategyId) return false;
        if (direction && t.direction !== direction) return false;
        if (profitable === "true" && !(t.net_profit > 0)) return false;
        if (profitable === "false" && !(t.net_profit <= 0)) return false;
        if (exitReason && t.exit_reason !== exitReason) return false;
        const entryDate = String(t.entry_datetime || "").slice(0, 10);
        if (dateFrom && entryDate && entryDate < dateFrom) return false;
        if (dateTo && entryDate && entryDate > dateTo) return false;
        if (number && String(t.number) !== String(number)) return false;
        return true;
      });
      this._updateFsOverlay();
      this._render();
    },

    _render() {
      const el = (id) => this.container.querySelector("#" + id);
      const showAll = el("tcShowAll").checked;
      const onlySelected = el("tcOnlySelected").checked;
      const showMarkers = el("tcShowMarkers").checked;
      const showConnectors = el("tcShowConnectors").checked;
      const showStopLoss = el("tcShowStopLoss").checked;
      const showTakeProfit = el("tcShowTakeProfit").checked;
      const showResultLabels = el("tcShowResultLabels").checked;
      const sel = this.selection.selectedTrade();
      const visible = onlySelected && sel ? [sel] : showAll ? this.selection.filtered : sel ? [sel] : [];

      this.markersHandle.setMarkers(showMarkers ? global.ChartEngine.Trades.buildMarkers(visible, { showResultLabels, showExits: true }) : []);
      this.overlay.setDisplayOptions({ showConnectors, showStopLoss, showTakeProfit });
      this.overlay.setTrades(visible);
      this.overlay.setSelected(this.selection.selectedId);

      const i = this.selection.filtered.findIndex((t) => t.id === this.selection.selectedId);
      el("tcCounter").textContent = this.selection.filtered.length ? `Сделка ${i >= 0 ? i + 1 : "—"} из ${this.selection.filtered.length}` : "Нет сделок по фильтру";
      this._updateFsNav();
    },

    _onSelectionChange() {
      this._render();
      const t = this.selection.selectedTrade();
      const card = this.container.querySelector("#tcCard");
      if (!t) { card.classList.add("hidden"); return; }
      card.classList.remove("hidden");
      card.innerHTML = this._renderCard(t);
      if (t.exit_time) this.core.setVisibleRange(t.entry_time, t.exit_time);
      // Keep the trades-table sub-view in sync so switching back highlights the same trade.
      if (window.highlightTradeRow) window.highlightTradeRow(t.id);
    },

    _renderCard(t) {
      const money = window.money || ((n) => n);
      const meta = (() => { try { return JSON.parse(t.signal_metadata_json || "{}"); } catch (e) { return {}; } })();
      const EXIT = global.ChartEngine.Trades.EXIT_LABEL;
      const riskRub = t.stop_loss != null ? Math.abs(t.entry_price - t.stop_loss) * t.quantity_shares : null;
      const rr = t.take_profit != null && t.stop_loss != null ? Math.abs(t.take_profit - t.entry_price) / Math.abs(t.entry_price - t.stop_loss) : null;
      const row = (label, value) => `<div><span>${label}</span><strong>${value}</strong></div>`;
      return `
        <div class="tc-card-head">
          <h3>Сделка №${t.number} · ${t.ticker}</h3>
          <div>
            <button class="secondary" id="tcCardPrev">←</button>
            <button class="secondary" id="tcCardNext">→</button>
            <button class="close-btn" id="tcCardClose" aria-label="Закрыть">×</button>
          </div>
        </div>
        <div class="summary-grid">
          ${row("Направление", t.direction === "long" ? "Long" : "Short")}
          ${row("Стратегия", (window.STRATEGIES[t.strategy_id] || {}).name || t.strategy_id)}
          ${row("Вход", `${money(t.entry_price)} ₽ · ${t.entry_datetime}`)}
          ${row("Выход", t.exit_datetime ? `${money(t.exit_price)} ₽ · ${t.exit_datetime}` : "—")}
          ${row("Причина выхода", EXIT[t.exit_reason] || t.exit_reason || "—")}
          ${row("Лоты / акции", `${t.quantity_lots} / ${t.quantity_shares}`)}
          ${row("Стоп / Тейк", `${t.stop_loss != null ? money(t.stop_loss) : "—"} / ${t.take_profit != null ? money(t.take_profit) : "—"}`)}
          ${row("Риск, ₽", riskRub != null ? money(riskRub) + " ₽" : "—")}
          ${row("Плановый R/R", rr != null ? rr.toFixed(2) : "—")}
          ${row("Комиссия", money(t.commission) + " ₽")}
          ${row("Чистая прибыль", `${money(t.net_profit)} ₽ (${t.return_percent}%)`)}
          ${row("R-мультипликатор", riskRub && t.net_profit != null ? (t.net_profit / (riskRub || 1)).toFixed(2) : "—")}
          ${row("MAE / MFE", meta.mae_pct != null || meta.mfe_pct != null ? `${meta.mae_pct ?? "—"}% / ${meta.mfe_pct ?? "—"}%` : "—")}
          ${row("Продолжительность", meta.bars_held != null ? `${meta.bars_held} баров` : "—")}
        </div>`;
    },

    _onChartClick(param) {
      if (!param.point) return;
      const hit = this._hitTestTrades(param.point.x, param.point.y);
      if (hit) this.selection.select(hit.id);
      setTimeout(() => {
        const closeBtn = this.container.querySelector("#tcCardClose");
        if (closeBtn) closeBtn.onclick = () => this.selection.select(null);
        const prevBtn = this.container.querySelector("#tcCardPrev");
        if (prevBtn) prevBtn.onclick = () => this.selection.prev();
        const nextBtn = this.container.querySelector("#tcCardNext");
        if (nextBtn) nextBtn.onclick = () => this.selection.next();
      }, 0);
    },

    _hitTestTrades(px, py) {
      const ts = this.core.chart.timeScale();
      const tol = 10;
      let best = null, bestDist = Infinity;
      for (const t of this.selection.filtered) {
        const ex = ts.timeToCoordinate(t.entry_time);
        const ey = this.core.candleSeries.priceToCoordinate(t.entry_price);
        if (ex != null && ey != null) {
          const d = Math.hypot(px - ex, py - ey);
          if (d < tol && d < bestDist) { bestDist = d; best = t; }
        }
        if (t.exit_time != null) {
          const xx = ts.timeToCoordinate(t.exit_time);
          const yy = this.core.candleSeries.priceToCoordinate(t.exit_price);
          if (xx != null && yy != null) {
            const d = Math.hypot(px - xx, py - yy);
            if (d < tol && d < bestDist) { bestDist = d; best = t; }
          }
        }
      }
      return best;
    },
  };

  /**
   * Result-card shortcut: after a portfolio backtest finishes, surface the
   * graph as a first-class next action instead of making the user hunt for
   * the same run in the history table. The backtest job already returns the
   * persisted DB run id as run_id_db, so this opens the exact saved run and
   * therefore the exact candles/trades used by the calculation.
   */
  function ensureBacktestChartAction(result) {
    const resultsCard = document.getElementById("backtestResults");
    const errors = document.getElementById("backtestErrors");
    if (!resultsCard || !errors) return;

    let wrap = document.getElementById("backtestTradeChartAction");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "backtestTradeChartAction";
      wrap.className = "success-actions";
      errors.insertAdjacentElement("afterend", wrap);
    }

    const runId = result && result.run_id_db;
    const trades = Number(result && result.trades || 0);
    const tickers = new Set((result && result.by_ticker || []).map((row) => row.ticker)).size;
    wrap.innerHTML = `
      <button class="primary" id="openBacktestTradeChartBtn" ${runId && trades ? "" : "disabled"}>Все сделки на графике${trades ? ` (${trades})` : ""}</button>
      <span class="muted-note">${trades ? `${tickers} инструмент${tickers === 1 ? "" : tickers >= 2 && tickers <= 4 ? "а" : "ов"} · фильтры по стратегии, направлению, результату, причине выхода и датам` : "В этом запуске нет сделок для отображения."}</span>
    `;

    const btn = document.getElementById("openBacktestTradeChartBtn");
    if (!btn || !runId || !trades) return;
    btn.onclick = async () => {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Открываем график…";
      try {
        await global.openTradeViewer(runId);
        const chartTab = document.querySelector('.tv-subtab[data-tv-view="chart"]');
        if (chartTab) chartTab.click();
      } catch (err) {
        console.error("Could not open backtest trade chart", err);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    };
  }

  const originalRenderBacktestResult = global.renderBacktestResult;
  if (typeof originalRenderBacktestResult === "function") {
    global.renderBacktestResult = function (result) {
      originalRenderBacktestResult(result);
      ensureBacktestChartAction(result);
    };
  }

  global.TradeChart = TradeChart;
})(window);
