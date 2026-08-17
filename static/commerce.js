(function (global) {
  "use strict";

  const analytics = () => global.StrategyLabAnalytics;
  const track = (name, params) => { try { const a = analytics(); if (a && a.trackGoal) a.trackGoal(name, params || {}); } catch (e) {} };
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = (n) => Number(n || 0).toLocaleString("ru-RU") + " ₽";
  const date = (ts) => ts ? new Date(ts * 1000).toLocaleDateString("ru-RU") : "—";

  function installCss() {
    if (document.querySelector('link[data-commerce-css="1"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "/static/commerce.css"; link.dataset.commerceCss = "1";
    document.head.appendChild(link);
  }

  function csrf() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : "";
  }

  async function api(url, options) {
    options = options || {};
    const method = String(options.method || "GET").toUpperCase();
    const headers = Object.assign({}, options.headers || {});
    if (options.body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-CSRF-Token"] = csrf();
    const response = await fetch(url, Object.assign({}, options, { headers, credentials: "same-origin" }));
    let data = null;
    try { data = await response.json(); } catch (e) {}
    if (!response.ok) throw new Error((data && data.error) || `Ошибка запроса (${response.status})`);
    return data;
  }

  let context = { authenticated: false, is_admin: false, email: null };
  async function loadContext() {
    try { context = await api("/account/api/commerce-context"); } catch (e) {}
    return context;
  }

  function addHeaderSupport() {
    const hero = document.querySelector(".hero-meta");
    if (!hero || document.getElementById("supportProjectBtn")) return;
    const btn = document.createElement("button");
    btn.type = "button"; btn.id = "supportProjectBtn"; btn.className = "secondary commerce-support-header";
    btn.innerHTML = "♡ Поддержать проект";
    btn.addEventListener("click", () => openSupport("header"));
    const account = hero.querySelector(".account-menu") || hero.querySelector('a[href="/login"]');
    hero.insertBefore(btn, account || null);
  }

  function addAccountMenuItems() {
    const menu = document.getElementById("accountDropdown");
    if (!menu || menu.querySelector("[data-commerce-menu]")) return;
    const marker = document.createElement("div"); marker.dataset.commerceMenu = "1"; marker.className = "commerce-menu-links";
    marker.innerHTML = `<a href="/account/strategies">Мои стратегии</a><button type="button" data-support-menu>♡ Поддержать Strategy Lab</button>${context.is_admin ? '<a href="/admin">Админ-панель</a>' : ''}`;
    const logout = menu.querySelector("#logoutBtn") || menu.querySelector("button:last-child");
    menu.insertBefore(marker, logout || null);
    const support = marker.querySelector("[data-support-menu]");
    if (support) support.onclick = (e) => { e.stopPropagation(); openSupport("account_menu"); };
  }

  function ensureStrategyCtas() {
    const page = document.getElementById("tab-strategies");
    if (page) {
      const head = page.querySelector(".card-head");
      if (head && !head.querySelector("[data-custom-strategy-header-cta]")) {
        const wrap = document.createElement("div"); wrap.className = "custom-strategy-head-cta"; wrap.dataset.customStrategyHeaderCta = "1";
        wrap.innerHTML = `<button type="button" class="secondary" data-open-custom-strategy data-source="strategy_header">+ Добавить свою стратегию</button><small>Платная индивидуальная разработка</small>`;
        head.appendChild(wrap);
      }
      const grid = document.getElementById("strategyCards");
      if (grid && !grid.querySelector("[data-custom-strategy-cta-card]")) {
        const card = document.createElement("article"); card.className = "strategy-card custom-strategy-cta-card"; card.dataset.customStrategyCtaCard = "1";
        card.innerHTML = `<div><span class="strategy-category">Индивидуальная разработка</span><h3>Есть собственная торговая стратегия?</h3><p class="strategy-summary">Опишите правила входа и выхода — реализуем её в Strategy Lab, чтобы вы могли тестировать идею на исторических данных Binance.</p><button type="button" class="primary" data-open-custom-strategy data-source="strategy_card">Добавить свою стратегию</button><small>Платная индивидуальная разработка · существующие функции остаются бесплатными</small></div>`;
        grid.appendChild(card);
      }
    }
    const assignment = document.querySelector(".strategy-assignment-head");
    if (assignment && !assignment.querySelector("[data-custom-strategy-assignment-cta]")) {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "link-btn custom-strategy-inline-cta";
      btn.dataset.customStrategyAssignmentCta = "1"; btn.dataset.openCustomStrategy = "1"; btn.dataset.source = "portfolio_strategies";
      btn.textContent = "+ Не нашли нужную стратегию? Добавить собственную";
      assignment.appendChild(btn);
    }
  }

  function bindGlobalClicks() {
    document.addEventListener("click", (event) => {
      const opener = event.target.closest && event.target.closest("[data-open-custom-strategy]");
      if (opener) {
        event.preventDefault();
        const source = opener.dataset.source || "unknown";
        track("custom_strategy_cta_click", { source });
        openOrder(source);
      }
    });
  }

  function modalShell(id, body) {
    let modal = document.getElementById(id);
    if (modal) return modal;
    modal = document.createElement("div"); modal.id = id; modal.className = "commerce-modal hidden";
    modal.innerHTML = `<div class="commerce-modal-backdrop" data-close-commerce></div><div class="commerce-modal-panel" role="dialog" aria-modal="true"><button class="close-btn" type="button" data-close-commerce aria-label="Закрыть">×</button>${body}</div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll("[data-close-commerce]").forEach((el) => el.onclick = () => modal.classList.add("hidden"));
    return modal;
  }

  function ensureOrderModal() {
    const body = `<div class="commerce-modal-head"><span class="step">Индивидуальная разработка</span><h2>Добавить свою стратегию</h2><p>Опишите торговые правила своими словами. Не обязательно использовать технические термины — мы уточним детали перед разработкой.</p></div>
      <form id="customStrategyOrderForm" class="commerce-order-form">
        <div class="form-grid two"><label>Название стратегии <input name="title" maxlength="160" placeholder="Например, Пробой утреннего диапазона"></label><label>Рынок / инструменты <input name="market" maxlength="500" value="Binance Spot" placeholder="Любые пары Binance Spot"</label></div>
        <label>Конкретные тикеры <input name="symbols" maxlength="1000" placeholder="Например: BTCUSDT, ETHUSDT — можно оставить пустым"></label>
        <fieldset><legend>Таймфрейм</legend><div class="commerce-checks">${["1m","10m","15m","30m","1h","4h","1d","other"].map((x) => `<label><input type="checkbox" name="timeframes" value="${x}" ${x === "10m" ? "checked" : ""}> ${x === "other" ? "Другое" : x}</label>`).join("")}</div></fieldset>
        <fieldset><legend>Направление торговли</legend><div class="commerce-checks"><label><input type="checkbox" name="directions" value="long" checked> Long</label><label><input type="checkbox" name="directions" value="short"> Short</label></div></fieldset>
        <div class="form-grid two"><label>Условия входа <textarea name="entry_rules" rows="4" maxlength="8000"></textarea></label><label>Условия выхода <textarea name="exit_rules" rows="4" maxlength="8000"></textarea></label></div>
        <div class="form-grid two"><label>Stop Loss <textarea name="stop_loss_rules" rows="3" maxlength="4000"></textarea></label><label>Take Profit <textarea name="take_profit_rules" rows="3" maxlength="4000"></textarea></label></div>
        <label>Размер позиции / управление капиталом <textarea name="position_sizing_rules" rows="3" maxlength="4000"></textarea></label>
        <label>Дополнительные фильтры <textarea name="additional_rules" rows="4" maxlength="8000" placeholder="Индикаторы, объём, время, несколько таймфреймов, дополнительные условия"></textarea></label>
        <label>Опишите стратегию своими словами <textarea name="freeform_description" rows="7" maxlength="12000" placeholder="Можно описать идею свободно — что должно происходить на графике, когда входить и когда выходить"></textarea></label>
        <label>Контакт для связи <input name="contact" maxlength="254" required></label>
        <p class="hint">Файлы пока не загружаются: приватное файловое хранилище будет добавлено отдельно. Текст заявки доступен только вам и администратору и не отправляется в Метрику.</p>
        <div class="commerce-form-actions"><button class="primary" type="submit">Отправить заявку</button><div class="message" id="customStrategyOrderMessage"></div></div>
      </form>`;
    const modal = modalShell("customStrategyOrderModal", body);
    const form = modal.querySelector("#customStrategyOrderForm");
    if (!form.dataset.bound) {
      form.dataset.bound = "1";
      form.addEventListener("submit", submitOrder);
    }
    return modal;
  }

  async function openOrder(source) {
    if (!context.authenticated) {
      location.href = "/login?next=/";
      return;
    }
    const modal = ensureOrderModal();
    const contact = modal.querySelector('[name="contact"]');
    if (contact && !contact.value) contact.value = context.email || "";
    modal.dataset.source = source || "unknown";
    modal.classList.remove("hidden");
    track("custom_strategy_order_open", { source: modal.dataset.source });
  }

  async function submitOrder(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const btn = form.querySelector('button[type="submit"]');
    const msg = form.querySelector("#customStrategyOrderMessage");
    const fd = new FormData(form);
    const payload = {
      title: fd.get("title"), market: fd.get("market"), symbols: fd.get("symbols"),
      timeframes: fd.getAll("timeframes"), directions: fd.getAll("directions"),
      entry_rules: fd.get("entry_rules"), exit_rules: fd.get("exit_rules"),
      stop_loss_rules: fd.get("stop_loss_rules"), take_profit_rules: fd.get("take_profit_rules"),
      position_sizing_rules: fd.get("position_sizing_rules"), additional_rules: fd.get("additional_rules"),
      freeform_description: fd.get("freeform_description"), contact: fd.get("contact")
    };
    btn.disabled = true; msg.textContent = ""; msg.className = "message";
    try {
      const order = await api("/api/custom-strategy-orders", { method: "POST", body: JSON.stringify(payload) });
      track("custom_strategy_order_submit", { source: document.getElementById("customStrategyOrderModal").dataset.source, timeframes_count: payload.timeframes.length, directions_count: payload.directions.length });
      msg.textContent = `Заявка #${order.public_id} отправлена.`; msg.className = "message success";
      setTimeout(() => { location.href = "/account/strategies"; }, 350);
    } catch (err) {
      msg.textContent = err.message; msg.className = "message error";
    } finally { btn.disabled = false; }
  }

  function ensureSupportModal() {
    const body = `<div class="commerce-modal-head"><span class="step">Добровольно</span><h2>Поддержать Strategy Lab</h2><p>Strategy Lab развивается как бесплатный проект. Если сервис оказался полезен, вы можете поддержать его дальнейшую разработку.</p></div>
      <form id="supportForm"><div class="support-amounts"><button type="button" data-support-amount="300">300 ₽</button><button type="button" data-support-amount="500" class="selected">500 ₽</button><button type="button" data-support-amount="1000">1 000 ₽</button><button type="button" data-support-amount="custom">Другая сумма</button></div><label id="supportCustomWrap" class="hidden">Сумма, ₽ <input type="number" id="supportCustomAmount" min="100" max="100000" step="100" value="1500"></label><input type="hidden" id="supportAmount" value="500"><button class="primary" type="submit">Поддержать</button><div class="message" id="supportMessage"></div><p class="hint">Разовый платёж. Поддержка не открывает и не ограничивает функции Strategy Lab.</p></form>`;
    const modal = modalShell("supportModal", body);
    modal.querySelectorAll("[data-support-amount]").forEach((b) => b.onclick = () => {
      modal.querySelectorAll("[data-support-amount]").forEach((x) => x.classList.toggle("selected", x === b));
      const custom = b.dataset.supportAmount === "custom";
      modal.querySelector("#supportCustomWrap").classList.toggle("hidden", !custom);
      if (!custom) modal.querySelector("#supportAmount").value = b.dataset.supportAmount;
      track("support_amount_select", { amount_preset: custom ? "custom" : Number(b.dataset.supportAmount) });
    });
    modal.querySelector("#supportForm").onsubmit = submitSupport;
    return modal;
  }

  function openSupport(source) {
    track("support_click", { source });
    if (!context.authenticated) { location.href = "/login?next=/"; return; }
    ensureSupportModal().classList.remove("hidden");
  }

  async function submitSupport(event) {
    event.preventDefault();
    const form = event.currentTarget; const modal = form.closest(".commerce-modal");
    const selected = modal.querySelector("[data-support-amount].selected");
    const amount = selected && selected.dataset.supportAmount === "custom" ? Number(modal.querySelector("#supportCustomAmount").value) : Number(modal.querySelector("#supportAmount").value);
    const btn = form.querySelector('button[type="submit"]'); const msg = modal.querySelector("#supportMessage");
    btn.disabled = true; msg.textContent = "";
    try {
      track("support_checkout_start", { amount });
      const result = await api("/api/billing/support/create-payment", { method: "POST", body: JSON.stringify({ amount }) });
      location.href = result.confirmation_url;
    } catch (err) { msg.textContent = err.message; msg.className = "message error"; btn.disabled = false; }
  }

  function addAccountStrategiesPage() {
    const nav = document.querySelector(".account-tabs");
    if (!nav || nav.querySelector('[href="/account/strategies"]')) return;
    const link = document.createElement("a"); link.className = "tab"; link.href = "/account/strategies"; link.textContent = "Мои стратегии";
    const settings = nav.querySelector('[data-account-tab="settings"]'); nav.insertBefore(link, settings || null);
    const root = document.querySelector(".account-page");
    if (!root || document.getElementById("account-strategies")) return;
    const page = document.createElement("div"); page.id = "account-strategies"; page.className = "account-subpage hidden";
    page.innerHTML = `<article class="card"><div class="card-head"><div><h2>Мои стратегии</h2></div></div><div id="privateStrategiesList"><p class="hint">Загрузка…</p></div></article><article class="card results-card"><div class="card-head"><div><h2>Мои заявки</h2></div><button type="button" class="secondary" data-open-custom-strategy data-source="account_orders">+ Новая заявка</button></div><div id="customStrategyOrdersList"><p class="hint">Загрузка…</p></div></article>`;
    root.insertBefore(page, root.querySelector("#account-settings") || null);
    if (location.pathname === "/account/strategies") {
      document.querySelectorAll(".account-subpage").forEach((el) => el.classList.add("hidden"));
      page.classList.remove("hidden");
      document.querySelectorAll(".account-tabs .tab").forEach((el) => el.classList.remove("active")); link.classList.add("active");
      loadMyCommerce();
    }
  }

  const quoteTracked = new Set();
  async function loadMyCommerce() {
    let orders = [], strategies = [];
    try {
      const results = await Promise.all([api("/account/api/strategy-orders"), api("/account/api/private-strategies")]);
      orders = results[0].orders || []; strategies = results[1].strategies || [];
    } catch (e) {}
    const sbox = document.getElementById("privateStrategiesList");
    if (sbox) sbox.innerHTML = strategies.length ? `<div class="private-strategy-list">${strategies.map((s) => `<div class="private-strategy-card"><div><span class="pill">Приватная</span><h3>${esc(s.name)}</h3><p class="hint">Доступна только вам и администратору.</p></div><div class="private-strategy-actions"><a class="secondary" href="/?openStrategy=${encodeURIComponent(s.id)}">Настроить</a><a class="primary" href="/?openPrivateBacktest=${encodeURIComponent(s.id)}">Запустить бэктест</a></div></div>`).join("")}</div>` : `<p class="hint">Готовых приватных стратегий пока нет. После реализации стратегия появится здесь.</p>`;
    const obox = document.getElementById("customStrategyOrdersList");
    if (obox) obox.innerHTML = orders.length ? `<div class="table-scroll"><table><thead><tr><th>№</th><th>Название</th><th>Дата</th><th>Статус</th><th>Стоимость</th><th>Оплата</th><th></th></tr></thead><tbody>${orders.map((o) => {
      if (o.status === "WAITING_PAYMENT" && !quoteTracked.has(o.id)) { quoteTracked.add(o.id); track("custom_strategy_quote_view", { order_status: o.status, amount: o.quoted_price || undefined }); }
      const pay = o.status === "WAITING_PAYMENT" && o.quoted_price ? `<button class="primary" data-pay-order="${esc(o.id)}">Оплатить ${money(o.quoted_price)}</button>` : "";
      return `<tr><td>#${esc(o.public_id)}</td><td>${esc(o.title || "Без названия")}</td><td>${date(o.created_at)}</td><td><span class="pill status-${String(o.status).toLowerCase()}">${esc(o.status_label)}</span></td><td>${o.quoted_price ? money(o.quoted_price) : "—"}</td><td>${o.payment_status === "SUCCEEDED" ? "Оплачено" : (o.payment_status === "CANCELED" ? "Отменён" : "—")}</td><td>${pay}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<p class="hint">Заявок пока нет.</p>`;
    if (obox) obox.querySelectorAll("[data-pay-order]").forEach((b) => b.onclick = () => payOrder(b.dataset.payOrder, b));
  }

  async function payOrder(orderId, button) {
    button.disabled = true;
    try {
      track("custom_strategy_payment_click", {});
      const result = await api("/api/billing/custom-strategy/create-payment", { method: "POST", body: JSON.stringify({ order_id: orderId }) });
      location.href = result.confirmation_url;
    } catch (e) { alert(e.message); button.disabled = false; }
  }

  async function refreshPrivateCatalog() {
    if (!document.getElementById("strategyCards")) return;
    try {
      const catalog = await api("/api/strategies");
      global.STRATEGIES = catalog;
      if (typeof global.fillStrategies === "function") global.fillStrategies();
      ensureStrategyCtas();
      const params = new URLSearchParams(location.search);
      if ((params.get("openStrategy") || params.get("openPrivateBacktest")) && typeof global.activateTab === "function") {
        global.activateTab(params.get("openPrivateBacktest") ? "backtest" : "strategies");
      }
    } catch (e) {}
  }

  async function handlePaymentResult() {
    const cfg = global.STRATEGY_LAB_PAYMENT_RESULT;
    if (!cfg || !cfg.payment_id) return;
    const title = document.getElementById("paymentResultTitle"); const text = document.getElementById("paymentResultText"); const actions = document.getElementById("paymentResultActions");
    try { await api("/api/billing/yookassa/sync", { method: "POST", body: "{}" }); } catch (e) {}
    let payment = null;
    for (let i = 0; i < 4; i++) {
      try { payment = await api(`/account/api/payments/${encodeURIComponent(cfg.payment_id)}/status`); } catch (e) { break; }
      if (payment.status !== "PENDING") break;
      if (i < 3) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    if (!payment) { title.textContent = "Не удалось проверить платёж"; text.textContent = "Откройте раздел «Мои стратегии» и проверьте статус позже."; return; }
    const eventKey = `strategy-lab-payment-goal:${payment.id}:${payment.status}`;
    if (payment.status === "SUCCEEDED") {
      if (payment.type === "SUPPORT") {
        title.textContent = "Спасибо за поддержку Strategy Lab ❤️"; text.textContent = "Платёж получен. Все основные функции проекта по-прежнему остаются бесплатными.";
        if (!sessionStorage.getItem(eventKey)) { track("support_success", { amount: payment.amount }); sessionStorage.setItem(eventKey, "1"); }
        actions.innerHTML = `<a class="primary" href="/">Вернуться в Strategy Lab</a>`;
      } else {
        title.textContent = "Оплата получена"; text.textContent = "Заявка передана в разработку. Её актуальный статус всегда доступен в разделе «Мои стратегии».";
        if (!sessionStorage.getItem(eventKey)) { track("custom_strategy_payment_success", { amount: payment.amount }); sessionStorage.setItem(eventKey, "1"); }
        actions.innerHTML = `<a class="primary" href="/account/strategies">Открыть заявку</a>`;
      }
    } else if (payment.status === "CANCELED") {
      title.textContent = "Платёж отменён"; text.textContent = "Списание не подтверждено. Вы можете повторить оплату из своей заявки.";
      actions.innerHTML = `<a class="secondary" href="/account/strategies">Мои заявки</a>`;
    } else {
      title.textContent = "Платёж обрабатывается"; text.textContent = "YooKassa ещё не подтвердила итоговый статус. Возврат на эту страницу не считается оплатой; статус обновится после webhook или серверной синхронизации.";
    }
  }

  function observeStrategyGrid() {
    const grid = document.getElementById("strategyCards");
    if (!grid || grid.dataset.commerceObserved) return;
    grid.dataset.commerceObserved = "1";
    new MutationObserver(() => ensureStrategyCtas()).observe(grid, { childList: true });
  }

  async function init() {
    installCss(); bindGlobalClicks(); await loadContext();
    addHeaderSupport(); addAccountMenuItems(); addAccountStrategiesPage();
    ensureStrategyCtas(); observeStrategyGrid(); await refreshPrivateCatalog(); await handlePaymentResult();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})(window);
