"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const C = require("../pump/lib/constants.cjs");
const curve = require("../pump/lib/curve.cjs");
const { loadConfig } = require("../pump/lib/config.cjs");
const strategy = require("../pump/lib/strategy.cjs");
const { Tracker, summarizeHolders, curveTokenBalance } = require("../pump/lib/tracker.cjs");
const { PaperBroker } = require("../pump/lib/paperBroker.cjs");
const { RiskManager } = require("../pump/lib/risk.cjs");
const { replay, metrics, splitByTime } = require("../pump/lib/replay.cjs");
const { normalizeCreate } = require("../pump/lib/feed.cjs");
const sol = require("../pump/lib/solana.cjs");
const { LiveBroker } = require("../pump/lib/liveBroker.cjs");
const { createWallet, loadWallet } = require("../pump/lib/wallet.cjs");
const { base58Encode, base58Decode } = require("../pump/lib/base58.cjs");

const { web3 } = sol;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps ${eps})`);
const cfgFor = (env = {}) => loadConfig({ env, cwd: os.tmpdir() });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- curve

test("curve: initial state and graduation constants", () => {
  near(curve.mcapSol(C.INITIAL_VIRTUAL_SOL, C.INITIAL_VIRTUAL_TOKENS), 27.958993, 1e-5);
  near(C.GRADUATION_REAL_SOL, 85.005359, 1e-5);
  const g = curve.reservesFromRealSol(C.GRADUATION_REAL_SOL);
  near(curveTokenBalance(g.vTok), C.TOTAL_SUPPLY_TOKENS - C.INITIAL_REAL_TOKENS, 1e-3);
  assert.equal(curve.progressFromRealSol(C.GRADUATION_REAL_SOL), 1);
});

test("curve: buy then sell the same tokens returns the same SOL (fees aside)", () => {
  const { vSol, vTok } = curve.reservesFromRealSol(12);
  const tokens = curve.quoteBuyTokens(vSol, vTok, 0.5);
  const after = { vSol: vSol + 0.5, vTok: vTok - tokens };
  near(curve.quoteSellSol(after.vSol, after.vTok, tokens), 0.5, 1e-9);
});

test("curve: account encode/decode round trip with discriminator", () => {
  const { vSol, vTok } = curve.reservesFromRealSol(7.25);
  const d = curve.decodeBondingCurve(curve.encodeBondingCurve({ vSol, vTok, realSol: 7.25, realTok: 500e6, complete: true }));
  assert.ok(d.discriminatorOk);
  near(d.vSol, vSol, 1e-9);
  near(d.vTok, vTok, 1e-6);
  near(d.realSol, 7.25, 1e-9);
  assert.equal(d.complete, true);
  assert.equal(curve.decodeBondingCurve(Buffer.alloc(10)), null);
});

// ---------------------------------------------------------------- strategy

const baseFeatures = (o = {}) => ({
  ageSec: 40, realSol: 10, inflow15: 1.5, inflow30: 4, drawdownFromPeakPct: 2, devBuySol: 0.5, devSold: false,
  complete: false, progress: 0.1, holders: { top1Pct: 4, top10Pct: 20 }, price: 1, ...o,
});

test("strategy: entry needs every condition plus a holder check", () => {
  const s = cfgFor().strategy;
  assert.equal(strategy.entryDecision(baseFeatures(), s).go, true);
  assert.deepEqual(strategy.entryDecision(baseFeatures({ holders: null }), s).reasons, ["holders-unchecked"]);
  assert.equal(strategy.entryDecision(baseFeatures({ holders: { top1Pct: 25, top10Pct: 40 } }), s).go, false);
  assert.ok(strategy.preEntry(baseFeatures({ ageSec: 5 }), s).reasons.includes("too-young"));
  assert.ok(strategy.preEntry(baseFeatures({ realSol: 50 }), s).reasons.includes("late"));
  assert.ok(strategy.preEntry(baseFeatures({ inflow30: 0.5 }), s).reasons.includes("weak-inflow30"));
  assert.ok(strategy.preEntry(baseFeatures({ devSold: true }), s).reasons.includes("dev-sold"));
  assert.ok(strategy.preEntry(baseFeatures({ devBuySol: 9 }), s).reasons.includes("big-dev-buy"));
  assert.equal(strategy.entryDecision(baseFeatures({ holders: { error: "rpc" } }), s).go, false);
});

test("strategy: exits fire in the right order", () => {
  const s = cfgFor().strategy;
  const pos = (o = {}) => ({ entryPrice: 1, openedAtMs: 0, peakPrice: 1, peakRealSol: 10, tp1Done: false, ...o });
  const f = (o) => baseFeatures({ realSol: 10, ...o });
  assert.equal(strategy.exitDecision(pos(), f({ price: 0.84 }), s, 10000).reason, "stop-loss");
  assert.equal(strategy.exitDecision(pos(), f({ price: 1.1, devSold: true }), s, 10000).reason, "dev-sold");
  assert.equal(strategy.exitDecision(pos(), f({ price: 1.1, progress: 0.95 }), s, 10000).reason, "near-graduation");
  const tp = strategy.exitDecision(pos(), f({ price: 1.4 }), s, 10000);
  assert.equal(tp.reason, "take-profit-1");
  assert.equal(tp.fraction, s.tp1Fraction);
  assert.equal(strategy.exitDecision(pos({ tp1Done: true, peakPrice: 1.6 }), f({ price: 1.3 }), s, 10000).reason, "trailing-stop");
  assert.equal(strategy.exitDecision(pos(), f({ price: 1.02 }), s, 95000).reason, "time-stop");
  assert.equal(strategy.exitDecision(pos({ tp1Done: true, peakPrice: 1.45 }), f({ price: 1.4 }), s, 95000).action, "hold");
  assert.equal(strategy.exitDecision(pos({ peakRealSol: 20 }), f({ price: 1.05, realSol: 15 }), s, 10000).reason, "outflow");
  assert.equal(strategy.exitDecision(pos({ tp1Done: true, peakPrice: 1.45 }), f({ price: 1.4 }), s, 430000).reason, "max-hold");
});

// ---------------------------------------------------------------- config

test("config: env overrides, params file and validation", () => {
  const cfg = cfgFor({ PUMP_MIN_REAL_SOL: "8", PUMP_MAX_TRADE_SOL: "0.05", PUMP_PRIORITY_FEE_SOL: "0.0002" });
  assert.equal(cfg.strategy.minRealSol, 8);
  assert.equal(cfg.risk.maxTradeSol, 0.05);
  assert.equal(cfg.costs.priorityFeeSol, 0.0002);
  assert.throws(() => cfgFor({ PUMP_MIN_REAL_SOL: "abc" }), /must be a number/);
  assert.throws(() => cfgFor({ PUMP_MIN_REAL_SOL: "50" }), /minRealSol must be < maxRealSol/);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pumpcfg-")), "p.json");
  fs.writeFileSync(f, JSON.stringify({ strategy: { stopLossPct: 22 }, validation: { passed: false } }));
  assert.equal(loadConfig({ env: {}, paramsFile: f }).strategy.stopLossPct, 22);
});

test("config: the active preset loads and stays inside the safety rules", () => {
  const cfg = loadConfig({ env: {}, cwd: os.tmpdir(), paramsFile: path.join(__dirname, "..", "pump", "presets", "active.json") });
  assert.equal(cfg.strategy.minRealSol, 3);
  assert.equal(cfg.risk.maxOpenPositions, 3);
  assert.equal(cfg.runtime.watchSecActive, 750);
  // Three positions plus the reserve fit in a ~$10 (0.097 SOL) wallet.
  assert.ok(cfg.risk.maxOpenPositions * cfg.risk.maxTradeSol + cfg.risk.reserveSol <= 0.097);
  assert.equal(cfg.risk.dailyLossLimitPct, 40, "loss limit unchanged");
});

// ---------------------------------------------------------------- tracker

function fakeAccount(realSol) {
  const { vSol, vTok } = curve.reservesFromRealSol(realSol);
  return { data: curve.encodeBondingCurve({ vSol, vTok, realSol, realTok: 1 }), owner: C.PUMP_PROGRAM_ID };
}

test("tracker: inflow windows, peaks, dev sell detection and holder summary", () => {
  const cfg = cfgFor();
  const derive = { bondingCurve: (m) => `curve#${m}`, ata: (o, m) => `ata#${o}#${m}` };
  const tr = new Tracker(cfg, derive);
  tr.add({ mint: "M1", creator: "DEV", symbol: "T", devBuySol: 0.4, devTokens: 1e7, createdAtMs: 0 }, 0);
  const feed = (t, rs) => tr.ingest([{ key: "curve#M1", mint: "M1", kind: "curve", account: fakeAccount(rs) }], t);
  feed(1000, 1);
  feed(16000, 4);
  feed(31000, 9);
  let f = tr.features("M1", 31000);
  near(f.inflow15, 5, 1e-6);
  near(f.inflow30, 8, 1e-6);
  tr.ingest([{ key: "M1", mint: "M1", kind: "mint", account: { owner: C.TOKEN_PROGRAM_ID } }], 31000);
  assert.equal(tr.tokens.get("M1").devAta, "ata#DEV#M1");
  const devAcct = (amt) => { const d = Buffer.alloc(165); d.writeBigUInt64LE(BigInt(amt * C.TOKEN_UNIT), 64); return { data: d, owner: C.TOKEN_PROGRAM_ID }; };
  tr.ingest([{ key: "ata#DEV#M1", mint: "M1", kind: "devAta", account: devAcct(1e7) }], 32000);
  assert.equal(tr.features("M1", 32000).devSold, false);
  feed(40000, 7);
  f = tr.features("M1", 40000);
  assert.ok(f.drawdownFromPeakPct > 0);
  tr.ingest([{ key: "ata#DEV#M1", mint: "M1", kind: "devAta", account: devAcct(4e6) }], 41000);
  assert.equal(tr.features("M1", 41000).devSold, true);

  const h = summarizeHolders(
    [{ address: "CURVE", uiAmount: 9e8 }, { address: "a", uiAmount: 5e7 }, { address: "b", uiAmount: 2e7 }],
    { curveAta: "CURVE" }
  );
  assert.deepEqual(h, { top1Pct: 5, top10Pct: 7 });
  const h2 = summarizeHolders([{ address: "x", uiAmount: 9e8 }, { address: "a", uiAmount: 5e7 }], { curveBalance: 9e8 });
  assert.equal(h2.top1Pct, 5);
});

