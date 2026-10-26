#!/usr/bin/env node
"use strict";

// What did the losing trades have in common at the moment the bot bought them?
// Reads the live trade log and the research recordings in data/pump/ and prints, for each
// entry feature, how trades in each range turned out. Paste the output to whoever tunes the bot.
//
//   node pump/analyze.cjs

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config.cjs");
const { replay } = require("./lib/replay.cjs");

const cfg = loadConfig({});
const dir = cfg.dataDir;

function readJsonl(re) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => re.test(n)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* torn last line */ }
    }
  }
  return out;
}

const FEATURES = [
  ["age at buy (s)", (e) => e.ageSec, [25, 40, 90]],
  ["SOL in curve", (e) => e.realSol, [8, 12, 20]],
  ["inflow last 30s", (e) => e.inflow30, [4, 7, 10]],
  ["inflow last 15s", (e) => e.inflow15, [1.5, 3, 5]],
  ["below its peak (%)", (e) => e.drawdownFromPeakPct, [2, 5, 9]],
  ["creator's buy (SOL)", (e) => e.devBuySol, [0.01, 0.5, 1.5]],
  ["top holder (%)", (e) => e.holders && e.holders.top1Pct, [3, 5, 7]],
  ["top 10 holders (%)", (e) => e.holders && e.holders.top10Pct, [15, 22, 29]],
  ["bet size x", (e) => e.conviction, [1.3, 1.7]],
];

function bucketLabel(v, cuts) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "unknown";
  for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return i === 0 ? `< ${cuts[0]}` : `${cuts[i - 1]}-${cuts[i]}`;
  return `>= ${cuts[cuts.length - 1]}`;
}

function report(title, trades) {
  console.log(`\n=== ${title}: ${trades.length} trades`);
  if (!trades.length) return;
  const sum = (rs, f) => rs.reduce((a, r) => a + f(r), 0);
  const line = (label, rs) => {
    const wins = rs.filter((t) => t.netSol > 0).length;
    const deep = rs.filter((t) => t.netPct <= -15).length;
    const cost = sum(rs, (t) => t.costSol) || 1;
    console.log(`  ${label.padEnd(12)} n ${String(rs.length).padStart(3)} | win ${String(Math.round((100 * wins) / rs.length)).padStart(3)}% | lost 15%+ ${String(Math.round((100 * deep) / rs.length)).padStart(3)}% | net ${(sum(rs, (t) => t.netSol) >= 0 ? "+" : "") + sum(rs, (t) => t.netSol).toFixed(4)} SOL | ${((100 * sum(rs, (t) => t.netSol)) / cost).toFixed(1)}% per SOL`);
  };
  line("all", trades);
  for (const [name, get, cuts] of FEATURES) {
    const groups = new Map();
    for (const t of trades) {
      const k = bucketLabel(get(t.entry || {}), cuts);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    if (groups.size === 1 && groups.has("unknown")) continue;
    console.log(` ${name}`);
    const order = ["unknown", `< ${cuts[0]}`, ...cuts.slice(1).map((c, i) => `${cuts[i]}-${c}`), `>= ${cuts[cuts.length - 1]}`];
    for (const k of order) if (groups.has(k)) line(k, groups.get(k));
  }
  const reasons = {};
  for (const t of trades) {
    const r = (t.exits && t.exits.length && t.exits[t.exits.length - 1].reason) || "?";
    reasons[r] = reasons[r] || [];
    reasons[r].push(t);
  }
  console.log(" last exit reason");
  for (const [r, rs] of Object.entries(reasons)) line(r, rs);
}

(async () => {
  const live = readJsonl(/^trades-live-.*\.jsonl$/).filter((t) => Number.isFinite(t.netSol));
  report("LIVE trades", live);
  const records = readJsonl(/^research-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const usable = records.filter((r) => r.maxRealSol >= cfg.strategy.minRealSol);
  if (usable.length) {
    const res = await replay(usable, cfg, { mode: "edge", sizeSol: 0.03 });
    report(`REPLAY of ${records.length} recorded coins (every signal, 0.03 SOL, current rules)`, res.trades);
  } else {
    console.log("\n(no research recordings yet)");
  }
})().catch((e) => {
  console.error(`Error: ${e.stack || e.message}`);
  process.exit(1);
});
