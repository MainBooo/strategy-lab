/* Compact mobile chart toolbar. Desktop is intentionally untouched. */
(function (g) {
  "use strict";
  const Page = g.ChartAnalysisPage;
  if (!Page) return;
  const PHONE = "(max-width:768px),(max-width:980px) and (max-height:520px)";
  const isPhone = () => !!g.matchMedia && g.matchMedia(PHONE).matches;
  const moreIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

  const secondaryIds = [
    "gtTemplatesMenu","gtAlertsMenu","gtReplayBtn","caUndoBtn","caRedoBtn",
    "gtSaveBtn","gtSettingsBtn","caSnapshotBtn","gtCollapseBottomBtn","gtCollapseRightBtn",
    "gtLayoutMenu","caFullscreenBtn"
  ];

  function hideSecondary(root) {
    secondaryIds.forEach(id => root.querySelector(`#${id}`)?.classList.add("sl-mobile-direct-hidden"));
  }

  function normalizePrimary(root) {
    const scroll = root.querySelector("#gtScroll");
    if (!scroll) return;
    hideSecondary(root);
    [...scroll.children].forEach(el => {
      if (!el || el.nodeType !== 1) return;
      const keep = el.matches(".gt-ticker,.gt-tf,.gt-type,#gtIndicatorsMenu,#gtMoreMenu") ||
        el.querySelector?.("#gtIndicatorsBtn,#gtMoreBtn");
      if (!keep) el.classList.add("sl-mobile-direct-hidden");
    });
    const more = root.querySelector("#gtMoreMenu");
    if (more && more.parentElement !== scroll) scroll.appendChild(more);
    const moreBtn = root.querySelector("#gtMoreBtn");
    if (moreBtn) {
      moreBtn.innerHTML = moreIcon;
      moreBtn.title = "Ещё";
      moreBtn.setAttribute("aria-label", "Дополнительные действия");
      moreBtn.classList.remove("gt-hidden","sl-mobile-direct-hidden");
      moreBtn.parentElement?.classList.remove("gt-hidden","sl-mobile-direct-hidden");
    }
    const ind = root.querySelector("#gtIndicatorsMenu");
    ind?.classList.remove("gt-hidden","sl-mobile-direct-hidden");
  }

  function addMobileMoreActions(pop) {
    if (!pop || !isPhone() || pop.querySelector(".sl-mobile-more-extra")) return;
    const group = document.createElement("div");
    group.className = "ca-more-group sl-mobile-more-extra";
    group.innerHTML = '<button class="ca-more-item" data-sl-mobile-act="layout">Раскладка графиков</button><button class="ca-more-item" data-sl-mobile-act="fullscreen">Полноэкранный режим</button>';
    pop.insertBefore(group, pop.firstChild);
    group.querySelector('[data-sl-mobile-act="layout"]')?.addEventListener("click", () => { pop.classList.add("hidden"); Page.root?.querySelector("#gtLayoutBtn")?.click(); });
    group.querySelector('[data-sl-mobile-act="fullscreen"]')?.addEventListener("click", () => { pop.classList.add("hidden"); Page._fsCtrl?.toggle?.(); });
  }

  function patchMorePopover() {
    if (Page.__slMobileMorePatched || typeof Page._renderMorePopover !== "function") return;
    Page.__slMobileMorePatched = true;
    const original = Page._renderMorePopover;
    Page._renderMorePopover = function () {
      original.call(this);
      addMobileMoreActions(this.root?.querySelector("#gtMorePop"));
    };
  }

  let queued = false;
  function compact() {
    if (!isPhone() || !Page.root || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const root = Page.root;
      root.classList.add("sl-mobile-chart-toolbar-v3");
      normalizePrimary(root);
      if (Page._bottomCollapsed === false && typeof Page._setBottomCollapsed === "function") Page._setBottomCollapsed(true, { skipSave:true });
    });
  }

  patchMorePopover();
  const style = document.createElement("style");
  style.id = "sl-mobile-chart-toolbar-v3-style";
  style.textContent = `
  @media (max-width:768px),(max-width:980px) and (max-height:520px){
    #chartsRoot.sl-mobile-chart-toolbar-v3 .ca-toolbar-unified{display:flex!important;align-items:center!important;flex-wrap:nowrap!important;gap:4px!important;padding:6px!important;overflow:hidden!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtScroll{display:flex!important;align-items:center!important;flex:1 1 auto!important;min-width:0!important;width:100%!important;gap:4px!important;overflow:hidden!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 .sl-mobile-direct-hidden{display:none!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-name,#chartsRoot.sl-mobile-chart-toolbar-v3 .gt-price,#chartsRoot.sl-mobile-chart-toolbar-v3 .gt-change{display:none!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-ticker{flex:1 1 112px!important;min-width:96px!important;max-width:154px!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-tf{flex:0 0 54px!important;min-width:54px!important;max-width:54px!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-type{flex:0 0 76px!important;min-width:68px!important;max-width:76px!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsMenu{display:block!important;flex:0 1 auto!important;min-width:32px!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn{height:32px!important;max-width:118px!important;padding:0 7px!important;white-space:nowrap!important;overflow:hidden!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreMenu{display:block!important;flex:0 0 32px!important;margin-left:auto!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreBtn{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:32px!important;min-width:32px!important;height:32px!important;padding:0!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreBtn svg{display:block!important;width:17px!important;height:17px!important;fill:currentColor!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMorePop{right:0!important;left:auto!important;width:min(310px,calc(100vw - 24px))!important;max-height:min(70vh,560px)!important;overflow:auto!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #caBottom.collapsed{height:38px!important}
  }
  @media(max-width:430px){
    #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-ticker{max-width:136px!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-type{flex-basis:70px!important;max-width:70px!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn .gt-btn-label{display:none!important}
    #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn{width:34px!important;min-width:34px!important;padding:0!important}
  }`;
  document.head.appendChild(style);
  compact();
  document.addEventListener("strategylab:terminal-ready", compact);
  g.addEventListener("resize", compact,{passive:true});
  g.addEventListener("orientationchange",compact,{passive:true});
  if(g.MutationObserver && Page.root){ const ob=new MutationObserver(compact); ob.observe(Page.root,{childList:true,subtree:true}); }
})(window);
