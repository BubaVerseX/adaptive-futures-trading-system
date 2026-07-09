/**
 * scripts/strategyLogic.cjs
 *
 * Single source of truth for indicator math and entry/exit signal logic.
 * Both the live bot (v33PowerPilot.cjs) and the backtester
 * (backtestStrategies.cjs) require() this same file — so "what the backtest
 * tested" and "what's actually running live" can never quietly drift apart,
 * which was a real risk with the old copy-pasted-per-version approach.
 *
 * Pure functions only. No network calls, no file I/O, no side effects.
 */

function atr(candles, period) {
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low :
    Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  const out = new Array(candles.length).fill(0);
  for (let i = 0; i < trs.length; i++) {
    out[i] = i < period ? trs.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1) : (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    prev = prev === null ? values.slice(0, period).reduce((a, b) => a + b, 0) / period : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function supertrendDir(candles, mult, period) {
  const a = atr(candles, period);
  const dir = new Array(candles.length).fill(1);
  let upperBand = null, lowerBand = null;
  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * a[i];
    const basicLower = hl2 - mult * a[i];
    if (i === 0) { upperBand = basicUpper; lowerBand = basicLower; dir[i] = 1; continue; }
    upperBand = (basicUpper < upperBand || candles[i - 1].close > upperBand) ? basicUpper : upperBand;
    lowerBand = (basicLower > lowerBand || candles[i - 1].close < lowerBand) ? basicLower : lowerBand;
    if (candles[i].close > upperBand) dir[i] = 1;
    else if (candles[i].close < lowerBand) dir[i] = -1;
    else dir[i] = dir[i - 1];
  }
  return dir;
}

// ---------------- Strategy 1: Supertrend ----------------

const DEFAULT_ST_PARAMS = {
  m1: 2, p1: 10, m2: 3, p2: 14, m3: 4, p3: 21,
  emaFilter: false, minAtr: 0.003, maxAtr: 0.03,
  sl: 0.02, tp: 0.015, maxHold: 144, minHold: 2,
};

// FIXED during extraction: previously read a module-level `cfg.minAgreement`
// implicitly. Now takes it as an explicit parameter (default 2) so this
// function has no hidden dependency on where it's called from.
function supertrendSignal(candles, i, p, minAgreement = 2) {
  const d1 = supertrendDir(candles, p.m1, p.p1);
  const d2 = supertrendDir(candles, p.m2, p.p2);
  const d3 = supertrendDir(candles, p.m3, p.p3);
  const close = candles.map((c) => c.close);
  const e1 = ema(close, 50);
  const e2 = ema(close, 200);
  const a = atr(candles, 14);
  const votesUp = [d1[i], d2[i], d3[i]].filter((v) => v === 1).length;
  const votesDown = [d1[i], d2[i], d3[i]].filter((v) => v === -1).length;
  const up = votesUp >= minAgreement;
  const down = votesDown >= minAgreement;
  const trendOkLong = !p.emaFilter || (e1[i] !== null && e2[i] !== null && e1[i] > e2[i]);
  const trendOkShort = !p.emaFilter || (e1[i] !== null && e2[i] !== null && e1[i] < e2[i]);
  const vol = a[i] ? a[i] / candles[i].close : 0;
  const volOk = vol >= p.minAtr && vol <= p.maxAtr;
  return {
    longEntry: up && trendOkLong && volOk, longExit: down,
    shortEntry: down && trendOkShort && volOk, shortExit: up,
    sl: p.sl, tp: p.tp, maxHold: p.maxHold, minHold: p.minHold,
  };
}

// ---------------- Strategy 2: Pullback ----------------

const PULLBACK_PARAMS = { sl: 0.02, tp: 0.03, maxHold: 100, minHold: 1 };

function pullbackSignal(candles, i) {
  const close = candles.map((c) => c.close);
  const e20 = ema(close, 20), e50 = ema(close, 50), e200 = ema(close, 200);
  if (e20[i] === null || e50[i] === null || e200[i] === null || e20[i - 1] === null) {
    return { longEntry: false, longExit: false, shortEntry: false, shortExit: false, ...PULLBACK_PARAMS };
  }
  const uptrend = e50[i] > e200[i];
  const downtrend = e50[i] < e200[i];
  const wasPulledBackDown = close[i - 1] < e20[i - 1];
  const wasPulledBackUp = close[i - 1] > e20[i - 1];
  const resolvedUp = close[i] > e20[i];
  const resolvedDown = close[i] < e20[i];
  return {
    longEntry: uptrend && wasPulledBackDown && resolvedUp, longExit: e50[i] < e200[i],
    shortEntry: downtrend && wasPulledBackUp && resolvedDown, shortExit: e50[i] > e200[i],
    ...PULLBACK_PARAMS,
  };
}

// ---------------- Strategy 3: Donchian Breakout ----------------

const BREAKOUT_PARAMS = { sl: 0.025, tp: 0.04, maxHold: 80, minHold: 1, donchianPeriod: 20, volumeMultiple: 1.2 };

function breakoutSignal(candles, i) {
  const p = BREAKOUT_PARAMS.donchianPeriod;
  if (i < p + 1) return { longEntry: false, longExit: false, shortEntry: false, shortExit: false, ...BREAKOUT_PARAMS };
  const window = candles.slice(i - p, i);
  const priorHigh = Math.max(...window.map((c) => c.high));
  const priorLow = Math.min(...window.map((c) => c.low));
  const priorMid = (priorHigh + priorLow) / 2;
  const avgVolume = window.reduce((a, c) => a + c.volume, 0) / window.length;
  const breakoutUp = candles[i].close > priorHigh;
  const breakoutDown = candles[i].close < priorLow;
  const volumeConfirmed = candles[i].volume > avgVolume * BREAKOUT_PARAMS.volumeMultiple;
  return {
    longEntry: breakoutUp && volumeConfirmed, longExit: candles[i].close < priorMid,
    shortEntry: breakoutDown && volumeConfirmed, shortExit: candles[i].close > priorMid,
    ...BREAKOUT_PARAMS,
  };
}

// ---------------- Fee-aware edge gate ----------------

const FEE_GATE = {
  takerFeeBpsRoundTrip: 11,
  slippageBufferBps: 3,
  minEdgeMultiple: 1.5,
};

function passesFeeGate(sig) {
  const costBps = FEE_GATE.takerFeeBpsRoundTrip + FEE_GATE.slippageBufferBps;
  const targetBps = sig.tp * 10000;
  return targetBps >= costBps * FEE_GATE.minEdgeMultiple;
}

// ---------------- Registry ----------------
// interval: candle timeframe this strategy operates on.
// needsParams: whether the strategy needs an external params object (currently only supertrend).
// fn(candles, i, params, minAgreement) -> signal object. Extra args are ignored by
// strategies that don't need them (JS allows this safely).

const STRATEGY_FNS = {
  supertrend: { interval: "5", needsParams: true, fn: (candles, i, params, minAgreement) => supertrendSignal(candles, i, params, minAgreement) },
  pullback: { interval: "15", needsParams: false, fn: (candles, i) => pullbackSignal(candles, i) },
  breakout: { interval: "15", needsParams: false, fn: (candles, i) => breakoutSignal(candles, i) },
};

function intervalMs(interval) {
  return Number(interval) * 60 * 1000;
}

module.exports = {
  atr, ema, supertrendDir,
  DEFAULT_ST_PARAMS, supertrendSignal,
  PULLBACK_PARAMS, pullbackSignal,
  BREAKOUT_PARAMS, breakoutSignal,
  FEE_GATE, passesFeeGate,
  STRATEGY_FNS, intervalMs,
};
