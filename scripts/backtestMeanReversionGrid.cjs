#!/usr/bin/env node
/**
 * scripts/backtestMeanReversionGrid.cjs
 *
 * Symmetric grid / mean-reversion hypothesis test on ETHUSDT only (new
 * hypothesis, not yet tested elsewhere in this repo):
 *   - LONG-only entry when close <= EMA20 * (1 - X%)
 *   - Take-profit when price rises X% above the ENTRY price (symmetric
 *     with the entry deviation, not measured from EMA)
 *   - Hard stop-loss at -2% from entry, regardless of X
 *   - Same conservative same-candle resolution as the rest of this repo's
 *     backtests: stop-loss checked before take-profit within a candle.
 *
 * Tests X in {0.5%, 1%, 1.5%, 2%} through the same 4-criteria gauntlet used
 * everywhere else (two non-overlapping 120-day windows, beats buy-and-hold,
 * survives 1.5x fee stress), PLUS an explicit regime comparison: a recent
 * ~40-day "trending" window vs the oldest available ~40-day window in the
 * fetched data, with an Efficiency Ratio computed for every window so
 * "trending vs choppy" is a measured property, not an assumption.
 *
 * Reuses ema() from strategyLogic.cjs and summarizeTrades()/computeWindows()
 * from freshGauntlet.cjs (both already exported) rather than reimplementing.
 *
 * Public Bybit data only, read-only, no API key needed.
 *
 * ============ USAGE ============
 *   node scripts/backtestMeanReversionGrid.cjs
 *   node scripts/backtestMeanReversionGrid.cjs --no-cache
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { ema } = require("./strategyLogic.cjs");
const { summarizeTrades, computeWindows } = require("./freshGauntlet.cjs");

const SYMBOL = "ETHUSDT";
const FETCH_DAYS = 245; // W1(120d) + W2(120d) + buffer for EMA20 warmup
const WINDOW_DAYS = 120;
const WINDOW_SHORT_DAYS = 40; // "current trending" window, per the request (30-45d)
const WINDOW_OLD_DAYS = 40; // oldest available same-length slice, for the regime comparison
const X_VALUES_PCT = [0.5, 1, 1.5, 2];
const HARD_STOP_PCT = 2; // fixed regardless of X, per spec
const INTRADAY_FEE_BPS = 14; // round-trip taker fee + slippage buffer, same convention as freshGauntlet.cjs
const STRESS_FEE_BPS = 21; // 1.5x

function parseArgs() {
  const args = process.argv.slice(2);
  return { noCache: args.includes("--no-cache") };
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Bad JSON: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function fetchCandles(symbol, interval, days) {
  const REST_BASE = "https://api.bybit.com";
  const stepMs = 15 * 60 * 1000;
  const limit = 1000;
  const windowEnd = Date.now();
  const wantedStart = windowEnd - days * 24 * 60 * 60 * 1000;
  let endTime = windowEnd;
  const seen = new Set();
  const out = [];
  while (endTime > wantedStart) {
    const startTime = Math.max(wantedStart, endTime - limit * stepMs);
    const url = `${REST_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&start=${startTime}&end=${endTime}&limit=${limit}`;
    const json = await httpGetJson(url);
    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
      throw new Error(`kline fetch failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const rows = json.result.list
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .sort((a, b) => a.ts - b.ts);
    if (!rows.length) break;
    for (const c of rows) if (!seen.has(c.ts) && c.close > 0) { seen.add(c.ts); out.push(c); }
    const firstTs = rows[0].ts;
    const nextEnd = firstTs - stepMs;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    await new Promise((r) => setTimeout(r, 150));
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

async function fetchCandlesCached(symbol, interval, days, cacheDir, noCache) {
  const cacheFile = path.join(cacheDir, `${symbol}-${interval}-${days}d.json`);
  if (!noCache && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs < 6 * 60 * 60 * 1000) return cached.candles;
  }
  const candles = await fetchCandles(symbol, interval, days);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), candles }));
  return candles;
}

function buyHoldReturn(candles, startTs, endTs) {
  const inRange = candles.filter((c) => c.ts >= startTs && c.ts < endTs);
  if (inRange.length < 2) return null;
  const first = inRange[0].open, last = inRange[inRange.length - 1].close;
  return +(((last - first) / first) * 100).toFixed(2);
}

// Resample 15m candles to one close per UTC day — computing Efficiency Ratio
// directly on 15m closes is dominated by intrabar noise (path length balloons
// from back-and-forth ticks that don't reflect the actual multi-day trend),
// which made every window read as near-zero/choppy regardless of how directional
// it actually was. Daily resampling is the standard granularity for this metric.
function dailyCloses(candles, startTs, endTs) {
  const byDay = new Map();
  for (const c of candles) {
    if (c.ts < startTs || c.ts >= endTs) continue;
    const dayKey = Math.floor(c.ts / 86400000);
    byDay.set(dayKey, c.close); // last write per day wins since candles are time-sorted
  }
  return [...byDay.keys()].sort((a, b) => a - b).map((k) => byDay.get(k));
}

// Kaufman Efficiency Ratio on daily-resampled closes: |net move| / sum(|day-to-day moves|).
// 1 = pure trend (every day moves the same direction), ~0 = pure chop.
function efficiencyRatio(candles, startTs, endTs) {
  const closes = dailyCloses(candles, startTs, endTs);
  if (closes.length < 3) return null;
  const netMove = Math.abs(closes[closes.length - 1] - closes[0]);
  let pathLength = 0;
  for (let i = 1; i < closes.length; i++) pathLength += Math.abs(closes[i] - closes[i - 1]);
  return pathLength > 0 ? +(netMove / pathLength).toFixed(4) : null;
}

// ---------------- Backtest engine ----------------
// Same conservative same-candle resolution as runIntradayBacktest in
// freshGauntlet.cjs: stop-loss checked before take-profit.

function runGridBacktest(candles, e20, xPct, feeBps) {
  const trades = [];
  let position = null;
  const xFrac = xPct / 100;
  const stopFrac = HARD_STOP_PCT / 100;

  for (let i = 1; i < candles.length - 1; i++) {
    if (e20[i] == null) continue;

    if (position) {
      const high = candles[i].high, low = candles[i].low;
      let exitPrice = null, exitReason = null;
      if (low <= position.stopPrice) { exitPrice = position.stopPrice; exitReason = "SL"; }
      else if (high >= position.tpPrice) { exitPrice = position.tpPrice; exitReason = "TP"; }

      if (exitPrice) {
        const rawPct = (exitPrice - position.entryPrice) / position.entryPrice;
        const pnlFraction = rawPct - feeBps / 10000;
        trades.push({ side: "LONG", entryTs: position.entryTs, exitTs: candles[i].ts, exitReason, pnlFraction });
        position = null;
      }
      continue;
    }

    const dropPct = (candles[i].close - e20[i]) / e20[i];
    if (dropPct <= -xFrac) {
      const entryPrice = candles[i].close;
      position = {
        entryPrice, entryIdx: i, entryTs: candles[i].ts,
        stopPrice: entryPrice * (1 - stopFrac),
        tpPrice: entryPrice * (1 + xFrac),
      };
    }
  }

  return trades;
}

// ---------------- Verdict (single-symbol variant of freshGauntlet's gauntletVerdict) ----------------

function pf(v) { return v.profitFactor === "inf" ? Infinity : v.profitFactor; }

function gauntletVerdict(w1, w2, w1Stress, buyHoldW1, buyHoldW2) {
  const c1 = pf(w1) > 1.3 && w1.tradeCount >= 100;
  const c2 = pf(w2) > 1.3 && w2.tradeCount >= 100 && w2.netReturnPct > 0;
  const c3a = w1.netReturnPct > buyHoldW1;
  const c3b = w2.netReturnPct > buyHoldW2;
  const c3 = c3a && c3b;
  const c4 = w1Stress.netReturnPct > 0;
  return { c1, c2, c3, c3a, c3b, c4, allPass: c1 && c2 && c3 && c4 };
}

function regimeLabel(er) {
  if (er == null) return "n/a";
  if (er >= 0.35) return "TRENDING";
  if (er <= 0.15) return "CHOPPY";
  return "MIXED";
}

async function main() {
  const { noCache } = parseArgs();
  const cacheDir = path.join(__dirname, "..", "data", "meanreversiongrid");

  console.log(`Fetching ${SYMBOL} 15m candles (${FETCH_DAYS}d)...`);
  const candles = await fetchCandlesCached(SYMBOL, "15", FETCH_DAYS, cacheDir, noCache);
  console.log(`  ${candles.length} candles, ${((candles[candles.length - 1].ts - candles[0].ts) / 86400000).toFixed(1)} days span\n`);

  const lastTs = candles[candles.length - 1].ts;
  const windows = computeWindows(lastTs, WINDOW_DAYS, WINDOW_SHORT_DAYS);
  const oldStart = candles[0].ts;
  const windowOld = { start: oldStart, end: oldStart + WINDOW_OLD_DAYS * 86400000 };

  console.log(`Windows: W1=${new Date(windows.window1.start).toISOString().slice(0, 10)}..${new Date(windows.window1.end).toISOString().slice(0, 10)}  ` +
    `W2=${new Date(windows.window2.start).toISOString().slice(0, 10)}..${new Date(windows.window2.end).toISOString().slice(0, 10)}  ` +
    `WS=${new Date(windows.windowShort.start).toISOString().slice(0, 10)}..${new Date(windows.windowShort.end).toISOString().slice(0, 10)} (recent, "trending")  ` +
    `WO=${new Date(windowOld.start).toISOString().slice(0, 10)}..${new Date(windowOld.end).toISOString().slice(0, 10)} (oldest available, regime comparison)\n`);

  const close = candles.map((c) => c.close);
  const e20 = ema(close, 20);

  const buyHoldW1 = buyHoldReturn(candles, windows.window1.start, windows.window1.end);
  const buyHoldW2 = buyHoldReturn(candles, windows.window2.start, windows.window2.end);
  const buyHoldWS = buyHoldReturn(candles, windows.windowShort.start, windows.windowShort.end);
  const buyHoldWO = buyHoldReturn(candles, windowOld.start, windowOld.end);

  const erW1 = efficiencyRatio(candles, windows.window1.start, windows.window1.end);
  const erW2 = efficiencyRatio(candles, windows.window2.start, windows.window2.end);
  const erWS = efficiencyRatio(candles, windows.windowShort.start, windows.windowShort.end);
  const erWO = efficiencyRatio(candles, windowOld.start, windowOld.end);

  console.log(`Regime measurement (Kaufman Efficiency Ratio, daily-resampled closes; 1=pure trend, ~0=pure chop):`);
  console.log(`  W1: ER=${erW1} (${regimeLabel(erW1)})  buyHold=${buyHoldW1}%`);
  console.log(`  W2: ER=${erW2} (${regimeLabel(erW2)})  buyHold=${buyHoldW2}%`);
  console.log(`  WS: ER=${erWS} (${regimeLabel(erWS)})  buyHold=${buyHoldWS}%`);
  console.log(`  WO: ER=${erWO} (${regimeLabel(erWO)})  buyHold=${buyHoldWO}%\n`);

  const results = [];

  for (const xPct of X_VALUES_PCT) {
    console.log(`===================== X = ${xPct}% =====================`);
    const allTrades = runGridBacktest(candles, e20, xPct, INTRADAY_FEE_BPS);
    const allTradesStress = runGridBacktest(candles, e20, xPct, STRESS_FEE_BPS);

    const inWindow = (trades, w) => trades.filter((t) => t.entryTs >= w.start && t.entryTs < w.end);

    const w1 = summarizeTrades(inWindow(allTrades, windows.window1));
    const w2 = summarizeTrades(inWindow(allTrades, windows.window2));
    const w1Stress = summarizeTrades(inWindow(allTradesStress, windows.window1));
    const wS = summarizeTrades(inWindow(allTrades, windows.windowShort));
    const wSStress = summarizeTrades(inWindow(allTradesStress, windows.windowShort));
    const wO = summarizeTrades(inWindow(allTrades, windowOld));
    const wOStress = summarizeTrades(inWindow(allTradesStress, windowOld));

    const verdict = gauntletVerdict(w1, w2, w1Stress, buyHoldW1, buyHoldW2);

    console.log(`  W1 (120d recent):  PF=${w1.profitFactor}  trades=${w1.tradeCount}  win%=${w1.winRatePct}  return=${w1.netReturnPct}%  buyHold=${buyHoldW1}%  maxDD=${w1.maxDrawdownPct}%`);
    console.log(`  W2 (120d prior):   PF=${w2.profitFactor}  trades=${w2.tradeCount}  win%=${w2.winRatePct}  return=${w2.netReturnPct}%  buyHold=${buyHoldW2}%  maxDD=${w2.maxDrawdownPct}%`);
    console.log(`  W1 @ 1.5x fee stress: PF=${w1Stress.profitFactor}  return=${w1Stress.netReturnPct}%`);
    console.log(`  Gauntlet: C1(PF>1.3,100+trades W1)=${verdict.c1 ? "PASS" : "FAIL"}  C2(PF>1.3,100+trades,positive W2)=${verdict.c2 ? "PASS" : "FAIL"}  C3(beats buy-hold both)=${verdict.c3 ? "PASS" : "FAIL"}  C4(survives 1.5x fees)=${verdict.c4 ? "PASS" : "FAIL"}  => ${verdict.allPass ? "ALL PASS" : "FAIL"}`);
    console.log(``);
    console.log(`  -- Regime comparison (informational, not part of the 4-criteria verdict) --`);
    console.log(`  WS (${WINDOW_SHORT_DAYS}d recent, ${regimeLabel(erWS)}, ER=${erWS}): PF=${wS.profitFactor}  trades=${wS.tradeCount}  win%=${wS.winRatePct}  return=${wS.netReturnPct}%  buyHold=${buyHoldWS}%  | stress PF=${wSStress.profitFactor} return=${wSStress.netReturnPct}%`);
    console.log(`  WO (${WINDOW_OLD_DAYS}d oldest available, ${regimeLabel(erWO)}, ER=${erWO}): PF=${wO.profitFactor}  trades=${wO.tradeCount}  win%=${wO.winRatePct}  return=${wO.netReturnPct}%  buyHold=${buyHoldWO}%  | stress PF=${wOStress.profitFactor} return=${wOStress.netReturnPct}%`);
    console.log("");

    results.push({ xPct, w1, w2, w1Stress, wS, wSStress, wO, wOStress, verdict });
  }

  console.log(`\n========================= SUMMARY =========================`);
  for (const r of results) {
    console.log(`X=${r.xPct}%: gauntlet=${r.verdict.allPass ? "PASS" : "FAIL"}  |  W1 PF=${r.w1.profitFactor} trades=${r.w1.tradeCount}  W2 PF=${r.w2.profitFactor} trades=${r.w2.tradeCount}  |  WS(trending) return=${r.wS.netReturnPct}% trades=${r.wS.tradeCount}  vs  WO(${regimeLabel(erWO)}) return=${r.wO.netReturnPct}% trades=${r.wO.tradeCount}`);
  }
  const anyPass = results.some((r) => r.verdict.allPass);
  console.log(`\n========== OVERALL VERDICT: ${anyPass ? "AT LEAST ONE X VALUE PASSED — needs further scrutiny before any live consideration" : "NO EDGE — all X values fail the 4-criteria gauntlet"} ==========`);

  const outPath = path.join(__dirname, "..", "data", "meanreversiongrid", "report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ windows, windowOld, erW1, erW2, erWS, erWO, buyHoldW1, buyHoldW2, buyHoldWS, buyHoldWO, results }, null, 2));
  console.log(`\nFull report written to ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runGridBacktest, efficiencyRatio, gauntletVerdict };
