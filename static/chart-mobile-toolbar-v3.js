/* Compact mobile chart toolbar for Strategy Lab.
 * Keeps only market essentials in the primary row and routes secondary
 * commands through the existing three-dot menu. Desktop layout is untouched.
 */
(function (g) {
  "use strict";

  const Page = g.ChartAnalysisPage;
  if (!Page) return;

  const PHONE = "(max-width: 768px), (max-width: 980px) and (max-height: 520px)";
  const isPhone = () => !!g.matchMedia && g.matchMedia(PHONE).matches;

  const moreIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

  function forceSecondaryIntoMore(root) {
    const ids = [
      "gtTemplatesMenu", "gtAlertsMenu", "gtReplayBtn", "caUndoBtn", "caRedoBtn",
      "gtSaveBtn", "gtSettingsBtn", "caSnapshotBtn", "gtCollapseBottomBtn", "gtCollapseRightBtn"
    ];
    ids.forEach((id) => {
      const el = root.querySelector(`#${id}`);
      if (el) el.classList.add("gt-hidden", "sl-mobile-overflow-item");
    });
  }

  function addMobileMoreActions(pop) {
    if (!pop || !isPhone()) return;
    let group = pop.querySelector(".sl-mobile-more-extra");
    if (!group) {
      group = document.createElement("div");
      group.className = "ca-more-group sl-mobile-more-extra";
      group.innerHTML = `
        <button class="ca-more-item" data-sl-mobile-act="layout">Раскладка графиков</button>
        <button class="ca-more-item" data-sl-mobile-act="fullscreen">Полноэкранный режим</button>
      `;
      pop.insertBefore(group, pop.firstChild);
      const sep = document.createElement("div");
      sep.className = "ca-more-sep sl-mobile-more-extra";
      group.after(sep);
    }
    group.querySelector('[data-sl-mobile-act="layout"]')?.addEventListener("click", () => {
      pop.classList.add("hidden");
      Page.root?.querySelector("#gtLayoutBtn")?.click();
    }, { once: true });
    group.querySelector('[data-sl-mobile-act="fullscreen"]')?.addEventListener("click", () => {
      pop.classList.add("hidden");
      Page._fsCtrl?.toggle?.();
    }, { once: true });
  }

  function patchMorePopover() {
    if (Page.__slMobileMorePatched || typeof Page._renderMorePopover !== "function") return;
    Page.__slMobileMorePatched = true;
    const original = Page._renderMorePopover;
    Page._renderMorePopover = function () {
      forceSecondaryIntoMore(this.root);
      original.call(this);
      addMobileMoreActions(this.root?.querySelector("#gtMorePop"));
    };
  }

  function compact() {
    if (!isPhone() || !Page.root) return;
    const root = Page.root;
    root.classList.add("sl-mobile-chart-toolbar-v3");

    forceSecondaryIntoMore(root);

    const moreBtn = root.querySelector("#gtMoreBtn");
    if (moreBtn) {
      moreBtn.innerHTML = moreIcon;
      moreBtn.title = "Ещё";
      moreBtn.setAttribute("aria-label", "Дополнительные действия");
    }

    // Mobile chart already exposes fullscreen from the chart tile itself.
    const fs = root.querySelector("#caFullscreenBtn");
    if (fs) fs.classList.add("sl-mobile-direct-hidden");
    const layout = root.querySelector("#gtLayoutMenu");
    if (layout) layout.classList.add("sl-mobile-direct-hidden");

    // Keep the lower properties/objects panel out of the first mobile view.
    if (Page._bottomCollapsed === false && typeof Page._setBottomCollapsed === "function") {
      Page._setBottomCollapsed(true, { skipSave: true });
    }

    requestAnimationFrame(() => {
      if (typeof Page._recalcToolbarOverflow === "function") Page._recalcToolbarOverflow();
      forceSecondaryIntoMore(root);
    });
  }

  patchMorePopover();

  const style = document.createElement("style");
  style.id = "sl-mobile-chart-toolbar-v3-style";
  style.textContent = `
    @media (max-width:768px), (max-width:980px) and (max-height:520px) {
      #chartsRoot.sl-mobile-chart-toolbar-v3 .ca-toolbar-unified {
        display:flex!important; align-items:center!important; flex-wrap:nowrap!important;
        gap:5px!important; padding:6px!important; overflow:visible!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtScroll {
        display:flex!important; align-items:center!important; flex:1 1 auto!important;
        min-width:0!important; width:auto!important; max-width:none!important;
        gap:5px!important; overflow:visible!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-name,
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-price,
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-change,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtTemplatesMenu,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtAlertsMenu,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtReplayBtn,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #caUndoBtn,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #caRedoBtn,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtSaveBtn,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtSettingsBtn,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #caSnapshotBtn,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtCollapseBottomBtn,
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtCollapseRightBtn,
      #chartsRoot.sl-mobile-chart-toolbar-v3 .sl-mobile-direct-hidden {
        display:none!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-ticker {
        flex:1 1 118px!important; min-width:92px!important; max-width:154px!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-tf {
        flex:0 0 54px!important; min-width:54px!important; max-width:54px!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-type {
        flex:0 0 78px!important; min-width:70px!important; max-width:78px!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsMenu {
        display:block!important; flex:0 0 auto!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn {
        height:32px!important; padding:0 8px!important; white-space:nowrap!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn .gt-btn-label {
        display:inline!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreMenu {
        display:block!important; flex:0 0 auto!important; margin-left:0!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreBtn {
        display:inline-flex!important; align-items:center!important; justify-content:center!important;
        width:32px!important; min-width:32px!important; height:32px!important; padding:0!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMoreBtn svg {
        display:block!important; width:17px!important; height:17px!important; fill:currentColor!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-hidden { display:none!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtMorePop {
        right:0!important; left:auto!important; width:min(310px,calc(100vw - 24px))!important;
        max-height:min(70vh,560px)!important; overflow:auto!important;
      }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #caBottom.collapsed { height:38px!important; }
    }

    @media (max-width:430px) {
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-ticker { max-width:132px!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-type { flex-basis:70px!important; max-width:70px!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn { padding:0 7px!important; }
    }

    @media (max-width:380px) {
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn .gt-btn-label { display:none!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 #gtIndicatorsBtn { width:32px!important; padding:0!important; }
      #chartsRoot.sl-mobile-chart-toolbar-v3 .gt-ticker { max-width:126px!important; }
    }
  `;
  document.head.appendChild(style);

  compact();
  document.addEventListener("strategylab:terminal-ready", compact);
  g.addEventListener("resize", compact, { passive: true });
  g.addEventListener("orientationchange", compact, { passive: true });

  if (g.MutationObserver) {
    const observer = new MutationObserver(() => compact());
    if (Page.root) observer.observe(Page.root, { childList: true, subtree: true });
  }
})(window);
