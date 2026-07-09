#!/usr/bin/env node
/**
 * scripts/backtestPairsTrading.cjs
 *
 * Backtests the pairs/spread strategy (pairsStrategy.cjs) against real
 * historical Bybit data, with realistic fees for BOTH legs (this trades two
 * assets at once, so costs are roughly double a single-symbol trade).
 *
 * Uses only public Bybit market data — no API key needed, read-only.
 *
 * ============ USAGE ============
 *   node scripts/backtestPairsTrading.cjs --pair BTCUSDT,ETHUSDT --days 120
 *   node scripts/backtestPairsTrading.cjs --pair ETHUSDT,SOLUSDT --days 120 --interval 15
 */

const https = require("https");
const { pairsSignalAt, PAIRS_PARAMS } = require("./pairsStrategy.cjs");

const FEE_BPS_PER_LEG_ROUND_TRIP = 14; // same assumption as the single-symbol backtester
const FEE_BPS_TOTAL = FEE_BPS_PER_LEG_ROUND_TRIP * 2; // two legs, both open and close

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  const pair = get("--pair", "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim());
  return {
    symbolA: pair[0],
    symbolB: pair[1],
    days: Number(get("--days", 120)),
    interval: get("--interval", "15"),
  };
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

async function fetchHistoricalCandles(symbol, interval, days) {
  const REST_BASE = "https://api.bybit.com";
  const stepMs = Number(interval) * 60 * 1000;
  const limit = 1000;
  const wantedStart = Date.now() - days * 24 * 60 * 60 * 1000;
  let endTime = Date.now();
  const seen = new Set();
  const out = [];

  while (endTime > wantedStart) {
    const startTime = Math.max(wantedStart, endTime - limit * stepMs);
    const url = `${REST_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&start=${startTime}&end=${endTime}&limit=${limit}`;
    const json = await httpGetJson(url);
    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
      throw new Error(`Bybit kline fetch failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const rows = json.result.list
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .sort((a, b) => a.ts - b.ts);
    if (!rows.length) break;
    for (const c of rows) {
      if (!seen.has(c.ts) && c.close > 0) { seen.add(c.ts); out.push(c); }
    }
    const firstTs = rows[0].ts;
    const nextEnd = firstTs - stepMs;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    await new Promise((r) => setTimeout(r, 150));
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Aligns two candle series by timestamp — required since pairs trading needs
 * both legs' prices at the exact same moment, and the two symbols' candle
 * timestamps aren't guaranteed to line up perfectly (gaps, listing dates, etc).
 */
function alignSeries(candlesA, candlesB) {
  const mapB = new Map(candlesB.map((c) => [c.ts, c]));
  const alignedA = [], alignedB = [];
  for (const a of candlesA) {
    const b = mapB.get(a.ts);
    if (b) { alignedA.push(a); alignedB.push(b); }
  }
  return { alignedA, alignedB };
}

function runPairsBacktest(candlesA, candlesB, params) {
  const trades = [];
  let position = null; // { direction, entryIdx, entryRatio }

  for (let i = params.lookback + 1; i < candlesA.length - 1; i++) {
    const sig = pairsSignalAt(candlesA, candlesB, i, params);
    if (sig.zScore === null) continue;

    if (position) {
      const heldCandles = i - position.entryIdx;
      const currentRatio = Math.log(candlesA[i].close / candlesB[i].close);
      const z = sig.zScore;

      let exitReason = null;
      // exit when spread reverted close to normal
      if (Math.abs(z) <= params.exitZScore) exitReason = "REVERTED";
      // hard stop if it kept diverging — relationship may genuinely be broken, not just stretched
      else if (Math.abs(z) >= params.stopZScore) exitReason = "STOP_DIVERGED";
      else if (heldCandles >= params.maxHold) exitReason = "TIME";

      if (exitReason) {
        const ratioChange = currentRatio - position.entryRatio;
        // If we shorted A / longed B (expecting ratio to fall), profit = -ratioChange.
        // If we longed A / shorted B (expecting ratio to rise), profit = +ratioChange.
        const rawPct = position.direction === "LONG_A_SHORT_B" ? ratioChange : -ratioChange;
        const netPct = rawPct - FEE_BPS_TOTAL / 10000;
        trades.push({ direction: position.direction, entryIdx: position.entryIdx, exitIdx: i, exitReason, heldCandles, netPct });
        position = null;
      }
      continue;
    }

    if (sig.entry) {
      position = { direction: sig.entry, entryIdx: i, entryRatio: Math.log(candlesA[i].close / candlesB[i].close) };
    }
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { tradeCount: 0 };
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  let equity = 1, peak = 1, maxDD = 0;
  for (const t of trades) {
    equity *= 1 + t.netPct;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  const grossWin = wins.reduce((a, t) => a + t.netPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPct, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return {
    tradeCount: trades.length,
    winRatePct: +((wins.length / trades.length) * 100).toFixed(1),
    netPnlPct: +((equity - 1) * 100).toFixed(2),
    profitFactor: profitFactor === Infinity ? "inf" : +profitFactor.toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    avgHeldCandles: +(trades.reduce((a, t) => a + t.heldCandles, 0) / trades.length).toFixed(1),
  };
}

function verdict(summary) {
  if (summary.tradeCount < 10) return "INSUFFICIENT_DATA";
  const pf = summary.profitFactor === "inf" ? Infinity : summary.profitFactor;
  if (summary.netPnlPct > 0 && pf > 1.2) return "POSSIBLE_EDGE";
  return "NO_EDGE";
}

async function main() {
  const args = parseArgs();
  console.log(`Pairs backtest: ${args.symbolA} vs ${args.symbolB}, ${args.interval}m candles, ${args.days} days`);
  console.log(`Fee assumption: ${FEE_BPS_TOTAL}bps total (both legs, round trip)\n`);

  const [candlesA, candlesB] = await Promise.all([
    fetchHistoricalCandles(args.symbolA, args.interval, args.days),
    fetchHistoricalCandles(args.symbolB, args.interval, args.days),
  ]);
  console.log(`Fetched ${candlesA.length} candles for ${args.symbolA}, ${candlesB.length} for ${args.symbolB}`);

  const { alignedA, alignedB } = alignSeries(candlesA, candlesB);
  console.log(`Aligned to ${alignedA.length} matching timestamps\n`);

  const trades = runPairsBacktest(alignedA, alignedB, PAIRS_PARAMS);
  const summary = summarize(trades);
  const v = verdict(summary);

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nVerdict: ${v}`);
  if (v === "POSSIBLE_EDGE") {
    console.log("Positive result — still re-check with a different --days window and a different pair before trusting it.");
  } else if (v === "NO_EDGE") {
    console.log("No edge found for this pair over this period. Try a different pair (e.g. ETHUSDT,SOLUSDT) before concluding pairs trading itself doesn't work here.");
  }
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runPairsBacktest, summarize, verdict, alignSeries };
