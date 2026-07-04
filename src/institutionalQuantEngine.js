"use strict";

const {
  scoreFunding,
  scoreOpenInterest,
  scoreVolume,
  scoreVolatility,
  scoreTrend,
} = require("./quantIntelligenceEngine");
const { bounded, clampScore, numeric, round } = require("./strategyUtils");

const INSTITUTIONAL_FACTOR_KEYS = Object.freeze([
  "marketRegime",
  "trend",
  "volume",
  "volatility",
  "funding",
  "openInterest",
  "strategy",
]);

const STRATEGY_COMPATIBILITY = Object.freeze({
  TRENDING: Object.freeze(["TREND_BREAKOUT", "MULTI_TIMEFRAME_TREND", "TREND_PULLBACK"]),
  RANGE: Object.freeze(["TREND_PULLBACK", "MULTI_TIMEFRAME_TREND"]),
  COMPRESSION: Object.freeze(["TREND_BREAKOUT", "MULTI_TIMEFRAME_TREND"]),
  EXPANSION: Object.freeze(["TREND_BREAKOUT", "MULTI_TIMEFRAME_TREND", "TREND_PULLBACK"]),
  HIGH_VOLATILITY: Object.freeze(["TREND_BREAKOUT", "MULTI_TIMEFRAME_TREND"]),
  LOW_VOLATILITY: Object.freeze(["TREND_PULLBACK"]),
});

function directionForSide(side) {
  return side === "SHORT" ? "DOWN" : "UP";
}

function maxAnalysisValue(analyses = {}, key) {
  return Math.max(
    numeric(analyses.entry && analyses.entry[key]),
    numeric(analyses.confirmation && analyses.confirmation[key]),
    numeric(analyses.trend && analyses.trend[key]),
    numeric(analyses.macro && analyses.macro[key])
  );
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

function normalizeWeights(config = {}) {
  const raw = {
    marketRegime: numeric(config.v20MarketRegimeWeight, 0.14),
    trend: numeric(config.v20TrendWeight, 0.24),
    volume: numeric(config.v20VolumeWeight, 0.13),
    volatility: numeric(config.v20VolatilityWeight, 0.12),
    funding: numeric(config.v20FundingWeight, 0.1),
    openInterest: numeric(config.v20OpenInterestWeight, 0.17),
    strategy: numeric(config.v20StrategyWeight, 0.1),
  };
  const total = Object.values(raw).reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(Math.max(0, value) / total, 4)]));
}

function capitalTargetForInstitutionalConfidence(config = {}, confidence) {
  let target = 0;
  if (confidence >= 76) target = numeric(config.v20CapitalTierEliteUsdt, 64);
  else if (confidence >= 66) target = numeric(config.v20CapitalTierStrongUsdt, 48);
  else if (confidence >= 56) target = numeric(config.v20CapitalTierNormalUsdt, 32);
  else if (confidence >= numeric(config.v20MinConfidence, 45)) target = numeric(config.v20CapitalTierExplorationUsdt, 20);
  return round(bounded(target, 0, numeric(config.maxDeployableCapitalUsdt, 64) || target), 4);
}

class MarketRegimeEngine {
  constructor(config = {}) {
    this.config = config;
  }

