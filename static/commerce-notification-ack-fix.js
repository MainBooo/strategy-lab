(function(){
  "use strict";
  if(window.__notificationAckFix)return;
  window.__notificationAckFix=true;

  let email="";
  let ack=0;
  let centerObserver=null;
  let discoveryObserver=null;

  function key(){return "strategy-lab:notifications-ack:"+email.toLowerCase();}

  function loadEvents(){
    if(!email)return [];
    try{
      const raw=localStorage.getItem("strategy-lab:notifications:"+email.toLowerCase());
      const data=JSON.parse(raw||"null");
      return data&&Array.isArray(data.events)?data.events:[];
    }catch(e){return [];}
  }

  function apply(){
    const trigger=document.querySelector(".notification-trigger");
    const badge=document.querySelector(".notification-badge");
    if(!trigger||!badge)return;

    const hasNew=loadEvents().some(function(item){return Number(item&&item.time||0)>ack;});
    if(!hasNew){
      if(!badge.classList.contains("hidden"))badge.classList.add("hidden");
      if(trigger.classList.contains("has-unread"))trigger.classList.remove("has-unread");
    }
  }

  function acknowledge(){
    ack=Date.now()/1000;
    try{localStorage.setItem(key(),String(ack));}catch(e){}
    window.setTimeout(apply,0);
  }

  function bindCenterObserver(){
    const center=document.querySelector(".notification-center");
    if(!center)return false;
    if(center.dataset.notificationAckObserved==="1")return true;

    center.dataset.notificationAckObserved="1";
    centerObserver=new MutationObserver(function(){apply();});
    // Only observe DOM content changes inside the notification center. The
    // notification renderer updates badge text/list children on refresh, which
    // is enough to re-apply the acknowledgement state. Do NOT observe class
    // attributes: apply() itself changes badge/trigger classes and a global
    // attribute observer can create a self-sustaining MutationObserver loop
    // that starves the browser main thread.
    centerObserver.observe(center,{subtree:true,childList:true});
    apply();
    return true;
  }

  function waitForCenter(){
    if(bindCenterObserver())return;
    const root=document.body||document.documentElement;
    if(!root)return;
    discoveryObserver=new MutationObserver(function(){
      if(bindCenterObserver()&&discoveryObserver){
        discoveryObserver.disconnect();
        discoveryObserver=null;
      }
    });
    discoveryObserver.observe(root,{subtree:true,childList:true});
    window.setTimeout(function(){
      if(discoveryObserver){
        discoveryObserver.disconnect();
        discoveryObserver=null;
      }
    },10000);
  }

  async function init(){
    try{
      const r=await fetch("/account/api/commerce-context",{credentials:"same-origin"});
      if(!r.ok)return;
      const c=await r.json();
      if(!c.authenticated||!c.email)return;
      email=String(c.email);
      try{ack=Number(localStorage.getItem(key())||0);}catch(e){ack=0;}
    }catch(e){return;}

    document.addEventListener("click",function(e){
      const t=e.target&&e.target.closest?e.target.closest(".notification-trigger"):null;
      if(t)acknowledge();
    },true);

    waitForCenter();
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();
