(function () {
  "use strict";

  if (window.location.pathname !== "/") return;

  const hero = document.querySelector("header.hero");
  const heroTitle = hero && hero.querySelector(".hero-title");
  const heroMeta = hero && hero.querySelector(".hero-meta");
  if (!hero || !heroTitle || !heroMeta || hero.dataset.premiumHero === "1") return;

  hero.dataset.premiumHero = "1";
  hero.classList.add("hero-premium");

  const topbar = document.createElement("div");
  topbar.className = "hero-topbar";
  topbar.innerHTML = `
    <a class="hero-brand" href="/" aria-label="Strategy Lab">
      <span class="hero-brand-mark" aria-hidden="true">
        <svg viewBox="0 0 48 48" fill="none">
          <path d="M19.2 31.8H15.6C8.64 31.8 3 26.16 3 19.2S8.64 6.6 15.6 6.6h7.2c6.96 0 12.6 5.64 12.6 12.6v1.2" stroke="currentColor" stroke-width="4.2" stroke-linecap="round"/>
          <path d="M28.8 16.2h3.6c6.96 0 12.6 5.64 12.6 12.6s-5.64 12.6-12.6 12.6h-7.2c-6.96 0-12.6-5.64-12.6-12.6v-1.2" stroke="currentColor" stroke-width="4.2" stroke-linecap="round"/>
          <path d="M16.8 24h14.4" stroke="currentColor" stroke-width="4.2" stroke-linecap="round"/>
        </svg>
      </span>
      <span>Strategy Lab</span>
    </a>`;
  topbar.appendChild(heroMeta);

  heroTitle.classList.remove("hero-title");
  heroTitle.classList.add("hero-copy");

  const title = heroTitle.querySelector("h1");
  if (title) title.innerHTML = `Strategy <span class="hero-lab">Lab</span>`;

  const copy = heroTitle.querySelector("p");
  if (copy) {
    const ctas = document.createElement("div");
    ctas.className = "hero-cta";
    ctas.innerHTML = `
      <a class="primary" href="#tab-portfolio">
        <span>Начать бесплатно</span><span class="hero-cta-arrow" aria-hidden="true">→</span>
      </a>
      <a class="secondary" href="#appPrimaryTabs">
        <span class="hero-cta-play" aria-hidden="true">▶</span>
        <span>Как это работает?</span>
      </a>`;
    copy.insertAdjacentElement("afterend", ctas);
  }

  const strategiesCount = Math.max(1, Object.keys(window.STRATEGIES || {}).length);
  const stats = document.createElement("aside");
  stats.className = "hero-stats";
  stats.setAttribute("aria-label", "Возможности Strategy Lab");
  stats.innerHTML = `
    <div class="hero-market-bars" aria-hidden="true">
      <span style="--bar:29%"></span><span style="--bar:42%"></span><span style="--bar:35%"></span>
      <span style="--bar:55%"></span><span style="--bar:48%"></span><span style="--bar:68%"></span>
      <span style="--bar:59%"></span><span style="--bar:77%"></span><span style="--bar:66%"></span>
      <span style="--bar:88%"></span><span style="--bar:72%"></span><span style="--bar:96%"></span>
      <span style="--bar:82%"></span><span style="--bar:91%"></span>
    </div>
    <div class="hero-stat">
      <span class="hero-stat-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 20V10"/><path d="M12 20V4"/><path d="M19 20v-7"/><path d="M3 15l5-5 4 3 7-8"/></svg>
      </span>
      <strong id="heroInstrumentCount">502</strong>
      <span>Инструментов MOEX</span>
    </div>
    <div class="hero-stat">
      <span class="hero-stat-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>
      </span>
      <strong>${strategiesCount}</strong>
      <span>Готовых стратегий</span>
    </div>
    <div class="hero-stat">
      <span class="hero-stat-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6"/><path d="M10 3v5l-5 9a2 2 0 0 0 1.75 3h10.5A2 2 0 0 0 19 17l-5-9V3"/><path d="M8 14h8"/></svg>
      </span>
      <strong>5</strong>
      <span>Режимов исследования</span>
    </div>
    <div class="hero-stat">
      <span class="hero-stat-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>
      </span>
      <strong>MOEX</strong>
      <span>Источник рыночных данных</span>
    </div>`;

  const main = document.createElement("div");
  main.className = "hero-main";
  main.appendChild(heroTitle);
  main.appendChild(stats);

  hero.replaceChildren(topbar, main);

  // Keep the hero instrument total tied to the existing app status element.
  // This observer watches text only on one node and never mutates that node,
  // so it cannot create a MutationObserver feedback loop.
  const status = document.getElementById("status");
  const heroCount = document.getElementById("heroInstrumentCount");
  const syncInstrumentCount = function () {
    if (!status || !heroCount) return;
    const text = status.textContent || "";
    const match = text.match(/(?:MOEX:\s*|Инструментов\s+MOEX:\s*)(\d+)/i) || text.match(/\b(\d{2,4})\b/);
    if (match) heroCount.textContent = match[1];
  };
  if (status && heroCount) {
    syncInstrumentCount();
    new MutationObserver(syncInstrumentCount).observe(status, { childList: true, characterData: true, subtree: true });
  }

  const tabIcons = {
    portfolio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16v12H4z"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M4 12h16"/></svg>',
    strategies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M22 12h-4"/></svg>',
    backtest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 13h4l2-6 4 12 2-6h6"/></svg>',
    charts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
    replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 5v14l11-7z"/></svg>'
  };

  document.querySelectorAll("#appPrimaryTabs .tab[data-tab]").forEach(function (button) {
    if (button.querySelector("svg")) return;
    const key = button.dataset.tab;
    const label = button.textContent.trim();
    button.textContent = "";
    button.insertAdjacentHTML("beforeend", (tabIcons[key] || "") + `<span>${label}</span>`);
  });

  // Icon insertion can change tab geometry after the original indicator has
  // measured itself, so ask existing resize-driven layout code to recalc.
  requestAnimationFrame(function () { window.dispatchEvent(new Event("resize")); });
})();
