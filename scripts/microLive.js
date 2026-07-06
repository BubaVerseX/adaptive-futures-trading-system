"use strict";

const fs = require("node:fs");
const { loadConfig } = require("../src/config");
const { loadMicroLiveProfileV26, microModelStatus } = require("../src/microstructure");

function fail(message, details = {}) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${message} ${JSON.stringify(details)}`);
  process.exitCode = 1;
}

function evaluateShadowPerformanceLock(latest = {}, config = {}) {
  const acceptedTrades = Number(latest.acceptedShadowTrades || latest.tradesTaken || 0);
  const blockers = [];
  if (!latest.modelReady) blockers.push("trained microstructure model was not used by latest shadow run");
  if (acceptedTrades < config.microShadowMinSignals) blockers.push(`accepted shadow trades ${acceptedTrades} < ${config.microShadowMinSignals}`);
  if (Number(latest.netPnl || latest.netPnlAfterFees || 0) <= 0) blockers.push("shadow netPnl is not positive after fees");
  if (Number(latest.profitFactor || 0) <= 1.2) blockers.push(`profitFactor ${latest.profitFactor || 0} <= 1.2`);
  if (Number(latest.maxDrawdown || 0) > config.microMaxDrawdownUsdt) blockers.push(`maxDrawdown ${latest.maxDrawdown} > ${config.microMaxDrawdownUsdt}`);
  if (Number(latest.unitValidationWarnings || 0) > 0) blockers.push(`unit validation warnings ${latest.unitValidationWarnings} > 0`);
  return blockers;
}

async function main() {
  const config = loadConfig();
  console.log(`[${new Date().toISOString()}] [WARN] V24 MICROSTRUCTURE TAKER ENGINE ACTIVE`);
  console.log(`[${new Date().toISOString()}] [WARN] MICRO LIVE MODE REQUESTED — TAKER ONLY — REAL FUNDS POSSIBLE`);
  if (!config.microLiveAcknowledged || !config.acknowledgeLiveTrading || config.dryRun || config.bybitTestnet || config.bybitDemoTrading) {
    fail("MICRO LIVE NOT STARTED — explicit live acknowledgement and mainnet DRY_RUN=false are required.", {
      microLiveAcknowledged: config.microLiveAcknowledged,
      acknowledgeLiveTrading: config.acknowledgeLiveTrading,
      dryRun: config.dryRun,
      bybitTestnet: config.bybitTestnet,
      bybitDemoTrading: config.bybitDemoTrading,
    });
    return;
  }
  if (!fs.existsSync(config.microLiveProfileV26File)) {
    fail("MICRO LIVE NOT STARTED — V26 validated microstructure live profile is missing.", {
      requiredProfile: config.microLiveProfileV26File,
      runFirst: "npm run micro:finalize",
    });
    return;
  }
  const model = microModelStatus(config);
  if (!model.ready) {
    fail("MICRO LIVE NOT STARTED — trained model is missing.", {
      reason: model.reason,
      manifest: config.microModelManifestFile,
      runFirst: "npm run micro:finalize",
    });
    return;
  }
  if (!fs.existsSync(config.microFinalReadinessFile)) {
    fail("MICRO LIVE NOT STARTED — V26 final readiness report is missing.", {
      requiredReadiness: config.microFinalReadinessFile,
      runFirst: "npm run micro:finalize",
    });
    return;
  }
  const readiness = JSON.parse(fs.readFileSync(config.microFinalReadinessFile, "utf8"));
  if (!readiness.eligible) {
    fail("MICRO LIVE NOT STARTED — V26 final readiness lock failed.", {
      status: readiness.status,
      blockers: readiness.blockers || readiness.reason || [],
      finalReadiness: config.microFinalReadinessFile,
      runFirst: "npm run micro:finalize",
    });
    return;
  }
  if (!fs.existsSync(config.microShadowV26ReportFile)) {
    fail("MICRO LIVE NOT STARTED — V26 shadow report is missing.", {
      requiredShadowReport: config.microShadowV26ReportFile,
      runFirst: "npm run micro:finalize",
    });
    return;
  }
  const latest = JSON.parse(fs.readFileSync(config.microShadowV26ReportFile, "utf8"));
  const blockers = evaluateShadowPerformanceLock(latest, { ...config, microShadowMinSignals: readiness.shadowMinimumSignalsRequired || config.microShadowQuickMinSignals || config.microShadowMinSignals });
  if (blockers.length) {
    fail("MICRO LIVE NOT STARTED — V26 shadow performance lock failed.", {
      blockers,
      shadowReport: config.microShadowV26ReportFile,
    });
    return;
  }
  const profile = loadMicroLiveProfileV26(config);
  if (
    !profile ||
    profile.status !== "VALIDATED" ||
    !profile.validationPassed ||
    profile.tradeCount < 50 ||
    Number(profile.netPnlAfterFees || 0) <= 0 ||
    Number(profile.profitFactor || 0) <= 1.2
  ) {
    fail("MICRO LIVE NOT STARTED — profile has not proven positive shadow/model performance after fees.", {
      profileStatus: profile && profile.status,
      validationPassed: profile && profile.validationPassed,
      tradeCount: profile && profile.tradeCount,
      netPnlAfterFees: profile && profile.netPnlAfterFees,
      profile: config.microLiveProfileV26File,
    });
    return;
  }
  console.log(JSON.stringify({
    status: "READY_BUT_NOT_STARTED_BY_SCRIPT",
    message: "Profile passed guards. Wire this profile into the existing order/risk manager before enabling live taker orders.",
    profile: config.microLiveProfileV26File,
    finalReadiness: config.microFinalReadinessFile,
    takerOnly: true,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  evaluateShadowPerformanceLock,
};
