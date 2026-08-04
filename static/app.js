const $=id=>document.getElementById(id);

const tooltips={
lookback:"Количество предыдущих свечей, по которым строится уровень. Малое значение даёт больше, но слабее уровней; большое — реже, но значимее.",atr_period:"Период Average True Range. ATR измеряет текущую волатильность и используется для нормализации глубины пробоя и стопа.",min_touches:"Минимальное число разнесённых касаний, необходимое для признания цены уровнем поддержки или сопротивления.",touch_tolerance_atr:"Максимальное расстояние от уровня, при котором свеча считается касанием. Измеряется в долях ATR.",min_depth_atr:"Минимальная глубина выхода цены за уровень. Слишком маленький прокол может быть обычным шумом.",max_depth_atr:"Максимальная глубина ложного пробоя. Более глубокое движение чаще оказывается настоящим пробоем.",return_window:"Максимальное число свечей, за которое цена должна закрыться обратно за уровень.",stop_buffer_atr:"Дополнительный запас за экстремумом ложного пробоя, чтобы стоп не стоял точно на минимуме или максимуме.",rr:"Отношение потенциальной прибыли к риску. Значение 2 означает тейк-профит на расстоянии двух размеров стопа.",min_risk_pct:"Минимально допустимая ширина стопа относительно цены. Отсекает слишком тесные стопы, чувствительные к шуму.",max_risk_pct:"Максимально допустимая ширина стопа. Отсекает сделки с чрезмерным риском.",min_touch_separation:"Минимальное расстояние между касаниями в свечах. Не позволяет считать соседние свечи отдельными подтверждениями уровня.",max_level_age:"Максимальный возраст уровня в свечах. Старые уровни могут терять актуальность.",confirmation:"Требовать дополнительную свечу в сторону возврата перед входом. Снижает число сигналов, но фильтрует слабые возвраты.",first_break_only:"После первой сделки по уровню больше его не использовать. Повторные тесты обычно ослабляют уровень.",atr_filter:"Торговать только когда текущий ATR выше своего среднего значения, то есть в более активном рынке.",fast:"Период быстрой экспоненциальной средней.",slow:"Период медленной экспоненциальной средней, задающей направление тренда.",period:"Период расчёта RSI.",oversold:"Нижняя граница RSI, ниже которой рынок считается перепроданным.",overbought:"Верхняя граница RSI, выше которой рынок считается перекупленным.",stop_atr:"Размер защитного стопа в единицах ATR.",max_wait:"Сколько свечей ждать пробоя после формирования внутреннего бара.",wick_ratio:"Минимальное отношение длины тени пин-бара к телу свечи.",retest_bars:"Сколько свечей ждать возврата цены к пробитому уровню."};
const paramsByStrategy={
false_breakout:[["lookback","Период уровня",80],["atr_period","ATR период",14],["min_touches","Минимум касаний",3],["touch_tolerance_atr","Допуск касания ATR",0.15],["min_depth_atr","Мин. глубина ATR",0.25],["max_depth_atr","Макс. глубина ATR",0.70],["return_window","Возврат за свечей",2],["stop_buffer_atr","Запас стопа ATR",0.05],["rr","Тейк R",2],["min_risk_pct","Мин. риск",0.0025],["max_risk_pct","Макс. риск",0.015],["min_touch_separation","Расстояние касаний",10],["max_level_age","Возраст уровня",150],["confirmation","Подтверждение",true,"checkbox"],["first_break_only","Только первый пробой",true,"checkbox"],["atr_filter","Фильтр ATR",false,"checkbox"]],
head_shoulders:[["pivot_span","Радиус экстремума",3],["shoulder_tolerance","Допуск плеч",0.03],["head_min_distance","Выступ головы",0.01],["stop_pct","Стоп",0.02],["take_pct","Тейк",0.05],["max_breakout_bars","Окно пробоя",30]],
breakout_retest:[["lookback","Период уровня",50],["retest_bars","Ожидание ретеста",5],["rr","Тейк R",2],["stop_atr","Запас стопа ATR",0.3]],ema_pullback:[["fast","Быстрая EMA",20],["slow","Медленная EMA",50],["rr","Тейк R",2],["stop_atr","Стоп ATR",1.2]],rsi_reversal:[["period","RSI период",14],["oversold","Перепроданность",30],["overbought","Перекупленность",70],["rr","Тейк R",1.5],["stop_atr","Стоп ATR",1]],inside_bar:[["rr","Тейк R",2],["max_wait","Ожидание пробоя",3]],pin_bar:[["wick_ratio","Отношение тени",2.5],["lookback","Период экстремума",20],["rr","Тейк R",2],["stop_atr","Запас стопа ATR",0.2]]};

const DATA_STATUS_LABEL={fresh:"Данные актуальны",stale:"Требуют обновления",none:"Данных нет"};
const DATA_STATUS_CLASS={fresh:"status-fresh",stale:"status-stale",none:"status-none"};
const money=n=>Number(n||0).toLocaleString("ru-RU",{maximumFractionDigits:2});
const fmtDateTime=ts=>ts?new Date(ts*1000).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—";

let securities=[];
let catalogSelected=new Set();
let portfolios=[];
let manualLots={};
let allocationMode="equal_lots";
let buildTargetPortfolioId=null;
let buildJobId=null,buildPollTimer=null;

let activePortfolioId=localStorage.getItem("moexlab_active_portfolio")||null;
let btPortfolio=null;
let btIncluded=new Set();
let backtestJobId=null,backtestPollTimer=null;
let lastBacktestResult=null;
let byTickerSort={key:"pnl_rub",dir:-1};

// accordion editor state
let expandedPortfolios=new Set();
let editorDrafts={};      // portfolioId -> deep-cloned editable portfolio
let editorDirty=new Set();
let priceCache={};        // ticker -> {last,change_pct,is_live,updated_at}

// history / trade viewer state
let historyPage=1,historyPageSize=10,historyTotal=0;
let tvRunId=null,tvPage=1,tvPageSize=25;

function setStatus(t,c=""){$("status").textContent=t;$("status").className=`status ${c}`}

// ------------------------------------------------------------------ tabs --
function activateTab(name){
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.tab===name));
  document.querySelectorAll(".tab-page").forEach(x=>x.classList.add("hidden"));
  $("tab-"+name).classList.remove("hidden");
  localStorage.setItem("moexlab_active_tab",name);
  if(name==="backtest")renderBacktestTab();
  if(name==="strategies")renderStrategiesContext();
  if(name==="charts"&&window.ChartAnalysisPage)window.ChartAnalysisPage.init($("chartsRoot"));
  if(window.refreshPortfolioBalance)window.refreshPortfolioBalance();
}
function initTabs(){
  document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>activateTab(b.dataset.tab));
  const saved=localStorage.getItem("moexlab_active_tab");
  activateTab(saved&&document.querySelector(`.tab[data-tab="${saved}"]`)?saved:"portfolio");
}
window.addEventListener("beforeunload",e=>{
  if(editorDirty.size){e.preventDefault();e.returnValue="";}
});

// --------------------------------------------------------------- catalog --
async function loadSecurities(refresh=false){
  setStatus("Загрузка справочника…","working");
  const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),45000);
  try{
    const r=await fetch(`/api/securities${refresh?"?refresh=1":""}`,{signal:ctrl.signal});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Не удалось загрузить справочник");
    securities=d;renderCatalog();
    setStatus(`Инструментов MOEX: ${d.length}`,"success");
  }catch(e){
    const msg=e.name==="AbortError"?"Справочник MOEX не ответил вовремя.":`Ошибка справочника: ${e.message}`;
    setStatus(msg,"error");throw e;
  }finally{clearTimeout(t)}
}
function catalogFilters(){
  return{q:$("catalogSearch").value.toLowerCase().trim(),sector:$("catalogSector").value,dataStatus:$("catalogDataStatus").value,
         onlyLiquid:$("catalogOnlyLiquid").checked,onlySelected:$("catalogOnlySelected").checked};
}
function filteredSecurities(){
  const f=catalogFilters();
  return securities.filter(s=>{
    if(f.q&&!`${s.SECID} ${s.SHORTNAME} ${s.ISIN||""}`.toLowerCase().includes(f.q))return false;
    if(f.sector&&s.SECTOR!==f.sector)return false;
    if(f.dataStatus&&s.DATA_STATUS!==f.dataStatus)return false;
    if(f.onlyLiquid&&!s.IS_LIQUID)return false;
    if(f.onlySelected&&!catalogSelected.has(s.SECID))return false;
    return true;
  });
}
function renderCatalog(){
  const all=filteredSecurities();
  $("catalogFoundCount").textContent=all.length;
  const shown=all.slice(0,300);
  $("securityList").innerHTML=shown.length?shown.map(s=>{
    const checked=catalogSelected.has(s.SECID);
    return `<label class="security-row ${checked?'selected-row':''}">
      <input type="checkbox" data-ticker="${s.SECID}" ${checked?"checked":""}>
      <span class="security-main"><strong>${s.SECID}</strong><small>${s.SHORTNAME||""}</small><em>${s.SECTOR} · TQBR · лот ${s.LOTSIZE||1}</em></span>
      <span class="security-data-status ${DATA_STATUS_CLASS[s.DATA_STATUS]||''}">${DATA_STATUS_LABEL[s.DATA_STATUS]||"—"}${s.DATA_UPDATED_AT?`<small>по ${s.DATA_UPDATED_AT}</small>`:""}</span>
    </label>`;
  }).join(""):"<div class='empty'>Ничего не найдено по текущим фильтрам.</div>";
  document.querySelectorAll("[data-ticker]").forEach(x=>x.onchange=()=>{
    x.checked?catalogSelected.add(x.dataset.ticker):catalogSelected.delete(x.dataset.ticker);
    renderCatalog();
  });
  updateCatalogSelectionUI();
}
function updateCatalogSelectionUI(){
  const count=catalogSelected.size;
  $("catalogSelectedCount").textContent=count;
  const wrap=$("selectedTickers");
  if(!count){
    wrap.className="selected-tickers empty-selection";wrap.textContent="Инструменты не выбраны";
    $("buildPanel").classList.add("hidden");return;
  }
  wrap.className="selected-tickers";
  wrap.innerHTML=[...catalogSelected].sort().map(t=>`<button class="ticker-chip" data-remove-ticker="${t}" title="Убрать ${t}">${t}<span>×</span></button>`).join("");
  document.querySelectorAll("[data-remove-ticker]").forEach(b=>b.onclick=()=>{catalogSelected.delete(b.dataset.removeTicker);renderCatalog()});
  $("buildPanel").classList.remove("hidden");
  renderAllocationExtra();
}
function renderPresets(){
  const labels=window.PRESET_LABELS||{};
  const buttons=Object.keys(window.SECURITY_PRESETS||{}).map(k=>`<button class="secondary preset-btn" data-preset="${k}">${labels[k]||k}</button>`).join("");
  $("presetActions").innerHTML=buttons+`<button class="secondary preset-btn" data-preset="all">Все акции TQBR</button>`;
  document.querySelectorAll(".preset-btn").forEach(b=>b.onclick=()=>{
    const key=b.dataset.preset;
    if(key==="all"){catalogSelected=new Set(securities.map(s=>s.SECID));}
    else{(window.SECURITY_PRESETS[key]||[]).forEach(t=>{if(securities.some(s=>s.SECID===t))catalogSelected.add(t)});}
    renderCatalog();
  });
}
$("selectAllFiltered").onclick=()=>{filteredSecurities().forEach(s=>catalogSelected.add(s.SECID));renderCatalog()};
$("clearCatalogSelection").onclick=()=>{catalogSelected.clear();renderCatalog()};
$("catalogSearch").addEventListener("input",renderCatalog);
$("catalogSector").addEventListener("change",renderCatalog);
$("catalogDataStatus").addEventListener("change",renderCatalog);
$("catalogOnlyLiquid").addEventListener("change",renderCatalog);
$("catalogOnlySelected").addEventListener("change",renderCatalog);

