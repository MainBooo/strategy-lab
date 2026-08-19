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
| Pitchfork family (4 варианта) | | 3 из 4: Standard `pitchfork`, Schiff `pitchfork_schiff`, Modified Schiff `pitchfork_modified_schiff` — общая геометрия (median + 2 parallel teeth, pane-pixel space), различаются только парой model-точек, задающих median (см. `PITCHFORK_VARIANT`); Inside Pitchfork отсутствует | да | **PARTIAL (испр. эта сессия)** | живой Playwright — все 3 варианта нарисованы с идентичными анкорами для сравнения, median-геометрия подтверждена программно (Schiff/Modified Schiff стартуют из одной точки midpoint(P0,P1), расходятся по направлению), hit-test/select/Properties/Object Tree подтверждены на проде |
| Rectangle, Rotated Rectangle, Circle/Ellipse, Triangle | | все 4: `rotated_rectangle` (эта сессия) — anchor0-anchor1 задают одно ребро (длина+угол), anchor2 — перпендикулярное смещение (ширина), реальный повёрнутый quad в pane-pixel space (`rotatedRectCorners()`), не просто offset-цена как у parallel_channel | да | **PARITY (испр. эта сессия)** | живой Playwright на проде — нарисован (3 анкора), рендер `kind:"rotated_rect"` (4 угла, заливка+обводка), hit-test (2 треугольника через `pointInTriangle`, плюс 4 стороны) подтверждён программно в обеих направлениях |
| Polyline, Path, Arc, Curve, Double Curve, Brush(freehand), Highlighter, Arrow, Arrow Marker | | все 9 из 9 теперь реализованы. Эта сессия (2026-08-19, продолжение): `highlighter` (тот же drag-release семплинг, что freehand, но толще/полупрозрачнее/round-cap по умолчанию — отдельный rail-инструмент, не пресет), `arrow` (2-анкорный сегмент + треугольная голова у anchor 1), 4× `arrow_mark_{up,down,left,right}` (1 анкор, фиксированный screen-space глиф без учёта drag); затем `path` (тот же multi-tap/geometry, что polyline — TradingView сам их почти не различает), `curve` (квадратичный Bezier, anchor2 — control-точка, кривая её не проходит), `arc` (настоящая дуга окружности через 3 анкора — `circumcircle()`+`arcSamples()`, откат на прямой отрезок при коллинеарных анкорах), `double_curve` (кубический Bezier-S, anchor2/anchor3 — 2 control-точки) | да | **PARITY (испр. эта сессия)** | живой Playwright на проде — все 10 новых типов (highlighter/arrow/4×arrow_mark из первой части + path/curve/arc/double_curve из этой) нарисованы программно (`dm.addDrawing`), верные render op kinds (`arrow`/`arrow_mark`/`highlighter`/`rotated_rect`/`polyline`/`bezier`), hit-test подтверждён на геометрически рассчитанной точке тела каждого объекта, для Arc отдельно программно подтверждено, что сэмплированная дуга проходит через 3-й анкор (расстояние <1px — только погрешность дискретизации), Object Tree показал верные русские подписи, `drawings.length===0` после удаления+reload — не осталось мусора в БД прода |
| Text, Anchored Text, Note, Price Note, Callout, Comment, Price Label, Signpost | | text, note есть; остальные аннотации отсутствуют как отдельные типы | да | PARTIAL | код |
| Fibonacci Retracement | anchors/levels/labels/style/extend/custom levels | anchors/levels/labels/style + **custom levels/Reverse/Extend-left** (эта сессия, Properties panel) | да, high priority | **PARITY (испр. эта сессия)** | живой Playwright — reverse/extendLeft/add/remove/edit level все подтверждены на реальном drawing |
| Fib Extension | | то же + custom levels/reverse (общий код с Retracement) | да | **PARITY (испр. эта сессия)** | код (общие хелперы с Retracement, отдельно не переигрывался вживую) |
| Fib Channel, Time Zone, Speed Resistance Fan/Arcs, Circles, Spiral, Wedge, Trend-Based Fib Time, Pitchfan | | отсутствуют | да | MISSING | — |
| Gann Fan/Square/Box | | Gann Fan `gann_fan` — классические 9 лучей (1×8..8×1), наклон в реальных барах (logical, не raw pixels) от базовой 1×1 линии; Square/Box отсутствуют | да | **PARTIAL (испр. эта сессия)** | живой Playwright — все 9 лучей отрисованы, подписаны, клипованы по границе pane, порядок наклона верный (1×8 самый пологий → 8×1 самый крутой) |
| Patterns (XABCD, ABCD, Triangle Pattern, Three Drives, H&S, Elliott Wave, Cyclic/Time Cycles, Sine) | | 8 из 8 категорий ТЗ покрыты (10 конкретных tool-типов): XABCD `xabcd_pattern`/ABCD `abcd_pattern`/Three Drives `three_drives_pattern`/Elliott Impulse `elliott_impulse_wave`/Elliott Correction `elliott_correction_wave` — общий размеченный-зигзаг+%-отношение рендер; Triangle Pattern `triangle_pattern`/Head & Shoulders `head_shoulders_pattern` — зигзаг + boundary-луч(и) (2 сходящихся/расходящихся для треугольника, 1 neckline для Г&П); Cyclic Lines `cyclic_lines` — серия равноотстоящих по времени вертикальных линий через весь видимый pane (Time Cycles отдельно не реализован — тот же TradingView-концепт); Sine Line `sine_line` — одна синусоида между двумя анкорами, перпендикулярно базовой линии в pane-pixel space (амплитуда — эвристика, не сверялась пиксель-в-пиксель с живым TradingView). Ни один паттерн без авто-классификации по имени (Gartley/Bat/Butterfly/Crab для XABCD, волновые правила для Elliott) — отдельный, более крупный кусок работы | да | **PARTIAL (испр. эта сессия)** | живой Playwright — staged-постановка всех новых (drag+2×tap для Elliott Correction, drag+4×tap для Elliott Impulse, drag-release для Cyclic Lines/Sine Line), метки/%-отношения (Elliott), 16 равноотстоящих вертикальных линий подтверждены программно после pan (Cyclic Lines), 65-точечная синусоида подтверждена программно (Sine Line), hit-test/Object Tree подтверждены для всех четырёх новых типов; живьём найден и исправлен реальный краш (`cyclicLineTimes` читал `d.points[1].time` без guard на draft-preview с 1 точкой) |
| Forecast, Bars Pattern, Ghost Feed | | отсутствуют | опционально после core engine | MISSING | — |
| Long/Short Position | Entry/Target/Stop/P&L/R:R, редактируемые handles | `long_position`/`short_position` реализованы с `editHandles: ["start","end","stop","take"]`, hit-test на handles | да | PARITY | код |
| Price Range / Time Range / Price&Time Range | измерение с дельтами (персистентные line tools) | реализованы как персистентные drawing-объекты (`price_range`/`time_range`/`price_date_range`) — совпадает с TV, там это тоже отдельные постоянные инструменты, не Measure | да | PARITY | код, унаследовано |
| Measure (Ruler) — временный оверлей | Alt/удержание, live дельта цены/%/баров/времени, исчезает на pointerup, не создаёт объект | новый `measure` tool (`TOOL_DEFS.measure`, `ephemeral: true`) — `_finishDraft()` не вызывает `addDrawing()`, переармирует tool; рендер `kind:"measure_tool"` (пунктир, та же математика что у price_date_range); кнопка в обоих рейлах (десктоп/мобильный) | да | **PARITY (испр. эта сессия)** | живой Playwright — drag показал живой пунктирный box "-1,37 (-1,78%) / 7.5 ч. · 451 бар.", на pointerup исчез, `drawings.length` остался 0, `activeTool` переармировался в "measure", второй drag сразу сработал без повторного выбора кнопки; только через явную кнопку — Alt+drag в режиме Cursor не реализован (см. audit BUG 7) |
| Anchored VWAP / Volume Profile | | Anchored VWAP `anchored_vwap` (1 анкор — кумулятивный volume-weighted typical price от бара анкора до последней свечи, живой пересчёт каждый кадр от `core.candles`, включая live-тик); Volume Profile (гистограмма объёма по ценовым уровням) отсутствует — отдельный, значительно больший кусок работы | да, если данные позволяют | **PARTIAL (испр. эта сессия)** | живой Playwright — реальные BTC/SOL данные, линия VWAP визуально совпадает с ожидаемым сглаженным трендом; перетаскивание анкор-точки живьём пересчитало серию (838→586 точек при переносе анкора вперёд по времени); hit-test по вычисленной линии (не только по анкору) подтверждён программным сканом |
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

