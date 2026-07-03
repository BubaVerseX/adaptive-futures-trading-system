"use strict";

const { emaDirection } = require("./indicators");

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampScore(value) {
  return Number(bounded(value, 0, 100).toFixed(2));
}

function average(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

function directionForSide(side) {
  return side === "LONG" ? "UP" : "DOWN";
}

function sideForDirection(direction) {
  if (direction === "UP") return "LONG";
  if (direction === "DOWN") return "SHORT";
  return null;
}

function oppositeDirection(direction) {
  if (direction === "UP") return "DOWN";
  if (direction === "DOWN") return "UP";
  return "CHOPPY";
}

function oppositeForSide(side) {
  return oppositeDirection(directionForSide(side));
}

function directedMomentum(side, analysis) {
  return side === "LONG" ? numeric(analysis && analysis.momentumPct) : -numeric(analysis && analysis.momentumPct);
}

function directedLastMomentum(side, analysis) {
  return side === "LONG" ? numeric(analysis && analysis.lastCandleMomentumPct) : -numeric(analysis && analysis.lastCandleMomentumPct);
}

function trendStructure(side, analysis) {
  if (!analysis) return false;
  if (![analysis.ema9, analysis.ema21, analysis.ema50].every(Number.isFinite)) return false;
  return side === "LONG"
    ? analysis.ema9 > analysis.ema21 && analysis.ema21 > analysis.ema50
    : analysis.ema9 < analysis.ema21 && analysis.ema21 < analysis.ema50;
}

function priceAboveStructure(side, analysis) {
  if (!analysis || !Number.isFinite(analysis.price) || !Number.isFinite(analysis.ema21)) return false;
  return side === "LONG" ? analysis.price >= analysis.ema21 : analysis.price <= analysis.ema21;
}

function bodyForSide(side, analysis, minimum = 0.42) {
  if (!analysis) return false;
  return analysis.bodyDirection === directionForSide(side) && numeric(analysis.bodyStrength) >= minimum;
}

function breakoutForSide(side, analysis) {
  if (!analysis) return false;
  return side === "LONG" ? Boolean(analysis.breakout) : Boolean(analysis.breakdown);
}

function recentDonchian(candles = [], lookback = 20) {
  if (!Array.isArray(candles) || candles.length <= lookback) return null;
  const prior = candles.slice(-(lookback + 1), -1);
  const latest = candles[candles.length - 1];
  if (!prior.length || !latest) return null;
  return {
    high: Math.max(...prior.map((candle) => numeric(candle.high))),
    low: Math.min(...prior.map((candle) => numeric(candle.low))),
    latestClose: numeric(latest.close),
    latestHigh: numeric(latest.high),
    latestLow: numeric(latest.low),
  };
}

function donchianBreakout(side, candles = [], lookback = 20, bufferPct = 0) {
  const channel = recentDonchian(candles, lookback);
  if (!channel) return { breakout: false, channel: null, distancePct: 0 };
  if (side === "LONG") {
    const threshold = channel.high * (1 + bufferPct / 100);
    return {
      breakout: channel.latestClose > threshold,
      channel,
      distancePct: channel.high > 0 ? ((channel.latestClose - channel.high) / channel.high) * 100 : 0,
    };
  }
  const threshold = channel.low * (1 - bufferPct / 100);
  return {
    breakout: channel.latestClose < threshold,
    channel,
    distancePct: channel.low > 0 ? ((channel.low - channel.latestClose) / channel.low) * 100 : 0,
  };
}

function controlledPullback(side, candles = [], analysis = null, lookback = 10) {
  if (!Array.isArray(candles) || candles.length < lookback + 3 || !analysis) {
    return { controlled: false, resumed: false, pullbackDepthPct: 0 };
  }
  const recent = candles.slice(-lookback);
  const latest = recent[recent.length - 1];
  const previous = recent[recent.length - 2];
  const closes = recent.map((candle) => numeric(candle.close));
  const high = Math.max(...recent.map((candle) => numeric(candle.high)));
  const low = Math.min(...recent.map((candle) => numeric(candle.low)));
  const price = numeric(latest.close);
  const ema21 = numeric(analysis.ema21);
  const atr = numeric(analysis.atr);
  const pullbackDepthPct = side === "LONG"
    ? high > 0 ? ((high - Math.min(...closes.slice(0, -1))) / high) * 100 : 0
    : low > 0 ? ((Math.max(...closes.slice(0, -1)) - low) / low) * 100 : 0;
  const notBroken = side === "LONG"
    ? price >= ema21 - atr * 0.55 && numeric(latest.low) >= numeric(analysis.ema50) - atr * 0.25
    : price <= ema21 + atr * 0.55 && numeric(latest.high) <= numeric(analysis.ema50) + atr * 0.25;
  const resumed = side === "LONG"
    ? price > numeric(previous.close) && numeric(latest.close) > numeric(latest.open)
    : price < numeric(previous.close) && numeric(latest.close) < numeric(latest.open);
  const controlled = pullbackDepthPct > numeric(analysis.atrPct) * 0.45 && pullbackDepthPct < numeric(analysis.atrPct) * 5.5 && notBroken;
  return {
    controlled,
    resumed,
    pullbackDepthPct: Number(pullbackDepthPct.toFixed(4)),
    notBroken,
  };
}

function multiTimeframeDirections(analyses = {}) {
  return {
    entry: emaDirection(analyses.entry),
    confirmation: emaDirection(analyses.confirmation),
    trend: emaDirection(analyses.trend),
    macro: emaDirection(analyses.macro),
    macroLong: emaDirection(analyses.macroLong),
  };
}

function alignmentScore(side, directions = {}) {
  const expected = directionForSide(side);
  const opposite = oppositeForSide(side);
  const weights = {
    entry: 15,
    confirmation: 22,
    trend: 30,
    macro: 23,
    macroLong: 10,
  };
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const direction = directions[key] || "CHOPPY";
    if (direction === expected) score += weight;
    else if (direction === "CHOPPY") score += weight * 0.35;
    else if (direction === opposite) score -= weight * 0.75;
  }
  const values = Object.values(directions);
  const allAligned = values.length > 0 && values.every((direction) => direction === expected);
  const trendMacroOpposite = directions.trend === opposite && directions.macro === opposite;
  if (allAligned) score += 8;
  if (directions.confirmation === expected && directions.trend === expected) score += 6;
  if (trendMacroOpposite) score -= 18;
  return {
    score: clampScore(score),
    allAligned,
    trendMacroOpposite,
    macroOpposite: directions.macro === opposite || directions.macroLong === opposite,
    expected,
    opposite,
  };
}

