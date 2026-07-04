"use strict";

const { bounded, clampScore, numeric, round } = require("./strategyUtils");

const FACTOR_KEYS = Object.freeze(["funding", "openInterest", "trend", "volume", "volatility", "regime", "strategy"]);

function normalizeFactorWeights(config = {}, learnedWeights = {}) {
  const raw = {
    funding: numeric(learnedWeights.funding, numeric(config.v19FundingWeight, 0.12)),
    openInterest: numeric(learnedWeights.openInterest, numeric(config.v19OpenInterestWeight, 0.18)),
    trend: numeric(learnedWeights.trend, numeric(config.v19TrendWeight, 0.26)),
    volume: numeric(learnedWeights.volume, numeric(config.v19VolumeWeight, 0.14)),
    volatility: numeric(learnedWeights.volatility, numeric(config.v19VolatilityWeight, 0.12)),
    regime: numeric(learnedWeights.regime, numeric(config.v19RegimeWeight, 0.1)),
    strategy: numeric(learnedWeights.strategy, numeric(config.v19StrategyWeight, 0.08)),
  };
  const sanitized = Object.fromEntries(FACTOR_KEYS.map((key) => [key, Math.max(0, raw[key])]));
  const total = Object.values(sanitized).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(sanitized).map(([key, value]) => [key, round(value / total, 4)]));
}

function latestAnalysis(analyses = {}) {
  return analyses.entry || analyses.confirmation || analyses.trend || analyses.macro || {};
}

function maxAnalysisValue(analyses = {}, key) {
  return Math.max(
    numeric(analyses.entry && analyses.entry[key]),
    numeric(analyses.confirmation && analyses.confirmation[key]),
    numeric(analyses.trend && analyses.trend[key]),
    numeric(analyses.macro && analyses.macro[key])
  );
}

function sideDirection(side) {
  return side === "SHORT" ? "DOWN" : "UP";
}

function directionScore(side, direction, supportive = 75, neutral = 50, opposed = 25) {
  const expected = sideDirection(side);
  if (direction === expected) return supportive;
  if (!direction || direction === "CHOPPY" || direction === "NEUTRAL") return neutral;
  return opposed;
}

function fundingRatePctFromMarketData(marketData = {}) {
  const raw = marketData.fundingRatePct !== undefined
    ? marketData.fundingRatePct
    : marketData.fundingRate !== undefined
      ? numeric(marketData.fundingRate) * 100
      : marketData.funding && marketData.funding.ratePct !== undefined
        ? marketData.funding.ratePct
        : marketData.funding && marketData.funding.rate !== undefined
          ? numeric(marketData.funding.rate) * 100
          : 0;
  return Number.isFinite(Number(raw)) ? Number(raw) : 0;
}

function scoreFunding(config = {}, side, marketData = {}) {
  const ratePct = fundingRatePctFromMarketData(marketData);
  const extremePct = numeric(config.v19ExtremeFundingRatePct, 0.05);
  let state = "NEUTRAL";
  if (ratePct >= extremePct) state = "EXTREME_POSITIVE";
  else if (ratePct <= -extremePct) state = "EXTREME_NEGATIVE";

  let score = 50;
  const reasons = [`funding ${round(ratePct, 5)}% ${state}`];
  if (state === "EXTREME_POSITIVE") {
    score = side === "SHORT" ? 68 : 42;
    reasons.push(side === "SHORT" ? "crowded longs create short-bias support" : "long pays crowded funding tax");
  } else if (state === "EXTREME_NEGATIVE") {
    score = side === "LONG" ? 68 : 42;
    reasons.push(side === "LONG" ? "crowded shorts create long-bias support" : "short pays crowded funding tax");
  }
  return {
    score: clampScore(score),
    state,
    ratePct: round(ratePct, 6),
    bias: score > 55 ? side : score < 45 ? (side === "LONG" ? "SHORT" : "LONG") : "NEUTRAL",
    reasons,
  };
}

