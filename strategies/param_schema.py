from __future__ import annotations

"""UI-facing schema for strategy parameters, one entry per param actually
read by the matching run_* function in simple_strategies.py / false_breakout.py
/ head_shoulders.py. Kept separate from STRATEGY_CATALOG (cosmetic metadata)
so the two can evolve independently.

UNIVERSAL_PARAMS are appended to every strategy's schema by merge_schema()
below - they map 1:1 to strategies.common.universal_execution_params(), which
every run_* function now reads.
"""

UNIVERSAL_PARAMS = [
    {"key": "direction", "label": "Направление сделок", "type": "select", "default": "both",
     "options": [{"value": "both", "label": "Long и Short"}, {"value": "long", "label": "Только Long"}, {"value": "short", "label": "Только Short"}],
     "tooltip": "Ограничить стратегию одной стороной рынка. По умолчанию открываются сделки в обе стороны."},
    {"key": "volume_filter", "label": "Фильтр объёма", "type": "checkbox", "default": False,
     "tooltip": "Пропускать сигналы, в момент которых объём торгов был ниже среднего. Отсекает слабые, неликвидные движения."},
    {"key": "volume_multiplier", "label": "Множитель среднего объёма", "type": "slider", "default": 1.5,
     "min": 1.0, "max": 3.0, "step": 0.1, "unit": "× средний объём",
     "tooltip": "Насколько объём в момент сигнала должен превышать скользящее среднее за 20 свечей. Работает только при включённом фильтре объёма."},
    {"key": "trailing_stop_atr", "label": "Трейлинг-стоп", "type": "slider", "default": 0,
     "min": 0, "max": 3, "step": 0.1, "unit": "× ATR (0 = выкл.)",
     "tooltip": "Стоп-лосс подтягивается вслед за ценой на расстоянии N ATR от максимума прибыли по сделке. 0 отключает трейлинг — стоп остаётся на исходном уровне."},
    {"key": "max_holding_bars", "label": "Макс. время в позиции", "type": "number", "default": 0,
     "min": 0, "max": 300, "step": 5, "unit": "свечей (0 = без ограничения)",
     "tooltip": "Принудительно закрыть сделку по цене закрытия, если за N свечей не сработали ни стоп, ни тейк."},
]

