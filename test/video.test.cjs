"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const data = require("../video/lib/data.cjs");
const { parseArgs } = require("../video/make.cjs");

const trade = (mint, symbol, openedAtMs, closedAtMs, netSol, reason = "stop-loss") => ({
  mint, symbol, openedAtMs, closedAtMs, sizeSol: 0.02, netSol, netPct: (netSol / 0.02) * 100, exits: [{ reason }],
});

test("pump: trades sorted by close and tied to the line of the coin they bought", () => {
  const research = [
    { mint: "A", createdAtMs: 1000, maxRealSol: 5 },
    { mint: "B", createdAtMs: 2000, maxRealSol: 50 },
    { mint: "C", createdAtMs: 3000, maxRealSol: 1 },
  ];
  const bot = data.pumpTimeline([trade("C", "cee", 3100, 3900, 0.001, "take-profit-1"), trade("A", "ay", 1100, 1500, -0.002)], research);
  assert.equal(bot.lines.length, 3);
  assert.deepEqual(bot.trades.map((t) => t.label), ["AY", "CEE"]);
  assert.equal(bot.trades[0].line, 0);
  assert.equal(bot.trades[1].line, 2);
  assert.equal(bot.trades[0].why, "STOP LOSS");
  assert.equal(bot.trades[1].why, "TAKE PROFIT");
  assert.equal(bot.watched, 3);
  assert.equal(bot.lines[1].w, 1); // a coin that pumped hard draws brighter
});

test("pump: a trade without a watched-coin record still gets its own line", () => {
  const bot = data.pumpTimeline([trade("Z", "zed", 500, 900, 0.003)], [{ mint: "A", createdAtMs: 1000 }]);
  assert.equal(bot.lines.length, 2);
  assert.equal(bot.lines[bot.trades[0].line].t, 500);
});

test("pump: with no research files the ring is one line per trade", () => {
  const bot = data.pumpTimeline([trade("A", "a", 1, 2, 0.1), trade("B", "b", 3, 4, -0.1)], []);
  assert.equal(bot.lineWord, "trade");
  assert.equal(bot.watched, null);
  assert.equal(bot.lines.length, 2);
});

test("pump: too many coins are grouped, traded coins always kept, and it says so", () => {
  const research = [];
  for (let i = 0; i < data.MAX_LINES * 2 + 10; i++) research.push({ mint: `m${i}`, createdAtMs: i });
  const bot = data.pumpTimeline([trade("m7", "x", 8, 9, 0.01)], research);
  assert.equal(bot.perLine, 3);
  assert.ok(bot.lines.length <= data.MAX_LINES + 1);
  assert.equal(bot.lines[bot.trades[0].line].t, 7);
  assert.equal(bot.watched, research.length);
});

test("pump: --days keeps only recent trades and coins", () => {
  const bot = data.pumpTimeline([trade("A", "a", 10, 20, 0.1), trade("B", "b", 100, 200, -0.1)], [], { fromMs: 50 });
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].label, "B");
});

test("bybit: closed-pnl rows become trades; a Sell close was a long; duplicates dropped", () => {
  const row = (orderId, side, pnl, t) => ({ orderId, symbol: "ETHUSDT", side, closedPnl: String(pnl), cumEntryValue: "40", openFee: "0.02", closeFee: "0.03", updatedTime: String(t) });
  const rows = [row("2", "Buy", -0.5, 2000), row("1", "Sell", 1.25, 1000), row("1", "Sell", 1.25, 1000)];
  const bot = data.bybitTimeline(rows);
  assert.equal(bot.trades.length, 2);
  assert.deepEqual(bot.trades.map((t) => t.side), ["LONG", "SHORT"]);
  assert.deepEqual(bot.trades.map((t) => t.pnl), [1.25, -0.5]);
  assert.ok(Math.abs(bot.trades[0].fee - 0.05) < 1e-12);
  assert.equal(bot.lines.length, 2);
  assert.equal(bot.status, "STOPPED");
});

test(".env reader handles quotes and ignores comments", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vid-")), ".env");
  fs.writeFileSync(file, '# keys\nBYBIT_API_KEY="abc"\nBYBIT_API_SECRET=def\nnot a line\n');
  assert.deepEqual(data.readDotEnv(file), { BYBIT_API_KEY: "abc", BYBIT_API_SECRET: "def" });
});

test("make.cjs options", () => {
  assert.deepEqual(parseArgs(["--days", "1", "--chrome", "--no-bybit", "--seconds", "45"]), { open: true, days: 1, chrome: true, noBybit: true, seconds: 45 });
  assert.equal(parseArgs(["--no-open"]).open, false);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});

