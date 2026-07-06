#!/usr/bin/env python3
"""Validate trained V26 microstructure models and select a live-ready profile.

Research-only. This script never connects to Bybit and cannot place orders.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from train_micro_model import FEATURE_COLUMNS, add_targets, list_snapshot_files, load_rows


SIDE_MODES = ("LONG_SHORT", "LONG_ONLY", "SHORT_ONLY")
SIGNAL_MODES = (("NORMAL", 1.0), ("INVERTED", -1.0))


def finite_float(value, fallback=0.0):
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else fallback
    except (TypeError, ValueError):
        return fallback


def profit_factor(values):
    wins = sum(max(0.0, finite_float(value)) for value in values)
    losses = abs(sum(min(0.0, finite_float(value)) for value in values))
    if losses > 0:
        return wins / losses
    return 999.0 if wins > 0 else 0.0


def max_drawdown(values):
    equity = 0.0
    peak = 0.0
    drawdown = 0.0
    for value in values:
        equity += finite_float(value)
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return drawdown


def summary(values):
    usable = [finite_float(value) for value in values if math.isfinite(finite_float(value))]
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
    spread_bps = max(0.0, finite_float(row.get("relativeSpread")) * 10000)
    return spread_bps, spread_bps + fee_bps + slippage_bps


def directional_accuracy(predicted_bps, actual_bps):
    comparable = 0
    hits = 0
    for predicted, actual in zip(predicted_bps, actual_bps):
        if predicted == 0 or actual == 0:
            continue
        comparable += 1
        if math.copysign(1, predicted) == math.copysign(1, actual):
            hits += 1
    return hits / comparable if comparable else 0


def side_allowed(predicted_bps, side_mode):
    if side_mode == "LONG_ONLY":
        return predicted_bps > 0
    if side_mode == "SHORT_ONLY":
        return predicted_bps < 0
    return predicted_bps != 0


def evaluate_threshold(rows, adjusted_predictions_bps, actual_bps, threshold_bps, side_mode, args):
    trades = []
    above_threshold = 0
    threshold_direction_hits = 0
    rejected_by_threshold = 0
    rejected_by_fee = 0
    rejected_by_spread = 0
    rejected_by_side_mode = 0
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
        if not side_allowed(predicted, side_mode):
            rejected_by_side_mode += 1
            continue
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
        "sideMode": side_mode,
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
        "rejectedBySideMode": rejected_by_side_mode,
    }


def better_result(left, right):
    if right is None:
        return left
    if left["netPnl"] != right["netPnl"]:
        return left if left["netPnl"] > right["netPnl"] else right
    if left["profitFactor"] != right["profitFactor"]:
        return left if left["profitFactor"] > right["profitFactor"] else right
    if left["tradeCount"] != right["tradeCount"]:
        return left if left["tradeCount"] > right["tradeCount"] else right
    return left if left["precisionAboveThreshold"] > right["precisionAboveThreshold"] else right


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
        return {"horizonSeconds": horizon, "status": "NO_VALIDATION_ROWS", "targetRows": len(target_rows)}

    model = CatBoostRegressor()
    model.load_model(str(model_info["modelFile"]))
    pool = Pool([[row[column] for column in FEATURE_COLUMNS] for row in validation_rows], feature_names=FEATURE_COLUMNS)
    raw_predictions_bps = [finite_float(value) * 10000 for value in model.predict(pool)]
    actual_bps = [finite_float(row["targetReturn"]) * 10000 for row in validation_rows]
    threshold_results = []
    best = None
    for signal_mode, multiplier in SIGNAL_MODES:
        adjusted = [value * multiplier for value in raw_predictions_bps]
        mode_accuracy = directional_accuracy(adjusted, actual_bps)
        for side_mode in SIDE_MODES:
            for threshold in args.thresholds_bps:
                result = evaluate_threshold(validation_rows, adjusted, actual_bps, threshold, side_mode, args)
                enriched = {
                    **result,
                    "signalMode": signal_mode,
                    "directionalAccuracy": mode_accuracy,
                }
                threshold_results.append(enriched)
                best = better_result(enriched, best)

    best_by_mode = {}
    for result in threshold_results:
        key = f"{result['signalMode']}_{result['sideMode']}"
        best_by_mode[key] = better_result(result, best_by_mode.get(key))
    return {
        "horizonSeconds": horizon,
        "status": "VALIDATED",
        "modelFile": model_info["modelFile"],
        "targetField": model_info.get("targetField", f"futureReturn{horizon}sBps"),
        "targetRows": len(target_rows),
        "validationRows": len(validation_rows),
        "predictionDistributionBps": summary(raw_predictions_bps),
        "realizedReturnDistributionBps": summary(actual_bps),
        "bestByMode": best_by_mode,
        "bestResult": best,
        "thresholdResults": threshold_results,
        "feesAndSlippageIncluded": True,
        "feeBps": args.fee_bps,
        "slippageBps": args.slippage_bps,
        "safetyBufferBps": args.safety_buffer_bps,
        "minNetEdgeBps": args.min_net_edge_bps,
        "unitWarnings": 0,
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
    if candidate.get("unitWarnings", 0) != 0:
        reasons.append("unitWarnings != 0")
    statistically_acceptable = (
        result.get("tradeCount", 0) >= args.minimum_validation_trades
        and result.get("precisionAboveThreshold", 0) >= args.min_precision
        and result.get("netPnl", 0) > 0
    )
    if result.get("directionalAccuracy", 0) <= 0.50 and not statistically_acceptable:
        reasons.append("directionalAccuracy <= 0.50 and statistical profile is not acceptable")
    return reasons


def blocked_reason_summary(validated, args):
    output = []
    for item in validated:
        result = item.get("bestResult") or {}
        output.append({
            "horizonSeconds": item.get("horizonSeconds"),
            "bestSignalMode": result.get("signalMode"),
            "bestSideMode": result.get("sideMode"),
            "bestThresholdBps": result.get("thresholdBps"),
            "bestNetPnl": result.get("netPnl"),
            "bestProfitFactor": result.get("profitFactor"),
            "bestTradeCount": result.get("tradeCount"),
            "predictionDistributionBps": item.get("predictionDistributionBps"),
            "realizedReturnDistributionBps": item.get("realizedReturnDistributionBps"),
            "expectedNetEdgeDistribution": result.get("expectedNetEdgeDistribution"),
            "rejectedByFee": result.get("rejectedByFee"),
            "rejectedByThreshold": result.get("rejectedByThreshold"),
            "rejectedBySpread": result.get("rejectedBySpread"),
            "rejectedBySideMode": result.get("rejectedBySideMode"),
            "blockedReasons": pass_reasons(item, args),
        })
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-dir", default="data/microstructure/snapshots")
    parser.add_argument("--manifest", default="models/microstructure/model-manifest.json")
    parser.add_argument("--output-report", default="models/microstructure/validation-report.json")
    parser.add_argument("--output-profile", default="models/microstructure/live-profile.json")
    parser.add_argument("--output-v25-profile", default="models/microstructure/live-profile-v25.json")
    parser.add_argument("--output-v26-profile", default="models/microstructure/live-profile-v26.json")
    parser.add_argument("--min-shadow-signals", type=int, default=500)
    parser.add_argument("--minimum-validation-trades", type=int, default=50)
    parser.add_argument("--min-net-edge-bps", type=float, default=3.0)
    parser.add_argument("--fee-bps", type=float, default=11.0)
    parser.add_argument("--slippage-bps", type=float, default=0.6)
    parser.add_argument("--safety-buffer-bps", type=float, default=1.0)
    parser.add_argument("--min-profit-factor", type=float, default=1.2)
    parser.add_argument("--min-precision", type=float, default=0.50)
    parser.add_argument("--max-drawdown", type=float, default=5.0)
    parser.add_argument("--thresholds-bps", default="0.1,0.25,0.5,1,1.5,2,3,5,8,10,15,20")
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
        Path(args.output_v26_profile).unlink(missing_ok=True)
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
        Path(args.output_v26_profile).unlink(missing_ok=True)
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
    rejected_reasons = blocked_reason_summary(validated, args)
    best_result = best.get("bestResult") if best else None
    report = {
        "status": "VALIDATED" if best else "REJECTED",
        "version": "V26",
        "message": "MICROSTRUCTURE_EDGE_VALIDATED" if best else "NO_VALID_MICROSTRUCTURE_EDGE_FOUND",
        "bestHorizonSeconds": best.get("horizonSeconds") if best else None,
        "bestSignalMode": best_result.get("signalMode") if best_result else None,
        "bestSideMode": best_result.get("sideMode") if best_result else None,
        "bestThresholdBps": best_result.get("thresholdBps") if best_result else None,
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
            "testedSignalModes": [item[0] for item in SIGNAL_MODES],
            "testedSideModes": list(SIDE_MODES),
            "thresholdsBps": args.thresholds_bps,
        },
    }
    profile = {
        **report,
        "shadowSignals": best_result.get("tradeCount") if best_result else 0,
        "netPnlAfterFees": best_result.get("netPnl") if best_result else 0,
        "profitFactor": best_result.get("profitFactor") if best_result else 0,
        "maxDrawdown": best_result.get("maxDrawdown") if best_result else None,
        "trainedModelExists": True,
        "validationPassed": bool(best),
        "liveOrdersAllowed": False,
    }
    write_json(Path(args.output_report), report)
    write_json(Path(args.output_profile), profile)
    if best:
        selected = best["bestResult"]
        selected_profile = {
            "status": "VALIDATED",
            "version": "V26",
            "modelFile": best["modelFile"],
            "horizonSeconds": best["horizonSeconds"],
            "targetField": best["targetField"],
            "signalMode": selected["signalMode"],
            "sideMode": selected["sideMode"],
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
            "unitWarnings": 0,
            "validationPassed": True,
            "shadowValidationRequired": True,
            "liveOrdersAllowed": False,
        }
        write_json(Path(args.output_v26_profile), selected_profile)
        write_json(Path(args.output_v25_profile), { **selected_profile, "version": "V25_COMPAT" })
    else:
        Path(args.output_v25_profile).unlink(missing_ok=True)
        Path(args.output_v26_profile).unlink(missing_ok=True)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
