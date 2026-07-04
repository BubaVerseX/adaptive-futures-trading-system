"use strict";

const { StrategyInterface } = require("./interface");
const { evaluateTrendBreakout } = require("./trendBreakout");
const { evaluateMultiTimeframeTrend } = require("./multiTimeframeTrend");
const { evaluateTrendPullback } = require("./trendPullback");
const { bounded, clampScore, numeric, round } = require("../strategyUtils");

function regimeName(marketRegime = {}) {
  const raw = String(marketRegime.regime || marketRegime.primary || marketRegime.direction || "RANGE").toUpperCase();
  if (raw.includes("EXTREME") || raw.includes("PANIC")) return "EXTREME";
  if (raw.includes("HIGH_VOLATILITY") || raw.includes("BREAKOUT")) return "HIGH_VOLATILITY";
  if (raw.includes("LOW_VOLATILITY") || raw.includes("DEAD")) return "LOW_VOLATILITY";
  if (raw.includes("TREND")) return "TRENDING";
  if (raw.includes("CHOP")) return "RANGE";
  return "RANGE";
}

class EvaluatorStrategy extends StrategyInterface {
  constructor({ name, strategyId, evaluator, compatibility, defaultHoldingSeconds }) {
    super(name);
    this.strategyId = strategyId;
    this.evaluator = evaluator;
    this.compatibility = compatibility;
    this.defaultHoldingSeconds = defaultHoldingSeconds;
  }

  generateSignal(context = {}) {
    const raw = this.evaluator(context);
    return {
      ...raw,
      name: this.name,
      strategyName: this.name,
      strategyId: this.strategyId,
      confidence: clampScore(raw && raw.confidence),
      preferredHoldingTimeSeconds: numeric(raw && raw.preferredHoldingTimeSeconds, this.defaultHoldingSeconds),
      expectedRewardRisk: numeric(raw && raw.expectedRewardRisk),
      positionSizeMultiplier: numeric(raw && raw.positionSizeMultiplier, 1),
      generatedBy: "V18_QUANT_STRATEGY_INTERFACE",
    };
  }

  generateExit(position = {}, context = {}) {
    const signal = context.signal || {};
    return {
      strategyName: this.name,
      strategyId: this.strategyId,
      dynamicExit: signal.dynamicExit || "trend invalidation, ATR trailing stop, structural breakdown",
      trailingStop: signal.trailingStop || { type: "ATR", dynamicExit: true },
      preserveSwingHold: true,
      reason: "V18 strategy interface delegates exits to trend structure and existing position manager",
      positionId: position.id || null,
    };
  }

  positionSizing(signal = {}, allocationContext = {}) {
    const allocationWeight = numeric(allocationContext.allocationWeight, 1 / 3);
    const baseMultiplier = numeric(signal.positionSizeMultiplier, 1);
    const performanceMultiplier = bounded(0.75 + allocationWeight * 1.5, 0.6, 1.6);
    return {
      strategyName: this.name,
      strategyId: this.strategyId,
      allocationWeight: round(allocationWeight, 4),
      positionSizeMultiplier: round(baseMultiplier * performanceMultiplier, 4),
      performanceMultiplier: round(performanceMultiplier, 4),
    };
  }

  expectedHoldingTime(signal = {}) {
    return numeric(signal.preferredHoldingTimeSeconds, this.defaultHoldingSeconds);
  }

  expectedRewardRisk(signal = {}) {
    return numeric(signal.expectedRewardRisk);
  }

  confidence(signal = {}) {
    return clampScore(signal.confidence);
  }

  marketCompatibility(marketRegime = {}) {
    const key = regimeName(marketRegime);
    return numeric(this.compatibility[key], this.compatibility.RANGE || 0.7);
  }
}

function createDefaultStrategies() {
  return [
    new EvaluatorStrategy({
      name: "DONCHIAN_TREND_BREAKOUT",
      strategyId: "TREND_BREAKOUT",
      evaluator: evaluateTrendBreakout,
      defaultHoldingSeconds: 12 * 60 * 60,
      compatibility: {
        TRENDING: 1,
        HIGH_VOLATILITY: 1,
        RANGE: 0.72,
        LOW_VOLATILITY: 0.5,
        EXTREME: 0,
      },
    }),
    new EvaluatorStrategy({
      name: "ATR_PULLBACK_CONTINUATION",
      strategyId: "TREND_PULLBACK",
      evaluator: evaluateTrendPullback,
      defaultHoldingSeconds: 10 * 60 * 60,
      compatibility: {
        TRENDING: 1,
        HIGH_VOLATILITY: 0.78,
        RANGE: 0.58,
        LOW_VOLATILITY: 0.45,
        EXTREME: 0,
      },
    }),
    new EvaluatorStrategy({
      name: "MULTI_TIMEFRAME_TREND_ALIGNMENT",
      strategyId: "MULTI_TIMEFRAME_TREND",
      evaluator: evaluateMultiTimeframeTrend,
      defaultHoldingSeconds: 18 * 60 * 60,
      compatibility: {
        TRENDING: 1,
        HIGH_VOLATILITY: 0.82,
        RANGE: 0.65,
        LOW_VOLATILITY: 0.48,
        EXTREME: 0,
      },
    }),
  ];
}

module.exports = {
  EvaluatorStrategy,
  createDefaultStrategies,
  regimeName,
};
