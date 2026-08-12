/* Mobile interaction compatibility + TradingView-style chart editor prototype.
 *
 * This file deliberately layers interaction/UI behavior on top of the
 * existing ChartAnalysisPage + ChartEngine drawing/indicator engines instead
 * of replacing price rendering, persistence, or the backend APIs.
 */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const Drawings = CE && CE.Drawings;

  // ---------------------------------------------------------------- touch --
  // Preserve the existing mouse implementation and bridge touch gestures only
  // when the drawing layer owns the interaction. Plain empty-chart gestures
  // still belong to Lightweight Charts so pan/zoom keeps working naturally.
  if (Drawings && Drawings.DrawingManager) {
    const proto = Drawings.DrawingManager.prototype;
    const originalBindDom = proto._bindDom;

    proto._bindDom = function () {
      originalBindDom.call(this);

      const el = this.core.container;
      const asMouseLike = (touch) => ({
        clientX: touch.clientX,
        clientY: touch.clientY,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        key: "",
      });
      const firstTouch = (e) => (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || null;

      el.addEventListener("touchstart", (e) => {
        const touch = firstTouch(e);
        if (!touch) return;
        const mouseLike = asMouseLike(touch);
        const pos = this._relXY(mouseLike);
        const hit = this.activeTool ? null : this.hitTest(pos.x, pos.y);

        // Empty-chart touches must stay available to Lightweight Charts for
        // pan/zoom. Still remember a possible TAP, though: if the finger is
        // released without moving, it behaves like TradingView and clears the
        // selected drawing. A drag cancels this candidate and remains pure pan.
        if (!this.activeTool && !hit) {
          this._mobileEmptyTapCandidate = { x: pos.x, y: pos.y, time: Date.now() };
          return;
        }
        this._mobileEmptyTapCandidate = null;

        e.preventDefault();
        e.stopPropagation();
        this._pointerInside = true;
        this._mobileTouchActive = true;

        const previousTap = this._mobileLastTap;
        this._onMouseDown(mouseLike);

        const now = Date.now();
        const isDoubleTap = previousTap
          && now - previousTap.time < 360
          && Math.hypot(pos.x - previousTap.x, pos.y - previousTap.y) < 28;
        if (isDoubleTap && this.draft) {
          const def = Drawings.TOOL_DEFS[this.draft.type];
          if (def && def.pointsNeeded < 0) {
            this._finishDraft();
            this._emit();
          }
        }
        this._mobileLastTap = { time: now, x: pos.x, y: pos.y };
      }, { passive: false, capture: true });

      el.addEventListener("touchmove", (e) => {
        const touch = firstTouch(e);
        if (!touch) return;
        if (!this._mobileTouchActive) {
          const candidate = this._mobileEmptyTapCandidate;
          if (candidate) {
            const pos = this._relXY(asMouseLike(touch));
            if (Math.hypot(pos.x - candidate.x, pos.y - candidate.y) > 10) this._mobileEmptyTapCandidate = null;
          }
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this._onMouseMove(asMouseLike(touch));
      }, { passive: false, capture: true });

      const finishTouch = (e, canceled) => {
        if (!this._mobileTouchActive) {
          const candidate = this._mobileEmptyTapCandidate;
          if (!canceled && candidate && Date.now() - candidate.time < 500) {
            const touch = firstTouch(e);
            if (touch) {
              const pos = this._relXY(asMouseLike(touch));
              if (Math.hypot(pos.x - candidate.x, pos.y - candidate.y) <= 10) this.select(null);
            }
          }
          this._mobileEmptyTapCandidate = null;
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this._onMouseUp();
        this._mobileTouchActive = false;
        this._pointerInside = false;
        this._mobileEmptyTapCandidate = null;
      };
      el.addEventListener("touchend", (e) => finishTouch(e, false), { passive: false, capture: true });
      el.addEventListener("touchcancel", (e) => finishTouch(e, true), { passive: false, capture: true });
    };

    // TradingView's "Keep drawing" mode: normally a completed drawing returns
    // to the cursor; when enabled, re-arm the same tool after committing it.
    const originalFinishDraft = proto._finishDraft;
    proto._finishDraft = function () {
      const tool = this.draft && this.draft.type;
      originalFinishDraft.call(this);
      if (this.keepDrawing && tool) {
        this.activeTool = tool;
        this._emit({ toolKept: true });
      }
    };
  }

  const Page = global.ChartAnalysisPage;
  if (!Page) return;

  // ---------------------------------------------------------- overflow UI --
  // On narrow screens toolbar items move into "More". Their original popovers
  // live inside hidden parents, so render the same content in the visible More
  // popover instead.
  if (typeof Page._renderMorePopover === "function") {
    const originalRenderMore = Page._renderMorePopover;

    const openSubmenu = (page, title, render) => {
      const pop = page.root.querySelector("#gtMorePop");
      if (!pop) return;
      pop.innerHTML = `
        <div class="ca-more-group tv-mobile-subhead">
          <button class="ca-more-item" type="button" data-mobile-more-back>← Назад</button>
          <div class="ca-more-heading">${title}</div>
        </div>
        <div class="ca-more-sep"></div>
        <div data-mobile-more-body></div>
      `;
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
        const btn = pop.querySelector(`[data-act="${action}"]`);
        if (!btn) return;
        btn.onclick = (e) => {
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

  // ------------------------------------------------ TradingView-like editor --
  const TOOL_GROUPS = [
    {
      id: "cursor",
      label: "Курсор",
      icon: "⌖",
      tools: [{ id: null, label: "Курсор / перекрестие", icon: "⌖" }],
    },
    {
      id: "trend",
      label: "Линии тренда",
      icon: "╱",
      tools: [
        { id: "trend_line", label: "Линия тренда", icon: "╱" },
        { id: "ray", label: "Луч", icon: "↗" },
        { id: "extended_line", label: "Расширенная линия", icon: "⟷" },
        { id: "horizontal_line", label: "Горизонтальный уровень", icon: "—" },
        { id: "vertical_line", label: "Вертикальная линия", icon: "│" },
        { id: "parallel_channel", label: "Параллельный канал", icon: "═" },
      ],
    },
    {
      id: "fib",
      label: "Фибоначчи",
      icon: "F",
      tools: [
        { id: "fib_retracement", label: "Коррекция Фибоначчи", icon: "F" },
        { id: "fib_extension", label: "Расширение Фибоначчи", icon: "Fx" },
      ],
    },
    {
      id: "shapes",
      label: "Геометрические фигуры",
      icon: "▭",
      tools: [
        { id: "rectangle", label: "Прямоугольник", icon: "▭" },
        { id: "circle", label: "Окружность / эллипс", icon: "○" },
        { id: "polyline", label: "Полилиния", icon: "⌁" },
      ],
    },
    {
      id: "notes",
      label: "Аннотации",
      icon: "T",
      tools: [
        { id: "text", label: "Текст", icon: "T" },
        { id: "note", label: "Заметка", icon: "▣" },
      ],
    },
    {
      id: "measure",
      label: "Измерения и позиции",
      icon: "↕",
      tools: [
        { id: "price_range", label: "Диапазон цены", icon: "↕" },
        { id: "time_range", label: "Диапазон времени", icon: "↔" },
        { id: "long_position", label: "Long позиция", icon: "↑" },
        { id: "short_position", label: "Short позиция", icon: "↓" },
      ],
    },
  ];

  const TOOL_BY_ID = new Map();
  TOOL_GROUPS.forEach((group) => group.tools.forEach((tool) => TOOL_BY_ID.set(tool.id || "__cursor__", { group, tool })));

  const TV_STATE_KEY = "moexlab_tv_editor_state";
  const DEFAULT_TOOL_BY_GROUP = {
    cursor: null,
    trend: "trend_line",
    fib: "fib_retracement",
    shapes: "rectangle",
    notes: "text",
    measure: "price_range",
  };

  function loadEditorState() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(TV_STATE_KEY) || "{}"); } catch (e) { /* ignore */ }
    return {
      lastTool: Object.assign({}, DEFAULT_TOOL_BY_GROUP, saved.lastTool || {}),
      keepDrawing: !!saved.keepDrawing,
      railCompact: saved.railCompact !== false,
    };
  }

  function saveEditorState(page) {
    if (!page._tvState) return;
    try {
      localStorage.setItem(TV_STATE_KEY, JSON.stringify({
        lastTool: page._tvState.lastTool,
        keepDrawing: !!page._tvState.keepDrawing,
        railCompact: page._tvState.railCompact !== false,
      }));
    } catch (e) { /* ignore */ }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function injectPrototypeStyles() {
    if (document.getElementById("tv-editor-prototype-styles")) return;
    const style = document.createElement("style");
    style.id = "tv-editor-prototype-styles";
    style.textContent = `
      /* Strategy Lab — TradingView-style editor prototype */
      #chartsRoot .ca-workspace { position: relative; }
      #chartsRoot .ca-tools.tv-rail {
        width: 50px;
        min-width: 50px;
        padding: 5px 4px;
        gap: 2px;
        overflow: visible;
        border-right: 1px solid var(--line);
        background: rgba(13,18,30,.96);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
      }
      #chartsRoot .tv-tool-group-btn,
      #chartsRoot .tv-rail-action {
        position: relative;
        width: 40px;
        height: 40px;
        min-height: 40px;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #aab4c9;
        font: 600 17px/1 system-ui, sans-serif;
        cursor: pointer;
        touch-action: manipulation;
      }
      #chartsRoot .tv-tool-group-btn:hover,
      #chartsRoot .tv-rail-action:hover { background: rgba(124,140,255,.10); color: #eef2ff; }
      #chartsRoot .tv-tool-group-btn.active,
      #chartsRoot .tv-rail-action.active {
        color: #8e9bff;
        background: rgba(93,108,255,.18);
        box-shadow: inset 0 0 0 1px rgba(124,140,255,.72);
      }
      #chartsRoot .tv-tool-group-btn .tv-caret {
        position: absolute;
        right: 3px;
        bottom: 3px;
        font-size: 7px;
        opacity: .55;
      }
      #chartsRoot .tv-rail-divider {
        height: 1px;
        margin: 4px 5px;
        background: var(--line);
      }
      #chartsRoot .tv-tool-flyout {
        position: absolute;
        left: 48px;
        top: 4px;
        z-index: 90;
        width: 250px;
        max-height: min(520px, calc(100vh - 130px));
        overflow: auto;
        padding: 8px;
        border: 1px solid rgba(140,154,186,.23);
        border-radius: 10px;
        background: rgba(20,26,42,.98);
        box-shadow: 0 18px 55px rgba(0,0,0,.48);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
      }
      #chartsRoot .tv-flyout-title {
        padding: 5px 8px 8px;
        color: #8792aa;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .06em;
        text-transform: uppercase;
      }
      #chartsRoot .tv-flyout-item {
        width: 100%;
        min-height: 38px;
        display: grid;
        grid-template-columns: 28px 1fr 18px;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: #e6ebf6;
        text-align: left;
        font: 500 13px/1.2 system-ui, sans-serif;
        cursor: pointer;
      }
      #chartsRoot .tv-flyout-item:hover { background: rgba(124,140,255,.11); }
      #chartsRoot .tv-flyout-item.active { background: rgba(124,140,255,.16); color: #fff; }
      #chartsRoot .tv-flyout-icon { text-align: center; color: #aeb7ca; font-weight: 700; }
      #chartsRoot .tv-flyout-check { color: #8e9bff; text-align: center; }
      #chartsRoot .tv-object-toolbar {
        position: absolute;
        z-index: 82;
        top: 58px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 5px;
        width: max-content;
        max-width: calc(100% - 130px);
        min-height: 42px;
        padding: 5px 7px;
        box-sizing: border-box;
        border: 1px solid rgba(140,154,186,.25);
        border-radius: 10px;
        background: rgba(20,26,42,.96);
        box-shadow: 0 14px 42px rgba(0,0,0,.40);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        overflow-x: auto;
        scrollbar-width: none;
      }
      #chartsRoot .tv-object-toolbar::-webkit-scrollbar { display: none; }
      #chartsRoot .tv-object-toolbar.hidden { display: none; }
      #chartsRoot .tv-object-name {
        flex: 0 0 auto;
        max-width: 150px;
        padding: 0 5px;
        color: #dfe5f2;
        font-size: 12px;
        font-weight: 650;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #chartsRoot .tv-obj-control,
      #chartsRoot .tv-obj-btn {
        flex: 0 0 auto;
        width: auto !important;
        min-width: 34px;
        height: 30px;
        border: 1px solid rgba(140,154,186,.18);
        border-radius: 6px;
        background: rgba(255,255,255,.025);
        color: #dbe1ed;
        font: 600 12px/1 system-ui, sans-serif;
      }
      #chartsRoot .tv-obj-control[data-tv-prop-width] { width: 58px !important; }
      #chartsRoot .tv-obj-control[data-tv-prop-dash] { width: 54px !important; }
      #chartsRoot .tv-obj-btn { cursor: pointer; padding: 0 8px; }
      #chartsRoot .tv-obj-btn:hover { background: rgba(124,140,255,.13); }
      #chartsRoot .tv-obj-btn.danger:hover { color: #ff8f9d; background: rgba(255,100,120,.10); }
      #chartsRoot .tv-color {
        width: 32px !important;
        min-width: 32px;
        padding: 3px;
        cursor: pointer;
      }
      #chartsRoot .tv-indicator-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      #chartsRoot .tv-indicator-title { font-size: 13px; font-weight: 700; color: #edf1fa; }
      #chartsRoot .tv-indicator-count { color: #7f8aa1; font-size: 11px; }
      #chartsRoot .tv-indicator-search {
        width: 100%;
        min-height: 38px;
        margin: 0 0 9px;
        padding: 0 11px;
        border: 1px solid rgba(140,154,186,.22);
        border-radius: 8px;
        background: rgba(5,8,16,.42);
        color: #edf1fa;
        outline: none;
        font: 500 13px system-ui, sans-serif;
      }
      #chartsRoot .tv-indicator-search:focus { border-color: rgba(124,140,255,.65); }
      #chartsRoot .tv-indicator-tabs {
        display: flex;
        gap: 4px;
        margin-bottom: 8px;
      }
      #chartsRoot .tv-indicator-tab {
        padding: 6px 9px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: #8f9ab0;
        font-size: 11px;
        font-weight: 650;
      }
      #chartsRoot .tv-indicator-tab.active { color: #dfe5f5; background: rgba(124,140,255,.13); }
      #chartsRoot .ca-popover:has(.tv-indicator-search) { width: min(370px, calc(100vw - 78px)); }
      #chartsRoot .tv-rail-tip {
        position: fixed;
        z-index: 120;
        pointer-events: none;
        max-width: 220px;
        padding: 6px 8px;
        border-radius: 6px;
        background: #252c3d;
        color: #f1f4fb;
        font-size: 11px;
        box-shadow: 0 8px 28px rgba(0,0,0,.35);
        opacity: 0;
        transform: translateY(4px);
        transition: opacity .12s, transform .12s;
      }
      #chartsRoot .tv-rail-tip.show { opacity: 1; transform: translateY(0); }
      @media (max-width: 620px) {
        #chartsRoot .ca-tools.tv-rail {
          width: 46px;
          min-width: 46px;
          padding-left: 2px;
          padding-right: 2px;
        }
        #chartsRoot .tv-tool-group-btn,
        #chartsRoot .tv-rail-action { width: 40px; height: 42px; min-height: 42px; }
        #chartsRoot .tv-tool-flyout {
          left: 44px;
          width: min(265px, calc(100vw - 78px));
          max-height: calc(100dvh - 180px);
        }
        #chartsRoot .tv-object-toolbar {
          top: 58px;
          left: 53px;
          right: auto;
          transform: none;
          width: max-content;
          max-width: calc(100vw - 72px);
          min-height: 38px;
          gap: 4px;
          padding: 4px 5px;
        }
        #chartsRoot .tv-object-name { display: none; }
        #chartsRoot .tv-obj-control,
        #chartsRoot .tv-obj-btn { height: 30px; min-width: 32px; }
        #chartsRoot .tv-obj-btn { padding: 0 7px; }
      }
    `;
    document.head.appendChild(style);
  }

  function closeToolFlyout(page) {
    if (!page || !page.root) return;
    const flyout = page.root.querySelector("#tvToolFlyout");
    if (flyout) flyout.classList.add("hidden");
    page._tvOpenGroup = null;
  }

  function selectTool(page, groupId, toolId) {
    const dm = page.drawingMgr;
    if (!dm) return;
    page._tvState.lastTool[groupId] = toolId;
    dm.keepDrawing = !!page._tvState.keepDrawing;
    dm.setTool(toolId);
    if (!toolId) dm.select(null);
    closeToolFlyout(page);
    refreshTradingViewRail(page);
    saveEditorState(page);
  }

  function renderToolFlyout(page, group, anchor) {
    const flyout = page.root.querySelector("#tvToolFlyout");
    if (!flyout) return;
    const activeTool = page.drawingMgr ? page.drawingMgr.activeTool : null;
    flyout.innerHTML = `
      <div class="tv-flyout-title">${escapeHtml(group.label)}</div>
      ${group.tools.map((tool) => `
        <button type="button" class="tv-flyout-item ${activeTool === tool.id ? "active" : ""}" data-tv-tool="${tool.id || ""}">
          <span class="tv-flyout-icon">${tool.icon}</span>
          <span>${escapeHtml(tool.label)}</span>
          <span class="tv-flyout-check">${activeTool === tool.id ? "✓" : ""}</span>
        </button>
      `).join("")}
    `;
    flyout.querySelectorAll("[data-tv-tool]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        selectTool(page, group.id, btn.dataset.tvTool || null);
      };
    });
    const railRect = page.root.querySelector("#caTools").getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const top = Math.max(4, Math.min(anchorRect.top - railRect.top, railRect.height - 220));
    flyout.style.top = `${top}px`;
    flyout.classList.remove("hidden");
    page._tvOpenGroup = group.id;
  }

  function refreshTradingViewRail(page) {
    if (!page.root || !page._tvState) return;
    const dm = page.drawingMgr;
    if (dm) dm.keepDrawing = !!page._tvState.keepDrawing;
    const activeTool = dm ? dm.activeTool : null;
    page.root.querySelectorAll("[data-tv-group]").forEach((btn) => {
      const group = TOOL_GROUPS.find((g) => g.id === btn.dataset.tvGroup);
      if (!group) return;
      const belongs = group.tools.some((tool) => tool.id === activeTool) || (group.id === "cursor" && !activeTool);
      btn.classList.toggle("active", belongs);
      const lastId = group.id === "cursor" ? null : page._tvState.lastTool[group.id];
      const last = group.tools.find((tool) => tool.id === lastId) || group.tools[0];
      const icon = btn.querySelector(".tv-group-icon");
      if (icon) icon.textContent = last.icon;
      btn.title = last.label;
      btn.setAttribute("aria-label", last.label);
    });
    const magnet = page.root.querySelector("[data-tv-action='magnet']");
    if (magnet) magnet.classList.toggle("active", !!(dm && dm.snapEnabled));
    const keep = page.root.querySelector("[data-tv-action='keep']");
    if (keep) keep.classList.toggle("active", !!page._tvState.keepDrawing);
    const lock = page.root.querySelector("[data-tv-action='lock-all']");
    if (lock && dm) {
      const allLocked = dm.drawings.length > 0 && dm.drawings.every((d) => d.locked);
      lock.classList.toggle("active", allLocked);
    }
    const hide = page.root.querySelector("[data-tv-action='hide-all']");
    if (hide && dm) {
      const allHidden = dm.drawings.length > 0 && dm.drawings.every((d) => d.hidden);
      hide.classList.toggle("active", allHidden);
    }
  }

  function bulkUpdate(page, key, value) {
    const dm = page.drawingMgr;
    if (!dm || !dm.drawings.length) return;
    dm.drawings.slice().forEach((d) => dm.updateDrawing(d.id, { [key]: value }));
    refreshTradingViewRail(page);
  }

  function buildTradingViewRail(page) {
    const rail = page.root.querySelector("#caTools");
    if (!rail) return;
    page._tvState = page._tvState || loadEditorState();
    rail.classList.add("tv-rail");
    rail.innerHTML = `
      ${TOOL_GROUPS.map((group) => {
        const lastId = group.id === "cursor" ? null : page._tvState.lastTool[group.id];
        const last = group.tools.find((tool) => tool.id === lastId) || group.tools[0];
        return `
          <button type="button" class="tv-tool-group-btn" data-tv-group="${group.id}" title="${escapeHtml(last.label)}" aria-label="${escapeHtml(last.label)}">
            <span class="tv-group-icon">${last.icon}</span>
            ${group.tools.length > 1 ? `<span class="tv-caret">◢</span>` : ""}
          </button>
        `;
      }).join("")}
      <div class="tv-rail-divider"></div>
      <button type="button" class="tv-rail-action" data-tv-action="magnet" title="Магнит: привязка к OHLC" aria-label="Магнит">⌁</button>
      <button type="button" class="tv-rail-action" data-tv-action="keep" title="Оставаться в режиме рисования" aria-label="Оставаться в режиме рисования">✎</button>
      <button type="button" class="tv-rail-action" data-tv-action="lock-all" title="Заблокировать все объекты" aria-label="Заблокировать все объекты">⌑</button>
      <button type="button" class="tv-rail-action" data-tv-action="hide-all" title="Скрыть все объекты" aria-label="Скрыть все объекты">◉</button>
      <button type="button" class="tv-rail-action" data-tv-action="objects" title="Дерево объектов" aria-label="Дерево объектов">☷</button>
      <button type="button" class="tv-rail-action" data-tv-action="remove-all" title="Удалить все объекты" aria-label="Удалить все объекты">⌫</button>
      <div class="tv-tool-flyout hidden" id="tvToolFlyout"></div>
    `;

    rail.querySelectorAll("[data-tv-group]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const group = TOOL_GROUPS.find((g) => g.id === btn.dataset.tvGroup);
        if (!group) return;
        if (group.tools.length === 1) {
          selectTool(page, group.id, group.tools[0].id);
          return;
        }
        if (page._tvOpenGroup === group.id) {
          selectTool(page, group.id, page._tvState.lastTool[group.id] || group.tools[0].id);
        } else {
          renderToolFlyout(page, group, btn);
        }
      };
    });

    rail.querySelectorAll("[data-tv-action]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const dm = page.drawingMgr;
        const action = btn.dataset.tvAction;
        if (!dm) return;
        if (action === "magnet") {
          dm.snapEnabled = !dm.snapEnabled;
          dm._emit({ snap: true });
        } else if (action === "keep") {
          page._tvState.keepDrawing = !page._tvState.keepDrawing;
          dm.keepDrawing = page._tvState.keepDrawing;
          saveEditorState(page);
        } else if (action === "lock-all") {
          const next = !(dm.drawings.length && dm.drawings.every((d) => d.locked));
          bulkUpdate(page, "locked", next);
        } else if (action === "hide-all") {
          const next = !(dm.drawings.length && dm.drawings.every((d) => d.hidden));
          bulkUpdate(page, "hidden", next);
        } else if (action === "objects") {
          if (typeof page._setBottomCollapsed === "function") page._setBottomCollapsed(false);
          const tab = page.root.querySelector('.ca-side-tab[data-side="objects"]');
          if (tab) tab.click();
        } else if (action === "remove-all") {
          if (!dm.drawings.length) return;
          if (!global.confirm("Удалить все объекты разметки на активном графике?")) return;
          dm.drawings.slice().forEach((d) => dm.removeDrawing(d.id));
        }
        refreshTradingViewRail(page);
      };
    });

    document.addEventListener("click", (e) => {
      if (!rail.contains(e.target)) closeToolFlyout(page);
    });

    refreshTradingViewRail(page);
  }

  function drawingLabel(d) {
    const def = Drawings && Drawings.TOOL_DEFS ? Drawings.TOOL_DEFS[d.type] : null;
    return (d.properties && d.properties.label) || (def && def.label) || d.type;
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

    const dm = page.drawingMgr;
    const d = dm && dm.drawings.find((x) => x.id === dm.selectedId);
    if (!d) {
      bar.classList.add("hidden");
      bar.innerHTML = "";
      return;
    }

    const color = /^#[0-9a-f]{6}$/i.test(d.properties.color || "") ? d.properties.color : "#7c8cff";
    const width = Number(d.properties.width || 1);
    const dash = d.properties.dash || "solid";
    bar.innerHTML = `
      <span class="tv-object-name" title="${escapeHtml(drawingLabel(d))}">${escapeHtml(drawingLabel(d))}</span>
      <input class="tv-obj-control tv-color" data-tv-prop-color type="color" value="${color}" title="Цвет">
      <select class="tv-obj-control" data-tv-prop-width title="Толщина">
        ${[1,2,3,4].map((n) => `<option value="${n}" ${width === n ? "selected" : ""}>${n}px</option>`).join("")}
      </select>
      <select class="tv-obj-control" data-tv-prop-dash title="Стиль линии">
        <option value="solid" ${dash === "solid" ? "selected" : ""}>—</option>
        <option value="dashed" ${dash === "dashed" ? "selected" : ""}>– –</option>
        <option value="dotted" ${dash === "dotted" ? "selected" : ""}>···</option>
      </select>
      <button class="tv-obj-btn ${d.locked ? "active" : ""}" data-tv-obj-lock title="${d.locked ? "Разблокировать" : "Заблокировать"}">${d.locked ? "🔒" : "🔓"}</button>
      <button class="tv-obj-btn" data-tv-obj-duplicate title="Дублировать">⧉</button>
      <button class="tv-obj-btn" data-tv-obj-more title="Свойства">⚙</button>
      <button class="tv-obj-btn danger" data-tv-obj-delete title="Удалить">⌫</button>
    `;
    bar.classList.remove("hidden");

    bar.querySelector("[data-tv-prop-color]").oninput = (e) => dm.updateDrawing(d.id, { properties: { color: e.target.value } });
    bar.querySelector("[data-tv-prop-width]").onchange = (e) => dm.updateDrawing(d.id, { properties: { width: Number(e.target.value) } });
    bar.querySelector("[data-tv-prop-dash]").onchange = (e) => dm.updateDrawing(d.id, { properties: { dash: e.target.value } });
    bar.querySelector("[data-tv-obj-lock]").onclick = () => dm.updateDrawing(d.id, { locked: !d.locked });
    bar.querySelector("[data-tv-obj-duplicate]").onclick = () => dm.duplicateDrawing(d.id);
    bar.querySelector("[data-tv-obj-delete]").onclick = () => dm.removeDrawing(d.id);
    bar.querySelector("[data-tv-obj-more]").onclick = () => {
      if (typeof page._setBottomCollapsed === "function") page._setBottomCollapsed(false);
      const tab = page.root.querySelector('.ca-side-tab[data-side="props"]');
      if (tab) tab.click();
    };
  }

  // Search-first indicator chooser, while preserving the existing manager and
  // settings widgets. It mirrors the TradingView mental model without trying
  // to fake indicators the engine does not actually implement.
  if (typeof Page._renderIndicatorsInto === "function") {
    const originalRenderIndicators = Page._renderIndicatorsInto;
    Page._renderIndicatorsInto = function (container) {
      originalRenderIndicators.call(this, container);
      const list = container.querySelector(".ca-ind-list");
      if (!list || container.querySelector(".tv-indicator-search")) return;

      const activeCount = this.activeTile && this.activeTile.indicatorMgr
        ? this.activeTile.indicatorMgr.list().length : 0;
      const head = document.createElement("div");
      head.innerHTML = `
        <div class="tv-indicator-head">
          <div class="tv-indicator-title">Индикаторы и стратегии</div>
          <div class="tv-indicator-count">Активно: ${activeCount}</div>
        </div>
        <input class="tv-indicator-search" type="search" placeholder="Поиск индикаторов" autocomplete="off">
        <div class="tv-indicator-tabs">
          <button type="button" class="tv-indicator-tab active">Технические</button>
          <button type="button" class="tv-indicator-tab" disabled title="Пользовательские индикаторы пока не подключены">Мои</button>
        </div>
      `;
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
      setTimeout(() => {
        if (global.matchMedia && global.matchMedia("(max-width: 620px)").matches) search.focus({ preventScroll: true });
      }, 0);
    };
  }

  // Patch build once: original page still owns top toolbar, watchlist, grid,
  // persistence, panel sizing, etc.; only the left editing rail is replaced.
  if (typeof Page._build === "function") {
    const originalBuild = Page._build;
    Page._build = function () {
      originalBuild.call(this);
      buildTradingViewRail(this);
      renderObjectToolbar(this);
    };
  }

  // Keep floating toolbar + active rail state in sync with selection/tool
  // changes. _renderProps is already called from DrawingManager.onChange().
  if (typeof Page._renderProps === "function") {
    const originalRenderProps = Page._renderProps;
    Page._renderProps = function () {
      originalRenderProps.call(this);
      refreshTradingViewRail(this);
      renderObjectToolbar(this);
    };
  }

  injectPrototypeStyles();
})(window);
