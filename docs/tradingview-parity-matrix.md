# TradingView parity matrix — «Анализ графиков»

Снято 2026-08-18, обновлено после коммита `f38b4c9` (см. changelog в конце
файла). Методология: код `static/chart-engine/*.js`,
`static/chart-analysis.js`, `static/chart-editor-terminal-*.js` + выборочная
живая проверка на `strategylab.generationweb.ru` (390×844, Playwright,
реальные Pointer Events на проде). Колонка **Test** отмечает, была ли
строка подтверждена вживую в эту сессию, унаследована из предыдущих
раундов (см. `git log`), или проверена только чтением кода — **не ставим
PARITY там, где нет хотя бы одного из этих подтверждений** (ТЗ §176/177).

Статусы: `MISSING` / `BROKEN` / `PARTIAL` / `PARITY` / `BLOCKED`.

## Top toolbar / header

| Component | TV reference | Strategy Lab (до сессии) | Required | Status | Test |
|---|---|---|---|---|---|
| Symbol pill → search overlay | тап открывает watchlist с поиском/ценами | `#gtTicker` перехватывался на телефоне, открывал `watchlist.openMobileDrawer()` | да | PARITY | код (`wireTickerTap`), не переснято в эту сессию |
| Timeframe pill | показывает текущий интервал, тап → меню | «Д» — мёртвый `<span>`, `#gtTimeframe` спрятан | да | **PARITY (испр. эта сессия)** | живой Playwright, см. audit BUG 1 |
| Chart-type selector | иконка свечей → меню | `#gtChartType`, CSS-фон иконка на телефоне, `<select>` на десктопе | да | PARITY | код, унаследовано |
| Индикаторы | список с поиском по категориям | `_renderIndicatorsInto` — поиск, категории, активные/настройки | да | PARITY | код, унаследовано |
| Меню (☰) | catch-all drawer | proxy-клик на `#gtMoreBtn` («Ещё») | да (эквивалент) | PARTIAL | нет отдельного global-меню приложения, только chart «Ещё» |
| Compare/add symbol | наложение второго тикера на график | отсутствует | нет back-end для multi-symbol overlay | MISSING | — |
| Alerts (🔔) | список + создание | `_renderAlertsInto`, реальный `/api/alerts` backend для авторизованных | да | PARITY | код |
| Price/change в header | текущая цена, Δ, Δ% | `#gtPrice`/`#gtChange`, обновляются на тик | да | PARITY | код, унаследовано |
| Bid/Ask | цена продажи/покупки | `sl-market-head` показывает bid/offer, если есть в price feed | да, если данные есть | PARTIAL | зависит от Binance-фида; не для всех тикеров |
| Volume в header | форматированный объём (K/M/B) | `sl-market-head`, `toLocaleString(..., {notation:"compact"})` | да | PARITY | код |

## Price / time scale, crosshair

| Component | TV reference | Strategy Lab | Required | Status | Test |
|---|---|---|---|---|---|
| Price scale (labels, drag, autoscale) | стандартное поведение | lightweight-charts встроенный | да | PARITY | библиотека, унаследовано |
| Current price label | подпись у последней цены | встроено в серию | да | PARITY | библиотека |
| Crosshair (desktop, мышь) | линии + подписи | lightweight-charts встроенный crosshair | да | PARITY | библиотека |
| Crosshair (touch) | активация жестом, drag без панорамирования | не найден отдельный mobile-специфичный жест активации; предположительно поведение по умолчанию библиотеки | да | **NOT VERIFIED** | не проверено на реальном touch-устройстве |
| Price-scale «+» (визуальный, следует за ценой) | плавающая «+» кнопка у шкалы | `ChartTile._updateScalePlus` — реальная кнопка, следует за крестом по Y, позиция считается от `priceScale("right").width()` | да, high priority (ТЗ §31) | **PARITY (испр. эта сессия)** | живой Playwright, 5/5 повторных тестов; см. audit — потребовалось 2 раунда реальных багов (высота 22→44px из-за конфликтующего правила, pointerup/click ретаргетился на canvas у самой шкалы) |
| Price-scale quick menu | Create Alert / Add H-Line / Create Order | оба пункта есть (Create Alert / Add Horizontal Line); Create Order отсутствует | да (Order — только если есть trading backend, которого нет — сознательно не реализовано) | **PARITY (испр. эта сессия)** | живой Playwright — создана реальная horizontal_line на точной цене под кнопкой |
| Time scale (даты, зум, drag) | стандартное поведение | lightweight-charts встроенный | да | PARITY | библиотека |
| Timezone | не хардкодить UTC+3 | `theme.js` форматирует явно как UTC (см. docs/chart-engine.md «Тайм-зоны» — намеренно, т.к. свечи хранятся наивно как MSK-время, трактовка как UTC на фронте не искажает часы зрителя) | да | PARITY (по замыслу) | код + существующая документация |