test("tracker: dead coins expire early, held coins never expire", () => {
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  tr.add({ mint: "DEAD", createdAtMs: 0 }, 0);
  tr.add({ mint: "HELD", createdAtMs: 0 }, 0);
  assert.equal(tr.expire(61000, new Set(["HELD"])).map((t) => t.mint).join(), "DEAD");
  assert.equal(tr.expire(10_000_000, new Set(["HELD"])).length, 0);
});

// ---------------------------------------------------------------- paper broker + risk

test("paper broker: a round trip at unchanged price costs exactly fees + tx costs", async () => {
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  tr.add({ mint: "M", createdAtMs: 0 }, 0);
  const at = (t) => tr.ingest([{ key: "c#M", mint: "M", kind: "curve", account: fakeAccount(10) }], t);
  at(0);
  const pb = new PaperBroker(cfg, tr, 1);
  const pBuy = pb.buy({ mint: "M", sol: 0.03, decisionPrice: tr.features("M", 0).price, nowMs: 0 });
  near(pb.availableSol(), 0.97, 1e-12);
  at(1500);
  pb.onTick(1500);
  const b = await pBuy;
  assert.ok(b.ok);
  // Price moved by our own buy only; selling now returns intoCurve exactly (constant product), minus fees.
  tr.tokens.get("M").last = { ...tr.tokens.get("M").last, vSol: tr.tokens.get("M").last.vSol + 0.03 / 1.0175, vTok: tr.tokens.get("M").last.vTok - b.tokens, t: 2000 };
  const pSell = pb.sell({ mint: "M", fraction: 1, nowMs: 2000 });
  tr.tokens.get("M").last.t = 3500;
  pb.onTick(3500);
  const s = await pSell;
  assert.ok(s.ok && s.closed);
  const fee = (cfg.costs.pumpFeePct + cfg.costs.portalFeePct) / 100;
  const tx = cfg.costs.priorityFeeSol + C.BASE_FEE_SOL;
  const expectedLoss = 0.03 - (0.03 / (1 + fee)) * (1 - fee) + 3 * tx;
  near(1 - pb.cash, expectedLoss, 1e-9);
});

