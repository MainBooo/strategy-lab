(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function fmtDate(ts) {
    if (!ts) return "—";
    return new Date(ts * 1000).toLocaleDateString("ru-RU");
  }
  function pct(v) {
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  // ------------------------------------------------------------- tabs ----
  function activateAccountTab(name) {
    document.querySelectorAll("[data-account-tab]").forEach((b) => b.classList.toggle("active", b.dataset.accountTab === name));
    document.querySelectorAll(".account-subpage").forEach((el) => el.classList.add("hidden"));
    const page = $("account-" + name);
    if (page) page.classList.remove("hidden");
    history.replaceState(null, "", name === "overview" ? "/account" : "/account/" + name);
    load(name);
  }
  document.querySelectorAll("[data-account-tab]").forEach((b) => {
    b.addEventListener("click", () => activateAccountTab(b.dataset.accountTab));
  });

  const loaded = new Set();
  function load(name) {
    if (loaded.has(name)) return;
    loaded.add(name);
    if (name === "overview") loadOverview();
    if (name === "backtests") loadBacktests(1);
    if (name === "portfolios") loadPortfolios();
    if (name === "favorites") loadFavorites();
  }

  // ---------------------------------------------------------- overview ---
  async function loadOverview() {
    let data;
    try { data = await authFetch("/account/api/overview"); } catch (e) { return; }
    $("overviewGreeting").textContent = "Добро пожаловать, " + data.display_name;
    $("overviewMetrics").innerHTML = [
      ["Бэктестов", data.counts.backtests],
      ["Портфелей", data.counts.portfolios],
      ["Избранных инструментов", data.counts.favorites],
    ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
    const rows = data.recent_backtests || [];
    $("overviewRecentBacktests").innerHTML = rows.length
      ? `<div class="table-scroll"><table><thead><tr><th>Дата</th><th>Портфель</th><th>Результат</th><th>Сделок</th><th></th></tr></thead><tbody>${
          rows.map((r) => `<tr><td>${fmtDate(r.created_at)}</td><td>${r.portfolio_name_snapshot || "—"}</td><td>${pct(r.return_percent)}</td><td>${r.trades_count ?? "—"}</td><td><a href="/?openRun=${r.id}">Открыть</a></td></tr>`).join("")
        }</tbody></table></div>`
      : `<p class="hint">Пока нет ни одного бэктеста. Запустите его на вкладке «Бэктест» в приложении.</p>`;
  }

  // --------------------------------------------------------- backtests ---
  async function loadBacktests(page) {
    let data;
    try { data = await authFetch(`/account/api/backtests?page=${page}&page_size=20`); } catch (e) { return; }
    const rows = data.rows || [];
    $("accountBacktestsTable").innerHTML = rows.length
      ? `<div class="table-scroll"><table><thead><tr><th>Дата</th><th>Портфель</th><th>Период</th><th>Сделок</th><th>Результат</th><th>Просадка</th><th></th></tr></thead><tbody>${
          rows.map((r) => `<tr><td>${fmtDate(r.created_at)}</td><td>${r.portfolio_name_snapshot || "—"}</td><td>${r.date_from || "—"} – ${r.date_to || "—"}</td><td>${r.trades_count ?? "—"}</td><td>${pct(r.return_percent)}</td><td>${pct(r.max_drawdown)}</td><td><a href="/?openRun=${r.id}">Открыть</a></td></tr>`).join("")
        }</tbody></table></div>`
      : `<p class="hint">У вас пока нет сохранённых бэктестов.</p>`;
    const total = data.total || 0, pageSize = 20, pages = Math.max(1, Math.ceil(total / pageSize));
    $("accountBacktestsPagination").innerHTML = pages > 1
      ? Array.from({ length: pages }, (_, i) => `<button class="secondary ${i + 1 === page ? "active" : ""}" data-page="${i + 1}">${i + 1}</button>`).join("")
      : "";
    $("accountBacktestsPagination").querySelectorAll("[data-page]").forEach((b) => {
      b.onclick = () => { loaded.delete("backtests"); loadBacktests(Number(b.dataset.page)); };
    });
  }

  // -------------------------------------------------------- portfolios ---
  async function loadPortfolios() {
    let data;
    try { data = await authFetch("/account/api/portfolios"); } catch (e) { return; }
    const rows = data.portfolios || [];
    $("accountPortfoliosTable").innerHTML = rows.length
      ? rows.map((p) => `<div class="account-table-row"><span>${p.name} <span class="hint" style="display:inline">(${(p.instruments || []).length} инструментов)</span></span><a href="/?portfolio=${p.id}">Открыть в приложении</a></div>`).join("")
      : `<p class="hint">У вас пока нет собственных портфелей. Портфели, созданные без входа в аккаунт, остаются общими для всех и отображаются на главной странице приложения.</p>`;
  }

  // --------------------------------------------------------- favorites ---
  async function loadFavorites() {
    let data;
    try { data = await authFetch("/account/api/favorites"); } catch (e) { return; }
    const rows = data.favorites || [];
    $("accountFavoritesList").innerHTML = rows.length
      ? rows.map((t) => `<div class="favorite-row"><span>${t}</span><button class="secondary" data-remove-fav="${t}">Убрать</button></div>`).join("")
      : `<p class="hint">Пока нет избранных инструментов. Добавляйте их звёздочкой на вкладке «Анализ графиков».</p>`;
    $("accountFavoritesList").querySelectorAll("[data-remove-fav]").forEach((b) => {
      b.onclick = async () => {
        try { await authFetch(`/account/api/favorites/${encodeURIComponent(b.dataset.removeFav)}`, { method: "DELETE" }); } catch (e) { return; }
        loaded.delete("favorites"); loadFavorites();
      };
    });
  }

  // ---------------------------------------------------------- settings ---
  function wireForm(formId, messageId, submit) {
    const form = $(formId);
    if (!form) return;
    const msg = $(messageId);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.textContent = ""; msg.className = "message";
      try {
        await submit(new FormData(form));
        msg.textContent = "Сохранено"; msg.className = "message success";
        form.reset();
      } catch (err) {
        msg.textContent = err.message || "Не удалось сохранить"; msg.className = "message error";
      }
    });
  }
  wireForm("profileForm", "profileMessage", (fd) =>
    authFetch("/account/api/settings/profile", { method: "POST", body: JSON.stringify({ display_name: fd.get("display_name") }) }));
  wireForm("passwordForm", "passwordMessage", (fd) => {
    if (fd.get("new_password") !== fd.get("new_password2")) throw new Error("Новые пароли не совпадают");
    return authFetch("/account/api/settings/password", {
      method: "POST",
      body: JSON.stringify({ current_password: fd.get("current_password"), new_password: fd.get("new_password") }),
    });
  });
  const deleteForm = $("deleteAccountForm");
  if (deleteForm) {
    deleteForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!confirm("Аккаунт будет деактивирован, вход станет невозможен. Продолжить?")) return;
      const msg = $("deleteAccountMessage");
      try {
        await authFetch("/account/api/delete", { method: "POST", body: JSON.stringify({ password: new FormData(deleteForm).get("password") }) });
        window.location.href = "/";
      } catch (err) {
        msg.textContent = err.message || "Не удалось удалить аккаунт"; msg.className = "message error";
      }
    });
  }

  activateAccountTab(window.ACCOUNT_INITIAL_TAB || "overview");
})();
