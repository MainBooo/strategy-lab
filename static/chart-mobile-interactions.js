/* Mobile interaction compatibility for the free-form chart workspace.
 *
 * The drawing engine was originally wired only to mouse events, so iOS
 * could activate a drawing tool in the rail without ever placing a point on
 * the chart. The unified toolbar also moves Indicators/Templates/Alerts into
 * the "More" menu on narrow screens; their original popovers live inside
 * toolbar items that are display:none while overflowed, so programmatically
 * clicking those hidden buttons cannot produce a visible menu.
 *
 * Keep the desktop paths untouched and add the missing mobile bridges here.
 */
(function (global) {
  "use strict";

  const CE = global.ChartEngine;
  const Drawings = CE && CE.Drawings;

  // ---------------------------------------------------------------- touch --
  // Preserve the existing mouse implementation verbatim and add touch events
  // only for gestures the drawing layer actually owns. Empty-chart touches
  // are deliberately left alone so Lightweight Charts keeps native pan/zoom.
  if (Drawings && Drawings.DrawingManager) {
    const proto = Drawings.DrawingManager.prototype;
    const originalBindDom = proto._bindDom;

    proto._bindDom = function () {
      originalBindDom.call(this);

      const el = this.core.container;
      const asMouseLike = (touch) => ({
        clientX: touch.clientX,
        clientY: touch.clientY,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        key: "",
      });
      const firstTouch = (e) => (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || null;

      el.addEventListener("touchstart", (e) => {
        const touch = firstTouch(e);
        if (!touch) return;
        const mouseLike = asMouseLike(touch);
        const pos = this._relXY(mouseLike);
        const hit = this.activeTool ? null : this.hitTest(pos.x, pos.y);

        // Cursor + empty chart belongs to Lightweight Charts (pan/zoom).
        // An active drawing tool or a touch directly on an existing drawing
        // belongs to DrawingManager and must not also scroll the chart.
        if (!this.activeTool && !hit) return;

        e.preventDefault();
        e.stopPropagation();
        this._pointerInside = true;
        this._mobileTouchActive = true;

        const previousTap = this._mobileLastTap;
        this._onMouseDown(mouseLike);

        // Desktop polylines finish on double-click/Enter. Phones have no
        // keyboard or reliable dblclick gesture, so a quick second tap near
        // the previous one commits an unbounded polyline after that tap has
        // added its final vertex.
        const now = Date.now();
        const isDoubleTap = previousTap
          && now - previousTap.time < 360
          && Math.hypot(pos.x - previousTap.x, pos.y - previousTap.y) < 28;
        if (isDoubleTap && this.draft) {
          const def = Drawings.TOOL_DEFS[this.draft.type];
          if (def && def.pointsNeeded < 0) {
            this._finishDraft();
            this._emit();
          }
        }
        this._mobileLastTap = { time: now, x: pos.x, y: pos.y };
      }, { passive: false, capture: true });

      el.addEventListener("touchmove", (e) => {
        if (!this._mobileTouchActive) return;
        const touch = firstTouch(e);
        if (!touch) return;
        e.preventDefault();
        e.stopPropagation();
        this._onMouseMove(asMouseLike(touch));
      }, { passive: false, capture: true });

      const finishTouch = (e) => {
        if (!this._mobileTouchActive) return;
        e.preventDefault();
        e.stopPropagation();
        this._onMouseUp();
        this._mobileTouchActive = false;
        this._pointerInside = false;
      };
      el.addEventListener("touchend", finishTouch, { passive: false, capture: true });
      el.addEventListener("touchcancel", finishTouch, { passive: false, capture: true });
    };
  }

  // ---------------------------------------------------------- overflow UI --
  // On mobile the real popover's parent toolbar item is .gt-hidden. Render
  // the same existing content directly inside the visible More popover
  // instead of trying to open a descendant of display:none.
  const Page = global.ChartAnalysisPage;
  if (Page && typeof Page._renderMorePopover === "function") {
    const originalRenderMore = Page._renderMorePopover;

    const openSubmenu = (page, title, render) => {
      const pop = page.root.querySelector("#gtMorePop");
      if (!pop) return;
      pop.innerHTML = `
        <div class="ca-more-group">
          <button class="ca-more-item" type="button" data-mobile-more-back>← Назад</button>
          <div class="ca-more-heading">${title}</div>
        </div>
        <div class="ca-more-sep"></div>
        <div data-mobile-more-body></div>
      `;
      const body = pop.querySelector("[data-mobile-more-body]");
      render(body);
      pop.querySelector("[data-mobile-more-back]").onclick = (e) => {
        e.stopPropagation();
        page._renderMorePopover();
      };
      pop.classList.remove("hidden");
    };

    Page._renderMorePopover = function () {
      originalRenderMore.call(this);
      const pop = this.root.querySelector("#gtMorePop");
      if (!pop) return;

      const wire = (action, title, render) => {
        const btn = pop.querySelector(`[data-act="${action}"]`);
        if (!btn) return;
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          openSubmenu(this, title, render);
        };
      };

      wire("indicators", "Индикаторы", (body) => this._renderIndicatorsInto(body));
      wire("templates", "Шаблоны", (body) => this._renderTemplatesInto(body));
      wire("alerts", "Оповещения", (body) => this._renderAlertsInto(body));
    };
  }
})(window);
