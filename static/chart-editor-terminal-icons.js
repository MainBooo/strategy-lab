/* Final icon normalization for chart terminal chrome: inline stroke SVG only. */
(function (g) {
  "use strict";
  const Page = g.ChartAnalysisPage;
  const icons = {
    gear: '<svg data-sl-icon viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>',
    eye: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    close: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    trash: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>',
    lock: '<svg data-sl-icon viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>',
    copy: '<svg data-sl-icon viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3"/></svg>',
    pencil: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16zM14 7l3 3"/></svg>',
    bell: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M6 9a6 6 0 0112 0c0 7 3 7 3 8H3c0-1 3-1 3-8M10 21h4"/></svg>',
    expand: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M3 16v3a2 2 0 002 2h3"/></svg>',
    contract: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M9 3v4a2 2 0 01-2 2H3M15 3v4a2 2 0 002 2h4M9 21v-4a2 2 0 00-2-2H3M15 21v-4a2 2 0 012-2h4"/></svg>',
    undo: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M9 7L4 12l5 5M5 12h8a6 6 0 016 6"/></svg>',
    redo: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M15 7l5 5-5 5M19 12h-8a6 6 0 00-6 6"/></svg>',
    chevron: '<svg data-sl-icon viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>'
  };

  function put(button, name) {
    if (!button || button.querySelector("svg[data-sl-icon]")) return;
    button.innerHTML = icons[name] || "";
  }
  function normalize(root) {
    root = root || document;
    root.querySelectorAll("[data-sl-legend-settings]").forEach((b) => put(b, "gear"));
    root.querySelectorAll("[data-sl-legend-vis]").forEach((b) => put(b, "eye"));
    root.querySelectorAll("[data-sl-legend-remove]").forEach((b) => put(b, "close"));
    root.querySelectorAll("#gtAlertsPop [data-al-toggle]").forEach((b) => put(b, "bell"));
    root.querySelectorAll("#gtAlertsPop [data-al-del]").forEach((b) => put(b, "trash"));
    root.querySelectorAll("#gtTemplatesPop [data-del], #gtTemplatesPop [data-ws-del]").forEach((b) => put(b, "trash"));
    root.querySelectorAll("#gtTemplatesPop [data-ws-rename]").forEach((b) => put(b, "pencil"));
    root.querySelectorAll("[data-tv-obj-edit-text]").forEach((b) => put(b, "pencil"));
    root.querySelectorAll("[data-tv-obj-lock]").forEach((b) => put(b, "lock"));
    root.querySelectorAll("[data-tv-obj-duplicate]").forEach((b) => put(b, "copy"));
    root.querySelectorAll("[data-tv-obj-more]").forEach((b) => put(b, "gear"));
    root.querySelectorAll("[data-tv-obj-delete]").forEach((b) => put(b, "trash"));
    root.querySelectorAll('.ca-tile-btn[data-role="close"]').forEach((b) => put(b, "close"));
    root.querySelectorAll('.ca-tile-btn[data-role="fs"]').forEach((b) => put(b, b.closest(".ca-tile")?.classList.contains("is-fullscreen") ? "contract" : "expand"));
    put(root.querySelector?.("#caUndoBtn"), "undo");
    put(root.querySelector?.("#caRedoBtn"), "redo");
    const fs = root.querySelector?.("#caFullscreenBtn");
    if (fs && !fs.querySelector("svg[data-sl-icon]")) put(fs, document.querySelector("#chartsRoot")?.classList.contains("is-fullscreen") ? "contract" : "expand");
    const collapse = root.querySelector?.("#gtCollapseBottomBtn");
    if (collapse && !collapse.querySelector("svg[data-sl-icon]")) put(collapse, "chevron");
    root.querySelectorAll?.(".ca-more-item").forEach((b) => {
      if (b.querySelector("svg")) return;
      const cleaned = (b.textContent || "").replace(/^[^A-Za-zА-Яа-яЁё0-9%]+/u, "").trim();
      if (cleaned && cleaned !== b.textContent.trim()) b.textContent = cleaned;
    });
    root.querySelectorAll?.(".alert-toast-title").forEach((el) => {
      const text = (el.textContent || "").replace(/^[^A-Za-zА-Яа-яЁё0-9]+/u, "").trim();
      if (!el.querySelector("svg[data-sl-icon]")) el.innerHTML = `${icons.bell}<span>${text}</span>`;
    });
  }

  let frame = 0;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; normalize(document); });
  }
  const observer = new MutationObserver(schedule);
  if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  else document.addEventListener("DOMContentLoaded", () => observer.observe(document.body, { childList: true, subtree: true, characterData: true }), { once: true });
  if (g.AlertService && typeof g.AlertService.onTriggered === "function") g.AlertService.onTriggered(schedule);

  const style = document.createElement("style");
  style.id = "sl-terminal-svg-icons";
  style.textContent = `
    #chartsRoot button svg[data-sl-icon], .alert-toast-title svg[data-sl-icon]{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
    .alert-toast-title{display:flex;align-items:center;gap:7px}
  `;
  document.head.appendChild(style);
  schedule();
})(window);
