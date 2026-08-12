from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing block: {label}")
    if text.count(old) != 1:
        raise SystemExit(f"non-unique block {label}: {text.count(old)}")
    return text.replace(old, new, 1)


# ---------- drawing engine ----------
path = Path("static/chart-engine/drawings.js")
s = path.read_text()
s = replace_once(
    s,
    "  const HIT_TOLERANCE_PX = 6;\n  const HANDLE_RADIUS_PX = 5;\n",
    "  const HIT_TOLERANCE_PX = 6;\n"
    "  const HANDLE_RADIUS_PX = 5;\n"
    "  // A finger is not a mouse cursor. Keep precise desktop hit-testing, but\n"
    "  // give touch a TradingView-like forgiving corridor around thin drawings.\n"
    "  const TOUCH_HIT_TOLERANCE_PX = 18;\n"
    "  const TOUCH_HANDLE_HIT_RADIUS_PX = 14;\n",
    "touch hit constants",
)

old = '''    hitTest(px, py) {
      const sorted = this.drawings.filter((d) => !d.hidden).sort((a, b) => b.zIndex - a.zIndex);
      // selected drawing gets priority so its own handles are grabbable even under overlaps
      if (this.selectedId) {
        const sel = sorted.find((d) => d.id === this.selectedId);
        if (sel) {
          const hit = this._hitDrawing(sel, px, py);
          if (hit) return hit;
        }
      }
      for (const d of sorted) {
        const hit = this._hitDrawing(d, px, py);
        if (hit) return hit;
      }
      return null;
    }

    _hitDrawing(d, px, py) {
      const pix = toPixels(this.core, d.points);
      const tol = HIT_TOLERANCE_PX;
      const handleAt = (i) => (pix[i] && pix[i].x != null && Math.hypot(px - pix[i].x, py - pix[i].y) <= HANDLE_RADIUS_PX + 3);
'''
new = '''    hitTest(px, py, { pointerType = "mouse" } = {}) {
      const sorted = this.drawings.filter((d) => !d.hidden).sort((a, b) => b.zIndex - a.zIndex);
      const touch = pointerType === "touch";
      const hitOptions = {
        tol: touch ? TOUCH_HIT_TOLERANCE_PX : HIT_TOLERANCE_PX,
        handleRadius: touch ? TOUCH_HANDLE_HIT_RADIUS_PX : HANDLE_RADIUS_PX + 3,
      };
      // TradingView semantics: resize/edit handles belong only to the selected
      // object. An unselected object is first grabbed as a whole, even if the
      // initial finger-down happens exactly over one of its hidden anchors.
      if (this.selectedId) {
        const sel = sorted.find((d) => d.id === this.selectedId);
        if (sel) {
          const hit = this._hitDrawing(sel, px, py, Object.assign({ allowHandles: true }, hitOptions));
          if (hit) return hit;
        }
      }
      for (const d of sorted) {
        if (d.id === this.selectedId) continue;
        const hit = this._hitDrawing(d, px, py, Object.assign({ allowHandles: false }, hitOptions));
        if (hit) return hit;
      }
      return null;
    }

    _hitDrawing(d, px, py, { tol = HIT_TOLERANCE_PX, handleRadius = HANDLE_RADIUS_PX + 3, allowHandles = true } = {}) {
      const pix = toPixels(this.core, d.points);
      const handleAt = (i) => allowHandles && pix[i] && pix[i].x != null && Math.hypot(px - pix[i].x, py - pix[i].y) <= handleRadius;
'''
s = replace_once(s, old, new, "hit test semantics")

