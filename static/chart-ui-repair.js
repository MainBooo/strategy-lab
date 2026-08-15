/* Keep only the desktop primary-tab indicator repair here. The chart terminal itself is owned by chart-editor-terminal-*.js. */
(function(global){
  "use strict";
  function sync(){
    const nav=document.getElementById("appPrimaryTabs");
    if(!nav||nav.offsetParent===null)return;
    const active=nav.querySelector(".tab.active"),indicator=nav.querySelector(".tab-indicator");
    if(!active||!indicator)return;
    const nr=nav.getBoundingClientRect(),ar=active.getBoundingClientRect();
    if(!ar.width||!ar.height)return;
    indicator.style.width=`${ar.width}px`;
    indicator.style.height=`${ar.height}px`;
    indicator.style.top=`${ar.top-nr.top+nav.scrollTop}px`;
    indicator.style.transform=`translateX(${ar.left-nr.left+nav.scrollLeft}px)`;
    nav.classList.add("indicator-ready");
  }
  const schedule=()=>requestAnimationFrame(()=>requestAnimationFrame(sync));
  function install(){
    const nav=document.getElementById("appPrimaryTabs");
    if(!nav||nav.dataset.slIndicatorRepair==="1")return;
    nav.dataset.slIndicatorRepair="1";
    nav.addEventListener("click",schedule,true);
    nav.addEventListener("scroll",schedule,{passive:true});
    global.addEventListener("resize",schedule,{passive:true});
    global.addEventListener("orientationchange",schedule,{passive:true});
    if(global.ResizeObserver){const ro=new ResizeObserver(schedule);ro.observe(nav);nav.querySelectorAll(".tab").forEach(t=>ro.observe(t));nav._slIndicatorResizeObserver=ro;}
    schedule();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
})(window);