  classify(analyses = {}, marketProfile = {}) {
    const tags = new Set(marketProfile.tags || []);
    const atrPct = maxAnalysisValue(analyses, "atrPct");
    const rangeExpansion = maxAnalysisValue(analyses, "rangeExpansion");
    const volumeSpike = maxAnalysisValue(analyses, "volumeSpike");
    const emaGap = Math.max(
      Math.abs(numeric(analyses.confirmation && analyses.confirmation.emaGapPct)),
      Math.abs(numeric(analyses.trend && analyses.trend.emaGapPct)),
      Math.abs(numeric(analyses.macro && analyses.macro.emaGapPct))
    );
    let regime = "RANGE";
    let score = 54;
    if (atrPct >= numeric(this.config.v20HighVolatilityAtrPct, numeric(this.config.highVolatilityAtrPct, 0.8))) {
      regime = "HIGH_VOLATILITY";
      score = 62;
    }
    if (rangeExpansion >= numeric(this.config.v20ExpansionRangeMultiple, 1.35) && volumeSpike >= numeric(this.config.v20ExpansionVolumeMultiple, 1.35)) {
      regime = "EXPANSION";
      score = 76;
    }
    if (emaGap >= numeric(this.config.v20TrendingEmaGapPct, 0.12) || tags.has("STRONG_TRENDING_MARKET")) {
      regime = "TRENDING";
      score = 74;
    }
    if (atrPct <= numeric(this.config.v20LowVolatilityAtrPct, numeric(this.config.regimeDeadMarketAtrPct, 0.1))) {
      regime = "LOW_VOLATILITY";
      score = 42;
    }
    if (rangeExpansion <= numeric(this.config.v20CompressionRangeMultiple, 0.72) && volumeSpike <= 1.05) {
      regime = "COMPRESSION";
      score = 48;
    }
    if (tags.has("SIDEWAYS_CHOP_MARKET") || marketProfile.direction === "CHOPPY") {
      regime = "RANGE";
      score = Math.min(score, 50);
    }
    return {
      score: clampScore(score),
      regime,
      atrPct: round(atrPct, 4),
      rangeExpansion: round(rangeExpansion, 4),
      volumeSpike: round(volumeSpike, 4),
      emaGapPct: round(emaGap, 4),
      compatibleStrategies: STRATEGY_COMPATIBILITY[regime] || STRATEGY_COMPATIBILITY.RANGE,
      strategyWeights: {
        TREND_BREAKOUT: regime === "EXPANSION" || regime === "HIGH_VOLATILITY" ? 1.22 : regime === "TRENDING" ? 1.08 : regime === "LOW_VOLATILITY" ? 0.7 : 0.9,
        MULTI_TIMEFRAME_TREND: regime === "TRENDING" ? 1.18 : regime === "RANGE" ? 0.92 : regime === "LOW_VOLATILITY" ? 0.78 : 1,
        TREND_PULLBACK: regime === "TRENDING" ? 1.14 : regime === "RANGE" ? 1.05 : regime === "HIGH_VOLATILITY" ? 0.72 : 0.95,
      },
      reasons: [`${regime}: ATR ${round(atrPct, 3)}%, range ${round(rangeExpansion, 3)}, volume ${round(volumeSpike, 3)}`],
    };
  }
}

class TrendEngine {
  constructor(config = {}) {
    this.config = config;
  }

  evaluate(side, analyses = {}) {
    const base = scoreTrend(this.config, side, analyses);
    const htfScores = [analyses.confirmation, analyses.trend, analyses.macro].map((analysis) => {
      if (!analysis) return 50;
      const expected = directionForSide(side);
      const aligned =
        side === "LONG"
          ? numeric(analysis.ema9) > numeric(analysis.ema21) && numeric(analysis.ema21) > numeric(analysis.ema50)
          : numeric(analysis.ema9) < numeric(analysis.ema21) && numeric(analysis.ema21) < numeric(analysis.ema50);
      const momentum = side === "LONG" ? numeric(analysis.momentumPct) : -numeric(analysis.momentumPct);
      return aligned ? 68 + Math.max(0, momentum) * 10 : analysis.bodyDirection === expected ? 52 : 34;
    });
    const htfTrendScore = clampScore(average(htfScores));
    const trendStrength = clampScore(base.score * 0.72 + htfTrendScore * 0.28);
    return {
      ...base,
      score: trendStrength,
      htfTrendScore,
      trendStrength,
      module: "TrendEngine",
    };
  }
}

class VolumeEngine {
  constructor(config = {}) {
    this.config = config;
  }

  evaluate(side, analyses = {}) {
    return { ...scoreVolume(this.config, side, analyses), module: "VolumeEngine" };
  }
}

class VolatilityEngine {
  constructor(config = {}) {
    this.config = config;
  }

  evaluate(analyses = {}) {
    return { ...scoreVolatility(this.config, analyses), module: "VolatilityEngine" };
  }
}

class FundingRateEngine {
  constructor(config = {}) {
    this.config = config;
  }

  evaluate(side, marketData = {}) {
    return { ...scoreFunding(this.config, side, marketData), module: "FundingRateEngine" };
  }
}

class OpenInterestEngine {
  constructor(config = {}) {
    this.config = config;
  }