test("pump: failed buys are kept with what they cost", () => {
  const bot = data.pumpTimeline([], [], { buyFails: [{ atMs: 5, symbol: "x", feesSol: 0.00001 }, { atMs: 1, mint: "abcdefgh" }] });
  assert.deepEqual(bot.fails.map((f) => f.label), ["ABCDEF", "X"]);
  assert.equal(bot.fails[1].feesSol, 0.00001);
});

test("bybit logs: strategy per entry, market checks and fee-gate skips", () => {
  const log = [
    "[v33] [ETHUSDT/supertrend] 2026-07-14T10:00:00.000Z no entry signal, waiting.",
    "[v33] [SOLUSDT/pullback] entry REJECTED by fee gate: target=3bps",
    "[v33] ENTRY LONG ETHUSDT qty=0.01",
    "[v33] [ETHUSDT/breakout] ENTRY recorded: { ok: true }",
    "[v33] [ETHUSDT/supertrend] 2026-07-14T12:00:00.000Z no entry signal, waiting.",
  ].join("\n");
  const logs = data.parseBybitLogs([log]);
  assert.equal(logs.checks, 2);
  assert.equal(logs.feeRejects, 1);
  assert.deepEqual(logs.byStrategy, { breakout: 1 });
  assert.deepEqual(logs.entries, [{ symbol: "ETHUSDT", strategy: "breakout", t: Date.parse("2026-07-14T10:00:00Z") }]);
  const close = Date.parse("2026-07-14T11:30:00Z");
  const bot = data.bybitTimeline([
    { orderId: "1", symbol: "ETHUSDT", side: "Sell", closedPnl: "1", updatedTime: String(close) },
    { orderId: "2", symbol: "SOLUSDT", side: "Sell", closedPnl: "1", updatedTime: String(close) },
  ], { logs });
  assert.deepEqual(bot.trades.map((t) => t.why).sort(), ["", "breakout"]);
  assert.equal(bot.logs.checks, 2);
});

test("story: one timeline, intermission for a long pause, highlights from real trades", () => {
  const D = data.DAY;
  const pump = data.pumpTimeline([trade("A", "aa", 100 * D, 100 * D + 60e3, 0.01, "take-profit-1"), trade("B", "bb", 101 * D, 101 * D + 60e3, -0.02)], []);
  const row = (id, pnl, t) => ({ orderId: id, symbol: "ETHUSDT", side: "Sell", closedPnl: String(pnl), openFee: "0.1", closeFee: "0.1", updatedTime: String(t) });
  const bybit = data.bybitTimeline([row("1", 2, 10 * D), row("2", -1, 11 * D)]);
  const sol = { [data.dayKey(100 * D)]: 100, [data.dayKey(101 * D)]: 200 };
  const st = data.buildStory([pump, bybit], sol);
  assert.equal(st.gaps.length, 1);
  assert.equal(st.gaps[0].days, 89);
  assert.deepEqual(st.chapters.map((c) => c.title), ["BYBIT", "PUMP.FUN"]);
  const kinds = st.highlights.map((h) => `${h.bot || "-"}:${h.kind}`);
  for (const k of ["bybit:start", "bybit:best", "bybit:worst", "bybit:stop", "-:gap", "pump:start", "pump:best", "pump:worst"]) assert.ok(kinds.includes(k), k);
  const stop = st.highlights.find((h) => h.kind === "stop");
  assert.equal(stop.value, "net +$1.00");
  assert.equal(stop.sub, "fees paid $0.40");
  assert.equal(st.priced, true);
  const p = st.totals.find((t) => t.key === "pump");
  assert.ok(Math.abs(p.usd - (0.01 * 100 - 0.02 * 200)) < 1e-9); // SOL priced on each trade's own day
  assert.equal(p.trades, 2);
  assert.equal(p.wins, 1);
});

test("story: without a SOL price there is no dollar total for pump.fun (never guessed)", () => {
  const pump = data.pumpTimeline([trade("A", "aa", 1, 2, 0.01)], []);
  const st = data.buildStory([pump], null);
  assert.equal(st.priced, false);
  assert.equal(st.totals[0].usd, null);
  assert.equal(pump.trades[0].usd, null);
});

test("sample data is a full story", () => {
  const { bots, solUsd } = data.demoBots();
  const st = data.buildStory(bots, solUsd);
  assert.ok(bots.every((b) => b.trades.length > 0));
  assert.ok(st.highlights.length >= 8);
});
