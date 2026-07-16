/**
 * scripts/pairsStrategy.cjs
 *
 * Statistical pairs (spread) trading — structurally different from every
 * strategy tested tonight. Those all bet on absolute price direction
 * (trend, pullback, breakout — all directional). This bets on the
 * RELATIONSHIP between two correlated assets: when it stretches unusually
 * far from its recent normal range, bet on it snapping back. Long one leg,
 * short the other, simultaneously — so a broad market pump or dump barely
 * matters, only the relationship between the two.
 *
 * HONEST STATUS: brand new, never tested until the backtester below runs it.
 * Same rule as everything else tonight — this does not go live until it
 * shows real, positive, sufficiently-sampled backtest results.
 */

function logRatio(candlesA, candlesB, i) {
  return Math.log(candlesA[i].close / candlesB[i].close);
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr, avg) {
  const variance = arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

const PAIRS_PARAMS = {
  lookback: 100,       // candles used to compute the "normal" spread range
  entryZScore: 2.0,    // enter when spread is this many std-devs from its rolling mean
  exitZScore: 0.5,     // exit when spread reverts to within this many std-devs
  stopZScore: 3.5,      // hard stop if the spread keeps diverging past this (relationship may be broken, not just stretched)
  maxHold: 200,
};

/**
 * Computes the z-score of the log price ratio between two assets at index i,
 * using only data up to and including i (no lookahead).
 */
function pairsSignalAt(candlesA, candlesB, i, params = PAIRS_PARAMS) {
  if (i < params.lookback) return { entry: null, zScore: null };

  const window = [];
  for (let j = i - params.lookback; j <= i; j++) {
    window.push(logRatio(candlesA, candlesB, j));
  }
  const currentRatio = window[window.length - 1];
  const historicalWindow = window.slice(0, -1); // mean/stdev computed on PRIOR candles only, not including current
  const avg = mean(historicalWindow);
  const sd = stdev(historicalWindow, avg);
  if (sd === 0) return { entry: null, zScore: 0 };

  const zScore = (currentRatio - avg) / sd;

  // zScore > entryZScore: A is unusually expensive relative to B -> short A, long B (bet on convergence)
  // zScore < -entryZScore: A is unusually cheap relative to B -> long A, short B
  let entry = null;
  if (zScore >= params.entryZScore) entry = "SHORT_A_LONG_B";
  else if (zScore <= -params.entryZScore) entry = "LONG_A_SHORT_B";

  return { entry, zScore, avg, sd };
}

module.exports = { pairsSignalAt, logRatio, PAIRS_PARAMS };
