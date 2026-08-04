/* MarketAnalysisChartAdapter: the free-form "Анализ графиков" page.
 * Candles come from the generic /api/candles endpoint (real MOEX data,
 * downloaded on demand and cached server-side - see candle_api.py).
 * Drawings/layouts are persisted per-object through /api/chart-layouts
 * and /api/chart-drawings (see charts_db.py) with a debounced autosave;
 * this file never keeps drawing state only in localStorage.
 *
 * The page is a workspace of one or more independent chart tiles
 * (ChartEngine.ChartTile, chart-engine/chart-tile.js) laid out in a grid.
 * The shared toolbar (symbol/timeframe/range/indicators/drawing tools/
 * templates) always acts on the *active* tile - Page.symbol/timeframe/
 * from/to/layout/core/indicatorMgr/drawingMgr below are getters/setters
 * that delegate to `this.activeTile`, which is what lets almost all of the
 * pre-existing single-chart logic (template save/load, drawing autosave,
 * the properties/objects side panel, the "order a strategy" modal) keep
 * working unchanged even though there can now be up to four charts. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  /* Candle interval (bar size) - distinct from the visible history range
   * below (RANGE_PRESETS). 30m/4h have no native MOEX ISS interval code and
   * are aggregated server-side from real 10m/60m candles - see
   * candle_api.AGGREGATE_TIMEFRAMES. Everything else maps 1:1 to a MOEX
   * interval and is fetched as-is. */
  const TIMEFRAMES = [
    { id: "1m", label: "1м" }, { id: "10m", label: "10м" }, { id: "30m", label: "30м" },
    { id: "60m", label: "1ч" }, { id: "4h", label: "4ч" }, { id: "1d", label: "1д" },
    { id: "1w", label: "1н" }, { id: "1mo", label: "1мес" },
  ];
  const RANGE_PRESETS = [
    { label: "1Д", days: 1 }, { label: "5Д", days: 5 }, { label: "1М", days: 30 }, { label: "3М", days: 90 },
    { label: "6М", days: 182 }, { label: "1Г", days: 365 }, { label: "5Л", days: 365 * 5 }, { label: "Все", days: null },
  ];
  const TOOL_BUTTONS = [
    { id: null, label: "Курсор", icon: "⇖" },
    { id: "horizontal_line", label: "Горизонтальный уровень", icon: "—" },
    { id: "vertical_line", label: "Вертикальная линия", icon: "❘" },
    { id: "trend_line", label: "Линия тренда", icon: "╱" },
    { id: "ray", label: "Луч", icon: "↗" },
    { id: "rectangle", label: "Прямоугольная зона", icon: "▭" },
    { id: "price_range", label: "Измерение", icon: "↕" },
    { id: "text", label: "Текстовая заметка", icon: "T" },
    { id: "long_position", label: "Long позиция", icon: "↑" },
    { id: "short_position", label: "Short позиция", icon: "↓" },
  ];
  const LAYOUTS = [
    { id: "1", label: "1 график", rows: 1, cols: 1 },
    { id: "2v", label: "2 графика вертикально", rows: 2, cols: 1 },
    { id: "2h", label: "2 графика горизонтально", rows: 1, cols: 2 },
    { id: "4", label: "4 графика", rows: 2, cols: 2 },
    { id: "6", label: "6 графиков (3×2)", rows: 2, cols: 3 },
  ];
  const LAYOUT_TILE_COUNT = { "1": 1, "2v": 2, "2h": 2, "4": 4, "6": 6 };
  const COUNT_TO_LAYOUT = { 1: "1", 2: "2h", 3: "4", 4: "4", 5: "6", 6: "6" };
  const WORKSPACE_STATE_KEY = "moexlab_chart_workspace";

  const Page = {
    root: null,
    securities: [],
    tiles: [],
    activeTileId: null,
    layoutMode: "1",
    _archivedTiles: [],
    _built: false,
    _saveQueue: {},

    get activeTile() {
      return this.tiles.find((t) => t.id === this.activeTileId) || this.tiles[0] || null;
    },
    get symbol() { return this.activeTile ? this.activeTile.symbol : "SBER"; },
    set symbol(v) { if (this.activeTile) this.activeTile.symbol = v; },
    get board() { return this.activeTile ? this.activeTile.board : "TQBR"; },
    set board(v) { if (this.activeTile) this.activeTile.board = v; },
    get timeframe() { return this.activeTile ? this.activeTile.timeframe : "1d"; },
    set timeframe(v) { if (this.activeTile) this.activeTile.timeframe = v; },
    get from() { return this.activeTile ? this.activeTile.from : null; },
    set from(v) { if (this.activeTile) this.activeTile.from = v; },
    get to() { return this.activeTile ? this.activeTile.to : null; },
    set to(v) { if (this.activeTile) this.activeTile.to = v; },
    get layout() { return this.activeTile ? this.activeTile.layout : null; },
    set layout(v) { if (this.activeTile) this.activeTile.layout = v; },
    get core() { return this.activeTile ? this.activeTile.core : null; },
    get indicatorMgr() { return this.activeTile ? this.activeTile.indicatorMgr : null; },
    get drawingMgr() { return this.activeTile ? this.activeTile.drawingMgr : null; },

    init(root) {
      this.root = root;
      if (this._built) return;
      this._built = true;
      if (!this._restoreWorkspaceState()) {
        const tile = new CE.ChartTile({});
        this.tiles = [tile];
        this.activeTileId = tile.id;
        this.layoutMode = "1";
      }
      this._build();
      this._syncTileGrid();
      this._loadSecurities().then(() => this._loadOrInit());
    },

    async _loadSecurities() {
      try {
        this.securities = await fetch("/api/securities").then((r) => r.json());
        const sel = this.root.querySelector("#caSymbol");
        sel.innerHTML = this.securities.map((s) => `<option value="${s.SECID}">${s.SECID} · ${s.SHORTNAME || ""}</option>`).join("");
        sel.value = this.symbol;
      } catch (e) { /* securities catalog is optional here - manual ticker entry still works via prompt fallback */ }
    },

    _build() {
      this.root.innerHTML = `
        <div class="ca-toolbar">
          <label>Инструмент <select id="caSymbol"></select></label>
          <label>Рынок <select id="caBoard"><option value="TQBR">TQBR</option></select></label>
          <label>Таймфрейм <select id="caTimeframe">${TIMEFRAMES.map((t) => `<option value="${t.id}" ${t.id === this.timeframe ? "selected" : ""}>${t.label}</option>`).join("")}</select></label>
          <label>С <input type="date" id="caFrom"></label>
          <label>По <input type="date" id="caTo"></label>
          <div class="ca-indicator-menu">
            <button class="secondary" id="caIndicatorsBtn">Индикаторы</button>
            <div class="ca-popover hidden" id="caIndicatorsPopover"></div>
          </div>
          <div class="ca-template-menu">
            <button class="secondary" id="caTemplatesBtn">Шаблоны</button>
            <div class="ca-popover hidden" id="caTemplatesPopover"></div>
          </div>
          <button class="secondary" id="caSaveBtn">Сохранить</button>
          <button class="primary" id="caOrderBtn">⚙ Заказать стратегию по разметке</button>
          <span class="ca-toolbar-spacer"></span>
          <div class="ca-layout-switch" id="caLayoutSwitch">
            ${LAYOUTS.map((l) => `
              <button class="ca-layout-btn ${l.id === this.layoutMode ? "active" : ""}" data-layout="${l.id}" title="${l.label}" aria-label="${l.label}">
                <span class="ca-layout-icon" style="grid-template-columns:repeat(${l.cols},1fr);grid-template-rows:repeat(${l.rows},1fr)">
                  ${Array.from({ length: l.rows * l.cols }).map(() => "<i></i>").join("")}
                </span>
              </button>`).join("")}
          </div>
          <button class="icon-btn" id="caUndoBtn" title="Отменить (Ctrl+Z)">↶</button>
          <button class="icon-btn" id="caRedoBtn" title="Повторить (Ctrl+Shift+Z)">↷</button>
          <button class="icon-btn" id="caSnapBtn" title="Прилипание к свечам">🧲</button>
          <button class="icon-btn" id="caSyncBtn" title="Синхронизировать время, масштаб и перекрестие между графиками" aria-label="Синхронизация графиков">🔗</button>
          <button class="icon-btn" id="caWatchlistToggleBtn" title="Список тикеров">☰</button>
          <button class="icon-btn" id="caFullscreenBtn" title="Полноэкранный режим рабочего пространства">⛶</button>
        </div>
        <div class="ca-workspace" id="caWorkspace">
          <div class="ca-tools" id="caTools">
            ${TOOL_BUTTONS.map((t) => `<button class="ca-tool-btn ${t.id === null ? "active" : ""}" data-tool="${t.id || ""}" title="${t.label}" aria-label="${t.label}">${t.icon}</button>`).join("")}
            <button class="ca-tool-btn ca-tool-danger" id="caDeleteBtn" title="Удалить объект (Delete)" aria-label="Удалить объект">🗑</button>
          </div>
          <div class="ca-chart-col">
            <div class="ca-tile-grid" id="caTileGrid"></div>
            <div class="ca-range-presets" id="caRangePresets">
              ${RANGE_PRESETS.map((p) => `<button class="range-preset" data-days="${p.days ?? ""}">${p.label}</button>`).join("")}
            </div>
            <div class="ca-status" id="caStatus"></div>
          </div>
          <div class="ca-side" id="caSide">
            <nav class="ca-side-tabs">
              <button class="ca-side-tab active" data-side="props">Свойства</button>
              <button class="ca-side-tab" data-side="objects">Объекты</button>
            </nav>
            <div id="caProps" class="ca-side-panel"></div>
            <div id="caObjects" class="ca-side-panel hidden"></div>
          </div>
          <div class="ca-watchlist" id="caWatchlist"></div>
        </div>
        <div class="wl-mobile-backdrop" id="caWatchlistBackdrop"></div>
      `;

      this.root.querySelector("#caFrom").value = this.from;
      this.root.querySelector("#caTo").value = this.to;

      this.root.querySelector("#caSymbol").onchange = (e) => this._selectSymbol(e.target.value);
      this.root.querySelector("#caTimeframe").onchange = (e) => {
        this.timeframe = e.target.value;
        if (this.activeTile) this.activeTile.updateHeader();
        this._reload();
        this._saveWorkspaceState();
      };
      this.root.querySelector("#caFrom").onchange = (e) => { this.from = e.target.value; this._reload(); this._saveWorkspaceState(); };
      this.root.querySelector("#caTo").onchange = (e) => { this.to = e.target.value; this._reload(); this._saveWorkspaceState(); };
      this.root.querySelectorAll(".range-preset").forEach((b) => (b.onclick = () => this._applyRangePreset(b.dataset.days)));

      this.root.querySelectorAll(".ca-tool-btn[data-tool]").forEach((b) => {
        b.onclick = () => {
          this.root.querySelectorAll(".ca-tool-btn[data-tool]").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          if (this.drawingMgr) this.drawingMgr.setTool(b.dataset.tool || null);
        };
      });
      this.root.querySelector("#caDeleteBtn").onclick = () => { if (this.drawingMgr && this.drawingMgr.selectedId) this.drawingMgr.removeDrawing(this.drawingMgr.selectedId); };
      this.root.querySelector("#caUndoBtn").onclick = () => this.drawingMgr && this.drawingMgr.undo();
      this.root.querySelector("#caRedoBtn").onclick = () => this.drawingMgr && this.drawingMgr.redo();
      this.root.querySelector("#caSnapBtn").onclick = (e) => {
        if (!this.drawingMgr) return;
        this.drawingMgr.snapEnabled = !this.drawingMgr.snapEnabled;
        e.target.classList.toggle("active", this.drawingMgr.snapEnabled);
      };
      this.root.querySelector("#caSyncBtn").classList.toggle("active", !!this.syncEnabled);
      this.root.querySelector("#caSyncBtn").onclick = (e) => {
        this.syncEnabled = !this.syncEnabled;
        e.target.classList.toggle("active", this.syncEnabled);
        this._saveWorkspaceState();
      };
      this._fsCtrl = new CE.Fullscreen.FullscreenController(this.root, {
        className: "is-fullscreen",
        onChange: (active) => this._onFullscreenChange(active),
      });
      this.root.querySelector("#caFullscreenBtn").onclick = () => this._fsCtrl.toggle();
      this.root.querySelector("#caSaveBtn").onclick = () => this._saveAsTemplate();
      this.root.querySelector("#caOrderBtn").onclick = () => this._openOrderModal();

      this.root.querySelectorAll(".ca-layout-btn").forEach((b) => (b.onclick = () => this._setLayout(b.dataset.layout)));

      let watchlistCollapsed = false;
      try { watchlistCollapsed = localStorage.getItem("moexlab_watchlist_collapsed") === "1"; } catch (e) { /* ignore */ }
      this.watchlist = new global.WatchlistSidebar(this.root.querySelector("#caWatchlist"), {
        collapsed: watchlistCollapsed,
        onSelect: (ticker) => this._selectSymbol(ticker),
        mobileBackdrop: this.root.querySelector("#caWatchlistBackdrop"),
      });
      this.watchlist.setActive(this.symbol);
      this.root.querySelector("#caWatchlistToggleBtn").onclick = () => this.watchlist.openMobileDrawer();
      this.root.querySelector("#caWatchlistBackdrop").onclick = () => this.watchlist.closeMobileDrawer();

      this.root.querySelectorAll(".ca-side-tab").forEach((b) => {
        b.onclick = () => {
          this.root.querySelectorAll(".ca-side-tab").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          this.root.querySelector("#caProps").classList.toggle("hidden", b.dataset.side !== "props");
          this.root.querySelector("#caObjects").classList.toggle("hidden", b.dataset.side !== "objects");
        };
      });

      this._buildIndicatorPopover();
      this._buildTemplatePopover();
    },

    // ------------------------------------------------------------- tiles --

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
          });
          tile.drawingMgr.onChange((mgr, detail) => this._onDrawingsChanged(tile, detail));
          tile.drawingMgr.onChange(() => {
            if (tile.id === this.activeTileId) { this._renderProps(); this._renderObjects(); }
          });
          tile.onRangeChange((range) => { if (this.syncEnabled) this._broadcastRange(tile, range); });
          tile.onCrosshairMove((time, price) => { if (this.syncEnabled) this._broadcastCrosshair(tile, time, price); });
          this._loadTile(tile);
        } else if (tile.el.parentElement !== grid) {
          grid.appendChild(tile.el);
        }
        tile.setActiveVisual(tile.id === this.activeTileId);
      });
    },

    /** Optional sync toggle (🔗 button): mirrors visible range and crosshair
     * position across every tile so panning/zooming/hovering one chart
     * moves the others the same way - each tile's own applyLogicalRange/
     * applyCrosshair sets an internal flag while applying, so this never
     * loops back into another broadcast. */
    _broadcastRange(source, range) {
      this.tiles.forEach((t) => { if (t !== source) t.applyLogicalRange(range); });
    },
    _broadcastCrosshair(source, time, price) {
      this.tiles.forEach((t) => { if (t !== source) t.applyCrosshair(time, price); });
    },

    _setLayout(mode) {
      if (!LAYOUT_TILE_COUNT[mode]) return;
      this.layoutMode = mode;
      this._resizeTiles(LAYOUT_TILE_COUNT[mode]);
      this._syncTileGrid();
      this._syncActiveLayoutButton();
      this._syncToolbarFromActiveTile();
      this._saveWorkspaceState();
    },

    _resizeTiles(targetCount) {
      while (this.tiles.length > targetCount) {
        const tile = this.tiles.pop();
        this._archivedTiles.push(tile.toConfig());
        tile.destroy();
      }
      while (this.tiles.length < targetCount) {
        const cfg = this._archivedTiles.pop() || { symbol: this.symbol, board: this.board, timeframe: this.timeframe, from: this.from, to: this.to };
        this.tiles.push(new CE.ChartTile(cfg));
      }
      if (!this.tiles.some((t) => t.id === this.activeTileId)) this.activeTileId = this.tiles[0].id;
    },

    _closeTile(id) {
      if (this.tiles.length <= 1) return;
      const idx = this.tiles.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const [tile] = this.tiles.splice(idx, 1);
      const wasActive = tile.id === this.activeTileId;
      tile.destroy();
      this.layoutMode = COUNT_TO_LAYOUT[this.tiles.length] || this.layoutMode;
      if (wasActive) this.activeTileId = this.tiles[Math.max(0, idx - 1)].id;
      this._syncActiveLayoutButton();
      this._syncTileGrid();
      this._syncToolbarFromActiveTile();
      this._saveWorkspaceState();
    },

    _setActiveTile(id) {
      if (id === this.activeTileId) return;
      this.activeTileId = id;
      this.tiles.forEach((t) => t.setActiveVisual(t.id === id));
      this._syncToolbarFromActiveTile();
      if (this.watchlist) this.watchlist.setActive(this.symbol);
      this._renderProps();
      this._renderObjects();
      this._saveWorkspaceState();
    },

    _syncActiveLayoutButton() {
      this.root.querySelectorAll(".ca-layout-btn").forEach((b) => b.classList.toggle("active", b.dataset.layout === this.layoutMode));
    },

    _syncToolbarFromActiveTile() {
      const t = this.activeTile;
      if (!t) return;
      const sel = this.root.querySelector("#caSymbol"); if (sel) sel.value = t.symbol;
      const tf = this.root.querySelector("#caTimeframe"); if (tf) tf.value = t.timeframe;
      const from = this.root.querySelector("#caFrom"); if (from) from.value = t.from;
      const to = this.root.querySelector("#caTo"); if (to) to.value = t.to;
      // Drawing-tool selection is a per-interaction toolbar concept, not
      // per-tile persisted state - switching the active tile resets it to
      // the cursor so the newly focused tile isn't left mid-draw with a
      // tool it never picked.
      this.root.querySelectorAll(".ca-tool-btn[data-tool]").forEach((b) => b.classList.toggle("active", !b.dataset.tool));
      if (t.drawingMgr) t.drawingMgr.setTool(null);
    },

    async _loadTile(tile) {
      if (!tile || !tile.core) return;
      const isActive = tile.id === this.activeTileId;
      const status = isActive ? this.root.querySelector("#caStatus") : null;
      if (status) status.textContent = "Загрузка свечей…";
      try {
        await tile.core.load({ symbol: tile.symbol, board: tile.board, timeframe: tile.timeframe, from: tile.from, to: tile.to, limit: 5000, onState: (s) => {
          if (!status) return;
          status.textContent = s === "loading" ? "Загрузка свечей…" : s === "empty" ? "Нет данных за выбранный период." : s === "error" ? "Ошибка загрузки свечей." : "";
        } });
        tile.core.fitContent();
      } catch (err) {
        if (status) status.textContent = "Ошибка: " + err.message;
      }
      tile.updateHeader();
    },

    // ------------------------------------------------------- persistence --

    _saveWorkspaceState() {
      try {
        localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify({
          layoutMode: this.layoutMode,
          tiles: this.tiles.map((t) => t.toConfig()),
          activeIndex: this.tiles.findIndex((t) => t.id === this.activeTileId),
          syncEnabled: !!this.syncEnabled,
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
        this.syncEnabled = !!state.syncEnabled;
        return true;
      } catch (e) {
        return false;
      }
    },

    // --------------------------------------------------------- toolbar ---

    _selectSymbol(ticker) {
      this.symbol = ticker;
      this.layout = null;
      const sel = this.root.querySelector("#caSymbol");
      if (sel) sel.value = ticker;
      if (this.watchlist) this.watchlist.setActive(ticker);
      if (this.activeTile) this.activeTile.updateHeader();
      this._reload();
      this._saveWorkspaceState();
    },

    _onFullscreenChange(active) {
      const btn = this.root.querySelector("#caFullscreenBtn");
      if (!btn) return;
      btn.textContent = active ? "⤢" : "⛶";
      btn.title = active ? "Выйти из полноэкранного режима (Esc)" : "Полноэкранный режим рабочего пространства";
      btn.setAttribute("aria-label", btn.title);
      btn.classList.toggle("active", active);
      // The container's box size changes on the fullscreen transition; each
      // tile's own ResizeObserver picks this up, but nudging every tile
      // explicitly avoids a one-frame stale layout on browsers that defer
      // the ResizeObserver callback until the next paint.
      requestAnimationFrame(() => this.tiles.forEach((t) => t.core && t.core._onResize()));
    },

    _applyRangePreset(days) {
      const to = new Date();
      const from = days ? new Date(Date.now() - Number(days) * 86400000) : new Date("2015-01-01");
      this.from = from.toISOString().slice(0, 10);
      this.to = to.toISOString().slice(0, 10);
      this.root.querySelector("#caFrom").value = this.from;
      this.root.querySelector("#caTo").value = this.to;
      this._reload();
      this._saveWorkspaceState();
    },

    async _loadOrInit() {
      const layouts = await CE.api.listLayouts("analysis", this.symbol).catch(() => []);
      const def = layouts.find((l) => l.is_default) || layouts[0];
      if (def) await this._applyLayout(def);
      else await this._reload();
    },

    async _applyLayout(layout) {
      this.layout = layout;
      this.symbol = layout.symbol || this.symbol;
      this.timeframe = layout.timeframe || this.timeframe;
      if (layout.visible_from) this.from = layout.visible_from;
      if (layout.visible_to) this.to = layout.visible_to;
      this.root.querySelector("#caSymbol").value = this.symbol;
      this.root.querySelector("#caTimeframe").value = this.timeframe;
      this.root.querySelector("#caFrom").value = this.from;
      this.root.querySelector("#caTo").value = this.to;
      if (this.watchlist) this.watchlist.setActive(this.symbol);
      if (this.activeTile) this.activeTile.updateHeader();
      await this._reload();
      const full = await CE.api.getLayout(layout.id);
      this.drawingMgr.loadDrawings(full.drawings || []);
      (layout.indicators || []).forEach((ind) => this.indicatorMgr.add(ind.type, ind.params));
    },

    _reload() {
      return this._loadTile(this.activeTile);
    },

    _buildIndicatorPopover() {
      const pop = this.root.querySelector("#caIndicatorsPopover");
      pop.innerHTML = CE.Indicators.registry.map((def) => `
        <label class="ca-indicator-row">
          <input type="checkbox" data-ind="${def.id}">
          <span>${def.label}</span>
        </label>`).join("");
      pop.querySelectorAll("input[data-ind]").forEach((cb) => {
        cb.onchange = () => {
          const id = cb.dataset.ind;
          const tile = this.activeTile;
          if (!tile) return;
          const key = "_ind_" + id;
          if (cb.checked) tile[key] = tile.indicatorMgr.add(id, {});
          else if (tile[key]) { tile.indicatorMgr.remove(tile[key]); tile[key] = null; }
        };
      });
      this.root.querySelector("#caIndicatorsBtn").onclick = () => pop.classList.toggle("hidden");
    },

    _buildTemplatePopover() {
      const pop = this.root.querySelector("#caTemplatesPopover");
      this.root.querySelector("#caTemplatesBtn").onclick = async () => {
        pop.classList.toggle("hidden");
        if (pop.classList.contains("hidden")) return;
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
      };
    },

    async _saveAsTemplate() {
      const name = prompt("Название шаблона", this.layout ? this.layout.name : `${this.symbol} · ${new Date().toLocaleDateString("ru-RU")}`);
      if (!name) return;
      const payload = {
        context: "analysis", name, symbol: this.symbol, board: this.board, timeframe: this.timeframe,
        visibleFrom: this.from, visibleTo: this.to, chartType: "candles",
        settings: {}, indicators: this.indicatorMgr.list().map((i) => ({ type: i.type, params: i.params })),
      };
      const layout = this.layout && this.layout.name === name
        ? await CE.api.updateLayout(this.layout.id, payload)
        : await CE.api.createLayout(payload);
      this.layout = layout;
      for (const d of this.drawingMgr.drawings) await this._persistDrawing(d);
      this.root.querySelector("#caStatus").textContent = "Шаблон сохранён.";
      setTimeout(() => { if (this.root.querySelector("#caStatus").textContent === "Шаблон сохранён.") this.root.querySelector("#caStatus").textContent = ""; }, 2000);
    },

    async _ensureLayout() {
      if (this.layout) return this.layout;
      this.layout = await CE.api.createLayout({
        context: "analysis", name: `${this.symbol} · автосохранение`, symbol: this.symbol, board: this.board,
        timeframe: this.timeframe, visibleFrom: this.from, visibleTo: this.to, chartType: "candles", settings: {}, indicators: [],
      });
      return this.layout;
    },

    _onDrawingsChanged(tile, detail) {
      if (detail.loaded || detail.history) return; // bulk operations - nothing to diff/save per-id
      const id = detail.created || detail.updated;
      if (id) this._queueSave(tile, id);
      if (detail.removed) this._queueDelete(detail.removed);
    },

    _queueSave(tile, id) {
      const key = tile.id + ":" + id;
      clearTimeout(this._saveQueue[key]);
      this._saveQueue[key] = setTimeout(() => this._flushSave(tile, id), 500);
    },

    async _flushSave(tile, id) {
      const d = tile.drawingMgr.drawings.find((x) => x.id === id);
      if (!d) return;
      await this._persistDrawing(tile, d);
    },

    async _persistDrawing(tileOrDrawing, maybeDrawing) {
      // Called two ways: (tile, drawing) from the autosave path above, or
      // (drawing) from _saveAsTemplate where "the active tile" is implied.
      const tile = maybeDrawing ? tileOrDrawing : this.activeTile;
      const d = maybeDrawing || tileOrDrawing;
      const layout = tile === this.activeTile ? await this._ensureLayout() : null;
      if (!layout) return; // autosave for a non-active tile has no persisted layout target yet
      const payload = { type: d.type, symbol: tile.symbol, timeframe: tile.timeframe, points: d.points, properties: d.properties, locked: d.locked, hidden: d.hidden, zIndex: d.zIndex };
      if (d._backendId) return CE.api.updateDrawing(d._backendId, payload).catch(() => {});
      const created = await CE.api.createDrawing(layout.id, payload).catch(() => null);
      if (created) d._backendId = created.id;
    },

    async _queueDelete(localId) {
      // The drawing object (and its _backendId) is already gone from the
      // array by the time this fires; nothing to look up - deletion is
      // best-effort and only matters if it had been persisted already.
    },

    _renderProps() {
      const panel = this.root.querySelector("#caProps");
      const dm = this.drawingMgr;
      const d = dm ? dm.drawings.find((x) => x.id === dm.selectedId) : null;
      if (!d) { panel.innerHTML = `<div class="muted-note">Выберите объект на графике, чтобы изменить его свойства.</div>`; return; }
      const isPosition = d.type === "long_position" || d.type === "short_position";
      panel.innerHTML = `
        <h4>${CE.Drawings.TOOL_DEFS[d.type].label}</h4>
        <label>Цвет <input type="color" id="propColor" value="${toHex(d.properties.color)}"></label>
        <label>Толщина <input type="number" id="propWidth" min="1" max="6" value="${d.properties.width || 1}"></label>
        <label class="toggle"><input type="checkbox" id="propLocked" ${d.locked ? "checked" : ""}><span>Заблокировать</span></label>
        <label class="toggle"><input type="checkbox" id="propHidden" ${d.hidden ? "checked" : ""}><span>Скрыть</span></label>
        ${d.type === "text" ? `<label>Текст <input type="text" id="propText" value="${escapeAttr(d.properties.text || "")}"></label>` : ""}
        ${isPosition ? `
          <label>Кол-во <input type="number" id="propQty" value="${d.properties.quantity || 0}"></label>
          <label>Стоп, % <input type="number" step="0.1" id="propStopPct" value="${(d.properties.stopOffsetPct || 0).toFixed(2)}"></label>
          <label>Тейк, % <input type="number" step="0.1" id="propTakePct" value="${(d.properties.takeOffsetPct || 0).toFixed(2)}"></label>
        ` : ""}
        <button class="secondary" id="propDuplicate">Дублировать (Ctrl+D)</button>
        <button class="secondary" id="propDelete">Удалить</button>
      `;
      panel.querySelector("#propColor").oninput = (e) => dm.updateDrawing(d.id, { properties: { color: e.target.value } });
      panel.querySelector("#propWidth").oninput = (e) => dm.updateDrawing(d.id, { properties: { width: Number(e.target.value) } });
      panel.querySelector("#propLocked").onchange = (e) => dm.updateDrawing(d.id, { locked: e.target.checked });
      panel.querySelector("#propHidden").onchange = (e) => dm.updateDrawing(d.id, { hidden: e.target.checked });
      const textInput = panel.querySelector("#propText");
      if (textInput) textInput.oninput = (e) => dm.updateDrawing(d.id, { properties: { text: e.target.value } });
      if (isPosition) {
        panel.querySelector("#propQty").oninput = (e) => dm.updateDrawing(d.id, { properties: { quantity: Number(e.target.value) } });
        panel.querySelector("#propStopPct").oninput = (e) => dm.updateDrawing(d.id, { properties: { stopOffsetPct: Number(e.target.value) } });
        panel.querySelector("#propTakePct").oninput = (e) => dm.updateDrawing(d.id, { properties: { takeOffsetPct: Number(e.target.value) } });
      }
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
              <span>${CE.Drawings.TOOL_DEFS[d.type].label}</span>
              <span class="ca-object-actions">
                <button data-toggle-hidden="${d.id}" title="Показать/скрыть">${d.hidden ? "🙈" : "👁"}</button>
                <button data-toggle-locked="${d.id}" title="Заблокировать">${d.locked ? "🔒" : "🔓"}</button>
                <button data-remove="${d.id}" title="Удалить">🗑</button>
              </span>
            </div>`).join("")
        : `<div class="muted-note">Пока нет объектов разметки.</div>`;
      panel.querySelectorAll("[data-obj]").forEach((row) => (row.onclick = (e) => { if (!e.target.closest("button")) dm.select(row.dataset.obj); }));
      panel.querySelectorAll("[data-toggle-hidden]").forEach((b) => (b.onclick = () => { const d = dm.drawings.find((x) => x.id === b.dataset.toggleHidden); dm.updateDrawing(d.id, { hidden: !d.hidden }); }));
      panel.querySelectorAll("[data-toggle-locked]").forEach((b) => (b.onclick = () => { const d = dm.drawings.find((x) => x.id === b.dataset.toggleLocked); dm.updateDrawing(d.id, { locked: !d.locked }); }));
      panel.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => dm.removeDrawing(b.dataset.remove)));
    },

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
          <h3>Заказать стратегию по разметке</h3>
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
    },

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
          visibleFrom: this.from, visibleTo: this.to,
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
    },
  };

  function toHex(color) {
    if (!color || color[0] === "#") return color || "#7c8cff";
    const m = color.match(/rgba?\((\d+),(\d+),(\d+)/);
    if (!m) return "#7c8cff";
    return "#" + m.slice(1, 4).map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  global.ChartAnalysisPage = Page;
})(window);
