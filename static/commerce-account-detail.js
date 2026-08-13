(function () {
  "use strict";

  if (location.pathname !== "/account/strategies") return;

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = (n) => Number(n || 0).toLocaleString("ru-RU") + " ₽";
  const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleString("ru-RU") : "—";

  async function api(url) {
    if (window.authFetch) return window.authFetch(url);
    const r = await fetch(url, { credentials: "same-origin" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Ошибка запроса (${r.status})`);
    return d;
  }

  function field(label, value) {
    return `<div class="admin-detail-block wide"><span>${esc(label)}</span><p>${esc(value || "—")}</p></div>`;
  }

  function ensureModal() {
    let modal = document.getElementById("accountOrderDetailModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "accountOrderDetailModal";
    modal.className = "commerce-modal hidden";
    modal.innerHTML = `<div class="commerce-modal-backdrop" data-close-order-detail></div><div class="commerce-modal-panel account-order-detail-panel" role="dialog" aria-modal="true" aria-label="Заявка на разработку стратегии"><button class="close-btn" type="button" data-close-order-detail aria-label="Закрыть">×</button><div id="accountOrderDetailBody"><p class="hint">Загрузка…</p></div></div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll("[data-close-order-detail]").forEach((el) => el.onclick = closeModal);
    return modal;
  }

  function closeModal() {
    const modal = document.getElementById("accountOrderDetailModal");
    if (modal) modal.classList.add("hidden");
    const url = new URL(location.href); url.searchParams.delete("order"); history.replaceState(null, "", url.pathname + (url.search ? url.search : ""));
  }

  async function openOrder(orderId) {
    const modal = ensureModal(); const body = modal.querySelector("#accountOrderDetailBody");
    modal.classList.remove("hidden"); body.innerHTML = `<p class="hint">Загрузка заявки…</p>`;
    try {
      const o = await api(`/account/api/strategy-orders/${encodeURIComponent(orderId)}`);
      body.innerHTML = `<div class="commerce-modal-head"><span class="step">#${esc(o.public_id)}</span><h2>${esc(o.title || "Заявка на стратегию")}</h2><p>${esc(o.status_label || o.status)} · ${fmtDate(o.created_at)}${o.quoted_price ? ` · ${money(o.quoted_price)}` : ""}</p></div><div class="admin-detail-grid account-order-detail-grid">
        ${field("Рынок / инструменты", [o.market, o.symbols].filter(Boolean).join(" · "))}
        ${field("Таймфреймы", (o.timeframes || []).join(", "))}
        ${field("Направления", (o.directions || []).join(", "))}
        ${field("Условия входа", o.entry_rules)}
        ${field("Условия выхода", o.exit_rules)}
        ${field("Stop Loss", o.stop_loss_rules)}
        ${field("Take Profit", o.take_profit_rules)}
        ${field("Размер позиции / управление капиталом", o.position_sizing_rules)}
        ${field("Дополнительные условия", o.additional_rules)}
        ${field("Описание своими словами", o.freeform_description)}
        ${field("Контакт", o.contact)}
      </div><p class="hint account-order-privacy-note">Внутренние заметки администратора и служебные данные платежей в пользовательский ответ не включаются.</p>`;
      const url = new URL(location.href); url.searchParams.set("order", o.public_id); history.replaceState(null, "", url.pathname + "?" + url.searchParams.toString());
    } catch (e) {
      body.innerHTML = `<h2>Заявка не найдена</h2><p class="message error">${esc(e.message)}</p>`;
    }
  }

  function decorateOrders() {
    const box = document.getElementById("customStrategyOrdersList");
    if (!box) return;
    box.querySelectorAll("tbody tr").forEach((row) => {
      if (row.dataset.orderDetailDecorated) return;
      const first = row.querySelector("td:first-child");
      if (!first) return;
      const publicId = first.textContent.trim().replace(/^#/, "");
      if (!/^SL-\d+$/i.test(publicId)) return;
      row.dataset.orderDetailDecorated = "1";
      const last = row.querySelector("td:last-child");
      if (last) {
        const btn = document.createElement("button"); btn.type = "button"; btn.className = "link-btn"; btn.textContent = "Подробнее";
        btn.onclick = () => openOrder(publicId); last.prepend(btn);
      }
      first.innerHTML = `<button type="button" class="link-btn" data-order-detail-public="${esc(publicId)}">#${esc(publicId)}</button>`;
      first.querySelector("button").onclick = () => openOrder(publicId);
    });
  }

  function init() {
    const root = document.getElementById("account-strategies") || document.querySelector(".account-page");
    if (!root) { setTimeout(init, 120); return; }
    decorateOrders();
    new MutationObserver(decorateOrders).observe(root, { childList: true, subtree: true });
    const requested = new URLSearchParams(location.search).get("order");
    if (requested) openOrder(requested);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
