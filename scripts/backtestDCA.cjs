#!/usr/bin/env node
/**
 * scripts/backtestDCA.cjs
 *
 * Simple DCA (dollar-cost-averaging) comparison — NOT a gauntlet test. DCA
 * makes no edge claim (buy a fixed $ amount on a fixed schedule, no price
 * condition, no stop-loss), so there's nothing to pass/fail here. This just
 * reports honest comparison numbers against two lump-sum benchmarks:
 *   1. DCA: fixed $ buy every 12h, no price condition
 *   2. Lump-sum, same total capital, all in on day 1 of the period
 *   3. Lump-sum, same total capital, all in on the LAST DAY of the period
 *      (defined as: entered at the open of the window's final 24h, held to
 *      window end — i.e. "you waited the whole period, then jumped in right
 *      before the end" — the realistic worst-case-timing scenario, not a
 *      literal zero-holding-period buy which would be ~0% by construction)
 *
 * BTC/ETH/SOL, 245 days (same window as backtestMeanReversionGrid.cjs), plus
 * the same two non-overlapping 120-day windows so DCA's relative performance
 * can be checked for consistency rather than trusting one lucky period.
 *
 * Reuses computeWindows() from freshGauntlet.cjs. Public Bybit data only,
 * read-only, no API key needed.
 *
 * ============ USAGE ============
 *   node scripts/backtestDCA.cjs
 *   node scripts/backtestDCA.cjs --no-cache
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { computeWindows } = require("./freshGauntlet.cjs");

const SYMBOLS = ["ETHUSDT", "SOLUSDT", "BTCUSDT"];
const FETCH_DAYS = 245; // same as backtestMeanReversionGrid.cjs
const WINDOW_DAYS = 120;
const DCA_INTERVAL_HOURS = 12;
const FIXED_BUY_USD = 10; // arbitrary unit — only ratios/returns matter here

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

async function fetchCandles(symbol, days) {
  const REST_BASE = "https://api.bybit.com";
  const stepMs = 60 * 60 * 1000; // 1h
  const limit = 1000;
  const windowEnd = Date.now();
  const wantedStart = windowEnd - days * 24 * 60 * 60 * 1000;
  let endTime = windowEnd;
  const seen = new Set();
  const out = [];
  while (endTime > wantedStart) {
    const startTime = Math.max(wantedStart, endTime - limit * stepMs);
    const url = `${REST_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=60&start=${startTime}&end=${endTime}&limit=${limit}`;
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

async function fetchCandlesCached(symbol, days, cacheDir, noCache) {
  const cacheFile = path.join(cacheDir, `${symbol}-60-${days}d.json`);
  if (!noCache && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs < 6 * 60 * 60 * 1000) return cached.candles;
  }
  const candles = await fetchCandles(symbol, days);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), candles }));
  return candles;
}

// ---------------- DCA simulation ----------------

function priceAtOrBefore(candles, ts) {
  // last candle with candle.ts <= ts (candles are hourly, time-sorted)
  let lo = 0, hi = candles.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function simulateWindow(candles, startTs, endTs) {
  const inRange = candles.filter((c) => c.ts >= startTs && c.ts < endTs);
  if (inRange.length < 2) return null;

  // --- DCA: buy FIXED_BUY_USD every DCA_INTERVAL_HOURS, starting at window start ---
  const stepMs = DCA_INTERVAL_HOURS * 60 * 60 * 1000;
  let totalInvested = 0;
  let totalCoins = 0;
  let buyCount = 0;
  for (let t = startTs; t < endTs; t += stepMs) {
    const idx = priceAtOrBefore(inRange, t);
    if (idx === null) continue;
    const price = inRange[idx].close;
    totalCoins += FIXED_BUY_USD / price;
    totalInvested += FIXED_BUY_USD;
    buyCount++;
  }
  const endPrice = inRange[inRange.length - 1].close;
  const dcaFinalValue = totalCoins * endPrice;
  const dcaReturnPct = totalInvested > 0 ? ((dcaFinalValue - totalInvested) / totalInvested) * 100 : null;

  // --- Lump-sum day 1: same totalInvested, all in at window-start price ---
  const startPrice = inRange[0].open;
  const day1ReturnPct = ((endPrice - startPrice) / startPrice) * 100;
  const day1FinalValue = totalInvested * (1 + day1ReturnPct / 100);

  // --- Lump-sum "last day": same totalInvested, entered at the open of the window's final 24h ---
  const lastDayStartTs = endTs - 24 * 60 * 60 * 1000;
  const lastDayIdx = priceAtOrBefore(inRange, lastDayStartTs);
  const lastDayEntryPrice = lastDayIdx !== null ? inRange[lastDayIdx].open : inRange[inRange.length - 1].open;
  const lastDayReturnPct = ((endPrice - lastDayEntryPrice) / lastDayEntryPrice) * 100;
  const lastDayFinalValue = totalInvested * (1 + lastDayReturnPct / 100);

  return {
    totalInvested: +totalInvested.toFixed(2),
    buyCount,
    startPrice: +startPrice.toFixed(4),
    endPrice: +endPrice.toFixed(4),
    dca: { finalValue: +dcaFinalValue.toFixed(2), returnPct: +dcaReturnPct.toFixed(2) },
    lumpDay1: { finalValue: +day1FinalValue.toFixed(2), returnPct: +day1ReturnPct.toFixed(2) },
    lumpLastDay: { finalValue: +lastDayFinalValue.toFixed(2), returnPct: +lastDayReturnPct.toFixed(2), entryPrice: +lastDayEntryPrice.toFixed(4) },
  };
}

function rankLine(sim) {
  const entries = [
    { name: "DCA", returnPct: sim.dca.returnPct },
    { name: "Lump Day1", returnPct: sim.lumpDay1.returnPct },
    { name: "Lump LastDay", returnPct: sim.lumpLastDay.returnPct },
  ].sort((a, b) => b.returnPct - a.returnPct);
  const best = entries[0], worst = entries[entries.length - 1];
  return `Best: ${best.name} (${best.returnPct >= 0 ? "+" : ""}${best.returnPct}%)  Worst: ${worst.name} (${worst.returnPct >= 0 ? "+" : ""}${worst.returnPct}%)  Spread: ${(best.returnPct - worst.returnPct).toFixed(2)}pp`;
}

async function main() {
  const { noCache } = parseArgs();
  const cacheDir = path.join(__dirname, "..", "data", "dcabacktest");

  const report = {};

  for (const symbol of SYMBOLS) {
    console.log(`\n===================== ${symbol} =====================`);
    console.log(`Fetching 1h candles (${FETCH_DAYS}d)...`);
    const candles = await fetchCandlesCached(symbol, FETCH_DAYS, cacheDir, noCache);
    console.log(`  ${candles.length} candles, ${((candles[candles.length - 1].ts - candles[0].ts) / 86400000).toFixed(1)} days span`);

    const lastTs = candles[candles.length - 1].ts;
    const windows = computeWindows(lastTs, WINDOW_DAYS, null);
    const fullStart = candles[0].ts, fullEnd = candles[candles.length - 1].ts + 1;

    const full = simulateWindow(candles, fullStart, fullEnd);
    const w1 = simulateWindow(candles, windows.window1.start, windows.window1.end);
    const w2 = simulateWindow(candles, windows.window2.start, windows.window2.end);

    function printSim(label, sim) {
      console.log(`\n-- ${label} --`);
      console.log(`  Total invested: $${sim.totalInvested}  (${sim.buyCount} DCA buys @ $${FIXED_BUY_USD} every ${DCA_INTERVAL_HOURS}h)`);
      console.log(`  Start price: ${sim.startPrice}  End price: ${sim.endPrice}`);
      console.log(`  DCA:            final value $${sim.dca.finalValue}  return ${sim.dca.returnPct >= 0 ? "+" : ""}${sim.dca.returnPct}%`);
      console.log(`  Lump Day1:      final value $${sim.lumpDay1.finalValue}  return ${sim.lumpDay1.returnPct >= 0 ? "+" : ""}${sim.lumpDay1.returnPct}%`);
      console.log(`  Lump LastDay:   final value $${sim.lumpLastDay.finalValue}  return ${sim.lumpLastDay.returnPct >= 0 ? "+" : ""}${sim.lumpLastDay.returnPct}%  (entered @ ${sim.lumpLastDay.entryPrice}, final 24h of window)`);
      console.log(`  ${rankLine(sim)}`);
    }

    printSim(`Full period (${FETCH_DAYS}d)`, full);
    printSim(`W1 (${WINDOW_DAYS}d recent: ${new Date(windows.window1.start).toISOString().slice(0, 10)}..${new Date(windows.window1.end).toISOString().slice(0, 10)})`, w1);
    printSim(`W2 (${WINDOW_DAYS}d prior: ${new Date(windows.window2.start).toISOString().slice(0, 10)}..${new Date(windows.window2.end).toISOString().slice(0, 10)})`, w2);

    report[symbol] = { full, w1, w2, windows };
  }

  console.log(`\n\n========================= SUMMARY =========================`);
  for (const symbol of SYMBOLS) {
    const r = report[symbol];
    console.log(`\n${symbol}:`);
    console.log(`  Full: DCA=${r.full.dca.returnPct >= 0 ? "+" : ""}${r.full.dca.returnPct}%  Day1=${r.full.lumpDay1.returnPct >= 0 ? "+" : ""}${r.full.lumpDay1.returnPct}%  LastDay=${r.full.lumpLastDay.returnPct >= 0 ? "+" : ""}${r.full.lumpLastDay.returnPct}%`);
    console.log(`  W1:   DCA=${r.w1.dca.returnPct >= 0 ? "+" : ""}${r.w1.dca.returnPct}%  Day1=${r.w1.lumpDay1.returnPct >= 0 ? "+" : ""}${r.w1.lumpDay1.returnPct}%  LastDay=${r.w1.lumpLastDay.returnPct >= 0 ? "+" : ""}${r.w1.lumpLastDay.returnPct}%`);
    console.log(`  W2:   DCA=${r.w2.dca.returnPct >= 0 ? "+" : ""}${r.w2.dca.returnPct}%  Day1=${r.w2.lumpDay1.returnPct >= 0 ? "+" : ""}${r.w2.lumpDay1.returnPct}%  LastDay=${r.w2.lumpLastDay.returnPct >= 0 ? "+" : ""}${r.w2.lumpLastDay.returnPct}%`);
    const dcaBeatsDay1Full = r.full.dca.returnPct > r.full.lumpDay1.returnPct;
    const dcaBeatsDay1W1 = r.w1.dca.returnPct > r.w1.lumpDay1.returnPct;
    const dcaBeatsDay1W2 = r.w2.dca.returnPct > r.w2.lumpDay1.returnPct;
    console.log(`  DCA beat Day1-lump-sum: Full=${dcaBeatsDay1Full} W1=${dcaBeatsDay1W1} W2=${dcaBeatsDay1W2} -> ${[dcaBeatsDay1Full, dcaBeatsDay1W1, dcaBeatsDay1W2].every(Boolean) ? "CONSISTENT (all 3)" : [dcaBeatsDay1Full, dcaBeatsDay1W1, dcaBeatsDay1W2].every((v) => !v) ? "CONSISTENT (never, all 3)" : "INCONSISTENT (period-dependent)"}`);
  }

  const outPath = path.join(__dirname, "..", "data", "dcabacktest", "report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${outPath}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
