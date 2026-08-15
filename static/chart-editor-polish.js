/* Late-loaded chart editor visual polish.
 *
 * Drawing state, Pointer Events and editor behavior live in the chart engine
 * and chart-mobile-interactions.js. This file is intentionally limited to
 * small cascade overrides that must load after the editor chrome.
 */
(function () {
  "use strict";

  const previous = document.getElementById("chart-editor-polish-styles");
  if (previous) previous.remove();

  const style = document.createElement("style");
  style.id = "chart-editor-polish-styles";
  style.textContent = `
    /* Indicator actions were inheriting the app-wide button padding, which
       made every + / settings / visibility / delete control much larger than
       the dense indicator list needs. Keep the override scoped to this list. */
    #chartsRoot .ca-ind-list .ca-indicator-row {
      min-height: 30px;
      gap: 4px;
      padding: 3px 2px;
    }

    #chartsRoot .ca-ind-list .ca-indicator-row > label {
      min-width: 0;
      margin: 0;
      gap: 5px;
      font-size: 11px;
      line-height: 1.2;
    }

    #chartsRoot .ca-ind-list .ca-indicator-row button,
    #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn {
      width: 28px !important;
      min-width: 28px !important;
      max-width: 28px !important;
      height: 28px !important;
      min-height: 28px !important;
      padding: 0 !important;
      margin: 0 !important;
      border-radius: 6px !important;
      flex: 0 0 28px !important;
      font-size: 13px !important;
      line-height: 1 !important;
    }

    #chartsRoot .ca-ind-list .ca-indicator-row button svg,
    #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn svg {
      width: 13px !important;
      height: 13px !important;
      flex: 0 0 13px !important;
    }

    @media (max-width: 620px) {
      #chartsRoot .ca-ind-list .ca-indicator-row {
        min-height: 28px;
        gap: 3px;
        padding: 2px 1px;
      }

      #chartsRoot .ca-ind-list .ca-indicator-row button,
      #chartsRoot .ca-ind-list .ca-indicator-row .icon-btn {
        width: 26px !important;
        min-width: 26px !important;
        max-width: 26px !important;
        height: 26px !important;
        min-height: 26px !important;
        flex-basis: 26px !important;
        border-radius: 5px !important;
      }
    }
  `;

  document.head.appendChild(style);
})();