## Chart body

| Component | TV reference | Strategy Lab | Required | Status | Test |
|---|---|---|---|---|---|
| Chart types | Candles/Bars/Line/Area/Baseline/HollowCandles/HeikinAshi (+опционально Renko/Kagi/PnF/Range) | 7: Candles/Bars/Line/Area/Baseline/HeikinAshi/HollowCandles | базовые 7 обязательны | **PARITY (испр. эта сессия)** | живой Playwright — цвет по сравнению с prevClose, hollow/filled по close-vs-open сверены с сырыми `/api/candles`; Renko/Kagi/PnF/Range по-прежнему не реализованы (опционально по ТЗ) |
| Grid | горизонт+вертикаль, низкая плотность | lightweight-charts встроенный, настроен в `theme.js` | да | PARITY | библиотека |
| Volume overlay | интегрирован в нижнюю часть pane | `ChartCore` создаёт volume-серию, toggle через индикаторы (`kind:"toggle"`) | да | PARITY | код |
| Auto-follow / «К последней цене» | компактный контрол, появляется только когда ушли от live-края | `core.js: scrollToRealTime()`, `chart-tile.js: liveBtn` | да | PARITY | код, унаследовано |
| Live update без сброса состояния | новые свечи не сбрасывают zoom/selection/crosshair | `_onRealtimeUpdate`/polling тика, не трогает viewport/drawings | да | PARITY | код |

## Drawing toolbar / инструменты

