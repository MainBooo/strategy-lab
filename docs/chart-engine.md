# Графическое ядро Strategy Lab

Единое графическое ядро на базе [lightweight-charts](https://github.com/tradingview/lightweight-charts)
(vendored `static/vendor/lightweight-charts.standalone.production.js`, v5.2.0, Apache-2.0),
используемое двумя модулями:

- **«График сделок»** — вкладка внутри модалки истории бэктеста (`static/trade-chart.js`).
- **«Анализ графиков»** — отдельная вкладка навигации (`static/chart-analysis.js`).

Оба модуля построены на общих файлах в `static/chart-engine/`:

| Файл | Назначение |
|---|---|
| `theme.js` | цвета, опции chart/candlestick, форматирование времени в UTC (см. «Тайм-зоны» ниже) |
| `core.js` | `ChartEngine.ChartCore` — обёртка над `createChart`: свечи, объём, resize, загрузка диапазона свечей, пагинация влево |
| `indicators.js` | `ChartEngine.Indicators` — реестр индикаторов + расчёт + управление сериями/панелями |
| `trades.js` | маркеры сделок, `TradeOverlayPrimitive` (коннектор + уровни), `TradeSelectionManager` |
| `drawings.js` | `DrawingManager` — инструменты рисования, hit-testing, undo/redo, canvas-примитив рендеринга |
| `persistence.js` | тонкий REST-клиент к `/api/chart-layouts`, `/api/chart-drawings`, `/api/chart-strategy-requests` + `debounce()` |

Backend: `charts_db.py` (SQLite, аналог `backtests_db.py`), `candle_api.py` (свечи для «Анализ графиков»,
с собственным кэшем в `data/chart_cache/`), маршруты `/api/chart-*` и `/api/candles` в `app.py`.

## Почему не пересчитываются сделки

`static/trade-chart.js` берёт сделки из `/api/backtests/<run_id>/trades` и свечи из
`/api/backtests/<run_id>/candles` — тот же локальный CSV-файл, который использовал движок бэктеста
(`load_candles(source, run.date_from, run.date_to)`), а не свежая загрузка с MOEX. Никакие
входы/выходы/стопы/тейки не пересчитываются на фронтенде — они только визуализируются.

## Тайм-зоны

В проекте нет ни одной timezone-aware даты: свечи и сделки хранятся как наивные строки
(биржевое время MSK). `candle_api.py` и `backtests_db`/`app.py` кодируют их в unix-секунды
через `pd.Timestamp(...).timestamp()`, что трактует наивное время **как UTC**. Поэтому
`theme.js` принудительно форматирует все подписи на графике через `toLocaleString(..., {timeZone:"UTC"})` —
иначе браузер зрителя в другом часовом поясе увидел бы смещённые часы. Если где-то в новом коде
понадобится время — используйте `ChartEngine.formatTime()` и `ChartEngine.parseNaiveDatetime()`,
не `new Date(...).toLocaleString()` напрямую.

## Как добавить новый инструмент рисования

1. `drawings.js` → `TOOL_DEFS`: добавьте `{ pointsNeeded, label }`.
2. `defaultProperties(type)`: стили/поля по умолчанию для нового типа.
3. `DrawingManager._hitDrawing()`: ветка hit-теста (попадание в линию/прямоугольник/точку).
4. `DrawingPaneView._buildOp()` и `_drawOp()`: как строить и рисовать geometry на canvas
   (все координаты считаются из `time/price` через `toPixels()` — **не** храните пиксели).
5. `chart-analysis.js` → `TOOL_BUTTONS`: кнопка на левой панели (иконка + подпись + `data-tool`).

Объект автоматически получит undo/redo, автосохранение, hidden/locked, дублирование —
это уже общая логика `DrawingManager`, специфичного кода не требуется.

## Как добавить новый индикатор

1. `indicators.js`: чистая функция расчёта (вход — массив свечей и параметры, выход — массив чисел/`null`).
   Если индикатор уже участвует в стратегиях бэктестера (сейчас это ATR и RSI, обе — простое
   скользящее среднее, **не** Wilder) — используйте ту же формулу, что в `strategies/common.py`
   / `strategies/simple_strategies.py`, а не «учебниковую», чтобы график не расходился с бэктестом.
2. `REGISTRY`: добавьте `{ id, label, defaultParams, kind }` (`kind`: `overlay` — на ценовой панели,
   `pane` — отдельная панель, `toggle` — просто вкл/выкл существующей серии, как `volume`).
3. `IndicatorPaneManager._createSeries()` и `_computeInto()`: какие серии создавать и как в них
   заливать точки.

Индикатор появится в выпадающем списке «Индикаторы» на странице «Анализ графиков» и в
переключателях RSI/ATR на графике сделок автоматически — UI читает `Indicators.registry`.

## Хранение разметки

`chart_layouts` / `chart_drawings` / `chart_strategy_requests` в `storage/charts.db`. Каждая
строка несёт `user_id`; сейчас во всём приложении используется одна константа
(`app.py: CURRENT_USER_ID = "local"`, других учётных записей нет), но `charts_db.py` и
`feature_flags.py` уже принимают `user_id`/делают явные проверки владения — при появлении
реальной авторизации логика владения меняться не должна, достаточно передавать настоящий id.

`feature_flags.has_feature(user_id, feature)` — единая точка входа для будущих ограничений
тарифа (`CHART_ANALYSIS_ACCESS`, `CHART_DRAWINGS_ADVANCED`, ...). Сейчас все флаги `True` —
намеренно, тарифов пока нет.

## Известные ограничения

- `/api/backtests/<run_id>/candles` отдаёт весь диапазон `run.date_from..date_to` целиком
  (если он не задан — весь локальный файл). Для тикеров с многолетней историей на 10-минутных
  свечах это может быть 20–30 тыс. баров за один ответ; график всё равно рисует только видимую
  область, но JSON получается тяжелее, чем нужно. `trade-chart.js` компенсирует это, сразу
  устанавливая видимый диапазон по фактическим сделкам, а не `fitContent()` (см. комментарий
  в `selectTicker()`) — но сама выгрузка не сужена. Следующий шаг —бэкенд мог бы сузить окно
  вокруг мин/макс времени сделок тикера, если диапазон запуска не задан явно.
- MAE/MFE и R-мультипликатор показываются только если реально сохранены (`signal_metadata_json`);
  для старых/забэкфилленных сделок их нет — карточка сделки честно показывает «—», а не 0.
- Причины выхода ограничены тем, что реально формирует движок: `take`/`stop`/`end_of_period`
  (TP/SL/END). Trailing-стоп и выход по времени в стратегиях не реализованы — соответствующие
  маркеры (`TRAIL`, `TIME`) не выводятся, чтобы не показывать несуществующую механику.
- Нет реальной аутентификации — «владение» разметкой формально проверяется, но на один и тот же
  `user_id="local"` для всех запросов, так как в приложении нет логина.