function openInterestSnapshot(marketData = {}) {
  const oi = marketData.openInterest || marketData.oi || {};
  const current = numeric(oi.current, numeric(marketData.openInterestCurrent));
  const previous = numeric(oi.previous, numeric(marketData.openInterestPrevious));
  const changePct = Number.isFinite(Number(oi.changePct))
    ? Number(oi.changePct)
    : previous > 0
      ? ((current - previous) / previous) * 100
      : 0;
  return { current, previous, changePct };
}

function scoreOpenInterest(config = {}, side, marketData = {}, analyses = {}) {
  const oi = openInterestSnapshot(marketData);
  const priceChangePct = numeric(marketData.priceChangePct, numeric(latestAnalysis(analyses).momentumPct));
  const minChangePct = numeric(config.v19OpenInterestChangeThresholdPct, 0.75);
  const priceUp = priceChangePct > 0;
  const priceDown = priceChangePct < 0;
  const oiUp = oi.changePct >= minChangePct;
  const oiDown = oi.changePct <= -minChangePct;
  let pattern = "NEUTRAL";
  if (priceUp && oiUp) pattern = "PRICE_UP_OI_UP";
  else if (priceDown && oiUp) pattern = "PRICE_DOWN_OI_UP";
  else if (priceUp && oiDown) pattern = "PRICE_UP_OI_DOWN";
  else if (priceDown && oiDown) pattern = "PRICE_DOWN_OI_DOWN";

  let score = 50;
  if (pattern === "PRICE_UP_OI_UP") score = side === "LONG" ? 76 : 34;
  else if (pattern === "PRICE_DOWN_OI_UP") score = side === "SHORT" ? 76 : 34;
  else if (pattern === "PRICE_UP_OI_DOWN") score = side === "LONG" ? 58 : 46;
  else if (pattern === "PRICE_DOWN_OI_DOWN") score = side === "SHORT" ? 58 : 46;

  return {
    score: clampScore(score),
    pattern,
    current: round(oi.current, 4),
    previous: round(oi.previous, 4),
    changePct: round(oi.changePct, 4),
    priceChangePct: round(priceChangePct, 4),
    reasons: [`${pattern}: price ${round(priceChangePct, 4)}%, OI ${round(oi.changePct, 4)}%`],
  };
}

function scoreVolume(config = {}, side, analyses = {}) {
  const entry = analyses.entry || {};
  const confirmation = analyses.confirmation || {};
  const trend = analyses.trend || {};
  const volumeSpike = Math.max(numeric(entry.volumeSpike), numeric(confirmation.volumeSpike), numeric(trend.volumeSpike));
  const rangeExpansion = Math.max(numeric(entry.rangeExpansion), numeric(confirmation.rangeExpansion), numeric(trend.rangeExpansion));
  const bodyStrength = Math.max(numeric(entry.bodyStrength), numeric(confirmation.bodyStrength), numeric(trend.bodyStrength));
  const directionalBody =
    [entry, confirmation, trend].some((analysis) => analysis.bodyDirection === sideDirection(side) && numeric(analysis.bodyStrength) >= 0.45);
  let state = "NORMAL_PARTICIPATION";
  let score = 52;
  if (volumeSpike >= numeric(config.v19InstitutionalVolumeSpike, 2.2) && rangeExpansion >= numeric(config.minRangeExpansion, 0.72)) {
    state = "INSTITUTIONAL_PARTICIPATION";
    score = directionalBody ? 82 : 64;
  } else if (volumeSpike >= numeric(config.v19VolumeSpikeThreshold, 1.45)) {
    state = "VOLUME_SPIKE";
    score = directionalBody ? 72 : 58;
  } else if (volumeSpike <= numeric(config.v19LowParticipationVolumeSpike, 0.72)) {
    state = "LOW_PARTICIPATION";
    score = 38;
  }
  if (volumeSpike >= numeric(config.v19VolumeSpikeThreshold, 1.45) && rangeExpansion < numeric(config.minRangeExpansion, 0.72) * 0.75 && bodyStrength < 0.35) {
    state = "FAKE_BREAKOUT_VOLUME";
    score = Math.min(score, 36);
  }
  return {
    score: clampScore(score),
    state,
    relativeVolume: round(volumeSpike, 4),
    rangeExpansion: round(rangeExpansion, 4),
    bodyStrength: round(bodyStrength, 4),
    directionalBody,
    reasons: [`${state}: relative volume ${round(volumeSpike, 3)}, range expansion ${round(rangeExpansion, 3)}`],
  };
}