// -------------------------------------------------------- allocation ui --
document.querySelectorAll("#allocationModes .mode-tab").forEach(b=>b.onclick=()=>{
  allocationMode=b.dataset.mode;
  document.querySelectorAll("#allocationModes .mode-tab").forEach(x=>x.classList.toggle("active",x===b));
  renderAllocationExtra();
});
function renderAllocationExtra(){
  const box=$("allocationExtra");
  if(allocationMode==="manual"){
    box.innerHTML=[...catalogSelected].sort().map(t=>{
      const sec=securities.find(s=>s.SECID===t);
      return `<label class="manual-lot-row"><span>${t} (лот ${sec?sec.LOTSIZE:1})</span><input type="number" min="1" value="${manualLots[t]||1}" data-manual-lot="${t}"></label>`;
    }).join("");
    box.querySelectorAll("[data-manual-lot]").forEach(inp=>inp.oninput=()=>{manualLots[inp.dataset.manualLot]=Math.max(1,Number(inp.value||1))});
  }else if(allocationMode==="equal_lots"){
    box.innerHTML=`<label class="inline-label">Лотов на инструмент <input type="number" id="lotsPerInstrument" min="1" value="1" style="width:90px"></label>`;
  }else{
    box.innerHTML=`<p class="hint">Капитал делится поровну между выбранными инструментами; количество лотов рассчитывается по последней известной цене закрытия и официальному размеру лота, без дробных лотов.</p>`;
  }
}

// ------------------------------------------------------------ build job --
function setBuildTarget(portfolioId){
  buildTargetPortfolioId=portfolioId;
  const p=portfolios.find(x=>x.id===portfolioId);
  const banner=$("buildTargetBanner");
  if(portfolioId&&p){
    banner.className="build-target-banner";
    banner.innerHTML=`Добавление инструментов в портфель «${p.name}». <button class="link-btn" id="cancelBuildTarget">Сформировать новый вместо этого</button>`;
    $("cancelBuildTarget").onclick=()=>setBuildTarget(null);
    $("portfolioNameInput").closest("label").classList.add("hidden");
  }else{
    banner.className="build-target-banner hidden";banner.innerHTML="";
    $("portfolioNameInput").closest("label").classList.remove("hidden");
  }
  $("buildPortfolioBtn").textContent=portfolioId?"Добавить в портфель":"Сформировать портфель";
}
function collectBuildPayload(){
  const tickers=[...catalogSelected];
  const allocation={mode:allocationMode};
  if(allocationMode==="equal_lots")allocation.lots_per_instrument=Math.max(1,Number($("lotsPerInstrument")?.value||1));
  if(allocationMode==="manual")allocation.lots=manualLots;
  const payload={tickers,starting_capital:Number($("buildCapital").value||1000000),allocation,interval:10,
                 from_date:$("buildFrom").value,till_date:$("buildTill").value};
  if(buildTargetPortfolioId)payload.portfolio_id=buildTargetPortfolioId;
  else payload.name=$("portfolioNameInput").value||"Новый портфель";
  return payload;
}
async function startBuild(){
  if(!catalogSelected.size){setStatus("Выберите хотя бы один инструмент","error");return}
  $("buildPortfolioBtn").disabled=true;
  $("buildProgress").classList.remove("hidden");
  $("buildSuccess").classList.add("hidden");
  $("buildMessage").textContent="";
  const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),15000);
  try{
    const r=await fetch("/api/portfolio/build",{method:"POST",headers:{"Content-Type":"application/json"},signal:ctrl.signal,body:JSON.stringify(collectBuildPayload())});
    clearTimeout(t);
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Не удалось запустить сборку портфеля");
    buildJobId=d.job_id;
    localStorage.setItem("moexlab_build_job",JSON.stringify({jobId:d.job_id}));
    pollBuildJob(d.job_id);
  }catch(e){
    clearTimeout(t);
    $("buildPortfolioBtn").disabled=false;
    $("buildProgress").classList.add("hidden");
    const msg=e.name==="AbortError"?"Сервер не ответил на запуск":e.message;
    $("buildMessage").textContent=`Ошибка: ${msg}`;
    setStatus(`Ошибка запуска сборки: ${msg}`,"error");
  }
}
$("buildPortfolioBtn").onclick=startBuild;
$("cancelBuildBtn").onclick=async()=>{if(buildJobId)try{await fetch(`/api/jobs/${buildJobId}/cancel`,{method:"POST"})}catch(e){}};

function renderBuildProgress(job){
  $("buildProgressFill").style.width=`${job.percent||0}%`;
  $("buildProgressPercent").textContent=`${job.percent||0}%`;
  $("buildProgressStage").textContent=job.current_ticker?`${job.stage}`:(job.stage||"—");
  $("buildProgressCounts").textContent=`${job.completed||0} из ${job.total||0}`;
  const errs=job.errors||[];
  $("buildProgressErrors").innerHTML=errs.length?`<strong>Ошибки (${errs.length}):</strong>`+errs.map(e=>`<div class="build-error-row"><span>${e.ticker}: ${e.message}</span></div>`).join(""):"";
}
function pollBuildJob(jobId){
  if(buildPollTimer)clearTimeout(buildPollTimer);
  const tick=async()=>{
    const ctrl=new AbortController();const abortT=setTimeout(()=>ctrl.abort(),10000);
    try{
      const r=await fetch(`/api/jobs/${jobId}`,{signal:ctrl.signal});
      clearTimeout(abortT);
      if(r.status===404){
        localStorage.removeItem("moexlab_build_job");
        $("buildPortfolioBtn").disabled=false;$("buildProgress").classList.add("hidden");
        setStatus("Задача формирования портфеля не найдена (сервис мог перезапуститься)","error");
        return;
      }
      const job=await r.json();
      renderBuildProgress(job);
      if(job.status==="completed"){
        localStorage.removeItem("moexlab_build_job");
        $("buildPortfolioBtn").disabled=false;$("buildProgress").classList.add("hidden");
        await loadPortfolios();
        showBuildSuccess(job);
        return;
      }
      if(job.status==="failed"){
        localStorage.removeItem("moexlab_build_job");
        $("buildPortfolioBtn").disabled=false;$("buildProgress").classList.add("hidden");
        const errs=job.errors||[];
        if(errs.length){
          $("buildMessage").innerHTML=`Ошибка: ${job.error?.message||"не удалось сформировать портфель"} <button class="secondary" id="retryFailedBuild">Повторить загрузку</button>`;
          $("retryFailedBuild").onclick=()=>{catalogSelected=new Set(errs.map(e=>e.ticker));renderCatalog();startBuild()};
        }else{
          $("buildMessage").textContent=`Ошибка: ${job.error?.message||"неизвестная ошибка"}`;
        }
        setStatus("Ошибка формирования портфеля","error");
        return;
      }
      buildPollTimer=setTimeout(tick,1200);
    }catch(e){
      clearTimeout(abortT);
      $("buildProgressStage").textContent=e.name==="AbortError"?"Сервер не отвечает…":`Сетевая ошибка: ${e.message}`;
      buildPollTimer=setTimeout(tick,2500);
    }
  };
  tick();
}
function resumeBuildJob(){
  const raw=localStorage.getItem("moexlab_build_job");
  if(!raw)return;
  try{
    const {jobId}=JSON.parse(raw);
    if(jobId){
      $("buildPortfolioBtn").disabled=true;
      $("buildPanel").classList.remove("hidden");
      $("buildProgress").classList.remove("hidden");
      pollBuildJob(jobId);
    }
  }catch(e){localStorage.removeItem("moexlab_build_job")}
}
function buildSuccessDismissed(){return sessionStorage.getItem("moexlab_build_success_dismissed")==="1"}
$("buildSuccessClose").onclick=()=>{
  sessionStorage.setItem("moexlab_build_success_dismissed","1");
  $("buildSuccess").classList.add("hidden");
};
function showBuildSuccess(job){
  const r=job.result||{};
  const errs=job.errors||[];
  sessionStorage.removeItem("moexlab_build_success_dismissed");
  $("buildSuccess").classList.remove("hidden");
  $("buildSuccessText").innerHTML=`Данные по ${r.instruments||0} инструментам подготовлены.`+
    (errs.length?` Не удалось подготовить: ${errs.map(e=>e.ticker).join(", ")}. <button class="secondary" id="retryPartialBuild">Повторить для них</button>`:"")+
    ` Теперь выберите стратегии и запустите бэктест.`;
  activePortfolioId=r.portfolio_id;
  localStorage.setItem("moexlab_active_portfolio",activePortfolioId);
  if(window.refreshPortfolioBalance)window.refreshPortfolioBalance();
  if(errs.length){
    const btn=document.getElementById("retryPartialBuild");
    if(btn)btn.onclick=()=>{catalogSelected=new Set(errs.map(e=>e.ticker));setBuildTarget(r.portfolio_id);renderCatalog();$("buildSuccess").classList.add("hidden")};
  }
  $("successGoStrategy").onclick=()=>activateTab("strategies");
  $("successGoBacktest").onclick=()=>activateTab("backtest");
  $("successOpenPortfolio").onclick=()=>{expandedPortfolios.add(r.portfolio_id);renderPortfolioList();$("portfolioList").scrollIntoView({behavior:"smooth"})};
  catalogSelected.clear();manualLots={};setBuildTarget(null);renderCatalog();
}

