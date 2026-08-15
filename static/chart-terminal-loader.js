/* Safari-safe loader for the restored TradingView-style chart terminal.
 * Heavy terminal modules are loaded only when the chart workspace is opened,
 * and as classic scripts in strict sequence. This keeps initial page startup
 * lightweight and avoids dynamic-import/module execution quirks on iOS Safari.
 */
(function (global) {
  "use strict";

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
