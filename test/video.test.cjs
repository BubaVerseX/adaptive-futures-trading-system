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
  assert.equal(bot.trades[0].why, "STOP");
  assert.equal(bot.trades[1].why, "TP");
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
  assert.deepEqual(parseArgs(["--days", "1", "--chrome", "--no-bybit"]), { open: true, days: 1, chrome: true, noBybit: true });
  assert.equal(parseArgs(["--no-open"]).open, false);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});

test("sample data is marked as a preview", () => {
  const [pump, bybit] = data.demoBots();
  assert.ok(pump.trades.length > 0 && bybit.trades.length > 0);
});
