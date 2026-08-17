/* Right-hand ticker watchlist for the "Анализ графиков" workspace, in the
 * spirit of a TradingView watchlist. Loads the real MOEX board catalog
 * (/api/securities) and last-price/change (/api/market/prices) each with a
 * single batched request - never one request per row. Favorites and custom
 * lists persist in localStorage (no accounts/DB in this single-user app, so
 * that is the real, working store - not a stub). Purely a picker: it never
 * owns chart state, it just reports ticker clicks to whoever constructed it
 * (the single chart page today, an active tile once multi-chart layouts
 * land).
 *
 * Stage 11 additions: absolute-change column + sortable columns, custom
 * lists (beyond the fixed Все/Избранное/Портфель tabs), a right-click
 * context menu for add/remove/favorite, a windowed/virtualized row
 * renderer (only the visible slice of a long list is ever in the DOM), and
 * an instrument-info panel for whichever ticker is currently active. */
(function (global) {
  "use strict";

  const FAVORITES_KEY = "moexlab_watchlist_favorites";
  const CUSTOM_LISTS_KEY = "moexlab_watchlist_custom_lists";
  const PRICE_REFRESH_MS = 30000;
  const ROW_HEIGHT = 40;
  const ROW_BUFFER = 8;
  const SECURITIES_DEDUP_MS = 5000;

  /** Shared across every consumer of the securities catalog on this page
   * (this sidebar and chart-analysis.js's own _loadSecurities both load on
   * the charts tab at the same moment) - an in-flight-request dedup, same
   * pattern as fetchRealtimeShared in realtime-indicator.js and
   * fetchCandlesShared in chart-engine/core.js, so two modules opening the
   * charts tab together never cost two /api/securities round trips.
   * Exposed on `global` because this file loads before chart-analysis.js
   * (see templates/index.html's script order) and there's no shared module
   * scope between the two otherwise. */
  function fetchSecuritiesShared() {
    const now = Date.now();
    const cached = global.__moexSecuritiesCache;
    if (cached && now - cached.ts < SECURITIES_DEDUP_MS) return cached.promise;
    const promise = fetch("/api/securities").then((r) => r.json());
    global.__moexSecuritiesCache = { promise, ts: now };
    promise.catch(() => { global.__moexSecuritiesCache = null; });
    return promise;
  }
  global.fetchSecuritiesShared = fetchSecuritiesShared;

  function loadSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch (e) { return new Set(); }
  }
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) { /* localStorage unavailable - just won't persist */ }
  }
  function loadCustomLists() {
    try {
      const raw = JSON.parse(localStorage.getItem(CUSTOM_LISTS_KEY) || "{}");
      const out = {};
      Object.keys(raw).forEach((name) => (out[name] = new Set(raw[name])));
      return out;
    } catch (e) { return {}; }
  }
  function saveCustomLists(lists) {
    try {
      const plain = {};
      Object.keys(lists).forEach((name) => (plain[name] = [...lists[name]]));
      localStorage.setItem(CUSTOM_LISTS_KEY, JSON.stringify(plain));
    } catch (e) { /* ignore */ }
  }

  function fmtMoney(n) {
    return n == null ? "—" : Number(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  class WatchlistSidebar {
    constructor(container, { onSelect, collapsed, mobileBackdrop } = {}) {
      this.container = container;
      this.mobileBackdrop = mobileBackdrop || null;
      this.onSelect = onSelect || (() => {});
      this.securities = [];
      this.prices = {};
      this.favorites = loadSet(FAVORITES_KEY);
      this.customLists = loadCustomLists();
      this.activeTicker = null;
      this.tab = "all";
      this.query = "";
      this.sort = { key: null, dir: 1 };
      this.portfolioTickers = null;
      this._searchDebounce = null;
      this._currentList = [];
      this._infoCache = new Map();
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
        <nav class="wl-tabs" id="wlTabs"></nav>
        <div class="wl-col-headers" id="wlColHeaders">
          <span class="wl-col-ticker" data-sort="ticker">Тикер</span>
          <span class="wl-col-num" data-sort="last">Цена</span>
          <span class="wl-col-num" data-sort="abs">Δ</span>
          <span class="wl-col-num" data-sort="pct">Δ%</span>
        </div>
        <div class="wl-list-viewport" id="wlListViewport">
          <div class="wl-list-spacer" id="wlSpacer">
            <div class="wl-list-rows" id="wlRows"></div>
          </div>
        </div>
        <div class="wl-info-panel" id="wlInfo"></div>
        <div class="wl-context-menu hidden" id="wlContextMenu"></div>
      `;
      this.container.querySelector("#wlSearch").oninput = (e) => {
        clearTimeout(this._searchDebounce);
        const value = e.target.value;
        this._searchDebounce = setTimeout(() => { this.query = value.trim().toUpperCase(); this._render(); }, 250);
      };
      this.container.querySelector("#wlCollapseBtn").onclick = () => this.setCollapsed(!this.container.classList.contains("wl-collapsed"));
      this._renderTabs();
      this.container.querySelectorAll("#wlColHeaders [data-sort]").forEach((el) => {
        el.onclick = () => {
          const key = el.dataset.sort;
          this.sort = this.sort.key === key ? { key, dir: -this.sort.dir } : { key, dir: 1 };
          this._syncSortHeaders();
          this._render();
        };
      });
      const viewport = this.container.querySelector("#wlListViewport");
      viewport.addEventListener("scroll", () => this._renderVisibleRows());
      this._resizeObserver = new ResizeObserver(() => this._renderVisibleRows());
      this._resizeObserver.observe(viewport);
      document.addEventListener("click", (e) => {
        const menu = this.container.querySelector("#wlContextMenu");
        if (menu && !menu.contains(e.target)) menu.classList.add("hidden");
      });
    }

    // ---------------------------------------------------------- tabs -----

    _renderTabs() {
      const nav = this.container.querySelector("#wlTabs");
      const fixed = [["all", "Все инструменты"], ["favorites", "Избранное"], ["portfolio", "Портфель"]];
      const customNames = Object.keys(this.customLists);
      nav.innerHTML = `
        ${fixed.map(([id, label]) => `<button class="wl-tab ${this.tab === id ? "active" : ""}" data-wl-tab="${id}">${label}</button>`).join("")}
        ${customNames.map((name) => `<button class="wl-tab ${this.tab === name ? "active" : ""}" data-wl-tab="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}
        <button class="wl-tab wl-tab-add" id="wlAddList" title="Создать список" aria-label="Создать новый список">+</button>
      `;
      nav.querySelectorAll("[data-wl-tab]").forEach((btn) => {
        btn.onclick = () => {
          this.tab = btn.dataset.wlTab;
          this._renderTabs();
          if (this.tab === "portfolio" && this.portfolioTickers === null) this._loadPortfolioTickers().then(() => this._render());
          else this._render();
        };
      });
      nav.querySelector("#wlAddList").onclick = () => {
        const name = prompt("Название нового списка");
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        if (!this.customLists[trimmed]) this.customLists[trimmed] = new Set();
        saveCustomLists(this.customLists);
        this.tab = trimmed;
        this._renderTabs();
        this._render();
      };
    }

    // -------------------------------------------------------- loading ----

    async _loadData() {
      try {
        const [securities, priceData] = await Promise.all([
          fetchSecuritiesShared(),
          fetch("/api/market/prices").then((r) => r.json()),
        ]);
        this.securities = Array.isArray(securities) ? securities : [];
        this.prices = (priceData && priceData.prices) || {};
      } catch (e) {
        this.container.querySelector("#wlRows").innerHTML = `<div class="muted-note">Не удалось загрузить список инструментов Binance.</div>`;
        return;
      }
      this._render();
      // On a cold page load, setActive(symbol) for the restored workspace's
      // tile can fire before this async fetch resolves - the info panel
      // would render once with this.securities still empty and never
      // update, leaving the catalog-derived rows (name/status/stepSize)
      // stuck on "—" forever even though the data is right here now.
      if (this.activeTicker) this._renderInfoPanel();
    }

    refreshPrices() {
      if (!this.securities.length) return;
      fetch("/api/market/prices")
        .then((r) => r.json())
        .then((data) => { this.prices = data.prices || {}; this._render(); })
        .catch(() => {});
    }

    async _loadPortfolioTickers() {
      let id = null;
      try { id = localStorage.getItem("moexlab_active_portfolio"); } catch (e) { /* ignore */ }
      if (!id) { this.portfolioTickers = []; return; }
      try {
        const p = await fetch(`/api/portfolios/${id}`).then((r) => r.json());
        this.portfolioTickers = (p.instruments || []).map((i) => i.ticker);
      } catch (e) { this.portfolioTickers = []; }
    }

    // ----------------------------------------------------- public API ----

    setActive(ticker) {
      this.activeTicker = ticker;
      this._syncActiveRowClasses();
      this._renderInfoPanel();
    }

    setCollapsed(collapsed) {
      this.container.classList.toggle("wl-collapsed", collapsed);
      const btn = this.container.querySelector("#wlCollapseBtn");
      btn.textContent = collapsed ? "«" : "»";
      btn.title = collapsed ? "Развернуть список" : "Свернуть список";
      try { localStorage.setItem("moexlab_watchlist_collapsed", collapsed ? "1" : "0"); } catch (e) { /* ignore */ }
      requestAnimationFrame(() => this._renderVisibleRows());
    }

    openMobileDrawer() {
      this.container.classList.add("wl-mobile-open");
      if (this.mobileBackdrop) this.mobileBackdrop.classList.add("show");
    }
    closeMobileDrawer() {
      this.container.classList.remove("wl-mobile-open");
      if (this.mobileBackdrop) this.mobileBackdrop.classList.remove("show");
    }

    // ------------------------------------------------------- filtering ---

    _visibleSecurities() {
      let list = this.securities;
      if (this.tab === "favorites") list = list.filter((s) => this.favorites.has(s.symbol));
      else if (this.tab === "portfolio") {
        const set = new Set(this.portfolioTickers || []);
        list = list.filter((s) => set.has(s.symbol));
      } else if (this.tab !== "all" && this.customLists[this.tab]) {
        const set = this.customLists[this.tab];
        list = list.filter((s) => set.has(s.symbol));
      }
      if (this.query) {
        list = list.filter((s) => s.symbol.includes(this.query) || String(s.baseAsset || "").toUpperCase().includes(this.query));
      }
      return list;
    }

    _sortedSecurities() {
      const list = this._visibleSecurities().slice();
      const { key, dir } = this.sort;
      if (!key) return list;
      const valueOf = (s) => {
        const q = this.prices[s.symbol];
        if (key === "ticker") return s.symbol;
        if (key === "last") return q ? q.last : null;
        if (key === "abs") return q ? q.change_abs : null;
        if (key === "pct") return q ? q.change_pct : null;
        return null;
      };
      return list.sort((a, b) => {
        const va = valueOf(a), vb = valueOf(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === "string") return va.localeCompare(vb) * dir;
        return (va - vb) * dir;
      });
    }

    _syncSortHeaders() {
      this.container.querySelectorAll("#wlColHeaders [data-sort]").forEach((el) => {
        el.classList.toggle("active", el.dataset.sort === this.sort.key);
        el.classList.toggle("desc", el.dataset.sort === this.sort.key && this.sort.dir === -1);
      });
    }

    // ------------------------------------------------------- rendering ---

    _render() {
      if (!this.securities.length) return; // still loading - keep the spinner note
      const list = this._sortedSecurities();
      this._currentList = list;
      const spacer = this.container.querySelector("#wlSpacer");
      spacer.style.height = list.length ? `${list.length * ROW_HEIGHT}px` : "auto";
      const rowsEl = this.container.querySelector("#wlRows");
      if (!list.length) {
        rowsEl.style.transform = "translateY(0)";
        rowsEl.innerHTML = `<div class="muted-note wl-empty">${
          this.tab === "favorites" ? "Пока нет избранных инструментов." :
          this.tab === "portfolio" ? "В активном портфеле нет инструментов." :
          this.tab !== "all" ? "Список пуст. Добавьте инструмент через правый клик на строке «Все инструменты»." :
          "Ничего не найдено."
        }</div>`;
        return;
      }
      this._renderVisibleRows();
    }

    _renderVisibleRows() {
      const viewport = this.container.querySelector("#wlListViewport");
      const rowsEl = this.container.querySelector("#wlRows");
      const list = this._currentList;
      if (!list.length) return;
      const scrollTop = viewport.scrollTop;
      const viewH = viewport.clientHeight || 400;
      const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_BUFFER);
      const endIdx = Math.min(list.length, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + ROW_BUFFER);
      rowsEl.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;
      rowsEl.innerHTML = list.slice(startIdx, endIdx).map((s) => this._rowHtml(s)).join("");
      this._wireRowEvents(rowsEl);
    }

    _rowHtml(s) {
      const q = this.prices[s.symbol];
      const last = q ? fmtMoney(q.last) : "—";
      const abs = q && q.change_abs != null ? `${q.change_abs >= 0 ? "+" : ""}${fmtMoney(q.change_abs)}` : "—";
      const pct = q && q.change_pct != null ? `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%` : "—";
      const chgClass = q && q.change_pct != null ? (q.change_pct >= 0 ? "pnl-pos" : "pnl-neg") : "";
      const fav = this.favorites.has(s.symbol);
      return `
        <div class="wl-row ${s.symbol === this.activeTicker ? "active" : ""}" data-ticker="${s.symbol}" style="height:${ROW_HEIGHT}px">
          <button class="wl-star ${fav ? "active" : ""}" data-fav="${s.symbol}" title="В избранное" aria-label="В избранное">${fav ? "★" : "☆"}</button>
          <span class="wl-ticker" title="${escapeHtml(s.baseAsset || "")}">${s.symbol}</span>
          <span class="wl-num">${last}</span>
          <span class="wl-num ${chgClass}">${abs}</span>
          <span class="wl-num ${chgClass}">${pct}</span>
        </div>`;
    }

    _wireRowEvents(rowsEl) {
      rowsEl.querySelectorAll(".wl-row[data-ticker]").forEach((row) => {
        row.onclick = (e) => {
          if (e.target.closest(".wl-star")) return;
          this.setActive(row.dataset.ticker);
          this.onSelect(row.dataset.ticker);
          this.closeMobileDrawer();
        };
        row.oncontextmenu = (e) => { e.preventDefault(); this._openContextMenu(e, row.dataset.ticker); };
      });
      rowsEl.querySelectorAll("[data-fav]").forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const t = btn.dataset.fav;
          if (this.favorites.has(t)) this.favorites.delete(t); else this.favorites.add(t);
          saveSet(FAVORITES_KEY, this.favorites);
          if (this.tab === "favorites") this._render();
          else { btn.textContent = this.favorites.has(t) ? "★" : "☆"; btn.classList.toggle("active", this.favorites.has(t)); }
        };
      });
    }

    _syncActiveRowClasses() {
      this.container.querySelectorAll(".wl-row[data-ticker]").forEach((row) => row.classList.toggle("active", row.dataset.ticker === this.activeTicker));
    }

    // ------------------------------------------------------ context menu -

    _openContextMenu(e, ticker) {
      const menu = this.container.querySelector("#wlContextMenu");
      const isFav = this.favorites.has(ticker);
      const customNames = Object.keys(this.customLists);
      menu.innerHTML = `
        <button class="ca-more-item" data-act="open">Открыть на графике</button>
        <button class="ca-more-item" data-act="fav">${isFav ? "Убрать из избранного" : "В избранное"}</button>
        ${customNames.length ? `<div class="ca-more-sep"></div><div class="ca-more-heading">Списки</div>` : ""}
        ${customNames.map((name) => {
          const inList = this.customLists[name].has(ticker);
          return `<button class="ca-more-item" data-act="list" data-list="${escapeHtml(name)}">${inList ? "✓ " : "+ "}${escapeHtml(name)}</button>`;
        }).join("")}
      `;
      menu.querySelector('[data-act="open"]').onclick = () => { this.setActive(ticker); this.onSelect(ticker); menu.classList.add("hidden"); };
      menu.querySelector('[data-act="fav"]').onclick = () => {
        if (isFav) this.favorites.delete(ticker); else this.favorites.add(ticker);
        saveSet(FAVORITES_KEY, this.favorites);
        this._render();
        menu.classList.add("hidden");
      };
      menu.querySelectorAll('[data-act="list"]').forEach((btn) => {
        btn.onclick = () => {
          const name = btn.dataset.list;
          const set = this.customLists[name];
          if (set.has(ticker)) set.delete(ticker); else set.add(ticker);
          saveCustomLists(this.customLists);
          this._render();
          menu.classList.add("hidden");
        };
      });
      menu.classList.remove("hidden");
      const maxX = this.container.getBoundingClientRect().width - 20;
      const localX = Math.min(e.clientX - this.container.getBoundingClientRect().left, maxX - 180);
      const localY = e.clientY - this.container.getBoundingClientRect().top;
      menu.style.left = `${Math.max(4, localX)}px`;
      menu.style.top = `${localY}px`;
    }

    // -------------------------------------------------- instrument info --

    async _renderInfoPanel() {
      const panel = this.container.querySelector("#wlInfo");
      if (!panel) return;
      if (!this.activeTicker || this.container.classList.contains("wl-collapsed")) { panel.innerHTML = ""; return; }
      const ticker = this.activeTicker;
      panel.innerHTML = `<div class="muted-note wl-info-loading">Загрузка сведений…</div>`;
      let info = this._infoCache.get(ticker);
      if (!info || Date.now() - info._fetchedAt > 30000) {
        try {
          info = await fetch(`/api/securities/${encodeURIComponent(ticker)}/info`).then((r) => r.json());
          info._fetchedAt = Date.now();
          this._infoCache.set(ticker, info);
        } catch (e) {
          panel.innerHTML = `<div class="muted-note">Не удалось загрузить сведения об инструменте.</div>`;
          return;
        }
      }
      if (this.activeTicker !== ticker) return; // user switched away while this was loading
      if (info.error) { panel.innerHTML = `<div class="muted-note">${escapeHtml(info.error)}</div>`; return; }
      // get_instrument_info() (market_ticker.py) only returns 24hr-ticker +
      // history-coverage fields - it never had name/board_title/lot_size/
      // lot_value/currency/trading_status_label (those were MOEX-era
      // fields removed from the backend during the Binance migration, but
      // this panel kept reading them - every one of those rows silently
      // rendered "—" forever, and "Рынок" was hardcoded to "Акции").
      // The catalog entry (already loaded for search/filter) has the real
      // Binance equivalents.
      const security = this.securities.find((s) => s.symbol === ticker);
      const rows = [
        ["Название", security ? security.baseAsset : null],
        ["Рынок", "Binance Spot"],
        ["Статус", security ? (security.status === "TRADING" ? "Торгуется" : security.status) : null],
        ["Цена", fmtMoney(info.price) + (security && security.quoteAsset ? ` ${security.quoteAsset}` : "")],
        ["Открытие", fmtMoney(info.open)],
        ["Максимум", fmtMoney(info.high)],
        ["Минимум", fmtMoney(info.low)],
        ["Объём", info.volume != null ? Number(info.volume).toLocaleString("ru-RU") : "—"],
        ["Шаг объёма (stepSize)", security ? security.stepSize : null],
        ["История доступна", info.history_from && info.history_to
          ? `${new Date(info.history_from * 1000).toLocaleDateString("ru-RU")} — ${new Date(info.history_to * 1000).toLocaleDateString("ru-RU")}`
          : "нет загруженных данных"],
      ];
      panel.innerHTML = `
        <div class="wl-info-title">${escapeHtml(ticker)}</div>
        ${rows.map(([k, v]) => `<div class="wl-info-row"><span class="muted">${k}</span><span>${v != null ? escapeHtml(String(v)) : "—"}</span></div>`).join("")}
      `;
    }

    destroy() {
      clearTimeout(this._searchDebounce);
      clearInterval(this._priceInterval);
      if (this._resizeObserver) this._resizeObserver.disconnect();
    }
  }

  global.WatchlistSidebar = WatchlistSidebar;
})(window);