function scoreVolatility(config = {}, analyses = {}) {
  const atrPct = maxAnalysisValue(analyses, "atrPct");
  const rangeExpansion = maxAnalysisValue(analyses, "rangeExpansion");
  const entryAtr = numeric(analyses.entry && analyses.entry.atrPct);
  const trendAtr = numeric(analyses.trend && analyses.trend.atrPct);
  const realizedVolatilityPct = Math.max(atrPct, Math.abs(numeric(analyses.entry && analyses.entry.momentumPct)), Math.abs(numeric(analyses.confirmation && analyses.confirmation.momentumPct)));
  const deadAtrPct = numeric(config.v19DeadMarketAtrPct, numeric(config.regimeDeadMarketAtrPct, 0.1));
  const expansionAtrPct = numeric(config.v19VolatilityExpansionAtrPct, numeric(config.regimeHighVolatilityAtrPct, 0.7));
  let state = "NORMAL_VOLATILITY";
  let score = 55;
  if (atrPct <= deadAtrPct && rangeExpansion < 0.85) {
    state = "DEAD_MARKET";
    score = 30;
  } else if (atrPct >= expansionAtrPct || rangeExpansion >= 1.35 || entryAtr > trendAtr * 1.18) {
    state = "VOLATILITY_EXPANSION";
    score = 76;
  } else if (rangeExpansion <= 0.75) {
    state = "VOLATILITY_CONTRACTION";
    score = 44;
  }
  return {
    score: clampScore(score),
    state,
    atrPct: round(atrPct, 4),
    realizedVolatilityPct: round(realizedVolatilityPct, 4),
    rangeExpansion: round(rangeExpansion, 4),
    reasons: [`${state}: ATR ${round(atrPct, 4)}%, realized ${round(realizedVolatilityPct, 4)}%`],
  };
}

function emaStructureScore(side, analysis = {}) {
  if (![analysis.ema9, analysis.ema21, analysis.ema50].every(Number.isFinite)) return 50;
  if (side === "LONG" && analysis.ema9 > analysis.ema21 && analysis.ema21 > analysis.ema50) return 74;
  if (side === "SHORT" && analysis.ema9 < analysis.ema21 && analysis.ema21 < analysis.ema50) return 74;
  if (side === "LONG" && analysis.ema9 < analysis.ema21 && analysis.ema21 < analysis.ema50) return 26;
  if (side === "SHORT" && analysis.ema9 > analysis.ema21 && analysis.ema21 > analysis.ema50) return 26;
  return 50;
}

function scoreTrend(_config = {}, side, analyses = {}) {
  const expected = sideDirection(side);
  const entry = analyses.entry || {};
  const confirmation = analyses.confirmation || {};
  const trend = analyses.trend || {};
  const macro = analyses.macro || {};
  const directionScores = [
    emaStructureScore(side, entry),
    emaStructureScore(side, confirmation),
    emaStructureScore(side, trend),
    emaStructureScore(side, macro),
  ];
  const momentumSupport = [entry, confirmation, trend, macro].reduce((sum, analysis) => {
    const directed = side === "LONG" ? numeric(analysis.momentumPct) : -numeric(analysis.momentumPct);
    return sum + bounded(directed * 12, -12, 12);
  }, 0);
  const acceleration =
    (side === "LONG" ? numeric(entry.emaGapPct) - numeric(entry.previousEmaGapPct) : numeric(entry.previousEmaGapPct) - numeric(entry.emaGapPct));
  const exhaustion =
    (side === "LONG" && numeric(entry.rsi14) >= 82) ||
    (side === "SHORT" && numeric(entry.rsi14) <= 18);
  const adxProxy = bounded(
    Math.abs(numeric(confirmation.emaGapPct)) * 10 + Math.abs(numeric(trend.emaGapPct)) * 12 + Math.max(0, momentumSupport) * 0.7,
    0,
    100
  );
  const base = directionScores.reduce((sum, score) => sum + score, 0) / directionScores.length;
  const score = clampScore(base + momentumSupport * 0.55 + bounded(acceleration * 35, -8, 8) + (exhaustion ? -10 : 0));
  const state = score >= 70 ? "TREND_ACCELERATION" : score <= 38 ? "TREND_OPPOSITION" : exhaustion ? "TREND_EXHAUSTION" : "TREND_NEUTRAL";
  return {
    score,
    state,
    expectedDirection: expected,
    adxProxy: round(adxProxy, 4),
    acceleration: round(acceleration, 5),
    exhaustion,
    reasons: [`${state}: EMA structure ${round(base, 2)}, ADX proxy ${round(adxProxy, 2)}`],
  };
}

