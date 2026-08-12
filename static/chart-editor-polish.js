/* Final interaction polish for the TradingView-style chart editor.
 * Keeps the underlying DrawingManager/renderer intact and narrows two UI
 * behaviours: tool flyouts close on the first chart placement, and anchor
 * handles are visible only for the selected drawing (or an in-progress draft).
 */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const Drawings = CE && CE.Drawings;
  const Page = global.ChartAnalysisPage;
  if (!Drawings || !Drawings.DrawingManager || !Page) return;

  function closeToolFlyout() {
    const page = global.ChartAnalysisPage;
    if (!page || !page.root) return;
    const flyout = page.root.querySelector("#tvToolFlyout");
    if (flyout) flyout.classList.add("hidden");
    page._tvOpenGroup = null;
  }

  // Any actual placement on the chart means the user has finished choosing a
  // tool. Close the chooser immediately, before the first anchor is written.
  const proto = Drawings.DrawingManager.prototype;
  if (!proto._tvPlacementClosesFlyout) {
    const originalPlacePoint = proto._placePoint;
    proto._placePoint = function (x, y) {
      closeToolFlyout();
      return originalPlacePoint.call(this, x, y);
    };
    proto._tvPlacementClosesFlyout = true;
  }

  // DrawingPaneView is intentionally internal to drawings.js, but every
  // manager exposes its live view through primitive._view. Wrap that renderer
  // per-manager so handles are painted only when the object is selected.
  // Draft anchors remain visible while the user is actively drawing.
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
    patchManager(page.drawingMgr);
    if (page.activeTile) patchManager(page.activeTile.drawingMgr);

    const tiles = page.tiles;
    if (Array.isArray(tiles)) {
      tiles.forEach((tile) => patchManager(tile && tile.drawingMgr));
    } else if (tiles instanceof Map) {
      tiles.forEach((tile) => patchManager(tile && tile.drawingMgr));
    } else if (tiles && typeof tiles === "object") {
      Object.values(tiles).forEach((tile) => patchManager(tile && tile.drawingMgr));
    }
  }

  // Apply on initial workspace build and whenever selection/properties are
  // refreshed (which also covers switching the active tile).
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
