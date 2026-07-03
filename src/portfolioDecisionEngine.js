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
  const extreme =
    atrPct >= numeric(config.abnormalVolatilityAtrPct, 1.6) ||
    tags.has("PANIC") ||
    tags.has("NEWS_LIKE_ABNORMAL") ||
    tags.has("EXCHANGE_DISLOCATION");
  const choppy = tags.has("SIDEWAYS_CHOP_MARKET") || tags.has("FAKE_BREAKOUT_ENVIRONMENT") || marketProfile.direction === "CHOPPY";
  if (extreme) {
    return {
      regime: "EXTREME_CONDITIONS",
      sizeMultiplier: numeric(config.v16ExtremeRegimeSizeMultiplier, 0),
      tradable: false,
      reason: "extreme volatility or exchange-dislocation conditions reject new portfolio risk",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  if (alignedTrend || tags.has("STRONG_TRENDING_MARKET")) {
    return {
      regime: "TREND",
      sizeMultiplier: numeric(config.v16TrendRegimeSizeMultiplier, 1),
      tradable: true,
      reason: "trend alignment supports full portfolio participation",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  if (breakoutLike && rangeExpansion >= numeric(config.minRangeExpansion, 1.1) && volumeSpike >= numeric(config.minVolumeSpike, 1.1) * 0.85) {
    return {
      regime: "RANGE",
      sizeMultiplier: numeric(config.v16RangeRegimeSizeMultiplier, 0.7),
      tradable: true,
      reason: "breakout/range expansion can trade with reduced allocation",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  if (atrPct <= numeric(config.regimeDeadMarketAtrPct, 0.12) || tags.has("DEAD_MARKET_CONDITIONS")) {
    return {
      regime: "LOW_VOLATILITY",
      sizeMultiplier: numeric(config.v16LowVolatilityRegimeSizeMultiplier, 0.5),
      tradable: true,
      reason: "low volatility reduces allocation instead of rejecting by default",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  if (choppy) {
    return {
      regime: "CHOPPY",
      sizeMultiplier: numeric(config.v16ChoppyRegimeSizeMultiplier, 0.5),
      tradable: true,
      reason: "choppy market halves allocation but still allows strong weighted confidence",
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 3),
      volumeSpike: round(volumeSpike, 3),
      directions,
    };
  }
  return {
    regime: "RANGE",
    sizeMultiplier: numeric(config.v16RangeRegimeSizeMultiplier, 0.7),
    tradable: true,
    reason: "range regime reduces allocation while preserving qualifying trend participation",
    atrPct: round(atrPct, 4),
    rangeExpansion: round(rangeExpansion, 3),
    volumeSpike: round(volumeSpike, 3),
    directions,
  };
}

function capitalTargetForConfidence(config, confidence, regime) {
  let base = 0;
  if (confidence >= 76) base = 45;
  else if (confidence >= 66) base = 36;
  else if (confidence >= 56) base = 28;
  else if (confidence >= numeric(config.v16PortfolioMinConfidence, 46)) base = 20;
  const regimeAdjusted = base * numeric(regime.sizeMultiplier, 1);
  const budget = numeric(config.maxDeployableCapitalUsdt, regimeAdjusted);
  return Number(Math.max(0, Math.min(regimeAdjusted, budget || regimeAdjusted)).toFixed(4));
}

function sideContribution(outputs, side, weights) {
  let confidence = 0;
  let rewardRiskNumerator = 0;
  let stopNumerator = 0;
  let moveNumerator = 0;
  let holdingNumerator = 0;
  let sizeMultiplierNumerator = 0;
  let contributionWeight = 0;
  const selected = [];
  for (const output of outputs) {
    const weight = numeric(weights[output.strategyId], 0);
    const sideConfidence = numeric(output.sideEvaluations[side] && output.sideEvaluations[side].confidence);
    confidence += sideConfidence * weight;
    contributionWeight += weight;
    const sideOutput = output.sideEvaluations[side];
    if (sideOutput) {
      rewardRiskNumerator += numeric(sideOutput.expectedRewardRisk) * sideConfidence * weight;
      stopNumerator += numeric(sideOutput.stopDistancePct) * sideConfidence * weight;
      moveNumerator += numeric(sideOutput.expectedMovePct) * sideConfidence * weight;
      holdingNumerator += numeric(sideOutput.preferredHoldingTimeSeconds) * sideConfidence * weight;
      sizeMultiplierNumerator += numeric(sideOutput.positionSizeMultiplier, 1) * sideConfidence * weight;
      selected.push(sideOutput);
    }
  }
  const denominator = Math.max(confidence, 0.000001);
  return {
    confidence: round(confidence, 4),
    contributionWeight,
    expectedRewardRisk: rewardRiskNumerator / denominator,
    stopDistancePct: stopNumerator / denominator,
    expectedMovePct: moveNumerator / denominator,
    preferredHoldingTimeSeconds: holdingNumerator / denominator,
    positionSizeMultiplier: sizeMultiplierNumerator / denominator,
    selected,
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
    const baseContext = {
      ...context,
      config: this.config,
      estimatedRoundTripCostPct,
      marketRegime: regime,
    };
    const strategyOutputs = STRATEGIES.map((strategy) => {
      const sideEvaluations = {};
      for (const side of ["LONG", "SHORT"]) {
        const sideOutput = strategy.evaluate({ ...baseContext, onlySide: side });
        sideEvaluations[side] = {
          ...sideOutput,
          evaluatedSide: side,
          direction: side,
          rawDirection: sideOutput.direction,
          rawConfidence: numeric(sideOutput.confidence),
          confidence: clampScore(sideOutput.confidence),
          portfolioWeight: round(weights[strategy.id], 4),
          marketRegimeSizeMultiplier: numeric(regime.sizeMultiplier, 1),
        };
      }
      const selectedSide = sideEvaluations.LONG.confidence >= sideEvaluations.SHORT.confidence ? "LONG" : "SHORT";
      return {
        strategyId: strategy.id,
        weight: round(weights[strategy.id], 4),
        direction: selectedSide,
        confidence: sideEvaluations[selectedSide].confidence,
        sideEvaluations,
        scoreBreakdown: [
          `${strategy.id} LONG ${sideEvaluations.LONG.confidence}`,
          `${strategy.id} SHORT ${sideEvaluations.SHORT.confidence}`,
        ],
      };
    });
    const longContribution = sideContribution(strategyOutputs, "LONG", weights);
    const shortContribution = sideContribution(strategyOutputs, "SHORT", weights);
    const side = longContribution.confidence >= shortContribution.confidence ? "LONG" : "SHORT";
    const opposite = side === "LONG" ? "SHORT" : "LONG";
    const selectedContribution = side === "LONG" ? longContribution : shortContribution;
    const oppositeContribution = side === "LONG" ? shortContribution : longContribution;
    const confidence = clampScore(Math.max(0, selectedContribution.confidence - Math.max(0, oppositeContribution.confidence - selectedContribution.confidence) * 0.18));
    const sideOutputs = selectedContribution.selected;
    const supporting = sideOutputs.filter((output) => output.confidence >= numeric(this.config.v15StrategyMinConfidence, 52) * 0.72);
    const opposing = oppositeContribution.selected.filter((output) => output.confidence >= selectedContribution.confidence / STRATEGIES.length);
    const dominantStrategy = sideOutputs.slice().sort((left, right) => right.confidence - left.confidence)[0] || null;
    const expectedRewardRisk = selectedContribution.expectedRewardRisk || 0;
    const stopDistancePct = selectedContribution.stopDistancePct || Math.max(numeric(this.config.stopLossPct), numeric(regime.atrPct) * numeric(this.config.trendPortfolioStopAtrMultiplier));
    const expectedMovePct = selectedContribution.expectedMovePct || stopDistancePct * this.config.v15MinRewardRisk;
    const projectedNetEdgePct = Number((expectedMovePct - estimatedRoundTripCostPct).toFixed(4));
    const feeEdgeRatio = estimatedRoundTripCostPct > 0 ? Number((expectedMovePct / estimatedRoundTripCostPct).toFixed(4)) : 999;
    const requiredConfidence = numeric(this.config.v16PortfolioMinConfidence, numeric(this.config.trendPortfolioMinScore, 46));
    const eligible =
      regime.tradable &&
      confidence >= requiredConfidence &&
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
    if (!regime.tradable) rejectionReasons.push(`market regime ${regime.regime} rejects new entries`);
    if (confidence < requiredConfidence) rejectionReasons.push(`portfolio confidence ${confidence} below ${requiredConfidence}`);
    if (projectedNetEdgePct < this.config.trendPortfolioMinNetEdgePct) rejectionReasons.push(`projected net edge ${projectedNetEdgePct}% below V15 minimum`);
    if (feeEdgeRatio < this.config.trendPortfolioMinRewardCostRatio) rejectionReasons.push(`reward/cost ${feeEdgeRatio.toFixed(2)} below V15 minimum`);
    if (expectedRewardRisk < this.config.v15MinRewardRisk) rejectionReasons.push(`expected reward/risk ${expectedRewardRisk.toFixed(2)} below V15 minimum`);
    const combination = supporting.map((output) => output.strategyId).join("+") || (dominantStrategy && dominantStrategy.strategyId) || "NONE";
    const capitalTargetUsdt = capitalTargetForConfidence(this.config, confidence, regime);
    const decision = {
      eligible,
      side: side || null,
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
        long: round(longContribution.confidence, 4),
        short: round(shortContribution.confidence, 4),
        supportWeight: round(selectedContribution.confidence, 4),
        opposeWeight: round(oppositeContribution.confidence, 4),
        disagreementPenalty: round(Math.max(0, oppositeContribution.confidence - selectedContribution.confidence) * 0.18, 4),
      },
      expectedRewardRisk: round(expectedRewardRisk, 4),
      stopDistancePct: round(stopDistancePct, 4),
      expectedMovePct: round(expectedMovePct, 4),
      projectedNetEdgePct,
      estimatedRoundTripCostPct,
      feeEdgeRatio,
      preferredHoldingTimeSeconds: Math.round(selectedContribution.preferredHoldingTimeSeconds || 0),
      positionSizeMultiplier: Number(bounded(
        numeric(selectedContribution.positionSizeMultiplier, 1) * numeric(regime.sizeMultiplier, 1),
        0.6,
        1.6
      ).toFixed(3)),
      capitalTargetUsdt,
      regimeSizeMultiplier: numeric(regime.sizeMultiplier, 1),
      setupType: dominantStrategy ? dominantStrategy.setupType : "V15_NO_TRADE",
      continuationSetupType: dominantStrategy ? dominantStrategy.continuationSetupType : "NONE",
      dynamicExit: dominantStrategy ? dominantStrategy.dynamicExit : "none",
      rejectionReasons,
      scoreBreakdown: [
        `V16 weighted confidence ${side || "NONE"} ${confidence}`,
        `strategy combination ${combination}`,
        `market regime ${regime.regime} size multiplier ${regime.sizeMultiplier}: ${regime.reason}`,
        ...strategyOutputs.flatMap((output) => [
          `${output.strategyId}: LONG ${output.sideEvaluations.LONG.confidence}`,
          `${output.strategyId}: SHORT ${output.sideEvaluations.SHORT.confidence}`,
        ]),
      ],
      portfolioDecisionEngine: "V16_WEIGHTED_PORTFOLIO_DECISION_ENGINE",
      expectedDirection: side ? directionForSide(side) : "CHOPPY",
    };
    this.log("INFO", "V16_PORTFOLIO_DECISION", {
      symbol: context.symbol,
      portfolioConfidence: confidence,
      trend: strategyOutputs.find((output) => output.strategyId === "MULTI_TIMEFRAME_TREND").sideEvaluations[side].confidence,
      breakout: strategyOutputs.find((output) => output.strategyId === "TREND_BREAKOUT").sideEvaluations[side].confidence,
      pullback: strategyOutputs.find((output) => output.strategyId === "TREND_PULLBACK").sideEvaluations[side].confidence,
      marketRegime: regime.regime,
      marketRegimeSizeMultiplier: regime.sizeMultiplier,
      expectedRewardRisk: round(expectedRewardRisk, 4),
      positionSizeUsdt: capitalTargetUsdt,
      decision: eligible ? `ENTER ${side}` : "SKIP",
      reasons: rejectionReasons,
    });
    return decision;
  }
}

module.exports = {
  PortfolioDecisionEngine,
  STRATEGIES,
  classifyMarketRegime,
  estimateRoundTripCostPct,
  normalizeWeights,
};
