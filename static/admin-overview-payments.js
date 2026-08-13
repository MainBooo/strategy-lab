(function () {
  "use strict";
  const cfg = window.STRATEGY_LAB_ADMIN || {};
  if (cfg.section !== "overview") return;

  async function addPaymentsKpi() {
    const grid = document.querySelector(".admin-kpis");
    if (!grid || grid.querySelector("[data-admin-payments-kpi]")) return false;
    try {
      const data = window.authFetch
        ? await window.authFetch("/api/admin/dashboard")
        : await fetch("/api/admin/dashboard", { credentials: "same-origin" }).then((r) => r.json());
      const item = document.createElement("div");
      item.className = "admin-kpi";
      item.dataset.adminPaymentsKpi = "1";
      item.innerHTML = `<span>Платежи</span><strong>${Number(data.payments || 0).toLocaleString("ru-RU")}</strong>`;
      const moneyCards = Array.from(grid.children).find((el) => /Получено за стратегии/.test(el.textContent || ""));
      grid.insertBefore(item, moneyCards || null);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function init() {
    if (await addPaymentsKpi()) return;
    const root = document.getElementById("adminContent");
    if (!root) return;
    const observer = new MutationObserver(async () => {
      if (await addPaymentsKpi()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
  }
  init();
})();