replacements = {
    'if (Math.hypot(px - x1, py - entryY) <= HANDLE_RADIUS_PX + 3) return { id: d.id, handle: "start" };': 'if (allowHandles && Math.hypot(px - x1, py - entryY) <= handleRadius) return { id: d.id, handle: "start" };',
    'if (Math.hypot(px - x2, py - entryY) <= HANDLE_RADIUS_PX + 3) return { id: d.id, handle: "end" };': 'if (allowHandles && Math.hypot(px - x2, py - entryY) <= handleRadius) return { id: d.id, handle: "end" };',
    'if (stopY != null && Math.hypot(px - (x1 + x2) / 2, py - stopY) <= HANDLE_RADIUS_PX + 3) return { id: d.id, handle: "stop" };': 'if (allowHandles && stopY != null && Math.hypot(px - (x1 + x2) / 2, py - stopY) <= handleRadius) return { id: d.id, handle: "stop" };',
    'if (takeY != null && Math.hypot(px - (x1 + x2) / 2, py - takeY) <= HANDLE_RADIUS_PX + 3) return { id: d.id, handle: "take" };': 'if (allowHandles && takeY != null && Math.hypot(px - (x1 + x2) / 2, py - takeY) <= handleRadius) return { id: d.id, handle: "take" };',
}
for old_line, new_line in replacements.items():
    if old_line not in s:
        raise SystemExit(f"missing position handle line: {old_line}")
    s = s.replace(old_line, new_line, 1)

s = replace_once(
    s,
    '          if (box && px >= box.x1 && px <= box.x2 && py >= box.y1 && py <= box.y2) return { id: d.id, handle: null };\n',
    '          if (box && px >= box.x1 - tol && px <= box.x2 + tol && py >= box.y1 - tol && py <= box.y2 + tol) return { id: d.id, handle: null };\n',
    "text note hit box",
)
s = replace_once(
    s,
    '      const hit = this.hitTest(pos.x, pos.y);\n      if (hit) {\n',
    '      const hit = this.hitTest(pos.x, pos.y, { pointerType: e.pointerType || "mouse" });\n      if (hit) {\n',
    "pointer-type hit test",
)
s = replace_once(
    s,
    '      // Preview-only notification. Persistence receives one {updated:id} on\n      // pointerup, never one network save trigger per pointermove.\n      this._emit();\n',
    '      // Preview-only notification. Persistence receives one {updated:id} on\n'
    '      // pointerup, never one network save trigger per pointermove. UI panels\n'
    '      // also ignore this marker so a finger drag cannot rebuild the DOM on\n'
    '      // every frame.\n'
    '      this._emit({ preview: true });\n',
    "drag preview detail",
)
s = replace_once(
    s,
    '          this.hoverId = nextHover;\n          this._emit();\n',
    '          this.hoverId = nextHover;\n          this._emit({ hover: true });\n',
    "hover detail",
)
path.write_text(s)


# ---------- chart properties ----------
path = Path("static/chart-analysis.js")
s = path.read_text()
s = replace_once(
    s,
    '''          tile.drawingMgr.onChange(() => {
            if (tile.id === this.activeTileId) { this._renderProps(); this._renderObjects(); }
          });
''',
    '''          tile.drawingMgr.onChange((mgr, detail) => {
            // Canvas preview/hover updates happen at pointer frequency. They
            // must repaint the primitive, not rebuild the properties/object
            // DOM while the user is dragging on iPhone.
            if (detail && (detail.preview || detail.hover)) return;
            if (tile.id === this.activeTileId) { this._renderProps(); this._renderObjects(); }
          });
''',
    "active tile drawing listener",
)

