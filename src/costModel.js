"use strict";

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function edgeTier(signal = {}) {
  const scannerTier = String(
    signal.tradeQualityTier ||
      signal.scannerQualityTier ||
      signal.qualityTier ||
      (signal.tradeQualification && signal.tradeQualification.tier) ||
      ""
  ).toUpperCase();
  if (scannerTier === "ELITE") return "ELITE_CONTINUATION";
  if (scannerTier === "STRONG") return "STRONG_CONTINUATION";
  if (scannerTier === "EXPLORATION") return "EXPLORATION_POSITIVE_EDGE";
  if (scannerTier === "NORMAL") return "NORMAL_CONTINUATION";
  if (signal.eliteSetup || signal.tradeCategory === "ELITE_SETUP" || signal.convictionTier === "TIER_3_ELITE_SETUP") return "ELITE_CONTINUATION";
  if (signal.eliteContinuationCandidate || signal.convictionTier === "TIER_2_STRONG_SETUP") return "STRONG_CONTINUATION";
  if (signal.explorationTrade || signal.tradeCategory === "EXPLORATION") return "EXPLORATION_POSITIVE_EDGE";
  if (signal.highActivityContinuation || /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/.test(String(signal.continuationSetupType || signal.setupType || ""))) {
    return "NORMAL_CONTINUATION";
  }
  return "NORMAL_CONTINUATION";
}

function calculateCostModel(config, signal = {}, plan = null, equityUsdt = 0) {
  const expectedGrossMovePct = Math.max(
    numeric(signal.expectedMovePct),
    numeric(signal.takeProfitDistancePct),
    numeric(config.minExpectedMovePct)
  );
  const entryIsMaker = /POST_ONLY|MAKER/i.test(String(signal.executionType || signal.intendedExecutionType || ""));
  const defaultEntryFeePct = entryIsMaker
    ? numeric(config.estimatedMakerFeePctPerSide, numeric(config.estimatedFeePctPerSide))
    : numeric(config.estimatedTakerFeePctPerSide, numeric(config.estimatedFeePctPerSide));
  const estimatedEntryFeePct = numeric(signal.estimatedEntryFeePct, defaultEntryFeePct);
  const estimatedExitFeePct = numeric(signal.estimatedExitFeePct, numeric(config.estimatedTakerFeePctPerSide, numeric(config.estimatedFeePctPerSide)));
  const estimatedFundingPct = numeric(signal.estimatedFundingPct, numeric(config.estimatedFundingPct));
  const liveSpreadPct = numeric(signal.spreadPct);
  const conservativeSlippagePct = Math.max(
    numeric(signal.estimatedSlippagePct),
    numeric(config.estimatedSlippagePct)
  ) * (signal.explorationTrade ? 1.1 : 1);
  const expectedTotalCostPct =
    estimatedEntryFeePct +
    estimatedExitFeePct +
    Math.max(0, estimatedFundingPct) +
    liveSpreadPct +
    conservativeSlippagePct;
  const tpProbability = bounded(numeric(signal.estimatedTpProbability, numeric(config.smartEdgeMinTpProbability)), 0.05, 0.95);
  const volatilityContinuationBoost = bounded((numeric(signal.continuationStrength) - numeric(config.continuationMinStrength)) / 200, 0, 0.14);
  const probabilityAdjustedMovePct = expectedGrossMovePct * bounded(tpProbability + volatilityContinuationBoost, 0.05, 0.95);
  const expectedNetEdgePct = probabilityAdjustedMovePct - expectedTotalCostPct * numeric(config.smartEdgeCostBufferMultiplier, 1.25);
  const stopDistancePct = numeric(signal.stopDistancePct, numeric(config.stopLossPct));
  const takeProfitDistancePct = numeric(signal.takeProfitDistancePct, numeric(config.takeProfitPct));
  const expectedRewardRiskRatio = stopDistancePct > 0 ? takeProfitDistancePct / stopDistancePct : 0;
  const expectedRewardCostRatio = expectedTotalCostPct > 0 ? expectedGrossMovePct / expectedTotalCostPct : 999;
  const notional = plan ? numeric(plan.notional) : numeric(signal.previewNotionalUsdt);
  const projectedGrossProfitUsdt = notional * (expectedGrossMovePct / 100);
  const projectedTotalCostUsdt = notional * (expectedTotalCostPct / 100);
  const projectedNetProfitUsdt = notional ? notional * (expectedNetEdgePct / 100) : 0;
  const projectedMaxLossAtStopUsdt = plan
    ? numeric(plan.maxLossAtStopUsdt, notional * (stopDistancePct / 100))
    : notional * (stopDistancePct / 100);
  const riskPctOfEquity = equityUsdt > 0 ? (projectedMaxLossAtStopUsdt / equityUsdt) * 100 : 0;
  return {
    tier: edgeTier(signal),
    expectedGrossMovePct: Number(expectedGrossMovePct.toFixed(4)),
    estimatedEntryFeePct: Number(estimatedEntryFeePct.toFixed(4)),
    estimatedExitFeePct: Number(estimatedExitFeePct.toFixed(4)),
    estimatedFundingPct: Number(estimatedFundingPct.toFixed(4)),
    liveSpreadPct: Number(liveSpreadPct.toFixed(4)),
    conservativeSlippagePct: Number(conservativeSlippagePct.toFixed(4)),
    expectedTotalCostPct: Number(expectedTotalCostPct.toFixed(4)),
    probabilityAdjustedMovePct: Number(probabilityAdjustedMovePct.toFixed(4)),
    expectedNetEdgePct: Number(expectedNetEdgePct.toFixed(4)),
    stopDistancePct: Number(stopDistancePct.toFixed(4)),
    takeProfitDistancePct: Number(takeProfitDistancePct.toFixed(4)),
    expectedRewardRiskRatio: Number(expectedRewardRiskRatio.toFixed(4)),
    expectedRewardCostRatio: Number(expectedRewardCostRatio.toFixed(4)),
    projectedGrossProfitUsdt: Number(projectedGrossProfitUsdt.toFixed(6)),
    projectedTotalCostUsdt: Number(projectedTotalCostUsdt.toFixed(6)),
    projectedNetProfitUsdt: Number(projectedNetProfitUsdt.toFixed(6)),
    projectedMaxLossAtStopUsdt: Number(projectedMaxLossAtStopUsdt.toFixed(6)),
    riskPctOfEquity: Number(riskPctOfEquity.toFixed(4)),
  };
}