function classifyQuantRegime(config = {}, analyses = {}, marketProfile = {}) {
  const tags = new Set(marketProfile.tags || []);
  const atrPct = maxAnalysisValue(analyses, "atrPct");
  const rangeExpansion = maxAnalysisValue(analyses, "rangeExpansion");
  const volumeSpike = maxAnalysisValue(analyses, "volumeSpike");
  const trendGap = Math.max(Math.abs(numeric(analyses.confirmation && analyses.confirmation.emaGapPct)), Math.abs(numeric(analyses.trend && analyses.trend.emaGapPct)));
  if (tags.has("PANIC") || tags.has("EXCHANGE_DISLOCATION") || atrPct >= numeric(config.abnormalVolatilityAtrPct, 1.6)) return "EXPLOSIVE";
  if (rangeExpansion >= 1.35 && volumeSpike >= 1.35) return "EXPLOSIVE";
  if (tags.has("STRONG_TRENDING_MARKET") || trendGap >= 0.12) return "TRENDING";
  if (atrPct <= numeric(config.v19DeadMarketAtrPct, numeric(config.regimeDeadMarketAtrPct, 0.1)) || rangeExpansion <= 0.72) return "COMPRESSION";
  if (tags.has("SIDEWAYS_CHOP_MARKET") || tags.has("FAKE_BREAKOUT_ENVIRONMENT") || marketProfile.direction === "CHOPPY") return "MEAN_REVERTING";
  return "RANGING";
}

function scoreRegime(config = {}, side, analyses = {}, marketProfile = {}) {
  const regime = classifyQuantRegime(config, analyses, marketProfile);
  const entry = analyses.entry || {};
  const trend = analyses.trend || {};
  const directedTrend = side === "LONG" ? numeric(trend.momentumPct) : -numeric(trend.momentumPct);
  const directedEntry = side === "LONG" ? numeric(entry.momentumPct) : -numeric(entry.momentumPct);
  let score = 52;
  if (regime === "TRENDING") score = directedTrend >= 0 ? 74 : 34;
  else if (regime === "EXPLOSIVE") score = directedEntry >= 0 ? 82 : 42;
  else if (regime === "COMPRESSION") score = 42;
  else if (regime === "MEAN_REVERTING") score = 46;
  else score = 55;
  return {
    score: clampScore(score),
    regime,
    strategyWeights: {
      TREND_BREAKOUT: regime === "EXPLOSIVE" ? 1.25 : regime === "TRENDING" ? 1.05 : regime === "COMPRESSION" ? 0.75 : 0.9,
      MULTI_TIMEFRAME_TREND: regime === "TRENDING" ? 1.2 : regime === "RANGING" ? 0.95 : regime === "MEAN_REVERTING" ? 0.8 : 1,
      TREND_PULLBACK: regime === "TRENDING" ? 1.15 : regime === "MEAN_REVERTING" ? 0.9 : 1,
    },
    reasons: [`${regime}: strategy weights adjusted by quantitative market regime`],
  };
}

function capitalTargetForQuantConfidence(config = {}, confidence) {
  let target = 0;
  if (confidence >= 76) target = numeric(config.v19CapitalTierEliteUsdt, 64);
  else if (confidence >= 66) target = numeric(config.v19CapitalTierStrongUsdt, 40);
  else if (confidence >= 56) target = numeric(config.v19CapitalTierNormalUsdt, 28);
  else if (confidence >= numeric(config.v19MinConfidence, 45)) target = numeric(config.v19CapitalTierExplorationUsdt, 20);
  const budget = numeric(config.maxDeployableCapitalUsdt, target);
  return round(bounded(target, 0, budget || target), 4);
}

