/* Shared fullscreen helper for chart surfaces (the "Анализ графиков"
 * workspace, individual multi-chart tiles, the trade chart). Uses the real
 * browser Fullscreen API so the OS/browser chrome, Esc handling and
 * fullscreenchange notifications are native - no CSS-only "pretend
 * fullscreen" that traps the user with no way out. A CSS-class fallback
 * only kicks in on the rare UA that has no Fullscreen API at all (some
 * embedded webviews), and even then still wires Esc manually so the user
 * is never stuck.
 *
 * Because requestFullscreen() only changes *how* the existing element is
 * displayed (it stays in the DOM, nothing is destroyed or recreated), the
 * chart instance, its data, indicators, drawings and trade overlays are
 * untouched across enter/exit - callers don't need to save/restore any of
 * that themselves. */
(function (global) {
  "use strict";

  const CE = (global.ChartEngine = global.ChartEngine || {});

  function fsEnabled() {
    return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }

  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function requestFs(el) {
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
    return Promise.reject(new Error("Fullscreen API unavailable"));
  }

  function exitFs() {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
    return Promise.resolve();
  }

  /** Wires `el` to togglable fullscreen. `onChange(active)` fires whenever
   * the state flips, by any means (our button, native Esc, F11, browser UI). */
  class FullscreenController {
    constructor(el, { className = "is-fullscreen", onChange } = {}) {
      this.el = el;
      this.className = className;
      this.onChange = onChange || (() => {});
      this._active = false;
      this._fallback = false;

      this._onFsChange = () => {
        if (this._fallback) return; // fallback path manages its own state below
        this._setActive(fsElement() === this.el);
      };
      document.addEventListener("fullscreenchange", this._onFsChange);
      document.addEventListener("webkitfullscreenchange", this._onFsChange);

      this._onKeydown = (e) => {
        if (e.key === "Escape" && this._fallback && this._active) {
          e.preventDefault();
          this.exit();
        }
      };
      document.addEventListener("keydown", this._onKeydown);
    }

    get active() {
      return this._active;
    }

    _setActive(active) {
      if (active === this._active) return;
      this._active = active;
      this.el.classList.toggle(this.className, active);
      this.onChange(active);
    }

    async enter() {
      if (this._active) return;
      if (fsEnabled()) {
        try {
          await requestFs(this.el);
          this._fallback = false;
          this._setActive(true);
          return;
        } catch (e) {
          /* fall through to CSS fallback below */
        }
      }
      this._fallback = true;
      this._setActive(true);
    }

    async exit() {
      if (!this._active) return;
      if (!this._fallback && fsElement() === this.el) {
        try {
          await exitFs();
        } catch (e) {
          /* ignore - fullscreenchange listener reconciles state either way */
        }
        return;
      }
      this._fallback = false;
      this._setActive(false);
    }

    toggle() {
      return this._active ? this.exit() : this.enter();
    }

    destroy() {
      document.removeEventListener("fullscreenchange", this._onFsChange);
      document.removeEventListener("webkitfullscreenchange", this._onFsChange);
      document.removeEventListener("keydown", this._onKeydown);
    }
  }

  CE.Fullscreen = { FullscreenController, fsEnabled, fsElement };
})(window);