- **Pitchfork (Standard)** — из MISSING в PARTIAL. Новый `pitchfork` tool,
  3 анкора (staged drag+tap, как `parallel_channel`/`triangle`) — медиана из
  анкора 0 через середину анкоров 1/2, два зубца через анкоры 1/2 параллельно
  медиане, всё посчитано напрямую в pane-pixel space (не в реальных time/
  price единицах) — "параллельно" в этом инструменте означает ровно то, что
  видно на экране, тот же принцип, которым уже клипуются
  `ray`/`extended_line`/`horizontal_ray`. Schiff/Modified Schiff/Inside Pitchfork
  варианты не реализованы — остаётся PARTIAL, не PARITY.
- **Pitchfork Schiff + Modified Schiff** (продолжение той же сессии) — те же
  3 анкора и та же placement-механика, что у Standard выше, общая функция
  `pitchforkSegments()` (теперь принимает `variant`) вместо копипасты: все
  три варианта различаются только тем, какая пара *model*-точек задаёт
  median — Standard: анкор0 → midpoint(анкор1,анкор2); Schiff:
  midpoint(анкор0,анкор1) → midpoint(анкор1,анкор2); Modified Schiff:
  midpoint(анкор0,анкор1) → анкор2 (см. `PITCHFORK_VARIANT`/
  `pitchforkMedianModelPoints`). Оба зубца (через анкор1/анкор2, параллельно
  новой median) не меняются между вариантами — то же самое pane-pixel-space
  построение. Inside Pitchfork по-прежнему не реализован — 3 из 4 вариантов
  TradingView-группы теперь есть.