  evaluate(side, marketData = {}, analyses = {}) {
    return { ...scoreOpenInterest(this.config, side, marketData, analyses), module: "OpenInterestEngine" };
  }
}

class PortfolioAllocator {
  constructor(config = {}) {
    this.config = config;
  }

  portfolioHealth({ openPositions = [], availableCapitalUsdt = null } = {}) {
    const currentExposure = openPositions.reduce((sum, position) => sum + Math.abs(numeric(position.marginUsedUsdt, numeric(position.margin))), 0);
    const portfolioRisk = openPositions.reduce((sum, position) => sum + Math.abs(numeric(position.maxLossAtStopUsdt)), 0);
    const bySymbol = openPositions.reduce((acc, position) => {
      acc[position.symbol] = (acc[position.symbol] || 0) + Math.abs(numeric(position.marginUsedUsdt, numeric(position.margin)));
      return acc;
    }, {});
    const deployable = numeric(this.config.maxDeployableCapitalUsdt, 64);
    const freeCapital = Math.max(0, numeric(availableCapitalUsdt, deployable) - currentExposure);
    const largestSymbol = Object.entries(bySymbol).sort((left, right) => right[1] - left[1])[0] || ["NONE", 0];
    return {
      currentExposureUsdt: round(currentExposure, 4),
      freeCapitalUsdt: round(Math.min(freeCapital, Math.max(0, deployable - currentExposure)), 4),
      correlation: openPositions.length > 1 ? "BTC_ETH_SOL_CRYPTO_CLUSTER" : "LOW_OPEN_CLUSTER",
      portfolioRiskUsdt: round(portfolioRisk, 4),
      sectorConcentration: {
        sector: "CRYPTO_MAJOR_PERPS",
        largestSymbol: largestSymbol[0],
        largestSymbolExposureUsdt: round(largestSymbol[1], 4),
      },
      maximumAdditionalRiskUsdt: round(Math.max(0, numeric(this.config.portfolioMaxOpenRiskPct, 2.6) / 100 * deployable - portfolioRisk), 4),
    };
  }

  allocate(confidence, regime, strategyId, positionSizeMultiplier = 1) {
    const target = capitalTargetForInstitutionalConfidence(this.config, confidence);
    const regimeMultiplier = numeric(regime && regime.strategyWeights && regime.strategyWeights[strategyId], 1);
    return round(bounded(target * bounded(regimeMultiplier, 0.7, 1.22) * bounded(positionSizeMultiplier, 0.6, 1.6), 0, numeric(this.config.maxDeployableCapitalUsdt, 64)), 4);
  }
}

class ExecutionLayer {
  plan({ side, strategySignal = {}, confidence, capitalTargetUsdt, expectedRewardRisk }) {
    return {
      side,
      capitalTargetUsdt,
      expectedHoldingTimeSeconds: numeric(strategySignal.preferredHoldingTimeSeconds, 6 * 60 * 60),
      expectedRewardRisk: round(numeric(expectedRewardRisk, numeric(strategySignal.expectedRewardRisk)), 4),
      executionLayer: "EXISTING_BYBIT_ORDER_MANAGER",
      placesOrders: false,
      preservesRiskManagerAuthority: true,
      explanation: `V20 decision layer selected ${side} with confidence ${round(confidence, 2)}; execution remains delegated to existing order manager and risk manager.`,
    };
  }
}

function combineScores(config = {}, factorScores = {}) {
  const weights = normalizeWeights(config);
  let total = 0;
  let weighted = 0;
  for (const key of INSTITUTIONAL_FACTOR_KEYS) {
    const score = Math.max(numeric(factorScores[key], 50), numeric(config.v20SingleFactorConfidenceFloor, 18));
    const weight = numeric(weights[key]);
    weighted += score * weight;
    total += weight;
  }
  return {
    confidence: clampScore(total > 0 ? weighted / total : 50),
    weights,
  };
}