| Component | TV reference | Strategy Lab | Required | Status | Test |
|---|---|---|---|---|---|
| Trend Line, Ray, Extended Line, Horizontal/Vertical Line, Horizontal Ray | все работают | все 6 реализованы, включая **horizontal_ray** (эта сессия) | да | **PARITY (испр. эта сессия)** | живой Playwright — создан, отрисован, обрезан ровно по границе пейна |
| Parallel Channel | 3 точки, offset-линия | `parallel_channel` реализован | да | PARITY | код |
| Trend Angle, Regression Trend, Flat Top/Bottom, Disjoint Channel | | отсутствуют | да | MISSING | — |
| Pitchfork family (4 варианта) | | отсутствуют | да | MISSING | — |
| Rectangle, Rotated Rectangle, Circle/Ellipse, Triangle | | rectangle/circle(ellipse)/triangle есть; Rotated Rectangle отсутствует | да | PARTIAL | код |
| Polyline, Path, Arc, Curve, Double Curve, Brush(freehand), Highlighter, Arrow, Arrow Marker | | polyline, freehand(brush) есть; Path/Arc/Curve/DoubleCurve/Highlighter/Arrow/ArrowMarker отсутствуют | да | PARTIAL | код |
| Text, Anchored Text, Note, Price Note, Callout, Comment, Price Label, Signpost | | text, note есть; остальные аннотации отсутствуют как отдельные типы | да | PARTIAL | код |
| Fibonacci Retracement | anchors/levels/labels/style/extend/custom levels | anchors/levels/labels/style + **custom levels/Reverse/Extend-left** (эта сессия, Properties panel) | да, high priority | **PARITY (испр. эта сессия)** | живой Playwright — reverse/extendLeft/add/remove/edit level все подтверждены на реальном drawing |
| Fib Extension | | то же + custom levels/reverse (общий код с Retracement) | да | **PARITY (испр. эта сессия)** | код (общие хелперы с Retracement, отдельно не переигрывался вживую) |
| Fib Channel, Time Zone, Speed Resistance Fan/Arcs, Circles, Spiral, Wedge, Trend-Based Fib Time, Pitchfan | | отсутствуют | да | MISSING | — |
| Gann Fan/Square/Box | | отсутствуют | да | MISSING | — |
| Patterns (XABCD, ABCD, Triangle Pattern, Three Drives, H&S, Elliott Wave, Cyclic/Time Cycles, Sine) | | отсутствуют | да | MISSING | — |
| Forecast, Bars Pattern, Ghost Feed | | отсутствуют | опционально после core engine | MISSING | — |
| Long/Short Position | Entry/Target/Stop/P&L/R:R, редактируемые handles | `long_position`/`short_position` реализованы с `editHandles: ["start","end","stop","take"]`, hit-test на handles | да | PARITY | код |
| Price Range / Time Range / Price&Time Range | измерение с дельтами (персистентные line tools) | реализованы как персистентные drawing-объекты (`price_range`/`time_range`/`price_date_range`) — совпадает с TV, там это тоже отдельные постоянные инструменты, не Measure | да | PARITY | код, унаследовано |
| Measure (Ruler) — временный оверлей | Alt/удержание, live дельта цены/%/баров/времени, исчезает на pointerup, не создаёт объект | новый `measure` tool (`TOOL_DEFS.measure`, `ephemeral: true`) — `_finishDraft()` не вызывает `addDrawing()`, переармирует tool; рендер `kind:"measure_tool"` (пунктир, та же математика что у price_date_range); кнопка в обоих рейлах (десктоп/мобильный) | да | **PARITY (испр. эта сессия)** | живой Playwright — drag показал живой пунктирный box "-1,37 (-1,78%) / 7.5 ч. · 451 бар.", на pointerup исчез, `drawings.length` остался 0, `activeTool` переармировался в "measure", второй drag сразу сработал без повторного выбора кнопки; только через явную кнопку — Alt+drag в режиме Cursor не реализован (см. audit BUG 7) |
| Anchored VWAP / Volume Profile | | отсутствуют | да, если данные позволяют | MISSING | — |
| Zoom tool (area-zoom, отдельно от pinch) | | отсутствует | да | MISSING | — |

## Interaction / редактирование объектов