- **Gann Fan** — из MISSING в PARTIAL. Новый `gann_fan` tool, 2 анкора —
  анкор 1 задаёт "1×1" (45°) наклон в реальных барах (`timeToLogical`, не
  сырые пиксели, иначе фан выглядел бы по-разному на разных масштабах),
  остальные 8 лучей — фиксированные множители того же наклона (классический
  набор 1×8..8×1). Square/Box из этой же TradingView-группы не реализованы.
- **XABCD Pattern** — из MISSING в PARTIAL. Новый `xabcd_pattern` tool,
  5 анкоров (staged drag+3×tap) — размеченный зигзаг X-A-B-C-D с %-отношением
  каждой ноги к предыдущей (по цене) в местах вершин. Сознательно НЕ включает
  автоматическую классификацию по названию паттерна (Gartley/Bat/Butterfly/
  Crab) — то, что реальный TradingView XABCD делает поверх скелета, это
  отдельный, значительно больший кусок работы (сверка отношений с
  известными наборами Фибоначчи-диапазонов на каждую пару ног). ABCD/
  Triangle Pattern/Three Drives/Head & Shoulders/Elliott Wave/Cyclic Lines/
  Sine Line по-прежнему не реализованы вообще.
- **ABCD Pattern + Triangle Pattern** (продолжение той же линии работы) —
  из MISSING в PARTIAL. `abcd_pattern` — тот же размеченный-зигзаг + %-
  отношения рендер, что у XABCD, но 4 анкора (A-B-C-D, без X); отрефакторено
  под общий `PATTERN_LABELS`/`kind:"xabcd"` render-путь вместо копипасты —
  разница только в списке меток и точке отсчёта цикла %-отношений.
  `triangle_pattern` — 5 анкоров (тот же staged drag+3×tap, что у XABCD),
  но рендерит не только зигзаг 1-2-3-4-5 (метки цифрами, без %-отношений),
  а ещё и два boundary-луча — через анкор0→анкор2 и анкор1→анкор3, оба
  extended в pane-pixel space (`trianglePatternSegments()`, тот же принцип
  клипования, что у pitchfork/gann_fan) — это и есть сходящиеся/расходящиеся
  трендлинии, которыми реальный треугольный паттерн размечается, а не
  просто 5 точек. ABCD/Triangle Pattern теперь оба PARTIAL — из 8
  паттерн-инструментов ТЗ реализовано 3 (XABCD/ABCD/Triangle Pattern),
  Three Drives/H&S/Elliott Wave/Cyclic Lines/Sine Line остаются MISSING.
  **Верифицировано** вживую на проде: ABCD нарисован (drag+2×tap, 4 точки),
  подтверждены метки `["A","B","C","D"]` и обе %-отношения (66.7%/125.0% на
  скриншоте); Triangle Pattern нарисован (drag+3×tap, 5 точек) с двумя
  расходящимися boundary-лучами, подтверждено программно
  `trianglePatternSegments()` вернул 2 сегмента; hit-test подтверждён для
  обоих новых типов программным сканом, Object Tree показал верные русские
  подписи; тестовые drawings удалены, reload с прода подтвердил
  `drawings.length === 0`.
