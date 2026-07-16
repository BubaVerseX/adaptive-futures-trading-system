#!/usr/bin/env node
/**
 * scripts/backtestFundingRate.cjs
 *
 * Backtests fundingRateStrategy.cjs against REAL historical Bybit funding
 * rate data and price candles, with realistic fees AND the actual funding
 * payments received/paid during each hold — this strategy's real edge (if
 * any) comes partly from that funding cash flow, not just price movement,
 * so it needs to be counted honestly, not ignored.
 *
 * Uses only public Bybit market data — no API key needed, read-only.
 *
 * ============ USAGE ============
 *   node scripts/backtestFundingRate.cjs --symbol BTCUSDT --days 180
 *   node scripts/backtestFundingRate.cjs --symbol ETHUSDT --days 180
 */

const https = require("https");
const { fundingSignalAt, FUNDING_PARAMS } = require("./fundingRateStrategy.cjs");

const FEE_BPS_ROUND_TRIP = 14;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    symbol: get("--symbol", "BTCUSDT"),
    days: Number(get("--days", 180)),
    offsetDays: Number(get("--offset-days", 0)),
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

async function fetchFundingHistory(symbol, days, offsetDays) {
  const REST_BASE = "https://api.bybit.com";
  const limit = 200; // Bybit's per-call cap for this endpoint
  const windowEnd = Date.now() - offsetDays * 24 * 60 * 60 * 1000;
  const wantedStart = windowEnd - days * 24 * 60 * 60 * 1000;
  let endTime = windowEnd;
  const seen = new Set();
  const out = [];

  while (endTime > wantedStart) {
    const url = `${REST_BASE}/v5/market/funding/history?category=linear&symbol=${symbol}&endTime=${endTime}&limit=${limit}`;
    const json = await httpGetJson(url);
    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
      throw new Error(`Bybit funding history fetch failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const rows = json.result.list
      .map((r) => ({ ts: Number(r.fundingRateTimestamp), fundingRate: Number(r.fundingRate) }))
      .sort((a, b) => a.ts - b.ts);
    if (!rows.length) break;
    for (const r of rows) if (!seen.has(r.ts) && r.ts >= wantedStart) { seen.add(r.ts); out.push(r); }
    const oldestTs = rows[0].ts;
    if (oldestTs <= wantedStart || oldestTs >= endTime) break;
    endTime = oldestTs;
    await new Promise((r) => setTimeout(r, 150));
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

async function fetchHourlyCandles(symbol, days, offsetDays) {
  const REST_BASE = "https://api.bybit.com";
  const stepMs = 60 * 60 * 1000; // 1h
  const limit = 1000;
  const windowEnd = Date.now() - offsetDays * 24 * 60 * 60 * 1000;
  const wantedStart = windowEnd - days * 24 * 60 * 60 * 1000;
  let endTime = windowEnd;
  const seen = new Set();
  const out = [];

  while (endTime > wantedStart) {
    const startTime = Math.max(wantedStart, endTime - limit * stepMs);
    const url = `${REST_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=60&start=${startTime}&end=${endTime}&limit=${limit}`;
    const json = await httpGetJson(url);
    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
      throw new Error(`Bybit kline fetch failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const rows = json.result.list
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) }))
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
 * Finds the price at or shortly after a given timestamp (nearest hourly
 * candle close at/after ts). Used to get entry/exit prices at funding event
 * times without any lookahead.
 */
function priceAtOrAfter(hourlyCandles, ts) {
  for (const c of hourlyCandles) {
    if (c.ts >= ts) return c;
  }
  return null;
}

function runFundingBacktest(fundingHistory, hourlyCandles, params) {
  const trades = [];
  let position = null; // { side, entryPrice, entryIdx, entryFundingIdx }

  for (let i = params.lookback; i < fundingHistory.length; i++) {
    const sig = fundingSignalAt(fundingHistory, i, params);
    if (sig.zScore === null) continue;

    if (position) {
      const heldPeriods = i - position.entryFundingIdx;
      const currentPrice = priceAtOrAfter(hourlyCandles, fundingHistory[i].ts);
      if (!currentPrice) continue;

      const isLong = position.side === "LONG";
      const priceDelta = isLong
        ? (currentPrice.close - position.entryPrice) / position.entryPrice
        : (position.entryPrice - currentPrice.close) / position.entryPrice;

      // Real accounting of funding received/paid during the hold: if SHORT and funding
      // is positive during a period, we RECEIVE that funding (shorts get paid by longs).
      // If LONG and funding is negative, we also receive. Otherwise we pay it.
      let fundingPnl = 0;
      for (let j = position.entryFundingIdx; j < i; j++) {
        const rate = fundingHistory[j].fundingRate;
        fundingPnl += isLong ? -rate : rate;
      }

      const reverted = Math.abs(sig.zScore) <= params.exitZScore;
      const timeUp = heldPeriods >= params.maxHoldPeriods;

      if (priceDelta <= -params.priceStopPct || reverted || timeUp) {
        const netPct = priceDelta + fundingPnl - FEE_BPS_ROUND_TRIP / 10000;
        trades.push({
          side: position.side, heldPeriods, netPct,
          exitReason: priceDelta <= -params.priceStopPct ? "PRICE_STOP" : reverted ? "FUNDING_NORMALIZED" : "TIME",
        });
        position = null;
      }
      continue;
    }

    if (sig.entry) {
      const entryPrice = priceAtOrAfter(hourlyCandles, fundingHistory[i].ts);
      if (!entryPrice) continue;
      position = { side: sig.entry, entryPrice: entryPrice.close, entryFundingIdx: i };
    }
  }
  return trades;
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

function verdict(summary) {
  if (summary.tradeCount < 10) return "INSUFFICIENT_DATA";
  const pf = summary.profitFactor === "inf" ? Infinity : summary.profitFactor;
  if (summary.netPnlPct > 0 && pf > 1.2) return "POSSIBLE_EDGE";
  return "NO_EDGE";
}

async function main() {
  const args = parseArgs();
  console.log(`Funding rate reversal backtest: ${args.symbol}, ${args.days} days, offset=${args.offsetDays} days back\n`);

  const [fundingHistory, hourlyCandles] = await Promise.all([
    fetchFundingHistory(args.symbol, args.days, args.offsetDays),
    fetchHourlyCandles(args.symbol, args.days, args.offsetDays),
  ]);
  console.log(`Fetched ${fundingHistory.length} funding events, ${hourlyCandles.length} hourly candles\n`);

  const trades = runFundingBacktest(fundingHistory, hourlyCandles, FUNDING_PARAMS);
  const summary = summarize(trades);
  const v = verdict(summary);

  console.log(JSON.stringify(summary, null, 2));

  if (hourlyCandles.length > 1) {
    const buyHoldPct = +(((hourlyCandles[hourlyCandles.length - 1].close - hourlyCandles[0].close) / hourlyCandles[0].close) * 100).toFixed(2);
    console.log(`\nBuy-and-hold benchmark over the same period: ${buyHoldPct}%`);
  }

  console.log(`\nVerdict: ${v}`);
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runFundingBacktest, summarize, verdict, fetchFundingHistory, fetchHourlyCandles };