| Component | TV reference | Strategy Lab | Required | Status | Test |
|---|---|---|---|---|---|
| Object selection (tap/click, deselect на пустом месте) | | `hitTest()`, `select(null)` на пустом тапе | да | PARITY | код |
| Handle editing (drag anchor) | live preview, no chart pan | `_dragState`, `_applyDrag`, `_setNavigationLocked(true)` на весь drag | да | PARITY | код |
| Object move (drag body) | модель, не screen-offset | `_translatePoints` через logical/price delta | да | PARITY | код |
| Floating toolbar при выборе | контекстные стиль/цвет/удалить рядом с объектом | `ChartTile._renderFloatToolbar`/`_positionFloatToolbar` — реальная пилюля у топ-точки выбранного объекта (цвет, толщина/стиль или ✎ для текста, lock, hide, дублировать, "…"→Свойства, удалить), позиция пересчитывается на каждый `onViewUpdate` (пан/зум/live-тик); заменила собой старый `#tvObjectToolbar` (chart-mobile-interactions.js), который был закреплён у верхнего края рабочей области, а не у объекта | да | **PARITY (испр. эта сессия)** | живой Playwright: цвет/толщина/стиль/lock/hide/дублировать/"…"/удалить по одному, синхронизация с нижней панелью «Свойства», не осталось дублирующего верхнего бара; 198 pytest + 2 JS runtime suites зелёные |
| Object Tree («Объекты») | список, select/hide/lock/rename/delete, sync с canvas | `_renderObjects()` — всё вышеперечисленное, двусторонняя синхронизация | да | PARITY | код |
| Magnet Off/Weak/Strong | | было boolean (только Strong); теперь 3 режима | да | **PARITY (испр. эта сессия)** | live-проверка snapPoint() против реальных свечей, см. audit |
| Keep drawing mode | | `dm.keepDrawing`, рейл-кнопка «✎» | да | PARITY | код |
| Lock (individual + all) | | `updateDrawing({locked})`, рейл-кнопка блокирует все | да | PARITY | код |
| Hide (drawings/indicators/all) | family-меню | рейл — попап с раздельными Скрыть рисунки/позиции/индикаторы/всё, disabled на пустых категориях, label флипается в «Показать …» | да | **PARITY (испр. эта сессия)** | живой Playwright — SMA спрятана точечно (series.options().visible), рисунок/позиция не тронуты |
| Remove (selected/drawings/indicators/all) | family-меню с подтверждением | тот же попап, раздельные Удалить рисунки/позиции/индикаторы/всё, каждый со своим `confirm()` | да | **PARITY (испр. эта сессия)** | живой Playwright — «Удалить позиции» стёр только позицию, trend_line и SMA целы |
| Undo/Redo | | `_undoStack`/`_redoStack`, 100 записей, один push на operation (не на pointermove) | да | PARITY | код, ТЗ §84 уже соблюдён |
| Drawing persistence (reload/timeframe/symbol) | | `/api/chart-drawings`, привязка к symbol/pane, `loadDrawings()` при смене тикера | да | PARITY | код |
| Multiselect (Ctrl/Cmd click) | | отсутствует | да (desktop) | MISSING | — |
| Grouping | | отсутствует | да | MISSING | — |
| Per-tool style defaults | «сделать стилем по умолчанию» | реализовано (`saveToolStyleDefault`, `styleOverrides`) | да | PARITY | код |
| Visibility by timeframe | | реализовано (`properties.visibleTimeframes`, фильтр в `_buildOp`) | да | PARITY | код |
| Context menu (canvas + drawing) | right-click/long-press | `openContextMenu()` — настройки/дублировать/скрыть/блокировать/удалить на объекте; алерт/сброс масштаба/снимок на пустом месте | да | PARITY | код |

## Alerts

| Component | TV reference | Strategy Lab | Required | Status | Test |
|---|---|---|---|---|---|
| Create alert из price-scale tap | | `bindPriceAxisAlertGesture` + `_openAlertPopoverWithPrice` | да | PARITY | код |
| Conditions (Crossing/Up/Down, Greater/Less) | | `AS.CONDITION_LABELS` — нужно свериться с фактическим списком в `alert-service.js` (не вычитано построчно в эту сессию) | да | NOT VERIFIED | — |
| Persistent backend (не только пока открыта страница) | | `/api/alerts` REST для авторизованных, `/api/alerts/events` для polling триггеров | да | PARITY | код |
| Anonymous fallback | | localStorage-only режим для неавторизованных | — | PARITY (сознательное решение) | код |
| Alert line на графике | | `ChartTile._syncAlertLines()` (эта сессия) — каждый включённый алерт символа рисуется как `createPriceLine` (пунктир, 🔔+условие+цена в подписи оси), пересинхронизируется на create/update/remove/trigger, смену символа, пересоздание серии | да | **PARITY (испр. эта сессия)** | живой Playwright — создан реальный алерт, линия появилась с точной ценой/подписью, исчезла при удалении |
| Horizontal Line → Create Alert | | context-menu «Добавить алерт здесь» + новая «Добавить горизонтальную линию» рядом (эта сессия); работают от любой точки клика/тапа по price-scale «+», не именно от существующей Horizontal Line drawing | да | PARTIAL | код + живой Playwright для price-scale «+» вариант |