test("paper broker: buys fail on slippage and still pay the network fee", async () => {
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  tr.add({ mint: "M", createdAtMs: 0 }, 0);
  tr.ingest([{ key: "c#M", mint: "M", kind: "curve", account: fakeAccount(5) }], 0);
  const pb = new PaperBroker(cfg, tr, 1);
  const p = pb.buy({ mint: "M", sol: 0.03, decisionPrice: tr.features("M", 0).price, nowMs: 0 });
  tr.ingest([{ key: "c#M", mint: "M", kind: "curve", account: fakeAccount(12) }], 1500);
  pb.onTick(1500);
  const r = await p;
  assert.equal(r.error, "slippage");
  near(1 - pb.cash, cfg.costs.priorityFeeSol + C.BASE_FEE_SOL);
});

test("risk: sizing, reserve, loss-streak pause and daily loss limit", () => {
  const r = new RiskManager(cfgFor().risk, 0.1);
  near(r.sizeFor(0.1), 0.03);
  near(r.sizeFor(0.04), 0.0112, 1e-12);
  assert.equal(r.sizeFor(0.02), 0);
  const t0 = Date.UTC(2026, 9, 25, 12);
  assert.ok(r.canEnter(t0, 0, 0.1).ok);
  assert.equal(r.canEnter(t0, 2, 0.1).reason, "max-open");
  r.onTradeClosed(-0.001, t0);
  r.onTradeClosed(-0.001, t0);
  r.onTradeClosed(-0.001, t0);
  assert.equal(r.canEnter(t0 + 1000, 0, 0.1).reason, "loss-streak-pause");
  assert.ok(r.canEnter(t0 + 11 * 60000, 0, 0.1).ok);
  r.onTradeClosed(-0.04, t0 + 12 * 60000);
  assert.equal(r.canEnter(t0 + 13 * 60000, 0, 0.1).reason, "daily-loss-limit");
  assert.ok(r.canEnter(t0 + 24 * 3600000, 0, 0.1).ok, "limit resets the next UTC day");
});

// ---------------------------------------------------------------- end to end on a synthetic market

const SHAPES = {
  // net SOL in the curve as a function of age (ms)
  runner: (a) => (a < 120000 ? (a / 120000) * 30 : 30 + ((a - 120000) / 240000) * 20),
  rug: (a) => (a < 40000 ? (a / 40000) * 8 : a < 50000 ? 8 : 1.5),
  fizzle: (a) => (a < 30000 ? (a / 30000) * 7 : 7),
  dump: (a) => (a < 40000 ? (a / 40000) * 10 : Math.max(3, 10 - ((a - 40000) / 20000) * 7)),
  dead: () => 0.1,
};

function synth(kind, i, t0) {
  const pathPts = [];
  for (let a = 1500; a <= 360000; a += 1500) pathPts.push([a, Math.round(SHAPES[kind](a) * 1e4) / 1e4]);
  return {
    mint: `${kind}${i}`.padEnd(32, "x"),
    symbol: kind.toUpperCase(),
    name: kind,
    creator: `creator${i}`,
    createdAtMs: t0 + i * 25000,
    devBuySol: 0.5,
    devTokensInitial: 1e7,
    devSoldAgeMs: kind === "rug" ? 50000 : null,
    holders: { top1Pct: 4, top10Pct: 20, ageMs: 20000 },
    complete: false,
    maxRealSol: Math.max(...pathPts.map((p) => p[1])),
    path: pathPts,
  };
}

test("end to end: replay trades the synthetic market and the books balance", async () => {
  const cfg = cfgFor();
  const t0 = Date.UTC(2026, 9, 25, 10);
  const kinds = ["runner", "rug", "fizzle", "dump", "dead"];
  const records = kinds.map((k, i) => synth(k, i, t0));
  const res = await replay(records, cfg, { mode: "edge", sizeSol: 0.03 });
  const by = Object.fromEntries(res.trades.map((t) => [t.symbol, t]));
  assert.equal(res.open, 0, "everything closed");
  assert.ok(!by.DEAD, "never trades a dead coin");
  assert.ok(by.RUNNER && by.RUNNER.netSol > 0, `runner should win: ${JSON.stringify(by.RUNNER)}`);
  assert.equal(by.RUNNER.exits[0].reason, "take-profit-1");
  assert.equal(by.RUG.exits.at(-1).reason, "dev-sold");
  assert.equal(by.FIZZLE.exits.at(-1).reason, "time-stop");
  assert.ok(["stop-loss", "outflow"].includes(by.DUMP.exits.at(-1).reason));
  for (const t of res.trades.filter((x) => x.symbol !== "RUNNER")) assert.ok(t.netSol < 0, `${t.symbol} should lose`);
  near(res.trades.reduce((a, t) => a + t.netSol, 0), res.finalCash - res.bankroll, 1e-5); // trade logs round to 6 decimals
  const m = metrics(res.trades);
  assert.equal(m.n, 4);
  assert.ok(m.profitFactor > 0);
});

