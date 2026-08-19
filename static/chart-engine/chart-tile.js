/* One independent chart pane ("tile") for the multi-chart grid in
 * "Анализ графиков". Each tile owns its own ChartCore, IndicatorPaneManager,
 * DrawingManager, RealtimeIndicator, per-tile FullscreenController, and its
 * own full state (ticker/timeframe/chartType/rangeMode/fromDate/
 * toDate/indicators/drawings/zoom/displayOptions/live subscription) -
 * nothing here reads or writes another tile.
 *
 * As of the Stage-2 toolbar unification, a tile's own header is
 * deliberately minimal (identity tag + per-tile fullscreen + close) - every
 * *command* (ticker/timeframe/chart type/indicators/templates/save/
 * settings/range/snapshot/order-strategy) now lives in the single
 * workspace toolbar (chart-analysis.js) and is applied to whichever tile is
 * "active" via the public methods below (setTimeframe/setChartType/
 * selectSymbol/applyQuickRange/saveAsTemplate/...). This file still
 * owns all of that state and logic - only the *chrome that triggers it*
 * moved up a level, so multiple disconnected control rows don't exist. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;

  const TIMEFRAMES = [
    { id: "1m", label: "1м" }, { id: "3m", label: "3м" }, { id: "5m", label: "5м" },
    { id: "10m", label: "10м" }, { id: "15m", label: "15м" }, { id: "30m", label: "30м" },
    { id: "1h", label: "1ч" }, { id: "2h", label: "2ч" }, { id: "4h", label: "4ч" },
    { id: "1d", label: "1д" }, { id: "1w", label: "1н" }, { id: "1mo", label: "1мес" },
  ];
  const TF_LABEL = TIMEFRAMES.reduce((m, t) => (m[t.id] = t.label, m), {});
  const CHART_TYPES = [
    { id: "candles", label: "Свечи" }, { id: "bars", label: "Бары" },
    { id: "line", label: "Линия" }, { id: "area", label: "Область" },
    { id: "baseline", label: "Базовая линия" }, { id: "heikin_ashi", label: "Heikin Ashi" },
    { id: "hollow_candles", label: "Полые свечи" },
  ];
  /* Live-ticking the current candle (see _onRealtimeUpdate below) only
   * covers timeframes with a fixed bucket width in seconds. A calendar day
   * IS a fixed 86400s width (UTC has no DST), so "1d" fits the same math as
   * the intraday buckets and the daily bar ticks live too. 1w/1mo don't: a
   * calendar week/month isn't a fixed multiple of a day (months vary in
   * length), so their "current bucket" can't be derived this way. */
  const LIVE_TICK_BUCKET_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "10m": 600, "15m": 900, "30m": 1800,
    "1h": 3600, "60m": 3600, "2h": 7200, "4h": 4 * 3600, "1d": 86400,
  };
  // How often an active tile re-fetches the tail of /api/candles to pick up
  // whatever the backend's freshness pass has done (a genuinely new real
  // candle or an updated still-forming one) - separate from
  // _onRealtimeUpdate's in-memory live tick, which only ever reacts to the
  // last-trade price. Binance Spot is 24/7 with no fixed publish cadence to
  // stay within (unlike the old MOEX free-tier feed) - 25s is just a sane
  // request budget for a 4-6 tile layout.
  const TAIL_REFRESH_MS = 25000;
  // Binance Spot trades 24/7 (1440 minutes/day) - only used to translate a
  // "days" quick-range preset into a bar count for setVisibleBarCount();
  // doesn't need to be exact, just in the right ballpark so "1Г" roughly
  // shows a year, not a week or a decade.
  const BARS_PER_DAY = {
    "1m": 1440, "3m": 480, "5m": 288, "10m": 144, "15m": 96, "30m": 48,
    "1h": 24, "60m": 24, "2h": 12, "4h": 6, "1d": 1, "1w": 1 / 7, "1mo": 1 / 30,
  };
  const RANGE_PRESETS = [
    { label: "1Д", days: 1 }, { label: "5Д", days: 5 }, { label: "1М", days: 30 }, { label: "3М", days: 90 },
    { label: "6М", days: 182 }, { label: "1Г", days: 365 }, { label: "5Л", days: 365 * 5 },
  ];

  // Icons for the floating toolbar (see ChartTile._renderFloatToolbar below).
  // lock/eye/trash paths match the ones already used by the mobile drawing
  // rail (chart-editor-terminal-mobile-v2.js) so the same action reads as
  // the same glyph everywhere in the app, even though that file's icon() is
  // a separate closure this engine-level file has no business depending on.
  const FT_ICONS = {
    lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    duplicate: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="13" height="13" rx="2"/><path d="M9 20h9a2 2 0 002-2V9"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>',
    edittext: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2 2 0 000-2.8l-1.2-1.2a2 2 0 00-2.8 0L4 15.5V20z"/><path d="M12.5 6.5l3 3"/></svg>',
  };
  // Same conversion as chart-analysis.js's toHex() (Properties panel's own
  // color input) - duplicated rather than shared because that file is a
  // page-level module this engine-level one has no business depending on.
  function ftColorHex(color) {
    if (!color || color[0] === "#") return color || "#7c8cff";
    const m = color.match(/rgba?\((\d+),(\d+),(\d+)/);
    if (!m) return "#7c8cff";
    return "#" + m.slice(1, 4).map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  }

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
    constructor({ symbol = "BTCUSDT", timeframe = "1d", chartType = "candles", displayOptions = null, indicators = null } = {}) {
      this.id = "tile" + ++_seq;
      this.symbol = symbol;
      this.timeframe = timeframe;
      this._initialChartType = chartType;
      this._initialDisplayOptions = displayOptions || null;
      this._initialIndicators = indicators || null;
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
      this._tailTimer = null;
      this._tailInFlight = false;
      this._tailVisHandler = null;
      this._tailFailures = 0;
      this._activatePointerHandler = null;
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
    mount(container, { onActivate, onClose, onScalePlusTap, onFloatToolbarMore } = {}) {
      this.el = container;
      this._onFloatToolbarMore = onFloatToolbarMore || null;
      container.className = "ca-tile";
      container.innerHTML = `
        <div class="ca-tile-header" data-role="header">
          <span class="ca-tile-tag" data-role="tag"></span>
          <div class="ca-tile-realtime-slot" data-role="realtimeSlot"></div>
          <span class="ca-tile-spacer"></span>
          <button class="ca-tile-btn" data-role="fs" title="Полноэкранный режим плитки" aria-label="Полноэкранный режим плитки"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg></button>
          <button class="ca-tile-btn ca-tile-close" data-role="close" title="Закрыть плитку" aria-label="Закрыть плитку">✕</button>
        </div>
        <div class="ca-tile-chart-host" data-role="chartHost">
          <button class="ca-tile-live-btn hidden" data-role="live" type="button">К последней цене</button>
          <button class="ca-scale-plus hidden" data-role="scalePlus" type="button" title="Действие по цене" aria-label="Действие по цене">+</button>
          <div class="ca-float-toolbar hidden" data-role="floatToolbar"></div>
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

      // Price-scale "+": TradingView's own gesture for "act on this exact
      // price" - follows the crosshair vertically along the price-scale
      // gutter while hovering the pane, tap opens a small menu (alert /
      // horizontal line) pre-filled with the hovered price. Deliberately a
      // *sibling* of chartHost's canvas rather than absolutely positioned
      // some other way that would still leave it a DOM descendant of
      // core.container - DrawingManager's pointerdown capture listener is
      // bound to core.container itself, so any element inside it still gets
      // routed through the drawing state machine first; this follows the
      // exact same pattern already proven by the "live" button above
      // (stopPropagation in the button's own handlers, nothing new).
      const scalePlusBtn = container.querySelector('[data-role="scalePlus"]');
      this._scalePlusPoint = null;
      // Freeze position/visibility the instant the pointer is actually over
      // the button, so a live crosshair sample never repositions it out
      // from under a pointer that's already arrived.
      this._scalePlusHovered = false;
      scalePlusBtn.addEventListener("pointerenter", () => { this._scalePlusHovered = true; });
      scalePlusBtn.addEventListener("pointerleave", () => { this._scalePlusHovered = false; });
      // Acts on pointerdown, not click. Directly verified (event-target
      // logging, not guesswork): pointerdown on this button consistently
      // targets the button itself, but the *matching* pointerup/click can
      // land back on the chart's own canvas instead - lightweight-charts
      // reserves an interaction margin around the price scale for its own
      // manual-scale-drag gesture wider than the scale's visible pixels,
      // which can re-target the release side of a press that started on an
      // overlay button sitting inside that margin. Nothing here needs the
      // release half of a click at all - acting immediately on the down
      // event, the one half that's never been observed to mistarget, sidesteps
      // the problem entirely instead of trying to out-guess the margin's exact width.
      scalePlusBtn.onpointerdown = (e) => {
        e.stopPropagation();
        if (this._scalePlusPoint && onScalePlusTap) onScalePlusTap(this, this._scalePlusPoint.price, this._scalePlusPoint.time);
      };
      // Swallow the follow-up click (fires after pointerup, whichever
      // element it lands on, since the interaction already completed above)
      // so it can't bubble into a dm.select(null) or a chart click handler.
      scalePlusBtn.onclick = (e) => e.stopPropagation();

      this.core.chart.subscribeCrosshairMove((param) => {
        const bar = param && param.time != null ? this.core.candleAt(param.time) : null;
        this._updatePriceHeader(bar);
        if (!this._applyingCrosshair) {
          const price = param && param.seriesData && param.seriesData.get(this.core.candleSeries);
          this._crosshairCbs.forEach((cb) => cb(param && param.time, price && price.close));
        }
        this._updateScalePlus(param, scalePlusBtn);
      });
      // subscribeCrosshairMove's `param.point` is only set while the pointer
      // is over the *plot* area - never while over the price-scale gutter
      // itself (confirmed by direct testing: moving toward a right-edge-
      // anchored button made it vanish the instant the cursor reached it,
      // because arriving there exits the zone that keeps it visible in the
      // first place - a real bug, not a fixture of the library). Keeping
      // the button flush against the *inside* of the gutter (updated below
      // from the live price-scale width, not a fixed offset - the gutter's
      // width itself changes with price precision) keeps it inside the
      // hoverable pane the whole time a real pointer travels toward it.
      this.core.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!this._applyingRange) this._rangeChangeCbs.forEach((cb) => cb(range));
      });

      // Floating toolbar (ТЗ "Floating toolbar при выборе"): a small pill of
      // quick style/lock/hide/duplicate/delete controls that tracks the
      // selected drawing's own topmost point, instead of the object's only
      // editing surface being the bottom "Свойства" panel. Content rebuilds
      // on selection change (onChange); position alone updates on every
      // real pane redraw (onViewUpdate, see drawings.js) so it tracks
      // through pan/zoom/live ticks without its own polling loop.
      const floatToolbar = container.querySelector('[data-role="floatToolbar"]');
      this.drawingMgr.onChange(() => this._renderFloatToolbar(floatToolbar));
      this.drawingMgr.onViewUpdate(() => this._positionFloatToolbar(floatToolbar));

      // Alert lines (ТЗ §93): an enabled alert for this tile's symbol shows
      // as a real horizontal price line on the chart, not just a row in the
      // alerts popover - createPriceLine() is lightweight-charts' own
      // built-in feature for exactly this (same mechanism a broker's order
      // line would use), so this needs no custom canvas drawing. Re-synced
      // on every AlertService change (create/update/remove/trigger-disable),
      // on symbol switch (_setSymbol below) and whenever the series itself
      // is recreated (chart-type switch disposes the old series - lines
      // attached to it go with it, see ChartCore.setSeriesType).
      this._alertPriceLines = new Map(); // alert id -> PriceLine
      if (global.AlertService) {
        global.AlertService.onChange(() => this._syncAlertLines());
        this._syncAlertLines();
      }
      this.core.onSeriesChange(() => { this._alertPriceLines = new Map(); this._syncAlertLines(); });

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
      if (onActivate) {
        this._activatePointerHandler = () => onActivate(this);
        container.addEventListener("pointerdown", this._activatePointerHandler, true);
      }

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

    /** Positions/shows/hides the price-scale "+" button for the current
     * crosshair sample. Hidden whenever: the setting is off
     * (displayOptions.scalePlusEnabled, see Chart Settings), the pointer
     * isn't over the plot area (param.point is only set there by
     * lightweight-charts - never while over the price/time scale gutter
     * itself), or a drawing tool is currently armed (placing a point under
     * a button the user is trying to tap would be exactly the kind of
     * accidental geometry TradingView's own plus never risks).
     *
     * Positioned flush against the *inside* of the price-scale gutter
     * (right: <live gutter width>px, not a fixed offset) rather than
     * inside the gutter itself - the gutter's width changes with price
     * precision, and a fixed offset can either overlap the axis label or
     * leave a gap. More importantly: since visibility itself depends on
     * being over the plot area, anchoring inside the gutter would make the
     * button vanish the instant a real pointer reached it (confirmed by
     * direct testing - a fixed-offset version disappeared right as the
     * mouse arrived, because arriving there exits the only zone that keeps
     * it shown). Staying just inside the plot boundary keeps it reachable
     * by an actual continuous pointer approach, not just by teleporting a
     * test cursor onto its coordinates. */
    _updateScalePlus(param, btn) {
      if (!btn || this._scalePlusHovered) return;
      const enabled = !this.core.displayOptions || this.core.displayOptions.scalePlusEnabled !== false;
      const toolArmed = !!(this.drawingMgr && this.drawingMgr.activeTool);
      if (!enabled || toolArmed || !param || !param.point || param.time == null) {
        btn.classList.add("hidden");
        this._scalePlusPoint = null;
        return;
      }
      let price = null;
      try { price = this.core.candleSeries.coordinateToPrice(param.point.y); } catch (err) { price = null; }
      if (!Number.isFinite(price)) {
        btn.classList.add("hidden");
        this._scalePlusPoint = null;
        return;
      }
      let gutterWidth = 56;
      try { gutterWidth = this.core.chart.priceScale("right").width() || gutterWidth; } catch (err) { /* fallback above */ }
      this._scalePlusPoint = { price, time: param.time };
      btn.classList.remove("hidden");
      btn.style.top = `${Math.round(param.point.y)}px`;
      btn.style.right = `${Math.round(gutterWidth) + 4}px`;
    }

    /** Floating toolbar content (ТЗ "Floating toolbar при выборе"): a
     * TradingView-style pill of quick actions for the selected drawing,
     * rebuilt on every DrawingManager change (selection changed, or any
     * property/lock/hidden flip on the drawing this pill already belongs
     * to - same "just re-render, onchange not oninput keeps focus sane"
     * approach as chart-analysis.js's own _renderProps). Actions duplicate
     * what the bottom "Свойства" panel and right-click menu already offer -
     * this is a shortcut for the common ones, not a new source of truth. */
    _renderFloatToolbar(el) {
      if (!el) return;
      const dm = this.drawingMgr;
      const d = dm && dm.drawings.find((x) => x.id === dm.selectedId);
      if (!d) { el.classList.add("hidden"); el.innerHTML = ""; return; }
      el.classList.remove("hidden");
      const isTextual = d.type === "text" || d.type === "note";
      // Arrow Mark glyphs are a fixed size/direction (see ARROW_MARK_LEN_PX
      // in drawings.js) - width/dash have no visual effect on them, and
      // they have no text to edit either, so neither of isTextual's two
      // branches applies.
      const isArrowMark = d.type.startsWith("arrow_mark_");
      const width = Number(d.properties.width || 1);
      const dash = d.properties.dash || "solid";
      // Width/dash selects and the text-edit shortcut match the old fixed-
      // position #tvObjectToolbar bar this pill replaces (chart-mobile-
      // interactions.js's renderObjectToolbar, now removed) exactly, so
      // nothing already-shipped regresses by switching to a pill that
      // actually tracks the selected object instead of sitting pinned to a
      // fixed spot at the top of the workspace.
      el.innerHTML = `
        <input type="color" class="ca-ft-color" data-role="color" value="${ftColorHex(d.properties.color)}" title="Цвет" aria-label="Цвет">
        ${isTextual ? `
        <button type="button" class="ca-ft-btn" data-act="edittext" title="Редактировать текст" aria-label="Редактировать текст">${FT_ICONS.edittext}</button>
        ` : isArrowMark ? "" : `
        <select class="ca-ft-select" data-role="width" title="Толщина" aria-label="Толщина">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${width === n ? "selected" : ""}>${n}px</option>`).join("")}</select>
        <select class="ca-ft-select" data-role="dash" title="Стиль линии" aria-label="Стиль линии">
          <option value="solid" ${dash === "solid" ? "selected" : ""}>—</option>
          <option value="dashed" ${dash === "dashed" ? "selected" : ""}>– –</option>
          <option value="dotted" ${dash === "dotted" ? "selected" : ""}>···</option>
        </select>
        `}
        <span class="ca-ft-sep"></span>
        <button type="button" class="ca-ft-btn ${d.locked ? "active" : ""}" data-act="lock" title="${d.locked ? "Разблокировать" : "Заблокировать"}" aria-label="Заблокировать">${FT_ICONS.lock}</button>
        <button type="button" class="ca-ft-btn ${d.hidden ? "active" : ""}" data-act="hide" title="${d.hidden ? "Показать" : "Скрыть"}" aria-label="Скрыть">${FT_ICONS.eye}</button>
        <button type="button" class="ca-ft-btn" data-act="dup" title="Дублировать (Ctrl+D)" aria-label="Дублировать">${FT_ICONS.duplicate}</button>
        <button type="button" class="ca-ft-btn" data-act="more" title="Настройки" aria-label="Настройки">${FT_ICONS.more}</button>
        <span class="ca-ft-sep"></span>
        <button type="button" class="ca-ft-btn ca-ft-danger" data-act="trash" title="Удалить" aria-label="Удалить">${FT_ICONS.trash}</button>
      `;
      // pointerdown (not click): the pill sits right on top of the
      // drawing's own hit region by design (see the .ca-float-toolbar guard
      // in DrawingManager._onPointerDown/_onDblClick) - stopping here keeps
      // a stray pointerdown from also reaching the tile-activate/pan
      // listeners bound higher up the same container, matching the
      // scalePlus/live-button pattern already used in this file.
      el.onpointerdown = (e) => e.stopPropagation();
      const colorInput = el.querySelector('[data-role="color"]');
      colorInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { color: e.target.value } });
      const widthInput = el.querySelector('[data-role="width"]');
      if (widthInput) widthInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { width: Number(e.target.value) } });
      const dashInput = el.querySelector('[data-role="dash"]');
      if (dashInput) dashInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { dash: e.target.value } });
      const editTextBtn = el.querySelector('[data-act="edittext"]');
      if (editTextBtn) editTextBtn.onclick = () => { if (this._onFloatToolbarMore) this._onFloatToolbarMore(this, { focusText: true }); };
      el.querySelector('[data-act="lock"]').onclick = () => dm.updateDrawing(d.id, { locked: !d.locked });
      el.querySelector('[data-act="hide"]').onclick = () => dm.updateDrawing(d.id, { hidden: !d.hidden });
      el.querySelector('[data-act="dup"]').onclick = () => dm.duplicateDrawing(d.id);
      el.querySelector('[data-act="trash"]').onclick = () => dm.removeDrawing(d.id);
      el.querySelector('[data-act="more"]').onclick = () => { if (this._onFloatToolbarMore) this._onFloatToolbarMore(this); };
      this._positionFloatToolbar(el);
    }

    /** Anchors the toolbar just above the selected drawing's topmost point
     * (DrawingManager.selectionAnchor()), flipping below it and clamping
     * horizontally when that would push it off the pane - same pane-pixel
     * space as selectionAnchor() itself (DrawingManager.paneSize()), not
     * core.container's full size (see paneWidth/paneHeight's doc comment:
     * the gutter/time-strip live outside that space). Runs on every real
     * pane redraw (onViewUpdate) so it tracks pan/zoom/live ticks without
     * its own polling loop. */
    _positionFloatToolbar(el) {
      if (!el || el.classList.contains("hidden")) return;
      const dm = this.drawingMgr;
      const anchor = dm && dm.selectionAnchor();
      if (!anchor) { el.classList.add("hidden"); return; }
      const { width: paneW, height: paneH } = dm.paneSize();
      const w = el.offsetWidth || 160;
      const h = el.offsetHeight || 30;
      const margin = 6;
      let left = anchor.x - w / 2;
      left = Math.max(margin, Math.min(left, paneW - w - margin));
      const above = anchor.y - h - 12;
      const top = above >= margin ? above : Math.min(anchor.y + 12, paneH - h - margin);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    }

    /** Adds/updates/removes this tile's price lines to exactly match its
     * symbol's currently-enabled alerts. Disabled/triggered-once alerts
     * (AlertService flips `enabled:false` on a one-shot alert once it
     * fires) drop off the chart the same way they drop out of "enabled"
     * everywhere else in the UI - the line was never a second source of
     * truth, just a rendering of AlertService.listFor(). */
    _syncAlertLines() {
      if (!this.core || !this.core.candleSeries || !global.AlertService) return;
      const alerts = global.AlertService.listFor(this.symbol).filter((a) => a.enabled);
      const seen = new Set();
      for (const a of alerts) {
        seen.add(a.id);
        const opts = {
          price: a.value,
          color: "#ffb74d",
          lineWidth: 1,
          lineStyle: 2, // dashed - matches theme.js's own crosshair style:2
          axisLabelVisible: true,
          title: `🔔 ${(global.AlertService.CONDITION_LABELS && global.AlertService.CONDITION_LABELS[a.condition]) || ""}`,
        };
        const existing = this._alertPriceLines.get(a.id);
        if (existing) existing.applyOptions(opts);
        else this._alertPriceLines.set(a.id, this.core.candleSeries.createPriceLine(opts));
      }
      for (const [id, line] of this._alertPriceLines) {
        if (!seen.has(id)) {
          try { this.core.candleSeries.removePriceLine(line); } catch (err) { /* series already gone */ }
          this._alertPriceLines.delete(id);
        }
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
     * previous session (see the constructor's docstring). displayOptions
     * (per-tile chart-appearance settings) DOES persist - it's a display
     * preference, not a transient viewport range. */
    toConfig() {
      return {
        symbol: this.symbol, timeframe: this.timeframe,
        chartType: this.core ? this.core.seriesType : this._initialChartType,
        displayOptions: this.core ? this.core.displayOptions : this._initialDisplayOptions,
        indicators: this.indicatorMgr
          ? this.indicatorMgr.list().map((i) => ({ type: i.type, params: i.params, style: i.style }))
          : this._initialIndicators,
      };
    }

    destroy() {
      this._stopTailRefresh();
      if (this.el && this._activatePointerHandler) {
        this.el.removeEventListener("pointerdown", this._activatePointerHandler, true);
      }
      this._activatePointerHandler = null;
      if (this.indicator) this.indicator.destroy();
      if (this.fsCtrl) this.fsCtrl.destroy();
      if (this.drawingMgr) this.drawingMgr.destroy();
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
      this._syncAlertLines();
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
          symbol: this.symbol, timeframe: this.timeframe,
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
      if (def) {
        // An explicitly-saved template is the more intentional source -
        // takes priority over the localStorage session snapshot below,
        // same precedence rule the rest of this class already applies to
        // rangeMode/fromDate/toDate.
        await this._applyLayout(def);
      } else {
        await this._reload();
        // Stage 12 "автоматическое сохранение": indicators added this
        // session (never explicitly saved as a template) still survive a
        // reload via the workspace-state localStorage snapshot - see
        // toConfig()/ChartAnalysisPage._restoreWorkspaceState.
        if (this._initialIndicators) {
          this._initialIndicators.forEach((ind) => this.indicatorMgr.add(ind.type, ind.params, undefined, ind.style));
        }
      }
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
      // __style rides inside params (see saveAsTemplate below) rather than
      // as its own backend column - the chart-layouts schema only has a
      // type/params pair per indicator, and threading a per-instance color/
      // width through there this way needs no backend change.
      (layout.indicators || []).forEach((ind) => {
        const { __style, ...params } = ind.params || {};
        this.indicatorMgr.add(ind.type, params, undefined, __style);
      });
      this._notifyStateChanged({ layoutApplied: true });
    }

    async saveAsTemplate(name) {
      name = name || prompt("Название шаблона", this.layout ? this.layout.name : `${this.symbol} · ${new Date().toLocaleDateString("ru-RU")}`);
      if (!name) return null;
      const payload = {
        context: "analysis", name, symbol: this.symbol, timeframe: this.timeframe,
        visibleFrom: this.rangeMode === "custom" ? this.fromDate : null,
        visibleTo: this.rangeMode === "custom" ? this.toDate : null,
        chartType: this.core ? this.core.seriesType : "candles",
        settings: this.core ? this.core.displayOptions : {},
        indicators: this.indicatorMgr.list().map((i) => ({ type: i.type, params: Object.assign({}, i.params, { __style: i.style }) })),
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
        context: "analysis", name: `${this.symbol} · автосохранение`, symbol: this.symbol,
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

    startRealtime() {
      if (this.indicator && this.symbol) this.indicator.start(this.symbol);
      this._startTailRefresh();
    }
    stopRealtime() {
      if (this.indicator) this.indicator.stop();
      this._stopTailRefresh();
    }
    showReplayMode() {
      if (this.indicator) this.indicator.showReplayMode();
      this._stopTailRefresh(); // Market Replay reads its own history - never poll live Binance data over it
    }

    _startTailRefresh() {
      this._stopTailRefresh();
      const tick = async () => { await this._refreshTail(); this._tailTimer = setTimeout(tick, TAIL_REFRESH_MS); };
      this._tailTimer = setTimeout(tick, TAIL_REFRESH_MS);
      this._tailVisHandler = () => { if (document.visibilityState === "visible") this._refreshTail(); };
      document.addEventListener("visibilitychange", this._tailVisHandler);
    }

    _stopTailRefresh() {
      clearTimeout(this._tailTimer);
      this._tailTimer = null;
      if (this._tailVisHandler) { document.removeEventListener("visibilitychange", this._tailVisHandler); this._tailVisHandler = null; }
    }

    /** Fetches just the tail of /api/candles and merges it in via
     * ChartCore.mergeTailCandles() - no fitContent, no zoom/scroll reset.
     * Skipped for a tile deliberately viewing a fixed past window (custom
     * range whose `to` isn't today), same rule _onRealtimeUpdate uses.
     * Surfaces a persistent failure (2+ in a row - a single blip is not
     * "Ошибка обновления", a genuinely broken poll is) via the same status
     * banner _reload() uses, and clears it on the next successful poll. */
    async _refreshTail() {
      if (this._tailInFlight || !this.core || !this.core.candles.length) return;
      if (document.visibilityState !== "visible") return;
      if (this.rangeMode === "custom" && this.toDate && this.toDate < todayISO()) return;
      this._tailInFlight = true;
      try {
        await this.core.refreshTail(10);
        this._tailFailures = 0;
        if (this.el) {
          const status = this.el.querySelector(".ca-tile-status");
          if (status && status.dataset.refreshError) { status.classList.add("hidden"); delete status.dataset.refreshError; }
        }
        this.updateHeader();
      } catch (e) {
        this._tailFailures++;
        if (this._tailFailures >= 2 && this.el) {
          const host = this.el.querySelector('[data-role="chartHost"]');
          let status = host.querySelector(".ca-tile-status");
          if (!status) { status = document.createElement("div"); status.className = "ca-tile-status"; host.appendChild(status); }
          status.textContent = "Ошибка обновления";
          status.dataset.refreshError = "1";
          status.classList.remove("hidden");
        }
      } finally {
        this._tailInFlight = false;
      }
    }

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
          layoutId: layout.id, symbol: this.symbol, timeframe: this.timeframe,
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
