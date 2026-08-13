(function(){
  "use strict";
  function load(src,key){
    if(document.querySelector(`script[data-${key}="1"]`)) return;
    const s=document.createElement("script");
    s.src=src; s.defer=true; s.setAttribute(`data-${key}`,"1");
    s.onerror=function(){}; document.head.appendChild(s);
  }
  load("/static/commerce-notifications.js","commerce-notifications");
  load("/static/commerce-notification-ack-fix.js","commerce-notification-ack-fix");
  if(location.pathname==="/account/strategies") load("/static/commerce-account-detail-core.js","commerce-order-detail-core");
})();
