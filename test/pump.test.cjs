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
const { RiskManager, carryPeak } = require("../pump/lib/risk.cjs");
const { replay, metrics, splitByTime } = require("../pump/lib/replay.cjs");
const { normalizeCreate, parseCreateLogs, RpcLogsFeed, walletFill, CREATE_EVENT, TRADE_EVENT } = require("../pump/lib/feed.cjs");
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

test("config: the active preset loads and only loosens the buy/sell rules", () => {
  const cfg = loadConfig({ env: {}, cwd: os.tmpdir(), paramsFile: path.join(__dirname, "..", "pump", "presets", "active.json") });
  assert.equal(cfg.strategy.minRealSol, 3);
  assert.equal(cfg.runtime.watchSecActive, 750);
  assert.deepEqual(cfg.risk, cfgFor().risk, "same money rules as the default");
});

test("config: by default it holds as many coins as it can pay for, never pauses, keeps half", () => {
  const cfg = cfgFor();
  const risk = new RiskManager(cfg.risk, 0.11);
  let cash = 0.11, open = 0;
  while (risk.canEnter(0, open, cash).ok) {
    cash -= risk.sizeFor(cash) * 1.2 + C.TOKEN_ACCOUNT_RENT_SOL + 0.0002; // worst-case fill: +20% slippage, rent and fees
    open++;
  }
  assert.equal(open, 2); // the rest stays above the keep-floor (half) even if both coins went to zero
  assert.ok(cash >= 0.055 - 1e-9);
  const r = new RiskManager(cfg.risk, 0.1);
  for (let i = 0; i < 8; i++) r.onTradeClosed(-0.004, 1000 + i); // 8 losses in a row
  assert.ok(r.canEnter(1010, 0, 0.068).ok, "no pause, no daily stop");
  r.onTradeClosed(-0.02, 1020); // 0.048: below half of the best (0.1)
  assert.equal(r.canEnter(1030, 0, 0.048).reason, "keep-floor");
});

test("config: max preset is the default without the keep-floor", () => {
  const cfg = loadConfig({ env: {}, cwd: os.tmpdir(), paramsFile: path.join(__dirname, "..", "pump", "presets", "max.json") });
  assert.deepEqual(cfg.strategy, cfgFor().strategy);
  assert.deepEqual({ ...cfg.risk, keepPct: 50 }, cfgFor().risk);
  const risk = new RiskManager(cfg.risk, 0.1);
  for (let i = 0; i < 10; i++) risk.onTradeClosed(-0.009, 1000 + i);
  assert.ok(risk.canEnter(2000, 0, 0.05).ok, "never stops on losses");
});

test("risk: the keep-floor carries over restarts (same wallet), clamped to the budget", () => {
  const saved = { wallet: "W", peakSol: 0.22 };
  assert.equal(carryPeak({ saved, owner: "W", startSol: 0.12, budgetSol: 0.25 }), 0.22); // restart after losses
  assert.equal(carryPeak({ saved, owner: "OTHER", startSol: 0.12, budgetSol: 0.25 }), 0.12);
  assert.equal(carryPeak({ saved, owner: "W", startSol: 0.12, budgetSol: 0.25, reset: true }), 0.12);
  assert.equal(carryPeak({ saved, owner: "W", startSol: 0.1, budgetSol: 0.15 }), 0.15); // lowered budget
  assert.equal(carryPeak({ saved, owner: "W", startSol: 0.25, budgetSol: 0.25 }), 0.25); // deposit since
  assert.equal(carryPeak({ saved: null, owner: "W", startSol: 0.12, budgetSol: 0.25 }), 0.12);
  const r = new RiskManager(cfgFor().risk, 0.12);
  r.peakSol = 0.22;
  const peaks = [];
  r.onPeak = (p) => peaks.push(p);
  r.savedPeak = 0.22;
  r.onTradeClosed(0.05, 0); // 0.17: below the carried best, nothing to save
  r.onTradeClosed(0.07, 0); // 0.24: a new best
  assert.deepEqual(peaks.map((p) => Math.round(p * 1000) / 1000), [0.24]);
  const low = new RiskManager(cfgFor().risk, 0.1);
  low.peakSol = 0.22; // carried: half is 0.11, this run starts below it
  assert.equal(low.canEnter(Date.UTC(2026, 9, 26), 0, 0.1).reason, "keep-floor");
});

