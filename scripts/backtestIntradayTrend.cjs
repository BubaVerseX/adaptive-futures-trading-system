#!/usr/bin/env node
/**
 * scripts/backtestIntradayTrend.cjs
 *
 * Same Donchian channel breakout logic as the daily strategy, but on 1h or
 * 4h candles instead of daily. This is a genuine, untested middle ground:
 *   - 5m/15m strategies (tested tonight): fee-heavy, held minutes-to-hours,
 *     consistently failed.
 *   - Daily strategy (tested tonight): almost no fee drag, held weeks,
 *     weak result, beaten by buy-and-hold.
 *   - THIS (1h/4h): holds hours-to-days, checks far more often than daily,
 *     moderate fee impact. Not yet tested.
 *
 * Uses only public Bybit market data — no API key needed, read-only.
 *
 * ============ USAGE ============
 *   node scripts/backtestIntradayTrend.cjs --symbol BTCUSDT --interval 60 --days 180
 *   node scripts/backtestIntradayTrend.cjs --symbol ETHUSDT --interval 240 --days 180
 */

const https = require("https");
const { dailyTrendSignalAt } = require("./dailyTrendStrategy.cjs");
const { atr } = require("./strategyLogic.cjs");

const FEE_BPS_ROUND_TRIP = 14;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  const interval = get("--interval", "60"); // "60" = 1h, "240" = 4h
  // Scale default lookbacks to roughly "N days" worth of bars at this timeframe,
  // shorter than the daily system's 20/10 day channels since this is meant to
  // react faster.
  const barsPerDay = 1440 / Number(interval);
  return {
    symbol: get("--symbol", "BTCUSDT"),
    interval,
    days: Number(get("--days", 180)),
    entryLookback: Number(get("--entry-lookback", Math.round(barsPerDay * 5))),  // ~5 days
    exitLookback: Number(get("--exit-lookback", Math.round(barsPerDay * 2))),    // ~2 days
    offsetDays: Number(get("--offset-days", 0)),
    sizingMode: get("--sizing", "risk-based"),
    capitalUsdt: Number(get("--capital", 64)),
    leverage: Number(get("--leverage", 3)),
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

async function fetchCandles(symbol, interval, days, offsetDays) {
  const REST_BASE = "https://api.bybit.com";
  const stepMs = Number(interval) * 60 * 1000;
  const limit = 1000;
  const windowEnd = Date.now() - offsetDays * 24 * 60 * 60 * 1000;
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

function runBacktest(candles, params, sizingConfig) {
  const atrSeries = atr(candles, params.atrPeriod);
  const trades = [];
  let equity = 1, peak = 1, maxDD = 0;
  let liquidationRiskCount = 0;
  let position = null;
  const liquidationThresholdPct = sizingConfig.leverage ? (1 / sizingConfig.leverage) * 0.8 : Infinity;

  for (let i = params.entryLookback + 1; i < candles.length; i++) {
    const sig = dailyTrendSignalAt(candles, i, params, atrSeries);
    if (sig.atr === null) continue;

    if (position) {
      const isLong = position.side === "LONG";
      const high = candles[i].high, low = candles[i].low, close = candles[i].close;
      let exitPrice = null, exitReason = null;
      if (isLong && low <= position.stopPrice) { exitPrice = position.stopPrice; exitReason = "ATR_STOP"; }
      else if (!isLong && high >= position.stopPrice) { exitPrice = position.stopPrice; exitReason = "ATR_STOP"; }
      else if (isLong && sig.longExit) { exitPrice = close; exitReason = "CHANNEL_EXIT"; }
      else if (!isLong && sig.shortExit) { exitPrice = close; exitReason = "CHANNEL_EXIT"; }

      if (exitPrice) {
        const priceDelta = isLong ? (exitPrice - position.entryPrice) / position.entryPrice : (position.entryPrice - exitPrice) / position.entryPrice;
        const stopDistancePct = Math.abs(position.entryPrice - position.stopPrice) / position.entryPrice;
        let pnlFraction;
        if (sizingConfig.mode === "full-notional") {
          pnlFraction = priceDelta * sizingConfig.leverage - FEE_BPS_ROUND_TRIP / 10000;
          if (stopDistancePct >= liquidationThresholdPct) liquidationRiskCount++;
        } else {
          pnlFraction = (priceDelta / stopDistancePct) * params.riskPerTradePct - FEE_BPS_ROUND_TRIP / 10000;
        }
        equity *= (1 + pnlFraction);
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, (peak - equity) / peak);
        trades.push({ side: position.side, exitReason, heldBars: i - position.entryIdx, pnlFraction });
        position = null;
      }
      continue;
    }

    const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
    if (side) {
      const entryPrice = candles[i].close;
      const stopDistance = params.atrStopMultiple * sig.atr;
      const stopPrice = side === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance;
      position = { side, entryPrice, entryIdx: i, stopPrice };
    }
  }
  return { trades, finalEquity: equity, maxDD, liquidationRiskCount };
}

function summarize(result) {
  const { trades, finalEquity, maxDD } = result;
  if (!trades.length) return { tradeCount: 0 };
  const wins = trades.filter((t) => t.pnlFraction > 0);
  const losses = trades.filter((t) => t.pnlFraction <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlFraction, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlFraction, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return {
    tradeCount: trades.length,
    winRatePct: +((wins.length / trades.length) * 100).toFixed(1),
    netPnlPct: +((finalEquity - 1) * 100).toFixed(2),
    profitFactor: profitFactor === Infinity ? "inf" : +profitFactor.toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    avgHeldBars: +(trades.reduce((a, t) => a + t.heldBars, 0) / trades.length).toFixed(1),
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
  const timeframeLabel = args.interval === "60" ? "1h" : args.interval === "240" ? "4h" : `${args.interval}m`;
  const params = {
    entryLookback: args.entryLookback, exitLookback: args.exitLookback,
    atrPeriod: 20, atrStopMultiple: 2, riskPerTradePct: 0.01,
  };

  console.log(`Intraday trend backtest: ${args.symbol} (${timeframeLabel} candles), ${args.days} days`);
  console.log(`Entry channel: ${args.entryLookback} bars | Exit channel: ${args.exitLookback} bars | Sizing: ${args.sizingMode}\n`);

  const candles = await fetchCandles(args.symbol, args.interval, args.days, args.offsetDays);
  console.log(`Fetched ${candles.length} candles\n`);

  const sizingConfig = { mode: args.sizingMode, leverage: args.leverage };
  const result = runBacktest(candles, params, sizingConfig);
  const summary = summarize(result);
  const v = verdict(summary);

  console.log(JSON.stringify(summary, null, 2));

  if (args.sizingMode === "full-notional" && result.liquidationRiskCount > 0) {
    console.log(`\n⚠ WARNING: ${result.liquidationRiskCount} of ${result.trades.length} trades risked liquidation before the stop could fire at ${args.leverage}x leverage.`);
  }

  const buyHoldPct = +(((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100).toFixed(2);
  console.log(`\nBuy-and-hold benchmark over the same period: ${buyHoldPct}%`);
  console.log(`\nVerdict: ${v}`);
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runBacktest, summarize, verdict, fetchCandles };
