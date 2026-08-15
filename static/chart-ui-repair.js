/* Runtime repairs for the chart workspace after the responsive integration. */
(function (global) {
  "use strict";

  function installToolbarIconFallbacks() {
    if (document.getElementById("sl-chart-toolbar-icon-fallbacks")) return;
    const style = document.createElement("style");
    style.id = "sl-chart-toolbar-icon-fallbacks";
    style.textContent = `
      #chartsRoot .ca-toolbar-unified .icon-btn,
      #chartsRoot .ca-toolbar-unified .gt-btn { color: var(--muted) !important; }
      #chartsRoot .ca-toolbar-unified .icon-btn svg,
      #chartsRoot .ca-toolbar-unified .gt-btn svg {
        display:block !important; width:15px !important; min-width:15px !important; max-width:15px !important;
        height:15px !important; min-height:15px !important; max-height:15px !important;
        flex:0 0 15px !important; opacity:1 !important; visibility:visible !important; overflow:visible !important;
      }
      #gtReplayBtn > svg,#gtLayoutBtn > svg,#gtSaveBtn > svg,#gtSettingsBtn > svg,
      #caSnapshotBtn > svg,#caFullscreenBtn > svg,#gtCollapseRightBtn > svg { display:none !important; }
      #gtReplayBtn::before { content:'◀'; } #gtLayoutBtn::before { content:'▦'; }
      #gtSaveBtn::before { content:'⌑'; } #gtSettingsBtn::before { content:'⚙'; }
      #caSnapshotBtn::before { content:'◉'; } #caFullscreenBtn::before { content:'⛶'; }
      #gtCollapseRightBtn::before { content:'▤'; }
      #gtReplayBtn::before,#gtLayoutBtn::before,#gtSaveBtn::before,#gtSettingsBtn::before,
      #caSnapshotBtn::before,#caFullscreenBtn::before,#gtCollapseRightBtn::before {
        display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px;
        flex:0 0 16px; font-size:15px; line-height:1; color:currentColor;
      }
    `;
    document.head.appendChild(style);
  }

  function syncPrimaryTabIndicator() {
    const nav = document.getElementById("appPrimaryTabs");
    if (!nav || nav.offsetParent === null) return;
    const active = nav.querySelector(".tab.active"), indicator = nav.querySelector(".tab-indicator");
    if (!active || !indicator) return;
    const nr = nav.getBoundingClientRect(), ar = active.getBoundingClientRect();
    if (!ar.width || !ar.height) return;
    indicator.style.width = `${ar.width}px`; indicator.style.height = `${ar.height}px`;
    indicator.style.top = `${ar.top - nr.top + nav.scrollTop}px`;
    indicator.style.transform = `translateX(${ar.left - nr.left + nav.scrollLeft}px)`;
    nav.classList.add("indicator-ready");
  }
  function scheduleTabSync() { requestAnimationFrame(() => requestAnimationFrame(syncPrimaryTabIndicator)); }
  function installTabRepair() {
    const nav = document.getElementById("appPrimaryTabs");
    if (!nav || nav.dataset.slIndicatorRepair === "1") return;
    nav.dataset.slIndicatorRepair = "1";
    nav.addEventListener("click", scheduleTabSync, true); nav.addEventListener("scroll", scheduleTabSync, { passive:true });
    global.addEventListener("resize", scheduleTabSync, { passive:true }); global.addEventListener("orientationchange", scheduleTabSync, { passive:true });
    if (global.ResizeObserver) { const ro = new ResizeObserver(scheduleTabSync); ro.observe(nav); nav.querySelectorAll(".tab").forEach(t=>ro.observe(t)); nav._slIndicatorResizeObserver=ro; }
    scheduleTabSync();
  }

  function loadScript(src) {
    return new Promise((resolve,reject)=>{
      const existing=document.querySelector(`script[data-sl-expanded-src="${src}"]`);
      if(existing){ if(existing.dataset.loaded==="1") resolve(); else existing.addEventListener("load",resolve,{once:true}); return; }
      const script=document.createElement("script"); script.src=src; script.async=false; script.dataset.slExpandedSrc=src;
      script.onload=()=>{script.dataset.loaded="1";resolve();}; script.onerror=reject; document.head.appendChild(script);
    });
  }

  function normalizeIndicatorDefinitions(I) {
    if (!I || !Array.isArray(I.registry)) return;
    I.registry.forEach((def) => {
      if (!def || !def.id) return;
      /* chart-analysis.js renders def.label. Extended definitions historically
         only supplied shortName/name/ruName, which produced literal "undefined" rows. */
      if (!def.label) def.label = def.shortName || def.ruName || def.name || String(def.id).toUpperCase();
    });
  }

  function refreshIndicatorUi() {
    const page=global.ChartAnalysisPage;
    if(!page || typeof page._renderIndicatorsInto!=="function") return;
    const pop=document.getElementById("gtIndicatorsPop");
    if(pop && !pop.classList.contains("hidden")) {
      try { page._renderIndicatorsInto(pop); } catch(e) { console.error("Indicator menu refresh failed",e); }
    }
  }

  async function ensureExpandedIndicators() {
    const I=global.ChartEngine&&global.ChartEngine.Indicators;
    if(!I||!Array.isArray(I.registry)) return;
    const files=["/static/chart-engine/indicators-expanded-kit.js","/static/chart-engine/indicators-expanded-trend.js","/static/chart-engine/indicators-expanded-oscillators.js","/static/chart-engine/indicators-expanded-volume-levels.js","/static/chart-engine/indicators-expanded-manager.js"];
    try {
      for(const src of files) await loadScript(src);
      normalizeIndicatorDefinitions(I);
      const page=global.ChartAnalysisPage;
      if(page&&Array.isArray(page.tiles)&&typeof I.upgradeTile==="function") page.tiles.forEach(tile=>{try{I.upgradeTile(tile);}catch(e){console.error("Indicator manager upgrade failed",e);}});
      refreshIndicatorUi();
      document.dispatchEvent(new CustomEvent("strategylab:indicators-expanded",{detail:{count:I.registry.length}}));
    } catch(e) { console.error("Expanded indicators failed to load",e); }
  }

  installToolbarIconFallbacks(); installTabRepair(); ensureExpandedIndicators();
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",()=>{installTabRepair();scheduleTabSync();},{once:true}); else scheduleTabSync();
})(window);
