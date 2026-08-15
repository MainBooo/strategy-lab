/* Responsive viewport coordinator.
 *
 * Loaded after the chart modules. CSS owns layout; this file only coordinates
 * viewport-dependent presentation around the existing ChartAnalysisPage,
 * DrawingManager and ChartCore instances. No parallel mobile state is created.
 */
(function (global) {
  "use strict";

  const PHONE_QUERY = "(max-width: 620px), (max-width: 960px) and (max-height: 520px)";
  const PHONE_TOOLBAR_OVERFLOW_KEYS = [
    "indicators", "templates", "alerts", "replay", "undo", "redo",
    "save", "settings", "snapshot", "collapseBottom", "collapseRight",
  ];
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

  function ensureMobileUxStyles() {
    if (document.getElementById("slChartMobileUxStyles")) return;
    const style = document.createElement("style");
    style.id = "slChartMobileUxStyles";
    style.textContent = `
      html.sl-phone-ui body.charts-active #chartsRoot .ca-toolbar-unified {
        padding: 3px 4px;
        gap: 3px;
        overflow: visible;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .gt-scroll {
        flex: 1 1 0;
        min-width: 0;
        gap: 3px;
      }
      html.sl-phone-ui body.charts-active #chartsRoot #gtPrice,
      html.sl-phone-ui body.charts-active #chartsRoot #gtName,
      html.sl-phone-ui body.charts-active #chartsRoot #gtChange,
      html.sl-phone-ui body.charts-active #chartsRoot #gtLayoutMenu {
        display: none;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .gt-ticker {
        flex: 0 1 72px;
        width: 72px;
        min-width: 64px;
        max-width: 78px;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .gt-tf {
        flex: 0 0 50px;
        width: 50px;
        min-width: 50px;
        max-width: 50px;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .gt-type {
        flex: 0 1 68px;
        width: 68px;
        min-width: 62px;
        max-width: 74px;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .gt-select {
        height: 44px;
        padding: 5px 5px;
        font-size: 12px;
      }
      html.sl-phone-ui body.charts-active #chartsRoot #caFullscreenBtn,
      html.sl-phone-ui body.charts-active #chartsRoot #gtMoreBtn {
        width: 42px;
        min-width: 42px;
        height: 44px;
        min-height: 44px;
        padding: 0;
      }
      html.sl-phone-ui body.charts-active #chartsRoot #gtMoreBtn svg { display: none; }
      html.sl-phone-ui body.charts-active #chartsRoot #gtMoreBtn::before {
        content: "•••";
        font-size: 15px;
        letter-spacing: 1px;
        line-height: 1;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-tile-header {
        min-height: 44px;
        height: 44px;
        padding: 4px 6px;
        gap: 5px;
        overflow: hidden;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-tile-tag {
        flex: 0 0 auto;
        max-width: 84px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-tile-realtime-slot {
        flex: 1 1 0;
        min-width: 0;
        overflow: hidden;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .rt-indicator,
      html.sl-phone-ui body.charts-active #chartsRoot .rt-indicator-btn,
      html.sl-phone-ui body.charts-active #chartsRoot .rt-label {
        min-width: 0;
        max-width: 100%;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .rt-indicator-btn {
        width: 100%;
        padding: 5px 8px;
        overflow: hidden;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .rt-label {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-tile-spacer { display: none; }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-tile-btn[data-role="fs"] {
        flex: 0 0 40px;
        width: 40px;
        min-width: 40px;
        height: 40px;
        min-height: 40px;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-center {
        position: relative;
        min-width: 0;
        min-height: 0;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-bottom:not(.collapsed) {
        position: fixed;
        flex: none;
        z-index: 560;
        left: max(8px, env(safe-area-inset-left));
        right: max(8px, env(safe-area-inset-right));
        bottom: calc(var(--sl-phone-nav-height, 58px) + max(8px, env(safe-area-inset-bottom)));
        width: auto;
        height: auto;
        max-height: min(58dvh, 430px);
        margin: 0;
        transform: none;
        overflow: hidden;
        border-radius: 16px 16px 12px 12px;
        box-shadow: 0 24px 70px rgba(0,0,0,.58);
      }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-bottom.collapsed { display: none; }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-resize-h { display: none; }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-bottom-body {
        max-height: calc(min(58dvh, 430px) - 44px);
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .ca-tools.tv-rail {
        width: 42px;
        min-width: 42px;
        max-width: 42px;
        padding-inline: 1px;
      }
      html.sl-phone-ui body.charts-active #chartsRoot .tv-tool-group-btn,
      html.sl-phone-ui body.charts-active #chartsRoot .tv-rail-action {
        width: 40px;
        min-width: 40px;
      }
      @media (max-width: 350px) {
        html.sl-phone-ui body.charts-active #chartsRoot .gt-ticker {
          flex-basis: 64px;
          width: 64px;
          min-width: 60px;
          max-width: 68px;
        }
        html.sl-phone-ui body.charts-active #chartsRoot .gt-type {
          flex-basis: 62px;
          width: 62px;
          min-width: 58px;
          max-width: 66px;
        }
        html.sl-phone-ui body.charts-active #chartsRoot .ca-tile-tag { max-width: 72px; }
      }
    `;
    document.head.appendChild(style);
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

  function syncTickerLabels(page, phone) {
    if (!page || !page.root) return;
    const select = page.root.querySelector("#gtTicker");
    if (!select) return;
    [...select.options].forEach((option) => {
      if (!option.dataset.slFullLabel) option.dataset.slFullLabel = option.textContent || "";
      option.textContent = phone ? option.value : option.dataset.slFullLabel;
    });
  }

  function applyPhoneToolbarPriorities(page, phone) {
    if (!page || !page.root) return;
    PHONE_TOOLBAR_OVERFLOW_KEYS.forEach((key) => {
      const el = page.root.querySelector(`[data-key="${key}"]`);
      if (!el) return;
      if (phone) el.classList.add("gt-hidden");
    });
  }

  function constrainToolbar(page, phone) {
    if (!page || !page.root) return;
    const toolbar = page.root.querySelector("#caToolbar");
    const scroll = page.root.querySelector("#gtScroll");
    if (!toolbar || !scroll) return;

    toolbar.style.width = "100%";
    toolbar.style.maxWidth = "100%";
    toolbar.style.minWidth = "0";
    scroll.style.flex = "1 1 0";
    scroll.style.minWidth = "0";
    scroll.style.maxWidth = "100%";

    const width = global.innerWidth || document.documentElement.clientWidth || 0;
    const name = page.root.querySelector("#gtName");
    const change = page.root.querySelector("#gtChange");
    const price = page.root.querySelector("#gtPrice");
    const ticker = page.root.querySelector("#gtTicker");
    const timeframe = page.root.querySelector("#gtTimeframe");
    const chartType = page.root.querySelector("#gtChartType");
    const layoutMenu = page.root.querySelector("#gtLayoutMenu");

    if (phone) {
      setDisplay(name, "none");
      setDisplay(change, "none");
      setDisplay(price, "none");
      setDisplay(layoutMenu, "none");
      setSizing(ticker, "", "");
      setSizing(timeframe, "", "");
      setSizing(chartType, "", "");
    } else if (width <= 1180) {
      setDisplay(name, "none");
      setDisplay(change, "none");
      setDisplay(price, "");
      setSizing(ticker, "82px", "112px");
      setSizing(timeframe, "52px", "64px");
      setSizing(chartType, "68px", "88px");
      if (width <= 900) setDisplay(layoutMenu, "none");
      else setDisplay(layoutMenu, "");
    } else {
      setDisplay(name, "");
      setDisplay(change, "");
      setDisplay(price, "");
      setDisplay(layoutMenu, "");
      setSizing(ticker, "", "");
      setSizing(timeframe, "", "");
      setSizing(chartType, "", "");
    }

    syncTickerLabels(page, phone);
  }

  function resizeExistingCharts(page, phone) {
    if (!page) return;
    constrainToolbar(page, phone);
    const tiles = Array.isArray(page.tiles) ? page.tiles : [];
    tiles.forEach((tile) => {
      if (tile && tile.core && typeof tile.core._onResize === "function") tile.core._onResize();
    });
    if (typeof page._recalcToolbarOverflow === "function") page._recalcToolbarOverflow();
    applyPhoneToolbarPriorities(page, phone);
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
      resizeExistingCharts(page, phone);
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

  function wrapChartPageMethods() {
    const page = global.ChartAnalysisPage;
    if (!page || page.__responsiveMethodsWrapped) return;

    if (typeof page.init === "function") {
      const originalInit = page.init;
      page.init = function () {
        const result = originalInit.apply(this, arguments);
        lastPhoneMode = null;
        scheduleSync();
        return result;
      };
    }

    if (typeof page._renderTickerOptions === "function") {
      const originalRenderTickerOptions = page._renderTickerOptions;
      page._renderTickerOptions = function () {
        const result = originalRenderTickerOptions.apply(this, arguments);
        scheduleSync();
        return result;
      };
    }

    if (typeof page._refreshGlobalHeader === "function") {
      const originalRefresh = page._refreshGlobalHeader;
      page._refreshGlobalHeader = function () {
        const result = originalRefresh.apply(this, arguments);
        if (isPhoneUi()) syncTickerLabels(this, true);
        return result;
      };
    }

    page.__responsiveMethodsWrapped = true;
  }

  ensureViewportFit();
  ensureMobileUxStyles();
  wrapChartPageMethods();

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
