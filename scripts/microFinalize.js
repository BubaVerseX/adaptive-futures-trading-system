"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { loadConfig } = require("../src/config");

const REQUIRED_GITIGNORE_LINES = [
  "micro-env/",
  "__pycache__/",
  "*.pyc",
  "*.so",
  "node_modules/",
  "data/microstructure/snapshots/",
  "data/microstructure/bybit-bot.log",
];

const INSTALL_COMMAND = [
  "python3 -m venv micro-env",
  "source micro-env/bin/activate",
  "pip install catboost pandas numpy scikit-learn joblib",
].join("\n");

function readJson(file, fallback = null) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function log(message, details = {}) {
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function appendMissingGitignoreLines(config) {
  const file = path.join(config.projectRoot, ".gitignore");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = REQUIRED_GITIGNORE_LINES.filter((line) => !lines.has(line));
  if (missing.length) {
    const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
    fs.appendFileSync(file, `${prefix}${missing.join("\n")}\n`, "utf8");
  }
  return { updated: missing.length > 0, missingAdded: missing };
}

function untrackMicroEnvIfNeeded(config) {
  const listed = spawnSync("git", ["ls-files", "micro-env"], {
    cwd: config.projectRoot,
    encoding: "utf8",
  });
  const tracked = listed.status === 0 && listed.stdout.trim().length > 0;
  if (!tracked) return { tracked: false, untracked: false };
  const result = spawnSync("git", ["rm", "-r", "--cached", "micro-env"], {
    cwd: config.projectRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    tracked: true,
    untracked: result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function verifyPythonDependencies(config) {
  const result = spawnSync(config.microPythonBin, [
    "-c",
    "import catboost, pandas, numpy, sklearn, joblib; print('MICRO_PYTHON_DEPS_OK')",
  ], {
    cwd: config.projectRoot,
    encoding: "utf8",
  });
  if (result.status === 0) return { ok: true, python: config.microPythonBin };
  return {
    ok: false,
    python: config.microPythonBin,
    installCommand: INSTALL_COMMAND,
    stderr: result.stderr,
    stdout: result.stdout,
    error: result.error && result.error.message,
  };
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed);
}

async function countCleanSnapshots(config) {
  const counts = Object.fromEntries(config.microSymbols.map((symbol) => [symbol, 0]));
  const badCounts = Object.fromEntries(config.microSymbols.map((symbol) => [symbol, 0]));
  if (!fs.existsSync(config.microSnapshotDir)) {
    return { ok: false, counts, badCounts, missing: config.microSymbols, files: 0 };
  }
  const files = [];
  const stack = [config.microSnapshotDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  for (const file of files) {
    await new Promise((resolve, reject) => {
      const reader = readline.createInterface({
        input: fs.createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      reader.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const item = JSON.parse(line);
          const symbol = item.symbol;
          if (!Object.hasOwn(counts, symbol)) return;
          const features = item.features || {};
          const clean = finite(item.timestamp) &&
            finite(features.midPrice) &&
            Number(features.midPrice) > 0 &&
            finite(features.relativeSpread) &&
            finite(features.bestBidSize) &&
            finite(features.bestAskSize);
          if (clean) counts[symbol] += 1;
          else badCounts[symbol] += 1;
        } catch (_error) {
          for (const symbol of Object.keys(badCounts)) badCounts[symbol] += 1;
        }
      });
      reader.on("close", resolve);
      reader.on("error", reject);
    });
  }
  const missing = config.microSymbols.filter((symbol) => counts[symbol] < config.microTrainingMinSnapshotsPerSymbol);
  return {
    ok: missing.length === 0,
    counts,
    badCounts,
    missing,
    files: files.length,
    minimumSnapshotsPerSymbol: config.microTrainingMinSnapshotsPerSymbol,
  };
}

function runNpmScript(config, scriptName, extraArgs = []) {
  log(`MICRO_FINALIZE_STEP_START:${scriptName}`, { extraArgs });
  const result = spawnSync("npm", ["run", scriptName, ...extraArgs], {
    cwd: config.projectRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    error: result.error && result.error.message,
  };
}

function validationPasses(profile) {
  if (!profile) return false;
  return profile.status === "VALIDATED" &&
    profile.validationPassed === true &&
    Number(profile.netPnlAfterFees || 0) > 0 &&
    Number(profile.profitFactor || 0) > 1.2 &&
    Number(profile.tradeCount || 0) >= 50 &&
    Number(profile.unitWarnings || 0) === 0;
}

function shadowPasses(report, minimumSignals, config) {
  if (!report) return { passed: false, blockers: ["shadow report missing"] };
  const acceptedTrades = Number(report.acceptedShadowTrades || report.tradesTaken || 0);
  const blockers = [];
  if (!report.modelReady) blockers.push("trained V26 model was not used by shadow run");
  if (acceptedTrades < minimumSignals) blockers.push(`accepted shadow trades ${acceptedTrades} < ${minimumSignals}`);
  if (Number(report.netPnl || report.netPnlAfterFees || 0) <= 0) blockers.push("shadow netPnl is not positive after fees");
  if (Number(report.profitFactor || 0) <= 1.2) blockers.push(`profitFactor ${report.profitFactor || 0} <= 1.2`);
  if (Number(report.maxDrawdown || 0) > config.microMaxDrawdownUsdt) blockers.push(`maxDrawdown ${report.maxDrawdown} > ${config.microMaxDrawdownUsdt}`);
  if (Number(report.unitValidationWarnings || 0) > 0) blockers.push(`unit validation warnings ${report.unitValidationWarnings} > 0`);
  return { passed: blockers.length === 0, blockers };
}

function summarizeBest(validationReport, profile) {
  const rejected = Array.isArray(validationReport && validationReport.rejectedReasons)
    ? validationReport.rejectedReasons
    : [];
  const bestRejected = rejected
    .slice()
    .sort((a, b) => Number(b.bestNetPnl || 0) - Number(a.bestNetPnl || 0))[0] || null;
  return {
    horizonSeconds: profile ? profile.horizonSeconds : validationReport && validationReport.bestHorizonSeconds,
    signalMode: profile ? profile.signalMode : validationReport && validationReport.bestSignalMode,
    sideMode: profile ? profile.sideMode : validationReport && validationReport.bestSideMode,
    thresholdBps: profile ? profile.bestThresholdBps : validationReport && validationReport.bestThresholdBps,
    tradeCount: profile ? profile.tradeCount : bestRejected && bestRejected.bestTradeCount,
    netPnl: profile ? profile.netPnlAfterFees : bestRejected && bestRejected.bestNetPnl,
    profitFactor: profile ? profile.profitFactor : bestRejected && bestRejected.bestProfitFactor,
    maxDrawdown: profile ? profile.maxDrawdown : null,
    blockers: profile ? [] : (bestRejected && bestRejected.blockedReasons) || [],
  };
}

async function main() {
  const config = loadConfig();
  fs.mkdirSync(config.microReportsDir, { recursive: true });
  log("MICRO_FINALIZE_STARTED", {
    noLiveOrders: true,
    normalTrendBotUntouched: true,
    symbols: config.microSymbols,
  });

  const readiness = {
    version: "V26",
    status: "STARTED",
    eligible: false,
    generatedAt: new Date().toISOString(),
    noLiveOrders: true,
    profileFile: config.microLiveProfileV26File,
    finalReadinessFile: config.microFinalReadinessFile,
    blockers: [],
  };

  readiness.repoCleanup = {
    gitignore: appendMissingGitignoreLines(config),
    microEnvTracking: untrackMicroEnvIfNeeded(config),
  };

  const deps = verifyPythonDependencies(config);
  readiness.pythonDependencies = deps;
  if (!deps.ok) {
    readiness.status = "NOT_READY";
    readiness.reason = "CATBOOST_OR_PYTHON_DEPENDENCY_MISSING";
    readiness.blockers.push("CatBoost/pandas/numpy/scikit-learn/joblib dependencies are missing.");
    readiness.recommendedNextAction = deps.installCommand;
    writeJson(config.microFinalReadinessFile, readiness);
    console.log("NOT_READY_FOR_LIVE");
    console.log(readiness.reason);
    console.log(deps.installCommand);
    return;
  }

  const snapshots = await countCleanSnapshots(config);
  readiness.snapshotValidation = snapshots;
  if (!snapshots.ok) {
    readiness.status = "NOT_READY";
    readiness.reason = "INSUFFICIENT_CLEAN_MICROSTRUCTURE_SNAPSHOTS";
    readiness.blockers.push(`Missing clean snapshots: ${snapshots.missing.join(", ")}`);
    readiness.recommendedNextAction = "Run npm run micro:shadow to collect more clean snapshots before training.";
    writeJson(config.microFinalReadinessFile, readiness);
    console.log("NOT_READY_FOR_LIVE");
    console.log(JSON.stringify({ reason: readiness.reason, counts: snapshots.counts, missing: snapshots.missing }, null, 2));
    return;
  }

  const training = runNpmScript(config, "micro:train");
  readiness.training = {
    ...training,
    report: config.microTrainingReportFile,
    trained: training.ok,
  };
  if (!training.ok) {
    readiness.status = "NOT_READY";
    readiness.reason = "MICRO_TRAINING_FAILED";
    readiness.blockers.push("micro:train command failed.");
    readiness.recommendedNextAction = "Inspect models/microstructure/training-report.json and rerun npm run micro:train.";
    writeJson(config.microFinalReadinessFile, readiness);
    console.log("NOT_READY_FOR_LIVE");
    console.log(readiness.reason);
    return;
  }

  const validation = runNpmScript(config, "micro:validate");
  const validationReport = readJson(config.microValidationReportFile, null);
  const profile = readJson(config.microLiveProfileV26File, null);
  readiness.validation = {
    ...validation,
    report: config.microValidationReportFile,
    profile: config.microLiveProfileV26File,
    passed: validation.ok && validationPasses(profile),
    best: summarizeBest(validationReport, profile),
    status: validationReport && validationReport.status,
    message: validationReport && validationReport.message,
  };
  if (!readiness.validation.passed) {
    readiness.status = "NOT_READY";
    readiness.reason = "NO_VALID_MICROSTRUCTURE_EDGE_FOUND";
    readiness.blockers.push("No V26 profile passed net PnL, profit factor, trade count, drawdown, and unit-warning gates.");
    readiness.recommendedNextAction = "Collect more snapshots across different market regimes, then rerun npm run micro:finalize.";
    writeJson(config.microFinalReadinessFile, readiness);
    console.log("NOT_READY_FOR_LIVE");
    console.log(JSON.stringify({
      reason: readiness.reason,
      best: readiness.validation.best,
      report: config.microValidationReportFile,
    }, null, 2));
    return;
  }

  const minSignals = config.microShadowQuickMinSignals || 50;
  const shadow = runNpmScript(config, "micro:shadow", ["--", "--duration-minutes", "240", "--min-signals", String(minSignals)]);
  const latestShadow = readJson(config.microLatestSummaryFile, null);
  if (latestShadow) writeJson(config.microShadowV26ReportFile, latestShadow);
  const shadowGate = shadowPasses(latestShadow, minSignals, config);
  readiness.shadow = {
    ...shadow,
    report: config.microShadowV26ReportFile,
    passed: shadow.ok && shadowGate.passed,
    blockers: shadowGate.blockers,
    minimumSignalsRequired: minSignals,
    fullReadinessSignalsRequired: config.microShadowMinSignals,
    quickReadiness: true,
    summary: latestShadow,
  };
  if (!readiness.shadow.passed) {
    readiness.status = "NOT_READY";
    readiness.reason = "MICRO_SHADOW_VALIDATION_FAILED";
    readiness.blockers.push(...shadowGate.blockers);
    readiness.recommendedNextAction = "Run npm run micro:shadow -- --duration-minutes 240 --min-signals 500 after the model profile improves.";
    writeJson(config.microFinalReadinessFile, readiness);
    console.log("NOT_READY_FOR_LIVE");
    console.log(JSON.stringify({
      reason: readiness.reason,
      blockers: readiness.shadow.blockers,
      shadowReport: config.microShadowV26ReportFile,
    }, null, 2));
    return;
  }

  readiness.status = "READY_FOR_MICRO_LIVE";
  readiness.eligible = true;
  readiness.shadowMinimumSignalsRequired = minSignals;
  readiness.recommendedNextAction = "npm run micro:live";
  writeJson(config.microFinalReadinessFile, readiness);
  console.log("READY_FOR_MICRO_LIVE");
  console.log("npm run micro:live");
}

main().catch((error) => {
  const config = loadConfig();
  const readiness = {
    version: "V26",
    status: "NOT_READY",
    eligible: false,
    generatedAt: new Date().toISOString(),
    noLiveOrders: true,
    reason: "MICRO_FINALIZE_UNHANDLED_ERROR",
    error: error && error.stack ? error.stack : String(error),
    recommendedNextAction: "Inspect the error, fix the pipeline input, then rerun npm run micro:finalize.",
  };
  writeJson(config.microFinalReadinessFile, readiness);
  console.error(error);
  console.log("NOT_READY_FOR_LIVE");
  process.exitCode = 1;
});