function buildShadowOpportunity({ decision = {}, context = {}, reason = "candidate skipped by portfolio layer" } = {}) {
  return {
    shadowMode: true,
    liveOrderGenerated: false,
    symbol: context.symbol || decision.symbol,
    side: decision.side,
    confidence: numeric(decision.confidence),
    strategyId: decision.strategyCombination || (decision.dominantStrategy && decision.dominantStrategy.strategyId),
    expectedRewardRisk: numeric(decision.expectedRewardRisk),
    expectedMovePct: numeric(decision.expectedMovePct),
    stopDistancePct: numeric(decision.stopDistancePct),
    missedOpportunityScore: clampScore(numeric(decision.confidence) * 0.55 + numeric(decision.expectedRewardRisk) * 12 + Math.max(0, numeric(decision.projectedNetEdgePct)) * 10),
    maximumFavorableExcursionPct: 0,
    maximumAdverseExcursionPct: 0,
    wouldHaveWon: null,
    wouldHaveLost: null,
    reason,
  };
}

function gradeFromScore(score) {
  if (score >= 96) return "A+";
  if (score >= 88) return "A";
  if (score >= 76) return "B";
  if (score >= 64) return "C";
  if (score >= 50) return "D";
  return "F";
}

function gradeTradeQuality(trade = {}) {
  const pnl = numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt, numeric(trade.realizedPnlUsdt)));
  const gross = numeric(trade.grossPnlUsdt, pnl);
  const fees = Math.abs(numeric(trade.feesUsdt, numeric(trade.totalFeesUsdt, numeric(trade.feesPaidUsdt))));
  const entryScore = clampScore(numeric(trade.quantConfidenceScore, numeric(trade.strategyConfidence, numeric(trade.convictionScore, 50))));
  const exitEfficiency = numeric(trade.maximumFavorableExcursionPct) > 0
    ? bounded(numeric(trade.realizedPnlPct, numeric(trade.pnlPct)) / numeric(trade.maximumFavorableExcursionPct), -1, 1.2)
    : pnl > 0 ? 0.75 : 0.35;
  const exitScore = clampScore(50 + exitEfficiency * 35 + (trade.runnerPartialTaken ? 8 : 0) - (trade.grossPositiveNetNegative ? 18 : 0));
  const slippage = Math.abs(numeric(trade.slippagePct));
  const executionScore = clampScore(84 - Math.min(30, slippage * 60) - Math.min(20, fees / Math.max(0.01, Math.abs(gross || pnl || 0.01)) * 8));
  const feeEfficiency = clampScore(100 - Math.min(80, fees / Math.max(0.01, Math.abs(gross || pnl || 0.01)) * 100));
  const riskEfficiency = clampScore(50 + (pnl / Math.max(0.01, numeric(trade.maxLossAtStopUsdt, Math.abs(pnl) || 0.01))) * 30 - Math.max(0, numeric(trade.maximumAdverseExcursionPct)) * 4);
  const overallScore = clampScore(entryScore * 0.24 + exitScore * 0.22 + executionScore * 0.18 + feeEfficiency * 0.18 + riskEfficiency * 0.18);
  return {
    entryScore,
    exitScore,
    executionScore,
    feeEfficiency,
    riskEfficiency,
    overallScore,
    overallGrade: gradeFromScore(overallScore),
  };
}

