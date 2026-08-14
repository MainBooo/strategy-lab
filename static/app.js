const $=id=>document.getElementById(id);

function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

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
let dataGaps=[];
let dataGapLoading=new Set();
let timeframeGaps=[];
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

// ----------------------------------------------------------------- toast --
// Transient, dismissable confirmations for actions the user just took
// (backtest finished, strategy applied, portfolio saved) - separate from
// .status, which stays as the persistent "current state of the page" chip
// in the header. Container is created lazily so no template edit was
// needed anywhere a toast might fire from.
const TOAST_ICONS={
  success:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
  error:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'
};
function toastStack(){
  let el=$("toastStack");
  if(!el){el=document.createElement("div");el.id="toastStack";el.className="toast-stack";document.body.appendChild(el);}
  return el;
}
function showToast(message,type="info",timeout=4200){
  const stack=toastStack();
  const el=document.createElement("div");
  el.className=`toast ${type}`;
  el.innerHTML=`<span class="toast-icon">${TOAST_ICONS[type]||TOAST_ICONS.info}</span><span class="toast-body">${message}</span><button class="toast-close" aria-label="Закрыть" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  const remove=()=>{el.classList.add("leaving");el.addEventListener("animationend",()=>el.remove(),{once:true});};
  el.querySelector(".toast-close").onclick=remove;
  stack.appendChild(el);
  if(timeout)setTimeout(remove,timeout);
  return el;
}

// ------------------------------------------------------------ count-up --
// Short-lived rAF loop, not CSS - the target values (portfolio balance,
// backtest metrics) come from the server as final numbers with no
// intermediate frames to animate through, so the counting itself has to be
// synthesized. Skipped entirely under prefers-reduced-motion (jumps
// straight to the end value, single paint).
function animateNumber(el,from,to,fmt,duration=600){
  if(!el)return;
  if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches){el.textContent=fmt(to);return;}
  const start=performance.now();
  const step=now=>{
    const p=Math.min(1,(now-start)/duration);
    const eased=1-Math.pow(1-p,3);
    el.textContent=fmt(from+(to-from)*eased);
    if(p<1)requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ tabs --
// Sliding pill behind the active desktop tab (styles.css ".tab-indicator").
// Reads real layout (offsetLeft/offsetWidth) rather than hardcoding widths
// because the labels are Cyrillic and render at different widths per tab.
function positionTabIndicator(){
  const nav=$("appPrimaryTabs");
  if(!nav)return;
  const active=nav.querySelector(".tab.active");
  const indicator=nav.querySelector(".tab-indicator");
  if(!active||!indicator)return;
  indicator.style.width=active.offsetWidth+"px";
  indicator.style.transform=`translateX(${active.offsetLeft}px)`;
  nav.classList.add("indicator-ready");
  // First positioning must be instant (no slide-in from x:0) - the
  // "no-anim" class set in the template disables the transition for
  // exactly one frame, then this removes it so every later move animates.
  if(indicator.classList.contains("no-anim")){
    requestAnimationFrame(()=>indicator.classList.remove("no-anim"));
  }
}
window.addEventListener("resize",()=>positionTabIndicator());

let _activeTabName=null;
function activateTab(name){
  const leaving=_activeTabName;
  _activeTabName=name;
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.tab===name));
  document.querySelectorAll(".tab-page").forEach(x=>x.classList.add("hidden"));
  $("tab-"+name).classList.remove("hidden");
  localStorage.setItem("moexlab_active_tab",name);
  positionTabIndicator();
  // The charts terminal is a full-bleed workspace (no room for the hero/
  // ticker-tape chrome the rest of the app uses) - see styles.css
  // "charts terminal full-bleed" section.
  document.body.classList.toggle("charts-active",name==="charts");
  // Realtime polling (chart-analysis.js) only runs while its own tab is the
  // one on screen - leaving it stops the poller, and re-entering below
  // resumes it and fetches immediately instead of waiting for the next tick.
  if(leaving==="charts"&&leaving!==name&&window.ChartAnalysisPage&&window.ChartAnalysisPage.onTabLeave)window.ChartAnalysisPage.onTabLeave();
  if(name==="backtest")renderBacktestTab();
  if(name==="charts"&&window.ChartAnalysisPage)window.ChartAnalysisPage.init($("chartsRoot"));
  if(name==="replay"&&window.MarketReplayPage)window.MarketReplayPage.init($("replayRoot"));
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
function catalogSkeletonHtml(n){
  return Array.from({length:n},()=>`<div class="skeleton-row"></div>`).join("");
}
async function loadSecurities(refresh=false){
  setStatus("Загрузка справочника…","working");
  if($("securityList"))$("securityList").innerHTML=catalogSkeletonHtml(9);
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
function portfolioStrategyLine(p){
  const overrideTickers=Object.keys(p.ticker_strategies||{}).filter(t=>(p.ticker_strategies[t]||[]).some(a=>a.enabled!==false));
  if(!overrideTickers.length){
    const name=(window.STRATEGIES[p.default_strategy_id]||{}).name||p.default_strategy_id||"—";
    return `Стратегия: ${name}`;
  }
  return `Назначено стратегий: ${strategyAssignmentCount(p)}`;
}
function formatDate(ts){return ts?new Date(ts*1000).toLocaleDateString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric"}):"—"}

async function fetchStartupJson(url,timeoutMs=12000){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const r=await fetch(url,{signal:ctrl.signal,credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}});
    let d;
    try{d=await r.json();}
    catch(e){throw new Error(`Некорректный JSON (${r.status})`);}
    if(!r.ok)throw new Error((d&&d.error)||`HTTP ${r.status}`);
    return d;
  }finally{clearTimeout(timer)}
}

async function loadPortfolioBacktestSummaries(){
  try{
    const recent=await fetchStartupJson("/api/backtests?page_size=50");
    const latestByPortfolio={};
    (recent.items||[]).forEach(run=>{
      if(run.status!=="completed"&&run.status!=="completed_with_errors")return;
      if(!latestByPortfolio[run.portfolio_id])latestByPortfolio[run.portfolio_id]=run;
    });
    portfolios.forEach(p=>{p.last_backtest_summary=latestByPortfolio[p.id]?latestByPortfolio[p.id].return_percent:null});
    renderPortfolioList();
  }catch(e){
    console.warn("[startup] backtests failed",e);
    // Backtest history is optional enrichment. Portfolios remain usable.
  }
}

async function loadPortfolios(){
  const mount=$("portfolioList");
  if(mount)mount.innerHTML="<div class='empty'>Загрузка сохранённых портфелей…</div>";
  try{
    const data=await fetchStartupJson("/api/portfolios");
    portfolios=Array.isArray(data)?data:[];
    renderPortfolioList();
    // Do not make portfolio rendering wait for optional backtest history.
    void loadPortfolioBacktestSummaries();
    return portfolios;
  }catch(e){
    if(mount){
      mount.innerHTML=`<div class="empty">Не удалось загрузить портфели.<br><button class="secondary" id="retryPortfoliosBtn" type="button" style="margin-top:10px">Повторить</button></div>`;
      const retry=$("retryPortfoliosBtn");
      if(retry)retry.onclick=()=>{void startupTask("portfolios",()=>loadPortfolios())};
    }
    throw e;
  }
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
  const dirty=editorDirty.has(p.id);
  const instrumentCount=(p.instruments||[]).length;
  const lastResultText=p.last_backtest_summary?`${p.last_backtest_summary>0?"+":""}${p.last_backtest_summary}%`:null;
  return `<article class="portfolio-card accordion ${expanded?'open':''}" data-portfolio-card="${p.id}">
    <div class="accordion-header" data-toggle-portfolio="${p.id}" role="button" tabindex="0" aria-expanded="${expanded}">
      <span class="accordion-arrow">${expanded?"▾":"▸"}</span>
      <div class="portfolio-card-main">
        <strong>${p.name}${dirty?' <span class="dirty-dot" title="Есть несохранённые изменения">●</span>':''}</strong>
        <small>${instrumentCount} инструмент${pluralSuffix(instrumentCount)} · ${money(p.starting_capital)} ₽</small>
        <small>${portfolioStrategyLine(p)}</small>
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
          <th>Стоимость</th><th>Доля</th>
        </tr></thead>
        <tbody id="ed-rows-${portfolioId}">${rows||'<tr><td colspan="8" class="empty">Инструментов нет.</td></tr>'}</tbody>
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
const PRESET_RU_LABEL={standard:"Стандартный",conservative:"Консервативный",aggressive:"Агрессивный",custom:"Пользовательские настройки"};

// Mirrors strategies/param_schema.py's SECTION_LABELS/SECTION_ORDER - keep the
// keys in sync with the "section" tag on every schema field; labels are UI
// text only, no need to round-trip them through the API.
const PARAM_SECTION_ORDER=["basic","entry","filters","exit","risk"];
const PARAM_SECTION_LABELS={basic:"Основные параметры",entry:"Условия входа",filters:"Фильтры",exit:"Условия выхода",risk:"Управление риском"};

// ---- shared param-form building blocks (used by the Strategy Library card
// accordion below, and by the per-ticker strategy assignment panels on the
// Backtest tab) - each caller owns its own state object and persistence,
// this just turns a strategy's schema + current values into markup/DOM events.
function renderParamField(f,val,idPrefix){
  const tip=f.tooltip?`<span class="tip" data-tip="${escapeHtml(f.tooltip)}">?</span>`:"";
  const unit=f.unit?`<small class="param-unit">${escapeHtml(f.unit)}</small>`:"";
  if(f.type==="checkbox"){
    return `<div class="param-field param-field-checkbox">
      <label class="toggle"><input type="checkbox" data-param-field="${f.key}" ${val?"checked":""}><span>${escapeHtml(f.label)} — ${val?"Вкл":"Выкл"}</span></label>${tip}
    </div>`;
  }
  let input;
  if(f.type==="select"){
    input=`<select data-param-field="${f.key}">${(f.options||[]).map(o=>`<option value="${o.value}" ${o.value===val?"selected":""}>${escapeHtml(o.label)}</option>`).join("")}</select>`;
  }else if(f.type==="slider"){
    input=`<span class="range-inline param-slider"><input type="range" data-param-field="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}"><output id="${idPrefix}-out-${f.key}">${val}</output></span>`;
  }else{
    input=`<input type="number" data-param-field="${f.key}" min="${f.min ?? ""}" max="${f.max ?? ""}" step="${f.step ?? 1}" value="${val}">`;
  }
  return `<div class="param-field"><span class="param-field-label">${escapeHtml(f.label)}${tip}${unit}</span>${input}</div>`;
}
function paramFieldsHTML(strategyId,values,idPrefix){
  const schema=(window.STRATEGIES[strategyId]||{}).params||[];
  const bySection={};
  schema.forEach(f=>{const s=f.section||"basic";(bySection[s]=bySection[s]||[]).push(f)});
  return PARAM_SECTION_ORDER.filter(s=>bySection[s]&&bySection[s].length).map(s=>{
    const fields=bySection[s];
    return `<details class="param-section" open>
      <summary class="param-section-title"><span>${PARAM_SECTION_LABELS[s]}</span><span class="param-section-count">${fields.length}</span></summary>
      <div class="param-grid">${fields.map(f=>renderParamField(f,values[f.key],idPrefix)).join("")}</div>
    </details>`;
  }).join("");
}
function presetSwitcherHTML(presetName,hasUserPreset){
  const items=[["conservative","Консервативный"],["standard","Стандартный"],["aggressive","Агрессивный"]];
  items.push(["custom",hasUserPreset?"Мои настройки":"Свои настройки"]);
  return `<div class="mode-tabs param-preset-tabs">${items.map(([k,label])=>
    (k==="custom"&&!hasUserPreset&&presetName!=="custom")?"":
    `<button type="button" class="mode-tab ${presetName===k?"active":""}" data-preset-pick="${k}">${label}</button>`).join("")}</div>`;
}
function readFieldValue(el){
  if(el.type==="checkbox")return el.checked;
  if(el.tagName==="SELECT")return el.value;
  return Number(el.value);
}
function bindParamFieldEvents(container,idPrefix,onFieldCommit){
  container.querySelectorAll("[data-param-field]").forEach(el=>{
    el.onchange=e=>{e.stopPropagation();onFieldCommit(el.dataset.paramField,readFieldValue(el))};
    if(el.type==="range"){
      el.oninput=()=>{const out=document.getElementById(`${idPrefix}-out-${el.dataset.paramField}`);if(out)out.textContent=el.value};
      el.onclick=e=>e.stopPropagation();
    }
    if(el.tagName==="SELECT"||el.type==="checkbox")el.onclick=e=>e.stopPropagation();
  });
  container.querySelectorAll("[data-preset-pick]").forEach(b=>b.onclick=e=>{e.stopPropagation();onFieldCommit("__preset__",b.dataset.presetPick)});
}
let expandedStrategyCards=new Set();
let strategyFormState={};       // strategyId -> {values, presetName}
let strategyUserPresets={};     // strategyId -> {parameters:{...}} | null (loaded lazily)

function ensureStrategyFormState(strategyId){
  if(!strategyFormState[strategyId]){
    const standard=(window.STRATEGIES[strategyId]||{}).presets?.standard||{};
    strategyFormState[strategyId]={values:{...standard},presetName:"standard"};
  }
  return strategyFormState[strategyId];
}

function fillStrategies(){
  $("strategyCards").innerHTML=Object.entries(window.STRATEGIES).map(([k,v])=>renderStrategyCard(k,v)).join("");
  bindStrategyCardEvents();
}

function renderStrategyCard(strategyId,meta){
  const expanded=expandedStrategyCards.has(strategyId);
  const st=ensureStrategyFormState(strategyId);
  const presetLabel=PRESET_RU_LABEL[st.presetName]||"Пользовательские настройки";
  return `<article class="strategy-card accordion ${meta.primary?"primary-strategy":""} ${expanded?"open":""}" data-strategy-card="${strategyId}">
    <div class="accordion-header" data-toggle-strategy="${strategyId}" role="button" tabindex="0" aria-expanded="${expanded}">
      <div class="strategy-card-main">
        <div class="strategy-card-toprow">
          <span class="strategy-category">${meta.category}</span>
          <span class="strategy-preset-chip">${presetLabel}</span>
        </div>
        <div class="strategy-card-titlerow">
          <h3>${meta.name}</h3>
          <span class="strategy-chevron" aria-hidden="true">⌄</span>
        </div>
        <p class="strategy-summary">${meta.summary}</p>
        <div class="strategy-visual">${meta.visual}</div>
      </div>
    </div>
    ${expanded
      ?`<div class="accordion-body" data-no-toggle="1" id="strategy-body-${strategyId}">${renderStrategyParamsForm(strategyId)}</div>`
      :""}
  </article>`;
}

function renderStrategyParamsForm(strategyId){
  const st=ensureStrategyFormState(strategyId);
  const userPreset=strategyUserPresets[strategyId];
  const idPrefix=`lib-${strategyId}`;
  return `
    <div class="param-section param-section-presets">
      <div class="param-section-title param-section-title-static"><span>Пресеты</span></div>
      ${presetSwitcherHTML(st.presetName,!!userPreset)}
    </div>
    ${paramFieldsHTML(strategyId,st.values,idPrefix)}
    <div class="param-form-footer">
      <button type="button" class="secondary" data-param-reset="${strategyId}">Сбросить по умолчанию</button>
      <button type="button" class="primary" data-param-save="${strategyId}">Сохранить настройки</button>
    </div>
    <div class="message" id="param-message-${strategyId}"></div>`;
}

function toggleStrategyExpand(strategyId){
  if(expandedStrategyCards.has(strategyId)){
    expandedStrategyCards.delete(strategyId);
  }else{
    expandedStrategyCards.add(strategyId);
    ensureStrategyFormState(strategyId);
    loadStrategyUserPreset(strategyId);
  }
  fillStrategies();
}

async function loadStrategyUserPreset(strategyId){
  if(strategyId in strategyUserPresets)return;
  try{
    const d=await fetch(`/api/strategy-presets/${strategyId}`).then(r=>r.json());
    strategyUserPresets[strategyId]=d&&d.parameters?d:null;
  }catch(e){strategyUserPresets[strategyId]=null}
  if(expandedStrategyCards.has(strategyId))fillStrategies();
}

function applyPresetToLibrary(strategyId,presetName){
  const st=ensureStrategyFormState(strategyId);
  const meta=window.STRATEGIES[strategyId]||{};
  if(presetName==="custom"){
    const userPreset=strategyUserPresets[strategyId];
    if(userPreset)st.values={...meta.presets.standard,...userPreset.parameters};
    // no saved preset yet: field edits already put it in "custom" state, nothing to apply
  }else{
    st.values={...(meta.presets?.[presetName]||meta.presets?.standard||{})};
  }
  st.presetName=presetName;
  fillStrategies();
}

function commitLibraryFieldChange(strategyId,key,value){
  const st=ensureStrategyFormState(strategyId);
  if(key==="__preset__"){applyPresetToLibrary(strategyId,value);return}
  st.values={...st.values,[key]:value};
  st.presetName="custom";
  fillStrategies();
}

async function saveLibraryPreset(strategyId){
  const st=ensureStrategyFormState(strategyId);
  const btn=document.querySelector(`[data-param-save="${strategyId}"]`);
  if(btn){btn.disabled=true;btn.textContent="Сохраняем…"}
  try{
    const r=await fetch(`/api/strategy-presets/${strategyId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({parameters:st.values})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Не удалось сохранить настройки");
    strategyUserPresets[strategyId]=d;
    st.presetName="custom";
    showToast(`Настройки «${window.STRATEGIES[strategyId]?.name||strategyId}» сохранены`,"success");
  }catch(e){
    showToast(e.message,"error");
  }finally{
    fillStrategies();
  }
}

function bindStrategyCardEvents(){
  document.querySelectorAll("[data-toggle-strategy]").forEach(el=>el.onclick=e=>{
    if(e.target.closest("[data-no-toggle]"))return;
    toggleStrategyExpand(el.dataset.toggleStrategy);
  });
  document.querySelectorAll("[data-strategy-card] .accordion-body").forEach(body=>{
    const strategyId=body.closest("[data-strategy-card]")?.dataset.strategyCard;
    if(strategyId)bindParamFieldEvents(body,`lib-${strategyId}`,(key,val)=>commitLibraryFieldChange(strategyId,key,val));
  });
  document.querySelectorAll("[data-param-reset]").forEach(b=>b.onclick=e=>{e.stopPropagation();applyPresetToLibrary(b.dataset.paramReset,"standard")});
  document.querySelectorAll("[data-param-save]").forEach(b=>b.onclick=e=>{e.stopPropagation();saveLibraryPreset(b.dataset.paramSave)});
}

// ----------------------------------------------------------------- backtest
// Mirrors timeframes.py's BACKTEST_TIMEFRAMES/BACKTEST_TIMEFRAME_LABELS -
// this is a fixed, rarely-changing spec (same 8 options the backend
// validates against in portfolio_backtest()), not data worth a round trip.
const BACKTEST_TIMEFRAMES=[
  ["1m","1 минута"],["5m","5 минут"],["10m","10 минут"],["15m","15 минут"],
  ["30m","30 минут"],["60m","1 час"],["4h","4 часа"],["1d","1 день"],
];
const BACKTEST_TIMEFRAME_LABEL=Object.fromEntries(BACKTEST_TIMEFRAMES);
function tfLabel(tf){return BACKTEST_TIMEFRAME_LABEL[tf||"10m"]||tf||"10 минут"}
$("goToPortfolioTab").onclick=()=>activateTab("portfolio");
$("backtestPortfolioSelect").onchange=e=>selectBacktestPortfolio(e.target.value);
const backtestTimeframeEl=$("backtestTimeframe");
if(backtestTimeframeEl){
  backtestTimeframeEl.innerHTML=BACKTEST_TIMEFRAMES.map(([v,l])=>`<option value="${v}">${l}</option>`).join("");
  backtestTimeframeEl.value="10m";
  backtestTimeframeEl.onchange=()=>refreshDataGaps();
}else{
  console.error("#backtestTimeframe missing from DOM - template/JS out of sync (needs a server restart to pick up the current template)");
}

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
  if(assignModalDraft)closeAssignmentModal(false);
  renderBacktestSectorFilter();
  renderBacktestChips();
  $("backtestResults").classList.add("hidden");
  lastBacktestResult=null;
  resumeBacktestJobIfAny();
}
function pluralSuffix(n){const m10=n%10,m100=n%100;if(m100>=11&&m100<=14)return"ов";if(m10===1)return"";if(m10>=2&&m10<=4)return"а";return"ов"}

// A ticker only contributes runs for strategies explicitly assigned to it -
// no silent fallback to the portfolio's legacy default_strategy_id, so a
// selected ticker with nothing assigned shows up in `missing` and blocks the
// run instead of quietly picking an arbitrary strategy for it.
function resolveComboCount(){
  if(!btPortfolio)return{total:0,byTicker:[],missing:[]};
  const ts=btPortfolio.ticker_strategies||{};
  const missing=[];
  const byTicker=[...btIncluded].map(ticker=>{
    const enabled=(ts[ticker]||[]).filter(a=>a.enabled!==false);
    if(!enabled.length)missing.push(ticker);
    const names=enabled.map(a=>(window.STRATEGIES[a.strategy_id]||{}).name||a.strategy_id);
    return{ticker,count:enabled.length,names};
  });
  return{total:byTicker.reduce((s,x)=>s+x.count,0),byTicker,missing};
}
function renderComboEstimate(){
  const est=resolveComboCount();
  const valEl=$("assignmentValidation");
  if(btIncluded.size&&est.missing.length){
    valEl.classList.remove("hidden");
    valEl.innerHTML=`<span>Для ${est.missing.map(escapeHtml).join(", ")} не выбрана стратегия.</span><button type="button" class="secondary" id="assignValidationFix">Настроить</button>`;
    $("assignValidationFix").onclick=openAssignmentModal;
  }else{
    valEl.classList.add("hidden");
    valEl.innerHTML="";
  }
  const runnable=est.total>0&&!est.missing.length;
  $("comboEstimate").innerHTML=!btIncluded.size?"Выберите хотя бы один инструмент.":
    est.missing.length?"Назначьте стратегии выбранным инструментам, чтобы запустить бэктест.":
    `<strong>Будет выполнено ${est.total} расчёт${pluralSuffix(est.total)}:</strong> `+est.byTicker.map(x=>`${x.ticker} × ${x.count}`).join(", ");
  $("runBacktestBtn").textContent=runnable?`Запустить бэктест (${est.total} расчёт${pluralSuffix(est.total)})`:(btIncluded.size?"Назначьте стратегии":"Выберите инструменты");
  $("runBacktestBtn").disabled=!runnable;
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
  renderAssignmentSummary();
  renderComboEstimate();
  refreshDataGaps();
}

// ---- per-ticker strategy assignment: portfolio -> ticker -> [strategies] --
// Modal-based editor. Edits happen on a local deep-cloned draft
// (assignModalDraft) while the dialog is open; nothing touches btPortfolio
// until "Сохранить" does one PATCH of the whole ticker_strategies map. This
// is the single place that reads/writes that schema on the Backtest tab.
let assignModalDraft=null;              // ticker -> [{strategy_id,parameters,enabled}], only while modal is open
let assignExpandedTickers=new Set();    // tickers whose accordion card is open in the modal
let assignExpandedParams=new Set();     // "TICKER::strategy_id" keys with an open inline param form

function pluralWord(n,forms){
  const m10=n%10,m100=n%100;
  if(m100>=11&&m100<=14)return forms[2];
  if(m10===1)return forms[0];
  if(m10>=2&&m10<=4)return forms[1];
  return forms[2];
}

function assignmentPresetKey(strategyId,parameters){
  const meta=window.STRATEGIES[strategyId]||{};
  const values={...(meta.presets?.standard||{}),...(parameters||{})};
  for(const name of ["standard","conservative","aggressive"]){
    const preset=meta.presets?.[name];
    if(preset&&Object.keys(preset).every(k=>preset[k]===values[k]))return name;
  }
  return "custom";
}
function matchesUserPreset(strategyId,parameters){
  const userPreset=strategyUserPresets[strategyId];
  if(!userPreset)return false;
  const standard=window.STRATEGIES[strategyId]?.presets?.standard||{};
  return JSON.stringify({...standard,...userPreset.parameters})===JSON.stringify({...standard,...(parameters||{})});
}
function assignmentPresetLabel(strategyId,parameters){
  const key=assignmentPresetKey(strategyId,parameters);
  if(key==="custom")return matchesUserPreset(strategyId,parameters)?"Мои настройки":"Пользовательские настройки";
  return PRESET_RU_LABEL[key];
}

// ---- compact summary strip on the Backtest tab (always visible) ----------
function renderAssignmentSummary(){
  const el=$("assignmentSummary");
  if(!el)return;
  if(!btPortfolio){el.innerHTML="";return}
  const ts=btPortfolio.ticker_strategies||{};
  const parts=(btPortfolio.instruments||[]).map(i=>{
    const n=(ts[i.ticker]||[]).filter(a=>a.enabled!==false).length;
    return n?`<strong>${escapeHtml(i.ticker)}</strong> — ${n} ${pluralWord(n,["стратегия","стратегии","стратегий"])}`:null;
  }).filter(Boolean);
  el.innerHTML=parts.length?parts.join(" · "):`<span class="assign-summary-empty">Стратегии ещё не назначены — нажмите «Настроить стратегии портфеля».</span>`;
}

// ---- modal lifecycle -------------------------------------------------------
function draftFor(ticker){
  assignModalDraft[ticker]=assignModalDraft[ticker]||[];
  return assignModalDraft[ticker];
}
function isAssignDraftDirty(){
  return JSON.stringify(assignModalDraft)!==JSON.stringify(btPortfolio.ticker_strategies||{});
}
function openAssignmentModal(){
  if(!btPortfolio)return;
  assignModalDraft=JSON.parse(JSON.stringify(btPortfolio.ticker_strategies||{}));
  assignExpandedTickers=new Set();
  assignExpandedParams=new Set();
  $("assignBulkStrategy").innerHTML=Object.entries(window.STRATEGIES).map(([k,v])=>`<option value="${k}">${escapeHtml(v.name)}</option>`).join("");
  $("strategyAssignModal").classList.remove("hidden");
  renderAssignmentModalBody();
}
function closeAssignmentModal(askConfirm){
  if(!assignModalDraft)return;
  if(askConfirm&&isAssignDraftDirty()&&!confirm("Закрыть без сохранения изменений?"))return;
  $("strategyAssignModal").classList.add("hidden");
  assignModalDraft=null;
}

// ---- body rendering ---------------------------------------------------
function renderAssignmentModalBody(){
  const body=$("strategyAssignBody");
  if(!body||!btPortfolio||!assignModalDraft)return;
  const tickers=(btPortfolio.instruments||[]).map(i=>i.ticker);
  body.innerHTML=tickers.length?tickers.map(renderAssignTickerCard).join(""):`<p class="muted-note">В портфеле нет инструментов.</p>`;
  bindAssignmentModalEvents();
  renderAssignFooterStats();
}

function renderAssignTickerCard(ticker){
  const list=assignModalDraft[ticker]||[];
  const enabledCount=list.filter(a=>a.enabled!==false).length;
  const open=assignExpandedTickers.has(ticker);
  const sec=securities.find(s=>s.SECID===ticker);
  const excluded=!btIncluded.has(ticker);
  return `<div class="assign-ticker-card ${open?"open":""}" data-assign-ticker-card="${ticker}">
    <div class="assign-ticker-head" data-assign-ticker-toggle="${ticker}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="assign-ticker-main">
        <div class="assign-ticker-toprow">
          <strong>${escapeHtml(ticker)}</strong>
          ${excluded?`<span class="assign-ticker-excluded" title="Не выбран для текущего запуска бэктеста">не в тесте</span>`:""}
        </div>
        <div class="assign-ticker-name">${escapeHtml(sec?.SHORTNAME||"")}</div>
      </div>
      <span class="assign-ticker-count ${enabledCount?"":"zero"}">${enabledCount?`${enabledCount} выбрано`:"не выбрано"}</span>
      <span class="assign-ticker-chevron" aria-hidden="true">⌄</span>
    </div>
    ${open?`<div class="assign-ticker-body" data-no-toggle="1">
      <div class="assign-ticker-quickactions">
        <button type="button" class="secondary" data-assign-select-all="${ticker}">Выбрать все</button>
        <button type="button" class="secondary" data-assign-clear-ticker="${ticker}">Снять все</button>
      </div>
      <div class="assign-strategy-list">${Object.entries(window.STRATEGIES).map(([sid,meta])=>renderAssignStrategyRow(ticker,sid,meta)).join("")}</div>
    </div>`:""}
  </div>`;
}

function renderAssignStrategyRow(ticker,strategyId,meta){
  const list=assignModalDraft[ticker]||[];
  const a=list.find(x=>x.strategy_id===strategyId);
  const checked=!!a&&a.enabled!==false;
  const key=`${ticker}::${strategyId}`;
  const paramsOpen=checked&&assignExpandedParams.has(key);
  return `<div class="assign-strategy-row">
    <div class="assign-strategy-main" data-assign-toggle-strategy="${ticker}" data-strategy-id="${strategyId}">
      <input type="checkbox" data-assign-check="${ticker}" data-strategy-id="${strategyId}" ${checked?"checked":""}>
      <span class="assign-strategy-name">${escapeHtml(meta.name)}</span>
      ${checked?`<span class="assign-strategy-preset">${assignmentPresetLabel(strategyId,a.parameters||{})}</span>
      <button type="button" class="secondary assign-strategy-configure" data-assign-configure="${ticker}" data-strategy-id="${strategyId}">Настроить</button>`:""}
    </div>
    ${paramsOpen?`<div class="assignment-config-panel" data-assign-param-grid="${ticker}::${strategyId}">${renderStrategyParamsFormFor(strategyId,a.parameters||{},`assign-${ticker}-${strategyId}`)}</div>`:""}
  </div>`;
}

function renderStrategyParamsFormFor(strategyId,parameters,idPrefix){
  const meta=window.STRATEGIES[strategyId]||{};
  const values={...(meta.presets?.standard||{}),...(parameters||{})};
  const presetName=assignmentPresetKey(strategyId,parameters);
  const hasUserPreset=!!strategyUserPresets[strategyId];
  return `<div class="param-section param-section-presets">
      <div class="param-section-title param-section-title-static"><span>Пресеты</span></div>
      ${presetSwitcherHTML(presetName,hasUserPreset)}
    </div>
    ${paramFieldsHTML(strategyId,values,idPrefix)}`;
}

// ---- draft mutation ------------------------------------------------------
function setStrategyEnabled(ticker,strategyId,enabled){
  const list=draftFor(ticker);
  let a=list.find(x=>x.strategy_id===strategyId);
  if(enabled){
    if(!a){
      const meta=window.STRATEGIES[strategyId]||{};
      a={strategy_id:strategyId,parameters:{...(meta.presets?.standard||{})},enabled:true};
      list.push(a);
    }else a.enabled=true;
  }else{
    if(a)a.enabled=false;
    assignExpandedParams.delete(`${ticker}::${strategyId}`);
  }
  renderAssignmentModalBody();
}
function toggleAssignParamPanel(ticker,strategyId){
  const key=`${ticker}::${strategyId}`;
  if(assignExpandedParams.has(key)){
    assignExpandedParams.delete(key);
  }else{
    assignExpandedParams.add(key);
    loadStrategyUserPreset(strategyId).then(()=>{if(assignExpandedParams.has(key))renderAssignmentModalBody()});
  }
  renderAssignmentModalBody();
}
function commitDraftFieldChange(ticker,strategyId,key,value){
  const list=draftFor(ticker);
  const a=list.find(x=>x.strategy_id===strategyId);
  if(!a)return;
  const meta=window.STRATEGIES[strategyId]||{};
  const current={...(meta.presets?.standard||{}),...(a.parameters||{})};
  if(key==="__preset__"){
    if(value==="custom"){
      const userPreset=strategyUserPresets[strategyId];
      a.parameters=userPreset?{...(meta.presets?.standard||{}),...userPreset.parameters}:current;
    }else{
      a.parameters={...(meta.presets?.[value]||meta.presets?.standard||{})};
    }
  }else{
    a.parameters={...current,[key]:value};
  }
  renderAssignmentModalBody();
}
function selectAllForTicker(ticker){
  const list=draftFor(ticker);
  Object.keys(window.STRATEGIES).forEach(sid=>{
    let a=list.find(x=>x.strategy_id===sid);
    if(!a){
      const meta=window.STRATEGIES[sid]||{};
      list.push({strategy_id:sid,parameters:{...(meta.presets?.standard||{})},enabled:true});
    }else a.enabled=true;
  });
  renderAssignmentModalBody();
}
function clearAllForTicker(ticker){
  (assignModalDraft[ticker]||[]).forEach(a=>a.enabled=false);
  renderAssignmentModalBody();
}
function applyBulkStrategyToAll(){
  if(!btPortfolio||!assignModalDraft)return;
  const strategyId=$("assignBulkStrategy").value;
  if(!strategyId)return;
  (btPortfolio.instruments||[]).forEach(i=>{
    const list=draftFor(i.ticker);
    let a=list.find(x=>x.strategy_id===strategyId);
    if(!a){
      const meta=window.STRATEGIES[strategyId]||{};
      list.push({strategy_id:strategyId,parameters:{...(meta.presets?.standard||{})},enabled:true});
    }else a.enabled=true;
  });
  renderAssignmentModalBody();
  showToast(`«${window.STRATEGIES[strategyId]?.name||strategyId}» добавлена всем инструментам`,"success");
}
function clearAllAssignments(){
  if(!confirm("Очистить все назначения стратегий во всём портфеле? Это затронет все инструменты."))return;
  assignModalDraft={};
  renderAssignmentModalBody();
}

// ---- footer stats + save --------------------------------------------------
function computeDraftFooterStats(){
  const tickers=[...btIncluded];
  let instrumentsWithStrategy=0,total=0;
  tickers.forEach(t=>{
    const n=(assignModalDraft[t]||[]).filter(a=>a.enabled!==false).length;
    if(n){instrumentsWithStrategy++;total+=n}
  });
  return{tickers:tickers.length,instrumentsWithStrategy,total};
}
function renderAssignFooterStats(){
  const st=computeDraftFooterStats();
  $("assignFooterStats").innerHTML=`<span>Инструментов: <strong>${st.tickers}</strong></span><span>Назначено стратегий: <strong>${st.total}</strong></span><span>Будет выполнено: <strong>${st.total} расчёт${pluralSuffix(st.total)}</strong></span>`;
  $("assignSaveBtn").textContent=st.total?`Сохранить — ${st.total} расчёт${pluralSuffix(st.total)}`:"Сохранить";
}
async function saveAssignmentModal(){
  if(!btPortfolio||!assignModalDraft)return;
  const btn=$("assignSaveBtn");
  const original=btn.textContent;
  btn.disabled=true;btn.textContent="Сохраняем…";
  try{
    const r=await fetch(`/api/portfolios/${btPortfolio.id}/strategies`,{method:"PATCH",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ticker_strategies:assignModalDraft})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Не удалось сохранить назначения стратегий");
    btPortfolio.ticker_strategies=d.ticker_strategies;
    const idx=portfolios.findIndex(p=>p.id===btPortfolio.id);
    if(idx>=0)portfolios[idx]=btPortfolio;
    assignModalDraft=null;
    $("strategyAssignModal").classList.add("hidden");
    renderAssignmentSummary();
    renderComboEstimate();
    showToast("Стратегии портфеля сохранены","success");
  }catch(e){
    showToast(e.message,"error");
  }finally{
    btn.disabled=false;btn.textContent=original;
  }
}

// ---- event binding ----------------------------------------------------
function bindAssignmentModalEvents(){
  document.querySelectorAll("[data-assign-ticker-toggle]").forEach(el=>el.onclick=e=>{
    if(e.target.closest("[data-no-toggle]"))return;
    const t=el.dataset.assignTickerToggle;
    assignExpandedTickers.has(t)?assignExpandedTickers.delete(t):assignExpandedTickers.add(t);
    renderAssignmentModalBody();
  });
  document.querySelectorAll("[data-assign-select-all]").forEach(b=>b.onclick=e=>{e.stopPropagation();selectAllForTicker(b.dataset.assignSelectAll)});
  document.querySelectorAll("[data-assign-clear-ticker]").forEach(b=>b.onclick=e=>{e.stopPropagation();clearAllForTicker(b.dataset.assignClearTicker)});
  document.querySelectorAll("[data-assign-check]").forEach(cb=>{
    cb.onclick=e=>e.stopPropagation();
    cb.onchange=e=>{e.stopPropagation();setStrategyEnabled(cb.dataset.assignCheck,cb.dataset.strategyId,cb.checked)};
  });
  document.querySelectorAll("[data-assign-configure]").forEach(b=>b.onclick=e=>{e.stopPropagation();toggleAssignParamPanel(b.dataset.assignConfigure,b.dataset.strategyId)});
  document.querySelectorAll("[data-assign-toggle-strategy]").forEach(el=>el.onclick=e=>{
    if(e.target.closest("[data-assign-configure]")||e.target.matches('input[type="checkbox"]'))return;
    const ticker=el.dataset.assignToggleStrategy,strategyId=el.dataset.strategyId;
    const cb=el.querySelector(`input[data-strategy-id="${strategyId}"]`);
    cb.checked=!cb.checked;
    setStrategyEnabled(ticker,strategyId,cb.checked);
  });
  document.querySelectorAll("[data-assign-param-grid]").forEach(panel=>{
    const [ticker,strategyId]=panel.dataset.assignParamGrid.split("::");
    bindParamFieldEvents(panel,`assign-${ticker}-${strategyId}`,(key,val)=>commitDraftFieldChange(ticker,strategyId,key,val));
  });
}

$("openAssignModalBtn").onclick=openAssignmentModal;
$("strategyAssignClose").onclick=()=>closeAssignmentModal(true);
$("strategyAssignBackdrop").onclick=()=>closeAssignmentModal(true);
$("assignCancelBtn").onclick=()=>closeAssignmentModal(true);
$("assignSaveBtn").onclick=saveAssignmentModal;
$("assignBulkAddBtn").onclick=applyBulkStrategyToAll;
$("assignClearAllBtn").onclick=clearAllAssignments;

// ---- pre-flight data coverage for the selected backtest period ----------
function fmtGapRange(g){
  if(g.missing_from&&g.missing_to)return`${g.missing_from} – ${g.missing_to}`;
  return g.missing_from||g.missing_to||"выбранный период";
}
async function refreshDataGaps(){
  if(!btPortfolio||!btIncluded.size){dataGaps=[];timeframeGaps=[];renderDataGaps();return}
  const params=new URLSearchParams();
  const df=$("backtestFrom").value,dt=$("backtestTill").value;
  if(df)params.set("date_from",df);
  if(dt)params.set("date_to",dt);
  params.set("tickers",[...btIncluded].join(","));
  params.set("timeframe",$("backtestTimeframe").value||"10m");
  const requestedPortfolioId=btPortfolio.id;
  try{
    const r=await fetch(`/api/portfolios/${requestedPortfolioId}/data-coverage?${params}`);
    const d=await r.json();
    if(!btPortfolio||btPortfolio.id!==requestedPortfolioId)return; // portfolio/tab changed while in flight
    dataGaps=(d.items||[]).filter(i=>!i.covered);
    // Distinct from dataGaps: the period is fine but the chosen non-10m
    // timeframe honestly has nothing for this ticker (no native data, no
    // finer base to aggregate from) - see backtest_candles.py. Never
    // offered a "Загрузить" retry, since the coverage check above already
    // attempted the same honest fetch/aggregate that would be retried.
    timeframeGaps=(d.items||[]).filter(i=>i.timeframe_available===false);
  }catch(e){dataGaps=[];timeframeGaps=[]}
  renderDataGaps();
}
function renderDataGaps(){
  const el=$("backtestDataGaps");
  if(!el)return;
  if(!dataGaps.length&&!timeframeGaps.length){el.classList.add("hidden");el.innerHTML="";return}
  el.classList.remove("hidden");
  let html="";
  if(dataGaps.length){
    html+=`<strong>Не хватает исторических данных:</strong>`+dataGaps.map(g=>{
      const loading=dataGapLoading.has(g.ticker);
      return`<div class="data-gap-row" data-gap-row="${g.ticker}">
        <span>Для <strong>${g.ticker}</strong> отсутствуют данные за ${fmtGapRange(g)}</span>
        <button class="secondary" data-gap-load="${g.ticker}" ${loading?"disabled":""}>${loading?"Загрузка…":"Загрузить"}</button>
      </div>`;
    }).join("");
  }
  if(timeframeGaps.length){
    html+=`<strong>Недоступен выбранный таймфрейм:</strong>`+timeframeGaps.map(g=>
      `<div class="data-gap-row"><span>${escapeHtml(g.timeframe_reason||`Для ${g.ticker} нет данных на этом таймфрейме.`)}</span></div>`
    ).join("");
  }
  el.innerHTML=html;
  el.querySelectorAll("[data-gap-load]").forEach(b=>b.onclick=()=>loadGapData(b.dataset.gapLoad));
}
async function loadGapData(ticker){
  if(!btPortfolio||dataGapLoading.has(ticker))return;
  const gap=dataGaps.find(g=>g.ticker===ticker);
  const oneYearAgo=new Date(Date.now()-365*86400000).toISOString().slice(0,10);
  const today=new Date().toISOString().slice(0,10);
  const date_from=$("backtestFrom").value||gap?.missing_from||oneYearAgo;
  const date_to=$("backtestTill").value||gap?.missing_to||today;
  dataGapLoading.add(ticker);renderDataGaps();
  try{
    const r=await fetch(`/api/portfolios/${btPortfolio.id}/instruments/${ticker}/download-data`,{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({date_from,date_to})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Не удалось загрузить данные");
    showToast(`Данные ${ticker} загружены`,"success");
    const fresh=await fetch(`/api/portfolios/${btPortfolio.id}`).then(x=>x.json());
    const idx=portfolios.findIndex(p=>p.id===fresh.id);
    if(idx>=0)portfolios[idx]=fresh;
    if(btPortfolio&&btPortfolio.id===fresh.id)btPortfolio=fresh;
    dataGapLoading.delete(ticker);
    await refreshDataGaps();
  }catch(e){
    dataGapLoading.delete(ticker);
    setStatus(`Ошибка загрузки данных ${ticker}: ${e.message}`,"error");
    renderDataGaps();
  }
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
$("backtestFrom").onchange=()=>refreshDataGaps();
$("backtestTill").onchange=()=>refreshDataGaps();

async function startBacktest(){
  if(!btIncluded.size)return;
  if(resolveComboCount().missing.length)return;
  $("runBacktestBtn").disabled=true;
  $("backtestProgress").classList.remove("hidden");
  $("backtestResults").classList.add("hidden");
  $("backtestMessage").textContent="";
  const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),15000);
  try{
    const r=await fetch(`/api/portfolios/${btPortfolio.id}/backtest`,{method:"POST",headers:{"Content-Type":"application/json"},signal:ctrl.signal,
      body:JSON.stringify({tickers:[...btIncluded],date_from:$("backtestFrom").value||undefined,date_to:$("backtestTill").value||undefined,
        timeframe:$("backtestTimeframe").value||"10m"})});
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
          showToast(job.status==="completed"?"Бэктест завершён — результаты готовы":"Бэктест завершён с ошибками по части комбинаций",job.status==="completed"?"success":"info");
          await loadPortfolios();
          loadHistory(1);
          if(window.refreshPortfolioBalance)window.refreshPortfolioBalance();
        }else{
          $("backtestMessage").textContent=`${job.status==="canceled"?"Отменено":"Ошибка"}: ${job.error?.message||"неизвестная ошибка"}`;
          setStatus(job.status==="canceled"?"Бэктест отменён":"Ошибка бэктеста","error");
          if(job.status!=="canceled")showToast(`Ошибка бэктеста: ${job.error?.message||"неизвестная ошибка"}`,"error");
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
  const signClass=(n)=>n>0?"pos":n<0?"neg":"";
  const fields=[
    ["Доходность",`${s.return_pct??0}%`,signClass(s.return_pct)],["Прибыль/убыток",`${money(pnl)} ₽`,signClass(pnl)],
    ["Просадка",`${s.max_drawdown_pct??0}%`,""],["Сделок",s.trades??0,""],["Win Rate",`${s.win_rate??0}%`,""],
    ["Profit Factor",s.profit_factor??"—",""],["Sharpe (оценка)",s.sharpe_ratio??"—",""],
    ["Использование капитала",`${s.capital_utilization_pct??0}%`,""],["Капитал",`${money(s.final_capital_rub)} ₽`,""],
  ];
  $(target).innerHTML=fields.map(([a,b,c])=>`<div class="metric"><span>${a}</span><strong class="${c}">${b}</strong></div>`).join("");
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
const BY_TICKER_NUM_KEYS=new Set(["trades","pnl_rub","win_rate","max_drawdown_pct"]);
function renderByTickerTable(){
  if(!lastBacktestResult)return;
  const rows=[...(lastBacktestResult.by_ticker||[])].sort((a,b)=>{
    const k=byTickerSort.key,av=a[k],bv=b[k];
    const cmp=typeof av==="number"&&typeof bv==="number"?av-bv:String(av).localeCompare(String(bv));
    return cmp*byTickerSort.dir;
  });
  $("byTickerTable").innerHTML=`<div class="table-scroll"><table><thead><tr>${BY_TICKER_COLUMNS.map(([k,l])=>`<th data-sort-key="${k}" class="sortable ${BY_TICKER_NUM_KEYS.has(k)?'num':''} ${byTickerSort.key===k?'sorted':''}">${l}${byTickerSort.key===k?(byTickerSort.dir>0?' ↑':' ↓'):''}</th>`).join("")}<th></th></tr></thead><tbody>${
    rows.map(r=>`<tr><td>${r.ticker}</td><td>${r.strategy_name||"—"}</td><td class="num">${r.trades}</td><td class="num ${r.pnl_rub>0?'pnl-pos':r.pnl_rub<0?'pnl-neg':''}">${r.pnl_rub}</td><td class="num">${r.win_rate}%</td><td class="num">${r.max_drawdown_pct}%</td><td>${r.run_id?`<button class="link-btn" data-open-run="${r.run_id}">Подробнее</button>`:"—"}</td></tr>`).join("")
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
  $("byStrategyTable").innerHTML=`<h3 style="margin-top:22px">По стратегиям</h3><div class="table-scroll"><table><thead><tr><th>Стратегия</th><th class="num">Тикеров</th><th class="num">Сделок</th><th class="num">Прибыль ₽</th><th class="num">Средний Win Rate</th></tr></thead><tbody>${
    rows.map(r=>`<tr><td>${r.strategy_name}</td><td class="num">${r.tickers}</td><td class="num">${r.trades}</td><td class="num ${r.pnl_rub>0?'pnl-pos':r.pnl_rub<0?'pnl-neg':''}">${r.pnl_rub}</td><td class="num">${r.avg_win_rate}%</td></tr>`).join("")
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
    <th>Дата</th><th>Портфель</th><th class="num">Комбинаций</th><th>Статус</th><th class="num">Доходность</th><th class="num">Просадка</th><th class="num">Сделок</th><th class="num">Длительность</th><th></th>
  </tr></thead><tbody>${items.map(it=>{
    const duration=it.completed_at&&it.started_at?`${(it.completed_at-it.started_at).toFixed(1)}с`:"—";
    const retClass=it.return_percent>0?"pnl-pos":it.return_percent<0?"pnl-neg":"";
    return `<tr>
      <td>${fmtDateTime(it.created_at)}</td>
      <td>${it.portfolio_name_snapshot||"—"}<div class="muted-note">${tfLabel(it.timeframe)}</div></td>
      <td class="num">${it.combinations_ok||0}/${it.combinations_count||0}</td>
      <td><span class="pill status-${it.status}">${HISTORY_STATUS_LABEL[it.status]||it.status}</span></td>
      <td class="num ${retClass}">${it.return_percent!=null?it.return_percent+"%":"—"}</td>
      <td class="num">${it.max_drawdown!=null?it.max_drawdown+"%":"—"}</td>
      <td class="num">${it.trades_count??"—"}</td>
      <td class="num">${duration}</td>
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
  $("tradeViewerHead").innerHTML=`<h3>Сделки: ${run.portfolio_name_snapshot||"портфель"}</h3><p class="muted-note">${fmtDateTime(run.created_at)} · ${run.combinations_ok}/${run.combinations_count} комбинаций · таймфрейм ${tfLabel(run.timeframe)}</p>`;
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
    <th class="num">#</th><th>Тикер</th><th>Стратегия</th><th>Направление</th><th>Вход</th><th>Выход</th><th class="num">Лоты</th><th class="num">Прибыль</th><th class="num">Доходность</th><th>Причина</th><th></th>
  </tr></thead><tbody>${items.map((t,i)=>`<tr data-row-id="${t.id}">
      <td class="num">${(tvPage-1)*tvPageSize+i+1}</td><td>${t.ticker}</td><td>${(window.STRATEGIES[t.strategy_id]||{}).name||t.strategy_id}</td>
      <td>${t.direction}</td><td>${t.entry_datetime}<br><small>${money(t.entry_price)} ₽</small></td>
      <td>${t.exit_datetime}<br><small>${money(t.exit_price)} ₽</small></td><td class="num">${t.quantity_lots}</td>
      <td class="num ${t.net_profit>0?'pnl-pos':'pnl-neg'}">${money(t.net_profit)} ₽</td><td class="num ${t.return_percent>0?'pnl-pos':t.return_percent<0?'pnl-neg':''}">${t.return_percent}%</td><td>${t.exit_reason||"—"}</td>
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
document.addEventListener("keydown",e=>{
  if(e.key!=="Escape"||$("tradeViewer").classList.contains("hidden"))return;
  // Trade chart fullscreen (trade-chart.js) also exits on Esc - if that's
  // currently active, this same keypress must only collapse fullscreen,
  // not also close the whole modal underneath it (document.fullscreenElement
  // is still set here regardless of listener order: leaving native
  // fullscreen is always an async transition, so it hasn't cleared yet at
  // this point in the same keydown dispatch; the fsCtrl.active check
  // covers the rare no-Fullscreen-API fallback path the same way).
  if(document.fullscreenElement||(window.TradeChart&&window.TradeChart.fsCtrl&&window.TradeChart.fsCtrl.active))return;
  $("tradeViewer").classList.add("hidden");
});

// ------------------------------------------------------------- ticker tape
let tickerTapeTimer=null;
let tickerTapeRequest=null;
let tickerTapeHasRendered=false;

async function fetchTickerTapeData(){
  if(tickerTapeRequest)tickerTapeRequest.abort();
  const ctrl=new AbortController();
  tickerTapeRequest=ctrl;
  const timer=setTimeout(()=>ctrl.abort(),8000);
  try{
    const r=await fetch(`/api/market-ticker?_ts=${Date.now()}`,{
      signal:ctrl.signal,credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}
    });
    let d;
    try{d=await r.json();}
    catch(e){throw new Error("Некорректный ответ котировок");}
    if(!r.ok)throw new Error((d&&d.error)||`HTTP ${r.status}`);
    return d;
  }finally{
    clearTimeout(timer);
    if(tickerTapeRequest===ctrl)tickerTapeRequest=null;
  }
}

async function loadTickerTape(){
  clearTimeout(tickerTapeTimer);
  try{
    const d=await fetchTickerTapeData();
    renderTickerTape(d);
    if(!tickerTapeHasRendered){
      tickerTapeHasRendered=true;
      console.info(`[ticker] rendered ${(d.quotes||[]).length} quotes`);
    }
    tickerTapeTimer=setTimeout(loadTickerTape,(d.quotes&&d.quotes.length)?45000:12000);
  }catch(e){
    const reason=e&&e.name==="AbortError"?"request timeout":(e&&e.message)||String(e);
    console.warn(`[ticker] ${reason}`);
    renderTickerTape({quotes:[],error:"Котировки временно недоступны"});
    tickerTapeTimer=setTimeout(loadTickerTape,12000);
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
function startupTask(name,fn){
  return Promise.resolve().then(fn).catch(e=>{
    console.error(`[startup] ${name} failed`,e);
    return null;
  });
}

async function bootstrap(){
  // UI wiring and independent data sources must never be serialized behind
  // an unrelated network request. In particular, ticker + portfolio rendering
  // are allowed to complete even when MOEX, backtest history or commerce is slow.
  renderPresets();
  fillStrategies();
  initTabs();
  setBuildTarget(null);
  resumeBuildJob();

  void loadTickerTape();
  void Promise.allSettled([
    startupTask("securities",()=>loadSecurities()),
    startupTask("portfolios",()=>loadPortfolios()),
  ]);

  // Deep link from the personal cabinet ("Мои бэктесты" -> "Открыть") -
  // reuses the existing backtest tab + trade viewer instead of building a
  // second results view inside /account.
  const openRun=new URLSearchParams(location.search).get("openRun");
  if(openRun){activateTab("backtest");void startupTask("open backtest",()=>openTradeViewer(openRun));}
}
bootstrap().catch(e=>console.error("[startup] bootstrap failed",e));
