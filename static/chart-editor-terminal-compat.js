/* Compatibility hooks and compact chart legend for the terminal core. */
(function (g) {
  "use strict";
  const Page = g.ChartAnalysisPage;
  const I = g.ChartEngine && g.ChartEngine.Indicators;
  if (!Page) return;

  if (I) {
    const pane = new Set(["adx", "aroon"]);
    const overlay = new Set(["rma", "vwma", "hma", "supertrend", "ichimoku", "psar", "keltner", "pivot", "highest_lowest", "linear_regression", "ma_envelope"]);
    I.registry.forEach((def) => {
      if (pane.has(def.id)) def.kind = "pane";
      if (overlay.has(def.id)) def.kind = "overlay";
    });
    const rsi = I.registry.find((x) => x.id === "rsi");
    if (rsi) rsi.aliases = [...new Set([...(rsi.aliases || []), "relative strength index", "индекс относительной силы"] )];
    const macd = I.registry.find((x) => x.id === "macd");
    if (macd) macd.aliases = [...new Set([...(macd.aliases || []), "moving average convergence divergence", "схождение расхождение скользящих средних"] )];
  }

  function manager() { return Page.activeTile && Page.activeTile.indicatorMgr; }
  function openIndicators(instanceId) {
    Page.root && Page.root.querySelector("#gtIndicatorsBtn")?.click();
    if (instanceId) requestAnimationFrame(() => Page.root?.querySelector(`[data-sl-set="${instanceId}"]`)?.click());
  }
  function renderLegend() {
    const tile = Page.activeTile;
    const host = tile && tile.el && tile.el.querySelector('[data-role="chartHost"]');
    if (!host || !tile.indicatorMgr) return;
    let legend = host.querySelector(".sl-chart-legend");
    if (!legend) { legend = document.createElement("div"); legend.className = "sl-chart-legend"; host.appendChild(legend); }
    const list = tile.indicatorMgr.list();
    legend.innerHTML = list.slice(0, 6).map((inst) => {
      const def = I && I.registry.find((x) => x.id === inst.type);
      const params = inst.params || {};
      const key = params.period || params.fast || params.rsiPeriod || "";
      const visible = !(inst.style && inst.style.visible === false);
      return `<div class="sl-chart-legend-chip ${visible ? "" : "off"}"><span>${def ? def.shortName || def.label : inst.type}${key ? ` ${key}` : ""}</span><button data-sl-legend-settings="${inst.id}" title="Настройки">⚙</button><button data-sl-legend-vis="${inst.id}" title="Показать/скрыть">◉</button><button data-sl-legend-remove="${inst.id}" title="Удалить">×</button></div>`;
    }).join("");
    legend.querySelectorAll("[data-sl-legend-settings]").forEach((b) => b.onclick = () => openIndicators(b.dataset.slLegendSettings));
    legend.querySelectorAll("[data-sl-legend-vis]").forEach((b) => b.onclick = () => {
      const m = manager(), item = m && m.list().find((x) => x.id === b.dataset.slLegendVis);
      if (!item) return;
      const visible = !(item.style && item.style.visible === false);
      if (typeof m.setVisible === "function") m.setVisible(item.id, !visible); else m.updateStyle(item.id, { visible: !visible });
      renderLegend();
    });
    legend.querySelectorAll("[data-sl-legend-remove]").forEach((b) => b.onclick = () => { const m = manager(); if (m) m.remove(b.dataset.slLegendRemove); renderLegend(); });
  }

  function relocatePopovers() {
    if (!Page.root) return;
    for (const id of ["gtAlertsPop", "gtTemplatesPop"]) {
      const pop = Page.root.querySelector(`#${id}`);
      if (pop && pop.parentElement !== Page.root) Page.root.appendChild(pop);
    }
  }

  function wireScaleControls() {
    if (!Page.root) return;
    const strip = Page.root.querySelector(".sl-chart-controls");
    if (!strip || strip.dataset.slScaleWired) return;
    strip.dataset.slScaleWired = "1";
    const buttons = strip.querySelectorAll("button");
    const percent = buttons[1], log = buttons[2];
    const apply = (mode, button) => {
      const tile = Page.activeTile;
      if (!tile || !tile.core) return;
      let current = 0;
      try { current = tile.core.chart.priceScale("right").options().mode || 0; } catch (_) {}
      const next = current === mode ? 0 : mode;
      try { tile.core.chart.priceScale("right").applyOptions({ mode: next }); } catch (_) {}
      percent && percent.classList.toggle("active", next === 2);
      log && log.classList.toggle("active", next === 1);
    };
    if (percent) { percent.title = "Процентная шкала"; percent.onclick = () => apply(2, percent); }
    if (log) { log.title = "Логарифмическая шкала"; log.onclick = () => apply(1, log); }
  }

  function syncLegacyHooks() {
    if (!Page.root) return;
    const objects = Page.root.querySelector('[data-sl-act="objects"]');
    if (objects) objects.setAttribute("data-tv-action", "objects");
    relocatePopovers();
    wireScaleControls();
    renderLegend();
  }

  if (typeof Page._build === "function") {
    const originalBuild = Page._build;
    Page._build = function () {
      const result = originalBuild.apply(this, arguments);
      requestAnimationFrame(syncLegacyHooks);
      return result;
    };
  }
  if (typeof Page._refreshGlobalHeader === "function") {
    const originalHeader = Page._refreshGlobalHeader;
    Page._refreshGlobalHeader = function () {
      const result = originalHeader.apply(this, arguments);
      renderLegend();
      return result;
    };
  }
  if (typeof Page._renderIndicatorsInto === "function") {
    const originalIndicators = Page._renderIndicatorsInto;
    Page._renderIndicatorsInto = function (container) {
      const result = originalIndicators.call(this, container);
      renderLegend();
      return result;
    };
  }

  const style = document.createElement("style");
  style.id = "sl-pro-terminal-compat";
  style.textContent = `
    #chartsRoot .sl-chart-legend{display:none}
    @media(max-width:768px),(max-width:980px) and (max-height:520px){
      html.sl-chart-phone body.charts-active #chartsRoot>.ca-popover{position:fixed!important;z-index:790!important;left:max(6px,env(safe-area-inset-left))!important;right:max(6px,env(safe-area-inset-right))!important;top:auto!important;bottom:calc(var(--sl-nav) + max(6px,env(safe-area-inset-bottom)))!important;width:auto!important;max-width:none!important;max-height:min(72dvh,620px)!important;overflow:auto!important;border-radius:16px 16px 10px 10px!important;background:#0d1320!important}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend{position:absolute;z-index:32;top:104px;left:8px;max-width:calc(100% - 82px);display:flex;gap:3px;overflow-x:auto;pointer-events:auto;scrollbar-width:none}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend::-webkit-scrollbar{display:none}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend-chip{flex:0 0 auto;height:30px;display:flex;align-items:center;border:1px solid rgba(148,163,184,.14);border-radius:6px;background:rgba(8,12,20,.84);color:#b9c3d5;font-size:9px;backdrop-filter:blur(4px)}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend-chip.off{opacity:.48}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend-chip>span{padding:0 5px;max-width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend-chip>button{width:28px;height:28px;border:0;border-left:1px solid rgba(148,163,184,.08);background:transparent;color:#8f9bb0;font-size:11px;padding:0}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-controls button.active{color:#b8c0ff;background:rgba(124,140,255,.12)}
    }
    @media(max-width:980px) and (max-height:520px){html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend{top:78px}}
  `;
  document.head.appendChild(style);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncLegacyHooks, { once: true });
  else syncLegacyHooks();
})(window);
