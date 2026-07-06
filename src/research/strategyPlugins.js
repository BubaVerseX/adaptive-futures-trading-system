"use strict";

const { analyzeCandles, parseCandles } = require("../indicators");
const {
  bounded,
  clampScore,
  controlledPullback,
  donchianBreakout,
  numeric,
  round,
  trendStructure,
} = require("../strategyUtils");

function analysisContext(candles = [], index = candles.length - 1) {
  const parsed = parseCandles(candles.slice(Math.max(0, index - 160), index + 1));
  return {
    candles: parsed,
    analysis: analyzeCandles(parsed, 55),
    price: numeric(parsed[parsed.length - 1] && parsed[parsed.length - 1].close),
  };
}

function researchSignal(strategy, context, side, confidence, details = {}) {
  const price = numeric(context.price);
  const stopDistancePct = Math.max(numeric(details.stopDistancePct), numeric(context.analysis && context.analysis.atrPct) * numeric(details.atrStopMultiplier, 1.5), 0.2);
  return {
    strategyId: strategy.strategyId,
    strategyName: strategy.name,
    direction: side,
    confidence: clampScore(confidence),
    entryReferencePrice: price,
    stopDistancePct: round(stopDistancePct, 4),
    stopPrice: side === "LONG" ? round(price * (1 - stopDistancePct / 100), 8) : round(price * (1 + stopDistancePct / 100), 8),
    expectedRewardRisk: round(numeric(details.expectedRewardRisk, 1.4), 4),
    expectedHoldingTimeSeconds: numeric(details.holdingSeconds, strategy.defaultHoldingSeconds),
    positionSizeMultiplier: numeric(details.positionSizeMultiplier, 1),
    reason: details.reason || strategy.name,
    params: details.params || {},
  };
}

class ResearchStrategyPlugin {
  constructor({ strategyId, name, defaultParams, parameterGrid, defaultHoldingSeconds }) {
    this.strategyId = strategyId;
    this.name = name;
    this.defaultParams = defaultParams;
    this.parameterGrid = parameterGrid;
    this.defaultHoldingSeconds = defaultHoldingSeconds;
  }

  parameterSets() {
    const keys = Object.keys(this.parameterGrid || {});
    if (!keys.length) return [this.defaultParams || {}];
    const sets = [{}];
    for (const key of keys) {
      const values = this.parameterGrid[key];
      const next = [];
      for (const base of sets) {
        for (const value of values) next.push({ ...base, [key]: value });
      }
      sets.splice(0, sets.length, ...next);
    }
    return sets.map((params) => ({ ...(this.defaultParams || {}), ...params }));
  }

  generateEntry() {
    throw new Error(`${this.name}.generateEntry() must be implemented.`);
  }

  generateExit(position, context = {}) {
    const analysis = context.analysis || {};
    if (position.side === "LONG" && !trendStructure("LONG", analysis) && numeric(position.unrealizedPct) > 0) {
      return { exit: true, reason: "TREND_DETERIORATION" };
    }
    if (position.side === "SHORT" && !trendStructure("SHORT", analysis) && numeric(position.unrealizedPct) > 0) {
      return { exit: true, reason: "TREND_DETERIORATION" };
    }
    return { exit: false, reason: "HOLD" };
  }

  positionSizing(signal = {}, context = {}) {
    const baseNotional = numeric(context.config && context.config.v22ResearchNotionalUsdt, 50);
    return {
      notionalUsdt: round(bounded(baseNotional * bounded(numeric(signal.confidence, 50) / 65, 0.4, 1.4) * numeric(signal.positionSizeMultiplier, 1), 2, numeric(context.config && context.config.maxDeployableCapitalUsdt, 64) || 64), 4),
    };
  }
}

