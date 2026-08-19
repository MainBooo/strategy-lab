/* Responsive professional chart terminal UI. Presentation only: all commands
 * delegate to the existing ChartAnalysisPage, ChartTile and DrawingManager.
 */
(function (g) {
  "use strict";
  const Page = g.ChartAnalysisPage, CE = g.ChartEngine, I = CE && CE.Indicators;
  if (!Page || !CE) return;
  const PHONE = "(max-width:768px),(max-width:980px) and (max-height:520px)";
  const phone = () => !!g.matchMedia && g.matchMedia(PHONE).matches;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const fmt = (v, d=2) => Number.isFinite(Number(v)) ? Number(v).toLocaleString("ru-RU", { minimumFractionDigits:d, maximumFractionDigits:d }) : "—";
  const icon = (name) => ({
    cursor:'<svg viewBox="0 0 24 24"><path d="M5 3l12 9-6 1 4 7-3 1-4-7-3 4z"/></svg>',
    trend:'<svg viewBox="0 0 24 24"><path d="M4 18L20 6"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="6" r="2"/></svg>',
    fib:'<svg viewBox="0 0 24 24"><path d="M4 5h16M4 9h10M4 13h16M4 17h10M4 21h16"/></svg>',
    shape:'<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="1"/></svg>',
    text:'<svg viewBox="0 0 24 24"><path d="M5 5h14M12 5v14M8 19h8"/></svg>',
    measure:'<svg viewBox="0 0 24 24"><path d="M5 19L19 5M5 14v5h5M14 5h5v5"/></svg>',
    brush:'<svg viewBox="0 0 24 24"><path d="M4 20c4 0 3-4 6-4l8-8-3-3-8 8c0 3-3 3-3 7z"/></svg>',
    position:'<svg viewBox="0 0 24 24"><path d="M5 17h14M7 13l5-7 5 7"/></svg>',
    magnet:'<svg viewBox="0 0 24 24"><path d="M6 4v8a6 6 0 0012 0V4M6 8h4M14 8h4"/></svg>',
    lock:'<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>',
    eye:'<svg viewBox="0 0 24 24"><path d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    list:'<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    trash:'<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>',
    gear:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>',
    plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    close:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    hamburger:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    shieldPlus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 5-3 8-7 9-4-1-7-4-7-9V6l7-3z"/><path d="M12 9v6M9 12h6"/></svg>',
    circlePlus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    gann:'<svg viewBox="0 0 24 24"><path d="M4 20L20 4M4 20L20 12M4 20L20 18M4 20L12 4M4 20L18 4"/></svg>',
    pattern:'<svg viewBox="0 0 24 24"><path d="M4 18l4-10 4 6 4-11 4 9"/><circle cx="4" cy="18" r="1.6"/><circle cx="8" cy="8" r="1.6"/><circle cx="12" cy="14" r="1.6"/><circle cx="16" cy="3" r="1.6"/><circle cx="20" cy="12" r="1.6"/></svg>',
    cycles:'<svg viewBox="0 0 24 24"><path d="M2 12c2-6 4-6 5.5 0S11 18 12 12s2.5-6 4-6 3.5 0 5.5 0"/><line x1="8" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="16" y2="20"/></svg>',
    vwap:'<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="4" y2="14"/><line x1="9" y1="20" x2="9" y2="9"/><line x1="14" y1="20" x2="14" y2="5"/><line x1="19" y1="20" x2="19" y2="11"/><path d="M2 17c3 0 5-5 8-7s7-1 12 1"/></svg>',
    arrow:'<svg viewBox="0 0 24 24"><path d="M4 20L20 4M20 4H11M20 4v9"/></svg>',
    curve:'<svg viewBox="0 0 24 24"><path d="M4 18C4 8 10 20 20 6"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="6" r="1.6"/></svg>'
  }[name] || "");

  const groups = [
    ["cursor","Курсор",icon("cursor"),[[null,"Курсор / выбор"]]],
    ["trend","Линии",icon("trend"),[["trend_line","Линия тренда"],["ray","Луч"],["horizontal_line","Горизонтальная линия"],["horizontal_ray","Горизонтальный луч"],["vertical_line","Вертикальная линия"],["parallel_channel","Параллельный канал"],["trend_angle","Угол тренда"],["regression_trend","Регрессионный тренд"],["flat_top_bottom","Плоский верх/низ"],["disjoint_channel","Несвязный канал"]]],
    ["fib","Фибоначчи",icon("fib"),[["fib_retracement","Коррекция Фибоначчи"],["fib_extension","Расширение Фибоначчи"],["fib_channel","Канал Фибоначчи"],["fib_wedge","Клин Фибоначчи"],["fib_time_zone","Временные зоны Фибоначчи"],["trend_based_fib_time","Временные зоны по тренду"],["fib_speed_resistance_fan","Веер скорости Фибоначчи"],["fib_pitchfan","Веер Фибоначчи (Pitchfan)"],["fib_circles","Круги Фибоначчи"],["fib_arcs","Дуги Фибоначчи"],["fib_spiral","Спираль Фибоначчи"]]],
    ["gann","Ганн и вилы",icon("gann"),[["pitchfork","Вилы Эндрюса"],["pitchfork_schiff","Вилы Шиффа"],["pitchfork_modified_schiff","Модиф. вилы Шиффа"],["gann_fan","Веер Ганна"]]],
    ["pattern","Паттерны",icon("pattern"),[["xabcd_pattern","Паттерн XABCD"],["abcd_pattern","Паттерн ABCD"],["triangle_pattern","Паттерн треугольник"],["three_drives_pattern","Три драйва"],["head_shoulders_pattern","Голова и плечи"],["elliott_impulse_wave","Волна Эллиотта (импульс)"],["elliott_correction_wave","Волна Эллиотта (коррекция)"]]],
    ["cycles","Циклы",icon("cycles"),[["cyclic_lines","Циклические линии"],["sine_line","Синусоида"]]],
    ["vwap","VWAP / Профиль",icon("vwap"),[["anchored_vwap","Привязанный VWAP"],["volume_profile","Профиль объёма (диапазон)"]]],
    ["shape","Фигуры",icon("shape"),[["rectangle","Прямоугольник"],["rotated_rectangle","Повёрнутый прямоугольник"],["circle","Эллипс"],["triangle","Треугольник"]]],
    ["arrow","Стрелки",icon("arrow"),[["arrow","Стрелка"],["arrow_mark_up","Стрелка вверх"],["arrow_mark_down","Стрелка вниз"],["arrow_mark_left","Стрелка влево"],["arrow_mark_right","Стрелка вправо"]]],
    ["curves","Кривые",icon("curve"),[["path","Путь"],["curve","Кривая"],["arc","Дуга"],["double_curve","Двойная кривая"]]],
    ["text","Текст",icon("text"),[["text","Текст"],["note","Заметка / метка"],["anchored_text","Привязанный текст"],["price_note","Ценовая заметка"],["callout","Выноска"],["comment","Комментарий"],["price_label","Ценовая метка"],["signpost","Сигнальный флаг"]]],
    ["measure","Измерения",icon("measure"),[["measure","Линейка (временная)"],["price_range","Диапазон цены"],["time_range","Диапазон времени"],["price_date_range","Цена и время"]]],
    ["brush","Кисть",icon("brush"),[["freehand","Кисть / freehand"],["highlighter","Маркер / highlighter"]]],
    ["position","Позиции",icon("position"),[["long_position","Long Position"],["short_position","Short Position"]]]
  ];
  const drawingManager = () => Page.activeTile && Page.activeTile.drawingMgr;
  const indicatorManager = () => Page.activeTile && Page.activeTile.indicatorMgr;
  const MAGNET_CYCLE = ["off", "weak", "strong"];
  const MAGNET_LABEL = { off: "выкл", weak: "слабый", strong: "сильный" };

  // TradingView's rail "eye"/"trash" open a family menu (Drawings/
  // Indicators/Positions/All), not a single flat toggle - Positions
  // (long_position/short_position) are DrawingManager entries like any
  // other drawing, so they're split out here rather than in drawings.js.
  const POSITION_TYPES = new Set(["long_position", "short_position"]);
  const bucketDrawings = (dm) => dm.drawings.filter((d) => !POSITION_TYPES.has(d.type));
  const bucketPositions = (dm) => dm.drawings.filter((d) => POSITION_TYPES.has(d.type));
  const allHiddenOf = (arr) => arr.length > 0 && arr.every((d) => d.hidden);

  function familyMenuItems(mode, dm, ind) {
    const drawings = bucketDrawings(dm), positions = bucketPositions(dm);
    const indicators = ind ? ind.list() : [];
    const anything = drawings.length || positions.length || indicators.length;
    if (mode === "hide") {
      return [
        { key: "drawings", label: allHiddenOf(drawings) ? "Показать рисунки" : "Скрыть рисунки", disabled: !drawings.length },
        { key: "positions", label: allHiddenOf(positions) ? "Показать позиции" : "Скрыть позиции", disabled: !positions.length },
        { key: "indicators", label: (ind && ind.allHidden()) ? "Показать индикаторы" : "Скрыть индикаторы", disabled: !indicators.length },
        { key: "all", label: "Скрыть/показать всё", disabled: !anything },
      ];
    }
    return [
      { key: "drawings", label: "Удалить рисунки", disabled: !drawings.length },
      { key: "positions", label: "Удалить позиции", disabled: !positions.length },
      { key: "indicators", label: "Удалить индикаторы", disabled: !indicators.length },
      { key: "all", label: "Удалить всё", disabled: !anything },
    ];
  }

  function runFamilyAction(mode, key, dm, ind) {
    const toggle = (arr) => { if (!arr.length) return; const hide = !allHiddenOf(arr); arr.forEach((d) => dm.updateDrawing(d.id, { hidden: hide })); };
    if (mode === "hide") {
      if (key === "drawings") toggle(bucketDrawings(dm));
      else if (key === "positions") toggle(bucketPositions(dm));
      else if (key === "indicators") { if (ind && ind.list().length) ind.setAllVisible(ind.allHidden()); }
      else if (key === "all") {
        const allHidden = dm.drawings.every((d) => d.hidden) && (!ind || !ind.list().length || ind.allHidden());
        dm.drawings.slice().forEach((d) => dm.updateDrawing(d.id, { hidden: !allHidden }));
        if (ind) ind.setAllVisible(allHidden);
      }
      return;
    }
    if (key === "drawings") { const arr = bucketDrawings(dm); if (arr.length && g.confirm("Удалить все рисунки (без позиций)?")) arr.forEach((d) => dm.removeDrawing(d.id)); }
    else if (key === "positions") { const arr = bucketPositions(dm); if (arr.length && g.confirm("Удалить все позиции?")) arr.forEach((d) => dm.removeDrawing(d.id)); }
    else if (key === "indicators") { const arr = ind ? ind.list() : []; if (arr.length && g.confirm("Удалить все индикаторы?")) arr.forEach((i) => ind.remove(i.id)); }
    else if (key === "all" && dm.drawings.length + (ind ? ind.list().length : 0) > 0 && g.confirm("Удалить все объекты разметки и индикаторы?")) {
      dm.drawings.slice().forEach((d) => dm.removeDrawing(d.id));
      if (ind) ind.list().forEach((i) => ind.remove(i.id));
    }
  }

  function buildRail() {
    if (!Page.root) return;
    const rail = Page.root.querySelector("#caTools");
    if (!rail || rail.dataset.slV2) return;
    if (typeof Page._drawingToolbarCleanup === "function") Page._drawingToolbarCleanup();
    rail.dataset.slV2 = "1"; rail.classList.add("tv-rail");
    rail.innerHTML = groups.map(gp => `<button class="sl-draw-group" type="button" data-sl-group="${gp[0]}" title="${esc(gp[1])}" aria-label="${esc(gp[1])}" aria-pressed="false">${gp[2]}<i></i></button>`).join("") + `
      <span class="sl-rail-sep"></span>
      <button class="sl-rail-action" data-sl-act="magnet" title="Магнит: выкл" aria-label="Магнит" aria-pressed="false">${icon("magnet")}<b class="sl-magnet-badge"></b></button>
      <button class="sl-rail-action" data-sl-act="keep" title="Оставаться в режиме рисования" aria-label="Оставаться в режиме рисования" aria-pressed="false">✎</button>
      <button class="sl-rail-action" data-sl-act="lock" title="Блокировка разметки" aria-label="Блокировка разметки" aria-pressed="false">${icon("lock")}</button>
      <button class="sl-rail-action" data-sl-act="hide" title="Скрыть/показать: рисунки, позиции, индикаторы" aria-label="Скрыть/показать" aria-pressed="false">${icon("eye")}</button>
      <button class="sl-rail-action" data-sl-act="objects" data-tv-action="objects" title="Объекты" aria-label="Объекты" aria-pressed="false">${icon("list")}</button>
      <button class="sl-rail-action" data-sl-act="delete" title="Удалить: рисунки, позиции, индикаторы" aria-label="Удалить">${icon("trash")}</button>
      <div class="sl-draw-picker hidden" role="menu"></div>`;
    const picker = rail.querySelector(".sl-draw-picker");
    rail.onclick = (event) => {
      const groupButton = event.target.closest("[data-sl-group]");
      if (groupButton) {
        event.stopPropagation(); const gp = groups.find(x => x[0] === groupButton.dataset.slGroup); if (!gp) return;
        if (gp[3].length === 1) { g.ChartDrawingUI?.deactivateEveryTool(Page, { deselectActive: true }); drawingManager()?.setTool(gp[3][0][0] || null); picker.classList.add("hidden"); refreshRail(); return; }
        const same = picker.dataset.group === gp[0] && !picker.classList.contains("hidden");
        picker.dataset.group = gp[0]; delete picker.dataset.family;
        picker.innerHTML = `<strong>${esc(gp[1])}</strong>` + gp[3].map(t => `<button type="button" data-sl-tool="${t[0] || ""}">${esc(t[1])}</button>`).join("");
        picker.classList.toggle("hidden", same); return;
      }
      const tool = event.target.closest("[data-sl-tool]");
      if (tool) { g.ChartDrawingUI?.deactivateEveryTool(Page, { deselectActive: true }); drawingManager()?.setTool(tool.dataset.slTool || null); picker.classList.add("hidden"); refreshRail(); return; }
      const familyItem = event.target.closest("[data-sl-family-item]");
      if (familyItem) {
        event.stopPropagation();
        if (familyItem.disabled) return;
        const dm = drawingManager(); if (!dm) return;
        runFamilyAction(picker.dataset.family, familyItem.dataset.slFamilyItem, dm, indicatorManager());
        picker.classList.add("hidden");
        refreshRail();
        return;
      }
      const openFamilyMenu = (mode, dm) => {
        const same = picker.dataset.family === mode && !picker.classList.contains("hidden");
        picker.dataset.family = mode; delete picker.dataset.group;
        const items = familyMenuItems(mode, dm, indicatorManager());
        const title = mode === "hide" ? "Скрыть/показать" : "Удалить";
        picker.innerHTML = `<strong>${title}</strong>` + items.map(it => `<button type="button" data-sl-family-item="${it.key}" ${it.disabled ? "disabled" : ""}>${esc(it.label)}</button>`).join("");
        picker.classList.toggle("hidden", same);
      };
      const action = event.target.closest("[data-sl-act]"); if (!action) return;
      const dm = drawingManager(); if (!dm) return;
      if (action.dataset.slAct === "magnet") dm.magnetMode = MAGNET_CYCLE[(MAGNET_CYCLE.indexOf(dm.magnetMode) + 1) % MAGNET_CYCLE.length];
      else if (action.dataset.slAct === "keep") dm.keepDrawing = !dm.keepDrawing;
      else if (action.dataset.slAct === "lock") { const lock = !(dm.drawings.length && dm.drawings.every(x => x.locked)); dm.drawings.slice().forEach(x => dm.updateDrawing(x.id, { locked:lock })); }
      else if (action.dataset.slAct === "hide") { event.stopPropagation(); openFamilyMenu("hide", dm); return; }
      else if (action.dataset.slAct === "objects") { const opening = Page._bottomCollapsed !== false; Page._setBottomCollapsed(!opening); if (opening) Page.root.querySelector('.ca-side-tab[data-side="objects"]')?.click(); }
      else if (action.dataset.slAct === "delete") { event.stopPropagation(); openFamilyMenu("delete", dm); return; }
      refreshRail();
    };
    document.addEventListener("pointerdown", (event) => {
      if (picker.classList.contains("hidden")) return;
      if (event.target instanceof Node && rail.contains(event.target)) return;
      picker.classList.add("hidden");
    }, true);
  }

  /** Reflects current drawing-engine state onto the rail's buttons - which
   * tool group is armed, magnet/keep-drawing/lock-all/hide-all pressed
   * state, objects-panel-open state. buildRail() only runs the DOM build
   * once (guarded by data-sl-v2); this is the cheap per-change refresh, and
   * is also what chart-mobile-interactions.js's object-toolbar/props-panel
   * hooks call (via g.StrategyLabMobileChart.refreshRail) now that this file
   * owns the one live rail. */
  function refreshRail() {
    const rail = Page.root && Page.root.querySelector("#caTools");
    if (!rail) return;
    const dm = drawingManager();
    const activeTool = dm ? dm.activeTool : null;
    rail.querySelectorAll("[data-sl-group]").forEach((btn) => {
      const gp = groups.find((x) => x[0] === btn.dataset.slGroup);
      if (!gp) return;
      const belongs = gp[0] === "cursor" ? !activeTool : gp[3].some((t) => t[0] === activeTool);
      btn.classList.toggle("active", belongs);
      btn.setAttribute("aria-pressed", belongs ? "true" : "false");
    });
    const setPressed = (act, on) => {
      const btn = rail.querySelector(`[data-sl-act="${act}"]`);
      if (!btn) return;
      btn.classList.toggle("active", !!on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    };
    const magnetMode = (dm && dm.magnetMode) || "off";
    setPressed("magnet", magnetMode !== "off");
    const magnetBtn = rail.querySelector('[data-sl-act="magnet"]');
    if (magnetBtn) {
      magnetBtn.title = `Магнит: ${MAGNET_LABEL[magnetMode]}`;
      const badge = magnetBtn.querySelector(".sl-magnet-badge");
      if (badge) badge.textContent = magnetMode === "weak" ? "W" : magnetMode === "strong" ? "S" : "";
    }
    setPressed("keep", dm && dm.keepDrawing);
    setPressed("lock", dm && dm.drawings.length && dm.drawings.every((x) => x.locked));
    const ind = indicatorManager();
    const anythingToHide = dm && (dm.drawings.length || (ind && ind.list().length));
    setPressed("hide", anythingToHide && dm.drawings.every((x) => x.hidden) && (!ind || !ind.list().length || ind.allHidden()));
    setPressed("objects", Page._bottomCollapsed === false);
  }

  function renderMarketHeader() {
    const tile = Page.activeTile, host = tile?.el?.querySelector('[data-role="chartHost"]'); if (!tile || !host) return;
    let el = host.querySelector(".sl-market-head"); if (!el) { el = document.createElement("div"); el.className = "sl-market-head"; host.appendChild(el); }
    const candles = tile.core?.candles || [], last = candles[candles.length - 1], info = tile._lastPriceInfo || {}, rt = tile.indicator?._lastPayload || {}, name = Page._instrumentName ? Page._instrumentName(tile.symbol) : "";
    const diff = info.diff != null ? `${info.diff >= 0 ? "+" : ""}${fmt(info.diff)} (${info.pct >= 0 ? "+" : ""}${fmt(info.pct)}%)` : "";
    el.innerHTML = `<b>${esc(tile.symbol)}</b><span> · ${esc(name)}</span><div><strong>${fmt(info.price != null ? info.price : last?.close)}</strong> <em class="${info.diff >= 0 ? "pnl-pos" : "pnl-neg"}">${diff}</em></div>${rt.bid != null || rt.offer != null ? `<section>${rt.bid != null ? `<i class="sell">${fmt(rt.bid)}<small>ПРОДАТЬ</small></i>` : ""}${rt.offer != null ? `<i class="buy">${fmt(rt.offer)}<small>КУПИТЬ</small></i>` : ""}</section>` : ""}<small>Объём ${last ? Number(last.volume || 0).toLocaleString("ru-RU", { notation:"compact", maximumFractionDigits:2 }) : "—"}</small>`;
  }

  /** One compact bottom row instead of the two stacked ones this used to
   * build (a "Диапазон/clock/%/лог/авто" row plus a separate "Список
   * котировок/Детали инструмента" tab row) - real TradingView mobile has a
   * single slim row here with plain text only, no icon buttons at all:
   * "Диапазон дат / clock / коррект.". Matched that exactly by moving every
   * icon-button action elsewhere: the scale toggles (%/лог/авто) and the
   * watchlist opener now live as ordinary rows inside the existing "..."
   * ("Ещё") popover (_renderMorePopover in chart-analysis.js), which this
   * row's "Диапазон" button already opens - no new UI surface, no gesture
   * guessing, and nothing here risks the separately-shipped price-axis
   * tap-to-alert gesture. */
  function buildBottomControls() {
    if (!Page.root) return; const center = Page.root.querySelector("#caCenter"); if (!center || center.querySelector(".sl-chart-controls")) return;
    center.insertAdjacentHTML("beforeend", `<div class="sl-chart-controls"><button type="button" data-sl-range>Диапазон ▾</button><span class="sl-chart-controls-sep"></span><span class="sl-chart-controls-clock" data-sl-clock>--:--:-- (UTC+3)</span></div>`);
    const controls = center.querySelector(".sl-chart-controls");
    controls.querySelector("[data-sl-range]").onclick = () => Page.root.querySelector("#gtMoreBtn")?.click();
    const tick = () => { const clock = controls.querySelector("[data-sl-clock]"); if (clock) clock.textContent = new Date(Date.now() + 3 * 3600000).toISOString().slice(11, 19) + " (UTC+3)"; };
    tick(); if (!Page._slClockTimer) Page._slClockTimer = setInterval(tick, 1000);
  }

  function closeButton() {
    const head = Page.root?.querySelector("#caBottom .ca-bottom-head"); if (!head || head.querySelector(".sl-panel-close")) return;
    const b = document.createElement("button"); b.className = "sl-panel-close"; b.type = "button"; b.title = "Закрыть"; b.setAttribute("aria-label", "Закрыть"); b.innerHTML = icon("close"); b.onclick = () => Page._setBottomCollapsed(true); head.appendChild(b);
  }

  function categoryOf(def) {
    if (def.category) return def.category;
    if (["sma","ema","wma","vwap"].includes(def.id)) return "trend";
    if (["bollinger","donchian","atr"].includes(def.id)) return "volatility";
    if (["rsi","macd","stochastic","momentum"].includes(def.id)) return "oscillator";
    if (def.id === "volume") return "volume";
    return "trend";
  }
  if (I) Page._renderIndicatorsInto = function (container) {
    const tile = this.activeTile; if (!tile || !container) return;
    const instances = tile.indicatorMgr.list(), cats = { trend:"ТРЕНДОВЫЕ", volatility:"ВОЛАТИЛЬНОСТЬ", oscillator:"ОСЦИЛЛЯТОРЫ", volume:"ОБЪЁМ", levels:"УРОВНИ / TREND STRENGTH" };
    container.innerHTML = `<div class="sl-ind-top"><b>Индикаторы и стратегии</b><span>Активно: ${instances.length}</span></div><input class="sl-ind-search" type="search" placeholder="Поиск индикаторов" aria-label="Поиск индикаторов"><div class="sl-ind-tabs"><button class="active" type="button">Технические</button><button type="button" disabled>Мои</button></div><div class="sl-active-ind">${instances.map(inst => { const def = I.registry.find(x => x.id === inst.type); return `<div class="sl-active-row"><span>${esc(def?.label || inst.type)}</span><button type="button" data-sl-set="${inst.id}" title="Настройки">${icon("gear")}</button><button type="button" data-sl-vis="${inst.id}" title="Показать/скрыть">${icon("eye")}</button><button type="button" data-sl-rm="${inst.id}" title="Удалить">${icon("trash")}</button><div class="sl-inline-settings hidden" data-sl-settings="${inst.id}"></div></div>`; }).join("")}</div>${Object.entries(cats).map(([key, label]) => `<section class="sl-ind-cat" data-cat="${key}"><h5>${label}</h5>${I.registry.filter(def => categoryOf(def) === key).map(def => { const search = [def.label, def.shortName, def.name, def.ruName, ...(def.aliases || [])].filter(Boolean).join(" ").toLowerCase(); return `<div class="sl-ind-item" data-search="${esc(search)}"><span><b>${esc(def.shortName || def.label)}</b><small>${esc(def.ruName && def.ruName !== def.label ? def.ruName : def.label)}</small></span><button type="button" data-sl-add="${def.id}" aria-label="Добавить ${esc(def.label)}">${icon("plus")}</button></div>`; }).join("")}</section>`).join("")}`;
    const search = container.querySelector(".sl-ind-search"); search.oninput = () => { const q = search.value.trim().toLowerCase(); container.querySelectorAll(".sl-ind-item").forEach(x => x.hidden = !!q && !x.dataset.search.includes(q)); container.querySelectorAll(".sl-ind-cat").forEach(x => x.hidden = ![...x.querySelectorAll(".sl-ind-item")].some(y => !y.hidden)); };
    container.querySelectorAll("[data-sl-add]").forEach(b => b.onclick = () => { tile.indicatorMgr.add(b.dataset.slAdd, {}); this._saveWorkspaceState(); this._renderIndicatorsInto(container); renderMarketHeader(); });
    container.querySelectorAll("[data-sl-rm]").forEach(b => b.onclick = () => { tile.indicatorMgr.remove(b.dataset.slRm); this._saveWorkspaceState(); this._renderIndicatorsInto(container); });
    container.querySelectorAll("[data-sl-vis]").forEach(b => b.onclick = () => { const inst = tile.indicatorMgr.list().find(x => x.id === b.dataset.slVis); if (!inst) return; const visible = !(inst.style && inst.style.visible === false); if (typeof tile.indicatorMgr.setVisible === "function") tile.indicatorMgr.setVisible(inst.id, !visible); else tile.indicatorMgr.updateStyle(inst.id, { visible:!visible }); this._saveWorkspaceState(); this._renderIndicatorsInto(container); });
    container.querySelectorAll("[data-sl-set]").forEach(b => b.onclick = () => { const panel = container.querySelector(`[data-sl-settings="${b.dataset.slSet}"]`); panel.classList.toggle("hidden"); if (!panel.classList.contains("hidden")) this._renderIndicatorSettings(panel, tile, b.dataset.slSet); });
  };

  function mobileCSS() {
    if (document.getElementById("sl-pro-terminal-v2")) return;
    const style = document.createElement("style"); style.id = "sl-pro-terminal-v2";
    const candleIconURI = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9ca8bd" stroke-width="1.6" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="21"/><rect x="5.3" y="8" width="5.4" height="7" rx="1"/><line x1="17" y1="6" x2="17" y2="18"/><rect x="14.3" y="9" width="5.4" height="6" rx="1"/></svg>');
    style.textContent = `
      :root{--sl-nav:58px}#chartsRoot .sl-market-head,#chartsRoot .sl-chart-controls{display:none}
      #chartsRoot .sl-draw-group,#chartsRoot .sl-rail-action{position:relative;width:40px;height:44px;min-height:44px;border:0;border-radius:7px;background:transparent;color:#9ca8bd;display:grid;place-items:center;padding:0;touch-action:manipulation}#chartsRoot .sl-draw-group.active,#chartsRoot .sl-rail-action.active{color:#8e9bff;background:#7c8cff2e;box-shadow:inset 0 0 0 1px #7c8cffb8}#chartsRoot .sl-draw-group svg,#chartsRoot .sl-rail-action svg,#chartsRoot .sl-panel-close svg,#chartsRoot .sl-ind-item svg,#chartsRoot .sl-active-row svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}#chartsRoot .sl-draw-group i{position:absolute;right:3px;bottom:3px;width:5px;height:5px;border-right:1px solid;border-bottom:1px solid;opacity:.55}#chartsRoot .sl-magnet-badge{position:absolute;right:2px;bottom:2px;min-width:9px;font-size:8px;font-weight:800;font-style:normal;line-height:1;color:#8e9bff}.sl-rail-sep{width:26px;height:1px;background:#ffffff18;margin:3px}.sl-draw-picker{position:absolute;z-index:800;left:44px;top:4px;width:270px;max-height:65dvh;overflow:auto;padding:7px;border:1px solid #96a0b433;border-radius:10px;background:#111725;box-shadow:0 20px 60px #0009}.sl-draw-picker.hidden{display:none}.sl-draw-picker strong{display:block;padding:6px;color:#8995aa;font-size:11px}.sl-draw-picker button{display:block;width:100%;min-height:44px;padding:8px;border:0;border-radius:7px;background:transparent;color:#e8edf8;text-align:left}.sl-draw-picker button:disabled{opacity:.35;pointer-events:none}
      @media ${PHONE}{html.sl-chart-phone body.charts-active{overflow:hidden;background:#080c14}html.sl-chart-phone body.charts-active .hero,html.sl-chart-phone body.charts-active .ticker-tape,html.sl-chart-phone body.charts-active .site-footer,html.sl-chart-phone body.charts-active .app-primary-tabs{display:none!important}html.sl-chart-phone body.charts-active .shell{width:100%;max-width:none;height:100dvh;margin:0;padding:max(0px,env(safe-area-inset-top)) 0 calc(var(--sl-nav) + env(safe-area-inset-bottom));display:flex;flex-direction:column}html.sl-chart-phone body.charts-active #tab-charts{flex:1;min-height:0;padding:0 max(0px,env(safe-area-inset-right)) 0 max(0px,env(safe-area-inset-left));overflow:hidden}html.sl-chart-phone body.charts-active #chartsRoot{height:100%;min-height:0;display:flex;flex-direction:column;background:#080c14;overflow:hidden}html.sl-chart-phone body.charts-active #caToolbar{flex:0 0 48px;min-height:48px;padding:2px 3px;border:0;border-bottom:1px solid #ffffff18;border-radius:0;background:#0a0f19;overflow:hidden}html.sl-chart-phone body.charts-active #gtScroll{min-width:0;gap:2px;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;scrollbar-width:none}html.sl-chart-phone body.charts-active #gtScroll::-webkit-scrollbar{display:none}html.sl-chart-phone body.charts-active #gtName,html.sl-chart-phone body.charts-active #gtPrice,html.sl-chart-phone body.charts-active #gtChange,html.sl-chart-phone body.charts-active #gtTemplatesMenu,html.sl-chart-phone body.charts-active #gtAlertsMenu,html.sl-chart-phone body.charts-active #gtReplayBtn,html.sl-chart-phone body.charts-active #caUndoBtn,html.sl-chart-phone body.charts-active #caRedoBtn,html.sl-chart-phone body.charts-active #gtLayoutMenu,html.sl-chart-phone body.charts-active #gtSaveBtn,html.sl-chart-phone body.charts-active #gtSettingsBtn,html.sl-chart-phone body.charts-active #caSnapshotBtn,html.sl-chart-phone body.charts-active #caFullscreenBtn,html.sl-chart-phone body.charts-active #gtCollapseBottomBtn,html.sl-chart-phone body.charts-active #gtCollapseRightBtn{display:none!important}html.sl-chart-phone body.charts-active #gtTicker{flex:1 1 90px;min-width:72px;max-width:110px;height:44px}html.sl-chart-phone body.charts-active #gtTimeframe{display:none!important}html.sl-chart-phone body.charts-active #slTvMenuBtn,html.sl-chart-phone body.charts-active #slTvTemplatesBtn,html.sl-chart-phone body.charts-active #slTvAlertsBtn{display:flex!important;flex:0 0 32px!important;width:32px!important;min-width:32px!important;height:44px;align-items:center;justify-content:center;padding:0}html.sl-chart-phone body.charts-active .sl-tv-interval-menu{display:flex!important;flex:0 0 auto!important;position:relative}html.sl-chart-phone body.charts-active #slTvIntervalBtn{display:flex!important;height:44px;min-width:32px;padding:0 7px;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#c3ccdd;background:transparent;border:0;border-radius:7px}html.sl-chart-phone body.charts-active #slTvIntervalBtn:active{background:#7c8cff2e;color:#8e9bff}html.sl-chart-phone body.charts-active #gtChartType{display:block!important;flex:0 0 32px!important;width:32px!important;min-width:32px!important;height:44px;padding:0;border:0;background:transparent url('${candleIconURI}') no-repeat center/18px 18px;color:transparent;text-indent:-9999px;-webkit-appearance:none;appearance:none}html.sl-chart-phone body.charts-active .gt-scroll .icon-btn,html.sl-chart-phone body.charts-active .gt-scroll .gt-btn{width:auto!important;min-width:0!important}html.sl-chart-phone body.charts-active .sl-draw-picker{position:fixed!important;z-index:790!important;left:max(6px,env(safe-area-inset-left))!important;right:max(6px,env(safe-area-inset-right))!important;top:auto!important;bottom:calc(var(--sl-nav) + max(6px,env(safe-area-inset-bottom)))!important;width:auto!important;max-width:none!important;max-height:min(72dvh,620px)!important;overflow:auto!important;border-radius:16px 16px 10px 10px!important;background:#0d1320!important}html.sl-chart-phone body.charts-active #gtIndicatorsMenu{display:block!important;flex:1 1 125px;min-width:105px}html.sl-chart-phone body.charts-active #gtIndicatorsBtn{display:flex!important;width:100%!important;min-width:0!important;height:44px;min-height:44px;justify-content:center}html.sl-chart-phone body.charts-active #chartsRoot #gtIndicatorsBtn .gt-btn-label{display:inline!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}html.sl-chart-phone body.charts-active #gtMoreMenu{display:block!important;flex:0 0 44px;margin-left:0}html.sl-chart-phone body.charts-active #gtMoreBtn{width:44px;height:44px;min-width:44px}html.sl-chart-phone body.charts-active #caWorkspace{flex:1;min-height:0;gap:0;overflow:hidden}html.sl-chart-phone body.charts-active #caTools.tv-rail{flex:0 0 44px;width:44px;min-width:44px;max-width:44px;padding:1px 2px;gap:0;overflow-y:auto;overflow-x:hidden;border-right:1px solid #ffffff18;background:#090e18;scrollbar-width:none}html.sl-chart-phone body.charts-active #caCenter{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}html.sl-chart-phone body.charts-active .ca-chart-col,html.sl-chart-phone body.charts-active .ca-tile-grid,html.sl-chart-phone body.charts-active .ca-tile{flex:1;min-height:0!important;height:auto}html.sl-chart-phone body.charts-active .ca-tile-grid{display:block!important;height:100%}html.sl-chart-phone body.charts-active .ca-tile-grid>.ca-tile{display:none!important;height:100%}html.sl-chart-phone body.charts-active .ca-tile-grid>.ca-tile.active{display:flex!important}html.sl-chart-phone body.charts-active .ca-tile-header{display:none!important}html.sl-chart-phone body.charts-active .ca-tile-chart-host{position:relative;height:100%;min-height:0;border:0;border-radius:0;background:#080c14}.sl-market-head{display:block!important;position:absolute;z-index:30;top:7px;left:8px;max-width:72%;pointer-events:none;color:#eaf0fa;text-shadow:0 1px 2px #000}.sl-market-head>b{font-size:13px}.sl-market-head>span{font-size:10px;color:#8d99ae}.sl-market-head>div{margin-top:3px}.sl-market-head strong{font-size:17px}.sl-market-head em{font-size:10px;font-style:normal}.sl-market-head section{display:flex;gap:4px;margin-top:5px}.sl-market-head i{min-width:72px;padding:3px 6px;border:1px solid;border-radius:5px;background:#080c14cc;font-style:normal;font-size:10px}.sl-market-head i small{display:block;font-size:7px}.sl-market-head .sell{color:#ff7081}.sl-market-head .buy{color:#4dd4ac}.sl-market-head>small{display:block;margin-top:4px;color:#8793aa;font-size:9px}.sl-chart-controls{display:flex!important;flex:0 0 38px;align-items:stretch;border-top:1px solid #ffffff18;background:#090e18}.sl-chart-controls>*{min-width:0;height:38px;border:0;border-right:1px solid #ffffff12;background:transparent;color:#8e9aaf;font-size:9.5px;display:flex;align-items:center;justify-content:center;padding:0 10px}.sl-chart-controls>[data-sl-range]{flex:1 1 auto;justify-content:flex-start}.sl-chart-controls-sep{align-self:center;flex:0 0 1px;height:20px;border-right:0;background:#ffffff1f;padding:0}.sl-chart-controls-clock{flex:0 0 auto;padding:0 8px;font-variant-numeric:tabular-nums;white-space:nowrap}.ca-bottom:not(.collapsed){position:fixed!important;z-index:795!important;left:max(6px,env(safe-area-inset-left))!important;right:max(6px,env(safe-area-inset-right))!important;bottom:calc(var(--sl-nav) + max(6px,env(safe-area-inset-bottom)))!important;width:auto!important;height:auto!important;max-height:70dvh!important;border-radius:16px!important;background:#0d1320!important}.sl-panel-close{position:absolute;right:4px;top:3px;width:44px;height:44px;border:0;background:transparent;color:#a0abbd}.sl-ind-top{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}.sl-ind-top span{color:#7f8ba0;font-size:11px}.sl-ind-search{width:100%;min-height:44px;border:1px solid #ffffff1f;border-radius:9px;background:#090e18;color:#eef2fa;padding:0 10px}.sl-ind-tabs{display:flex;gap:4px;margin:7px 0}.sl-ind-tabs button{flex:1;min-height:40px;border:0;border-radius:7px;background:transparent;color:#8793aa}.sl-ind-tabs .active{background:#7c8cff22;color:#dce2f5}.sl-active-row{display:grid;grid-template-columns:minmax(0,1fr) 42px 42px 42px;align-items:center;min-height:46px;border-bottom:1px solid #ffffff10}.sl-active-row>button{height:42px;border:0;background:transparent;color:#9aa6ba}.sl-inline-settings{grid-column:1/-1;padding:8px}.sl-inline-settings.hidden{display:none}.sl-ind-cat h5{margin:12px 4px 5px;color:#748096;font-size:10px}.sl-ind-item{display:grid;grid-template-columns:minmax(0,1fr) 44px;align-items:center;min-height:50px;border-bottom:1px solid #ffffff0c}.sl-ind-item span{display:flex;flex-direction:column;min-width:0}.sl-ind-item small{color:#778399;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sl-ind-item button{width:44px;height:44px;border:0;background:transparent;color:#9ca7ff}.mobile-bottom-nav{display:flex!important;position:fixed!important;z-index:830!important;left:0;right:0;bottom:0;margin:0!important;padding:3px max(3px,env(safe-area-inset-right)) max(3px,env(safe-area-inset-bottom)) max(3px,env(safe-area-inset-left))!important;border-top:1px solid #ffffff18!important;background:#0a0f19fa!important}.mobile-bottom-nav .tab{flex:1;min-width:0;min-height:52px!important;padding:3px 1px!important;border:0!important;background:transparent!important;color:#677389!important}.mobile-bottom-nav .tab.active{color:#9ca7ff!important;background:#7c8cff18!important}#chartsRoot.is-fullscreen,#chartsRoot:fullscreen{position:fixed!important;z-index:900;inset:0;width:100vw;height:100dvh;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);background:#080c14}body.sl-chart-fs .mobile-bottom-nav{display:none!important}.ca-modal-backdrop{align-items:stretch;padding:max(6px,env(safe-area-inset-top)) max(6px,env(safe-area-inset-right)) max(6px,env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-left))}.ca-settings-modal{width:100%;max-width:none;max-height:100%;margin:0;border-radius:14px;overflow:auto}}
      @media(max-width:980px) and (max-height:520px){:root{--sl-nav:52px}.mobile-bottom-nav .tab{min-height:46px!important}.mobile-bottom-nav .tab span{display:none}.sl-chart-controls{flex-basis:32px}.sl-chart-controls>*{height:32px}.sl-chart-controls-sep{height:16px}}
    `; document.head.appendChild(style);
  }

  function compactTickerLabels() {
    const select = Page.root?.querySelector("#gtTicker"); if (!select) return;
    [...select.options].forEach(option => { if (!option.dataset.slFullLabel) option.dataset.slFullLabel = option.textContent || option.value; option.textContent = phone() ? option.value : option.dataset.slFullLabel; });
  }

  /** Real TradingView's symbol pill opens a rich search overlay, not an OS
   * picker wheel - and this app already has that overlay (the watchlist
   * drawer, with prices/search/favorites), just never wired to the primary
   * symbol control on phone. #gtTicker stays a native <select> (desktop
   * mouse users get the OS dropdown, and it's still the source of truth
   * _commandSelectTicker reads from), but on phone its tap is intercepted
   * before the native picker opens and redirected to the drawer instead. */
  function wireTickerTap() {
    const select = Page.root?.querySelector("#gtTicker"); if (!select || select.dataset.slTapWired) return;
    select.dataset.slTapWired = "1";
    const openDrawer = () => { Page.watchlist?.openMobileDrawer(); requestAnimationFrame(() => Page.watchlist?.setActive(Page.activeTile?.symbol)); };
    select.addEventListener("touchstart", (event) => { if (!phone()) return; event.preventDefault(); select.blur(); openDrawer(); }, { passive:false });
    select.addEventListener("mousedown", (event) => { if (!phone()) return; event.preventDefault(); openDrawer(); });
  }
  /* Real TradingView's top bar also has a menu hamburger and three icons
   * (compare/add-symbol, an unlabeled circle-plus, and a bare-letter pill)
   * ahead of the chart-type/indicators icons. The two with a real
   * equivalent feature here (Шаблоны, Оповещения) proxy-click the existing
   * hidden desktop buttons - reusing their already-relocated popovers
   * (relocatePopovers below / chart-editor-terminal-compat.js) instead of
   * duplicating that plumbing - and the menu icon proxies to the existing
   * "Ещё" button, the closest thing to a catch-all drawer this page has.
   *
   * The bare-letter pill ("Д" in the reference screenshot) is NOT a fourth
   * decorative icon: it's TradingView's own current-interval readout - "Д"
   * is Russian-localized "День" (Daily), which is exactly what the
   * reference chart was on (its two visible month ticks, "Июль"/"Авг",
   * only make sense for daily bars). A previous pass here misread it as an
   * unidentifiable glyph, rendered it as an inert aria-hidden span
   * (pointer-events:none, no click handler - a dead button, the exact
   * anti-pattern this project's spec calls out by name) and, in the very
   * next commit, went further and hid the *real* working interval control
   * (#gtTimeframe) from the row entirely on the theory that TradingView's
   * row has "no separate interval pill". It does - this glyph *is* that
   * pill. Fixed by making it a real, TradingView-labelled interval button
   * (compactTf() below matches TV's own abbreviation scheme: bare number
   * under an hour, "Nч" for hours, Д/Н/М for day/week/month) that opens a
   * dedicated interval popover anchored right here, exactly where
   * TradingView's own tap target lives - not buried three taps deep in
   * "...". */
  const INTERVAL_COMPACT = { "1m": "1", "3m": "3", "5m": "5", "10m": "10", "15m": "15", "30m": "30", "1h": "1ч", "2h": "2ч", "4h": "4ч", "1d": "Д", "1w": "Н", "1mo": "М" };
  function compactTf(id) { return INTERVAL_COMPACT[id] || id; }
  function syncIntervalLabel() {
    const btn = Page.root && Page.root.querySelector("#slTvIntervalBtn");
    const tile = Page.activeTile;
    if (btn && tile) btn.textContent = compactTf(tile.timeframe);
  }
  function renderIntervalPopover(pop) {
    const tile = Page.activeTile;
    if (!tile) return;
    pop.innerHTML = `<div class="ca-more-heading">Таймфрейм</div><div class="ca-range-presets">${tile.listTimeframes().map((t) => `<button type="button" class="range-preset ${t.id === tile.timeframe ? "active" : ""}" data-sl-interval="${esc(t.id)}">${esc(t.label)}</button>`).join("")}</div>`;
    pop.querySelectorAll("[data-sl-interval]").forEach((b) => (b.onclick = () => {
      pop.classList.add("hidden");
      Page._commandSetTimeframe(b.dataset.slInterval);
      syncIntervalLabel();
    }));
  }
  function buildTopbarExtras() {
    if (!Page.root) return;
    const scroll = Page.root.querySelector("#gtScroll");
    const tf = Page.root.querySelector("#gtTimeframe");
    if (!scroll || !tf || scroll.dataset.slTvExtras) return;
    scroll.dataset.slTvExtras = "1";
    scroll.insertAdjacentHTML("afterbegin", `<button class="icon-btn sl-tv-menu" id="slTvMenuBtn" type="button" title="Меню" aria-label="Меню">${icon("hamburger")}</button>`);
    tf.insertAdjacentHTML("afterend", `<button class="icon-btn" id="slTvTemplatesBtn" type="button" title="Шаблоны" aria-label="Шаблоны">${icon("shieldPlus")}</button><button class="icon-btn" id="slTvAlertsBtn" type="button" title="Оповещения" aria-label="Оповещения">${icon("circlePlus")}</button><div class="gt-menu sl-tv-interval-menu"><button class="icon-btn sl-tv-interval" id="slTvIntervalBtn" type="button" title="Таймфрейм" aria-label="Таймфрейм" aria-haspopup="true">${esc(compactTf(tf.value))}</button><div class="ca-popover hidden" id="slTvIntervalPop"></div></div>`);
    // stopPropagation matters here: without it, the *real* click still
    // bubbles to document after the proxied one - _wireGlobalPopover's own
    // outside-click-closes listener (chart-analysis.js) then sees a target
    // that isn't the real button and immediately re-hides the popover it
    // just opened.
    const proxyClick = (proxyId, realId) => { const btn = Page.root.querySelector(`#${proxyId}`); if (btn) btn.onclick = (e) => { e.stopPropagation(); Page.root.querySelector(`#${realId}`)?.click(); }; };
    proxyClick("slTvMenuBtn", "gtMoreBtn");
    proxyClick("slTvTemplatesBtn", "gtTemplatesBtn");
    proxyClick("slTvAlertsBtn", "gtAlertBtn");
    const intervalBtn = Page.root.querySelector("#slTvIntervalBtn");
    const intervalPop = Page.root.querySelector("#slTvIntervalPop");
    if (intervalBtn && intervalPop) Page._wireGlobalPopover(intervalBtn, intervalPop, () => renderIntervalPopover(intervalPop));
  }
  function relocatePopovers() {
    if (!Page.root) return;
    for (const id of ["gtAlertsPop", "gtTemplatesPop", "slTvIntervalPop"]) { const pop = Page.root.querySelector(`#${id}`); if (pop && pop.parentElement !== Page.root) Page.root.appendChild(pop); }
  }
  let lastPhone = null;
  function sync() {
    const isPhone = phone(); document.documentElement.classList.toggle("sl-chart-phone", isPhone); if (!Page.root) return;
    if (isPhone && lastPhone !== true && Page._bottomCollapsed !== true) Page._setBottomCollapsed(true, { skipSave:true });
    lastPhone = isPhone; buildRail(); refreshRail(); buildBottomControls(); closeButton(); compactTickerLabels(); wireTickerTap(); buildTopbarExtras(); relocatePopovers(); renderMarketHeader(); syncIntervalLabel();
    Page.tiles.forEach(tile => tile.core?._onResize());
  }

  const oldBuild = Page._build;
  Page._build = function () { const result = oldBuild.apply(this, arguments); requestAnimationFrame(sync); return result; };
  const oldHeader = Page._refreshGlobalHeader;
  Page._refreshGlobalHeader = function () { const result = oldHeader.apply(this, arguments); compactTickerLabels(); renderMarketHeader(); syncIntervalLabel(); return result; };
  const oldTicker = Page._renderTickerOptions;
  Page._renderTickerOptions = function () { const result = oldTicker.apply(this, arguments); compactTickerLabels(); return result; };
  const oldActive = Page._setActiveTile;
  Page._setActiveTile = function () { const result = oldActive.apply(this, arguments); requestAnimationFrame(() => { buildRail(); refreshRail(); renderMarketHeader(); syncIntervalLabel(); }); return result; };
  const oldFullscreen = Page._onFullscreenChange;
  Page._onFullscreenChange = function (active) { const result = oldFullscreen.apply(this, arguments); document.body.classList.toggle("sl-chart-fs", !!active); requestAnimationFrame(sync); return result; };
  const viewport = document.querySelector('meta[name="viewport"]'); if (viewport && !/viewport-fit\s*=\s*cover/i.test(viewport.content)) viewport.content += ",viewport-fit=cover";
  mobileCSS(); g.addEventListener("resize", () => requestAnimationFrame(sync), { passive:true }); g.addEventListener("orientationchange", () => requestAnimationFrame(sync), { passive:true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync, { once:true }); else sync();
  g.StrategyLabMobileChart = { refresh:sync, refreshRail, indicatorCount:() => I ? I.registry.length : 0 };
})(window);
