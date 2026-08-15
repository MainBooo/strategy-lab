/* Strategy Lab technical-indicator extension.
 * Extends the existing registry/PaneManager; does not create another chart state.
 */
(function (g) {
  "use strict";
  const CE = g.ChartEngine;
  const I = CE && CE.Indicators;
  if (!I || I.__slExpandedV2) return;
  I.__slExpandedV2 = true;

  const finite = Number.isFinite;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const source = (candles, key = "close") => candles.map((c) => {
    if (key === "open") return c.open;
    if (key === "high") return c.high;
    if (key === "low") return c.low;
    if (key === "hl2") return (c.high + c.low) / 2;
    if (key === "hlc3") return (c.high + c.low + c.close) / 3;
    if (key === "ohlc4") return (c.open + c.high + c.low + c.close) / 4;
    return c.close;
  });
  const sma = I.calc.sma;
  const ema = I.calc.ema;
  const atr = I.calc.atr;
  const rsi = I.calc.rsi;

  function rma(values, period) {
    const out = Array(values.length).fill(null); let seed = 0, count = 0, prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]; if (!finite(v)) continue;
      if (prev == null) { seed += v; count++; if (count === period) prev = seed / period; }
      else prev = (prev * (period - 1) + v) / period;
      if (prev != null) out[i] = prev;
    }
    return out;
  }
  function wma(values, period) {
    const out = Array(values.length).fill(null), denom = period * (period + 1) / 2;
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0, ok = true;
      for (let j = 0; j < period; j++) { const v = values[i - j]; if (!finite(v)) { ok = false; break; } sum += v * (period - j); }
      if (ok) out[i] = sum / denom;
    }
    return out;
  }
  function rolling(values, period, wantMax) {
    const out = Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let best = wantMax ? -Infinity : Infinity, ok = true;
      for (let j = i - period + 1; j <= i; j++) { const v = values[j]; if (!finite(v)) { ok = false; break; } best = wantMax ? Math.max(best, v) : Math.min(best, v); }
      if (ok) out[i] = best;
    }
    return out;
  }
  function stddev(values, period) {
    const mean = sma(values, period), out = Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      if (!finite(mean[i])) continue; let sum = 0, ok = true;
      for (let j = i - period + 1; j <= i; j++) { if (!finite(values[j])) { ok = false; break; } sum += (values[j] - mean[i]) ** 2; }
      if (ok) out[i] = Math.sqrt(sum / period);
    }
    return out;
  }
  function trueRange(candles) {
    return candles.map((c, i) => !i ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  }
  function rollingSum(values, period) {
    const out = Array(values.length).fill(null); let sum = 0;
    for (let i = 0; i < values.length; i++) { sum += finite(values[i]) ? values[i] : 0; if (i >= period) sum -= finite(values[i - period]) ? values[i - period] : 0; if (i >= period - 1) out[i] = sum; }
    return out;
  }

  const calc = {};
  calc.rma = (c, p) => ({ main: rma(source(c, p.source), +p.period) });
  calc.vwma = (c, p) => { const s = source(c, p.source), v = c.map(x => +x.volume || 0), pv = s.map((x, i) => x * v[i]), a = rollingSum(pv, +p.period), b = rollingSum(v, +p.period); return { main: a.map((x, i) => finite(x) && b[i] ? x / b[i] : null) }; };
  calc.hma = (c, p) => { const s = source(c, p.source), n = +p.period, half = Math.max(1, Math.floor(n / 2)), root = Math.max(1, Math.round(Math.sqrt(n))), a = wma(s, half), b = wma(s, n); return { main: wma(s.map((_, i) => finite(a[i]) && finite(b[i]) ? 2 * a[i] - b[i] : null), root) }; };
  calc.supertrend = (c, p) => {
    const av = rma(trueRange(c), +p.period), up = Array(c.length).fill(null), down = Array(c.length).fill(null), direction = Array(c.length).fill(null);
    let finalUpper = null, finalLower = null, dir = 1; const factor = +p.factor;
    for (let i = 0; i < c.length; i++) {
      if (!finite(av[i])) continue; const mid = (c[i].high + c[i].low) / 2, basicUpper = mid + factor * av[i], basicLower = mid - factor * av[i];
      finalUpper = finalUpper == null || basicUpper < finalUpper || (i && c[i - 1].close > finalUpper) ? basicUpper : finalUpper;
      finalLower = finalLower == null || basicLower > finalLower || (i && c[i - 1].close < finalLower) ? basicLower : finalLower;
      if (dir < 0 && c[i].close > finalUpper) dir = 1; else if (dir > 0 && c[i].close < finalLower) dir = -1;
      direction[i] = dir; if (dir > 0) up[i] = finalLower; else down[i] = finalUpper;
    }
    return { up, down, direction };
  };
  calc.ichimoku = (c, p) => {
    const highs = c.map(x => x.high), lows = c.map(x => x.low);
    const mid = (n) => { const hi = rolling(highs, n, true), lo = rolling(lows, n, false); return hi.map((x, i) => finite(x) && finite(lo[i]) ? (x + lo[i]) / 2 : null); };
    const tenkan = mid(+p.conversion), kijun = mid(+p.base), rawB = mid(+p.spanBPeriod), spanA = Array(c.length).fill(null), spanB = Array(c.length).fill(null), chikou = Array(c.length).fill(null), d = +p.displacement;
    for (let i = 0; i < c.length; i++) { if (i + d < c.length && finite(tenkan[i]) && finite(kijun[i])) spanA[i + d] = (tenkan[i] + kijun[i]) / 2; if (i + d < c.length && finite(rawB[i])) spanB[i + d] = rawB[i]; if (i - d >= 0) chikou[i - d] = c[i].close; }
    return { tenkan, kijun, spanA, spanB, chikou };
  };
  calc.psar = (c, p) => {
    const out = Array(c.length).fill(null); if (c.length < 2) return { main: out };
    let bull = c[1].close >= c[0].close, sar = bull ? c[0].low : c[0].high, ep = bull ? Math.max(c[0].high, c[1].high) : Math.min(c[0].low, c[1].low), af = +p.step;
    out[0] = sar;
    for (let i = 1; i < c.length; i++) {
      sar += af * (ep - sar);
      if (bull) { sar = Math.min(sar, c[i - 1].low, i > 1 ? c[i - 2].low : c[i - 1].low); if (c[i].low < sar) { bull = false; sar = ep; ep = c[i].low; af = +p.step; } else if (c[i].high > ep) { ep = c[i].high; af = Math.min(+p.maxStep, af + +p.step); } }
      else { sar = Math.max(sar, c[i - 1].high, i > 1 ? c[i - 2].high : c[i - 1].high); if (c[i].high > sar) { bull = true; sar = ep; ep = c[i].high; af = +p.step; } else if (c[i].low < ep) { ep = c[i].low; af = Math.min(+p.maxStep, af + +p.step); } }
      out[i] = sar;
    }
    return { main: out };
  };
  calc.adx = (c, p) => {
    const n = +p.period, tr = trueRange(c), plusDM = Array(c.length).fill(0), minusDM = Array(c.length).fill(0);
    for (let i = 1; i < c.length; i++) { const up = c[i].high - c[i - 1].high, down = c[i - 1].low - c[i].low; plusDM[i] = up > down && up > 0 ? up : 0; minusDM[i] = down > up && down > 0 ? down : 0; }
    const trSm = rma(tr, n), plusSm = rma(plusDM, n), minusSm = rma(minusDM, n), plus = tr.map((_, i) => trSm[i] ? 100 * plusSm[i] / trSm[i] : null), minus = tr.map((_, i) => trSm[i] ? 100 * minusSm[i] / trSm[i] : null), dx = tr.map((_, i) => finite(plus[i]) && finite(minus[i]) && plus[i] + minus[i] ? 100 * Math.abs(plus[i] - minus[i]) / (plus[i] + minus[i]) : null);
    return { adx: rma(dx, +p.smoothing), plus, minus };
  };
  calc.aroon = (c, p) => {
    const n = +p.period, up = Array(c.length).fill(null), down = Array(c.length).fill(null);
    for (let i = n - 1; i < c.length; i++) { let hi = -Infinity, lo = Infinity, hiIdx = i, loIdx = i; for (let j = i - n + 1; j <= i; j++) { if (c[j].high >= hi) { hi = c[j].high; hiIdx = j; } if (c[j].low <= lo) { lo = c[j].low; loIdx = j; } } up[i] = 100 * (n - 1 - (i - hiIdx)) / (n - 1 || 1); down[i] = 100 * (n - 1 - (i - loIdx)) / (n - 1 || 1); }
    return { up, down };
  };
  calc.bb_width = (c, p) => { const s = source(c, p.source), mid = sma(s, +p.period), dev = stddev(s, +p.period), k = +p.mult; return { main: mid.map((x, i) => x ? 200 * k * dev[i] / Math.abs(x) : null) }; };
  calc.keltner = (c, p) => { const mid = ema(source(c, p.source), +p.period), a = atr(c, +p.atrPeriod), k = +p.mult; return { upper: mid.map((x, i) => finite(x) && finite(a[i]) ? x + k * a[i] : null), mid, lower: mid.map((x, i) => finite(x) && finite(a[i]) ? x - k * a[i] : null) }; };
  calc.stddev = (c, p) => ({ main: stddev(source(c, p.source), +p.period) });
  calc.historical_volatility = (c, p) => { const s = source(c, p.source), ret = s.map((x, i) => i && s[i - 1] > 0 && x > 0 ? Math.log(x / s[i - 1]) : null), dev = stddev(ret, +p.period), factor = Math.sqrt(+p.annualization || 252) * 100; return { main: dev.map(x => finite(x) ? x * factor : null) }; };
  calc.stoch_rsi = (c, p) => { const rs = rsi(c, +p.rsiPeriod), hi = rolling(rs, +p.stochPeriod, true), lo = rolling(rs, +p.stochPeriod, false), raw = rs.map((x, i) => finite(x) && finite(hi[i]) && hi[i] !== lo[i] ? 100 * (x - lo[i]) / (hi[i] - lo[i]) : null), k = sma(raw, +p.kPeriod); return { k, d: sma(k, +p.dPeriod) }; };
  calc.cci = (c, p) => { const tp = c.map(x => (x.high + x.low + x.close) / 3), mid = sma(tp, +p.period), out = Array(c.length).fill(null), n = +p.period; for (let i = n - 1; i < c.length; i++) { if (!finite(mid[i])) continue; let dev = 0; for (let j = i - n + 1; j <= i; j++) dev += Math.abs(tp[j] - mid[i]); dev /= n; out[i] = dev ? (tp[i] - mid[i]) / (0.015 * dev) : 0; } return { main: out }; };
  calc.williams_r = (c, p) => { const hi = rolling(c.map(x => x.high), +p.period, true), lo = rolling(c.map(x => x.low), +p.period, false); return { main: c.map((x, i) => finite(hi[i]) && hi[i] !== lo[i] ? -100 * (hi[i] - x.close) / (hi[i] - lo[i]) : null) }; };
  calc.roc = (c, p) => { const s = source(c, p.source), n = +p.period; return { main: s.map((x, i) => i >= n && s[i - n] ? 100 * (x / s[i - n] - 1) : null) }; };
  calc.ultimate = (c, p) => {
    const bp = Array(c.length).fill(null), tr = Array(c.length).fill(null);
    for (let i = 1; i < c.length; i++) { const pc = c[i - 1].close; bp[i] = c[i].close - Math.min(c[i].low, pc); tr[i] = Math.max(c[i].high, pc) - Math.min(c[i].low, pc); }
    const ratio = (n) => { const a = rollingSum(bp, n), b = rollingSum(tr, n); return a.map((x, i) => finite(x) && b[i] ? x / b[i] : null); };
    const a = ratio(+p.short), b = ratio(+p.mid), d = ratio(+p.long); return { main: c.map((_, i) => finite(a[i]) && finite(b[i]) && finite(d[i]) ? 100 * (4 * a[i] + 2 * b[i] + d[i]) / 7 : null) };
  };
  calc.awesome = (c, p) => { const s = source(c, "hl2"), a = sma(s, +p.fast), b = sma(s, +p.slow); return { main: s.map((_, i) => finite(a[i]) && finite(b[i]) ? a[i] - b[i] : null) }; };
  calc.trix = (c, p) => { const s = source(c, p.source), e1 = ema(s, +p.period), e2 = ema(e1, +p.period), e3 = ema(e2, +p.period), line = e3.map((x, i) => i && finite(x) && finite(e3[i - 1]) && e3[i - 1] ? 100 * (x / e3[i - 1] - 1) : null); return { line, signal: ema(line, +p.signal) }; };
  calc.cmo = (c, p) => { const s = source(c, p.source), gains = Array(s.length).fill(0), losses = Array(s.length).fill(0), n = +p.period; for (let i = 1; i < s.length; i++) { const d = s[i] - s[i - 1]; gains[i] = Math.max(d, 0); losses[i] = Math.max(-d, 0); } const gsum = rollingSum(gains, n), lsum = rollingSum(losses, n); return { main: s.map((_, i) => finite(gsum[i]) && finite(lsum[i]) && gsum[i] + lsum[i] ? 100 * (gsum[i] - lsum[i]) / (gsum[i] + lsum[i]) : null) }; };
  calc.obv = (c) => { const out = Array(c.length).fill(0); for (let i = 1; i < c.length; i++) out[i] = out[i - 1] + (c[i].close > c[i - 1].close ? (+c[i].volume || 0) : c[i].close < c[i - 1].close ? -(+c[i].volume || 0) : 0); return { main: out }; };
  calc.mfi = (c, p) => { const n = +p.period, tp = c.map(x => (x.high + x.low + x.close) / 3), pos = Array(c.length).fill(0), neg = Array(c.length).fill(0); for (let i = 1; i < c.length; i++) { const flow = tp[i] * (+c[i].volume || 0); if (tp[i] > tp[i - 1]) pos[i] = flow; else if (tp[i] < tp[i - 1]) neg[i] = flow; } const ps = rollingSum(pos, n), ns = rollingSum(neg, n); return { main: c.map((_, i) => finite(ps[i]) && finite(ns[i]) ? (ns[i] === 0 ? 100 : 100 - 100 / (1 + ps[i] / ns[i])) : null) }; };
  calc.cmf = (c, p) => { const n = +p.period, mfv = c.map(x => x.high === x.low ? 0 : (((x.close - x.low) - (x.high - x.close)) / (x.high - x.low)) * (+x.volume || 0)), vol = c.map(x => +x.volume || 0), a = rollingSum(mfv, n), b = rollingSum(vol, n); return { main: a.map((x, i) => finite(x) && b[i] ? x / b[i] : null) }; };
  calc.ad = (c) => { const out = Array(c.length).fill(0); let total = 0; for (let i = 0; i < c.length; i++) { const x = c[i], m = x.high === x.low ? 0 : ((x.close - x.low) - (x.high - x.close)) / (x.high - x.low); total += m * (+x.volume || 0); out[i] = total; } return { main: out }; };
  calc.volume_osc = (c, p) => { const vol = c.map(x => +x.volume || 0), a = ema(vol, +p.fast), b = ema(vol, +p.slow); return { main: vol.map((_, i) => finite(a[i]) && finite(b[i]) && b[i] ? 100 * (a[i] - b[i]) / b[i] : null) }; };
  calc.pvt = (c) => { const out = Array(c.length).fill(0); for (let i = 1; i < c.length; i++) out[i] = out[i - 1] + (c[i - 1].close ? (c[i].close - c[i - 1].close) / c[i - 1].close * (+c[i].volume || 0) : 0); return { main: out }; };
  calc.pivot = (c) => { const pivot = Array(c.length).fill(null), r1 = Array(c.length).fill(null), s1 = Array(c.length).fill(null); for (let i = 1; i < c.length; i++) { pivot[i] = (c[i - 1].high + c[i - 1].low + c[i - 1].close) / 3; r1[i] = 2 * pivot[i] - c[i - 1].low; s1[i] = 2 * pivot[i] - c[i - 1].high; } return { pivot, r1, s1 }; };
  calc.highest_lowest = (c, p) => ({ high: rolling(c.map(x => x.high), +p.period, true), low: rolling(c.map(x => x.low), +p.period, false) });
  calc.linear_regression = (c, p) => { const s = source(c, p.source), n = +p.period, out = Array(s.length).fill(null), sx = n * (n - 1) / 2, sxx = n * (n - 1) * (2 * n - 1) / 6, denom = n * sxx - sx * sx; for (let i = n - 1; i < s.length; i++) { let sy = 0, sxy = 0; for (let x = 0; x < n; x++) { const y = s[i - n + 1 + x]; sy += y; sxy += x * y; } const slope = denom ? (n * sxy - sx * sy) / denom : 0, intercept = (sy - slope * sx) / n; out[i] = intercept + slope * (n - 1); } return { main: out }; };
  calc.ma_envelope = (c, p) => { const mid = sma(source(c, p.source), +p.period), k = (+p.percent || 2) / 100; return { upper: mid.map(x => finite(x) ? x * (1 + k) : null), mid, lower: mid.map(x => finite(x) ? x * (1 - k) : null) }; };

  const defs = [
    ["rma","RMA/SMMA","trend",{period:20,source:"close"},["main"]], ["vwma","VWMA","trend",{period:20,source:"close"},["main"]], ["hma","HMA","trend",{period:20,source:"close"},["main"]], ["supertrend","Supertrend","trend",{period:10,factor:3},["up","down"]], ["ichimoku","Ichimoku Cloud","trend",{conversion:9,base:26,spanBPeriod:52,displacement:26},["tenkan","kijun","spanA","spanB","chikou"]], ["psar","Parabolic SAR","trend",{step:.02,maxStep:.2},["main"]], ["adx","ADX / DMI","oscillator",{period:14,smoothing:14},["adx","plus","minus"]], ["aroon","Aroon","oscillator",{period:25},["up","down"]],
    ["bb_width","Bollinger Band Width","volatility",{period:20,mult:2,source:"close"},["main"]], ["keltner","Keltner Channels","trend",{period:20,atrPeriod:10,mult:2,source:"close"},["upper","mid","lower"]], ["stddev","Standard Deviation","volatility",{period:20,source:"close"},["main"]], ["historical_volatility","Historical Volatility","volatility",{period:20,annualization:252,source:"close"},["main"]],
    ["stoch_rsi","Stochastic RSI","oscillator",{rsiPeriod:14,stochPeriod:14,kPeriod:3,dPeriod:3},["k","d"]], ["cci","CCI","oscillator",{period:20},["main"]], ["williams_r","Williams %R","oscillator",{period:14},["main"]], ["roc","ROC","oscillator",{period:12,source:"close"},["main"]], ["ultimate","Ultimate Oscillator","oscillator",{short:7,mid:14,long:28},["main"]], ["awesome","Awesome Oscillator","oscillator",{fast:5,slow:34},["main"]], ["trix","TRIX","oscillator",{period:15,signal:9,source:"close"},["line","signal"]], ["cmo","Chande Momentum Oscillator","oscillator",{period:14,source:"close"},["main"]],
    ["obv","OBV","volume",{},["main"]], ["mfi","Money Flow Index","volume",{period:14},["main"]], ["cmf","Chaikin Money Flow","volume",{period:20},["main"]], ["ad","Accumulation / Distribution","volume",{},["main"]], ["volume_osc","Volume Oscillator","volume",{fast:5,slow:20},["main"],"histogram"], ["pvt","Price Volume Trend","volume",{},["main"]],
    ["pivot","Pivot Points","levels",{},["pivot","r1","s1"]], ["highest_lowest","Highest High / Lowest Low","levels",{period:20},["high","low"]], ["linear_regression","Linear Regression","levels",{period:100,source:"close"},["main"]], ["ma_envelope","Moving Average Envelope","levels",{period:20,percent:2,source:"close"},["upper","mid","lower"]]
  ];
  const labels = { trend:"Трендовые", volatility:"Волатильность", oscillator:"Осцилляторы", volume:"Объём", levels:"Уровни / сила тренда" };
  const existing = new Set(I.registry.map(x => x.id));
  for (const [id, label, category, defaultParams, keys, renderType] of defs) {
    if (existing.has(id)) continue;
    I.registry.push({ id, label, name:label, shortName:label.split(" ")[0], ruName:label, category, defaultParams, kind:(category === "trend" || category === "levels") ? "overlay" : "pane", sourceParam:Object.prototype.hasOwnProperty.call(defaultParams,"source"), aliases:[label.toLowerCase()], _slV2:true, _slKeys:keys, renderType:renderType || (keys.length > 1 ? "multi-line" : "line") });
  }
  const rsiDef = I.registry.find(x => x.id === "rsi"); if (rsiDef) { rsiDef.category = "oscillator"; rsiDef.aliases = [...new Set([...(rsiDef.aliases || []), "relative strength index", "индекс относительной силы"])]; }
  const macdDef = I.registry.find(x => x.id === "macd"); if (macdDef) { macdDef.category = "oscillator"; macdDef.aliases = [...new Set([...(macdDef.aliases || []), "moving average convergence divergence", "схождение расхождение скользящих средних"])]; }
  for (const id of ["sma","ema","wma","vwap"]) { const d = I.registry.find(x => x.id === id); if (d) d.category = "trend"; }
  for (const id of ["bollinger","donchian","atr"]) { const d = I.registry.find(x => x.id === id); if (d) d.category = "volatility"; }
  for (const id of ["stochastic","momentum"]) { const d = I.registry.find(x => x.id === id); if (d) d.category = "oscillator"; }
  const volumeDef = I.registry.find(x => x.id === "volume"); if (volumeDef) volumeDef.category = "volume";
  I.categories = Object.assign({}, I.categories || {}, labels);

  const oldCompute = I.compute;
  I.compute = function (id, candles, params) {
    const fn = calc[id]; if (!fn) return oldCompute(id, candles, params);
    const def = I.registry.find(x => x.id === id);
    return fn(candles || [], Object.assign({}, def ? def.defaultParams : {}, params || {}));
  };

  const P = I.PaneManager.prototype, oldStyle = P._defaultStyle, oldCreate = P._createSeries, oldInto = P._computeInto;
  const palette = ["#7c8cff", "#4dd4ac", "#ffb454", "#ff7081", "#8de3ff"];
  P._defaultStyle = function (def) {
    if (!def._slV2) return oldStyle.call(this, def);
    const colors = def._slKeys.map((_, i) => palette[i % palette.length]);
    return colors.length === 1 ? { color:colors[0] } : { colors };
  };
  P._createSeries = function (def, style, paneIndex) {
    if (!def._slV2) return oldCreate.call(this, def, style, paneIndex);
    const L = g.LightweightCharts, width = clamp(Math.round(style.width || 1), 1, 6);
    return def._slKeys.map((key, i) => {
      const color = (style.colors ? style.colors[i] : style.color) || palette[i % palette.length];
      if (def.renderType === "histogram") return this.core.chart.addSeries(L.HistogramSeries, { color, lastValueVisible:false, priceLineVisible:false, visible:style.visible !== false }, paneIndex);
      const options = { color, lineWidth:width, lastValueVisible:false, priceLineVisible:false, visible:style.visible !== false };
      if (def.id === "psar") { options.lineVisible = false; options.pointMarkersVisible = true; options.pointMarkersRadius = 2.5; }
      return this.core.chart.addSeries(L.LineSeries, options, paneIndex);
    });
  };
  P._computeInto = function (id) {
    const inst = this.instances.get(id);
    if (!inst || !inst.def._slV2) return oldInto.call(this, id);
    const candles = this.core.candles;
    if (!candles || !candles.length) return;
    const result = calc[inst.def.id](candles, inst.params);
    const points = (arr) => candles.map((c, i) => ({ time:c.time, value:arr[i] })).filter(p => finite(p.value));
    inst.def._slKeys.forEach((key, idx) => {
      const series = inst.series[idx], arr = result[key] || [];
      if (!series) return;
      if (inst.def.renderType === "histogram") {
        const up = CE.theme?.up || "#4dd4ac", down = CE.theme?.down || "#ff7081";
        series.setData(candles.map((c, i) => ({ time:c.time, value:finite(arr[i]) ? arr[i] : 0, color:(arr[i] || 0) >= 0 ? up : down })));
      } else series.setData(points(arr));
    });
  };
  if (!P.setVisible) P.setVisible = function (id, visible) { const inst = this.instances.get(id); if (!inst) return; inst.style.visible = !!visible; inst.series.forEach(s => s.applyOptions({ visible:!!visible })); if (inst.def.id === "volume" && this.core.volumeSeries) this.core.volumeSeries.applyOptions({ visible:!!visible }); };

  g.StrategyLabIndicatorExtension = { count:() => I.registry.length, ids:() => I.registry.map(x => x.id) };
})(window);
