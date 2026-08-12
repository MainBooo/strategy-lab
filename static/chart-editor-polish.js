/* Interaction/state polish for the TradingView-style chart editor.
 *
 * The chart workspace owns one DrawingManager per active ChartTile.  The UI
 * editor historically also exposed page.drawingMgr; on mobile those two can
 * briefly diverge while a flyout is open/switching tools.  This file makes the
 * active tile the source of truth, closes chooser flyouts deterministically,
 * clears stale tools when another group is opened, and keeps edit handles
 * visible only for the selected drawing (or an in-progress draft).
 */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const Drawings = CE && CE.Drawings;
  const Page = global.ChartAnalysisPage;
  if (!Drawings || !Drawings.DrawingManager || !Page) return;

  const TOOL_GROUP_BY_ID = {
    trend_line: "trend", ray: "trend", extended_line: "trend",
    horizontal_line: "trend", vertical_line: "trend", parallel_channel: "trend",
    fib_retracement: "fib", fib_extension: "fib",
    rectangle: "shapes", circle: "shapes", polyline: "shapes",
    text: "notes", note: "notes",
    price_range: "measure", time_range: "measure",
    long_position: "measure", short_position: "measure",
  };

  function pageInstance() {
    return global.ChartAnalysisPage || Page;
  }

  function activeManager(page) {
    if (!page) return null;
    if (page.activeTile && page.activeTile.drawingMgr) return page.activeTile.drawingMgr;
    if (page.drawingMgr) return page.drawingMgr;

    // Defensive fallback for layout transitions: find the visually active tile.
    const tiles = page.tiles;
    const all = Array.isArray(tiles) ? tiles
      : tiles instanceof Map ? Array.from(tiles.values())
        : tiles && typeof tiles === "object" ? Object.values(tiles) : [];
    const active = all.find((tile) => tile && tile.el && tile.el.classList && tile.el.classList.contains("active"));
    return active && active.drawingMgr ? active.drawingMgr : null;
  }

  function closeAllToolFlyouts(page) {
    document.querySelectorAll("#chartsRoot #tvToolFlyout").forEach((flyout) => flyout.classList.add("hidden"));
    if (page) page._tvOpenGroup = null;
  }

  function cancelStaleTool(page) {
    const dm = activeManager(page);
    if (!dm) return;
    if (dm.draft) dm.cancelDraft();
    if (dm.activeTool) dm.setTool(null);
    if (dm.selectedId) dm.select(null);
  }

  function armTool(page, toolId) {
    const dm = activeManager(page);
    if (!dm) {
      closeAllToolFlyouts(page);
      return;
    }

    // Changing tools must never inherit the unfinished draft/selection of the
    // previously active tool.  This is what caused a rectangle choice to keep
    // producing the preceding trend-line geometry on mobile.
    if (dm.draft) dm.cancelDraft();
    dm.setTool(toolId || null);
    dm.select(null);

    const groupId = TOOL_GROUP_BY_ID[toolId];
    if (groupId && page._tvState && page._tvState.lastTool) {
      page._tvState.lastTool[groupId] = toolId;
    }
    closeAllToolFlyouts(page);
  }

  const proto = Drawings.DrawingManager.prototype;

  // Failsafe: if a placement somehow starts while a chooser is still visible,
  // hide every flyout before the first anchor is written.  This deliberately
  // avoids relying on page.drawingMgr, because _placePoint already runs on the
  // exact manager that owns the touched chart.
  if (!proto._tvPlacementClosesEveryFlyout) {
    const originalPlacePoint = proto._placePoint;
    proto._placePoint = function (x, y) {
      closeAllToolFlyouts(pageInstance());
      return originalPlacePoint.call(this, x, y);
    };
    proto._tvPlacementClosesEveryFlyout = true;
  }

  // Capture the chooser item before its legacy onclick runs.  Pointer/click
  // dispatch on iOS Safari can differ depending on whether a flyout overlaps
  // the chart; event delegation here guarantees that the ACTIVE TILE receives
  // the selected tool and the flyout disappears immediately.
  if (!document.documentElement.dataset.tvToolSelectionFix) {
    document.documentElement.dataset.tvToolSelectionFix = "1";

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const item = target.closest("#chartsRoot .tv-flyout-item[data-tv-tool]");
      if (item) {
        const page = pageInstance();
        armTool(page, item.dataset.tvTool || null);
        // Do not stop propagation: the existing handler may still update its
        // persisted last-tool state/rail icon.  Our active manager is already
        // correct, so a stale page alias can no longer determine behaviour.
        return;
      }

      const groupButton = target.closest("#chartsRoot .tv-tool-group-btn[data-tv-group]");
      if (groupButton) {
        // Let the existing group handler open/toggle the flyout first.  If a
        // chooser remains visible after that click, we are in "choose a tool"
        // mode and must neutralise the previously armed tool.  This prevents a
        // tap through/after the menu from drawing the old line type.
        setTimeout(() => {
          const page = pageInstance();
          const flyout = document.querySelector("#chartsRoot #tvToolFlyout");
          if (flyout && !flyout.classList.contains("hidden")) cancelStaleTool(page);
        }, 0);
      }
    }, true);
  }

  // Handles: paint anchors only when the drawing is actually selected.  Draft
  // anchors remain visible while a new object is being constructed.
  function patchManager(manager) {
    const view = manager && manager.primitive && manager.primitive._view;
    if (!view || view._tvSelectedHandlesOnly || typeof view._drawOp !== "function") return;

    const originalDrawOp = view._drawOp;
    view._drawOp = function (ctx, op, r, rv, w, h) {
      const originalHandle = this._handle;
      const isDraft = !!(op && op.d && op.d.id === "__draft__");
      if (!op || (!op.selected && !isDraft)) this._handle = function () {};
      try {
        return originalDrawOp.call(this, ctx, op, r, rv, w, h);
      } finally {
        this._handle = originalHandle;
      }
    };
    view._tvSelectedHandlesOnly = true;
    if (manager.primitive && typeof manager.primitive.requestUpdate === "function") manager.primitive.requestUpdate();
  }

  function patchPageManagers(page) {
    if (!page) return;
    patchManager(activeManager(page));
    if (page.drawingMgr) patchManager(page.drawingMgr);

    const tiles = page.tiles;
    if (Array.isArray(tiles)) {
      tiles.forEach((tile) => patchManager(tile && tile.drawingMgr));
    } else if (tiles instanceof Map) {
      tiles.forEach((tile) => patchManager(tile && tile.drawingMgr));
    } else if (tiles && typeof tiles === "object") {
      Object.values(tiles).forEach((tile) => patchManager(tile && tile.drawingMgr));
    }
  }

  if (typeof Page._build === "function") {
    const originalBuild = Page._build;
    Page._build = function () {
      const result = originalBuild.apply(this, arguments);
      patchPageManagers(this);
      return result;
    };
  }

  if (typeof Page._renderProps === "function") {
    const originalRenderProps = Page._renderProps;
    Page._renderProps = function () {
      patchPageManagers(this);
      return originalRenderProps.apply(this, arguments);
    };
  }

  if (typeof Page._setActiveTile === "function") {
    const originalSetActiveTile = Page._setActiveTile;
    Page._setActiveTile = function () {
      const result = originalSetActiveTile.apply(this, arguments);
      patchPageManagers(this);
      return result;
    };
  }
})(window);