function summarizeInstitutionalTrades(trades = []) {
  const closed = trades.filter((trade) => Number.isFinite(numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt, Number.NaN))));
  const by = (keyFn) => {
    const buckets = {};
    for (const trade of closed) {
      const key = keyFn(trade) || "UNKNOWN";
      buckets[key] = (buckets[key] || 0) + numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt));
    }
    return Object.entries(buckets).sort((left, right) => right[1] - left[1]);
  };
  const strategyRank = by((trade) => trade.strategyId || trade.strategyCombination);
  const symbolRank = by((trade) => trade.symbol);
  const sorted = closed.slice().sort((left, right) => numeric(right.netPnlUsdt, numeric(right.pnlUsdt)) - numeric(left.netPnlUsdt, numeric(left.pnlUsdt)));
  const largestWin = sorted[0] || null;
  const losingTrades = closed
    .filter((trade) => numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt)) < 0)
    .sort((left, right) => numeric(left.netPnlUsdt, numeric(left.pnlUsdt)) - numeric(right.netPnlUsdt, numeric(right.pnlUsdt)));
  const largestLoss = losingTrades[0] || null;
  const feeTotal = closed.reduce((sum, trade) => sum + Math.abs(numeric(trade.feesUsdt, numeric(trade.totalFeesUsdt))), 0);
  const pnlTotal = closed.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt)), 0);
  return {
    pnlUsdt: round(pnlTotal, 6),
    tradeCount: closed.length,
    bestStrategy: strategyRank[0] ? strategyRank[0][0] : null,
    worstStrategy: strategyRank[strategyRank.length - 1] ? strategyRank[strategyRank.length - 1][0] : null,
    mostProfitableSymbol: symbolRank[0] ? symbolRank[0][0] : null,
    largestMistake: largestLoss ? {
      symbol: largestLoss.symbol,
      strategyId: largestLoss.strategyId,
      netPnlUsdt: numeric(largestLoss.netPnlUsdt, numeric(largestLoss.pnlUsdt)),
      reason: largestLoss.exitReason || "largest net loss",
    } : null,
    largestWin: largestWin ? {
      symbol: largestWin.symbol,
      strategyId: largestWin.strategyId,
      netPnlUsdt: numeric(largestWin.netPnlUsdt, numeric(largestWin.pnlUsdt)),
    } : null,
    largestLoss: largestLoss ? {
      symbol: largestLoss.symbol,
      strategyId: largestLoss.strategyId,
      netPnlUsdt: numeric(largestLoss.netPnlUsdt, numeric(largestLoss.pnlUsdt)),
    } : null,
    recommendedImprovements: [
      feeTotal > Math.abs(pnlTotal) * 0.5 ? "Reduce fee drag by preferring higher reward-to-cost setups and maker entries when practical." : "Continue monitoring fee efficiency.",
      "Use V20 shadow-mode outcomes to calibrate skipped qualified opportunities.",
      "Keep learning focused on strategy weighting, sizing, exits, holding duration, and confidence calibration.",
    ],
  };
}

function walkForwardValidation(trades = [], windowsDays = [30, 90, 180]) {
  const now = Date.now();
  const closed = trades.filter((trade) => Number.isFinite(numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt, Number.NaN))));
  return Object.fromEntries(windowsDays.map((days) => {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const slice = closed.filter((trade) => {
      const when = Date.parse(trade.exitedAt || trade.closedAt || trade.timestamp || "");
      return !Number.isFinite(when) || when >= cutoff;
    });
    const wins = slice.filter((trade) => numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt)) > 0);
    const losses = slice.filter((trade) => numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt)) < 0);
    const grossWin = wins.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt)), 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt)), 0));
    const returns = slice.map((trade) => numeric(trade.netReturnPct, numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt))));
    const avg = average(returns);
    const variance = returns.length ? returns.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / returns.length : 0;
    const downside = returns.filter((value) => value < 0);
    const downsideVariance = downside.length ? downside.reduce((sum, value) => sum + Math.pow(value, 2), 0) / downside.length : 0;
    return [`${days}d`, {
      netProfitUsdt: round(grossWin - grossLoss, 6),
      profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : grossWin > 0 ? 999 : 0,
      sharpe: variance > 0 ? round(avg / Math.sqrt(variance), 4) : 0,
      sortino: downsideVariance > 0 ? round(avg / Math.sqrt(downsideVariance), 4) : 0,
      maximumDrawdownUsdt: round(grossLoss, 6),
      winRatePct: slice.length ? round((wins.length / slice.length) * 100, 2) : 0,
      averageWinnerUsdt: wins.length ? round(grossWin / wins.length, 6) : 0,
      averageLoserUsdt: losses.length ? round(grossLoss / losses.length, 6) : 0,
      averageHoldingSeconds: slice.length ? round(slice.reduce((sum, trade) => sum + numeric(trade.holdSeconds), 0) / slice.length, 2) : 0,
      feesUsdt: round(slice.reduce((sum, trade) => sum + Math.abs(numeric(trade.feesUsdt, numeric(trade.totalFeesUsdt))), 0), 6),
      profitContributionByStrategy: Object.fromEntries(Object.entries(slice.reduce((acc, trade) => {
        const key = trade.strategyId || trade.strategyCombination || "UNKNOWN";
        acc[key] = (acc[key] || 0) + numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt));
        return acc;
      }, {})).map(([key, value]) => [key, round(value, 6)])),
    }];
  }));
}

