from __future__ import annotations

import itertools
import json
import uuid
from pathlib import Path

import pandas as pd

from strategies.false_breakout import run_false_breakout


def _frange(start: float, stop: float, step: float):
    values = []
    current = start
    guard = 0
    while current <= stop + step / 1000 and guard < 10000:
        values.append(round(current, 10))
        current += step
        guard += 1
    return values


def build_grid(ranges: dict) -> list[dict]:
    definitions = {
        "lookback": lambda x: list(range(int(x["from"]), int(x["to"]) + 1, int(x["step"]))),
        "min_touches": lambda x: list(range(int(x["from"]), int(x["to"]) + 1, int(x["step"]))),
        "touch_tolerance_atr": lambda x: _frange(float(x["from"]), float(x["to"]), float(x["step"])),
        "min_depth_atr": lambda x: _frange(float(x["from"]), float(x["to"]), float(x["step"])),
        "max_depth_atr": lambda x: _frange(float(x["from"]), float(x["to"]), float(x["step"])),
        "return_window": lambda x: list(range(int(x["from"]), int(x["to"]) + 1, int(x["step"]))),
        "stop_buffer_atr": lambda x: _frange(float(x["from"]), float(x["to"]), float(x["step"])),
        "rr": lambda x: _frange(float(x["from"]), float(x["to"]), float(x["step"])),
    }

    keys, value_lists = [], []
    for key, maker in definitions.items():
        spec = ranges.get(key)
        if spec:
            keys.append(key)
            value_lists.append(maker(spec))

    fixed = {
        "atr_period": int(ranges.get("atr_period", 14)),
        "confirmation": bool(ranges.get("confirmation", True)),
        "min_risk_pct": float(ranges.get("min_risk_pct", 0.0025)),
        "max_risk_pct": float(ranges.get("max_risk_pct", 0.015)),
        "min_touch_separation": int(ranges.get("min_touch_separation", 10)),
        "max_level_age": int(ranges.get("max_level_age", 150)),
        "first_break_only": bool(ranges.get("first_break_only", True)),
        "atr_filter": bool(ranges.get("atr_filter", False)),
    }

    grid = []
    for values in itertools.product(*value_lists):
        item = dict(zip(keys, values))
        item.update(fixed)
        grid.append(item)
    return grid


def run_optimizer(source: Path, ranges: dict, results_dir: Path) -> dict:
    grid = build_grid(ranges)
    if len(grid) > 5000:
        raise ValueError(f"Слишком много комбинаций: {len(grid)}. Максимум 5000.")

    optimization_id = "opt_" + uuid.uuid4().hex[:10]
    optimization_dir = results_dir / optimization_id
    optimization_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    best_run = None
    best_score = float("-inf")

    for index, params in enumerate(grid, start=1):
        result = run_false_breakout(
            source=source,
            raw_params=params,
            results_dir=optimization_dir,
        )
        summary = result["summary"]
        trades = int(summary.get("trades", 0))
        pf = summary.get("profit_factor")
        if pf is not None:
            pf_value = float(pf)
        elif trades > 0:
            # summarize() returns profit_factor=None specifically when there
            # are zero losing trades (gross_loss<=0) - a flawless outcome,
            # not an undefined/bad one. Scoring that as 0 (the worst a real
            # profit factor could be) buried a genuinely excellent small
            # sample at the bottom of the ranking. Treat it as a strong,
            # capped profit factor instead; sample_penalty below still keeps
            # a tiny all-winners run from unfairly beating a large, proven
            # one on trade count alone.
            pf_value = 5.0
        else:
            pf_value = 0.0
        expectancy = float(summary.get("average_trade_pct", 0.0))
        drawdown = abs(float(summary.get("max_drawdown_pct", 0.0)))
        compounded = float(summary.get("compounded_return_pct", 0.0))

        # Penalize tiny samples and deep drawdowns.
        sample_penalty = 0 if trades >= 30 else (30 - trades) * 0.03
        score = pf_value + compounded / 20 + expectancy * 3 - drawdown / 20 - sample_penalty

        row = {
            "rank_score": round(score, 5),
            "run_id": result["run_id"],
            **params,
            **{k: v for k, v in summary.items() if k not in {"params", "run_id"}},
        }
        rows.append(row)

        if score > best_score:
            best_score = score
            best_run = result

    table = pd.DataFrame(rows).sort_values(
        ["rank_score", "profit_factor", "trades"],
        ascending=[False, False, False],
    ).reset_index(drop=True)
    table.insert(0, "rank", range(1, len(table) + 1))
    table.to_csv(optimization_dir / "optimization_results.csv", index=False)

    top = table.head(50).to_dict(orient="records")
    payload = {
        "optimization_id": optimization_id,
        "combinations": len(grid),
        "best": best_run["summary"] if best_run else None,
        "top": top,
    }
    (optimization_dir / "optimization_summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def run_batch(files: list[Path], strategy: str, params: dict, results_dir: Path) -> dict:
    batch_id = "batch_" + uuid.uuid4().hex[:10]
    batch_dir = results_dir / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    for source in files:
        if strategy != "false_breakout":
            raise ValueError("Пакетный режим пока подключён для ложного пробоя.")
        result = run_false_breakout(source, params, batch_dir)
        summary = result["summary"]
        rows.append({
            "file": source.name,
            "run_id": result["run_id"],
            **{k: v for k, v in summary.items() if k not in {"params", "run_id", "source_file"}},
        })

    table = pd.DataFrame(rows)
    table.to_csv(batch_dir / "batch_results.csv", index=False)

    aggregate = {
        "files": len(rows),
        "total_trades": int(table["trades"].sum()) if not table.empty else 0,
        "profitable_files": int((table["compounded_return_pct"] > 0).sum()) if not table.empty else 0,
        "average_profit_factor": round(float(table["profit_factor"].dropna().mean()), 3)
            if not table.empty and table["profit_factor"].notna().any() else None,
        "average_return_pct": round(float(table["compounded_return_pct"].mean()), 3)
            if not table.empty else 0,
        "average_drawdown_pct": round(float(table["max_drawdown_pct"].mean()), 3)
            if not table.empty else 0,
    }
    payload = {"batch_id": batch_id, "aggregate": aggregate, "rows": rows}
    (batch_dir / "batch_summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload
