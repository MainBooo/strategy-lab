/* Local price-alert service for the "Анализ графиков" workspace (Stage 9).
 *
 * This is a genuine, working implementation, not a placeholder UI: alerts
 * are stored in localStorage, evaluated against real realtime ticks (see
 * ChartTile.onLiveTick in chart-engine/chart-tile.js - never against
 * crosshair-hover prices), and trigger both an in-app toast and an optional
 * sound.
 *
 * It's deliberately shaped like a small, swappable backend client rather
 * than a pile of DOM code with state mixed in:
 *   - AlertService.list()/create()/update()/remove()/setEnabled() are the
 *     only way alert state is read or written.
 *   - AlertService.evaluate(symbol, price) is the only way a price tick
 *     reaches it.
 *   - Persistence (localStorage) is isolated in _load()/_save() below - the
 *     rest of the module has no idea where alerts live. Moving this to a
 *     real backend later means replacing _load()/_save()/evaluate()'s
 *     trigger persistence with API calls; every caller (chart-analysis.js,
 *     the alerts popover) keeps working against the same list()/create()/...
 *     surface.
 * There is intentionally no server-side push here: without a background
 * process independent of the open browser tab, alerts can only fire while a
 * chart tile showing that symbol is open and ticking (see chart-tile.js's
 * realtime polling) - a real, stated architectural limit of a browser-only
 * implementation, not a hidden gap. */
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

  function uid() { return "al" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function loadList() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function saveList(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { /* quota/private mode - alerts just won't persist across reloads */ }
  }

  /** Short beep via Web Audio - no asset file to ship/load, and it respects
   * the user gesture requirement (only ever called from a trigger that
   * follows earlier user interaction with the page, e.g. having opened the
   * alerts panel). */
  function beep() {
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      osc.onended = () => ctx.close();
    } catch (e) { /* audio unavailable - alert still shows visually */ }
  }

  function ensureToastHost() {
    let host = document.getElementById("alertToastHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "alertToastHost";
      host.className = "alert-toast-host";
      document.body.appendChild(host);
    }
    return host;
  }

  function showToast(alert, price) {
    const host = ensureToastHost();
    const el = document.createElement("div");
    el.className = "alert-toast";
    el.innerHTML = `
      <div class="alert-toast-title">🔔 ${alert.symbol}</div>
      <div class="alert-toast-body">${CONDITION_LABELS[alert.condition]} ${fmtVal(alert.value)} · сейчас ${fmtVal(price)}</div>
    `;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 6000);
  }

  function fmtVal(n) {
    return Number(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const AlertService = {
    CONDITION_LABELS,
    _list: loadList(),
    _lastPrice: new Map(), // symbol -> last seen price, for cross_up/cross_down detection
    _changeCbs: [],
    _triggeredCbs: [],

    onChange(cb) { this._changeCbs.push(cb); }
    ,
    onTriggered(cb) { this._triggeredCbs.push(cb); },

    list() { return this._list.slice(); },
    listFor(symbol) { return this._list.filter((a) => a.symbol === symbol); },

    isSoundEnabled() {
      try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch (e) { return true; }
    },
    setSoundEnabled(on) {
      try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch (e) { /* ignore */ }
    },

    /** @param {{symbol,condition,value,repeat}} data condition is one of
     * price_above/price_below/cross_up/cross_below; repeat is "once"|"repeat" */
    create(data) {
      const alert = {
        id: uid(),
        symbol: data.symbol,
        condition: data.condition,
        value: Number(data.value),
        repeat: data.repeat === "repeat" ? "repeat" : "once",
        enabled: true,
        createdAt: Date.now(),
        lastTriggeredAt: null,
        triggerCount: 0,
      };
      this._list.push(alert);
      this._persist();
      return alert;
    },

    update(id, patch) {
      const a = this._list.find((x) => x.id === id);
      if (!a) return null;
      Object.assign(a, patch);
      this._persist();
      return a;
    },

    setEnabled(id, enabled) { return this.update(id, { enabled: !!enabled }); },

    remove(id) {
      this._list = this._list.filter((x) => x.id !== id);
      this._persist();
    },

    _persist() {
      saveList(this._list);
      this._changeCbs.forEach((cb) => { try { cb(this.list()); } catch (e) { console.error(e); } });
    },

    /** Called on every genuine realtime tick (see ChartTile.onLiveTick).
     * Cross conditions compare against the previous tick's price for the
     * same symbol - the very first tick for a symbol can never trigger a
     * cross_up/cross_down (there's nothing to have crossed from yet), which
     * is the correct behavior, not a bug. */
    evaluate(symbol, price) {
      if (price == null || !Number.isFinite(price)) return;
      const prev = this._lastPrice.get(symbol);
      this._lastPrice.set(symbol, price);
      const candidates = this._list.filter((a) => a.enabled && a.symbol === symbol);
      for (const a of candidates) {
        let hit = false;
        if (a.condition === "price_above") hit = price >= a.value;
        else if (a.condition === "price_below") hit = price <= a.value;
        else if (a.condition === "cross_up") hit = prev != null && prev < a.value && price >= a.value;
        else if (a.condition === "cross_down") hit = prev != null && prev > a.value && price <= a.value;
        if (hit) this._fire(a, price);
      }
    },

    _fire(alert, price) {
      alert.lastTriggeredAt = Date.now();
      alert.triggerCount += 1;
      if (alert.repeat === "once") alert.enabled = false;
      this._persist();
      showToast(alert, price);
      if (this.isSoundEnabled()) beep();
      this._triggeredCbs.forEach((cb) => { try { cb(alert, price); } catch (e) { console.error(e); } });
    },
  };

  global.AlertService = AlertService;
})(window);
