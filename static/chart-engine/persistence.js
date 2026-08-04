/* Thin client for the chart-layout/drawing/strategy-request backend
 * (see charts_db.py + the /api/chart-* routes in app.py). Also exposes a
 * debounce() helper so autosave doesn't fire a request per mouse-move
 * during a drag. */
(function (global) {
  "use strict";

  async function req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const api = {
    listLayouts: (context, symbol) => req("GET", `/api/chart-layouts?${new URLSearchParams({ context: context || "", symbol: symbol || "" })}`),
    getLayout: (id) => req("GET", `/api/chart-layouts/${id}`),
    createLayout: (payload) => req("POST", "/api/chart-layouts", payload),
    updateLayout: (id, payload) => req("PUT", `/api/chart-layouts/${id}`, payload),
    deleteLayout: (id) => req("DELETE", `/api/chart-layouts/${id}`),

    createDrawing: (layoutId, payload) => req("POST", `/api/chart-layouts/${layoutId}/drawings`, payload),
    updateDrawing: (id, payload) => req("PUT", `/api/chart-drawings/${id}`, payload),
    deleteDrawing: (id) => req("DELETE", `/api/chart-drawings/${id}`),

    uploadScreenshot: (dataUrl) => req("POST", "/api/chart-screenshot", { dataUrl }),
    createStrategyRequest: (payload) => req("POST", "/api/chart-strategy-requests", payload),
    listStrategyRequests: () => req("GET", "/api/chart-strategy-requests"),
  };

  function debounce(fn, wait) {
    let timer = null;
    const wrapped = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
  }

  global.ChartEngine.api = api;
  global.ChartEngine.debounce = debounce;
})(window);
