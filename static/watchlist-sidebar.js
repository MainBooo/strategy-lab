/* Right-hand ticker watchlist for the "Анализ графиков" workspace, in the
 * spirit of a TradingView watchlist. Loads the real MOEX board catalog
 * (/api/securities) and last-price/change (/api/market/prices) each with a
 * single batched request - never one request per row. Favorites persist in
 * localStorage (no accounts/DB in this single-user app, so that is the
 * real, working store - not a stub). Purely a picker: it never owns chart
 * state, it just reports ticker clicks to whoever constructed it (the
 * single chart page today, an active tile once multi-chart layouts land). */
(function (global) {
  "use strict";

  const FAVORITES_KEY = "moexlab_watchlist_favorites";
  const PRICE_REFRESH_MS = 30000;

  function loadFavorites() {
    try {
      return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"));
    } catch (e) {
      return new Set();
    }
  }
  function saveFavorites(set) {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...set]));
    } catch (e) {
      /* localStorage unavailable (private mode, quota) - favorites just won't persist */
    }
  }

  class WatchlistSidebar {
    constructor(container, { onSelect, collapsed, mobileBackdrop } = {}) {
      this.container = container;
      this.mobileBackdrop = mobileBackdrop || null;
      this.onSelect = onSelect || (() => {});
      this.securities = [];
      this.prices = {};
      this.favorites = loadFavorites();
      this.activeTicker = null;
      this.tab = "all";
      this.query = "";
      this.portfolioTickers = null;
      this._searchDebounce = null;
      this._build(!!collapsed);
      this._loadData();
      this._priceInterval = setInterval(() => this.refreshPrices(), PRICE_REFRESH_MS);
    }

    _build(collapsed) {
      this.container.classList.toggle("wl-collapsed", collapsed);
      this.container.innerHTML = `
        <div class="wl-header">
          <input type="search" id="wlSearch" placeholder="Тикер или название…" aria-label="Поиск инструмента">
          <button class="icon-btn" id="wlCollapseBtn" title="${collapsed ? "Развернуть список" : "Свернуть список"}" aria-label="Свернуть/развернуть список">${collapsed ? "«" : "»"}</button>
        </div>
        <nav class="wl-tabs">
          <button class="wl-tab active" data-wl-tab="all">Все инструменты</button>
          <button class="wl-tab" data-wl-tab="favorites">Избранное</button>
          <button class="wl-tab" data-wl-tab="portfolio">Портфель</button>
        </nav>
        <div class="wl-list" id="wlList"><div class="muted-note">Загрузка…</div></div>
      `;
      this.container.querySelector("#wlSearch").oninput = (e) => {
        clearTimeout(this._searchDebounce);
        const value = e.target.value;
        this._searchDebounce = setTimeout(() => {
          this.query = value.trim().toUpperCase();
          this._render();
        }, 250);
      };
      this.container.querySelectorAll(".wl-tab").forEach((btn) => {
        btn.onclick = () => {
          this.container.querySelectorAll(".wl-tab").forEach((x) => x.classList.remove("active"));
          btn.classList.add("active");
          this.tab = btn.dataset.wlTab;
          if (this.tab === "portfolio" && this.portfolioTickers === null) this._loadPortfolioTickers().then(() => this._render());
          else this._render();
        };
      });
      this.container.querySelector("#wlCollapseBtn").onclick = () => this.setCollapsed(!this.container.classList.contains("wl-collapsed"));
    }

    async _loadData() {
      try {
        const [securities, priceData] = await Promise.all([
          fetch("/api/securities").then((r) => r.json()),
          fetch("/api/market/prices").then((r) => r.json()),
        ]);
        this.securities = Array.isArray(securities) ? securities : [];
        this.prices = (priceData && priceData.prices) || {};
      } catch (e) {
        this.container.querySelector("#wlList").innerHTML = `<div class="muted-note">Не удалось загрузить список инструментов MOEX.</div>`;
        return;
      }
      this._render();
    }

    refreshPrices() {
      if (!this.securities.length) return;
      fetch("/api/market/prices")
        .then((r) => r.json())
        .then((data) => {
          this.prices = data.prices || {};
          this._render();
        })
        .catch(() => {});
    }

    async _loadPortfolioTickers() {
      let id = null;
      try {
        id = localStorage.getItem("moexlab_active_portfolio");
      } catch (e) { /* ignore */ }
      if (!id) {
        this.portfolioTickers = [];
        return;
      }
      try {
        const p = await fetch(`/api/portfolios/${id}`).then((r) => r.json());
        this.portfolioTickers = (p.instruments || []).map((i) => i.ticker);
      } catch (e) {
        this.portfolioTickers = [];
      }
    }

    setActive(ticker) {
      this.activeTicker = ticker;
      this.container.querySelectorAll(".wl-row").forEach((row) => row.classList.toggle("active", row.dataset.ticker === ticker));
    }

    setCollapsed(collapsed) {
      this.container.classList.toggle("wl-collapsed", collapsed);
      const btn = this.container.querySelector("#wlCollapseBtn");
      btn.textContent = collapsed ? "«" : "»";
      btn.title = collapsed ? "Развернуть список" : "Свернуть список";
      try {
        localStorage.setItem("moexlab_watchlist_collapsed", collapsed ? "1" : "0");
      } catch (e) { /* ignore */ }
    }

    openMobileDrawer() {
      this.container.classList.add("wl-mobile-open");
      if (this.mobileBackdrop) this.mobileBackdrop.classList.add("show");
    }
    closeMobileDrawer() {
      this.container.classList.remove("wl-mobile-open");
      if (this.mobileBackdrop) this.mobileBackdrop.classList.remove("show");
    }

    _visibleSecurities() {
      let list = this.securities;
      if (this.tab === "favorites") list = list.filter((s) => this.favorites.has(s.SECID));
      else if (this.tab === "portfolio") {
        const set = new Set(this.portfolioTickers || []);
        list = list.filter((s) => set.has(s.SECID));
      }
      if (this.query) {
        list = list.filter((s) => s.SECID.includes(this.query) || String(s.SHORTNAME || "").toUpperCase().includes(this.query));
      }
      return list;
    }

    _render() {
      const listEl = this.container.querySelector("#wlList");
      if (!listEl) return;
      const list = this._visibleSecurities();
      if (!this.securities.length) return; // still loading - keep the spinner note
      if (!list.length) {
        listEl.innerHTML = `<div class="muted-note">${
          this.tab === "favorites" ? "Пока нет избранных инструментов." : this.tab === "portfolio" ? "В активном портфеле нет инструментов." : "Ничего не найдено."
        }</div>`;
        return;
      }
      listEl.innerHTML = list
        .map((s) => {
          const q = this.prices[s.SECID];
          const price = q ? fmtMoney(q.last) : "—";
          const chg = q && q.change_pct != null ? q.change_pct : null;
          const chgClass = chg == null ? "" : chg >= 0 ? "pnl-pos" : "pnl-neg";
          const chgText = chg == null ? "" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`;
          const fav = this.favorites.has(s.SECID);
          return `
          <div class="wl-row ${s.SECID === this.activeTicker ? "active" : ""}" data-ticker="${s.SECID}">
            <button class="wl-star ${fav ? "active" : ""}" data-fav="${s.SECID}" title="В избранное" aria-label="В избранное">${fav ? "★" : "☆"}</button>
            <div class="wl-info">
              <div class="wl-ticker">${s.SECID}</div>
              <div class="wl-name">${escapeHtml(s.SHORTNAME || "")}</div>
            </div>
            <div class="wl-price">
              <div class="wl-last">${price}</div>
              <div class="wl-change ${chgClass}">${chgText}</div>
            </div>
          </div>`;
        })
        .join("");
      listEl.querySelectorAll(".wl-row").forEach((row) => {
        row.onclick = (e) => {
          if (e.target.closest(".wl-star")) return;
          this.setActive(row.dataset.ticker);
          this.onSelect(row.dataset.ticker);
          this.closeMobileDrawer();
        };
      });
      listEl.querySelectorAll("[data-fav]").forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const t = btn.dataset.fav;
          if (this.favorites.has(t)) this.favorites.delete(t);
          else this.favorites.add(t);
          saveFavorites(this.favorites);
          if (this.tab === "favorites") this._render();
          else {
            btn.textContent = this.favorites.has(t) ? "★" : "☆";
            btn.classList.toggle("active", this.favorites.has(t));
          }
        };
      });
    }

    destroy() {
      clearTimeout(this._searchDebounce);
      clearInterval(this._priceInterval);
    }
  }

  function fmtMoney(n) {
    return Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₽";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  global.WatchlistSidebar = WatchlistSidebar;
})(window);
