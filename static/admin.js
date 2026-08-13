(function () {
  "use strict";

  const cfg = window.STRATEGY_LAB_ADMIN || { section: "overview", entity_id: null };
  const root = document.getElementById("adminContent");
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = (n) => Number(n || 0).toLocaleString("ru-RU") + " ₽";
  const dt = (ts) => ts ? new Date(ts * 1000).toLocaleString("ru-RU") : "—";

  if (!document.querySelector('link[data-admin-css="1"]')) {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/static/admin.css"; link.dataset.adminCss = "1"; document.head.appendChild(link);
  }

  async function api(url, options) {
    if (window.authFetch) return window.authFetch(url, options || {});
    options = options || {};
    const headers = Object.assign({"Content-Type":"application/json"}, options.headers || {});
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET") headers["X-CSRF-Token"] = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
    const r = await fetch(url, Object.assign({}, options, { headers, credentials:"same-origin" }));
    const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d;
  }

  document.querySelectorAll("[data-admin-section]").forEach((a) => a.classList.toggle("active", a.dataset.adminSection === cfg.section));
  const shell = document.getElementById("adminShell");
  const menu = document.getElementById("adminMenuToggle");
  if (menu) menu.onclick = () => shell.classList.toggle("admin-mobile-open");

  function errorCard(err) { root.innerHTML = `<article class="card"><h2>Не удалось загрузить раздел</h2><p class="message error">${esc(err.message || err)}</p></article>`; }
  function kpi(label, value) { return `<div class="admin-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`; }

  async function overview() {
    try {
      const d = await api("/api/admin/dashboard"); const s = d.orders_by_status || {};
      root.innerHTML = `<div class="admin-page-head"><div><span class="step">ADMIN</span><h2>Strategy Lab — Администрирование</h2></div></div><div class="admin-kpis">
        ${kpi("Пользователи", d.users)}${kpi("Заявки на стратегии", d.orders_total)}${kpi("Ожидают оценки", (s.NEW||0)+(s.REVIEWING||0))}${kpi("Ожидают оплаты", s.WAITING_PAYMENT||0)}
        ${kpi("В разработке", s.IN_PROGRESS||0)}${kpi("Готово / завершено", (s.READY||0)+(s.COMPLETED||0))}${kpi("Получено за стратегии", money(d.strategies_total))}${kpi("Поддержка проекта", money(d.support_total))}
      </div><article class="card"><h3>Поддержка за 30 дней</h3><p class="lead">${money(d.support_30d)}</p><p class="hint">Здесь только операционные показатели заявок и платежей — без лишней CRM и без содержимого торговых стратегий.</p></article>`;
    } catch (e) { errorCard(e); }
  }

  function orderStatus(o) { return `<span class="pill status-${String(o.status||"").toLowerCase()}">${esc(o.status_label || o.status)}</span>`; }

  async function orders() {
    if (cfg.entity_id) return orderDetail(cfg.entity_id);
    root.innerHTML = `<div class="admin-page-head"><div><span class="step">Заявки</span><h2>Заявки на стратегии</h2></div></div><div class="admin-toolbar">
      <input id="aoQuery" placeholder="№, название, user id"><select id="aoStatus"><option value="">Все статусы</option>${["NEW","REVIEWING","NEEDS_INFO","WAITING_PAYMENT","PAID","IN_PROGRESS","READY","COMPLETED","CANCELLED"].map(x=>`<option>${x}</option>`).join("")}</select>
      <select id="aoPayment"><option value="">Любая оплата</option><option>PENDING</option><option>SUCCEEDED</option><option>CANCELED</option></select><input id="aoFrom" type="date"><input id="aoTo" type="date"><button class="secondary" id="aoApply">Применить</button>
    </div><article class="card results-card"><div id="adminOrdersTable"><p class="hint">Загрузка…</p></div></article>`;
    document.getElementById("aoApply").onclick = loadOrdersTable;
    await loadOrdersTable();
  }

  async function loadOrdersTable() {
    try {
      const p = new URLSearchParams();
      const values = {q:"aoQuery",status:"aoStatus",payment_status:"aoPayment",date_from:"aoFrom",date_to:"aoTo"};
      Object.entries(values).forEach(([k,id]) => { const v = document.getElementById(id).value; if (v) p.set(k,v); });
      const d = await api(`/api/admin/strategy-orders?${p}`); const rows = d.orders || []; const box = document.getElementById("adminOrdersTable");
      box.innerHTML = rows.length ? `<div class="table-scroll"><table><thead><tr><th>№</th><th>Пользователь</th><th>Стратегия</th><th>Создано</th><th>Статус</th><th>Цена</th><th>Оплата</th><th></th></tr></thead><tbody>${rows.map(o=>`<tr><td>#${esc(o.public_id)}</td><td><span class="admin-table-user">${esc(o.user&&o.user.display_name)}<small>${esc(o.user&&o.user.email)}</small></span></td><td>${esc(o.title||"Без названия")}</td><td>${dt(o.created_at)}</td><td>${orderStatus(o)}</td><td>${o.quoted_price?money(o.quoted_price):"—"}</td><td>${esc(o.payment_status||"—")}</td><td><a href="/admin/strategy-orders/${encodeURIComponent(o.id)}">Открыть</a></td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">Заявок по фильтрам нет.</p>`;
    } catch(e) { document.getElementById("adminOrdersTable").innerHTML = `<p class="message error">${esc(e.message)}</p>`; }
  }

  const detailField = (label, value, wide) => `<div class="admin-detail-block ${wide?"wide":""}"><span>${esc(label)}</span><p>${esc(value || "—")}</p></div>`;

  async function orderDetail(id) {
    try {
      const o = await api(`/api/admin/strategy-orders/${encodeURIComponent(id)}`); const runners = await api("/api/admin/strategy-runners");
      root.innerHTML = `<div class="admin-page-head"><div><a href="/admin/strategy-orders">← Все заявки</a><h2>#${esc(o.public_id)} · ${esc(o.title||"Без названия")}</h2><p class="hint">${esc(o.user&&o.user.display_name)} · ${esc(o.user&&o.user.email)} · ${dt(o.created_at)}</p></div>${orderStatus(o)}</div>
      <div class="admin-order-detail"><article class="card"><div class="admin-detail-grid">
        ${detailField("Контакт",o.contact)}${detailField("Рынок",o.market)}${detailField("Инструменты",o.symbols)}${detailField("Таймфреймы",(o.timeframes||[]).join(", "))}${detailField("Long / Short",(o.directions||[]).join(", "))}
        ${detailField("Условия входа",o.entry_rules,true)}${detailField("Условия выхода",o.exit_rules,true)}${detailField("Stop Loss",o.stop_loss_rules,true)}${detailField("Take Profit",o.take_profit_rules,true)}${detailField("Position sizing",o.position_sizing_rules,true)}${detailField("Дополнительные условия",o.additional_rules,true)}${detailField("Свободное описание",o.freeform_description,true)}
      </div></article>
      <article class="card admin-actions-card"><h3>Управление заявкой</h3>
        <div class="admin-action-row"><label>Стоимость реализации, ₽ <input id="quotePrice" type="number" min="100" max="5000000" value="${o.quoted_price||""}" ${o.paid_at?'disabled':''}></label><button class="secondary" id="saveQuote" ${o.paid_at?'disabled':''}>Сохранить оценку</button><button class="primary" id="sendOffer" ${!o.quoted_price||o.paid_at?'disabled':''}>Отправить предложение клиенту</button></div>
        <div><span class="hint">Статус</span><div class="admin-status-actions" id="statusActions"></div></div>
        <label>Внутренняя заметка <textarea id="adminNotes" maxlength="12000">${esc(o.admin_notes||"")}</textarea></label><button class="secondary" id="saveNotes">Сохранить заметку</button>
        <div class="admin-action-row"><label>Привязать готовую реализацию <select id="runnerSelect">${(runners.runners||[]).map(r=>`<option value="${esc(r.id)}">${esc(r.name)} (${esc(r.id)})</option>`).join("")}</select></label><label>Название для пользователя <input id="privateStrategyName" maxlength="160" value="${esc(o.title||"")}"></label><button class="primary" id="linkStrategy" ${!["PAID","IN_PROGRESS","READY"].includes(o.status)?'disabled':''}>Привязать стратегию</button></div>
        <div class="message" id="adminOrderMessage"></div>
      </article></div>`;
      bindOrderActions(o);
    } catch(e) { errorCard(e); }
  }

  function msg(text, error) { const el=document.getElementById("adminOrderMessage"); if(el){el.textContent=text;el.className="message "+(error?"error":"success");} }
  async function action(button, fn) { if(button.disabled)return; button.disabled=true; try{await fn();}catch(e){msg(e.message,true);button.disabled=false;} }

  function bindOrderActions(o) {
    const transitions = {NEW:["REVIEWING","NEEDS_INFO","CANCELLED"],REVIEWING:["NEEDS_INFO","CANCELLED"],NEEDS_INFO:["REVIEWING","CANCELLED"],WAITING_PAYMENT:["CANCELLED"],PAID:["IN_PROGRESS"],READY:["COMPLETED"]};
    const labels={REVIEWING:"Оцениваем",NEEDS_INFO:"Нужно уточнение",IN_PROGRESS:"В разработку",COMPLETED:"Завершить",CANCELLED:"Отменить"};
    const box=document.getElementById("statusActions"); box.innerHTML=(transitions[o.status]||[]).map(s=>`<button class="secondary ${s==='CANCELLED'?'admin-danger':''}" data-next-status="${s}">${labels[s]||s}</button>`).join("") || `<span class="hint">Нет ручных переходов для текущего статуса.</span>`;
    box.querySelectorAll("[data-next-status]").forEach(b=>b.onclick=()=>action(b,async()=>{await api(`/api/admin/strategy-orders/${o.id}/status`,{method:"POST",body:JSON.stringify({status:b.dataset.nextStatus})});location.reload();}));
    const saveQuote=document.getElementById("saveQuote"); saveQuote.onclick=()=>action(saveQuote,async()=>{await api(`/api/admin/strategy-orders/${o.id}/quote`,{method:"POST",body:JSON.stringify({quoted_price:Number(document.getElementById("quotePrice").value)})});msg("Оценка сохранена",false);setTimeout(()=>location.reload(),250);});
    const send=document.getElementById("sendOffer"); send.onclick=()=>action(send,async()=>{await api(`/api/admin/strategy-orders/${o.id}/send-offer`,{method:"POST",body:"{}"});location.reload();});
    const notes=document.getElementById("saveNotes"); notes.onclick=()=>action(notes,async()=>{await api(`/api/admin/strategy-orders/${o.id}/notes`,{method:"POST",body:JSON.stringify({admin_notes:document.getElementById("adminNotes").value})});msg("Внутренняя заметка сохранена",false);notes.disabled=false;});
    const link=document.getElementById("linkStrategy"); link.onclick=()=>action(link,async()=>{await api(`/api/admin/strategy-orders/${o.id}/link-strategy`,{method:"POST",body:JSON.stringify({runner_strategy_id:document.getElementById("runnerSelect").value,name:document.getElementById("privateStrategyName").value})});msg("Приватная стратегия привязана",false);setTimeout(()=>location.reload(),300);});
  }

  async function payments() {
    root.innerHTML=`<div class="admin-page-head"><div><span class="step">Платежи</span><h2>Платежи и поддержка</h2></div></div><div class="admin-toolbar"><select id="payType"><option value="">Все типы</option><option>CUSTOM_STRATEGY</option><option>SUPPORT</option></select><select id="payStatus"><option value="">Все статусы</option><option>PENDING</option><option>SUCCEEDED</option><option>CANCELED</option></select><button class="secondary" id="payApply">Применить</button></div><article class="card"><div id="adminPaymentsTable"><p class="hint">Загрузка…</p></div></article>`;
    document.getElementById("payApply").onclick=loadPayments; await loadPayments();
  }
  async function loadPayments(){try{const p=new URLSearchParams();const t=document.getElementById("payType").value,s=document.getElementById("payStatus").value;if(t)p.set("type",t);if(s)p.set("status",s);const d=await api(`/api/admin/payments?${p}`);const rows=d.payments||[];document.getElementById("adminPaymentsTable").innerHTML=rows.length?`<div class="table-scroll"><table><thead><tr><th>Дата</th><th>Payment ID</th><th>Пользователь</th><th>Тип</th><th>Заказ</th><th>Сумма</th><th>Provider</th><th>Provider ID</th><th>Статус</th><th>Оплачен</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${dt(x.created_at)}</td><td><code>${esc(x.id.slice(0,10))}…</code></td><td>${x.user?`<span class="admin-table-user">${esc(x.user.display_name)}<small>${esc(x.user.email)}</small></span>`:"—"}</td><td>${esc(x.type)}</td><td>${esc(x.order_public_id||"—")}</td><td>${money(x.amount)}</td><td>${esc(x.provider)}</td><td><code>${esc(x.provider_payment_id||"—")}</code></td><td>${esc(x.status)}</td><td>${dt(x.paid_at)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="hint">Платежей нет.</p>`;}catch(e){document.getElementById("adminPaymentsTable").innerHTML=`<p class="message error">${esc(e.message)}</p>`;}}

  async function users(){try{const d=await api("/api/admin/users");const rows=d.users||[];root.innerHTML=`<div class="admin-page-head"><div><span class="step">Пользователи</span><h2>Пользователи</h2></div></div><article class="card"><div class="table-scroll"><table><thead><tr><th>ID</th><th>Пользователь</th><th>Регистрация</th><th>Портфели</th><th>Бэктесты</th><th>Заявки</th><th>Приватные стратегии</th><th>Оплачено</th></tr></thead><tbody>${rows.map(u=>`<tr><td><code>${esc(u.id.slice(0,10))}…</code></td><td><span class="admin-table-user">${esc(u.display_name)}${u.is_admin?' <small>ADMIN</small>':''}<small>${esc(u.email)}</small></span></td><td>${dt(u.registered_at)}</td><td>${u.portfolios}</td><td>${u.backtests}</td><td>${u.orders}</td><td>${u.private_strategies}</td><td>${money(u.paid_strategies_rub)}</td></tr>`).join("")}</tbody></table></div></article>`;}catch(e){errorCard(e);}}

  if (cfg.section === "orders") orders(); else if (cfg.section === "payments") payments(); else if (cfg.section === "users") users(); else overview();
})();
