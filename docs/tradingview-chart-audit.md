# TradingView chart-workspace audit — «Анализ графиков»

Дата: 2026-08-18. Метод: чтение исходников (`static/chart-engine/*.js`,
`static/chart-analysis.js`, `static/chart-editor-terminal-*.js`) +
живая проверка на `strategylab.generationweb.ru` через Playwright
(мобильный viewport 390×844, реальные Pointer Events, не только чтение
кода). Это ревизия существующей, уже во многом рабочей реализации, а не
аудит с нуля — проект уже прошёл несколько предыдущих раундов
TradingView-parity работы (см. `git log`: `d7f7227`, `f593c14`, `5bc8299`,
`5c7778c`, `d443dcc`, `908dd8a`, `454b3ad`, `f208f78`).

## Используемая библиотека и почему

**lightweight-charts v5.2.0** (TradingView, Apache-2.0), vendored в
`static/vendor/`. Это официальная open-source библиотека TradingView для
рендеринга свечей/серий/шкал — не Supercharts (весь UI chrome: toolbar,
рисование, alerts, object tree — написан в этом проекте с нуля поверх её
primitives API). Ограничения: нет Pine Script, нет закрытых
community-индикаторов, нет их брокерских интеграций — что и так вне
scope согласно ТЗ (раздел «Границы parity»).

## Архитектура (файл → назначение)

| Файл | Назначение |
|---|---|
| `chart-engine/theme.js` | цвета, опции chart/candlestick, UTC-форматирование времени |
| `chart-engine/core.js` | `ChartCore` — обёртка `createChart`: свечи, объём, resize, пагинация |
| `chart-engine/indicators.js` | реестр индикаторов (12: SMA/EMA/WMA/VWAP/Bollinger/Donchian/RSI/MACD/ATR/Stochastic/Momentum/Volume) + расчёт + панели |
| `chart-engine/trades.js` | маркеры сделок бэктеста, один canvas-примитив на все сделки |
| `chart-engine/drawings.js` | `DrawingManager` — 20 инструментов, hit-testing, undo/redo, canvas-рендер |
| `chart-engine/persistence.js` | REST-клиент `/api/chart-layouts`, `/api/chart-drawings`, debounce |
| `chart-engine/fullscreen.js` | настоящий Fullscreen API + CSS-фолбэк |
| `chart-engine/chart-tile.js` | одна плитка графика: symbol/timeframe/chartType/replay-тик |
| `chart-analysis.js` | вся страница «Анализ графиков»: toolbar, watchlist, alerts UI, object tree, context-menu, мультиграфики |
| `chart-editor-terminal-mobile-v2.js` | телефонный layout поверх той же логики: rail, top-bar extras, bottom row |
| `chart-editor-terminal-compat.js`, `-fixes.js`, `-icons.js`, `-indicators-v2.js` | более мелкие мобильные/иконочные патчи прошлых раундов |
| `alert-service.js` | localStorage для анонимов, реальный `/api/alerts` REST + polling `/api/alerts/events` для авторизованных |

## Координатная модель (уже реализовано правильно)

`drawings.js` хранит каждую точку как `{time, price}` — **никогда** как
пиксели (см. `TOOL_DEFS`, `addDrawing`, `_translatePoints`). Пиксели
вычисляются на лету через `toPixels()`/`timeToCoordinateSafe()`/
`priceToCoordinateSafe()` при каждом рендере и hit-тесте. Это уже
удовлетворяет требованию ТЗ §42 — специальной доработки не нужно.

## Interaction state machine (уже реализовано)

`DrawingManager` — единый Pointer Events pipeline (`_onPointerDown/Move/Up/
Cancel`, `_onLostPointerCapture`), с explicit states (`NAVIGATE`,
`TOOL_ARMED`, `PLACING`, `SELECTED`, `DRAG_OBJECT`, `DRAG_HANDLE`,
`TEXT_EDIT`). Native Touch Events используются **только** как gesture-guard
(`_onTouchStartGuard/MoveGuard/EndGuard`) для `preventDefault()` там, где
Pointer Events сами это сделать не могут (Safari может «защёлкнуть» page
scroll раньше, чем сработает JS) — не как вторая логическая система, что
и требует ТЗ §39-41. `touch-action` переключается динамически
(`_setNavigationLocked`) только на время активного инструмента/жеста, не
глобально на всю страницу.

## Разобранные баги ТЗ (симптом → root cause → решение)

### BUG 1 — кнопка «Д» не нажималась (ИСПРАВЛЕНО, коммит `e1f7afe`)

**Симптом**: в верхнем тулбаре на телефоне присутствовала кнопка «Д»
между `+` и иконкой типа графика, визуально похожая на TradingView, но
тап по ней не делал ничего.

