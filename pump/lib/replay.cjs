"use strict";

const { Tracker } = require("./tracker.cjs");
const { PaperBroker } = require("./paperBroker.cjs");
const { RiskManager } = require("./risk.cjs");
const { Recorder } = require("./recorder.cjs");
const { Engine } = require("./engine.cjs");
const { RecordedMarket } = require("./recordedMarket.cjs");

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Runs the real engine over recorded coins with a simulated clock.
 * mode "edge": fixed trade size, no position/loss caps -> measures the rules themselves.
 * mode "account": the configured risk limits and bankroll -> what the account would have done.
 */
async function replay(records, baseCfg, { mode = "edge", sizeSol = 0.03, startSol = null } = {}) {
  const cfg = clone(baseCfg);
  if (mode === "edge") {
    Object.assign(cfg.risk, {
      maxOpenPositions: 1000, maxTradeSol: sizeSol, minTradeSol: sizeSol, tradeFractionOfFree: 1,
      reserveSol: 0, dailyLossLimitPct: 1e9, lossStreak: 1e9, keepPct: 0, compound: 0,
    });
  }
  const bankroll = startSol !== null ? startSol : mode === "edge" ? 1e6 : cfg.paperStartSol;
  const market = new RecordedMarket(records, { clock: () => now });
  let now = market.records.length ? market.records[0].createdAtMs : 0;
  const tracker = new Tracker(cfg, market.derive);
  const broker = new PaperBroker(cfg, tracker, bankroll);
  const risk = new RiskManager(cfg.risk, bankroll);
  const engine = new Engine({ cfg, tracker, broker, risk, recorder: new Recorder("", cfg.runtime, { enabled: false }), rpc: market, clock: () => now });
  const lastLaunch = market.records.length ? market.records[market.records.length - 1].createdAtMs : 0;
  const end = lastLaunch + (Math.max(cfg.runtime.watchSec, cfg.runtime.watchSecActive) + cfg.strategy.maxHoldSec) * 1000;
  while (now <= end) {
    for (const e of market.newEvents(now)) engine.onCreate(e);
    if (tracker.tokens.size === 0 && engine.positions.size === 0 && broker.pending.length === 0) {
      const next = market.nextEventMs();
      if (next === null) break;
      now = Math.max(now + cfg.runtime.pollMs, next);
      continue;
    }
    await engine.tick(now);
    now += cfg.runtime.pollMs;
  }
  await engine.settle();
  return { trades: engine.closedTrades, open: engine.positions.size, stats: engine.stats, risk, unknownHolders: market.unknownHolders, finalCash: broker.cash, bankroll };
}

function metrics(trades) {
  const n = trades.length;
  if (!n) return { n: 0, netSol: 0, winRatePct: 0, profitFactor: 0, avgNetPct: 0, maxDrawdownSol: 0, reasons: {} };
  let gw = 0, gl = 0, wins = 0, cum = 0, peak = 0, maxDD = 0;
  const reasons = {};
  for (const t of [...trades].sort((a, b) => a.closedAtMs - b.closedAtMs)) {
    if (t.netSol > 0) { wins++; gw += t.netSol; } else gl += -t.netSol;
    cum += t.netSol;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    const last = t.exits[t.exits.length - 1];
    if (last) reasons[last.reason] = (reasons[last.reason] || 0) + 1;
  }
  return {
    n,
    netSol: cum,
    winRatePct: (wins / n) * 100,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    avgNetPct: trades.reduce((a, t) => a + t.netPct, 0) / n,
    maxDrawdownSol: maxDD,
    reasons,
  };
}

// Records split by launch time into two halves of equal duration.
function splitByTime(records) {
  if (records.length < 2) return [records, []];
  const sorted = [...records].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const mid = (sorted[0].createdAtMs + sorted[sorted.length - 1].createdAtMs) / 2;
  return [sorted.filter((r) => r.createdAtMs < mid), sorted.filter((r) => r.createdAtMs >= mid)];
}

function stressCosts(cfg, mult) {
  const c = clone(cfg);
  c.costs.pumpFeePct *= mult;
  c.costs.portalFeePct *= mult;
  c.costs.priorityFeeSol *= mult;
  return c;
}

module.exports = { replay, metrics, splitByTime, stressCosts };
