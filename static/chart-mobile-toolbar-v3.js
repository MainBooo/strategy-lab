/* Mobile-only owner for the chart toolbar.
 * Desktop/tablet overflow is handled by chart-terminal-loader.js.
 */
(function (g) {
  "use strict";
  const Page = g.ChartAnalysisPage;
  if (!Page) return;

  const PHONE = "(max-width:768px),(max-width:980px) and (max-height:520px)";
  const isPhone = () => !!g.matchMedia && g.matchMedia(PHONE).matches;
  const moreIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

  const SECONDARY = [
    "gtTemplatesMenu","gtAlertsMenu","gtReplayBtn","caUndoBtn","caRedoBtn",
    "gtSaveBtn","gtSettingsBtn","caSnapshotBtn","gtLayoutMenu","caFullscreenBtn",
    "gtCollapseBottomBtn","gtCollapseRightBtn"
  ];

  function portalPopover(root, popId, homeId) {
    const pop = root.querySelector(`#${popId}`);
    if (!pop) return;
    if (!pop.dataset.slHomeId) pop.dataset.slHomeId = homeId;
    if (isPhone()) {
      if (pop.parentElement !== root) root.appendChild(pop);
    } else {
      const home = root.querySelector(`#${pop.dataset.slHomeId}`);
      if (home && pop.parentElement !== home) home.appendChild(pop);
    }
  }

  function syncPopoverHomes(root) {
    // Keep interactive popovers outside the clipped toolbar on iOS Safari.
    portalPopover(root, "gtIndicatorsPop", "gtIndicatorsMenu");
    portalPopover(root, "gtMorePop", "gtMoreMenu");
  }

  function applyVisibility(root) {
    SECONDARY.forEach((id) => root.querySelector(`#${id}`)?.classList.toggle("sl-mobile-secondary", isPhone()));
    root.querySelectorAll("#gtScroll [data-key]").forEach((el) => el.classList.remove("gt-hidden"));
    root.querySelector("#gtIndicatorsMenu")?.classList.remove("gt-hidden", "sl-mobile-secondary");
    root.querySelector("#gtMoreMenu")?.classList.remove("gt-hidden", "sl-mobile-secondary");
  }

  function ensureMoreButton(root) {
    const btn = root.querySelector("#gtMoreBtn");
    if (!btn) return;
    if (!btn.querySelector("svg[data-sl-mobile-more]")) {
      btn.innerHTML = moreIcon.replace("<svg ", '<svg data-sl-mobile-more="1" ');
    }
    btn.title = "Ещё";
    btn.setAttribute("aria-label", "Дополнительные действия");
  }

  function addMobileMoreActions(pop) {
    if (!pop || !isPhone() || pop.querySelector(".sl-mobile-more-extra")) return;
    const group = document.createElement("div");
    group.className = "ca-more-group sl-mobile-more-extra";
    group.innerHTML = `
      <button class="ca-more-item" type="button" data-sl-mobile-act="layout">Раскладка графиков</button>
      <button class="ca-more-item" type="button" data-sl-mobile-act="fullscreen">Полноэкранный режим</button>
    `;
    pop.insertBefore(group, pop.firstChild);
    group.querySelector('[data-sl-mobile-act="layout"]')?.addEventListener("click", () => {
      pop.classList.add("hidden");
      Page.root?.querySelector("#gtLayoutBtn")?.click();
    });
    group.querySelector('[data-sl-mobile-act="fullscreen"]')?.addEventListener("click", () => {
      pop.classList.add("hidden");
      Page._fsCtrl?.toggle?.();
    });
  }

  function patchMorePopover() {
    if (Page.__slMobileMorePatched || typeof Page._renderMorePopover !== "function") return;
    Page.__slMobileMorePatched = true;
    const original = Page._renderMorePopover;
    Page._renderMorePopover = function () {
      const result = original.call(this);
      addMobileMoreActions(this.root?.querySelector("#gtMorePop"));
      return result;
    };
  }

  function sync() {
    if (!Page.root) return;
    const root = Page.root;
    root.classList.toggle("sl-mobile-chart-toolbar-v3", isPhone());
    applyVisibility(root);
    syncPopoverHomes(root);
    ensureMoreButton(root);
    if (isPhone() && Page._bottomCollapsed === false && typeof Page._setBottomCollapsed === "function") {
      Page._setBottomCollapsed(true, { skipSave: true });
    }
  }

  patchMorePopover();

  // Page is normally already built when this late bundle loads. Hook rebuilds
  // without observing/re-writing the DOM on every mutation.
  if (typeof Page._build === "function" && !Page.__slMobileBuildPatched) {
    Page.__slMobileBuildPatched = true;
    const originalBuild = Page._build;
    Page._build = function () {
      const result = originalBuild.apply(this, arguments);
      requestAnimationFrame(sync);
      return result;
    };
  }

  const style = document.createElement("style");
  style.id = "sl-mobile-chart-toolbar-v3-style";
  style.textContent = `
    @media (max-width:768px),(max-width:980px) and (max-height:520px) {
      #chartsRoot.sl-mobile-chart-toolbar-v3 .ca-toolbar-unified {
        display:flex!important;align-items:center!important;flex-wrap:nowrap!important;
        gap:4px!important;padding:6px!important;min-width:0!important;overflow:hidden!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtScroll {
        display:flex!important;align-items:center!important;flex:1 1 auto!important;
        min-width:0!important;width:auto!important;gap:4px!important;overflow:hidden!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .sl-mobile-secondary { display:none!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-name,
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-price,
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-change { display:none!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-ticker {
        flex:1 1 96px!important;min-width:88px!important;max-width:132px!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-tf {
        flex:0 0 50px!important;min-width:50px!important;max-width:50px!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-type {
        flex:0 0 68px!important;min-width:64px!important;max-width:68px!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsMenu {
        display:block!important;flex:0 0 auto!important;min-width:0!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn {
        display:inline-flex!important;align-items:center!important;justify-content:center!important;
        height:36px!important;min-width:36px!important;max-width:112px!important;padding:0 8px!important;
        white-space:nowrap!important;pointer-events:auto!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreMenu {
        display:block!important;flex:0 0 36px!important;margin-left:auto!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreBtn {
        display:inline-flex!important;align-items:center!important;justify-content:center!important;
        width:36px!important;min-width:36px!important;height:36px!important;padding:0!important;pointer-events:auto!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreBtn svg {
        display:block!important;width:18px!important;height:18px!important;fill:currentColor!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 > #gtIndicatorsPop,
      #chartsRoot.sl-mobile-chart-toolbar-v3 > #gtMorePop {
        position:fixed!important;z-index:9999!important;left:max(8px,env(safe-area-inset-left))!important;
        right:max(8px,env(safe-area-inset-right))!important;top:auto!important;
        bottom:calc(72px + env(safe-area-inset-bottom))!important;width:auto!important;max-width:none!important;
        max-height:min(68dvh,620px)!important;overflow:auto!important;pointer-events:auto!important;
        border-radius:14px!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #caBottom.collapsed { height:38px!important; }
    }
    @media (max-width:390px) {
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn .gt-btn-label { display:none!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn { width:36px!important;max-width:36px!important;padding:0!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-ticker { max-width:112px!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-type { flex-basis:64px!important;max-width:64px!important; }
    }
  `;
  document.head.appendChild(style);

  sync();
  document.addEventListener("strategylab:terminal-ready", sync);
  g.addEventListener("resize", () => requestAnimationFrame(sync), { passive: true });
  g.addEventListener("orientationchange", () => requestAnimationFrame(sync), { passive: true });
})(window);