// -------------------------------------------------- saved portfolios (accordion) --
function strategyAssignmentCount(p){
  return Object.values(p.ticker_strategies||{}).reduce((sum,list)=>sum+(list||[]).filter(a=>a.enabled!==false).length,0);
}
function strategySummaryLabel(p){
  const overrideTickers=Object.keys(p.ticker_strategies||{}).filter(t=>(p.ticker_strategies[t]||[]).some(a=>a.enabled!==false));
  return overrideTickers.length?`Индивидуальные стратегии (${overrideTickers.length})`:"Одна стратегия для всех";
}
function dataReadinessLabel(p){
  const items=p.instruments||[];
  const ready=items.filter(i=>{const sec=securities.find(s=>s.SECID===i.ticker);return !sec||sec.DATA_STATUS==="fresh"}).length;
  if(!items.length)return{text:"Нет инструментов",cls:"status-none"};
  if(ready===items.length)return{text:"Данные готовы",cls:"status-fresh"};
  if(ready===0)return{text:"Данные отсутствуют",cls:"status-none"};
  return{text:`Готово ${ready} из ${items.length}`,cls:"status-stale"};
}
function formatDate(ts){return ts?new Date(ts*1000).toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric"}):"—"}

async function loadPortfolios(){
  portfolios=await fetch("/api/portfolios").then(r=>r.json());
  try{
    const recent=await fetch("/api/backtests?page_size=50").then(r=>r.json());
    const latestByPortfolio={};
    (recent.items||[]).forEach(run=>{
      if(run.status!=="completed"&&run.status!=="completed_with_errors")return;
      if(!latestByPortfolio[run.portfolio_id])latestByPortfolio[run.portfolio_id]=run;
    });
    portfolios.forEach(p=>{p.last_backtest_summary=latestByPortfolio[p.id]?latestByPortfolio[p.id].return_percent:null});
  }catch(e){/* history unavailable - collapsed card just omits the last-result figure */}
  renderPortfolioList();
}

function confirmDiscardIfDirty(portfolioId){
  if(!editorDirty.has(portfolioId))return true;
  return confirm("В этом портфеле есть несохранённые изменения. Закрыть без сохранения?");
}

function togglePortfolioExpand(portfolioId){
  if(expandedPortfolios.has(portfolioId)){
    if(!confirmDiscardIfDirty(portfolioId))return;
    expandedPortfolios.delete(portfolioId);
    editorDirty.delete(portfolioId);
    delete editorDrafts[portfolioId];
  }else{
    expandedPortfolios.add(portfolioId);
    editorDrafts[portfolioId]=JSON.parse(JSON.stringify(portfolios.find(p=>p.id===portfolioId)));
    fetchPricesFor(portfolios.find(p=>p.id===portfolioId));
  }
  renderPortfolioList();
}

async function fetchPricesFor(portfolio){
  if(!portfolio)return;
  const tickers=(portfolio.instruments||[]).map(i=>i.ticker);
  if(!tickers.length)return;
  try{
    const r=await fetch(`/api/market/prices?tickers=${tickers.join(",")}`);
    const d=await r.json();
    Object.assign(priceCache,d.prices||{});
  }catch(e){/* stale/missing prices are handled per-row via priceCache lookups */}
  if(expandedPortfolios.has(portfolio.id))renderPortfolioList();
}

function renderPortfolioList(){
  $("portfolioList").innerHTML=portfolios.length?portfolios.map(renderPortfolioCard).join(""):
    "<div class='empty'>Портфелей пока нет. Выберите инструменты выше, чтобы сформировать первый портфель.</div>";
  portfolios.forEach(p=>{
    if(expandedPortfolios.has(p.id))wirePortfolioEditor(p.id);
  });
  document.querySelectorAll("[data-toggle-portfolio]").forEach(el=>el.onclick=e=>{
    if(e.target.closest("[data-no-toggle]"))return;
    togglePortfolioExpand(el.dataset.togglePortfolio);
  });
  document.querySelectorAll(".delete-portfolio").forEach(b=>b.onclick=async e=>{
    e.stopPropagation();
    const p=portfolios.find(x=>x.id===b.dataset.id);
    if(!confirm(`Удалить портфель «${p?p.name:''}»? Загруженные исторические данные останутся — они используются и другими портфелями.`))return;
    await fetch(`/api/portfolios/${b.dataset.id}`,{method:"DELETE"});
    if(activePortfolioId===b.dataset.id){activePortfolioId=null;localStorage.removeItem("moexlab_active_portfolio");if(window.refreshPortfolioBalance)window.refreshPortfolioBalance()}
    expandedPortfolios.delete(b.dataset.id);editorDirty.delete(b.dataset.id);
    loadPortfolios();
  });
}

function renderPortfolioCard(p){
  const expanded=expandedPortfolios.has(p.id);
  const readiness=dataReadinessLabel(p);
  const dirty=editorDirty.has(p.id);
  const lastResultText=p.last_backtest_summary?`${p.last_backtest_summary>0?"+":""}${p.last_backtest_summary}%`:null;
  return `<article class="portfolio-card accordion ${expanded?'open':''}" data-portfolio-card="${p.id}">
    <div class="accordion-header" data-toggle-portfolio="${p.id}" role="button" tabindex="0" aria-expanded="${expanded}">
      <span class="accordion-arrow">${expanded?"▾":"▸"}</span>
      <div class="portfolio-card-main">
        <strong>${p.name}${dirty?' <span class="dirty-dot" title="Есть несохранённые изменения">●</span>':''}</strong>
        <small>${(p.instruments||[]).length} инструментов · ${money(p.starting_capital)} ₽</small>
        <small>${readiness.text} · ${strategySummaryLabel(p)}</small>
        <small class="portfolio-dates">Последний бэктест: ${p.last_backtest_at?formatDate(p.last_backtest_at)+(lastResultText?` (${lastResultText})`:''):"не запускался"}</small>
      </div>
      <button class="danger delete-portfolio" data-id="${p.id}" data-no-toggle="1">Удалить</button>
    </div>
    ${expanded?`<div class="accordion-body" data-no-toggle="1" id="editor-${p.id}"></div>`:""}
  </article>`;
}

// ---- inline full editor -----------------------------------------------
function draftOf(portfolioId){return editorDrafts[portfolioId]}
function markDirty(portfolioId){editorDirty.add(portfolioId);renderPortfolioCardDirtyDot(portfolioId)}
function renderPortfolioCardDirtyDot(portfolioId){
  const header=document.querySelector(`[data-portfolio-card="${portfolioId}"] strong`);
  if(header&&!header.querySelector(".dirty-dot"))header.insertAdjacentHTML("beforeend",' <span class="dirty-dot" title="Есть несохранённые изменения">●</span>');
}

function instrumentPositionValue(inst){
  const q=priceCache[inst.ticker];
  if(!q||q.last==null)return null;
  return q.last*(inst.lot_size||1)*(inst.lot_count||1);
}

function wirePortfolioEditor(portfolioId){
  const mount=document.getElementById(`editor-${portfolioId}`);
  if(!mount)return;
  mount.innerHTML=renderEditorHtml(portfolioId);
  bindEditorEvents(portfolioId);
}

function renderEditorHtml(portfolioId){
  const draft=draftOf(portfolioId);
  const instruments=draft.instruments||[];
  const rows=instruments.map(inst=>renderInstrumentRow(portfolioId,inst)).join("");
  const totals=computeEditorTotals(draft);
  return `
    <div class="form-grid three">
      <label>Название портфеля <input data-ed-field="name" value="${draft.name}"></label>
      <label>Стартовый капитал, ₽ <input data-ed-field="starting_capital" type="number" step="1000" value="${draft.starting_capital}"></label>
      <label>Стратегия по умолчанию <select data-ed-field="default_strategy_id">${Object.entries(window.STRATEGIES).map(([k,v])=>`<option value="${k}" ${draft.default_strategy_id===k?'selected':''}>${v.name}</option>`).join("")}</select></label>
    </div>
    <div class="allocation-row">
      <strong>Пересчитать распределение</strong>
      <div class="mode-tabs" data-ed-alloc-modes>
        <button type="button" class="mode-tab" data-ed-alloc="equal_lots">Одинаковое кол-во лотов</button>
        <button type="button" class="mode-tab" data-ed-alloc="equal_capital">Поровну по капиталу</button>
        <button type="button" class="mode-tab" data-ed-alloc="equal_lot_value">Поровну с учётом лота</button>
        <button type="button" class="mode-tab" data-ed-alloc="max_capital">Максимум капитала</button>
      </div>
    </div>
    <div class="editor-actions-row">
      <button class="secondary" data-ed-add-instruments="${portfolioId}">Добавить инструменты</button>
      <button class="secondary" data-ed-remove-selected="${portfolioId}">Удалить выбранные</button>
    </div>
    <div class="table-scroll instrument-editor-table">
      <table>
        <thead><tr>
          <th></th><th>Тикер</th><th>Цена</th><th>Лот</th><th>Кол-во лотов</th><th>Акций</th>
          <th>Стоимость</th><th>Доля</th><th>Данные</th><th>Стратегии</th>
        </tr></thead>
        <tbody id="ed-rows-${portfolioId}">${rows||'<tr><td colspan="10" class="empty">Инструментов нет.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="editor-summary" id="ed-summary-${portfolioId}">${renderEditorSummary(totals,draft)}</div>
    <div class="editor-save-row">
      <button class="primary" data-ed-save="${portfolioId}">Сохранить изменения</button>
      <button class="secondary" data-ed-cancel="${portfolioId}">Отменить изменения</button>
      <button class="secondary" data-ed-goto-backtest="${portfolioId}">Перейти к бэктесту</button>
    </div>
    <div class="message" id="ed-message-${portfolioId}"></div>`;
}

function computeEditorTotals(draft){
  const starting=Number(draft.starting_capital||0);
  let positions=0;
  (draft.instruments||[]).forEach(inst=>{const v=instrumentPositionValue(inst);if(v!=null)positions+=v});
  return {starting,positions,free:starting-positions,usedPct:starting>0?positions/starting*100:0};
}
function renderEditorSummary(totals,draft){
  const over=totals.free<0;
  return `<div class="summary-grid">
      <div><span>Стартовый капитал</span><strong>${money(totals.starting)} ₽</strong></div>
      <div><span>Предварительная стоимость позиций</span><strong>${money(totals.positions)} ₽</strong></div>
      <div><span>${over?"Превышение":"Свободный капитал"}</span><strong class="${over?'over-budget':''}">${money(Math.abs(totals.free))} ₽</strong></div>
      <div><span>Использовано</span><strong>${totals.usedPct.toFixed(2)}%</strong></div>
    </div>
    ${over?`<div class="budget-warning">Стоимость выбранных позиций превышает стартовый капитал на ${money(Math.abs(totals.free))} ₽.</div>`:""}`;
}

function renderInstrumentRow(portfolioId,inst){
  const sec=securities.find(s=>s.SECID===inst.ticker);
  const q=priceCache[inst.ticker];
  const priceText=q&&q.last!=null?`${money(q.last)} ₽${q.is_live?"":" <small>(закрытие)</small>"}`:"Цена недоступна";
  const value=instrumentPositionValue(inst);
  const shares=(inst.lot_size||1)*(inst.lot_count||1);
  const draft=draftOf(portfolioId);
  const totals=computeEditorTotals(draft);
  const share=totals.positions>0&&value!=null?(value/totals.positions*100).toFixed(1)+"%":"—";
  const dataStatus=sec?sec.DATA_STATUS:"none";
  const assignments=(draft.ticker_strategies||{})[inst.ticker]||[];
  const chips=assignments.filter(a=>a.enabled!==false).map((a,idx)=>{
    const name=(window.STRATEGIES[a.strategy_id]||{}).name||a.strategy_id;
    return `<button class="strategy-chip" data-ed-strategy-remove="${inst.ticker}" data-idx="${idx}" title="Убрать ${name}">${name}<span>×</span></button>`;
  }).join("")||`<span class="muted-note">по умолчанию: ${(window.STRATEGIES[draft.default_strategy_id]||{}).name||draft.default_strategy_id}</span>`;
  return `<tr data-ed-row="${inst.ticker}">
    <td><input type="checkbox" data-ed-select="${inst.ticker}"></td>
    <td><strong>${inst.ticker}</strong><br><small>${sec?sec.SHORTNAME:""}</small></td>
    <td>${priceText}</td>
    <td>${inst.lot_size||1}</td>
    <td class="lot-cell">
      <button type="button" class="lot-btn" data-ed-lot-minus="${inst.ticker}">−</button>
      <input type="number" min="0" step="1" value="${inst.lot_count||1}" data-ed-lot="${inst.ticker}">
      <button type="button" class="lot-btn" data-ed-lot-plus="${inst.ticker}">+</button>
    </td>
    <td>${shares}</td>
    <td>${value!=null?money(value)+" ₽":"—"}</td>
    <td>${share}</td>
    <td><span class="security-data-status ${DATA_STATUS_CLASS[dataStatus]||''}">${dataStatus==="none"?"Требуется загрузка":DATA_STATUS_LABEL[dataStatus]}</span>
        ${dataStatus!=="fresh"?`<button class="link-btn" data-ed-prepare-data="${inst.ticker}">Подготовить данные</button>`:""}</td>
    <td class="strategy-chips-cell">${chips}<button class="link-btn" data-ed-add-strategy="${inst.ticker}">+ Добавить</button>
      <div class="strategy-add-panel hidden" data-ed-strategy-panel="${inst.ticker}"></div></td>
  </tr>`;
}

function refreshEditorRow(portfolioId,ticker){
  const draft=draftOf(portfolioId);
  const inst=(draft.instruments||[]).find(i=>i.ticker===ticker);
  const row=document.querySelector(`#ed-rows-${portfolioId} [data-ed-row="${ticker}"]`);
  if(inst&&row){
    row.outerHTML=renderInstrumentRow(portfolioId,inst);
    bindRowEvents(portfolioId,ticker);
  }
  const summary=document.getElementById(`ed-summary-${portfolioId}`);
  if(summary)summary.innerHTML=renderEditorSummary(computeEditorTotals(draft),draft);
}

function bindRowEvents(portfolioId,ticker){
  const row=document.querySelector(`#ed-rows-${portfolioId} [data-ed-row="${ticker}"]`);
  if(!row)return;
  const draft=draftOf(portfolioId);
  const inst=(draft.instruments||[]).find(i=>i.ticker===ticker);
  const setLots=v=>{inst.lot_count=Math.max(0,Math.round(v));markDirty(portfolioId);refreshEditorRow(portfolioId,ticker)};
  row.querySelector("[data-ed-lot]").onchange=e=>setLots(Number(e.target.value||0));
  row.querySelector("[data-ed-lot-minus]").onclick=()=>setLots((inst.lot_count||0)-1);
  row.querySelector("[data-ed-lot-plus]").onclick=()=>setLots((inst.lot_count||0)+1);
  const prep=row.querySelector("[data-ed-prepare-data]");
  if(prep)prep.onclick=()=>{setBuildTarget(portfolioId);catalogSelected=new Set([ticker]);renderCatalog();activateTab("portfolio");$("securityList").scrollIntoView({behavior:"smooth"})};
  row.querySelectorAll("[data-ed-strategy-remove]").forEach(b=>b.onclick=()=>{
    const list=draft.ticker_strategies[ticker]||[];
    list.splice(Number(b.dataset.idx),1);
    if(!list.length)delete draft.ticker_strategies[ticker];
    markDirty(portfolioId);refreshEditorRow(portfolioId,ticker);
  });
  const addBtn=row.querySelector("[data-ed-add-strategy]");
  if(addBtn)addBtn.onclick=()=>toggleStrategyAddPanel(portfolioId,ticker);
}

function toggleStrategyAddPanel(portfolioId,ticker){
  const panel=document.querySelector(`[data-ed-strategy-panel="${ticker}"]`);
  if(!panel)return;
  if(!panel.classList.contains("hidden")){panel.classList.add("hidden");panel.innerHTML="";return}
  document.querySelectorAll(".strategy-add-panel").forEach(p=>{p.classList.add("hidden");p.innerHTML=""});
  const draft=draftOf(portfolioId);
  const used=new Set((draft.ticker_strategies[ticker]||[]).map(a=>a.strategy_id));
  const options=Object.entries(window.STRATEGIES).filter(([k])=>!used.has(k));
  panel.innerHTML=`<div class="strategy-add-list">${options.map(([k,v])=>`<button type="button" class="secondary" data-ed-pick-strategy="${k}">${v.name}</button>`).join("")||"<span class='muted-note'>Все стратегии уже добавлены</span>"}</div>`;
  panel.classList.remove("hidden");
  panel.querySelectorAll("[data-ed-pick-strategy]").forEach(b=>b.onclick=()=>{
    draft.ticker_strategies[ticker]=draft.ticker_strategies[ticker]||[];
    draft.ticker_strategies[ticker].push({strategy_id:b.dataset.edPickStrategy,parameters:{},enabled:true});
    markDirty(portfolioId);refreshEditorRow(portfolioId,ticker);
  });
}

function bindEditorEvents(portfolioId){
  const draft=draftOf(portfolioId);
  document.querySelectorAll(`#editor-${portfolioId} [data-ed-field]`).forEach(el=>{
    el.onchange=()=>{
      const f=el.dataset.edField;
      draft[f]=f==="starting_capital"?Number(el.value||0):el.value;
      markDirty(portfolioId);
      if(f==="starting_capital"){
        const s=document.getElementById(`ed-summary-${portfolioId}`);
        if(s)s.innerHTML=renderEditorSummary(computeEditorTotals(draft),draft);
      }
    };
  });
  (draft.instruments||[]).forEach(inst=>bindRowEvents(portfolioId,inst.ticker));
  document.querySelectorAll(`#editor-${portfolioId} [data-ed-alloc]`).forEach(b=>b.onclick=()=>applyEditorAllocation(portfolioId,b.dataset.edAlloc));
  const addBtn=document.querySelector(`#editor-${portfolioId} [data-ed-add-instruments]`);
  if(addBtn)addBtn.onclick=()=>{
    if(!confirmDiscardIfDirty(portfolioId))return;
    setBuildTarget(portfolioId);activateTab("portfolio");$("securityList").scrollIntoView({behavior:"smooth"});
  };
  const removeBtn=document.querySelector(`#editor-${portfolioId} [data-ed-remove-selected]`);
  if(removeBtn)removeBtn.onclick=()=>{
    const checked=[...document.querySelectorAll(`#editor-${portfolioId} [data-ed-select]:checked`)].map(c=>c.dataset.edSelect);
    if(!checked.length){alert("Отметьте инструменты для удаления галочками в первом столбце");return}
    draft.instruments=(draft.instruments||[]).filter(i=>!checked.includes(i.ticker));
    checked.forEach(t=>delete draft.ticker_strategies[t]);
    markDirty(portfolioId);wirePortfolioEditor(portfolioId);
  };
  const saveBtn=document.querySelector(`#editor-${portfolioId} [data-ed-save]`);
  if(saveBtn)saveBtn.onclick=()=>saveEditor(portfolioId);
  const cancelBtn=document.querySelector(`#editor-${portfolioId} [data-ed-cancel]`);
  if(cancelBtn)cancelBtn.onclick=()=>{
    editorDrafts[portfolioId]=JSON.parse(JSON.stringify(portfolios.find(p=>p.id===portfolioId)));
    editorDirty.delete(portfolioId);
    wirePortfolioEditor(portfolioId);
    renderPortfolioList();
  };
  const gotoBt=document.querySelector(`#editor-${portfolioId} [data-ed-goto-backtest]`);
  if(gotoBt)gotoBt.onclick=()=>{
    if(!confirmDiscardIfDirty(portfolioId))return;
    activePortfolioId=portfolioId;localStorage.setItem("moexlab_active_portfolio",portfolioId);activateTab("backtest");
  };
}

function applyEditorAllocation(portfolioId,mode){
  const draft=draftOf(portfolioId);
  const items=draft.instruments||[];
  if(!items.length)return;
  const capital=Number(draft.starting_capital||0);
  if(mode==="equal_lots"){
    const n=Number(prompt("Одинаковое количество лотов на инструмент:","1")||1);
    items.forEach(i=>i.lot_count=Math.max(0,Math.round(n)));
  }else if(mode==="equal_capital"){
    const per=capital/items.length;
    items.forEach(i=>{const q=priceCache[i.ticker];const lotValue=q&&q.last?q.last*(i.lot_size||1):null;
      i.lot_count=lotValue&&lotValue>0?Math.max(1,Math.floor(per/lotValue)):1;});
  }else if(mode==="equal_lot_value"){
    const totalLotValue=items.reduce((s,i)=>{const q=priceCache[i.ticker];return s+((q&&q.last?q.last*(i.lot_size||1):0))},0)||1;
    items.forEach(i=>{const q=priceCache[i.ticker];const lotValue=q&&q.last?q.last*(i.lot_size||1):0;
      const target=capital*(lotValue/totalLotValue||1/items.length);
      i.lot_count=lotValue>0?Math.max(1,Math.floor(target/lotValue)):1;});
  }else if(mode==="max_capital"){
    let remaining=capital;
    items.forEach(i=>{const q=priceCache[i.ticker];const lotValue=q&&q.last?q.last*(i.lot_size||1):null;
      if(!lotValue||lotValue<=0){i.lot_count=1;return}
      const n=Math.max(1,Math.floor(remaining/items.length/lotValue));
      i.lot_count=n;remaining-=n*lotValue;});
  }
  markDirty(portfolioId);wirePortfolioEditor(portfolioId);
}

async function saveEditor(portfolioId){
  const draft=draftOf(portfolioId);
  const msg=document.getElementById(`ed-message-${portfolioId}`);
  const saveBtn=document.querySelector(`#editor-${portfolioId} [data-ed-save]`);
  const totals=computeEditorTotals(draft);
  if(totals.free<0&&!confirm(`Стоимость позиций превышает капитал на ${money(Math.abs(totals.free))} ₽. Сохранить всё равно?`))return;
  if(saveBtn){saveBtn.disabled=true;saveBtn.textContent="Сохраняем…"}
  try{
    const r=await fetch(`/api/portfolios/${portfolioId}`,{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name:draft.name,starting_capital:draft.starting_capital,default_strategy_id:draft.default_strategy_id,
                            instruments:draft.instruments,ticker_strategies:draft.ticker_strategies})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Не удалось сохранить портфель");
    editorDirty.delete(portfolioId);
    if(msg)msg.textContent="Изменения сохранены";
    await loadPortfolios();
    expandedPortfolios.add(portfolioId);
    editorDrafts[portfolioId]=JSON.parse(JSON.stringify(portfolios.find(p=>p.id===portfolioId)));
    renderPortfolioList();
  }catch(e){
    if(msg)msg.textContent=`Ошибка: ${e.message}`;
  }finally{
    if(saveBtn){saveBtn.disabled=false;saveBtn.textContent="Сохранить изменения"}
  }
}

// ---------------------------------------------------------------- strategies
function fillStrategies(){
  $("strategyCards").innerHTML=Object.entries(window.STRATEGIES).map(([k,v])=>`<article class="strategy-card ${v.primary?"primary-strategy":""}"><div class="strategy-visual">${v.visual}</div><span>${v.category}</span><h3>${v.name}</h3><p>${v.summary}</p><button class="secondary choose-strategy" data-strategy="${k}">Применить к портфелю</button></article>`).join("");
  document.querySelectorAll(".choose-strategy").forEach(b=>b.onclick=()=>applyStrategyToActivePortfolio(b.dataset.strategy));
}
function renderStrategiesContext(){
  const p=portfolios.find(x=>x.id===activePortfolioId);
  $("strategiesContext").textContent=p?`Активный портфель: «${p.name}»`:"Портфель не выбран — сначала сформируйте его на вкладке «Портфель».";
}
async function applyStrategyToActivePortfolio(strategyId){
  if(!activePortfolioId||!portfolios.some(p=>p.id===activePortfolioId)){
    setStatus("Сначала сформируйте или откройте портфель на вкладке «Портфель»","error");
    activateTab("portfolio");return;
  }
  await fetch(`/api/portfolios/${activePortfolioId}/strategies`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({default_strategy_id:strategyId})});
  await loadPortfolios();
  setStatus("Стратегия по умолчанию применена к портфелю","success");
  activateTab("backtest");
}