- **Three Drives Pattern + Head & Shoulders** (продолжение той же линии
  работы) — из MISSING в PARTIAL. `three_drives_pattern` — 6 анкоров
  (0-1-A-2-B-3, три «драйва» с двумя корректирующими откатами) —
  переиспользует ровно тот же `kind:"xabcd"` render/hit-test путь, что
  XABCD/ABCD (просто добавлен в `PATTERN_LABELS` и в оба case-списка) —
  ни одной новой строчки рендер-кода не понадобилось.
  `head_shoulders_pattern` — 5 анкоров (ЛП-впадина-Голова-впадина-ПП, тот
  же staged drag+3×tap, что у Triangle Pattern), рендерит зигзаг +
  ОДНУ boundary-линию (neckline через обе впадины, анкор1→анкор3) вместо
  двух — отрефакторено под общие `PATTERN_BOUNDARY_PAIRS`/
  `PATTERN_BOUNDARY_LABELS`/`patternBoundarySegments()` вместо копипасты
  Triangle Pattern-кода (кол-во boundary-линий теперь параметр, не
  зашитое число, `kind` рендера тоже обобщён в `"pattern_boundary"`
  вместо `"triangle_pattern"`). Pattern family теперь 5 из 8 (XABCD/ABCD/
  Triangle Pattern/Three Drives/Head & Shoulders); Elliott Wave/Cyclic
  Lines/Sine Line остаются MISSING — у каждого своя нестандартная
  геометрия/лейблинг, не drop-in по этому же рецепту.
  **Верифицировано** вживую на проде: Three Drives нарисован (drag+4×tap,
  6 точек) — метки `["0","1","A","2","B","3"]` и все 4 %-отношения
  (50.0%/220.0%/45.5%/800.0%) видны на скриншоте; Head & Shoulders
  нарисован (drag+3×tap, 5 точек) — метки `["ЛП","1","Г","2","ПП"]`
  подтверждены, `patternBoundarySegments()` вернул ровно 1 сегмент
  (neckline), видимый на скриншоте как горизонтальная линия через обе
  впадины, продлённая вправо; hit-test подтверждён для обоих новых типов
  программным сканом, Object Tree показал верные подписи; тестовые
  drawings удалены, reload с прода подтвердил `drawings.length === 0`.
  Побочная находка при живой проверке (не баг, просто заметка для
  следующей сессии): первая попытка нарисовать Three Drives молча не
  создала объект — координата первой точки (`box.y + 550`) на 13px
  превышала фактическую высоту тайла графика (537px), т.е. первый
  pointerdown landing вне canvas'а вообще не был захвачен
  DrawingManager'ом; drag "ничего не сделал", а затем каждый следующий
  tap добавлял ровно одну точку (итог: 4 из 6 нужных к моменту, когда
  тест был прерван) — сам движок отработал корректно, это была ошибка
  тестовых координат, не баг кода.
