"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { summarizeMicroTrades } = require("../src/microstructure");

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writeJson(file, value) {
  ensureDir(file);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

function listSnapshotFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...listSnapshotFiles(full));
    if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(full);
  }
  return output;
}

function countLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

async function main() {
  const config = loadConfig();
  const snapshotFiles = listSnapshotFiles(config.microSnapshotDir);
  const snapshotCount = snapshotFiles.reduce((sum, file) => sum + countLines(file), 0);
  const shadowTrades = fs.existsSync(config.microShadowTradesFile)
    ? JSON.parse(fs.readFileSync(config.microShadowTradesFile, "utf8"))
    : [];
  const shadowSummary = summarizeMicroTrades(shadowTrades);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "MICROSTRUCTURE_RESEARCH",
    noLiveOrders: true,
    liveExecutionEngineTouched: false,
    symbols: config.microSymbols,
    dataRequirements: {
      source: "Bybit public websocket orderbook.1 and publicTrade streams",
      snapshotFrequency: "1 second",
      predictionTarget: `log(mid[t+${config.microPredictionHorizonSeconds}s] / mid[t])`,
      horizonsSeconds: config.microPredictionHorizonsSeconds,
      requiredFields: [
        "best bid/ask",
        "bid/ask size",
        "public trade side/size/price",
        "timestamp",
      ],
    },
    snapshotFiles,
    snapshotCount,
    pythonPipeline: {
      train: "python/microstructure/train_micro_model.py",
      validate: "python/microstructure/validate_micro_model.py",
      predict: "python/microstructure/predict_micro_signal.py",
      modelsDir: config.microModelDir,
      modelType: "CatBoostRegressor/CatBoostClassifier when catboost is installed",
      validation: "walk-forward with purge gap; no random k-fold",
    },
    shadowSummary,
    liveActivationRequirements: {
      minimumShadowSignals: config.microShadowMinSignals,
      positiveNetPerformanceAfterFees: true,
      liveProfileFile: config.microLiveProfileFile,
      takerOnly: true,
    },
  };
  writeJson(config.microLatestSummaryFile, report);
  console.log(JSON.stringify({
    message: "V24 microstructure research report generated.",
    snapshotCount,
    latestSummary: config.microLatestSummaryFile,
    noLiveOrders: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
