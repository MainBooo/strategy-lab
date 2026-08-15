/* Safari-safe loader for the restored TradingView-style chart terminal. */
(function (global) {
  "use strict";

  const files = [
    "/static/chart-editor-terminal-indicators-v2.js",
    "/static/chart-editor-terminal-mobile-v2.js",
    "/static/chart-editor-terminal-fixes.js",
    "/static/chart-editor-terminal-compat.js",
    "/static/chart-editor-terminal-icons.js"
  ];

  let started = false;
  let finished = false;

  function loadClassic(src) {
    return new Promise((resolve, reject) => {
      const key = `script[data-sl-terminal-src="${src}"]`;
      const existing = document.querySelector(key);
      if (existing) {
        if (existing.dataset.loaded === "1") resolve();
        else {
          existing.addEventListener("load", resolve, { once: true });
          existing.addEventListener("error", reject, { once: true });
        }
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.defer = false;
      script.dataset.slTerminalSrc = src;
      script.onload = () => { script.dataset.loaded = "1"; resolve(); };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  function installAdaptiveToolbarOverflow() {
    const Page = global.ChartAnalysisPage;
    if (!Page || Page.__slAdaptiveToolbarOverflow) return;
    Page.__slAdaptiveToolbarOverflow = true;

    Page._recalcToolbarOverflow = function () {
      const root = this.root;
      const toolbar = root && root.querySelector("#caToolbar");
      const scroll = root && root.querySelector("#gtScroll");
      if (!toolbar || !scroll) return;

      const items = [...scroll.querySelectorAll("[data-key]")]
        .sort((a, b) => Number(a.dataset.priority) - Number(b.dataset.priority));
      items.forEach((el) => el.classList.remove("gt-hidden"));

      const width = toolbar.getBoundingClientRect().width || global.innerWidth || 0;
      let forcedPriority = 0;
      if (width < 1500) forcedPriority = 5;
      if (width < 1320) forcedPriority = 8;
      if (width < 1120) forcedPriority = 10;
      // Phone: keep only the market controls and Indicators in the main row.
      // Everything secondary is already rendered by the native three-dot menu.
      if (width < 760) forcedPriority = 10;

      items.forEach((el) => {
        if (Number(el.dataset.priority) <= forcedPriority) el.classList.add("gt-hidden");
      });

      let guard = 0;
      while (scroll.scrollWidth > scroll.clientWidth + 1 && guard < items.length) {
        const next = items.find((el) => !el.classList.contains("gt-hidden"));
        if (!next) break;
        next.classList.add("gt-hidden");
        guard++;
      }

      const more = root.querySelector("#gtMoreMenu");
      if (more) more.classList.toggle("sl-has-overflow", items.some((el) => el.classList.contains("gt-hidden")));
    };

    const style = document.createElement("style");
    style.id = "sl-adaptive-chart-toolbar";
    style.textContent = `
      #chartsRoot .ca-toolbar-unified{min-width:0;overflow:hidden}
      #chartsRoot .gt-scroll{min-width:0;flex:1 1 auto;max-width:none;overflow:hidden}
      #chartsRoot .gt-more{flex:0 0 auto;margin-left:4px}
      #chartsRoot .gt-hidden{display:none!important}
      #chartsRoot #gtMoreMenu.sl-has-overflow #gtMoreBtn{border-color:rgba(124,140,255,.34)}
      @media(max-width:1320px){
        #chartsRoot .ca-toolbar-unified{gap:5px}
        #chartsRoot .gt-scroll{gap:5px}
        #chartsRoot .gt-btn,#chartsRoot .icon-btn{flex:0 0 auto}
      }
      @media(max-width:1120px){
        #chartsRoot .gt-name{display:none}
        #chartsRoot .gt-ticker{max-width:190px}
      }
      @media(max-width:760px){
        #chartsRoot .ca-toolbar-unified{gap:4px;padding-left:6px;padding-right:6px}
        #chartsRoot .gt-scroll{gap:4px}
        #chartsRoot #caFullscreenBtn{display:none!important}
        #chartsRoot #gtLayoutMenu{flex:0 0 auto}
        #chartsRoot #gtLayoutBtn,#chartsRoot #gtMoreBtn{width:36px;min-width:36px;padding:0}
        #chartsRoot .gt-ticker{min-width:0;max-width:180px}
      }
    `;
    document.head.appendChild(style);

    const recalc = () => requestAnimationFrame(() => Page._recalcToolbarOverflow());
    global.addEventListener("resize", recalc, { passive: true });
    global.addEventListener("orientationchange", recalc, { passive: true });
    document.addEventListener("strategylab:terminal-ready", recalc);
    recalc();
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      for (const src of files) await loadClassic(src);
      installAdaptiveToolbarOverflow();
      finished = true;
      if (global.StrategyLabMobileChart && typeof global.StrategyLabMobileChart.refresh === "function") {
        requestAnimationFrame(() => global.StrategyLabMobileChart.refresh());
      }
      requestAnimationFrame(() => {
        const Page = global.ChartAnalysisPage;
        if (Page && typeof Page._recalcToolbarOverflow === "function") Page._recalcToolbarOverflow();
      });
      document.dispatchEvent(new CustomEvent("strategylab:terminal-ready"));
    } catch (error) {
      started = false;
      console.error("[StrategyLab] chart terminal bundle failed", error);
    }
  }

  function chartsAreVisible() {
    const page = document.getElementById("tab-charts");
    return !!(page && !page.classList.contains("hidden"));
  }

  function install() {
    document.querySelectorAll('[data-tab="charts"]').forEach((button) => {
      button.addEventListener("click", start, { passive: true });
    });
    if (chartsAreVisible()) start();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();

  global.StrategyLabTerminalLoader = {
    start,
    get started() { return started; },
    get ready() { return finished; }
  };
})(window);
