/* Chart engine: theme tokens shared by the trade chart and the analysis
 * module. Values are lifted from static/styles.css :root so both modules
 * render on the same dark palette as the rest of Strategy Lab
 * instead of lightweight-charts' defaults. The app only has a dark theme
 * today (no light-mode toggle exists), so that's all this covers. */
(function (global) {
  "use strict";

  const theme = {
    bg: "#0c1019",
    panelBg: "#111725",
    text: "#f4f7fb",
    muted: "#9ea9bb",
    line: "rgba(255,255,255,.09)",
    accent: "#7c8cff",
    up: "#4dd4ac",
    down: "#ff7081",
    upSoft: "rgba(77,212,172,.14)",
    downSoft: "rgba(255,112,129,.14)",
    crosshair: "#c8cfe0",
  };

  /* Candle/trade timestamps are naive MOEX exchange-local (MSK) datetimes
   * encoded as if they were UTC (see candle_api.py / backtests_db.py: no
   * tz-aware datetime exists anywhere in this app, entry_datetime is a
   * naive string straight from MOEX). If lightweight-charts formatted
   * labels in the *browser's* local timezone, a viewer outside MSK would
   * see the wrong wall-clock hour. Forcing UTC formatting here makes the
   * displayed time equal the naive MSK string everywhere, regardless of
   * the viewer's browser timezone. */
  function formatTime(unixSeconds, withDate) {
    const d = new Date(unixSeconds * 1000);
    const date = d.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
    const time = d.toLocaleTimeString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
    if (withDate === "date-only") return date;
    if (withDate === "time-only") return time;
    return `${date} ${time}`;
  }

  function chartOptions(overrides) {
    return Object.assign(
      {
        localization: {
          timeFormatter: (t) => formatTime(t),
        },
        layout: {
          background: { color: "transparent" },
          textColor: theme.muted,
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          panes: { separatorColor: theme.line, separatorHoverColor: "rgba(124,140,255,.18)" },
        },
        grid: {
          vertLines: { color: theme.line },
          horzLines: { color: theme.line },
        },
        crosshair: {
          mode: 0,
          vertLine: { color: theme.crosshair, width: 1, style: 2, labelBackgroundColor: "#1c2434" },
          horzLine: { color: theme.crosshair, width: 1, style: 2, labelBackgroundColor: "#1c2434" },
        },
        rightPriceScale: { borderColor: theme.line },
        timeScale: {
          borderColor: theme.line,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4,
          tickMarkFormatter: (time, tickMarkType) => {
            const d = new Date(time * 1000);
            const get = (opt) => d.toLocaleString("ru-RU", Object.assign({ timeZone: "UTC" }, opt));
            switch (tickMarkType) {
              case 0: return get({ year: "numeric" });
              case 1: return get({ month: "short" });
              case 2: return get({ day: "2-digit", month: "short" });
              default: return get({ hour: "2-digit", minute: "2-digit" });
            }
          },
        },
        autoSize: false,
      },
      overrides || {}
    );
  }

  function candlestickOptions(overrides) {
    return Object.assign(
      {
        upColor: theme.up,
        downColor: theme.down,
        borderUpColor: theme.up,
        borderDownColor: theme.down,
        wickUpColor: theme.up,
        wickDownColor: theme.down,
      },
      overrides || {}
    );
  }

  global.ChartEngine = global.ChartEngine || {};
  global.ChartEngine.theme = theme;
  global.ChartEngine.chartOptions = chartOptions;
  global.ChartEngine.candlestickOptions = candlestickOptions;
  global.ChartEngine.formatTime = formatTime;
  /** Inverse of the naive-MSK-as-UTC encoding used throughout the backend
   * (backtest_trades.entry_datetime etc. are naive "YYYY-MM-DD HH:MM:SS"
   * strings with no timezone). Appending "Z" makes the browser parse the
   * digits as UTC instead of its own local timezone, matching Python's
   * pd.Timestamp(naive_str).timestamp(). */
  global.ChartEngine.parseNaiveDatetime = function parseNaiveDatetime(str) {
    if (!str) return null;
    const iso = String(str).replace(" ", "T");
    const ms = Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
    return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
  };
})(window);
