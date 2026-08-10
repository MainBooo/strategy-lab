from __future__ import annotations

import math

"""UI-facing schema for strategy parameters, one entry per param actually
read by the matching run_* function in simple_strategies.py / false_breakout.py
/ head_shoulders.py. Kept separate from STRATEGY_CATALOG (cosmetic metadata)
so the two can evolve independently.

UNIVERSAL_PARAMS are appended to every strategy's schema by merge_schema()
below - they map 1:1 to strategies.common.universal_execution_params(), which
every run_* function now reads.

Every field carries a "section" tag used purely for UI grouping in the
Strategy Library / Backtest-tab param forms - one of:
  basic   - Основные параметры
  entry   - Условия входа (including strategy-specific sub-conditions like
            retest/pullback logic - those don't get their own top-level UI
            section, they live inside "Условия входа")
  filters - Фильтры
  exit    - Условия выхода
  risk    - Управление риском
SECTION_LABELS is the single source of truth for the Russian section titles;
static/app.js mirrors these keys (not the labels) when grouping fields.
"""

SECTION_LABELS = {
    "basic": "Основные параметры",
    "entry": "Условия входа",
    "filters": "Фильтры",
    "exit": "Условия выхода",
    "risk": "Управление риском",
}
SECTION_ORDER = ["basic", "entry", "filters", "exit", "risk"]

TIMEFRAME_OPTIONS = [
    {"value": "10m", "label": "10 минут"},
    {"value": "30m", "label": "30 минут"},
    {"value": "60m", "label": "1 час"},
    {"value": "4h", "label": "4 часа"},
    {"value": "1d", "label": "1 день"},
]
TIMEFRAME_TOOLTIP = ("Укрупняет исходные свечи до этого таймфрейма перед расчётом сигналов "
                      "(честная агрегация OHLCV). Если выбранный ТФ меньше или равен таймфрейму "
                      "загруженных данных, используются исходные свечи без изменений.")

UNIVERSAL_PARAMS = [
    {"key": "direction", "label": "Направление сделок", "type": "select", "default": "both", "section": "basic",
     "options": [{"value": "both", "label": "Long и Short"}, {"value": "long", "label": "Только Long"}, {"value": "short", "label": "Только Short"}],
     "tooltip": "Ограничить стратегию одной стороной рынка. По умолчанию открываются сделки в обе стороны."},
    {"key": "volume_filter", "label": "Фильтр объёма", "type": "checkbox", "default": False, "section": "filters",
     "tooltip": "Пропускать сигналы, в момент которых объём торгов был ниже среднего. Отсекает слабые, неликвидные движения."},
    {"key": "volume_multiplier", "label": "Множитель среднего объёма", "type": "slider", "default": 1.5, "section": "filters",
     "min": 1.0, "max": 3.0, "step": 0.1, "unit": "× средний объём",
     "tooltip": "Насколько объём в момент сигнала должен превышать скользящее среднее за 20 свечей. Работает только при включённом фильтре объёма."},
    {"key": "trailing_stop_atr", "label": "Трейлинг-стоп", "type": "slider", "default": 0, "section": "exit",
     "min": 0, "max": 3, "step": 0.1, "unit": "× ATR (0 = выкл.)",
     "tooltip": "Стоп-лосс подтягивается вслед за ценой на расстоянии N ATR от максимума прибыли по сделке. 0 отключает трейлинг — стоп остаётся на исходном уровне."},
    {"key": "breakeven_at_r", "label": "Перевод в безубыток", "type": "slider", "default": 0, "section": "exit",
     "min": 0, "max": 3, "step": 0.1, "unit": "× R (0 = выкл.)",
     "tooltip": "Как только сделка прошла в прибыль на N размеров начального риска (R), стоп переносится на цену входа. 0 отключает перевод в безубыток."},
    {"key": "max_holding_bars", "label": "Макс. время в позиции", "type": "number", "default": 0, "section": "exit",
     "min": 0, "max": 300, "step": 5, "unit": "свечей (0 = без ограничения)",
     "tooltip": "Принудительно закрыть сделку по цене закрытия, если за N свечей не сработали ни стоп, ни тейк."},
    {"key": "risk_per_trade_pct", "label": "Риск на сделку", "type": "slider", "default": 0, "section": "risk",
     "min": 0, "max": 0.05, "step": 0.0025, "unit": "% капитала (0 = фикс. лот)",
     "tooltip": "Доля текущего капитала, которой рискует одна сделка. Размер позиции пересчитывается по расстоянию до стопа. 0 отключает риск-менеджмент — используется фиксированное число лотов из портфеля."},
    {"key": "max_concurrent_trades", "label": "Макс. число одновременных сделок", "type": "number", "default": 1, "section": "risk",
     "min": 1, "max": 5, "step": 1, "unit": "сделок",
     "tooltip": "Сколько сделок по этой стратегии на этом инструменте может быть открыто одновременно. 1 — как раньше, только последовательные сделки."},
    {"key": "reentry_cooldown_bars", "label": "Запрет повторного входа", "type": "number", "default": 0, "section": "risk",
     "min": 0, "max": 50, "step": 1, "unit": "свечей после выхода",
     "tooltip": "После закрытия сделки не открывать новую в течение N свечей. Помогает избежать серии сделок подряд на одном и том же шуме."},
]

