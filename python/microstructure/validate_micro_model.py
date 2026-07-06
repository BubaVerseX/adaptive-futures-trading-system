#!/usr/bin/env python3
"""Validate trained V24 microstructure models with post-cost shadow accounting."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from train_micro_model import FEATURE_COLUMNS, add_targets, list_snapshot_files, load_rows


def profit_factor(values):
    wins = sum(max(0.0, float(value)) for value in values)
    losses = abs(sum(min(0.0, float(value)) for value in values))
    if losses > 0:
        return wins / losses
    return 999.0 if wins > 0 else 0.0


def max_drawdown(values):
    equity = 0.0
    peak = 0.0
    drawdown = 0.0
    for value in values:
        equity += float(value)
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return drawdown


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def cost_bps(row, fee_bps, slippage_bps):
    return float(row.get("relativeSpread") or 0) * 10000 + fee_bps + slippage_bps


def validate_model(model_info, rows, args):
    try:
        from catboost import CatBoostRegressor, Pool
    except ImportError as exc:
        return {"horizonSeconds": model_info.get("horizonSeconds"), "status": "CATBOOST_MISSING", "error": str(exc)}

    horizon = int(model_info["horizonSeconds"])
    target_rows = add_targets(rows, horizon)
    split = int(len(target_rows) * 0.7)
    validation_rows = target_rows[split:]
    if not validation_rows:
        return {"horizonSeconds": horizon, "status": "NO_VALIDATION_ROWS"}

    model = CatBoostRegressor()
    model.load_model(str(model_info["modelFile"]))
    pool = Pool([[row[column] for column in FEATURE_COLUMNS] for row in validation_rows], feature_names=FEATURE_COLUMNS)
    predictions = [float(value) for value in model.predict(pool)]
    predicted_bps = [prediction * 10000 for prediction in predictions]
    actual_bps = [float(row["targetReturn"]) * 10000 for row in validation_rows]
    direction_hits = [
        1 for predicted, actual in zip(predicted_bps, actual_bps)
        if predicted != 0 and actual != 0 and math.copysign(1, predicted) == math.copysign(1, actual)
    ]
    trades = []
    threshold_hits = 0
    threshold_total = 0
    for row, predicted, actual in zip(validation_rows, predicted_bps, actual_bps):
        total_cost = cost_bps(row, args.fee_bps, args.slippage_bps)
        expected_net = abs(predicted) - total_cost - args.safety_buffer_bps
        if expected_net <= args.min_net_edge_bps or abs(predicted) <= total_cost + args.safety_buffer_bps:
            continue
        threshold_total += 1
        if predicted != 0 and actual != 0 and math.copysign(1, predicted) == math.copysign(1, actual):
            threshold_hits += 1
        realized_bps = actual if predicted > 0 else -actual
        net_bps = realized_bps - total_cost
        trades.append(net_bps / 10000)
    return {
        "horizonSeconds": horizon,
        "status": "VALIDATED",
        "validationRows": len(validation_rows),
        "directionalAccuracy": len(direction_hits) / len(validation_rows) if validation_rows else 0,
        "precisionAboveThreshold": threshold_hits / threshold_total if threshold_total else 0,
        "tradeCount": len(trades),
        "netPnl": sum(trades),
        "profitFactor": profit_factor(trades),
        "maxDrawdown": max_drawdown(trades),
        "averageTradeNetReturn": sum(trades) / len(trades) if trades else 0,
        "feesAndSlippageIncluded": True,
        "feeBps": args.fee_bps,
        "slippageBps": args.slippage_bps,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-dir", default="data/microstructure/snapshots")
    parser.add_argument("--manifest", default="models/microstructure/model-manifest.json")
    parser.add_argument("--output-report", default="models/microstructure/validation-report.json")
    parser.add_argument("--output-profile", default="models/microstructure/live-profile.json")
    parser.add_argument("--min-shadow-signals", type=int, default=500)
    parser.add_argument("--min-net-edge-bps", type=float, default=3.0)
    parser.add_argument("--fee-bps", type=float, default=11.0)
    parser.add_argument("--slippage-bps", type=float, default=0.6)
    parser.add_argument("--safety-buffer-bps", type=float, default=1.0)
    parser.add_argument("--min-profit-factor", type=float, default=1.2)
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        report = {
            "status": "MICRO_MODEL_NOT_READY",
            "reason": "MODEL_MANIFEST_MISSING",
            "validatedModels": [],
        }
        write_json(Path(args.output_report), report)
        write_json(Path(args.output_profile), { **report, "liveOrdersAllowed": False })
        print(json.dumps(report, indent=2))
        return

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    trained_models = [model for model in manifest.get("models", []) if model.get("status") == "TRAINED"]
    if manifest.get("status") != "TRAINED" or not trained_models:
        report = {
            "status": "MICRO_MODEL_NOT_READY",
            "reason": "NO_TRAINED_MODELS",
            "manifestStatus": manifest.get("status"),
            "validatedModels": [],
        }
        write_json(Path(args.output_report), report)
        write_json(Path(args.output_profile), { **report, "liveOrdersAllowed": False })
        print(json.dumps(report, indent=2))
        return

    rows = load_rows(list_snapshot_files(Path(args.snapshot_dir)))
    validated = [validate_model(model, rows, args) for model in trained_models]
    passing = [
        item for item in validated
        if item.get("status") == "VALIDATED" and
        item.get("netPnl", 0) > 0 and
        item.get("profitFactor", 0) > args.min_profit_factor and
        item.get("tradeCount", 0) >= args.min_shadow_signals
    ]
    best = sorted(passing, key=lambda item: (item["profitFactor"], item["netPnl"]), reverse=True)[0] if passing else None
    report = {
        "status": "VALIDATED" if best else "REJECTED",
        "bestHorizonSeconds": best.get("horizonSeconds") if best else None,
        "validatedModels": validated,
        "promotionCriteria": {
            "netPnlPositive": True,
            "profitFactorGreaterThan": args.min_profit_factor,
            "minimumAcceptedShadowTrades": args.min_shadow_signals,
            "feesAndSlippageIncluded": True,
        },
    }
    profile = {
        **report,
        "status": "VALIDATED" if best else "REJECTED",
        "shadowSignals": best.get("tradeCount") if best else 0,
        "netPnlAfterFees": best.get("netPnl") if best else 0,
        "profitFactor": best.get("profitFactor") if best else 0,
        "maxDrawdown": best.get("maxDrawdown") if best else None,
        "trainedModelExists": True,
        "liveOrdersAllowed": bool(best),
    }
    write_json(Path(args.output_report), report)
    write_json(Path(args.output_profile), profile)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
