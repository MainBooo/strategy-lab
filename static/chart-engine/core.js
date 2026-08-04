/* Chart engine core: one shared wrapper around lightweight-charts used by
 * both the backtest trade chart and the free-form analysis module. Owns
 * chart lifecycle (create/resize/destroy), candle+volume series, and
 * fetching candle ranges from /api/candles (with abort-on-stale-request
 * and lazy pagination to the left). Everything specific to trades or to
 * drawing tools lives in separate files and is layered on top via the
 * primitives / markers APIs - this file never knows about trades or
 * drawings. */
(function (global) {
  "use strict";

  const LWC = global.LightweightCharts;
  const theme = global.ChartEngine.theme;

  class ChartCore {
    /** @param {HTMLElement} container @param {{showVolume?:boolean}} opts */
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.chart = LWC.createChart(container, global.ChartEngine.chartOptions());
      this.candleSeries = this.chart.addSeries(LWC.CandlestickSeries, global.ChartEngine.candlestickOptions());
      this.volumeSeries = null;
      if (this.opts.showVolume !== false) this._addVolumeSeries();

      this._resizeObserver = new ResizeObserver(() => this._onResize());
      this._resizeObserver.observe(container);
      this._onResize();

      this._candles = [];
      this._candlesByTime = new Map();
      this._fetchAbort = null;
      this._fetchParams = null;
      this._loadingOlder = false;
      this._reachedHistoryStart = false;
      this._listeners = [];

      const rangeHandler = (range) => this._maybeLoadOlder(range);
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);
      this._listeners.push(() => this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler));
    }

    _addVolumeSeries() {
      this.volumeSeries = this.chart.addSeries(global.LightweightCharts.HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
        color: theme.up,
      });
      this.volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }

    _onResize() {
      const rect = this.container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) this.chart.resize(rect.width, rect.height);
    }

    /** @returns {{time:number,open:number,high:number,low:number,close:number,volume:number}[]} */
    get candles() {
      return this._candles;
    }

    candleAt(time) {
      return this._candlesByTime.get(time) || null;
    }

    /** Loads a fresh range for a symbol, replacing any previously loaded data.
     * A single page is capped at `limit` bars, so for a wide from/to span on
     * a fine-grained timeframe the first page can land short of `from` (e.g.
     * a 6-month request on 10m bars is ~10-15k bars, far past the 5000 page
     * cap). Rather than making the user scroll left to trigger lazy paging
     * for a range they explicitly asked for, keep pulling older pages here
     * until the requested `from` is covered or real history runs out. */
    async load({ symbol, board, timeframe, from, to, limit, onState }) {
      this._fetchParams = { symbol, board, timeframe };
      this._reachedHistoryStart = false;
      if (this._fetchAbort) this._fetchAbort.abort();
      const controller = new AbortController();
      this._fetchAbort = controller;
      onState && onState("loading");
      try {
        const params = new URLSearchParams({
          symbol,
          board: board || "TQBR",
          timeframe: timeframe || "1d",
          from: String(from),
          to: String(to),
          limit: String(limit || 5000),
        });
        const res = await fetch(`/api/candles?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const data = await res.json();
        if (controller.signal.aborted) return;
        this._setCandles(data.candles || []);
        this._reachedHistoryStart = !data.nextCursor;
        await this._fillDownTo(from, controller);
        if (controller.signal.aborted) return;
        onState && onState(this._candles.length ? "ready" : "empty");
        return data;
      } catch (err) {
        if (controller.signal.aborted) return;
        onState && onState("error", err);
        throw err;
      }
    }

    /** Keeps fetching older pages (same mechanism as _maybeLoadOlder) until
     * the oldest loaded bar reaches `from` or the API says there's no more
     * history. Bounded by an iteration cap so a misbehaving cursor can't
     * spin forever. */
    async _fillDownTo(from, controller) {
      const fromTs = Math.floor(new Date(from).getTime() / 1000);
      if (!Number.isFinite(fromTs)) return;
      for (let i = 0; i < 200; i++) {
        if (controller.signal.aborted || this._reachedHistoryStart) return;
        if (!this._candles.length || this._candles[0].time <= fromTs) return;
        const added = await this._fetchOlderPage(controller.signal);
        if (!added) return;
      }
    }

    /** For adapters that fetch candles from a different endpoint than /api/candles
     * (e.g. the backtest trade chart, which must show exactly the local file the
     * engine ran against, not a fresh MOEX fetch). */
    setCandlesDirect(candles) {
      this._reachedHistoryStart = true; // no lazy-left-scroll pagination for this source
      this._setCandles(candles);
    }

    _setCandles(candles) {
      this._candles = candles.slice().sort((a, b) => a.time - b.time);
      this._candlesByTime = new Map(this._candles.map((c) => [c.time, c]));
      this.candleSeries.setData(this._candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
      if (this.volumeSeries) {
        this.volumeSeries.setData(
          this._candles.map((c) => ({
            time: c.time,
            value: c.volume || 0,
            color: c.close >= c.open ? theme.upSoft : theme.downSoft,
          }))
        );
      }
      this._notifyDataChanged();
    }

    async _maybeLoadOlder(logicalRange) {
      if (!logicalRange || this._loadingOlder || this._reachedHistoryStart || !this._fetchParams) return;
      if (logicalRange.from > 12) return; // still far from the left edge
      if (!this._candles.length) return;
      await this._fetchOlderPage();
    }

    /** Fetches one older page and prepends it to `_candles`. Returns true if
     * any new (strictly older) bars were added, false if history is
     * exhausted (and sets `_reachedHistoryStart` accordingly). */
    async _fetchOlderPage(signal) {
      if (this._loadingOlder || !this._fetchParams || !this._candles.length) return false;
      this._loadingOlder = true;
      try {
        const earliest = this._candles[0].time;
        const params = new URLSearchParams({
          symbol: this._fetchParams.symbol,
          board: this._fetchParams.board || "TQBR",
          timeframe: this._fetchParams.timeframe || "1d",
          from: "2000-01-01",
          to: new Date(earliest * 1000).toISOString().slice(0, 10),
          before: String(earliest),
          limit: "2000",
        });
        const res = await fetch(`/api/candles?${params}`, signal ? { signal } : undefined);
        if (!res.ok) return false;
        const data = await res.json();
        const older = (data.candles || []).filter((c) => c.time < earliest);
        if (!older.length) {
          this._reachedHistoryStart = true;
          return false;
        }
        this._setCandles(older.concat(this._candles));
        this._reachedHistoryStart = !data.nextCursor;
        return true;
      } catch (err) {
        if (signal && signal.aborted) return false;
        throw err;
      } finally {
        this._loadingOlder = false;
      }
    }

    onDataChanged(cb) {
      this._dataChangedCbs = this._dataChangedCbs || [];
      this._dataChangedCbs.push(cb);
      return () => {
        this._dataChangedCbs = this._dataChangedCbs.filter((f) => f !== cb);
      };
    }

    _notifyDataChanged() {
      (this._dataChangedCbs || []).forEach((cb) => {
        try {
          cb(this._candles);
        } catch (e) {
          console.error(e);
        }
      });
    }

    fitContent() {
      this.chart.timeScale().fitContent();
    }

    /** Scrolls/zooms the visible range to cover [from,to] with a small margin, in unix seconds. */
    setVisibleRange(from, to) {
      const span = Math.max(1, to - from);
      const margin = Math.round(span * 0.15);
      this.chart.timeScale().setVisibleRange({ from: from - margin, to: to + margin });
    }

    destroy() {
      this._resizeObserver.disconnect();
      this._listeners.forEach((off) => off());
      this.chart.remove();
    }
  }

  global.ChartEngine.ChartCore = ChartCore;
})(window);
