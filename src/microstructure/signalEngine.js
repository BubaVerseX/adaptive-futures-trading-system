"use strict";

const fs = require("node:fs");

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 8) {
  return Number(numeric(value).toFixed(places));
}

function clip(value, min, max) {
  return Math.max(min, Math.min(max, numeric(value)));
}

function pctToBps(value) {
  return numeric(value) * 100;
}

function decimalToBps(value) {
  return numeric(value) * 10000;
}

function bpsToPct(value) {
  return numeric(value) / 100;
}

function sanitizeFeatureValue(key, value, config = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return { valid: false, value: 0, reason: `${key}:NON_FINITE`, key, rawValue: value };
  const maxAbs = numeric(config.microMaxFeatureAbsValue, 10000);
  const normalizedCaps = {
    l1OrderBookImbalance: 1,
    tradeImbalance: 1,
    tradeImbalance_1s: 1,
    tradeImbalance_3s: 1,
    tradeImbalance_5s: 1,
    tradeImbalance_10s: 1,
    tradeImbalance_30s: 1,
    tradeImbalance_60s: 1,
    volumeConcentration: 1,
    relativeSpread: 0.2,
    micropriceDeviationFromMid: 0.05,
    vwapBuyToMidDeviation: 0.05,
    vwapSellToMidDeviation: 0.05,
    shortRealizedVolatility: 0.05,
  };
  const isWindowedNormalized = /^(tradeImbalance|vwapBuyToMidDeviation|vwapSellToMidDeviation|shortRealizedVolatility|volumeConcentration)_\d+s$/.test(key);
  const rawMarketValue = (
    /(?:Price|Size|Volume|Trades|Variance|Spread|Flow)$/i.test(key) ||
    /(?:Price|Size|Volume|Trades|Variance|Spread|Flow)_\d+s$/i.test(key)
  ) && key !== "relativeSpread";
  const cap = Object.prototype.hasOwnProperty.call(normalizedCaps, key)
    ? normalizedCaps[key]
    : isWindowedNormalized
      ? normalizedCaps[key.replace(/_\d+s$/, "")]
      : rawMarketValue
        ? numeric(config.microMaxRawFeatureAbsValue, 1e12)
        : maxAbs;
  if (Math.abs(parsed) > cap) {
    return {
      valid: false,
      value: Math.sign(parsed) * cap,
      reason: `${key}:ABSURD_VALUE`,
      key,
      rawValue: parsed,
      cap,
    };
  }
  return { valid: true, value: clip(parsed, -cap, cap), reason: null };
}

function sanitizeMicroFeatures(features = {}, config = {}) {
  const sanitized = {};
  const warnings = [];
  const details = [];
  for (const [key, value] of Object.entries(features || {})) {
    if (/zscore/i.test(key)) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        warnings.push(`${key}:NON_FINITE`);
        details.push({ feature: key, value, reason: "NON_FINITE" });
        sanitized[key] = 0;
      } else {
        sanitized[key] = clip(parsed, -numeric(config.microMaxZScoreAbs, 8), numeric(config.microMaxZScoreAbs, 8));
        if (sanitized[key] !== parsed) {
          warnings.push(`${key}:CLIPPED`);
          details.push({ feature: key, value: parsed, clippedTo: sanitized[key], reason: "CLIPPED" });
        }
      }
      continue;
    }
    const result = sanitizeFeatureValue(key, value, config);
    sanitized[key] = result.value;
    if (!result.valid) {
      warnings.push(result.reason);
      details.push({
        feature: result.key || key,
        value: result.rawValue ?? value,
        cap: result.cap,
        reason: result.reason,
      });
    }
  }
  return {
    features: sanitized,
    valid: warnings.length === 0,
    warnings,
    details,
  };
}

function heuristicMicroPredictionBps(features = {}, config = {}) {
  const sanitized = sanitizeMicroFeatures(features, config).features;
  const imbalance = numeric(sanitized.l1OrderBookImbalance);
  const micropriceBps = decimalToBps(sanitized.micropriceDeviationFromMid);
  const flow = numeric(sanitized.tradeImbalance_3s, numeric(sanitized.tradeImbalance));
  const pressure = clip(numeric(sanitized.orderFlowPressureScore), -100, 100) / 100;
  const spreadPenaltyBps = Math.max(0, numeric(sanitized.spreadZScore)) * 0.25;
  return round(
    clip(
      imbalance * 1.2 +
      micropriceBps * 0.45 +
      flow * 0.9 +
      pressure * 0.8 -
      spreadPenaltyBps,
      -50,
      50
    ),
    6
  );
}