- **Elliott Wave (Impulse + Correction) + Cyclic Lines + Sine Line**
  (продолжение той же линии работы) — из MISSING в PARTIAL, закрывает все
  оставшиеся 3 категории паттерн-строки ТЗ. `elliott_impulse_wave` (6
  анкоров, 0-1-2-3-4-5) и `elliott_correction_wave` (4 анкора, 0-A-B-C) —
  оба переиспользуют ровно тот же `kind:"xabcd"` render/hit-test путь, что
  Three Drives/XABCD/ABCD (добавлены в `PATTERN_LABELS` и оба case-списка)
  — снова ни строчки нового рендер-кода. Никакой волновой валидации
  (чередование коррекций, «волна 3 никогда не самая короткая» и т.п.) —
  только размеченный скелет и %-отношения ног, как у всей этой семьи.
  `cyclic_lines` (2 анкора) — принципиально другая механика: анкор1.time
  минус анкор0.time задаёт интервал повтора, рендерится не сам отрезок
  между анкорами, а серия равноотстоящих по времени вертикальных линий
  через весь видимый pane в обе стороны от анкора0 (`cyclicLineTimes()`/
  `cyclicLineXs()`) — пересчитывается каждый кадр от текущего видимого
  диапазона (через `coordinateToLogicalSafe` по обеим границам pane), так
  что pan/zoom всегда показывают верный набор линий; жёсткий кап в 300
  линий на случай вырожденного near-zero интервала. Time Cycles (соседний
  TradingView-инструмент с тем же концептом) отдельно не реализован.
  `sine_line` (2 анкора) — одна синусоида от анкора0 до анкора1,
  осциллирующая перпендикулярно базовой линии анкор0→анкор1, целиком в
  pane-pixel space (`sineLineSamples()`, 64 сэмпла); амплитуда — доля от
  длины базовой линии (0.12), разумная, но не сверенная пиксель-в-пиксель
  с живым TradingView эвристика — честно задокументировано в коде.
  **Найден и исправлен реальный краш** при живой проверке (изначально не
  в тестах — синтетический fake-chart harness юнит-тестов случайно не
  воспроизводил этот конкретный кадр, см. ниже): `cyclicLineTimes()`
  читал `d.points[1].time` без проверки, что `d.points[1]` вообще
  существует. Точное окно: между `pointerdown` (анкор0 уже реально
  помещён в `draft.points`, длина 1) и первым `pointermove` этого же
  drag'а — `DrawingManager._draftPreviewPoint` в этот момент ещё `null`
  (устанавливается только в обработчике `pointermove`), так что
  `DrawingPaneView.update()`'s ветка "добавить preview-точку к
  draft.points для рендера" (`preview ? draft.points.concat([preview]) :
  draft.points`) отдаёт ровно 1 точку, а не 2 — `d.points[1]` оказывается
  `undefined`. На проде это окно реально достижимо (lightweight-charts
  перерисовывает независимо от движения курсора — live-тик, crosshair-
  редроу), в отличие от синтетического harness, где рендер вызывается
  только вручную. Исправлено guard'ом
  `if (!d.points[0] || !d.points[1]) return [];` в начале функции;
  воспроизведено вживую на проде, переподтверждено чистым после фикса —
  статика без build-шага, фикс живой сразу. Добавлен регресс-тест
  (`chart_drawing_runtime.test.js`), который рендерит именно в этом окне
  (сразу после `pointerdown`, до первого `pointermove`) — проверено, что
  тест реально ловит баг: временный откат guard'а немедленно ронял тест
  тем же `TypeError`, что и на проде.
  Pattern family теперь 8 из 8 категорий ТЗ (10 конкретных tool-типов)
  имеют хотя бы PARTIAL-реализацию; полная авто-классификация по имени
  паттерна (XABCD Gartley/Bat/Butterfly/Crab, Elliott волновые правила) —
  отдельная, значительно большая задача, остаётся не реализованной везде.
  **Верифицировано** вживую на проде: Elliott Impulse нарисован
  (drag+4×tap, 6 точек) — метки `["0","1","2","3","4","5"]` и 4
  %-отношения (42.9%/266.7%/50.0%/225.0%) видны на скриншоте; Elliott
  Correction нарисован (drag+2×tap, 4 точки) — метки `["0","A","B","C"]`
  и 2 %-отношения (64.3%/166.7%) видны; Cyclic Lines нарисован (один
  drag) — 16 равноотстоящих вертикальных линий подтверждены программно
  (`op.xs.length === 16`), пересчёт после панорамирования графика
  подтверждён без ошибок в консоли; Sine Line нарисован (один drag) — 65
  сэмплов синусоиды подтверждены программно, гладкая S-образная кривая
  видна на скриншоте; hit-test подтверждён для всех четырёх новых типов
  программным сканом, Object Tree показал верные подписи; тестовые
  drawings удалены, reload с прода подтвердил `drawings.length === 0`.
- **Anchored VWAP** — из MISSING в PARTIAL (соседний крупный MISSING-пункт,
  переключились на него после диминишинг-ретёрнс на остатках пункта
  Gann/Pitchfork/паттерны). Новый `anchored_vwap` tool, единственный
  анкор — но принципиально другая механика рендера, чем у всей семьи
  drawing-инструментов этой сессии: не фиксированная геометрия, а
  вычисляемая ценовая серия (кумулятивный volume-weighted typical price
  `(high+low+close)/3`, взвешенный по `volume` каждого бара) от бара
  анкора до последней свечи, пересчитываемая каждый кадр напрямую из
  живого `core.candles` (`anchoredVwapSeries()`/`anchoredVwapPixels()`) —
  тот же принцип "живой пересчёт без отдельного update-провода", которым
  уже пользуется `cyclic_lines` для видимого диапазона. Volume Profile
  (гистограмма объёма по ценовым уровням, вторая половина этого пункта
  ТЗ) — значительно больший отдельный кусок работы, не реализован.
  **Верифицировано** вживую на проде на реальных данных SOLUSDT: линия
  VWAP визуально совпала с ожидаемым сглаженным трендом (гладкая кривая
  поверх шумных свечей); перетаскивание анкор-точки живьём пересчитало
  всю серию (838 точек → 586 при переносе анкора вперёд по времени,
  подтверждено программно); hit-test по вычисленной линии (не только по
  самому анкору) подтверждён программным сканом. Тестовое покрытие:
  выделен в отдельный `persistentTools`-фильтр (как `measure`, но по
  другой причине — его "тело" нужно реальными candles+volume, которых
  нет в generic identity-conversion fake-окружении остальных тестов) с
  собственным dedicated-тестом на честных synthetic candles (проверены
  точные числовые значения VWAP на 3 барах, hit-test по анкору и по
  середине вычисленной линии, поведение при анкоре после последней свечи
  и при полностью пустых candles — оба случая не должны падать и не
  должны рендерить тело). 198 pytest + оба JS runtime suites зелёные.
- **Верифицировано** вживую на проде для Schiff/Modified Schiff — все три
  Pitchfork-варианта нарисованы с идентичными анкорами на одном графике для
  прямого сравнения; программно подтверждено, что Schiff и Modified Schiff
  стартуют median из одной и той же точки (midpoint анкор0/анкор1), но
  расходятся по направлению (Schiff → midpoint анкор1/анкор2, Modified
  Schiff → анкор2 напрямую), а Standard стартует из анкора0 — ровно по
  формулам выше; hit-test подтверждён для обоих новых типов программным
  сканом; тестовые drawings удалены, reload с прода подтвердил
  `drawings.length === 0`.
- Все три новых инструмента переиспользуют существующую generic-инфраструктуру
  без единой строчки специального кода: Properties panel (цвет/толщина/
  стиль/прозрачность/label/видимость по таймфреймам), Object Tree, floating
  toolbar при выборе (`selectionAnchor()`), undo/redo, автосохранение в
  `/api/chart-drawings` — всё это уже было написано для произвольного
  N-анкорного типа рисунка, ничего не пришлось трогать.
- Кнопки в обоих рейлах: десктопный `chart-analysis.js` TOOL_BUTTONS (3 новые
  записи) и мобильный/desktop-унифицированный рейл
  `chart-editor-terminal-mobile-v2.js` — 2 новые группы, "Ганн и вилы"
  (Вилы Эндрюса + Веер Ганна) и "Паттерны" (XABCD). Попутная находка: этот
  desktop TOOL_BUTTONS массив в `chart-analysis.js`, судя по всему,
  фактически мёртвый код — `chart-editor-terminal-mobile-v2.js`'s
  `buildRail()` рендерит `#caTools` безусловно на любом viewport (не только
  на телефоне) и переопределяет его содержимое; живая проверка на десктопе
  (1440×900) показала именно группированный рейл mobile-v2, не плоский
  список TOOL_BUTTONS. Уже существовавший до этой сессии пробел (`triangle`/
  `freehand` тоже отсутствовали в TOOL_BUTTONS) подтверждает это — не стал
  трогать/удалять в этой сессии, вне заявленной задачи.

