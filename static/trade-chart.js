/* BacktestChartAdapter: wires the shared chart engine into the existing
 * trade-viewer modal (templates/index.html #tvChartView). Candles come
 * from /api/backtests/<run>/candles - the exact local file+range the
 * backtest engine read, never a fresh MOEX fetch - so the chart can
 * never disagree with the trades table. This module never recomputes a
 * trade; it only renders what backtests_db already has. */
(function (global) {
  "use strict";

  const parseNaive = global.ChartEngine.parseNaiveDatetime;

  const TradeChart = {
    run: null,
    core: null,
    indicatorMgr: null,
    overlay: null,
    markersHandle: null,
    selection: null,
    ticker: null,
    container: null,
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
      container.innerHTML = `
        <div class="tc-toolbar">
          <label>Тикер <select id="tcTicker"></select></label>
          <label>Стратегия <select id="tcStrategy"><option value="">Все стратегии</option></select></label>
          <label>Направление <select id="tcDirection"><option value="">Все</option><option value="long">Long</option><option value="short">Short</option></select></label>
          <label>Результат <select id="tcResult"><option value="">Все сделки</option><option value="true">Прибыльные</option><option value="false">Убыточные</option></select></label>
          <label>№ сделки <input id="tcTradeNumber" type="number" min="1" placeholder="любая"></label>
          <button class="secondary" id="tcHideAll" title="Скрыть все сделки на графике">Скрыть сделки</button>
          <button class="secondary" id="tcResetRange" title="Вернуть масштаб графика к общему диапазону тестирования">К общему диапазону</button>
        </div>
        <div class="tc-toolbar">
          <label class="toggle"><input type="checkbox" id="tcShowAll" checked><span>Показывать все сделки</span></label>
          <label class="toggle"><input type="checkbox" id="tcOnlySelected"><span>Только выбранная сделка</span></label>
          <label class="toggle"><input type="checkbox" id="tcShowMarkers" checked><span>Маркеры</span></label>
          <label class="toggle"><input type="checkbox" id="tcShowConnectors" checked><span>Линии вход–выход</span></label>
          <label class="toggle"><input type="checkbox" id="tcShowStopLoss" checked><span>Stop-loss</span></label>
          <label class="toggle"><input type="checkbox" id="tcShowTakeProfit" checked><span>Take-profit</span></label>
          <label class="toggle"><input type="checkbox" id="tcShowResultLabels" checked><span>Подписи результата</span></label>
          <label class="toggle"><input type="checkbox" id="tcShowRsi"><span>RSI(14)</span></label>
          <label class="toggle"><input type="checkbox" id="tcShowAtr"><span>ATR(14)</span></label>
        </div>
        <div class="tc-nav">
          <button class="secondary" id="tcPrev">← Предыдущая сделка</button>
          <span id="tcCounter" class="muted-note">—</span>
          <button class="secondary" id="tcNext">Следующая сделка →</button>
        </div>
        <div class="tc-status" id="tcStatus"></div>
        <div id="tcChartHost" class="tc-chart-host"></div>
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

      [
        "tcStrategy", "tcDirection", "tcResult", "tcTradeNumber", "tcShowAll", "tcOnlySelected",
        "tcShowMarkers", "tcShowConnectors", "tcShowStopLoss", "tcShowTakeProfit", "tcShowResultLabels",
      ].forEach((id) => {
        container.querySelector("#" + id).addEventListener("input", () => this._applyFilters());
      });
      container.querySelector("#tcShowRsi").onchange = (e) => this._toggleIndicator("rsi", e.target.checked);
      container.querySelector("#tcShowAtr").onchange = (e) => this._toggleIndicator("atr", e.target.checked);
      container.querySelector("#tcPrev").onclick = () => this.selection.prev();
      container.querySelector("#tcNext").onclick = () => this.selection.next();
      container.querySelector("#tcHideAll").onclick = () => {
        container.querySelector("#tcShowAll").checked = false;
        this.selection.select(null);
        this._applyFilters();
      };
      container.querySelector("#tcResetRange").onclick = () => {
        const trades = this.selection.filtered;
        if (!trades.length) { this.core.fitContent(); return; }
        const from = Math.min(...trades.map((t) => t.entry_time));
        const to = Math.max(...trades.map((t) => t.exit_time || t.entry_time));
        this.core.setVisibleRange(from, to);
      };

      this.core.chart.subscribeClick((param) => this._onChartClick(param));
      this._built = true;
    },

    _toggleIndicator(type, on) {
      const key = "_ind_" + type;
      if (on) this[key] = this.indicatorMgr.add(type, {});
      else if (this[key]) { this.indicatorMgr.remove(this[key]); this[key] = null; }
    },

    async selectTicker(ticker) {
      this.ticker = ticker;
      this.container.querySelector("#tcTicker").value = ticker;
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
      const number = el("tcTradeNumber").value;
      this.selection.setFilters((t) => {
        if (strategyId && t.strategy_id !== strategyId) return false;
        if (direction && t.direction !== direction) return false;
        if (profitable === "true" && !(t.net_profit > 0)) return false;
        if (profitable === "false" && !(t.net_profit <= 0)) return false;
        if (number && String(t.number) !== String(number)) return false;
        return true;
      });
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

  global.TradeChart = TradeChart;
})(window);