function learnedFactorWeights(config = {}, factorStats = {}) {
  const hasStats = factorStats && typeof factorStats === "object" && Object.keys(factorStats).length > 0;
  if (!hasStats) return normalizeFactorWeights(config);
  const base = normalizeFactorWeights(config);
  const adjusted = {};
  for (const key of FACTOR_KEYS) {
    const stats = factorStats[key] || {};
    const samples = numeric(stats.count);
    const profitFactor = numeric(stats.profitFactor, 1);
    const expectancy = numeric(stats.expectancyUsdt, numeric(stats.expectancy));
    const sampleWeight = bounded(samples / numeric(config.v19LearningFullWeightTrades, 100), 0, 1);
    const performanceTilt = bounded((profitFactor - 1) * 0.12 + expectancy * 0.02, -0.15, 0.15) * sampleWeight;
    adjusted[key] = Math.max(0.02, base[key] * (1 + performanceTilt));
  }
  return normalizeFactorWeights(config, adjusted);
}

function summarizeFactorScores(factors = {}) {
  return Object.fromEntries(FACTOR_KEYS.map((key) => [key, factors[key] ? round(factors[key].score, 4) : 50]));
}

function combineFactorScores(config = {}, factors = {}, strategyScore = 50, weights = normalizeFactorWeights(config)) {
  const enriched = {
    ...factors,
    strategy: {
      score: clampScore(strategyScore),
      state: "STRATEGY_SIGNAL",
      reasons: [`strategy layer confidence ${round(strategyScore, 2)}`],
    },
  };
  let weighted = 0;
  let total = 0;
  for (const key of FACTOR_KEYS) {
    const factorScore = clampScore(enriched[key] ? enriched[key].score : 50);
    const noCollapseScore = Math.max(factorScore, numeric(config.v19SingleFactorConfidenceFloor, 18));
    const weight = numeric(weights[key]);
    weighted += noCollapseScore * weight;
    total += weight;
  }
  return {
    confidence: clampScore(total > 0 ? weighted / total : strategyScore),
    weights,
    scores: summarizeFactorScores(enriched),
  };
}

function factorSummaryFromTrade(trade = {}) {
  return trade.quantFactorScores || (trade.quantIntelligence && trade.quantIntelligence.factorScores) || trade.factorScores || null;
}

function summarizeFactorTrades(trades = []) {
  const byFactor = Object.fromEntries(FACTOR_KEYS.map((key) => [key, { trades: 0, positiveBiasTrades: 0, netProfitUsdt: 0, wins: 0, losses: 0, grossWin: 0, grossLoss: 0, returns: [] }]));
  for (const trade of trades) {
    const scores = factorSummaryFromTrade(trade);
    if (!scores) continue;
    const pnl = numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt, numeric(trade.realizedPnlUsdt)));
    for (const key of FACTOR_KEYS) {
      const score = numeric(scores[key], 50);
      const bucket = byFactor[key];
      bucket.trades += 1;
      if (score >= 55) bucket.positiveBiasTrades += 1;
      const contribution = pnl * bounded(Math.abs(score - 50) / 50, 0.05, 1);
      bucket.netProfitUsdt += contribution;
      bucket.returns.push(contribution);
      if (contribution > 0) {
        bucket.wins += 1;
        bucket.grossWin += contribution;
      } else if (contribution < 0) {
        bucket.losses += 1;
        bucket.grossLoss += Math.abs(contribution);
      }
    }
  }
  return Object.fromEntries(Object.entries(byFactor).map(([key, bucket]) => {
    const average = bucket.returns.length ? bucket.returns.reduce((sum, value) => sum + value, 0) / bucket.returns.length : 0;
    const variance = bucket.returns.length ? bucket.returns.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / bucket.returns.length : 0;
    const downside = bucket.returns.filter((value) => value < 0);
    const downsideVariance = downside.length ? downside.reduce((sum, value) => sum + Math.pow(value, 2), 0) / downside.length : 0;
    return [key, {
      trades: bucket.trades,
      positiveBiasTrades: bucket.positiveBiasTrades,
      netProfitUsdt: round(bucket.netProfitUsdt, 6),
      profitFactor: bucket.grossLoss > 0 ? round(bucket.grossWin / bucket.grossLoss, 4) : bucket.grossWin > 0 ? 999 : 0,
      winRatePct: bucket.trades ? round((bucket.wins / bucket.trades) * 100, 2) : 0,
      sharpe: variance > 0 ? round(average / Math.sqrt(variance), 4) : 0,
      sortino: downsideVariance > 0 ? round(average / Math.sqrt(downsideVariance), 4) : 0,
      drawdownProxyUsdt: round(bucket.grossLoss, 6),
    }];
  }));
}