start = s.index('    _renderProps() {')
end = s.index('    _renderObjects() {', start)
new_method = r'''    _renderProps() {
      const panel = this.root.querySelector("#caProps");
      const dm = this.drawingMgr;
      const d = dm ? dm.drawings.find((x) => x.id === dm.selectedId) : null;
      if (!d) { panel.innerHTML = `<div class="muted-note">Выберите объект на графике, чтобы изменить его свойства.</div>`; return; }
      const isPosition = d.type === "long_position" || d.type === "short_position";
      const isTextual = d.type === "text" || d.type === "note";
      const tile = this.activeTile;
      const tfList = tile ? tile.listTimeframes() : [];
      const visibleTf = d.properties.visibleTimeframes || [];
      panel.innerHTML = `
        <h4>${CE.Drawings.TOOL_DEFS[d.type].label}</h4>
        <div class="ca-prop-coords">
          <span class="ca-more-heading">Координаты</span>
          ${d.points.map((p, i) => `<div class="ca-coord-row">${d.points.length > 1 ? `#${i + 1}: ` : ""}${fmtCoordTime(p.time)}${p.price != null ? ` · ${fmtPrice(p.price)}` : ""}</div>`).join("")}
        </div>
        ${isTextual ? `
          <label class="ca-prop-text-label">${d.type === "note" ? "Текст заметки" : "Текст"}
            <textarea id="propText" class="ca-prop-textarea" rows="4" placeholder="Введите текст…"></textarea>
          </label>
          <div class="muted-note ca-prop-text-hint">Текст сохраняется после завершения ввода.</div>
        ` : ""}
        <label>Цвет <input type="color" id="propColor" value="${toHex(d.properties.color)}"></label>
        ${!isTextual ? `
          <label>Толщина <input type="number" id="propWidth" min="1" max="6" value="${d.properties.width || 1}"></label>
          <label>Стиль линии
            <select id="propDash">
              <option value="solid" ${d.properties.dash !== "dashed" && d.properties.dash !== "dotted" ? "selected" : ""}>Сплошная</option>
              <option value="dashed" ${d.properties.dash === "dashed" ? "selected" : ""}>Штрихи</option>
              <option value="dotted" ${d.properties.dash === "dotted" ? "selected" : ""}>Точки</option>
            </select>
          </label>
        ` : ""}
        <label>Прозрачность <input type="range" id="propOpacity" min="10" max="100" value="${Math.round((d.properties.opacity != null ? d.properties.opacity : 1) * 100)}"></label>
        <label class="toggle"><input type="checkbox" id="propLocked" ${d.locked ? "checked" : ""}><span>Заблокировать</span></label>
        <label class="toggle"><input type="checkbox" id="propHidden" ${d.hidden ? "checked" : ""}><span>Скрыть</span></label>
        ${!isTextual ? `<label class="toggle"><input type="checkbox" id="propShowPrice" ${d.properties.showPrice ? "checked" : ""}><span>Показывать цену</span></label>` : ""}
        <label>Подпись (для списка объектов) <input type="text" id="propLabel" value="${escapeAttr(d.properties.label || "")}"></label>
        ${isPosition ? `
          <label>Кол-во <input type="number" id="propQty" value="${d.properties.quantity || 0}"></label>
          <label>Стоп, % <input type="number" step="0.1" id="propStopPct" value="${(d.properties.stopOffsetPct || 0).toFixed(2)}"></label>
          <label>Тейк, % <input type="number" step="0.1" id="propTakePct" value="${(d.properties.takeOffsetPct || 0).toFixed(2)}"></label>
        ` : ""}
        <div class="ca-prop-tfvis">
          <span class="ca-more-heading">Видимость на таймфреймах</span>
          <label class="ca-more-toggle"><input type="checkbox" id="propTfAll" ${!visibleTf.length ? "checked" : ""}><span>Все таймфреймы</span></label>
          <div class="ca-tf-grid ${!visibleTf.length ? "hidden" : ""}" id="propTfGrid">
            ${tfList.map((t) => `<label class="ca-more-toggle"><input type="checkbox" data-tf="${t.id}" ${visibleTf.includes(t.id) ? "checked" : ""}><span>${t.label}</span></label>`).join("")}
          </div>
        </div>
        <button class="secondary" id="propDuplicate">Дублировать (Ctrl+D)</button>
        <button class="secondary" id="propDelete">Удалить</button>
      `;

      // updateDrawing() re-renders this panel. Commit-style change events keep
      // the focused textarea/number input alive while the user is typing.
      const colorInput = panel.querySelector("#propColor");
      if (colorInput) colorInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { color: e.target.value } });
      const widthInput = panel.querySelector("#propWidth");
      if (widthInput) widthInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { width: Number(e.target.value) } });
      const dashInput = panel.querySelector("#propDash");
      if (dashInput) dashInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { dash: e.target.value } });
      const opacityInput = panel.querySelector("#propOpacity");
      if (opacityInput) opacityInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { opacity: Number(e.target.value) / 100 } });
      panel.querySelector("#propLocked").onchange = (e) => dm.updateDrawing(d.id, { locked: e.target.checked });
      panel.querySelector("#propHidden").onchange = (e) => dm.updateDrawing(d.id, { hidden: e.target.checked });
      const showPrice = panel.querySelector("#propShowPrice");
      if (showPrice) showPrice.onchange = (e) => dm.updateDrawing(d.id, { properties: { showPrice: e.target.checked } });
      panel.querySelector("#propLabel").onchange = (e) => { dm.updateDrawing(d.id, { properties: { label: e.target.value } }); this._renderObjects(); };
      const textInput = panel.querySelector("#propText");
      if (textInput) {
        textInput.value = d.properties.text || "";
        textInput.onchange = (e) => dm.updateDrawing(d.id, { properties: { text: e.target.value } });
      }
      if (isPosition) {
        panel.querySelector("#propQty").onchange = (e) => dm.updateDrawing(d.id, { properties: { quantity: Number(e.target.value) } });
        panel.querySelector("#propStopPct").onchange = (e) => dm.updateDrawing(d.id, { properties: { stopOffsetPct: Number(e.target.value) } });
        panel.querySelector("#propTakePct").onchange = (e) => dm.updateDrawing(d.id, { properties: { takeOffsetPct: Number(e.target.value) } });
      }
      const tfAll = panel.querySelector("#propTfAll");
      const tfGrid = panel.querySelector("#propTfGrid");
      tfAll.onchange = (e) => {
        tfGrid.classList.toggle("hidden", e.target.checked);
        if (e.target.checked) dm.updateDrawing(d.id, { properties: { visibleTimeframes: null } });
      };
      tfGrid.querySelectorAll("[data-tf]").forEach((cb) => (cb.onchange = () => {
        const checked = [...tfGrid.querySelectorAll("[data-tf]")].filter((x) => x.checked).map((x) => x.dataset.tf);
        dm.updateDrawing(d.id, { properties: { visibleTimeframes: checked } });
      }));
      panel.querySelector("#propDuplicate").onclick = () => dm.duplicateDrawing(d.id);
      panel.querySelector("#propDelete").onclick = () => dm.removeDrawing(d.id);
    },

'''
s = s[:start] + new_method + s[end:]
path.write_text(s)


