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
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function fmtVal(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    const av = Math.abs(v);
    const d = av >= 1 ? 2 : av >= 0.01 ? 4 : 8;
    return v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: d });
  }
  // Reads back the already-rendered series data instead of recomputing the
  // indicator here, so the legend can never disagree with what's actually
  // drawn (and doesn't need to know each indicator's own compute() return
  // shape - sma/rsi/... return one line, bollinger/macd/donchian/stochastic
  // return several, and the ~27 indicators added by
  // chart-editor-terminal-indicators-v2.js are unknown shapes to this file).
  function seriesLastValue(series) {
    try {
      const data = series.data();
      if (!data || !data.length) return null;
      const last = data[data.length - 1];
      return last && Number.isFinite(last.value) ? last.value : null;
    } catch (e) { return null; }
  }
  /** TradingView-standard on-chart legend: symbol/timeframe/OHLC of the
   * latest bar plus each active indicator's name, color swatch and current
   * value - previously mobile-only (hidden by CSS on desktop, see below)
   * and without live values at all (name + one static param only). */
  function renderLegend() {
    const tile = Page.activeTile;
    const host = tile && tile.el && tile.el.querySelector('[data-role="chartHost"]');
    if (!host || !tile.indicatorMgr) return;
    // Self-registers once per tile so the legend's OHLC/indicator values
    // keep updating on every new candle/live tick, not just on the handful
    // of explicit call sites below (build, header refresh, indicator list
    // change).
    if (tile.core && !tile.core._legendSubscribed) {
      tile.core._legendSubscribed = true;
      tile.core.onDataChanged(() => renderLegend());
    }
    let legend = host.querySelector(".sl-chart-legend");
    if (!legend) { legend = document.createElement("div"); legend.className = "sl-chart-legend"; host.appendChild(legend); }
    const candles = (tile.core && tile.core.candles) || [];
    const last = candles[candles.length - 1];
    const tfLabel = (tile.listTimeframes && tile.listTimeframes().find((t) => t.id === tile.timeframe) || {}).label || tile.timeframe;
    const ohlcHtml = last ? `<div class="sl-chart-legend-ohlc">
        <b>${esc(tile.symbol)}</b><span class="sl-legend-tf">${esc(tfLabel)}</span>
        <span>O<em>${fmtVal(last.open)}</em></span><span>H<em>${fmtVal(last.high)}</em></span>
        <span>L<em>${fmtVal(last.low)}</em></span><span>C<em class="${last.close >= last.open ? "up" : "down"}">${fmtVal(last.close)}</em></span>
      </div>` : "";
    const list = tile.indicatorMgr.list();
    const indHtml = list.slice(0, 8).map((inst) => {
      const def = I && I.registry.find((x) => x.id === inst.type);
      const engineInst = tile.indicatorMgr.instances.get(inst.id);
      const visible = !(inst.style && inst.style.visible === false);
      const colors = (inst.style && (inst.style.colors || (inst.style.color ? [inst.style.color] : []))) || [];
      const values = engineInst && engineInst.series ? engineInst.series.map((s) => seriesLastValue(s)) : [];
      const valuesHtml = values.length
        ? values.map((v, i) => `<em style="color:${colors[i] || colors[0] || "#9aa6ba"}">${fmtVal(v)}</em>`).join(" ")
        : "";
      return `<div class="sl-chart-legend-chip ${visible ? "" : "off"}"><i class="sl-legend-dot" style="background:${colors[0] || "#9aa6ba"}"></i><span>${esc(def ? def.shortName || def.label : inst.type)}</span>${valuesHtml ? `<span class="sl-legend-values">${valuesHtml}</span>` : ""}<button data-sl-legend-settings="${inst.id}" title="Настройки">⚙</button><button data-sl-legend-vis="${inst.id}" title="Показать/скрыть">◉</button><button data-sl-legend-remove="${inst.id}" title="Удалить">×</button></div>`;
    }).join("");
    legend.innerHTML = ohlcHtml + indHtml;
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

  // The legend also needs to refresh whenever an indicator is added/removed/
  // restyled from *any* UI - not just its own buttons above. There are (at
  // least) two competing indicator-popover implementations loaded at
  // different times (see chart-terminal-loader.js), and the one that ends
  // up live doesn't necessarily call any Page.* hook this file already
  // wraps. Patching IndicatorPaneManager's own mutator methods once here
  // catches every caller, present or future, instead of chasing each
  // popover's specific click handlers.
  if (I && I.PaneManager && I.PaneManager.prototype) {
    ["add", "remove", "updateParams", "updateStyle", "setVisible"].forEach((method) => {
      if (typeof I.PaneManager.prototype[method] !== "function") return;
      const original = I.PaneManager.prototype[method];
      I.PaneManager.prototype[method] = function (...args) {
        const result = original.apply(this, args);
        renderLegend();
        return result;
      };
    });
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
    #chartsRoot .sl-chart-legend{position:absolute;z-index:32;top:8px;left:8px;max-width:calc(100% - 16px);display:flex;flex-wrap:wrap;gap:4px;align-items:center;pointer-events:auto}
    #chartsRoot .sl-chart-legend-ohlc{display:flex;align-items:center;gap:6px;height:26px;padding:0 8px;border-radius:6px;background:rgba(8,12,20,.72);backdrop-filter:blur(4px);color:#c7cfdd;font:600 11px/1 system-ui,sans-serif;white-space:nowrap}
    #chartsRoot .sl-chart-legend-ohlc b{color:#edf1fa;font-weight:700}
    #chartsRoot .sl-legend-tf{color:#8f9bb0}
    #chartsRoot .sl-chart-legend-ohlc span{display:flex;align-items:center;gap:2px;color:#7c879c}
    #chartsRoot .sl-chart-legend-ohlc em{font-style:normal;color:#c7cfdd}
    #chartsRoot .sl-chart-legend-ohlc em.up{color:#4dd4ac}
    #chartsRoot .sl-chart-legend-ohlc em.down{color:#ff7081}
    #chartsRoot .sl-chart-legend-chip{display:flex;align-items:center;gap:4px;height:26px;padding:0 4px 0 7px;border:1px solid rgba(148,163,184,.14);border-radius:6px;background:rgba(8,12,20,.72);color:#b9c3d5;font-size:11px;backdrop-filter:blur(4px)}
    #chartsRoot .sl-legend-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
    #chartsRoot .sl-legend-values em{font-style:normal;margin-left:5px;font-weight:600}
    #chartsRoot .sl-chart-legend-chip.off{opacity:.48}
    @media(max-width:768px),(max-width:980px) and (max-height:520px){
      html.sl-chart-phone body.charts-active #chartsRoot>.ca-popover{position:fixed!important;z-index:790!important;left:max(6px,env(safe-area-inset-left))!important;right:max(6px,env(safe-area-inset-right))!important;top:auto!important;bottom:calc(var(--sl-nav) + max(6px,env(safe-area-inset-bottom)))!important;width:auto!important;max-width:none!important;max-height:min(72dvh,620px)!important;overflow:auto!important;border-radius:16px 16px 10px 10px!important;background:#0d1320!important}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend{position:absolute;z-index:32;top:104px;left:8px;max-width:calc(100% - 82px);display:flex;gap:3px;overflow-x:auto;pointer-events:auto;scrollbar-width:none}
      html.sl-chart-phone body.charts-active #chartsRoot .sl-chart-legend-ohlc{display:none}
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
