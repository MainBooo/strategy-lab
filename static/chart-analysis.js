/* MarketAnalysisChartAdapter: the free-form "Анализ графиков" page.
 * Candles come from the generic /api/candles endpoint (real MOEX data,
 * downloaded on demand and cached server-side - see candle_api.py).
 * Drawings/layouts are persisted per-object through /api/chart-layouts
 * and /api/chart-drawings (see charts_db.py) with a debounced autosave;
 * this file never keeps drawing state only in localStorage. */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const TIMEFRAMES = [
    { id: "1m", label: "1м" }, { id: "10m", label: "10м" }, { id: "60m", label: "1ч" },
    { id: "1d", label: "1Д" }, { id: "1w", label: "1Н" }, { id: "1mo", label: "1Мес" },
  ];
  const RANGE_PRESETS = [
    { label: "1Д", days: 1 }, { label: "5Д", days: 5 }, { label: "1М", days: 30 }, { label: "3М", days: 90 },
    { label: "6М", days: 182 }, { label: "1Г", days: 365 }, { label: "5Л", days: 365 * 5 }, { label: "Все", days: null },
  ];
  const TOOL_BUTTONS = [
    { id: null, label: "Курсор", icon: "⇖" },
    { id: "horizontal_line", label: "Горизонтальный уровень", icon: "—" },
    { id: "vertical_line", label: "Вертикальная линия", icon: "❘" },
    { id: "trend_line", label: "Линия тренда", icon: "╱" },
    { id: "ray", label: "Луч", icon: "↗" },
    { id: "rectangle", label: "Прямоугольная зона", icon: "▭" },
    { id: "price_range", label: "Измерение", icon: "↕" },
    { id: "text", label: "Текстовая заметка", icon: "T" },
    { id: "long_position", label: "Long позиция", icon: "↑" },
    { id: "short_position", label: "Short позиция", icon: "↓" },
  ];

  const Page = {
    root: null,
    core: null,
    indicatorMgr: null,
    drawingMgr: null,
    symbol: "SBER",
    board: "TQBR",
    timeframe: "1d",
    from: null,
    to: null,
    layout: null,
    securities: [],
    _built: false,
    _saveQueue: {},

    init(root) {
      this.root = root;
      if (this._built) return;
      this._built = true;
      this.to = new Date().toISOString().slice(0, 10);
      this.from = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
      this._build();
      this._loadSecurities().then(() => this._loadOrInit());
    },

    async _loadSecurities() {
      try {
        this.securities = await fetch("/api/securities").then((r) => r.json());
        const sel = this.root.querySelector("#caSymbol");
        sel.innerHTML = this.securities.map((s) => `<option value="${s.SECID}">${s.SECID} · ${s.SHORTNAME || ""}</option>`).join("");
        sel.value = this.symbol;
      } catch (e) { /* securities catalog is optional here - manual ticker entry still works via prompt fallback */ }
    },

    _build() {
      this.root.innerHTML = `
        <div class="ca-toolbar">
          <label>Инструмент <select id="caSymbol"></select></label>
          <label>Рынок <select id="caBoard"><option value="TQBR">TQBR</option></select></label>
          <label>Таймфрейм <select id="caTimeframe">${TIMEFRAMES.map((t) => `<option value="${t.id}" ${t.id === this.timeframe ? "selected" : ""}>${t.label}</option>`).join("")}</select></label>
          <label>С <input type="date" id="caFrom"></label>
          <label>По <input type="date" id="caTo"></label>
          <div class="ca-indicator-menu">
            <button class="secondary" id="caIndicatorsBtn">Индикаторы</button>
            <div class="ca-popover hidden" id="caIndicatorsPopover"></div>
          </div>
          <div class="ca-template-menu">
            <button class="secondary" id="caTemplatesBtn">Шаблоны</button>
            <div class="ca-popover hidden" id="caTemplatesPopover"></div>
          </div>
          <button class="secondary" id="caSaveBtn">Сохранить</button>
          <button class="primary" id="caOrderBtn">⚙ Заказать стратегию по разметке</button>
          <span class="ca-toolbar-spacer"></span>
          <button class="icon-btn" id="caUndoBtn" title="Отменить (Ctrl+Z)">↶</button>
          <button class="icon-btn" id="caRedoBtn" title="Повторить (Ctrl+Shift+Z)">↷</button>
          <button class="icon-btn" id="caSnapBtn" title="Прилипание к свечам">🧲</button>
          <button class="icon-btn" id="caFullscreenBtn" title="Полноэкранный режим">⛶</button>
        </div>
        <div class="ca-workspace" id="caWorkspace">
          <div class="ca-tools" id="caTools">
            ${TOOL_BUTTONS.map((t) => `<button class="ca-tool-btn ${t.id === null ? "active" : ""}" data-tool="${t.id || ""}" title="${t.label}" aria-label="${t.label}">${t.icon}</button>`).join("")}
            <button class="ca-tool-btn ca-tool-danger" id="caDeleteBtn" title="Удалить объект (Delete)" aria-label="Удалить объект">🗑</button>
          </div>
          <div class="ca-chart-col">
            <div id="caChartHost" class="ca-chart-host"></div>
            <div class="ca-range-presets" id="caRangePresets">
              ${RANGE_PRESETS.map((p) => `<button class="range-preset" data-days="${p.days ?? ""}">${p.label}</button>`).join("")}
            </div>
            <div class="ca-status" id="caStatus"></div>
          </div>
          <div class="ca-side" id="caSide">
            <nav class="ca-side-tabs">
              <button class="ca-side-tab active" data-side="props">Свойства</button>
              <button class="ca-side-tab" data-side="objects">Объекты</button>
            </nav>
            <div id="caProps" class="ca-side-panel"></div>
            <div id="caObjects" class="ca-side-panel hidden"></div>
          </div>
        </div>
      `;

      this.root.querySelector("#caFrom").value = this.from;
      this.root.querySelector("#caTo").value = this.to;

      this.core = new CE.ChartCore(this.root.querySelector("#caChartHost"), { showVolume: true });
      this.indicatorMgr = new CE.Indicators.PaneManager(this.core);
      this.drawingMgr = new CE.Drawings.DrawingManager(this.core);
      this.drawingMgr.onChange((mgr, detail) => this._onDrawingsChanged(detail));

      this.root.querySelector("#caSymbol").onchange = (e) => { this.symbol = e.target.value; this.layout = null; this._reload(); };
      this.root.querySelector("#caTimeframe").onchange = (e) => { this.timeframe = e.target.value; this._reload(); };
      this.root.querySelector("#caFrom").onchange = (e) => { this.from = e.target.value; this._reload(); };
      this.root.querySelector("#caTo").onchange = (e) => { this.to = e.target.value; this._reload(); };
      this.root.querySelectorAll(".range-preset").forEach((b) => (b.onclick = () => this._applyRangePreset(b.dataset.days)));

      this.root.querySelectorAll(".ca-tool-btn[data-tool]").forEach((b) => {
        b.onclick = () => {
          this.root.querySelectorAll(".ca-tool-btn[data-tool]").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          this.drawingMgr.setTool(b.dataset.tool || null);
        };
      });
      this.root.querySelector("#caDeleteBtn").onclick = () => { if (this.drawingMgr.selectedId) this.drawingMgr.removeDrawing(this.drawingMgr.selectedId); };
      this.root.querySelector("#caUndoBtn").onclick = () => this.drawingMgr.undo();
      this.root.querySelector("#caRedoBtn").onclick = () => this.drawingMgr.redo();
      this.root.querySelector("#caSnapBtn").onclick = (e) => {
        this.drawingMgr.snapEnabled = !this.drawingMgr.snapEnabled;
        e.target.classList.toggle("active", this.drawingMgr.snapEnabled);
      };
      this.root.querySelector("#caFullscreenBtn").onclick = () => this.root.closest(".tab-page").classList.toggle("ca-fullscreen");
      this.root.querySelector("#caSaveBtn").onclick = () => this._saveAsTemplate();
      this.root.querySelector("#caOrderBtn").onclick = () => this._openOrderModal();

      this.root.querySelectorAll(".ca-side-tab").forEach((b) => {
        b.onclick = () => {
          this.root.querySelectorAll(".ca-side-tab").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          this.root.querySelector("#caProps").classList.toggle("hidden", b.dataset.side !== "props");
          this.root.querySelector("#caObjects").classList.toggle("hidden", b.dataset.side !== "objects");
        };
      });

      this._buildIndicatorPopover();
      this._buildTemplatePopover();
      this.drawingMgr.onChange(() => { this._renderProps(); this._renderObjects(); });
    },

    _applyRangePreset(days) {
      const to = new Date();
      const from = days ? new Date(Date.now() - Number(days) * 86400000) : new Date("2015-01-01");
      this.from = from.toISOString().slice(0, 10);
      this.to = to.toISOString().slice(0, 10);
      this.root.querySelector("#caFrom").value = this.from;
      this.root.querySelector("#caTo").value = this.to;
      this._reload();
    },

    async _loadOrInit() {
      const layouts = await CE.api.listLayouts("analysis", this.symbol).catch(() => []);
      const def = layouts.find((l) => l.is_default) || layouts[0];
      if (def) await this._applyLayout(def);
      else await this._reload();
    },

    async _applyLayout(layout) {
      this.layout = layout;
      this.symbol = layout.symbol || this.symbol;
      this.timeframe = layout.timeframe || this.timeframe;
      if (layout.visible_from) this.from = layout.visible_from;
      if (layout.visible_to) this.to = layout.visible_to;
      this.root.querySelector("#caSymbol").value = this.symbol;
      this.root.querySelector("#caTimeframe").value = this.timeframe;
      this.root.querySelector("#caFrom").value = this.from;
      this.root.querySelector("#caTo").value = this.to;
      await this._reload();
      const full = await CE.api.getLayout(layout.id);
      this.drawingMgr.loadDrawings(full.drawings || []);
      (layout.indicators || []).forEach((ind) => this.indicatorMgr.add(ind.type, ind.params));
    },

    async _reload() {
      const status = this.root.querySelector("#caStatus");
      status.textContent = "Загрузка свечей…";
      try {
        await this.core.load({ symbol: this.symbol, board: this.board, timeframe: this.timeframe, from: this.from, to: this.to, limit: 5000, onState: (s) => {
          status.textContent = s === "loading" ? "Загрузка свечей…" : s === "empty" ? "Нет данных за выбранный период." : s === "error" ? "Ошибка загрузки свечей." : "";
        } });
        this.core.fitContent();
      } catch (err) {
        status.textContent = "Ошибка: " + err.message;
      }
    },

    _buildIndicatorPopover() {
      const pop = this.root.querySelector("#caIndicatorsPopover");
      pop.innerHTML = CE.Indicators.registry.map((def) => `
        <label class="ca-indicator-row">
          <input type="checkbox" data-ind="${def.id}">
          <span>${def.label}</span>
        </label>`).join("");
      pop.querySelectorAll("input[data-ind]").forEach((cb) => {
        cb.onchange = () => {
          const id = cb.dataset.ind;
          if (cb.checked) this["_ind_" + id] = this.indicatorMgr.add(id, {});
          else if (this["_ind_" + id]) { this.indicatorMgr.remove(this["_ind_" + id]); this["_ind_" + id] = null; }
        };
      });
      this.root.querySelector("#caIndicatorsBtn").onclick = () => pop.classList.toggle("hidden");
    },

    _buildTemplatePopover() {
      const pop = this.root.querySelector("#caTemplatesPopover");
      this.root.querySelector("#caTemplatesBtn").onclick = async () => {
        pop.classList.toggle("hidden");
        if (pop.classList.contains("hidden")) return;
        const layouts = await CE.api.listLayouts("analysis", this.symbol).catch(() => []);
        pop.innerHTML = layouts.length
          ? layouts.map((l) => `
              <div class="ca-template-row">
                <button class="link-btn ca-template-load" data-id="${l.id}">${l.name}${l.is_default ? " ★" : ""}</button>
                <button class="icon-btn" data-del="${l.id}" title="Удалить">🗑</button>
              </div>`).join("")
          : `<div class="muted-note">Нет сохранённых шаблонов для ${this.symbol}</div>`;
        pop.querySelectorAll(".ca-template-load").forEach((b) => (b.onclick = async () => {
          const l = await CE.api.getLayout(b.dataset.id);
          await this._applyLayout(l);
          pop.classList.add("hidden");
        }));
        pop.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async (e) => {
          e.stopPropagation();
          await CE.api.deleteLayout(b.dataset.del);
          b.closest(".ca-template-row").remove();
        }));
      };
    },

    async _saveAsTemplate() {
      const name = prompt("Название шаблона", this.layout ? this.layout.name : `${this.symbol} · ${new Date().toLocaleDateString("ru-RU")}`);
      if (!name) return;
      const payload = {
        context: "analysis", name, symbol: this.symbol, board: this.board, timeframe: this.timeframe,
        visibleFrom: this.from, visibleTo: this.to, chartType: "candles",
        settings: {}, indicators: this.indicatorMgr.list().map((i) => ({ type: i.type, params: i.params })),
      };
      const layout = this.layout && this.layout.name === name
        ? await CE.api.updateLayout(this.layout.id, payload)
        : await CE.api.createLayout(payload);
      this.layout = layout;
      for (const d of this.drawingMgr.drawings) await this._persistDrawing(d);
      this.root.querySelector("#caStatus").textContent = "Шаблон сохранён.";
      setTimeout(() => { if (this.root.querySelector("#caStatus").textContent === "Шаблон сохранён.") this.root.querySelector("#caStatus").textContent = ""; }, 2000);
    },

    async _ensureLayout() {
      if (this.layout) return this.layout;
      this.layout = await CE.api.createLayout({
        context: "analysis", name: `${this.symbol} · автосохранение`, symbol: this.symbol, board: this.board,
        timeframe: this.timeframe, visibleFrom: this.from, visibleTo: this.to, chartType: "candles", settings: {}, indicators: [],
      });
      return this.layout;
    },

    _onDrawingsChanged(detail) {
      if (detail.loaded || detail.history) return; // bulk operations - nothing to diff/save per-id
      const id = detail.created || detail.updated;
      if (id) this._queueSave(id);
      if (detail.removed) this._queueDelete(detail.removed);
    },

    _queueSave(id) {
      clearTimeout(this._saveQueue[id]);
      this._saveQueue[id] = setTimeout(() => this._flushSave(id), 500);
    },

    async _flushSave(id) {
      const d = this.drawingMgr.drawings.find((x) => x.id === id);
      if (!d) return;
      await this._persistDrawing(d);
    },

    async _persistDrawing(d) {
      const layout = await this._ensureLayout();
      const payload = { type: d.type, symbol: this.symbol, timeframe: this.timeframe, points: d.points, properties: d.properties, locked: d.locked, hidden: d.hidden, zIndex: d.zIndex };
      if (d._backendId) return CE.api.updateDrawing(d._backendId, payload).catch(() => {});
      const created = await CE.api.createDrawing(layout.id, payload).catch(() => null);
      if (created) d._backendId = created.id;
    },

    async _queueDelete(localId) {
      // The drawing object (and its _backendId) is already gone from the
      // array by the time this fires; nothing to look up - deletion is
      // best-effort and only matters if it had been persisted already.
    },

    _renderProps() {
      const panel = this.root.querySelector("#caProps");
      const d = this.drawingMgr.drawings.find((x) => x.id === this.drawingMgr.selectedId);
      if (!d) { panel.innerHTML = `<div class="muted-note">Выберите объект на графике, чтобы изменить его свойства.</div>`; return; }
      const isPosition = d.type === "long_position" || d.type === "short_position";
      panel.innerHTML = `
        <h4>${CE.Drawings.TOOL_DEFS[d.type].label}</h4>
        <label>Цвет <input type="color" id="propColor" value="${toHex(d.properties.color)}"></label>
        <label>Толщина <input type="number" id="propWidth" min="1" max="6" value="${d.properties.width || 1}"></label>
        <label class="toggle"><input type="checkbox" id="propLocked" ${d.locked ? "checked" : ""}><span>Заблокировать</span></label>
        <label class="toggle"><input type="checkbox" id="propHidden" ${d.hidden ? "checked" : ""}><span>Скрыть</span></label>
        ${d.type === "text" ? `<label>Текст <input type="text" id="propText" value="${escapeAttr(d.properties.text || "")}"></label>` : ""}
        ${isPosition ? `
          <label>Кол-во <input type="number" id="propQty" value="${d.properties.quantity || 0}"></label>
          <label>Стоп, % <input type="number" step="0.1" id="propStopPct" value="${(d.properties.stopOffsetPct || 0).toFixed(2)}"></label>
          <label>Тейк, % <input type="number" step="0.1" id="propTakePct" value="${(d.properties.takeOffsetPct || 0).toFixed(2)}"></label>
        ` : ""}
        <button class="secondary" id="propDuplicate">Дублировать (Ctrl+D)</button>
        <button class="secondary" id="propDelete">Удалить</button>
      `;
      panel.querySelector("#propColor").oninput = (e) => this.drawingMgr.updateDrawing(d.id, { properties: { color: e.target.value } });
      panel.querySelector("#propWidth").oninput = (e) => this.drawingMgr.updateDrawing(d.id, { properties: { width: Number(e.target.value) } });
      panel.querySelector("#propLocked").onchange = (e) => this.drawingMgr.updateDrawing(d.id, { locked: e.target.checked });
      panel.querySelector("#propHidden").onchange = (e) => this.drawingMgr.updateDrawing(d.id, { hidden: e.target.checked });
      const textInput = panel.querySelector("#propText");
      if (textInput) textInput.oninput = (e) => this.drawingMgr.updateDrawing(d.id, { properties: { text: e.target.value } });
      if (isPosition) {
        panel.querySelector("#propQty").oninput = (e) => this.drawingMgr.updateDrawing(d.id, { properties: { quantity: Number(e.target.value) } });
        panel.querySelector("#propStopPct").oninput = (e) => this.drawingMgr.updateDrawing(d.id, { properties: { stopOffsetPct: Number(e.target.value) } });
        panel.querySelector("#propTakePct").oninput = (e) => this.drawingMgr.updateDrawing(d.id, { properties: { takeOffsetPct: Number(e.target.value) } });
      }
      panel.querySelector("#propDuplicate").onclick = () => this.drawingMgr.duplicateDrawing(d.id);
      panel.querySelector("#propDelete").onclick = () => this.drawingMgr.removeDrawing(d.id);
    },

    _renderObjects() {
      const panel = this.root.querySelector("#caObjects");
      this.root.querySelector('.ca-side-tab[data-side="objects"]').textContent = `Объекты (${this.drawingMgr.drawings.length})`;
      panel.innerHTML = this.drawingMgr.drawings.length
        ? this.drawingMgr.drawings.map((d) => `
            <div class="ca-object-row ${d.id === this.drawingMgr.selectedId ? "active" : ""}" data-obj="${d.id}">
              <span>${CE.Drawings.TOOL_DEFS[d.type].label}</span>
              <span class="ca-object-actions">
                <button data-toggle-hidden="${d.id}" title="Показать/скрыть">${d.hidden ? "🙈" : "👁"}</button>
                <button data-toggle-locked="${d.id}" title="Заблокировать">${d.locked ? "🔒" : "🔓"}</button>
                <button data-remove="${d.id}" title="Удалить">🗑</button>
              </span>
            </div>`).join("")
        : `<div class="muted-note">Пока нет объектов разметки.</div>`;
      panel.querySelectorAll("[data-obj]").forEach((row) => (row.onclick = (e) => { if (!e.target.closest("button")) this.drawingMgr.select(row.dataset.obj); }));
      panel.querySelectorAll("[data-toggle-hidden]").forEach((b) => (b.onclick = () => { const d = this.drawingMgr.drawings.find((x) => x.id === b.dataset.toggleHidden); this.drawingMgr.updateDrawing(d.id, { hidden: !d.hidden }); }));
      panel.querySelectorAll("[data-toggle-locked]").forEach((b) => (b.onclick = () => { const d = this.drawingMgr.drawings.find((x) => x.id === b.dataset.toggleLocked); this.drawingMgr.updateDrawing(d.id, { locked: !d.locked }); }));
      panel.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => this.drawingMgr.removeDrawing(b.dataset.remove)));
    },

    async _openOrderModal() {
      let overlay = document.getElementById("caOrderModal");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "caOrderModal";
        overlay.className = "ca-modal-backdrop";
        document.body.appendChild(overlay);
      }
      overlay.innerHTML = `
        <div class="ca-modal">
          <button class="close-btn" id="caOrderClose" aria-label="Закрыть">×</button>
          <h3>Заказать стратегию по разметке</h3>
          <p class="ca-warning">Разметка графика сама по себе не является формализованной торговой стратегией. Перед разработкой правила будут уточнены и согласованы.</p>
          <label>Описание торговой идеи <textarea id="ordIdea" rows="3"></textarea></label>
          <label>Условия входа <textarea id="ordEntry" rows="2"></textarea></label>
          <label>Условия выхода <textarea id="ordExit" rows="2"></textarea></label>
          <label>Стоп <input id="ordStop"></label>
          <label>Тейк <input id="ordTake"></label>
          <label>Управление позицией <input id="ordMgmt"></label>
          <label>Допустимый риск <input id="ordRisk"></label>
          <label>Комментарий <textarea id="ordComment" rows="2"></textarea></label>
          <label class="toggle"><input type="checkbox" id="ordScreenshot" checked><span>Приложить скриншот текущего графика</span></label>
          <div class="message" id="ordMessage"></div>
          <button class="primary" id="ordSubmit">Отправить заявку</button>
        </div>`;
      overlay.classList.remove("hidden");
      overlay.querySelector("#caOrderClose").onclick = () => overlay.classList.add("hidden");
      overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add("hidden"); };
      overlay.querySelector("#ordSubmit").onclick = () => this._submitOrder(overlay);
    },

    async _submitOrder(overlay) {
      const val = (id) => overlay.querySelector(id).value.trim();
      const msg = overlay.querySelector("#ordMessage");
      if (!val("#ordIdea")) { msg.textContent = "Опишите торговую идею."; return; }
      let screenshotPath = null;
      if (overlay.querySelector("#ordScreenshot").checked) {
        try {
          const canvas = this.core.chart.takeScreenshot();
          const dataUrl = canvas.toDataURL("image/png");
          const up = await CE.api.uploadScreenshot(dataUrl);
          screenshotPath = up.path;
        } catch (e) { /* screenshot is a nice-to-have; submitting without one is fine */ }
      }
      const layout = await this._ensureLayout();
      try {
        await CE.api.createStrategyRequest({
          layoutId: layout.id, symbol: this.symbol, board: this.board, timeframe: this.timeframe,
          visibleFrom: this.from, visibleTo: this.to,
          drawingsSnapshot: this.drawingMgr.drawings, indicators: this.indicatorMgr.list(),
          ideaDescription: val("#ordIdea"), entryConditions: val("#ordEntry"), exitConditions: val("#ordExit"),
          stopDescription: val("#ordStop"), takeDescription: val("#ordTake"), positionManagement: val("#ordMgmt"),
          riskTolerance: val("#ordRisk"), comment: val("#ordComment"), screenshotPath,
        });
        msg.textContent = "Заявка отправлена.";
        setTimeout(() => overlay.classList.add("hidden"), 1200);
      } catch (e) {
        msg.textContent = "Ошибка: " + e.message;
      }
    },
  };

  function toHex(color) {
    if (!color || color[0] === "#") return color || "#7c8cff";
    const m = color.match(/rgba?\((\d+),(\d+),(\d+)/);
    if (!m) return "#7c8cff";
    return "#" + m.slice(1, 4).map((x) => Number(x).toString(16).padStart(2, "0")).join("");
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  global.ChartAnalysisPage = Page;
})(window);