PARAM_SCHEMA: dict[str, list[dict]] = {
    "false_breakout": [
        {"key": "lookback", "label": "Период уровня", "type": "number", "default": 80, "min": 20, "max": 200, "step": 5, "unit": "свечей", "section": "basic",
         "tooltip": "Количество предыдущих свечей, по которым строится уровень. Малое значение даёт больше, но слабее уровней; большое — реже, но значимее."},
        {"key": "atr_period", "label": "Период ATR", "type": "number", "default": 14, "min": 5, "max": 50, "step": 1, "unit": "свечей", "section": "basic",
         "tooltip": "Период Average True Range. ATR измеряет текущую волатильность и используется для нормализации глубины пробоя и стопа."},
        {"key": "min_touches", "label": "Минимум касаний", "type": "number", "default": 3, "min": 1, "max": 6, "step": 1, "unit": "касаний", "section": "basic",
         "tooltip": "Минимальное число разнесённых касаний, необходимое для признания цены уровнем поддержки или сопротивления."},
        {"key": "min_touch_separation", "label": "Расстояние между касаниями", "type": "number", "default": 10, "min": 2, "max": 30, "step": 1, "unit": "свечей", "section": "basic",
         "tooltip": "Минимальное расстояние между касаниями в свечах. Не позволяет считать соседние свечи отдельными подтверждениями уровня."},
        {"key": "max_level_age", "label": "Возраст уровня", "type": "number", "default": 150, "min": 50, "max": 400, "step": 10, "unit": "свечей", "section": "basic",
         "tooltip": "Максимальный возраст уровня в свечах. Старые уровни могут терять актуальность."},
        {"key": "touch_tolerance_atr", "label": "Допуск касания", "type": "slider", "default": 0.15, "min": 0.05, "max": 0.5, "step": 0.01, "unit": "× ATR", "section": "entry",
         "tooltip": "Максимальное расстояние от уровня, при котором свеча считается касанием. Измеряется в долях ATR."},
        {"key": "min_depth_atr", "label": "Мин. глубина пробоя", "type": "slider", "default": 0.25, "min": 0.05, "max": 1.0, "step": 0.01, "unit": "× ATR", "section": "entry",
         "tooltip": "Минимальная глубина выхода цены за уровень. Слишком маленький прокол может быть обычным шумом."},
        {"key": "max_depth_atr", "label": "Макс. глубина пробоя", "type": "slider", "default": 0.70, "min": 0.1, "max": 2.0, "step": 0.01, "unit": "× ATR", "section": "entry",
         "tooltip": "Максимальная глубина ложного пробоя. Более глубокое движение чаще оказывается настоящим пробоем."},
        {"key": "return_window", "label": "Окно возврата", "type": "number", "default": 2, "min": 1, "max": 10, "step": 1, "unit": "свечей", "section": "entry",
         "tooltip": "Максимальное число свечей, за которое цена должна закрыться обратно за уровень."},
        {"key": "confirmation", "label": "Подтверждение свечой", "type": "checkbox", "default": True, "section": "entry",
         "tooltip": "Требовать дополнительную свечу в сторону возврата перед входом. Снижает число сигналов, но фильтрует слабые возвраты."},
        {"key": "first_break_only", "label": "Только первый пробой", "type": "checkbox", "default": True, "section": "entry",
         "tooltip": "После первой сделки по уровню больше его не использовать. Повторные тесты обычно ослабляют уровень."},
        {"key": "atr_filter", "label": "Фильтр волатильности", "type": "checkbox", "default": False, "section": "filters",
         "tooltip": "Торговать только когда текущий ATR выше своего среднего значения, то есть в более активном рынке."},
        {"key": "stop_buffer_atr", "label": "Запас стопа", "type": "slider", "default": 0.05, "min": 0, "max": 0.3, "step": 0.01, "unit": "× ATR", "section": "exit",
         "tooltip": "Дополнительный запас за экстремумом ложного пробоя, чтобы стоп не стоял точно на минимуме или максимуме."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 2.0, "min": 0.5, "max": 5, "step": 0.1, "unit": "R", "section": "exit",
         "tooltip": "Отношение потенциальной прибыли к риску. Значение 2 означает тейк-профит на расстоянии двух размеров стопа."},
        {"key": "min_risk_pct", "label": "Мин. риск на сделку", "type": "slider", "default": 0.0025, "min": 0.001, "max": 0.02, "step": 0.0005, "unit": "% от цены", "section": "risk",
         "tooltip": "Минимально допустимая ширина стопа относительно цены. Отсекает слишком тесные стопы, чувствительные к шуму."},
        {"key": "max_risk_pct", "label": "Макс. риск на сделку", "type": "slider", "default": 0.015, "min": 0.005, "max": 0.05, "step": 0.001, "unit": "% от цены", "section": "risk",
         "tooltip": "Максимально допустимая ширина стопа. Отсекает сделки с чрезмерным риском."},
    ],
    "head_shoulders": [
        {"key": "pivot_span", "label": "Радиус экстремума", "type": "number", "default": 3, "min": 2, "max": 10, "step": 1, "unit": "свечей", "section": "basic",
         "tooltip": "Сколько свечей слева и справа должны быть ниже/выше пика или впадины, чтобы точка считалась разворотным экстремумом."},
        {"key": "shoulder_tolerance", "label": "Допуск симметрии плеч", "type": "slider", "default": 0.03, "min": 0.01, "max": 0.1, "step": 0.005, "unit": "%", "section": "basic",
         "tooltip": "Насколько сильно может отличаться цена двух плеч фигуры, чтобы она всё ещё считалась «Головой и плечами»."},
        {"key": "head_min_distance", "label": "Выступ головы", "type": "slider", "default": 0.01, "min": 0.005, "max": 0.05, "step": 0.005, "unit": "%", "section": "basic",
         "tooltip": "Минимальное превышение головы над плечами. Слишком маленький выступ — ненадёжная фигура."},
        {"key": "max_breakout_bars", "label": "Окно пробоя шеи", "type": "number", "default": 30, "min": 10, "max": 80, "step": 5, "unit": "свечей", "section": "entry",
         "tooltip": "Сколько свечей ждать пробоя линии шеи после формирования правого плеча, прежде чем фигура считается несостоявшейся."},
        {"key": "stop_pct", "label": "Стоп-лосс", "type": "slider", "default": 0.02, "min": 0.005, "max": 0.05, "step": 0.005, "unit": "% от цены входа", "section": "exit",
         "tooltip": "Фиксированный стоп-лосс в процентах от цены входа."},
        {"key": "take_pct", "label": "Тейк-профит", "type": "slider", "default": 0.05, "min": 0.01, "max": 0.15, "step": 0.005, "unit": "% от цены входа", "section": "exit",
         "tooltip": "Фиксированный тейк-профит в процентах от цены входа."},
    ],
    "breakout_retest": [
        # Основные
        {"key": "timeframe", "label": "Таймфрейм", "type": "select", "default": "10m", "options": TIMEFRAME_OPTIONS, "section": "basic",
         "tooltip": TIMEFRAME_TOOLTIP},
        {"key": "lookback", "label": "Период поиска уровня", "type": "number", "default": 50, "min": 10, "max": 150, "step": 5, "unit": "свечей", "section": "basic",
         "tooltip": "Количество предыдущих свечей, по которым строится диапазон (уровень пробоя)."},
        {"key": "min_touches", "label": "Мин. число касаний уровня", "type": "number", "default": 2, "min": 1, "max": 6, "step": 1, "unit": "касаний", "section": "basic",
         "tooltip": "Минимальное число разнесённых касаний границы диапазона перед тем, как её пробой считается значимым."},
        {"key": "min_break_atr", "label": "Мин. размер пробоя", "type": "slider", "default": 0.15, "min": 0.05, "max": 1.0, "step": 0.01, "unit": "× ATR", "section": "basic",
         "tooltip": "Минимальное расстояние закрытия свечи за уровнем. Отсекает пробои-шум, которые тут же гаснут."},
        {"key": "max_break_atr", "label": "Макс. размер пробоя", "type": "slider", "default": 1.5, "min": 0.3, "max": 4.0, "step": 0.05, "unit": "× ATR", "section": "basic",
         "tooltip": "Максимальное расстояние закрытия свечи за уровнем. Слишком сильный импульсный пробой обычно уже не ретестит уровень."},
        {"key": "confirm_bars", "label": "Свечи подтверждения пробоя", "type": "number", "default": 1, "min": 0, "max": 5, "step": 1, "unit": "свечей", "section": "basic",
         "tooltip": "Сколько подряд свечей должны закрыться за уровнем, прежде чем пробой считается подтверждённым. 0 — подтверждение не требуется."},
        # Ретест (внутри «Условия входа»)
        {"key": "retest_bars", "label": "Макс. ожидание ретеста", "type": "number", "default": 5, "min": 1, "max": 15, "step": 1, "unit": "свечей", "section": "entry",
         "tooltip": "Сколько свечей ждать возврата цены к пробитому уровню для входа на ретесте."},
        {"key": "retest_tolerance_atr", "label": "Допуск отклонения от уровня", "type": "slider", "default": 0.1, "min": 0.02, "max": 0.5, "step": 0.01, "unit": "× ATR", "section": "entry",
         "tooltip": "Насколько близко цена должна подойти к уровню, чтобы это считалось ретестом."},
        {"key": "allow_false_wick", "label": "Разрешён ложный прокол", "type": "checkbox", "default": True, "section": "entry",
         "tooltip": "Разрешить тени свечи на ретесте кратковременно проколоть уровень, если закрытие всё равно осталось по нужную сторону. Если выключено — любой прокол уровня тенью отменяет сигнал."},
        {"key": "require_confirm_close", "label": "Подтверждающее закрытие свечи", "type": "checkbox", "default": False, "section": "entry",
         "tooltip": "После касания уровня на ретесте требовать ещё одну свечу с закрытием в сторону продолжения движения, прежде чем входить."},
        {"key": "entry_mode", "label": "Тип входа", "type": "select", "default": "market", "section": "entry",
         "options": [{"value": "market", "label": "По рынку"}, {"value": "limit", "label": "Лимитной заявкой"}],
         "tooltip": "«По рынку» — вход по цене открытия следующей свечи после подтверждения ретеста. «Лимитной заявкой» — заявка выставляется у уровня со смещением и исполняется, как только цена её коснётся."},
        {"key": "entry_offset_atr", "label": "Смещение входа", "type": "slider", "default": 0.1, "min": 0, "max": 1.0, "step": 0.01, "unit": "× ATR", "section": "entry",
         "tooltip": "Насколько лимитная заявка смещена от уровня в выгодную сторону. Используется только при типе входа «Лимитной заявкой»."},
        {"key": "max_entry_distance_atr", "label": "Макс. дистанция входа от уровня", "type": "slider", "default": 1.0, "min": 0.2, "max": 3.0, "step": 0.1, "unit": "× ATR", "section": "entry",
         "tooltip": "Если к моменту исполнения цена уже ушла от уровня дальше этого расстояния, сделка отменяется — не догонять цену."},
        # Фильтры
        {"key": "atr_filter", "label": "Фильтр волатильности", "type": "checkbox", "default": False, "section": "filters",
         "tooltip": "Торговать только когда текущий ATR выше своего среднего значения за 50 свечей, то есть в более активном рынке."},
        {"key": "htf_trend_filter", "label": "Фильтр тренда старшего ТФ", "type": "checkbox", "default": False, "section": "filters",
         "tooltip": "Требовать совпадения направления сделки с трендом на укрупнённом (в 6 раз) таймфрейме — EMA50 выше/ниже цены на старшем ТФ."},
        {"key": "ema_filter", "label": "EMA filter", "type": "checkbox", "default": False, "section": "filters",
         "tooltip": "Требовать, чтобы цена входа была по нужную сторону от EMA (см. период ниже)."},
        {"key": "ema_filter_period", "label": "Период EMA фильтра", "type": "number", "default": 50, "min": 10, "max": 200, "step": 5, "unit": "свечей", "section": "filters",
         "tooltip": "Период скользящей средней для EMA filter. Работает только при включённом EMA filter."},
        # Выход
        {"key": "stop_atr", "label": "Stop Loss", "type": "slider", "default": 0.3, "min": 0.1, "max": 1.5, "step": 0.05, "unit": "× ATR", "section": "exit",
         "tooltip": "Размер защитного стопа за уровнем в единицах ATR."},
        {"key": "rr", "label": "Take Profit (R/R)", "type": "slider", "default": 2, "min": 0.5, "max": 5, "step": 0.1, "unit": "R", "section": "exit",
         "tooltip": "Отношение потенциальной прибыли к риску."},
    ],
    "ema_pullback": [
        # Основные
        {"key": "timeframe", "label": "Таймфрейм", "type": "select", "default": "10m", "options": TIMEFRAME_OPTIONS, "section": "basic",
         "tooltip": TIMEFRAME_TOOLTIP},
        {"key": "fast", "label": "Fast EMA", "type": "number", "default": 20, "min": 5, "max": 50, "step": 1, "unit": "свечей", "section": "basic",
         "tooltip": "Период быстрой экспоненциальной средней."},
        {"key": "slow", "label": "Slow EMA", "type": "number", "default": 50, "min": 20, "max": 200, "step": 5, "unit": "свечей", "section": "basic",
         "tooltip": "Период медленной экспоненциальной средней, задающей направление тренда."},
        {"key": "min_trend_strength_atr", "label": "Мин. сила тренда", "type": "slider", "default": 0.3, "min": 0, "max": 2.0, "step": 0.05, "unit": "× ATR", "section": "basic",
         "tooltip": "Минимальное расстояние между Fast и Slow EMA в момент сигнала. Отсекает вход во время плоского, неопределённого рынка."},
        {"key": "min_ema_distance_atr", "label": "Мин. расстояние между EMA", "type": "slider", "default": 0.15, "min": 0, "max": 1.5, "step": 0.05, "unit": "× ATR", "section": "basic",
         "tooltip": "Минимальное расстояние между Fast и Slow EMA непосредственно перед началом отката. Подтверждает, что откату предшествовало настоящее трендовое движение."},
        # Откат (внутри «Условия входа»)
        {"key": "pullback_min_depth_atr", "label": "Мин. глубина отката", "type": "slider", "default": 0.1, "min": 0, "max": 1.5, "step": 0.05, "unit": "× ATR", "section": "entry",
         "tooltip": "Минимальная глубина отката от локального экстремума до цены входа. Слишком мелкий откат — не полноценная коррекция."},
        {"key": "pullback_max_depth_atr", "label": "Макс. глубина отката", "type": "slider", "default": 1.2, "min": 0.2, "max": 3.0, "step": 0.05, "unit": "× ATR", "section": "entry",
         "tooltip": "Максимальная глубина отката. Слишком глубокий откат обычно означает разворот тренда, а не паузу в нём."},
        {"key": "pullback_bars", "label": "Число свечей отката", "type": "number", "default": 5, "min": 1, "max": 20, "step": 1, "unit": "свечей", "section": "entry",
         "tooltip": "Максимальное число свечей, за которое откат должен дойти до EMA и развернуться обратно по тренду."},
        {"key": "touch_mode", "label": "Касание EMA", "type": "select", "default": "must_touch", "section": "entry",
         "options": [{"value": "must_touch", "label": "Обязательное касание"}, {"value": "approach_ok", "label": "Допустимо приближение"}],
         "tooltip": "«Обязательное касание» — цена должна коснуться Fast EMA (в пределах допуска ниже). «Допустимо приближение» — достаточно подойти на расстояние допуска, не касаясь."},
        {"key": "ema_touch_tolerance_atr", "label": "Допуск отклонения от EMA", "type": "slider", "default": 0.15, "min": 0.02, "max": 0.6, "step": 0.01, "unit": "× ATR", "section": "entry",
         "tooltip": "Насколько близко к Fast EMA должна подойти цена, чтобы это засчиталось как касание/приближение."},
        # Подтверждение входа
        {"key": "impulse_candle_entry", "label": "Вход по импульсной свече", "type": "checkbox", "default": False, "section": "entry",
         "tooltip": "Требовать, чтобы сигнальная свеча имела тело не меньше «Мин. размера сигнальной свечи» — то есть была явным импульсом в сторону тренда, а не вялым баром."},
        {"key": "breakout_confirm", "label": "Подтверждение пробоем сигнальной свечи", "type": "checkbox", "default": True, "section": "entry",
         "tooltip": "Входить только когда следующая свеча пробивает максимум (long) или минимум (short) сигнальной свечи — вместо безусловного входа по её открытию."},
        {"key": "signal_candle_min_size_atr", "label": "Мин. размер сигнальной свечи", "type": "slider", "default": 0.3, "min": 0, "max": 2.0, "step": 0.05, "unit": "× ATR", "section": "entry",
         "tooltip": "Минимальный размер тела сигнальной свечи в единицах ATR. Работает при включённом «Вход по импульсной свече»."},
        # Выход
        {"key": "stop_atr", "label": "Stop Loss", "type": "slider", "default": 1.2, "min": 0.2, "max": 3, "step": 0.1, "unit": "× ATR", "section": "exit",
         "tooltip": "Размер защитного стопа в единицах ATR от цены входа."},
        {"key": "rr", "label": "Take Profit (R/R)", "type": "slider", "default": 2, "min": 0.5, "max": 5, "step": 0.1, "unit": "R", "section": "exit",
         "tooltip": "Отношение потенциальной прибыли к риску."},
    ],
    "rsi_reversal": [
        {"key": "period", "label": "Период RSI", "type": "number", "default": 14, "min": 5, "max": 30, "step": 1, "unit": "свечей", "section": "basic",
         "tooltip": "Период расчёта индикатора RSI."},
        {"key": "oversold", "label": "Перепроданность", "type": "slider", "default": 30, "min": 10, "max": 40, "step": 1, "unit": "RSI", "section": "entry",
         "tooltip": "Нижняя граница RSI, ниже которой рынок считается перепроданным. Вход — на возврате RSI выше этой границы."},
        {"key": "overbought", "label": "Перекупленность", "type": "slider", "default": 70, "min": 60, "max": 90, "step": 1, "unit": "RSI", "section": "entry",
         "tooltip": "Верхняя граница RSI, выше которой рынок считается перекупленным. Вход — на возврате RSI ниже этой границы."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 1.5, "min": 0.5, "max": 5, "step": 0.1, "unit": "R", "section": "exit",
         "tooltip": "Отношение потенциальной прибыли к риску."},
        {"key": "stop_atr", "label": "Стоп-лосс", "type": "slider", "default": 1.0, "min": 0.2, "max": 3, "step": 0.1, "unit": "× ATR", "section": "exit",
         "tooltip": "Размер защитного стопа в единицах ATR от цены входа."},
    ],
    "inside_bar": [
        {"key": "max_wait", "label": "Ожидание пробоя", "type": "number", "default": 3, "min": 1, "max": 10, "step": 1, "unit": "свечей", "section": "entry",
         "tooltip": "Сколько свечей ждать пробоя диапазона материнской свечи после формирования внутреннего бара."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 2, "min": 0.5, "max": 5, "step": 0.1, "unit": "R", "section": "exit",
         "tooltip": "Отношение потенциальной прибыли к риску. Стоп берётся от границы материнской свечи."},
    ],
    "pin_bar": [
        {"key": "wick_ratio", "label": "Отношение тени к телу", "type": "slider", "default": 2.5, "min": 1.5, "max": 5, "step": 0.1, "unit": "× тело свечи", "section": "basic",
         "tooltip": "Минимальное отношение длины тени пин-бара к телу свечи, чтобы свеча считалась пин-баром."},
        {"key": "lookback", "label": "Период экстремума", "type": "number", "default": 20, "min": 5, "max": 60, "step": 1, "unit": "свечей", "section": "basic",
         "tooltip": "Пин-бар должен обновлять минимум/максимум за это число предыдущих свечей."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 2, "min": 0.5, "max": 5, "step": 0.1, "unit": "R", "section": "exit",
         "tooltip": "Отношение потенциальной прибыли к риску."},
        {"key": "stop_atr", "label": "Запас стопа", "type": "slider", "default": 0.2, "min": 0.1, "max": 1, "step": 0.05, "unit": "× ATR", "section": "exit",
         "tooltip": "Дополнительный запас стопа за тенью пин-бара в единицах ATR."},
    ],
}

