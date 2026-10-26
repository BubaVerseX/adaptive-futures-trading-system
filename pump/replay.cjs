#!/usr/bin/env node
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { loadConfig, validate } = require("./lib/config.cjs");
const { replay, metrics, splitByTime, stressCosts } = require("./lib/replay.cjs");

const HELP = `Measure the strategy on coins the bot recorded (data/pump/research-*.jsonl).

  node pump/replay.cjs              default (or --params) strategy: edge test, halves, 1.5x fees, $10 account
  node pump/replay.cjs --sweep      search parameters on the first half, judge them on the second half
  node pump/replay.cjs --sweep --quick   smaller search
  node pump/replay.cjs --compare    current settings vs. "patience" and "second chance" switches

Options: --params file.json, --size SOL (edge-test trade size, default 0.03)`;

const GRID_FULL = { minRealSol: [4, 6, 10], minInflow30: [1.5, 2.5, 4], stopLossPct: [10, 15, 25], tp1Pct: [25, 35, 60] };
const GRID_QUICK = { minRealSol: [4, 8], minInflow30: [1.5, 3], stopLossPct: [12, 20], tp1Pct: [30, 60] };

// What the live trades and the recordings pointed at (Oct 26): coins whose creator bought at
// launch lost in both; coins bought older did better in replay; stop-loss exits fill ~30% down.
const COMPARE_VARIANTS = [
  ["current settings", {}],
  ["creator bought nothing (skip if the creator bought > 0.01 SOL at launch)", { maxDevBuySol: 0.01 }],
  ["older coins (buy at 90-180s old)", { entryMinAgeSec: 90 }],
  ["creator bought nothing + older coins", { maxDevBuySol: 0.01, entryMinAgeSec: 90 }],
  ["tighter stop-loss (8%)", { stopLossPct: 8 }],
  ["creator bought nothing + tighter stop-loss", { maxDevBuySol: 0.01, stopLossPct: 8 }],
  ["creator holds a small bag only (skip if > 3% of supply)", { maxDevHoldPct: 3 }],
  // Same trades, sized by conviction: worth it only if it earns more per SOL bought.
  ["bigger buys when sure (strong buying gets up to 2x)", {}, { conviction: true }],
];

const perSol = (trades) => {
  const cost = trades.reduce((a, t) => a + t.costSol, 0);
  return cost > 0 ? (trades.reduce((a, t) => a + t.netSol, 0) / cost) * 100 : 0;
};