# ---------- mobile/object toolbar ----------
path = Path("static/chart-mobile-interactions.js")
s = path.read_text()
old = '''    const color = /^#[0-9a-f]{6}$/i.test(drawing.properties.color || "") ? drawing.properties.color : "#7c8cff";
    const width = Number(drawing.properties.width || 1);
    const dash = drawing.properties.dash || "solid";
    bar.innerHTML = `
      <span class="tv-object-name" title="${escapeHtml(drawingLabel(drawing))}">${escapeHtml(drawingLabel(drawing))}</span>
      <input class="tv-obj-control tv-color" data-tv-prop-color type="color" value="${color}" title="Цвет">
      <select class="tv-obj-control" data-tv-prop-width title="Толщина">${[1,2,3,4].map((n) => `<option value="${n}" ${width === n ? "selected" : ""}>${n}px</option>`).join("")}</select>
      <select class="tv-obj-control" data-tv-prop-dash title="Стиль линии">
        <option value="solid" ${dash === "solid" ? "selected" : ""}>—</option>
        <option value="dashed" ${dash === "dashed" ? "selected" : ""}>– –</option>
        <option value="dotted" ${dash === "dotted" ? "selected" : ""}>···</option>
      </select>
      <button class="tv-obj-btn ${drawing.locked ? "active" : ""}" data-tv-obj-lock title="${drawing.locked ? "Разблокировать" : "Заблокировать"}">${drawing.locked ? "🔒" : "🔓"}</button>
      <button class="tv-obj-btn" data-tv-obj-duplicate title="Дублировать">⧉</button>
      <button class="tv-obj-btn" data-tv-obj-more title="Свойства">⚙</button>
      <button class="tv-obj-btn danger" data-tv-obj-delete title="Удалить">⌫</button>
    `;
    bar.classList.remove("hidden");

    bar.querySelector("[data-tv-prop-color]").oninput = (e) => dm.updateDrawing(drawing.id, { properties: { color: e.target.value } });
    bar.querySelector("[data-tv-prop-width]").onchange = (e) => dm.updateDrawing(drawing.id, { properties: { width: Number(e.target.value) } });
    bar.querySelector("[data-tv-prop-dash]").onchange = (e) => dm.updateDrawing(drawing.id, { properties: { dash: e.target.value } });
    bar.querySelector("[data-tv-obj-lock]").onclick = () => dm.updateDrawing(drawing.id, { locked: !drawing.locked });
    bar.querySelector("[data-tv-obj-duplicate]").onclick = () => dm.duplicateDrawing(drawing.id);
    bar.querySelector("[data-tv-obj-delete]").onclick = () => dm.removeDrawing(drawing.id);
    bar.querySelector("[data-tv-obj-more]").onclick = () => {
      if (typeof page._setBottomCollapsed === "function") page._setBottomCollapsed(false);
      const tab = page.root.querySelector('.ca-side-tab[data-side="props"]');
      if (tab) tab.click();
    };
'''
new = '''    const color = /^#[0-9a-f]{6}$/i.test(drawing.properties.color || "") ? drawing.properties.color : "#7c8cff";
    const width = Number(drawing.properties.width || 1);
    const dash = drawing.properties.dash || "solid";
    const isTextual = drawing.type === "text" || drawing.type === "note";
    bar.innerHTML = `
      <span class="tv-object-name" title="${escapeHtml(drawingLabel(drawing))}">${escapeHtml(drawingLabel(drawing))}</span>
      <input class="tv-obj-control tv-color" data-tv-prop-color type="color" value="${color}" title="Цвет">
      ${isTextual ? `
        <button class="tv-obj-btn" data-tv-obj-edit-text title="Редактировать текст" aria-label="Редактировать текст">✎</button>
      ` : `
        <select class="tv-obj-control" data-tv-prop-width title="Толщина">${[1,2,3,4].map((n) => `<option value="${n}" ${width === n ? "selected" : ""}>${n}px</option>`).join("")}</select>
        <select class="tv-obj-control" data-tv-prop-dash title="Стиль линии">
          <option value="solid" ${dash === "solid" ? "selected" : ""}>—</option>
          <option value="dashed" ${dash === "dashed" ? "selected" : ""}>– –</option>
          <option value="dotted" ${dash === "dotted" ? "selected" : ""}>···</option>
        </select>
      `}
      <button class="tv-obj-btn ${drawing.locked ? "active" : ""}" data-tv-obj-lock title="${drawing.locked ? "Разблокировать" : "Заблокировать"}">${drawing.locked ? "🔒" : "🔓"}</button>
      <button class="tv-obj-btn" data-tv-obj-duplicate title="Дублировать">⧉</button>
      <button class="tv-obj-btn" data-tv-obj-more title="Свойства">⚙</button>
      <button class="tv-obj-btn danger" data-tv-obj-delete title="Удалить">⌫</button>
    `;
    bar.classList.remove("hidden");

    const colorInput = bar.querySelector("[data-tv-prop-color]");
    if (colorInput) colorInput.onchange = (e) => dm.updateDrawing(drawing.id, { properties: { color: e.target.value } });
    const widthInput = bar.querySelector("[data-tv-prop-width]");
    if (widthInput) widthInput.onchange = (e) => dm.updateDrawing(drawing.id, { properties: { width: Number(e.target.value) } });
    const dashInput = bar.querySelector("[data-tv-prop-dash]");
    if (dashInput) dashInput.onchange = (e) => dm.updateDrawing(drawing.id, { properties: { dash: e.target.value } });
    const editTextButton = bar.querySelector("[data-tv-obj-edit-text]");
    if (editTextButton) editTextButton.onclick = () => {
      if (typeof page._setBottomCollapsed === "function") page._setBottomCollapsed(false);
      const tab = page.root.querySelector('.ca-side-tab[data-side="props"]');
      if (tab) tab.click();
      if (typeof page._renderProps === "function") page._renderProps();
      requestAnimationFrame(() => {
        const field = page.root.querySelector("#propText");
        if (!field) return;
        field.focus();
        if (typeof field.setSelectionRange === "function") field.setSelectionRange(field.value.length, field.value.length);
        if (typeof field.scrollIntoView === "function") field.scrollIntoView({ block: "nearest" });
      });
    };
    bar.querySelector("[data-tv-obj-lock]").onclick = () => dm.updateDrawing(drawing.id, { locked: !drawing.locked });
    bar.querySelector("[data-tv-obj-duplicate]").onclick = () => dm.duplicateDrawing(drawing.id);
    bar.querySelector("[data-tv-obj-delete]").onclick = () => dm.removeDrawing(drawing.id);
    bar.querySelector("[data-tv-obj-more]").onclick = () => {
      if (typeof page._setBottomCollapsed === "function") page._setBottomCollapsed(false);
      const tab = page.root.querySelector('.ca-side-tab[data-side="props"]');
      if (tab) tab.click();
    };
'''
s = replace_once(s, old, new, "textual object toolbar")
s = replace_once(
    s,
    '      #chartsRoot .tv-indicator-search { width:100%; min-height:40px; margin:0 0 9px; padding:0 11px; border:1px solid rgba(140,154,186,.22); border-radius:8px; background:rgba(5,8,16,.42); color:#edf1fa; outline:none; font:500 13px system-ui,sans-serif; }\n',
    '      #chartsRoot .tv-indicator-search { width:100%; min-height:40px; margin:0 0 9px; padding:0 11px; border:1px solid rgba(140,154,186,.22); border-radius:8px; background:rgba(5,8,16,.42); color:#edf1fa; outline:none; font:500 13px system-ui,sans-serif; }\n'
    '      #chartsRoot .ca-prop-textarea { width:100%; min-height:84px; box-sizing:border-box; padding:10px 11px; border:1px solid rgba(140,154,186,.22); border-radius:8px; background:rgba(5,8,16,.42); color:#edf1fa; outline:none; resize:vertical; font:500 14px/1.4 system-ui,sans-serif; }\n'
    '      #chartsRoot .ca-prop-textarea:focus { border-color:rgba(124,140,255,.72); box-shadow:0 0 0 2px rgba(124,140,255,.12); }\n'
    '      #chartsRoot .ca-prop-text-hint { margin-top:-4px; margin-bottom:8px; }\n',
    "textarea styles",
)
path.write_text(s)


