/* Historical candle storage management modal ("Хранилище данных").
 * Talks to the centralized SQLite candle store added in market_data_store.py
 * via /api/market-data/instruments (per-symbol/timeframe coverage) and
 * /api/market-data/sync (job-based bulk download, reusing the same
 * JobStore/poll pattern as portfolio build/backtest jobs elsewhere in this
 * app - see resumeBuildJob()/pollBuildJob() in app.js for the sibling
 * implementation this one mirrors). Not a stub: every button here drives a
 * real Binance download job with real progress. */
(function (global) {
  "use strict";

  const JOB_KEY = "moexlab_market_data_job";
  const NATIVE_TF_LABELS = {
    "1m": "1м", "3m": "3м", "5m": "5м", "15m": "15м", "30m": "30м",
    "1h": "1ч", "2h": "2ч", "4h": "4ч", "1d": "1д", "1w": "1н", "1mo": "1мес",
  };

  function fmtTime(unixSeconds) {
    if (!unixSeconds) return "—";
    const d = new Date(unixSeconds * 1000);
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function fmtCount(n) {
    if (!n) return "0";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  class MarketDataManager {
    constructor(container) {
      this.container = container;
      this.items = [];
      this.nativeTimeframes = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1mo"];
      this.query = "";
      this.selected = new Set();
      this.selectedTimeframes = new Set(["5m", "1d"]);
      this.mode = "initial";
      this.jobId = null;
      this._pollTimer = null;
      this._searchDebounce = null;
      this._build();
    }

    _build() {
      this.container.innerHTML = `
        <div class="mdm-backdrop" id="mdmBackdrop"></div>
        <div class="mdm-modal" role="dialog" aria-modal="true" aria-label="Хранилище исторических данных">
          <div class="mdm-head">
            <h3>Хранилище исторических данных</h3>
            <button class="icon-btn" id="mdmClose" aria-label="Закрыть" title="Закрыть">✕</button>
          </div>
          <div class="mdm-body">
            <div class="mdm-controls">
              <input type="search" id="mdmSearch" placeholder="Тикер или название…" aria-label="Поиск инструмента">
              <div class="mdm-tf-picker" role="group" aria-label="Таймфреймы для загрузки">
                ${this.nativeTimeframes.map(tf => `
                  <label class="mdm-tf-chip">
                    <input type="checkbox" data-tf="${tf}" ${this.selectedTimeframes.has(tf) ? "checked" : ""}>
                    <span>${NATIVE_TF_LABELS[tf]}</span>
                  </label>`).join("")}
              </div>
              <div class="mdm-mode">
                <label><input type="radio" name="mdmMode" value="initial" checked> Загрузить историю</label>
                <label><input type="radio" name="mdmMode" value="continue"> Обновить (докачать новое)</label>
              </div>
              <div class="mdm-actions">
                <button class="secondary" id="mdmSelectAll">Выбрать все видимые</button>
                <button class="secondary" id="mdmSelectNone">Снять выбор</button>
                <button class="primary" id="mdmStart" disabled>Загрузить (<span id="mdmSelCount">0</span>)</button>
                <button class="danger hidden" id="mdmStop">Остановить</button>
              </div>
            </div>
            <div class="mdm-progress hidden" id="mdmProgress">
              <div class="mdm-progress-bar"><div class="mdm-progress-fill" id="mdmProgressFill" style="width:0%"></div></div>
              <div class="mdm-progress-row">
                <span id="mdmProgressStage">—</span>
                <span id="mdmProgressCounts">0 / 0</span>
              </div>
            </div>
            <div class="mdm-list" id="mdmList"><div class="muted-note">Загрузка списка инструментов…</div></div>
          </div>
        </div>
      `;
      this.container.querySelector("#mdmClose").onclick = () => this.close();
      this.container.querySelector("#mdmBackdrop").onclick = () => this.close();
      this.container.querySelector("#mdmSearch").oninput = (e) => {
        clearTimeout(this._searchDebounce);
        const value = e.target.value;
        this._searchDebounce = setTimeout(() => { this.query = value.trim().toUpperCase(); this._loadItems(); }, 250);
      };
      this.container.querySelectorAll(".mdm-tf-chip input").forEach((cb) => {
        cb.onchange = () => {
          if (cb.checked) this.selectedTimeframes.add(cb.dataset.tf);
          else this.selectedTimeframes.delete(cb.dataset.tf);
        };
      });
      this.container.querySelectorAll('input[name="mdmMode"]').forEach((r) => {
        r.onchange = () => { if (r.checked) this.mode = r.value; };
      });
      this.container.querySelector("#mdmSelectAll").onclick = () => {
        this.items.forEach((it) => this.selected.add(it.symbol));
        this._renderList(); this._updateActions();
      };
      this.container.querySelector("#mdmSelectNone").onclick = () => {
        this.selected.clear(); this._renderList(); this._updateActions();
      };
      this.container.querySelector("#mdmStart").onclick = () => this._start();
      this.container.querySelector("#mdmStop").onclick = () => this._stop();
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.container.classList.contains("mdm-open")) this.close();
      });
    }

    open() {
      this.container.classList.add("mdm-open");
      this._loadItems();
      this._resumeJobIfAny();
    }
    close() { this.container.classList.remove("mdm-open"); }

    async _loadItems() {
      try {
        const params = new URLSearchParams(); if (this.query) params.set("q", this.query);
        const r = await fetch(`/api/market-data/instruments?${params}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Ошибка загрузки списка");
        this.items = data.items || [];
        this.nativeTimeframes = data.native_timeframes || this.nativeTimeframes;
        this._renderList();
      } catch (e) {
        this.container.querySelector("#mdmList").innerHTML = `<div class="muted-note">Ошибка: ${e.message}</div>`;
      }
    }

    _renderList() {
      const list = this.container.querySelector("#mdmList");
      if (!this.items.length) { list.innerHTML = `<div class="muted-note">Ничего не найдено</div>`; return; }
      list.innerHTML = this.items.map((it) => {
        const tfBadges = this.nativeTimeframes.map((tf) => {
          const cov = it.timeframes[tf];
          if (!cov || !cov.candle_count) return `<span class="mdm-tf-badge mdm-tf-empty">${NATIVE_TF_LABELS[tf]}</span>`;
          const cls = cov.status === "failed" ? "mdm-tf-failed" : cov.status === "running" ? "mdm-tf-running" : "mdm-tf-ok";
          return `<span class="mdm-tf-badge ${cls}" title="${fmtCount(cov.candle_count)} свечей, ${fmtTime(cov.earliest_ts)} — ${fmtTime(cov.latest_ts)}">${NATIVE_TF_LABELS[tf]} · ${fmtCount(cov.candle_count)}</span>`;
        }).join("");
        return `
          <div class="mdm-row">
            <label class="mdm-row-check">
              <input type="checkbox" data-ticker="${it.symbol}" ${this.selected.has(it.symbol) ? "checked" : ""}>
            </label>
            <div class="mdm-row-main">
              <div class="mdm-row-title"><strong>${it.symbol}</strong><span class="muted">${it.base || ""}</span></div>
              <div class="mdm-row-badges">${tfBadges}</div>
            </div>
            <div class="mdm-row-updated">${it.last_synced_at ? fmtTime(it.last_synced_at) : "не загружено"}</div>
          </div>`;
      }).join("");
      list.querySelectorAll('input[type="checkbox"][data-ticker]').forEach((cb) => {
        cb.onchange = () => {
          if (cb.checked) this.selected.add(cb.dataset.ticker); else this.selected.delete(cb.dataset.ticker);
          this._updateActions();
        };
      });
    }

    _updateActions() {
      this.container.querySelector("#mdmSelCount").textContent = String(this.selected.size);
      this.container.querySelector("#mdmStart").disabled = this.selected.size === 0;
    }

    async _start() {
      if (!this.selected.size) return;
      const timeframes = [...this.selectedTimeframes];
      if (!timeframes.length) { alert("Выберите хотя бы один таймфрейм"); return; }
      const btn = this.container.querySelector("#mdmStart");
      btn.disabled = true; btn.classList.add("is-loading");
      try {
        const r = await fetch("/api/market-data/sync", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: [...this.selected], timeframes, mode: this.mode }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Не удалось запустить загрузку");
        this.jobId = data.job_id;
        localStorage.setItem(JOB_KEY, JSON.stringify({ jobId: this.jobId }));
        this._showProgress(true);
        this._poll();
      } catch (e) {
        alert(`Ошибка: ${e.message}`);
        btn.disabled = false;
      } finally {
        btn.classList.remove("is-loading");
      }
    }

    async _stop() {
      if (!this.jobId) return;
      try { await fetch(`/api/jobs/${this.jobId}/cancel`, { method: "POST" }); } catch (e) { /* poll loop will surface the real state */ }
    }

    _showProgress(show) {
      this.container.querySelector("#mdmProgress").classList.toggle("hidden", !show);
      this.container.querySelector("#mdmStop").classList.toggle("hidden", !show);
    }

    _resumeJobIfAny() {
      const raw = localStorage.getItem(JOB_KEY);
      if (!raw) return;
      try {
        const { jobId } = JSON.parse(raw);
        if (jobId) { this.jobId = jobId; this._showProgress(true); this._poll(); }
      } catch (e) { localStorage.removeItem(JOB_KEY); }
    }

    _renderProgress(job) {
      this.container.querySelector("#mdmProgressFill").style.width = `${job.percent || 0}%`;
      this.container.querySelector("#mdmProgressStage").textContent = job.stage || "—";
      this.container.querySelector("#mdmProgressCounts").textContent = `${job.completed || 0} / ${job.total || 0}`;
    }

    _poll() {
      if (this._pollTimer) clearTimeout(this._pollTimer);
      const tick = async () => {
        const ctrl = new AbortController(); const abortT = setTimeout(() => ctrl.abort(), 10000);
        try {
          const r = await fetch(`/api/jobs/${this.jobId}`, { signal: ctrl.signal });
          clearTimeout(abortT);
          if (r.status === 404) { this._finish(); return; }
          const job = await r.json();
          this._renderProgress(job);
          if (["completed", "completed_with_errors", "failed", "canceled"].includes(job.status)) {
            this._finish();
            this._loadItems();
            if (job.status === "failed") alert(`Загрузка завершилась с ошибкой: ${job.error?.message || "неизвестная ошибка"}`);
            return;
          }
          this._pollTimer = setTimeout(tick, 1200);
        } catch (e) {
          clearTimeout(abortT);
          this._pollTimer = setTimeout(tick, 2500);
        }
      };
      tick();
    }

    _finish() {
      localStorage.removeItem(JOB_KEY);
      this.jobId = null;
      this._showProgress(false);
      this.container.querySelector("#mdmStart").disabled = this.selected.size === 0;
    }
  }

  global.MarketDataManager = MarketDataManager;
})(window);