function heuristicMicroPredictionPct(features = {}, config = {}) {
  return round(bpsToPct(heuristicMicroPredictionBps(features, config)), 6);
}

function loadMicroProfile(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function featureContributionEstimate(features = {}, config = {}) {
  const sanitized = sanitizeMicroFeatures(features, config).features;
  const cap = numeric(config.microMaxContributionAbs, 100);
  return [
    ["orderBookImbalance", numeric(sanitized.l1OrderBookImbalance) * 31],
    ["micropriceDeviation", decimalToBps(sanitized.micropriceDeviationFromMid) * 0.19],
    ["tradeImbalance", numeric(sanitized.tradeImbalance_3s, sanitized.tradeImbalance) * 14],
    ["spread", -Math.max(0, clip(numeric(sanitized.spreadZScore), -8, 8)) * 6],
    ["netOrderFlow", clip(numeric(sanitized.netOrderFlow_3s, sanitized.netOrderFlow) * 0.01, -cap, cap)],
  ]
    .map(([feature, contribution]) => ({ feature, contribution: round(clip(contribution, -cap, cap), 4) }))
    .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution))
    .slice(0, 6);
}

function predictionBpsFromInput(prediction = {}, features = {}, config = {}) {
  let value;
  if (prediction.predictedReturnBps !== undefined) value = numeric(prediction.predictedReturnBps);
  else if (prediction.predictedReturnPct !== undefined) value = pctToBps(prediction.predictedReturnPct);
  else if (prediction.predictedReturn !== undefined) value = decimalToBps(prediction.predictedReturn);
  else value = heuristicMicroPredictionBps(features, config);
  return {
    value,
    valid: Number.isFinite(value) && Math.abs(value) <= numeric(config.microMaxPredictedReturnBps, 50),
    warning: Number.isFinite(value) ? "PREDICTED_RETURN_ABSURD_VALUE" : "PREDICTED_RETURN_NON_FINITE",
  };
}

function agreementScore(predictedReturnBps, features = {}) {
  const sign = Math.sign(predictedReturnBps);
  if (!sign) return 0;
  const inputs = [
    numeric(features.l1OrderBookImbalance),
    numeric(features.micropriceDeviationFromMid),
    numeric(features.tradeImbalance_3s, features.tradeImbalance),
    numeric(features.orderFlowPressureScore),
  ];
  const agreeing = inputs.filter((value) => Math.sign(value) === sign).length;
  return agreeing / inputs.length;
}