# ---------- runtime regression ----------
path = Path("tests/chart_drawing_runtime.test.js")
s = path.read_text()
marker = "// Pointer cancel rolls creation/edit state back and releases capture.\n"
block = r'''// Touch editing uses a forgiving hit corridor, and hidden handles on an
// unselected object never resize it. First drag moves the whole object; once
// selected, dragging a visible anchor edits only that anchor.
{
  const env = makeManager();
  env.manager.setTool("trend_line");
  drag(env, 20, 20, 120, 120, 1000);
  const drawing = env.manager.drawings[0];
  env.manager.select(null);

  // 16px vertically off y=x is ~11.3px perpendicular: outside the old 6px
  // mouse corridor, inside the touch corridor.
  const touchGrab = drag(env, 70, 86, 100, 116, 2000);
  assert.strictEqual(touchGrab.down.defaultPrevented, true);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points)),
    [{ time: 50, price: 50 }, { time: 150, price: 150 }],
  );

  env.manager.select(null);
  drag(env, 50, 50, 80, 80, 2800); // exact hidden anchor => whole-object move
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points)),
    [{ time: 80, price: 80 }, { time: 180, price: 180 }],
  );

  // The object is now selected, so the same anchor is an explicit edit handle.
  drag(env, 80, 80, 105, 115, 3600);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(drawing.points)),
    [{ time: 105, price: 115 }, { time: 180, price: 180 }],
  );
}

'''
if marker not in s:
    raise SystemExit("runtime marker missing")
s = s.replace(marker, block + marker, 1)
path.write_text(s)


# ---------- static contracts ----------
path = Path("tests/test_chart_drawing_interactions.py")
s = path.read_text()
addition = r'''


def test_touch_object_editing_and_textual_editor_contracts():
    drawings = Path("static/chart-engine/drawings.js").read_text()
    analysis = Path("static/chart-analysis.js").read_text()
    mobile = Path("static/chart-mobile-interactions.js").read_text()

    assert "TOUCH_HIT_TOLERANCE_PX = 18" in drawings
    assert 'pointerType: e.pointerType || "mouse"' in drawings
    assert "allowHandles: false" in drawings
    assert "this._emit({ preview: true })" in drawings
    assert "detail.preview || detail.hover" in analysis

    assert 'const isTextual = d.type === "text" || d.type === "note"' in analysis
    assert 'textarea id=\\"propText\\"' in analysis
    assert "textInput.onchange" in analysis
    assert "textInput.oninput" not in analysis
    assert "data-tv-obj-edit-text" in mobile
    assert 'const isTextual = drawing.type === "text" || drawing.type === "note"' in mobile
'''
if "def test_touch_object_editing_and_textual_editor_contracts()" not in s:
    s += addition
path.write_text(s)
