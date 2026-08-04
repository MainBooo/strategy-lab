/* Indicator math + registry + pane manager, kept separate from rendering
 * per module (calc functions are pure: candles[] -> numbers[]).
 *
 * ATR and RSI here intentionally use the exact same formulas as the
 * backtest engine (strategies/common.py add_atr, strategies/
 * simple_strategies.py _rsi - both plain rolling means, not Wilder
 * smoothing) so a strategy's ATR-based stop or an RSI-reversal signal
 * looks the same on this chart as it did to the backtester. SMA/EMA/MACD/
 * Bollinger/Donchian aren't used by any strategy today, so there is
 * nothing in the engine to stay consistent with; they use their standard
 * textbook definitions. */
(function (global) {
  "use strict";

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

  function macd(candles, fast, slow, signal) {
    const close = closes(candles);
    const emaFast = ema(close, fast);
    const emaSlow = ema(close, slow);
    const line = close.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
    const firstValid = line.findIndex((v) => v != null);
    const signalLine = ema(line.map((v) => (v == null ? null : v)), signal);
    const histogram = line.map((v, i) => (v != null && signalLine[i] != null ? v - signalLine[i] : null));
    return { line, signal: signalLine, histogram, firstValid };
  }

  function bollinger(candles, period, mult) {
    const close = closes(candles);
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

  const REGISTRY = [
    { id: "sma", label: "SMA", defaultParams: { period: 20 }, kind: "overlay" },
    { id: "ema", label: "EMA", defaultParams: { period: 20 }, kind: "overlay" },
    { id: "bollinger", label: "Bollinger Bands", defaultParams: { period: 20, mult: 2 }, kind: "overlay" },
    { id: "donchian", label: "Donchian Channel", defaultParams: { period: 20 }, kind: "overlay" },
    { id: "rsi", label: "RSI", defaultParams: { period: 14 }, kind: "pane" },
    { id: "macd", label: "MACD", defaultParams: { fast: 12, slow: 26, signal: 9 }, kind: "pane" },
    { id: "atr", label: "ATR", defaultParams: { period: 14 }, kind: "pane" },
    { id: "volume", label: "Объём", defaultParams: {}, kind: "toggle" },
  ];

  function compute(id, candles, params) {
    switch (id) {
      case "sma": return { main: sma(closes(candles), params.period) };
      case "ema": return { main: ema(closes(candles), params.period) };
      case "bollinger": return bollinger(candles, params.period, params.mult);
      case "donchian": return donchian(candles, params.period);
      case "rsi": return { main: rsi(candles, params.period) };
      case "macd": return macd(candles, params.fast, params.slow, params.signal);
      case "atr": return { main: atr(candles, params.period) };
      default: throw new Error(`Неизвестный индикатор: ${id}`);
    }
  }

  /** Attaches/detaches indicator series on a ChartCore instance, recomputing on data changes. */
  class IndicatorPaneManager {
    constructor(chartCore) {
      this.core = chartCore;
      this.instances = new Map(); // instanceId -> {def, params, series:[], paneIndex}
      this._nextPane = 1;
      this._unsub = chartCore.onDataChanged(() => this._recomputeAll());
    }

    list() {
      return [...this.instances.entries()].map(([id, inst]) => ({ id, type: inst.def.id, params: inst.params }));
    }

    add(typeId, params, instanceId) {
      const def = REGISTRY.find((d) => d.id === typeId);
      if (!def) throw new Error(`Неизвестный индикатор: ${typeId}`);
      const id = instanceId || `${typeId}_${Math.random().toString(36).slice(2, 9)}`;
      const merged = Object.assign({}, def.defaultParams, params || {});
      if (def.kind === "toggle") {
        if (typeId === "volume" && this.core.volumeSeries) this.core.volumeSeries.applyOptions({ visible: true });
        this.instances.set(id, { def, params: merged, series: [] });
        return id;
      }
      const paneIndex = def.kind === "pane" ? this._nextPane++ : 0;
      const series = this._createSeries(def, merged, paneIndex);
      this.instances.set(id, { def, params: merged, series, paneIndex });
      this._computeInto(id);
      return id;
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

    updateParams(id, params) {
      const inst = this.instances.get(id);
      if (!inst) return;
      inst.params = Object.assign({}, inst.params, params);
      this._computeInto(id);
    }

    _createSeries(def, params, paneIndex) {
      const LWC = global.LightweightCharts;
      const palette = ["#7c8cff", "#4dd4ac", "#ffb454", "#ff7081", "#8de3ff"];
      const opts = { lastValueVisible: false, priceLineVisible: false };
      switch (def.id) {
        case "sma":
        case "ema":
          return [this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: palette[0] }), paneIndex)];
        case "bollinger":
          return [
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: palette[0], lineWidth: 1 }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: "#5b6478", lineWidth: 1 }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: palette[0], lineWidth: 1 }), paneIndex),
          ];
        case "donchian":
          return [
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: palette[3], lineWidth: 1 }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: palette[1], lineWidth: 1 }), paneIndex),
          ];
        case "rsi":
        case "atr":
          return [this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: palette[0] }), paneIndex)];
        case "macd":
          return [
            this.core.chart.addSeries(LWC.HistogramSeries, Object.assign({}, opts, { color: palette[1] }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: palette[0] }), paneIndex),
            this.core.chart.addSeries(LWC.LineSeries, Object.assign({}, opts, { color: palette[3] }), paneIndex),
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
        case "sma":
        case "ema":
        case "rsi":
        case "atr":
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
        case "macd":
          inst.series[0].setData(
            candles.map((c, i) => ({ time: c.time, value: result.histogram[i] || 0, color: (result.histogram[i] || 0) >= 0 ? "#4dd4ac" : "#ff7081" }))
          );
          inst.series[1].setData(toPoints(result.line));
          inst.series[2].setData(toPoints(result.signal));
          break;
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
    compute,
    calc: { sma, ema, rsi, atr, macd, bollinger, donchian },
    PaneManager: IndicatorPaneManager,
  };
})(window);
