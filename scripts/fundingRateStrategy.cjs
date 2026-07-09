/**
 * scripts/fundingRateStrategy.cjs
 *
 * Funding rate reversal — genuinely different from every strategy tested
 * tonight. Those all read price action (candles). This reads FUNDING RATE:
 * a periodic (every 8h on Bybit) payment between long and short traders,
 * driven by how crowded one side of the market currently is.
 *
 * Concept: when funding is unusually extreme relative to its own recent
 * history, it means an unusually large share of traders are crowded into
 * one side (often over-leveraged). That crowding has some real, documented
 * tendency to precede a reversal or squeeze. This bets against the crowd,
 * not on a price pattern.
 *
 * HONEST STATUS: never tested until the backtester runs it. This is a real,
 * different idea — not a guarantee it works here.
 */

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr, avg) {
  const variance = arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

const FUNDING_PARAMS = {
  lookback: 90,        // funding periods used to compute "normal" (90 x 8h = 30 days)
  entryZScore: 2.0,    // enter when funding is this many std-devs from its own recent mean
  exitZScore: 0.5,     // treat funding as "normalized" once back within this range
  maxHoldPeriods: 6,   // hard time-stop: 6 x 8h = 48 hours
  priceStopPct: 0.03,  // price-based safety stop, independent of the funding thesis
};

/**
 * Computes a z-score of the current funding rate relative to its own recent
 * history, using only PRIOR funding events (no lookahead).
 */
function fundingSignalAt(fundingHistory, i, params = FUNDING_PARAMS) {
  if (i < params.lookback) return { entry: null, zScore: null };

  const window = fundingHistory.slice(i - params.lookback, i).map((f) => f.fundingRate); // prior periods only
  const avg = mean(window);
  const sd = stdev(window, avg);
  if (sd === 0) return { entry: null, zScore: 0 };

  const current = fundingHistory[i].fundingRate;
  const zScore = (current - avg) / sd;

  // Very positive funding = crowd is overwhelmingly long = bet on reversal DOWN = go SHORT.
  // Shorting when funding is positive also means we RECEIVE the funding payments while held.
  let entry = null;
  if (zScore >= params.entryZScore) entry = "SHORT"; // fade the crowded longs
  else if (zScore <= -params.entryZScore) entry = "LONG"; // fade the crowded shorts

  return { entry, zScore, avg, sd };
}

module.exports = { fundingSignalAt, FUNDING_PARAMS };
