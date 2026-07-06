"use strict";

const { loadConfig } = require("../src/config");
const { MicrostructureCollector, MicrostructureShadowEngine } = require("../src/microstructure");

function log(level, message, details = {}) {
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
  console.log(`[${new Date().toISOString()}] [${level}] ${message}${suffix}`);
}

function parseArgs(argv) {
  const args = { durationMinutes: 240, minSignals: 500 };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--duration-minutes") args.durationMinutes = Number(argv[index + 1]);
    if (token === "--min-signals") args.minSignals = Number(argv[index + 1]);
  }
  if (!Number.isFinite(args.durationMinutes) || args.durationMinutes <= 0) args.durationMinutes = 240;
  if (!Number.isFinite(args.minSignals) || args.minSignals <= 0) args.minSignals = 500;
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = { ...loadConfig(), microShadowMinSignals: args.minSignals };
  const durationMs = Math.round(args.durationMinutes * 60 * 1000);
  log("WARN", "V24 MICROSTRUCTURE TAKER ENGINE ACTIVE - SHADOW MODE ONLY", {
    noLiveOrders: true,
    takerOnly: true,
    symbols: config.microSymbols,
    durationMinutes: args.durationMinutes,
    minSignals: args.minSignals,
  });
  const shadow = new MicrostructureShadowEngine(config, log);
  const collector = new MicrostructureCollector(config, log);
  let done = false;
  const startedAt = Date.now();
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  collector.on("snapshot", (snapshot) => {
    shadow.markToMarket(snapshot);
    shadow.evaluateSnapshot(snapshot);
    const report = shadow.persistReport();
    if (!done && report.totalRawSignals >= args.minSignals) {
      done = true;
      finish("MIN_SIGNALS_REACHED");
    }
  });
  collector.start();
  const timeout = setTimeout(() => {
    if (!done) {
      done = true;
      finish("DURATION_REACHED");
    }
  }, durationMs);
  const reason = await finished;
  clearTimeout(timeout);
  collector.stop();
  const report = shadow.persistReport();
  log("INFO", "MICRO_SHADOW_COMPLETED", {
    reason,
    durationMs,
    elapsedMs: Date.now() - startedAt,
    totalRawSignals: report.totalRawSignals,
    acceptedShadowTrades: report.acceptedShadowTrades,
    netPnl: report.netPnl,
    unitValidationWarnings: report.unitValidationWarnings,
    latestSummary: config.microLatestSummaryFile,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
