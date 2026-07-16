#!/usr/bin/env node
/**
 * scripts/backtestBroadTrend.cjs
 *
 * Runs the same daily-trend Donchian/ATR strategy (dailyTrendStrategy.cjs)
 * across the most liquid USDT perpetuals on Bybit, not just BTC/ETH/SOL.
 * Rationale: single-symbol backtests here already showed the verdict flip
 * (edge / no edge) purely from changing the lookback window — a classic
 * small-sample noise signature. More independent markets is what actually
 * averages that noise out, IF there's a real signal to average.
 *
 * Robustness check per symbol: split its history in half and require BOTH
 * halves to individually clear the edge bar, not just the full window.
 * A symbol that only "works" over one arbitrary window is exactly the kind
 * of result that already burned this account for six weeks.
 *
 * Sizing stays risk-based (fixed % equity risk per trade via ATR stop) —
 * leverage does not change per-trade risk here, only margin usage, so it is
 * deliberately capped low and NOT used as a return lever.
 *
 * Uses only public Bybit market data. No API key needed, read-only.
 *
 * ============ USAGE ============
 *   node scripts/backtestBroadTrend.cjs --top 60 --days 730
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { dailyTrendSignalAt, DAILY_TREND_PARAMS } = require("./dailyTrendStrategy.cjs");
const { runDailyTrendBacktest, summarize, verdict } = require("./backtestDailyTrend.cjs");

const CACHE = path.join(process.cwd(), "data/research/cache/broadtrend");
fs.mkdirSync(CACHE, { recursive: true });

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    top: Number(get("--top", 60)),
    days: Number(get("--days", 730)),
    leverage: Number(get("--leverage", 2)), // deliberately conservative — see file header
    refresh: args.includes("--refresh"),
  };
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Bad JSON: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getLiquidUniverse(topN) {
  const info = await httpGetJson("https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000");
  if (!info || info.retCode !== 0) throw new Error("instruments-info failed: " + JSON.stringify(info).slice(0, 200));
  const tradingUsdtPerp = new Set(
    info.result.list
      .filter((i) => i.quoteCoin === "USDT" && i.contractType === "LinearPerpetual" && i.status === "Trading")
      .map((i) => i.symbol)
  );

  const tickers = await httpGetJson("https://api.bybit.com/v5/market/tickers?category=linear");
  if (!tickers || tickers.retCode !== 0) throw new Error("tickers failed: " + JSON.stringify(tickers).slice(0, 200));

  const ranked = tickers.result.list
    .filter((t) => tradingUsdtPerp.has(t.symbol))
    .map((t) => ({ symbol: t.symbol, turnover24h: Number(t.turnover24h || 0) }))
    .sort((a, b) => b.turnover24h - a.turnover24h);

  return ranked.slice(0, topN).map((r) => r.symbol);
}

async function fetchDailyCandles(symbol, days, refresh) {
  const file = path.join(CACHE, `${symbol}_${days}d.json`);
  if (!refresh && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(cached) && cached.length > days * 0.8) return cached;
  }

  const REST_BASE = "https://api.bybit.com";
  const stepMs = 24 * 60 * 60 * 1000;
  const limit = 1000;
  const wantedStart = Date.now() - days * stepMs;
  let endTime = Date.now();
  const seen = new Set();
  const out = [];

  while (endTime > wantedStart) {
    const startTime = Math.max(wantedStart, endTime - limit * stepMs);
    const url = `${REST_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=D&start=${startTime}&end=${endTime}&limit=${limit}`;
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
    await sleep(120);
  }
  out.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

function robustnessCheck(candles, sizingConfig) {
  const mid = Math.floor(candles.length / 2);
  const firstHalf = candles.slice(0, mid);
  const secondHalf = candles.slice(mid);

  const rFull = summarize(runDailyTrendBacktest(candles, DAILY_TREND_PARAMS, sizingConfig));
  const r1 = summarize(runDailyTrendBacktest(firstHalf, DAILY_TREND_PARAMS, sizingConfig));
  const r2 = summarize(runDailyTrendBacktest(secondHalf, DAILY_TREND_PARAMS, sizingConfig));

  const halfPasses = (r) => r.tradeCount >= 5 && r.netPnlPct > 0 && (r.profitFactor === "inf" || r.profitFactor >= 1.1);
  const robust = halfPasses(r1) && halfPasses(r2);

  return { full: rFull, firstHalf: r1, secondHalf: r2, robust };
}

async function main() {
  const args = parseArgs();
  console.log(`Fetching top ${args.top} USDT perpetuals by 24h turnover...`);
  const universe = await getLiquidUniverse(args.top);
  console.log(`Universe (${universe.length}): ${universe.join(", ")}\n`);

  const sizingConfig = { mode: "risk-based", leverage: args.leverage };
  const results = [];
  let skipped = 0;

  for (let idx = 0; idx < universe.length; idx++) {
    const symbol = universe[idx];
    process.stderr.write(`[${idx + 1}/${universe.length}] ${symbol}...\r`);
    let candles;
    try {
      candles = await fetchDailyCandles(symbol, args.days, args.refresh);
    } catch (e) {
      skipped++;
      continue;
    }
    if (candles.length < Math.max(120, args.days * 0.5)) { skipped++; continue; }

    const check = robustnessCheck(candles, sizingConfig);
    const buyHoldPct = +(((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100).toFixed(2);
    results.push({ symbol, candleCount: candles.length, buyHoldPct, ...check });
    await sleep(100);
  }
  console.error(" ".repeat(40) + "\r");

  console.log(`\nTested ${results.length} symbols (${skipped} skipped — insufficient history or fetch failure)\n`);

  const robustSymbols = results.filter((r) => r.robust);
  console.log(`=== ROBUST (edge holds in BOTH halves independently): ${robustSymbols.length}/${results.length} ===`);
  for (const r of robustSymbols.sort((a, b) => b.full.netPnlPct - a.full.netPnlPct)) {
    console.log(
      `  ${r.symbol.padEnd(14)} full: ${String(r.full.netPnlPct).padStart(7)}%  PF ${String(r.full.profitFactor).padStart(5)}  ` +
      `trades ${String(r.full.tradeCount).padStart(3)}  | half1 ${String(r.firstHalf.netPnlPct).padStart(6)}% PF ${String(r.firstHalf.profitFactor).padStart(4)}  ` +
      `| half2 ${String(r.secondHalf.netPnlPct).padStart(6)}% PF ${String(r.secondHalf.profitFactor).padStart(4)}  | buy&hold ${r.buyHoldPct}%`
    );
  }

  console.log(`\n=== Portfolio-level (equal-weight across all ${results.length} tested symbols) ===`);
  const avgNet = results.reduce((a, r) => a + r.full.netPnlPct, 0) / results.length;
  const avgBuyHold = results.reduce((a, r) => a + r.buyHoldPct, 0) / results.length;
  const allTrades = results.flatMap((r) => r.full.tradeCount);
  const totalTrades = allTrades.reduce((a, b) => a + b, 0);
  console.log(`  Avg strategy net return per symbol: ${avgNet.toFixed(2)}%`);
  console.log(`  Avg buy-and-hold return per symbol: ${avgBuyHold.toFixed(2)}%`);
  console.log(`  Total trades across universe: ${totalTrades}`);
  console.log(`  Symbols with robust edge (both halves): ${robustSymbols.length} / ${results.length} (${((robustSymbols.length / results.length) * 100).toFixed(1)}%)`);

  const expectedFalsePositiveRate = 0.05; // rough: how many would pass a loose bar by pure chance
  console.log(`\nFor reference: if there were truly zero edge anywhere, you'd still expect a handful of symbols`);
  console.log(`to pass a "both halves positive" bar by chance alone out of ${results.length} independent trials.`);
  console.log(`Treat the robust list above as candidates to re-test out-of-sample, not as proven winners yet.`);

  const outFile = path.join(process.cwd(), "data/research/reports/broad-trend-report.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), args, results }, null, 2));
  console.log(`\nFull results written to ${outFile}`);
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
