"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { loadConfig } = require("../src/config");

function run() {
  const config = loadConfig();
  const script = path.join(config.projectRoot, "python", "microstructure", "validate_micro_model.py");
  const feeBps = Number(config.estimatedTakerFeePctPerSide || config.estimatedFeePctPerSide || 0.055) * 2 * 100;
  const args = [
    script,
    "--snapshot-dir", config.microSnapshotDir,
    "--manifest", config.microModelManifestFile,
    "--output-report", config.microValidationReportFile,
    "--output-profile", config.microLiveProfileFile,
    "--output-v25-profile", config.microLiveProfileV25File,
    "--min-shadow-signals", String(config.microShadowMinSignals),
    "--min-net-edge-bps", String(config.microMinNetEdgeBps),
    "--fee-bps", String(config.microTakerFeeBps ?? feeBps),
    "--slippage-bps", String(config.microSlippageBps ?? config.microEstimatedSlippageBps),
    "--safety-buffer-bps", String(config.microSafetyBufferBps),
    "--min-profit-factor", "1.2",
    "--label-tolerance-ms", String(config.microLabelToleranceMs),
    "--thresholds-bps", config.microThresholdSweepBps.join(","),
    "--max-drawdown", String(config.microValidationMaxDrawdown),
  ];
  console.log(JSON.stringify({
    message: "MICRO_VALIDATION_START",
    noLiveOrders: true,
    snapshotDir: config.microSnapshotDir,
    manifest: config.microModelManifestFile,
    outputReport: config.microValidationReportFile,
    outputV25Profile: config.microLiveProfileV25File,
    thresholdsBps: config.microThresholdSweepBps,
  }, null, 2));
  const result = spawnSync(config.microPythonBin, args, {
    cwd: config.projectRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  process.exitCode = result.status || 0;
}

run();