function edgeRequirements(config, tier, signal = {}) {
  const qualityPacingMultiplier = signal.qualityPacingActive ? numeric(config.qualityPacingEdgeMultiplier, 1.25) : 1;
  const table = {
    EXPLORATION_POSITIVE_EDGE: {
      minNetEdgePct: numeric(config.edgeExplorationMinNetPct),
      minRewardCostRatio: numeric(config.edgeExplorationMinRewardCostRatio),
      minRewardRiskRatio: numeric(config.edgeExplorationMinRewardRiskRatio),
    },
    NORMAL_CONTINUATION: {
      minNetEdgePct: numeric(config.edgeNormalMinNetPct),
      minRewardCostRatio: numeric(config.edgeNormalMinRewardCostRatio),
      minRewardRiskRatio: numeric(config.edgeNormalMinRewardRiskRatio),
    },
    STRONG_CONTINUATION: {
      minNetEdgePct: numeric(config.edgeStrongMinNetPct),
      minRewardCostRatio: numeric(config.edgeStrongMinRewardCostRatio),
      minRewardRiskRatio: numeric(config.edgeStrongMinRewardRiskRatio),
    },
    ELITE_CONTINUATION: {
      minNetEdgePct: numeric(config.edgeEliteMinNetPct),
      minRewardCostRatio: numeric(config.edgeEliteMinRewardCostRatio),
      minRewardRiskRatio: numeric(config.edgeEliteMinRewardRiskRatio),
    },
  };
  const requirements = table[tier] || table.NORMAL_CONTINUATION;
  return {
    minNetEdgePct: Number((requirements.minNetEdgePct * qualityPacingMultiplier).toFixed(4)),
    minRewardCostRatio: Number((requirements.minRewardCostRatio * qualityPacingMultiplier).toFixed(4)),
    minRewardRiskRatio: Number(requirements.minRewardRiskRatio.toFixed(4)),
  };
}

function edgeGate(config, signal = {}, plan = null, equityUsdt = 0) {
  const model = calculateCostModel(config, signal, plan, equityUsdt);
  const requirements = edgeRequirements(config, model.tier, signal);
  const reasons = [];
  if (model.expectedNetEdgePct < requirements.minNetEdgePct) {
    reasons.push(`expected net edge ${model.expectedNetEdgePct}% below ${requirements.minNetEdgePct}%`);
  }
  if (model.expectedRewardCostRatio < requirements.minRewardCostRatio) {
    reasons.push(`reward/cost ${model.expectedRewardCostRatio} below ${requirements.minRewardCostRatio}`);
  }
  if (model.expectedRewardRiskRatio < requirements.minRewardRiskRatio) {
    reasons.push(`reward/risk ${model.expectedRewardRiskRatio} below ${requirements.minRewardRiskRatio}`);
  }
  if (model.projectedNetProfitUsdt < 0 && plan) {
    reasons.push(`projected net profit ${model.projectedNetProfitUsdt} USDT is negative`);
  }
  return {
    approved: reasons.length === 0,
    rejected: reasons.length > 0,
    reason: reasons.join("; "),
    requirements,
    model,
  };
}

module.exports = {
  calculateCostModel,
  edgeGate,
  edgeTier,
};
