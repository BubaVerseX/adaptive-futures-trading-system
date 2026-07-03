"use strict";

const {
  alignmentScore,
  bodyForSide,
  bounded,
  clampScore,
  directionForSide,
  directedMomentum,
  multiTimeframeDirections,
  noSignal,
  numeric,
  priceAboveStructure,
  rewardRisk,
  round,
  sideForDirection,
  trendStructure,
} = require("../strategyUtils");

const STRATEGY_ID = "MULTI_TIMEFRAME_TREND";

function dominantSide(directions) {
  const votes = [directions.confirmation, directions.trend, directions.macro, directions.macroLong].filter((direction) => direction !== "CHOPPY");
  const up = votes.filter((direction) => direction === "UP").length;
  const down = votes.filter((direction) => direction === "DOWN").length;
  if (up >= 2 && up > down) return "LONG";
  if (down >= 2 && down > up) return "SHORT";
  return null;
}

function evaluateSide(side, context) {
  const { analyses, config, price } = context;
  const directions = multiTimeframeDirections(analyses);
  const expected = directionForSide(side);
  const dominant = dominantSide(directions);
  const alignment = alignmentScore(side, directions);
  const trend = trendStructure(side, analyses.trend);
  const confirmation = trendStructure(side, analyses.confirmation);
  const macro = trendStructure(side, analyses.macro);
  const entryTiming = directions.entry === expected || (bodyForSide(side, analyses.entry, 0.38) && directedMomentum(side, analyses.entry) > -0.02);
  const priceStructure = priceAboveStructure(side, analyses.confirmation) && priceAboveStructure(side, analyses.trend);
  const momentum = Math.max(directedMomentum(side, analyses.entry), directedMomentum(side, analyses.confirmation), directedMomentum(side, analyses.trend));
  const volumeSpike = Math.max(numeric(analyses.entry.volumeSpike), numeric(analyses.confirmation.volumeSpike));
  const atrPct = Math.max(numeric(analyses.confirmation.atrPct), numeric(analyses.trend.atrPct));
  const rangeExpansion = Math.max(numeric(analyses.entry.rangeExpansion), numeric(analyses.confirmation.rangeExpansion));

  const scoreBreakdown = [];
  let confidence = alignment.score * 0.46;
  scoreBreakdown.push(`multi-timeframe alignment ${round(alignment.score, 2)} -> +${round(alignment.score * 0.46, 2)}`);
  const add = (label, points) => {
    confidence += points;
    scoreBreakdown.push(`${label} ${points >= 0 ? "+" : ""}${round(points, 2)}`);
  };
  if (dominant === side) add("dominant HTF direction agrees", 16);
  else if (dominant) add("dominant HTF direction opposes", -24);
  if (trend) add("higher timeframe moving-average structure healthy", 14);
  if (confirmation) add("intermediate timeframe confirmation healthy", 10);
  if (macro) add("macro moving-average structure aligned", 7);
  if (entryTiming) add("lower timeframe entry timing agrees", 6);
  else add("lower timeframe entry trigger not ready", -7);
  if (priceStructure) add("price remains on trend side of structure", 7);
  if (momentum > 0) add("momentum confirmation supports trend", bounded(momentum * 32, 2, 9));
  else add("momentum confirmation absent", -8);
  if (volumeSpike >= config.minVolumeSpike) add("volume confirms trend", 5);
  if (rangeExpansion >= config.minRangeExpansion * 0.9) add("volatility filter passed", 4);
  if (alignment.trendMacroOpposite) add("15m/1h style trend and macro opposition", -22);

  const stopDistancePct = Math.max(config.stopLossPct, atrPct * config.trendPortfolioStopAtrMultiplier);
  const expectedMovePct = Math.max(
    atrPct * config.trendPortfolioTargetAtrMultiplier * 0.92,
    Math.abs(momentum) * 3.4,
    context.estimatedRoundTripCostPct + config.trendPortfolioMinNetEdgePct
  );
  const expectedRewardRisk = rewardRisk(expectedMovePct, stopDistancePct);
  if (expectedRewardRisk >= config.v15MinRewardRisk) add("trend reward/risk acceptable", 5);
  else add("trend reward/risk too small", -8);

  const enabled =
    confidence >= config.v15StrategyMinConfidence &&
    expectedRewardRisk >= config.v15MinRewardRisk &&
    dominant === side &&
    !alignment.trendMacroOpposite &&
    (trend || confirmation) &&
    entryTiming;
  return {
    strategyId: STRATEGY_ID,
    direction: enabled ? side : "NONE",
    confidence: clampScore(confidence),
    expectedRewardRisk,
    stopLocation: price * (side === "LONG" ? 1 - stopDistancePct / 100 : 1 + stopDistancePct / 100),
    stopDistancePct: round(stopDistancePct),
    expectedMovePct: round(expectedMovePct),
    preferredHoldingTimeSeconds: 18 * 60 * 60,
    positionSizeMultiplier: confidence >= 86 ? 1.4 : confidence >= 74 ? 1.2 : 1,
    setupType: "V15_MULTI_TIMEFRAME_TREND",
    continuationSetupType: "HTF_TREND_CONTINUATION",
    enabled,
    rejected: !enabled,
    reason: enabled ? "dominant multi-timeframe trend continuation" : "multi-timeframe trend not dominant enough",
    reasons: scoreBreakdown,
    scoreBreakdown,
    trailingStop: {
      type: "ATR_STRUCTURE",
      atrMultiplier: config.runnerAtrTrailingMultiplier * 1.08,
      dynamicExit: true,
    },
    dynamicExit: "trend deterioration, ATR trail, macro opposition",
    components: {
      directions,
      alignment,
      dominant,
      trend,
      confirmation,
      macro,
      entryTiming,
      priceStructure,
      momentum: round(momentum, 4),
      volumeSpike: round(volumeSpike, 3),
      atrPct: round(atrPct, 4),
    },
  };
}

function evaluateMultiTimeframeTrend(context) {
  const directions = multiTimeframeDirections(context.analyses);
  const preferred = dominantSide(directions);
  const sides = context.onlySide ? [context.onlySide] : preferred ? [preferred, preferred === "LONG" ? "SHORT" : "LONG"] : ["LONG", "SHORT"];
  const candidates = sides.map((side) => evaluateSide(side, context)).sort((left, right) => right.confidence - left.confidence);
  return candidates[0] || noSignal(STRATEGY_ID, "no multi-timeframe side evaluated");
}

module.exports = { STRATEGY_ID, evaluateMultiTimeframeTrend };
