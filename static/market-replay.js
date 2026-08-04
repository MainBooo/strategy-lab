/* Market Replay: bar-by-bar historical playback with manual trading.
 * Server (replay_engine.py) is the sole source of truth for what candle
 * data exists, what the current price is, and what state (cash/position/
 * trades) resulted from each action - this file only renders what the
 * server returns and sends step/order/back/goto requests. It never
 * computes P&L or decides what's "revealed" itself, so there is no
 * client-side path that could leak or compute against future data. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const SPEED_OPTIONS = [1, 2, 5, 10, 25, 50, "max"];
  const NATIVE_TIMEFRAMES = ["1m", "10m", "60m", "1d", "1w", "1mo"];
  const TF_LABELS = { "1m": "1 минута", "10m": "10 минут", "60m": "1 час", "1d": "1 день", "1w": "1 неделя", "1mo": "1 месяц" };
  const SESSION_KEY = "moexlab_replay_session_id";
  const BASE_INTERVAL_MS = 700;

  function fmtDateTime(unixSeconds) {
    if (!unixSeconds) return "—";
    const d = new Date(unixSeconds * 1000);
    return d.toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function fmtMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n) + " ₽";
  }
  function pnlClass(n) { return n > 0 ? "pnl-pos" : n < 0 ? "pnl-neg" : ""; }

  const Page = {
    root: null,
    _built: false,
    state: null,
    core: null,
    overlay: null,
    markersHandle: null,
    playing: false,
    _playTimer: null,
    _busy: false,
    securities: [],
    sessions: [],

    init(root) {
      this.root = root;
      if (this._built) { this._refreshSessionList(); return; }
      this._built = true;
      this._build();
      this._loadSecurities();
      this._resumeIfAny();
      document.addEventListener("keydown", (e) => this._onKeydown(e));
    },

    _build() {
      this.root.innerHTML = `
        <div class="mr-setup" id="mrSetup">
          <div class="mr-setup-grid">
            <label>Тикер
              <input type="text" id="mrTicker" list="mrTickerList" placeholder="SBER" autocomplete="off">
              <datalist id="mrTickerList"></datalist>
            </label>
            <label>Площадка
              <input type="text" id="mrBoard" value="TQBR">
            </label>
            <label>Таймфрейм
              <select id="mrTimeframe">${NATIVE_TIMEFRAMES.map((tf) => `<option value="${tf}">${TF_LABELS[tf]}</option>`).join("")}</select>
            </label>
            <label>Дата начала
              <input type="date" id="mrStartDate">
            </label>
            <label>Час
              <input type="number" id="mrStartHour" min="0" max="23" value="10">
            </label>
            <label>Минута
              <input type="number" id="mrStartMinute" min="0" max="59" value="0">
            </label>
            <label>Начальный баланс, ₽
              <input type="number" id="mrBalance" min="1000" step="1000" value="1000000">
            </label>
            <label>Комиссия, % за сторону
              <input type="number" id="mrCommission" min="0" max="5" step="0.01" value="0.05">
            </label>
            <label>Проскальзывание, б.п.
              <input type="number" id="mrSlippage" min="0" max="500" step="1" value="0">
            </label>
            <label>Скорость
              <select id="mrSpeed">${SPEED_OPTIONS.map((s) => `<option value="${s}">${s === "max" ? "Максимум" : s + "×"}</option>`).join("")}</select>
            </label>
          </div>
          <p class="muted-note mr-tick-note">Режим: свечи (минимальный доступный таймфрейм — 1 минута). Исторические тиковые данные MOEX ISS в этой интеграции недоступны — воспроизведение честно идёт по свечам, без имитации тиков.</p>
          <div class="mr-setup-actions">
            <button class="primary" id="mrStart">Запустить воспроизведение</button>
          </div>
          <div class="mr-setup-message" id="mrSetupMessage"></div>
          <div class="mr-sessions" id="mrSessions"></div>
        </div>

        <div class="mr-player hidden" id="mrPlayerRoot">
          <div class="mr-controlbar">
            <div class="mr-cb-left">
              <strong id="mrSymbolLabel">—</strong>
              <span id="mrClock" class="mr-clock">—</span>
              <span class="pill" id="mrStatusPill">Пауза</span>
            </div>
            <div class="mr-cb-right">
              <span id="mrPercent">0%</span>
              <button class="secondary" id="mrNewSession">Новая сессия</button>
              <button class="danger" id="mrDeleteSession">Удалить сессию</button>
            </div>
          </div>
          <div class="mr-layout">
            <div class="mr-chart-col">
              <div class="mr-chart-host" id="mrChartHost"></div>
              <div class="mr-transport">
                <button class="secondary" id="mrRestart" title="Перезапустить (сброс к началу)">⟲ Перезапустить</button>
                <button class="secondary" id="mrStepBack" title="Шаг назад (←)">◀ Назад</button>
                <button class="primary" id="mrPlayPause" title="Play/Pause (пробел)">▶ Играть</button>
                <button class="secondary" id="mrStepFwd" title="Шаг вперёд (→)">Вперёд ▶</button>
                <label class="mr-speed-inline">Скорость
                  <select id="mrSpeedLive">${SPEED_OPTIONS.map((s) => `<option value="${s}">${s === "max" ? "Максимум" : s + "×"}</option>`).join("")}</select>
                </label>
                <button class="secondary" id="mrGotoBtn" title="Перейти к дате">Перейти к дате…</button>
              </div>
              <div class="mr-goto hidden" id="mrGotoPanel">
                <input type="date" id="mrGotoDate"><input type="number" id="mrGotoHour" min="0" max="23" placeholder="Час"><input type="number" id="mrGotoMinute" min="0" max="59" placeholder="Мин">
                <button class="primary" id="mrGotoApply">Перейти</button>
                <button class="secondary" id="mrGotoCancel">Отмена</button>
              </div>
            </div>
            <div class="mr-side-col">
              <div class="mr-card mr-account">
                <div class="mr-account-row"><span>Свободные средства</span><strong id="mrCash">—</strong></div>
                <div class="mr-account-row"><span>Стоимость позиции</span><strong id="mrPosValue">—</strong></div>
                <div class="mr-account-row"><span>Нереализ. P&amp;L</span><strong id="mrUnrealized">—</strong></div>
                <div class="mr-account-row"><span>Реализ. P&amp;L</span><strong id="mrRealized">—</strong></div>
                <div class="mr-account-row mr-account-total"><span>Итого</span><strong id="mrTotal">—</strong></div>
              </div>
              <div class="mr-card mr-position hidden" id="mrPositionCard">
                <h4>Открытая позиция</h4>
                <div id="mrPositionBody"></div>
              </div>
              <div class="mr-card mr-order">
                <h4>Ручная сделка</h4>
                <label>Лоты <input type="number" id="mrLots" min="1" step="1" value="1"></label>
                <label>Stop Loss <input type="number" id="mrStopLoss" step="0.01" placeholder="необязательно"></label>
                <label>Take Profit <input type="number" id="mrTakeProfit" step="0.01" placeholder="необязательно"></label>
                <div class="mr-order-buttons">
                  <button class="mr-buy" id="mrBuy">Buy</button>
                  <button class="mr-sell" id="mrSell">Sell</button>
                  <button class="mr-short" id="mrShort">Short</button>
                  <button class="mr-close" id="mrClose">Close</button>
                </div>
                <div class="mr-order-message" id="mrOrderMessage"></div>
              </div>
              <div class="mr-card mr-trades">
                <h4>Сделки сессии</h4>
                <div id="mrTradesList" class="mr-trades-list"><div class="muted-note">Сделок пока нет</div></div>
              </div>
            </div>
          </div>
        </div>
      `;
      this.root.querySelector("#mrStartDate").value = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      this.root.querySelector("#mrStart").onclick = () => this._startSession();
      this.root.querySelector("#mrNewSession").onclick = () => this._backToSetup();
      this.root.querySelector("#mrDeleteSession").onclick = () => this._deleteSession();
      this.root.querySelector("#mrRestart").onclick = () => this._reset();
      this.root.querySelector("#mrStepBack").onclick = () => this._stepBack();
      this.root.querySelector("#mrStepFwd").onclick = () => this._step();
      this.root.querySelector("#mrPlayPause").onclick = () => this._togglePlay();
      this.root.querySelector("#mrGotoBtn").onclick = () => this.root.querySelector("#mrGotoPanel").classList.toggle("hidden");
      this.root.querySelector("#mrGotoCancel").onclick = () => this.root.querySelector("#mrGotoPanel").classList.add("hidden");
      this.root.querySelector("#mrGotoApply").onclick = () => this._goto();
      this.root.querySelector("#mrSpeedLive").onchange = (e) => this._setSpeed(e.target.value);
      this.root.querySelector("#mrBuy").onclick = () => this._order("buy");
      this.root.querySelector("#mrSell").onclick = () => this._order("sell");
      this.root.querySelector("#mrShort").onclick = () => this._order("short");
      this.root.querySelector("#mrClose").onclick = () => this._order("close");
    },

    async _loadSecurities() {
      try {
        const r = await fetch("/api/securities");
        const data = await r.json();
        this.securities = Array.isArray(data) ? data : [];
        this.root.querySelector("#mrTickerList").innerHTML = this.securities
          .slice(0, 500)
          .map((s) => `<option value="${s.SECID}">${s.SHORTNAME || ""}</option>`).join("");
      } catch (e) { /* datalist just stays empty - typing a ticker manually still works */ }
    },

    async _startSession() {
      const btn = this.root.querySelector("#mrStart");
      const msg = this.root.querySelector("#mrSetupMessage");
      const ticker = this.root.querySelector("#mrTicker").value.trim().toUpperCase();
      if (!ticker) { msg.textContent = "Укажите тикер"; return; }
      const payload = {
        ticker, board: this.root.querySelector("#mrBoard").value.trim() || "TQBR",
        timeframe: this.root.querySelector("#mrTimeframe").value,
        start_date: this.root.querySelector("#mrStartDate").value,
        start_hour: Number(this.root.querySelector("#mrStartHour").value || 10),
        start_minute: Number(this.root.querySelector("#mrStartMinute").value || 0),
        starting_balance: Number(this.root.querySelector("#mrBalance").value || 1000000),
        commission_rate: Number(this.root.querySelector("#mrCommission").value || 0) / 100,
        slippage_bps: Number(this.root.querySelector("#mrSlippage").value || 0),
        speed: Number(this.root.querySelector("#mrSpeed").value || 1),
      };
      btn.disabled = true; msg.textContent = "Запуск…";
      try {
        const r = await fetch("/api/replay/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Не удалось запустить сессию");
        localStorage.setItem(SESSION_KEY, data.session.id);
        this._enterPlayer(data);
      } catch (e) {
        msg.textContent = `Ошибка: ${e.message}`;
      } finally {
        btn.disabled = false;
      }
    },

    async _resumeIfAny() {
      const sid = localStorage.getItem(SESSION_KEY);
      this._refreshSessionList();
      if (!sid) return;
      try {
        const r = await fetch(`/api/replay/sessions/${sid}`);
        if (!r.ok) { localStorage.removeItem(SESSION_KEY); return; }
        const data = await r.json();
        this._enterPlayer(data);
      } catch (e) { /* setup form stays visible - user can start a fresh session */ }
    },

    async _refreshSessionList() {
      try {
        const r = await fetch("/api/replay/sessions");
        this.sessions = await r.json();
        const box = this.root.querySelector("#mrSessions");
        if (!box) return;
        if (!this.sessions.length) { box.innerHTML = ""; return; }
        box.innerHTML = `<h4>Незавершённые сессии</h4>` + this.sessions.slice(0, 8).map((s) => `
          <button class="mr-session-row" data-sid="${s.id}">
            <strong>${s.ticker}</strong> <span class="muted">${TF_LABELS[s.timeframe] || s.timeframe}</span>
            <span class="muted">от ${fmtDateTime(s.start_ts)}</span>
            <span class="muted">${s.reveal_index} баров пройдено</span>
          </button>`).join("");
        box.querySelectorAll(".mr-session-row").forEach((b) => {
          b.onclick = async () => {
            const r2 = await fetch(`/api/replay/sessions/${b.dataset.sid}`);
            if (!r2.ok) return;
            localStorage.setItem(SESSION_KEY, b.dataset.sid);
            this._enterPlayer(await r2.json());
          };
        });
      } catch (e) { /* session list is a convenience, not critical path */ }
    },

    _backToSetup() {
      this._stopPlaying();
      localStorage.removeItem(SESSION_KEY);
      this.state = null;
      this.root.querySelector("#mrPlayerRoot").classList.add("hidden");
      this.root.querySelector("#mrSetup").classList.remove("hidden");
      this._refreshSessionList();
    },

    async _deleteSession() {
      if (!this.state) return;
      if (!confirm("Удалить эту сессию Market Replay безвозвратно?")) return;
      const sid = this.state.session.id;
      this._stopPlaying();
      await fetch(`/api/replay/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
      this._backToSetup();
    },

    _enterPlayer(state) {
      this.root.querySelector("#mrSetup").classList.add("hidden");
      this.root.querySelector("#mrPlayerRoot").classList.remove("hidden");
      this.root.querySelector("#mrSymbolLabel").textContent = `${state.session.ticker} · ${TF_LABELS[state.session.timeframe] || state.session.timeframe}`;
      this.root.querySelector("#mrSpeedLive").value = String(state.session.speed);
      if (!this.core) {
        this.core = new CE.ChartCore(this.root.querySelector("#mrChartHost"), { showVolume: true });
        this.overlay = new CE.Trades.TradeOverlayPrimitive(this.core.chart, this.core.candleSeries);
        this.core.candleSeries.attachPrimitive(this.overlay);
        this.markersHandle = global.LightweightCharts.createSeriesMarkers(this.core.candleSeries, []);
      }
      this._applyState(state);
      this._loadTrades();
    },

    _applyState(state) {
      this.state = state;
      const combined = (state.history || []).concat(state.revealed || []);
      this.core.setCandlesDirect(combined);
      if (combined.length) this.core.fitContent();
      this.root.querySelector("#mrClock").textContent = fmtDateTime(state.current_time);
      this.root.querySelector("#mrPercent").textContent = `${state.percent}% · ${state.reveal_index}/${state.total_available}`;
      this.root.querySelector("#mrStatusPill").textContent = this.playing ? "Воспроизведение" : "Пауза";
      this.root.querySelector("#mrStatusPill").className = `pill ${this.playing ? "status-running" : "status-queued"}`;
      this.root.querySelector("#mrCash").textContent = fmtMoney(state.equity.cash);
      this.root.querySelector("#mrPosValue").textContent = fmtMoney(state.equity.position_value);
      const unrealizedEl = this.root.querySelector("#mrUnrealized");
      unrealizedEl.textContent = fmtMoney(state.equity.unrealized_pnl);
      unrealizedEl.className = pnlClass(state.equity.unrealized_pnl);
      const realizedEl = this.root.querySelector("#mrRealized");
      realizedEl.textContent = fmtMoney(state.equity.realized_pnl);
      realizedEl.className = pnlClass(state.equity.realized_pnl);
      this.root.querySelector("#mrTotal").textContent = fmtMoney(state.equity.total);
      this.root.querySelector("#mrStepBack").disabled = !state.can_step_back;

      const posCard = this.root.querySelector("#mrPositionCard");
      const s = state.session;
      if (s.position_side) {
        posCard.classList.remove("hidden");
        this.root.querySelector("#mrPositionBody").innerHTML = `
          <div class="mr-account-row"><span>Направление</span><strong>${s.position_side === "long" ? "Long" : "Short"}</strong></div>
          <div class="mr-account-row"><span>Лоты</span><strong>${s.position_qty_lots}</strong></div>
          <div class="mr-account-row"><span>Средняя цена</span><strong>${s.position_avg_price != null ? s.position_avg_price.toFixed(2) : "—"}</strong></div>
          <div class="mr-account-row"><span>Stop Loss</span><strong>${s.position_stop_loss ?? "—"}</strong></div>
          <div class="mr-account-row"><span>Take Profit</span><strong>${s.position_take_profit ?? "—"}</strong></div>`;
      } else {
        posCard.classList.add("hidden");
      }
      if (state.finished) this._stopPlaying();
    },

    async _loadTrades() {
      if (!this.state) return;
      try {
        const r = await fetch(`/api/replay/sessions/${this.state.session.id}/trades`);
        const trades = await r.json();
        this._renderTrades(trades);
        this._renderMarkers(trades);
      } catch (e) { /* markers/table just stay stale until the next successful poll */ }
    },

    _renderTrades(trades) {
      const box = this.root.querySelector("#mrTradesList");
      if (!trades.length) { box.innerHTML = `<div class="muted-note">Сделок пока нет</div>`; return; }
      box.innerHTML = trades.slice().reverse().map((t) => `
        <div class="mr-trade-row">
          <span class="mr-trade-side ${t.side === "long" ? "mr-side-long" : "mr-side-short"}">${t.side === "long" ? "Long" : "Short"}</span>
          <span>${t.action}</span>
          <span>${t.qty_lots} лот × ${t.fill_price.toFixed(2)}</span>
          ${t.realized_pnl != null ? `<span class="${pnlClass(t.realized_pnl)}">${fmtMoney(t.realized_pnl)}</span>` : "<span></span>"}
          ${t.exit_reason ? `<span class="mr-exit-reason">${t.exit_reason === "stop" ? "SL" : t.exit_reason === "take" ? "TP" : "вручную"}</span>` : "<span></span>"}
        </div>`).join("");
    },

    _renderMarkers(trades) {
      // Pair sequential fills into display trades (entry->exit) for the
      // shared TradeOverlayPrimitive/marker renderer, which expects one
      // row per completed round trip rather than one row per fill.
      const display = [];
      let open = null;
      for (const t of trades) {
        if (t.action === "open") {
          open = { id: t.id, direction: t.side, entry_time: t.bar_ts, entry_price: t.fill_price, stop_loss: t.stop_loss, take_profit: t.take_profit };
        } else if (t.action === "add" && open) {
          open.stop_loss = t.stop_loss ?? open.stop_loss;
          open.take_profit = t.take_profit ?? open.take_profit;
        } else if ((t.action === "reduce" || t.action === "close") && open) {
          display.push({
            ...open, exit_time: t.bar_ts, exit_price: t.fill_price, exit_reason: t.exit_reason || "manual",
            net_profit: t.realized_pnl, return_percent: null,
          });
          if (t.action === "close") open = null;
        }
      }
      if (open) display.push(open); // still-open position: entry marker only, no exit yet
      this.overlay.setTrades(display);
      this.markersHandle.setMarkers(CE.Trades.buildMarkers(display, { showResultLabels: false, showExits: true }));
    },

    async _step() {
      if (this._busy || !this.state) return;
      this._busy = true;
      try {
        const r = await fetch(`/api/replay/sessions/${this.state.session.id}/step`, { method: "POST" });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        this._applyState(data);
        this._loadTrades();
      } catch (e) {
        this._stopPlaying();
        this._orderMessage(e.message);
      } finally {
        this._busy = false;
      }
    },

    async _stepBack() {
      if (this._busy || !this.state) return;
      this._busy = true;
      this._stopPlaying();
      try {
        const r = await fetch(`/api/replay/sessions/${this.state.session.id}/back`, { method: "POST" });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        this._applyState(data);
        this._loadTrades();
      } catch (e) {
        this._orderMessage(e.message);
      } finally {
        this._busy = false;
      }
    },

    async _reset() {
      if (!this.state) return;
      this._stopPlaying();
      const r = await fetch(`/api/replay/sessions/${this.state.session.id}/reset`, { method: "POST" });
      const data = await r.json();
      if (r.ok) { this._applyState(data); this._loadTrades(); }
    },

    _goto() {
      if (!this.state) return;
      const date = this.root.querySelector("#mrGotoDate").value;
      const hour = Number(this.root.querySelector("#mrGotoHour").value || 0);
      const minute = Number(this.root.querySelector("#mrGotoMinute").value || 0);
      if (!date) return;
      this._stopPlaying();
      fetch(`/api/replay/sessions/${this.state.session.id}/goto`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, hour, minute }),
      }).then((r) => r.json().then((data) => {
        if (data.error) { this._orderMessage(data.error); return; }
        this._applyState(data); this._loadTrades();
        this.root.querySelector("#mrGotoPanel").classList.add("hidden");
      }));
    },

    _setSpeed(value) {
      // Speed only governs the client-side auto-play interval timer; it is
      // not economically meaningful trading-session state, so it is kept
      // purely client-side rather than round-tripped to the backend.
      if (!this.state) return;
      if (this.playing) { this._stopPlaying(); this._startPlaying(); }
    },

    _togglePlay() { this.playing ? this._stopPlaying() : this._startPlaying(); },

    _startPlaying() {
      if (!this.state || this.state.finished) return;
      this.playing = true;
      this.root.querySelector("#mrPlayPause").textContent = "⏸ Пауза";
      this.root.querySelector("#mrStatusPill").textContent = "Воспроизведение";
      this.root.querySelector("#mrStatusPill").className = "pill status-running";
      const speed = this.root.querySelector("#mrSpeedLive").value;
      const interval = speed === "max" ? 20 : Math.max(30, BASE_INTERVAL_MS / Number(speed));
      this._playTimer = setInterval(() => this._step(), interval);
    },

    _stopPlaying() {
      this.playing = false;
      if (this._playTimer) { clearInterval(this._playTimer); this._playTimer = null; }
      const btn = this.root.querySelector("#mrPlayPause");
      if (btn) btn.textContent = "▶ Играть";
      const pill = this.root.querySelector("#mrStatusPill");
      if (pill) { pill.textContent = "Пауза"; pill.className = "pill status-queued"; }
    },

    async _order(action) {
      if (!this.state) return;
      const lots = Number(this.root.querySelector("#mrLots").value || 1);
      const slRaw = this.root.querySelector("#mrStopLoss").value;
      const tpRaw = this.root.querySelector("#mrTakeProfit").value;
      const payload = { action, lots, stop_loss: slRaw === "" ? null : Number(slRaw), take_profit: tpRaw === "" ? null : Number(tpRaw) };
      try {
        const r = await fetch(`/api/replay/sessions/${this.state.session.id}/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        this._applyState(data);
        this._loadTrades();
        this._orderMessage("");
      } catch (e) {
        this._orderMessage(e.message);
      }
    },

    _orderMessage(text) {
      const el = this.root.querySelector("#mrOrderMessage");
      if (el) el.textContent = text || "";
    },

    _onKeydown(e) {
      if (!this.state || this.root.querySelector("#mrPlayerRoot").classList.contains("hidden")) return;
      const tag = (document.activeElement && document.activeElement.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.code === "Space") { e.preventDefault(); this._togglePlay(); }
      else if (e.code === "ArrowRight") { e.preventDefault(); this._step(); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); this._stepBack(); }
    },
  };

  global.MarketReplayPage = Page;
})(window);
