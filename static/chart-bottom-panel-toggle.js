/* Keep one control for the Properties / Objects panel and place it directly
 * in the panel header next to the Properties / Objects tabs. The original
 * top-toolbar control is reused (not cloned), so the existing action and
 * state remain the single source of truth.
 */
(function (global) {
  "use strict";

  const Page = global.ChartAnalysisPage;
  if (!Page) return;

  function removeLegacyClose() {
    Page.root?.querySelectorAll("#caBottom .sl-panel-close").forEach((button) => button.remove());
  }

  function moveToggleIntoPanel() {
    const root = Page.root;
    if (!root) return;
    const button = root.querySelector("#gtCollapseBottomBtn");
    const head = root.querySelector("#caBottom .ca-bottom-head");
    if (!button || !head) return;

    let actions = head.querySelector(".sl-bottom-head-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "sl-bottom-head-actions";
      head.appendChild(actions);
    }
    if (button.parentElement !== actions) actions.appendChild(button);
    button.classList.add("sl-bottom-panel-toggle");
  }

  function syncToggle() {
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
      #chartsRoot #caBottom .ca-bottom-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      #chartsRoot #caBottom .ca-side-tabs { min-width:0; }
      #chartsRoot #caBottom .sl-bottom-head-actions { display:flex; align-items:center; margin-left:auto; flex:0 0 auto; }
      #chartsRoot #caBottom #gtCollapseBottomBtn.sl-bottom-panel-toggle { display:inline-flex!important; align-items:center; justify-content:center; width:34px; min-width:34px; height:30px; padding:0; margin:0; }
      #chartsRoot #caBottom #gtCollapseBottomBtn.sl-bottom-panel-toggle svg { transition:transform .16s ease; }
      #chartsRoot #caBottom #gtCollapseBottomBtn.sl-bottom-panel-toggle.sl-bottom-collapsed svg { transform:rotate(180deg); }
    `;
    document.head.appendChild(style);
  }

  if (!Page.__slBottomTogglePatched && typeof Page._setBottomCollapsed === "function") {
    Page.__slBottomTogglePatched = true;
    const originalSetBottomCollapsed = Page._setBottomCollapsed;
    Page._setBottomCollapsed = function () {
      const result = originalSetBottomCollapsed.apply(this, arguments);
      removeLegacyClose();
      moveToggleIntoPanel();
      syncToggle();
      return result;
    };
  }

  if (!Page.__slBottomBuildPatched && typeof Page._build === "function") {
    Page.__slBottomBuildPatched = true;
    const originalBuild = Page._build;
    Page._build = function () {
      const result = originalBuild.apply(this, arguments);
      removeLegacyClose();
      moveToggleIntoPanel();
      syncToggle();
      return result;
    };
  }

  removeLegacyClose();
  moveToggleIntoPanel();
  syncToggle();
})(window);
