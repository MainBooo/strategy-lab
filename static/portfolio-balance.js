/* Compact "portfolio balance" widget in the global header. There is no
 * live/paper-trading account anywhere in this app - only portfolio configs
 * (portfolio_store.py) and the results of individual backtest runs
 * (backtests_db.py, computed by portfolio_engine.simulate_portfolio). So
 * "balance" here is exactly what /api/portfolios/<id>/summary reports: the
 * ending equity of the most recently completed backtest run for the
 * currently active portfolio - never a fabricated live number. It stays in
 * sync with the active-portfolio convention already used elsewhere
 * (localStorage "moexlab_active_portfolio", see app.js). */
(function () {
  "use strict";

  const el = document.getElementById("portfolioBalanceWidget");
  if (!el) return;

  let expanded = false;
  let lastData = null;
  let lastRequestedId = null;

  function activePortfolioId() {
    try {
      return localStorage.getItem("moexlab_active_portfolio");
    } catch (e) {
      return null;
    }
  }

  function fmtMoney(n) {
    if (n == null) return "—";
    return Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + " ₽";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function render() {
    const id = activePortfolioId();
    if (!id) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    el.classList.remove("hidden");
    if (!lastData || lastData.portfolio_id !== id) {
      el.innerHTML = `<div class="pb-loading">Портфель…</div>`;
      return;
    }
    if (!lastData.has_run) {
      el.innerHTML = `
        <div class="pb-summary pb-static">
          <div class="pb-label">${escapeHtml(lastData.portfolio_name || "Портфель")}</div>
          <div class="pb-empty">Бэктест ещё не запускался</div>
        </div>`;
      return;
    }
    const profit = lastData.profit || 0;
    const pct = lastData.return_percent || 0;
    // Both the money and percent deltas take their sign from `profit` alone
    // (not each formatted independently) so a tiny loss that rounds to
    // "0.00%" still reads as "-0.00%" next to a negative ruble amount,
    // rather than the two disagreeing.
    const positive = profit >= 0;
    const sign = positive ? "+" : "-";
    const pnlClass = positive ? "pnl-pos" : "pnl-neg";
    el.innerHTML = `
      <button class="pb-summary" id="pbToggle" aria-expanded="${expanded}" title="Показать детали">
        <div class="pb-label">${escapeHtml(lastData.portfolio_name || "Портфель")}</div>
        <div class="pb-value">${fmtMoney(lastData.final_capital)}</div>
        <div class="pb-change ${pnlClass}">${sign}${fmtMoney(Math.abs(profit))} · ${sign}${Math.abs(pct).toFixed(2)}%</div>
      </button>
      <div class="pb-detail ${expanded ? "" : "hidden"}" id="pbDetail">
        <div><span>Начальный капитал</span><strong>${fmtMoney(lastData.initial_capital)}</strong></div>
        <div><span>Итоговый капитал</span><strong>${fmtMoney(lastData.final_capital)}</strong></div>
        <div><span>Результат</span><strong class="${pnlClass}">${sign}${fmtMoney(Math.abs(profit))}</strong></div>
        <div><span>Доходность</span><strong class="${pnlClass}">${sign}${Math.abs(pct).toFixed(2)}%</strong></div>
        <div><span>Просадка</span><strong>${lastData.max_drawdown != null ? "-" + Math.abs(lastData.max_drawdown).toFixed(2) + "%" : "—"}</strong></div>
        <div><span>Сделок</span><strong>${lastData.trades_count ?? "—"}</strong></div>
        <div><span>Период теста</span><strong>${lastData.date_from || "—"} – ${lastData.date_to || "—"}</strong></div>
      </div>
    `;
    const toggle = document.getElementById("pbToggle");
    if (toggle) toggle.onclick = () => { expanded = !expanded; render(); };
  }

  async function refresh() {
    const id = activePortfolioId();
    if (!id) {
      lastData = null;
      render();
      return;
    }
    lastRequestedId = id;
    try {
      const data = await fetch(`/api/portfolios/${id}/summary`).then((r) => r.json());
      if (lastRequestedId !== id || activePortfolioId() !== id) return; // portfolio switched mid-flight
      lastData = data;
    } catch (e) {
      lastData = null;
    }
    render();
  }

  window.refreshPortfolioBalance = refresh;
  render();
  refresh();
  setInterval(refresh, 60000);
})();