// ----------------------------------------------------------------- backtest
$("goToPortfolioTab").onclick=()=>activateTab("portfolio");
$("applyStrategyPrompt").onclick=()=>{
  if(!btPortfolio)return;
  expandedPortfolios.add(btPortfolio.id);
  activateTab("portfolio");
  renderPortfolioList();
  document.querySelector(`[data-portfolio-card="${btPortfolio.id}"]`)?.scrollIntoView({behavior:"smooth"});
};
$("backtestPortfolioSelect").onchange=e=>selectBacktestPortfolio(e.target.value);

function renderBacktestTab(){
  if(!portfolios.length){
    $("backtestNoPortfolio").classList.remove("hidden");
    $("backtestBody").classList.add("hidden");
    return;
  }
  $("backtestNoPortfolio").classList.add("hidden");
  $("backtestBody").classList.remove("hidden");
  $("backtestPortfolioSelect").innerHTML=portfolios.map(p=>`<option value="${p.id}">${p.name} (${(p.instruments||[]).length})</option>`).join("");
  const wantId=activePortfolioId&&portfolios.some(p=>p.id===activePortfolioId)?activePortfolioId:portfolios[0].id;
  $("backtestPortfolioSelect").value=wantId;
  selectBacktestPortfolio(wantId);
  populateHistoryFilters();
  loadHistory(1);
}
function selectBacktestPortfolio(id){
  btPortfolio=portfolios.find(p=>p.id===id);
  if(!btPortfolio)return;
  activePortfolioId=id;localStorage.setItem("moexlab_active_portfolio",id);
  if(window.refreshPortfolioBalance)window.refreshPortfolioBalance();
  btIncluded=new Set((btPortfolio.instruments||[]).map(i=>i.ticker));
  renderBacktestSectorFilter();
  renderBacktestChips();
  $("backtestResults").classList.add("hidden");
  lastBacktestResult=null;
  resumeBacktestJobIfAny();
}
function pluralSuffix(n){const m10=n%10,m100=n%100;if(m100>=11&&m100<=14)return"ов";if(m10===1)return"";if(m10>=2&&m10<=4)return"а";return"ов"}

