#!/usr/bin/env node
/**
 * scripts/simulateAggressive.cjs
 *
 * "Show me what aggressive looks like" — without spending real money to
 * find out (we already have that receipt, see TRADING_STATUS.md: -$48.66
 * in ~4 hours on 2026-07-02 from the original uncapped bot).
 *
 * Method: pool the REAL per-trade outcomes from the 39-symbol broad trend
 * backtest (already run, candles cached locally — no network needed here),
 * then bootstrap-resample from that empirical distribution at increasing
 * levels of aggressiveness (risk-per-trade %) and run each level thousands
 * of times to see the actual spread of outcomes, not one lucky/unlucky
 * live run.
 *
 * riskPerTradePct is the lever: the live scripts currently use 1% (risk 1%
 * of equity per trade, sized by ATR so the stop-loss costs exactly that).
 * "Aggressive" here means cranking that number up — same mechanism as
 * higher leverage / bigger position size, just expressed directly as
 * intended risk per trade, which is the honest unit (leverage alone is
 * meaningless without knowing stop distance).
 *
 * ============ USAGE ============
 *   node scripts/simulateAggressive.cjs
 */

const fs = require("fs");
const path = require("path");
const { dailyTrendSignalAt, DAILY_TREND_PARAMS } = require("./dailyTrendStrategy.cjs");
const { runDailyTrendBacktest } = require("./backtestDailyTrend.cjs");

const CACHE_DIR = path.join(process.cwd(), "data/research/cache/broadtrend");
const STARTING_CAPITAL = 64;
const TRADES_PER_RUN = 60; // roughly how many trades this system generates per symbol over ~2 years; simulate one "account lifetime"
const ITERATIONS = 5000;
const RISK_LEVELS = [0.01, 0.05, 0.15, 0.30, 0.50]; // 1% = current live setting, rest = "aggressive"

function loadPooledTrades() {
  if (!fs.existsSync(CACHE_DIR)) {
    throw new Error(`${CACHE_DIR} not found — run scripts/backtestBroadTrend.cjs first to populate the candle cache.`);
  }
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  const pooled = [];
  // riskPerTradePct=1 in DAILY_TREND_PARAMS gives us "raw" per-trade return
  // shape at baseline; we rescale afterward per risk level rather than
  // re-running the backtest N times.
  const baseParams = { ...DAILY_TREND_PARAMS, riskPerTradePct: 0.01 };
  for (const f of files) {
    const candles = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
    if (!Array.isArray(candles) || candles.length < 120) continue;
    const result = runDailyTrendBacktest(candles, baseParams, { mode: "risk-based", leverage: 2 });
    for (const t of result.trades) pooled.push(t.pnlFraction); // already fee-inclusive, at 1% risk baseline
  }
  return pooled;
}

function sample(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function runOneAccountLifetime(pooledAt1pct, riskLevel, trades) {
  const scale = riskLevel / 0.01; // rescale the baseline 1%-risk return to the target risk level
  let equity = STARTING_CAPITAL;
  for (let i = 0; i < trades; i++) {
    const baseReturn = sample(pooledAt1pct);
    const scaledReturn = baseReturn * scale;
    // A single trade can't lose more than 100% of what's staked on it; cap
    // the per-trade downside at -100% (total loss of equity), which is what
    // "liquidated" means in practice.
    const cappedReturn = Math.max(scaledReturn, -1);
    equity *= (1 + cappedReturn);
    if (equity < 0.01) { equity = 0; break; } // effectively wiped out, can't recover
  }
  return equity;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function main() {
  console.log(`Loading real trade outcomes from cached broad-basket backtest (${CACHE_DIR})...`);
  const pooled = loadPooledTrades();
  console.log(`Pooled ${pooled.length} real trade outcomes (fee-inclusive, at 1% risk-per-trade baseline) across ~39 symbols, 2 years.\n`);

  console.log(`Simulating ${ITERATIONS} account "lifetimes" of ${TRADES_PER_RUN} trades each, starting from $${STARTING_CAPITAL}, at increasing aggressiveness:\n`);

  for (const risk of RISK_LEVELS) {
    const outcomes = [];
    for (let i = 0; i < ITERATIONS; i++) {
      outcomes.push(runOneAccountLifetime(pooled, risk, TRADES_PER_RUN));
    }
    outcomes.sort((a, b) => a - b);

    const wipedOutPct = (outcomes.filter((e) => e <= 0.5).length / ITERATIONS) * 100;
    const doubledPct = (outcomes.filter((e) => e >= STARTING_CAPITAL * 2).length / ITERATIONS) * 100;
    const fivexPct = (outcomes.filter((e) => e >= STARTING_CAPITAL * 5).length / ITERATIONS) * 100;
    const median = percentile(outcomes, 0.5);
    const p5 = percentile(outcomes, 0.05);
    const p95 = percentile(outcomes, 0.95);

    const label = risk === 0.01 ? "1% (current live setting)" : `${(risk * 100).toFixed(0)}% (aggressive)`;
    console.log(`Risk-per-trade: ${label}`);
    console.log(`  Median outcome:        $${median.toFixed(2)}`);
    console.log(`  5th percentile (bad):  $${p5.toFixed(2)}`);
    console.log(`  95th percentile (good):$${p95.toFixed(2)}`);
    console.log(`  P(effectively wiped out, <$0.50):  ${wipedOutPct.toFixed(1)}%`);
    console.log(`  P(at least doubled, >=$${(STARTING_CAPITAL * 2).toFixed(0)}):     ${doubledPct.toFixed(1)}%`);
    console.log(`  P(5x or more, >=$${(STARTING_CAPITAL * 5).toFixed(0)}):          ${fivexPct.toFixed(1)}%`);
    console.log("");
  }

  console.log("Read this as: cranking risk-per-trade up doesn't turn a flat/negative-expectancy");
  console.log("strategy into a good bet. It just widens the spread of outcomes — bigger chance");
  console.log("of wipeout, alongside a bigger chance of a lucky spike. The median gets WORSE as");
  console.log("risk increases, because compounding a slightly-negative-expectancy return at higher");
  console.log("variance drags the typical (not average) outcome down, even though the mean of a");
  console.log("single trade doesn't change. This is the same math as the July 2 real-account result.");
}

main();