## Multi-chart / workspace / fullscreen

| Component | TV reference | Strategy Lab | Required | Status | Test |
|---|---|---|---|---|---|
| Fullscreen (настоящий API + CSS fallback, Escape) | | `fullscreen.js: FullscreenController` | да | PARITY | код, документировано в `docs/CHART_MODULE.md` |
| Layouts 1/2/2×2/3×2 | | `LAYOUTS` — 1/2v/2h/3/3b/4/6, архивирование убранных плиток (LIFO) | да | PARITY | код + существующая документация |
| Sync (ticker/interval/crosshair/scroll/zoom/range) | | `syncFlags`, echo-protection (`_applyingRange`/`_applyingCrosshair`) | да | PARITY | код + существующая документация |
| Mobile viewport (100dvh, safe-area, no double scroll) | | `env(safe-area-inset-*)`, `100dvh`, единая `overflow:hidden` цепочка | да | PARITY | живой Playwright (визуально, эта и предыдущие сессии) |
| Replay совместимость | | не проверялось в эту сессию | должен не сломаться | NOT VERIFIED | — |
| Backtest trade markers | entry/exit/long/short/hover | `trades.js: TradeOverlayPrimitive`, `TradeSelectionManager`, один canvas-примитив на все сделки | да | PARITY | код + существующая документация |

## Changelog этой сессии (после первого снимка, коммит `e1f7afe`)

Коммиты `aa402dc`, `9e61027`, `2e48c41`, `f38b4c9`, `8838d00`, `181bc1f`,
`8a6160a` — сняты после `6390adb`:

- **Floating toolbar при выборе** — из PARTIAL в PARITY.
  `ChartTile._renderFloatToolbar`/`_positionFloatToolbar`
  (`chart-engine/chart-tile.js`) рисуют реальную пилюлю у топ-точки
  выбранного объекта (`DrawingManager.selectionAnchor()`/`paneSize()`,
  новые в `drawings.js`): цвет, толщина+стиль линии (или ✎ «редактировать
  текст» для text/note), lock, hide, дублировать, «…»→открывает нижнюю
  панель «Свойства», удалить. Позиция пересчитывается на каждый
  `onViewUpdate` (реальная перерисовка пейна — пан/зум/live-тик), не
  повторяет `_renderFloatToolbar`. По ходу найдено и устранено: DrawingManager
  ничего не знал про DOM-оверлеи поверх канваса — клик по кнопке пилюли,
  сидящей прямо на точке объекта, попадал в тот же pixel-hit-test, что и
  сам объект, и мог заодно захватить pointer для drag/edit-сессии; добавлен
  точечный guard в `_onPointerDown`/`_onDblClick` на `.ca-float-toolbar`.
  Также обнаружился и устранён дублирующий, уже существовавший
  fixed-position `#tvObjectToolbar` (`chart-mobile-interactions.js`,
  закреплён у верхнего края рабочей области, не следил за объектом) —
  показывался одновременно с новой пилюлей на любом selection; удалён
  целиком (функция `renderObjectToolbar`, все вызовы, CSS), его
  width/dash/edit-text функциональность перенесена в новую пилюлю, чтобы
  ничего не регрессировало.
- **Hollow Candles** (`8838d00`) — из PARTIAL (6/7 обязательных типов) в
  PARITY. Цвет по сравнению с *предыдущим* close (не своим open, как у
  обычной свечи), тело hollow (цвет фона графика, виден только
  border/wick) когда close бара ≥ его собственного open, иначе залито
  сплошным цветом — два независимых измерения, как в реальном TV.
  lightweight-charts не имеет встроенного «hollow»-режима — реализовано
  через per-point `color`/`borderColor`/`wickColor` в данных серии.
