/* Legacy chart polish compatibility shim.
 * Keep this file free of interaction handlers: DrawingManager remains the sole
 * owner of chart pointer/runtime interactions. The restored terminal UI is
 * loaded as isolated modules after chart-analysis has been parsed.
 */
import("/static/chart-editor-terminal-indicators-v2.js")
  .then(() => import("/static/chart-editor-terminal-mobile-v2.js"))
  .then(() => import("/static/chart-editor-terminal-fixes.js"))
  .then(() => import("/static/chart-editor-terminal-compat.js"))
  .then(() => import("/static/chart-editor-terminal-icons.js"))
  .catch((error) => console.error("[StrategyLab] chart terminal bundle failed", error));
