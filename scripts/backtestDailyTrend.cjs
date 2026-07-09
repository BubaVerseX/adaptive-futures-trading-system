#!/usr/bin/env node
/**
 * scripts/backtestDailyTrend.cjs
 *
 * Backtests dailyTrendStrategy.cjs against real historical Bybit DAILY
 * candles. Trend-following systems trade infrequently by design (weeks
 * between trades is normal, not a bug) — so this needs a longer history
 * than the intraday backtests tonight to get a meaningful sample size.
 * Default is 2 years.
 *
 * Uses only public Bybit market data — no API key needed, read-only.
 *
 * ============ USAGE ============
 *   node scripts/backtestDailyTrend.cjs --symbol BTCUSDT --days 730
 *   node scripts/backtestDailyTrend.cjs --symbol ETHUSDT --days 1095
 */

const https = require("https");
const { dailyTrendSignalAt, DAILY_TREND_PARAMS } = require("./dailyTrendStrategy.cjs");
const { atr } = require("./strategyLogic.cjs");

const FEE_BPS_ROUND_TRIP = 14; // matters much less here given trade frequency, but included for honesty

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    symbol: get("--symbol", "BTCUSDT"),
    days: Number(get("--days", 730)),
    sizingMode: get("--sizing", "risk-based"), // "risk-based" (default, safer) or "full-notional"
    capitalUsdt: Number(get("--capital", 64)),
    leverage: Number(get("--leverage", 3)), // deliberately low default — see liquidation-risk note below
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

// Daily candles need their own fetch logic — Bybit's interval param is the
// literal string "D" (not a minute count), so the numeric-minutes math used
// everywhere else tonight doesn't apply here.
async function fetchDailyCandles(symbol, days) {
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
      throw new Error(`Bybit daily kline fetch failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
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
 * Walks day-by-day. Position sizing is ATR-based: risk a fixed % of current
 * (compounding) equity per trade, sized so that hitting the protective stop
 * loses exactly that %, regardless of how volatile the market currently is.
 * This is the real mechanism that keeps trend systems from blowing up during
 * a violent, choppy period — bigger ATR automatically means smaller size.
 */
function runDailyTrendBacktest(candles, params, sizingConfig = { mode: "risk-based", leverage: 3 }) {
  const atrSeries = atr(candles, params.atrPeriod);
  const trades = [];
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  let liquidationRiskCount = 0;
  let position = null;

  // Liquidation happens roughly when the adverse move reaches 1/leverage (before fees/funding).
  // Leave a safety margin — treat anything past 80% of that threshold as genuinely at risk.
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
          // Full notional deployed every trade (capital x leverage). Return scales directly
          // with leverage — this is the "use the whole 64" mode, at the cost of risk per
          // trade now varying with volatility instead of staying fixed.
          pnlFraction = priceDelta * sizingConfig.leverage - FEE_BPS_ROUND_TRIP / 10000;
          if (stopDistancePct >= liquidationThresholdPct) {
            liquidationRiskCount++;
            position.liquidationRisk = true;
          }
        } else {
          // risk-based (default): same $ risk per trade regardless of current volatility
          pnlFraction = (priceDelta / stopDistancePct) * params.riskPerTradePct - FEE_BPS_ROUND_TRIP / 10000;
        }

        equity *= (1 + pnlFraction);
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, (peak - equity) / peak);
        trades.push({
          side: position.side, entryIdx: position.entryIdx, exitIdx: i, exitReason,
          heldDays: i - position.entryIdx, pnlFraction, stopDistancePct: +(stopDistancePct * 100).toFixed(2),
          liquidationRisk: !!position.liquidationRisk,
        });
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
    avgHeldDays: +(trades.reduce((a, t) => a + t.heldDays, 0) / trades.length).toFixed(1),
  };
}

function verdict(summary) {
  if (summary.tradeCount < 8) return "INSUFFICIENT_DATA (trend systems trade rarely — try a longer --days window)";
  const pf = summary.profitFactor === "inf" ? Infinity : summary.profitFactor;
  if (summary.netPnlPct > 0 && pf > 1.2) return "POSSIBLE_EDGE";
  return "NO_EDGE";
}

async function main() {
  const args = parseArgs();
  console.log(`Daily trend backtest: ${args.symbol}, ${args.days} days of daily candles`);
  console.log(`Sizing mode: ${args.sizingMode}${args.sizingMode === "full-notional" ? ` | capital=${args.capitalUsdt} USDT | leverage=${args.leverage}x` : ""}\n`);

  const candles = await fetchDailyCandles(args.symbol, args.days);
  console.log(`Fetched ${candles.length} daily candles\n`);

  const sizingConfig = { mode: args.sizingMode, leverage: args.leverage };
  const result = runDailyTrendBacktest(candles, DAILY_TREND_PARAMS, sizingConfig);
  const summary = summarize(result);
  const v = verdict(summary);

  console.log(JSON.stringify(summary, null, 2));

  if (args.sizingMode === "full-notional" && result.liquidationRiskCount > 0) {
    console.log(`\n⚠ WARNING: ${result.liquidationRiskCount} of ${result.trades.length} trades had a stop-loss distance wide enough that`);
    console.log(`  ${args.leverage}x leverage risks liquidation BEFORE the intended stop could fire. Consider lower leverage`);
    console.log(`  (try --leverage 2, or check the printed stopDistancePct per trade against 1/leverage).`);
  }

  console.log(`\nVerdict: ${v}`);
  console.log("\nRemember: trend systems trade rarely by design. A modest trade count here is normal, not a red flag by itself — but it does mean the result carries less statistical weight than the higher-frequency backtests from earlier tonight.");
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runDailyTrendBacktest, summarize, verdict, fetchDailyCandles };
