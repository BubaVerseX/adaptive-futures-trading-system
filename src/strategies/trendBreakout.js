"use strict";

const {
  bodyForSide,
  bounded,
  breakoutForSide,
  clampScore,
  directionForSide,
  directedMomentum,
  donchianBreakout,
  multiTimeframeDirections,
  noSignal,
  numeric,
  rewardRisk,
  round,
  trendStructure,
} = require("../strategyUtils");

const STRATEGY_ID = "TREND_BREAKOUT";

function evaluateSide(side, context) {
  const { analyses, config, price } = context;
  const directions = multiTimeframeDirections(analyses);
  const expected = directionForSide(side);
  const entryBreakout = donchianBreakout(side, analyses.entryCandles, config.v15DonchianEntryLookback);
  const confirmationBreakout = donchianBreakout(side, analyses.confirmationCandles, config.v15DonchianConfirmationLookback);
  const analysisBreakout = breakoutForSide(side, analyses.entry) || breakoutForSide(side, analyses.confirmation);
  const breakout = entryBreakout.breakout || confirmationBreakout.breakout || analysisBreakout;
  const confirmationTrend = trendStructure(side, analyses.confirmation);
  const htfTrend = trendStructure(side, analyses.trend);
  const macroAligned = directions.macro === expected || directions.macroLong === expected;
  const volumeSpike = Math.max(numeric(analyses.entry.volumeSpike), numeric(analyses.confirmation.volumeSpike), numeric(analyses.trend.volumeSpike));
  const rangeExpansion = Math.max(numeric(analyses.entry.rangeExpansion), numeric(analyses.confirmation.rangeExpansion), numeric(analyses.trend.rangeExpansion));
  const atrPct = Math.max(numeric(analyses.entry.atrPct), numeric(analyses.confirmation.atrPct), numeric(analyses.trend.atrPct));
  const momentum = Math.max(directedMomentum(side, analyses.entry), directedMomentum(side, analyses.confirmation));
  const continuation = directions.confirmation === expected && directions.trend !== directions.entry ? momentum > 0 : directions.confirmation === expected;

  const scoreBreakdown = [];
  let confidence = 0;
  const add = (label, points) => {
    confidence += points;
    scoreBreakdown.push(`${label} ${points >= 0 ? "+" : ""}${round(points, 2)}`);
  };
  if (breakout) add("Donchian-style breakout channel triggered", 28);
  else add("no breakout through recent channel", -18);
  if (confirmationTrend) add("intermediate trend confirms breakout", 18);
  if (htfTrend) add("higher timeframe trend confirms breakout", 18);
  if (macroAligned) add("macro bias supports continuation", 8);
  else if (directions.macro && directions.macro !== "CHOPPY") add("macro bias not supportive", -8);
  if (volumeSpike >= config.minVolumeSpike + 0.25) add("volume expansion confirms breakout", 9);
  else if (volumeSpike >= config.minVolumeSpike * 0.85) add("early volume expansion", 4);
  else add("volume expansion too weak", -8);
  if (rangeExpansion >= config.minRangeExpansion) add("ATR/range expansion filter passed", 8);
  else add("range expansion weak", -5);
  if (atrPct >= config.v15MinAtrPct) add("ATR volatility filter passed", 6);
  else add("ATR volatility too compressed", -9);
  if (bodyForSide(side, analyses.entry, 0.45)) add("entry candle body confirms direction", 5);
  if (continuation) add("breakout continuation structure present", 7);
  if (momentum > 0) add("momentum supports breakout", bounded(momentum * 28, 1, 7));

  const stopDistancePct = Math.max(
    config.stopLossPct,
    atrPct * config.trendPortfolioStopAtrMultiplier,
    config.v15MinStopAtrMultiplier * atrPct
  );
  const expectedMovePct = Math.max(
    config.trendPortfolioMinNetEdgePct + context.estimatedRoundTripCostPct,
    atrPct * config.trendPortfolioTargetAtrMultiplier,
    rangeExpansion * atrPct * 2.2,
    Math.abs(momentum) * 2.8
  );
  const expectedRewardRisk = rewardRisk(expectedMovePct, stopDistancePct);
  if (expectedRewardRisk >= config.v15MinRewardRisk) add("breakout reward/risk acceptable", 7);
  else add("breakout reward/risk too small", -10);

  const enabled = breakout && confidence >= config.v15StrategyMinConfidence && expectedRewardRisk >= config.v15MinRewardRisk;
  return {
    strategyId: STRATEGY_ID,
    direction: enabled ? side : "NONE",
    confidence: clampScore(confidence),
    expectedRewardRisk,
    stopLocation: price * (side === "LONG" ? 1 - stopDistancePct / 100 : 1 + stopDistancePct / 100),
    stopDistancePct: round(stopDistancePct),
    expectedMovePct: round(expectedMovePct),
    preferredHoldingTimeSeconds: 12 * 60 * 60,
    positionSizeMultiplier: confidence >= 82 ? 1.35 : confidence >= 70 ? 1.18 : 1,
    setupType: "V15_TREND_BREAKOUT",
    continuationSetupType: "DONCHIAN_BREAKOUT_CONTINUATION",
    enabled,
    rejected: !enabled,
    reason: enabled ? "Donchian breakout with ATR trend confirmation" : "breakout thesis below strategy threshold",
    reasons: scoreBreakdown,
    scoreBreakdown,
    trailingStop: {
      type: "ATR",
      atrMultiplier: config.runnerAtrTrailingMultiplier,
      dynamicExit: true,
    },
    dynamicExit: "trend invalidation, ATR trail, structural breakdown",
    components: {
      entryBreakout,
      confirmationBreakout,
      analysisBreakout,
      confirmationTrend,
      htfTrend,
      macroAligned,
      volumeSpike: round(volumeSpike, 3),
      rangeExpansion: round(rangeExpansion, 3),
      atrPct: round(atrPct, 4),
      momentum: round(momentum, 4),
    },
  };
}

function evaluateTrendBreakout(context) {
  const sides = context.onlySide ? [context.onlySide] : ["LONG", "SHORT"];
  const candidates = sides.map((side) => evaluateSide(side, context)).sort((left, right) => right.confidence - left.confidence);
  return candidates[0] || noSignal(STRATEGY_ID, "no side evaluated");
}

module.exports = { STRATEGY_ID, evaluateTrendBreakout };
