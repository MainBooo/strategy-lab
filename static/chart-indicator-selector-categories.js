/* Categorized checkbox selector for Analysis Charts indicators.
 * Keeps the existing IndicatorManager and settings renderer as the only
 * source of truth; this module changes presentation only.
 */
(function (global) {
  "use strict";

  const Page = global.ChartAnalysisPage;
  const CE = global.ChartEngine;
  const Indicators = CE && CE.Indicators;
  if (!Page || !Indicators) return;

  const CATEGORY_ORDER = ["trend", "volatility", "oscillator", "volume", "levels", "other"];
  const CATEGORY_LABELS = {
    trend: "Трендовые",
    volatility: "Волатильность",
    oscillator: "Осцилляторы",
    volume: "Объём и денежный поток",
    levels: "Уровни и каналы",
    other: "Другие",
  };

  const BASE_CATEGORY = {
    sma: "trend", ema: "trend", wma: "trend", vwap: "trend",
    bollinger: "volatility", donchian: "volatility", atr: "volatility",
    rsi: "oscillator", macd: "oscillator", stochastic: "oscillator", momentum: "oscillator",
    volume: "volume",
  };

  const collapsedCategories = new Set();

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>\"]/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
    }[ch]));
  }

  function categoryOf(def) {
    const raw = def && (def.category || BASE_CATEGORY[def.id]);
    return CATEGORY_LABELS[raw] ? raw : "other";
  }

  function displayName(def) {
    return def.ruName || def.label || def.name || def.shortName || def.id;
  }

  function shortName(def) {
    return def.shortName || def.label || def.name || def.id.toUpperCase();
  }

  function searchText(def) {
    return [def.id, def.label, def.shortName, def.name, def.ruName, ...(def.aliases || [])]
      .filter(Boolean).join(" ").toLowerCase();
  }

  function selectedRow(def, instance) {
    const name = displayName(def);
    return `
      <div class="sl-ind-selected-row" data-ind-search="${escapeHtml(searchText(def))}">
        <label class="sl-ind-check-row">
          <input type="checkbox" data-ind-selected="${escapeHtml(def.id)}" checked>
          <span class="sl-ind-label"><b>${escapeHtml(shortName(def))}</b><small>${escapeHtml(name)}</small></span>
        </label>
        <button class="icon-btn sl-ind-selected-gear" type="button" data-ind-gear="${escapeHtml(instance.id)}" title="Настройки индикатора" aria-label="Настройки ${escapeHtml(name)}">⚙</button>
      </div>
      <div class="ca-ind-settings hidden" data-ind-panel="${escapeHtml(instance.id)}"></div>`;
  }

  function categoryRow(def, active) {
    const name = displayName(def);
    return `
      <label class="sl-ind-check-row sl-ind-catalog-row" data-ind-search="${escapeHtml(searchText(def))}">
        <input type="checkbox" data-ind="${escapeHtml(def.id)}" ${active ? "checked" : ""}>
        <span class="sl-ind-label"><b>${escapeHtml(shortName(def))}</b><small>${escapeHtml(name)}</small></span>
      </label>`;
  }

  function categoryHeader(key, count, collapsed) {
    return `
      <button class="sl-ind-category-toggle" type="button" data-ind-toggle="${key}" aria-expanded="${collapsed ? "false" : "true"}">
        <span class="sl-ind-chevron" aria-hidden="true">›</span>
        <span class="sl-ind-category-name">${escapeHtml(CATEGORY_LABELS[key])}</span>
        <span class="sl-ind-category-count">${count}</span>
      </button>`;
  }

  function installStyles() {
    if (document.getElementById("sl-indicator-categories-style")) return;
    const style = document.createElement("style");
    style.id = "sl-indicator-categories-style";
    style.textContent = `
      #chartsRoot #gtIndicatorsPop.sl-ind-categorized { width:min(390px,calc(100vw - 18px)); max-height:min(72vh,680px); overflow:auto; padding:10px; }
      #chartsRoot .sl-ind-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
      #chartsRoot .sl-ind-head strong { font-size:13px; }
      #chartsRoot .sl-ind-count { color:var(--muted); font-size:11px; white-space:nowrap; }
      #chartsRoot .sl-ind-search { width:100%; height:36px; margin:0 0 9px; padding:0 10px; border:1px solid var(--line); border-radius:7px; background:var(--panel); color:var(--text); outline:none; }
      #chartsRoot .sl-ind-search:focus { border-color:var(--accent); }
      #chartsRoot .sl-ind-selected { margin:0 0 10px; padding:8px; border:1px solid rgba(124,140,255,.28); border-radius:9px; background:rgba(124,140,255,.07); }
      #chartsRoot .sl-ind-section-title { display:flex; align-items:center; justify-content:space-between; margin:0 0 5px; color:var(--muted); font-size:10px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; }
      #chartsRoot .sl-ind-selected-empty { padding:5px 2px; color:var(--muted); font-size:11px; }
      #chartsRoot .sl-ind-selected-row { display:grid; grid-template-columns:minmax(0,1fr) 30px; gap:4px; align-items:center; min-height:36px; }
      #chartsRoot .sl-ind-selected-gear { width:28px!important; min-width:28px!important; height:28px!important; padding:0!important; }
      #chartsRoot .sl-ind-category { margin-top:5px; }
      #chartsRoot .sl-ind-category + .sl-ind-category { border-top:1px solid rgba(255,255,255,.055); }
      #chartsRoot .sl-ind-category-toggle { display:grid; grid-template-columns:18px minmax(0,1fr) auto; align-items:center; gap:6px; width:100%; min-height:36px; padding:6px 3px; border:0; background:transparent; color:var(--muted); text-align:left; cursor:pointer; }
      #chartsRoot .sl-ind-category-toggle:hover { background:rgba(255,255,255,.035); }
      #chartsRoot .sl-ind-chevron { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; font-size:18px; line-height:1; transform:rotate(90deg); transition:transform .14s ease; color:var(--muted); }
      #chartsRoot .sl-ind-category.is-collapsed .sl-ind-chevron { transform:rotate(0deg); }
      #chartsRoot .sl-ind-category-name { font-size:10px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); }
      #chartsRoot .sl-ind-category-count { color:var(--muted); font-size:9px; font-weight:600; }
      #chartsRoot .sl-ind-category-list { display:block; }
      #chartsRoot .sl-ind-category.is-collapsed .sl-ind-category-list { display:none; }
      #chartsRoot .sl-ind-check-row { display:flex!important; flex-direction:row!important; align-items:center!important; justify-content:flex-start!important; gap:9px!important; width:100%; min-height:36px; padding:5px 4px; margin:0; border-radius:6px; cursor:pointer; text-align:left!important; }
      #chartsRoot .sl-ind-check-row:hover { background:rgba(255,255,255,.035); }
      #chartsRoot .sl-ind-check-row input[type=checkbox] { position:static!important; display:block!important; flex:0 0 18px!important; width:18px!important; min-width:18px!important; height:18px!important; margin:0!important; padding:0!important; accent-color:var(--accent); cursor:pointer; }
      #chartsRoot .sl-ind-label { display:flex!important; flex:1 1 auto; flex-direction:column!important; align-items:flex-start!important; justify-content:center!important; min-width:0; line-height:1.15; text-align:left!important; }
      #chartsRoot .sl-ind-label b { display:block; color:var(--text); font-size:11px; font-weight:650; text-align:left; }
      #chartsRoot .sl-ind-label small { display:block; color:var(--muted); font-size:9.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; max-width:100%; }
      #chartsRoot .sl-ind-no-results { padding:14px 4px; color:var(--muted); font-size:11px; text-align:center; }
      @media(max-width:620px){
        #chartsRoot #gtIndicatorsPop.sl-ind-categorized { width:min(330px,calc(100vw - 12px)); max-height:72dvh; padding:8px; }
        #chartsRoot .sl-ind-check-row { min-height:40px; }
        #chartsRoot .sl-ind-category-toggle { min-height:40px; }
        #chartsRoot .sl-ind-label b { font-size:11px; }
        #chartsRoot .sl-ind-label small { font-size:9px; }
      }
    `;
    document.head.appendChild(style);
  }

  Page._renderIndicatorsInto = function (container) {
    const tile = this.activeTile;
    if (!tile || !container) { if (container) container.innerHTML = ""; return; }

    installStyles();
    container.classList.add("sl-ind-categorized");

    const registry = Array.isArray(Indicators.registry) ? Indicators.registry : [];
    const instances = tile.indicatorMgr.list();
    const activeByType = new Map(instances.map((instance) => [instance.type, instance]));
    const grouped = new Map(CATEGORY_ORDER.map((key) => [key, []]));
    registry.forEach((def) => grouped.get(categoryOf(def)).push(def));

    const selectedHtml = instances.map((instance) => {
      const def = registry.find((item) => item.id === instance.type) || {
        id: instance.type, label: instance.type, shortName: instance.type,
      };
      return selectedRow(def, instance);
    }).join("");

    const categoriesHtml = CATEGORY_ORDER.map((key) => {
      const defs = grouped.get(key) || [];
      if (!defs.length) return "";
      const collapsed = collapsedCategories.has(key);
      return `
        <section class="sl-ind-category ${collapsed ? "is-collapsed" : ""}" data-ind-category="${key}">
          ${categoryHeader(key, defs.length, collapsed)}
          <div class="sl-ind-category-list">${defs.map((def) => categoryRow(def, activeByType.has(def.id))).join("")}</div>
        </section>`;
    }).join("");

    container.innerHTML = `
      <div class="sl-ind-head"><strong>Индикаторы и стратегии</strong><span class="sl-ind-count">Активно: ${instances.length}</span></div>
      <input class="sl-ind-search" type="search" placeholder="Поиск индикаторов" aria-label="Поиск индикаторов">
      <section class="sl-ind-selected">
        <div class="sl-ind-section-title"><span>Выбранные</span><span class="sl-ind-category-count">${instances.length}</span></div>
        ${selectedHtml || '<div class="sl-ind-selected-empty">Пока ничего не выбрано</div>'}
      </section>
      <div class="sl-ind-categories">${categoriesHtml}</div>
      <div class="sl-ind-no-results hidden">Ничего не найдено</div>`;

    const rerender = () => {
      this._saveWorkspaceState();
      this._renderIndicatorsInto(container);
    };

    container.querySelectorAll("[data-ind-toggle]").forEach((button) => {
      button.onclick = () => {
        const key = button.dataset.indToggle;
        const section = button.closest(".sl-ind-category");
        if (!section) return;
        const willCollapse = !section.classList.contains("is-collapsed");
        section.classList.toggle("is-collapsed", willCollapse);
        button.setAttribute("aria-expanded", willCollapse ? "false" : "true");
        if (willCollapse) collapsedCategories.add(key);
        else collapsedCategories.delete(key);
      };
    });

    container.querySelectorAll("input[data-ind]").forEach((checkbox) => {
      checkbox.onchange = () => {
        const id = checkbox.dataset.ind;
        if (checkbox.checked) {
          if (!tile.indicatorMgr.list().some((item) => item.type === id)) tile.indicatorMgr.add(id, {});
        } else {
          const existing = tile.indicatorMgr.list().find((item) => item.type === id);
          if (existing) tile.indicatorMgr.remove(existing.id);
        }
        rerender();
      };
    });

    container.querySelectorAll("input[data-ind-selected]").forEach((checkbox) => {
      checkbox.onchange = () => {
        if (checkbox.checked) return;
        const existing = tile.indicatorMgr.list().find((item) => item.type === checkbox.dataset.indSelected);
        if (existing) tile.indicatorMgr.remove(existing.id);
        rerender();
      };
    });

    container.querySelectorAll("[data-ind-gear]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        const panel = container.querySelector(`[data-ind-panel="${button.dataset.indGear}"]`);
        if (!panel) return;
        panel.classList.toggle("hidden");
        if (!panel.classList.contains("hidden") && typeof this._renderIndicatorSettings === "function") {
          this._renderIndicatorSettings(panel, tile, button.dataset.indGear);
        }
      };
    });

    const search = container.querySelector(".sl-ind-search");
    const noResults = container.querySelector(".sl-ind-no-results");
    search.oninput = () => {
      const query = search.value.trim().toLowerCase();
      let visibleCount = 0;
      container.querySelectorAll(".sl-ind-category").forEach((section) => {
        let categoryVisible = 0;
        section.querySelectorAll(".sl-ind-catalog-row").forEach((row) => {
          const visible = !query || (row.dataset.indSearch || "").includes(query);
          row.hidden = !visible;
          if (visible) categoryVisible += 1;
        });
        section.hidden = categoryVisible === 0;
        if (query && categoryVisible > 0) section.classList.remove("is-collapsed");
        else if (!query && collapsedCategories.has(section.dataset.indCategory)) section.classList.add("is-collapsed");
        visibleCount += categoryVisible;
      });
      noResults.classList.toggle("hidden", visibleCount !== 0);
    };
  };
})(window);
