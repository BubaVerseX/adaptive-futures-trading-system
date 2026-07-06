#!/usr/bin/env python3
"""Validate trained V25 microstructure models and select a live-ready profile.

Research-only. This script never connects to Bybit and cannot place orders.
"""

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


def summary(values):
    usable = [float(value) for value in values if math.isfinite(float(value))]
    if not usable:
        return {"min": 0, "max": 0, "mean": 0}
    return {
        "min": min(usable),
        "max": max(usable),
        "mean": sum(usable) / len(usable),
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def cost_bps(row, fee_bps, slippage_bps):
    spread_bps = float(row.get("relativeSpread") or 0) * 10000
    return spread_bps, spread_bps + fee_bps + slippage_bps


def directional_accuracy(predicted_bps, actual_bps):
    hits = [
        1 for predicted, actual in zip(predicted_bps, actual_bps)
        if predicted != 0 and actual != 0 and math.copysign(1, predicted) == math.copysign(1, actual)
    ]
    return len(hits) / len(actual_bps) if actual_bps else 0


def evaluate_threshold(rows, adjusted_predictions_bps, actual_bps, threshold_bps, args):
    trades = []
    above_threshold = 0
    threshold_direction_hits = 0
    rejected_by_threshold = 0
    rejected_by_fee = 0
    rejected_by_spread = 0
    expected_net_edges = []
    for row, predicted, actual in zip(rows, adjusted_predictions_bps, actual_bps):
        abs_prediction = abs(predicted)
        spread_bps, total_cost_bps = cost_bps(row, args.fee_bps, args.slippage_bps)
        expected_net_edge = abs_prediction - total_cost_bps - args.safety_buffer_bps
        expected_net_edges.append(expected_net_edge)
        if abs_prediction < threshold_bps:
            rejected_by_threshold += 1
            continue
        above_threshold += 1
        if predicted != 0 and actual != 0 and math.copysign(1, predicted) == math.copysign(1, actual):
            threshold_direction_hits += 1
        if spread_bps >= abs_prediction:
            rejected_by_spread += 1
            continue
        if expected_net_edge <= args.min_net_edge_bps or abs_prediction <= total_cost_bps + args.safety_buffer_bps:
            rejected_by_fee += 1
            continue
        realized_bps = actual if predicted > 0 else -actual
        net_bps = realized_bps - total_cost_bps
        trades.append(net_bps / 10000)
    pf = profit_factor(trades)
    dd = max_drawdown(trades)
    return {
        "thresholdBps": threshold_bps,
        "numberAboveThreshold": above_threshold,
        "precisionAboveThreshold": threshold_direction_hits / above_threshold if above_threshold else 0,
        "tradeCount": len(trades),
        "netPnl": sum(trades),
        "profitFactor": pf,
        "maxDrawdown": dd,
        "averageTradeNetReturn": sum(trades) / len(trades) if trades else 0,
        "expectedNetEdgeDistribution": summary(expected_net_edges),
        "rejectedByThreshold": rejected_by_threshold,
        "rejectedByFee": rejected_by_fee,
        "rejectedBySpread": rejected_by_spread,
    }


def better_result(left, right):
    if right is None:
        return left
    if left["netPnl"] != right["netPnl"]:
        return left if left["netPnl"] > right["netPnl"] else right
    if left["profitFactor"] != right["profitFactor"]:
        return left if left["profitFactor"] > right["profitFactor"] else right
    return left if left["tradeCount"] > right["tradeCount"] else right


def validate_model(model_info, rows, args):
    try:
        from catboost import CatBoostRegressor, Pool
    except ImportError as exc:
        return {"horizonSeconds": model_info.get("horizonSeconds"), "status": "CATBOOST_MISSING", "error": str(exc)}

    horizon = int(model_info["horizonSeconds"])
    target_rows = add_targets(rows, horizon, args.label_tolerance_ms)
    split = int(len(target_rows) * 0.7)
    validation_rows = target_rows[split:]
    if not validation_rows:
        return {"horizonSeconds": horizon, "status": "NO_VALIDATION_ROWS"}

    model = CatBoostRegressor()
    model.load_model(str(model_info["modelFile"]))
    pool = Pool([[row[column] for column in FEATURE_COLUMNS] for row in validation_rows], feature_names=FEATURE_COLUMNS)
    raw_predictions_bps = [float(value) * 10000 for value in model.predict(pool)]
    actual_bps = [float(row["targetReturn"]) * 10000 for row in validation_rows]
    threshold_results = []
    best = None
    for signal_mode, multiplier in [("NORMAL", 1.0), ("INVERTED", -1.0)]:
        adjusted = [value * multiplier for value in raw_predictions_bps]
        mode_accuracy = directional_accuracy(adjusted, actual_bps)
        for threshold in args.thresholds_bps:
            result = evaluate_threshold(validation_rows, adjusted, actual_bps, threshold, args)
            enriched = {
                **result,
                "signalMode": signal_mode,
                "directionalAccuracy": mode_accuracy,
            }
            threshold_results.append(enriched)
            best = better_result(enriched, best)

    normal_best = None
    inverted_best = None
    for result in threshold_results:
        if result["signalMode"] == "NORMAL":
            normal_best = better_result(result, normal_best)
        else:
            inverted_best = better_result(result, inverted_best)
    return {
        "horizonSeconds": horizon,
        "status": "VALIDATED",
        "modelFile": model_info["modelFile"],
        "targetField": model_info.get("targetField", f"futureReturn{horizon}sBps"),
        "validationRows": len(validation_rows),
        "predictionDistributionBps": summary(raw_predictions_bps),
        "realizedReturnDistributionBps": summary(actual_bps),
        "bestNormal": normal_best,
        "bestInverted": inverted_best,
        "bestResult": best,
        "thresholdResults": threshold_results,
        "feesAndSlippageIncluded": True,
        "feeBps": args.fee_bps,
        "slippageBps": args.slippage_bps,
        "safetyBufferBps": args.safety_buffer_bps,
        "minNetEdgeBps": args.min_net_edge_bps,
    }


def pass_reasons(candidate, args):
    result = candidate.get("bestResult") or {}
    reasons = []
    if result.get("netPnl", 0) <= 0:
        reasons.append("netPnl <= 0")
    if result.get("profitFactor", 0) <= args.min_profit_factor:
        reasons.append(f"profitFactor <= {args.min_profit_factor}")
    if result.get("tradeCount", 0) < args.minimum_validation_trades:
        reasons.append(f"tradeCount < {args.minimum_validation_trades}")
    if result.get("maxDrawdown", 0) > args.max_drawdown:
        reasons.append(f"maxDrawdown > {args.max_drawdown}")
    return reasons


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-dir", default="data/microstructure/snapshots")
    parser.add_argument("--manifest", default="models/microstructure/model-manifest.json")
    parser.add_argument("--output-report", default="models/microstructure/validation-report.json")
    parser.add_argument("--output-profile", default="models/microstructure/live-profile.json")
    parser.add_argument("--output-v25-profile", default="models/microstructure/live-profile-v25.json")
    parser.add_argument("--min-shadow-signals", type=int, default=500)
    parser.add_argument("--minimum-validation-trades", type=int, default=50)
    parser.add_argument("--min-net-edge-bps", type=float, default=3.0)
    parser.add_argument("--fee-bps", type=float, default=11.0)
    parser.add_argument("--slippage-bps", type=float, default=0.6)
    parser.add_argument("--safety-buffer-bps", type=float, default=1.0)
    parser.add_argument("--min-profit-factor", type=float, default=1.2)
    parser.add_argument("--max-drawdown", type=float, default=5.0)
    parser.add_argument("--thresholds-bps", default="0.5,1,2,3,5,8,10,15,20")
    parser.add_argument("--label-tolerance-ms", type=int, default=1500)
    args = parser.parse_args()
    args.thresholds_bps = [float(item.strip()) for item in args.thresholds_bps.split(",") if item.strip()]

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        report = {
            "status": "MICRO_MODEL_NOT_READY",
            "reason": "MODEL_MANIFEST_MISSING",
            "validatedModels": [],
            "message": "NO_VALID_MICROSTRUCTURE_EDGE_FOUND",
        }
        write_json(Path(args.output_report), report)
        write_json(Path(args.output_profile), { **report, "liveOrdersAllowed": False })
        Path(args.output_v25_profile).unlink(missing_ok=True)
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
            "message": "NO_VALID_MICROSTRUCTURE_EDGE_FOUND",
        }
        write_json(Path(args.output_report), report)
        write_json(Path(args.output_profile), { **report, "liveOrdersAllowed": False })
        Path(args.output_v25_profile).unlink(missing_ok=True)
        print(json.dumps(report, indent=2))
        return

    rows = load_rows(list_snapshot_files(Path(args.snapshot_dir)))
    validated = [validate_model(model, rows, args) for model in trained_models]
    passing = [
        item for item in validated
        if item.get("status") == "VALIDATED" and not pass_reasons(item, args)
    ]
    best = sorted(
        passing,
        key=lambda item: (item["bestResult"]["netPnl"], item["bestResult"]["profitFactor"], item["bestResult"]["tradeCount"]),
        reverse=True,
    )[0] if passing else None
    rejected_reasons = [
        {
            "horizonSeconds": item.get("horizonSeconds"),
            "bestSignalMode": (item.get("bestResult") or {}).get("signalMode"),
            "bestThresholdBps": (item.get("bestResult") or {}).get("thresholdBps"),
            "bestNetPnl": (item.get("bestResult") or {}).get("netPnl"),
            "bestProfitFactor": (item.get("bestResult") or {}).get("profitFactor"),
            "bestTradeCount": (item.get("bestResult") or {}).get("tradeCount"),
            "blockedReasons": pass_reasons(item, args),
        }
        for item in validated
    ]
    report = {
        "status": "VALIDATED" if best else "REJECTED",
        "message": "MICROSTRUCTURE_EDGE_VALIDATED" if best else "NO_VALID_MICROSTRUCTURE_EDGE_FOUND",
        "bestHorizonSeconds": best.get("horizonSeconds") if best else None,
        "bestSignalMode": (best.get("bestResult") or {}).get("signalMode") if best else None,
        "bestThresholdBps": (best.get("bestResult") or {}).get("thresholdBps") if best else None,
        "validatedModels": validated,
        "rejectedReasons": rejected_reasons,
        "promotionCriteria": {
            "netPnlPositive": True,
            "profitFactorGreaterThan": args.min_profit_factor,
            "minimumValidationTrades": args.minimum_validation_trades,
            "minimumAcceptedShadowTrades": args.min_shadow_signals,
            "maxDrawdown": args.max_drawdown,
            "unitWarningsRequired": 0,
            "feesAndSlippageIncluded": True,
        },
    }
    profile = {
        **report,
        "shadowSignals": (best.get("bestResult") or {}).get("tradeCount") if best else 0,
        "netPnlAfterFees": (best.get("bestResult") or {}).get("netPnl") if best else 0,
        "profitFactor": (best.get("bestResult") or {}).get("profitFactor") if best else 0,
        "maxDrawdown": (best.get("bestResult") or {}).get("maxDrawdown") if best else None,
        "trainedModelExists": True,
        "validationPassed": bool(best),
        "liveOrdersAllowed": False,
    }
    write_json(Path(args.output_report), report)
    write_json(Path(args.output_profile), profile)
    if best:
        selected = best["bestResult"]
        v25_profile = {
            "status": "VALIDATED",
            "version": "V25",
            "modelFile": best["modelFile"],
            "horizonSeconds": best["horizonSeconds"],
            "targetField": best["targetField"],
            "signalMode": selected["signalMode"],
            "bestThresholdBps": selected["thresholdBps"],
            "netPnlAfterFees": selected["netPnl"],
            "profitFactor": selected["profitFactor"],
            "tradeCount": selected["tradeCount"],
            "maxDrawdown": selected["maxDrawdown"],
            "directionalAccuracy": selected["directionalAccuracy"],
            "precisionAboveThreshold": selected["precisionAboveThreshold"],
            "feeBps": args.fee_bps,
            "slippageBps": args.slippage_bps,
            "safetyBufferBps": args.safety_buffer_bps,
            "minNetEdgeBps": args.min_net_edge_bps,
            "validationPassed": True,
            "shadowValidationRequired": True,
            "liveOrdersAllowed": False,
        }
        write_json(Path(args.output_v25_profile), v25_profile)
    else:
        Path(args.output_v25_profile).unlink(missing_ok=True)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