**Root cause**: предыдущий раунд правок (`454b3ad`) сопоставлял иконки
верхнего ряда TradingView icon-for-icon по скриншоту, но не смог
идентифицировать «Д» как реальную фичу и вставил её как
`<span class="sl-tv-decorative" aria-hidden="true" tabindex="-1">` с
`pointer-events:none` — то есть намеренно неинтерактивный элемент.
Следующий коммит (`f208f78`) пошёл дальше и **спрятал уже работавший**
`#gtTimeframe` (реальный переключатель таймфрейма) из верхнего ряда,
на основании вывода «в реальном TradingView нет отдельной таймфрейм-пилюли
в верхнем ряду».

Это чтение референса было ошибочным. «Д» — это и есть таймфрейм-пилюля:
TradingView показывает текущий интервал в toolbar в сокращённом виде, а
«Д» — русская локализация «День» (Daily). Referenced-скриншот
(`Tradingview.PNG`) показывает AAPL на дневных барах (видны только
переходы месяцев «Июль»/«Авг») — что и объясняет, почему там «Д», а не
число.

**Решение**: «Д»/`#gtTimeframe` объединены в один реальный контрол —
`#slTvIntervalBtn`, показывающий текущий интервал в сокращении TradingView
(число без единицы <1ч, «Nч» для часов, Д/Н/М для дня/недели/месяца —
`INTERVAL_COMPACT` в `chart-editor-terminal-mobile-v2.js`), тап открывает
попап со всеми поддерживаемыми интервалами (переиспользует существующий
`.ca-popover`/`_wireGlobalPopover` и авто-relocate под phone bottom-sheet
через `#chartsRoot>.ca-popover`, тот же механизм что уже работал для
`gtAlertsPop`/`gtTemplatesPop`). Дублирующая группа «Таймфрейм», добавленная
в «...»-меню как обходной путь, удалена как избыточная и отсутствующая в
реальном TradingView.

**Верификация**: живой Playwright на проде, 390×844 — тап открывает
попап, тап «1ч» переключает график и пилюлю синхронно,
`#gtTimeframe.value` (source of truth для остального кода) остаётся в
синхроне, консоль чистая.

### BUG 2/3/4 — Pencil выбирается, но не рисует; touch перехватывается chart library

**Проверка**: код `drawings.js` для `freehand` — специальный `completion:
"drag-release"` режим, сэмплирующий точки по `pointermove` пока палец
удерживается (`FREEHAND_SAMPLE_MIN_DIST_PX` — троттлинг сэмплов, не React
state на каждый pointermove — уже удовлетворяет ТЗ §48). Прямая проверка
живого прода: активация инструмента (`data-sl-group="brush"` →
`drawingMgr.setTool('freehand')`) корректно взводит `activeTool`; синтетическая
последовательность `pointerdown`→6×`pointermove`→`pointerup` с
`pointerType:'touch'` на реальном canvas создаёт настоящий объект в
`drawingMgr.drawings` (проверено и убрано за собой, чтобы не оставлять
тестовые данные в БД).