class TrendBreakoutStrategy extends ResearchStrategyPlugin {
  constructor() {
    super({
      strategyId: "TREND_BREAKOUT",
      name: "TrendBreakout",
      defaultParams: { donchian: 20, atrStop: 1.6, holdingBars: 96 },
      parameterGrid: { donchian: [20, 40], atrStop: [1.4, 1.8], holdingBars: [72, 144] },
      defaultHoldingSeconds: 8 * 60 * 60,
    });
  }

  generateEntry(context = {}, params = this.defaultParams) {
    const long = donchianBreakout("LONG", context.candles, params.donchian, 0.02);
    const short = donchianBreakout("SHORT", context.candles, params.donchian, 0.02);
    const volume = numeric(context.analysis.volumeSpike, 1);
    if (long.breakout) return researchSignal(this, context, "LONG", 52 + long.distancePct * 18 + volume * 5, {
      atrStopMultiplier: params.atrStop,
      expectedRewardRisk: 1.7,
      holdingSeconds: params.holdingBars * 60,
      params,
      reason: "Donchian upper breakout",
    });
    if (short.breakout) return researchSignal(this, context, "SHORT", 52 + short.distancePct * 18 + volume * 5, {
      atrStopMultiplier: params.atrStop,
      expectedRewardRisk: 1.7,
      holdingSeconds: params.holdingBars * 60,
      params,
      reason: "Donchian lower breakout",
    });
    return null;
  }
}

class MomentumContinuationStrategy extends ResearchStrategyPlugin {
  constructor() {
    super({
      strategyId: "MOMENTUM_CONTINUATION",
      name: "MomentumContinuation",
      defaultParams: { minMomentum: 0.14, minCandles: 3, atrStop: 1.45, holdingBars: 72 },
      parameterGrid: { minMomentum: [0.1, 0.16], minCandles: [2, 3], atrStop: [1.3, 1.7] },
      defaultHoldingSeconds: 4 * 60 * 60,
    });
  }

  generateEntry(context = {}, params = this.defaultParams) {
    const analysis = context.analysis || {};
    if (numeric(analysis.upMomentumCandles) >= params.minCandles && numeric(analysis.momentumPct) >= params.minMomentum) {
      return researchSignal(this, context, "LONG", 50 + numeric(analysis.upMomentumCandles) * 5 + numeric(analysis.volumeSpike, 1) * 5, {
        atrStopMultiplier: params.atrStop,
        expectedRewardRisk: 1.45,
        holdingSeconds: params.holdingBars * 60,
        params,
        reason: "multi-candle long momentum continuation",
      });
    }
    if (numeric(analysis.downMomentumCandles) >= params.minCandles && numeric(analysis.momentumPct) <= -params.minMomentum) {
      return researchSignal(this, context, "SHORT", 50 + numeric(analysis.downMomentumCandles) * 5 + numeric(analysis.volumeSpike, 1) * 5, {
        atrStopMultiplier: params.atrStop,
        expectedRewardRisk: 1.45,
        holdingSeconds: params.holdingBars * 60,
        params,
        reason: "multi-candle short momentum continuation",
      });
    }
    return null;
  }
}

class MeanReversionStrategy extends ResearchStrategyPlugin {
  constructor() {
    super({
      strategyId: "MEAN_REVERSION",
      name: "MeanReversion",
      defaultParams: { lower: 0.18, upper: 0.82, rsiLow: 38, rsiHigh: 62, atrStop: 1.2, holdingBars: 48 },
      parameterGrid: { lower: [0.16, 0.22], upper: [0.78, 0.84], atrStop: [1.1, 1.35] },
      defaultHoldingSeconds: 2 * 60 * 60,
    });
  }