function resolveComboCount(){
  if(!btPortfolio)return{total:0,byTicker:[]};
  const ts=btPortfolio.ticker_strategies||{};
  const byTicker=[...btIncluded].map(ticker=>{
    const enabled=(ts[ticker]||[]).filter(a=>a.enabled!==false);
    const n=enabled.length||1;
    const names=enabled.length?enabled.map(a=>(window.STRATEGIES[a.strategy_id]||{}).name||a.strategy_id):
      [(window.STRATEGIES[btPortfolio.default_strategy_id]||{}).name||btPortfolio.default_strategy_id];
    return{ticker,count:n,names};
  });
  return{total:byTicker.reduce((s,x)=>s+x.count,0),byTicker};
}
function renderComboEstimate(){
  const est=resolveComboCount();
  $("comboEstimate").innerHTML=est.total?`<strong>Будет выполнено ${est.total} расчёт${pluralSuffix(est.total)}:</strong> `+
    est.byTicker.map(x=>`${x.ticker} × ${x.count}`).join(", "):"Выберите хотя бы один инструмент.";
  $("runBacktestBtn").textContent=est.total?`Запустить бэктест (${est.total} расчёт${pluralSuffix(est.total)})`:"Выберите инструменты";
  $("runBacktestBtn").disabled=est.total===0;
  $("backtestSelectedCount").textContent=btIncluded.size;
  $("backtestTotalCount").textContent=(btPortfolio?.instruments||[]).length;
}
function renderBacktestChips(){
  const all=btPortfolio.instruments||[];
  $("backtestTickerChips").innerHTML=all.map(i=>{
    const on=btIncluded.has(i.ticker);
    return `<button class="ticker-chip toggle-chip ${on?'on':'off'}" data-bt-ticker="${i.ticker}">${i.ticker}${on?' ✓':' ×'}</button>`;
  }).join("");
  document.querySelectorAll("[data-bt-ticker]").forEach(b=>b.onclick=()=>{
    const t=b.dataset.btTicker;
    btIncluded.has(t)?btIncluded.delete(t):btIncluded.add(t);
    renderBacktestChips();
  });
  renderComboEstimate();
}
function renderBacktestSectorFilter(){
  const sectors=[...new Set((btPortfolio.instruments||[]).map(i=>{const sec=securities.find(s=>s.SECID===i.ticker);return sec?sec.SECTOR:"Прочее"}))];
  $("selectBySector").innerHTML=`<option value="">По отрасли…</option>`+sectors.map(s=>`<option value="${s}">${s}</option>`).join("");
}
$("selectAllTickers").onclick=()=>{btIncluded=new Set((btPortfolio.instruments||[]).map(i=>i.ticker));renderBacktestChips()};
$("clearAllTickers").onclick=()=>{btIncluded.clear();renderBacktestChips()};
$("selectDataReadyTickers").onclick=()=>{
  btIncluded=new Set((btPortfolio.instruments||[]).filter(i=>{const sec=securities.find(s=>s.SECID===i.ticker);return !sec||sec.DATA_STATUS==="fresh"}).map(i=>i.ticker));
  renderBacktestChips();
};
$("selectBySector").onchange=e=>{
  const sector=e.target.value;if(!sector)return;
  (btPortfolio.instruments||[]).forEach(i=>{const sec=securities.find(s=>s.SECID===i.ticker);if((sec?sec.SECTOR:"Прочее")===sector)btIncluded.add(i.ticker)});
  renderBacktestChips();
  e.target.value="";
};

