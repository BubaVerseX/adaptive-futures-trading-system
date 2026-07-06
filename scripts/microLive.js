"use strict";

const fs = require("node:fs");
const { loadConfig } = require("../src/config");
const { loadMicroProfile } = require("../src/microstructure");

function fail(message, details = {}) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${message} ${JSON.stringify(details)}`);
  process.exitCode = 1;
}

function evaluateShadowPerformanceLock(latest = {}, config = {}) {
  const signalCount = Number(latest.totalRawSignals || latest.totalSignals || latest.shadowSignals || 0);
  const blockers = [];
  if (signalCount < config.microShadowMinSignals) blockers.push(`shadow signals ${signalCount} < ${config.microShadowMinSignals}`);
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
  if (!fs.existsSync(config.microLiveProfileFile)) {
    fail("MICRO LIVE NOT STARTED — validated microstructure live profile is missing.", {
      requiredProfile: config.microLiveProfileFile,
      runFirst: "npm run micro:shadow, then python/microstructure/validate_micro_model.py",
    });
    return;
  }
  if (!fs.existsSync(config.microLatestSummaryFile)) {
    fail("MICRO LIVE NOT STARTED — latest shadow summary is missing.", {
      requiredSummary: config.microLatestSummaryFile,
      runFirst: "npm run micro:shadow -- --duration-minutes 240 --min-signals 500",
    });
    return;
  }
  const latest = JSON.parse(fs.readFileSync(config.microLatestSummaryFile, "utf8"));
  const blockers = evaluateShadowPerformanceLock(latest, config);
  if (blockers.length) {
    fail("MICRO LIVE NOT STARTED — shadow performance lock failed.", {
      blockers,
      latestSummary: config.microLatestSummaryFile,
    });
    return;
  }
  const profile = loadMicroProfile(config.microLiveProfileFile);
  if (!profile || profile.status !== "VALIDATED" || profile.shadowSignals < config.microShadowMinSignals || Number(profile.netPnlAfterFees || 0) <= 0) {
    fail("MICRO LIVE NOT STARTED — profile has not proven positive shadow/model performance after fees.", {
      profileStatus: profile && profile.status,
      shadowSignals: profile && profile.shadowSignals,
      netPnlAfterFees: profile && profile.netPnlAfterFees,
      minimumShadowSignals: config.microShadowMinSignals,
    });
    return;
  }
  console.log(JSON.stringify({
    status: "READY_BUT_NOT_STARTED_BY_SCRIPT",
    message: "Profile passed guards. Wire this profile into the existing order/risk manager before enabling live taker orders.",
    profile: config.microLiveProfileFile,
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
