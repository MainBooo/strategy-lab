/* Safari-safe loader for the restored TradingView-style chart terminal.
 * Heavy terminal modules are loaded only when the chart workspace is opened,
 * and as classic scripts in strict sequence. This keeps initial page startup
 * lightweight and avoids dynamic-import/module execution quirks on iOS Safari.
 */
(function (global) {
  "use strict";

  /* chart-analysis.js already owns the stable indicator selector: one
   * checkbox per registry item, plus the existing settings button for active
   * indicators. The terminal mobile enhancement temporarily replaces that
   * renderer with a long "+" list. Preserve the base renderer before loading
   * enhancements and restore it afterwards, then apply the categorized
   * checkbox presentation as the final indicator-selector layer. */
  const baseIndicatorRenderer = global.ChartAnalysisPage && global.ChartAnalysisPage._renderIndicatorsInto;

  const files = [
    "/static/chart-editor-terminal-indicators-v2.js",
    "/static/chart-editor-terminal-mobile-v2.js",
    "/static/chart-editor-terminal-fixes.js",
    "/static/chart-editor-terminal-compat.js",
    "/static/chart-editor-terminal-icons.js",
    "/static/chart-responsive-coordinator.js"
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
      script.onload = () => {
        script.dataset.loaded = "1";
        resolve();
      };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function start() {
    if (started) return;
    started = true;
    try {
      for (const src of files) await loadClassic(src);

      /* Restore the original checkbox behaviour only. Do not roll back any of
       * the terminal's drawing tools, expanded indicator registry, toolbar,
       * responsive handling or icon work. */
      if (baseIndicatorRenderer && global.ChartAnalysisPage) {
        global.ChartAnalysisPage._renderIndicatorsInto = baseIndicatorRenderer;
      }

      /* Final presentation layer: groups the same registry checkboxes by type
       * and shows currently selected indicators in a removable block at top. */
      await loadClassic("/static/chart-indicator-selector-categories.js");

      /* Use the existing top-toolbar chevron as the only Properties / Objects
       * collapse control and remove the duplicate X from the panel header. */
      await loadClassic("/static/chart-bottom-panel-toggle.js");

      finished = true;
      if (global.StrategyLabMobileChart && typeof global.StrategyLabMobileChart.refresh === "function") {
        requestAnimationFrame(() => global.StrategyLabMobileChart.refresh());
      }
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }

  global.StrategyLabTerminalLoader = {
    start,
    get started() { return started; },
    get ready() { return finished; }
  };
})(window);
