(function () {
  "use strict";

  // Analytics is best-effort infrastructure. The queue keeps auth events safe
  // even if the Metrika script has not loaded yet (or is blocked entirely).
  if (!window.StrategyLabAnalytics) {
    window.StrategyLabAnalytics = {
      q: [],
      trackGoal: function () { this.q.push(["goal"].concat(Array.from(arguments))); },
      trackPageView: function () { this.q.push(["page"].concat(Array.from(arguments))); },
      trackVirtualPage: function () { this.q.push(["virtual"].concat(Array.from(arguments))); }
    };
  }
  if (!document.querySelector('script[data-strategy-lab-analytics="1"]')) {
    const analyticsScript = document.createElement("script");
    analyticsScript.src = "/static/analytics.js";
    analyticsScript.async = false;
    analyticsScript.dataset.strategyLabAnalytics = "1";
    analyticsScript.onerror = function () { /* analytics must never block auth/app */ };
    document.head.appendChild(analyticsScript);
  }

  function trackGoal(name, params) {
    try { window.StrategyLabAnalytics.trackGoal(name, params || {}); } catch (e) { /* best-effort */ }
  }

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : "";
  }

  /** fetch() wrapper for the auth/account JSON endpoints - attaches the
   * CSRF header (see csrf.py) on every state-changing request and always
   * sends/receives JSON. Exposed on window so account.js can reuse it. */
  async function authFetch(url, options) {
    options = options || {};
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    const method = (options.method || "GET").toUpperCase();
    if (method !== "GET") headers["X-CSRF-Token"] = csrfToken();
    const resp = await fetch(url, Object.assign({}, options, { headers, credentials: "same-origin" }));
    let data = null;
    try { data = await resp.json(); } catch (e) { /* no body */ }
    if (!resp.ok) {
      const message = (data && data.error) || `Ошибка запроса (${resp.status})`;
      const err = new Error(message);
      err.status = resp.status;
      throw err;
    }
    return data;
  }
  window.authFetch = authFetch;

  function showMessage(el, text, isError) {
    if (!el) return;
    el.textContent = text;
    el.className = "message " + (isError ? "error" : "success");
    // A wrong password/duplicate email etc. is common enough on these forms
    // that a purely textual message is easy to miss - the shake draws the
    // eye to it without being alarming (CSS animation, auto-removes itself
    // via animationend so re-triggering on a second failed attempt works).
    if (isError && text) {
      const form = el.closest("form");
      if (form) {
        form.classList.remove("shake");
        void form.offsetWidth; // restart the animation if it's already mid-shake
        form.classList.add("shake");
        form.addEventListener("animationend", () => form.classList.remove("shake"), { once: true });
      }
    }
  }

  function wireForm(formId, messageId, submit, onSuccess) {
    const form = document.getElementById(formId);
    if (!form) return;
    const msg = document.getElementById(messageId);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
      showMessage(msg, "", false);
      try {
        const result = await submit(new FormData(form));
        if (onSuccess) onSuccess(result);
      } catch (err) {
        showMessage(msg, err.message || "Что-то пошло не так", true);
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
      }
    });
  }

  // Only same-origin, path-only redirects are ever honored - an absolute/
  // protocol-relative "next" would be an open redirect (see auth_routes.py's
  // server-side check, which is authoritative; this is just a UX nicety so
  // a bad value doesn't even get submitted as the visible link target).
  function safeNext(raw) {
    if (!raw) return "/";
    if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
    return raw;
  }

  wireForm("loginForm", "loginMessage", async (fd) => {
    return authFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: fd.get("email"), password: fd.get("password"), remember: fd.get("remember") === "on",
      }),
    });
  }, () => {
    trackGoal("login_completed");
    const next = safeNext(document.getElementById("loginForm").dataset.next);
    window.location.href = next;
  });

  wireForm("registerForm", "registerMessage", async (fd) => {
    if (fd.get("password") !== fd.get("password2")) throw new Error("Пароли не совпадают");
    if (!fd.get("accept_terms")) throw new Error("Нужно принять условия использования");
    return authFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        display_name: fd.get("display_name"), email: fd.get("email"), password: fd.get("password"),
      }),
    });
  }, () => {
    trackGoal("registration_completed");
    const next = safeNext(document.getElementById("registerForm").dataset.next);
    window.location.href = next;
  });

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await authFetch("/api/auth/logout", { method: "POST" });
        trackGoal("logout");
      } catch (e) { /* best-effort */ }
      window.location.href = "/";
    });
  }

  const menuBtn = document.getElementById("accountMenuBtn");
  const dropdown = document.getElementById("accountDropdown");
  if (menuBtn && dropdown) {
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); dropdown.classList.toggle("hidden"); });
    document.addEventListener("click", () => dropdown.classList.add("hidden"));
  }
})();
