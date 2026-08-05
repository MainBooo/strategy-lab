/* MarketAnalysisChartAdapter: the free-form "Анализ графиков" page.
 * Candles come from the generic /api/candles endpoint (real MOEX data,
 * downloaded on demand and cached server-side - see candle_api.py).
 * Drawings/layouts are persisted per-object through /api/chart-layouts
 * and /api/chart-drawings (see charts_db.py) with a debounced autosave;
 * this file never keeps drawing state only in localStorage.
 *
 * The page is a workspace of one or more independent chart tiles
 * (ChartEngine.ChartTile, chart-engine/chart-tile.js) laid out in a grid.
 * Each tile now owns its OWN full settings header (symbol/board/timeframe/
 * chart type/range/indicators/templates/save/live subscription) - this file
 * only owns what's genuinely workspace-level: the layout switch, the
 * watchlist sidebar, the drawing tool palette + undo/redo/snap + the
 * properties/objects side panel (all of which act on whichever tile is
 * *active*), the optional cross-tile range/crosshair sync, and workspace
 * fullscreen. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;

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

    get activeTile() {
      return this.tiles.find((t) => t.id === this.activeTileId) || this.tiles[0] || null;
    },
    // Kept for the drawing toolbar / side panel below, which act on
    // whichever tile is active - everything else (symbol, timeframe, range,
    // indicators, templates, save, live) now lives on ChartTile itself.
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
      }
      // Runs every time this tab becomes active (not just the first build) -
      // see onTabLeave() below and activateTab() in app.js, which calls
      // init() on every visit but only stops polling on the way out.
      this.tiles.forEach((t) => t.startRealtime());
    },

    onTabLeave() {
      this.tiles.forEach((t) => t.stopRealtime());
    },

    async _loadSecurities() {
      try {
        this.securities = await fetch("/api/securities").then((r) => r.json());
        this.tiles.forEach((t) => t.setSecurities(this.securities));
      } catch (e) { /* securities catalog is optional here - manual ticker entry still works via prompt fallback */ }
    },

    _build() {
      this.root.innerHTML = `
        <div class="ca-toolbar">
          <div class="ca-layout-switch" id="caLayoutSwitch">
            ${LAYOUTS.map((l) => `
              <button class="ca-layout-btn ${l.id === this.layoutMode ? "active" : ""}" data-layout="${l.id}" title="${l.label}" aria-label="${l.label}">
                <span class="ca-layout-icon" style="grid-template-columns:repeat(${l.cols},1fr);grid-template-rows:repeat(${l.rows},1fr)">
                  ${Array.from({ length: l.rows * l.cols }).map(() => "<i></i>").join("")}
                </span>
              </button>`).join("")}
          </div>
          <span class="ca-toolbar-spacer"></span>
          <button class="icon-btn" id="caUndoBtn" title="Отменить (Ctrl+Z)">↶</button>
          <button class="icon-btn" id="caRedoBtn" title="Повторить (Ctrl+Shift+Z)">↷</button>
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

      this.root.querySelectorAll(".ca-layout-btn").forEach((b) => (b.onclick = () => this._setLayout(b.dataset.layout)));

      let watchlistCollapsed = false;
      try { watchlistCollapsed = localStorage.getItem("moexlab_watchlist_collapsed") === "1"; } catch (e) { /* ignore */ }
      this.watchlist = new global.WatchlistSidebar(this.root.querySelector("#caWatchlist"), {
        collapsed: watchlistCollapsed,
        onSelect: (ticker) => { if (this.activeTile) this.activeTile.selectSymbol(ticker); },
        mobileBackdrop: this.root.querySelector("#caWatchlistBackdrop"),
      });
      if (this.activeTile) this.watchlist.setActive(this.activeTile.symbol);
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
          tile.setSecurities(this.securities);
          tile.drawingMgr.onChange(() => {
            if (tile.id === this.activeTileId) { this._renderProps(); this._renderObjects(); }
          });
          tile.onRangeChange((range) => { if (this.syncEnabled) this._broadcastRange(tile, range); });
          tile.onCrosshairMove((time, price) => { if (this.syncEnabled) this._broadcastCrosshair(tile, time, price); });
          tile.onStateChanged((t, detail) => {
            this._saveWorkspaceState();
            if (t.id === this.activeTileId && this.watchlist) this.watchlist.setActive(t.symbol);
          });
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
        const cfg = this._archivedTiles.pop() || (active ? { symbol: active.symbol, board: active.board, timeframe: active.timeframe } : {});
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
      this._syncActiveLayoutButton();
      this._syncTileGrid();
      this._saveWorkspaceState();
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
      this._renderProps();
      this._renderObjects();
      this._saveWorkspaceState();
    },

    _syncActiveLayoutButton() {
      this.root.querySelectorAll(".ca-layout-btn").forEach((b) => b.classList.toggle("active", b.dataset.layout === this.layoutMode));
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

    // --------------------------------------------------------- misc UI ---

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
