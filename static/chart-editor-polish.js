/* Unified drawing-tool controller for Strategy Lab charts.
 * Loaded after chart-mobile-interactions.js and intentionally supersedes its
 * legacy mouse+touch bridge and click-driven rail. DrawingManager.activeTool
 * remains the single source of truth; this file does not introduce a second
 * selected-tool state.
 */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const Drawings = CE && CE.Drawings;
  const Page = global.ChartAnalysisPage;
  if (!Drawings || !Drawings.DrawingManager || !Page) return;

  const GROUPS = [
    { id: "cursor", label: "Курсор", icon: "⌖", tools: [{ id: null, label: "Курсор / выбор", icon: "⌖" }] },
    { id: "trend", label: "Линии тренда", icon: "╱", tools: [
      { id: "trend_line", label: "Линия тренда", icon: "╱" },
      { id: "ray", label: "Луч", icon: "↗" },
      { id: "extended_line", label: "Расширенная линия", icon: "⟷" },
      { id: "horizontal_line", label: "Горизонтальный уровень", icon: "—" },
      { id: "vertical_line", label: "Вертикальная линия", icon: "│" },
      { id: "parallel_channel", label: "Параллельный канал", icon: "═" },
    ] },
    { id: "fib", label: "Фибоначчи", icon: "F", tools: [
      { id: "fib_retracement", label: "Коррекция Фибоначчи", icon: "F" },
      { id: "fib_extension", label: "Расширение Фибоначчи", icon: "Fx" },
    ] },
    { id: "shapes", label: "Геометрические фигуры", icon: "▭", tools: [
      { id: "rectangle", label: "Прямоугольник", icon: "▭" },
      { id: "circle", label: "Окружность / эллипс", icon: "○" },
      { id: "polyline", label: "Полилиния", icon: "⌁" },
    ] },
    { id: "notes", label: "Аннотации", icon: "T", tools: [
      { id: "text", label: "Текст", icon: "T" },
      { id: "note", label: "Заметка", icon: "▣" },
    ] },
    { id: "measure", label: "Измерения и позиции", icon: "↕", tools: [
      { id: "price_range", label: "Диапазон цены", icon: "↕" },
      { id: "time_range", label: "Диапазон времени", icon: "↔" },
      { id: "long_position", label: "Long позиция", icon: "↑" },
      { id: "short_position", label: "Short позиция", icon: "↓" },
    ] },
  ];
  const DEFAULT_LAST = { cursor: null, trend: "trend_line", fib: "fib_retracement", shapes: "rectangle", notes: "text", measure: "price_range" };
  const STATE_KEY = "moexlab_tv_editor_state";

  function activeManager(page) {
    return page && page.activeTile && page.activeTile.drawingMgr ? page.activeTile.drawingMgr : (page && page.drawingMgr) || null;
  }

  function managers(page) {
    const seen = new Set(), result = [];
    const tiles = page && Array.isArray(page.tiles) ? page.tiles : [];
    tiles.forEach((tile) => {
      const dm = tile && tile.drawingMgr;
      if (dm && !seen.has(dm)) { seen.add(dm); result.push(dm); }
    });
    const active = activeManager(page);
    if (active && !seen.has(active)) result.push(active);
    return result;
  }

  function ensureState(page) {
    if (!page._tvState) {
      let saved = {};
      try { saved = JSON.parse(global.localStorage.getItem(STATE_KEY) || "{}"); } catch (e) { /* unavailable */ }
      page._tvState = { lastTool: Object.assign({}, DEFAULT_LAST, saved.lastTool || {}), keepDrawing: !!saved.keepDrawing };
    } else {
      page._tvState.lastTool = Object.assign({}, DEFAULT_LAST, page._tvState.lastTool || {});
    }
    return page._tvState;
  }

  function saveState(page) {
    try {
      global.localStorage.setItem(STATE_KEY, JSON.stringify({ lastTool: page._tvState.lastTool, keepDrawing: !!page._tvState.keepDrawing }));
    } catch (e) { /* unavailable */ }
  }

  function deactivateAll(page, deselectActive) {
    const active = activeManager(page);
    managers(page).forEach((dm) => {
      if (dm.activeTool || dm.draft || dm._draftPreviewPoint || dm._dragState) dm.setTool(null);
      dm.keepDrawing = !!ensureState(page).keepDrawing;
      if (deselectActive && dm === active && dm.selectedId) dm.select(null);
    });
  }

  function closeMenu(page) {
    if (!page || !page.root) return;
    const flyout = page.root.querySelector("#tvToolFlyout");
    if (flyout) flyout.classList.add("hidden");
    page._tvOpenGroup = null;
    page.root.classList.remove("tv-tool-menu-open");
  }

  function activate(page, groupId, toolId) {
    deactivateAll(page, true);
    const dm = activeManager(page);
    if (dm && toolId) {
      dm.keepDrawing = !!ensureState(page).keepDrawing;
      dm.setTool(toolId);
      dm.select(null);
    }
    ensureState(page).lastTool[groupId] = toolId;
    saveState(page);
    closeMenu(page);
    refresh(page);
  }

  function refresh(page) {
    if (!page || !page.root) return;
    const state = ensureState(page);
    const dm = activeManager(page);
    const activeTool = dm ? dm.activeTool : null;
    page.root.querySelectorAll(".tv-tool-group-btn[data-tv-group]").forEach((button) => {
      const group = GROUPS.find((g) => g.id === button.dataset.tvGroup);
      if (!group) return;
      const isActive = group.id === "cursor" ? (!activeTool && !page._tvOpenGroup) : group.tools.some((t) => t.id === activeTool);
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
      const lastId = group.id === "cursor" ? null : state.lastTool[group.id];
      const last = group.tools.find((t) => t.id === lastId) || group.tools[0];
      const icon = button.querySelector(".tv-group-icon");
      if (icon) icon.textContent = last.icon;
      button.title = last.label;
    });
    const magnet = page.root.querySelector("[data-tv-action='magnet']");
    if (magnet) magnet.classList.toggle("active", !!(dm && dm.snapEnabled));
    const keep = page.root.querySelector("[data-tv-action='keep']");
    if (keep) keep.classList.toggle("active", !!state.keepDrawing);
    const lock = page.root.querySelector("[data-tv-action='lock-all']");
    if (lock && dm) lock.classList.toggle("active", dm.drawings.length > 0 && dm.drawings.every((d) => d.locked));
    const hide = page.root.querySelector("[data-tv-action='hide-all']");
    if (hide && dm) hide.classList.toggle("active", dm.drawings.length > 0 && dm.drawings.every((d) => d.hidden));
  }

  // ------------------------------- one pointer stream for drawing gestures --
  const proto = Drawings.DrawingManager.prototype;
  const baseSetTool = proto.setTool;
  proto.setTool = function (type) {
    const pointerId = this._drawingPointerId;
    if (pointerId != null && this.core && this.core.container && this.core.container.releasePointerCapture) {
      try { this.core.container.releasePointerCapture(pointerId); } catch (e) { /* already released */ }
    }
    this._drawingPointerId = null;
    this._emptyPointerTap = null;
    this._draftPreviewPoint = null;
    this._dragState = null;
    return baseSetTool.call(this, type || null);
  };

  const baseCancelDraft = proto.cancelDraft;
  proto.cancelDraft = function () {
    this._draftPreviewPoint = null;
    return baseCancelDraft.call(this);
  };

  proto._bindDom = function () {
    const el = this.core.container;
    el.style.position = el.style.position || "relative";
    el.tabIndex = el.tabIndex >= 0 ? el.tabIndex : 0;
    const MOVE = 11, TAP_MS = 500, DOUBLE_MS = 360, DOUBLE_PX = 28;
    const rel = (e) => this._relXY(e);
    const owns = (e) => this._drawingPointerId === e.pointerId;

    const enter = () => { this._pointerInside = true; };
    const leave = () => { if (this._drawingPointerId == null) this._pointerInside = false; };
    const down = (e) => {
      if (e.isPrimary === false) return;
      const p = rel(e);
      const hit = this.activeTool ? null : this.hitTest(p.x, p.y);
      if (!this.activeTool && !hit) {
        if (e.pointerType === "touch" || e.pointerType === "pen") this._emptyPointerTap = { id: e.pointerId, x: p.x, y: p.y, at: Date.now() };
        else this.select(null);
        return; // chart keeps pan/zoom/pinch
      }
      this._emptyPointerTap = null;
      this._drawingPointerId = e.pointerId;
      this._pointerInside = true;
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      e.preventDefault();
      e.stopPropagation();
      this._onMouseDown(e);
    };
    const move = (e) => {
      if (owns(e)) {
        e.preventDefault();
        e.stopPropagation();
        this._onMouseMove(e);
        return;
      }
      const c = this._emptyPointerTap;
      if (c && c.id === e.pointerId) {
        const p = rel(e);
        if (Math.hypot(p.x - c.x, p.y - c.y) > MOVE) this._emptyPointerTap = null;
      } else if (e.pointerType === "mouse" && this._pointerInside) {
        this._onMouseMove(e);
      }
    };
    const finishOwned = (e, canceled) => {
      if (!owns(e)) return false;
      e.preventDefault();
      e.stopPropagation();
      if (!canceled) {
        this._onMouseUp();
        if ((e.pointerType === "touch" || e.pointerType === "pen") && this.draft) {
          const def = Drawings.TOOL_DEFS[this.draft.type];
          if (def && def.pointsNeeded < 0) {
            const p = rel(e), now = Date.now(), prev = this._lastDrawingTap;
            const dbl = prev && now - prev.at <= DOUBLE_MS && Math.hypot(p.x - prev.x, p.y - prev.y) <= DOUBLE_PX;
            this._lastDrawingTap = { at: now, x: p.x, y: p.y };
            if (dbl) { this._finishDraft(); this._emit({ pointerDoubleTap: true }); this._lastDrawingTap = null; }
          }
        }
      }
      if (el.releasePointerCapture) { try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      this._drawingPointerId = null;
      this._pointerInside = false;
      return true;
    };
    const up = (e) => {
      if (finishOwned(e, false)) return;
      const c = this._emptyPointerTap;
      if (!c || c.id !== e.pointerId) return;
      const p = rel(e);
      if (Date.now() - c.at <= TAP_MS && Math.hypot(p.x - c.x, p.y - c.y) <= MOVE) this.select(null);
      this._emptyPointerTap = null;
    };
    const cancel = (e) => {
      if (finishOwned(e, true)) return;
      if (this._emptyPointerTap && this._emptyPointerTap.id === e.pointerId) this._emptyPointerTap = null;
    };
    const dbl = (e) => this._onDblClick(e);
    const key = (e) => this._onKeyDown(e);

    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down, true);
    global.addEventListener("pointermove", move, true);
    global.addEventListener("pointerup", up, true);
    global.addEventListener("pointercancel", cancel, true);
    el.addEventListener("dblclick", dbl);
    el.addEventListener("keydown", key);
    this._pointerDomCleanup = () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down, true);
      global.removeEventListener("pointermove", move, true);
      global.removeEventListener("pointerup", up, true);
      global.removeEventListener("pointercancel", cancel, true);
      el.removeEventListener("dblclick", dbl);
      el.removeEventListener("keydown", key);
      this._pointerDomCleanup = null;
    };
  };

  const baseDestroy = proto.destroy;
  proto.destroy = function () {
    if (this._pointerDomCleanup) this._pointerDomCleanup();
    return baseDestroy.call(this);
  };

  // Existing renderer draws anchor circles for every object. Suppress them
  // unless the object is selected (draft anchors stay visible).
  function patchHandles(dm) {
    const view = dm && dm.primitive && dm.primitive._view;
    if (!view || view._pointerHandlesPatched || typeof view._drawOp !== "function") return;
    const draw = view._drawOp;
    view._drawOp = function (ctx, op, r, rv, w, h) {
      const handle = this._handle;
      const draft = !!(op && op.d && op.d.id === "__draft__");
      if (!op || (!op.selected && !draft)) this._handle = function () {};
      try { return draw.call(this, ctx, op, r, rv, w, h); }
      finally { this._handle = handle; }
    };
    view._pointerHandlesPatched = true;
    if (dm.primitive.requestUpdate) dm.primitive.requestUpdate();
  }

  function patchManagers(page) { managers(page).forEach(patchHandles); }

  // ------------------------------------------ pointer-driven tool chooser --
  function renderMenu(page, group, anchor) {
    deactivateAll(page, true);
    const rail = page.root.querySelector("#caTools");
    const menu = rail && rail.querySelector("#tvToolFlyout");
    if (!rail || !menu) return;
    menu.innerHTML = `<div class="tv-flyout-title">${group.label}</div>${group.tools.map((t) =>
      `<button type="button" class="tv-flyout-item" data-tv-tool="${t.id || ""}" data-tv-tool-group="${group.id}" role="menuitem"><span class="tv-flyout-icon">${t.icon}</span><span>${t.label}</span><span class="tv-flyout-check"></span></button>`
    ).join("")}`;
    const railRect = rail.getBoundingClientRect(), anchorRect = anchor.getBoundingClientRect();
    menu.style.top = `${Math.max(4, Math.min(anchorRect.top - railRect.top, Math.max(4, railRect.height - 260)))}px`;
    menu.classList.remove("hidden");
    page._tvOpenGroup = group.id;
    page.root.classList.add("tv-tool-menu-open");
    refresh(page);
  }

  function bulk(page, key, value) {
    const dm = activeManager(page);
    if (!dm) return;
    dm.drawings.slice().forEach((d) => dm.updateDrawing(d.id, { [key]: value }));
  }

  function rebuildRail(page) {
    const rail = page.root.querySelector("#caTools");
    if (!rail) return;
    if (page._tvPointerToolbarCleanup) page._tvPointerToolbarCleanup();
    const state = ensureState(page);
    rail.classList.add("tv-rail");
    rail.innerHTML = `${GROUPS.map((g) => {
      const lastId = g.id === "cursor" ? null : state.lastTool[g.id];
      const last = g.tools.find((t) => t.id === lastId) || g.tools[0];
      return `<button type="button" class="tv-tool-group-btn" data-tv-group="${g.id}" aria-pressed="false" title="${last.label}"><span class="tv-group-icon">${last.icon}</span>${g.tools.length > 1 ? '<span class="tv-caret">◢</span>' : ""}</button>`;
    }).join("")}
      <div class="tv-rail-divider"></div>
      <button type="button" class="tv-rail-action" data-tv-action="magnet" title="Магнит">⌁</button>
      <button type="button" class="tv-rail-action" data-tv-action="keep" title="Оставаться в режиме рисования">✎</button>
      <button type="button" class="tv-rail-action" data-tv-action="lock-all" title="Заблокировать все">⌑</button>
      <button type="button" class="tv-rail-action" data-tv-action="hide-all" title="Скрыть все">◉</button>
      <button type="button" class="tv-rail-action" data-tv-action="objects" title="Объекты">☷</button>
      <button type="button" class="tv-rail-action" data-tv-action="remove-all" title="Удалить все">⌫</button>
      <div class="tv-tool-flyout hidden" id="tvToolFlyout" role="menu"></div>`;

    const railDown = (e) => { if (e.target instanceof Element && e.target.closest("button")) e.stopPropagation(); };
    const railUp = (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const item = target.closest(".tv-flyout-item[data-tv-tool]");
      if (item) {
        e.preventDefault(); e.stopPropagation();
        activate(page, item.dataset.tvToolGroup, item.dataset.tvTool || null);
        return;
      }
      const groupButton = target.closest(".tv-tool-group-btn[data-tv-group]");
      if (groupButton) {
        e.preventDefault(); e.stopPropagation();
        const group = GROUPS.find((g) => g.id === groupButton.dataset.tvGroup);
        if (!group) return;
        if (group.tools.length === 1) activate(page, group.id, group.tools[0].id);
        else if (page._tvOpenGroup === group.id) { closeMenu(page); refresh(page); }
        else renderMenu(page, group, groupButton);
        return;
      }
      const actionButton = target.closest(".tv-rail-action[data-tv-action]");
      if (!actionButton) return;
      e.preventDefault(); e.stopPropagation(); closeMenu(page);
      const dm = activeManager(page);
      if (!dm) return;
      const action = actionButton.dataset.tvAction;
      if (action === "magnet") { dm.snapEnabled = !dm.snapEnabled; dm._emit({ snap: true }); }
      else if (action === "keep") { state.keepDrawing = !state.keepDrawing; dm.keepDrawing = state.keepDrawing; saveState(page); }
      else if (action === "lock-all") bulk(page, "locked", !(dm.drawings.length && dm.drawings.every((d) => d.locked)));
      else if (action === "hide-all") bulk(page, "hidden", !(dm.drawings.length && dm.drawings.every((d) => d.hidden)));
      else if (action === "objects") { if (page._setBottomCollapsed) page._setBottomCollapsed(false); const tab = page.root.querySelector('.ca-side-tab[data-side="objects"]'); if (tab) tab.click(); }
      else if (action === "remove-all" && dm.drawings.length && global.confirm("Удалить все объекты разметки на активном графике?")) dm.drawings.slice().forEach((d) => dm.removeDrawing(d.id));
      refresh(page);
    };
    const outside = (e) => {
      if (!page._tvOpenGroup) return;
      if (e.target instanceof Node && rail.contains(e.target)) return;
      closeMenu(page);
      refresh(page);
    };
    const escape = (e) => {
      if (e.key !== "Escape") return;
      if (page._tvOpenGroup) { e.preventDefault(); e.stopPropagation(); closeMenu(page); refresh(page); return; }
      const dm = activeManager(page);
      if (dm && (dm.draft || dm.activeTool)) { e.preventDefault(); dm.setTool(null); refresh(page); }
    };
    rail.addEventListener("pointerdown", railDown);
    rail.addEventListener("pointerup", railUp);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    page._tvPointerToolbarCleanup = () => {
      rail.removeEventListener("pointerdown", railDown);
      rail.removeEventListener("pointerup", railUp);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      page._tvPointerToolbarCleanup = null;
    };
    refresh(page);
  }

  // Fix the actual stacking issue seen on iPhone: backdrop-filter on the old
  // rail created a stacking context, so its z-index:90 flyout could still sit
  // underneath the sibling object toolbar. Raise the rail stacking context
  // itself, hide the object toolbar while choosing, and use 44px touch rows.
  const style = document.createElement("style");
  style.id = "chart-editor-pointer-fix";
  style.textContent = `
    #chartsRoot .ca-tools.tv-rail { position:relative; z-index:120; overflow:visible; }
    #chartsRoot .tv-tool-flyout { z-index:2; pointer-events:auto; }
    #chartsRoot.tv-tool-menu-open .tv-object-toolbar { display:none !important; }
    #chartsRoot .tv-flyout-item { min-height:44px; padding:7px 8px; touch-action:manipulation; -webkit-user-select:none; user-select:none; pointer-events:auto; }
    #chartsRoot .tv-tool-group-btn, #chartsRoot .tv-rail-action { min-height:44px; touch-action:manipulation; -webkit-user-select:none; user-select:none; }
    @media (hover:none) { #chartsRoot .tv-flyout-item:hover { background:transparent; } #chartsRoot .tv-flyout-item:active { background:rgba(124,140,255,.20); } }
  `;
  const oldStyle = document.getElementById(style.id);
  if (oldStyle) oldStyle.remove();
  document.head.appendChild(style);

  // In a one-chart workspace / phone viewport, fullscreen the workspace, not
  // only the tile, so the drawing rail and flyout remain inside the Fullscreen
  // API element and keep accepting taps.
  if (CE.ChartTile && CE.ChartTile.prototype && typeof CE.ChartTile.prototype.mount === "function") {
    const baseMount = CE.ChartTile.prototype.mount;
    CE.ChartTile.prototype.mount = function (container) {
      const result = baseMount.apply(this, arguments);
      const button = container && container.querySelector('[data-role="fs"]');
      if (button && !button.dataset.editorFsWired) {
        const tileClick = button.onclick;
        button.dataset.editorFsWired = "1";
        button.onclick = (e) => {
          const page = global.ChartAnalysisPage;
          const mobile = !!(global.matchMedia && global.matchMedia("(max-width:620px)").matches);
          const single = !!(page && Array.isArray(page.tiles) && page.tiles.length === 1);
          if ((mobile || single) && page && page._fsCtrl) { e.stopPropagation(); page._fsCtrl.toggle(); return; }
          if (typeof tileClick === "function") tileClick.call(button, e);
        };
      }
      return result;
    };
  }

  const pageBuild = Page._build;
  Page._build = function () {
    const result = pageBuild.apply(this, arguments);
    rebuildRail(this); // replaces the old click-wired rail DOM
    patchManagers(this);
    return result;
  };

  if (typeof Page._renderProps === "function") {
    const renderProps = Page._renderProps;
    Page._renderProps = function () {
      const result = renderProps.apply(this, arguments);
      patchManagers(this);
      refresh(this);
      if (this._tvOpenGroup) {
        const bar = this.root.querySelector("#tvObjectToolbar");
        if (bar) bar.classList.add("hidden");
      }
      return result;
    };
  }

  if (typeof Page._setActiveTile === "function") {
    const setActiveTile = Page._setActiveTile;
    Page._setActiveTile = function () {
      deactivateAll(this, false);
      closeMenu(this);
      const result = setActiveTile.apply(this, arguments);
      patchManagers(this);
      refresh(this);
      return result;
    };
  }

  global.ChartDrawingDiagnostics = {
    activeTool: () => activeManager(Page) ? activeManager(Page).activeTool : null,
    openGroup: () => Page._tvOpenGroup || null,
    managerStates: () => managers(Page).map((dm) => ({ activeTool: dm.activeTool, draftType: dm.draft && dm.draft.type, selectedId: dm.selectedId })),
  };
})(window);