async function startBacktest(){
  if(!btIncluded.size)return;
  $("runBacktestBtn").disabled=true;
  $("backtestProgress").classList.remove("hidden");
  $("backtestResults").classList.add("hidden");
  $("backtestMessage").textContent="";
  const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),15000);
  try{
    const r=await fetch(`/api/portfolios/${btPortfolio.id}/backtest`,{method:"POST",headers:{"Content-Type":"application/json"},signal:ctrl.signal,
      body:JSON.stringify({tickers:[...btIncluded],date_from:$("backtestFrom").value||undefined,date_to:$("backtestTill").value||undefined})});
    clearTimeout(t);
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Не удалось запустить бэктест");
    backtestJobId=d.job_id;
    localStorage.setItem("moexlab_backtest_job",JSON.stringify({jobId:d.job_id,portfolioId:btPortfolio.id}));
    pollBacktestJob(d.job_id);
  }catch(e){
    clearTimeout(t);
    renderComboEstimate();
    $("backtestProgress").classList.add("hidden");
    const msg=e.name==="AbortError"?"Сервер не ответил на запуск":e.message;
    $("backtestMessage").textContent=`Ошибка: ${msg}`;
    setStatus(`Ошибка запуска бэктеста: ${msg}`,"error");
  }
}
$("runBacktestBtn").onclick=startBacktest;
$("cancelBacktestBtn").onclick=async()=>{if(backtestJobId)try{await fetch(`/api/jobs/${backtestJobId}/cancel`,{method:"POST"})}catch(e){}};

function renderBacktestProgress(job){
  $("backtestProgressFill").style.width=`${job.percent||0}%`;
  $("backtestProgressPercent").textContent=`${job.percent||0}%`;
  $("backtestProgressStage").textContent=job.stage||"—";
  $("backtestProgressCounts").textContent=`${job.completed||0} из ${job.total||0}`;
}
const BACKTEST_TERMINAL=["completed","completed_with_errors","failed","canceled"];
function pollBacktestJob(jobId){
  if(backtestPollTimer)clearTimeout(backtestPollTimer);
  const tick=async()=>{
    const ctrl=new AbortController();const abortT=setTimeout(()=>ctrl.abort(),10000);
    try{
      const r=await fetch(`/api/jobs/${jobId}`,{signal:ctrl.signal});
      clearTimeout(abortT);
      if(r.status===404){
        localStorage.removeItem("moexlab_backtest_job");
        renderComboEstimate();$("backtestProgress").classList.add("hidden");
        setStatus("Задача бэктеста не найдена (сервис мог перезапуститься)","error");
        return;
      }
      const job=await r.json();
      renderBacktestProgress(job);
      if(BACKTEST_TERMINAL.includes(job.status)){
        localStorage.removeItem("moexlab_backtest_job");
        renderComboEstimate();$("backtestProgress").classList.add("hidden");
        if(job.status==="completed"||job.status==="completed_with_errors"){
          renderBacktestResult(job.result);
          setStatus(job.status==="completed"?"Бэктест завершён":"Бэктест завершён с ошибками по части комбинаций","success");
          await loadPortfolios();
          loadHistory(1);
          if(window.refreshPortfolioBalance)window.refreshPortfolioBalance();
        }else{
          $("backtestMessage").textContent=`${job.status==="canceled"?"Отменено":"Ошибка"}: ${job.error?.message||"неизвестная ошибка"}`;
          setStatus(job.status==="canceled"?"Бэктест отменён":"Ошибка бэктеста","error");
        }
        return;
      }
      backtestPollTimer=setTimeout(tick,1200);
    }catch(e){
      clearTimeout(abortT);
      $("backtestProgressStage").textContent=e.name==="AbortError"?"Сервер не отвечает…":`Сетевая ошибка: ${e.message}`;
      backtestPollTimer=setTimeout(tick,2500);
    }
  };
  tick();
}
function resumeBacktestJobIfAny(){
  const raw=localStorage.getItem("moexlab_backtest_job");
  if(!raw)return;
  try{
    const{jobId,portfolioId}=JSON.parse(raw);
    if(jobId&&btPortfolio&&portfolioId===btPortfolio.id){
      $("backtestProgress").classList.remove("hidden");
      pollBacktestJob(jobId);
    }
  }catch(e){localStorage.removeItem("moexlab_backtest_job")}
}

