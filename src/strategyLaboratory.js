"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { analyzeCandles, parseCandles } = require("./indicators");
const {
  average,
  bounded,
  clampScore,
  controlledPullback,
  directionForSide,
  donchianBreakout,
  numeric,
  recentDonchian,
  round,
  trendStructure,
} = require("./strategyUtils");

const LAB_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
const LAB_WINDOWS_DAYS = Object.freeze([30, 90, 180, 365]);
const NO_POSITIVE_EXPECTANCY_MESSAGE = "No strategy currently demonstrates positive historical expectancy.";

function candleTime(candle, fallbackIndex = 0) {
  const raw = candle && (candle.time || candle.start || candle.timestamp);
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 1700000000000 + fallbackIndex * 60 * 1000;
}

function detectCandleSeconds(candles = []) {
  if (!Array.isArray(candles) || candles.length < 2) return 60;
  const deltas = [];
  for (let index = 1; index < Math.min(candles.length, 20); index += 1) {
    const delta = candleTime(candles[index], index) - candleTime(candles[index - 1], index - 1);
    if (delta > 0) deltas.push(delta / 1000);
  }
  return deltas.length ? Math.max(1, Math.round(average(deltas))) : 60;
}

function regimeFromAnalysis(analysis = {}) {
  const atrPct = numeric(analysis.atrPct);
  const rangeExpansion = numeric(analysis.rangeExpansion, 1);
  const volumeSpike = numeric(analysis.volumeSpike, 1);
  const emaGap = Math.abs(numeric(analysis.emaGapPct));
  if (rangeExpansion >= 1.45 && volumeSpike >= 1.35) return "EXPANSION";
  if (atrPct >= 0.85) return "HIGH_VOLATILITY";
  if (atrPct <= 0.12 || (rangeExpansion <= 0.75 && volumeSpike <= 1.05)) return "LOW_VOLATILITY";
  if (emaGap >= 0.18 || Math.abs(numeric(analysis.momentumPct)) >= 0.16) return "TRENDING";
  return "RANGE";
}

function returnStats(values = []) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return { average: 0, standardDeviation: 0, downsideDeviation: 0 };
  const avg = average(usable);
  const variance = usable.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / usable.length;
  const downside = usable.filter((value) => value < 0);
  const downsideVariance = downside.length ? downside.reduce((sum, value) => sum + Math.pow(value, 2), 0) / downside.length : 0;
  return {
    average: avg,
    standardDeviation: Math.sqrt(variance),
    downsideDeviation: Math.sqrt(downsideVariance),
  };
}

function drawdown(pnls = []) {
  let equity = 0;
  let peak = 0;
  let maximum = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  }
  return maximum;
}

function summarizeLabTrades(trades = []) {
  const closed = trades.filter((trade) => Number.isFinite(numeric(trade.netPnlUsdt, Number.NaN)));
  const pnls = closed.map((trade) => numeric(trade.netPnlUsdt));
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const returns = returnStats(closed.map((trade) => numeric(trade.netReturnPct)));
  return {
    tradeCount: closed.length,
    netProfitUsdt: round(pnls.reduce((sum, value) => sum + value, 0), 6),
    winRatePct: closed.length ? round((wins.length / closed.length) * 100, 2) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : wins.length ? 999 : 0,
    maximumDrawdownUsdt: round(drawdown(pnls), 6),
    averageWinnerUsdt: wins.length ? round(grossWin / wins.length, 6) : 0,
    averageLoserUsdt: losses.length ? round(grossLoss / losses.length, 6) : 0,
    sharpeRatio: returns.standardDeviation > 0 ? round(returns.average / returns.standardDeviation, 4) : 0,
    sortinoRatio: returns.downsideDeviation > 0 ? round(returns.average / returns.downsideDeviation, 4) : 0,
    averageHoldSeconds: closed.length ? round(closed.reduce((sum, trade) => sum + numeric(trade.holdSeconds), 0) / closed.length, 2) : 0,
    feesUsdt: round(closed.reduce((sum, trade) => sum + Math.abs(numeric(trade.feesUsdt)), 0), 6),
  };
}

