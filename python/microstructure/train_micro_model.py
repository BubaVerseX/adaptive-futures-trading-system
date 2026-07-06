#!/usr/bin/env python3
"""Train V24 microstructure CatBoost models from cached shadow snapshots.

Research-only. This script never connects to Bybit and cannot place orders.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterable


FEATURE_COLUMNS = [
    "relativeSpread",
    "bestBidSize",
    "bestAskSize",
    "l1OrderBookImbalance",
    "micropriceDeviationFromMid",
    "signedTradeVolume",
    "netOrderFlow",
    "buyVolume",
    "sellVolume",
    "tradeImbalance",
    "vwapBuyToMidDeviation",
    "vwapSellToMidDeviation",
    "totalTradedVolume",
    "numberOfTrades",
    "tradePriceVariance",
    "shortRealizedVolatility",
    "volumeConcentration",
    "spreadZScore",
    "imbalanceZScore",
    "orderFlowPressureScore",
]


def finite(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def list_snapshot_files(snapshot_dir: Path) -> list[Path]:
    if not snapshot_dir.exists():
        return []
    return sorted(path for path in snapshot_dir.rglob("*.jsonl") if path.is_file())


def load_rows(paths: Iterable[Path]) -> list[dict]:
    rows: list[dict] = []
    skipped_bad = 0
    for path in paths:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                item = json.loads(line)
                features = item.get("features", {})
                row = {
                    "timestamp": item.get("timestamp"),
                    "symbol": item.get("symbol"),
                    "midPrice": features.get("midPrice"),
                }
                row.update({column: features.get(column, 0.0) for column in FEATURE_COLUMNS})
                if not row["symbol"] or not finite(row["timestamp"]) or not finite(row["midPrice"]):
                    skipped_bad += 1
                    continue
                if any(not finite(row[column]) for column in FEATURE_COLUMNS):
                    skipped_bad += 1
                    continue
                rows.append(row)
    rows = sorted(rows, key=lambda row: (row["symbol"], int(row["timestamp"])))
    for row in rows:
        row["_skippedBadRows"] = skipped_bad
    return rows


def counts_by_symbol(rows: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["symbol"]] = counts.get(row["symbol"], 0) + 1
    return counts


def add_targets(rows: list[dict], horizon_seconds: int) -> list[dict]:
    by_symbol: dict[str, list[dict]] = {}
    for row in rows:
        by_symbol.setdefault(row["symbol"], []).append(row)
    output: list[dict] = []
    horizon_ms = horizon_seconds * 1000
    for symbol_rows in by_symbol.values():
        by_time = {int(row["timestamp"]): row for row in symbol_rows if row.get("timestamp") is not None}
        for row in symbol_rows:
            future = by_time.get(int(row["timestamp"]) + horizon_ms)
            if not future:
                continue
            mid = float(row.get("midPrice") or 0)
            future_mid = float(future.get("midPrice") or 0)
            if mid <= 0 or future_mid <= 0:
                continue
            enriched = dict(row)
            target = math.log(future_mid / mid)
            enriched[f"targetReturn_{horizon_seconds}s"] = target
            enriched["targetReturn"] = target
            enriched["targetReturnBps"] = target * 10000
            enriched["targetDirection"] = 1 if target > 0 else 0
            output.append(enriched)
    return output


def direction_weighted_score(y_true, y_pred) -> float:
    total = 0.0
    weight = 0.0
    for actual, predicted in zip(y_true, y_pred):
        magnitude = abs(float(actual))
        if magnitude == 0:
            continue
        total += (1.0 if actual * predicted > 0 else -1.0) * magnitude
        weight += magnitude
    return total / weight if weight else 0.0


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshots", nargs="*", default=[], help="Optional snapshot JSONL files.")
    parser.add_argument("--snapshot-dir", default="data/microstructure/snapshots")
    parser.add_argument("--output-dir", default="models/microstructure")
    parser.add_argument("--horizons", default="3,5,10,30")
    parser.add_argument("--min-snapshots-per-symbol", type=int, default=10000)
    args = parser.parse_args()

    snapshot_paths = [Path(item) for item in args.snapshots] if args.snapshots else list_snapshot_files(Path(args.snapshot_dir))
    output_dir = Path(args.output_dir)
    rows = load_rows(snapshot_paths)
    symbol_counts = counts_by_symbol(rows)
    required_symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    not_ready = [symbol for symbol in required_symbols if symbol_counts.get(symbol, 0) < args.min_snapshots_per_symbol]
    base_report = {
        "status": "NOT_READY" if not_ready else "READY_TO_TRAIN",
        "snapshotFiles": [str(path) for path in snapshot_paths],
        "rows": len(rows),
        "skippedBadRows": rows[0].get("_skippedBadRows", 0) if rows else 0,
        "snapshotsBySymbol": symbol_counts,
        "minimumSnapshotsPerSymbol": args.min_snapshots_per_symbol,
        "notReadySymbols": not_ready,
        "horizonsSeconds": [int(item.strip()) for item in args.horizons.split(",") if item.strip()],
    }
    if not_ready:
        write_json(output_dir / "training-report.json", base_report)
        write_json(output_dir / "model-manifest.json", { **base_report, "models": [] })
        print(json.dumps(base_report, indent=2))
        return

    try:
        from catboost import CatBoostRegressor, Pool
    except ImportError as exc:
        report = { **base_report, "status": "CATBOOST_MISSING", "error": str(exc) }
        write_json(output_dir / "training-report.json", report)
        write_json(output_dir / "model-manifest.json", { **report, "models": [] })
        print(json.dumps(report, indent=2))
        raise SystemExit(1) from exc

    models = []
    for horizon in base_report["horizonsSeconds"]:
        target_rows = add_targets(rows, horizon)
        split = int(len(target_rows) * 0.7)
        purge = max(30, horizon * 5)
        train_rows = target_rows[: max(0, split - purge)]
        validation_rows = target_rows[split:]
        if len(train_rows) < 1000 or len(validation_rows) < 250:
            models.append({
                "horizonSeconds": horizon,
                "status": "NOT_ENOUGH_TARGET_ROWS",
                "targetRows": len(target_rows),
                "trainRows": len(train_rows),
                "validationRows": len(validation_rows),
            })
            continue
        train_pool = Pool(
            [[row[column] for column in FEATURE_COLUMNS] for row in train_rows],
            [row["targetReturn"] for row in train_rows],
            feature_names=FEATURE_COLUMNS,
        )
        validation_pool = Pool(
            [[row[column] for column in FEATURE_COLUMNS] for row in validation_rows],
            [row["targetReturn"] for row in validation_rows],
            feature_names=FEATURE_COLUMNS,
        )
        model = CatBoostRegressor(iterations=300, depth=6, learning_rate=0.05, loss_function="RMSE", verbose=False)
        model.fit(train_pool, eval_set=validation_pool)
        predictions = model.predict(validation_pool)
        score = direction_weighted_score([row["targetReturn"] for row in validation_rows], predictions)
        model_path = output_dir / f"microstructure_{horizon}s.cbm"
        model.save_model(str(model_path))
        importance = model.get_feature_importance(validation_pool, type="FeatureImportance")
        models.append({
            "horizonSeconds": horizon,
            "status": "TRAINED",
            "modelFile": str(model_path),
            "targetRows": len(target_rows),
            "trainRows": len(train_rows),
            "validationRows": len(validation_rows),
            "directionWeightedScore": score,
            "featureImportance": sorted(
                [{"feature": feature, "importance": float(value)} for feature, value in zip(FEATURE_COLUMNS, importance)],
                key=lambda item: item["importance"],
                reverse=True,
            ),
        })

    trained = [model for model in models if model.get("status") == "TRAINED"]
    report = {
        **base_report,
        "status": "TRAINED" if trained else "NO_TRAINED_MODELS",
        "models": models,
    }
    write_json(output_dir / "training-report.json", report)
    write_json(output_dir / "model-manifest.json", report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