### Продолжение 2026-08-19 (после части 10) — Rotated Rectangle, Arrow, Arrow Mark ×4, Highlighter

- **Rotated Rectangle** (`rotated_rectangle`) — из MISSING в PARITY. 3-анкорное
  размещение (staged drag+tap, как triangle/pitchfork): anchor0→anchor1 —
  одно ребро (длина+угол), anchor2 — перпендикулярное смещение от этого
  ребра (ширина). Настоящий повёрнутый quad в pane-pixel space
  (`rotatedRectCorners()`), а не price-offset проекция, которой пользуется
  `parallel_channel`, — поэтому прямоугольник реально поворачивается на
  экране, а не просто «съезжает» по цене. Hit-test — 2 треугольника через
  уже существовавший `pointInTriangle()` (диагональное разбиение quad) +
  4 стороны.
- **Arrow** (`arrow`) — из MISSING в PARITY. То же 2-анкорное размещение,
  что и `trend_line` (hit-test буквально делит с ним один `case`), рендер
  добавляет треугольную голову у anchor 1 в направлении вектора.
- **Arrow Mark ×4** (`arrow_mark_up/down/left/right`) — из MISSING в
  PARITY. 1 анкор, фиксированный screen-space глиф (не зависит от drag,
  в отличие от `arrow`) — стрелка + короткий хвост в одном из 4
  направлений (`ARROW_MARK_DIR`). Hit-test — круг вокруг тела глифа,
  смещённого от анкора в сторону хвоста (`arrowMarkBodyCenter()`), а не
  вокруг самой точки анкора — иначе тело было бы неотличимо от handle.
  Floating toolbar для этого типа скрывает и «толщину/стиль» (глиф
  фиксированного размера — на него не влияют), и текстовую кнопку
  text/note (`isArrowMark` в `chart-tile.js`).