function renderMetrics(s,target){
  const pnl=(s.final_capital_rub||0)-(s.starting_capital_rub||0);
  const fields=[
    ["Доходность",`${s.return_pct??0}%`],["Прибыль/убыток",`${money(pnl)} ₽`],
    ["Просадка",`${s.max_drawdown_pct??0}%`],["Сделок",s.trades??0],["Win Rate",`${s.win_rate??0}%`],
    ["Profit Factor",s.profit_factor??"—"],["Sharpe (оценка)",s.sharpe_ratio??"—"],
    ["Использование капитала",`${s.capital_utilization_pct??0}%`],["Капитал",`${money(s.final_capital_rub)} ₽`],
  ];
  $(target).innerHTML=fields.map(([a,b])=>`<div class="metric"><span>${a}</span><strong>${b}</strong></div>`).join("");
}
function renderBacktestResult(result){
  lastBacktestResult=result;
  $("backtestResults").classList.remove("hidden");
  renderMetrics(result,"portfolioMetrics");
  const errs=result.ticker_errors||[];
  $("backtestErrors").innerHTML=errs.length?`<strong>Не удалось рассчитать (${errs.length}):</strong>`+errs.map(e=>`<div class="build-error-row"><span>${e.ticker}${e.strategy_id?` — ${e.strategy_id}`:""}: ${e.message}</span></div>`).join(""):"";
  renderByTickerTable();
  renderByStrategyTable(result.by_strategy||[]);
}
const BY_TICKER_COLUMNS=[["ticker","Тикер"],["strategy_name","Стратегия"],["trades","Сделок"],["pnl_rub","Прибыль ₽"],["win_rate","Win Rate"],["max_drawdown_pct","Просадка"]];
function renderByTickerTable(){
  if(!lastBacktestResult)return;
  const rows=[...(lastBacktestResult.by_ticker||[])].sort((a,b)=>{
    const k=byTickerSort.key,av=a[k],bv=b[k];
    const cmp=typeof av==="number"&&typeof bv==="number"?av-bv:String(av).localeCompare(String(bv));
    return cmp*byTickerSort.dir;
  });
  $("byTickerTable").innerHTML=`<div class="table-scroll"><table><thead><tr>${BY_TICKER_COLUMNS.map(([k,l])=>`<th data-sort-key="${k}" class="sortable ${byTickerSort.key===k?'sorted':''}">${l}${byTickerSort.key===k?(byTickerSort.dir>0?' ↑':' ↓'):''}</th>`).join("")}<th></th></tr></thead><tbody>${
    rows.map(r=>`<tr><td>${r.ticker}</td><td>${r.strategy_name||"—"}</td><td>${r.trades}</td><td>${r.pnl_rub}</td><td>${r.win_rate}%</td><td>${r.max_drawdown_pct}%</td><td>${r.run_id?`<button class="link-btn" data-open-run="${r.run_id}">Подробнее</button>`:"—"}</td></tr>`).join("")
  }</tbody></table></div>`;
  document.querySelectorAll("[data-sort-key]").forEach(th=>th.onclick=()=>{
    const key=th.dataset.sortKey;
    byTickerSort.dir=byTickerSort.key===key?-byTickerSort.dir:-1;byTickerSort.key=key;
    renderByTickerTable();
  });
  document.querySelectorAll("[data-open-run]").forEach(b=>b.onclick=()=>window.open(`/api/result/${b.dataset.openRun}/trades.csv`,"_blank"));
}
function renderByStrategyTable(rows){
  if(!rows.length){$("byStrategyTable").innerHTML="";return}
  $("byStrategyTable").innerHTML=`<h3 style="margin-top:22px">По стратегиям</h3><div class="table-scroll"><table><thead><tr><th>Стратегия</th><th>Тикеров</th><th>Сделок</th><th>Прибыль ₽</th><th>Средний Win Rate</th></tr></thead><tbody>${
    rows.map(r=>`<tr><td>${r.strategy_name}</td><td>${r.tickers}</td><td>${r.trades}</td><td>${r.pnl_rub}</td><td>${r.avg_win_rate}%</td></tr>`).join("")
  }</tbody></table></div>`;
}

// ---------------------------------------------------------- backtest history
function populateHistoryFilters(){
  $("historyFilterPortfolio").innerHTML=`<option value="">Все портфели</option>`+portfolios.map(p=>`<option value="${p.id}">${p.name}</option>`).join("");
  $("historyFilterStrategy").innerHTML=`<option value="">Все стратегии</option>`+Object.entries(window.STRATEGIES).map(([k,v])=>`<option value="${k}">${v.name}</option>`).join("");
  $("tvFilterStrategy").innerHTML=`<option value="">Все стратегии</option>`+Object.entries(window.STRATEGIES).map(([k,v])=>`<option value="${k}">${v.name}</option>`).join("");
  ["historyFilterPortfolio","historyFilterTicker","historyFilterStrategy","historyFilterStatus","historyFilterDateFrom","historyFilterDateTo"].forEach(id=>{
    $(id).onchange=()=>loadHistory(1);
  });
}
const HISTORY_STATUS_LABEL={running:"Выполняется",queued:"В очереди",completed:"Завершён",completed_with_errors:"С ошибками",failed:"Ошибка",canceled:"Отменён"};
async function loadHistory(page){
  historyPage=page;
  const params=new URLSearchParams({page,page_size:historyPageSize});
  const pf=$("historyFilterPortfolio").value; if(pf)params.set("portfolio_id",pf);
  const tk=$("historyFilterTicker").value.trim(); if(tk)params.set("ticker",tk.toUpperCase());
  const sg=$("historyFilterStrategy").value; if(sg)params.set("strategy_id",sg);
  const st=$("historyFilterStatus").value; if(st)params.set("status",st);
  const df=$("historyFilterDateFrom").value; if(df)params.set("date_from",df);
  const dt=$("historyFilterDateTo").value; if(dt)params.set("date_to",dt);
  const r=await fetch(`/api/backtests?${params}`);
  const d=await r.json();
  historyTotal=d.total;
  renderHistoryTable(d.items);
  renderHistoryPagination();
}
function renderHistoryTable(items){
  if(!items.length){$("historyTable").innerHTML="<div class='empty'>Запусков пока нет.</div>";return}
  $("historyTable").innerHTML=`<div class="table-scroll"><table><thead><tr>
    <th>Дата</th><th>Портфель</th><th>Комбинаций</th><th>Статус</th><th>Доходность</th><th>Просадка</th><th>Сделок</th><th>Длительность</th><th></th>
  </tr></thead><tbody>${items.map(it=>{
    const duration=it.completed_at&&it.started_at?`${(it.completed_at-it.started_at).toFixed(1)}с`:"—";
    return `<tr>
      <td>${fmtDateTime(it.created_at)}</td>
      <td>${it.portfolio_name_snapshot||"—"}</td>
      <td>${it.combinations_ok||0}/${it.combinations_count||0}</td>
      <td><span class="pill status-${it.status}">${HISTORY_STATUS_LABEL[it.status]||it.status}</span></td>
      <td>${it.return_percent!=null?it.return_percent+"%":"—"}</td>
      <td>${it.max_drawdown!=null?it.max_drawdown+"%":"—"}</td>
      <td>${it.trades_count??"—"}</td>
      <td>${duration}</td>
      <td class="history-actions">
        <button class="link-btn" data-hist-trades="${it.id}">Сделки</button>
        <button class="link-btn" data-hist-repeat="${it.id}">Повторить</button>
        <a class="link-btn" href="/api/backtests/${it.id}/export.csv">CSV</a>
        <a class="link-btn" href="/api/backtests/${it.id}/export.json">JSON</a>
        <button class="link-btn danger-link" data-hist-delete="${it.id}">Удалить</button>
      </td>
    </tr>`;
  }).join("")}</tbody></table></div>`;
  document.querySelectorAll("[data-hist-trades]").forEach(b=>b.onclick=()=>openTradeViewer(b.dataset.histTrades));
  document.querySelectorAll("[data-hist-repeat]").forEach(b=>b.onclick=async()=>{
    const r=await fetch(`/api/backtests/${b.dataset.histRepeat}/repeat`,{method:"POST"});
    const d=await r.json();
    if(!r.ok){alert(d.error||"Не удалось повторить запуск");return}
    backtestJobId=d.job_id;
    $("backtestProgress").classList.remove("hidden");
    pollBacktestJob(d.job_id);
    setStatus("Повторный расчёт запущен","working");
  });
  document.querySelectorAll("[data-hist-delete]").forEach(b=>b.onclick=async()=>{
    if(!confirm("Удалить этот запуск бэктеста из истории? Это действие необратимо."))return;
    await fetch(`/api/backtests/${b.dataset.histDelete}`,{method:"DELETE"});
    loadHistory(historyPage);
  });
}
function renderHistoryPagination(){
  const pages=Math.max(1,Math.ceil(historyTotal/historyPageSize));
  $("historyPagination").innerHTML=`<button class="secondary" ${historyPage<=1?"disabled":""} id="histPrev">← Назад</button>
    <span>Страница ${historyPage} из ${pages} (${historyTotal})</span>
    <button class="secondary" ${historyPage>=pages?"disabled":""} id="histNext">Вперёд →</button>`;
  const prev=document.getElementById("histPrev"),next=document.getElementById("histNext");
  if(prev)prev.onclick=()=>loadHistory(historyPage-1);
  if(next)next.onclick=()=>loadHistory(historyPage+1);
}

// ------------------------------------------------------------- trade viewer
let tvActiveView="trades";
function setTvView(view){
  tvActiveView=view;
  document.querySelectorAll(".tv-subtab").forEach(b=>b.classList.toggle("active",b.dataset.tvView===view));
  $("tvTradesView").classList.toggle("hidden",view!=="trades");
  $("tvChartView").classList.toggle("hidden",view!=="chart");
  if(view==="chart"&&window.TradeChart)window.TradeChart.activate($("tvChartView"));
}
document.querySelectorAll(".tv-subtab").forEach(b=>b.onclick=()=>setTvView(b.dataset.tvView));