# Risk-shaping overrides only - params that don't express a risk stance
# (lookback/period/pivot_span/atr_period and similar structural windows,
# fast/slow EMA lengths, timeframe) stay at their "standard" default in
# every preset.
PRESETS: dict[str, dict[str, dict]] = {
    "false_breakout": {
        "conservative": {"min_touches": 4, "touch_tolerance_atr": 0.12, "min_depth_atr": 0.3, "rr": 1.5, "confirmation": True,
                          "max_risk_pct": 0.01, "atr_filter": True, "volume_filter": True, "volume_multiplier": 1.8,
                          "trailing_stop_atr": 1.0, "breakeven_at_r": 1.0, "max_holding_bars": 60,
                          "risk_per_trade_pct": 0.005, "reentry_cooldown_bars": 5},
        "standard": {},
        "aggressive": {"min_touches": 2, "touch_tolerance_atr": 0.2, "min_depth_atr": 0.2, "rr": 3.0, "confirmation": False,
                       "max_risk_pct": 0.02, "atr_filter": False, "volume_filter": False,
                       "risk_per_trade_pct": 0.02, "max_concurrent_trades": 2},
    },
    "head_shoulders": {
        "conservative": {"shoulder_tolerance": 0.02, "head_min_distance": 0.015, "take_pct": 0.04,
                          "volume_filter": True, "volume_multiplier": 1.8, "trailing_stop_atr": 1.0,
                          "breakeven_at_r": 1.0, "max_holding_bars": 60, "risk_per_trade_pct": 0.005, "reentry_cooldown_bars": 5},
        "standard": {},
        "aggressive": {"shoulder_tolerance": 0.05, "head_min_distance": 0.008, "take_pct": 0.08, "volume_filter": False,
                       "risk_per_trade_pct": 0.02, "max_concurrent_trades": 2},
    },
    "breakout_retest": {
        "conservative": {"min_touches": 2, "min_break_atr": 0.25, "max_break_atr": 1.0, "confirm_bars": 1,
                          "retest_tolerance_atr": 0.06, "allow_false_wick": False, "require_confirm_close": True,
                          "entry_mode": "market", "max_entry_distance_atr": 0.6,
                          "atr_filter": True, "htf_trend_filter": True, "ema_filter": True,
                          "volume_filter": True, "volume_multiplier": 1.8,
                          "rr": 1.5, "stop_atr": 0.4, "trailing_stop_atr": 1.0, "breakeven_at_r": 1.0, "max_holding_bars": 40,
                          "risk_per_trade_pct": 0.005, "max_concurrent_trades": 1, "reentry_cooldown_bars": 5},
        "standard": {},
        "aggressive": {"min_touches": 1, "min_break_atr": 0.08, "max_break_atr": 2.5, "confirm_bars": 0,
                        "retest_tolerance_atr": 0.2, "allow_false_wick": True, "require_confirm_close": False,
                        "entry_mode": "limit", "entry_offset_atr": 0.05, "max_entry_distance_atr": 1.5,
                        "atr_filter": False, "htf_trend_filter": False, "ema_filter": False, "volume_filter": False,
                        "rr": 3.0, "stop_atr": 0.2, "risk_per_trade_pct": 0.02, "max_concurrent_trades": 2},
    },
    "ema_pullback": {
        "conservative": {"min_trend_strength_atr": 0.5, "min_ema_distance_atr": 0.3, "pullback_min_depth_atr": 0.15,
                          "pullback_max_depth_atr": 0.8, "pullback_bars": 3, "touch_mode": "must_touch",
                          "ema_touch_tolerance_atr": 0.08, "impulse_candle_entry": True, "breakout_confirm": True,
                          "signal_candle_min_size_atr": 0.5, "volume_filter": True, "volume_multiplier": 1.8,
                          "rr": 1.5, "stop_atr": 1.5, "trailing_stop_atr": 1.2, "breakeven_at_r": 1.0, "max_holding_bars": 50,
                          "risk_per_trade_pct": 0.005, "reentry_cooldown_bars": 5},
        "standard": {},
        "aggressive": {"min_trend_strength_atr": 0.1, "min_ema_distance_atr": 0.05, "pullback_min_depth_atr": 0.02,
                        "pullback_max_depth_atr": 1.8, "pullback_bars": 8, "touch_mode": "approach_ok",
                        "ema_touch_tolerance_atr": 0.3, "impulse_candle_entry": False, "breakout_confirm": False,
                        "signal_candle_min_size_atr": 0.0, "volume_filter": False,
                        "rr": 3.0, "stop_atr": 0.9, "risk_per_trade_pct": 0.02, "max_concurrent_trades": 2},
    },
    "rsi_reversal": {
        "conservative": {"oversold": 25, "overbought": 75, "rr": 1.2, "stop_atr": 1.3, "volume_filter": True,
                          "volume_multiplier": 1.8, "trailing_stop_atr": 1.0, "breakeven_at_r": 1.0, "max_holding_bars": 40,
                          "risk_per_trade_pct": 0.005, "reentry_cooldown_bars": 5},
        "standard": {},
        "aggressive": {"oversold": 35, "overbought": 65, "rr": 2.2, "stop_atr": 0.8, "volume_filter": False,
                       "risk_per_trade_pct": 0.02, "max_concurrent_trades": 2},
    },
    "inside_bar": {
        "conservative": {"rr": 1.5, "max_wait": 2, "volume_filter": True, "volume_multiplier": 1.8,
                          "trailing_stop_atr": 1.0, "breakeven_at_r": 1.0, "max_holding_bars": 30,
                          "risk_per_trade_pct": 0.005, "reentry_cooldown_bars": 5},
        "standard": {},
        "aggressive": {"rr": 3.0, "max_wait": 5, "volume_filter": False, "risk_per_trade_pct": 0.02, "max_concurrent_trades": 2},
    },
    "pin_bar": {
        "conservative": {"wick_ratio": 3.2, "rr": 1.5, "stop_atr": 0.3, "volume_filter": True, "volume_multiplier": 1.8,
                          "trailing_stop_atr": 1.0, "breakeven_at_r": 1.0, "max_holding_bars": 40,
                          "risk_per_trade_pct": 0.005, "reentry_cooldown_bars": 5},
        "standard": {},
        "aggressive": {"wick_ratio": 2.0, "rr": 3.0, "stop_atr": 0.15, "risk_per_trade_pct": 0.02, "max_concurrent_trades": 2},
    },
}


