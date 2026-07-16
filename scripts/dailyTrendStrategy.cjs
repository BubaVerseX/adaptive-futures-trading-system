/**
 * scripts/dailyTrendStrategy.cjs
 *
 * Daily-timeframe trend following via Donchian channel breakout — enter on a
 * new N-day high/low, exit on a shorter M-day channel break the other way.
 * This is the core idea behind the "Turtle Trading" system and, more
 * broadly, what CTA / managed futures funds have run since the 1980s.
 *
 * Structurally different from everything tested tonight:
 *   - Daily candles, not 5m/15m — fees become nearly irrelevant at this
 *     trade frequency (holding weeks, not hours).
 *   - No fixed take-profit. Trend-following works by letting winners run;
 *     you exit on structure breaking, not a percentage target.
 *   - Position sizing is volatility-based (ATR), same risk per trade
 *     regardless of how choppy or calm the market currently is — this is
 *     what keeps a trend system from blowing up during a volatile patch.
 *
 * HONEST STATUS: never tested until the backtester runs it. Real historical
 * grounding for the general APPROACH (decades of CTA track record) does not
 * mean THIS specific implementation on THESE specific coins is proven —
 * same rule as everything else tonight.
 */

const { atr } = require("./strategyLogic.cjs");

const DAILY_TREND_PARAMS = {
  entryLookback: 20,   // enter on a new 20-day high/low
  exitLookback: 10,    // exit on a 10-day channel break the other way
  atrPeriod: 20,
  atrStopMultiple: 2,  // protective stop at entry +/- 2x ATR, in case of a sharp reversal right after entry
  riskPerTradePct: 0.01, // risk 1% of equity per trade, sized by ATR (bigger ATR = smaller position, same $ risk)
};

function donchianChannel(candles, i, lookback) {
  if (i < lookback) return { high: null, low: null };
  const window = candles.slice(i - lookback, i); // prior N candles, excludes current (no lookahead)
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
  };
}

function dailyTrendSignalAt(candles, i, params = DAILY_TREND_PARAMS, atrSeries = null) {
  const entryChannel = donchianChannel(candles, i, params.entryLookback);
  const exitChannel = donchianChannel(candles, i, params.exitLookback);
  const a = atrSeries || atr(candles, params.atrPeriod);

  if (entryChannel.high === null || exitChannel.high === null) {
    return { longEntry: false, shortEntry: false, longExit: false, shortExit: false, atr: null };
  }

  const close = candles[i].close;
  return {
    longEntry: close > entryChannel.high,
    shortEntry: close < entryChannel.low,
    longExit: close < exitChannel.low,
    shortExit: close > exitChannel.high,
    atr: a[i],
    entryChannel,
    exitChannel,
  };
}

module.exports = { dailyTrendSignalAt, donchianChannel, DAILY_TREND_PARAMS };
