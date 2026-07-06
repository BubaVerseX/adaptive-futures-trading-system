"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { loadConfig } = require("../src/config");

function run() {
  const config = loadConfig();
  const script = path.join(config.projectRoot, "python", "microstructure", "train_micro_model.py");
  const args = [
    script,
    "--snapshot-dir", config.microSnapshotDir,
    "--output-dir", config.microModelDir,
    "--horizons", config.microPredictionHorizonsSeconds.join(","),
    "--min-snapshots-per-symbol", String(config.microTrainingMinSnapshotsPerSymbol),
  ];
  console.log(JSON.stringify({
    message: "MICRO_TRAINING_START",
    noLiveOrders: true,
    snapshotDir: config.microSnapshotDir,
    outputDir: config.microModelDir,
    horizonsSeconds: config.microPredictionHorizonsSeconds,
    minimumSnapshotsPerSymbol: config.microTrainingMinSnapshotsPerSymbol,
  }, null, 2));
  const result = spawnSync(config.microPythonBin, args, {
    cwd: config.projectRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  process.exitCode = result.status || 0;
}

run();
