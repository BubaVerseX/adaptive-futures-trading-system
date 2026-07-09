#!/usr/bin/env node
/**
 * scripts/backtestMTFConfluence.cjs
 *
 * Tests whether requiring a higher-timeframe (4h) trend to agree BEFORE
 * taking a 5m/15m entry signal improves on the single-timeframe results
 * from earlier tonight. This is a genuinely different lever — not another
 * flavor of the same single-timeframe idea — since it's asking a different
 * question: "does context from a bigger picture filter out the bad
 * single-timeframe signals that were losing money?"
 *
 * HONEST STATUS: brand new, never tested before this backtest runs it.
 *
 * ============ USAGE ============
 *   node scripts/backtestMTFConfluence.cjs --symbol BTCUSDT --strategy pullback --days 120
 *   node scripts/backtestMTFConfluence.cjs --symbol ETHUSDT --strategy breakout --days 120
 *   node scripts/backtestMTFConfluence.cjs --symbol SOLUSDT --strategy supertrend --days 120
 */

const https = require("https");
const { STRATEGY_FNS, DEFAULT_ST_PARAMS, ema } = require("./strategyLogic.cjs");

const FEE_BPS_ROUND_TRIP = 14;
const TREND_INTERVAL = "240"; // 4h

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    symbol: get("--symbol", "BTCUSDT"),
    strategy: get("--strategy", "pullback"),
    days: Number(get("--days", 120)),
    minAgreement: Number(get("--min-agreement", 2)),
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

/**
 * Builds a function that, given any timestamp, returns the higher-timeframe
 * trend direction using only 4h candles that had ALREADY CLOSED by that time
 * (no lookahead — this is the same discipline as everything tested tonight).
 */
function buildTrendLookup(trendCandles) {
  const closes = trendCandles.map((c) => c.close);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  return function trendAt(ts) {
    // find the last trend candle that closed at or before ts
    let idx = -1;
    for (let i = 0; i < trendCandles.length; i++) {
      if (trendCandles[i].ts + Number(TREND_INTERVAL) * 60 * 1000 <= ts) idx = i;
      else break;
    }
    if (idx === -1 || e50[idx] === null || e200[idx] === null) return "UNKNOWN";
    return e50[idx] > e200[idx] ? "UP" : "DOWN";
  };
}

function runBacktestWithConfluence(entryCandles, strategyName, params, minAgreement, trendAt) {
  const strategyDef = STRATEGY_FNS[strategyName];
  const trades = [];
  let position = null;
  let rejectedByConfluence = 0;

  for (let i = 1; i < entryCandles.length - 1; i++) {
    const sig = strategyDef.fn(entryCandles, i, params, minAgreement);

    if (position) {
      const heldCandles = i - position.entryIdx;
      const isLong = position.side === "LONG";
      const high = entryCandles[i].high, low = entryCandles[i].low;
      let exitPrice = null, exitReason = null;
      if (isLong) {
        const slPrice = position.entryPrice * (1 - sig.sl);
        const tpPrice = position.entryPrice * (1 + sig.tp);
        if (low <= slPrice) { exitPrice = slPrice; exitReason = "SL"; }
        else if (high >= tpPrice) { exitPrice = tpPrice; exitReason = "TP"; }
      } else {
        const slPrice = position.entryPrice * (1 + sig.sl);
        const tpPrice = position.entryPrice * (1 - sig.tp);
        if (high >= slPrice) { exitPrice = slPrice; exitReason = "SL"; }
        else if (low <= tpPrice) { exitPrice = tpPrice; exitReason = "TP"; }
      }
      const exitSignal = isLong ? sig.longExit : sig.shortExit;
      if (!exitPrice && exitSignal && heldCandles >= sig.minHold) { exitPrice = entryCandles[i].close; exitReason = "SIGNAL"; }
      if (!exitPrice && heldCandles >= sig.maxHold) { exitPrice = entryCandles[i].close; exitReason = "TIME"; }
      if (exitPrice) {
        const rawPct = isLong ? (exitPrice - position.entryPrice) / position.entryPrice : (position.entryPrice - exitPrice) / position.entryPrice;
        const netPct = rawPct - FEE_BPS_ROUND_TRIP / 10000;
        trades.push({ side: position.side, exitReason, heldCandles, netPct });
        position = null;
      }
      continue;
    }

    const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
    if (!side) continue;

    const trend = trendAt(entryCandles[i].ts);
    const confluenceOk = (side === "LONG" && trend === "UP") || (side === "SHORT" && trend === "DOWN");
    if (!confluenceOk) { rejectedByConfluence++; continue; }

    position = { side, entryPrice: entryCandles[i].close, entryIdx: i };
  }
  return { trades, rejectedByConfluence };
}

function summarize(trades) {
  if (!trades.length) return { tradeCount: 0 };
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  let equity = 1, peak = 1, maxDD = 0;
  for (const t of trades) { equity *= 1 + t.netPct; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak); }
  const grossWin = wins.reduce((a, t) => a + t.netPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPct, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return {
    tradeCount: trades.length,
    winRatePct: +((wins.length / trades.length) * 100).toFixed(1),
    netPnlPct: +((equity - 1) * 100).toFixed(2),
    profitFactor: profitFactor === Infinity ? "inf" : +profitFactor.toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
  };
}

async function main() {
  const args = parseArgs();
  const strategyDef = STRATEGY_FNS[args.strategy];
  if (!strategyDef) { console.error(`Unknown strategy: ${args.strategy}`); process.exit(1); }

  console.log(`MTF Confluence backtest: ${args.symbol} / ${args.strategy} (${strategyDef.interval}m entries + 4h trend filter), ${args.days} days\n`);

  const [entryCandles, trendCandles] = await Promise.all([
    fetchHistoricalCandles(args.symbol, strategyDef.interval, args.days),
    fetchHistoricalCandles(args.symbol, TREND_INTERVAL, args.days),
  ]);
  console.log(`Fetched ${entryCandles.length} entry-timeframe candles, ${trendCandles.length} 4h trend candles`);

  const trendAt = buildTrendLookup(trendCandles);
  const params = args.strategy === "supertrend" ? DEFAULT_ST_PARAMS : null;

  const withFilter = runBacktestWithConfluence(entryCandles, args.strategy, params, args.minAgreement, trendAt);
  const summaryWith = summarize(withFilter.trades);

  console.log(`\nWITH 4h confluence filter:`);
  console.log(JSON.stringify(summaryWith, null, 2));
  console.log(`Entries rejected by confluence filter: ${withFilter.rejectedByConfluence}`);

  const pf = summaryWith.profitFactor === "inf" ? Infinity : summaryWith.profitFactor;
  const verdict = summaryWith.tradeCount >= 10 && summaryWith.netPnlPct > 0 && pf > 1.2 ? "POSSIBLE_EDGE" : "NO_EDGE";
  console.log(`\nVerdict: ${verdict}`);
  console.log(`\nCompare this to tonight's earlier result for ${args.symbol}/${args.strategy} (no confluence filter) to see if the 4h filter actually helped or just reduced trade count without improving quality.`);
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runBacktestWithConfluence, buildTrendLookup, summarize };
