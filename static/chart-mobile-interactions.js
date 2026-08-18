/* TradingView-style drawing editor chrome for the free-form chart workspace.
 * Pointer ownership, creation/edit state transitions, drafts, gesture
 * thresholds and capture live in chart-engine/drawings.js. The tool rail
 * itself lives in chart-editor-terminal-mobile-v2.js; this module owns the
 * floating per-selection object toolbar, "Ещё" submenu drill-down, and
 * cross-tile tool-state bookkeeping. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const Drawings = CE && CE.Drawings;
  const Page = global.ChartAnalysisPage;
  if (!Drawings || !Drawings.DrawingManager || !Page) return;

  // The rail (tool groups/flyouts) used to be built here, but
  // chart-editor-terminal-mobile-v2.js's rail is the one actually shown to
  // users (it loads later and explicitly tears this one down - see its own
  // buildRail()), so building a second, invisible one was dead weight and a
  // source of confusion. This file now owns only what v2 doesn't: the
  // floating object toolbar, the "Ещё" submenu drill-down, and per-tile
  // lifecycle bookkeeping (deselecting/cancelling an in-progress tool when
  // switching tiles or leaving the Charts tab).

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function activeManager(page) {
    return page && page.activeTile && page.activeTile.drawingMgr
      ? page.activeTile.drawingMgr
      : page && page.drawingMgr ? page.drawingMgr : null;
  }

  function allManagers(page) {
    const out = [];
    const seen = new Set();
    const tiles = page && page.tiles;
    const list = Array.isArray(tiles) ? tiles
      : tiles instanceof Map ? Array.from(tiles.values())
        : tiles && typeof tiles === "object" ? Object.values(tiles) : [];
    list.forEach((tile) => {
      const dm = tile && tile.drawingMgr;
      if (dm && !seen.has(dm)) { seen.add(dm); out.push(dm); }
    });
    const current = activeManager(page);
    if (current && !seen.has(current)) out.push(current);
    return out;
  }

  // ---------------------------------------------------------- editor state --
  function deactivateEveryTool(page, { deselectActive = true } = {}) {
    const active = activeManager(page);
    allManagers(page).forEach((dm) => {
      if (dm.activeTool || dm.draft || dm._draftPreviewPoint || dm._dragState) dm.setTool(null);
      if (deselectActive && dm === active && dm.selectedId) dm.select(null);
    });
  }

  function refreshRail() {
    if (global.StrategyLabMobileChart && typeof global.StrategyLabMobileChart.refreshRail === "function") {
      global.StrategyLabMobileChart.refreshRail();
    }
  }

  // Escape cancels/finishes the active drawing tool from anywhere on the
  // page, not just while the chart canvas itself has focus (drawings.js's
  // own _onKeyDown is scoped to pointer-over-chart/chart-focused). Attached
  // once at script load - a page-level listener like this doesn't need
  // rebuilding alongside the rail, unlike the flyout it used to also manage.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const dm = activeManager(Page);
    if (dm && (dm.draft || dm.activeTool)) {
      event.preventDefault();
      event.stopPropagation();
      dm.handleEscape();
      refreshRail();
    }
  }, true);

  // ------------------------------------------------------ object toolbar --
  function drawingLabel(drawing) {
    const def = Drawings.TOOL_DEFS && Drawings.TOOL_DEFS[drawing.type];
    return (drawing.properties && drawing.properties.label) || (def && def.label) || drawing.type;
  }

  function renderObjectToolbar(page) {
    const workspace = page.root && page.root.querySelector("#caWorkspace");
    if (!workspace) return;
    let bar = workspace.querySelector("#tvObjectToolbar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "tvObjectToolbar";
      bar.className = "tv-object-toolbar hidden";
      workspace.appendChild(bar);
    }

    const picker = page.root.querySelector(".sl-draw-picker");
    if (picker && !picker.classList.contains("hidden")) {
      bar.classList.add("hidden");
      bar.innerHTML = "";
      return;
    }

    const dm = activeManager(page);
    const drawing = dm && dm.drawings.find((item) => item.id === dm.selectedId);
    if (!drawing) {
      bar.classList.add("hidden");
      bar.innerHTML = "";
      return;
    }

    const color = /^#[0-9a-f]{6}$/i.test(drawing.properties.color || "") ? drawing.properties.color : "#7c8cff";
    const width = Number(drawing.properties.width || 1);
    const dash = drawing.properties.dash || "solid";
    const isTextual = drawing.type === "text" || drawing.type === "note";
    bar.innerHTML = `
      <span class="tv-object-name" title="${escapeHtml(drawingLabel(drawing))}">${escapeHtml(drawingLabel(drawing))}</span>
      <input class="tv-obj-control tv-color" data-tv-prop-color type="color" value="${color}" title="Цвет">
      ${isTextual ? `
        <button class="tv-obj-btn" data-tv-obj-edit-text title="Редактировать текст" aria-label="Редактировать текст">✎</button>
      ` : `
        <select class="tv-obj-control" data-tv-prop-width title="Толщина">${[1,2,3,4].map((n) => `<option value="${n}" ${width === n ? "selected" : ""}>${n}px</option>`).join("")}</select>
        <select class="tv-obj-control" data-tv-prop-dash title="Стиль линии">
          <option value="solid" ${dash === "solid" ? "selected" : ""}>—</option>
          <option value="dashed" ${dash === "dashed" ? "selected" : ""}>– –</option>
          <option value="dotted" ${dash === "dotted" ? "selected" : ""}>···</option>
        </select>
      `}
      <button class="tv-obj-btn ${drawing.locked ? "active" : ""}" data-tv-obj-lock title="${drawing.locked ? "Разблокировать" : "Заблокировать"}">${drawing.locked ? "🔒" : "🔓"}</button>
      <button class="tv-obj-btn" data-tv-obj-duplicate title="Дублировать">⧉</button>
      <button class="tv-obj-btn" data-tv-obj-more title="Свойства">⚙</button>
      <button class="tv-obj-btn danger" data-tv-obj-delete title="Удалить">⌫</button>
    `;
    bar.classList.remove("hidden");

    const colorInput = bar.querySelector("[data-tv-prop-color]");
    if (colorInput) colorInput.onchange = (e) => dm.updateDrawing(drawing.id, { properties: { color: e.target.value } });
    const widthInput = bar.querySelector("[data-tv-prop-width]");
    if (widthInput) widthInput.onchange = (e) => dm.updateDrawing(drawing.id, { properties: { width: Number(e.target.value) } });
    const dashInput = bar.querySelector("[data-tv-prop-dash]");
    if (dashInput) dashInput.onchange = (e) => dm.updateDrawing(drawing.id, { properties: { dash: e.target.value } });
    const editTextButton = bar.querySelector("[data-tv-obj-edit-text]");
    if (editTextButton) editTextButton.onclick = () => {
      if (typeof page._setBottomCollapsed === "function") page._setBottomCollapsed(false);
      const tab = page.root.querySelector('.ca-side-tab[data-side="props"]');
      if (tab) tab.click();
      if (typeof page._renderProps === "function") page._renderProps();
      requestAnimationFrame(() => {
        const field = page.root.querySelector("#propText");
        if (!field) return;
        field.focus();
        if (typeof field.setSelectionRange === "function") field.setSelectionRange(field.value.length, field.value.length);
        if (typeof field.scrollIntoView === "function") field.scrollIntoView({ block: "nearest" });
      });
    };
    bar.querySelector("[data-tv-obj-lock]").onclick = () => dm.updateDrawing(drawing.id, { locked: !drawing.locked });
    bar.querySelector("[data-tv-obj-duplicate]").onclick = () => dm.duplicateDrawing(drawing.id);
    bar.querySelector("[data-tv-obj-delete]").onclick = () => dm.removeDrawing(drawing.id);
    bar.querySelector("[data-tv-obj-more]").onclick = () => {
      if (typeof page._setBottomCollapsed === "function") page._setBottomCollapsed(false);
      const tab = page.root.querySelector('.ca-side-tab[data-side="props"]');
      if (tab) tab.click();
    };
  }

  // ---------------------------------------------------------- overflow UI --
  if (typeof Page._renderMorePopover === "function") {
    const originalRenderMore = Page._renderMorePopover;
    const openSubmenu = (page, title, render) => {
      const pop = page.root.querySelector("#gtMorePop");
      if (!pop) return;
      pop.innerHTML = `
        <div class="ca-more-group tv-mobile-subhead">
          <button class="ca-more-item" type="button" data-mobile-more-back>← Назад</button>
          <div class="ca-more-heading">${escapeHtml(title)}</div>
        </div>
        <div class="ca-more-sep"></div><div data-mobile-more-body></div>`;
      const body = pop.querySelector("[data-mobile-more-body]");
      render(body);
      pop.querySelector("[data-mobile-more-back]").onclick = (e) => {
        e.stopPropagation();
        page._renderMorePopover();
      };
      pop.classList.remove("hidden");
    };

    Page._renderMorePopover = function () {
      originalRenderMore.call(this);
      const pop = this.root.querySelector("#gtMorePop");
      if (!pop) return;
      const wire = (action, title, render) => {
        const button = pop.querySelector(`[data-act="${action}"]`);
        if (!button) return;
        button.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          openSubmenu(this, title, render);
        };
      };
      wire("indicators", "Индикаторы", (body) => this._renderIndicatorsInto(body));
      wire("templates", "Шаблоны", (body) => this._renderTemplatesInto(body));
      wire("alerts", "Оповещения", (body) => this._renderAlertsInto(body));
    };
  }

  if (typeof Page._renderIndicatorsInto === "function") {
    const originalRenderIndicators = Page._renderIndicatorsInto;
    Page._renderIndicatorsInto = function (container) {
      originalRenderIndicators.call(this, container);
      const list = container.querySelector(".ca-ind-list");
      if (!list || container.querySelector(".tv-indicator-search")) return;
      const activeCount = this.activeTile && this.activeTile.indicatorMgr ? this.activeTile.indicatorMgr.list().length : 0;
      const head = document.createElement("div");
      head.innerHTML = `
        <div class="tv-indicator-head"><div class="tv-indicator-title">Индикаторы и стратегии</div><div class="tv-indicator-count">Активно: ${activeCount}</div></div>
        <input class="tv-indicator-search" type="search" placeholder="Поиск индикаторов" autocomplete="off">
        <div class="tv-indicator-tabs"><button type="button" class="tv-indicator-tab active">Технические</button><button type="button" class="tv-indicator-tab" disabled>Мои</button></div>`;
      while (head.firstChild) container.insertBefore(head.firstChild, list);
      const search = container.querySelector(".tv-indicator-search");
      search.oninput = () => {
        const q = search.value.trim().toLocaleLowerCase("ru-RU");
        container.querySelectorAll(".ca-indicator-row").forEach((row) => {
          const match = !q || row.textContent.toLocaleLowerCase("ru-RU").includes(q);
          row.style.display = match ? "" : "none";
          const panel = row.nextElementSibling;
          if (panel && panel.classList.contains("ca-ind-settings") && !match) panel.classList.add("hidden");
        });
      };
    };
  }

  // -------------------------------------------------------------- styles --
  function injectStyles() {
    const old = document.getElementById("tv-editor-prototype-styles");
    if (old) old.remove();
    if (document.getElementById("tv-editor-pointer-styles")) return;
    const style = document.createElement("style");
    style.id = "tv-editor-pointer-styles";
    style.textContent = `
      #chartsRoot .ca-workspace { position: relative; }
      #chartsRoot .ca-tools.tv-rail {
        position: relative; z-index: 120;
        width: 50px; min-width: 50px; padding: 5px 4px; gap: 2px; overflow: visible;
        border-right: 1px solid var(--line); background: rgba(13,18,30,.98);
      }
      #chartsRoot .tv-object-toolbar {
        position:absolute; z-index:82; top:58px; left:50%; transform:translateX(-50%);
        display:flex; align-items:center; gap:5px; width:max-content; max-width:calc(100% - 130px);
        min-height:42px; padding:5px 7px; box-sizing:border-box; border:1px solid rgba(140,154,186,.25);
        border-radius:10px; background:rgba(20,26,42,.97); box-shadow:0 14px 42px rgba(0,0,0,.40);
        overflow-x:auto; scrollbar-width:none;
      }
      #chartsRoot .tv-object-toolbar::-webkit-scrollbar { display:none; }
      #chartsRoot .tv-object-toolbar.hidden { display:none; }
      #chartsRoot .tv-object-name { flex:0 0 auto; max-width:150px; padding:0 5px; color:#dfe5f2; font-size:12px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #chartsRoot .tv-obj-control, #chartsRoot .tv-obj-btn { flex:0 0 auto; width:auto !important; min-width:34px; height:30px; border:1px solid rgba(140,154,186,.18); border-radius:6px; background:rgba(255,255,255,.025); color:#dbe1ed; font:600 12px/1 system-ui,sans-serif; }
      #chartsRoot .tv-obj-control[data-tv-prop-width] { width:58px !important; }
      #chartsRoot .tv-obj-control[data-tv-prop-dash] { width:54px !important; }
      #chartsRoot .tv-obj-btn { cursor:pointer; padding:0 8px; }
      #chartsRoot .tv-color { width:32px !important; min-width:32px; padding:3px; cursor:pointer; }
      #chartsRoot .tv-indicator-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
      #chartsRoot .tv-indicator-title { font-size:13px; font-weight:700; color:#edf1fa; }
      #chartsRoot .tv-indicator-count { color:#7f8aa1; font-size:11px; }
      #chartsRoot .tv-indicator-search { width:100%; min-height:40px; margin:0 0 9px; padding:0 11px; border:1px solid rgba(140,154,186,.22); border-radius:8px; background:rgba(5,8,16,.42); color:#edf1fa; outline:none; font:500 13px system-ui,sans-serif; }
      #chartsRoot .ca-prop-textarea { width:100%; min-height:84px; box-sizing:border-box; padding:10px 11px; border:1px solid rgba(140,154,186,.22); border-radius:8px; background:rgba(5,8,16,.42); color:#edf1fa; outline:none; resize:vertical; font:500 14px/1.4 system-ui,sans-serif; }
      #chartsRoot .ca-prop-textarea:focus { border-color:rgba(124,140,255,.72); box-shadow:0 0 0 2px rgba(124,140,255,.12); }
      #chartsRoot .ca-prop-text-hint { margin-top:-4px; margin-bottom:8px; }
      #chartsRoot .tv-indicator-tabs { display:flex; gap:4px; margin-bottom:8px; }
      #chartsRoot .tv-indicator-tab { padding:6px 9px; border:0; border-radius:7px; background:transparent; color:#8f9ab0; font-size:11px; font-weight:650; }
      #chartsRoot .tv-indicator-tab.active { color:#dfe5f5; background:rgba(124,140,255,.13); }
      @media (max-width:620px) {
        #chartsRoot .ca-tools.tv-rail { width:46px; min-width:46px; padding-left:2px; padding-right:2px; }
        #chartsRoot .tv-object-toolbar { top:58px; left:53px; right:auto; transform:none; width:max-content; max-width:calc(100vw - 72px); min-height:38px; gap:4px; padding:4px 5px; }
        #chartsRoot .tv-object-name { display:none; }
        #chartsRoot .tv-obj-control, #chartsRoot .tv-obj-btn { height:30px; min-width:32px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ----------------------------------------------------------- fullscreen --
  if (CE.ChartTile && CE.ChartTile.prototype && typeof CE.ChartTile.prototype.mount === "function") {
    const originalTileMount = CE.ChartTile.prototype.mount;
    CE.ChartTile.prototype.mount = function (container) {
      const result = originalTileMount.apply(this, arguments);
      const button = container && container.querySelector('[data-role="fs"]');
      if (button && !button.dataset.editorFullscreenWired) {
        const tileFullscreen = button.onclick;
        button.dataset.editorFullscreenWired = "1";
        button.onclick = (event) => {
          const page = global.ChartAnalysisPage;
          const mobile = !!(global.matchMedia && global.matchMedia("(max-width: 620px)").matches);
          const singleTile = !!(page && Array.isArray(page.tiles) && page.tiles.length === 1);
          if ((mobile || singleTile) && page && page._fsCtrl) {
            event.stopPropagation();
            page._fsCtrl.toggle();
            return;
          }
          if (typeof tileFullscreen === "function") tileFullscreen.call(button, event);
        };
      }
      return result;
    };
  }

  // ------------------------------------------------------------ page hooks --
  const originalBuild = Page._build;
  Page._build = function () {
    const result = originalBuild.apply(this, arguments);
    renderObjectToolbar(this);
    return result;
  };

  if (typeof Page._setBottomCollapsed === "function") {
    const originalSetBottomCollapsed = Page._setBottomCollapsed;
    Page._setBottomCollapsed = function () {
      const result = originalSetBottomCollapsed.apply(this, arguments);
      refreshRail();
      return result;
    };
  }

  if (typeof Page._renderProps === "function") {
    const originalRenderProps = Page._renderProps;
    Page._renderProps = function () {
      const result = originalRenderProps.apply(this, arguments);
      refreshRail();
      renderObjectToolbar(this);
      return result;
    };
  }

  if (typeof Page._setActiveTile === "function") {
    const originalSetActiveTile = Page._setActiveTile;
    Page._setActiveTile = function (id) {
      if (id === this.activeTileId) return originalSetActiveTile.apply(this, arguments);
      deactivateEveryTool(this, { deselectActive: false });
      const result = originalSetActiveTile.apply(this, arguments);
      refreshRail();
      renderObjectToolbar(this);
      return result;
    };
  }

  if (typeof Page.onTabLeave === "function") {
    const originalTabLeave = Page.onTabLeave;
    Page.onTabLeave = function () {
      const picker = this.root && this.root.querySelector(".sl-draw-picker");
      if (picker) picker.classList.add("hidden");
      deactivateEveryTool(this, { deselectActive: false });
      return originalTabLeave.apply(this, arguments);
    };
  }

  injectStyles();

  // Exposed so chart-editor-terminal-mobile-v2.js's rail (loaded later, owns
  // the actual tool-selection UI) can cancel an in-progress draft/armed tool
  // on every OTHER tile before arming a new tool on the active one -
  // otherwise switching tools on tile A while tile B has a half-drawn
  // trend line leaves tile B's draft dangling until the user clicks into it.
  global.ChartDrawingUI = {
    deactivateEveryTool: (page, opts) => deactivateEveryTool(page || Page, opts),
  };
})(window);