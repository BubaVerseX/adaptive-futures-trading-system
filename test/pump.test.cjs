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
const { createWallet, loadWallet, base58Decode } = require("../pump/lib/wallet.cjs");

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
  near(eng.closedTrades[0].netSol, 0.025 - 0.03 - cfg.costs.priorityFeeSol, 1e-6);
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

function buildTx(payer, transferLamports = 0) {
  const ixs = [web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })];
  if (transferLamports) ixs.push(web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: web3.Keypair.generate().publicKey, lamports: transferLamports }));
  const msg = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message();
  return new web3.VersionedTransaction(msg).serialize();
}

function mockNet(kp, mint, metas) {
  const bodies = [];
  const conn = {
    sent: [],
    async sendRawTransaction(raw) { this.sent.push(raw); return `SIG${this.sent.length}`; },
    async getSignatureStatuses() { return { value: [{ confirmationStatus: "confirmed", err: null }] }; },
    async getTransaction() { return { meta: metas.shift() }; },
    async getBalance() { return 1e8; },
    accounts: [],
    async getParsedTokenAccountsByOwner() { return { value: this.accounts }; },
    async getLatestBlockhash() { return { blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }; },
  };
  let nextTransfer = 0;
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const bytes = buildTx(kp.publicKey, nextTransfer);
    return { status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => "" };
  };
  return { conn, fetchImpl, bodies, setTransfer: (l) => { nextTransfer = l; } };
}

test("live broker: buy is checked, signed locally and accounted from the chain", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const tb = (amt) => [{ owner: me, mint, uiTokenAmount: { amount: String(amt), decimals: 6 } }];
  const net = mockNet(kp, mint, [{ preBalances: [1e8], postBalances: [1e8 - 32_144_280], preTokenBalances: [], postTokenBalances: tb(1_000_000_000) }]);
  const lb = new LiveBroker(cfg, { conn: net.conn, keypair: kp, budgetSol: 0.05, fetchImpl: net.fetchImpl, sleepFn: async () => {} });
  await lb.refreshBalance();
  near(lb.availableSol(), 0.05);
  const r = await lb.buy({ mint, sol: 0.03 });
  assert.ok(r.ok, r.error);
  near(r.tokens, 1000);
  near(r.solSpent, 0.03214428);
  assert.equal(net.bodies[0].action, "buy");
  assert.equal(net.bodies[0].denominatedInSol, "true");
  assert.equal(net.bodies[0].pool, "pump");
  const signed = web3.VersionedTransaction.deserialize(net.conn.sent[0]);
  assert.ok(signed.signatures[0].some((b) => b !== 0), "transaction was signed");
});

test("live broker: refuses a transaction that sends SOL out directly", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const net = mockNet(kp, mint, []);
  net.setTransfer(0.5 * 1e9);
  const lb = new LiveBroker(cfg, { conn: net.conn, keypair: kp, fetchImpl: net.fetchImpl, sleepFn: async () => {} });
  const r = await lb.buy({ mint, sol: 0.03 });
  assert.equal(r.ok, false);
  assert.match(r.error, /refused transaction/);
  assert.equal(net.conn.sent.length, 0, "nothing was sent");
});

test("live broker: full sell reads proceeds and closes the empty account for the rent", async () => {
  const cfg = cfgFor();
  const kp = web3.Keypair.generate();
  const me = kp.publicKey.toBase58();
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const tb = (amt) => [{ owner: me, mint, uiTokenAmount: { amount: String(amt), decimals: 6 } }];
  const net = mockNet(kp, mint, [
    { preBalances: [5e7], postBalances: [5e7 + 40_000_000], preTokenBalances: tb(1_000_000_000), postTokenBalances: tb(0) },
    { preBalances: [9e7], postBalances: [9e7 + 2_034_280], preTokenBalances: [], postTokenBalances: [] },
  ]);
  net.conn.accounts = [{ pubkey: web3.Keypair.generate().publicKey, account: { owner: new web3.PublicKey(C.TOKEN_PROGRAM_ID), data: { parsed: { info: { mint, tokenAmount: { amount: "0", uiAmount: 0 } } } } } }];
  const lb = new LiveBroker(cfg, { conn: net.conn, keypair: kp, fetchImpl: net.fetchImpl, sleepFn: async () => {} });
  const r = await lb.sell({ mint, fraction: 1 });
  assert.ok(r.ok, r.error);
  near(r.tokensSold, 1000);
  near(r.rentRefund, 0.00203428);
  near(r.solReceived, 0.04 + 0.00203428);
  assert.equal(net.bodies[0].amount, "100%");
  assert.equal(net.bodies[0].pool, "auto");
  assert.equal(net.conn.sent.length, 2, "sell + close account");
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