test("end to end: account mode respects the bankroll and max open positions", async () => {
  const cfg = cfgFor();
  const t0 = Date.UTC(2026, 9, 25, 10);
  // Five runners launched together: only maxOpenPositions can be held at once.
  const records = [0, 1, 2, 3, 4].map((i) => ({ ...synth("runner", i, t0), createdAtMs: t0 + i * 100 }));
  const res = await replay(records, cfg, { mode: "account" });
  assert.equal(res.bankroll, cfg.paperStartSol);
  assert.ok(res.trades.length <= cfg.risk.maxOpenPositions, `took ${res.trades.length}`);
  assert.ok(res.trades.every((t) => t.sizeSol <= cfg.risk.maxTradeSol + 1e-12));
  near(res.trades.reduce((a, t) => a + t.netSol, 0), res.finalCash - res.bankroll, 1e-5); // trade logs round to 6 decimals
});

test("switches: outflow grace period and one re-buy of the same coin", async () => {
  const s = cfgFor().strategy;
  const pos = { entryPrice: 1, openedAtMs: 0, peakPrice: 1, peakRealSol: 10, tp1Done: false };
  const dip = baseFeatures({ price: 0.95, realSol: 7.5 });
  assert.equal(strategy.exitDecision(pos, dip, s, 10000).reason, "outflow");
  assert.equal(strategy.exitDecision(pos, dip, { ...s, outflowGraceSec: 20 }, 10000).action, "hold");
  assert.equal(strategy.exitDecision(pos, dip, { ...s, outflowGraceSec: 20 }, 25000).reason, "outflow");

  // A coin that surges, dumps (we sell), then surges again later.
  const t0 = Date.UTC(2026, 9, 25, 10);
  const pts = [];
  for (let a = 1500; a <= 360000; a += 1500) {
    const v = a < 40000 ? (a / 40000) * 10 : a < 55000 ? 10 - ((a - 40000) / 15000) * 4 : a < 120000 ? 6 : Math.min(28, 6 + ((a - 120000) / 60000) * 22);
    pts.push([a, Math.round(v * 1e4) / 1e4]);
  }
  const rec = { ...synth("runner", 0, t0), symbol: "TWICE", path: pts, maxRealSol: 28 };
  const once = await replay([rec], cfgFor(), { mode: "edge", sizeSol: 0.03 });
  const cfg2 = cfgFor({ PUMP_REENTRY_COOLDOWN_SEC: "30", PUMP_ENTRY_MAX_AGE_SEC: "180" });
  const twice = await replay([rec], cfg2, { mode: "edge", sizeSol: 0.03 });
  assert.equal(once.trades.length, 1, "default: one trade per coin");
  assert.equal(twice.trades.length, 2, "re-entry: bought again on the second surge");
  assert.ok(twice.trades[1].openedAtMs > twice.trades[0].closedAtMs + 30000);
});

test("switches: creator bag size and coins whose creator already left", () => {
  const s = cfgFor().strategy;
  assert.ok(!strategy.preEntry(baseFeatures({ devHoldPct: 8 }), s).reasons.includes("dev-big-bag"), "off by default");
  assert.ok(strategy.preEntry(baseFeatures({ devHoldPct: 8 }), { ...s, maxDevHoldPct: 3 }).reasons.includes("dev-big-bag"));
  assert.ok(!strategy.preEntry(baseFeatures({ devHoldPct: 2 }), { ...s, maxDevHoldPct: 3 }).reasons.includes("dev-big-bag"));
  assert.ok(strategy.preEntry(baseFeatures({ devSold: true, devSoldAtMs: 1000 }), s).reasons.includes("dev-sold"));
  assert.ok(!strategy.preEntry(baseFeatures({ devSold: true, devSoldAtMs: 1000 }), { ...s, allowDevSold: 1 }).reasons.includes("dev-sold"));
  const pos = { entryPrice: 1, openedAtMs: 6000, decidedAtMs: 5000, peakPrice: 1, peakRealSol: 10, tp1Done: false };
  // Sold before we decided: already known, not a reason to run.
  assert.equal(strategy.exitDecision(pos, baseFeatures({ price: 1, devSold: true, devSoldAtMs: 1000 }), s, 9000).action, "hold");
  // Sold after we decided (even before the fill landed): get out.
  assert.equal(strategy.exitDecision(pos, baseFeatures({ price: 1, devSold: true, devSoldAtMs: 5500 }), s, 9000).reason, "dev-sold");
});

test("replay: time split puts earlier launches in the first half", () => {
  const recs = [1, 2, 3, 4].map((i) => ({ createdAtMs: i * 1000 }));
  const [a, b] = splitByTime(recs);
  assert.deepEqual(a.map((r) => r.createdAtMs), [1000, 2000]);
  assert.deepEqual(b.map((r) => r.createdAtMs), [3000, 4000]);
});

// ---------------------------------------------------------------- feed

test("engine: a timed-out buy that lands later is adopted and sold", async () => {
  const { Engine } = require("../pump/lib/engine.cjs");
  const { Recorder } = require("../pump/lib/recorder.cjs");
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  tr.add({ mint: "LATE", symbol: "LATE", createdAtMs: 0 }, 0);
  tr.ingest([{ key: "c#LATE", mint: "LATE", kind: "curve", account: fakeAccount(8) }], 0);
  const sold = [];
  const broker = {
    mode: "live",
    availableSol: () => 0.1,
    buy: async () => ({ ok: false, error: "not confirmed in time", sig: "S1", feesSol: 0 }),
    tokenBalance: async () => 1234,
    estimateBuyCost: (s) => s * 1.0175 + 0.0021,
    sell: async (o) => { sold.push(o); return { ok: true, solReceived: 0.025, tokensSold: 1234, closed: true }; },
  };
  let now = 1000;
  const rpc = { getAccounts: async (keys) => keys.map(() => fakeAccount(8)), getLargestHolders: async () => [] };
  const eng = new Engine({ cfg, tracker: tr, broker, risk: new RiskManager(cfg.risk, 0.1), recorder: new Recorder("", cfg.runtime, { enabled: false }), rpc, clock: () => now });
  eng.buy(tr.features("LATE", now), 0.03, now);
  await eng.settle();
  assert.equal(eng.positions.size, 0);
  now = 50000;
  await eng.tick(now);
  await eng.settle();
  assert.equal(sold.length, 1);
  assert.equal(eng.stats.lateFills, 1);
  assert.equal(eng.closedTrades[0].exits[0].reason, "late-fill");
  near(eng.closedTrades[0].netSol, 0.025 - (0.03 * 1.0175 + 0.0021), 1e-6); // cost estimated incl. fees + rent
});

