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

  /* Cross-tile dedup for the main candle load (Stage 4: "единый кэш по
   * ключу ticker+interval+range" - the URL's querystring already IS that
   * key, symbol+board+timeframe+from/to+limit). Two tiles opening the same
   * ticker/timeframe (independently, or via the ticker/interval sync
   * toggles in chart-analysis.js) share the in-flight request instead of
   * both hitting /api/candles. Mirrors the exact pattern already used for
   * realtime quotes (see fetchRealtimeShared in realtime-indicator.js) -
   * deliberately a short in-flight dedup window, not a long-lived stale
   * cache, so a real "reload with fresh data" always hits the network. */
  const CANDLE_FETCH_DEDUP_MS = 4000;
  const _sharedCandleFetches = new Map(); // url -> {promise, ts}
  function fetchCandlesShared(url) {
    const now = Date.now();
    const cached = _sharedCandleFetches.get(url);
    if (cached && now - cached.ts < CANDLE_FETCH_DEDUP_MS) return cached.promise;
    const promise = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      return res.json();
    });
    _sharedCandleFetches.set(url, { promise, ts: now });
    promise.catch(() => { _sharedCandleFetches.delete(url); }); // never cache a failed request
    return promise;
  }

  class ChartCore {
    /** @param {HTMLElement} container @param {{showVolume?:boolean}} opts */
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.chart = LWC.createChart(container, global.ChartEngine.chartOptions());
      this.seriesType = "candles";
      this.candleSeries = this._createPriceSeries("candles");
      this.volumeSeries = null;
      this._seriesChangeCbs = [];
      this.displayOptions = {}; // last applied setDisplayOptions() payload - see toConfig()/restore
      this._tzOffsetHours = 0; // 0 = MSK (data is already naive-MSK-as-UTC, see theme.js formatTime)
      this._haPrev = null; // {open,close} of the last *finalized* Heikin-Ashi bar
      this._haLast = null; // last computed HA point (finalized or still-live)
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

      // "Following the market" (TradingView's default behavior): true while
      // the right edge of the visible range is at (or past) the last loaded
      // bar. Any user pan/zoom that leaves the last bar off-screen turns
      // this off; live ticks then accumulate silently instead of yanking
      // the view back (see appendCandle below and _updateFollowState).
      this._following = true;
      this._pendingLiveCount = 0;
      this._followChangeCbs = [];

      const rangeHandler = (range) => {
        this._maybeLoadOlder(range);
        this._updateFollowState(range);
      };
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

    _createPriceSeries(type) {
      if (type === "line") return this.chart.addSeries(LWC.LineSeries, { color: theme.accent, lineWidth: 2 });
      if (type === "area") return this.chart.addSeries(LWC.AreaSeries, { lineColor: theme.accent, topColor: "rgba(124,140,255,.28)", bottomColor: "rgba(124,140,255,.02)", lineWidth: 2 });
      if (type === "bars") return this.chart.addSeries(LWC.BarSeries, { upColor: theme.up, downColor: theme.down });
      if (type === "baseline") {
        const baseValue = this._candles && this._candles.length ? this._candles[0].close : 0;
        return this.chart.addSeries(LWC.BaselineSeries, {
          baseValue: { type: "price", price: baseValue },
          topLineColor: theme.up, bottomLineColor: theme.down,
          topFillColor1: "rgba(77,212,172,.25)", topFillColor2: "rgba(77,212,172,.02)",
          bottomFillColor1: "rgba(255,112,129,.02)", bottomFillColor2: "rgba(255,112,129,.25)",
          lineWidth: 2,
        });
      }
      // Heikin Ashi renders as candlesticks - only the plotted OHLC values differ
      // (computed by _computeHeikinAshi/_haPoint below), not the series kind.
      return this.chart.addSeries(LWC.CandlestickSeries, global.ChartEngine.candlestickOptions());
    }

    /** Candles/bars/Heikin-Ashi keep full OHLC; line/area/baseline only ever
     * plot the close. (Heikin-Ashi bypasses this - see _computeHeikinAshi/
     * _haPoint, which derive their own synthetic OHLC.)
     *
     * A synthetic no-trade bucket (candle.isSynthetic - see
     * candle_api._fill_synthetic_gaps) gets a muted neutral color instead
     * of the normal up/down palette on candles/bars, so the timeline still
     * visibly advances every interval without implying a real up or down
     * move happened - per spec, "не выделять слишком ярко", just distinct
     * enough to read as "no trade here" on hover/inspection. */
    _seriesPoint(candle, type) {
      if (type === "line" || type === "area" || type === "baseline") {
        return { time: candle.time, value: candle.close };
      }
      const point = { time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
      if (candle.isSynthetic) {
        if (type === "bars") {
          point.color = theme.muted;
        } else {
          point.color = theme.muted;
          point.borderColor = theme.muted;
          point.wickColor = theme.muted;
        }
      }
      return point;
    }

    /** Heikin-Ashi transform (full recompute - used on load/page/reset, not
     * per live tick): haClose is the average of the bar's own OHLC; haOpen
     * is the midpoint of the *previous* HA bar's open/close (first bar
     * falls back to its own raw open/close); haHigh/haLow extend the raw
     * high/low to also cover the HA open/close so the synthetic body never
     * pokes outside its own wick. */
    _computeHeikinAshi(candles) {
      const out = [];
      let prevOpen = null, prevClose = null;
      for (const c of candles) {
        const haOpen = prevOpen == null ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        const haHigh = Math.max(c.high, haOpen, haClose);
        const haLow = Math.min(c.low, haOpen, haClose);
        out.push({ time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose });
        prevOpen = haOpen; prevClose = haClose;
      }
      return out;
    }

    /** Incremental Heikin-Ashi point for the live-ticking bar: haOpen stays
     * fixed at the midpoint of the last *finalized* bar's HA open/close
     * (this._haPrev) for as long as the current bar keeps re-ticking; only
     * haClose/High/Low move each tick. appendCandle() below advances
     * _haPrev exactly once, on the tick where a genuinely new bar starts. */
    _haPoint(candle) {
      const prevOpen = this._haPrev ? this._haPrev.open : candle.open;
      const prevClose = this._haPrev ? this._haPrev.close : candle.close;
      const haOpen = (prevOpen + prevClose) / 2;
      const haClose = (candle.open + candle.high + candle.low + candle.close) / 4;
      const haHigh = Math.max(candle.high, haOpen, haClose);
      const haLow = Math.min(candle.low, haOpen, haClose);
      return { time: candle.time, open: haOpen, high: haHigh, low: haLow, close: haClose };
    }

    onSeriesChange(cb) {
      this._seriesChangeCbs.push(cb);
      return () => { this._seriesChangeCbs = this._seriesChangeCbs.filter((f) => f !== cb); };
    }

    /** Switches candles/line/bars/area. lightweight-charts has no in-place
     * series-type change, so this removes the old series and creates a new
     * one - anything holding a reference to the old series (drawings'
     * attached primitive, in particular) must re-bind via onSeriesChange,
     * which fires with the new series right after data is restored. Zoom/
     * pan position and drawings' own stored price/time coordinates are
     * untouched - only the series object identity changes. */
    setSeriesType(type) {
      if (type === this.seriesType || !["candles", "line", "bars", "area", "baseline", "heikin_ashi"].includes(type)) return;
      this.chart.removeSeries(this.candleSeries);
      this.seriesType = type;
      this.candleSeries = this._createPriceSeries(type);
      if (type === "heikin_ashi") {
        const ha = this._computeHeikinAshi(this._candles);
        this._haLast = ha.length ? ha[ha.length - 1] : null;
        this._haPrev = ha.length > 1 ? { open: ha[ha.length - 2].open, close: ha[ha.length - 2].close } : null;
        this.candleSeries.setData(ha);
      } else {
        this.candleSeries.setData(this._candles.map((c) => this._seriesPoint(c, type)));
      }
      this._applyDisplayOptions();
      this._seriesChangeCbs.forEach((cb) => {
        try { cb(this.candleSeries); } catch (e) { console.error(e); }
      });
    }

    /** Chart-appearance settings (Stage 5): colors, wick/border visibility,
     * price line, grid, background, volume visibility, price precision,
     * autoscale - applied via series/chart applyOptions(), never by
     * recreating the chart or series instance. Persists in this.displayOptions
     * so ChartTile.toConfig() can save/restore it per tile. */
    setDisplayOptions(opts) {
      this.displayOptions = Object.assign({}, this.displayOptions, opts);
      this._applyDisplayOptions();
    }

    _applyDisplayOptions() {
      const o = this.displayOptions || {};
      if (this.seriesType === "candles" || this.seriesType === "heikin_ashi") {
        const opts = {};
        if (o.upColor) opts.upColor = o.upColor;
        if (o.downColor) opts.downColor = o.downColor;
        if (o.borderColor) { opts.borderUpColor = o.borderColor; opts.borderDownColor = o.borderColor; }
        if (o.wickColor) { opts.wickUpColor = o.wickColor; opts.wickDownColor = o.wickColor; }
        if (o.showBorders != null) opts.borderVisible = !!o.showBorders;
        if (o.showWicks != null) opts.wickVisible = !!o.showWicks;
        if (Object.keys(opts).length) this.candleSeries.applyOptions(opts);
      }
      const commonOpts = {};
      if (o.priceLineVisible != null) commonOpts.priceLineVisible = !!o.priceLineVisible;
      if (o.priceFormatPrecision != null) {
        commonOpts.priceFormat = { type: "price", precision: o.priceFormatPrecision, minMove: 1 / Math.pow(10, o.priceFormatPrecision) };
      }
      if (Object.keys(commonOpts).length) this.candleSeries.applyOptions(commonOpts);
      if (this.volumeSeries) this.volumeSeries.applyOptions({ visible: o.showVolume !== false });
      const chartOpts = {};
      if (o.showGrid != null) chartOpts.grid = { vertLines: { visible: !!o.showGrid }, horzLines: { visible: !!o.showGrid } };
      if (o.background) chartOpts.layout = { background: { color: o.background } };
      if (Object.keys(chartOpts).length) this.chart.applyOptions(chartOpts);
      if (o.autoScale != null) this.chart.priceScale("right").applyOptions({ autoScale: !!o.autoScale });
    }

    /** Fixed-offset timezone display (Stage 5's "часовой пояс"): every
     * timestamp in this app is a naive MOEX exchange-local (MSK) datetime
     * encoded as if it were UTC (see theme.js's formatTime docstring/
     * parseNaiveDatetime) - there is no per-viewer IANA timezone to convert
     * *from*, only a single fixed exchange timezone. So "timezone" here
     * genuinely means "displayed as MSK wall-clock (offset 0, the default -
     * UTC-formatting already shows the naive MSK digits as-is) or shifted to
     * true UTC (offset -3h, since MSK is UTC+3 with no DST)" - a real,
     * working, correctly-scoped feature, not a stand-in for full tz support
     * this data model has no room for. */
    setTimezoneOffset(hours) {
      this._tzOffsetHours = hours;
      const offsetSec = hours * 3600;
      this.chart.applyOptions({
        localization: { timeFormatter: (t) => global.ChartEngine.formatTime(t + offsetSec) },
        timeScale: {
          tickMarkFormatter: (time, tickMarkType) => {
            const d = new Date((time + offsetSec) * 1000);
            const get = (opt) => d.toLocaleString("ru-RU", Object.assign({ timeZone: "UTC" }, opt));
            switch (tickMarkType) {
              case 0: return get({ year: "numeric" });
              case 1: return get({ month: "short" });
              case 2: return get({ day: "2-digit", month: "short" });
              default: return get({ hour: "2-digit", minute: "2-digit" });
            }
          },
        },
      });
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
     *
     * `from`/`to` are both optional - the default ("full history") load
     * omits `from` entirely: the backend's tail query (ORDER BY ts DESC
     * LIMIT) then naturally returns just the latest `limit` bars regardless
     * of how far back real history goes, so opening a chart never fetches
     * more than one page's worth up front. Older bars come in later via the
     * existing scroll-triggered _maybeLoadOlder/_fetchOlderPage, exactly
     * like any other lazy-loaded page.
     *
     * When `from` IS given (the user picked a custom range), a single page
     * is still capped at `limit` bars, so for a wide span on a fine-grained
     * timeframe the first page can land short of `from` (e.g. a 6-month
     * request on 10m bars is ~10-15k bars, far past the 5000 page cap).
     * Rather than making the user scroll left to trigger lazy paging for a
     * range they explicitly asked for, keep pulling older pages here until
     * the requested `from` is covered or real history runs out. */
    async load({ symbol, board, timeframe, from, to, limit, onState }) {
      this._fetchParams = { symbol, board, timeframe };
      this._reachedHistoryStart = false;
      // A fresh load (new symbol/timeframe/range) always starts followed -
      // fitContent() is about to show the freshly loaded range's right edge.
      this._following = true;
      this._pendingLiveCount = 0;
      if (this._fetchAbort) this._fetchAbort.abort();
      const controller = new AbortController();
      this._fetchAbort = controller;
      onState && onState("loading");
      try {
        const params = new URLSearchParams({
          symbol,
          board: board || "TQBR",
          timeframe: timeframe || "1d",
          limit: String(limit || 5000),
        });
        if (to) params.set("to", String(to));
        if (from) params.set("from", String(from));
        const data = await fetchCandlesShared(`/api/candles?${params}`);
        if (controller.signal.aborted) return;
        this._setCandles(data.candles || []);
        this._reachedHistoryStart = !data.nextCursor;
        if (from) await this._fillDownTo(from, controller);
        if (controller.signal.aborted) return;
        onState && onState(this._candles.length ? "ready" : "empty");
        return data;
      } catch (err) {
        if (controller.signal.aborted) return;
        onState && onState("error", err);
        throw err;
      }
    }

    /** Public wrapper around _fillDownTo for callers outside load() - e.g. a
     * quick-range preset ("1Г") that needs the visible span covered by real
     * data before zooming to it, without re-fetching the whole series. */
    async ensureCoverageBack(fromDate) {
      await this._fillDownTo(fromDate, new AbortController());
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
      this._following = true;
      this._pendingLiveCount = 0;
      this._setCandles(candles);
    }

    /** Appends (or, if it shares the last bar's timestamp, replaces) exactly
     * one candle via lightweight-charts' incremental `series.update()`
     * instead of re-serializing and redrawing the entire series with
     * `setData()`. Market Replay calls this on every forward step - at 25x-
     * 50x speed that's several redraws a second, and a full setData() over
     * a growing multi-thousand-bar array on every one of them is exactly
     * the "перерисовывался полностью на каждый тик" perf issue to avoid.
     * Falls back to a full _setCandles() if `candle` doesn't extend the
     * series (e.g. after a goto/reset jump) so state never desyncs. */
    appendCandle(candle) {
      const last = this._candles[this._candles.length - 1];
      if (last && candle.time < last.time) {
        this._setCandles(this._candles.concat([candle]));
        return;
      }
      const isNewBar = !last || candle.time !== last.time;
      if (last && candle.time === last.time) {
        this._candles[this._candles.length - 1] = candle;
      } else {
        this._candles.push(candle);
      }
      this._candlesByTime.set(candle.time, candle);
      if (this.seriesType === "heikin_ashi") {
        if (isNewBar && this._haLast) this._haPrev = { open: this._haLast.open, close: this._haLast.close };
        const haPoint = this._haPoint(candle);
        this._haLast = haPoint;
        this.candleSeries.update(haPoint);
      } else {
        this.candleSeries.update(this._seriesPoint(candle, this.seriesType));
      }
      if (this.volumeSeries) {
        this.volumeSeries.update({ time: candle.time, value: candle.volume || 0, color: candle.close >= candle.open ? theme.upSoft : theme.downSoft });
      }
      // lightweight-charts only auto-scrolls series.update() into view when
      // the previous last bar was already the rightmost visible one, so a
      // user who's scrolled back into history never gets yanked forward by
      // this call - it only ever needs to track *our own* count for the
      // "К последней цене" button.
      if (isNewBar && !this._following) {
        this._pendingLiveCount++;
        this._notifyFollow();
      }
      this._notifyDataChanged();
    }

    /** Periodic "catch up on newly closed intervals" fetch (see ChartTile's
     * tail-refresh timer) - separate from load()'s full-range fetch but
     * sharing the same cross-tile dedup cache (fetchCandlesShared), so two
     * tiles polling the same symbol/timeframe at nearly the same moment
     * collapse onto one request instead of firing two. Always asks for the
     * tail of the full history (no from/to), so it naturally reflects
     * whatever the backend's freshness/gap-fill pass just did - see
     * candle_api._ensure_coverage / _fill_synthetic_gaps. Throws on a
     * failed fetch so the caller can distinguish and surface a genuine
     * refresh error, rather than silently doing nothing. */
    async refreshTail(limit) {
      if (!this._fetchParams) return null;
      const { symbol, board, timeframe } = this._fetchParams;
      const params = new URLSearchParams({ symbol, board: board || "TQBR", timeframe: timeframe || "1d", limit: String(limit || 10) });
      const data = await fetchCandlesShared(`/api/candles?${params}`);
      this.mergeTailCandles(data.candles || []);
      return data;
    }

    /** Merges a small ascending batch of the newest backend candles (real
     * and/or synthetic gap-fill bars - see candle_api._fill_synthetic_gaps)
     * into the already-loaded series without a full reload/redraw and
     * without touching zoom/scroll position. This is what lets a periodic
     * background refresh (see ChartTile's tail-refresh timer) pick up a
     * newly-closed real candle, an updated still-forming candle, or a
     * newly-inserted synthetic no-trade bar - each via one targeted
     * series.update() through appendCandle(), never setData(). Silently
     * no-ops if the batch doesn't connect to what's already loaded (a
     * range/symbol change invalidated it mid-flight) - the next full
     * load() resyncs properly instead of splicing on a disconnected tail. */
    mergeTailCandles(candles) {
      if (!candles || !candles.length || !this._candles.length) return;
      const lastLoaded = this._candles[this._candles.length - 1].time;
      if (candles[0].time > lastLoaded + 1) return;
      // Only candles at-or-after the current last loaded bar go through
      // appendCandle (update-in-place or append) - anything older is
      // already-known history repeated in every tail response (the API
      // always returns the newest `limit` rows, not just what changed).
      // Feeding an already-loaded older timestamp into appendCandle would
      // hit its "went backward" fallback (a full concat+resort, meant for
      // a genuine rewind like Market Replay's goto/reset), which doesn't
      // dedupe against an already-present same-timestamp row - a real bug
      // reproduced live (AKMC 10m) where every poll re-appended the same
      // handful of tail bars as duplicates.
      candles.forEach((c) => { if (c.time >= lastLoaded) this.appendCandle(c); });
    }

    /** True while the visible range's right edge is at (or past) the last
     * loaded bar - see the constructor's docstring on _following. */
    get isFollowing() { return this._following; }
    get pendingLiveCount() { return this._pendingLiveCount; }

    onFollowChange(cb) {
      this._followChangeCbs.push(cb);
      return () => { this._followChangeCbs = this._followChangeCbs.filter((f) => f !== cb); };
    }

    _notifyFollow() {
      this._followChangeCbs.forEach((cb) => {
        try { cb(this._following, this._pendingLiveCount); } catch (e) { console.error(e); }
      });
    }

    _updateFollowState(logicalRange) {
      if (!logicalRange || !this._candles.length) return;
      const lastIndex = this._candles.length - 1;
      const following = logicalRange.to >= lastIndex - 0.5;
      if (following === this._following) return;
      this._following = following;
      if (following) this._pendingLiveCount = 0;
      this._notifyFollow();
    }

    /** "К последней цене": scrolls to the live edge and resumes following.
     * Doesn't touch price-scale zoom or drawings - only the time axis. */
    scrollToRealTime() {
      this.chart.timeScale().scrollToRealTime();
      this._following = true;
      this._pendingLiveCount = 0;
      this._notifyFollow();
    }

    _setCandles(candles) {
      this._candles = candles.slice().sort((a, b) => a.time - b.time);
      this._candlesByTime = new Map(this._candles.map((c) => [c.time, c]));
      if (this.seriesType === "heikin_ashi") {
        const ha = this._computeHeikinAshi(this._candles);
        this._haLast = ha.length ? ha[ha.length - 1] : null;
        this._haPrev = ha.length > 1 ? { open: ha[ha.length - 2].open, close: ha[ha.length - 2].close } : null;
        this.candleSeries.setData(ha);
      } else {
        this.candleSeries.setData(this._candles.map((c) => this._seriesPoint(c, this.seriesType)));
      }
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

    /** Zooms to show (roughly) the last `n` loaded bars. Used for the quick
     * range presets (1Д…5Л) instead of setVisibleRange(): a time-based range
     * spanning many more bars than a chart panel can legibly show gets
     * clamped/snapped by lightweight-charts' own bar-spacing floor in ways
     * that don't match the requested span (observed on 10m/1m data over a
     * 1-year window) - working in logical bar indices sidesteps that
     * entirely and is what "how many bars fit" actually means anyway. */
    setVisibleBarCount(n) {
      const total = this._candles.length;
      if (!total) return;
      const count = Math.max(2, Math.min(n, total));
      this.chart.timeScale().setVisibleLogicalRange({ from: total - count - 1, to: total });
    }

    destroy() {
      this._resizeObserver.disconnect();
      this._listeners.forEach((off) => off());
      this.chart.remove();
    }
  }

  global.ChartEngine.ChartCore = ChartCore;
})(window);
