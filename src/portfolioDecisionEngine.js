"use strict";

const { evaluateTrendBreakout } = require("./strategies/trendBreakout");
const { evaluateMultiTimeframeTrend } = require("./strategies/multiTimeframeTrend");
const { evaluateTrendPullback } = require("./strategies/trendPullback");
const {
  bounded,
  clampScore,
  directionForSide,
  multiTimeframeDirections,
  numeric,
  rewardRisk,
  round,
} = require("./strategyUtils");

const STRATEGIES = Object.freeze([
  { id: "TREND_BREAKOUT", weightKey: "v15TrendBreakoutWeight", evaluate: evaluateTrendBreakout },
  { id: "MULTI_TIMEFRAME_TREND", weightKey: "v15MultiTimeframeTrendWeight", evaluate: evaluateMultiTimeframeTrend },
  { id: "TREND_PULLBACK", weightKey: "v15TrendPullbackWeight", evaluate: evaluateTrendPullback },
]);

function normalizeWeights(config) {
  const raw = Object.fromEntries(STRATEGIES.map((strategy) => [strategy.id, Math.max(0, numeric(config[strategy.weightKey], 1))]));
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value / total]));
}

function estimateRoundTripCostPct(config, spreadPct) {
  return Number(((numeric(config.estimatedFeePctPerSide) * 2) + numeric(config.estimatedSlippagePct) + numeric(spreadPct)).toFixed(5));
}

