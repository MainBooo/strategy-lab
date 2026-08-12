(function (global) {
  "use strict";

  const COUNTER_ID = 111542935;
  const PROD_HOST = "strategylab.generationweb.ru";
  const enabled = global.location && global.location.hostname === PROD_HOST;
  const previous = global.StrategyLabAnalytics;
  const queued = previous && Array.isArray(previous.q) ? previous.q.slice() : [];
  const sentTerminalJobs = new Set();
  const replayFinishedSessions = new Set();
  const jobContext = new Map();
  const portfolioStrategyCache = new Map();
  const drawingManagersObserved = new WeakSet();
  const wrappedObjects = new WeakSet();
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

  function normalizeAssignments(raw) {
    const out = new Map();
    if (!raw || typeof raw !== "object") return out;
    Object.keys(raw).forEach((ticker) => {
      const rows = Array.isArray(raw[ticker]) ? raw[ticker] : [];
      rows.forEach((row) => {
        if (!row || row.enabled === false || !row.strategy_id) return;
        const key = ticker + "::" + row.strategy_id;
        out.set(key, {
          ticker: ticker,
          strategy_id: row.strategy_id,
          parameters: row.parameters || {}
        });
      });
    });
    return out;
  }

  function rememberPortfolio(portfolio) {
    if (!portfolio || !portfolio.id) return;
    portfolioStrategyCache.set(String(portfolio.id), normalizeAssignments(portfolio.ticker_strategies));
  }

  function strategyContext(portfolioId, tickers) {
    const assignments = portfolioStrategyCache.get(String(portfolioId)) || new Map();
    const allowed = new Set(Array.isArray(tickers) ? tickers : []);
    const rows = [];
    assignments.forEach((row) => {
      if (!allowed.size || allowed.has(row.ticker)) rows.push(row);
    });
    const ids = Array.from(new Set(rows.map((r) => r.strategy_id))).slice(0, 12);
    return { rows: rows, ids: ids, count: ids.length };
  }

  function handlePortfolioStrategySave(portfolioId, body) {
    const next = normalizeAssignments(body && body.ticker_strategies);
    const prev = portfolioStrategyCache.get(String(portfolioId)) || new Map();
    let added = 0;
    next.forEach((row, key) => {
      const old = prev.get(key);
      if (!old) {
        added += 1;
        trackGoal("strategy_selected", {
          strategy_id: row.strategy_id,
          ticker: row.ticker,
          module: "portfolio_strategies"
        });
        trackGoal("portfolio_strategy_assigned", {
          ticker: row.ticker,
          strategy: row.strategy_id,
          strategies_count: next.size
        });
        return;
      }
      if (JSON.stringify(old.parameters || {}) !== JSON.stringify(row.parameters || {})) {
        trackGoal("strategy_settings_changed", {
          strategy_id: row.strategy_id,
          ticker: row.ticker,
          module: "portfolio_strategies"
        });
      }
    });
    portfolioStrategyCache.set(String(portfolioId), next);
    if (!added && next.size !== prev.size) {
      trackGoal("portfolio_updated", { update_type: "strategy_assignments" });
    }
  }

  function handleJob(jobId, job) {
    if (!job || !job.status || sentTerminalJobs.has(jobId)) return;
    const ctx = jobContext.get(jobId);
    if (!ctx) return;
    if (!["completed", "completed_with_errors", "failed", "canceled"].includes(job.status)) return;
    sentTerminalJobs.add(jobId);

    if (ctx.kind === "portfolio_build") {
      if (job.status === "completed") {
        const tickers = Array.isArray(ctx.body && ctx.body.tickers) ? ctx.body.tickers : [];
        if (ctx.body && ctx.body.portfolio_id) {
          tickers.slice(0, 12).forEach((ticker) => trackGoal("portfolio_instrument_added", {
            ticker: ticker,
            board: "TQBR",
            source: "portfolio_build"
          }));
          trackGoal("portfolio_updated", {
            instruments_count: tickers.length,
            update_type: "instruments_added"
          });
        } else {
          trackGoal("portfolio_created", {
            instruments_count: tickers.length,
            selected_tickers_count: tickers.length,
            creation_type: "new"
          });
        }
      }
      return;
    }

    if (ctx.kind === "backtest") {
      const body = ctx.body || {};
      const params = {
        ticker: Array.isArray(body.tickers) && body.tickers.length === 1 ? body.tickers[0] : undefined,
        instruments_count: Array.isArray(body.tickers) ? body.tickers.length : undefined,
        timeframe: body.timeframe,
        date_range: body.date_from || body.date_to ? [body.date_from || null, body.date_to || null] : undefined,
        strategies_count: ctx.strategyCount,
        strategy: ctx.strategyIds && ctx.strategyIds.length === 1 ? ctx.strategyIds[0] : undefined,
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
          ticker: params.ticker,
          strategy: params.strategy,
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
        if (url && method === "POST" && /^\/api\/portfolios\/[^/]+\/backtest$/.test(url.pathname)) {
          trackGoal("backtest_failed", { stage: "start", error_type: "network_error" });
        }
        throw e;
      }

      safeCall(() => {
        if (!url || url.origin !== global.location.origin) return;
        const path = url.pathname;
        const clone = response.clone();
        clone.json().then((data) => {
          if (method === "GET" && path === "/api/portfolios" && response.ok && Array.isArray(data)) {
            data.forEach(rememberPortfolio);
          }
          const portfolioGet = path.match(/^\/api\/portfolios\/([^/]+)$/);
          if (method === "GET" && portfolioGet && response.ok) rememberPortfolio(data);

          if (method === "POST" && path === "/api/portfolio/build" && response.ok && data && data.job_id) {
            jobContext.set(String(data.job_id), { kind: "portfolio_build", body: body || {}, startedAt: Date.now() });
          }

          const backtestStart = path.match(/^\/api\/portfolios\/([^/]+)\/backtest$/);
          if (method === "POST" && backtestStart) {
            if (!response.ok) {
              trackGoal("backtest_failed", {
                stage: "start",
                error_type: classifyError(response.status),
                http_status: response.status,
                ticker: Array.isArray(body && body.tickers) && body.tickers.length === 1 ? body.tickers[0] : undefined,
                timeframe: body && body.timeframe
              });
            } else if (data && data.job_id) {
              const strategies = strategyContext(backtestStart[1], body && body.tickers);
              const ctx = {
                kind: "backtest",
                body: body || {},
                startedAt: Date.now(),
                strategyIds: strategies.ids,
                strategyCount: strategies.count
              };
              jobContext.set(String(data.job_id), ctx);
              trackGoal("backtest_started", {
                ticker: Array.isArray(body && body.tickers) && body.tickers.length === 1 ? body.tickers[0] : undefined,
                instruments_count: Array.isArray(body && body.tickers) ? body.tickers.length : undefined,
                timeframe: body && body.timeframe,
                date_range: body && (body.date_from || body.date_to) ? [body.date_from || null, body.date_to || null] : undefined,
                strategy: strategies.ids.length === 1 ? strategies.ids[0] : undefined,
                strategies_count: strategies.count
              });
              if (strategies.count > 1) {
                trackGoal("multi_strategy_test_started", {
                  ticker: Array.isArray(body && body.tickers) && body.tickers.length === 1 ? body.tickers[0] : undefined,
                  strategies_count: strategies.count,
                  strategy_ids: strategies.ids
                });
              }
            }
          }

          const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
          if (method === "GET" && jobMatch && response.ok) handleJob(jobMatch[1], data);

          if (method === "PUT" && /^\/api\/portfolios\/[^/]+$/.test(path) && response.ok) trackGoal("portfolio_updated", { update_type: "saved_edit" });
          const strategyPatch = path.match(/^\/api\/portfolios\/([^/]+)\/strategies$/);
          if (method === "PATCH" && strategyPatch && response.ok) handlePortfolioStrategySave(strategyPatch[1], body || {});

          if (method === "DELETE") {
            const m = path.match(/^\/api\/portfolios\/[^/]+\/instruments\/([^/]+)$/);
            if (m && response.ok) trackGoal("portfolio_instrument_removed", { ticker: decodeURIComponent(m[1]) });
          }

          if (method === "POST" && path === "/api/replay/sessions" && response.ok) {
            trackGoal("market_replay_started", {
              ticker: body && body.ticker,
              timeframe: body && body.timeframe,
              selected_start_date: body && body.start_date
            });
          }
          const replayStep = path.match(/^\/api\/replay\/sessions\/([^/]+)\/step$/);
          if (method === "POST" && replayStep && response.ok && data && data.finished && !replayFinishedSessions.has(replayStep[1])) {
            replayFinishedSessions.add(replayStep[1]);
            trackGoal("market_replay_finished", {
              ticker: data.session && data.session.ticker,
              timeframe: data.session && data.session.timeframe
            });
          }

          const backtestBase = path.match(/^\/api\/backtests\/([^/]+)$/);
          if (method === "GET" && backtestBase && response.ok) trackGoal("backtest_result_opened", {});
          if (method === "GET" && /^\/api\/backtests\/[^/]+\/candles$/.test(path) && response.ok) trackGoal("backtest_trades_chart_opened", {});
          if (method === "GET" && /^\/api\/backtests\/[^/]+\/trades\/\d+$/.test(path) && response.ok) trackGoal("backtest_trade_opened", {});

          if (!response.ok && /\/api\/(?:candles|market-data|securities|portfolios\/[^/]+\/instruments\/[^/]+\/download-data)/.test(path)) {
            const tickerFromPath = safeCall(() => decodeURIComponent((path.match(/\/instruments\/([^/]+)\//) || [])[1] || "")) || undefined;
            trackGoal("market_data_load_failed", {
              ticker: tickerFromPath || (body && body.ticker),
              timeframe: body && body.timeframe,
              source: "moex",
              error_type: classifyError(response.status),
              http_status: response.status
            });
          }
        }).catch(function () { /* non-JSON response */ });
      });
      return response;
    };
    wrapped.__strategyLabAnalyticsWrapped = true;
    global.fetch = wrapped;
  }

  function semanticDrawingType(type) {
    return type === "circle" ? "ellipse" : type;
  }

  function observeDrawingManager(tile) {
    const mgr = tile && tile.drawingMgr;
    if (!mgr || drawingManagersObserved.has(mgr) || typeof mgr.onChange !== "function") return;
    drawingManagersObserved.add(mgr);
    mgr.onChange(function (manager, detail) {
      if (!detail || !detail.created) return;
      const drawing = Array.isArray(manager.drawings) ? manager.drawings.find((d) => d.id === detail.created) : null;
      if (!drawing || !drawing.type) return;
      trackGoal("chart_drawing_created", {
        ticker: tile.symbol,
        drawing_type: semanticDrawingType(drawing.type)
      });
    });
  }

  function wrapMethod(obj, method, after) {
    if (!obj || typeof obj[method] !== "function") return;
    const original = obj[method];
    if (original.__strategyLabAnalyticsWrapped) return;
    const wrapped = function () {
      const args = Array.prototype.slice.call(arguments);
      const before = safeCall(() => ({
        symbol: this.activeTile && this.activeTile.symbol,
        timeframe: this.activeTile && this.activeTile.timeframe,
        layoutMode: this.layoutMode
      })) || {};
      const result = original.apply(this, args);
      safeCall(() => after.call(this, args, before, result));
      return result;
    };
    wrapped.__strategyLabAnalyticsWrapped = true;
    obj[method] = wrapped;
  }

  function installChartHooks() {
    const page = global.ChartAnalysisPage;
    if (!page) return;
    (page.tiles || []).forEach(observeDrawingManager);
    if (wrappedObjects.has(page)) return;
    wrappedObjects.add(page);

    wrapMethod(page, "_commandSelectTicker", function (args, before) {
      const ticker = args[0];
      if (ticker && ticker !== before.symbol) trackGoal("chart_ticker_changed", { ticker: ticker });
      setTimeout(() => (this.tiles || []).forEach(observeDrawingManager), 0);
    });
    wrapMethod(page, "_commandSetTimeframe", function (args, before) {
      const timeframe = args[0];
      if (timeframe && timeframe !== before.timeframe) {
        trackGoal("chart_timeframe_changed", { ticker: before.symbol, timeframe: timeframe });
      }
    });
    wrapMethod(page, "_setLayout", function (args, before) {
      const layout = args[0];
      if (layout && layout !== before.layoutMode) {
        trackGoal("chart_layout_changed", {
          charts_count: Array.isArray(this.tiles) ? this.tiles.length : undefined,
          layout: layout
        });
      }
      setTimeout(() => (this.tiles || []).forEach(observeDrawingManager), 0);
    });
    wrapMethod(page, "_onFullscreenChange", function (args) {
      if (args[0] === true) trackGoal("chart_fullscreen_opened", {});
    });
  }

  function installReplayHooks() {
    const page = global.MarketReplayPage;
    if (!page || wrappedObjects.has(page)) return;
    wrappedObjects.add(page);
    wrapMethod(page, "_togglePlay", function (args, before) {
      if (this.playing) return;
      const now = Date.now();
      const prev = pauseDedup.get("replay_pause") || 0;
      if (now - prev > 1200 && this.state && !this.state.finished) {
        pauseDedup.set("replay_pause", now);
        trackGoal("market_replay_paused", {
          ticker: this.state.session && this.state.session.ticker,
          timeframe: this.state.session && this.state.session.timeframe
        });
      }
    });
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
      if (event.target.closest && event.target.closest("[data-assign-configure]")) {
        const btn = event.target.closest("[data-assign-configure]");
        trackGoal("strategy_settings_opened", {
          ticker: btn.dataset.assignConfigure,
          strategy_id: btn.dataset.strategyId,
          module: "portfolio_strategies"
        });
      }
      const libraryHeader = event.target.closest && event.target.closest("[data-toggle-strategy]");
      if (libraryHeader && libraryHeader.dataset.toggleStrategy) {
        trackGoal("strategy_settings_opened", {
          strategy_id: libraryHeader.dataset.toggleStrategy,
          module: "strategy_library"
        });
      }
    }, false);

    document.addEventListener("change", function (event) {
      const el = event.target;
      if (!el) return;
      if (el.matches && el.matches("#gtIndicatorsPop input[data-ind]") && el.checked) {
        const page = global.ChartAnalysisPage;
        const tile = page && page.activeTile;
        const exists = tile && tile.indicatorMgr && tile.indicatorMgr.list().some((item) => item.type === el.dataset.ind);
        if (exists) trackGoal("chart_indicator_added", { ticker: tile.symbol, indicator: el.dataset.ind });
      }
    }, false);
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

  const hookTimer = setInterval(function () {
    installChartHooks();
    installReplayHooks();
    const page = global.ChartAnalysisPage;
    if (page && Array.isArray(page.tiles)) page.tiles.forEach(observeDrawingManager);
  }, 750);
  global.addEventListener("pagehide", function () { clearInterval(hookTimer); }, { once: true });

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