test("feed: PumpPortal create messages are normalized, other pools ignored", () => {
  const e = normalizeCreate({ txType: "create", mint: "MINT", traderPublicKey: "DEV", bondingCurveKey: "BC", name: "N", symbol: "S", solAmount: 1.2, initialBuy: 3.5e7, vSolInBondingCurve: 31.2, vTokensInBondingCurve: 1.03e9, pool: "pump" }, 5);
  assert.equal(e.mint, "MINT");
  assert.equal(e.creator, "DEV");
  assert.equal(e.bondingCurve, "BC");
  assert.equal(e.devBuySol, 1.2);
  assert.equal(e.createdAtMs, 5);
  const raw = normalizeCreate({ txType: "create", mint: "M", vSolInBondingCurve: 31.2e9, vTokensInBondingCurve: 1.03e15, initialBuy: 3.5e13 }, 0);
  near(raw.vSol, 31.2);
  near(raw.vTok, 1.03e9);
  near(raw.devTokens, 3.5e7);
  assert.equal(normalizeCreate({ txType: "create", mint: "M", pool: "bonk" }, 0), null);
  assert.equal(normalizeCreate({ txType: "buy", mint: "M" }, 0), null);
});

// ---------------------------------------------------------------- solana helpers, wallet, live broker (mocked network)

test("solana: PDA/ATA derivation and close-account instruction", () => {
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const owner = web3.Keypair.generate().publicKey.toBase58();
  const bc = sol.bondingCurveAddress(mint);
  assert.equal(bc, sol.bondingCurveAddress(mint));
  assert.notEqual(sol.ataAddress(owner, mint, C.TOKEN_PROGRAM_ID), sol.ataAddress(owner, mint, C.TOKEN_2022_PROGRAM_ID));
  const ix = sol.closeAccountInstruction(owner, owner, owner, C.TOKEN_2022_PROGRAM_ID);
  assert.equal(ix.programId.toBase58(), C.TOKEN_2022_PROGRAM_ID);
  assert.deepEqual([...ix.data], [9]);
});

test("wallet: create, load (JSON and base58), never overwrite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpwallet-"));
  const file = path.join(dir, "w", "wallet.json");
  const kp = createWallet(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadWallet(file).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.throws(() => createWallet(file), /refusing to overwrite/);
  // base58 round trip through a known-good encoder: web3 PublicKey.toBase58 of 32 bytes.
  const pkBytes = kp.publicKey.toBytes();
  assert.deepEqual([...base58Decode(kp.publicKey.toBase58())], [...pkBytes]);
});

// Builds a transaction like PumpPortal would return. extra: [TransactionInstruction] appended.
function buildTx(payer, { transferLamports = 0, extra = [] } = {}) {
  const ixs = [web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })];
  if (transferLamports) ixs.push(web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: web3.Keypair.generate().publicKey, lamports: transferLamports }));
  ixs.push(...extra);
  const msg = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message();
  return new web3.VersionedTransaction(msg);
}

/**
 * A tiny fake Solana + PumpPortal. Every sent transaction gets the next scripted outcome:
 *   { status: "confirmed" | "failed" | "late" | "dropped", meta, tokensAfter }
 * "late" = not visible while the bot waits, visible on the next status lookup.
 */
function mockNet(kp, mint, outcomes = []) {
  const me = kp.publicKey.toBase58();
  const state = { tokens: 0, preLamports: 1e8, simLoss: 0.001, simOwner: C.SYSTEM_PROGRAM_ID, simErr: null, simTokens: 1000 };
  const sent = [], bodies = [], bySig = new Map(), lookups = new Map();
  let nextBuild = {};
  const conn = {
    sent,
    async sendRawTransaction(raw) {
      const tx = raw.length && web3.VersionedTransaction.deserialize(raw);
      const sig = base58Encode(tx.signatures[0]);
      sent.push({ raw, sig });
      bySig.set(sig, outcomes.shift() || { status: "confirmed", meta: { preBalances: [0], postBalances: [0], preTokenBalances: [], postTokenBalances: [] } });
      return sig;
    },
    async getSignatureStatuses(sigs) {
      return {
        value: sigs.map((sig) => {
          const o = bySig.get(sig);
          if (!o) return null;
          const n = (lookups.get(sig) || 0) + 1;
          lookups.set(sig, n);
          if (o.status === "dropped") return null;
          if (o.status === "late" && !o.visible) return null;
          if (o.status === "failed") return { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } };
          if (o.tokensAfter !== undefined && !o.applied) { state.tokens = o.tokensAfter; o.applied = true; }
          return { confirmationStatus: "confirmed", err: null };
        }),
      };
    },
    async getTransaction(sig) {
      const o = bySig.get(sig);
      return o && o.status !== "dropped" && o.status !== "failed" ? { meta: o.meta } : null;
    },
    async getBalance() { return state.preLamports; },
    async simulateTransaction(vtx, cfg) {
      if (state.simErr) return { value: { err: state.simErr, logs: [] } };
      const tokenAcc = () => {
        const d = Buffer.alloc(165);
        d.writeBigUInt64LE(BigInt(Math.round(state.simTokens * 1e6)), 64);
        return { data: [d.toString("base64"), "base64"], owner: C.TOKEN_PROGRAM_ID, lamports: 2039280 };
      };
      const extra = cfg.accounts.addresses.slice(1).map((_, i) => (i === 0 ? tokenAcc() : null));
      return { value: { err: null, logs: [], accounts: [{ lamports: state.preLamports - state.simLoss * 1e9, owner: state.simOwner }, ...extra] } };
    },
    async getMultipleAccountsInfo(keys) { return keys.map(() => null); },
    async getParsedTokenAccountsByOwner() {
      const raw = Math.round(state.tokens * 1e6);
      return { value: [{ pubkey: web3.Keypair.generate().publicKey, account: { owner: new web3.PublicKey(C.TOKEN_PROGRAM_ID), data: { parsed: { info: { mint, tokenAmount: { amount: String(raw), uiAmount: state.tokens } } } } } }] };
    },
    async getLatestBlockhash() { return { blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }; },
  };
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const bytes = buildTx(kp.publicKey, nextBuild).serialize();
    return { status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => "" };
  };
  // Make every "late" transaction visible (it landed after the bot stopped waiting).
  const landLate = () => { for (const o of bySig.values()) if (o.status === "late") o.visible = true; };
  return { conn, fetchImpl, bodies, state, me, landLate, build: (b) => { nextBuild = b; } };
}