  generateEntry(context = {}, params = this.defaultParams) {
    const analysis = context.analysis || {};
    const position = numeric(analysis.rangePosition, 0.5);
    const rsi = numeric(analysis.rsi14, 50);
    if (position <= params.lower && rsi <= params.rsiLow) {
      return researchSignal(this, context, "LONG", 48 + (params.lower - position) * 100 + (params.rsiLow - rsi) * 0.6, {
        atrStopMultiplier: params.atrStop,
        expectedRewardRisk: 1.25,
        holdingSeconds: params.holdingBars * 60,
        positionSizeMultiplier: 0.75,
        params,
        reason: "lower range reversion",
      });
    }
    if (position >= params.upper && rsi >= params.rsiHigh) {
      return researchSignal(this, context, "SHORT", 48 + (position - params.upper) * 100 + (rsi - params.rsiHigh) * 0.6, {
        atrStopMultiplier: params.atrStop,
        expectedRewardRisk: 1.25,
        holdingSeconds: params.holdingBars * 60,
        positionSizeMultiplier: 0.75,
        params,
        reason: "upper range reversion",
      });
    }
    return null;
  }
}

class PullbackStrategy extends ResearchStrategyPlugin {
  constructor() {
    super({
      strategyId: "PULLBACK",
      name: "Pullback",
      defaultParams: { lookback: 10, atrStop: 1.45, holdingBars: 72 },
      parameterGrid: { lookback: [8, 12], atrStop: [1.25, 1.65], holdingBars: [72, 120] },
      defaultHoldingSeconds: 5 * 60 * 60,
    });
  }

  generateEntry(context = {}, params = this.defaultParams) {
    for (const side of ["LONG", "SHORT"]) {
      if (!trendStructure(side, context.analysis)) continue;
      const pullback = controlledPullback(side, context.candles, context.analysis, params.lookback);
      if (!pullback.controlled || !pullback.resumed) continue;
      return researchSignal(this, context, side, 54 + numeric(context.analysis.volumeSpike, 1) * 5 + Math.abs(numeric(context.analysis.emaGapPct)) * 2, {
        atrStopMultiplier: params.atrStop,
        expectedRewardRisk: 1.55,
        holdingSeconds: params.holdingBars * 60,
        params,
        reason: "controlled trend pullback resumed",
      });
    }
    return null;
  }
}

class VolatilityExpansionStrategy extends ResearchStrategyPlugin {
  constructor() {
    super({
      strategyId: "VOLATILITY_EXPANSION",
      name: "VolatilityExpansion",
      defaultParams: { minRangeExpansion: 1.4, minVolumeSpike: 1.35, atrStop: 1.8, holdingBars: 72 },
      parameterGrid: { minRangeExpansion: [1.25, 1.45], minVolumeSpike: [1.2, 1.45], atrStop: [1.5, 2] },
      defaultHoldingSeconds: 4 * 60 * 60,
    });
  }

  generateEntry(context = {}, params = this.defaultParams) {
    const analysis = context.analysis || {};
    if (numeric(analysis.rangeExpansion, 1) < params.minRangeExpansion || numeric(analysis.volumeSpike, 1) < params.minVolumeSpike) return null;
    const side = numeric(analysis.momentumPct) >= 0 ? "LONG" : "SHORT";
    return researchSignal(this, context, side, 50 + numeric(analysis.rangeExpansion, 1) * 7 + numeric(analysis.volumeSpike, 1) * 5, {
      atrStopMultiplier: params.atrStop,
      expectedRewardRisk: 1.7,
      holdingSeconds: params.holdingBars * 60,
      positionSizeMultiplier: 1.1,
      params,
      reason: "range and volume expansion",
    });
  }
}

function createResearchStrategies() {
  return [
    new TrendBreakoutStrategy(),
    new MomentumContinuationStrategy(),
    new MeanReversionStrategy(),
    new PullbackStrategy(),
    new VolatilityExpansionStrategy(),
  ];
}

module.exports = {
  MeanReversionStrategy,
  MomentumContinuationStrategy,
  PullbackStrategy,
  ResearchStrategyPlugin,
  TrendBreakoutStrategy,
  VolatilityExpansionStrategy,
  analysisContext,
  createResearchStrategies,
};