class InstitutionalQuantEngine {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.marketRegime = new MarketRegimeEngine(config);
    this.trend = new TrendEngine(config);
    this.volume = new VolumeEngine(config);
    this.volatility = new VolatilityEngine(config);
    this.funding = new FundingRateEngine(config);
    this.openInterest = new OpenInterestEngine(config);
    this.allocator = new PortfolioAllocator(config);
    this.execution = new ExecutionLayer(config);
  }

  evaluate({ side, strategySignal = {}, strategyId = null, analyses = {}, marketProfile = {}, marketData = {}, openPositions = [] } = {}) {
    const direction = side || strategySignal.direction || "LONG";
    const resolvedStrategyId = strategyId || strategySignal.strategyId || "UNKNOWN_STRATEGY";
    const regime = this.marketRegime.classify(analyses, marketProfile);
    const factors = {
      marketRegime: regime,
      trend: this.trend.evaluate(direction, analyses),
      volume: this.volume.evaluate(direction, analyses),
      volatility: this.volatility.evaluate(analyses),
      funding: this.funding.evaluate(direction, marketData),
      openInterest: this.openInterest.evaluate(direction, marketData, analyses),
      strategy: {
        score: clampScore(numeric(strategySignal.confidence, 50)),
        state: "STRATEGY_SIGNAL",
        reasons: [`${resolvedStrategyId} strategy confidence ${round(numeric(strategySignal.confidence, 50), 2)}`],
      },
    };
    const factorScores = Object.fromEntries(INSTITUTIONAL_FACTOR_KEYS.map((key) => [key, clampScore(factors[key].score)]));
    const combined = combineScores(this.config, factorScores);
    const compatible = regime.compatibleStrategies.includes(resolvedStrategyId);
    const compatibilityMultiplier = compatible ? 1 : numeric(this.config.v20IncompatibleStrategyPenaltyMultiplier, 0.72);
    const confidence = clampScore(combined.confidence * compatibilityMultiplier);
    const capitalTargetUsdt = this.allocator.allocate(confidence, regime, resolvedStrategyId, numeric(strategySignal.positionSizeMultiplier, 1));
    const portfolioHealth = this.allocator.portfolioHealth({ openPositions });
    const executionPlan = this.execution.plan({
      side: direction,
      strategySignal,
      confidence,
      capitalTargetUsdt,
      expectedRewardRisk: numeric(strategySignal.expectedRewardRisk),
    });
    const result = {
      engine: "V20_INSTITUTIONAL_QUANT_ENGINE",
      side: direction,
      confidence,
      capitalTargetUsdt,
      factorScores,
      factorWeights: combined.weights,
      factors,
      funding: factors.funding,
      openInterest: factors.openInterest,
      volume: factors.volume,
      volatility: factors.volatility,
      trend: factors.trend,
      regime,
      marketRegime: regime,
      strategyCompatible: compatible,
      strategyRegimeMultiplier: compatibilityMultiplier,
      portfolioHealth,
      executionPlan,
      expectedHoldingTimeSeconds: executionPlan.expectedHoldingTimeSeconds,
      reasons: INSTITUTIONAL_FACTOR_KEYS.flatMap((key) => factors[key].reasons || []),
    };
    this.log("DEBUG", "V20_INSTITUTIONAL_QUANT_EVALUATED", {
      side: direction,
      strategyId: resolvedStrategyId,
      confidence,
      capitalTargetUsdt,
      regime: regime.regime,
      strategyCompatible: compatible,
      factorScores,
      portfolioHealth,
    });
    return result;
  }
}

module.exports = {
  ExecutionLayer,
  FundingRateEngine,
  InstitutionalQuantEngine,
  INSTITUTIONAL_FACTOR_KEYS,
  MarketRegimeEngine,
  OpenInterestEngine,
  PortfolioAllocator,
  TrendEngine,
  VolumeEngine,
  VolatilityEngine,
  buildShadowOpportunity,
  capitalTargetForInstitutionalConfidence,
  combineScores,
  gradeTradeQuality,
  normalizeWeights,
  summarizeInstitutionalTrades,
  walkForwardValidation,
};
