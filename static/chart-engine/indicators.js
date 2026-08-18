/* Indicator math + registry + pane manager, kept separate from rendering
 * per module (calc functions are pure: candles[] -> numbers[]).
 *
 * ATR and RSI here intentionally use the exact same formulas as the
 * backtest engine (strategies/common.py add_atr, strategies/
 * simple_strategies.py _rsi - both plain rolling means, not Wilder
 * smoothing) so a strategy's ATR-based stop or an RSI-reversal signal
 * looks the same on this chart as it did to the backtester. SMA/EMA/WMA/
 * MACD/Bollinger/Donchian/Stochastic/Momentum/VWAP aren't used by any
 * strategy today, so there is nothing in the engine to stay consistent
 * with; they use their standard textbook definitions. */
(function (global) {
  "use strict";

  const SOURCES = [
    { id: "close", label: "Close" }, { id: "open", label: "Open" },
    { id: "high", label: "High" }, { id: "low", label: "Low" },
    { id: "hl2", label: "HL/2" }, { id: "hlc3", label: "HLC/3" }, { id: "ohlc4", label: "OHLC/4" },
  ];

  function sourceValue(c, source) {
    switch (source) {
      case "open": return c.open;
      case "high": return c.high;
      case "low": return c.low;
      case "hl2": return (c.high + c.low) / 2;
      case "hlc3": return (c.high + c.low + c.close) / 3;
      case "ohlc4": return (c.open + c.high + c.low + c.close) / 4;
      default: return c.close;
    }
  }
  function sourceSeries(candles, source) {
    return candles.map((c) => sourceValue(c, source));
  }
  function closes(candles) {
    return candles.map((c) => c.close);
  }

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const alpha = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      if (values[i] == null) continue;
      prev = prev == null ? values[i] : values[i] * alpha + prev * (1 - alpha);
      out[i] = prev;
    }
    return out;
  }

  /** Linearly-weighted moving average - most recent bar gets weight `period`,
   * oldest in the window gets weight 1. Standard textbook WMA. */
  function wma(values, period) {
    const out = new Array(values.length).fill(null);
    const denom = (period * (period + 1)) / 2;
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[i - j] * (period - j);
      out[i] = sum / denom;
    }
    return out;
  }

  function stddev(values, period, meanSeries) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      const mean = meanSeries[i];
      if (mean == null) continue;
      let sumSq = 0;
      for (let j = i - period + 1; j <= i; j++) sumSq += (values[j] - mean) ** 2;
      out[i] = Math.sqrt(sumSq / period);
    }
    return out;
  }

  /** Rolling mean of true range, min_periods=period - mirrors add_atr() in strategies/common.py exactly. */
  function atr(candles, period) {
    const tr = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const prevClose = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    });
    return sma(tr, period);
  }

  /** Rolling-mean RSI (not Wilder) - mirrors _rsi() in strategies/simple_strategies.py exactly. */
  function rsi(candles, period) {
    const close = closes(candles);
    const gains = new Array(close.length).fill(0);
    const losses = new Array(close.length).fill(0);
    for (let i = 1; i < close.length; i++) {
      const delta = close[i] - close[i - 1];
      gains[i] = Math.max(delta, 0);
      losses[i] = Math.max(-delta, 0);
    }
    const avgGain = sma(gains, period);
    const avgLoss = sma(losses, period);
    return close.map((_, i) => {
      if (avgGain[i] == null || avgLoss[i] == null) return null;
      if (avgLoss[i] === 0) return 100;
      const rs = avgGain[i] / avgLoss[i];
      return 100 - 100 / (1 + rs);
    });
  }

  function macd(candles, fast, slow, signal, source) {
    const close = sourceSeries(candles, source);
    const emaFast = ema(close, fast);
    const emaSlow = ema(close, slow);
    const line = close.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
    const signalLine = ema(line.map((v) => (v == null ? null : v)), signal);
    const histogram = line.map((v, i) => (v != null && signalLine[i] != null ? v - signalLine[i] : null));
    return { line, signal: signalLine, histogram };
  }

  function bollinger(candles, period, mult, source) {
    const close = sourceSeries(candles, source);
    const mid = sma(close, period);
    const dev = stddev(close, period, mid);
    const upper = mid.map((m, i) => (m != null && dev[i] != null ? m + mult * dev[i] : null));
    const lower = mid.map((m, i) => (m != null && dev[i] != null ? m - mult * dev[i] : null));
    return { mid, upper, lower };
  }

  function donchian(candles, period) {
    const upper = new Array(candles.length).fill(null);
    const lower = new Array(candles.length).fill(null);
    for (let i = period - 1; i < candles.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        hi = Math.max(hi, candles[j].high);
        lo = Math.min(lo, candles[j].low);
      }
      upper[i] = hi;
      lower[i] = lo;
    }
    return { upper, lower };
  }

  /** %K = position of close within the period's high/low range (0-100),
   * %D = SMA of %K - standard "slow" stochastic (no extra %K smoothing). */
  function stochastic(candles, kPeriod, dPeriod) {
    const k = new Array(candles.length).fill(null);
    for (let i = kPeriod - 1; i < candles.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
      const range = hi - lo;
      k[i] = range ? ((candles[i].close - lo) / range) * 100 : 50;
    }
    const d = sma(k.map((v) => (v == null ? null : v)), dPeriod);
    return { k, d };
  }

  /** Momentum: close now vs close `period` bars ago (absolute difference,
   * the standard textbook definition - not the rate-of-change % variant). */
  function momentum(candles, period, source) {
    const src = sourceSeries(candles, source);
    const out = new Array(src.length).fill(null);
    for (let i = period; i < src.length; i++) out[i] = src[i] - src[i - period];
    return out;
  }

  /** Session VWAP: cumulative (typical price × volume) / cumulative volume,
   * resetting at each new exchange day - candle.time is naive-MSK-as-UTC
   * (see theme.js), so a UTC day boundary on that timestamp IS the MSK
   * trading-day boundary, no extra timezone math needed. */
  function vwap(candles) {
    const out = new Array(candles.length).fill(null);
    let cumPV = 0, cumV = 0, lastDay = null;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const day = Math.floor(c.time / 86400);
      if (day !== lastDay) { cumPV = 0; cumV = 0; lastDay = day; }
      const typical = (c.high + c.low + c.close) / 3;
      cumPV += typical * (c.volume || 0);
      cumV += c.volume || 0;
      out[i] = cumV ? cumPV / cumV : typical;
    }
    return out;
  }

  const REGISTRY = [
    { id: "sma", label: "SMA", defaultParams: { period: 20, source: "close" }, kind: "overlay", sourceParam: true },
    { id: "ema", label: "EMA", defaultParams: { period: 20, source: "close" }, kind: "overlay", sourceParam: true },
    { id: "wma", label: "WMA", defaultParams: { period: 20, source: "close" }, kind: "overlay", sourceParam: true },
    { id: "vwap", label: "VWAP", defaultParams: {}, kind: "overlay" },
    { id: "bollinger", label: "Bollinger Bands", defaultParams: { period: 20, mult: 2, source: "close" }, kind: "overlay", sourceParam: true },
    { id: "donchian", label: "Donchian Channel", defaultParams: { period: 20 }, kind: "overlay" },
    { id: "rsi", label: "RSI", defaultParams: { period: 14 }, kind: "pane" },
    { id: "macd", label: "MACD", defaultParams: { fast: 12, slow: 26, signal: 9, source: "close" }, kind: "pane", sourceParam: true },
    { id: "atr", label: "ATR", defaultParams: { period: 14 }, kind: "pane" },
    { id: "stochastic", label: "Stochastic", defaultParams: { kPeriod: 14, dPeriod: 3 }, kind: "pane" },
    { id: "momentum", label: "Momentum", defaultParams: { period: 10, source: "close" }, kind: "pane", sourceParam: true },
    { id: "volume", label: "Объём", defaultParams: {}, kind: "toggle" },
  ];

  function compute(id, candles, params) {
    switch (id) {
      case "sma": return { main: sma(sourceSeries(candles, params.source), params.period) };
      case "ema": return { main: ema(sourceSeries(candles, params.source), params.period) };
      case "wma": return { main: wma(sourceSeries(candles, params.source), params.period) };
      case "vwap": return { main: vwap(candles) };
      case "bollinger": return bollinger(candles, params.period, params.mult, params.source);
      case "donchian": return donchian(candles, params.period);
      case "rsi": return { main: rsi(candles, params.period) };
      case "macd": return macd(candles, params.fast, params.slow, params.signal, params.source);
      case "atr": return { main: atr(candles, params.period) };
      case "stochastic": return stochastic(candles, params.kPeriod, params.dPeriod);
      case "momentum": return { main: momentum(candles, params.period, params.source) };
      default: throw new Error(`Неизвестный индикатор: ${id}`);
    }
  }

  const DEFAULT_PALETTE = ["#7c8cff", "#4dd4ac", "#ffb454", "#ff7081", "#8de3ff", "#c792ea"];

  /** Attaches/detaches indicator series on a ChartCore instance, recomputing
   * on data changes. Each instance carries its own `style` (color(s)/width)
   * independent of every other instance - two SMAs on the same tile can
   * have different colors, and changing one never touches the other. */
  class IndicatorPaneManager {
    constructor(chartCore) {
      this.core = chartCore;
      this.instances = new Map(); // instanceId -> {def, params, style, series:[], paneIndex}
      this._nextPane = 1;
      this._paletteCursor = 0;
      this._unsub = chartCore.onDataChanged(() => this._recomputeAll());
    }

    list() {
      return [...this.instances.entries()].map(([id, inst]) => ({ id, type: inst.def.id, params: inst.params, style: inst.style }));
    }

    add(typeId, params, instanceId, style) {
      const def = REGISTRY.find((d) => d.id === typeId);
      if (!def) throw new Error(`Неизвестный индикатор: ${typeId}`);
      const id = instanceId || `${typeId}_${Math.random().toString(36).slice(2, 9)}`;
      const merged = Object.assign({}, def.defaultParams, params || {});
      const resolvedStyle = Object.assign({ width: 1 }, this._defaultStyle(def), style || {});
      if (def.kind === "toggle") {
        if (typeId === "volume" && this.core.volumeSeries) this.core.volumeSeries.applyOptions({ visible: true });
        this.instances.set(id, { def, params: merged, style: resolvedStyle, series: [] });
        return id;
      }
      const paneIndex = def.kind === "pane" ? this._nextPane++ : 0;
      const series = this._createSeries(def, resolvedStyle, paneIndex);
      this.instances.set(id, { def, params: merged, style: resolvedStyle, series, paneIndex });
      this._computeInto(id);
      return id;
    }

    _defaultStyle(def) {
      const n = def.id === "bollinger" ? 3 : def.id === "donchian" ? 2 : def.id === "macd" ? 3 : def.id === "stochastic" ? 2 : 1;
      const colors = [];
      for (let i = 0; i < n; i++) colors.push(DEFAULT_PALETTE[(this._paletteCursor + i) % DEFAULT_PALETTE.length]);
      this._paletteCursor = (this._paletteCursor + 1) % DEFAULT_PALETTE.length;
      return n === 1 ? { color: colors[0] } : { colors };
    }

    remove(id) {
      const inst = this.instances.get(id);
      if (!inst) return;
      if (inst.def.id === "volume") {
        if (this.core.volumeSeries) this.core.volumeSeries.applyOptions({ visible: false });
      } else {
        inst.series.forEach((s) => this.core.chart.removeSeries(s));
      }
      this.instances.delete(id);
    }

    /** Hide/show family menu (chart rail "eye" action, see chart-editor-
     * terminal-mobile-v2.js): unlike drawings, indicator instances never had
     * a persistent hidden flag - series.applyOptions({visible}) already
     * exists per-type (volume's own toggle above), this just generalizes it
     * to every series kind and tracks the flag so allHidden() can drive the
     * rail's pressed state. */
    setVisible(id, visible) {
      const inst = this.instances.get(id);
      if (!inst) return;
      inst.hidden = !visible;
      if (inst.def.id === "volume") {
        if (this.core.volumeSeries) this.core.volumeSeries.applyOptions({ visible });
      } else {
        inst.series.forEach((s) => s.applyOptions({ visible }));
      }
    }

    setAllVisible(visible) {
      this.instances.forEach((inst, id) => this.setVisible(id, visible));
    }

    allHidden() {
      return this.instances.size > 0 && [...this.instances.values()].every((inst) => inst.hidden);
    }

    updateParams(id, params) {
      const inst = this.instances.get(id);
      if (!inst) return;
      inst.params = Object.assign({}, inst.params, params);
      this._computeInto(id);
    }

    /** Color/width changes apply via series.applyOptions() - never recreates
     * the series, so zoom/pane layout/other instances are untouched. */
    updateStyle(id, style) {
      const inst = this.instances.get(id);
      if (!inst || !inst.series.length) return;
      inst.style = Object.assign({}, inst.style, style);
      if (inst.style.width != null) inst.series.forEach((s) => s.applyOptions({ lineWidth: inst.style.width }));
      if (inst.style.color) inst.series[0].applyOptions({ color: inst.style.color });
      if (inst.style.colors) inst.style.colors.forEach((c, i) => { if (inst.series[i]) inst.series[i].applyOptions({ color: c }); });
      if (inst.def.id === "macd" && inst.style.colors) this._computeInto(id); // histogram colors are per-bar, recomputed not applyOptions'd
    }

    _createSeries(def, style, paneIndex) {
      const LWC = global.LightweightCharts;
      const opts = { lastValueVisible: false, priceLineVisible: false, lineWidth: style.width || 1 };
      const c = (i) => (style.colors ? style.colors[i] : style.color) || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
      switch (def.id) {
        case "sma": case "ema": case "wma": case "vwap": case "rsi": case "atr": case "momentum":
          return [this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(0) }), paneIndex)];
        case "bollinger":
          return [
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(0) }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(1) }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(2) }), paneIndex),
          ];
        case "donchian":
          return [
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(0) }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(1) }), paneIndex),
          ];
        case "stochastic":
          return [
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(0) }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(1) }), paneIndex),
          ];
        case "macd":
          return [
            this.core.chart.addSeries(LWC.HistogramSeries, Object.assign({}, opts, { color: c(1) }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(0) }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: c(2) }), paneIndex),
          ];
        default:
          return [];
      }
    }

    _computeInto(id) {
      const inst = this.instances.get(id);
      if (!inst || inst.def.kind === "toggle") return;
      const candles = this.core.candles;
      if (!candles.length) return;
      const result = compute(inst.def.id, candles, inst.params);
      const toPoints = (arr) =>
        candles.map((c, i) => ({ time: c.time, value: arr[i] })).filter((p) => p.value != null && Number.isFinite(p.value));
      switch (inst.def.id) {
        case "sma": case "ema": case "wma": case "vwap": case "rsi": case "atr": case "momentum":
          inst.series[0].setData(toPoints(result.main));
          break;
        case "bollinger":
          inst.series[0].setData(toPoints(result.upper));
          inst.series[1].setData(toPoints(result.mid));
          inst.series[2].setData(toPoints(result.lower));
          break;
        case "donchian":
          inst.series[0].setData(toPoints(result.upper));
          inst.series[1].setData(toPoints(result.lower));
          break;
        case "stochastic":
          inst.series[0].setData(toPoints(result.k));
          inst.series[1].setData(toPoints(result.d));
          break;
        case "macd": {
          // Only the up-color is user-customizable (colors[1], the
          // histogram slot) - the down-color stays fixed at the theme's
          // "down" red so a positive/negative histogram bar is always
          // distinguishable even if someone picks similar up/line colors.
          const histColor = (inst.style.colors && inst.style.colors[1]) || DEFAULT_PALETTE[1];
          const histColorDown = "#ff7081";
          inst.series[0].setData(
            candles.map((c, i) => ({ time: c.time, value: result.histogram[i] || 0, color: (result.histogram[i] || 0) >= 0 ? histColor : histColorDown }))
          );
          inst.series[1].setData(toPoints(result.line));
          inst.series[2].setData(toPoints(result.signal));
          break;
        }
      }
    }

    _recomputeAll() {
      for (const id of this.instances.keys()) this._computeInto(id);
    }

    destroy() {
      this._unsub();
      for (const id of [...this.instances.keys()]) this.remove(id);
    }
  }

  global.ChartEngine.Indicators = {
    registry: REGISTRY,
    sources: SOURCES,
    compute,
    calc: { sma, ema, wma, rsi, atr, macd, bollinger, donchian, stochastic, momentum, vwap },
    PaneManager: IndicatorPaneManager,
  };
})(window);
