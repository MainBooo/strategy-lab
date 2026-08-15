(function(g){'use strict';
const CE=g.ChartEngine, I=CE&&CE.Indicators, LWC=g.LightweightCharts;if(!I||!I.PaneManager||!LWC)return;
const Base=I.PaneManager, palette=['#7c8cff','#4dd4ac','#ffb454','#ff7081','#8de3ff','#c792ea','#f5d76e'];
const extra=[]; const finite=Number.isFinite;
const K={
 p:(v,d=1)=>Math.max(1,Math.round(Number(v)||d)), finite,
 src:(cs,s='close')=>cs.map(c=>s==='open'?c.open:s==='high'?c.high:s==='low'?c.low:s==='hl2'?(c.high+c.low)/2:s==='hlc3'?(c.high+c.low+c.close)/3:s==='ohlc4'?(c.open+c.high+c.low+c.close)/4:c.close),
 hi:cs=>cs.map(c=>c.high), lo:cs=>cs.map(c=>c.low), vol:cs=>cs.map(c=>Number(c.volume)||0),
 rsum(a,n){n=this.p(n);const o=Array(a.length).fill(null),q=[];let s=0,c=0;for(let i=0;i<a.length;i++){const v=finite(a[i])?a[i]:null;q.push(v);if(v!=null){s+=v;c++}if(q.length>n){const x=q.shift();if(x!=null){s-=x;c--}}if(q.length===n&&c===n)o[i]=s}return o},
 sma(a,n){n=this.p(n);const s=this.rsum(a,n);return s.map(v=>finite(v)?v/n:null)},
 ema(a,n){n=this.p(n);const o=Array(a.length).fill(null),x=2/(n+1);let p=null;for(let i=0;i<a.length;i++){if(!finite(a[i]))continue;p=p==null?a[i]:a[i]*x+p*(1-x);o[i]=p}return o},
 rma(a,n){n=this.p(n);const o=Array(a.length).fill(null);let seed=0,c=0,p=null;for(let i=0;i<a.length;i++){const v=a[i];if(!finite(v))continue;if(p==null){seed+=v;c++;if(c===n){p=seed/n;o[i]=p}}else{p=(p*(n-1)+v)/n;o[i]=p}}return o},
 wma(a,n){n=this.p(n);const o=Array(a.length).fill(null),d=n*(n+1)/2;for(let i=n-1;i<a.length;i++){let s=0,ok=1;for(let j=0;j<n;j++){const v=a[i-j];if(!finite(v)){ok=0;break}s+=v*(n-j)}if(ok)o[i]=s/d}return o},
 ext(a,n,max){n=this.p(n);const o=Array(a.length).fill(null);for(let i=n-1;i<a.length;i++){let x=max?-Infinity:Infinity,ok=1;for(let j=i-n+1;j<=i;j++){if(!finite(a[j])){ok=0;break}x=max?Math.max(x,a[j]):Math.min(x,a[j])}if(ok)o[i]=x}return o},
 std(a,n,m){n=this.p(n);m=m||this.sma(a,n);const o=Array(a.length).fill(null);for(let i=n-1;i<a.length;i++){if(!finite(m[i]))continue;let s=0,ok=1;for(let j=i-n+1;j<=i;j++){if(!finite(a[j])){ok=0;break}s+=(a[j]-m[i])**2}if(ok)o[i]=Math.sqrt(s/n)}return o},
 tr(cs){return cs.map((c,i)=>i?Math.max(c.high-c.low,Math.abs(c.high-cs[i-1].close),Math.abs(c.low-cs[i-1].close)):c.high-c.low)},
 atr(cs,n){return this.sma(this.tr(cs),n)},
 rsi(cs,n,s='close'){const a=this.src(cs,s),up=Array(a.length).fill(0),dn=Array(a.length).fill(0);for(let i=1;i<a.length;i++){const d=a[i]-a[i-1];up[i]=Math.max(0,d);dn[i]=Math.max(0,-d)}const u=this.sma(up,n),d=this.sma(dn,n);return a.map((_,i)=>finite(u[i])&&finite(d[i])?(d[i]===0?100:100-100/(1+u[i]/d[i])):null)},
 line:(key,title,color=0,more={})=>Object.assign({key,title,type:'line',color},more), hist:(key,title,color=0,more={})=>Object.assign({key,title,type:'histogram',color},more),
 num:(key,label,def,min=1,max=1000,step=1)=>({key,label,type:'number',default:def,min,max,step}), source:(def='close')=>({key:'source',label:'Источник',type:'source',default:def})
};
function register(defs){for(const d of defs){d.extended=true;d.shortName=d.shortName||d.name||d.id.toUpperCase();d.name=d.name||d.shortName;d.ruName=d.ruName||d.name;d.aliases=d.aliases||[];d.defaultParams=d.defaultParams||{};d.paramsSchema=d.paramsSchema||[];d.kind=d.kind||((d.pane||'overlay')==='overlay'?'overlay':'pane');d.pane=d.pane||(d.kind==='overlay'?'overlay':'separate');d.series=d.series||[K.line('main',d.shortName)];if(!I.registry.some(x=>x.id===d.id)){I.registry.push(d);extra.push(d)}}}
function def(id){return I.registry.find(x=>x.id===id)||null}
const baseMeta={
 sma:{shortName:'SMA',name:'Simple Moving Average',ruName:'Простая скользящая средняя',category:'trend',aliases:['moving average','скользящая средняя']},
 ema:{shortName:'EMA',name:'Exponential Moving Average',ruName:'Экспоненциальная скользящая средняя',category:'trend',aliases:['экспоненциальная средняя']},
 wma:{shortName:'WMA',name:'Weighted Moving Average',ruName:'Взвешенная скользящая средняя',category:'trend',aliases:['взвешенная средняя']},
 vwap:{shortName:'VWAP',name:'Volume Weighted Average Price',ruName:'Средневзвешенная цена по объёму',category:'trend',aliases:['средняя цена','объём']},
 bollinger:{shortName:'BB',name:'Bollinger Bands',ruName:'Полосы Боллинджера',category:'volatility',aliases:['bollinger','bb','боллинджер']},
 donchian:{shortName:'DC',name:'Donchian Channels',ruName:'Каналы Дончяна',category:'volatility',aliases:['donchian','дончян']},
 rsi:{shortName:'RSI',name:'Relative Strength Index',ruName:'Индекс относительной силы',category:'oscillator',aliases:['relative strength index','индекс относительной силы']},
 macd:{shortName:'MACD',name:'Moving Average Convergence Divergence',ruName:'Схождение/расхождение скользящих средних',category:'oscillator',aliases:['moving average convergence divergence']},
 atr:{shortName:'ATR',name:'Average True Range',ruName:'Средний истинный диапазон',category:'volatility',aliases:['average true range','истинный диапазон']},
 stochastic:{shortName:'Stoch',name:'Stochastic Oscillator',ruName:'Стохастик',category:'oscillator',aliases:['stochastic','стохастик']},
 momentum:{shortName:'Momentum',name:'Momentum',ruName:'Моментум',category:'oscillator',aliases:['моментум']},
 volume:{shortName:'Volume',name:'Volume',ruName:'Объём',category:'volume',aliases:['объём','volume']}
};
for(const d of I.registry){const m=baseMeta[d.id];if(!m)continue;Object.assign(d,m);if(!d.paramsSchema){d.paramsSchema=Object.keys(d.defaultParams||{}).map(k=>k==='source'?K.source(d.defaultParams[k]):K.num(k,k==='period'?'Период':k,d.defaultParams[k],1,1000,k==='mult'?0.1:1))}}
I.Expanded={register,def,extra,kit:K,BasePaneManager:Base,palette};
})(window);
