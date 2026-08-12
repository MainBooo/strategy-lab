(function (global) {
  "use strict";

  const COUNTER_ID = 111542935;
  const PROD_HOST = "strategylab.generationweb.ru";
  const enabled = global.location && global.location.hostname === PROD_HOST;
  const previous = global.StrategyLabAnalytics;
  const queued = previous && Array.isArray(previous.q) ? previous.q.slice() : [];
  const sentTerminalJobs = new Set();
  const jobContext = new Map();
  const pauseDedup = new Map();
  let currentVirtualPage = null;

  const SAFE_QUERY = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]);
  const SENSITIVE_QUERY = /token|jwt|api[_-]?key|email|session|auth|code|password|secret/i;

  function safeCall(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function sanitizeValue(value, depth) {
    if (depth > 2) return undefined;
    if (value == null) return value;
    if (typeof value === "string") return value.slice(0, 120);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 12).map((v) => sanitizeValue(v, depth + 1)).filter((v) => v !== undefined);
    if (typeof value === "object") {
      const out = {};
      Object.keys(value).slice(0, 20).forEach((key) => {
        if (/email|name|password|token|jwt|cookie|authorization|secret|body|stack|message/i.test(key)) return;
        const v = sanitizeValue(value[key], depth + 1);
        if (v !== undefined) out[key] = v;
      });
      return out;
    }
    return undefined;
  }

  function sanitizeUrl(raw) {
    return safeCall(() => {
      const url = new URL(raw || global.location.href, global.location.origin);
      const clean = new URL(url.origin + url.pathname);
      url.searchParams.forEach((value, key) => {
        if (SAFE_QUERY.has(key) && !SENSITIVE_QUERY.test(key)) clean.searchParams.set(key, value.slice(0, 120));
      });
      if (url.hash && /^#(?:portfolio|strategies|backtest|charts|replay)$/.test(url.hash)) clean.hash = url.hash;
      return clean.href;
    }) || global.location.origin + global.location.pathname;
  }

  function ymCall(method) {
    if (!enabled || typeof global.ym !== "function") return false;
    const args = Array.prototype.slice.call(arguments, 1);
    safeCall(() => global.ym.apply(global, [COUNTER_ID, method].concat(args)));
    return true;
  }

  function trackGoal(event, params) {
    if (!enabled || !event) return;
    const payload = sanitizeValue(params || {}, 0) || {};
    ymCall("reachGoal", String(event).slice(0, 80), payload);
  }

  function trackPageView(url, options) {
    if (!enabled) return;
    const target = sanitizeUrl(url || global.location.href);
    const referer = options && options.referer ? sanitizeUrl(options.referer) : undefined;
    ymCall("hit", target, { title: document.title.slice(0, 160), referer: referer });
  }

  function trackVirtualPage(name) {
    if (!name || currentVirtualPage === name) return;
    const previousPage = currentVirtualPage;
    currentVirtualPage = name;
    const url = new URL(global.location.origin + global.location.pathname);
    global.location.search && new URL(global.location.href).searchParams.forEach((value, key) => {
      if (SAFE_QUERY.has(key)) url.searchParams.set(key, value);
    });
    url.hash = name;
    trackPageView(url.href, previousPage ? { referer: global.location.origin + global.location.pathname + "#" + previousPage } : undefined);
  }

  function loadMetrika() {
    if (!enabled || typeof document === "undefined") return;
    if (document.querySelector('script[data-strategy-lab-metrika="1"]')) return;
    if (typeof global.ym !== "function") {
      global.ym = function () { (global.ym.a = global.ym.a || []).push(arguments); };
      global.ym.l = Date.now();
    }
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://mc.yandex.ru/metrika/tag.js";
    script.dataset.strategyLabMetrika = "1";
    script.onerror = function () { /* analytics is deliberately best-effort */ };
    (document.head || document.documentElement).appendChild(script);
    ymCall("init", {
      defer: true,
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: true,
      sendTitle: true
    });
  }

  function parseBody(options) {
    if (!options || typeof options.body !== "string") return null;
    return safeCall(() => JSON.parse(options.body)) || null;
  }

  function classifyError(status) {
    if (!status) return "network_error";
    if (status === 401 || status === 403) return "auth_error";
    if (status === 404) return "not_found";
    if (status === 408 || status === 504) return "timeout";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "server_error";
    return "request_error";
  }

  function handleJob(jobId, job) {
    if (!job || !job.status || sentTerminalJobs.has(jobId)) return;
    const ctx = jobContext.get(jobId);
    if (!ctx) return;
    if (!["completed", "completed_with_errors", "failed", "canceled"].includes(job.status)) return;
    sentTerminalJobs.add(jobId);

    if (ctx.kind === "portfolio_build") {
      if (job.status === "completed") {
        const count = Array.isArray(ctx.body && ctx.body.tickers) ? ctx.body.tickers.length : undefined;
        trackGoal(ctx.body && ctx.body.portfolio_id ? "portfolio_updated" : "portfolio_created", {
          instruments_count: count,
          selected_tickers_count: count,
          creation_type: ctx.body && ctx.body.portfolio_id ? "add_instruments" : "new"
        });
      }
      return;
    }

    if (ctx.kind === "backtest") {
      const body = ctx.body || {};
      const strategies = body.strategy_ids || body.strategies;
      const params = {
        instruments_count: Array.isArray(body.tickers) ? body.tickers.length : undefined,
        timeframe: body.timeframe,
        date_range: body.date_from || body.date_to ? [body.date_from || null, body.date_to || null] : undefined,
        strategies_count: Array.isArray(strategies) ? strategies.length : undefined,
        status: job.status
      };
      const result = job.result || {};
      if (job.status === "completed" || job.status === "completed_with_errors") {
        params.trades_count = result.trades_count || (result.summary && result.summary.trades_count);
        params.total_return = result.total_return || (result.summary && result.summary.total_return);
        params.win_rate = result.win_rate || (result.summary && result.summary.win_rate);
        params.max_drawdown = result.max_drawdown || (result.summary && result.summary.max_drawdown);
        params.duration_ms = Date.now() - ctx.startedAt;
        trackGoal("backtest_completed", params);
      } else if (job.status === "failed") {
        trackGoal("backtest_failed", {
          stage: job.stage,
          error_type: classifyError(job.http_status),
          http_status: job.http_status,
          instruments_count: params.instruments_count,
          timeframe: params.timeframe
        });
      }
    }
  }

  function installFetchObserver() {
    if (!global.fetch || global.fetch.__strategyLabAnalyticsWrapped) return;
    const originalFetch = global.fetch.bind(global);
    const wrapped = async function (input, options) {
      const method = String((options && options.method) || "GET").toUpperCase();
      const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
      const url = safeCall(() => new URL(rawUrl, global.location.origin));
      const body = parseBody(options);
      let response;
      try {
        response = await originalFetch(input, options);
      } catch (e) {
        if (url && /\/api\/(?:candles|market-data|securities|portfolios\/[^/]+\/instruments\/[^/]+\/download-data)/.test(url.pathname)) {
          trackGoal("market_data_load_failed", { ticker: body && body.ticker, timeframe: body && body.timeframe, source: "moex", error_type: "network_error" });
        }
        throw e;
      }

      safeCall(() => {
        if (!url || url.origin !== global.location.origin) return;
        const path = url.pathname;
        const clone = response.clone();
        clone.json().then((data) => {
          if (method === "POST" && path === "/api/portfolio/build" && response.ok && data && data.job_id) {
            jobContext.set(String(data.job_id), { kind: "portfolio_build", body: body || {}, startedAt: Date.now() });
          }
          if (method === "POST" && /^\/api\/portfolios\/[^/]+\/backtest$/.test(path) && response.ok && data && data.job_id) {
            const ctx = { kind: "backtest", body: body || {}, startedAt: Date.now() };
            jobContext.set(String(data.job_id), ctx);
            const strategyIds = body && (body.strategy_ids || body.strategies);
            trackGoal("backtest_started", {
              instruments_count: Array.isArray(body && body.tickers) ? body.tickers.length : undefined,
              timeframe: body && body.timeframe,
              date_range: body && (body.date_from || body.date_to) ? [body.date_from || null, body.date_to || null] : undefined,
              strategies_count: Array.isArray(strategyIds) ? strategyIds.length : undefined
            });
            if (Array.isArray(strategyIds) && strategyIds.length > 1) {
              trackGoal("multi_strategy_test_started", { strategies_count: strategyIds.length, strategy_ids: strategyIds.slice(0, 12) });
            }
          }
          const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
          if (method === "GET" && jobMatch && response.ok) handleJob(jobMatch[1], data);

          if (method === "PUT" && /^\/api\/portfolios\/[^/]+$/.test(path) && response.ok) trackGoal("portfolio_updated", {});
          if (method === "PATCH" && /^\/api\/portfolios\/[^/]+\/strategies$/.test(path) && response.ok) {
            const assignments = body && body.ticker_strategies;
            trackGoal("portfolio_strategy_assigned", { strategies_count: assignments && typeof assignments === "object" ? Object.keys(assignments).length : undefined });
          }
          if (method === "DELETE") {
            const m = path.match(/^\/api\/portfolios\/[^/]+\/instruments\/([^/]+)$/);
            if (m && response.ok) trackGoal("portfolio_instrument_removed", { ticker: decodeURIComponent(m[1]) });
          }
          if (method === "POST" && path === "/api/replay/sessions" && response.ok) {
            trackGoal("market_replay_started", { ticker: body && body.ticker, timeframe: body && body.timeframe, selected_start_date: body && body.start_date });
          }
          if (!response.ok && /\/api\/(?:candles|market-data|securities|portfolios\/[^/]+\/instruments\/[^/]+\/download-data)/.test(path)) {
            trackGoal("market_data_load_failed", { ticker: body && body.ticker, timeframe: body && body.timeframe, source: "moex", error_type: classifyError(response.status), http_status: response.status });
          }
        }).catch(function () { /* non-JSON response */ });
      });
      return response;
    };
    wrapped.__strategyLabAnalyticsWrapped = true;
    global.fetch = wrapped;
  }

  function installUiObserver() {
    document.addEventListener("click", function (event) {
      const tab = event.target.closest && event.target.closest("[data-tab]");
      if (tab && tab.dataset.tab) {
        trackVirtualPage(tab.dataset.tab);
        if (tab.dataset.tab === "charts") trackGoal("chart_analysis_opened", {});
        if (tab.dataset.tab === "replay") trackGoal("market_replay_opened", {});
      }
      if (event.target.closest && event.target.closest("#openAssignModalBtn")) trackGoal("portfolio_strategies_opened", {});
      if (event.target.closest && event.target.closest("[data-hist-open], [data-open-backtest], .open-backtest-result")) trackGoal("backtest_result_opened", {});
      if (event.target.closest && event.target.closest("[data-show-trades], [data-trade-chart], #openTradesChart")) trackGoal("backtest_trades_chart_opened", {});
      if (event.target.closest && event.target.closest("#mrPlayPause")) {
        const now = Date.now();
        const prev = pauseDedup.get("replay_toggle") || 0;
        if (now - prev > 1200) {
          pauseDedup.set("replay_toggle", now);
          const btn = event.target.closest("#mrPlayPause");
          if (btn && /pause|пауза/i.test(btn.textContent || "")) trackGoal("market_replay_paused", {});
        }
      }
    }, true);

    document.addEventListener("change", function (event) {
      const el = event.target;
      if (!el || !el.id) return;
      if (el.id === "backtestTimeframe") trackGoal("chart_timeframe_changed", { module: "backtest", timeframe: el.value });
      if (el.id === "mrTimeframe") trackGoal("chart_timeframe_changed", { module: "market_replay", timeframe: el.value });
    }, true);
  }

  const api = {
    q: [],
    enabled: enabled,
    counterId: COUNTER_ID,
    trackGoal: trackGoal,
    trackEvent: trackGoal,
    trackPageView: trackPageView,
    trackVirtualPage: trackVirtualPage,
    sanitizeUrl: sanitizeUrl
  };
  global.StrategyLabAnalytics = api;

  loadMetrika();
  installFetchObserver();
  installUiObserver();

  const savedTab = safeCall(() => localStorage.getItem("moexlab_active_tab"));
  if (global.location.pathname === "/") trackVirtualPage(savedTab || "portfolio");
  else trackPageView(global.location.href);

  queued.forEach((entry) => {
    if (!Array.isArray(entry) || !entry.length) return;
    const method = entry[0];
    const args = entry.slice(1);
    if (method === "goal") trackGoal.apply(null, args);
    if (method === "page") trackPageView.apply(null, args);
    if (method === "virtual") trackVirtualPage.apply(null, args);
  });
})(window);
