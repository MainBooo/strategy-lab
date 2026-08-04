from __future__ import annotations

# Single source of truth for the "ready-made sets" filter buttons and the
# per-ticker industry tag shown in the catalog. Kept as curated lists (not
# derived from a MOEX classification endpoint - TQBR board-securities data
# doesn't carry a sector field) so it stays in sync between the preset
# buttons and the "отрасль" filter instead of drifting as two copies.
SECURITY_PRESETS: dict[str, list[str]] = {
    "top10": ["SBER","GAZP","LKOH","ROSN","NVTK","T","YDEX","MOEX","GMKN","VTBR"],
    "top20": ["SBER","GAZP","LKOH","ROSN","NVTK","T","YDEX","MOEX","GMKN","VTBR","MAGN","CHMF","NLMK","ALRS","PHOR","SIBN","MTSS","IRAO","HYDR","AFLT"],
    "banks": ["SBER","SBERP","VTBR","CBOM","BSPB"],
    "oilgas": ["GAZP","LKOH","ROSN","NVTK","SIBN","TATN","TATNP","SNGS","SNGSP","BANE","BANEP","RNFT"],
    "metals": ["GMKN","MAGN","CHMF","NLMK","ALRS","RUAL","ENPG","PHOR","AKRN","MTLR","MTLRP","UGLD","SELG"],
    "it": ["YDEX","T","POSI","ASTR","DIAS","HEAD"],
}

PRESET_LABELS: dict[str, str] = {
    "top10": "ТОП-10 ликвидных",
    "top20": "ТОП-20",
    "banks": "Банки",
    "oilgas": "Нефть и газ",
    "metals": "Металлургия",
    "it": "IT",
}

SECTOR_LABELS: dict[str, str] = {
    "banks": "Финансы",
    "oilgas": "Нефть и газ",
    "metals": "Металлургия",
    "it": "IT",
}

# A ticker can appear in multiple curated lists (e.g. top10 & oilgas); pick
# the first matching *sector* list (banks/oilgas/metals/it) for its industry
# tag, falling back to a neutral label instead of leaving it blank.
_SECTOR_ORDER = ["banks", "oilgas", "metals", "it"]


def sector_for(ticker: str) -> str:
    ticker = str(ticker).upper()
    for key in _SECTOR_ORDER:
        if ticker in SECURITY_PRESETS[key]:
            return SECTOR_LABELS[key]
    return "Прочее"


def is_liquid(ticker: str) -> bool:
    return str(ticker).upper() in SECURITY_PRESETS["top20"]
