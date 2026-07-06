#!/usr/bin/env python3
"""Train V24 microstructure CatBoost models from 1-second snapshot JSONL data.

This script is research-only. It does not connect to Bybit and cannot place orders.
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


def load_rows(paths: Iterable[Path]) -> list[dict]:
    rows: list[dict] = []
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
                rows.append(row)
    return sorted(rows, key=lambda row: (row["symbol"], row["timestamp"]))


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
            enriched["targetReturn"] = math.log(future_mid / mid)
            enriched["targetDirection"] = 1 if enriched["targetReturn"] > 0 else 0
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshots", nargs="+", required=True, help="Snapshot JSONL files.")
    parser.add_argument("--output-dir", default="models/microstructure")
    parser.add_argument("--horizon-seconds", type=int, default=3)
    args = parser.parse_args()

    try:
        from catboost import CatBoostRegressor, Pool
    except ImportError as exc:
        raise SystemExit("CatBoost is required for V24 training: pip install catboost pandas") from exc

    rows = add_targets(load_rows([Path(item) for item in args.snapshots]), args.horizon_seconds)
    if len(rows) < 1000:
        raise SystemExit(f"Not enough target rows for training: {len(rows)}")

    split = int(len(rows) * 0.7)
    purge = max(30, args.horizon_seconds * 5)
    train_rows = rows[: max(0, split - purge)]
    validation_rows = rows[split:]
    train_pool = Pool([[row[column] for column in FEATURE_COLUMNS] for row in train_rows], [row["targetReturn"] for row in train_rows], feature_names=FEATURE_COLUMNS)
    validation_pool = Pool([[row[column] for column in FEATURE_COLUMNS] for row in validation_rows], [row["targetReturn"] for row in validation_rows], feature_names=FEATURE_COLUMNS)
    model = CatBoostRegressor(iterations=300, depth=6, learning_rate=0.05, loss_function="RMSE", verbose=False)
    model.fit(train_pool, eval_set=validation_pool)
    predictions = model.predict(validation_pool)
    score = direction_weighted_score([row["targetReturn"] for row in validation_rows], predictions)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / "microstructure_universal.cbm"
    model.save_model(str(model_path))
    importance = model.get_feature_importance(validation_pool, type="FeatureImportance")
    report = {
        "status": "TRAINED",
        "model": str(model_path),
        "horizonSeconds": args.horizon_seconds,
        "rows": len(rows),
        "trainRows": len(train_rows),
        "validationRows": len(validation_rows),
        "directionWeightedScore": score,
        "featureImportance": sorted(
            [{"feature": feature, "importance": float(value)} for feature, value in zip(FEATURE_COLUMNS, importance)],
            key=lambda item: item["importance"],
            reverse=True,
        ),
    }
    (output_dir / "training-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