const tb = (me, mint, amt) => [{ owner: me, mint, uiTokenAmount: { amount: String(Math.round(amt * 1e6)), decimals: 6 } }];
const meta = (me, mint, solDelta, tokPre, tokPost) => ({
  preBalances: [1e8], postBalances: [1e8 + Math.round(solDelta * 1e9)], preTokenBalances: tb(me, mint, tokPre), postTokenBalances: tb(me, mint, tokPost),
});
const newBroker = (cfg, kp, net, extra = {}) =>
  new LiveBroker(cfg, { conn: net.conn, keypair: kp, fetchImpl: net.fetchImpl, sleepFn: async () => {}, confirmMs: 30, ...extra });

test("inspect: flags drains that are not plain transfers", () => {
  const kp = web3.Keypair.generate();
  const me = kp.publicKey;
  const other = web3.Keypair.generate().publicKey;
  const ok = sol.inspectTransaction(buildTx(me, { transferLamports: 2_000_000 }), me);
  near(ok.outflowSol, 0.002);
  assert.deepEqual(ok.risky, []);
  assert.deepEqual(ok.unknownPrograms, []);
  const assign = sol.inspectTransaction(buildTx(me, { extra: [web3.SystemProgram.assign({ accountPubkey: me, programId: other })] }), me);
  assert.equal(assign.risky.length, 1);
  const seeded = sol.inspectTransaction(buildTx(me, { extra: [web3.SystemProgram.createAccountWithSeed({ fromPubkey: me, newAccountPubkey: other, basePubkey: me, seed: "x", lamports: 5e9, space: 0, programId: other })] }), me);
  assert.equal(seeded.risky.length, 1, "createAccountWithSeed from the wallet is refused");
  const unknown = sol.inspectTransaction(buildTx(me, { extra: [new web3.TransactionInstruction({ programId: other, keys: [{ pubkey: me, isSigner: true, isWritable: true }], data: Buffer.from([1]) })] }), me);
  assert.deepEqual(unknown.unknownPrograms, [other.toBase58()]);
  assert.deepEqual(sol.inspectTransaction(buildTx(me, { extra: [new web3.TransactionInstruction({ programId: other, keys: [{ pubkey: me, isSigner: true, isWritable: true }], data: Buffer.alloc(0) })] }), me, [other.toBase58()]).unknownPrograms, []);
  // An unknown program that is never handed the wallet can't touch its SOL or coins.
  const blind = sol.inspectTransaction(buildTx(me, { extra: [new web3.TransactionInstruction({ programId: other, keys: [{ pubkey: web3.Keypair.generate().publicKey, isSigner: false, isWritable: true }], data: Buffer.from([7]) })] }), me);
  assert.deepEqual(blind.unknownPrograms, []);
  assert.deepEqual(blind.harmlessPrograms, [other.toBase58()]);
});

test("diagnostics: unknown program report (authority, usage, accounts)", async () => {
  const kp = web3.Keypair.generate();
  const prog = web3.Keypair.generate().publicKey;
  const programData = web3.Keypair.generate().publicKey;
  const authority = web3.Keypair.generate().publicKey;
  const pdData = Buffer.alloc(45);
  pdData.writeUInt32LE(3, 0);
  pdData.writeBigUInt64LE(12345n, 4);
  pdData[12] = 1;
  authority.toBuffer().copy(pdData, 13);
  const progData = Buffer.alloc(36);
  progData.writeUInt32LE(2, 0);
  programData.toBuffer().copy(progData, 4);
  // Calls into pump.fun from inside the program only show up in the logs.
  const pumpTx = (payer) => ({
    meta: { logMessages: [`Program ${prog.toBase58()} invoke [1]`, `Program ${C.PUMP_PROGRAM_ID} invoke [2]`] },
    transaction: { message: { staticAccountKeys: [payer, prog], compiledInstructions: [{ programIdIndex: 1 }] } },
  });
  const conn = {
    async getAccountInfo(k) {
      if (k.equals(prog)) return { executable: true, owner: new web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), data: progData };
      if (k.equals(programData)) return { executable: false, owner: new web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), data: pdData };
      return null;
    },
    async getSignaturesForAddress() { return [{ signature: "a", blockTime: 1000 }, { signature: "b", blockTime: 990 }, { signature: "c", blockTime: 980 }]; },
    async getTransaction() { return pumpTx(web3.Keypair.generate().publicKey); },
  };
  const e = await sol.explainProgram(conn, prog.toBase58());
  assert.equal(e.executable, true);
  assert.equal(e.upgradeAuthority, authority.toBase58());
  assert.equal(e.lastDeploySlot, 12345);
  assert.deepEqual([e.recentTx, e.spanSec, e.sampled, e.withPump, e.distinctPayers], [3, 20, 3, 3, 3]);
  const tx = buildTx(kp.publicKey, { extra: [new web3.TransactionInstruction({ programId: prog, keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }, { pubkey: authority, isSigner: false, isWritable: false }], data: Buffer.from([1, 2]) })] });
  const ixs = sol.instructionAccounts(tx, prog.toBase58());
  assert.equal(ixs.length, 1);
  assert.equal(ixs[0].dataLen, 2);
  assert.deepEqual(ixs[0].accounts[0], { address: kp.publicKey.toBase58(), signer: true, writable: true });
  assert.equal(ixs[0].accounts[1].signer, false);
});