PARAM_SCHEMA: dict[str, list[dict]] = {
    "false_breakout": [
        {"key": "lookback", "label": "Период уровня", "type": "number", "default": 80, "min": 20, "max": 200, "step": 5, "unit": "свечей",
         "tooltip": "Количество предыдущих свечей, по которым строится уровень. Малое значение даёт больше, но слабее уровней; большое — реже, но значимее."},
        {"key": "atr_period", "label": "Период ATR", "type": "number", "default": 14, "min": 5, "max": 50, "step": 1, "unit": "свечей",
         "tooltip": "Период Average True Range. ATR измеряет текущую волатильность и используется для нормализации глубины пробоя и стопа."},
        {"key": "min_touches", "label": "Минимум касаний", "type": "number", "default": 3, "min": 1, "max": 6, "step": 1, "unit": "касаний",
         "tooltip": "Минимальное число разнесённых касаний, необходимое для признания цены уровнем поддержки или сопротивления."},
        {"key": "touch_tolerance_atr", "label": "Допуск касания", "type": "slider", "default": 0.15, "min": 0.05, "max": 0.5, "step": 0.01, "unit": "× ATR",
         "tooltip": "Максимальное расстояние от уровня, при котором свеча считается касанием. Измеряется в долях ATR."},
        {"key": "min_depth_atr", "label": "Мин. глубина пробоя", "type": "slider", "default": 0.25, "min": 0.05, "max": 1.0, "step": 0.01, "unit": "× ATR",
         "tooltip": "Минимальная глубина выхода цены за уровень. Слишком маленький прокол может быть обычным шумом."},
        {"key": "max_depth_atr", "label": "Макс. глубина пробоя", "type": "slider", "default": 0.70, "min": 0.1, "max": 2.0, "step": 0.01, "unit": "× ATR",
         "tooltip": "Максимальная глубина ложного пробоя. Более глубокое движение чаще оказывается настоящим пробоем."},
        {"key": "return_window", "label": "Окно возврата", "type": "number", "default": 2, "min": 1, "max": 10, "step": 1, "unit": "свечей",
         "tooltip": "Максимальное число свечей, за которое цена должна закрыться обратно за уровень."},
        {"key": "stop_buffer_atr", "label": "Запас стопа", "type": "slider", "default": 0.05, "min": 0, "max": 0.3, "step": 0.01, "unit": "× ATR",
         "tooltip": "Дополнительный запас за экстремумом ложного пробоя, чтобы стоп не стоял точно на минимуме или максимуме."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 2.0, "min": 0.5, "max": 5, "step": 0.1, "unit": "R",
         "tooltip": "Отношение потенциальной прибыли к риску. Значение 2 означает тейк-профит на расстоянии двух размеров стопа."},
        {"key": "confirmation", "label": "Подтверждение свечой", "type": "checkbox", "default": True,
         "tooltip": "Требовать дополнительную свечу в сторону возврата перед входом. Снижает число сигналов, но фильтрует слабые возвраты."},
        {"key": "min_risk_pct", "label": "Мин. риск на сделку", "type": "slider", "default": 0.0025, "min": 0.001, "max": 0.02, "step": 0.0005, "unit": "% от цены",
         "tooltip": "Минимально допустимая ширина стопа относительно цены. Отсекает слишком тесные стопы, чувствительные к шуму."},
        {"key": "max_risk_pct", "label": "Макс. риск на сделку", "type": "slider", "default": 0.015, "min": 0.005, "max": 0.05, "step": 0.001, "unit": "% от цены",
         "tooltip": "Максимально допустимая ширина стопа. Отсекает сделки с чрезмерным риском."},
        {"key": "min_touch_separation", "label": "Расстояние между касаниями", "type": "number", "default": 10, "min": 2, "max": 30, "step": 1, "unit": "свечей",
         "tooltip": "Минимальное расстояние между касаниями в свечах. Не позволяет считать соседние свечи отдельными подтверждениями уровня."},
        {"key": "max_level_age", "label": "Возраст уровня", "type": "number", "default": 150, "min": 50, "max": 400, "step": 10, "unit": "свечей",
         "tooltip": "Максимальный возраст уровня в свечах. Старые уровни могут терять актуальность."},
        {"key": "first_break_only", "label": "Только первый пробой", "type": "checkbox", "default": True,
         "tooltip": "После первой сделки по уровню больше его не использовать. Повторные тесты обычно ослабляют уровень."},
        {"key": "atr_filter", "label": "Фильтр волатильности", "type": "checkbox", "default": False,
         "tooltip": "Торговать только когда текущий ATR выше своего среднего значения, то есть в более активном рынке."},
    ],
    "head_shoulders": [
        {"key": "pivot_span", "label": "Радиус экстремума", "type": "number", "default": 3, "min": 2, "max": 10, "step": 1, "unit": "свечей",
         "tooltip": "Сколько свечей слева и справа должны быть ниже/выше пика или впадины, чтобы точка считалась разворотным экстремумом."},
        {"key": "shoulder_tolerance", "label": "Допуск симметрии плеч", "type": "slider", "default": 0.03, "min": 0.01, "max": 0.1, "step": 0.005, "unit": "%",
         "tooltip": "Насколько сильно может отличаться цена двух плеч фигуры, чтобы она всё ещё считалась «Головой и плечами»."},
        {"key": "head_min_distance", "label": "Выступ головы", "type": "slider", "default": 0.01, "min": 0.005, "max": 0.05, "step": 0.005, "unit": "%",
         "tooltip": "Минимальное превышение головы над плечами. Слишком маленький выступ — ненадёжная фигура."},
        {"key": "stop_pct", "label": "Стоп-лосс", "type": "slider", "default": 0.02, "min": 0.005, "max": 0.05, "step": 0.005, "unit": "% от цены входа",
         "tooltip": "Фиксированный стоп-лосс в процентах от цены входа."},
        {"key": "take_pct", "label": "Тейк-профит", "type": "slider", "default": 0.05, "min": 0.01, "max": 0.15, "step": 0.005, "unit": "% от цены входа",
         "tooltip": "Фиксированный тейк-профит в процентах от цены входа."},
        {"key": "max_breakout_bars", "label": "Окно пробоя шеи", "type": "number", "default": 30, "min": 10, "max": 80, "step": 5, "unit": "свечей",
         "tooltip": "Сколько свечей ждать пробоя линии шеи после формирования правого плеча, прежде чем фигура считается несостоявшейся."},
    ],
    "breakout_retest": [
        {"key": "lookback", "label": "Период уровня", "type": "number", "default": 50, "min": 10, "max": 150, "step": 5, "unit": "свечей",
         "tooltip": "Количество предыдущих свечей, по которым строится диапазон (уровень пробоя)."},
        {"key": "retest_bars", "label": "Ожидание ретеста", "type": "number", "default": 5, "min": 1, "max": 15, "step": 1, "unit": "свечей",
         "tooltip": "Сколько свечей ждать возврата цены к пробитому уровню для входа на ретесте."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 2, "min": 0.5, "max": 5, "step": 0.1, "unit": "R",
         "tooltip": "Отношение потенциальной прибыли к риску."},
        {"key": "stop_atr", "label": "Запас стопа", "type": "slider", "default": 0.3, "min": 0.1, "max": 1.5, "step": 0.05, "unit": "× ATR",
         "tooltip": "Размер защитного стопа за уровнем в единицах ATR."},
    ],
    "ema_pullback": [
        {"key": "fast", "label": "Быстрая EMA", "type": "number", "default": 20, "min": 5, "max": 50, "step": 1, "unit": "свечей",
         "tooltip": "Период быстрой экспоненциальной средней."},
        {"key": "slow", "label": "Медленная EMA", "type": "number", "default": 50, "min": 20, "max": 200, "step": 5, "unit": "свечей",
         "tooltip": "Период медленной экспоненциальной средней, задающей направление тренда."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 2, "min": 0.5, "max": 5, "step": 0.1, "unit": "R",
         "tooltip": "Отношение потенциальной прибыли к риску."},
        {"key": "stop_atr", "label": "Стоп-лосс", "type": "slider", "default": 1.2, "min": 0.2, "max": 3, "step": 0.1, "unit": "× ATR",
         "tooltip": "Размер защитного стопа в единицах ATR от цены входа."},
    ],
    "rsi_reversal": [
        {"key": "period", "label": "Период RSI", "type": "number", "default": 14, "min": 5, "max": 30, "step": 1, "unit": "свечей",
         "tooltip": "Период расчёта индикатора RSI."},
        {"key": "oversold", "label": "Перепроданность", "type": "slider", "default": 30, "min": 10, "max": 40, "step": 1, "unit": "RSI",
         "tooltip": "Нижняя граница RSI, ниже которой рынок считается перепроданным. Вход — на возврате RSI выше этой границы."},
        {"key": "overbought", "label": "Перекупленность", "type": "slider", "default": 70, "min": 60, "max": 90, "step": 1, "unit": "RSI",
         "tooltip": "Верхняя граница RSI, выше которой рынок считается перекупленным. Вход — на возврате RSI ниже этой границы."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 1.5, "min": 0.5, "max": 5, "step": 0.1, "unit": "R",
         "tooltip": "Отношение потенциальной прибыли к риску."},
        {"key": "stop_atr", "label": "Стоп-лосс", "type": "slider", "default": 1.0, "min": 0.2, "max": 3, "step": 0.1, "unit": "× ATR",
         "tooltip": "Размер защитного стопа в единицах ATR от цены входа."},
    ],
    "inside_bar": [
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 2, "min": 0.5, "max": 5, "step": 0.1, "unit": "R",
         "tooltip": "Отношение потенциальной прибыли к риску. Стоп берётся от границы материнской свечи."},
        {"key": "max_wait", "label": "Ожидание пробоя", "type": "number", "default": 3, "min": 1, "max": 10, "step": 1, "unit": "свечей",
         "tooltip": "Сколько свечей ждать пробоя диапазона материнской свечи после формирования внутреннего бара."},
    ],
    "pin_bar": [
        {"key": "wick_ratio", "label": "Отношение тени к телу", "type": "slider", "default": 2.5, "min": 1.5, "max": 5, "step": 0.1, "unit": "× тело свечи",
         "tooltip": "Минимальное отношение длины тени пин-бара к телу свечи, чтобы свеча считалась пин-баром."},
        {"key": "lookback", "label": "Период экстремума", "type": "number", "default": 20, "min": 5, "max": 60, "step": 1, "unit": "свечей",
         "tooltip": "Пин-бар должен обновлять минимум/максимум за это число предыдущих свечей."},
        {"key": "rr", "label": "Тейк-профит", "type": "slider", "default": 2, "min": 0.5, "max": 5, "step": 0.1, "unit": "R",
         "tooltip": "Отношение потенциальной прибыли к риску."},
        {"key": "stop_atr", "label": "Запас стопа", "type": "slider", "default": 0.2, "min": 0.1, "max": 1, "step": 0.05, "unit": "× ATR",
         "tooltip": "Дополнительный запас стопа за тенью пин-бара в единицах ATR."},
    ],
}

