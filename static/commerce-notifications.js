(function () {
  "use strict";
  if (window.__strategyLabNotificationsInstalled) return;
  window.__strategyLabNotificationsInstalled = true;

  ["/static/commerce-mobile.css", "/static/commerce-notifications.css"].forEach((href) => {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  });

  const MAX_EVENTS = 60;
  const POLL_MS = 30000;
  let context = null;
  let store = null;
  let center = null;

  async function getJson(url) {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function money(value) {
    return Number(value || 0).toLocaleString("ru-RU") + " ₽";
  }

  function event(id, time, title, text, href, kind) {
    return { id, time: Number(time || Date.now() / 1000), title, text, href, kind: kind || "info" };
  }

  function orderEvents(order) {
    const id = String(order.id || order.public_id || "");
    const pub = String(order.public_id || "");
    const href = `/account/strategies?order=${encodeURIComponent(pub)}`;
    const rows = [event(`order:${id}:received`, order.created_at, `Заявка ${pub} получена`, "Заявка сохранена. Мы сообщим здесь, когда изменится её статус.", href, "received")];
    const status = String(order.status || "");

    if (status === "REVIEWING") rows.push(event(`order:${id}:reviewing`, order.updated_at, `Заявка ${pub} на оценке`, "Мы изучаем правила стратегии и оцениваем объём разработки.", href, "reviewing"));
    if (status === "NEEDS_INFO") rows.push(event(`order:${id}:needs-info`, order.updated_at, `По заявке ${pub} нужно уточнение`, "Откройте заявку: для оценки или разработки требуется дополнительная информация.", href, "needs_info"));

    const quoteVisibleStatuses = new Set(["WAITING_PAYMENT", "PAID", "IN_PROGRESS", "READY", "COMPLETED"]);
    if (order.quoted_price && order.quoted_at && quoteVisibleStatuses.has(status)) {
      rows.push(event(`order:${id}:quoted:${order.quoted_price}`, order.quoted_at, `Заявка ${pub} оценена`, `Стоимость разработки — ${money(order.quoted_price)}.${status === "WAITING_PAYMENT" ? " Можно перейти к оплате." : ""}`, href, "quoted"));
    }
    if (order.paid_at) rows.push(event(`order:${id}:paid`, order.paid_at, `Оплата ${pub} подтверждена`, "Платёж получен. Заявка передана в очередь на разработку.", href, "paid"));
    if (order.started_at) rows.push(event(`order:${id}:started`, order.started_at, `Разработка ${pub} началась`, "Стратегия находится в разработке.", href, "started"));
    if (order.strategy_id && order.completed_at) rows.push(event(`order:${id}:ready`, order.completed_at, `Стратегия ${pub} готова`, "Приватная стратегия появилась в разделе «Мои стратегии» и доступна для настройки и бэктеста.", href, "ready"));
    if (status === "COMPLETED") rows.push(event(`order:${id}:completed`, order.updated_at || order.completed_at, `Заявка ${pub} завершена`, "Работа по заявке завершена.", href, "completed"));
    if (status === "CANCELLED" && order.cancelled_at) rows.push(event(`order:${id}:cancelled`, order.cancelled_at, `Заявка ${pub} отменена`, "Заявка была отменена.", href, "cancelled"));
    if (order.payment_status === "CANCELED" && status === "WAITING_PAYMENT") rows.push(event(`order:${id}:payment-cancelled`, order.updated_at, `Оплата ${pub} не завершена`, "Платёж отменён. Его можно повторить из заявки.", href, "payment_cancelled"));
    return rows;
  }

  function loadStore() {
    const key = `strategy-lab:notifications:${String(context.email || "user").toLowerCase()}`;
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) {}
    store = parsed && Array.isArray(parsed.events) ? parsed : { events: [], read: {} };
    store.key = key;
    store.read = store.read || {};
  }

  function saveStore() {
    try { localStorage.setItem(store.key, JSON.stringify({ events: store.events, read: store.read })); } catch (e) {}
  }

  function mergeEvents(incoming) {
    const existing = new Map(store.events.map((x) => [x.id, x]));
    const added = [];
    incoming.forEach((item) => {
      if (!item || !item.id || existing.has(item.id)) return;
      existing.set(item.id, item);
      store.read[item.id] = false;
      added.push(item);
    });
    store.events = Array.from(existing.values()).sort((a, b) => Number(b.time || 0) - Number(a.time || 0)).slice(0, MAX_EVENTS);
    const allowed = new Set(store.events.map((x) => x.id));
    Object.keys(store.read).forEach((id) => { if (!allowed.has(id)) delete store.read[id]; });
    saveStore();
    return added;
  }

  function fmtTime(ts) {
    const d = new Date(Number(ts || 0) * 1000);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  }

  function unreadCount() {
    return store.events.reduce((n, item) => n + (store.read[item.id] ? 0 : 1), 0);
  }

  function ensureCenter() {
    if (center) return center;
    const hero = document.querySelector(".hero-meta");
    if (!hero) return null;
    center = document.createElement("div");
    center.className = "notification-center";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "notification-trigger";
    trigger.setAttribute("aria-label", "Уведомления");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span class="notification-badge hidden"></span>';

    const panel = document.createElement("div");
    panel.className = "notification-panel hidden";
    panel.innerHTML = '<div class="notification-panel-head"><strong>Уведомления</strong><button type="button" class="notification-mark-all">Прочитать все</button></div><div class="notification-list"></div>';
    center.append(trigger, panel);
    const account = hero.querySelector(".account-menu") || hero.querySelector('a[href="/login"]');
    hero.insertBefore(center, account || null);

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("hidden");
      trigger.setAttribute("aria-expanded", panel.classList.contains("hidden") ? "false" : "true");
    });
    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.querySelector(".notification-mark-all").addEventListener("click", () => {
      store.events.forEach((item) => { store.read[item.id] = true; });
      saveStore(); render();
    });
    document.addEventListener("click", () => {
      panel.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
    });
    return center;
  }

  function render() {
    const root = ensureCenter();
    if (!root) return;
    const badge = root.querySelector(".notification-badge");
    const trigger = root.querySelector(".notification-trigger");
    const list = root.querySelector(".notification-list");
    const count = unreadCount();
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.toggle("hidden", count === 0);
    trigger.classList.toggle("has-unread", count > 0);
    list.textContent = "";
    if (!store.events.length) {
      const empty = document.createElement("div"); empty.className = "notification-empty"; empty.textContent = "Новых событий по заявкам пока нет."; list.appendChild(empty); return;
    }
    store.events.forEach((item) => {
      const link = document.createElement("a");
      link.className = "notification-item" + (store.read[item.id] ? "" : " unread");
      link.href = item.href || "#";
      const head = document.createElement("div"); head.className = "notification-item-title";
      const title = document.createElement("span"); title.textContent = item.title;
      const time = document.createElement("time"); time.textContent = fmtTime(item.time);
      const text = document.createElement("p"); text.textContent = item.text || "";
      head.append(title, time); link.append(head, text);
      link.addEventListener("click", () => { store.read[item.id] = true; saveStore(); });
      list.appendChild(link);
    });
  }

  function toast(item) {
    if (!item || Date.now() / 1000 - Number(item.time || 0) > 180) return;
    const node = document.createElement("div"); node.className = "notification-toast";
    const title = document.createElement("strong"); title.textContent = item.title;
    const text = document.createElement("span"); text.textContent = item.text || "";
    node.append(title, text); document.body.appendChild(node);
    setTimeout(() => node.remove(), 5200);
  }

  async function refresh() {
    if (!context || !context.authenticated) return;
    const all = [];
    try {
      const payload = await getJson("/account/api/strategy-orders");
      (payload.orders || []).forEach((order) => all.push(...orderEvents(order)));
    } catch (e) {}

    if (context.is_admin) {
      try {
        const payload = await getJson("/api/admin/strategy-orders?status=NEW");
        const cutoff = Date.now() / 1000 - 7 * 86400;
        (payload.orders || []).filter((o) => Number(o.created_at || 0) >= cutoff).forEach((o) => {
          all.push(event(`admin:order:${o.id}:new`, o.created_at, `Новая заявка ${o.public_id}`, "Поступила новая заявка на индивидуальную стратегию.", `/admin/strategy-orders/${encodeURIComponent(o.id)}`, "admin_new"));
        });
      } catch (e) {}
    }

    const added = mergeEvents(all);
    render();
    const latest = added.sort((a, b) => Number(b.time || 0) - Number(a.time || 0))[0];
    if (latest) toast(latest);
  }

  async function init() {
    try { context = await getJson("/account/api/commerce-context"); } catch (e) { return; }
    if (!context.authenticated) return;
    loadStore();
    ensureCenter();
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