test("live broker: an unknown program that never sees the wallet does not block a buy", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [{ status: "confirmed", meta: meta(kp.publicKey.toBase58(), mint, -0.0322, 0, 900) }]);
  net.build({ extra: [new web3.TransactionInstruction({ programId: web3.Keypair.generate().publicKey, keys: [{ pubkey: web3.Keypair.generate().publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1]) })] });
  const r = await newBroker(cfg, kp, net).buy({ mint, sol: 0.03 });
  assert.ok(r.ok, r.error);
});

test("curve: non-standard curves are detected, recorded and skipped by the strategy", async () => {
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  tr.add({ mint: "ODD", createdAtMs: 0 }, 0);
  const vSol = 782.6, vTok = 1.073e9; // starts at ~729 SOL market cap with nothing bought
  tr.ingest([{ key: "c#ODD", mint: "ODD", kind: "curve", account: { data: curve.encodeBondingCurve({ vSol, vTok, realSol: 0, realTok: 793.1e6 }), owner: C.PUMP_PROGRAM_ID } }], 1000);
  const t = tr.tokens.get("ODD");
  assert.equal(t.curve.standard, false);
  assert.equal(tr.stats.nonStandard, 1);
  const f = tr.features("ODD", 1000);
  assert.equal(f.standardCurve, false);
  assert.ok(strategy.preEntry({ ...baseFeatures(), standardCurve: false }, cfg.strategy).reasons.includes("non-standard-curve"));
  assert.ok(!strategy.preEntry({ ...baseFeatures(), standardCurve: true }, cfg.strategy).reasons.includes("non-standard-curve"));
  // Standard coin: recognised as such.
  tr.add({ mint: "STD", createdAtMs: 0 }, 0);
  tr.ingest([{ key: "c#STD", mint: "STD", kind: "curve", account: fakeAccount(2) }], 1000);
  assert.equal(tr.tokens.get("STD").curve.standard, true);
  // Replay rebuilds a recorded coin's reserves from its own curve parameters.
  const { RecordedMarket } = require("../pump/lib/recordedMarket.cjs");
  const m = new RecordedMarket([{ mint: "ODD", createdAtMs: 0, path: [[1000, 5]], curve: { base: 782.6, k: 782.6 * 1.073e9, totalSupply: 1e9 } }], { clock: () => 2000 });
  const [acc] = await m.getAccounts(["curve#ODD"]);
  near(curve.decodeBondingCurve(acc.data).vSol, 787.6, 1e-6);
});

test("live broker: buy is inspected, simulated, signed locally and booked from the chain", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [{ status: "confirmed", meta: meta(kp.publicKey.toBase58(), mint, -0.03214428, 0, 1000) }]);
  const lb = newBroker(cfg, kp, net, { budgetSol: 0.05 });
  await lb.refreshBalance();
  near(lb.availableSol(), 0.05);
  const r = await lb.buy({ mint, sol: 0.03 });
  assert.ok(r.ok, r.error);
  near(r.tokens, 1000);
  near(r.solSpent, 0.03214428);
  assert.equal(r.sig, net.conn.sent[0].sig, "signature computed locally");
  assert.deepEqual([net.bodies[0].action, net.bodies[0].denominatedInSol, net.bodies[0].pool], ["buy", "true", "pump"]);
  assert.ok(web3.VersionedTransaction.deserialize(net.conn.sent[0].raw).signatures[0].some((b) => b !== 0), "signed");
});

test("live broker: refuses direct outflow, simulated drains, owner changes and unknown programs", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const cases = [
    [(n) => n.build({ transferLamports: 0.5e9 }), /straight out/],
    [(n) => { n.state.simLoss = 0.5; }, /wallet would lose/],
    [(n) => { n.state.simOwner = web3.Keypair.generate().publicKey.toBase58(); }, /take over or close the wallet/],
    [(n) => n.build({ extra: [new web3.TransactionInstruction({ programId: web3.Keypair.generate().publicKey, keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(0) })] }), /unknown program/],
    [(n) => { n.state.simErr = { InstructionError: [2, { Custom: 6002 }] }; }, /would fail on-chain/],
    [(n) => { n.state.simTokens = 0; }, /no coins arriving/],
  ];
  for (const [setup, msg] of cases) {
    const net = mockNet(kp, mint);
    setup(net);
    const r = await newBroker(cfg, kp, net).buy({ mint, sol: 0.03 });
    assert.equal(r.ok, false);
    assert.match(r.error, msg);
    assert.equal(net.conn.sent.length, 0, `nothing sent for ${msg}`);
  }
});

test("live broker: full sell books proceeds and closes the empty account for the rent", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [
    { status: "confirmed", meta: meta(me, mint, 0.04, 1000, 0), tokensAfter: 0 },
    { status: "confirmed", meta: meta(me, mint, 0.00203428, 0, 0) },
  ]);
  net.state.tokens = 1000;
  const r = await newBroker(cfg, kp, net).sell({ mint, fraction: 1 });
  assert.ok(r.ok, r.error);
  assert.equal(r.closed, true);
  near(r.tokensSold, 1000);
  near(r.rentRefund, 0.00203428);
  near(r.solReceived, 0.04 + 0.00203428);
  assert.deepEqual([net.bodies[0].amount, net.bodies[0].pool], ["100%", "auto"]);
  assert.equal(net.conn.sent.length, 2, "sell + close account");
});

test("live broker: a partial sell that times out is never re-sent as a partial", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [
    { status: "late", meta: meta(me, mint, 0.02, 1000, 500) }, // the 50% lands after the bot gave up on it
    { status: "confirmed", meta: meta(me, mint, 0.019, 500, 0), tokensAfter: 0 },
    { status: "confirmed", meta: meta(me, mint, 0.002, 0, 0) },
  ]);
  net.state.tokens = 1000;
  const lb = newBroker(cfg, kp, net);
  const r = await lb.sell({ mint, fraction: 0.5, estimateSol: 0.02 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(net.bodies.map((b) => b.amount), ["50%", "100%"], "retry is a full exit, never a second 50%");
  assert.equal(r.closed, true);
  // The late 50% landing afterwards can't oversell: the wallet is already empty.
});