# Risk-shaping overrides only - params that don't express a risk stance
# (lookback/period/pivot_span/atr_period and similar structural windows)
# stay at their "standard" default in every preset.
PRESETS: dict[str, dict[str, dict]] = {
    "false_breakout": {
        "conservative": {"min_touches": 4, "touch_tolerance_atr": 0.12, "min_depth_atr": 0.3, "rr": 1.5, "confirmation": True,
                          "max_risk_pct": 0.01, "atr_filter": True, "volume_filter": True, "volume_multiplier": 1.8,
                          "trailing_stop_atr": 1.0, "max_holding_bars": 60},
        "standard": {},
        "aggressive": {"min_touches": 2, "touch_tolerance_atr": 0.2, "min_depth_atr": 0.2, "rr": 3.0, "confirmation": False,
                       "max_risk_pct": 0.02, "atr_filter": False, "volume_filter": False},
    },
    "head_shoulders": {
        "conservative": {"shoulder_tolerance": 0.02, "head_min_distance": 0.015, "take_pct": 0.04,
                          "volume_filter": True, "volume_multiplier": 1.8, "trailing_stop_atr": 1.0, "max_holding_bars": 60},
        "standard": {},
        "aggressive": {"shoulder_tolerance": 0.05, "head_min_distance": 0.008, "take_pct": 0.08, "volume_filter": False},
    },
    "breakout_retest": {
        "conservative": {"retest_bars": 3, "rr": 1.5, "stop_atr": 0.4, "volume_filter": True, "volume_multiplier": 1.8,
                          "trailing_stop_atr": 1.0, "max_holding_bars": 40},
        "standard": {},
        "aggressive": {"retest_bars": 7, "rr": 3.0, "stop_atr": 0.2, "volume_filter": False},
    },
    "ema_pullback": {
        "conservative": {"rr": 1.5, "stop_atr": 1.5, "volume_filter": True, "volume_multiplier": 1.8,
                          "trailing_stop_atr": 1.2, "max_holding_bars": 50},
        "standard": {},
        "aggressive": {"rr": 3.0, "stop_atr": 0.9, "volume_filter": False},
    },
    "rsi_reversal": {
        "conservative": {"oversold": 25, "overbought": 75, "rr": 1.2, "stop_atr": 1.3, "volume_filter": True,
                          "volume_multiplier": 1.8, "trailing_stop_atr": 1.0, "max_holding_bars": 40},
        "standard": {},
        "aggressive": {"oversold": 35, "overbought": 65, "rr": 2.2, "stop_atr": 0.8, "volume_filter": False},
    },
    "inside_bar": {
        "conservative": {"rr": 1.5, "max_wait": 2, "volume_filter": True, "volume_multiplier": 1.8,
                          "trailing_stop_atr": 1.0, "max_holding_bars": 30},
        "standard": {},
        "aggressive": {"rr": 3.0, "max_wait": 5, "volume_filter": False},
    },
    "pin_bar": {
        "conservative": {"wick_ratio": 3.2, "rr": 1.5, "stop_atr": 0.3, "volume_filter": True, "volume_multiplier": 1.8,
                          "trailing_stop_atr": 1.0, "max_holding_bars": 40},
        "standard": {},
        "aggressive": {"wick_ratio": 2.0, "rr": 3.0, "stop_atr": 0.15, "volume_filter": False},
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
