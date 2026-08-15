/* Strategy Lab notification channel client.
 *
 * Web Push permission is requested only from an explicit button click. On
 * iPhone/iPad the UI explains the Home Screen requirement instead of asking
 * for permission inside a normal Safari tab, where Web Push is unavailable.
 */
(function (global) {
  "use strict";

  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || "";
  let configCache = null;

  function ensureManifest() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement("link"); link.rel = "manifest"; link.href = "/static/manifest.webmanifest"; document.head.appendChild(link);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      const meta = document.createElement("meta"); meta.name = "theme-color"; meta.content = "#080b12"; document.head.appendChild(meta);
    }
    if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
      const meta = document.createElement("meta"); meta.name = "apple-mobile-web-app-capable"; meta.content = "yes"; document.head.appendChild(meta);
    }
  }

  function ensureStyles() {
    if (document.getElementById("strategyNotificationStyles")) return;
    const style = document.createElement("style");
    style.id = "strategyNotificationStyles";
    style.textContent = `
      .alert-delivery-settings { margin-top:10px; padding-top:10px; border-top:1px solid var(--line); }
      .alert-delivery-title { margin-bottom:7px; color:var(--text); font-size:12px; font-weight:800; }
      .alert-delivery-row { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:46px; padding:6px 2px; color:var(--text); }
      .alert-delivery-row > div { min-width:0; display:flex; flex-direction:column; gap:2px; }
      .alert-delivery-row strong { font-size:12.5px; }
      .alert-delivery-row small { color:var(--muted); font-size:10.5px; line-height:1.3; }
      .alert-delivery-actions { display:flex; align-items:center; gap:6px; flex:none; }
      .alert-delivery-row .secondary { width:auto; min-height:36px; padding:7px 10px; font-size:11px; flex:none; }
      .alert-delivery-row input[type="checkbox"] { width:20px; height:20px; min-height:20px; flex:none; }
      .alert-delivery-row.is-disabled { opacity:.55; }
      .alert-delivery-settings .message { min-height:0; margin-top:4px; font-size:11px; }
      @media (max-width:620px), (max-width:960px) and (max-height:520px) {
        .alert-delivery-row { min-height:50px; align-items:flex-start; }
        .alert-delivery-actions { flex-wrap:wrap; justify-content:flex-end; }
        .alert-delivery-row .secondary { min-height:40px; }
      }
    `;
    document.head.appendChild(style);
  }

  function isAppleMobile() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isStandalone() { return !!(global.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true); }
  function supported() { return "serviceWorker" in navigator && "PushManager" in global && "Notification" in global; }

  async function api(url, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.method && opts.method !== "GET") opts.headers["X-CSRF-Token"] = csrf();
    const r = await fetch(url, opts); const data = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(data.error || `HTTP ${r.status}`); err.status = r.status; throw err; }
    return data;
  }

  async function loadConfig(force) {
    if (configCache && !force) return configCache;
    try { configCache = await api("/api/notifications/config"); return configCache; }
    catch (e) { if (e.status === 401) return null; throw e; }
  }
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }
  async function getRegistration() { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); return navigator.serviceWorker.ready; }
  async function pushStatus() {
    if (isAppleMobile() && !isStandalone()) return { state: "ios-install-required" };
    if (!supported()) return { state: "unsupported" };
    const registration = await getRegistration(); const subscription = await registration.pushManager.getSubscription();
    if (subscription) return { state: "enabled", subscription };
    if (Notification.permission === "denied") return { state: "denied" };
    return { state: "available" };
  }

  async function enablePush() {
    const cfg = await loadConfig(true);
    if (!cfg) throw new Error("Войдите в аккаунт, чтобы получать уведомления.");
    if (!cfg.capabilities.web_push || !cfg.vapid_public_key) throw new Error("Web Push ещё не настроен на сервере.");
    if (isAppleMobile() && !isStandalone()) {
      const err = new Error("На iPhone уведомления работают для веб-приложения, добавленного на экран «Домой». Откройте «Поделиться» → «На экран Домой», запустите Strategy Lab с иконки и включите уведомления здесь."); err.code = "ios-install-required"; throw err;
    }
    if (!supported()) throw new Error("Этот браузер не поддерживает Web Push.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Разрешение на уведомления не предоставлено.");
    const registration = await getRegistration(); let sub = await registration.pushManager.getSubscription();
    if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.vapid_public_key) });
    await api("/api/notifications/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
    configCache = null; return sub;
  }
  async function disablePush() {
    if (!supported()) return;
    const registration = await getRegistration(); const sub = await registration.pushManager.getSubscription();
    if (sub) { const endpoint = sub.endpoint; await api("/api/notifications/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }) }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    await api("/api/notifications/settings", { method: "PATCH", body: JSON.stringify({ web_push_enabled: false }) }).catch(() => {}); configCache = null;
  }
  async function testPush() { return api("/api/notifications/push/test", { method: "POST", body: "{}" }); }
  async function setChannel(key, enabled) { const body = {}; body[key] = !!enabled; const data = await api("/api/notifications/settings", { method: "PATCH", body: JSON.stringify(body) }); configCache = null; return data.settings; }
  async function createTelegramLink() { return (await api("/api/notifications/telegram/link", { method: "POST", body: "{}" })).url; }
  async function unlinkTelegram() { await api("/api/notifications/telegram/link", { method: "DELETE", body: "{}" }); configCache = null; }

  function statusText(state) {
    if (state === "enabled") return "Включены на этом устройстве";
    if (state === "denied") return "Запрещены в настройках устройства";
    if (state === "ios-install-required") return "На iPhone: сначала добавить на экран «Домой»";
    if (state === "unsupported") return "Не поддерживаются этим браузером";
    return "Доступны, но не включены";
  }

  async function renderSettings(host) {
    if (!host) return;
    host.innerHTML = '<div class="muted-note">Проверяем каналы уведомлений…</div>';
    let cfg;
    try { cfg = await loadConfig(true); } catch (e) { host.innerHTML = `<div class="muted-note">${e.message}</div>`; return; }
    if (!cfg) { host.innerHTML = '<div class="muted-note">Войдите в аккаунт, чтобы алерты работали при закрытой вкладке.</div>'; return; }
    let ps = { state: "unsupported" }; try { ps = await pushStatus(); } catch (_) {}
    const pushCap = cfg.capabilities.web_push, emailCap = cfg.capabilities.email, tgCap = cfg.capabilities.telegram;
    host.innerHTML = `
      <div class="alert-delivery-title">Каналы уведомлений</div>
      <div class="alert-delivery-row">
        <div><strong>На устройство</strong><small>${pushCap ? statusText(ps.state) : "Нужно настроить Web Push на сервере"}</small></div>
        <div class="alert-delivery-actions">
          ${ps.state === "enabled" ? '<button class="secondary" type="button" data-notify-test>Тест</button>' : ''}
          <button class="secondary" type="button" data-notify-push>${ps.state === "enabled" ? "Отключить" : "Включить"}</button>
        </div>
      </div>
      <label class="alert-delivery-row ${emailCap ? "" : "is-disabled"}"><div><strong>Email</strong><small>${cfg.email}${emailCap ? "" : " · SMTP не настроен"}</small></div><input type="checkbox" data-notify-email ${cfg.settings.email_enabled ? "checked" : ""} ${emailCap ? "" : "disabled"}></label>
      <div class="alert-delivery-row ${tgCap ? "" : "is-disabled"}"><div><strong>Telegram</strong><small>${cfg.telegram_linked ? "Бот подключён" : (tgCap ? "Подключите бота один раз" : "Бот не настроен")}</small></div><button class="secondary" type="button" data-notify-telegram ${tgCap ? "" : "disabled"}>${cfg.telegram_linked ? "Отключить" : "Подключить"}</button></div>
      <div class="message" data-notify-message></div>`;
    const message = host.querySelector("[data-notify-message]");
    const pushBtn = host.querySelector("[data-notify-push]"); pushBtn.disabled = !pushCap && ps.state !== "enabled";
    pushBtn.onclick = async () => { message.textContent = ""; try { if (ps.state === "enabled") await disablePush(); else await enablePush(); await renderSettings(host); } catch (e) { message.textContent = e.message; message.className = "message error"; } };
    const testBtn = host.querySelector("[data-notify-test]"); if (testBtn) testBtn.onclick = async () => {
      message.textContent = "Отправляем тест…"; message.className = "message"; testBtn.disabled = true;
      try { const data = await testPush(); message.textContent = `Тест отправлен на ${data.sent} устройство.`; message.className = "message success"; }
      catch (e) { message.textContent = e.message; message.className = "message error"; }
      finally { testBtn.disabled = false; }
    };
    const email = host.querySelector("[data-notify-email]"); if (email) email.onchange = async () => { try { await setChannel("email_enabled", email.checked); } catch (e) { email.checked = !email.checked; message.textContent = e.message; message.className = "message error"; } };
    const tg = host.querySelector("[data-notify-telegram]"); if (tg) tg.onclick = async () => { message.textContent = ""; try { if (cfg.telegram_linked) { await unlinkTelegram(); await renderSettings(host); } else { const url = await createTelegramLink(); global.open(url, "_blank", "noopener"); message.textContent = "Откройте бота и нажмите Start. После привязки закройте и снова откройте окно оповещений."; } } catch (e) { message.textContent = e.message; message.className = "message error"; } };
  }

  function mountIntoAlertsPopover() {
    const pop = document.getElementById("gtAlertsPop");
    if (!pop || pop.classList.contains("hidden") || pop.querySelector(".alert-delivery-settings")) return;
    const host = document.createElement("div"); host.className = "alert-delivery-settings"; pop.appendChild(host); renderSettings(host);
  }
  function observeAlertUi() {
    const observer = new MutationObserver(() => mountIntoAlertsPopover());
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    document.addEventListener("click", (e) => { if (e.target.closest?.("#gtAlertBtn")) setTimeout(mountIntoAlertsPopover, 0); });
  }

  ensureManifest(); ensureStyles(); observeAlertUi();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  global.StrategyNotifications = { loadConfig, pushStatus, enablePush, disablePush, testPush, setChannel, createTelegramLink, unlinkTelegram, renderSettings, isStandalone };
})(window);