- **Highlighter** (`highlighter`) — из MISSING в PARITY. Буквально тот же
  `creationGesture`/`completion` («freehand-drag»/«drag-release»), что и
  `freehand`, — отдельный tool, не пресет, только чтобы иметь свою кнопку
  на рейле (как в реальном TradingView). Отличается только
  `defaultProperties` (толщина 14px, непрозрачность 0.35, жёлтый по
  умолчанию) и собственным render op `kind:"highlighter"` (round
  cap/join — иначе толстый штрих выглядел бы как последовательность
  прямоугольных сегментов, не как маркер).
- Все шесть новых типов не потребовали ни строчки специального кода в
  Properties panel/Object Tree/undo-redo/автосохранении/whole-object drag
  (генерик-перевод точек по `editAxis`) — та же generic N-анкорная
  инфраструктура, что и у паттерн-семьи part 5-9.
- Кнопки: `chart-analysis.js` TOOL_BUTTONS (+7 записей, тот же вероятно
  мёртвый код, что и раньше — см. находку части 5, не трогал) и
  мобильный/унифицированный рейл `chart-editor-terminal-mobile-v2.js` —
  новая группа «Стрелки» (Arrow + 4× Arrow Mark), `rotated_rectangle`
  добавлен в существующую группу «Фигуры», `highlighter` — в
  существующую группу «Кисть» рядом с `freehand`.
  **Верифицировано** вживую на проде (QA-логин через подписанный session
  cookie, тот же `chart-qa-hollow-1786191200@example.com`): все 7 объектов
  созданы программно (`dm.addDrawing`) с ценами внутри видимого диапазона
  графика (не за пределами price-scale — первая попытка с офсетами ±3..8
  ушла за видимый диапазон и ничего не отрисовала, это не баг кода, а
  ошибка тестовых координат); render op kind подтверждён для каждого
  (`arrow`/`arrow_mark`×4/`highlighter`/`rotated_rect`), скриншот
  визуально подтвердил стрелку с головой, полупрозрачный жёлтый
  highlighter-штрих и повёрнутый залитый прямоугольник; hit-test
  подтверждён программным сканом на геометрически рассчитанной точке
  тела каждого объекта (не только на handle) — для arrow_mark отдельно
  проверены все 4 направления смещения тела; Object Tree показал верные
  русские подписи; все тестовые drawings удалены, reload с прода
  подтвердил `drawings.length === 0` — не осталось мусора в реальной БД.
  198 pytest + оба JS runtime suites зелёные (allTools расширен на 7
  новых имён; отдельный блок для `highlighter`, зеркальный уже
  существовавшему для `freehand`, проверяет drag-release семплирование
  и свой собственный op kind/width; `arrow` добавлен в generic
  fixed-2-point-tools цикл; `arrow_mark_up` — в generic single-tap-anchor
  цикл).

