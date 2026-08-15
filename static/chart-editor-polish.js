/* Responsive viewport coordinator.
 *
 * Historical note: this filename used to be an editor-polish shim.  It is
 * still loaded last by index.html, which makes it the safest small place to
 * coordinate viewport-only behavior without touching DrawingManager or chart
 * state.  CSS owns layout; this file only:
 *   - enables safe-area viewport coverage,
 *   - gives short phone landscape the same compact UI class as portrait,
 *   - collapses the existing Properties/Objects panel when entering phone UI,
 *   - constrains the existing unified chart toolbar to its real container,
 *   - asks existing chart instances/toolbar overflow logic to re-measure after
 *     resize, orientation and Safari visual-viewport changes.
 *
 * No separate mobile panel/drawing state is introduced.  _bottomCollapsed,
 * DrawingManager and ChartCore remain the single sources of truth.
 */
(function (global) {
  "use strict";

  const PHONE_QUERY = "(max-width: 620px), (max-width: 960px) and (max-height: 520px)";
  let lastPhoneMode = null;
  let resizeFrame = 0;

  function ensureViewportFit() {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const content = meta.getAttribute("content") || "width=device-width,initial-scale=1";
    if (!/viewport-fit\s*=\s*cover/i.test(content)) {
      meta.setAttribute("content", `${content},viewport-fit=cover`);
    }
  }

  function isPhoneUi() {
    return !!(global.matchMedia && global.matchMedia(PHONE_QUERY).matches);
  }

  function constrainToolbar(page) {
    if (!page || !page.root) return;
    const toolbar = page.root.querySelector("#caToolbar");
    const scroll = page.root.querySelector("#gtScroll");
    if (!toolbar || !scroll) return;

    /*
     * .gt-scroll historically used flex: 1 1 auto while its children and
     * popovers intentionally keep overflow:visible. At tablet widths that
     * makes the flex base equal to the toolbar's max-content width; the row
     * can therefore grow ~50px beyond the viewport before the existing
     * _recalcToolbarOverflow() sees a constrained clientWidth. Giving the
     * flexible row a zero basis makes the real toolbar box the constraint.
     * The existing priority algorithm then moves low-priority actions into
     * "Ещё" exactly as designed. No controls are removed and popovers remain
     * visible outside their button boxes.
     */
    toolbar.style.width = "100%";
    toolbar.style.maxWidth = "100%";
    toolbar.style.minWidth = "0";
    scroll.style.flex = "1 1 0";
    scroll.style.minWidth = "0";
    scroll.style.maxWidth = "100%";
  }

  function resizeExistingCharts(page) {
    if (!page) return;
    constrainToolbar(page);
    const tiles = Array.isArray(page.tiles) ? page.tiles : [];
    tiles.forEach((tile) => {
      if (tile && tile.core && typeof tile.core._onResize === "function") tile.core._onResize();
    });
    if (typeof page._recalcToolbarOverflow === "function") page._recalcToolbarOverflow();
  }

  function syncViewport() {
    const phone = isPhoneUi();
    document.documentElement.classList.toggle("sl-phone-ui", phone);

    const page = global.ChartAnalysisPage;
    if (page && page.root) {
      const enteringPhone = phone && lastPhoneMode !== true;
      if (enteringPhone && typeof page._setBottomCollapsed === "function") {
        // Presentation default only: do not overwrite the persisted desktop
        // preference. Selection/drawings are untouched by this method.
        page._setBottomCollapsed(true, { skipSave: true });
      }
      resizeExistingCharts(page);
      lastPhoneMode = phone;
    }
  }

  function scheduleSync() {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      syncViewport();
    });
  }

  function wrapChartPageInit() {
    const page = global.ChartAnalysisPage;
    if (!page || typeof page.init !== "function" || page.__responsiveInitWrapped) return;
    const originalInit = page.init;
    page.init = function () {
      const result = originalInit.apply(this, arguments);
      // _restoreWorkspaceState() runs inside init. Reconcile the presentation
      // after that restore so a desktop-open panel does not eat a phone chart.
      lastPhoneMode = null;
      scheduleSync();
      return result;
    };
    page.__responsiveInitWrapped = true;
  }

  ensureViewportFit();
  wrapChartPageInit();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleSync, { once: true });
  } else {
    scheduleSync();
  }

  const media = global.matchMedia ? global.matchMedia(PHONE_QUERY) : null;
  if (media) {
    if (typeof media.addEventListener === "function") media.addEventListener("change", scheduleSync);
    else if (typeof media.addListener === "function") media.addListener(scheduleSync);
  }

  global.addEventListener("resize", scheduleSync, { passive: true });
  global.addEventListener("orientationchange", scheduleSync, { passive: true });
  if (global.visualViewport) {
    global.visualViewport.addEventListener("resize", scheduleSync, { passive: true });
  }
})(window);
