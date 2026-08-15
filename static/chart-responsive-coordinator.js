/* Chart toolbar responsive coordinator.
 *
 * One responsibility only: keep the existing unified chart toolbar inside its
 * rendered box. It does not own chart, drawing, realtime or panel state and it
 * does not create/clone controls. Existing buttons and their handlers remain
 * the single source of truth; low-priority actions are represented in the
 * existing "Ещё" popover through the native gt-hidden contract.
 */
(function (global) {
  "use strict";

  const Page = global.ChartAnalysisPage;
  if (!Page) return;

  const COMPACT_WIDTH = 980;
  const TIGHT_WIDTH = 640;
  const SECONDARY_KEYS = new Set([
    "templates", "alerts", "replay", "undo", "redo",
    "save", "settings", "snapshot", "collapseBottom", "collapseRight",
  ]);
  let frame = 0;

  function toolbarGap(toolbar) {
    const cs = global.getComputedStyle ? global.getComputedStyle(toolbar) : null;
    const raw = cs ? (cs.columnGap || cs.gap || "0") : "0";
    const gap = parseFloat(raw);
    return Number.isFinite(gap) ? gap : 0;
  }

  function recalc() {
    const root = Page.root;
    if (!root) return;
    const toolbar = root.querySelector("#caToolbar");
    const scroll = root.querySelector("#gtScroll");
    const more = root.querySelector("#gtMoreMenu");
    if (!toolbar || !scroll || !more) return;

    const width = toolbar.getBoundingClientRect().width || toolbar.clientWidth || 0;
    if (!width) return;

    const compact = width <= COMPACT_WIDTH;
    const tight = width <= TIGHT_WIDTH;
    root.classList.toggle("sl-toolbar-compact", compact);
    root.classList.toggle("sl-toolbar-tight", tight);
    root.classList.remove("sl-toolbar-indicator-icon-only");

    const items = [...scroll.querySelectorAll("[data-key]")]
      .sort((a, b) => Number(a.dataset.priority) - Number(b.dataset.priority));

    // Reset only overflow state owned by this coordinator.
    items.forEach((el) => el.classList.remove("gt-hidden"));

    // At phone/tablet-sized rendered toolbars keep the primary workflow in the
    // row and send secondary actions to the already-existing More menu. This is
    // based on actual toolbar width, not UA or viewport media queries, so Safari
    // desktop-site/zoom modes cannot bypass it.
    if (compact) {
      items.forEach((el) => {
        if (SECONDARY_KEYS.has(el.dataset.key)) el.classList.add("gt-hidden");
      });
      root.querySelector('[data-key="indicators"]')?.classList.remove("gt-hidden");
    }

    const gap = toolbarGap(toolbar);
    const moreWidth = more.getBoundingClientRect().width || more.offsetWidth || 34;
    const available = Math.max(0, width - moreWidth - gap - 2);

    // Native implementation compared scrollWidth with scroll.clientWidth. On
    // Safari the flex item's max-content width can become its clientWidth, so
    // that comparison says "fits" while the row visibly runs beyond the
    // toolbar. Compare against the toolbar's real rendered budget instead.
    let guard = 0;
    while (scroll.scrollWidth > available + 1 && guard < items.length) {
      const next = items.find((el) => !el.classList.contains("gt-hidden") && el.dataset.key !== "indicators");
      if (!next) break;
      next.classList.add("gt-hidden");
      guard += 1;
    }

    // Indicators is the last direct action we are willing to compact. Keep the
    // real button/handler, only drop its text label if an exceptionally narrow
    // rendered toolbar still cannot fit after all secondary actions moved out.
    if (scroll.scrollWidth > available + 1) {
      root.classList.add("sl-toolbar-indicator-icon-only");
    }
  }

  function schedule() {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      recalc();
    });
  }

  // Keep ChartAnalysisPage's existing ResizeObserver and More-menu contract,
  // but fix the width calculation in the one method that observer already
  // calls. No parallel observer, duplicate toolbar or duplicate actions.
  Page._recalcToolbarOverflow = recalc;

  const style = document.createElement("style");
  style.id = "sl-rendered-toolbar-fit";
  style.textContent = `
    #chartsRoot.sl-toolbar-compact .gt-name,
    #chartsRoot.sl-toolbar-compact .gt-change,
    #chartsRoot.sl-toolbar-compact #gtLayoutMenu,
    #chartsRoot.sl-toolbar-compact #caFullscreenBtn { display:none !important; }

    #chartsRoot.sl-toolbar-compact #gtTicker { min-width:72px; max-width:110px; }
    #chartsRoot.sl-toolbar-compact #gtTimeframe { min-width:46px; max-width:58px; }
    #chartsRoot.sl-toolbar-compact #gtChartType { min-width:60px; max-width:82px; }
    #chartsRoot.sl-toolbar-compact .ca-toolbar-unified { gap:4px; padding:5px 6px; overflow:visible; }
    #chartsRoot.sl-toolbar-compact #gtScroll { min-width:0; gap:4px; overflow:visible; }
    #chartsRoot.sl-toolbar-compact #gtIndicatorsBtn { max-width:122px; padding-inline:8px; }
    #chartsRoot.sl-toolbar-compact #gtMoreMenu { display:block !important; flex:0 0 auto; margin-left:auto; }
    #chartsRoot.sl-toolbar-compact #gtMoreBtn { width:32px; min-width:32px; height:32px; padding:0; }

    #chartsRoot.sl-toolbar-tight #gtPrice { display:none !important; }
    #chartsRoot.sl-toolbar-tight #gtTicker { min-width:68px; max-width:100px; }
    #chartsRoot.sl-toolbar-tight #gtChartType { min-width:58px; max-width:76px; }

    #chartsRoot.sl-toolbar-indicator-icon-only #gtIndicatorsBtn .gt-btn-label { display:none !important; }
    #chartsRoot.sl-toolbar-indicator-icon-only #gtIndicatorsBtn { width:32px; min-width:32px; padding:0; justify-content:center; }

    /* Safari/WebKit can collapse inline SVG flex children to zero width.
       Keep the proven explicit icon basis on the toolbar itself. */
    #chartsRoot .ca-toolbar-unified .icon-btn svg,
    #chartsRoot .ca-toolbar-unified .gt-btn svg {
      flex:0 0 15px !important;
      width:15px !important;
      height:15px !important;
      min-width:15px !important;
      max-width:15px !important;
    }

    #chartsRoot.sl-toolbar-compact #gtIndicatorsPop,
    #chartsRoot.sl-toolbar-compact #gtMorePop {
      z-index:900;
      max-width:min(340px, calc(100vw - 16px));
    }
    #chartsRoot.sl-toolbar-compact #gtIndicatorsPop { left:auto; right:0; }
  `;
  document.head.appendChild(style);

  // The terminal loader runs after ChartAnalysisPage.init on an already-open
  // Charts tab. Recalculate once now, then reuse normal resize/orientation
  // events. The page's own ResizeObserver will also call this same method.
  schedule();
  global.addEventListener("resize", schedule, { passive: true });
  global.addEventListener("orientationchange", schedule, { passive: true });
  if (global.visualViewport) global.visualViewport.addEventListener("resize", schedule, { passive: true });
})(window);

