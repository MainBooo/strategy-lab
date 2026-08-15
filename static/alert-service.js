/* Price-alert service for the "Анализ графиков" workspace.
 *
 * Anonymous visitors keep the original localStorage-only behavior. Logged-in
 * users transparently switch to the persistent /api/alerts backend so rules
 * are evaluated by the server worker and can notify Web Push/Telegram/email
 * even when Strategy Lab is closed. The public list/create/update/remove API
 * stays synchronous/optimistic so chart-analysis.js needs no state rewrite.
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "moexlab_alerts";
  const SOUND_KEY = "moexlab_alerts_sound";
  const CONDITION_LABELS = {
    price_above: "Цена выше",
    price_below: "Цена ниже",
    cross_up: "Пересечение снизу вверх",
    cross_down: "Пересечение сверху вниз",
  };

  function csrf() { return document.querySelector('meta[name="csrf-token"]')?.content || ""; }
  function uid() { return "al" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function loadList() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function saveList(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { /* private/quota */ }
  }
  function fmtVal(n) { return Number(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function beep() {
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.4);
      osc.onended = () => ctx.close();
    } catch (e) { /* audio unavailable */ }
  }

  function ensureToastHost() {
    let host = document.getElementById("alertToastHost");
    if (!host) { host = document.createElement("div"); host.id = "alertToastHost"; host.className = "alert-toast-host"; document.body.appendChild(host); }
    return host;
  }
  function showToast(alert, price) {
    const host = ensureToastHost(); const el = document.createElement("div");
    el.className = "alert-toast";
    el.innerHTML = `<div class="alert-toast-title">🔔 ${alert.symbol}</div><div class="alert-toast-body">${CONDITION_LABELS[alert.condition]} ${fmtVal(alert.value ?? alert.threshold)} · сейчас ${fmtVal(price)}</div>`;
    host.appendChild(el); requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 6000);
  }

  async function requestJson(url, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.method && opts.method !== "GET") opts.headers["X-CSRF-Token"] = csrf();
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(data.error || `HTTP ${r.status}`); err.status = r.status; throw err; }
    return data;
  }

  const AlertService = {
    CONDITION_LABELS,
    _list: loadList(),
    _lastPrice: new Map(),
    _changeCbs: [], _triggeredCbs: [],
    _serverMode: false, _eventAfter: Date.now() / 1000, _eventTimer: null,

    onChange(cb) { this._changeCbs.push(cb); },
    onTriggered(cb) { this._triggeredCbs.push(cb); },
    list() { return this._list.slice(); },
    listFor(symbol) { return this._list.filter((a) => a.symbol === symbol); },
    isServerBacked() { return this._serverMode; },

    isSoundEnabled() { try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch (e) { return true; } },
    setSoundEnabled(on) { try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch (e) {} },

    _notifyChange() { this._changeCbs.forEach((cb) => { try { cb(this.list()); } catch (e) { console.error(e); } }); },
    _persistLocal() { saveList(this._list); this._notifyChange(); },

    create(data) {
      const alert = { id: uid(), symbol: String(data.symbol || "").toUpperCase(), condition: data.condition, value: Number(data.value), repeat: data.repeat === "repeat" ? "repeat" : "once", enabled: true, createdAt: Date.now(), lastTriggeredAt: null, triggerCount: 0 };
      this._list.push(alert); this._notifyChange();
      this._ready.then(async () => {
        if (!this._serverMode) { this._persistLocal(); return; }
        try {
          const result = await requestJson("/api/alerts", { method: "POST", body: JSON.stringify({ symbol: alert.symbol, condition: alert.condition, value: alert.value, repeat: alert.repeat }) });
          const idx = this._list.findIndex((x) => x.id === alert.id); if (idx >= 0) this._list[idx] = this._normalizeServer(result.alert);
          this._notifyChange();
        } catch (e) { console.error("Alert create failed", e); this._list = this._list.filter((x) => x.id !== alert.id); this._notifyChange(); }
      });
      return alert;
    },

    update(id, patch) {
      const a = this._list.find((x) => x.id === id); if (!a) return null;
      Object.assign(a, patch); this._notifyChange();
      this._ready.then(async () => {
        if (!this._serverMode || !String(id).startsWith("al_")) { this._persistLocal(); return; }
        try { const r = await requestJson(`/api/alerts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }); Object.assign(a, this._normalizeServer(r.alert)); this._notifyChange(); }
        catch (e) { console.error("Alert update failed", e); await this._refreshRemote(); }
      });
      return a;
    },
    setEnabled(id, enabled) { return this.update(id, { enabled: !!enabled }); },
    remove(id) {
      this._list = this._list.filter((x) => x.id !== id); this._notifyChange();
      this._ready.then(async () => {
        if (!this._serverMode || !String(id).startsWith("al_")) { this._persistLocal(); return; }
        try { await requestJson(`/api/alerts/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) { console.error("Alert remove failed", e); }
      });
    },

    _normalizeServer(a) {
      return { id: a.id, symbol: a.symbol, condition: a.condition, value: Number(a.value), repeat: a.repeat, enabled: !!a.enabled, createdAt: Number(a.created_at || 0) * 1000, lastTriggeredAt: a.last_triggered_at ? Number(a.last_triggered_at) * 1000 : null, triggerCount: Number(a.trigger_count || 0) };
    },

    async _refreshRemote() {
      if (!this._serverMode) return;
      try { const data = await requestJson("/api/alerts"); this._list = (data.alerts || []).map((a) => this._normalizeServer(a)); this._notifyChange(); }
      catch (e) { console.error("Alert refresh failed", e); }
    },

    async _initRemote() {
      try {
        const data = await requestJson("/api/alerts");
        this._serverMode = true;
        const remote = (data.alerts || []).map((a) => this._normalizeServer(a));
        // One-time convenience migration: if this account has no server rules
        // yet, preserve alerts previously created in this browser.
        if (!remote.length && this._list.length) {
          for (const local of this._list.filter((a) => a.symbol && CONDITION_LABELS[a.condition] && Number.isFinite(Number(a.value)))) {
            try { await requestJson("/api/alerts", { method: "POST", body: JSON.stringify({ symbol: local.symbol, condition: local.condition, value: Number(local.value), repeat: local.repeat }) }); } catch (_) {}
          }
          const migrated = await requestJson("/api/alerts");
          this._list = (migrated.alerts || []).map((a) => this._normalizeServer(a));
        } else this._list = remote;
        this._notifyChange();
        this._startEventPolling();
      } catch (e) {
        if (e.status !== 401) console.warn("Persistent alerts unavailable; using local alerts", e);
        this._serverMode = false; this._persistLocal();
      }
    },

    _startEventPolling() {
      if (this._eventTimer) return;
      const poll = async () => {
        if (!this._serverMode || document.hidden) return;
        try {
          const data = await requestJson(`/api/alerts/events?after=${encodeURIComponent(this._eventAfter)}`);
          for (const evt of data.events || []) {
            this._eventAfter = Math.max(this._eventAfter, Number(evt.created_at || 0) + 0.000001);
            const alert = { id: evt.alert_id, symbol: evt.symbol, condition: evt.condition, value: evt.threshold };
            showToast(alert, evt.price); if (this.isSoundEnabled()) beep();
            this._triggeredCbs.forEach((cb) => { try { cb(alert, evt.price); } catch (e) { console.error(e); } });
          }
          if ((data.events || []).length) await this._refreshRemote();
        } catch (e) { if (e.status === 401) this._serverMode = false; }
      };
      this._eventTimer = setInterval(poll, 10000); poll();
      document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    },

    /** Anonymous/local fallback only. Authenticated rules are evaluated by the
     * server worker so they continue to work with every browser tab closed. */
    evaluate(symbol, price) {
      if (this._serverMode || price == null || !Number.isFinite(price)) return;
      const prev = this._lastPrice.get(symbol); this._lastPrice.set(symbol, price);
      const candidates = this._list.filter((a) => a.enabled && a.symbol === symbol);
      for (const a of candidates) {
        let hit = false;
        if (a.condition === "price_above") hit = price >= a.value;
        else if (a.condition === "price_below") hit = price <= a.value;
        else if (a.condition === "cross_up") hit = prev != null && prev < a.value && price >= a.value;
        else if (a.condition === "cross_down") hit = prev != null && prev > a.value && price <= a.value;
        if (hit) this._fireLocal(a, price);
      }
    },
    _fireLocal(alert, price) {
      alert.lastTriggeredAt = Date.now(); alert.triggerCount += 1; if (alert.repeat === "once") alert.enabled = false;
      this._persistLocal(); showToast(alert, price); if (this.isSoundEnabled()) beep();
      this._triggeredCbs.forEach((cb) => { try { cb(alert, price); } catch (e) { console.error(e); } });
    },
  };

  global.AlertService = AlertService;
  AlertService._ready = AlertService._initRemote();

  // Load the optional delivery-channel UI after the core alert API exists.
  if (!document.querySelector('script[data-strategy-notifications]')) {
    const s = document.createElement("script"); s.src = "/static/notifications-client.js"; s.defer = true; s.dataset.strategyNotifications = "1"; document.head.appendChild(s);
  }
})(window);