function performanceScore(metrics = {}) {
  const pfScore = Math.min(45, numeric(metrics.profitFactor) * 18);
  const pnlScore = bounded(numeric(metrics.netProfitUsdt) * 2.5, -35, 35);
  const winScore = bounded((numeric(metrics.winRatePct) - 42) * 0.35, -12, 18);
  const drawdownPenalty = Math.min(25, numeric(metrics.maximumDrawdownUsdt) * 2.5);
  const tradePenalty = numeric(metrics.tradeCount) > 0 ? 0 : 20;
  return round(bounded(35 + pfScore + pnlScore + winScore - drawdownPenalty - tradePenalty, 0, 100), 4);
}

function eligibilityFromMetrics(config = {}, metrics = {}) {
  const minProfitFactor = numeric(config.v21MinProfitFactor, 1.2);
  const maxDrawdown = numeric(config.v21MaxDrawdownUsdt, 8);
  const minTradeCount = numeric(config.v21MinTradeCount, 12);
  const reasons = [];
  if (numeric(metrics.netProfitUsdt) <= 0) reasons.push("net profit is not positive");
  if (numeric(metrics.profitFactor) <= minProfitFactor) reasons.push(`profit factor ${metrics.profitFactor} <= ${minProfitFactor}`);
  if (numeric(metrics.maximumDrawdownUsdt) > maxDrawdown) reasons.push(`drawdown ${metrics.maximumDrawdownUsdt} > ${maxDrawdown}`);
  if (numeric(metrics.tradeCount) < minTradeCount) reasons.push(`trade count ${metrics.tradeCount} < ${minTradeCount}`);
  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

class LaboratoryStrategyPlugin {
  constructor({ strategyId, name, family, strengths, weaknesses, regimes, holdSeconds }) {
    this.strategyId = strategyId;
    this.name = name;
    this.family = family;
    this.strengths = strengths;
    this.weaknesses = weaknesses;
    this.compatibleRegimes = regimes;
    this.baseHoldSeconds = holdSeconds;
  }

  generateEntry() {
    throw new Error(`${this.name}.generateEntry() must be implemented.`);
  }

  generateExit(position, context = {}) {
    return {
      exit: false,
      reason: "LAB_DYNAMIC_HOLD",
      trailingStopPct: Math.max(numeric(context.analysis && context.analysis.atrPct), 0.2),
      stopPrice: position.stopPrice,
    };
  }

  positionSizing(signal = {}, config = {}) {
    const deployable = numeric(config.maxDeployableCapitalUsdt, 64) || 64;
    const base = numeric(config.v21LabPositionNotionalUsdt, Math.min(32, deployable));
    const confidenceMultiplier = bounded(numeric(signal.confidence, 50) / 65, 0.45, 1.35);
    return {
      notionalUsdt: round(bounded(base * confidenceMultiplier * numeric(signal.positionSizeMultiplier, 1), 2, deployable), 4),
      positionSizeMultiplier: round(confidenceMultiplier * numeric(signal.positionSizeMultiplier, 1), 4),
    };
  }

  expectedHoldingTime(signal = {}) {
    return numeric(signal.expectedHoldingTimeSeconds, this.baseHoldSeconds);
  }
}

function labSignal(strategy, context, side, confidence, details = {}) {
  if (confidence < numeric(context.config.v21LabMinEntryConfidence, 45)) {
    return null;
  }
  const analysis = context.analysis || {};
  const price = numeric(context.price);
  const stopDistancePct = Math.max(numeric(details.stopDistancePct), numeric(analysis.atrPct) * numeric(context.config.v21StopAtrMultiplier, 1.6), 0.25);
  const stopPrice = side === "LONG" ? price * (1 - stopDistancePct / 100) : price * (1 + stopDistancePct / 100);
  return {
    strategyId: strategy.strategyId,
    strategyName: strategy.name,
    setupType: strategy.family,
    direction: side,
    confidence: clampScore(confidence),
    entryPrice: price,
    stopPrice: round(stopPrice, 8),
    stopDistancePct: round(stopDistancePct, 4),
    expectedRewardRisk: round(numeric(details.expectedRewardRisk, 1.45), 4),
    expectedHoldingTimeSeconds: numeric(details.expectedHoldingTimeSeconds, strategy.baseHoldSeconds),
    positionSizeMultiplier: numeric(details.positionSizeMultiplier, 1),
    regime: context.regime,
    reasons: details.reasons || [],
  };
}

class TrendBreakoutLabStrategy extends LaboratoryStrategyPlugin {
  constructor() {
    super({
      strategyId: "LAB_TREND_BREAKOUT",
      name: "Trend Breakout",
      family: "TREND_BREAKOUT",
      strengths: ["Captures directional expansion", "Works best when volume confirms new highs/lows"],
      weaknesses: ["Can whipsaw in range markets", "Needs cost-aware breakout distance"],
      regimes: ["TRENDING", "EXPANSION", "HIGH_VOLATILITY"],
      holdSeconds: 6 * 60 * 60,
    });
  }

  generateEntry(context = {}) {
    const candles = context.candles || [];
    const analysis = context.analysis || {};
    const lookback = numeric(context.config.v21DonchianLookback, 20);
    const long = donchianBreakout("LONG", candles, lookback, 0.02);
    const short = donchianBreakout("SHORT", candles, lookback, 0.02);
    const volume = numeric(analysis.volumeSpike, 1);
    const trend = Math.abs(numeric(analysis.emaGapPct));
    if (long.breakout) {
      return labSignal(this, context, "LONG", 48 + long.distancePct * 18 + Math.min(18, volume * 6) + Math.min(12, trend * 3), {
        stopDistancePct: numeric(analysis.atrPct) * 1.7,
        expectedRewardRisk: 1.65,
        positionSizeMultiplier: 1.08,
        reasons: ["Donchian upper-channel breakout", `volume ${round(volume, 2)}x`],
      });
    }
    if (short.breakout) {
      return labSignal(this, context, "SHORT", 48 + short.distancePct * 18 + Math.min(18, volume * 6) + Math.min(12, trend * 3), {
        stopDistancePct: numeric(analysis.atrPct) * 1.7,
        expectedRewardRisk: 1.65,
        positionSizeMultiplier: 1.08,
        reasons: ["Donchian lower-channel breakout", `volume ${round(volume, 2)}x`],
      });
    }
    return null;
  }
}

class TrendPullbackLabStrategy extends LaboratoryStrategyPlugin {
  constructor() {
    super({
      strategyId: "LAB_TREND_PULLBACK",
      name: "Trend Pullback",
      family: "TREND_PULLBACK",
      strengths: ["Improves entry location inside established trend", "Usually better fee-adjusted reward/risk than chasing"],
      weaknesses: ["Can enter too early if the pullback becomes reversal"],
      regimes: ["TRENDING", "RANGE"],
      holdSeconds: 5 * 60 * 60,
    });
  }

  generateEntry(context = {}) {
    const analysis = context.analysis || {};
    for (const side of ["LONG", "SHORT"]) {
      if (!trendStructure(side, analysis)) continue;
      const pullback = controlledPullback(side, context.candles || [], analysis, numeric(context.config.v21PullbackLookback, 10));
      if (!pullback.controlled || !pullback.resumed) continue;
      return labSignal(this, context, side, 54 + Math.min(18, numeric(analysis.volumeSpike, 1) * 5) + Math.min(16, numeric(analysis.emaGapPct) * 2), {
        stopDistancePct: numeric(analysis.atrPct) * 1.45,
        expectedRewardRisk: 1.55,
        positionSizeMultiplier: 1,
        reasons: [`controlled ${side.toLowerCase()} trend pullback`, `pullback depth ${round(pullback.pullbackDepthPct, 3)}%`],
      });
    }
    return null;
  }
}

class MomentumContinuationLabStrategy extends LaboratoryStrategyPlugin {
  constructor() {
    super({
      strategyId: "LAB_MOMENTUM_CONTINUATION",
      name: "Momentum Continuation",
      family: "MOMENTUM_CONTINUATION",
      strengths: ["Participates in persistent directional pressure", "Responsive to multi-candle momentum"],
      weaknesses: ["Can overpay during late impulse candles"],
      regimes: ["TRENDING", "EXPANSION", "HIGH_VOLATILITY"],
      holdSeconds: 4 * 60 * 60,
    });
  }

  generateEntry(context = {}) {
    const analysis = context.analysis || {};
    const up = numeric(analysis.upMomentumCandles);
    const down = numeric(analysis.downMomentumCandles);
    const volume = numeric(analysis.volumeSpike, 1);
    if (up >= 3 && numeric(analysis.momentumPct) > 0.14 && volume >= 1.15) {
      return labSignal(this, context, "LONG", 50 + up * 5 + Math.min(18, volume * 5) + numeric(analysis.momentumPct) * 18, {
        stopDistancePct: numeric(analysis.atrPct) * 1.55,
        expectedRewardRisk: 1.45,
        positionSizeMultiplier: 0.95,
        reasons: [`${up} upward momentum candles`, `momentum ${round(numeric(analysis.momentumPct), 3)}%`],
      });
    }
    if (down >= 3 && numeric(analysis.momentumPct) < -0.14 && volume >= 1.15) {
      return labSignal(this, context, "SHORT", 50 + down * 5 + Math.min(18, volume * 5) + Math.abs(numeric(analysis.momentumPct)) * 18, {
        stopDistancePct: numeric(analysis.atrPct) * 1.55,
        expectedRewardRisk: 1.45,
        positionSizeMultiplier: 0.95,
        reasons: [`${down} downward momentum candles`, `momentum ${round(numeric(analysis.momentumPct), 3)}%`],
      });
    }
    return null;
  }
}

class MeanReversionLabStrategy extends LaboratoryStrategyPlugin {
  constructor() {
    super({
      strategyId: "LAB_MEAN_REVERSION",
      name: "Mean Reversion",
      family: "MEAN_REVERSION",
      strengths: ["Useful when price stretches inside ranges", "Can add participation without chasing trend exhaustion"],
      weaknesses: ["Dangerous in clean trend breakouts", "Requires strict stops"],
      regimes: ["RANGE", "LOW_VOLATILITY"],
      holdSeconds: 2 * 60 * 60,
    });
  }

  generateEntry(context = {}) {
    const analysis = context.analysis || {};
    if (!["RANGE", "LOW_VOLATILITY"].includes(context.regime)) return null;
    const rangePosition = numeric(analysis.rangePosition, 0.5);
    const rsi = numeric(analysis.rsi14, 50);
    if (rangePosition <= 0.18 && rsi <= 38) {
      return labSignal(this, context, "LONG", 50 + (0.18 - rangePosition) * 90 + (38 - rsi) * 0.8, {
        stopDistancePct: Math.max(0.25, numeric(analysis.atrPct) * 1.25),
        expectedRewardRisk: 1.25,
        positionSizeMultiplier: 0.72,
        reasons: ["lower-range mean reversion", `RSI ${round(rsi, 2)}`],
      });
    }
    if (rangePosition >= 0.82 && rsi >= 62) {
      return labSignal(this, context, "SHORT", 50 + (rangePosition - 0.82) * 90 + (rsi - 62) * 0.8, {
        stopDistancePct: Math.max(0.25, numeric(analysis.atrPct) * 1.25),
        expectedRewardRisk: 1.25,
        positionSizeMultiplier: 0.72,
        reasons: ["upper-range mean reversion", `RSI ${round(rsi, 2)}`],
      });
    }
    return null;
  }
}

class VolatilityExpansionLabStrategy extends LaboratoryStrategyPlugin {
  constructor() {
    super({
      strategyId: "LAB_VOLATILITY_EXPANSION",
      name: "Volatility Expansion",
      family: "VOLATILITY_EXPANSION",
      strengths: ["Targets fresh volatility after compression", "Works when range expansion and volume agree"],
      weaknesses: ["Can misread one-candle news spikes", "Needs enough spread/fee cushion"],
      regimes: ["COMPRESSION", "EXPANSION", "HIGH_VOLATILITY"],
      holdSeconds: 4.5 * 60 * 60,
    });
  }

  generateEntry(context = {}) {
    const analysis = context.analysis || {};
    const rangeExpansion = numeric(analysis.rangeExpansion, 1);
    const volume = numeric(analysis.volumeSpike, 1);
    if (rangeExpansion < 1.4 || volume < 1.35) return null;
    const side = numeric(analysis.momentumPct) >= 0 ? "LONG" : "SHORT";
    return labSignal(this, context, side, 50 + Math.min(20, rangeExpansion * 7) + Math.min(18, volume * 5) + Math.abs(numeric(analysis.momentumPct)) * 16, {
      stopDistancePct: numeric(analysis.atrPct) * 1.8,
      expectedRewardRisk: 1.7,
      positionSizeMultiplier: 1.12,
      reasons: [`range expansion ${round(rangeExpansion, 2)}`, `volume ${round(volume, 2)}x`],
    });
  }
}

function createLaboratoryStrategies() {
  return [
    new TrendBreakoutLabStrategy(),
    new TrendPullbackLabStrategy(),
    new MomentumContinuationLabStrategy(),
    new MeanReversionLabStrategy(),
    new VolatilityExpansionLabStrategy(),
  ];
}

function simulationExit(signal, candles, entryIndex, config = {}) {
  const candleSeconds = detectCandleSeconds(candles);
  const maxBars = Math.max(3, Math.round(numeric(signal.expectedHoldingTimeSeconds, 4 * 60 * 60) / candleSeconds));
  const entryPrice = numeric(signal.entryPrice, numeric(candles[entryIndex] && candles[entryIndex].close));
  const side = signal.direction;
  let stopPrice = numeric(signal.stopPrice);
  let exitPrice = numeric(candles[Math.min(candles.length - 1, entryIndex + maxBars)] && candles[Math.min(candles.length - 1, entryIndex + maxBars)].close, entryPrice);
  let exitIndex = Math.min(candles.length - 1, entryIndex + maxBars);
  let reason = "EXPECTED_HOLD_COMPLETE";
  let maxFavorablePct = 0;
  let maxAdversePct = 0;
  for (let index = entryIndex + 1; index <= Math.min(candles.length - 1, entryIndex + maxBars); index += 1) {
    const candle = candles[index];
    const high = numeric(candle.high);
    const low = numeric(candle.low);
    const favorablePct = side === "LONG" ? ((high - entryPrice) / entryPrice) * 100 : ((entryPrice - low) / entryPrice) * 100;
    const adversePct = side === "LONG" ? ((entryPrice - low) / entryPrice) * 100 : ((high - entryPrice) / entryPrice) * 100;
    maxFavorablePct = Math.max(maxFavorablePct, favorablePct);
    maxAdversePct = Math.max(maxAdversePct, adversePct);
    if ((side === "LONG" && low <= stopPrice) || (side === "SHORT" && high >= stopPrice)) {
      exitPrice = stopPrice;
      exitIndex = index;
      reason = "LAB_STOP";
      break;
    }
    if (maxFavorablePct >= numeric(signal.stopDistancePct) * 1.4) {
      const trailDistancePct = Math.max(numeric(signal.stopDistancePct) * 0.75, numeric(config.v21TrailAtrPct, 0.25));
      stopPrice = side === "LONG"
        ? Math.max(stopPrice, high * (1 - trailDistancePct / 100))
        : Math.min(stopPrice, low * (1 + trailDistancePct / 100));
    }
    const targetPct = numeric(signal.stopDistancePct) * numeric(signal.expectedRewardRisk, 1.4);
    if (maxFavorablePct >= targetPct) {
      exitPrice = side === "LONG" ? entryPrice * (1 + targetPct / 100) : entryPrice * (1 - targetPct / 100);
      exitIndex = index;
      reason = "LAB_REWARD_REFERENCE";
      break;
    }
  }
  const grossPct = side === "LONG" ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  const feePct = numeric(config.estimatedFeePctPerSide, 0.055) * 2 + numeric(config.estimatedSlippagePct, 0.08);
  const sizing = signal.sizing || { notionalUsdt: numeric(config.v21LabPositionNotionalUsdt, 32) };
  const notional = numeric(sizing.notionalUsdt, 32);
  const netPct = grossPct - feePct;
  return {
    symbol: signal.symbol,
    strategyId: signal.strategyId,
    strategyName: signal.strategyName,
    setupType: signal.setupType,
    side,
    regime: signal.regime,
    confidence: signal.confidence,
    entryPrice: round(entryPrice, 8),
    exitPrice: round(exitPrice, 8),
    enteredAt: new Date(candleTime(candles[entryIndex], entryIndex)).toISOString(),
    exitedAt: new Date(candleTime(candles[exitIndex], exitIndex)).toISOString(),
    holdSeconds: Math.max(0, (exitIndex - entryIndex) * candleSeconds),
    grossReturnPct: round(grossPct, 4),
    netReturnPct: round(netPct, 4),
    feesUsdt: round(notional * (feePct / 100), 6),
    grossPnlUsdt: round(notional * (grossPct / 100), 6),
    netPnlUsdt: round(notional * (netPct / 100), 6),
    maximumFavorableExcursionPct: round(maxFavorablePct, 4),
    maximumAdverseExcursionPct: round(maxAdversePct, 4),
    exitReason: reason,
  };
}

class StrategyLaboratory {
  constructor(config = {}, log = () => {}, strategies = createLaboratoryStrategies()) {
    this.config = config;
    this.log = log;
    this.strategies = strategies;
  }

  contextFor(candles, index, symbol) {
    const parsed = parseCandles(candles.slice(Math.max(0, index - 120), index + 1));
    const analysis = analyzeCandles(parsed, 55);
    const price = numeric(parsed[parsed.length - 1] && parsed[parsed.length - 1].close);
    return {
      symbol,
      candles: parsed,
      index,
      analysis,
      regime: regimeFromAnalysis(analysis),
      price,
      config: this.config,
    };
  }

  simulateStrategy(strategy, symbol, rawCandles = []) {
    const candles = parseCandles(rawCandles || []);
    const trades = [];
    if (candles.length < 80) return trades;
    for (let index = 60; index < candles.length - 5; index += 1) {
      const context = this.contextFor(candles, index, symbol);
      const signal = strategy.generateEntry(context);
      if (!signal) continue;
      signal.symbol = symbol;
      signal.sizing = strategy.positionSizing(signal, this.config);
      const trade = simulationExit(signal, candles, index, this.config);
      trades.push(trade);
      const candleSeconds = detectCandleSeconds(candles);
      index += Math.max(1, Math.floor(numeric(trade.holdSeconds) / candleSeconds));
    }
    return trades;
  }

  run(candlesBySymbol = {}, options = {}) {
    const symbols = (options.symbols || LAB_SYMBOLS).filter((symbol) => Array.isArray(candlesBySymbol[symbol]));
    const strategyReports = {};
    const allRankItems = [];
    for (const strategy of this.strategies) {
      const allTrades = [];
      const tradesBySymbol = {};
      for (const symbol of symbols) {
        const trades = this.simulateStrategy(strategy, symbol, candlesBySymbol[symbol]);
        tradesBySymbol[symbol] = trades;
        allTrades.push(...trades);
      }
      const latestTime = allTrades.length
        ? Math.max(...allTrades.map((trade) => Date.parse(trade.exitedAt)).filter(Number.isFinite))
        : Date.now();
      const windows = {};
      for (const days of LAB_WINDOWS_DAYS) {
        const cutoff = latestTime - days * 24 * 60 * 60 * 1000;
        windows[`${days}d`] = summarizeLabTrades(allTrades.filter((trade) => {
          const when = Date.parse(trade.exitedAt);
          return !Number.isFinite(when) || when >= cutoff;
        }));
      }
      const aggregate = summarizeLabTrades(allTrades);
      const eligibility = eligibilityFromMetrics(this.config, aggregate);
      const regimeBuckets = {};
      for (const trade of allTrades) {
        const key = trade.regime || "UNKNOWN";
        if (!regimeBuckets[key]) regimeBuckets[key] = [];
        regimeBuckets[key].push(trade);
      }
      const regimeSummaries = Object.fromEntries(Object.entries(regimeBuckets).map(([key, trades]) => [key, summarizeLabTrades(trades)]));
      const bestRegime = Object.entries(regimeSummaries).sort((left, right) => numeric(right[1].netProfitUsdt) - numeric(left[1].netProfitUsdt))[0];
      const worstRegime = Object.entries(regimeSummaries).sort((left, right) => numeric(left[1].netProfitUsdt) - numeric(right[1].netProfitUsdt))[0];
      const rankItem = {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        score: performanceScore(aggregate),
        eligibleForLive: eligibility.eligible,
        promotionBlockedReasons: eligibility.reasons,
        ...aggregate,
      };
      allRankItems.push(rankItem);
      strategyReports[strategy.strategyId] = {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        pluginInterface: ["generateEntry", "generateExit", "positionSizing", "expectedHoldingTime"],
        aggregate,
        windows,
        bySymbol: Object.fromEntries(Object.entries(tradesBySymbol).map(([symbol, trades]) => [symbol, summarizeLabTrades(trades)])),
        regimePerformance: regimeSummaries,
        strengths: strategy.strengths,
        weaknesses: strategy.weaknesses,
        bestMarketRegime: bestRegime ? bestRegime[0] : null,
        worstMarketRegime: worstRegime ? worstRegime[0] : null,
        expectedHoldingTimeSeconds: strategy.expectedHoldingTime(),
        expectedTradeFrequency: aggregate.tradeCount >= 40 ? "HIGH" : aggregate.tradeCount >= 15 ? "MEDIUM" : aggregate.tradeCount > 0 ? "LOW" : "NONE",
        eligibleForLive: eligibility.eligible,
        promotionBlockedReasons: eligibility.reasons,
      };
    }
    const rankings = allRankItems.sort((left, right) => right.score - left.score).map((item, index) => ({ rank: index + 1, ...item }));
    const promotedStrategies = rankings.filter((item) => item.eligibleForLive);
    const report = {
      generatedAt: new Date().toISOString(),
      objective: "V21 Strategy Laboratory: prove strategy expectancy before live use",
      noLiveOrders: true,
      symbols,
      windowsDays: LAB_WINDOWS_DAYS,
      thresholds: {
        minProfitFactor: numeric(this.config.v21MinProfitFactor, 1.2),
        positiveNetProfitRequired: true,
        maxDrawdownUsdt: numeric(this.config.v21MaxDrawdownUsdt, 8),
        minTradeCount: numeric(this.config.v21MinTradeCount, 12),
      },
      strategies: strategyReports,
      rankings,
      promotedStrategies,
      recommendedLiveStrategy: promotedStrategies[0] || null,
      message: promotedStrategies.length ? `Promote ${promotedStrategies[0].strategyName} first; it ranked #${promotedStrategies[0].rank}.` : NO_POSITIVE_EXPECTANCY_MESSAGE,
    };
    this.log("INFO", "V21_STRATEGY_LABORATORY_COMPLETED", {
      strategies: this.strategies.length,
      promotedStrategies: promotedStrategies.map((item) => item.strategyId),
      message: report.message,
    });
    return report;
  }

  shadowEvaluate(context = {}) {
    const analyses = context.analyses || {};
    const candles = analyses.entryCandles || analyses.confirmationCandles || analyses.trendCandles || [];
    const parsed = parseCandles(candles);
    if (parsed.length < 20) return [];
    const latest = parsed[parsed.length - 1];
    const labContext = {
      symbol: context.symbol,
      candles: parsed,
      index: parsed.length - 1,
      analysis: analyses.entry || analyzeCandles(parsed, 55),
      regime: regimeFromAnalysis(analyses.entry || {}),
      price: numeric(context.price, numeric(latest.close)),
      config: this.config,
    };
    return this.strategies.map((strategy) => {
      const signal = strategy.generateEntry(labContext);
      return signal ? {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        direction: signal.direction,
        confidence: signal.confidence,
        expectedRewardRisk: signal.expectedRewardRisk,
        stopDistancePct: signal.stopDistancePct,
        expectedMovePct: numeric(signal.stopDistancePct) * numeric(signal.expectedRewardRisk, 1.4),
        expectedHoldingTimeSeconds: signal.expectedHoldingTimeSeconds,
        wouldHaveEntered: true,
        trackingStatus: "PENDING_FUTURE_OUTCOME",
        liveOrderGenerated: false,
        shadowOnly: true,
      } : {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        wouldHaveEntered: false,
        trackingStatus: "NO_ENTRY",
        liveOrderGenerated: false,
        shadowOnly: true,
      };
    });
  }

  writeReport(report, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

module.exports = {
  LAB_SYMBOLS,
  LAB_WINDOWS_DAYS,
  NO_POSITIVE_EXPECTANCY_MESSAGE,
  LaboratoryStrategyPlugin,
  MeanReversionLabStrategy,
  MomentumContinuationLabStrategy,
  StrategyLaboratory,
  TrendBreakoutLabStrategy,
  TrendPullbackLabStrategy,
  VolatilityExpansionLabStrategy,
  createLaboratoryStrategies,
  eligibilityFromMetrics,
  regimeFromAnalysis,
  summarizeLabTrades,
};