/* Dense indicator action buttons are unrelated to toolbar ownership and are
 * intentionally preserved from the current main. */
(function () {
  "use strict";
  const old = document.getElementById("chart-indicator-compact-actions");
  if (old) old.remove();
  const style = document.createElement("style");
  style.id = "chart-indicator-compact-actions";
  style.textContent = `
    #chartsRoot .ca-ind-list .ca-indicator-row { min-height:30px; gap:4px; padding:3px 2px; }
    #chartsRoot .ca-ind-list .ca-indicator-row > label { min-width:0; margin:0; gap:5px; font-size:11px; line-height:1.2; }
    #chartsRoot .ca-ind-list .ca-indicator-row button,
    #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn,
    #chartsRoot .sl-ind-active-row .sl-mini-icon-btn {
      width:28px !important; min-width:28px !important; max-width:28px !important;
      height:28px !important; min-height:28px !important; padding:0 !important; margin:0 !important;
      border-radius:6px !important; flex:0 0 28px !important; font-size:13px !important; line-height:1 !important;
    }
    #chartsRoot .ca-ind-list .ca-indicator-row button svg,
    #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn svg,
    #chartsRoot .sl-ind-active-row .sl-mini-icon-btn svg { width:13px !important; height:13px !important; flex:0 0 13px !important; }
    @media (max-width:620px) {
      #chartsRoot .ca-ind-list .ca-indicator-row { min-height:28px; gap:3px; padding:2px 1px; }
      #chartsRoot .ca-ind-list .ca-indicator-row button,
      #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn,
      #chartsRoot .sl-ind-active-row .sl-mini-icon-btn {
        width:26px !important; min-width:26px !important; max-width:26px !important;
        height:26px !important; min-height:26px !important; flex-basis:26px !important; border-radius:5px !important;
      }
    }
  `;
  document.head.appendChild(style);
})();