### Продолжение 2026-08-19, часть 2 — Path, Curve, Arc, Double Curve

Закрывает последний хвост той же строки ТЗ ("Polyline, Path, Arc, Curve,
Double Curve, Brush, Highlighter, Arrow, Arrow Marker" — теперь 9/9), после
Rotated Rectangle/Arrow/Arrow Mark/Highlighter выше в этом же changelog.

- **Path** (`path`) — из MISSING в PARITY. Буквально та же
  multi-tap-геометрия, что `polyline` (делит один и тот же render/hit-test
  `case`, рендерится тем же `kind:"polyline"`) — в реальном TradingView
  Path и Polyline тоже почти не различимы (оба — прямые отрезки между
  кликами), разница только в отдельной кнопке на рейле.
- **Curve** (`curve`) — из MISSING в PARITY. Квадратичный Bezier: anchor0/
  anchor1 — концы (staged drag, как обычно), anchor2 — **control-точка**
  (кривая выгибается в её сторону, но не проходит через неё — стандартная
  Bezier-терминология; TradingView-шный "тащи прямо по кривой" эффект
  нигде не задокументирован достаточно точно для сверки). Сэмплируется в
  33 точки (`quadraticBezierSamples()`) и красится/hit-тестится как
  полилиния через них — тот же принцип, которым уже пользуется
  `sine_line`, а не встроенный canvas `quadraticCurveTo` (у которого нет
  API «расстояние до точки» для hit-test).
- **Arc** (`arc`) — из MISSING в PARITY. Настоящая дуга окружности, не
  Bezier — anchor0/anchor1/anchor2 все трое лежат буквально **на** дуге
  (`circumcircle()` — окружность через 3 точки по формуле определителя;
  `arcSamples()` считает, какое из двух возможных направлений обхода от
  anchor0 к anchor1 реально проходит через anchor2, и сэмплирует именно
  его). При (почти) коллинеарных анкорах окружность не существует —
  честный откат на прямой отрезок anchor0→anchor1 (геометрический предел
  всё более плоской дуги — тоже прямая, ничего не «ломается»).
- **Double Curve** (`double_curve`) — из MISSING в PARITY. Кубический
  Bezier-S: anchor0/anchor1 — концы, anchor2/anchor3 — их две независимые
  control-точки (тот же принцип, что у Curve, только кубический —
  `cubicBezierSamples()`, 41 точка).
- Все четыре не потребовали нового кода в Properties panel/Object Tree/
  undo-redo/автосохранении/whole-object drag — та же generic N-анкорная
  инфраструктура. Кнопки: `chart-analysis.js` TOOL_BUTTONS (+4 записи) и
  новая группа «Кривые» в `chart-editor-terminal-mobile-v2.js`.
  **Верифицировано** вживую на проде (тот же QA-аккаунт): все 4 типа
  созданы программно с ценами внутри видимого диапазона, верные render op
  kinds (`polyline` для Path, общий `bezier` для Curve/Arc/Double Curve),
  скриншот визуально подтвердил угловатый zigzag у Path в противовес
  гладким кривым у остальных трёх; hit-test подтверждён на середине
  сэмплированной кривой для всех четырёх; отдельно программно проверено,
  что дуга Arc проходит через 3-й анкор (минимальное расстояние от
  сэмплированной дуги до пикселя anchor2 — 0.86px, чистая погрешность
  дискретизации на 41 точке, не ошибка формулы); Object Tree — верные
  подписи; тестовые drawings удалены, reload с прода подтвердил
  `drawings.length === 0`. 198 pytest + JS runtime suite зелёные —
  добавлены op-kind проверки для всех четырёх новых типов плюс отдельный
  regression-тест на откат Arc к прямому отрезку при коллинеарных
  анкорах (было бы `NaN`/крашем без guard на `circumcircle()`).

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
