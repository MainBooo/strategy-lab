/* Small post-load compatibility layer for the mobile terminal core. */
(function (g) {
  "use strict";
  const Page = g.ChartAnalysisPage;
  const CE = g.ChartEngine;
  if (!Page || !CE) return;

  function isPhone() {
    return !!(g.matchMedia && g.matchMedia("(max-width:768px),(max-width:980px) and (max-height:520px)").matches);
  }

  // The base manager exposes style.visible through list(). Keep the mobile eye
  // button wired to that real state rather than a second UI-only flag.
  if (typeof Page._renderIndicatorsInto === "function") {
    const originalIndicators = Page._renderIndicatorsInto;
    Page._renderIndicatorsInto = function (container) {
      const result = originalIndicators.call(this, container);
      const tile = this.activeTile;
      if (!tile || !container) return result;
      container.querySelectorAll("[data-sl-vis]").forEach((button) => {
        button.onclick = () => {
          const item = tile.indicatorMgr.list().find((x) => x.id === button.dataset.slVis);
          if (!item) return;
          const currentlyVisible = !(item.style && item.style.visible === false);
          if (typeof tile.indicatorMgr.setVisible === "function") tile.indicatorMgr.setVisible(item.id, !currentlyVisible);
          else tile.indicatorMgr.updateStyle(item.id, { visible: !currentlyVisible });
          this._saveWorkspaceState();
          this._renderIndicatorsInto(container);
        };
      });
      return result;
    };
  }

  // Fullscreen is priority-exempt in the desktop toolbar, therefore the old
  // overflow builder is not guaranteed to place it under "..." on a phone.
  // Add explicit secondary actions while reusing the existing controllers.
  if (typeof Page._renderMorePopover === "function") {
    const originalMore = Page._renderMorePopover;
    Page._renderMorePopover = function () {
      const result = originalMore.call(this);
      const pop = this.root && this.root.querySelector("#gtMorePop");
      if (!pop || pop.querySelector("[data-sl-more-actions]")) return result;
      const block = document.createElement("div");
      block.dataset.slMoreActions = "1";
      block.innerHTML = `
        <div class="ca-more-sep"></div>
        <div class="ca-more-group">
          <button class="ca-more-item" type="button" data-sl-more="alerts">Оповещения</button>
          <button class="ca-more-item" type="button" data-sl-more="templates">Шаблоны</button>
          <button class="ca-more-item" type="button" data-sl-more="settings">Настройки графика</button>
          <button class="ca-more-item" type="button" data-sl-more="fullscreen">Полноэкранный режим</button>
        </div>`;
      pop.appendChild(block);
      const close = () => pop.classList.add("hidden");
      block.querySelector('[data-sl-more="alerts"]').onclick = () => { close(); this.root.querySelector("#gtAlertBtn")?.click(); };
      block.querySelector('[data-sl-more="templates"]').onclick = () => { close(); this.root.querySelector("#gtTemplatesBtn")?.click(); };
      block.querySelector('[data-sl-more="settings"]').onclick = () => { close(); this._openSettingsDialog(); };
      block.querySelector('[data-sl-more="fullscreen"]').onclick = () => { close(); this._fsCtrl && this._fsCtrl.toggle(); };
      return result;
    };
  }

  // On phones the selected native <option> should read like "SBER", not a
  // clipped desktop "SBER · Сбер" string. Preserve the full text for desktop.
  function compactTickerLabels() {
    const select = Page.root && Page.root.querySelector("#gtTicker");
    if (!select) return;
    [...select.options].forEach((option) => {
      if (!option.dataset.slFullLabel) option.dataset.slFullLabel = option.textContent || option.value;
      option.textContent = isPhone() ? option.value : option.dataset.slFullLabel;
    });
  }
  if (typeof Page._renderTickerOptions === "function") {
    const originalTicker = Page._renderTickerOptions;
    Page._renderTickerOptions = function () {
      const result = originalTicker.apply(this, arguments);
      compactTickerLabels();
      return result;
    };
  }

  function polish() {
    if (!Page.root) return;
    compactTickerLabels();
    (Page.tiles || []).forEach((tile) => {
      if (!tile || !tile.core) return;
      try { tile.core.candleSeries.applyOptions({ priceLineVisible: true, priceLineStyle: 2 }); } catch (_) {}
    });
  }

  const style = document.createElement("style");
  style.id = "sl-pro-terminal-fixes";
  style.textContent = `
    @media(max-width:768px),(max-width:980px) and (max-height:520px){
      html.sl-chart-phone body.charts-active #chartsRoot #gtIndicatorsBtn .gt-btn-label{display:inline!important}
      html.sl-chart-phone body.charts-active #chartsRoot .ca-tile-grid{display:block!important;height:100%}
      html.sl-chart-phone body.charts-active #chartsRoot .ca-tile-grid>.ca-tile{display:none!important;height:100%}
      html.sl-chart-phone body.charts-active #chartsRoot .ca-tile-grid>.ca-tile.active{display:flex!important}
      html.sl-chart-phone body.charts-active .ca-modal-backdrop{align-items:stretch;padding:max(6px,env(safe-area-inset-top)) max(6px,env(safe-area-inset-right)) max(6px,env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-left))}
      html.sl-chart-phone body.charts-active .ca-settings-modal{width:100%;max-width:none;max-height:100%;margin:0;border-radius:14px;overflow:auto}
      #chartsRoot .sl-draw-picker button:disabled{pointer-events:none}
    }`;
  document.head.appendChild(style);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", polish, { once: true });
  else polish();
  g.addEventListener("resize", () => requestAnimationFrame(polish), { passive: true });
})(window);