async function openTradeViewer(runId,focusTradeId){
  tvRunId=runId;tvPage=1;
  $("tradeViewer").classList.remove("hidden");
  $("tradeDetail").classList.add("hidden");
  const run=await fetch(`/api/backtests/${runId}`).then(r=>r.json());
  $("tradeViewerHead").innerHTML=`<h3>Сделки: ${run.portfolio_name_snapshot||"портфель"}</h3><p class="muted-note">${fmtDateTime(run.created_at)} · ${run.combinations_ok}/${run.combinations_count} комбинаций</p>`;
  $("tvFilterTicker").innerHTML=`<option value="">Все тикеры</option>`+[...new Set((run.results||[]).map(r=>r.ticker))].map(t=>`<option value="${t}">${t}</option>`).join("");
  window.TradeChart&&window.TradeChart.setRun(run);
  loadTrades();
  if(focusTradeId!=null){
    setTvView("chart");
    window.TradeChart&&window.TradeChart.focusTrade(focusTradeId);
  } else {
    setTvView("trades");
  }
}
window.openTradeViewer=openTradeViewer;
window.money=money;
window.fmtDateTime=fmtDateTime;
window.highlightTradeRow=function(id){
  document.querySelectorAll("[data-row-id].trade-row-highlight").forEach(el=>el.classList.remove("trade-row-highlight"));
  const row=document.querySelector(`[data-row-id="${id}"]`);
  if(row){row.classList.add("trade-row-highlight");row.scrollIntoView({block:"nearest"});}
};
["tvFilterTicker","tvFilterStrategy","tvFilterProfitable","tvFilterDirection","tvFilterExitReason"].forEach(id=>{
  document.getElementById(id).onchange=()=>{tvPage=1;loadTrades()};
});
async function loadTrades(){
  const params=new URLSearchParams({page:tvPage,page_size:tvPageSize});
  const t=$("tvFilterTicker").value; if(t)params.set("ticker",t);
  const s=$("tvFilterStrategy").value; if(s)params.set("strategy_id",s);
  const p=$("tvFilterProfitable").value; if(p)params.set("profitable",p);
  const dir=$("tvFilterDirection").value; if(dir)params.set("direction",dir);
  const er=$("tvFilterExitReason").value; if(er)params.set("exit_reason",er);
  const r=await fetch(`/api/backtests/${tvRunId}/trades?${params}`);
  const d=await r.json();
  renderTradesTable(d.items,d.total);
}
function renderTradesTable(items,total){
  if(!items.length){$("tvTable").innerHTML="<div class='empty'>Сделок не найдено по текущим фильтрам.</div>";$("tvPagination").innerHTML="";return}
  $("tvTable").innerHTML=`<div class="table-scroll"><table><thead><tr>
    <th>#</th><th>Тикер</th><th>Стратегия</th><th>Направление</th><th>Вход</th><th>Выход</th><th>Лоты</th><th>Прибыль</th><th>Доходность</th><th>Причина</th><th></th>
  </tr></thead><tbody>${items.map((t,i)=>`<tr data-row-id="${t.id}">
      <td>${(tvPage-1)*tvPageSize+i+1}</td><td>${t.ticker}</td><td>${(window.STRATEGIES[t.strategy_id]||{}).name||t.strategy_id}</td>
      <td>${t.direction}</td><td>${t.entry_datetime}<br><small>${money(t.entry_price)} ₽</small></td>
      <td>${t.exit_datetime}<br><small>${money(t.exit_price)} ₽</small></td><td>${t.quantity_lots}</td>
      <td class="${t.net_profit>0?'pnl-pos':'pnl-neg'}">${money(t.net_profit)} ₽</td><td>${t.return_percent}%</td><td>${t.exit_reason||"—"}</td>
      <td><button class="link-btn" data-trade-detail="${t.id}">Подробнее</button> <button class="link-btn" data-trade-chart="${t.id}">На графике</button></td>
    </tr>`).join("")}</tbody></table></div>`;
  document.querySelectorAll("[data-trade-detail]").forEach(b=>b.onclick=()=>openTradeDetail(b.dataset.tradeDetail));
  document.querySelectorAll("[data-trade-chart]").forEach(b=>b.onclick=()=>{setTvView("chart");window.TradeChart&&window.TradeChart.focusTrade(b.dataset.tradeChart);});
  document.querySelectorAll("[data-row-id]").forEach(row=>row.onclick=(e)=>{
    if(e.target.closest("button"))return; // buttons above already handle their own action
    setTvView("chart");window.TradeChart&&window.TradeChart.focusTrade(row.dataset.rowId);
  });
  const pages=Math.max(1,Math.ceil(total/tvPageSize));
  $("tvPagination").innerHTML=`<button class="secondary" ${tvPage<=1?"disabled":""} id="tvPrev">← Назад</button><span>Страница ${tvPage} из ${pages} (${total})</span><button class="secondary" ${tvPage>=pages?"disabled":""} id="tvNext">Вперёд →</button>`;
  const prev=document.getElementById("tvPrev"),next=document.getElementById("tvNext");
  if(prev)prev.onclick=()=>{tvPage--;loadTrades()};
  if(next)next.onclick=()=>{tvPage++;loadTrades()};
}
async function openTradeDetail(tradeId){
  const t=await fetch(`/api/backtests/${tvRunId}/trades/${tradeId}`).then(r=>r.json());
  const meta=t.signal_metadata||{};
  const riskRub=t.stop_loss&&t.entry_price?Math.abs(t.entry_price-t.stop_loss)*t.quantity_shares:null;
  const riskPct=t.stop_loss&&t.entry_price?Math.abs(t.entry_price-t.stop_loss)/t.entry_price*100:null;
  const rr=t.take_profit&&t.stop_loss&&t.entry_price?Math.abs(t.take_profit-t.entry_price)/Math.abs(t.entry_price-t.stop_loss):null;
  const candlesHtml=(t.candles||[]).slice(0,60).map(c=>`<tr><td>${c.time}</td><td>${c.open}</td><td>${c.high}</td><td>${c.low}</td><td>${c.close}</td></tr>`).join("");
  $("tradeDetail").innerHTML=`
    <h3>Сделка #${t.id} — ${t.ticker} (${(window.STRATEGIES[t.strategy_id]||{}).name||t.strategy_id})</h3>
    <div class="summary-grid">
      <div><span>Направление</span><strong>${t.direction}</strong></div>
      <div><span>Вход</span><strong>${money(t.entry_price)} ₽ · ${t.entry_datetime}</strong></div>
      <div><span>Выход</span><strong>${money(t.exit_price)} ₽ · ${t.exit_datetime}</strong></div>
      <div><span>Причина выхода</span><strong>${t.exit_reason||"—"}</strong></div>
      <div><span>Лоты/акции</span><strong>${t.quantity_lots} / ${t.quantity_shares}</strong></div>
      <div><span>Риск, ₽ / %</span><strong>${riskRub!=null?money(riskRub)+" ₽ / "+riskPct.toFixed(2)+"%":"—"}</strong></div>
      <div><span>Плановый R/R</span><strong>${rr!=null?rr.toFixed(2):"—"}</strong></div>
      <div><span>Валовая прибыль</span><strong>${money(t.gross_profit)} ₽</strong></div>
      <div><span>Комиссия</span><strong>${money(t.commission)} ₽</strong></div>
      <div><span>Чистая прибыль</span><strong>${money(t.net_profit)} ₽ (${t.return_percent}%)</strong></div>
      <div><span>MAE</span><strong>${meta.mae_pct!=null?meta.mae_pct+"%":"—"}</strong></div>
      <div><span>MFE</span><strong>${meta.mfe_pct!=null?meta.mfe_pct+"%":"—"}</strong></div>
      <div><span>Stop / Take</span><strong>${t.stop_loss?money(t.stop_loss):"—"} / ${t.take_profit?money(t.take_profit):"—"}</strong></div>
    </div>
    ${candlesHtml?`<h4 style="margin:16px 0 8px">Свечи вокруг сделки</h4><div class="table-scroll"><table><thead><tr><th>Время</th><th>Open</th><th>High</th><th>Low</th><th>Close</th></tr></thead><tbody>${candlesHtml}</tbody></table></div>`:""}
  `;
  $("tradeDetail").classList.remove("hidden");
  $("tradeDetail").scrollIntoView({behavior:"smooth"});
}
$("tradeViewerClose").onclick=()=>$("tradeViewer").classList.add("hidden");
$("tradeViewerBackdrop").onclick=()=>$("tradeViewer").classList.add("hidden");
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("tradeViewer").classList.contains("hidden"))$("tradeViewer").classList.add("hidden")});

// ------------------------------------------------------------- ticker tape
let tickerTapeTimer=null;
async function loadTickerTape(){
  try{
    const r=await fetch("/api/market-ticker");
    const d=await r.json();
    renderTickerTape(d);
    tickerTapeTimer=setTimeout(loadTickerTape,(d.quotes&&d.quotes.length)?45000:60000);
  }catch(e){
    renderTickerTape({quotes:[],error:"Котировки временно недоступны"});
    tickerTapeTimer=setTimeout(loadTickerTape,60000);
  }
}
function renderTickerTape(d){
  const track=$("tickerTapeTrack");
  const quotes=d.quotes||[];
  if(!quotes.length){track.innerHTML=`<div class="ticker-tape-empty">${d.error||"Котировки временно недоступны"}</div>`;return}
  const itemsHtml=quotes.map(q=>{
    const up=q.change_pct>0,down=q.change_pct<0;
    const arrow=up?"▲":down?"▼":"•";
    const cls=up?"up":down?"down":"flat";
    const stale=q.is_live?"":` <span class="tape-stale">Последние торги</span>`;
    return `<span class="ticker-tape-item ${cls}"><strong>${q.ticker}</strong> ${Number(q.last).toLocaleString('ru-RU')} ${arrow} ${q.change_pct>0?'+':''}${q.change_pct??0}%${stale}</span>`;
  }).join(`<span class="ticker-tape-sep">·</span>`);
  track.innerHTML=`<div class="ticker-tape-seq">${itemsHtml}</div><div class="ticker-tape-seq" aria-hidden="true">${itemsHtml}</div>`;
}

// ------------------------------------------------------------------- init
async function bootstrap(){
  renderPresets();
  fillStrategies();
  await Promise.all([loadSecurities(),loadPortfolios()]).catch(e=>{setStatus("Ошибка запуска","error");console.error(e)});
  renderStrategiesContext();
  initTabs();
  setBuildTarget(null);
  resumeBuildJob();
  loadTickerTape();
}
bootstrap();