test("live broker: an earlier sell that landed late is booked instead of selling again", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [
    { status: "late", meta: meta(me, mint, 0.041, 1000, 0), tokensAfter: 0 },
    { status: "dropped" }, { status: "dropped" },
    { status: "confirmed", meta: meta(me, mint, 0.002, 0, 0) },
  ]);
  net.state.tokens = 1000;
  const lb = newBroker(cfg, kp, net);
  const first = await lb.sell({ mint, fraction: 1, estimateSol: 0.04 });
  assert.equal(first.ok, false, "nothing confirmed while waiting");
  assert.equal(net.conn.sent.length, 3);
  net.landLate();
  const again = await lb.sell({ mint, fraction: 1, estimateSol: 0.04 });
  assert.ok(again.ok, again.error);
  assert.equal(again.closed, true);
  near(again.tokensSold, 1000);
  near(again.solReceived, 0.041 + 0.002);
  assert.equal(net.conn.sent.length, 4, "only the close-account transaction was added");
});

test("live broker: withdraw sends the exact lamport balance minus the fee", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const net = mockNet(kp, "x");
  net.state.preLamports = 123456789;
  await newBroker(cfg, kp, net).withdrawAll(web3.Keypair.generate().publicKey.toBase58());
  const tx = web3.Transaction.from(net.conn.sent[0].raw);
  assert.equal(tx.instructions[0].data.readBigUInt64LE(4), 123456789n - 5000n);
});

test("engine: a failing trade log never crashes the bot", async () => {
  const { Engine } = require("../pump/lib/engine.cjs");
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  tr.add({ mint: "Q", symbol: "Q", createdAtMs: 0 }, 0);
  tr.ingest([{ key: "c#Q", mint: "Q", kind: "curve", account: fakeAccount(8) }], 0);
  const broker = {
    mode: "paper",
    availableSol: () => 0.1,
    buy: async () => ({ ok: true, tokens: 10, solSpent: 0.03 }),
    sell: async () => ({ ok: true, solReceived: 0.02, tokensSold: 10, closed: true }),
  };
  const recorder = { recordTrade: () => { throw new Error("disk full"); }, recordToken: () => {} };
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on("unhandledRejection", onUnhandled);
  const logs = [];
  const eng = new Engine({ cfg, tracker: tr, broker, risk: new RiskManager(cfg.risk, 0.1), recorder, rpc: { getAccounts: async (k) => k.map(() => fakeAccount(8)), getLargestHolders: async () => [] }, log: (l, m) => logs.push(m), clock: () => 1000 });
  eng.buy(tr.features("Q", 1000), 0.03, 1000);
  await eng.settle();
  eng.sell(eng.positions.get("Q"), { action: "sell", fraction: 1, reason: "test", gainPct: 0 }, tr.features("Q", 1000), 1000);
  await eng.settle();
  await new Promise((r) => setImmediate(r));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0);
  assert.equal(eng.positions.size, 0, "position closed even though logging failed");
  assert.ok(logs.some((m) => /internal error: disk full/.test(m)));
});

test("holders: curve account excluded by derived address or by being the giant holder", () => {
  const rows = [{ address: "CURVE22", uiAmount: 8.8e8 }, { address: "a", uiAmount: 3e7 }];
  assert.equal(summarizeHolders(rows, { curveAtas: ["CURVE1", "CURVE22"] }).top1Pct, 3);
  // Unknown address and a stale expected balance: still recognised as the curve.
  assert.equal(summarizeHolders(rows, { curveBalance: 9.5e8 }).top1Pct, 3);
});

test("replay: a dev sale before the first dev-wallet read still blocks the trade", async () => {
  const cfg = cfgFor();
  const rec = synth("runner", 0, Date.UTC(2026, 9, 25, 10));
  rec.devSoldAgeMs = 3000;
  const res = await replay([rec], cfg, { mode: "edge", sizeSol: 0.03 });
  assert.equal(res.trades.length, 0);
});

test("paper broker: a sell that gaps past its slippage fills a poll later, like a live retry", async () => {
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  tr.add({ mint: "M", createdAtMs: 0 }, 0);
  const at = (t, rs) => tr.ingest([{ key: "c#M", mint: "M", kind: "curve", account: fakeAccount(rs) }], t);
  at(0, 20);
  const pb = new PaperBroker(cfg, tr, 1);
  const pBuy = pb.buy({ mint: "M", sol: 0.03, decisionPrice: tr.features("M", 0).price, nowMs: 0 });
  at(1500, 20);
  pb.onTick(1500);
  assert.ok((await pBuy).ok);
  let done = false;
  const pSell = pb.sell({ mint: "M", fraction: 1, nowMs: 1500, decisionPrice: tr.features("M", 1500).price }).then((r) => { done = true; return r; });
  at(3000, 8); // price collapses ~60%: beyond 25% slippage
  pb.onTick(3000);
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, "first attempt failed on slippage");
  at(4500, 8);
  pb.onTick(4500);
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, "second attempt (40%) also failed");
  at(6000, 8);
  pb.onTick(6000);
  assert.ok((await pSell).ok, "third attempt fills");
});

test("config: stop files and data folder are anchored to the repo root", () => {
  const { REPO_ROOT } = require("../pump/lib/config.cjs");
  const cfg = loadConfig({ env: {} });
  assert.equal(cfg.stopFiles[0], path.join(REPO_ROOT, "STOP_PUMP.txt"));
  assert.equal(cfg.stopFiles[1], path.join(REPO_ROOT, "STOP_BOT.txt"));
  assert.equal(cfg.dataDir, path.join(REPO_ROOT, "data", "pump"));
});

// ---------------------------------------------------------------- run

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${e.stack.split("\n").slice(0, 3).join("\n     ")}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} pump tests passed`);
  process.exit(failed ? 1 : 0);
})();