function microCostGate(snapshot = {}, prediction = {}, config = {}) {
  const validation = sanitizeMicroFeatures(snapshot.features || {}, config);
  const features = validation.features;
  const predictionValidation = predictionBpsFromInput(prediction, features, config);
  const predictedReturnBps = predictionValidation.valid ? predictionValidation.value : 0;
  const spreadCostBps = decimalToBps(numeric(features.relativeSpread));
  const feeCostBps = pctToBps(numeric(config.estimatedTakerFeePctPerSide, numeric(config.estimatedFeePctPerSide, 0.055)) * 2);
  const slippageCostBps = prediction.slippageCostBps !== undefined
    ? numeric(prediction.slippageCostBps)
    : numeric(config.microEstimatedSlippageBps, pctToBps(config.microEstimatedSlippagePct, 0.006));
  const safetyBufferBps = numeric(config.microSafetyBufferBps, 1);
  const expectedGrossEdgeBps = Math.abs(predictedReturnBps);
  const totalCostBps = spreadCostBps + feeCostBps + slippageCostBps + safetyBufferBps;
  const expectedNetEdgeBps = expectedGrossEdgeBps - totalCostBps;
  const topLiquidityUsdt = Math.min(
    numeric(features.bestBidSize) * numeric(features.midPrice),
    numeric(features.bestAskSize) * numeric(features.midPrice)
  );
  const stale = numeric(snapshot.dataAgeMs) > numeric(config.microStaleDataMs, 2000);
  const wideSpread = bpsToPct(spreadCostBps) > numeric(config.microMaxRelativeSpreadPct, 0.04);
  const lowLiquidity = topLiquidityUsdt < numeric(config.microMinTopLiquidityUsdt, 200);
  const weakPrediction = expectedGrossEdgeBps < pctToBps(numeric(config.microMinPredictedReturnPct, 0.012));
  const weakNetEdge = expectedNetEdgeBps <= numeric(config.microMinNetEdgeBps, 3);
  const abnormalBook = numeric(features.bestBidSize) <= 0 || numeric(features.bestAskSize) <= 0 || numeric(features.midPrice) <= 0;
  const blockedReasons = [];
  if (!validation.valid) blockedReasons.push("BAD_FEATURE_VALUES");
  if (!predictionValidation.valid) blockedReasons.push(predictionValidation.warning);
  if (stale) blockedReasons.push("STALE_ORDERBOOK_DATA");
  if (wideSpread) blockedReasons.push("SPREAD_TOO_WIDE");
  if (lowLiquidity) blockedReasons.push("TOP_OF_BOOK_LIQUIDITY_TOO_LOW");
  if (weakPrediction) blockedReasons.push("PREDICTED_RETURN_BELOW_THRESHOLD");
  if (expectedGrossEdgeBps <= totalCostBps) blockedReasons.push("PREDICTED_RETURN_DOES_NOT_COVER_COSTS");
  if (weakNetEdge) blockedReasons.push("EXPECTED_NET_EDGE_BELOW_MINIMUM_BPS");
  if (abnormalBook) blockedReasons.push("ABNORMAL_ORDERBOOK");
  const side = predictedReturnBps > 0 ? "LONG" : predictedReturnBps < 0 ? "SHORT" : "NONE";
  const featureAgreement = agreementScore(predictedReturnBps, features);
  const liquidityQuality = Math.min(1, topLiquidityUsdt / Math.max(1, numeric(config.microMinTopLiquidityUsdt, 200) * 5));
  const spreadQuality = Math.max(0, 1 - (bpsToPct(spreadCostBps) / Math.max(0.0001, numeric(config.microMaxRelativeSpreadPct, 0.04))));
  const recentShadowPerformanceScore = Math.max(-1, Math.min(1, numeric(prediction.recentShadowPerformanceScore, 0)));
  const confidence = Math.max(0, Math.min(95, Math.round(
    35 +
    Math.min(20, Math.max(0, expectedNetEdgeBps) * 2.5) +
    featureAgreement * 18 +
    liquidityQuality * 12 +
    spreadQuality * 12 +
    recentShadowPerformanceScore * 8
  )));
  return {
    approved: blockedReasons.length === 0 && ["LONG", "SHORT"].includes(side),
    side,
    confidence,
    predictedReturnBps: round(predictedReturnBps, 6),
    expectedGrossEdgeBps: round(expectedGrossEdgeBps, 6),
    spreadCostBps: round(spreadCostBps, 6),
    feeCostBps: round(feeCostBps, 6),
    slippageCostBps: round(slippageCostBps, 6),
    safetyBufferBps: round(safetyBufferBps, 6),
    totalCostBps: round(totalCostBps, 6),
    expectedNetEdgeBps: round(expectedNetEdgeBps, 6),
    predictedReturnPct: round(bpsToPct(predictedReturnBps), 6),
    expectedGrossEdgePct: round(bpsToPct(expectedGrossEdgeBps), 6),
    spreadCostPct: round(bpsToPct(spreadCostBps), 6),
    feeCostPct: round(bpsToPct(feeCostBps), 6),
    slippageEstimatePct: round(bpsToPct(slippageCostBps), 6),
    expectedNetEdgePct: round(bpsToPct(expectedNetEdgeBps), 6),
    featureAgreement: round(featureAgreement, 4),
    liquidityQuality: round(liquidityQuality, 4),
    spreadQuality: round(spreadQuality, 4),
    featureValidationWarnings: [
      ...validation.warnings,
      ...(predictionValidation.valid ? [] : [predictionValidation.warning]),
    ],
    featureValidationDetails: [
      ...validation.details,
      ...(predictionValidation.valid ? [] : [{
        feature: "predictedReturnBps",
        value: predictionValidation.value,
        cap: numeric(config.microMaxPredictedReturnBps, 50),
        reason: predictionValidation.warning,
      }]),
    ],
    topLiquidityUsdt: round(topLiquidityUsdt, 4),
    blockedReasons,
    takerOnly: true,
    topContributingFeatures: prediction.topContributingFeatures || featureContributionEstimate(features, config),
  };
}

function microMarginForSignal(signal = {}, config = {}) {
  const confidence = numeric(signal.confidence);
  const base = confidence >= 85
    ? numeric(config.microEliteTradeMarginUsdt, 32)
    : confidence >= 72
      ? numeric(config.microStrongTradeMarginUsdt, 20)
      : numeric(config.microBaseTradeMarginUsdt, 10);
  return Math.min(base, numeric(config.microMaxDeployableCapitalUsdt, 64));
}

module.exports = {
  featureContributionEstimate,
  heuristicMicroPredictionBps,
  heuristicMicroPredictionPct,
  loadMicroProfile,
  microCostGate,
  microMarginForSignal,
  predictionBpsFromInput,
  sanitizeMicroFeatures,
};
