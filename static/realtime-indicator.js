/* Compact realtime/latency indicator shown above a chart tile (see
 * chart-analysis.js). Polls GET /api/market/realtime?ticker=... on a single
 * timer per instance and renders the normalized {source, market_timestamp,
 * delay_ms, status, market_status} block from market_ticker.get_realtime() -
 * the frontend never computes "is this live" itself, it only renders what
 * the backend decided (see docs/DYNAMIC_MARKET_DATA.md, "why backend
 * decides status").
 *
 * One instance = one polled symbol. chart-analysis.js owns exactly one
 * instance per tile and calls setSymbol()/stop() as the active symbol
 * changes or the tile is destroyed - it never polls the 4-6 tiles in a
 * multi-chart layout independently of visibility, and Market Replay never
 * creates one of these at all (its own module, its own "Историческое
 * воспроизведение" label - see market-replay.js), so live and replayed
 * prices can never end up mixed on screen. */
(function (global) {
  "use strict";

  const STATUS_META = {
    delayed: { dot: "●", cls: "rti-delayed", label: (d) => `Данные MOEX · задержка ${fmtDelay(d)}` },
    warning: { dot: "●", cls: "rti-warning", label: (d) => `Данные MOEX · задержка ${fmtDelay(d)}` },
    stale: { dot: "●", cls: "rti-stale", label: (d) => `Устаревшие данные · ${fmtDelay(d)}` },
    disconnected: { dot: "●", cls: "rti-disconnected", label: () => "Источник временно недоступен" },
    market_closed: { dot: "○", cls: "rti-closed", label: (_d, q) => q && q.market_time ? `Рынок закрыт · последняя сделка ${q.market_time}` : "Рынок закрыт" },
    no_trades: { dot: "○", cls: "rti-closed", label: () => "Нет сделок по инструменту" },
    connecting: { dot: "●", cls: "rti-connecting", label: () => "Подключение…" },
    replay: { dot: "◐", cls: "rti-replay", label: () => "Историческое воспроизведение" },
  };

  function fmtDelay(ms) {
    if (ms == null) return "н/д";
    const sec = ms / 1000;
    if (sec < 90) return `${Math.round(sec)} сек.`;
    const min = sec / 60;
    if (min < 90) return `${min.toFixed(min < 10 ? 1 : 0)} мин.`;
    return `${(min / 60).toFixed(1)} ч.`;
  }

  /* Cross-instance dedup: a multi-tile layout can have several
   * RealtimeIndicator instances (one per tile) polling the *same* ticker
   * (two tiles both showing SBER) on independent timers that drift apart
   * slightly. Without this, that's N redundant /api/market/realtime
   * requests per ticker instead of one - see the spec's "дедуплицировать
   * одинаковые подписки". Any poll for a ticker within DEDUP_WINDOW_MS of
   * another poll for the same ticker reuses the in-flight/just-finished
   * fetch instead of starting a new one. */
  const _sharedFetches = new Map(); // ticker -> {promise, ts}
  const DEDUP_WINDOW_MS = 3000;
  function fetchRealtimeShared(ticker) {
    const now = Date.now();
    const cached = _sharedFetches.get(ticker);
    if (cached && now - cached.ts < DEDUP_WINDOW_MS) return cached.promise;
    const promise = fetch(`/api/market/realtime?ticker=${encodeURIComponent(ticker)}`).then((r) => r.json());
    _sharedFetches.set(ticker, { promise, ts: now });
    return promise;
  }

  function fmtClock(iso) {
    if (!iso) return "—";
    try {
      // Backend timestamps are naive-UTC-as-MSK-wall-time (see market_ticker.py) -
      // display as-is rather than letting the browser reinterpret the offset.
      const s = iso.replace("Z", "");
      const t = s.split("T")[1] || s.split(" ")[1] || s;
      return t.slice(0, 8);
    } catch (e) { return iso; }
  }

  class RealtimeIndicator {
    /** @param {HTMLElement} container @param {{compact?:()=>boolean}} [opts] */
    constructor(container, opts) {
      this.container = container;
      this.opts = opts || {};
      this.symbol = null;
      this._timer = null;
      this._pollGen = 0;
      this._lastPayload = null;
      this._visible = true;
      this.container.className = "rt-indicator";
      this.container.innerHTML = `
        <button type="button" class="rt-indicator-btn" id="rtiBtn">
          <span class="rt-dot" id="rtiDot">●</span><span class="rt-label" id="rtiLabel">—</span>
        </button>
        <div class="rt-popover hidden" id="rtiPopover"></div>
      `;
      this._btn = this.container.querySelector("#rtiBtn");
      this._dot = this.container.querySelector("#rtiDot");
      this._label = this.container.querySelector("#rtiLabel");
      this._popover = this.container.querySelector("#rtiPopover");
      this._btn.onclick = () => this._popover.classList.toggle("hidden");
      document.addEventListener("click", (e) => {
        if (!this.container.contains(e.target)) this._popover.classList.add("hidden");
      });
      this._visHandler = () => {
        this._visible = document.visibilityState === "visible";
        if (this._visible) this._poll(); // catch up immediately on return
      };
      document.addEventListener("visibilitychange", this._visHandler);
    }

    /** Switches the polled symbol (aborting any in-flight request for the
     * old one) and polls immediately instead of waiting for the next tick. */
    setSymbol(symbol) {
      if (symbol === this.symbol) return;
      this._pollGen++; // invalidate any in-flight poll for the old symbol
      this.symbol = symbol;
      this._render({ status: "connecting" });
      this._poll();
    }

    start(symbol) {
      const cfg = (global.REALTIME_CONFIG || {});
      if (cfg.enabled === false) { this.container.classList.add("hidden"); return; }
      this.container.classList.remove("hidden");
      this.symbol = symbol;
      this._render({ status: "connecting" });
      this._poll();
      this._scheduleNext();
    }

    /** Market Replay path: no polling, no MOEX calls - just the static
     * "Историческое воспроизведение" label so the indicator never implies
     * live data during a replay session. */
    showReplayMode() {
      this.stop();
      this.container.classList.remove("hidden");
      this._render({ status: "replay" });
    }

    stop() {
      clearTimeout(this._timer);
      this._timer = null;
      this._pollGen++;
      this.symbol = null;
    }

    destroy() {
      this.stop();
      document.removeEventListener("visibilitychange", this._visHandler);
    }

    _scheduleNext() {
      clearTimeout(this._timer);
      const cfg = (global.REALTIME_CONFIG || {});
      const interval = Math.max(5000, cfg.poll_interval_ms || 45000);
      this._timer = setTimeout(() => { this._poll(); this._scheduleNext(); }, interval);
    }

    async _poll() {
      if (!this.symbol || !this._visible) return;
      const symbol = this.symbol;
      const gen = ++this._pollGen;
      try {
        const data = await fetchRealtimeShared(symbol);
        if (gen !== this._pollGen || symbol !== this.symbol) return; // stale by the time it resolved (symbol switched)
        this._lastPayload = data;
        this._render(data);
        if (this.opts.onUpdate) this.opts.onUpdate(data);
      } catch (e) {
        if (gen !== this._pollGen || symbol !== this.symbol) return;
        this._render({ status: "disconnected" });
      }
    }

    _render(data) {
      let status = data.status || "connecting";
      // warning: our own "getting worse than the measured baseline" band
      // inside candle_api's "delayed" classification (see market_ticker.py
      // _classify_status - it never returns "warning" itself, the frontend
      // derives it so the threshold used for color can live in one place:
      // REALTIME_CONFIG, already passed to the backend classifier too).
      const cfg = global.REALTIME_CONFIG || {};
      if (status === "delayed" && data.delay_ms != null && cfg.warning_delay_ms && data.delay_ms >= cfg.warning_delay_ms) {
        status = "warning";
      }
      const meta = STATUS_META[status] || STATUS_META.connecting;
      const compact = this.opts.compact ? this.opts.compact() : false;
      this.container.className = `rt-indicator ${meta.cls}`;
      this._dot.textContent = meta.dot;
      this._label.textContent = compact ? (data.delay_ms != null ? fmtDelay(data.delay_ms) : meta.label(data.delay_ms, data)) : meta.label(data.delay_ms, data);
      this._popover.innerHTML = this._popoverHtml(data, status);
    }

    _popoverHtml(data, status) {
      if (status === "replay") {
        return `<div class="rt-pop-row"><strong>Историческое воспроизведение</strong></div>
                <div class="rt-pop-row muted">Market Replay использует только историю выбранной сессии, без текущих рыночных данных.</div>`;
      }
      const fmtPrice = (n) => (n == null ? null : Number(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      const rows = [
        ["Источник", data.source || "MOEX"],
        ["Тикер", data.ticker || this.symbol || "—"],
        ["Последняя рыночная запись", data.market_time ? `${data.market_time} (МСК)` : "—"],
      ];
      // bid/ask only exist for names with a live order book at the moment of
      // the snapshot - omit the rows entirely rather than show "н/д" for
      // every illiquid ticker, per the source-availability rule in the spec.
      if (data.bid != null) rows.push(["Bid", fmtPrice(data.bid)]);
      if (data.offer != null) rows.push(["Ask", fmtPrice(data.offer)]);
      rows.push(
        ["Получено сервером", fmtClock(data.server_received_at)],
        ["Отображено сейчас", fmtClock(data.response_generated_at)],
        ["Расчётная задержка", data.delay_ms != null ? fmtDelay(data.delay_ms) : "н/д"],
        ["Статус рынка", data.market_status === "open" ? "Открыт" : "Закрыт"],
      );
      if (data.error) rows.push(["Ошибка", data.error]);
      return rows.map(([k, v]) => `<div class="rt-pop-row"><span class="muted">${k}</span><span>${v}</span></div>`).join("");
    }
  }

  global.RealtimeIndicator = RealtimeIndicator;
})(window);
