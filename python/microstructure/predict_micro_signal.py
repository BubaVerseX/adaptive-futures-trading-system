#!/usr/bin/env python3
"""Predict a V24 microstructure return from one feature JSON object."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from train_micro_model import FEATURE_COLUMNS


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="models/microstructure/microstructure_universal.cbm")
    parser.add_argument("--features", required=True, help="JSON file containing either features or a snapshot with features.")
    args = parser.parse_args()

    try:
      from catboost import CatBoostRegressor, Pool
    except ImportError as exc:
      raise SystemExit("CatBoost is required for V24 prediction: pip install catboost") from exc

    payload = json.loads(Path(args.features).read_text(encoding="utf-8"))
    features = payload.get("features", payload)
    model = CatBoostRegressor()
    model.load_model(args.model)
    pool = Pool([[features.get(column, 0.0) for column in FEATURE_COLUMNS]], feature_names=FEATURE_COLUMNS)
    prediction = float(model.predict(pool)[0])
    print(json.dumps({
        "predictedReturn": prediction,
        "predictedReturnPct": prediction * 100,
        "predictedReturnBps": prediction * 10000,
        "direction": "LONG" if prediction > 0 else "SHORT" if prediction < 0 else "FLAT",
    }, indent=2))


if __name__ == "__main__":
    main()