- **Hide/Remove family-меню** (`181bc1f`) — из PARTIAL в PARITY. Рейл-
  кнопки «глаз»/«корзина» открывают попап с раздельными действиями:
  Скрыть/Удалить рисунки · позиции · индикаторы · всё. Позиции
  (`long_position`/`short_position`) отделены от рисунков просто по
  `d.type`, без изменений в `drawings.js`. Индикаторы раньше вообще не
  умели скрываться (не было даже `visible`-флага на инстансе) —
  `IndicatorPaneManager` получил `setVisible`/`setAllVisible`/
  `allHidden()`, обобщив уже существовавший спец-кейс volume-тумблера
  на любой тип серии.

- **price-scale «+»** — из PARTIAL в PARITY (визуальная кнопка + меню Create Alert/Add H-Line).
- **Alert lines на графике** — из NOT VERIFIED в PARITY (реально отсутствовали, теперь есть).
- **Horizontal Ray** — из PARTIAL (не было как отдельный тип) в PARITY.
- **Fibonacci custom levels/Reverse/Extend-left** — из PARTIAL в PARITY.
- **Найден и исправлен independent баг**: `ray`/`extended_line`/`fib_retracement`/
  `fib_extension`/`time_range` — все инструменты, «продлевающиеся до края»,
  обрезались по `container.clientWidth/clientHeight` (весь host, включая
  price-scale gutter и time-scale strip), а не по фактическому размеру
  canvas'а самого пейна (`DrawingLayerPrimitive` рисует только на нём) —
  часть линии, тянущаяся к правому/нижнему краю, просто не рендерилась
  (не «пряталась» под шкалой — canvas обрезает контент по своим
  границам). Исправлено централизованно (`paneWidth()`/`paneHeight()`
  хелперы) во всех 9 местах разом, не по одному инструменту.

- **Measure (Ruler)** (`58dcc8d` — см. `git log`) — из PARTIAL в PARITY. Новый
  `measure` tool в `TOOL_DEFS` с `ephemeral: true` — единственный tool, чей
  `_finishDraft()` не создаёт drawing-объект: вместо `addDrawing()` он
  очищает draft и сразу переармирует тот же tool, так что drag за drag
  измеряет подряд без повторного клика по кнопке. Рендер — новый op
  `kind: "measure_tool"` (пунктирный box, та же price+date-математика, что
  у `price_date_range`, но без drag-handles). Кнопка: `chart-analysis.js`
  TOOL_BUTTONS ("Измерение") на десктопе, первый пункт группы "Измерения"
  в мобильном рейле ("Линейка (временная)"). `price_range`/`time_range`/
  `price_date_range` не тронуты — в реальном TradingView это отдельные
  персистентные line tools, существующие наравне с Measure, не вместо него.

## Известные пробелы этой сессии (честно, не проверялось)

- Полный **reference pack** TradingView (25 состояний, 4 mobile viewport, §4 ТЗ) не
  собирался — эта сессия использовала предоставленные `Tradingview.PNG` +
  `Strategy Lab.png` как единственные референсы.
- **Pixel-diff/overlay сравнение** (§149-150) не проводилось — визуальные
  оценки в этой матрице основаны на прямом просмотре скриншотов, не на
  автоматизированном diff.
- **Real iOS Safari** не тестировался — вся touch-верификация через
  Chromium DevTools Pointer Events эмуляцию (см. audit, BUG 2-4).
- **Индикаторные панели** (crosshair sync между panes, resize, drawing
  tools внутри oscillator pane) не проверялись отдельно.
- **Keyboard shortcuts** сверх Ctrl+Z/Shift+Z/Delete/Escape (уже
  подтверждены в `chart-analysis.js`/`drawings.js`) — не сверялись
  построчно со списком ТЗ §104.
