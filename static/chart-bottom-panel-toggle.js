/* Keep a single control for the Properties / Objects panel.
 * The top toolbar already owns gtCollapseBottomBtn; remove the duplicate
 * close button injected into the panel header and keep the toolbar button
 * visually in sync with the panel state.
 */
(function (global) {
  "use strict";

  const Page = global.ChartAnalysisPage;
  if (!Page) return;

  function removeLegacyClose() {
    Page.root?.querySelectorAll("#caBottom .sl-panel-close").forEach((button) => button.remove());
  }

  function syncToolbarButton() {
    const button = Page.root?.querySelector("#gtCollapseBottomBtn");
    if (!button) return;
    const collapsed = Page._bottomCollapsed === true;
    button.classList.toggle("sl-bottom-collapsed", collapsed);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.title = collapsed ? "Развернуть панель свойств и объектов" : "Свернуть панель свойств и объектов";
    button.setAttribute("aria-label", button.title);
  }

  if (!document.getElementById("sl-bottom-panel-toggle-style")) {
    const style = document.createElement("style");
    style.id = "sl-bottom-panel-toggle-style";
    style.textContent = `
      #chartsRoot #caBottom .sl-panel-close { display:none!important; }
      #chartsRoot #gtCollapseBottomBtn svg { transition:transform .16s ease; }
      #chartsRoot #gtCollapseBottomBtn.sl-bottom-collapsed svg { transform:rotate(180deg); }
    `;
    document.head.appendChild(style);
  }

  if (!Page.__slBottomTogglePatched && typeof Page._setBottomCollapsed === "function") {
    Page.__slBottomTogglePatched = true;
    const originalSetBottomCollapsed = Page._setBottomCollapsed;
    Page._setBottomCollapsed = function () {
      const result = originalSetBottomCollapsed.apply(this, arguments);
      removeLegacyClose();
      syncToolbarButton();
      return result;
    };
  }

  if (!Page.__slBottomBuildPatched && typeof Page._build === "function") {
    Page.__slBottomBuildPatched = true;
    const originalBuild = Page._build;
    Page._build = function () {
      const result = originalBuild.apply(this, arguments);
      removeLegacyClose();
      syncToolbarButton();
      return result;
    };
  }

  removeLegacyClose();
  syncToolbarButton();
})(window);