function rewardRisk(expectedMovePct, stopDistancePct) {
  const stop = Math.max(0.01, numeric(stopDistancePct));
  return Number((Math.max(0, numeric(expectedMovePct)) / stop).toFixed(4));
}

function round(value, digits = 4) {
  return Number(numeric(value).toFixed(digits));
}

function noSignal(strategyId, reason, details = {}) {
  return {
    strategyId,
    direction: "NONE",
    confidence: 0,
    expectedRewardRisk: 0,
    stopLocation: null,
    stopDistancePct: 0,
    preferredHoldingTimeSeconds: 0,
    positionSizeMultiplier: 0,
    setupType: `${strategyId}_NO_TRADE`,
    enabled: false,
    rejected: true,
    reason,
    reasons: [reason],
    scoreBreakdown: [reason],
    details,
  };
}

module.exports = {
  alignmentScore,
  average,
  bodyForSide,
  bounded,
  breakoutForSide,
  clampScore,
  controlledPullback,
  directionForSide,
  directedLastMomentum,
  directedMomentum,
  donchianBreakout,
  multiTimeframeDirections,
  noSignal,
  numeric,
  oppositeForSide,
  priceAboveStructure,
  recentDonchian,
  rewardRisk,
  round,
  sideForDirection,
  trendStructure,
};