test("conviction: stronger buying pressure buys more, within the free cash", () => {
  const s = cfgFor().strategy; // minimums: 2.5 SOL per 30s, 0.8 SOL per 15s
  assert.equal(strategy.conviction({ inflow30: 2.5, inflow15: 0.8 }, s, 2), 1);
  near(strategy.conviction({ inflow30: 5, inflow15: 1.6 }, s, 2), 1.5);
  near(strategy.conviction({ inflow30: 50, inflow15: 1.6 }, s, 2), 1.5, 1e-12); // both windows must be strong
  assert.equal(strategy.conviction({ inflow30: 50, inflow15: 50 }, s, 2), 2);
  assert.equal(strategy.conviction({ inflow30: 50, inflow15: 50 }, s, 1), 1); // switched off
  assert.equal(strategy.conviction({ inflow30: NaN, inflow15: 1 }, s, 2), 1);
  const r = new RiskManager(cfgFor().risk, 0.11);
  near(r.sizeFor(0.11), 0.025);
  near(r.sizeFor(0.11, 2), 0.0439673, 1e-6); // what still fits above the keep-floor at a worst-case fill
  near(r.sizeFor(0.3, 2), 0.05); // twice the base size
  near(r.sizeFor(0.3, 1.5), 0.0375);
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

test("tracker: a creator account a lagging node can't show yet is not a sale; mint reads are retried", () => {
  const cfg = cfgFor();
  const derive = { bondingCurve: (m) => `curve#${m}`, ata: (o, m) => `ata#${o}#${m}` };
  const devAcct = (amt) => { const d = Buffer.alloc(165); d.writeBigUInt64LE(BigInt(amt * C.TOKEN_UNIT), 64); return { data: d, owner: C.TOKEN_PROGRAM_ID }; };
  const tr = new Tracker(cfg, derive);
  tr.add({ mint: "M", creator: "DEV", devBuySol: 0.4, devTokens: 1e7, createdAtMs: 0 }, 0);
  tr.ingest([{ key: "curve#M", mint: "M", kind: "curve", account: fakeAccount(2) }], 1000);
  tr.ingest([{ key: "M", mint: "M", kind: "mint", account: { owner: C.TOKEN_PROGRAM_ID } }], 1000);
  tr.ingest([{ key: "ata#DEV#M", mint: "M", kind: "devAta", account: null }], 2000); // node behind: null
  assert.equal(tr.features("M", 2000).devSold, false);
  tr.ingest([{ key: "ata#DEV#M", mint: "M", kind: "devAta", account: devAcct(1e7) }], 3000);
  assert.equal(tr.features("M", 3000).devSold, false);
  assert.equal(tr.stats.devNullIgnored, 1);
  // Seen once, then gone: the creator closed the account after selling out.
  tr.ingest([{ key: "ata#DEV#M", mint: "M", kind: "devAta", account: null }], 4000);
  assert.equal(tr.features("M", 4000).devSold, true);
  // Never seen, three nulls in a row: treated as no tokens (sold out if the launch buy had some).
  const t2 = new Tracker(cfg, derive);
  t2.add({ mint: "N", creator: "DEV", devBuySol: 0.4, devTokens: 1e7, createdAtMs: 0 }, 0);
  t2.ingest([{ key: "curve#N", mint: "N", kind: "curve", account: fakeAccount(2) }], 1000);
  for (const ms of [2000, 3000, 4000]) t2.ingest([{ key: "ata#DEV#N", mint: "N", kind: "devAta", account: null }], ms);
  assert.equal(t2.features("N", 4000).devSold, true);
  // A mint the RPC can't show three times is asked for again 10 ticks later, then derives the dev account.
  const t3 = new Tracker(cfg, derive);
  t3.add({ mint: "Q", creator: "DEV", createdAtMs: 0 }, 0);
  t3.ingest([{ key: "curve#Q", mint: "Q", kind: "curve", account: fakeAccount(2) }], 1000);
  const mintAsked = () => t3.pollTargets(2000).some((x) => x.kind === "mint");
  for (let i = 0; i < 3; i++) {
    assert.ok(mintAsked());
    t3.ingest([{ key: "Q", mint: "Q", kind: "mint", account: null }], 2000);
  }
  assert.equal(t3.stats.mintGiveUps, 1);
  let ticks = 1;
  while (!mintAsked() && ticks < 50) ticks++;
  assert.equal(ticks, 10, "asked again after a 10-tick pause");
  t3.ingest([{ key: "Q", mint: "Q", kind: "mint", account: { owner: C.TOKEN_PROGRAM_ID } }], 2000);
  assert.equal(t3.tokens.get("Q").devAta, "ata#DEV#Q");
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
  near(pb.availableSol(), 1 - 0.03 - pb.txCostSol() - C.TOKEN_ACCOUNT_RENT_SOL, 1e-12); // a pending buy holds its whole cost
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

test("risk: sizing, reserve, loss-streak pause and daily loss limit (when switched on)", () => {
  const r = new RiskManager({ ...cfgFor().risk, maxOpenPositions: 2, maxTradeSol: 0.03, dailyLossLimitPct: 40, lossStreakPauseMin: 10, keepPct: 0 }, 0.1);
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

test("risk: winnings grow the trade size; the keep-floor stops buys below half the best balance", () => {
  const base = { ...cfgFor().risk, maxTradeSol: 0.03 };
  const r = new RiskManager(base, 0.1);
  const t0 = Date.UTC(2026, 9, 25, 12);
  near(r.sizeFor(0.2), 0.03);
  r.onTradeClosed(0.05, t0); // account 0.15: +50%
  near(r.sizeFor(0.2), 0.045); // the size limit grew by the same 50%
  r.onTradeClosed(-0.03, t0); // 0.12: still above half of the 0.15 best
  near(r.sizeFor(0.2), 0.036);
  assert.ok(r.canEnter(t0, 0, 0.12).ok);
  r.onTradeClosed(0.02, t0 + 86400000); // a new day: daily limit fresh
  r.onTradeClosed(-0.03, t0 + 86400000);
  r.onTradeClosed(-0.039, t0 + 2 * 86400000); // 0.071 < half of 0.15, daily limit not hit
  assert.equal(r.canEnter(t0 + 2 * 86400000, 0, 0.07).reason, "keep-floor");
  assert.ok(r.belowFloor());
  assert.equal(r.sizeFor(0.07), 0); // below the floor: nothing fits
  const off = new RiskManager({ ...base, keepPct: 0, compound: 0 }, 0.1);
  off.onTradeClosed(0.05, t0);
  near(off.sizeFor(0.2), 0.03);
  off.onTradeClosed(-0.1, t0 + 86400000);
  assert.ok(off.canEnter(t0 + 86400000 + 3600000, 0, 0.1).reason !== "keep-floor");
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
  const t0 = Date.UTC(2026, 9, 25, 10);
  // Five runners launched together.
  const records = [0, 1, 2, 3, 4].map((i) => ({ ...synth("runner", i, t0), createdAtMs: t0 + i * 100 }));
  const capped = cfgFor({ PUMP_MAX_OPEN_POSITIONS: "2" });
  const res = await replay(records, capped, { mode: "account" });
  assert.equal(res.bankroll, capped.paperStartSol);
  assert.ok(res.trades.length <= 2, `took ${res.trades.length}`);
  // Default: no position cap, the money is the limit; strong signals buy up to 2x.
  const cfg = cfgFor();
  const all = await replay(records, cfg, { mode: "account" });
  assert.ok(all.trades.length >= res.trades.length);
  assert.ok(all.trades.every((t) => t.sizeSol <= cfg.risk.maxTradeSol * cfg.risk.convictionMax + 1e-12));
  for (const r of [res, all]) near(r.trades.reduce((a, t) => a + t.netSol, 0), r.finalCash - r.bankroll, 1e-5); // logs round to 6 decimals
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

// Borsh-encodes an Anchor event the way the pump.fun program logs it.
function anchorEventLine(disc, fields) {
  const parts = [Buffer.from(disc)];
  for (const [type, v] of fields) {
    if (type === "str") {
      const b = Buffer.from(v, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      parts.push(len, b);
    } else if (type === "key") parts.push(new web3.PublicKey(v).toBuffer());
    else if (type === "u64") {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(v));
      parts.push(b);
    } else parts.push(Buffer.from([Number(v)])); // bool / u8
  }
  return `Program data: ${Buffer.concat(parts).toString("base64")}`;
}

// A launch transaction's logs: create + the creator's buy + someone else's buy, with the
// events laid out as in pump.fun's current IDL (newer fields appended at the end).
function launchLogs({ mint, dev, other, name = "Moon Cat", symbol = "MCAT", curveOf = (m) => sol.bondingCurveAddress(m) }) {
  const P = C.PUMP_PROGRAM_ID;
  const createEvent = anchorEventLine(CREATE_EVENT, [
    ["str", name], ["str", symbol], ["str", "https://ipfs.io/ipfs/QmExample"],
    ["key", mint], ["key", curveOf(mint)], ["key", dev], ["key", dev], ["u64", 1761400000],
    ["u64", 1.073e15], ["u64", 30e9], ["u64", 7.931e14], ["u64", 1e15], ["key", C.TOKEN_PROGRAM_ID],
    ["bool", 0], ["bool", 0], ["key", "So11111111111111111111111111111111111111112"], ["u64", 30e9], ["u64", 30], ["bool", 0], ["u8", 0],
  ]);
  const trade = (user, sol, tokens) => anchorEventLine(TRADE_EVENT, [
    ["key", mint], ["u64", sol * 1e9], ["u64", tokens * 1e6], ["bool", 1], ["key", user], ["u64", 1761400000],
    ["u64", 31.5e9], ["u64", 1.022e15], ["u64", 1.5e9], ["u64", 7.42e14], ["key", other], ["u64", 95], ["u64", 1e7],
    ["key", dev], ["u64", 30], ["u64", 4e6], ["bool", 1], ["u64", 0], ["u64", 0], ["u64", 0], ["u64", 1761400000], ["str", "buy"],
  ]);
  return [
    "Program ComputeBudget111111111111111111111111111111 invoke [1]",
    "Program ComputeBudget111111111111111111111111111111 success",
    `Program ${P} invoke [1]`,
    "Program log: Instruction: Create",
    "Program 11111111111111111111111111111111 invoke [2]",
    "Program 11111111111111111111111111111111 success",
    `Program ${C.TOKEN_PROGRAM_ID} invoke [2]`,
    "Program log: Instruction: InitializeMint2",
    `Program ${C.TOKEN_PROGRAM_ID} consumed 2780 of 230000 compute units`,
    `Program ${C.TOKEN_PROGRAM_ID} success`,
    createEvent,
    `Program ${P} invoke [2]`,
    `Program ${P} consumed 2003 of 21877 compute units`,
    `Program ${P} success`,
    `Program ${P} consumed 120000 of 250000 compute units`,
    `Program ${P} success`,
    `Program ${P} invoke [1]`,
    "Program log: Instruction: Buy",
    trade(dev, 1.5, 52e6),
    `Program ${P} success`,
    `Program ${P} invoke [1]`,
    "Program log: Instruction: Buy",
    trade(other, 0.5, 15e6),
    `Program ${P} success`,
  ];
}

test("feed: launches are read from pump.fun's own log events; fakes are ignored", () => {
  // The discriminators pump.fun's published IDL lists for these events.
  assert.deepEqual([...CREATE_EVENT], [27, 114, 169, 77, 222, 235, 99, 118]);
  assert.deepEqual([...TRADE_EVENT], [189, 219, 127, 211, 78, 230, 97, 238]);
  const key = () => web3.Keypair.generate().publicKey.toBase58();
  const mint = key(), dev = key(), other = key();
  const logs = launchLogs({ mint, dev, other, name: "Moon\u001b[2J Cat" });
  const [e, ...rest] = parseCreateLogs(logs, 1234, sol.bondingCurveAddress);
  assert.equal(rest.length, 0);
  assert.equal(e.mint, mint);
  assert.equal(e.creator, dev);
  assert.equal(e.bondingCurve, sol.bondingCurveAddress(mint));
  assert.equal(e.name, "Moon[2J Cat"); // no terminal control characters
  assert.equal(e.symbol, "MCAT");
  near(e.devBuySol, 1.5); // the creator's own buy only
  near(e.devTokens, 52e6);
  assert.equal(e.createdAtMs, 1234);
  // An event whose curve isn't the coin's real pump.fun curve is not trusted.
  assert.deepEqual(parseCreateLogs(logs, 0, () => "SomeOtherAddress"), []);
  // The same event logged by another program is a fake.
  const fake = logs.map((l) => l.replace(`Program ${C.PUMP_PROGRAM_ID} invoke [1]`, `Program ${other} invoke [1]`).replace(`Program ${C.PUMP_PROGRAM_ID} success`, `Program ${other} success`));
  assert.deepEqual(parseCreateLogs(fake, 0, sol.bondingCurveAddress), []);
  // Truncated or cut-short logs: nothing to read (the feed then fetches the transaction).
  assert.deepEqual(parseCreateLogs(logs.slice(0, 6).concat(["Log truncated"]), 0), []);
  const cut = logs.map((l) => (l.startsWith("Program data: ") ? l.slice(0, 60) : l));
  assert.deepEqual(parseCreateLogs(cut, 0), []);
  // No buy in the launch: the creator bought nothing.
  const noBuy = parseCreateLogs(logs.slice(0, 16), 0, sol.bondingCurveAddress)[0];
  assert.equal(noBuy.devBuySol, 0);
});

test("poller: price checks use the free RPC, the main one only when it fails or lags", async () => {
  let now = 0;
  const calls = [];
  const answers = { free: { slot: 100 }, main: { slot: 100 } };
  const fetch = async (conn, keys) => {
    calls.push(conn);
    const a = answers[conn];
    if (a.error) throw new Error(a.error);
    return { accounts: keys.map((k) => ({ k, from: conn })), slot: a.slot };
  };
  const p = new sol.AccountPoller({ main: "main", free: "free", fetch, clock: () => now, maxLagSlots: 10, restMs: 60000 });
  assert.equal((await p.getAccounts(["A"]))[0].from, "free");
  // Lagging free node (the feed has seen slot 150): the main RPC answers, the free one rests briefly.
  p.seen(150);
  answers.main.slot = 151;
  assert.equal((await p.getAccounts(["A"]))[0].from, "main");
  assert.ok(p.resting());
  now = 11000;
  answers.free.slot = 152;
  assert.equal((await p.getAccounts(["A"]))[0].from, "free");
  // Errors (e.g. 429): main answers, the free one rests a minute.
  answers.free.error = "429 Too Many Requests";
  assert.equal((await p.getAccounts(["A"]))[0].from, "main");
  now = 30000;
  calls.length = 0;
  assert.equal((await p.getAccounts(["A"]))[0].from, "main");
  assert.deepEqual(calls, ["main"], "no calls to a resting endpoint");
  delete answers.free.error;
  now = 72000;
  assert.equal((await p.getAccounts(["A"]))[0].from, "free");
  assert.deepEqual(p.stats, { free: 3, main: 3, freeErrors: 1, stale: 1 });
  // A free endpoint that hangs never stalls the bot.
  const hang = new sol.AccountPoller({ main: "main", free: "free", timeoutMs: 20, fetch: (conn, keys) => (conn === "free" ? new Promise(() => {}) : fetch(conn, keys)) });
  assert.equal((await hang.getAccounts(["A"]))[0].from, "main");
  assert.ok(hang.resting());
  // Without a free endpoint everything goes to the main RPC.
  const solo = new sol.AccountPoller({ main: "main", fetch });
  assert.equal((await solo.getAccounts(["A"]))[0].from, "main");
});

test("config: price checks go to the public RPC unless switched off or already the main RPC", () => {
  assert.equal(cfgFor({ SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" }).pollRpcUrl, C.DEFAULT_RPC_URL);
  assert.equal(cfgFor({ SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x", PUMP_POLL_RPC_URL: "off" }).pollRpcUrl, null);
  assert.equal(cfgFor({}).pollRpcUrl, null); // main RPC is the public one already
  assert.equal(cfgFor({ PUMP_POLL_RPC_URL: "https://other.example" }).pollRpcUrl, "https://other.example");
});

test("feed: subscribes to launches only, widens to all pump.fun logs if none arrive", () => {
  const subs = [];
  const removed = [];
  const conn = { onLogs: (addr) => { subs.push(addr.toBase58()); return subs.length; }, removeOnLogsListener: async (id) => { removed.push(id); } };
  const feed = new RpcLogsFeed({ conn, derive: sol.derive, widenAfterMs: 1e9 });
  feed.start();
  assert.deepEqual(subs, ["TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"]); // pump.fun's mint authority: create/create_v2 only
  const program = new web3.PublicKey(C.PUMP_PROGRAM_ID);
  feed.launches = 1;
  feed.widen(program);
  assert.equal(subs.length, 1, "launches arrive: stays narrow");
  feed.launches = 0;
  feed.widen(program);
  assert.deepEqual(subs, ["TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM", C.PUMP_PROGRAM_ID]);
  assert.deepEqual(removed, [1]);
  feed.stop();
  assert.deepEqual(removed, [1, 2]);
});

test("feed: the RPC feed needs no lookups for readable launches and retries the rest", async () => {
  const key = () => web3.Keypair.generate().publicKey.toBase58();
  let now = 0;
  const lookups = [];
  let answer = null;
  const conn = { getTransaction: async (sig) => { lookups.push(sig); return answer; } };
  const feed = new RpcLogsFeed({ conn, derive: sol.derive, clock: () => now, maxWaitMs: 30000 });
  const got = [];
  const slots = [];
  feed.on("create", (e) => got.push(e));
  feed.on("slot", (s) => slots.push(s));
  const a = { mint: key(), dev: key(), other: key() };
  feed.onLogs({ err: null, signature: "A", logs: launchLogs(a) }, { slot: 777 });
  assert.deepEqual(slots, [777]); // the chain tip, for the poller's lag check
  feed.onLogs({ err: { InstructionError: [0, "x"] }, signature: "F", logs: launchLogs({ mint: key(), dev: key(), other: key() }) });
  feed.onLogs({ err: null, signature: "T", logs: ["Program log: Instruction: Buy"] });
  assert.equal(got.length, 1);
  assert.equal(got[0].mint, a.mint);
  assert.equal(lookups.length, 0); // read from the logs alone
  // Unreadable launch: looked up, backed off while the node doesn't have it yet.
  const b = { mint: key(), dev: key(), other: key() };
  feed.onLogs({ err: null, signature: "B", logs: [`Program ${C.PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: CreateV2", "Log truncated"] });
  await feed.drain();
  assert.deepEqual(lookups, ["B"]);
  now = 100;
  await feed.drain();
  assert.equal(lookups.length, 1); // still backing off
  now = 600;
  answer = { meta: { logMessages: launchLogs(b), postTokenBalances: [] }, transaction: { message: { staticAccountKeys: [] } } };
  await feed.drain();
  assert.equal(lookups.length, 2);
  assert.equal(got.length, 2);
  assert.equal(got[1].mint, b.mint);
  assert.equal(got[1].createdAtMs, 0); // age counts from when the launch was seen
  // A launch the RPC never returns is given up after maxWaitMs and counted.
  answer = null;
  feed.onLogs({ err: null, signature: "C", logs: [`Program ${C.PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: Create"] });
  for (now = 1000; now <= 40000; now += 500) await feed.drain();
  assert.equal(feed.missed, 1);
  assert.equal(feed.queue.length, 0);
  assert.ok(lookups.length < 15, `${lookups.length} lookups`); // backoff, not a hammer
  assert.equal(feed.fromLogs, 1);
  assert.equal(feed.launches, 3);
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
      if (state.sendThrows > 0) { state.sendThrows--; throw new Error("503 Service Unavailable"); }
      const tx = raw.length && web3.VersionedTransaction.deserialize(raw);
      const sig = base58Encode(tx.signatures[0]);
      sent.push({ raw, sig });
      const o = outcomes.shift() || { status: "confirmed", meta: { preBalances: [0], postBalances: [0], preTokenBalances: [], postTokenBalances: [] } };
      bySig.set(sig, o);
      if (o.tokensOnSend !== undefined) state.tokens = o.tokensOnSend; // coins leave before the status is visible
      if (o.closesOnSend) state.ataGone = true;
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
          if (o.tokensAfter !== undefined && !o.applied) { state.tokens = o.tokensAfter; o.applied = true; if (o.closesAccount) state.ataGone = true; }
          return { confirmationStatus: "confirmed", err: null };
        }),
      };
    },
    async getTransaction(sig) {
      const o = bySig.get(sig);
      if (o && o.unreadable) return null; // landed, but the RPC can't return it yet
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
    async getMultipleAccountsInfo(keys) {
      // The wallet's token account for this coin (classic token program), unless a sale closed it.
      const ata = sol.ataAddress(me, mint, C.TOKEN_PROGRAM_ID);
      return keys.map((k) => {
        if (state.ataGone || String(k.toBase58 ? k.toBase58() : k) !== ata) return null;
        if (state.hideReads > 0) { state.hideReads--; return null; } // a node that hasn't applied our buy yet
        const d = Buffer.alloc(165);
        d.writeBigUInt64LE(BigInt(Math.round(state.tokens * 1e6)), 64);
        return { data: d, owner: new web3.PublicKey(C.TOKEN_PROGRAM_ID), lamports: 2039280 };
      });
    },
    async getParsedTokenAccountsByOwner() {
      if (state.ataGone) return { value: [] };
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
  const markUnreadable = (sig) => { const o = bySig.get(sig); if (o) o.unreadable = true; };
  return { conn, fetchImpl, bodies, state, me, landLate, markUnreadable, build: (b) => { nextBuild = b; } };
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

test("curve: non-standard curves are detected, dropped from watching and skipped by the strategy", async () => {
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
  // Odd coins are never traded, so they stop being polled (and aren't recorded).
  assert.deepEqual(tr.expire(1000), []);
  assert.equal(tr.tokens.has("ODD"), false);
  assert.equal(tr.tokens.has("STD"), true);
  const keep = new Tracker(cfgFor({ PUMP_REQUIRE_STANDARD_CURVE: "0" }), { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  keep.add({ mint: "ODD", createdAtMs: 0 }, 0);
  keep.ingest([{ key: "c#ODD", mint: "ODD", kind: "curve", account: { data: curve.encodeBondingCurve({ vSol, vTok, realSol: 0, realTok: 793.1e6 }), owner: C.PUMP_PROGRAM_ID } }], 1000);
  keep.expire(1000);
  assert.equal(keep.tokens.has("ODD"), true); // kept when odd curves are allowed
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

test("live broker: a sale that closed the token account itself needs no second close", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [{ status: "confirmed", meta: meta(me, mint, 0.04 + 0.00203928, 1000, 0), tokensAfter: 0, closesAccount: true }]);
  net.state.tokens = 1000;
  const r = await newBroker(cfg, kp, net).sell({ mint, fraction: 1 });
  assert.ok(r.ok, r.error);
  assert.equal(r.closed, true);
  assert.equal(r.closeError, null, "no false warning");
  assert.equal(r.rentRefund, 0);
  near(r.solReceived, 0.04 + 0.00203928); // the rent came back inside the sale
  assert.equal(net.conn.sent.length, 1, "no separate close transaction");
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

test("live broker: a take-profit that timed out but landed is booked once, not twice", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [
    { status: "late", meta: meta(me, mint, 0.02, 1000, 500), tokensOnSend: 500 }, // lands, status not visible yet
    { status: "confirmed", meta: meta(me, mint, 0.022, 500, 0), tokensAfter: 0 },
    { status: "confirmed", meta: meta(me, mint, 0.00203928, 0, 0) },
  ]);
  net.state.tokens = 1000;
  const lb = newBroker(cfg, kp, net);
  const tp = await lb.sell({ mint, fraction: 0.5, estimateSol: 0.02 });
  assert.ok(tp.ok && tp.estimated && !tp.closed);
  near(tp.solReceived, 0.02);
  net.landLate();
  const rest = await lb.sell({ mint, fraction: 1, estimateSol: 0.022 });
  assert.ok(rest.ok, rest.error);
  assert.equal(rest.closed, true);
  near(tp.solReceived + rest.solReceived, 0.02 + 0.022 + 0.00203928); // the late 50% is not counted again
  assert.deepEqual(net.bodies.map((b) => b.amount), ["50%", "100%"]);
});

test("live broker: a sale that landed but can't be read back is booked as an estimate plus rent", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [
    { status: "late", meta: meta(me, mint, 0.04, 1000, 0) }, // still in flight when we stop waiting
    { status: "dropped" }, { status: "dropped" },
  ]);
  net.state.tokens = 1000;
  const lb = newBroker(cfg, kp, net);
  assert.equal((await lb.sell({ mint, fraction: 1, estimateSol: 0.04 })).ok, false);
  // It lands (closing the account) but the RPC can't return the transaction yet.
  const first = [...net.conn.sent][0].sig;
  net.landLate();
  net.state.tokens = 0;
  net.state.ataGone = true;
  net.markUnreadable(first);
  const r = await lb.sell({ mint, fraction: 1, estimateSol: 0.04 });
  assert.ok(r.ok, r.error);
  assert.equal(r.estimated, true);
  assert.equal(r.closed, true);
  near(r.solReceived, 0.04 + C.TOKEN_ACCOUNT_RENT_SOL);
  assert.equal(net.conn.sent.length, 3, "nothing new was sent");
});

test("live broker: zero coins on the first read is checked again, never booked as a free sale", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [
    { status: "confirmed", meta: meta(me, mint, 0.04, 1000, 0), tokensAfter: 0 },
    { status: "confirmed", meta: meta(me, mint, 0.00203928, 0, 0) },
  ]);
  net.state.tokens = 1000;
  net.state.hideReads = 1; // the first read comes from a node that hasn't applied our buy yet
  const r = await newBroker(cfg, kp, net).sell({ mint, fraction: 1, estimateSol: 0.04 });
  assert.ok(r.ok, r.error);
  near(r.tokensSold, 1000);
  near(r.solReceived, 0.04 + 0.00203928);
  assert.deepEqual(net.bodies.map((b) => b.amount), ["100%"]);
  // No coins and no sale of ours anywhere: say so instead of booking a sale.
  const empty = mockNet(kp, mint, []);
  const g = await newBroker(cfg, kp, empty).sell({ mint, fraction: 1, estimateSol: 0.04 });
  assert.equal(g.ok, false);
  assert.equal(g.goneWithoutSale, true);
});

test("live broker: a take-profit that failed on-chain is retried as a take-profit, not a full exit", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [
    { status: "failed" },
    { status: "confirmed", meta: meta(me, mint, 0.02, 1000, 500), tokensAfter: 500 },
  ]);
  net.state.tokens = 1000;
  const r = await newBroker(cfg, kp, net).sell({ mint, fraction: 0.5, estimateSol: 0.02 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(net.bodies.map((b) => b.amount), ["50%", "50%"], "the runner is kept");
  assert.equal(r.closed, false);
  near(r.tokensSold, 500);
});

test("live broker: a deposit is not profit and doesn't raise the budget; a buy holds its worst case", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const buyMeta = { preBalances: [2e8], postBalances: [2e8 - 0.0306e9], preTokenBalances: tb(me, mint, 0), postTokenBalances: tb(me, mint, 1000) };
  const net = mockNet(kp, mint, [{ status: "confirmed", meta: buyMeta, tokensAfter: 1000 }]);
  net.state.preLamports = 1e8; // 0.1 SOL
  const lb = newBroker(cfg, kp, net, { budgetSol: 0.1 });
  await lb.refreshBalance();
  near(lb.availableSol(), 0.1);
  net.state.preLamports = 2e8; // the owner sends 0.1 SOL while the bot runs
  await lb.refreshBalance();
  near(lb.availableSol(), 0.1, 1e-9);
  near(lb.externalSol(), 0.1, 1e-9);
  const p = lb.buy({ mint, sol: 0.03 });
  near(lb.committed, 0.03 * 1.2 + C.TOKEN_ACCOUNT_RENT_SOL + lb.txFeeSol(), 1e-12); // held while in flight
  net.state.preLamports = 2e8 - 0.0306e9;
  const r = await p;
  assert.ok(r.ok, r.error);
  near(lb.committed, 0, 1e-12);
  near(lb.flowSol, -0.0306, 1e-9);
  near(lb.availableSol(), 0.1 - 0.0306, 1e-9); // the budget minus what trading spent
  near(lb.externalSol(), 0.1, 1e-9); // still just the deposit
});

test("engine: P&L counts closed trades and open coins, not the wallet balance", () => {
  const { Engine } = require("../pump/lib/engine.cjs");
  const cfg = cfgFor();
  const eng = new Engine({ cfg, tracker: new Tracker(cfg, null), broker: { mode: "live" }, risk: new RiskManager(cfg.risk, 0.1), recorder: null, rpc: null });
  const { vSol, vTok } = curve.reservesFromRealSol(10);
  const tokens = curve.quoteBuyTokens(vSol, vTok, 0.03);
  eng.positions.set("M", { mint: "M", state: "open", tokens, costSol: 0.0326, proceedsSol: 0, lastF: { vSol: vSol + 0.03, vTok: vTok - tokens } });
  eng.positions.set("B", { mint: "B", state: "buying", tokens: 0, costSol: 0, proceedsSol: 0 }); // not filled yet
  const back = curve.liquidationValueSol(vSol + 0.03, vTok - tokens, tokens, eng.feeFraction()) + C.TOKEN_ACCOUNT_RENT_SOL;
  near(eng.unrealizedSol(), back - 0.0326, 1e-12);
});

test("live broker: full exits use a wide bound at once and retry an on-chain failure without idling", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [
    { status: "failed" },
    { status: "confirmed", meta: meta(me, mint, 0.04, 1000, 0), tokensAfter: 0 },
    { status: "confirmed", meta: meta(me, mint, 0.00203928, 0, 0) },
  ]);
  net.state.tokens = 1000;
  const lb = newBroker(cfg, kp, net);
  let balanceReads = 0;
  const realBalance = lb.tokenBalance.bind(lb);
  lb.tokenBalance = (m) => { balanceReads++; return realBalance(m); };
  const r = await lb.sell({ mint, fraction: 1, estimateSol: 0.04 });
  assert.ok(r.ok, r.error);
  assert.deepEqual(net.bodies.map((b) => b.slippage), [60, 70], "a full exit doesn't climb 25 -> 40 -> 60");
  assert.equal(balanceReads, 2, "one read before selling, one after the exit; none between the attempts");
  near(r.feesSol, lb.txFeeSol());
});

test("live broker: a send that errored is re-sent through the second endpoint (same bytes)", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, [{ status: "confirmed", meta: meta(me, mint, -0.0306, 0, 1000), tokensAfter: 1000 }]);
  net.state.sendThrows = 1; // the main RPC refuses the first send
  const pushed = [];
  const rebroadcastConn = { sendRawTransaction: (raw, o) => { pushed.push(Buffer.from(raw).toString("base64")); return net.conn.sendRawTransaction(raw, o); } };
  const r = await newBroker(cfg, kp, net, { rebroadcastConn }).buy({ mint, sol: 0.03 });
  assert.ok(r.ok, r.error);
  assert.equal(pushed.length >= 1, true);
  assert.equal(net.conn.sent.length, 1, "the same transaction landed once");
  assert.equal(Buffer.from(net.conn.sent[0].raw).toString("base64"), pushed[0]);
});

// A trade transaction's logs with this wallet's TradeEvent (post-trade reserves included).
function tradeLogs({ mint, user, isBuy, sol, tokens, vSolAfter, vTokAfter, short = false }) {
  const head = [["key", mint], ["u64", Math.round(sol * 1e9)], ["u64", Math.round(tokens * 1e6)], ["bool", isBuy ? 1 : 0], ["key", user]];
  const tail = [["u64", 1761400000], ["u64", Math.round(vSolAfter * 1e9)], ["u64", Math.round(vTokAfter * 1e6)], ["u64", Math.round((vSolAfter - 30) * 1e9)], ["u64", 7e14]];
  return [`Program ${C.PUMP_PROGRAM_ID} invoke [1]`, `Program log: Instruction: ${isBuy ? "Buy" : "Sell"}`, anchorEventLine(TRADE_EVENT, short ? head : head.concat(tail)), `Program ${C.PUMP_PROGRAM_ID} success`];
}

test("fills: the real price comes from the wallet's own trade event (pre-trade curve price)", async () => {
  const me = web3.Keypair.generate().publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const logs = tradeLogs({ mint, user: me, isBuy: true, sol: 0.03, tokens: 9e5, vSolAfter: 40.03, vTokAfter: 8.04e8 });
  const f = walletFill(logs, mint, me, true);
  near(f.fillPrice, 40 / 8.049e8, 1e-15); // the curve just before this buy
  near(f.avgPrice, 0.03 / 9e5, 1e-15);
  near(f.realSolAfter, 10.03, 1e-9);
  assert.equal(walletFill(logs, mint, web3.Keypair.generate().publicKey.toBase58(), true), null, "someone else's trade");
  const short = walletFill(tradeLogs({ mint, user: me, isBuy: true, sol: 0.03, tokens: 9e5, short: true }), mint, me, true);
  assert.equal(short.fillPrice, null); // older layout: amounts only
  near(short.sol, 0.03);
  // The live broker reports it with the buy; the engine then measures gains from it.
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const buyMeta = { ...meta(wallet, mint, -0.0326, 0, 9e5), logMessages: tradeLogs({ mint, user: wallet, isBuy: true, sol: 0.0295, tokens: 9e5, vSolAfter: 40.0295, vTokAfter: 8.04e8 }) };
  const net = mockNet(kp, mint, [{ status: "confirmed", meta: buyMeta, tokensAfter: 9e5 }]);
  const r = await newBroker(cfg, kp, net).buy({ mint, sol: 0.03 });
  assert.ok(r.ok, r.error);
  near(r.fillPrice, 40 / 8.049e8, 1e-15);
  assert.equal(r.fillSource, "event");
  assert.ok(Number.isFinite(r.premiumPct));
});

test("recorder: failed buys get their own log", () => {
  const { Recorder } = require("../pump/lib/recorder.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pump-rec-"));
  const rec = new Recorder(dir, cfgFor().runtime);
  rec.recordBuyFail("live", { atMs: Date.UTC(2026, 9, 25, 22), mint: "M", error: "failed on-chain: 6002", final: true });
  const rows = fs.readFileSync(path.join(dir, "buyfails-live-2026-10-25.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].error, "failed on-chain: 6002");
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

test("engine: shutdown waits for a sale started by a late-fill check; failed-on-chain buys aren't re-checked", async () => {
  const { Engine } = require("../pump/lib/engine.cjs");
  const { Recorder } = require("../pump/lib/recorder.cjs");
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  for (const m of ["LATE", "FAIL"]) {
    tr.add({ mint: m, symbol: m, createdAtMs: 0 }, 0);
    tr.ingest([{ key: `c#${m}`, mint: m, kind: "curve", account: fakeAccount(8) }], 0);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const broker = {
    mode: "live",
    availableSol: () => 0.1,
    buy: async ({ mint }) => (mint === "FAIL" ? { ok: false, error: "failed on-chain", sig: "S2", feesSol: 0.0001, final: true } : { ok: false, error: "not confirmed in time", sig: "S1", feesSol: 0 }),
    tokenBalance: async () => { await wait(20); return 1234; },
    estimateBuyCost: (s) => s * 1.0175 + 0.0021,
    sell: async () => { await wait(20); return { ok: true, solReceived: 0.025, tokensSold: 1234, closed: true }; },
  };
  let now = 1000;
  const rpc = { getAccounts: async (keys) => keys.map(() => fakeAccount(8)), getLargestHolders: async () => [] };
  const eng = new Engine({ cfg, tracker: tr, broker, risk: new RiskManager(cfg.risk, 0.1), recorder: new Recorder("", cfg.runtime, { enabled: false }), rpc, clock: () => now });
  eng.buy(tr.features("LATE", now), 0.03, now);
  eng.buy(tr.features("FAIL", now), 0.03, now);
  await eng.settle();
  assert.deepEqual(eng.lateFillChecks.map((c) => c.mint), ["LATE"]);
  now = 50000;
  eng.stopping = true;
  eng.checkLateFills(now);
  assert.equal(eng.busy(), true, "a lookup in flight keeps the bot from quitting");
  await eng.settle();
  assert.equal(eng.closedTrades.length, 1, "the sale it started finished before settle returned");
  assert.equal(eng.busy(), false);
});

test("engine: a creator sale during the buy is acted on as soon as the buy fills", async () => {
  const { Engine } = require("../pump/lib/engine.cjs");
  const { Recorder } = require("../pump/lib/recorder.cjs");
  const cfg = cfgFor();
  const tr = new Tracker(cfg, { bondingCurve: (m) => `c#${m}`, ata: () => "x" });
  tr.add({ mint: "RUG", symbol: "RUG", createdAtMs: 0 }, 0);
  tr.ingest([{ key: "c#RUG", mint: "RUG", kind: "curve", account: fakeAccount(8) }], 0);
  const sells = [];
  let fill;
  const broker = {
    mode: "live",
    availableSol: () => 0.1,
    buy: () => new Promise((r) => { fill = r; }),
    sell: async (o) => { sells.push(o.reason); return { ok: true, solReceived: 0.02, tokensSold: 1000, closed: true }; },
  };
  let now = 1000;
  const eng = new Engine({ cfg, tracker: tr, broker, risk: new RiskManager(cfg.risk, 0.1), recorder: new Recorder("", cfg.runtime, { enabled: false }), rpc: null, clock: () => now });
  eng.buy(tr.features("RUG", now), 0.03, now);
  now = 2500;
  tr.tokens.get("RUG").devSoldAtMs = 2000; // the creator dumps while our buy is in flight
  fill({ ok: true, tokens: 1000, solSpent: 0.0326 });
  await eng.settle();
  assert.deepEqual(sells, ["dev-sold"], "sold in the same step as the fill, not a tick later");
});

test("solana: batches of a big poll go out together", async () => {
  let inFlight = 0, most = 0;
  const conn = {
    getMultipleAccountsInfoAndContext: async (keys) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { context: { slot: 100 + keys.length }, value: keys.map(() => null) };
    },
  };
  const keys = Array.from({ length: 150 }, () => web3.Keypair.generate().publicKey.toBase58());
  const r = await sol.getAccountsAt(conn, keys);
  assert.equal(most, 2);
  assert.equal(r.accounts.length, 150);
  assert.equal(r.slot, 150); // the older of the two answers
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
