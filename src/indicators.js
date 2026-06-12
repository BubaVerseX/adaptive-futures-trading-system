"use strict";

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(current, previous) {
  return ((current - previous) / previous) * 100;
}

function ema(values, period) {
  if (values.length < period) return null;
  const smoothing = 2 / (period + 1);
  let result = average(values.slice(0, period));
  for (const value of values.slice(period)) result = value * smoothing + result * (1 - smoothing);
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  const moves = values.slice(-(period + 1)).map((value, index, recent) => (index ? value - recent[index - 1] : 0)).slice(1);
  const gain = average(moves.map((move) => Math.max(move, 0)));
  const loss = average(moves.map((move) => Math.max(-move, 0)));
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(-(period + 1)).map((candle, index, recent) => {
    if (index === 0) return null;
    const previousClose = recent[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  }).slice(1);
  return average(ranges);
}

function parseCandles(rawCandles) {
  return rawCandles
    .map((candle) => ({
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
      turnover: Number(candle.turnover || 0),
    }))
    .filter((candle) => Object.values(candle).every(Number.isFinite))
    .sort((left, right) => left.time - right.time);
}

function consecutiveCloseMoves(closes, direction) {
  let count = 0;
  for (let index = closes.length - 1; index > 0; index -= 1) {
    const current = closes[index];
    const previous = closes[index - 1];
    if (direction === "UP" && current > previous) {
      count += 1;
    } else if (direction === "DOWN" && current < previous) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function analyzeCandles(candles, minimumCandles = 55) {
  if (candles.length < minimumCandles) return null;
  const closes = candles.map((candle) => candle.close);
  const latest = candles[candles.length - 1];
  const beforeLatest = candles.slice(-21, -1);
  const latestRange = latest.high - latest.low;
  const normalRange = average(beforeLatest.map((candle) => candle.high - candle.low));
  const body = Math.abs(latest.close - latest.open);
  const atrValue = atr(candles, 14);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const previousCloses = closes.slice(0, -1);
  const previousEma9 = ema(previousCloses, 9);
  const previousEma21 = ema(previousCloses, 21);
  const rsi14 = rsi(closes, 14);
  const priorHigh = Math.max(...beforeLatest.map((candle) => candle.high));
  const priorLow = Math.min(...beforeLatest.map((candle) => candle.low));
  const priorRange = priorHigh - priorLow;
  const rangePosition = priorRange > 0 ? Math.max(0, Math.min(1, (latest.close - priorLow) / priorRange)) : 0.5;
  const normalVolume = average(beforeLatest.map((candle) => candle.volume));

  return {
    price: latest.close,
    ema9,
    ema21,
    ema50,
    emaGapPct: ((ema9 - ema21) / latest.close) * 100,
    previousEmaGapPct: ((previousEma9 - previousEma21) / candles[candles.length - 2].close) * 100,
    rsi14,
    atr: atrValue,
    atrPct: (atrValue / latest.close) * 100,
    momentumPct: percentChange(latest.close, candles[candles.length - 4].close),
    lastCandleMomentumPct: percentChange(latest.close, candles[candles.length - 2].close),
    upMomentumCandles: consecutiveCloseMoves(closes, "UP"),
    downMomentumCandles: consecutiveCloseMoves(closes, "DOWN"),
    volumeSpike: normalVolume > 0 ? latest.volume / normalVolume : 0,
    priorHigh,
    priorLow,
    rangePosition,
    distanceFromRangeLowPct: latest.close > 0 ? ((latest.close - priorLow) / latest.close) * 100 : 0,
    distanceFromRangeHighPct: latest.close > 0 ? ((priorHigh - latest.close) / latest.close) * 100 : 0,
    breakout: latest.close > priorHigh,
    breakdown: latest.close < priorLow,
    bodyStrength: latestRange > 0 ? body / latestRange : 0,
    bodyDirection: latest.close > latest.open ? "UP" : latest.close < latest.open ? "DOWN" : "FLAT",
    candleRangeAtr: atrValue > 0 ? latestRange / atrValue : 0,
    rangeExpansion: normalRange > 0 ? latestRange / normalRange : 0,
  };
}

function emaDirection(analysis) {
  if (!analysis) return "CHOPPY";
  if (![analysis.ema9, analysis.ema21, analysis.ema50].every(Number.isFinite)) return "CHOPPY";
  if (analysis.ema9 > analysis.ema21 && analysis.ema21 > analysis.ema50 && analysis.momentumPct > 0) return "UP";
  if (analysis.ema9 < analysis.ema21 && analysis.ema21 < analysis.ema50 && analysis.momentumPct < 0) return "DOWN";
  return "CHOPPY";
}

module.exports = { analyzeCandles, emaDirection, parseCandles, percentChange };
