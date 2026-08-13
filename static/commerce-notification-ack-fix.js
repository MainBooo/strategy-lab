(function(){
  "use strict";
  if(window.__notificationAckFix)return;
  window.__notificationAckFix=true;
  let email="";
  let ack=0;
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
    if(!hasNew){badge.classList.add("hidden");trigger.classList.remove("has-unread");}
  }
  function acknowledge(){
    ack=Date.now()/1000;
    try{localStorage.setItem(key(),String(ack));}catch(e){}
    window.setTimeout(apply,0);
  }
  async function init(){
    try{
      const r=await fetch("/account/api/commerce-context",{credentials:"same-origin"});
      if(!r.ok)return;
      const c=await r.json();
      if(!c.authenticated||!c.email)return;
      email=String(c.email);
      ack=Number(localStorage.getItem(key())||0);
    }catch(e){return;}
    document.addEventListener("click",function(e){
      const t=e.target&&e.target.closest?e.target.closest(".notification-trigger"):null;
      if(t)acknowledge();
    },true);
    const observer=new MutationObserver(apply);
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["class"]});
    apply();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();
