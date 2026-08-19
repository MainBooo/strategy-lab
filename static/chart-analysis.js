/* MarketAnalysisChartAdapter: the free-form "Анализ графиков" page.
 * Candles come from the generic /api/candles endpoint (real MOEX data,
 * downloaded on demand and cached server-side - see candle_api.py).
 * Drawings/layouts are persisted per-object through /api/chart-layouts
 * and /api/chart-drawings (see charts_db.py) with a debounced autosave;
 * this file never keeps drawing state only in localStorage.
 *
 * The page is a workspace of one or more independent chart tiles
 * (ChartEngine.ChartTile, chart-engine/chart-tile.js) laid out in a grid.
 * As of the Stage-2/3 toolbar unification, this file owns ONE single-row
 * top toolbar (ticker/name/price/change/interval/type/indicators/
 * templates/alerts/replay/undo/redo/layout/save/settings/snapshot/
 * fullscreen/collapse-bottom/collapse-right/overflow) whose every command
 * acts on whichever tile is *active* - plus the drawing tool palette,
 * properties/objects side panel, watchlist sidebar, optional cross-tile
 * sync, and workspace fullscreen. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;

  // Line-icon set for the top toolbar (Stage-2 unified bar) - swapped in for
  // the emoji glyphs the toolbar shipped with, which read as a mismatched,
  // dated accent against the rest of the app's monochrome stroke-icon
  // language (see the mobile bottom nav in index.html for the same style).
  // Deliberately NOT touching TOOL_BUTTONS below (the drawing-tool rail) -
  // those are already plain technical symbols (╱ — ↗ …), not colorful
  // emoji, and rendered through a different path (_buildToolRail) than the
  // toolbar HTML this is inlined into. Each icon is intentionally tiny
  // (16x16, 2px stroke) so it reads at a glance next to a text label
  // without the button growing past its existing 32px box. data-icon
  // attributes elsewhere in the toolbar (used only as a plain-text prefix
  // in the collapsed "Ещё" popover list, see _renderMorePopover) are left
  // as their original emoji on purpose - that's a compact text list, not a
  // real icon slot, and mixing markup into dataset strings there would be
  // a bigger, riskier change for a place these icons barely register.
  const ICN = {
    chart: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    rewind: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M19 5v14L8 12l11-7z"/><line x1="5" y1="5" x2="5" y2="19"/></svg>',
    grid: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    save: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.63 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 0 1 4 0v.09A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"/></svg>',
    camera: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8a2 2 0 0 1 2-2h1l1.5-2h7L17 6h1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/><circle cx="12" cy="13" r="3.4"/></svg>',
    expand: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    panelRight: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>'
  };

  const TOOL_BUTTONS = [
    { id: null, label: "Курсор", icon: "⇖" },
    { id: "trend_line", label: "Линия тренда", icon: "╱" },
    { id: "horizontal_line", label: "Горизонтальная линия", icon: "—" },
    { id: "horizontal_ray", label: "Горизонтальный луч", icon: "―→" },
    { id: "vertical_line", label: "Вертикальная линия", icon: "❘" },
    { id: "ray", label: "Луч", icon: "↗" },
    { id: "extended_line", label: "Расширенная линия", icon: "⟷" },
    { id: "parallel_channel", label: "Параллельный канал", icon: "═" },
    { id: "rectangle", label: "Прямоугольник", icon: "▭" },
    { id: "circle", label: "Эллипс", icon: "◯" },
    { id: "polyline", label: "Полилиния (Enter/двойной клик — завершить)", icon: "⌁" },
    { id: "text", label: "Текст", icon: "T" },
    { id: "note", label: "Заметка", icon: "🗨" },
    { id: "measure", label: "Измерение (временное, потяните — исчезает при отпускании)", icon: "📏" },
    { id: "price_range", label: "Диапазон цены", icon: "↕" },
    { id: "time_range", label: "Диапазон времени", icon: "↔" },
    { id: "long_position", label: "Long позиция", icon: "↑" },
    { id: "short_position", label: "Short позиция", icon: "↓" },
    { id: "fib_retracement", label: "Коррекция Фибоначчи", icon: "F" },
    { id: "fib_extension", label: "Расширение Фибоначчи", icon: "Fx" },
    { id: "pitchfork", label: "Вилы Эндрюса", icon: "⑂" },
    { id: "pitchfork_schiff", label: "Вилы Шиффа", icon: "⑃" },
    { id: "pitchfork_modified_schiff", label: "Модифицированные вилы Шиффа", icon: "⑄" },
    { id: "gann_fan", label: "Веер Ганна", icon: "⋔" },
    { id: "xabcd_pattern", label: "Паттерн XABCD (X-A-B-C-D)", icon: "◬" },
    { id: "abcd_pattern", label: "Паттерн ABCD (A-B-C-D)", icon: "◭" },
    { id: "triangle_pattern", label: "Паттерн треугольник", icon: "◺" },
    { id: "three_drives_pattern", label: "Паттерн «Три драйва»", icon: "◮" },
    { id: "head_shoulders_pattern", label: "Паттерн «Голова и плечи»", icon: "⛰" },
    { id: "elliott_impulse_wave", label: "Волна Эллиотта (импульс)", icon: "⚡" },
    { id: "elliott_correction_wave", label: "Волна Эллиотта (коррекция)", icon: "↝" },
    { id: "cyclic_lines", label: "Циклические линии", icon: "❘❘❘" },
    { id: "sine_line", label: "Синусоида", icon: "∿" },
    { id: "anchored_vwap", label: "Привязанный VWAP", icon: "V" },
    { id: "rotated_rectangle", label: "Повёрнутый прямоугольник", icon: "▱" },
    { id: "arrow", label: "Стрелка", icon: "↗" },
    { id: "arrow_mark_up", label: "Стрелка вверх", icon: "↑" },
    { id: "arrow_mark_down", label: "Стрелка вниз", icon: "↓" },
    { id: "arrow_mark_left", label: "Стрелка влево", icon: "←" },
    { id: "arrow_mark_right", label: "Стрелка вправо", icon: "→" },
    { id: "highlighter", label: "Маркер", icon: "▮" },
  ];

  const LAYOUTS = [
    { id: "1", label: "Один график", rows: 1, cols: 1 },
    { id: "2v", label: "Два графика вертикально", rows: 2, cols: 1 },
    { id: "2h", label: "Два графика горизонтально", rows: 1, cols: 2 },
    { id: "3", label: "Три графика: один большой слева", asym: "left" },
    { id: "3b", label: "Три графика: один большой справа", asym: "right" },
    { id: "4", label: "Четыре графика", rows: 2, cols: 2 },
    { id: "6", label: "Шесть графиков", rows: 2, cols: 3 },
  ];
  const LAYOUT_TILE_COUNT = { "1": 1, "2v": 2, "2h": 2, "3": 3, "3b": 3, "4": 4, "6": 6 };
  const COUNT_TO_LAYOUT = { 1: "1", 2: "2h", 3: "3", 4: "4", 5: "6", 6: "6" };

  const SYNC_LABELS = { ticker: "Тикеры", interval: "Интервалы", crosshair: "Перекрестие", scroll: "Прокрутка (позиция)", zoom: "Масштаб (ширина свечей)", range: "Диапазон отображения" };
  const MAGNET_LABELS = { off: "выкл", weak: "слабый", strong: "сильный" };

  const IND_PARAM_LABELS = { period: "Период", mult: "Множитель", fast: "Быстрая", slow: "Медленная", signal: "Сигнальная", kPeriod: "%K период", dPeriod: "%D период" };
  const IND_LINE_LABELS = {
    bollinger: ["Верхняя", "Средняя", "Нижняя"],
    donchian: ["Верхняя", "Нижняя"],
    macd: ["MACD", "Гистограмма", "Сигнальная"],
    stochastic: ["%K", "%D"],
  };

  /* Ascending order = collapses first into the "Ещё" overflow menu when the
   * toolbar doesn't fit its own width - see _recalcToolbarOverflow(). Core
   * identity (ticker/name/price/change/interval/type), the layout picker,
   * fullscreen and the overflow button itself are never collapsible. */
  const TOOLBAR_META = {
    collapseRight: { label: "Список инструментов", icon: "▤", priority: 1 },
    collapseBottom: { label: "Панель свойств", icon: "︿", priority: 2 },
    save: { label: "Сохранить шаблон", icon: "💾", priority: 3 },
    settings: { label: "Настройки графика", icon: "⚙", priority: 4 },
    snapshot: { label: "Снимок графика", icon: "📷", priority: 5 },
    replay: { label: "Market Replay", icon: "⏮", priority: 6 },
    redo: { label: "Повторить", icon: "↷", priority: 7 },
    undo: { label: "Отменить", icon: "↶", priority: 8 },
    alerts: { label: "Оповещения", icon: "🔔", priority: 9 },
    templates: { label: "Шаблоны", icon: "🗂", priority: 10 },
    indicators: { label: "Индикаторы", icon: "📈", priority: 11 },
  };

  const WORKSPACE_STATE_KEY = "moexlab_chart_workspace";
  const WORKSPACE_TEMPLATES_KEY = "moexlab_workspace_templates";
  const BOTTOM_HEIGHT_KEY = "moexlab_ca_bottom_height";
  const BOTTOM_COLLAPSED_KEY = "moexlab_ca_bottom_collapsed";
  const WATCHLIST_WIDTH_KEY = "moexlab_ca_watchlist_width";
  const BOTTOM_HEIGHT_DEFAULT = 220, BOTTOM_HEIGHT_MIN = 120, BOTTOM_HEIGHT_MAX = 560;
  const WATCHLIST_WIDTH_DEFAULT = 280, WATCHLIST_WIDTH_MIN = 220, WATCHLIST_WIDTH_MAX = 480;

  /** Mini schematic shown on each layout thumbnail: a uniform rows×cols grid
   * of cells for the symmetric layouts, or a hand-built 1-big+2-small shape
   * (mirrored via CSS row-reverse for "3b") for the asymmetric ones -
   * grid-template's repeat() can't express that asymmetry. */
  function layoutIcon(l) {
    if (l.asym === "left") {
      return `<span class="ca-layout-icon ca-layout-icon-3"><i class="ca-li-big"></i><span class="ca-li-col"><i></i><i></i></span></span>`;
    }
    if (l.asym === "right") {
      return `<span class="ca-layout-icon ca-layout-icon-3 ca-layout-icon-3-rev"><i class="ca-li-big"></i><span class="ca-li-col"><i></i><i></i></span></span>`;
    }
    return `<span class="ca-layout-icon" style="grid-template-columns:repeat(${l.cols},1fr);grid-template-rows:repeat(${l.rows},1fr)">
      ${Array.from({ length: l.rows * l.cols }).map(() => "<i></i>").join("")}
    </span>`;
  }

  function fmtPrice(n) {
    // A fixed 2-decimal cap rounds sub-cent Binance instruments (SHIB, PEPE,
    // ...) to "0.00" everywhere this feeds the price readout/coordinate
    // panel/alerts - scale precision to magnitude instead.
    if (n == null) return "—";
    const v = Number(n);
    const digits = Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 4 : 8;
    return v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: digits });
  }
  /** Coordinate-panel time display for a drawing's anchor point - same
   * UTC formatting as the chart's own axis (see theme.js's formatTime),
   * so this shows the same wall-clock hour as the chart. */
  function fmtCoordTime(t) {
    if (t == null) return "—";
    return CE.formatTime(t);
  }
  function toHex(color) {
    if (!color || color[0] === "#") return color || "#7c8cff";
    const m = color.match(/rgba?\((\d+),(\d+),(\d+)/);
    if (!m) return "#7c8cff";
    return "#" + m.slice(1, 4).map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  const Page = {
    root: null,
    securities: [],
    tiles: [],
    activeTileId: null,
    layoutMode: "1",
    // Every sync channel independently OFF by default - a fresh workspace
    // (and any workspace migrating from the old single syncEnabled toggle,
    // see _restoreWorkspaceState below) always starts with fully
    // independent tiles; the user must explicitly opt each one in via the
    // "Синхронизация графиков" menu. scroll/zoom are deliberately separate
    // keys (not one bundled "timescale") per spec: panning one tile must
    // never imply anything about zoom sync, and vice versa.
    syncFlags: { ticker: false, interval: false, crosshair: false, scroll: false, zoom: false, range: false },
    _archivedTiles: [],
    _built: false,

    get activeTile() {
      return this.tiles.find((t) => t.id === this.activeTileId) || this.tiles[0] || null;
    },
    // Kept for the drawing toolbar / side panel below, which act on
    // whichever tile is active.
    get core() { return this.activeTile ? this.activeTile.core : null; },
    get indicatorMgr() { return this.activeTile ? this.activeTile.indicatorMgr : null; },
    get drawingMgr() { return this.activeTile ? this.activeTile.drawingMgr : null; },

    init(root) {
      this.root = root;
      if (!this._built) {
        this._built = true;
        if (!this._restoreWorkspaceState()) {
          const tile = new CE.ChartTile({});
          this.tiles = [tile];
          this.activeTileId = tile.id;
          this.layoutMode = "1";
        }
        this._build();
        this._syncTileGrid();
        this._loadSecurities();
        if (global.AlertService) global.AlertService.onTriggered(() => this._refreshAlertBadge());
      }
      this.tiles.forEach((t) => t.startRealtime());
    },

    onTabLeave() {
      this.tiles.forEach((t) => t.stopRealtime());
    },

    async _loadSecurities() {
      try {
        this.securities = await global.fetchSecuritiesShared();
        this.tiles.forEach((t) => t.setSecurities(this.securities));
        this._reconcileStaleSymbols();
        this._renderTickerOptions();
      } catch (e) { /* securities catalog is optional here - manual ticker entry still works via prompt fallback */ }
    },

    /** A workspace restored from localStorage (see _restoreWorkspaceState)
     * can still carry a ticker from before the MOEX->Binance migration
     * (e.g. "SBER") that no longer exists in the Binance catalog - such a
     * tile would silently show "Нет данных за выбранный период" forever.
     * Once the real catalog is in, swap any unknown symbol to BTCUSDT (the
     * same default a brand-new tile gets) and persist the correction so it
     * doesn't keep restoring the dead ticker on every visit. */
    _reconcileStaleSymbols() {
      if (!this.securities.length) return;
      const known = new Set(this.securities.map((s) => s.symbol));
      let changed = false;
      this.tiles.forEach((t) => {
        if (!known.has(t.symbol)) {
          t.selectSymbol("BTCUSDT");
          changed = true;
        }
      });
      if (changed) {
        this._refreshGlobalHeader();
        this._saveWorkspaceState();
      }
    },

    _instrumentName(ticker) {
      const s = this.securities.find((x) => x.symbol === ticker);
      return s ? (s.baseAsset || "") : "";
    },

    // ----------------------------------------------------------- build ----

    _build() {
      const tile = this.activeTile;
      this.root.innerHTML = `
        <div class="ca-toolbar ca-toolbar-unified" id="caToolbar">
          <div class="gt-scroll" id="gtScroll">
            <select class="gt-select gt-ticker" id="gtTicker" aria-label="Инструмент"></select>
            <span class="gt-name" id="gtName" data-priority-exempt></span>
            <span class="gt-price" id="gtPrice">—</span>
            <span class="gt-change" id="gtChange"></span>
            <select class="gt-select gt-tf" id="gtTimeframe" aria-label="Таймфрейм">
              ${tile.listTimeframes().map((t) => `<option value="${t.id}">${t.label}</option>`).join("")}
            </select>
            <select class="gt-select gt-type" id="gtChartType" aria-label="Тип графика">
              ${tile.listChartTypes().map((t) => `<option value="${t.id}">${t.label}</option>`).join("")}
            </select>
            <div class="gt-menu" id="gtIndicatorsMenu" data-key="indicators" data-priority="11" data-label="Индикаторы" data-icon="📈">
              <button class="gt-btn" id="gtIndicatorsBtn" aria-haspopup="true" title="Индикаторы" aria-label="Индикаторы">${ICN.chart} <span class="gt-btn-label">Индикаторы</span></button>
              <div class="ca-popover hidden" id="gtIndicatorsPop"></div>
            </div>
            <div class="gt-menu" id="gtTemplatesMenu" data-key="templates" data-priority="10" data-label="Шаблоны" data-icon="🗂">
              <button class="gt-btn" id="gtTemplatesBtn" aria-haspopup="true" title="Шаблоны" aria-label="Шаблоны">${ICN.folder} <span class="gt-btn-label">Шаблоны</span></button>
              <div class="ca-popover ca-popover-wide hidden" id="gtTemplatesPop"></div>
            </div>
            <div class="gt-menu" id="gtAlertsMenu" data-key="alerts" data-priority="9" data-label="Оповещения" data-icon="🔔">
              <button class="gt-btn icon-btn" id="gtAlertBtn" title="Оповещения" aria-label="Оповещения" aria-haspopup="true">${ICN.bell}<span class="gt-badge hidden" id="gtAlertBadge"></span></button>
              <div class="ca-popover ca-popover-wide hidden" id="gtAlertsPop"></div>
            </div>
            <button class="icon-btn" id="gtReplayBtn" data-key="replay" data-priority="6" data-label="Market Replay" data-icon="⏮" title="Market Replay" aria-label="Открыть Market Replay для текущего инструмента">${ICN.rewind}</button>
            <button class="icon-btn" id="caUndoBtn" data-key="undo" data-priority="8" data-label="Отменить" data-icon="↶" title="Отменить (Ctrl+Z)" aria-label="Отменить">↶</button>
            <button class="icon-btn" id="caRedoBtn" data-key="redo" data-priority="7" data-label="Повторить" data-icon="↷" title="Повторить (Ctrl+Shift+Z)" aria-label="Повторить">↷</button>
            <div class="gt-menu" id="gtLayoutMenu" data-priority-exempt>
              <button class="icon-btn" id="gtLayoutBtn" title="Раскладка графиков" aria-label="Выбор раскладки графиков" aria-haspopup="true">${ICN.grid}</button>
              <div class="ca-popover ca-popover-layouts hidden" id="gtLayoutPop"></div>
            </div>
            <button class="icon-btn" id="gtSaveBtn" data-key="save" data-priority="3" data-label="Сохранить шаблон" data-icon="💾" title="Сохранить шаблон" aria-label="Сохранить шаблон">${ICN.save}</button>
            <button class="icon-btn" id="gtSettingsBtn" data-key="settings" data-priority="4" data-label="Настройки графика" data-icon="⚙" title="Настройки графика" aria-label="Настройки графика">${ICN.gear}</button>
            <button class="icon-btn" id="caSnapshotBtn" data-key="snapshot" data-priority="5" data-label="Снимок графика" data-icon="📷" title="Скачать снимок активного графика (PNG)" aria-label="Снимок графика">${ICN.camera}</button>
            <button class="icon-btn" id="caFullscreenBtn" data-priority-exempt title="Полноэкранный режим рабочего пространства" aria-label="Полноэкранный режим рабочего пространства">${ICN.expand}</button>
            <button class="icon-btn" id="gtCollapseBottomBtn" data-key="collapseBottom" data-priority="2" data-label="Свернуть панель свойств" data-icon="︿" title="Свернуть панель свойств" aria-label="Свернуть/развернуть панель свойств и объектов">${ICN.chevronDown}</button>
            <button class="icon-btn" id="gtCollapseRightBtn" data-key="collapseRight" data-priority="1" data-label="Свернуть список инструментов" data-icon="▤" title="Свернуть список инструментов" aria-label="Свернуть/развернуть список инструментов">${ICN.panelRight}</button>
          </div>
          <div class="gt-menu gt-more" id="gtMoreMenu">
            <button class="icon-btn" id="gtMoreBtn" title="Ещё" aria-label="Дополнительные действия" aria-haspopup="true">${ICN.more}</button>
            <div class="ca-popover ca-popover-right ca-popover-wide hidden" id="gtMorePop"></div>
          </div>
        </div>
        <div class="ca-workspace" id="caWorkspace">
          <div class="ca-tools" id="caTools">
            ${TOOL_BUTTONS.map((t) => `<button class="ca-tool-btn ${t.id === null ? "active" : ""}" data-tool="${t.id || ""}" title="${t.label}" aria-label="${t.label}">${t.icon}</button>`).join("")}
            <button class="ca-tool-btn ca-tool-danger" id="caDeleteBtn" title="Удалить объект (Delete)" aria-label="Удалить объект">🗑</button>
          </div>
          <div class="ca-center" id="caCenter">
            <div class="ca-chart-col">
              <div class="ca-tile-grid" id="caTileGrid"></div>
            </div>
            <div class="ca-resize-h" id="caResizeH" title="Изменить высоту панели"></div>
            <div class="ca-bottom" id="caBottom">
              <div class="ca-bottom-head">
                <nav class="ca-side-tabs">
                  <button class="ca-side-tab active" data-side="props">Свойства</button>
                  <button class="ca-side-tab" data-side="objects">Объекты</button>
                </nav>
              </div>
              <div class="ca-bottom-body">
                <div id="caProps" class="ca-side-panel"></div>
                <div id="caObjects" class="ca-side-panel hidden"></div>
              </div>
            </div>
          </div>
          <div class="ca-resize-v" id="caResizeV" title="Изменить ширину списка инструментов"></div>
          <div class="ca-watchlist" id="caWatchlist"></div>
        </div>
        <div class="wl-mobile-backdrop" id="caWatchlistBackdrop"></div>
      `;

      this._wireToolTools();
      this._wireGlobalToolbar();
      this._wireWatchlist();
      this._wireSideTabs();
      this._buildPanelChrome();
      this._wireToolbarOverflow();
      this._syncCollapseRightButton();
      this._bindTimeframeHotkeys();
    },

    /** TradingView-style timeframe hotkeys: type a number (buffered briefly
     * so "1" then "5" within the window reads as 15, not two separate
     * switches to 1 and 5) to jump to that many minutes, or H/D/W for
     * hour/day/week (optionally after a number, e.g. "4" then "H" = 4h).
     * _build() can re-run (layout changes, tab re-entry) but this listener
     * must only ever attach once per page lifetime. */
    _bindTimeframeHotkeys() {
      if (this._tfHotkeysBound) return;
      this._tfHotkeysBound = true;
      const BUFFER_MS = 600;
      let buffer = "";
      let timer = null;
      const clearBuffer = () => { buffer = ""; if (timer) { clearTimeout(timer); timer = null; } };
      const apply = (tf) => {
        const list = this.activeTile ? this.activeTile.listTimeframes() : [];
        if (!list.some((t) => t.id === tf)) return;
        this._commandSetTimeframe(tf);
        const select = this.root && this.root.querySelector("#gtTimeframe");
        if (select) select.value = tf;
      };
      document.addEventListener("keydown", (event) => {
        if (!document.body.classList.contains("charts-active")) return;
        const target = event.target;
        if (target instanceof Element && target.matches("input,textarea,select,[contenteditable],[contenteditable='true']")) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key;
        if (/^[0-9]$/.test(key)) {
          buffer = (buffer + key).slice(-3);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { apply(`${Number(buffer)}m`); clearBuffer(); }, BUFFER_MS);
          return;
        }
        const letter = key.length === 1 ? key.toUpperCase() : "";
        const suffix = { H: "h", D: "d", W: "w", M: "mo" }[letter];
        if (!suffix) return;
        const n = buffer ? Number(buffer) : 1;
        clearBuffer();
        apply(`${n}${suffix}`);
      }, true);
    },

    _wireToolTools() {
      this.root.querySelectorAll(".ca-tool-btn[data-tool]").forEach((b) => {
        b.onclick = () => {
          this.root.querySelectorAll(".ca-tool-btn[data-tool]").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          if (this.drawingMgr) this.drawingMgr.setTool(b.dataset.tool || null);
        };
      });
      this.root.querySelector("#caDeleteBtn").onclick = () => { if (this.drawingMgr && this.drawingMgr.selectedId) this.drawingMgr.removeDrawing(this.drawingMgr.selectedId); };
    },

    _wireSideTabs() {
      this.root.querySelectorAll(".ca-side-tab").forEach((b) => {
        b.onclick = () => {
          this.root.querySelectorAll(".ca-side-tab").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          this.root.querySelector("#caProps").classList.toggle("hidden", b.dataset.side !== "props");
          this.root.querySelector("#caObjects").classList.toggle("hidden", b.dataset.side !== "objects");
        };
      });
    },

    _wireWatchlist() {
      let watchlistCollapsed = false;
      try { watchlistCollapsed = localStorage.getItem("moexlab_watchlist_collapsed") === "1"; } catch (e) { /* ignore */ }
      this.watchlist = new global.WatchlistSidebar(this.root.querySelector("#caWatchlist"), {
        collapsed: watchlistCollapsed,
        onSelect: (ticker) => this._commandSelectTicker(ticker),
        mobileBackdrop: this.root.querySelector("#caWatchlistBackdrop"),
      });
      if (this.activeTile) this.watchlist.setActive(this.activeTile.symbol);
    },

    // ------------------------------------------------- unified toolbar ----

    _wireGlobalToolbar() {
      const $ = (sel) => this.root.querySelector(sel);
      const tile = this.activeTile;

      $("#gtTicker").onchange = (e) => this._commandSelectTicker(e.target.value);
      $("#gtTimeframe").value = tile.timeframe;
      $("#gtTimeframe").onchange = (e) => this._commandSetTimeframe(e.target.value);
      $("#gtChartType").value = tile.core ? tile.core.seriesType : "candles";
      $("#gtChartType").onchange = (e) => { if (this.activeTile) this.activeTile.setChartType(e.target.value); };

      this._wireGlobalPopover($("#gtIndicatorsBtn"), $("#gtIndicatorsPop"), () => this._renderIndicatorsInto($("#gtIndicatorsPop")));
      this._wireGlobalPopover($("#gtTemplatesBtn"), $("#gtTemplatesPop"), () => this._renderTemplatesInto($("#gtTemplatesPop")));
      this._wireGlobalPopover($("#gtAlertBtn"), $("#gtAlertsPop"), () => this._renderAlertsInto($("#gtAlertsPop")));
      this._wireGlobalPopover($("#gtLayoutBtn"), $("#gtLayoutPop"), () => this._renderLayoutPopover());
      this._wireGlobalPopover($("#gtMoreBtn"), $("#gtMorePop"), () => this._renderMorePopover());

      this._toolbarActions = {
        replay: () => this._commandOpenReplay(),
        undo: () => this.drawingMgr && this.drawingMgr.undo(),
        redo: () => this.drawingMgr && this.drawingMgr.redo(),
        save: () => this._commandSaveTemplate(),
        settings: () => this._openSettingsDialog(),
        snapshot: () => this._downloadSnapshot(),
        collapseBottom: () => this._setBottomCollapsed(!this._bottomCollapsed),
        collapseRight: () => {
          // Below 980px the watchlist is a full off-canvas drawer (display:none
          // until opened), not just a narrow column - see chart.css's mobile
          // block - so this button's job is "open the drawer" there instead
          // of "toggle collapsed width".
          if (global.matchMedia && global.matchMedia("(max-width: 980px)").matches) { this.watchlist.openMobileDrawer(); return; }
          this.watchlist.setCollapsed(!this.root.querySelector("#caWatchlist").classList.contains("wl-collapsed"));
          this._syncCollapseRightButton();
        },
        indicators: () => $("#gtIndicatorsBtn").click(),
        templates: () => $("#gtTemplatesBtn").click(),
        alerts: () => $("#gtAlertBtn").click(),
      };
      Object.keys(this._toolbarActions).forEach((key) => {
        const btn = this.root.querySelector(`[data-key="${key}"]`);
        if (btn && btn.tagName === "BUTTON") btn.onclick = this._toolbarActions[key];
      });

      $("#caFullscreenBtn").onclick = () => this._fsCtrl.toggle();
      this._fsCtrl = new CE.Fullscreen.FullscreenController(this.root, {
        className: "is-fullscreen",
        onChange: (active) => this._onFullscreenChange(active),
      });

      this.root.querySelector("#caWatchlistBackdrop").onclick = () => this.watchlist.closeMobileDrawer();

      this._renderTickerOptions();
      this._refreshGlobalHeader();
    },

    _wireGlobalPopover(btn, pop, onOpen) {
      btn.onclick = (e) => {
        e.stopPropagation();
        const willOpen = pop.classList.contains("hidden");
        this.root.querySelectorAll(".ca-popover").forEach((p) => p.classList.add("hidden"));
        if (willOpen) { pop.classList.remove("hidden"); if (onOpen) onOpen(); }
      };
      document.addEventListener("click", (e) => { if (!pop.contains(e.target) && e.target !== btn) pop.classList.add("hidden"); });
    },

    _renderTickerOptions() {
      const sel = this.root.querySelector("#gtTicker");
      if (!sel || !this.securities.length) return;
      const current = this.activeTile ? this.activeTile.symbol : null;
      sel.innerHTML = this.securities.map((s) => `<option value="${s.symbol}">${s.symbol}${s.baseAsset ? " · " + s.baseAsset : ""}</option>`).join("");
      if (current) sel.value = current;
    },

    /** Refreshes the toolbar's ticker/name/price/change/timeframe/chartType
     * display from whichever tile is active - called on activation, symbol/
     * timeframe/chart-type change, and every price tick for the active
     * tile. */
    _refreshGlobalHeader() {
      const tile = this.activeTile;
      const $ = (sel) => this.root.querySelector(sel);
      if (!tile) return;
      const tickerSel = $("#gtTicker");
      if (tickerSel) tickerSel.value = tile.symbol;
      $("#gtName").textContent = this._instrumentName(tile.symbol);
      $("#gtTimeframe").value = tile.timeframe;
      $("#gtChartType").value = tile.core ? tile.core.seriesType : "candles";
      const info = tile._lastPriceInfo;
      $("#gtPrice").textContent = info ? fmtPrice(info.price) : "—";
      const changeEl = $("#gtChange");
      if (info && info.diff != null) {
        changeEl.textContent = `${info.diff >= 0 ? "+" : ""}${fmtPrice(info.diff)} (${info.diff >= 0 ? "+" : ""}${info.pct.toFixed(2)}%)`;
        changeEl.className = `gt-change ${info.diff >= 0 ? "pnl-pos" : "pnl-neg"}`;
      } else {
        changeEl.textContent = "";
        changeEl.className = "gt-change";
      }
    },

    // --------------------------------------------------- toolbar commands --

    _commandSelectTicker(ticker) {
      if (!this.activeTile) return;
      this.activeTile.selectSymbol(ticker);
      if (this.syncFlags.ticker) this.tiles.forEach((t) => { if (t !== this.activeTile) t.selectSymbol(ticker); });
    },

    _commandSetTimeframe(tf) {
      if (!this.activeTile) return;
      this.activeTile.setTimeframe(tf);
      if (this.syncFlags.interval) this.tiles.forEach((t) => { if (t !== this.activeTile) t.setTimeframe(tf); });
    },

    async _commandSaveTemplate() {
      if (!this.activeTile) return;
      await this.activeTile.saveAsTemplate();
    },

    /** Switches to the Market Replay tab and preselects the active tile's
     * ticker in its setup form - Market Replay itself (a separate, already
     * fully-implemented full-screen mode with its own transport panel,
     * speed control, Space-to-play/pause and future-candle blocking - see
     * market-replay.js) stays a distinct workspace from live multi-chart
     * analysis, matching how the rest of the app already separates the two
     * (Stage 10's "нельзя увидеть будущие свечи" is enforced server-side
     * there, not re-implemented here). */
    _commandOpenReplay() {
      const ticker = this.activeTile ? this.activeTile.symbol : null;
      if (global.activateTab) global.activateTab("replay");
      if (ticker) {
        setTimeout(() => {
          const inp = document.getElementById("mrTicker");
          if (inp) inp.value = ticker;
        }, 0);
      }
    },

    // ------------------------------------------------- indicators popover --

    _renderIndicatorsInto(container) {
      const tile = this.activeTile;
      if (!tile) { container.innerHTML = ""; return; }
      const instances = tile.indicatorMgr.list();
      const activeTypes = new Set(instances.map((i) => i.type));
      container.innerHTML = `
        <div class="ca-ind-list">
          ${CE.Indicators.registry.map((def) => {
            const inst = instances.find((i) => i.type === def.id);
            return `
              <div class="ca-indicator-row">
                <label><input type="checkbox" data-ind="${def.id}" ${inst ? "checked" : ""}><span>${def.label}</span></label>
                ${inst ? `<button class="icon-btn" data-ind-gear="${inst.id}" title="Настройки индикатора" aria-label="Настройки ${def.label}">⚙</button>` : ""}
              </div>
              ${inst ? `<div class="ca-ind-settings hidden" data-ind-panel="${inst.id}"></div>` : ""}
            `;
          }).join("")}
        </div>
      `;
      container.querySelectorAll("input[data-ind]").forEach((cb) => {
        cb.onchange = () => {
          const id = cb.dataset.ind;
          if (cb.checked) {
            tile.indicatorMgr.add(id, {});
          } else {
            const existing = tile.indicatorMgr.list().find((i) => i.type === id);
            if (existing) tile.indicatorMgr.remove(existing.id);
          }
          this._saveWorkspaceState();
          this._renderIndicatorsInto(container);
        };
      });
      container.querySelectorAll("[data-ind-gear]").forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const panel = container.querySelector(`[data-ind-panel="${btn.dataset.indGear}"]`);
          const willOpen = panel.classList.contains("hidden");
          container.querySelectorAll(".ca-ind-settings").forEach((p) => p.classList.add("hidden"));
          if (willOpen) { panel.classList.remove("hidden"); this._renderIndicatorSettings(panel, tile, btn.dataset.indGear); }
        };
      });
    },

    _renderIndicatorSettings(panel, tile, instanceId) {
      const inst = tile.indicatorMgr.list().find((i) => i.id === instanceId);
      if (!inst) return;
      const def = CE.Indicators.registry.find((d) => d.id === inst.type);
      const paramKeys = Object.keys(def.defaultParams).filter((k) => k !== "source");
      const colorsHtml = inst.style.colors
        ? inst.style.colors.map((c, i) => `<label>${IND_LINE_LABELS[def.id]?.[i] || `Линия ${i + 1}`} <input type="color" data-ind-color="${i}" value="${toHex(c)}"></label>`).join("")
        : `<label>Цвет <input type="color" data-ind-color="0" value="${toHex(inst.style.color)}"></label>`;
      panel.innerHTML = `
        ${paramKeys.map((k) => `<label>${IND_PARAM_LABELS[k] || k} <input type="number" step="${k === "mult" ? "0.1" : "1"}" data-ind-param="${k}" value="${inst.params[k]}"></label>`).join("")}
        ${def.sourceParam ? `<label>Источник <select data-ind-source>${CE.Indicators.sources.map((s) => `<option value="${s.id}" ${inst.params.source === s.id ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>` : ""}
        ${colorsHtml}
        <label>Толщина <input type="number" min="1" max="6" data-ind-width value="${inst.style.width || 1}"></label>
        <button class="secondary" data-ind-remove>Удалить</button>
      `;
      panel.querySelectorAll("[data-ind-param]").forEach((inp) => (inp.onchange = () => {
        tile.indicatorMgr.updateParams(instanceId, { [inp.dataset.indParam]: Number(inp.value) });
        this._saveWorkspaceState();
      }));
      const sourceSel = panel.querySelector("[data-ind-source]");
      if (sourceSel) sourceSel.onchange = () => { tile.indicatorMgr.updateParams(instanceId, { source: sourceSel.value }); this._saveWorkspaceState(); };
      panel.querySelectorAll("[data-ind-color]").forEach((inp) => (inp.oninput = () => {
        const idx = Number(inp.dataset.indColor);
        if (inst.style.colors) { const colors = inst.style.colors.slice(); colors[idx] = inp.value; tile.indicatorMgr.updateStyle(instanceId, { colors }); }
        else tile.indicatorMgr.updateStyle(instanceId, { color: inp.value });
        this._saveWorkspaceState();
      }));
      panel.querySelector("[data-ind-width]").onchange = (e) => { tile.indicatorMgr.updateStyle(instanceId, { width: Number(e.target.value) }); this._saveWorkspaceState(); };
      panel.querySelector("[data-ind-remove]").onclick = () => {
        tile.indicatorMgr.remove(instanceId);
        this._saveWorkspaceState();
        this._renderIndicatorsInto(panel.closest("#gtIndicatorsPop") || panel.parentElement.parentElement);
      };
    },

    // -------------------------------------------------- templates popover --

    async _renderTemplatesInto(container) {
      const tile = this.activeTile;
      if (!tile) { container.innerHTML = ""; return; }
      container.innerHTML = `
        <div class="ca-more-heading">Рабочее пространство</div>
        <div id="caWsTemplates"></div>
        <div class="ca-more-sep"></div>
        <div class="ca-more-heading">График «${tile.symbol}»</div>
        <div id="caTileTemplates"><div class="muted-note">Загрузка…</div></div>
      `;
      this._renderWorkspaceTemplates(container.querySelector("#caWsTemplates"));
      const tileContainer = container.querySelector("#caTileTemplates");
      const layouts = await tile.listTemplates();
      tileContainer.innerHTML = layouts.length
        ? layouts.map((l) => `
            <div class="ca-template-row">
              <button class="link-btn ca-template-load" data-id="${l.id}">${l.name}${l.is_default ? " ★" : ""}</button>
              <button class="icon-btn" data-del="${l.id}" title="Удалить">🗑</button>
            </div>`).join("")
        : `<div class="muted-note">Нет сохранённых шаблонов для ${tile.symbol}</div>`;
      tileContainer.querySelectorAll(".ca-template-load").forEach((b) => (b.onclick = async () => {
        await tile.loadTemplate(b.dataset.id);
        this.root.querySelectorAll(".ca-popover").forEach((p) => p.classList.add("hidden"));
      }));
      tileContainer.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async (e) => {
        e.stopPropagation();
        await tile.deleteTemplate(b.dataset.del);
        b.closest(".ca-template-row").remove();
      }));
    },

    // ---------------------------------------------- workspace templates ---
    // (Stage 12: the whole multi-tile layout as one named unit - distinct
    // from the per-tile "график «X»" templates above, which only ever
    // covered a single tile's symbol/range/indicators/drawings. Stored in
    // localStorage, same persistence tier as the always-on auto-save
    // session snapshot (WORKSPACE_STATE_KEY) - this is the *named, manual*
    // counterpart to that, not a replacement for it.)

    _listWorkspaceTemplates() {
      try { return JSON.parse(localStorage.getItem(WORKSPACE_TEMPLATES_KEY) || "{}"); } catch (e) { return {}; }
    },
    _saveWorkspaceTemplatesMap(map) {
      try { localStorage.setItem(WORKSPACE_TEMPLATES_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
    },

    /** Everything Stage 12 lists: layout, every tile's full data (symbol/
     * timeframe/type/indicators/settings - drawings persist separately via
     * the DB per-tile layout system, unaffected by this), panel sizes,
     * sync flags, and open/collapsed panel state. Watchlist favorites/
     * custom lists are deliberately NOT part of this snapshot - those are
     * user-wide reference data (like browser bookmarks), not something a
     * "workspace template" should overwrite when someone loads a
     * colleague's saved layout. */
    _snapshotWorkspace() {
      const watchlist = this.root.querySelector("#caWatchlist");
      return {
        layoutMode: this.layoutMode,
        tiles: this.tiles.map((t) => t.toConfig()),
        activeIndex: this.tiles.findIndex((t) => t.id === this.activeTileId),
        syncFlags: this.syncFlags,
        bottomHeight: this._bottomHeight,
        bottomCollapsed: this._bottomCollapsed,
        watchlistWidth: watchlist ? Math.round(watchlist.getBoundingClientRect().width) : null,
        watchlistCollapsed: watchlist ? watchlist.classList.contains("wl-collapsed") : false,
        savedAt: Date.now(),
      };
    },

    _applyWorkspaceSnapshot(snap) {
      if (!snap || !Array.isArray(snap.tiles) || !snap.tiles.length) return;
      this.tiles.forEach((t) => { t.stopRealtime(); t.destroy(); });
      this.layoutMode = LAYOUT_TILE_COUNT[snap.layoutMode] ? snap.layoutMode : "1";
      const count = LAYOUT_TILE_COUNT[this.layoutMode];
      this.tiles = snap.tiles.slice(0, count).map((cfg) => new CE.ChartTile(cfg));
      while (this.tiles.length < count) this.tiles.push(new CE.ChartTile({}));
      const activeIdx = Number.isInteger(snap.activeIndex) && snap.activeIndex >= 0 && snap.activeIndex < this.tiles.length ? snap.activeIndex : 0;
      this.activeTileId = this.tiles[activeIdx].id;
      if (snap.syncFlags) this.syncFlags = Object.assign({}, this.syncFlags, snap.syncFlags);
      this.tiles.forEach((t) => t.startRealtime());
      this._syncTileGrid();
      if (snap.bottomHeight) {
        this._bottomHeight = clamp(snap.bottomHeight, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX);
        this.root.querySelector("#caBottom").style.height = this._bottomHeight + "px";
      }
      this._setBottomCollapsed(!!snap.bottomCollapsed);
      const watchlist = this.root.querySelector("#caWatchlist");
      if (snap.watchlistWidth) watchlist.style.width = clamp(snap.watchlistWidth, WATCHLIST_WIDTH_MIN, WATCHLIST_WIDTH_MAX) + "px";
      if (this.watchlist) this.watchlist.setCollapsed(!!snap.watchlistCollapsed);
      this._syncCollapseRightButton();
      this._refreshGlobalHeader();
      this._renderTickerOptions();
      this._saveWorkspaceState();
    },

    _renderWorkspaceTemplates(container) {
      const templates = this._listWorkspaceTemplates();
      const names = Object.keys(templates);
      container.innerHTML = `
        <div class="ca-ws-save-row">
          <input type="text" id="wsName" placeholder="Название пространства…" aria-label="Название рабочего пространства">
          <button class="secondary" id="wsSave">Сохранить</button>
        </div>
        ${names.length ? names.map((name) => `
          <div class="ca-template-row">
            <button class="link-btn ca-ws-load" data-name="${escapeAttr(name)}">${escapeAttr(name)}</button>
            <span class="ca-ws-actions">
              <button class="icon-btn" data-ws-rename="${escapeAttr(name)}" title="Переименовать">✎</button>
              <button class="icon-btn" data-ws-del="${escapeAttr(name)}" title="Удалить">🗑</button>
            </span>
          </div>`).join("") : `<div class="muted-note">Нет сохранённых рабочих пространств.</div>`}
      `;
      container.querySelector("#wsSave").onclick = () => {
        const input = container.querySelector("#wsName");
        const name = input.value.trim();
        if (!name) return;
        const map = this._listWorkspaceTemplates();
        map[name] = this._snapshotWorkspace();
        this._saveWorkspaceTemplatesMap(map);
        input.value = "";
        this._renderWorkspaceTemplates(container);
      };
      container.querySelectorAll(".ca-ws-load").forEach((b) => (b.onclick = () => {
        const map = this._listWorkspaceTemplates();
        this._applyWorkspaceSnapshot(map[b.dataset.name]);
        this.root.querySelectorAll(".ca-popover").forEach((p) => p.classList.add("hidden"));
      }));
      container.querySelectorAll("[data-ws-rename]").forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        const oldName = b.dataset.wsRename;
        const newName = prompt("Новое название", oldName);
        if (!newName || !newName.trim() || newName === oldName) return;
        const map = this._listWorkspaceTemplates();
        map[newName.trim()] = map[oldName];
        delete map[oldName];
        this._saveWorkspaceTemplatesMap(map);
        this._renderWorkspaceTemplates(container);
      }));
      container.querySelectorAll("[data-ws-del]").forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        const name = b.dataset.wsDel;
        if (!confirm(`Удалить рабочее пространство «${name}»?`)) return;
        const map = this._listWorkspaceTemplates();
        delete map[name];
        this._saveWorkspaceTemplatesMap(map);
        this._renderWorkspaceTemplates(container);
      }));
    },

    // ----------------------------------------------------- alerts popover --

    _renderAlertsInto(container) {
      const AS = global.AlertService;
      if (!AS) { container.innerHTML = `<div class="muted-note">Сервис оповещений недоступен.</div>`; return; }
      const tile = this.activeTile;
      const list = AS.list();
      const soundOn = AS.isSoundEnabled();
      container.innerHTML = `
        <div class="alert-form">
          <input type="text" id="alSymbol" value="${tile ? tile.symbol : ""}" placeholder="Тикер" aria-label="Тикер оповещения">
          <select id="alCondition" aria-label="Условие">
            ${Object.entries(AS.CONDITION_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
          </select>
          <input type="number" id="alValue" step="0.01" placeholder="Цена" aria-label="Пороговая цена">
          <select id="alRepeat" aria-label="Повтор">
            <option value="once">Один раз</option>
            <option value="repeat">Повторять</option>
          </select>
          <button class="secondary" id="alAdd">Добавить</button>
        </div>
        <label class="ca-more-toggle alert-sound-toggle"><input type="checkbox" id="alSound" ${soundOn ? "checked" : ""}><span>Звуковой сигнал</span></label>
        <div class="alert-list" id="alList">
          ${list.length ? list.map((a) => `
            <div class="alert-row ${a.enabled ? "" : "alert-row-off"}">
              <div class="alert-row-main">
                <strong>${a.symbol}</strong>
                <span>${AS.CONDITION_LABELS[a.condition]} ${fmtPrice(a.value)}</span>
                <span class="muted">${a.repeat === "repeat" ? "повторно" : "однократно"}${a.triggerCount ? ` · срабатывало ${a.triggerCount}×` : ""}</span>
              </div>
              <div class="alert-row-actions">
                <button data-al-toggle="${a.id}" title="${a.enabled ? "Отключить" : "Включить"}">${a.enabled ? "🔔" : "🔕"}</button>
                <button data-al-del="${a.id}" title="Удалить">🗑</button>
              </div>
            </div>`).join("") : `<div class="muted-note">Нет созданных оповещений.</div>`}
        </div>
      `;
      container.querySelector("#alAdd").onclick = () => {
        const symbol = container.querySelector("#alSymbol").value.trim().toUpperCase();
        const value = Number(container.querySelector("#alValue").value);
        if (!symbol || !Number.isFinite(value)) return;
        AS.create({
          symbol, value,
          condition: container.querySelector("#alCondition").value,
          repeat: container.querySelector("#alRepeat").value,
        });
        this._renderAlertsInto(container);
      };
      container.querySelector("#alSound").onchange = (e) => AS.setSoundEnabled(e.target.checked);
      container.querySelectorAll("[data-al-toggle]").forEach((b) => (b.onclick = () => {
        const a = list.find((x) => x.id === b.dataset.alToggle);
        AS.setEnabled(a.id, !a.enabled);
        this._renderAlertsInto(container);
      }));
      container.querySelectorAll("[data-al-del]").forEach((b) => (b.onclick = () => {
        AS.remove(b.dataset.alDel);
        this._renderAlertsInto(container);
      }));
    },

    /** TradingView signature gesture: tap the price axis to create an alert
     * at that price, instead of only via the toolbar bell's manual form
     * (see _bindPriceAxisAlertGesture below, wired from ChartTile.mount). */
    _openAlertPopoverWithPrice(tile, price) {
      // Deferred one tick: both callers (the context menu's click handler
      // and the price-axis tap's pointerup handler) run synchronously
      // inside a click/pointerup dispatch that _wireGlobalPopover's own
      // document-level "click outside closes the popover" listener also
      // observes later in the very same bubble phase - opening synchronously
      // here had it immediately re-hidden by that listener a moment later.
      setTimeout(() => {
        const btn = this.root.querySelector("#gtAlertBtn");
        const pop = this.root.querySelector("#gtAlertsPop");
        if (!btn || !pop) return;
        this.root.querySelectorAll(".ca-popover").forEach((p) => p.classList.add("hidden"));
        pop.classList.remove("hidden");
        this._renderAlertsInto(pop);
        const valueInput = pop.querySelector("#alValue");
        const symbolInput = pop.querySelector("#alSymbol");
        const conditionSelect = pop.querySelector("#alCondition");
        const candles = tile.core && tile.core.candles;
        const lastClose = candles && candles.length ? candles[candles.length - 1].close : null;
        if (symbolInput) symbolInput.value = tile.symbol;
        if (valueInput) {
          // coordinateToPrice()/pixelToPoint() return raw float pixel-math
          // (e.g. 81.60333746898263) - round to a sane number of decimals
          // for a price field instead of dumping 14 digits into it.
          const digits = Number.isFinite(price) ? (Math.abs(price) >= 1 ? 2 : Math.abs(price) >= 0.01 ? 4 : 8) : 2;
          valueInput.value = Number.isFinite(price) ? Number(price.toFixed(digits)) : "";
        }
        if (conditionSelect && lastClose != null) conditionSelect.value = price >= lastClose ? "price_above" : "price_below";
        if (valueInput) { valueInput.focus(); valueInput.select(); }
      }, 0);
    },

    /** Price-scale "+" quick menu (see ChartTile._updateScalePlus /
     * onScalePlusTap): a tiny two-item menu anchored to the "+" button
     * itself, using the exact {price,time} ChartTile sampled from the
     * crosshair - not re-derived from the click position, so it stays
     * correct even though the button sits in the price-scale gutter rather
     * than over the point it represents. Reuses the same .ca-context-menu/
     * .ca-context-item chrome as the canvas right-click menu (ТЗ §95: one
     * menu system, not a bespoke popup per feature) instead of building a
     * new visual language for one more menu. */
    _openScalePlusMenu(tile, price, time) {
      closeContextMenu();
      if (!tile || !tile.el || !Number.isFinite(price)) return;
      const btn = tile.el.querySelector('[data-role="scalePlus"]');
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const items = [
        { label: "Создать алерт", onClick: () => this._openAlertPopoverWithPrice(tile, price) },
        { label: "Добавить горизонтальную линию", onClick: () => { if (tile.drawingMgr) tile.drawingMgr.addDrawing("horizontal_line", [{ time, price }]); } },
      ];
      const menu = document.createElement("div");
      menu.id = "caContextMenu";
      menu.className = "ca-context-menu";
      menu.innerHTML = items.map((item, i) => `<button type="button" class="ca-context-item" data-idx="${i}">${item.label}</button>`).join("");
      document.body.appendChild(menu);
      const menuRect = menu.getBoundingClientRect();
      const left = Math.max(4, Math.min(rect.left - menuRect.width - 6, window.innerWidth - menuRect.width - 8));
      const top = Math.max(4, Math.min(rect.top - menuRect.height / 2, window.innerHeight - menuRect.height - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.querySelectorAll("[data-idx]").forEach((b) => (b.onclick = () => { items[Number(b.dataset.idx)].onClick(); closeContextMenu(); }));
      const closeOnOutside = (e) => {
        if (menu.contains(e.target) || e.target === btn) return;
        closeContextMenu();
        document.removeEventListener("pointerdown", closeOnOutside, true);
      };
      setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
    },

    _refreshAlertBadge() {
      const badge = this.root.querySelector("#gtAlertBadge");
      if (!badge) return;
      badge.classList.remove("hidden");
      setTimeout(() => badge.classList.add("hidden"), 4000);
    },

    // ------------------------------------------------------ more menu -----

    _renderMorePopover() {
      const pop = this.root.querySelector("#gtMorePop");
      const tile = this.activeTile;
      if (!tile) { pop.innerHTML = ""; return; }
      const hidden = [...this.root.querySelectorAll("#gtScroll [data-key].gt-hidden")]
        .sort((a, b) => Number(a.dataset.priority) - Number(b.dataset.priority));
      const overflowRows = hidden.map((el) => `<button class="ca-more-item" data-act="${el.dataset.key}">${el.dataset.icon} ${el.dataset.label}</button>`).join("");
      let scaleMode = 0;
      try { scaleMode = tile.core && tile.core.chart.priceScale("right").options().mode || 0; } catch (_) {}
      pop.innerHTML = `
        ${overflowRows ? `<div class="ca-more-group">${overflowRows}</div><div class="ca-more-sep"></div>` : ""}
        <div class="ca-more-group">
          <div class="ca-more-heading">Диапазон</div>
          <div class="ca-range-presets">
            ${tile.listRangePresets().map((p) => `<button class="range-preset" data-range-days="${p.days}">${p.label}</button>`).join("")}
            <button class="range-preset ${tile.rangeMode !== "custom" ? "active" : ""}" data-range-all="1">Все</button>
          </div>
        </div>
        <div class="ca-more-sep"></div>
        <div class="ca-more-group">
          <div class="ca-more-heading">Шкала цен</div>
          <div class="ca-range-presets">
            <button class="range-preset ${scaleMode === 2 ? "active" : ""}" data-act="scalePercent">%</button>
            <button class="range-preset ${scaleMode === 1 ? "active" : ""}" data-act="scaleLog">Лог</button>
            <button class="range-preset" data-act="scaleAuto">Авто</button>
          </div>
        </div>
        <div class="ca-more-sep"></div>
        <div class="ca-more-group">
          <div class="ca-more-heading">Синхронизация графиков</div>
          ${Object.keys(SYNC_LABELS).map((k) => `<label class="ca-more-toggle"><input type="checkbox" data-sync="${k}" ${this.syncFlags[k] ? "checked" : ""}><span>${SYNC_LABELS[k]}</span></label>`).join("")}
        </div>
        <div class="ca-more-sep"></div>
        <button class="ca-more-item" data-act="order">⚙ Заказать стратегию по разметке</button>
        <button class="ca-more-item" data-act="snap">🧲 Магнит: ${MAGNET_LABELS[(tile.drawingMgr && tile.drawingMgr.magnetMode) || "off"]}</button>
        <button class="ca-more-item" data-act="reset">↺ Сбросить масштаб</button>
      `;
      pop.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => {
        pop.classList.add("hidden");
        const act = b.dataset.act;
        if (this._toolbarActions[act]) this._toolbarActions[act]();
        else if (act === "order") tile.openOrderModal();
        else if (act === "snap") {
          // Off -> Weak -> Strong -> Off, matching TradingView's own magnet
          // (see DrawingManager.snapPoint in chart-engine/drawings.js for
          // what "weak" vs "strong" actually do). Also keeps the rail's own
          // magnet button (chart-editor-terminal-mobile-v2.js) in sync - it
          // reads the same drawingMgr.magnetMode but previously had no way
          // to learn this menu had changed it.
          if (tile.drawingMgr) {
            const cycle = ["off", "weak", "strong"];
            tile.drawingMgr.magnetMode = cycle[(cycle.indexOf(tile.drawingMgr.magnetMode) + 1) % cycle.length];
          }
          if (window.StrategyLabMobileChart && typeof window.StrategyLabMobileChart.refreshRail === "function") window.StrategyLabMobileChart.refreshRail();
        }
        else if (act === "reset") { if (tile.core) tile.core.fitContent(); }
        else if (act === "scalePercent" || act === "scaleLog") {
          if (!tile.core) return;
          const mode = act === "scalePercent" ? 2 : 1;
          let current = 0; try { current = tile.core.chart.priceScale("right").options().mode || 0; } catch (_) {}
          try { tile.core.chart.priceScale("right").applyOptions({ mode: current === mode ? 0 : mode }); } catch (_) {}
        }
        else if (act === "scaleAuto") { try { tile.core && tile.core.chart.priceScale("right").applyOptions({ autoScale: true }); } catch (_) {} }
      }));
      pop.querySelectorAll(".range-preset[data-range-days]").forEach((b) => (b.onclick = () => {
        tile.applyQuickRange(Number(b.dataset.rangeDays));
        if (this.syncFlags.range) this.tiles.forEach((t) => { if (t !== tile) t.applyQuickRange(Number(b.dataset.rangeDays)); });
        pop.classList.add("hidden");
      }));
      const allBtn = pop.querySelector("[data-range-all]");
      if (allBtn) allBtn.onclick = () => {
        tile.resetRange();
        if (this.syncFlags.range) this.tiles.forEach((t) => { if (t !== tile) t.resetRange(); });
        pop.classList.add("hidden");
      };
      pop.querySelectorAll("[data-sync]").forEach((cb) => (cb.onchange = () => {
        this.syncFlags[cb.dataset.sync] = cb.checked;
        this._saveWorkspaceState();
      }));
    },

    // ----------------------------------------------------- responsive -----

    _wireToolbarOverflow() {
      const scroll = this.root.querySelector("#gtScroll");
      const ro = new ResizeObserver(() => this._recalcToolbarOverflow());
      ro.observe(this.root.querySelector("#caToolbar"));
      this._toolbarResizeObserver = ro;
      this._recalcToolbarOverflow();
    },

    /** Keeps the toolbar a single visual row (spec: "нельзя оставлять
     * элементы в нескольких несвязанных строках") by hiding the lowest-
     * priority collapsible items (see TOOLBAR_META) while the row's content
     * is wider than the row itself, and showing them again as space frees
     * up. Hidden items' actions stay reachable through the "Ещё" menu,
     * rendered by _renderMorePopover() from the same .gt-hidden markers. */
    _recalcToolbarOverflow() {
      const scroll = this.root.querySelector("#gtScroll");
      if (!scroll) return;
      const items = [...scroll.querySelectorAll("[data-key]")].sort((a, b) => Number(a.dataset.priority) - Number(b.dataset.priority));
      items.forEach((el) => el.classList.remove("gt-hidden"));
      let guard = 0;
      while (scroll.scrollWidth > scroll.clientWidth + 1 && guard < items.length) {
        const next = items.find((el) => !el.classList.contains("gt-hidden"));
        if (!next) break;
        next.classList.add("gt-hidden");
        guard++;
      }
    },

    // --------------------------------------------------- resizable chrome --

    _buildPanelChrome() {
      const bottom = this.root.querySelector("#caBottom");
      const watchlist = this.root.querySelector("#caWatchlist");

      // Default to collapsed on phone-width screens (no saved preference yet) -
      // the Свойства/Объекты panel used to default open everywhere, eating
      // ~40% of the viewport height on first mobile visit. An explicit prior
      // choice (localStorage already has a value) always wins over this.
      let collapsed = window.innerWidth <= 620, height = BOTTOM_HEIGHT_DEFAULT, wlWidth = WATCHLIST_WIDTH_DEFAULT;
      try {
        const savedCollapsed = localStorage.getItem(BOTTOM_COLLAPSED_KEY);
        if (savedCollapsed !== null) collapsed = savedCollapsed === "1";
        const h = Number(localStorage.getItem(BOTTOM_HEIGHT_KEY));
        if (Number.isFinite(h) && h > 0) height = h;
        const w = Number(localStorage.getItem(WATCHLIST_WIDTH_KEY));
        if (Number.isFinite(w) && w > 0) wlWidth = w;
      } catch (e) { /* ignore */ }

      this._bottomHeight = clamp(height, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX);
      bottom.style.height = this._bottomHeight + "px";
      this._setBottomCollapsed(collapsed, { skipSave: true });

      watchlist.style.width = clamp(wlWidth, WATCHLIST_WIDTH_MIN, WATCHLIST_WIDTH_MAX) + "px";

      this._wireDrag(this.root.querySelector("#caResizeH"), (dy) => {
        if (this._bottomCollapsed) return;
        this._bottomHeight = clamp(this._bottomHeight + dy, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX);
        bottom.style.height = this._bottomHeight + "px";
      }, () => { try { localStorage.setItem(BOTTOM_HEIGHT_KEY, String(this._bottomHeight)); } catch (e) { /* ignore */ } });

      this._wireDrag(this.root.querySelector("#caResizeV"), (dx) => {
        if (watchlist.classList.contains("wl-collapsed")) return;
        const next = clamp(watchlist.getBoundingClientRect().width + dx, WATCHLIST_WIDTH_MIN, WATCHLIST_WIDTH_MAX);
        watchlist.style.width = next + "px";
      }, () => { try { localStorage.setItem(WATCHLIST_WIDTH_KEY, String(watchlist.getBoundingClientRect().width)); } catch (e) { /* ignore */ } }, "x");
    },

    _wireDrag(handle, onDrag, onDone, axis) {
      if (!handle) return;
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        handle.classList.add("dragging");
        document.body.classList.add("ca-resizing");
        let last = axis === "x" ? e.clientX : e.clientY;
        const onMove = (ev) => {
          const pos = axis === "x" ? ev.clientX : ev.clientY;
          const delta = last - pos;
          last = pos;
          onDrag(delta);
          this.tiles.forEach((t) => t.core && t.core._onResize());
        };
        const onUp = () => {
          handle.classList.remove("dragging");
          document.body.classList.remove("ca-resizing");
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (onDone) onDone();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    },

    _setBottomCollapsed(collapsed, { skipSave } = {}) {
      this._bottomCollapsed = collapsed;
      const bottom = this.root.querySelector("#caBottom");
      bottom.classList.toggle("collapsed", collapsed);
      const btn = this.root.querySelector("#gtCollapseBottomBtn");
      if (btn) {
        btn.textContent = collapsed ? "﹀" : "︿";
        btn.title = collapsed ? "Развернуть панель свойств" : "Свернуть панель свойств";
        btn.classList.toggle("active", collapsed);
      }
      if (!skipSave) {
        try { localStorage.setItem(BOTTOM_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch (e) { /* ignore */ }
      }
      requestAnimationFrame(() => this.tiles.forEach((t) => t.core && t.core._onResize()));
    },

    _syncCollapseRightButton() {
      const btn = this.root.querySelector("#gtCollapseRightBtn");
      const collapsed = this.root.querySelector("#caWatchlist").classList.contains("wl-collapsed");
      if (!btn) return;
      btn.title = collapsed ? "Развернуть список инструментов" : "Свернуть список инструментов";
      btn.setAttribute("aria-label", "Свернуть/развернуть список инструментов");
      btn.classList.toggle("active", collapsed);
    },

    _downloadSnapshot() {
      if (!this.core) return;
      const canvas = this.core.chart.takeScreenshot();
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.download = `${this.activeTile.symbol}_${this.activeTile.timeframe}_${stamp}.png`;
      a.click();
    },

    // ---------------------------------------------------- layout popover --

    _renderLayoutPopover() {
      const pop = this.root.querySelector("#gtLayoutPop");
      pop.innerHTML = LAYOUTS.map((l) => `
        <button class="ca-layout-thumb ${l.id === this.layoutMode ? "active" : ""}" data-layout="${l.id}" title="${l.label}" aria-label="${l.label}">
          ${layoutIcon(l)}
          <span class="ca-layout-thumb-label">${l.label}</span>
        </button>`).join("");
      pop.querySelectorAll(".ca-layout-thumb").forEach((b) => (b.onclick = () => {
        this._setLayout(b.dataset.layout);
        pop.classList.add("hidden");
      }));
    },

    // ------------------------------------------------------------ tiles --

    _syncTileGrid() {
      const grid = this.root.querySelector("#caTileGrid");
      grid.className = "ca-tile-grid layout-" + this.layoutMode;
      const keep = new Set(this.tiles.filter((t) => t.el).map((t) => t.el));
      [...grid.children].forEach((child) => { if (!keep.has(child)) child.remove(); });
      this.tiles.forEach((tile) => {
        if (!tile.el) {
          const el = document.createElement("div");
          grid.appendChild(el);
          tile.mount(el, {
            onActivate: (t) => this._setActiveTile(t.id),
            onClose: (t) => this._closeTile(t.id),
            onScalePlusTap: (t, price, time) => this._openScalePlusMenu(t, price, time),
            onFloatToolbarMore: (t, { focusText } = {}) => {
              if (typeof this._setBottomCollapsed === "function") this._setBottomCollapsed(false);
              const tab = this.root.querySelector('.ca-side-tab[data-side="props"]');
              if (tab) tab.click();
              if (!focusText) return;
              requestAnimationFrame(() => {
                const field = this.root.querySelector("#propText");
                if (!field) return;
                field.focus();
                if (typeof field.setSelectionRange === "function") field.setSelectionRange(field.value.length, field.value.length);
                if (typeof field.scrollIntoView === "function") field.scrollIntoView({ block: "nearest" });
              });
            },
          });
          tile.setSecurities(this.securities);
          tile.drawingMgr.onChange((mgr, detail) => {
            // Canvas preview/hover updates happen at pointer frequency. They
            // must repaint the primitive, not rebuild the properties/object
            // DOM while the user is dragging on iPhone.
            if (detail && (detail.preview || detail.hover)) return;
            if (tile.id === this.activeTileId) { this._renderProps(); this._renderObjects(); }
          });
          tile.onRangeChange((range) => { if (this.syncFlags.scroll || this.syncFlags.zoom) this._broadcastRange(tile, range); });
          tile.onCrosshairMove((time, price) => { if (this.syncFlags.crosshair) this._broadcastCrosshair(tile, time, price); });
          tile.onPriceUpdate((t, info) => {
            t._lastPriceInfo = info;
            if (t.id === this.activeTileId) this._refreshGlobalHeader();
          });
          tile.onLiveTick((symbol, price) => { if (global.AlertService) global.AlertService.evaluate(symbol, price); });
          tile.onStateChanged((t, detail) => {
            // Any state change worth notifying about (symbol/timeframe/
            // range/layout) can reload the series into an entirely
            // different logical-index space - a stale _lastBroadcastRange
            // from before that would compute a meaningless scroll delta on
            // the next sync broadcast, so always drop it here.
            t._lastBroadcastRange = null;
            this._saveWorkspaceState();
            if (t.id === this.activeTileId) {
              if (this.watchlist) this.watchlist.setActive(t.symbol);
              this._refreshGlobalHeader();
            }
          });
        } else if (tile.el.parentElement !== grid) {
          grid.appendChild(tile.el);
        }
        tile.setActiveVisual(tile.id === this.activeTileId);
      });
    },

    /** Applies `range` (source's new visible logical range) to the other
     * tiles according to which of scroll/zoom sync is actually on - the two
     * are never bundled into one "apply the whole range" call except when
     * BOTH are enabled. Cycle-safe: each tile's own onRangeChange only
     * re-fires from a genuine user interaction (ChartTile guards
     * programmatic applyLogicalRange() calls via _applyingRange), so this
     * can never re-trigger itself through another tile. */
    _broadcastRange(source, range) {
      if (!range) return;
      const prev = source._lastBroadcastRange || range;
      source._lastBroadcastRange = range;
      const deltaPos = range.from - prev.from;
      const bothOn = this.syncFlags.scroll && this.syncFlags.zoom;
      this.tiles.forEach((t) => {
        if (t === source || !t.core) return;
        if (bothOn) {
          t.applyLogicalRange(range);
          return;
        }
        const tRange = t.core.chart.timeScale().getVisibleLogicalRange();
        if (!tRange) return;
        if (this.syncFlags.zoom) {
          // Match the source's new width, keep this tile's own center -
          // scroll sync being off means this tile's position must not move.
          const center = (tRange.from + tRange.to) / 2;
          const width = range.to - range.from;
          t.applyLogicalRange({ from: center - width / 2, to: center + width / 2 });
        } else if (this.syncFlags.scroll) {
          // Translate by the same delta, keep this tile's own width - zoom
          // sync being off means this tile's own scale must not change.
          t.applyLogicalRange({ from: tRange.from + deltaPos, to: tRange.to + deltaPos });
        }
      });
    },
    _broadcastCrosshair(source, time, price) {
      this.tiles.forEach((t) => { if (t !== source) t.applyCrosshair(time, price); });
    },

    _setLayout(mode) {
      if (!LAYOUT_TILE_COUNT[mode]) return;
      this.layoutMode = mode;
      this._resizeTiles(LAYOUT_TILE_COUNT[mode]);
      this._syncTileGrid();
      this._saveWorkspaceState();
    },

    _resizeTiles(targetCount) {
      const active = this.activeTile;
      while (this.tiles.length > targetCount) {
        const tile = this.tiles.pop();
        this._archivedTiles.push(tile.toConfig());
        tile.stopRealtime();
        tile.destroy();
      }
      while (this.tiles.length < targetCount) {
        const cfg = this._archivedTiles.pop() || (active ? { symbol: active.symbol, timeframe: active.timeframe } : {});
        const tile = new CE.ChartTile(cfg);
        this.tiles.push(tile);
        tile.startRealtime();
      }
      if (!this.tiles.some((t) => t.id === this.activeTileId)) this.activeTileId = this.tiles[0].id;
    },

    _closeTile(id) {
      if (this.tiles.length <= 1) return;
      const idx = this.tiles.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const [tile] = this.tiles.splice(idx, 1);
      const wasActive = tile.id === this.activeTileId;
      tile.stopRealtime();
      tile.destroy();
      this.layoutMode = COUNT_TO_LAYOUT[this.tiles.length] || this.layoutMode;
      if (wasActive) this.activeTileId = this.tiles[Math.max(0, idx - 1)].id;
      this._syncTileGrid();
      this._saveWorkspaceState();
      this._refreshGlobalHeader();
    },

    _setActiveTile(id) {
      if (id === this.activeTileId) return;
      this.activeTileId = id;
      this.tiles.forEach((t) => t.setActiveVisual(t.id === id));
      if (this.watchlist && this.activeTile) this.watchlist.setActive(this.activeTile.symbol);
      // Drawing-tool selection is a per-interaction toolbar concept, not
      // per-tile persisted state - switching the active tile resets it to
      // the cursor so the newly focused tile isn't left mid-draw with a
      // tool it never picked.
      this.root.querySelectorAll(".ca-tool-btn[data-tool]").forEach((b) => b.classList.toggle("active", !b.dataset.tool));
      if (this.drawingMgr) this.drawingMgr.setTool(null);
      this._refreshGlobalHeader();
      this._renderTickerOptions();
      this._renderProps();
      this._renderObjects();
      this._saveWorkspaceState();
    },

    // ------------------------------------------------------- persistence --

    _saveWorkspaceState() {
      try {
        localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify({
          layoutMode: this.layoutMode,
          tiles: this.tiles.map((t) => t.toConfig()),
          activeIndex: this.tiles.findIndex((t) => t.id === this.activeTileId),
          syncFlags: this.syncFlags,
        }));
      } catch (e) { /* localStorage unavailable - workspace just won't restore next visit */ }
    },

    _restoreWorkspaceState() {
      try {
        const raw = localStorage.getItem(WORKSPACE_STATE_KEY);
        if (!raw) return false;
        const state = JSON.parse(raw);
        if (!state || !Array.isArray(state.tiles) || !state.tiles.length) return false;
        this.layoutMode = LAYOUT_TILE_COUNT[state.layoutMode] ? state.layoutMode : "1";
        const count = LAYOUT_TILE_COUNT[this.layoutMode];
        this.tiles = state.tiles.slice(0, count).map((cfg) => new CE.ChartTile(cfg));
        while (this.tiles.length < count) this.tiles.push(new CE.ChartTile({}));
        const activeIdx = Number.isInteger(state.activeIndex) && state.activeIndex >= 0 && state.activeIndex < this.tiles.length ? state.activeIndex : 0;
        this.activeTileId = this.tiles[activeIdx].id;
        // A per-parameter syncFlags snapshot restores as-is (it only ever
        // contains what the user explicitly turned on). A pre-syncFlags
        // session ("syncEnabled" - one bundled toggle from an older
        // version) does NOT get migrated to any sync being on: every sync
        // channel must start OFF until explicitly re-enabled, even for a
        // workspace that had the old toggle on - see the spec's "по
        // умолчанию все виды синхронизации должны быть выключены".
        if (state.syncFlags) this.syncFlags = Object.assign({}, this.syncFlags, state.syncFlags);
        return true;
      } catch (e) {
        return false;
      }
    },

    // --------------------------------------------------------- misc UI ---

    _onFullscreenChange(active) {
      const btn = this.root.querySelector("#caFullscreenBtn");
      if (!btn) return;
      btn.textContent = active ? "⤢" : "⛶";
      btn.title = active ? "Выйти из полноэкранного режима (Esc)" : "Полноэкранный режим рабочего пространства";
      btn.setAttribute("aria-label", btn.title);
      btn.classList.toggle("active", active);
      requestAnimationFrame(() => this.tiles.forEach((t) => t.core && t.core._onResize()));
    },

    // ------------------------------------------------------ settings UI ---

    _openSettingsDialog() {
      const tile = this.activeTile;
      if (!tile || !tile.core) return;
      let overlay = document.getElementById("caSettingsModal");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "caSettingsModal";
        overlay.className = "ca-modal-backdrop";
        document.body.appendChild(overlay);
      }
      const o = tile.core.displayOptions || {};
      const theme = CE.theme;
      // 2 decimals suits RUB-scale prices but truncates sub-cent Binance
      // instruments (SHIB, PEPE, ...) to "0.00" by default - derive a
      // sensible starting point from the tile's actual last price instead.
      let autoPrecision = 2;
      const lastClose = tile.core.candles && tile.core.candles.length ? tile.core.candles[tile.core.candles.length - 1].close : null;
      if (lastClose != null) {
        const p = Math.abs(lastClose);
        autoPrecision = p >= 1 ? 2 : p >= 0.01 ? 4 : 8;
      }
      overlay.innerHTML = `
        <div class="ca-modal ca-settings-modal">
          <button class="close-btn" id="csClose" aria-label="Закрыть">×</button>
          <h3>Настройки графика · ${tile.symbol}</h3>
          <div class="ca-settings-grid">
            <label>Цвет роста <input type="color" id="csUp" value="${toHex(o.upColor || theme.up)}"></label>
            <label>Цвет падения <input type="color" id="csDown" value="${toHex(o.downColor || theme.down)}"></label>
            <label>Цвет границ <input type="color" id="csBorder" value="${toHex(o.borderColor || theme.up)}"></label>
            <label>Цвет фитилей <input type="color" id="csWick" value="${toHex(o.wickColor || theme.up)}"></label>
            <label class="toggle"><input type="checkbox" id="csShowWicks" ${o.showWicks !== false ? "checked" : ""}><span>Показывать фитили</span></label>
            <label class="toggle"><input type="checkbox" id="csShowBorders" ${o.showBorders !== false ? "checked" : ""}><span>Показывать границы</span></label>
            <label class="toggle"><input type="checkbox" id="csPriceLine" ${o.priceLineVisible !== false ? "checked" : ""}><span>Линия текущей цены</span></label>
            <label class="toggle"><input type="checkbox" id="csGrid" ${o.showGrid !== false ? "checked" : ""}><span>Сетка</span></label>
            <label class="toggle"><input type="checkbox" id="csVolume" ${o.showVolume !== false ? "checked" : ""}><span>Объёмы</span></label>
            <label class="toggle"><input type="checkbox" id="csAutoScale" ${o.autoScale !== false ? "checked" : ""}><span>Автомасштаб</span></label>
            <label class="toggle"><input type="checkbox" id="csScalePlus" ${o.scalePlusEnabled !== false ? "checked" : ""}><span>«+» на шкале цены</span></label>
            <label>Фон <input type="color" id="csBg" value="${toHex(o.background || "#0c1019")}"></label>
            <label>Точность цены <input type="number" id="csPrecision" min="0" max="8" value="${o.priceFormatPrecision != null ? o.priceFormatPrecision : autoPrecision}"></label>
            <label>Часовой пояс
              <select id="csTz">
                <option value="0" ${(tile.core._tzOffsetHours || 0) === 0 ? "selected" : ""}>UTC</option>
                <option value="3" ${(tile.core._tzOffsetHours || 0) === 3 ? "selected" : ""}>МСК (UTC+3)</option>
              </select>
            </label>
          </div>
          <p class="muted-note">Настройки применяются сразу и сохраняются для этой плитки.</p>
        </div>`;
      overlay.classList.remove("hidden");
      overlay.querySelector("#csClose").onclick = () => overlay.classList.add("hidden");
      overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add("hidden"); };

      const apply = (patch) => { tile.core.setDisplayOptions(patch); this._saveWorkspaceState(); };
      overlay.querySelector("#csUp").oninput = (e) => apply({ upColor: e.target.value });
      overlay.querySelector("#csDown").oninput = (e) => apply({ downColor: e.target.value });
      overlay.querySelector("#csBorder").oninput = (e) => apply({ borderColor: e.target.value });
      overlay.querySelector("#csWick").oninput = (e) => apply({ wickColor: e.target.value });
      overlay.querySelector("#csShowWicks").onchange = (e) => apply({ showWicks: e.target.checked });
      overlay.querySelector("#csShowBorders").onchange = (e) => apply({ showBorders: e.target.checked });
      overlay.querySelector("#csPriceLine").onchange = (e) => apply({ priceLineVisible: e.target.checked });
      overlay.querySelector("#csGrid").onchange = (e) => apply({ showGrid: e.target.checked });
      overlay.querySelector("#csVolume").onchange = (e) => apply({ showVolume: e.target.checked });
      overlay.querySelector("#csAutoScale").onchange = (e) => apply({ autoScale: e.target.checked });
      overlay.querySelector("#csScalePlus").onchange = (e) => apply({ scalePlusEnabled: e.target.checked });
      overlay.querySelector("#csBg").oninput = (e) => apply({ background: e.target.value });
      overlay.querySelector("#csPrecision").onchange = (e) => apply({ priceFormatPrecision: Number(e.target.value) });
      overlay.querySelector("#csTz").onchange = (e) => tile.core.setTimezoneOffset(Number(e.target.value));
    },

    // ------------------------------------------------ properties/objects --

    _renderProps() {
      const panel = this.root.querySelector("#caProps");
      const dm = this.drawingMgr;
      const d = dm ? dm.drawings.find((x) => x.id === dm.selectedId) : null;
      if (!d) { panel.innerHTML = `<div class="muted-note">Выберите объект на графике, чтобы изменить его свойства.</div>`; return; }
      const isPosition = d.type === "long_position" || d.type === "short_position";
      const isTextual = d.type === "text" || d.type === "note";
      const isFib = d.type === "fib_retracement" || d.type === "fib_extension";
      const fibDefaults = d.type === "fib_retracement" ? CE.Drawings.FIB_RETRACEMENT_LEVELS : CE.Drawings.FIB_EXTENSION_LEVELS;
      const fibLevels = Array.isArray(d.properties.levels) && d.properties.levels.length ? d.properties.levels : fibDefaults;
      const tile = this.activeTile;
      const tfList = tile ? tile.listTimeframes() : [];
      const visibleTf = d.properties.visibleTimeframes || [];
      panel.innerHTML = `
        <h4>${CE.Drawings.TOOL_DEFS[d.type].label}</h4>
        <div class="ca-prop-coords">
          <span class="ca-more-heading">Координаты</span>
          ${d.points.map((p, i) => `<div class="ca-coord-row">${d.points.length > 1 ? `#${i + 1}: ` : ""}${fmtCoordTime(p.time)}${p.price != null ? ` · ${fmtPrice(p.price)}` : ""}</div>`).join("")}
        </div>
        ${isTextual ? `
          <label class="ca-prop-text-label">${d.type === "note" ? "Текст заметки" : "Текст"}
            <textarea id="propText" class="ca-prop-textarea" rows="4" placeholder="Введите текст…"></textarea>
          </label>
          <div class="muted-note ca-prop-text-hint">Текст сохраняется после завершения ввода.</div>
        ` : ""}
        <label>Цвет <input type="color" id="propColor" value="${toHex(d.properties.color)}"></label>
        ${!isTextual ? `
          <label>Толщина <input type="number" id="propWidth" min="1" max="6" value="${d.properties.width || 1}"></label>
          <label>Стиль линии
            <select id="propDash">
              <option value="solid" ${d.properties.dash !== "dashed" && d.properties.dash !== "dotted" ? "selected" : ""}>Сплошная</option>
              <option value="dashed" ${d.properties.dash === "dashed" ? "selected" : ""}>Штрихи</option>
              <option value="dotted" ${d.properties.dash === "dotted" ? "selected" : ""}>Точки</option>
            </select>
          </label>
        ` : ""}
        <label>Прозрачность <input type="range" id="propOpacity" min="10" max="100" value="${Math.round((d.properties.opacity != null ? d.properties.opacity : 1) * 100)}"></label>
        <label class="toggle"><input type="checkbox" id="propLocked" ${d.locked ? "checked" : ""}><span>Заблокировать</span></label>
        <label class="toggle"><input type="checkbox" id="propHidden" ${d.hidden ? "checked" : ""}><span>Скрыть</span></label>
        ${!isTextual ? `<label class="toggle"><input type="checkbox" id="propShowPrice" ${d.properties.showPrice ? "checked" : ""}><span>Показывать цену</span></label>` : ""}
        <label>Подпись (для списка объектов) <input type="text" id="propLabel" value="${escapeAttr(d.properties.label || "")}"></label>
        ${isPosition ? `
          <label>Кол-во <input type="number" id="propQty" value="${d.properties.quantity || 0}"></label>
          <label>Стоп, % <input type="number" step="0.1" id="propStopPct" value="${(d.properties.stopOffsetPct || 0).toFixed(2)}"></label>
          <label>Тейк, % <input type="number" step="0.1" id="propTakePct" value="${(d.properties.takeOffsetPct || 0).toFixed(2)}"></label>
        ` : ""}
        ${isFib ? `
          <div class="ca-prop-fib">
            <span class="ca-more-heading">Уровни Фибоначчи</span>
            <label class="toggle"><input type="checkbox" id="propFibReverse" ${d.properties.reverse ? "checked" : ""}><span>Развернуть</span></label>
            <label class="toggle"><input type="checkbox" id="propFibExtend" ${d.properties.extendLeft ? "checked" : ""}><span>Продлить влево</span></label>
            <div class="ca-fib-levels" id="propFibLevels">
              ${fibLevels.map((lv, i) => `<div class="ca-fib-level-row"><input type="number" step="0.001" data-fib-level="${i}" value="${lv}"><button type="button" class="ca-fib-level-rm" data-fib-remove="${i}" title="Удалить уровень" aria-label="Удалить уровень">✕</button></div>`).join("")}
            </div>
            <button class="secondary" id="propFibAdd">+ Добавить уровень</button>
          </div>
        ` : ""}
        <div class="ca-prop-tfvis">
          <span class="ca-more-heading">Видимость на таймфреймах</span>
          <label class="ca-more-toggle"><input type="checkbox" id="propTfAll" ${!visibleTf.length ? "checked" : ""}><span>Все таймфреймы</span></label>
          <div class="ca-tf-grid ${!visibleTf.length ? "hidden" : ""}" id="propTfGrid">
            ${tfList.map((t) => `<label class="ca-more-toggle"><input type="checkbox" data-tf="${t.id}" ${visibleTf.includes(t.id) ? "checked" : ""}><span>${t.label}</span></label>`).join("")}
          </div>
        </div>
        <button class="secondary" id="propSetDefault" title="Каждый новый ${CE.Drawings.TOOL_DEFS[d.type].label} будет начинаться с этого стиля">Сделать стилем по умолчанию</button>
        <button class="secondary" id="propDuplicate">Дублировать (Ctrl+D)</button>
        <button class="secondary" id="propDelete">Удалить</button>
      `;

      // updateDrawing() re-renders this panel. Commit-style change events keep
      // the focused textarea/number input alive while the user is typing.
      const colorInput = panel.querySelector("#propColor");
      if (colorInput) colorInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { color: e.target.value } });
      const widthInput = panel.querySelector("#propWidth");
      if (widthInput) widthInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { width: Number(e.target.value) } });
      const dashInput = panel.querySelector("#propDash");
      if (dashInput) dashInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { dash: e.target.value } });
      const opacityInput = panel.querySelector("#propOpacity");
      if (opacityInput) opacityInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { opacity: Number(e.target.value) / 100 } });
      panel.querySelector("#propLocked").onchange = (e) => dm.updateDrawing(d.id, { locked: e.target.checked });
      panel.querySelector("#propHidden").onchange = (e) => dm.updateDrawing(d.id, { hidden: e.target.checked });
      const showPrice = panel.querySelector("#propShowPrice");
      if (showPrice) showPrice.onchange = (e) => dm.updateDrawing(d.id, { properties: { showPrice: e.target.checked } });
      panel.querySelector("#propLabel").onchange = (e) => { dm.updateDrawing(d.id, { properties: { label: e.target.value } }); this._renderObjects(); };
      const textInput = panel.querySelector("#propText");
      if (textInput) {
        textInput.value = d.properties.text || "";
        textInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { text: e.target.value } });
      }
      if (isPosition) {
        panel.querySelector("#propQty").onchange = (e) => dm.updateDrawing(d.id, { properties: { quantity: Number(e.target.value) } });
        panel.querySelector("#propStopPct").onchange = (e) => dm.updateDrawing(d.id, { properties: { stopOffsetPct: Number(e.target.value) } });
        panel.querySelector("#propTakePct").onchange = (e) => dm.updateDrawing(d.id, { properties: { takeOffsetPct: Number(e.target.value) } });
      }
      if (isFib) {
        panel.querySelector("#propFibReverse").onchange = (e) => dm.updateDrawing(d.id, { properties: { reverse: e.target.checked } });
        panel.querySelector("#propFibExtend").onchange = (e) => dm.updateDrawing(d.id, { properties: { extendLeft: e.target.checked } });
        const currentLevels = () => (Array.isArray(d.properties.levels) && d.properties.levels.length ? d.properties.levels.slice() : fibDefaults.slice());
        panel.querySelectorAll("[data-fib-level]").forEach((input) => (input.onchange = () => {
          const levels = currentLevels();
          const i = Number(input.dataset.fibLevel);
          const v = Number(input.value);
          if (Number.isFinite(v)) levels[i] = v;
          dm.updateDrawing(d.id, { properties: { levels } });
        }));
        panel.querySelectorAll("[data-fib-remove]").forEach((btn) => (btn.onclick = () => {
          const levels = currentLevels();
          if (levels.length <= 1) return; // at least one level must remain
          levels.splice(Number(btn.dataset.fibRemove), 1);
          dm.updateDrawing(d.id, { properties: { levels } });
        }));
        panel.querySelector("#propFibAdd").onclick = () => {
          const levels = currentLevels();
          levels.push(0);
          dm.updateDrawing(d.id, { properties: { levels } });
        };
      }
      const tfAll = panel.querySelector("#propTfAll");
      const tfGrid = panel.querySelector("#propTfGrid");
      tfAll.onchange = (e) => {
        tfGrid.classList.toggle("hidden", e.target.checked);
        if (e.target.checked) dm.updateDrawing(d.id, { properties: { visibleTimeframes: null } });
      };
      tfGrid.querySelectorAll("[data-tf]").forEach((cb) => (cb.onchange = () => {
        const checked = [...tfGrid.querySelectorAll("[data-tf]")].filter((x) => x.checked).map((x) => x.dataset.tf);
        dm.updateDrawing(d.id, { properties: { visibleTimeframes: checked } });
      }));
      panel.querySelector("#propSetDefault").onclick = () => {
        const style = { color: d.properties.color, opacity: d.properties.opacity };
        if (!isTextual) { style.width = d.properties.width; style.dash = d.properties.dash; }
        saveToolStyleDefault(d.type, style);
        (this.tiles || []).forEach((t) => { if (t.drawingMgr) t.drawingMgr.styleOverrides[d.type] = style; });
        if (typeof showToast === "function") showToast(`Стиль «${CE.Drawings.TOOL_DEFS[d.type].label}» по умолчанию сохранён`, "success");
      };
      panel.querySelector("#propDuplicate").onclick = () => dm.duplicateDrawing(d.id);
      panel.querySelector("#propDelete").onclick = () => dm.removeDrawing(d.id);
    },

    _renderObjects() {
      const panel = this.root.querySelector("#caObjects");
      const dm = this.drawingMgr;
      const drawings = dm ? dm.drawings : [];
      this.root.querySelector('.ca-side-tab[data-side="objects"]').textContent = `Объекты (${drawings.length})`;
      panel.innerHTML = drawings.length
        ? drawings.map((d) => `
            <div class="ca-object-row ${d.id === dm.selectedId ? "active" : ""}" data-obj="${d.id}">
              <span>${d.properties.label ? escapeAttr(d.properties.label) : CE.Drawings.TOOL_DEFS[d.type].label}</span>
              <span class="ca-object-actions">
                <button data-toggle-hidden="${d.id}" title="Показать/скрыть">${d.hidden ? "🙈" : "👁"}</button>
                <button data-toggle-locked="${d.id}" title="Заблокировать">${d.locked ? "🔒" : "🔓"}</button>
                <button data-rename="${d.id}" title="Переименовать">✎</button>
                <button data-remove="${d.id}" title="Удалить">🗑</button>
              </span>
            </div>`).join("")
        : `<div class="muted-note">Пока нет объектов разметки.</div>`;
      panel.querySelectorAll("[data-obj]").forEach((row) => (row.onclick = (e) => { if (!e.target.closest("button")) dm.select(row.dataset.obj); }));
      panel.querySelectorAll("[data-toggle-hidden]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const d = dm.drawings.find((x) => x.id === b.dataset.toggleHidden); dm.updateDrawing(d.id, { hidden: !d.hidden }); }));
      panel.querySelectorAll("[data-toggle-locked]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const d = dm.drawings.find((x) => x.id === b.dataset.toggleLocked); dm.updateDrawing(d.id, { locked: !d.locked }); }));
      panel.querySelectorAll("[data-rename]").forEach((b) => (b.onclick = (e) => {
        e.stopPropagation();
        const d = dm.drawings.find((x) => x.id === b.dataset.rename);
        const name = prompt("Название объекта", d.properties.label || "");
        if (name != null) dm.updateDrawing(d.id, { properties: { label: name } });
      }));
      panel.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); dm.removeDrawing(b.dataset.remove); }));
    },
  };

  // ---------------------------------------------- per-tool style defaults --
  // TradingView lets you set a drawing tool's default style once (right-
  // click a tool -> Template -> "Save as default") so every future trend
  // line, say, starts red/2px without re-styling each one. Previously the
  // only place style persisted here was whole-chart templates (saveAsTemplate
  // above), which bundle layout+indicators+drawings together - there was no
  // way to set "new trend lines default to red" independent of one specific
  // chart. See _renderProps' propSetDefault button and DrawingManager's
  // styleOverrides (chart-engine/drawings.js).
  const TOOL_STYLE_DEFAULTS_KEY = "moexlab_tool_style_defaults";
  function loadToolStyleDefaults() {
    try { return JSON.parse(localStorage.getItem(TOOL_STYLE_DEFAULTS_KEY) || "{}"); } catch (e) { return {}; }
  }
  function saveToolStyleDefault(type, style) {
    const all = loadToolStyleDefaults();
    all[type] = style;
    try { localStorage.setItem(TOOL_STYLE_DEFAULTS_KEY, JSON.stringify(all)); } catch (e) { /* storage unavailable */ }
  }
  // --------------------------------------- price-axis tap-to-alert gesture --
  // TradingView's signature alert gesture: tap the right-edge price axis to
  // open the alert form pre-filled with the price under the tap. A real
  // drag on the axis is left completely alone (never preventDefault/
  // stopPropagation) so lightweight-charts' own native manual-scale-drag
  // interaction keeps working exactly as before - only a clean, short,
  // near-stationary tap is treated as "create an alert here".
  const PRICE_AXIS_TAP_MAX_MOVE_PX = 5;
  const PRICE_AXIS_TAP_MAX_MS = 400;
  const PRICE_AXIS_FALLBACK_WIDTH_PX = 56;
  function bindPriceAxisAlertGesture(tile) {
    const host = tile.el && tile.el.querySelector('[data-role="chartHost"]');
    if (!host || host._priceAxisAlertBound) return;
    host._priceAxisAlertBound = true;
    let down = null;
    host.addEventListener("pointerdown", (e) => {
      const rect = host.getBoundingClientRect();
      let axisWidth = PRICE_AXIS_FALLBACK_WIDTH_PX;
      try { axisWidth = tile.core.chart.priceScale("right").width() || PRICE_AXIS_FALLBACK_WIDTH_PX; } catch (err) { /* older/odd lightweight-charts build */ }
      if (e.clientX > rect.right || rect.right - e.clientX > axisWidth) { down = null; return; }
      down = { x: e.clientX, y: e.clientY, time: Date.now() };
    }, { passive: true });
    host.addEventListener("pointerup", (e) => {
      if (!down) return;
      const info = down;
      down = null;
      if (Math.hypot(e.clientX - info.x, e.clientY - info.y) > PRICE_AXIS_TAP_MAX_MOVE_PX) return;
      if (Date.now() - info.time > PRICE_AXIS_TAP_MAX_MS) return;
      let price = null;
      try { price = tile.core.candleSeries.coordinateToPrice(e.clientY - host.getBoundingClientRect().top); } catch (err) { /* series not ready */ }
      if (price == null || !Number.isFinite(price)) return;
      Page._openAlertPopoverWithPrice(tile, price);
    }, { passive: true });
  }

  // ------------------------------------------------------ context menu ----
  // TradingView-standard right-click affordances - previously the only
  // context menu anywhere in this module was on the watchlist; the chart
  // canvas and its drawings had none at all.
  function closeContextMenu() {
    const menu = document.getElementById("caContextMenu");
    if (menu) menu.remove();
  }
  function buildContextMenuItems(tile, hit, coordPoint) {
    const dm = tile.drawingMgr;
    if (hit && dm) {
      const d = dm.drawings.find((x) => x.id === hit.id);
      if (!d) return [];
      return [
        { label: "Настройки", onClick: () => {
          if (typeof Page._setBottomCollapsed === "function") Page._setBottomCollapsed(false);
          const tab = Page.root.querySelector('.ca-side-tab[data-side="props"]');
          if (tab) tab.click();
        } },
        { label: "Дублировать (Ctrl+D)", onClick: () => dm.duplicateDrawing(d.id) },
        { label: d.hidden ? "Показать" : "Скрыть", onClick: () => dm.updateDrawing(d.id, { hidden: !d.hidden }) },
        { label: d.locked ? "Разблокировать" : "Заблокировать", onClick: () => dm.updateDrawing(d.id, { locked: !d.locked }) },
        { separator: true },
        { label: "Удалить", danger: true, onClick: () => dm.removeDrawing(d.id) },
      ];
    }
    return [
      { label: "Добавить алерт здесь", onClick: () => { if (coordPoint && Number.isFinite(coordPoint.price)) Page._openAlertPopoverWithPrice(tile, coordPoint.price); } },
      { label: "Добавить горизонтальную линию", onClick: () => { if (dm && coordPoint && Number.isFinite(coordPoint.price)) dm.addDrawing("horizontal_line", [{ time: coordPoint.time, price: coordPoint.price }]); } },
      { separator: true },
      { label: "Сбросить масштаб", onClick: () => tile.core && tile.core.fitContent() },
      { label: "Снимок графика", onClick: () => Page._downloadSnapshot && Page._downloadSnapshot() },
    ];
  }
  function openContextMenu(tile, clientX, clientY, host) {
    closeContextMenu();
    if (tile !== Page.activeTile) Page._setActiveTile(tile.id);
    const rect = host.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const dm = tile.drawingMgr;
    const hit = dm ? dm.hitTest(px, py) : null;
    if (hit) dm.select(hit.id);
    let coordPoint = null;
    try { coordPoint = dm ? dm.pixelToPoint(px, py) : null; } catch (err) { /* off-chart click */ }
    const items = buildContextMenuItems(tile, hit, coordPoint);
    if (!items.length) return;
    const menu = document.createElement("div");
    menu.id = "caContextMenu";
    menu.className = "ca-context-menu";
    menu.innerHTML = items.map((item, i) => item.separator
      ? `<div class="ca-context-sep"></div>`
      : `<button type="button" class="ca-context-item ${item.danger ? "danger" : ""}" data-idx="${i}">${item.label}</button>`
    ).join("");
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - menuRect.width - 8;
    const maxTop = window.innerHeight - menuRect.height - 8;
    menu.style.left = `${Math.max(4, Math.min(clientX, maxLeft))}px`;
    menu.style.top = `${Math.max(4, Math.min(clientY, maxTop))}px`;
    menu.querySelectorAll("[data-idx]").forEach((btn) => {
      btn.onclick = () => {
        const item = items[Number(btn.dataset.idx)];
        closeContextMenu();
        if (item && item.onClick) item.onClick();
      };
    });
    setTimeout(() => {
      document.addEventListener("pointerdown", function onOutside(e) {
        if (!menu.contains(e.target)) { closeContextMenu(); document.removeEventListener("pointerdown", onOutside, true); }
      }, true);
      document.addEventListener("keydown", function onKey(e) {
        if (e.key === "Escape") { closeContextMenu(); document.removeEventListener("keydown", onKey, true); }
      }, true);
    }, 0);
  }
  function bindContextMenu(tile) {
    const host = tile.el && tile.el.querySelector('[data-role="chartHost"]');
    if (!host || host._contextMenuBound) return;
    host._contextMenuBound = true;
    host.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenu(tile, e.clientX, e.clientY, host);
    });
  }

  if (CE.ChartTile && CE.ChartTile.prototype && typeof CE.ChartTile.prototype.mount === "function") {
    const originalTileMountForStyles = CE.ChartTile.prototype.mount;
    CE.ChartTile.prototype.mount = function (container) {
      const result = originalTileMountForStyles.apply(this, arguments);
      if (this.drawingMgr) this.drawingMgr.styleOverrides = loadToolStyleDefaults();
      bindPriceAxisAlertGesture(this);
      bindContextMenu(this);
      return result;
    };
  }

  global.ChartAnalysisPage = Page;
})(window);
