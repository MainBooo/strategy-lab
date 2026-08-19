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
| Trend Angle, Regression Trend, Flat Top/Bottom, Disjoint Channel | | все 4 реализованы (эта сессия): `trend_angle` — та же 2-анкорная геометрия/hit-test, что trend_line, плюс on-screen угол в градусах (`trendAngleDegrees()`, пересчитывается на каждый рендер — тот же принцип, почему угол в реальном TradingView «плывёт» при зуме); `regression_trend` — 2 анкора задают только временной диапазон, сама линия+полосы отклонения (±2σ) вычисляются живьём из `core.candles` (OLS-регрессия close по времени, `regressionTrendChannel()`) — тот же «живой пересчёт без отдельного update-провода», которым уже пользуется `anchored_vwap`; `flat_top_bottom` — тот же 3-анкорный `parallel_channel`, но вторая граница держит цену anchor2 константой (`flatBoundaryPoints()`), а не offset-параллельна; `disjoint_channel` — 4 независимых анкора, две несвязанные линии, переиспользует render/hit-test `channel`-кайнда напрямую (он и так не предполагает параллельность) | да | **PARITY (испр. эта сессия)** | живой Playwright на реальных данных SOLUSDT (200-барное окно для регрессии) — все 4 созданы программно, верные render op kinds, hit-test подтверждён для каждой линии/границы отдельно (включая обе несвязанные линии disjoint_channel и оба edge'а flat_top_bottom), regression_trend визуально подтверждён скриншотом (сплошная mid-линия + пунктирные ±2σ границы + заливка); 198 pytest + оба JS runtime suites зелёные (dedicated numeric-тест на OLS slope/intercept/stddev для regression_trend на synthetic 3-candle фикстуре, geometry-тесты на flat_top_bottom/disjoint_channel/trend_angle) |
| Pitchfork family (4 варианта) | | 3 из 4: Standard `pitchfork`, Schiff `pitchfork_schiff`, Modified Schiff `pitchfork_modified_schiff` — общая геометрия (median + 2 parallel teeth, pane-pixel space), различаются только парой model-точек, задающих median (см. `PITCHFORK_VARIANT`); Inside Pitchfork отсутствует | да | **PARTIAL (испр. эта сессия)** | живой Playwright — все 3 варианта нарисованы с идентичными анкорами для сравнения, median-геометрия подтверждена программно (Schiff/Modified Schiff стартуют из одной точки midpoint(P0,P1), расходятся по направлению), hit-test/select/Properties/Object Tree подтверждены на проде |
| Rectangle, Rotated Rectangle, Circle/Ellipse, Triangle | | все 4: `rotated_rectangle` (эта сессия) — anchor0-anchor1 задают одно ребро (длина+угол), anchor2 — перпендикулярное смещение (ширина), реальный повёрнутый quad в pane-pixel space (`rotatedRectCorners()`), не просто offset-цена как у parallel_channel | да | **PARITY (испр. эта сессия)** | живой Playwright на проде — нарисован (3 анкора), рендер `kind:"rotated_rect"` (4 угла, заливка+обводка), hit-test (2 треугольника через `pointInTriangle`, плюс 4 стороны) подтверждён программно в обеих направлениях |
| Polyline, Path, Arc, Curve, Double Curve, Brush(freehand), Highlighter, Arrow, Arrow Marker | | все 9 из 9 теперь реализованы. Эта сессия (2026-08-19, продолжение): `highlighter` (тот же drag-release семплинг, что freehand, но толще/полупрозрачнее/round-cap по умолчанию — отдельный rail-инструмент, не пресет), `arrow` (2-анкорный сегмент + треугольная голова у anchor 1), 4× `arrow_mark_{up,down,left,right}` (1 анкор, фиксированный screen-space глиф без учёта drag); затем `path` (тот же multi-tap/geometry, что polyline — TradingView сам их почти не различает), `curve` (квадратичный Bezier, anchor2 — control-точка, кривая её не проходит), `arc` (настоящая дуга окружности через 3 анкора — `circumcircle()`+`arcSamples()`, откат на прямой отрезок при коллинеарных анкорах), `double_curve` (кубический Bezier-S, anchor2/anchor3 — 2 control-точки) | да | **PARITY (испр. эта сессия)** | живой Playwright на проде — все 10 новых типов (highlighter/arrow/4×arrow_mark из первой части + path/curve/arc/double_curve из этой) нарисованы программно (`dm.addDrawing`), верные render op kinds (`arrow`/`arrow_mark`/`highlighter`/`rotated_rect`/`polyline`/`bezier`), hit-test подтверждён на геометрически рассчитанной точке тела каждого объекта, для Arc отдельно программно подтверждено, что сэмплированная дуга проходит через 3-й анкор (расстояние <1px — только погрешность дискретизации), Object Tree показал верные русские подписи, `drawings.length===0` после удаления+reload — не осталось мусора в БД прода |
| Text, Anchored Text, Note, Price Note, Callout, Comment, Price Label, Signpost | | text, note есть; остальные аннотации отсутствуют как отдельные типы | да | PARTIAL | код |
| Fibonacci Retracement | anchors/levels/labels/style/extend/custom levels | anchors/levels/labels/style + **custom levels/Reverse/Extend-left** (эта сессия, Properties panel) | да, high priority | **PARITY (испр. эта сессия)** | живой Playwright — reverse/extendLeft/add/remove/edit level все подтверждены на реальном drawing |
| Fib Extension | | то же + custom levels/reverse (общий код с Retracement) | да | **PARITY (испр. эта сессия)** | код (общие хелперы с Retracement, отдельно не переигрывался вживую) |
| Fib Channel, Time Zone, Speed Resistance Fan/Arcs, Circles, Spiral, Wedge, Trend-Based Fib Time, Pitchfan | | 9 из 9 — семья закрыта полностью. Часть 1 (`fib_time_zone`/`fib_speed_resistance_fan`/`fib_circles`/`fib_arcs`) — см. changelog «часть 3». Часть 2 (`fib_channel`/`fib_wedge`/`trend_based_fib_time`) — см. changelog «часть 4». Часть 3 (эта сессия): `fib_pitchfan` (тот же 3-анкорный handle+прогн placement, что у pitchfork, но вместо median+2 зубьев — веер лучей от anchor0 через каждую Фибоначчи-долю отрезка anchor1↔anchor2; на 50% луч буквально совпадает с медианой обычного pitchfork — переиспользует render/hit-test `gann_fan` без изменений, как уже делает fib_speed_resistance_fan), `fib_spiral` (логарифмическая «золотая спираль» вокруг anchor0, anchor1 задаёт стартовый радиус/угол; радиус растёт в φ раз за каждую четверть оборота — стандартное определение) | да | **PARITY/PARTIAL (испр. эта сессия)** | живой Playwright на проде — оба типа нарисованы программно, верные render op kinds (`gann_fan` для Pitchfan, `fib_spiral` для Spiral), скриншот визуально подтвердил веер лучей и узнаваемую логарифмическую спираль одновременно; hit-test подтверждён программно для обоих (Pitchfan — точка на веере рядом с вершиной, Spiral — точка на первом витке); floating toolbar появился при выделении; консоль чистая; `drawings.length===0` после удаления+reload — не осталось мусора в БД прода. Юнит-тесты: Pitchfan — все 7 лучей стартуют строго из anchor0, 50%-луч коллинеарен midpoint(anchor1,anchor2) и помечен major; Spiral — первая точка сэмплов буквально совпадает с anchor1, после ровно четверти оборота радиус вырос ровно в φ раз |
| Gann Fan/Square/Box | | Gann Fan `gann_fan` — классические 9 лучей (1×8..8×1), наклон в реальных барах (logical, не raw pixels) от базовой 1×1 линии; Square/Box отсутствуют | да | **PARTIAL (испр. эта сессия)** | живой Playwright — все 9 лучей отрисованы, подписаны, клипованы по границе pane, порядок наклона верный (1×8 самый пологий → 8×1 самый крутой) |
| Patterns (XABCD, ABCD, Triangle Pattern, Three Drives, H&S, Elliott Wave, Cyclic/Time Cycles, Sine) | | 8 из 8 категорий ТЗ покрыты (10 конкретных tool-типов): XABCD `xabcd_pattern`/ABCD `abcd_pattern`/Three Drives `three_drives_pattern`/Elliott Impulse `elliott_impulse_wave`/Elliott Correction `elliott_correction_wave` — общий размеченный-зигзаг+%-отношение рендер; Triangle Pattern `triangle_pattern`/Head & Shoulders `head_shoulders_pattern` — зигзаг + boundary-луч(и) (2 сходящихся/расходящихся для треугольника, 1 neckline для Г&П); Cyclic Lines `cyclic_lines` — серия равноотстоящих по времени вертикальных линий через весь видимый pane (Time Cycles отдельно не реализован — тот же TradingView-концепт); Sine Line `sine_line` — одна синусоида между двумя анкорами, перпендикулярно базовой линии в pane-pixel space (амплитуда — эвристика, не сверялась пиксель-в-пиксель с живым TradingView). Ни один паттерн без авто-классификации по имени (Gartley/Bat/Butterfly/Crab для XABCD, волновые правила для Elliott) — отдельный, более крупный кусок работы | да | **PARTIAL (испр. эта сессия)** | живой Playwright — staged-постановка всех новых (drag+2×tap для Elliott Correction, drag+4×tap для Elliott Impulse, drag-release для Cyclic Lines/Sine Line), метки/%-отношения (Elliott), 16 равноотстоящих вертикальных линий подтверждены программно после pan (Cyclic Lines), 65-точечная синусоида подтверждена программно (Sine Line), hit-test/Object Tree подтверждены для всех четырёх новых типов; живьём найден и исправлен реальный краш (`cyclicLineTimes` читал `d.points[1].time` без guard на draft-preview с 1 точкой) |
| Forecast, Bars Pattern, Ghost Feed | | отсутствуют | опционально после core engine | MISSING | — |
| Long/Short Position | Entry/Target/Stop/P&L/R:R, редактируемые handles | `long_position`/`short_position` реализованы с `editHandles: ["start","end","stop","take"]`, hit-test на handles | да | PARITY | код |
| Price Range / Time Range / Price&Time Range | измерение с дельтами (персистентные line tools) | реализованы как персистентные drawing-объекты (`price_range`/`time_range`/`price_date_range`) — совпадает с TV, там это тоже отдельные постоянные инструменты, не Measure | да | PARITY | код, унаследовано |
| Measure (Ruler) — временный оверлей | Alt/удержание, live дельта цены/%/баров/времени, исчезает на pointerup, не создаёт объект | новый `measure` tool (`TOOL_DEFS.measure`, `ephemeral: true`) — `_finishDraft()` не вызывает `addDrawing()`, переармирует tool; рендер `kind:"measure_tool"` (пунктир, та же математика что у price_date_range); кнопка в обоих рейлах (десктоп/мобильный) | да | **PARITY (испр. эта сессия)** | живой Playwright — drag показал живой пунктирный box "-1,37 (-1,78%) / 7.5 ч. · 451 бар.", на pointerup исчез, `drawings.length` остался 0, `activeTool` переармировался в "measure", второй drag сразу сработал без повторного выбора кнопки; только через явную кнопку — Alt+drag в режиме Cursor не реализован (см. audit BUG 7) |
| Anchored VWAP / Volume Profile | | Anchored VWAP `anchored_vwap` (1 анкор — кумулятивный volume-weighted typical price от бара анкора до последней свечи, живой пересчёт каждый кадр от `core.candles`, включая live-тик); Volume Profile `volume_profile` (2 анкора — Fixed Range: время от anchor0 до anchor1, цена анкоров игнорируется — гистограмма всегда покрывает полный high/low диапазон попавших в окно свечей, 24 ценовых бакета, объём каждой свечи распределён по бакетам пропорционально перекрытию диапазона свечи с каждым бакетом; POC — бакет с макс. объёмом — выделен отдельной заливкой+рамкой+подписью) | да, если данные позволяют | **PARITY (испр. эта сессия)** | живой Playwright — реальные SOL данные: 24/24 бакета спроецированы, ровно 1 POC, сумма объёмов бакетов совпадает с суммой объёмов попавших в диапазон свечей; hit-test по bounding-box гистограммы и по обоим якорям подтверждён программно; floating toolbar появился при выделении; скриншот подтвердил узнаваемую горизонтальную гистограмму с подписанным POC; линия VWAP по-прежнему визуально совпадает с ожидаемым сглаженным трендом (предыдущая сессия); hit-test VWAP по вычисленной линии (не только по анкору) подтверждён программным сканом |
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
| Multiselect (Ctrl/Cmd click) | | `DrawingManager.selectedIds` (Set, заменил единичный `selectedId` — сохранён как compat-геттер/сеттер), Ctrl/Cmd-click в `_onPointerDown` тогглит объект/группу через `select(id,{additive})` | да (desktop) | **PARITY (испр. эта сессия)** | живой Playwright: реальные mouse-события (не programmatic API) — plain click выбирает один, Ctrl-click добавляет второй, plain mousedown-drag на объекте внутри мульти-выборки двигает оба на одинаковую дельту |
| Grouping | | `groupSelection()`/`ungroupSelection()` пишут/чистят `properties.groupId`; клик по любому члену группы выбирает всю группу (`_selectionUnit`); групповой drag через `groupOrigPoints` в `_dragState`/`_applyDrag`; `duplicateSelection()` — дублированная группа получает новый groupId, не мержится с оригиналом | да | **PARITY (испр. эта сессия)** | живой Playwright: Group через floating toolbar назначил общий groupId обоим объектам; 198 pytest + 2 JS runtime suites зелёные (включая dedicated multiselect/group/duplicate блок) |
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

### Продолжение 2026-08-19, часть 3 — Fibonacci family, часть 1 (Time Zone, Speed Resistance Fan, Circles, Arcs)

Переключение на следующий крупный кандидат из плана части 12 после
закрытия строки Path/Arc/Curve/DoubleCurve выше — Fibonacci-семья, где
часть инструментов действительно переиспользует уже написанную Gann/
Cyclic-инфраструктуру, как и предполагалось.

- **Fib Time Zone** (`fib_time_zone`) — из MISSING в PARTIAL. anchor0→
  anchor1's время задаёт базовый интервал; вертикальные линии рисуются на
  `anchor0.time + интервал×F` для каждого числа Фибоначчи F (0,1,2,3,5,8,
  13...) — новая `fibTimeZoneMarks()`, фиксированный (не per-frame
  динамический, как у `cyclic_lines`) список из 25 членов ряда Фибоначчи
  с лихвой покрывает любой реалистичный масштаб/расстояние между
  анкорами без пересчёта количества членов на каждый кадр. Линии
  подписаны самим числом зоны (как в реальном TradingView).
- **Fib Speed Resistance Fan** (`fib_speed_resistance_fan`) — из MISSING
  в PARTIAL. Та же 2-анкорная постановка, что у `gann_fan`, но лучи идут
  от anchor0 к фракционным *ценовым* точкам на времени anchor1 (доли
  Фибоначчи от ценового диапазона anchor0→anchor1) — новая
  `fibFanSegments()`, классическое определение Speed Resistance Fan
  (веерные линии к дробным уровням отката диапазона), а не Gann-подобные
  угловые коэффициенты 1×8..8×1 от 45°-базовой линии. Полностью
  переиспользует render/hit-test `gann_fan`-опа (`{segments, label,
  major}`) без изменений — оба инструмента структурно идентичны, кроме
  того, как считаются сегменты.
- **Fib Circles** (`fib_circles`) — из MISSING в PARTIAL. Концентрические
  кольца вокруг anchor0, радиусы — коэффициенты Фибоначчи (0.236..1.618,
  включая расширения за 100%, а не только 0-100% как у retracement) от
  пиксельного расстояния anchor0→anchor1 — новая `fibCircles()`.
  Рендерится через `ctx.ellipse()` с независимым x/y масштабом (как уже
  делает инструмент `circle`), не `ctx.arc()` — на случай разных
  horizontal/vertical pixel ratio холста. Hit-test — «кольцевая полоса»
  (`|dist-radius| <= tol`), не заливка внутренности.
- **Fib Arcs** (`fib_arcs`) — из MISSING в PARTIAL. Те же радиусы, что у
  Fib Circles, но центр — anchor1 (конец движения, отдельное от Fib
  Circles соглашение TradingView), и рисуется только половина окружности,
  обращённая в сторону от anchor0 — новая `fibArcSamples()`, делит
  переиспользуемый `circleArcSamples()` с полным кольцом Circles (тот же
  сэмплер, разный диапазон углов). Hit-test — расстояние до сэмплированной
  полилинии (как у Curve/Arc/Sine Line), не кольцевая полоса, поскольку
  полукольцо — не замкнутая кривая.
- Все четыре не потребовали нового кода в Properties panel/Object Tree/
  undo-redo/автосохранении/whole-object drag. Кнопки: `chart-analysis.js`
  TOOL_BUTTONS (+4 записи) и существующая группа «Фибоначчи» в
  `chart-editor-terminal-mobile-v2.js` (была 2 пункта, стала 6).
  **Верифицировано** вживую на проде (тот же QA-аккаунт): все 4 типа
  созданы программно с ценами внутри видимого диапазона; верные render
  op kinds для каждого (`fib_speed_resistance_fan` подтверждённо реально
  делит `kind:"gann_fan"`, не отдельный); скриншот визуально подтвердил
  все 4 формы одновременно, включая подписанные зоны «0 1 2 3» и явно
  различимые вложенные кольца vs полукольца; hit-test подтверждён
  программно для всех четырёх — для `fib_time_zone` пришлось отдельно
  скрыть остальные 3 плотно расположенные тестовые фигуры и повторить
  hit-test изолированно (у первой попытки пробная точка совпала с
  визуальным перекрытием соседних фигур в тесных тестовых координатах,
  не с багом самого hit-test — после изоляции совпадение подтвердилось);
  Object Tree — верные подписи; тестовые drawings удалены, reload с
  прода подтвердил `drawings.length === 0`. 198 pytest + JS runtime
  suite зелёные — allTools +4 имени (generic persistentTools/pointsFor/
  boundaryPointsFor уже покрывали anchorCount 2 без изменений), плюс
  отдельные проверки: op kind для всех четырёх, строго возрастающие
  радиусы колец Fib Circles (не просто «какие-то кольца»), и что каждая
  дуга Fib Arcs — реально разомкнутая половина (оба конца на одном
  радиусе от anchor1, но не совпадают друг с другом).

### Продолжение 2026-08-19, часть 4 — Fibonacci family, часть 2 (Channel, Wedge, Trend-Based Fib Time)

Закрывает 7 из 9 в Fibonacci-строке ТЗ (остаются только Fib Spiral и Fib
Pitchfan — новая геометрия, отдельный будущий кусок). Все три выбраны
именно как «дешёвые довески» — прямые расширения уже написанной
геометрии parallel_channel/triangle/fib_time_zone, как и предполагалось
в плане предыдущей части.

- **Fib Channel** (`fib_channel`) — из MISSING в PARTIAL. Та же
  3-анкорная постановка, что у `parallel_channel` (anchor2's
  перпендикулярное ценовое смещение от линии anchor0-anchor1 через уже
  существующую `lerpPriceAtTime()`), но вместо двух границ рисуется одна
  линия-уровень на каждую долю `fibLevels()`/`FIB_RETRACEMENT_LEVELS` —
  новая `fibChannelSegments()`. Уровень 0 совпадает с линией
  anchor0-anchor1 буквально, уровень 1 — с offset-линией
  parallel_channel; всё остальное линейно интерполируется между ними.
  Сегменты ограничены anchor0.time..anchor1.time (не продлеваются до
  края pane), как и у самого `parallel_channel`.
- **Fib Wedge** (`fib_wedge`) — из MISSING в PARTIAL. Та же 3-анкорная
  постановка, что у `triangle`/`pitchfork` (anchor0 — общая вершина,
  anchor1/anchor2 — два расходящихся ребра), но вместо замкнутой фигуры
  или зубьев — новая `fibWedgeSegments()`, для каждой доли Фибоначчи L
  (кроме 0 — вырождается в саму вершину, пропускается) соединяет точку
  на доле L вдоль ребра anchor0→anchor1 с точкой на той же доле вдоль
  ребра anchor0→anchor2: сужающийся веер соединительных линий от вершины
  наружу, силуэт клина. На доле L=1 линия буквально совпадает с
  anchor1↔anchor2.
- **Trend-Based Fib Time** (`trend_based_fib_time`) — из MISSING в
  PARTIAL. Та же математика чисел Фибоначчи, что уже написана для
  `fib_time_zone` (`FIB_TIME_ZONE_SEQUENCE`), но зоны отсчитываются от
  anchor1 (конец тренда), а не anchor0 (начало) — новая
  `trendBasedFibTimeMarks()`, отличается от `fibTimeZoneMarks()` только
  тем, от какого анкора считается интервал; собственный TradingView-шный
  смысл двух похожих инструментов ("Time Zone" считает от точки старта,
  "Trend-Based Fib Time" — от точки окончания движения). Полностью
  переиспользует render/hit-test-опу `fib_time_zone` без изменений.
- Все три не потребовали нового кода в Properties panel/Object Tree/
  undo-redo/автосохранении/whole-object drag. Кнопки: `chart-analysis.js`
  TOOL_BUTTONS (+3 записи) и существующая группа «Фибоначчи» в
  `chart-editor-terminal-mobile-v2.js` (была 6 пунктов, стала 9).
  **Верифицировано** вживую на проде (тот же QA-аккаунт): все 3 типа
  созданы программно с ценами внутри видимого диапазона; верные render
  op kinds (Trend-Based Fib Time подтверждённо реально делит
  `kind:"fib_time_zone"`, не отдельный); скриншот визуально подтвердил
  все 3 формы одновременно — подписанные уровни канала 0.0%..100.0%,
  явно сужающийся клин, зоны 0/1; hit-test подтверждён программно для
  всех трёх — для Fib Wedge отдельно проверены обе граничные стороны
  (`edge1`/`edge2`), не только уровневые линии; Object Tree — верные
  подписи; тестовые drawings удалены, reload с прода подтвердил
  `drawings.length === 0`. 198 pytest + JS runtime suite зелёные —
  allTools +3 имени, плюс точная геометрическая проверка для всех трёх
  (Fib Channel: уровень 0 буквально совпадает с anchor0→anchor1, уровень
  1 проходит через anchor2; Fib Wedge: уровень 0 пропущен, уровень 1
  буквально совпадает с anchor1↔anchor2; Trend-Based Fib Time: зона 0
  сидит на anchor1, не anchor0). По пути найдена и исправлена
  cross-realm-ловушка в самом тестовом харнессе (не в коде продукта):
  `assert.deepStrictEqual` на объект, пришедший прямо из `vm`-песочницы
  drawings.js, падал из-за разных `Object.prototype` между реалмами
  (Node's `deepStrictEqual` сверяет и прототип) — исправлено извлечением
  примитивных полей в новый объект перед сравнением, тот же приём, что
  уже неявно использовался в паре существующих тестов этого файла.

### Продолжение 2026-08-19, часть 5 — Fibonacci family, часть 3 (Pitchfan, Spiral) — семья закрыта 9/9

Закрывает последние два инструмента Fibonacci-строки ТЗ. Оба — genuinely
новая геометрия (не drop-in расширение существующего кода), как и
ожидалось в плане части 4.

- **Fib Pitchfan** (`fib_pitchfan`) — из MISSING в PARTIAL. Та же
  3-анкорная постановка, что у `pitchfork` (anchor0 — handle,
  anchor1/anchor2 — прогны), но вместо median+2 параллельных зубьев —
  новая `fibPitchfanSegments()`: веер лучей от anchor0 через точку на
  каждой доле `FIB_PITCHFAN_RATIOS` (`[0, 0.382, 0.5, 0.618, 1, 1.618,
  2.618]`) вдоль отрезка anchor1→anchor2, интерполированного в реальных
  time+price (доли вне [0,1] корректно экстраполируют за прогн).
  Переиспользует ray-клиппинг + render/hit-test-опу `gann_fan` без
  изменений — тот же приём, которым уже пользуется
  `fib_speed_resistance_fan` для своего, по-другому устроенного веера.
  На доле 0.5 целевая точка буквально совпадает с midpoint(anchor1,
  anchor2) — той же точкой, куда целится медиана обычного pitchfork
  (`pitchforkMedianModelPoints`, вариант "standard") — не совпадение, оба
  инструмента в TradingView имеют это определение; этот луч помечен
  `major`, как и 1×1-луч у Gann Fan.
- **Fib Spiral** (`fib_spiral`) — из MISSING в PARTIAL. Новая
  `fibSpiralSamples()`: логарифмическая «золотая спираль» вокруг
  anchor0, anchor1 задаёт стартовый радиус (пиксельное расстояние от
  anchor0) и стартовый угол. Радиус растёт в φ=(1+√5)/2 раз за каждую
  четверть оборота — стандартное определение «golden spiral», честно
  задокументированная эвристика (как и амплитуда sine_line/набор рэйтов
  Ганн-фана), не сверенная пиксель-в-пиксель с живым TradingView.
  Сэмплируется на `FIB_SPIRAL_TURNS=3` полных оборота (`48` сэмплов на
  оборот) в polyline-точки — та же техника, что уже использует sine_line/
  bezier-семья, а не через canvas-примитив дуги (нет API «расстояние до
  точки» для hit-test).
- Оба не потребовали нового кода в Properties panel/Object Tree/undo-
  redo/автосохранении/whole-object drag. Кнопки: `chart-analysis.js`
  TOOL_BUTTONS (+2 записи) и группа «Фибоначчи» в
  `chart-editor-terminal-mobile-v2.js` (была 9 пунктов, стала 11).
  **Верифицировано** вживую на проде (тот же QA-аккаунт): оба типа
  созданы программно с реальными bar-aligned анкорами; верные render op
  kinds (`gann_fan` для Pitchfan, `fib_spiral` для Spiral — отдельный
  новый); скриншот визуально подтвердил явный веер лучей и узнаваемую
  логарифмическую спираль на одном графике одновременно; hit-test
  подтверждён программно для обоих (вершина веера у Pitchfan, первая
  точка сэмплов у Spiral — совпала с якорем `handle:1`); floating
  toolbar появился при выделении Pitchfan; консоль чистая на всех шагах;
  тестовые drawings удалены, reload с прода подтвердил
  `drawings.length === 0`. 198 pytest + оба JS runtime suite зелёные —
  allTools +2 имени, плюс точная геометрическая проверка (Fib Pitchfan:
  все 7 лучей стартуют строго из anchor0 (x1=y1=0 в тестовых
  identity-координатах), 50%-луч коллинеарен midpoint(anchor1,anchor2) и
  помечен `major`; Fib Spiral: первая точка сэмплов буквально совпадает
  с anchor1, после ровно четверти оборота (шаг 12 из 48-на-оборот)
  радиус вырос ровно в φ раз — оба свойства прошли на первой попытке,
  без правок формул).

### Продолжение 2026-08-19, часть 6 — Volume Profile (Fixed Range)

Closes the second half of the Anchored VWAP / Volume Profile ТЗ line item
(the first half, `anchored_vwap`, was done in an earlier session).

- **Volume Profile** (`volume_profile`) — из MISSING в PARITY. Fixed Range
  Volume Profile: 2 анкора, но принципиально другого назначения, чем у
  каждого другого 2-анкорного инструмента этой сессии — их цена
  игнорируется, значение несёт только их время (order-independent диапазон
  `[min(t0,t1), max(t0,t1)]`). Внутри этого временного окна — полный
  high/low диапазон всех попавших туда свечей делится на `VOLUME_PROFILE_
  ROWS=24` равных ценовых бакета (TradingView-й собственный дефолт для
  этого инструмента). Объём каждой свечи распределяется по всем бакетам,
  которые перекрывает её собственный диапазон `[low,high]`, пропорционально
  доле перекрытия — не «весь объём в один бакет по close», как было бы
  проще, а честное распределение (TradingView делает то же самое: реальная
  свеча редко торгуется по одной цене). POC (Point of Control, TradingView-
  й термин для строки с максимальным объёмом) помечается отдельно —
  заливка ярче, своя рамка, подпись «POC».
  Новые `volumeProfileBuckets()`/`volumeProfilePixels()` — тот же принцип
  «живой пересчёт из core.candles каждый кадр, без отдельного апдейт-
  провода», которым уже пользуются `anchoredVwapSeries`/`cyclicLineTimes`.
  Рендер/hit-test — новый, не переиспользует ни один существующий op kind
  (единственный инструмент этой Fibonacci/паттерн-серии сессий, которому
  понадобился настоящий новый `_drawOp` case, а не расширение уже
  написанного) — bounding-box hit-test (не по каждому бару отдельно,
  проще и достаточно для UX), бары растут вправо от левого края коробки на
  `MAX_BAR_FRACTION=0.9` её ширины, масштаб — доля от объёма POC-бакета.
  Кнопки: `chart-analysis.js` TOOL_BUTTONS (+1) и группа «VWAP» в
  `chart-editor-terminal-mobile-v2.js` переименована в «VWAP / Профиль»
  (была 1 пункт, стала 2) — тот же самый SVG-иконка (`icon("vwap")`) и так
  уже выглядит как гистограмма объёма+кривая, подошла без изменений.
  **Верифицировано** вживую на проде (тот же QA-аккаунт): drawing создан
  программно на реальных SOLUSDT данных (диапазон ~500 баров); верный
  render op kind (`volume_profile`), 24/24 бакета спроецированы, ровно
  один POC-бакет; скриншот визуально подтвердил горизонтальную гистограмму
  с подписанным «POC» и пунктирной рамкой профиля; hit-test подтверждён
  программно и по обоим якорям, и по bounding-box гистограммы; floating
  toolbar появился при выделении; консоль чистая; тестовый drawing удалён,
  reload с прода подтвердил `drawings.length === 0`. 198 pytest + оба JS
  runtime suite зелёные — allTools +1 имя, отдельный dedicated-тест на
  synthetic candles (как у `anchored_vwap`, не generic identity-fixture —
  тоже вычисляемый инструмент, не фиксированная геометрия): 3 свечи с
  ценовыми диапазонами ровно на границах бакетов (каждая занимает ровно 8
  из 24 бакетов) — точные числовые значения по бакетам (12.5/25/37.5),
  сумма объёмов бакетов равна сумме объёмов свечей (600), POC-флаг ровно на
  одном бакете, decoy-свеча далеко вне временного/ценового диапазона не
  протекла в бакеты; отдельный тест на диапазон без свечей внутри (не
  падает, ничего не рисует) и на пустой `makeManager()`-фикстуру без свечей
  вовсе.
- **Multiselect (Ctrl/Cmd click) + Grouping** — из MISSING в PARITY, самый
  крупный оставшийся кусок ТЗ. `DrawingManager.selectedId` (единичный
  string) заменён на `selectedIds` (Set, insertion-ordered) —
  `selectedId` остался compat-геттером/сеттером (читает/пишет первый
  элемент множества), так что все довавторные call sites
  (addDrawing/removeDrawing/undo/redo/loadDrawings/hitTest) продолжают
  работать без изменений в single-selection режиме. `select(id,
  {additive})`: Ctrl/Cmd-click (`_onPointerDown`) передаёт
  `additive:true` — тогглит `_selectionUnit(id)` (сам объект, либо, если
  он в группе, все члены группы разом — клик по любому одному члену
  группы выбирает её всю целиком, поведение реального TradingView) в/из
  текущей выборки; plain click заменяет выборку целиком. `hitTest`
  отдаёт resize-handles только при ровно одном выбранном объекте — при
  мульти-выборке любой drag всегда whole-object (не resize), совпадает с
  тем, что рисуется (`showHandles` в `_buildOp` той же логикой).
  Whole-object drag на объекте, который уже часть текущей мульти-
  выборки, двигает все выбранные объекты на одну и ту же
  logical/price-дельту (`groupOrigPoints` в `_dragState`, применяется в
  `_applyDrag` через editAxis каждого объекта отдельно — так
  сгруппированный horizontal_line остаётся горизонтальным, даже когда
  trend_line-сосед по группе двигается свободно); persistence отправляет
  `updated` как массив id (не один id) для группового drag, каждый член
  сохраняется отдельной строкой. `groupSelection()`/`ungroupSelection()`
  пишут/чистят `properties.groupId` (тот же непрозрачный JSON-блоб,
  которым уже пользуется каждый per-drawing style — новой backend-схемы
  не потребовалось); `duplicateSelection()` копирует всю выборку и
  выбирает копии — дублированная группа получает **новый** groupId
  (remap на лету), не мержится с оригиналом. Floating toolbar
  (`ChartTile._renderMultiFloatToolbar`) и панель «Свойства»
  (`_renderMultiProps`) получили отдельный компактный режим для N>1
  выбранных объектов — счётчик + Дублировать/Группировать
  (Ungroup, если выборка уже целая группа)/Удалить; per-object
  цвет/толщина/стиль не показываются — не обобщаются на разнородную
  выборку. Хоткеи: Ctrl/Cmd+G группирует (N>1), Ctrl/Cmd+Shift+G
  разгруппировывает, Ctrl/Cmd+D дублирует выборку, Delete/Backspace
  удаляет всю выборку (по одному `removeDrawing()` на id — N объектов
  дают N записей в undo-стеке, не общий rewrite контракта одиночного
  удаления).
  **Реальный баг найден и исправлен** (не в реализации мультивыборки
  саму по себе, а в уже существовавшем `_onPointerDown`): plain
  (non-Ctrl) mousedown на объекте, уже входящем в текущую мульти-
  выборку, безусловно вызывал `select(hit.id, {additive:false})` —
  заменял выборку одним этим объектом ДО того, как начинался drag, из-за
  чего `isGroupDrag`-проверка в `_onPointerMove` (`selectedIds.size > 1`)
  всегда видела уже схлопнутую до одного объекта выборку и никогда не
  запускала групповой drag. Поймано JS runtime suite'ом (написанным этой
  же сессией) на синтетическом сценарии до какой-либо живой проверки —
  второй выбранный объект оставался на месте после drag первого. Исправлено:
  `_onPointerDown` теперь пропускает `select()` (сохраняет текущую
  мульти-выборку как есть), когда клик non-additive и попадает в объект,
  уже входящий в выборку из >1 элемента — именно тот жест, которым
  начинается групповой drag.
  Отдельно найден и исправлен баг в самом тесте (не в продакшен-коде):
  тестовый файл выполняет `drawings.js` внутри `vm`-песочницы; массивы,
  построенные ВНУТРИ этой песочницы (например, `duplicateSelection()`
  возвращает копии, `[...groupOrigPoints.keys()]` в `_finishEditPointer`)
  относятся к другому JS-realm, чем массивы, построенные в самом
  тест-файле — `assert.deepStrictEqual` на них падает с «not
  reference-equal» даже при побайтово идентичном содержимом (прототип
  `Array.prototype` из другого realm). Исправлено оборачиванием через
  `Array.from()`, вызванный из внешнего realm-идентификатора — тот же
  трюк уже неявно работал у остальных ассертов файла, потому что их
  правая часть строилась через `[...selectedIds]` (spread выполняется в
  внешнем коде) или через литерал `[d1.id, d2.id]`, а не через `.map()`/
  `.slice()` на объекте, пришедшем из vm.
  **Верифицировано** вживую на проде (тот же QA-аккаунт, реальные mouse-
  события через Playwright, не programmatic `dm.select()`-вызовы): plain
  click выбрал один trend_line, Ctrl-click добавил второй (`selectedIds`
  подтверждён программно); plain mousedown+drag на первом объекте
  сохранил мульти-выборку и подтверждённо сдвинул ОБА объекта на
  идентичную time/price-дельту; floating toolbar показал пилюлю «2
  объектов» с Дублировать/Группировать/Удалить, панель «Свойства» —
  тот же счётчик и кнопки; Group через пилюлю назначил обоим общий
  `properties.groupId`. Скриншот подтвердил визуально (пилюля + панель
  синхронны). Тестовые drawings удалены, reload с прода подтвердил
  `drawings.length === 0`, консоль чистая на всех шагах. 198 pytest + оба
  JS runtime suite зелёные (расширены dedicated-блоком на select/additive/
  group-selection-unit/duplicateSelection/group-drag/multi-delete-
  duplicate-group-ungroup-via-keyboard).
- **Trend Angle, Regression Trend, Flat Top/Bottom, Disjoint Channel** —
  из MISSING в PARITY, следующий выбранный крупный MISSING-пункт после
  того, как Multiselect/Grouping закрыл предыдущий. Все 4 переиспользуют
  уже написанную инфраструктуру, ни одному не потребовалось совсем новой
  геометрии с нуля.
  `trend_angle` — буквально `trend_line`'s 2-анкорная placement/hit-test
  (добавлен в тот же `case` список), но `_buildOp` считает
  `trendAngleDegrees(pix0,pix1)` (screen-space `atan2`, знак инвертирован
  под конвенцию TradingView — растущая слева-направо линия даёт
  положительный угол) и пишет его в новый op kind `trend_angle`, который
  красит ту же линию, что `segment`, плюс подпись `±N.N°` у середины
  (`_text()`, тот же хелпер, что уже красит подписи hline/fib_channel).
  Угол считается заново на каждый рендер из ТЕКУЩЕЙ пиксельной проекции,
  не хранится — тот же эффект, из-за которого у настоящего TradingView
  угол «плывёт» при зуме, это не баг, а прямое следствие того, что это
  экранный, а не геометрический угол.
  `regression_trend` — 2 анкора задают только временной диапазон
  (`[min(t0,t1),max(t0,t1)]`, order-independent — тот же принцип, что
  `volumeProfileBuckets`), сама линия — обычная OLS-регрессия close по
  времени всех попавших в диапазон свечей плюс параллельные полосы на
  ±2σ остатков (TradingView-й дефолт для этого инструмента) —
  `regressionTrendChannel()`, вычисляется живьём из `core.candles` каждый
  вызов, ни разу не кешируется — тот же «живой пересчёт без отдельного
  update-провода», которым уже пользуется `anchored_vwap`/`cyclic_lines`/
  `volume_profile`. Новый op kind `regression_trend`: сплошная mid-линия,
  пунктирные upper/lower, опциональная заливка между ними (тот же
  0.14-альфа приём, что у `channel`/`rect`).
  `flat_top_bottom` — та же 3-анкорная staged placement, что
  `parallel_channel`, но вторая граница — не параллельный offset, а
  буквально константная цена anchor2 на времени anchor0/anchor1
  (`flatBoundaryPoints()`) — переиспользует `channel`-кайнд без изменений
  (он просто рисует line1 + опциональную line2 + заливку между ними, без
  предположения о параллельности).
  `disjoint_channel` — 4 независимых анкора (drag+2×tap, та же схема, что
  у `double_curve`), две генуинно несвязанные линии (anchor0-anchor1,
  anchor2-anchor3, вторая никак не выводится из первой) — тоже
  переиспользует `channel`-кайнд напрямую без единой строчки нового
  рендер-кода, только 4 хэндла вместо 3.
  **Верифицировано** вживую на проде (тот же QA-аккаунт, реальные
  свечи SOLUSDT — 200-барное окно для regression_trend, чтобы OLS считал
  по-настоящему): все 4 созданы программно, верные render op kinds
  подтверждены структурно (`flat_top_bottom`: `ox1===x1`/`ox2===x2` —
  флэт-граница на тех же x, что и наклонная кромка; `disjoint_channel`:
  `ox1/ox2` заметно вне диапазона `x1/x2` — независимый второй сегмент,
  не производный от первого); hit-test подтверждён отдельно для каждой
  линии/границы (обе несвязанные линии disjoint_channel, обе кромки
  flat_top_bottom, mid-линия regression_trend, тело trend_angle);
  regression_trend отдельно подтверждён скриншотом в изоляции — узнаваемая
  форма TradingView-регрессионного канала (сплошная mid + пунктирные
  ±2σ границы + лёгкая заливка); тестовые drawings удалены, reload с
  прода подтвердил `drawings.length === 0`, консоль чистая (единственная
  ошибка — сторонний `wss://mc.yandex.ru` handshake от Yandex Metrika, не
  относится к правке). 198 pytest + оба JS runtime suites зелёные
  (`allTools` +4 имени; `regression_trend` заведён в тот же
  `persistentTools`-эксклюжн, что `anchored_vwap`/`volume_profile`, со
  своим dedicated-тестом на synthetic 3-candle фикстуре — slope/intercept/
  stddev посчитаны вручную и сверены с точностью 1e-9, плюс under-2-
  candles edge case; отдельные geometry-тесты на `trend_angle`'s угол,
  `flat_top_bottom`'s флэт-границу, `disjoint_channel`'s независимость
  двух сегментов).

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