def _defaults_for(strategy_id: str) -> dict:
    return {p["key"]: p["default"] for p in PARAM_SCHEMA.get(strategy_id, []) + UNIVERSAL_PARAMS}


def full_schema(strategy_id: str) -> list[dict]:
    return PARAM_SCHEMA.get(strategy_id, []) + UNIVERSAL_PARAMS


def full_presets(strategy_id: str) -> dict[str, dict]:
    defaults = _defaults_for(strategy_id)
    result = {}
    for preset_name, overrides in PRESETS.get(strategy_id, {}).items():
        result[preset_name] = {**defaults, **overrides}
    return result


def parse_params(strategy_id: str, raw: dict) -> dict:
    """Single source of truth for turning arbitrary client input into a
    validated, engine-ready params dict: every key comes from full_schema(),
    coerced to its declared type ("number" -> int, "slider" -> float,
    "checkbox" -> bool, "select" -> validated string) and clamped to its
    declared min/max. Anything the client didn't send, or sent malformed,
    falls back to the schema default - this is also what makes older saved
    portfolios/presets (missing newer keys) forward-compatible without a
    migration."""
    raw = raw or {}
    result = {}
    for f in full_schema(strategy_id):
        key, typ, default = f["key"], f["type"], f["default"]
        val = raw.get(key, default)
        if typ == "checkbox":
            result[key] = bool(val)
        elif typ == "select":
            allowed = {o["value"] for o in f.get("options", [])}
            result[key] = val if val in allowed else default
        else:
            try:
                num = float(val)
            except (TypeError, ValueError):
                num = float(default)
            if not math.isfinite(num):
                num = float(default)
            lo, hi = f.get("min"), f.get("max")
            if lo is not None:
                num = max(float(lo), num)
            if hi is not None:
                num = min(float(hi), num)
            result[key] = int(round(num)) if typ == "number" else num
    return result
