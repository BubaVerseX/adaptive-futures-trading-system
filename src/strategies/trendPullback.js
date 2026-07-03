"use strict";

const {
  bodyForSide,
  bounded,
  clampScore,
  controlledPullback,
  directionForSide,
  directedLastMomentum,
  directedMomentum,
  multiTimeframeDirections,
  noSignal,
  numeric,
  priceAboveStructure,
  rewardRisk,
  round,
  trendStructure,
} = require("../strategyUtils");

const STRATEGY_ID = "TREND_PULLBACK";

function evaluateSide(side, context) {
  const { analyses, config, price } = context;
  const directions = multiTimeframeDirections(analyses);
  const expected = directionForSide(side);
  const trend = trendStructure(side, analyses.trend);
  const confirmation = trendStructure(side, analyses.confirmation);
  const macroSupport = directions.macro === expected || directions.macro === "CHOPPY";
  const pullback = controlledPullback(side, analyses.entryCandles, analyses.entry, config.v15PullbackLookback);
  const confirmationPullback = controlledPullback(side, analyses.confirmationCandles, analyses.confirmation, Math.max(6, Math.floor(config.v15PullbackLookback / 2)));
  const resumed = pullback.resumed || bodyForSide(side, analyses.entry, 0.38) || directedLastMomentum(side, analyses.entry) > 0;
  const priceStructure = priceAboveStructure(side, analyses.entry) || priceAboveStructure(side, analyses.confirmation);
  const momentumResumption = directedMomentum(side, analyses.entry) > -0.03 && directedMomentum(side, analyses.confirmation) >= 0;
  const volumeSpike = Math.max(numeric(analyses.entry.volumeSpike), numeric(analyses.confirmation.volumeSpike));
  const atrPct = Math.max(numeric(analyses.entry.atrPct), numeric(analyses.confirmation.atrPct));
  const reversalDanger =
    directions.trend !== expected ||
    directions.macro === (side === "LONG" ? "DOWN" : "UP") ||
    !priceStructure ||
    (!pullback.notBroken && !confirmationPullback.notBroken);

  const scoreBreakdown = [];
  let confidence = 0;
  const add = (label, points) => {
    confidence += points;
    scoreBreakdown.push(`${label} ${points >= 0 ? "+" : ""}${round(points, 2)}`);
  };
  if (trend) add("established higher timeframe trend required", 24);
  else add("higher timeframe trend not established", -24);
  if (confirmation) add("intermediate trend remains intact", 16);
  if (macroSupport) add("macro does not oppose pullback continuation", 7);
  else add("macro opposes pullback continuation", -12);
  if (pullback.controlled || confirmationPullback.controlled) add("controlled pullback detected", 18);
  else add("pullback not controlled", -12);
  if (resumed) add("trend resumption trigger fired", 14);
  else add("trend resumption not confirmed", -10);
  if (priceStructure) add("pullback held moving-average structure", 8);
  if (momentumResumption) add("momentum resumed without reversal catch", 7);
  if (volumeSpike >= config.minVolumeSpike * 0.85) add("enough volume for continuation", 5);
  if (reversalDanger) add("reversal-catching danger penalty", -18);

  const stopDistancePct = Math.max(config.stopLossPct, atrPct * config.trendPortfolioStopAtrMultiplier * 0.92);
  const expectedMovePct = Math.max(
    atrPct * config.trendPortfolioTargetAtrMultiplier * 0.78,
    Math.abs(directedMomentum(side, analyses.confirmation)) * 3.2,
    context.estimatedRoundTripCostPct + config.trendPortfolioMinNetEdgePct
  );
  const expectedRewardRisk = rewardRisk(expectedMovePct, stopDistancePct);
  if (expectedRewardRisk >= config.v15MinRewardRisk) add("pullback reward/risk acceptable", 5);
  else add("pullback reward/risk too small", -8);

  const enabled =
    confidence >= config.v15StrategyMinConfidence &&
    expectedRewardRisk >= config.v15MinRewardRisk &&
    trend &&
    (pullback.controlled || confirmationPullback.controlled) &&
    resumed &&
    !reversalDanger;
  return {
    strategyId: STRATEGY_ID,
    direction: enabled ? side : "NONE",
    confidence: clampScore(confidence),
    expectedRewardRisk,
    stopLocation: price * (side === "LONG" ? 1 - stopDistancePct / 100 : 1 + stopDistancePct / 100),
    stopDistancePct: round(stopDistancePct),
    expectedMovePct: round(expectedMovePct),
    preferredHoldingTimeSeconds: 10 * 60 * 60,
    positionSizeMultiplier: confidence >= 82 ? 1.25 : confidence >= 70 ? 1.12 : 0.95,
    setupType: "V15_TREND_PULLBACK",
    continuationSetupType: "PULLBACK_CONTINUATION",
    enabled,
    rejected: !enabled,
    reason: enabled ? "controlled pullback resumed in established trend" : "pullback continuation thesis incomplete",
    reasons: scoreBreakdown,
    scoreBreakdown,
    trailingStop: {
      type: "ATR_PULLBACK",
      atrMultiplier: config.runnerAtrTrailingMultiplier,
      dynamicExit: true,
    },
    dynamicExit: "resumption failure, ATR stop, trend invalidation",
    components: {
      directions,
      trend,
      confirmation,
      macroSupport,
      pullback,
      confirmationPullback,
      resumed,
      priceStructure,
      momentumResumption,
      volumeSpike: round(volumeSpike, 3),
      atrPct: round(atrPct, 4),
      reversalDanger,
    },
  };
}

function evaluateTrendPullback(context) {
  const sides = context.onlySide ? [context.onlySide] : ["LONG", "SHORT"];
  const candidates = sides.map((side) => evaluateSide(side, context)).sort((left, right) => right.confidence - left.confidence);
  return candidates[0] || noSignal(STRATEGY_ID, "no pullback side evaluated");
}

module.exports = { STRATEGY_ID, evaluateTrendPullback };