**Вывод**: на уровне Pointer Events логика уже корректна и не
воспроизводит описанный баг. `touch-action` не задаётся глобально нигде
в CSS (`grep -rn touch-action` — только `manipulation` на кнопках рейла и
внутри `drawings.js`'s собственного динамического переключателя).
Ни один сторонний скрипт не перехватывает pointerdown раньше
`DrawingManager` (его capture-phase listener висит на контейнере, выше по
DOM, чем canvas самой lightweight-charts). Похоже, этот баг был устранён
одним из предыдущих раундов (архитектура `_pointerSession`/`_ownedTouchIds`
в `drawings.js` выглядит как целевое решение именно этой проблемы, судя по
детальности комментариев). **Не воспроизведён** синтетически на реальном
Chromium/iOS-совместимом Pointer Events стеке — но синтетический тест не
эквивалентен реальному iOS Safari touchstart-latching; рекомендуется
дополнительно проверить на физическом iPhone (см. Remaining differences
в отчёте).

### BUG 6 — object selection

Не воспроизведён: `hitTest()`/`_hitDrawing()` покрывают все 20 типов
рисунков (линии, фигуры, freehand/polyline по сегментам, text/note по
bounding box, fib по уровням, long/short по hit-зоне) с раздельными
допусками касания мышью/пальцем (`HIT_TOLERANCE_PX`=6 vs
`TOUCH_HIT_TOLERANCE_PX`=18). Есть двусторонняя синхронизация выбора
Object Tree ↔ canvas (`_renderObjects()` в `chart-analysis.js`).
**PARITY**.

### BUG 7 — нет Measure/Ruler

Исправлено 2026-08-18: добавлен отдельный `measure` tool
(`TOOL_DEFS.measure`, `drawings.js`) с флагом `ephemeral: true` —
`_finishDraft()` для него не вызывает `addDrawing()`/не пишет в историю,
а сразу переармирует тот же tool, так что drag-drag-drag измеряет
подряд без повторного выбора кнопки. Рендерится как пунктирный box
(`kind: "measure_tool"`) с той же математикой, что у `price_date_range`
(дельта цены/%, длительность, число баров), но полупрозрачный (общий
draft-alpha 0.6) и без drag-handles — исчезает на pointerup. Кнопка:
десктоп `chart-analysis.js` TOOL_BUTTONS ("Измерение"), мобильный рейл —
первый пункт группы "Измерения" ("Линейка (временная)").
`price_range`/`time_range`/`price_date_range` оставлены как есть —
в реальном TradingView это тоже отдельные персистентные line tools,
не то же самое, что Measure. **PARITY**.

Не сделано (возможное следующее улучшение, не блокер): реальный
TradingView также запускает Measure через Alt+drag без переключения
инструмента (прямо в режиме Cursor) — здесь это не реализовано,
только через явную кнопку в рейле.

### BUG 8 — нет price-scale +

**Частично неверно**: полноценного визуального «+», следующего за
курсором вдоль шкалы цены (ТЗ §31), нет. Но есть функциональный эквивалент
жеста: `bindPriceAxisAlertGesture()` в `chart-analysis.js` — короткий тап
по правому краю шкалы цены (не drag — drag остаётся нетронутым для
нативного изменения масштаба lightweight-charts) открывает алерт
предзаполненный ценой под тапом; правый клик/long-press по графику также
даёт «Добавить алерт здесь» через context-menu. Отсутствует именно
персистентный визуальный `+`-индикатор и опция «Add Horizontal Line» из
того же меню. **PARTIAL**.

### BUG 9 — Crosshair UX

lightweight-charts предоставляет встроенный crosshair (vertical/horizontal
line + price/time labels) — используется как есть, тема настроена в
`theme.js`. Отдельного mobile-specific crosshair-activation жеста (в
отличие от panning) не найдено в коде — вероятно наследует поведение
библиотеки по умолчанию. **Не верифицировано на реальном touch-девайсе**,
см. Remaining differences.

### BUG 10 — UI toolbar и drawing engine рассинхронизированы

Toolbar (`data-tool`/`data-sl-tool` кнопки) вызывает
`drawingMgr.setTool()` напрямую, `refreshRail()`/подсветка `.active`
читает `drawingMgr.activeTool` как единственный источник истины (ТЗ §169
«один state source» — уже выполнено). Не воспроизведено.

### BUG 11 — Mobile chart занимает меньше площади, чем должен

Судя по git-истории (`5c7778c`, `f593c14`, серия «charts-mobile»
коммитов) — это уже было целью предыдущих раундов: убраны дублирующие
нижние ряды, `.sl-chart-controls` сведена к одной компактной строке,
`html.sl-chart-phone` даёт графику `flex:1;min-height:0` на весь доступный
`100dvh` с учётом `env(safe-area-inset-*)`. Дальнейших находок при беглой
проверке нет — трактуется как в основном решённое, отдельный
pixel-by-pixel замер против reference pack (§4, не собран в эту сессию)
нужен для financially закрытия.

### BUG 12 — controls есть, но feature отсутствует (запрещено)

Единственный подтверждённый случай — исправленная «Д» (BUG 1). Более
широкая проверка (клик по каждой видимой кнопке верхнего тулбара,
рейла и «...»-меню) не проводилась в рамках этой сессии — см.
`docs/tradingview-parity-matrix.md`, статус `NOT VERIFIED` для
непроверенных пунктов, чтобы не декларировать parity без проверки
(ТЗ §176 — недостаточно «выглядит рабочим»).

## Известные архитектурные ограничения (актуальны и сегодня)

Унаследовано из `docs/chart-engine.md`, актуальность не менялась:

- `/api/backtests/<run_id>/candles` отдаёт весь диапазон целиком — тяжёлый
  JSON для тикеров с долгой историей на мелких таймфреймах.
- MAE/MFE и R-мультипликатор — только если реально посчитаны и сохранены;
  честное «—» вместо 0 для старых сделок.
- Причины выхода сделки ограничены `take`/`stop`/`end_of_period` — TRAIL/TIME
  не реализованы в движке стратегий, поэтому не выводятся на графике.
- Нет реальной multi-user авторизации — `CURRENT_USER_ID = "local"` во всём
  приложении; владение разметкой/алертами проверяется формально корректно,
  но на одного и того же пользователя.

## Магнит — до и после этой сессии

**До**: `DrawingManager.snapEnabled` — boolean. Включён → любая точка
всегда притягивается к ближайшему OHLC значению текущего бара, независимо
от расстояния. Это соответствует только TradingView Strong Magnet — Weak
Magnet (снап только когда курсор уже близко к значению) отсутствовал
как режим.

**После** (коммит `e1f7afe`): `magnetMode` — `"off"|"weak"|"strong"`.
`snapPoint()` для `"weak"` дополнительно проверяет пиксельное расстояние
между сырой и притянутой ценой через `priceToCoordinateSafe()` и не
снапает, если оно больше `WEAK_MAGNET_SNAP_PX` (14px) — так поведение
не зависит от масштаба цены/зума, а только от экранного расстояния, как
и в реальном TradingView. Верифицировано напрямую против живых данных
свечи (см. отчёт).