function parseArgs(argv) {
  const a = { size: 0.03 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--sweep") a.sweep = true;
    else if (k === "--compare") a.compare = true;
    else if (k === "--quick") a.quick = true;
    else if (k === "--params") a.params = argv[++i];
    else if (k === "--size") a.size = Number(argv[++i]);
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown option ${k}`);
  }
  return a;
}

function loadRecords(dir) {
  if (!fs.existsSync(dir)) return { records: [], files: [] };
  const files = fs.readdirSync(dir).filter((f) => /^research-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const records = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch (_) { /* skip a torn last line */ }
    }
  }
  return { records, files };
}

const pf = (x) => (x === Infinity ? "inf" : x.toFixed(2));
const fmt = (m) =>
  m.n ? `${String(m.n).padStart(4)} trades | win ${m.winRatePct.toFixed(0).padStart(3)}% | PF ${pf(m.profitFactor).padStart(5)} | net ${(m.netSol >= 0 ? "+" : "") + m.netSol.toFixed(4)} SOL | avg ${m.avgNetPct.toFixed(1)}%/trade | max drawdown ${m.maxDrawdownSol.toFixed(4)} SOL`
      : "   0 trades";

function cartesian(grid) {
  return Object.entries(grid).reduce((acc, [k, vals]) => acc.flatMap((o) => vals.map((v) => ({ ...o, [k]: v }))), [{}]);
}

function withStrategy(cfg, overrides) {
  const c = JSON.parse(JSON.stringify(cfg));
  Object.assign(c.strategy, overrides);
  validate(c);
  return c;
}

async function evaluate(records, cfg, size) {
  const [h1, h2] = splitByTime(records);
  const full = metrics((await replay(records, cfg, { mode: "edge", sizeSol: size })).trades);
  const m1 = metrics((await replay(h1, cfg, { mode: "edge", sizeSol: size })).trades);
  const m2 = metrics((await replay(h2, cfg, { mode: "edge", sizeSol: size })).trades);
  const stress = metrics((await replay(records, stressCosts(cfg, 1.5), { mode: "edge", sizeSol: size })).trades);
  return { full, m1, m2, stress };
}

function verdict({ full, m1, m2, stress }) {
  const checks = [
    ["100+ trades", full.n >= 100],
    ["profit factor above 1.3", full.profitFactor > 1.3],
    ["profitable in both halves", m1.netSol > 0 && m2.netSol > 0],
    ["still profitable with 1.5x fees", stress.netSol > 0],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "fail"}  ${name}`);
  const passed = checks.every(([, ok]) => ok);
  console.log(passed ? "\nVERDICT: edge shows up on this data. Keep collecting; re-check before adding money." : "\nVERDICT: NOT PROVEN. Treat live trading as paying for data, not as income.");
  return passed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const cfg = loadConfig({ paramsFile: args.params });
  const { records, files } = loadRecords(cfg.dataDir);
  if (!records.length) {
    console.log(`No research data in ${cfg.dataDir} yet. Let the bot run (paper mode is fine) for a few hours: node pump/bot.cjs`);
    return;
  }
  const grid = args.quick ? GRID_QUICK : GRID_FULL;
  const minReal = Math.min(
    cfg.strategy.minRealSol,
    ...(args.sweep ? grid.minRealSol : []),
    ...(args.compare ? COMPARE_VARIANTS.map(([, v]) => v.minRealSol ?? Infinity) : [])
  );
  // Coins that never reached the entry threshold can't trade; leaving them out only saves time.
  const usable = records.filter((r) => r.maxRealSol >= minReal);
  const t0 = Math.min(...records.map((r) => r.createdAtMs));
  const t1 = Math.max(...records.map((r) => r.createdAtMs));
  console.log(`Data: ${files.length} file(s), ${records.length} active coins over ${((t1 - t0) / 3600000).toFixed(1)} hours; ${usable.length} ever reached ${minReal} SOL.`);
  console.log(`Edge test: every signal taken at ${args.size} SOL, real fees, fills ~${cfg.costs.latencyMs}ms after the decision.\n`);

  if (args.compare) {
    const [, h2] = splitByTime(usable);
    for (const [name, change, opts = {}] of COMPARE_VARIANTS) {
      const c = withStrategy(cfg, change);
      const allTrades = (await replay(usable, c, { mode: "edge", sizeSol: args.size, ...opts })).trades;
      const lateTrades = (await replay(h2, c, { mode: "edge", sizeSol: args.size, ...opts })).trades;
      const all = metrics(allTrades), late = metrics(lateTrades);
      console.log(`${name}\n   all data     ${fmt(all)}\n   second half  ${fmt(late)}\n   per SOL      ${perSol(allTrades).toFixed(1)}% all data, ${perSol(lateTrades).toFixed(1)}% second half`);
    }
    console.log("\nA switch is worth turning on only if its per-SOL result beats \"current settings\" on all data AND on the second half,");
    console.log("is above 0 in both, and still has a decent number of trades. With few trades, differences can be luck.");
    return;
  }

  if (!args.sweep) {
    const e = await evaluate(usable, cfg, args.size);
    console.log(`all data     ${fmt(e.full)}`);
    console.log(`first half   ${fmt(e.m1)}`);
    console.log(`second half  ${fmt(e.m2)}`);
    console.log(`fees x1.5    ${fmt(e.stress)}`);
    if (e.full.n) console.log(`exit reasons ${JSON.stringify(e.full.reasons)}`);
    const acct = await replay(usable, cfg, { mode: "account" });
    console.log(`\n$10-style account (${acct.bankroll} SOL, real limits): ${acct.bankroll} -> ${acct.finalCash.toFixed(4)} SOL over ${acct.trades.length} trades`);
    if (acct.unknownHolders) console.log(`(holder data missing for ${acct.unknownHolders} checks in the recording; assumed fine, which flatters results)`);
    console.log("");
    verdict(e);
    return;
  }

  const [train, test] = splitByTime(usable);
  const combos = cartesian(grid);
  console.log(`Sweep: ${combos.length} parameter sets, chosen on the first half (${train.length} coins), judged on the second half (${test.length} coins).`);
  const rows = [];
  for (const combo of combos) {
    let c;
    try { c = withStrategy(cfg, combo); } catch (_) { continue; }
    const m = metrics((await replay(train, c, { mode: "edge", sizeSol: args.size })).trades);
    rows.push({ combo, train: m });
    process.stdout.write(".");
  }
  console.log("\n");
  const ranked = rows.filter((r) => r.train.n >= 10).sort((a, b) => b.train.netSol - a.train.netSol).slice(0, 5);
  if (!ranked.length) {
    console.log("Not enough trades in the first half to choose anything. Collect more data.");
    return;
  }
  for (const r of ranked) {
    r.test = metrics((await replay(test, withStrategy(cfg, r.combo), { mode: "edge", sizeSol: args.size })).trades);
    console.log(JSON.stringify(r.combo));
    console.log(`   first half (chosen on) ${fmt(r.train)}`);
    console.log(`   second half (honest)   ${fmt(r.test)}`);
  }
  const best = ranked[0];
  const bestCfg = withStrategy(cfg, best.combo);
  console.log(`\nBest on the first half: ${JSON.stringify(best.combo)}. Full check on all data:`);
  const e = await evaluate(usable, bestCfg, args.size);
  const passed = verdict(e);
  const out = path.join(cfg.dataDir, "best-params.json");
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    strategy: bestCfg.strategy,
    validation: { passed, train: best.train, secondHalf: best.test, all: e.full, feesX15: e.stress },
  }, null, 2));
  console.log(`\nSaved to ${out}. Use it with: node pump/bot.cjs --params ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(`Error: ${e.stack || e.message}`);
  process.exit(1);
});
