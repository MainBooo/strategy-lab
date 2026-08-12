/* TradingView-style drawing editor chrome for the free-form chart workspace.
 * Pointer ownership, creation/edit state transitions, drafts, gesture
 * thresholds and capture live in chart-engine/drawings.js. This module owns
 * only the rail/flyouts/tool selection UI, mobile layout and editor chrome. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const Drawings = CE && CE.Drawings;
  const Page = global.ChartAnalysisPage;
  if (!Drawings || !Drawings.DrawingManager || !Page) return;

  const TOOL_GROUPS = [
    { id: "cursor", label: "Курсор", icon: "⌖", tools: [{ id: null, label: "Курсор / выбор", icon: "⌖" }] },
    {
      id: "trend", label: "Линии тренда", icon: "╱", tools: [
        { id: "trend_line", label: "Линия тренда", icon: "╱" },
        { id: "ray", label: "Луч", icon: "↗" },
        { id: "extended_line", label: "Расширенная линия", icon: "⟷" },
        { id: "horizontal_line", label: "Горизонтальный уровень", icon: "—" },
        { id: "vertical_line", label: "Вертикальная линия", icon: "│" },
        { id: "parallel_channel", label: "Параллельный канал", icon: "═" },
      ],
    },
    {
      id: "fib", label: "Фибоначчи", icon: "F", tools: [
        { id: "fib_retracement", label: "Коррекция Фибоначчи", icon: "F" },
        { id: "fib_extension", label: "Расширение Фибоначчи", icon: "Fx" },
      ],
    },
    {
      id: "shapes", label: "Геометрические фигуры", icon: "▭", tools: [
        { id: "rectangle", label: "Прямоугольник", icon: "▭" },
        { id: "circle", label: "Эллипс", icon: "○" },
        { id: "polyline", label: "Полилиния", icon: "⌁" },
      ],
    },
    {
      id: "notes", label: "Аннотации", icon: "T", tools: [
        { id: "text", label: "Текст", icon: "T" },
        { id: "note", label: "Заметка", icon: "▣" },
      ],
    },
    {
      id: "measure", label: "Измерения и позиции", icon: "↕", tools: [
        { id: "price_range", label: "Диапазон цены", icon: "↕" },
        { id: "time_range", label: "Диапазон времени", icon: "↔" },
        { id: "long_position", label: "Long позиция", icon: "↑" },
        { id: "short_position", label: "Short позиция", icon: "↓" },
      ],
    },
  ];

  const DEFAULT_TOOL_BY_GROUP = {
    cursor: null,
    trend: "trend_line",
    fib: "fib_retracement",
    shapes: "rectangle",
    notes: "text",
    measure: "price_range",
  };
  const TV_STATE_KEY = "moexlab_tv_editor_state";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function loadEditorState() {
    let saved = {};
    try { saved = JSON.parse(global.localStorage.getItem(TV_STATE_KEY) || "{}"); } catch (e) { /* storage unavailable */ }
    return {
      lastTool: Object.assign({}, DEFAULT_TOOL_BY_GROUP, saved.lastTool || {}),
      keepDrawing: !!saved.keepDrawing,
    };
  }

  function saveEditorState(page) {
    if (!page || !page._tvState) return;
    try {
      global.localStorage.setItem(TV_STATE_KEY, JSON.stringify({
        lastTool: page._tvState.lastTool,
        keepDrawing: !!page._tvState.keepDrawing,
      }));
    } catch (e) { /* storage unavailable */ }
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
      dm.keepDrawing = !!(page._tvState && page._tvState.keepDrawing);
      if (deselectActive && dm === active && dm.selectedId) dm.select(null);
    });
  }

  function activateTool(page, groupId, toolId) {
    deactivateEveryTool(page, { deselectActive: true });
    const dm = activeManager(page);
    if (dm && toolId) {
      dm.keepDrawing = !!page._tvState.keepDrawing;
      dm.setTool(toolId);
      dm.select(null);
    }
    if (page._tvState && groupId in page._tvState.lastTool) page._tvState.lastTool[groupId] = toolId;
    saveEditorState(page);
    closeToolFlyout(page);
    refreshTradingViewRail(page);
  }

  function closeToolFlyout(page) {
    if (!page || !page.root) return;
    const flyout = page.root.querySelector("#tvToolFlyout");
    if (flyout) flyout.classList.add("hidden");
    page._tvOpenGroup = null;
  }

  function renderToolFlyout(page, group, anchor) {
    const rail = page.root.querySelector("#caTools");
    const flyout = rail && rail.querySelector("#tvToolFlyout");
    if (!rail || !flyout) return;

    // Opening a chooser is itself a mode transition. No unfinished drawing or
    // previously armed tool is allowed to survive while the user is choosing.
    deactivateEveryTool(page, { deselectActive: true });

    flyout.innerHTML = `
      <div class="tv-flyout-title">${escapeHtml(group.label)}</div>
      ${group.tools.map((tool) => `
        <button type="button" class="tv-flyout-item" data-tv-tool="${tool.id || ""}" data-tv-tool-group="${group.id}">
          <span class="tv-flyout-icon">${tool.icon}</span>
          <span class="tv-flyout-label">${escapeHtml(tool.label)}</span>
          <span class="tv-flyout-check"></span>
        </button>
      `).join("")}
    `;

    const railRect = rail.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const maxTop = Math.max(4, railRect.height - Math.min(360, flyout.scrollHeight || 240) - 4);
    flyout.style.top = `${Math.max(4, Math.min(anchorRect.top - railRect.top, maxTop))}px`;
    flyout.classList.remove("hidden");
    page._tvOpenGroup = group.id;
    refreshTradingViewRail(page);
  }

  function bulkUpdate(page, key, value) {
    const dm = activeManager(page);
    if (!dm || !dm.drawings.length) return;
    dm.drawings.slice().forEach((drawing) => dm.updateDrawing(drawing.id, { [key]: value }));
  }

  function refreshTradingViewRail(page) {
    if (!page || !page.root || !page._tvState) return;
    const dm = activeManager(page);
    if (dm) dm.keepDrawing = !!page._tvState.keepDrawing;
    const activeTool = dm ? dm.activeTool : null;

    page.root.querySelectorAll("[data-tv-group]").forEach((button) => {
      const group = TOOL_GROUPS.find((item) => item.id === button.dataset.tvGroup);
      if (!group) return;
      const belongs = group.id === "cursor"
        ? !activeTool && !page._tvOpenGroup
        : group.tools.some((tool) => tool.id === activeTool);
      button.classList.toggle("active", belongs);
      button.setAttribute("aria-pressed", belongs ? "true" : "false");

      const lastId = group.id === "cursor" ? null : page._tvState.lastTool[group.id];
      const last = group.tools.find((tool) => tool.id === lastId) || group.tools[0];
      const icon = button.querySelector(".tv-group-icon");
      if (icon) icon.textContent = last.icon;
      button.title = last.label;
      button.setAttribute("aria-label", last.label);
    });

    const magnet = page.root.querySelector("[data-tv-action='magnet']");
    if (magnet) magnet.classList.toggle("active", !!(dm && dm.snapEnabled));
    const keep = page.root.querySelector("[data-tv-action='keep']");
    if (keep) keep.classList.toggle("active", !!page._tvState.keepDrawing);
    const lock = page.root.querySelector("[data-tv-action='lock-all']");
    if (lock && dm) lock.classList.toggle("active", dm.drawings.length > 0 && dm.drawings.every((d) => d.locked));
    const hide = page.root.querySelector("[data-tv-action='hide-all']");
    if (hide && dm) hide.classList.toggle("active", dm.drawings.length > 0 && dm.drawings.every((d) => d.hidden));
  }

  function buildTradingViewRail(page) {
    const rail = page.root.querySelector("#caTools");
    if (!rail) return;
    if (page._drawingToolbarCleanup) page._drawingToolbarCleanup();

    page._tvState = page._tvState || loadEditorState();
    page._tvState.lastTool = Object.assign({}, DEFAULT_TOOL_BY_GROUP, page._tvState.lastTool || {});
    rail.classList.add("tv-rail");
    rail.innerHTML = `
      ${TOOL_GROUPS.map((group) => {
        const lastId = group.id === "cursor" ? null : page._tvState.lastTool[group.id];
        const last = group.tools.find((tool) => tool.id === lastId) || group.tools[0];
        return `<button type="button" class="tv-tool-group-btn" data-tv-group="${group.id}" title="${escapeHtml(last.label)}" aria-label="${escapeHtml(last.label)}" aria-pressed="false">
          <span class="tv-group-icon">${last.icon}</span>${group.tools.length > 1 ? '<span class="tv-caret">◢</span>' : ""}
        </button>`;
      }).join("")}
      <div class="tv-rail-divider"></div>
      <button type="button" class="tv-rail-action" data-tv-action="magnet" title="Магнит: привязка к OHLC" aria-label="Магнит">⌁</button>
      <button type="button" class="tv-rail-action" data-tv-action="keep" title="Оставаться в режиме рисования" aria-label="Оставаться в режиме рисования">✎</button>
      <button type="button" class="tv-rail-action" data-tv-action="lock-all" title="Заблокировать все объекты" aria-label="Заблокировать все объекты">⌑</button>
      <button type="button" class="tv-rail-action" data-tv-action="hide-all" title="Скрыть все объекты" aria-label="Скрыть все объекты">◉</button>
      <button type="button" class="tv-rail-action" data-tv-action="objects" title="Дерево объектов" aria-label="Дерево объектов">☷</button>
      <button type="button" class="tv-rail-action" data-tv-action="remove-all" title="Удалить все объекты" aria-label="Удалить все объекты">⌫</button>
      <div class="tv-tool-flyout hidden" id="tvToolFlyout" role="menu" aria-label="Инструменты рисования"></div>
    `;

    const onRailPointerDown = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !target.closest("button")) return;
      event.stopPropagation();
    };

    const onRailPointerUp = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const toolItem = target.closest(".tv-flyout-item[data-tv-tool]");
      if (toolItem) {
        event.preventDefault();
        event.stopPropagation();
        activateTool(page, toolItem.dataset.tvToolGroup, toolItem.dataset.tvTool || null);
        return;
      }

      const groupButton = target.closest(".tv-tool-group-btn[data-tv-group]");
      if (groupButton) {
        event.preventDefault();
        event.stopPropagation();
        const group = TOOL_GROUPS.find((item) => item.id === groupButton.dataset.tvGroup);
        if (!group) return;
        if (group.tools.length === 1) {
          activateTool(page, group.id, group.tools[0].id);
          return;
        }
        if (page._tvOpenGroup === group.id) closeToolFlyout(page);
        else renderToolFlyout(page, group, groupButton);
        refreshTradingViewRail(page);
        return;
      }

      const actionButton = target.closest(".tv-rail-action[data-tv-action]");
      if (!actionButton) return;
      event.preventDefault();
      event.stopPropagation();
      closeToolFlyout(page);
      const dm = activeManager(page);
      if (!dm) return;
      const action = actionButton.dataset.tvAction;
      if (action === "magnet") {
        dm.snapEnabled = !dm.snapEnabled;
        dm._emit({ snap: true });
      } else if (action === "keep") {
        page._tvState.keepDrawing = !page._tvState.keepDrawing;
        dm.keepDrawing = page._tvState.keepDrawing;
        saveEditorState(page);
      } else if (action === "lock-all") {
        bulkUpdate(page, "locked", !(dm.drawings.length && dm.drawings.every((d) => d.locked)));
      } else if (action === "hide-all") {
        bulkUpdate(page, "hidden", !(dm.drawings.length && dm.drawings.every((d) => d.hidden)));
      } else if (action === "objects") {
        if (typeof page._setBottomCollapsed === "function") page._setBottomCollapsed(false);
        const tab = page.root.querySelector('.ca-side-tab[data-side="objects"]');
        if (tab) tab.click();
      } else if (action === "remove-all") {
        if (dm.drawings.length && global.confirm("Удалить все объекты разметки на активном графике?")) {
          dm.drawings.slice().forEach((d) => dm.removeDrawing(d.id));
        }
      }
      refreshTradingViewRail(page);
    };

    const onDocumentPointerDown = (event) => {
      if (!page._tvOpenGroup) return;
      const target = event.target;
      if (target instanceof Node && rail.contains(target)) return;
      closeToolFlyout(page);
      refreshTradingViewRail(page);
    };

    const onDocumentKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (page._tvOpenGroup) {
        event.preventDefault();
        event.stopPropagation();
        closeToolFlyout(page);
        refreshTradingViewRail(page);
        return;
      }
      const dm = activeManager(page);
      if (dm && (dm.draft || dm.activeTool)) {
        event.preventDefault();
        event.stopPropagation();
        dm.handleEscape();
        refreshTradingViewRail(page);
      }
    };

    rail.addEventListener("pointerdown", onRailPointerDown);
    rail.addEventListener("pointerup", onRailPointerUp);
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);

    page._drawingToolbarCleanup = () => {
      rail.removeEventListener("pointerdown", onRailPointerDown);
      rail.removeEventListener("pointerup", onRailPointerUp);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      page._drawingToolbarCleanup = null;
    };

    refreshTradingViewRail(page);
  }

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

    if (page._tvOpenGroup) {
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
    bar.innerHTML = `
      <span class="tv-object-name" title="${escapeHtml(drawingLabel(drawing))}">${escapeHtml(drawingLabel(drawing))}</span>
      <input class="tv-obj-control tv-color" data-tv-prop-color type="color" value="${color}" title="Цвет">
      <select class="tv-obj-control" data-tv-prop-width title="Толщина">${[1,2,3,4].map((n) => `<option value="${n}" ${width === n ? "selected" : ""}>${n}px</option>`).join("")}</select>
      <select class="tv-obj-control" data-tv-prop-dash title="Стиль линии">
        <option value="solid" ${dash === "solid" ? "selected" : ""}>—</option>
        <option value="dashed" ${dash === "dashed" ? "selected" : ""}>– –</option>
        <option value="dotted" ${dash === "dotted" ? "selected" : ""}>···</option>
      </select>
      <button class="tv-obj-btn ${drawing.locked ? "active" : ""}" data-tv-obj-lock title="${drawing.locked ? "Разблокировать" : "Заблокировать"}">${drawing.locked ? "🔒" : "🔓"}</button>
      <button class="tv-obj-btn" data-tv-obj-duplicate title="Дублировать">⧉</button>
      <button class="tv-obj-btn" data-tv-obj-more title="Свойства">⚙</button>
      <button class="tv-obj-btn danger" data-tv-obj-delete title="Удалить">⌫</button>
    `;
    bar.classList.remove("hidden");

    bar.querySelector("[data-tv-prop-color]").oninput = (e) => dm.updateDrawing(drawing.id, { properties: { color: e.target.value } });
    bar.querySelector("[data-tv-prop-width]").onchange = (e) => dm.updateDrawing(drawing.id, { properties: { width: Number(e.target.value) } });
    bar.querySelector("[data-tv-prop-dash]").onchange = (e) => dm.updateDrawing(drawing.id, { properties: { dash: e.target.value } });
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
      #chartsRoot .tv-tool-group-btn, #chartsRoot .tv-rail-action {
        position: relative; width: 40px; height: 40px; min-height: 44px;
        display: grid; place-items: center; border: 0; border-radius: 8px;
        background: transparent; color: #aab4c9; font: 600 17px/1 system-ui,sans-serif;
        cursor: pointer; touch-action: manipulation; -webkit-user-select: none; user-select: none;
      }
      #chartsRoot .tv-tool-group-btn.active, #chartsRoot .tv-rail-action.active {
        color: #8e9bff; background: rgba(93,108,255,.18); box-shadow: inset 0 0 0 1px rgba(124,140,255,.72);
      }
      #chartsRoot .tv-tool-group-btn .tv-caret { position:absolute; right:3px; bottom:3px; font-size:7px; opacity:.55; }
      #chartsRoot .tv-rail-divider { height:1px; margin:4px 5px; background:var(--line); }
      #chartsRoot .tv-tool-flyout {
        position:absolute; left:48px; top:4px; z-index:2;
        width:250px; max-height:min(520px,calc(100dvh - 130px)); overflow:auto;
        padding:8px; border:1px solid rgba(140,154,186,.23); border-radius:10px;
        background:rgba(20,26,42,.99); box-shadow:0 18px 55px rgba(0,0,0,.48);
        pointer-events:auto; overscroll-behavior:contain;
      }
      #chartsRoot .tv-tool-flyout.hidden { display:none; }
      #chartsRoot .tv-flyout-title { padding:5px 8px 8px; color:#8792aa; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
      #chartsRoot .tv-flyout-item {
        width:100%; min-height:44px; display:grid; grid-template-columns:28px 1fr 18px;
        align-items:center; gap:8px; padding:7px 8px; border:0; border-radius:7px;
        background:transparent; color:#e6ebf6; text-align:left; font:500 13px/1.25 system-ui,sans-serif;
        cursor:pointer; touch-action:manipulation; -webkit-user-select:none; user-select:none; pointer-events:auto;
      }
      #chartsRoot .tv-flyout-item:active { background:rgba(124,140,255,.20); }
      @media (hover:hover) { #chartsRoot .tv-flyout-item:hover { background:rgba(124,140,255,.11); } }
      #chartsRoot .tv-flyout-icon { text-align:center; color:#aeb7ca; font-weight:700; }
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
      #chartsRoot .tv-indicator-tabs { display:flex; gap:4px; margin-bottom:8px; }
      #chartsRoot .tv-indicator-tab { padding:6px 9px; border:0; border-radius:7px; background:transparent; color:#8f9ab0; font-size:11px; font-weight:650; }
      #chartsRoot .tv-indicator-tab.active { color:#dfe5f5; background:rgba(124,140,255,.13); }
      @media (max-width:620px) {
        #chartsRoot .ca-tools.tv-rail { width:46px; min-width:46px; padding-left:2px; padding-right:2px; }
        #chartsRoot .tv-tool-group-btn, #chartsRoot .tv-rail-action { width:40px; height:44px; min-height:44px; }
        #chartsRoot .tv-tool-flyout { left:44px; width:min(280px,calc(100vw - 70px)); max-height:calc(100dvh - 170px); }
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
    buildTradingViewRail(this);
    renderObjectToolbar(this);
    return result;
  };

  if (typeof Page._renderProps === "function") {
    const originalRenderProps = Page._renderProps;
    Page._renderProps = function () {
      const result = originalRenderProps.apply(this, arguments);
        refreshTradingViewRail(this);
      renderObjectToolbar(this);
      return result;
    };
  }

  if (typeof Page._setActiveTile === "function") {
    const originalSetActiveTile = Page._setActiveTile;
    Page._setActiveTile = function (id) {
      if (id === this.activeTileId) return originalSetActiveTile.apply(this, arguments);
      deactivateEveryTool(this, { deselectActive: false });
      closeToolFlyout(this);
      const result = originalSetActiveTile.apply(this, arguments);
        refreshTradingViewRail(this);
      renderObjectToolbar(this);
      return result;
    };
  }

  if (typeof Page.onTabLeave === "function") {
    const originalTabLeave = Page.onTabLeave;
    Page.onTabLeave = function () {
      closeToolFlyout(this);
      deactivateEveryTool(this, { deselectActive: false });
      return originalTabLeave.apply(this, arguments);
    };
  }

  injectStyles();

  global.ChartDrawingUI = {
    groups: TOOL_GROUPS,
    activeTool: () => activeManager(Page) ? activeManager(Page).activeTool : null,
    openGroup: () => Page._tvOpenGroup || null,
    closeMenu: () => closeToolFlyout(Page),
  };
})(window);