function rollingWalkForwardFactorValidation(trades = [], window = 50) {
  const windows = [];
  for (let index = 0; index < trades.length; index += window) {
    const slice = trades.slice(index, index + window);
    if (!slice.length) continue;
    windows.push({
      fromTrade: index,
      toTrade: index + slice.length - 1,
      factorPerformance: summarizeFactorTrades(slice),
    });
  }
  return windows;
}

class QuantIntelligenceEngine {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
  }

  evaluate({ side, strategySignal = {}, analyses = {}, marketProfile = {}, marketData = {}, factorStats = {} } = {}) {
    const direction = side || strategySignal.direction || "LONG";
    const strategyScore = clampScore(numeric(strategySignal.confidence, numeric(strategySignal.rawConfidence, 50)));
    const factors = {
      funding: scoreFunding(this.config, direction, marketData),
      openInterest: scoreOpenInterest(this.config, direction, marketData, analyses),
      trend: scoreTrend(this.config, direction, analyses),
      volume: scoreVolume(this.config, direction, analyses),
      volatility: scoreVolatility(this.config, analyses),
      regime: scoreRegime(this.config, direction, analyses, marketProfile),
    };
    const weights = learnedFactorWeights(this.config, factorStats);
    const combined = combineFactorScores(this.config, factors, strategyScore, weights);
    const confidence = combined.confidence;
    const capitalTargetUsdt = capitalTargetForQuantConfidence(this.config, confidence);
    const result = {
      engine: "V19_QUANT_INTELLIGENCE_ENGINE",
      side: direction,
      confidence,
      capitalTargetUsdt,
      factorScores: combined.scores,
      factorWeights: combined.weights,
      factors,
      funding: factors.funding,
      openInterest: factors.openInterest,
      volume: factors.volume,
      volatility: factors.volatility,
      trend: factors.trend,
      regime: factors.regime,
      expectedHoldingTimeSeconds: numeric(strategySignal.preferredHoldingTimeSeconds, 6 * 60 * 60),
      reasons: FACTOR_KEYS.flatMap((key) => {
        if (key === "strategy") return [`strategy score ${strategyScore}`];
        return factors[key] ? factors[key].reasons : [];
      }),
    };
    this.log("DEBUG", "V19_QUANT_INTELLIGENCE_EVALUATED", {
      side: direction,
      confidence,
      capitalTargetUsdt,
      funding: factors.funding.state,
      openInterest: factors.openInterest.pattern,
      trend: factors.trend.state,
      volume: factors.volume.state,
      volatility: factors.volatility.state,
      regime: factors.regime.regime,
      factorScores: combined.scores,
      factorWeights: combined.weights,
    });
    return result;
  }
}

module.exports = {
  QuantIntelligenceEngine,
  FACTOR_KEYS,
  capitalTargetForQuantConfidence,
  classifyQuantRegime,
  combineFactorScores,
  learnedFactorWeights,
  normalizeFactorWeights,
  rollingWalkForwardFactorValidation,
  scoreFunding,
  scoreOpenInterest,
  scoreRegime,
  scoreTrend,
  scoreVolatility,
  scoreVolume,
  summarizeFactorTrades,
};
