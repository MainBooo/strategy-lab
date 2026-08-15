/* Responsive viewport coordinator.
 *
 * This is the proven responsive coordinator from the pre-merge chart UI.
 * It constrains the existing unified toolbar and lets ChartAnalysisPage's
 * native priority overflow own button visibility. No second mobile toolbar
 * or cloned controls are created.
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

  function setDisplay(el, value) {
    if (el) el.style.display = value;
  }

  function setSizing(el, minWidth, maxWidth) {
    if (!el) return;
    el.style.minWidth = minWidth;
    el.style.maxWidth = maxWidth;
  }

  function constrainToolbar(page) {
    if (!page || !page.root) return;
    const toolbar = page.root.querySelector("#caToolbar");
    const scroll = page.root.querySelector("#gtScroll");
    if (!toolbar || !scroll) return;

    /* The original regression was caused by .gt-scroll using its max-content
     * width as the flex base. Constrain that existing row instead of creating
     * a second mobile representation. The native _recalcToolbarOverflow()
     * then moves low-priority data-key actions into the existing "Ещё" menu. */
    toolbar.style.width = "100%";
    toolbar.style.maxWidth = "100%";
    toolbar.style.minWidth = "0";
    scroll.style.flex = "1 1 0";
    scroll.style.minWidth = "0";
    scroll.style.maxWidth = "100%";

    const width = global.innerWidth || document.documentElement.clientWidth || 0;
    const name = page.root.querySelector("#gtName");
    const change = page.root.querySelector("#gtChange");
    const ticker = page.root.querySelector("#gtTicker");
    const timeframe = page.root.querySelector("#gtTimeframe");
    const chartType = page.root.querySelector("#gtChartType");
    const layoutMenu = page.root.querySelector("#gtLayoutMenu");

    if (width <= 1180) {
      setDisplay(name, "none");
      setDisplay(change, "none");
      setSizing(ticker, "82px", "112px");
      setSizing(timeframe, "52px", "64px");
      setSizing(chartType, "68px", "88px");
    } else {
      setDisplay(name, "");
      setDisplay(change, "");
      setSizing(ticker, "", "");
      setSizing(timeframe, "", "");
      setSizing(chartType, "", "");
    }

    if (width <= 900) setDisplay(layoutMenu, "none");
    else setDisplay(layoutMenu, "");
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

/* Dense indicator action buttons are unrelated to toolbar ownership and are
 * intentionally preserved from the current main. */
(function () {
  "use strict";
  const old = document.getElementById("chart-indicator-compact-actions");
  if (old) old.remove();
  const style = document.createElement("style");
  style.id = "chart-indicator-compact-actions";
  style.textContent = `
    #chartsRoot .ca-ind-list .ca-indicator-row { min-height:30px; gap:4px; padding:3px 2px; }
    #chartsRoot .ca-ind-list .ca-indicator-row > label { min-width:0; margin:0; gap:5px; font-size:11px; line-height:1.2; }
    #chartsRoot .ca-ind-list .ca-indicator-row button,
    #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn,
    #chartsRoot .sl-ind-active-row .sl-mini-icon-btn {
      width:28px !important; min-width:28px !important; max-width:28px !important;
      height:28px !important; min-height:28px !important; padding:0 !important; margin:0 !important;
      border-radius:6px !important; flex:0 0 28px !important; font-size:13px !important; line-height:1 !important;
    }
    #chartsRoot .ca-ind-list .ca-indicator-row button svg,
    #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn svg,
    #chartsRoot .sl-ind-active-row .sl-mini-icon-btn svg { width:13px !important; height:13px !important; flex:0 0 13px !important; }
    @media (max-width:620px) {
      #chartsRoot .ca-ind-list .ca-indicator-row { min-height:28px; gap:3px; padding:2px 1px; }
      #chartsRoot .ca-ind-list .ca-indicator-row button,
      #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn,
      #chartsRoot .sl-ind-active-row .sl-mini-icon-btn {
        width:26px !important; min-width:26px !important; max-width:26px !important;
        height:26px !important; min-height:26px !important; flex-basis:26px !important; border-radius:5px !important;
      }
    }
  `;
  document.head.appendChild(style);
})();