function classifyMarketRegime(config, marketProfile = {}, analyses = {}) {
  const tags = new Set(marketProfile.tags || []);
  const directions = multiTimeframeDirections(analyses);
  const atrPct = Math.max(
    numeric(analyses.entry && analyses.entry.atrPct),
    numeric(analyses.confirmation && analyses.confirmation.atrPct),
    numeric(analyses.trend && analyses.trend.atrPct),
    numeric(marketProfile.avgAtrPct),
    numeric(marketProfile.btcVolatilityPct)
  );
  const rangeExpansion = Math.max(
    numeric(analyses.entry && analyses.entry.rangeExpansion),
    numeric(analyses.confirmation && analyses.confirmation.rangeExpansion),
    numeric(analyses.trend && analyses.trend.rangeExpansion)
  );
  const volumeSpike = Math.max(
    numeric(analyses.entry && analyses.entry.volumeSpike),
    numeric(analyses.confirmation && analyses.confirmation.volumeSpike),
    numeric(analyses.trend && analyses.trend.volumeSpike)
  );
  const alignedTrend =
    directions.confirmation !== "CHOPPY" &&
    directions.confirmation === directions.trend &&
    (directions.macro === directions.trend || directions.macro === "CHOPPY");
  const breakoutLike =
    tags.has("HIGH_VOLATILITY_BREAKOUT_MARKET") ||
    Boolean(analyses.entry && (analyses.entry.breakout || analyses.entry.breakdown)) ||
    Boolean(analyses.confirmation && (analyses.confirmation.breakout || analyses.confirmation.breakdown));
  if (atrPct >= numeric(config.abnormalVolatilityAtrPct, 1.6) || tags.has("PANIC")) {
    return {
      regime: "HIGH_VOLATILITY",
      strategyBias: { TREND_BREAKOUT: 1.1, MULTI_TIMEFRAME_TREND: 0.95, TREND_PULLBACK: 0.78 },
      reason: "abnormal volatility requires breakout-first selectivity",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  if (breakoutLike && rangeExpansion >= numeric(config.minRangeExpansion, 1.1) && volumeSpike >= numeric(config.minVolumeSpike, 1.1) * 0.85) {
    return {
      regime: "HIGH_VOLATILITY",
      strategyBias: { TREND_BREAKOUT: 1.18, MULTI_TIMEFRAME_TREND: 1, TREND_PULLBACK: 0.9 },
      reason: "breakout volatility expansion detected",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  if (alignedTrend || tags.has("STRONG_TRENDING_MARKET")) {
    return {
      regime: "TRENDING",
      strategyBias: { TREND_BREAKOUT: 1.04, MULTI_TIMEFRAME_TREND: 1.12, TREND_PULLBACK: 1.08 },
      reason: "multi-timeframe trend alignment supports trend strategies",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  if (atrPct <= numeric(config.regimeDeadMarketAtrPct, 0.12) || tags.has("DEAD_MARKET_CONDITIONS")) {
    return {
      regime: "LOW_VOLATILITY",
      strategyBias: { TREND_BREAKOUT: 0.72, MULTI_TIMEFRAME_TREND: 0.82, TREND_PULLBACK: 0.86 },
      reason: "low volatility asks for stronger evidence before committing",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  return {
    regime: "RANGE",
    strategyBias: { TREND_BREAKOUT: 0.76, MULTI_TIMEFRAME_TREND: 0.86, TREND_PULLBACK: 1.04 },
    reason: "range conditions permit only high-quality trend continuation/pullback signals",
    atrPct: round(atrPct, 4),
    rangeExpansion: round(rangeExpansion, 3),
    volumeSpike: round(volumeSpike, 3),
    directions,
  };
}

class PortfolioDecisionEngine {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
  }

  evaluate(context) {
    const weights = normalizeWeights(this.config);
    const regime = classifyMarketRegime(this.config, context.marketProfile, context.analyses);
    const estimatedRoundTripCostPct = estimateRoundTripCostPct(this.config, context.spreadPct);
    const strategyContext = {
      ...context,
      config: this.config,
      estimatedRoundTripCostPct,
      marketRegime: regime,
    };
    const strategyOutputs = STRATEGIES.map((strategy) => {
      const output = strategy.evaluate(strategyContext);
      const biasedConfidence = clampScore(numeric(output.confidence) * numeric(regime.strategyBias[strategy.id], 1));
      return {
        ...output,
        rawConfidence: numeric(output.confidence),
        confidence: biasedConfidence,
        portfolioWeight: round(weights[strategy.id], 4),
        marketRegimeBias: numeric(regime.strategyBias[strategy.id], 1),
      };
    });
    const votes = { LONG: 0, SHORT: 0 };
    const weightedReward = { LONG: 0, SHORT: 0 };
    const weightedStopDistance = { LONG: 0, SHORT: 0 };
    const weightedMove = { LONG: 0, SHORT: 0 };
    const participants = { LONG: [], SHORT: [] };
    for (const output of strategyOutputs) {
      if (!["LONG", "SHORT"].includes(output.direction)) continue;
      const weighted = output.confidence * output.portfolioWeight;
      votes[output.direction] += weighted;
      weightedReward[output.direction] += numeric(output.expectedRewardRisk) * weighted;
      weightedStopDistance[output.direction] += numeric(output.stopDistancePct) * weighted;
      weightedMove[output.direction] += numeric(output.expectedMovePct) * weighted;
      participants[output.direction].push(output);
    }
    const side = votes.LONG >= votes.SHORT ? "LONG" : "SHORT";
    const opposite = side === "LONG" ? "SHORT" : "LONG";
    const supporting = participants[side];
    const opposing = participants[opposite];
    const supportWeight = votes[side];
    const opposeWeight = votes[opposite];
    const consensusBoost = supporting.length >= 2 ? 6 : supporting.length === 1 ? 0 : -14;
    const conflictPenalty = opposing.length ? Math.min(18, opposeWeight * 0.18) : 0;
    const confidence = clampScore(supportWeight + consensusBoost - conflictPenalty);
    const dominantStrategy = supporting.slice().sort((left, right) => right.confidence - left.confidence)[0] || null;
    const expectedRewardRisk = supportWeight > 0 ? weightedReward[side] / supportWeight : 0;
    const stopDistancePct = supportWeight > 0
      ? weightedStopDistance[side] / supportWeight
      : Math.max(numeric(this.config.stopLossPct), numeric(regime.atrPct) * numeric(this.config.trendPortfolioStopAtrMultiplier));
    const expectedMovePct = supportWeight > 0
      ? weightedMove[side] / supportWeight
      : stopDistancePct * this.config.v15MinRewardRisk;
    const projectedNetEdgePct = Number((expectedMovePct - estimatedRoundTripCostPct).toFixed(4));
    const feeEdgeRatio = estimatedRoundTripCostPct > 0 ? Number((expectedMovePct / estimatedRoundTripCostPct).toFixed(4)) : 999;
    const eligible =
      supporting.length > 0 &&
      confidence >= this.config.trendPortfolioMinScore &&
      projectedNetEdgePct >= this.config.trendPortfolioMinNetEdgePct &&
      feeEdgeRatio >= this.config.trendPortfolioMinRewardCostRatio &&
      expectedRewardRisk >= this.config.v15MinRewardRisk;
    const confidenceClass =
      confidence >= this.config.trendPortfolioEliteScore
        ? "ELITE"
        : confidence >= this.config.trendPortfolioStrongScore
          ? "HIGH"
          : confidence >= this.config.trendPortfolioNormalScore
            ? "STANDARD"
            : "REJECT";
    const qualityTier =
      confidenceClass === "ELITE"
        ? "ELITE"
        : confidenceClass === "HIGH"
          ? "STRONG"
          : confidenceClass === "STANDARD"
            ? "NORMAL"
            : "REJECT";
    const rejectionReasons = [];
    if (!supporting.length) rejectionReasons.push("no V15 strategy produced an enabled directional signal");
    if (confidence < this.config.trendPortfolioMinScore) rejectionReasons.push(`portfolio confidence ${confidence} below ${this.config.trendPortfolioMinScore}`);
    if (projectedNetEdgePct < this.config.trendPortfolioMinNetEdgePct) rejectionReasons.push(`projected net edge ${projectedNetEdgePct}% below V15 minimum`);
    if (feeEdgeRatio < this.config.trendPortfolioMinRewardCostRatio) rejectionReasons.push(`reward/cost ${feeEdgeRatio.toFixed(2)} below V15 minimum`);
    if (expectedRewardRisk < this.config.v15MinRewardRisk) rejectionReasons.push(`expected reward/risk ${expectedRewardRisk.toFixed(2)} below V15 minimum`);
    const combination = supporting.map((output) => output.strategyId).join("+") || "NONE";
    return {
      eligible,
      side: eligible || supporting.length ? side : null,
      confidence,
      confidenceClass,
      qualityTier: eligible ? qualityTier : "REJECT",
      dominantStrategy,
      strategyOutputs,
      supportingStrategies: supporting.map((output) => output.strategyId),
      opposingStrategies: opposing.map((output) => output.strategyId),
      strategyCombination: combination,
      marketRegime: regime,
      votes: {
        long: round(votes.LONG, 4),
        short: round(votes.SHORT, 4),
        supportWeight: round(supportWeight, 4),
        opposeWeight: round(opposeWeight, 4),
        consensusBoost,
        conflictPenalty: round(conflictPenalty, 4),
      },
      expectedRewardRisk: round(expectedRewardRisk, 4),
      stopDistancePct: round(stopDistancePct, 4),
      expectedMovePct: round(expectedMovePct, 4),
      projectedNetEdgePct,
      estimatedRoundTripCostPct,
      feeEdgeRatio,
      preferredHoldingTimeSeconds: supporting.length
        ? Math.round(supporting.reduce((sum, output) => sum + numeric(output.preferredHoldingTimeSeconds), 0) / supporting.length)
        : 0,
      positionSizeMultiplier: Number(bounded(
        supporting.length
          ? supporting.reduce((sum, output) => sum + numeric(output.positionSizeMultiplier, 1), 0) / supporting.length
          : 1,
        0.6,
        1.6
      ).toFixed(3)),
      setupType: dominantStrategy ? dominantStrategy.setupType : "V15_NO_TRADE",
      continuationSetupType: dominantStrategy ? dominantStrategy.continuationSetupType : "NONE",
      dynamicExit: dominantStrategy ? dominantStrategy.dynamicExit : "none",
      rejectionReasons,
      scoreBreakdown: [
        `V15 weighted vote ${side || "NONE"} confidence ${confidence}`,
        `strategy combination ${combination}`,
        `market regime ${regime.regime}: ${regime.reason}`,
        ...strategyOutputs.flatMap((output) => output.scoreBreakdown.map((reason) => `${output.strategyId}: ${reason}`)),
      ],
      portfolioDecisionEngine: "V15_MULTI_STRATEGY_PORTFOLIO_ENGINE",
      expectedDirection: side ? directionForSide(side) : "CHOPPY",
    };
  }
}

module.exports = {
  PortfolioDecisionEngine,
  STRATEGIES,
  classifyMarketRegime,
  estimateRoundTripCostPct,
  normalizeWeights,
};
