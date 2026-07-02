"use strict";

const { analyzeCandles, emaDirection, parseCandles } = require("./indicators");
const { marketRegimeV2, sessionProfile } = require("./marketRegime");
const { setupTypeFromSignal } = require("./adaptiveEngine");

const TREND_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampScore(value) {
  return Number(bounded(value, 0, 100).toFixed(2));
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function mapLimited(items, concurrency, operation) {
  const output = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      output[current] = await operation(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output.filter(Boolean);
}

function directionForSide(side) {
  return side === "LONG" ? "UP" : "DOWN";
}

function oppositeForSide(side) {
  return side === "LONG" ? "DOWN" : "UP";
}

function directedMomentum(side, analysis) {
  return side === "LONG" ? numeric(analysis && analysis.momentumPct) : -numeric(analysis && analysis.momentumPct);
}

function aligned(direction, expected) {
  if (direction === expected) return 1;
  if (direction === "CHOPPY") return 0.35;
  return -0.8;
}

function trendStructure(side, analysis) {
  if (!analysis) return false;
  if (![analysis.ema9, analysis.ema21, analysis.ema50].every(Number.isFinite)) return false;
  return side === "LONG"
    ? analysis.ema9 > analysis.ema21 && analysis.ema21 > analysis.ema50
    : analysis.ema9 < analysis.ema21 && analysis.ema21 < analysis.ema50;
}

function breakoutForSide(side, analysis) {
  if (!analysis) return false;
  return side === "LONG" ? Boolean(analysis.breakout) : Boolean(analysis.breakdown);
}

function bodyForSide(side, analysis) {
  if (!analysis) return false;
  return analysis.bodyDirection === directionForSide(side) && numeric(analysis.bodyStrength) >= 0.48;
}

function movingInSide(side, analysis) {
  return directedMomentum(side, analysis) > 0;
}

function trendThesisKey(signal = {}) {
  return [
    signal.symbol,
    signal.side,
    signal.continuationSetupType || signal.setupType || "TREND_THESIS",
    signal.trend15m,
    signal.trend1h,
    signal.trend4h,
    signal.macroTrend,
  ].join(":");
}

function qualityTier(config, score) {
  if (score >= config.trendPortfolioEliteScore) return "ELITE";
  if (score >= config.trendPortfolioStrongScore) return "STRONG";
  if (score >= config.trendPortfolioNormalScore) return "NORMAL";
  return "REJECT";
}

function portfolioBreadth(side, directions = {}) {
  const expected = directionForSide(side);
  const opposite = oppositeForSide(side);
  const values = TREND_SYMBOLS.map((symbol) => directions[symbol] || "CHOPPY");
  const alignedCount = values.filter((direction) => direction === expected).length;
  const conflictCount = values.filter((direction) => direction === opposite).length;
  const neutralCount = values.filter((direction) => direction === "CHOPPY").length;
  const score = bounded(50 + alignedCount * 16 - conflictCount * 20 - neutralCount * 4 + (alignedCount === 3 ? 10 : 0), 0, 100);
  return {
    score: Number(score.toFixed(2)),
    alignedCount,
    conflictCount,
    neutralCount,
    allAligned: alignedCount === 3,
    directions: Object.fromEntries(TREND_SYMBOLS.map((symbol, index) => [symbol, values[index]])),
  };
}

class TrendPortfolioEngine {
  constructor(config, client, log, adaptive = null) {
    this.config = config;
    this.client = client;
    this.log = log;
    this.adaptive = adaptive;
    this.focusUniverseLogged = false;
    this.scanErrors = 0;
    this.cachedDirections = Object.fromEntries(TREND_SYMBOLS.map((symbol) => [symbol, "CHOPPY"]));
  }

  async universe() {
    if (!this.focusUniverseLogged) {
      this.log("WARN", "V14_TREND_PORTFOLIO_ENGINE_ACTIVE", {
        symbols: TREND_SYMBOLS,
        engine: "independent trend-following thesis engine",
        scalpDecisionLogicReused: false,
        maximizeNetProfitAfterFees: true,
      });
      this.log("INFO", "V14_TRADING_UNIVERSE_LOCKED", {
        allowedSymbols: TREND_SYMBOLS,
        removedSymbols: "all symbols outside BTCUSDT, ETHUSDT, SOLUSDT",
      });
      this.focusUniverseLogged = true;
    }
    const allSymbols = await this.client.getSymbols();
    const tickers = (await Promise.all(TREND_SYMBOLS.map((symbol) => this.client.getTicker(symbol)))).filter(Boolean);
    const tickersBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
    const accepted = [];
    const rejected = { outsideFocus: 0, contract: 0, marketData: 0, volume: 0, spread: 0 };
    for (const info of allSymbols) {
      if (!TREND_SYMBOLS.includes(info.symbol)) {
        rejected.outsideFocus += 1;
        continue;
      }
      const ticker = tickersBySymbol.get(info.symbol);
      const perpetual = info.contractType === "LinearPerpetual";
      if (!perpetual || info.status !== "Trading" || info.settleCoin !== "USDT") {
        rejected.contract += 1;
        continue;
      }
      const price = Number(ticker && ticker.lastPrice);
      const volume = Number(ticker && ticker.turnover24h);
      const bid = Number(ticker && ticker.bid1Price);
      const ask = Number(ticker && ticker.ask1Price);
      if (![price, volume, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= 0) {
        rejected.marketData += 1;
        continue;
      }
      const spreadPct = ((ask - bid) / ((ask + bid) / 2)) * 100;
      if (volume < this.config.min24hVolumeUsdt) {
        rejected.volume += 1;
        continue;
      }
      if (spreadPct > this.config.maxSpreadPct) {
        rejected.spread += 1;
        continue;
      }
      accepted.push({ info, price, volume, spreadPct });
    }
    accepted.sort((left, right) => TREND_SYMBOLS.indexOf(left.info.symbol) - TREND_SYMBOLS.indexOf(right.info.symbol));
    if (typeof this.client.subscribeTickers === "function") {
      this.client.subscribeTickers(accepted.map((item) => item.info.symbol));
    }
    this.log("INFO", "V14_TREND_UNIVERSE_PREPARED", {
      eligible: accepted.length,
      analyzing: accepted.length,
      rejected,
      maxDeployableCapitalUsdt: this.config.maxDeployableCapitalUsdt,
      maxPositionsPerSymbol: this.config.maxPositionsPerSymbol,
    });
    return accepted;
  }

  async candleSet(symbol) {
    const [entryRaw, confirmationRaw, trendRaw, macroRaw, macroLongRaw] = await Promise.all([
      this.client.getKlines(symbol, this.config.candleIntervalFast, 90),
      this.client.getKlines(symbol, this.config.candleIntervalMain, 90),
      this.client.getKlines(symbol, this.config.candleIntervalTrend, 90),
      this.client.getKlines(symbol, this.config.candleIntervalMacro, 90),
      this.client.getKlines(symbol, this.config.candleIntervalMacroLong, 90),
    ]);
    return {
      entry: analyzeCandles(parseCandles(entryRaw), 55),
      confirmation: analyzeCandles(parseCandles(confirmationRaw), 55),
      trend: analyzeCandles(parseCandles(trendRaw), 55),
      macro: analyzeCandles(parseCandles(macroRaw), 55),
      macroLong: analyzeCandles(parseCandles(macroLongRaw), 55),
    };
  }

  trendDirections(analyses) {
    return {
      entry15m: emaDirection(analyses.entry),
      confirmation1h: emaDirection(analyses.confirmation),
      trend4h: emaDirection(analyses.trend),
      macro1d: emaDirection(analyses.macro),
      macroLong: emaDirection(analyses.macroLong),
    };
  }

  scoreSide(side, item, analyses, marketProfile) {
    const expected = directionForSide(side);
    const opposite = oppositeForSide(side);
    const directions = this.trendDirections(analyses);
    const mtfRaw =
      aligned(directions.entry15m, expected) * 18 +
      aligned(directions.confirmation1h, expected) * 25 +
      aligned(directions.trend4h, expected) * 34 +
      aligned(directions.macro1d, expected) * 18 +
      aligned(directions.macroLong, expected) * 5;
    const allAligned = Object.values(directions).every((direction) => direction === expected);
    const trendAndMacroOpposite = directions.trend4h === opposite && directions.macro1d === opposite;
    const macroOpposite = directions.macro1d === opposite || directions.macroLong === opposite;
    const mtfScore = clampScore(mtfRaw + (allAligned ? 8 : 0) - (trendAndMacroOpposite ? this.config.trendPortfolioMacroOppositionPenalty : macroOpposite ? 12 : 0));

    const confirmationTrend = trendStructure(side, analyses.confirmation);
    const htfTrend = trendStructure(side, analyses.trend);
    const macroTrend = trendStructure(side, analyses.macro);
    const momentum15m = directedMomentum(side, analyses.entry);
    const momentum1h = directedMomentum(side, analyses.confirmation);
    const momentum4h = directedMomentum(side, analyses.trend);
    const continuationMomentum = momentum15m > 0 && momentum1h > 0;
    const momentumPersistenceCandles = Math.max(
      side === "LONG" ? analyses.entry.upMomentumCandles : analyses.entry.downMomentumCandles,
      side === "LONG" ? analyses.confirmation.upMomentumCandles : analyses.confirmation.downMomentumCandles,
      side === "LONG" ? analyses.trend.upMomentumCandles : analyses.trend.downMomentumCandles
    );
    const volumeSpike = Math.max(analyses.entry.volumeSpike, analyses.confirmation.volumeSpike, analyses.trend.volumeSpike);
    const rangeExpansion = Math.max(analyses.entry.rangeExpansion, analyses.confirmation.rangeExpansion, analyses.trend.rangeExpansion);
    const breakoutContinuation = breakoutForSide(side, analyses.entry) || breakoutForSide(side, analyses.confirmation) || breakoutForSide(side, analyses.trend);
    const volatilityExpansion = Math.max(analyses.entry.atrPct, analyses.confirmation.atrPct, analyses.trend.atrPct);
    const directionalBody = bodyForSide(side, analyses.entry) || bodyForSide(side, analyses.confirmation);
    const breadth = portfolioBreadth(side, {
      ...this.cachedDirections,
      [item.info.symbol]: directions.confirmation1h,
    });

    let score = 0;
    const scoreBreakdown = [];
    const add = (label, points) => {
      score += points;
      scoreBreakdown.push(`${label} ${points >= 0 ? "+" : ""}${Number(points.toFixed ? points.toFixed(2) : points)}`);
    };
    add("HTF trend thesis alignment", mtfScore * 0.42);
    if (confirmationTrend) add("1h trend structure healthy", 10);
    if (htfTrend) add("4h trend direction healthy", 15);
    if (macroTrend) add("daily macro bias supportive", 8);
    if (continuationMomentum) add("momentum continuation", 10);
    if (momentum4h > 0) add("4h trend persistence", 7);
    if (momentumPersistenceCandles >= 3) add("multi-candle persistence", 7);
    if (volumeSpike >= this.config.minVolumeSpike + 0.35) add("volume confirmation", 9);
    else if (volumeSpike >= this.config.minVolumeSpike) add("early volume confirmation", 5);
    if (rangeExpansion >= this.config.minRangeExpansion) add("volatility/range expansion", 7);
    if (breakoutContinuation) add("breakout continuation structure", 9);
    if (directionalBody) add("directional candle body", 5);
    if (breadth.allAligned) add("BTC/ETH/SOL portfolio alignment", 7);
    else if (breadth.conflictCount >= 2) add("portfolio trend conflict", -10);
    if (marketProfile && Array.isArray(marketProfile.tags) && marketProfile.tags.includes("SIDEWAYS_CHOP_MARKET")) add("market chop patience penalty", -8);
    if (trendAndMacroOpposite) add("4h plus daily opposition", -this.config.trendPortfolioMacroOppositionPenalty);
    else if (macroOpposite) add("daily macro opposition", -12);

    const roundTripFeePct = this.config.estimatedFeePctPerSide * 2;
    const estimatedRoundTripCostPct = roundTripFeePct + this.config.estimatedSlippagePct + item.spreadPct;
    const expectedMovePct = Math.max(
      this.config.takeProfitPct,
      this.config.minExpectedMovePct,
      analyses.confirmation.atrPct * this.config.trendPortfolioExpectedMoveAtrMultiplier,
      analyses.trend.atrPct * (this.config.trendPortfolioExpectedMoveAtrMultiplier * 0.72),
      Math.abs(momentum1h) * 2.8,
      Math.abs(momentum4h) * 1.8
    );
    const feeEdgeRatio = estimatedRoundTripCostPct > 0 ? expectedMovePct / estimatedRoundTripCostPct : 999;
    const probability = bounded(
      0.32 +
        mtfScore / 280 +
        (confirmationTrend ? 0.05 : 0) +
        (htfTrend ? 0.07 : 0) +
        (continuationMomentum ? 0.05 : 0) +
        (volumeSpike >= this.config.minVolumeSpike ? 0.04 : 0) +
        (breakoutContinuation ? 0.04 : 0) -
        (macroOpposite ? 0.08 : 0),
      0.18,
      0.82
    );
    const projectedNetEdgePct = Number((expectedMovePct - estimatedRoundTripCostPct).toFixed(4));
    const smartProjectedNetEdgePct = Number((expectedMovePct * probability - estimatedRoundTripCostPct * this.config.smartEdgeCostBufferMultiplier).toFixed(4));
    if (projectedNetEdgePct >= this.config.trendPortfolioMinNetEdgePct && feeEdgeRatio >= this.config.trendPortfolioMinRewardCostRatio) {
      add("post-cost trend edge validated", 8);
    } else {
      add("post-cost edge insufficient", -14);
    }

    let finalScore = clampScore(score);
    const rejected = [];
    if (mtfScore < 48) rejected.push(`trend thesis too weak: MTF score ${mtfScore}`);
    if (trendAndMacroOpposite) rejected.push("4h and daily trend oppose entry thesis");
    if (!confirmationTrend && !htfTrend) rejected.push("no complete 1h/4h trend structure");
    if (!continuationMomentum && !breakoutContinuation) rejected.push("no momentum continuation or breakout continuation");
    if (volumeSpike < this.config.minVolumeSpike * 0.8) rejected.push("volume confirmation too weak for swing thesis");
    if (projectedNetEdgePct < this.config.trendPortfolioMinNetEdgePct) rejected.push(`projected net edge ${projectedNetEdgePct}% below V14 minimum`);
    if (feeEdgeRatio < this.config.trendPortfolioMinRewardCostRatio) rejected.push(`reward/cost ${feeEdgeRatio.toFixed(2)} below V14 minimum`);

    const adaptive = this.applyAdaptiveGuidance({
      symbol: item.info.symbol,
      side,
      score: finalScore,
      rejected,
      setupType: breakoutContinuation ? "TREND_BREAKOUT_CONTINUATION" : "TREND_MOMENTUM_CONTINUATION",
      continuationSetupType: breakoutContinuation ? "BREAKOUT_CONTINUATION" : "MOMENTUM_CONTINUATION",
    });
    finalScore = clampScore(finalScore + adaptive.scoreAdjustment);
    const tier = rejected.length ? "REJECT" : qualityTier(this.config, finalScore);
    const eligible = tier !== "REJECT" && finalScore >= this.config.trendPortfolioMinScore;
    const signal = {
      symbol: item.info.symbol,
      info: item.info,
      side,
      price: item.price,
      score: finalScore,
      baseScore: finalScore,
      requiredScore: this.config.trendPortfolioMinScore,
      requiredConvictionScore: this.config.trendPortfolioMinScore,
      convictionScore: finalScore,
      technicalConvictionScore: finalScore,
      adaptiveConfidence: adaptive.confidence,
      adaptiveScoreAdjustment: adaptive.scoreAdjustment,
      adaptiveRiskMultiplier: adaptive.riskMultiplier,
      adaptiveLeverageMultiplier: adaptive.leverageMultiplier,
      adaptivePolicyMode: adaptive.policyMode,
      adaptiveReasons: adaptive.reasons,
      rejected,
      eligible,
      tradeQualityTier: tier,
      scannerQualityTier: tier,
      qualityTier: tier,
      profitQualityTier: tier,
      tradeQualification: {
        tier,
        category: eligible ? "ACCEPTED" : "TREND_THESIS_REJECTED",
        reason: eligible ? "V14 complete trend thesis accepted" : rejected[0] || "V14 trend score below threshold",
        assignedBy: "trendPortfolioEngine.js",
        scalpDecisionLogicReused: false,
      },
      tradeQualityAssignedBy: "trendPortfolioEngine.js",
      rejectionCategory: eligible ? "ACCEPTED" : "TREND_THESIS",
      rejectionReason: eligible ? null : rejected[0] || "V14 trend score below threshold",
      setupType: breakoutContinuation ? "TREND_BREAKOUT_CONTINUATION" : "TREND_MOMENTUM_CONTINUATION",
      tradeCategory: tier === "ELITE" ? "ELITE_SETUP" : "TREND_PORTFOLIO",
      explorationTrade: false,
      forcedMarketSampling: false,
      eliteSetup: tier === "ELITE",
      highQualityContinuation: tier === "STRONG" || tier === "ELITE",
      eliteContinuationCandidate: tier === "ELITE",
      continuationStrength: Number(bounded(mtfScore * 0.55 + Math.max(0, momentum1h) * 4 + Math.max(0, momentum4h) * 2 + (breakoutContinuation ? 12 : 0), 0, 100).toFixed(2)),
      continuationSetupType: breakoutContinuation ? "BREAKOUT_CONTINUATION" : "MOMENTUM_CONTINUATION",
      continuationComponents: {
        confirmationTrend,
        htfTrend,
        macroTrend,
        continuationMomentum,
        momentum4hPositive: momentum4h > 0,
        breakoutContinuation,
        volumeSpike: Number(volumeSpike.toFixed(3)),
        rangeExpansion: Number(rangeExpansion.toFixed(3)),
      },
      continuationBreakout: breakoutContinuation,
      pullbackContinuation: !breakoutContinuation && confirmationTrend && htfTrend && continuationMomentum,
      breakoutRetest: breakoutContinuation && confirmationTrend,
      momentumResumption: continuationMomentum,
      trendAcceleration: momentum15m > momentum1h && continuationMomentum,
      trendThesis: {
        key: null,
        expected,
        directions,
        mtfScore,
        thesis: eligible ? "HTF trend alignment with post-cost edge" : "No qualified swing thesis",
        holdingIntent: "2h to multiple days while trend remains valid",
      },
      trendThesisKey: null,
      swingSignalFingerprint: null,
      trend15m: directions.entry15m,
      trend5m: directions.entry15m,
      trend1h: directions.confirmation1h,
      trend4h: directions.trend4h,
      macroTrend: directions.macro1d,
      macroAligned: directions.macro1d === expected,
      macroContradicts: macroOpposite,
      multiTimeframeAligned: mtfScore >= 70,
      multiTimeframeTrendScore: mtfScore,
      multiTimeframeDirections: directions,
      multiTimeframeAllAligned: allAligned,
      multiTimeframeTrendAndMacroOpposite: trendAndMacroOpposite,
      multiTimeframeMacroOpposite: macroOpposite,
      marketBreadthScore: breadth.score,
      marketBreadthDirections: breadth.directions,
      marketBreadthAlignedCount: breadth.alignedCount,
      marketBreadthConflictCount: breadth.conflictCount,
      portfolioAlphaScore: breadth.score,
      portfolioAlphaAlignedCount: breadth.alignedCount,
      portfolioAlphaConflictCount: breadth.conflictCount,
      btcTrendScore: breadth.directions.BTCUSDT === expected ? 100 : breadth.directions.BTCUSDT === opposite ? 0 : 50,
      ethTrendScore: breadth.directions.ETHUSDT === expected ? 100 : breadth.directions.ETHUSDT === opposite ? 0 : 50,
      solTrendScore: breadth.directions.SOLUSDT === expected ? 100 : breadth.directions.SOLUSDT === opposite ? 0 : 50,
      btcTrendAligned: breadth.directions.BTCUSDT === expected,
      btcTrend: breadth.directions.BTCUSDT,
      ethTrend: breadth.directions.ETHUSDT,
      rsi: analyses.confirmation.rsi14,
      atrPct: Math.max(analyses.confirmation.atrPct, analyses.trend.atrPct),
      entryMomentumPct: momentum15m,
      momentum1mPct: momentum15m,
      momentum5mPct: momentum1h,
      momentum4hPct: momentum4h,
      momentumPersistenceCandles,
      volumeSpike,
      volumeCondition: volumeSpike >= this.config.minVolumeSpike + 0.35 ? "STRONG_VOLUME_SPIKE" : volumeSpike >= this.config.minVolumeSpike ? "CONFIRMED_VOLUME" : "LOW_VOLUME",
      volatilityRegime: volatilityExpansion >= this.config.highVolatilityAtrPct ? "HIGH_VOLATILITY" : volatilityExpansion < 0.12 ? "LOW_VOLATILITY" : "NORMAL",
      spreadPct: item.spreadPct,
      liquidityScore: Number(bounded(80 - item.spreadPct * 80 + Math.min(18, Math.log10(Math.max(1, item.volume / this.config.min24hVolumeUsdt)) * 8), 0, 100).toFixed(2)),
      trendQualityScore: Number(bounded(mtfScore * 0.55 + (confirmationTrend ? 12 : 0) + (htfTrend ? 16 : 0) + (volumeSpike >= this.config.minVolumeSpike ? 8 : 0), 0, 100).toFixed(2)),
      antiChopScore: marketProfile && Array.isArray(marketProfile.tags) && marketProfile.tags.includes("SIDEWAYS_CHOP_MARKET") ? 1 : 0,
      expectedMovePct: Number(expectedMovePct.toFixed(4)),
      takeProfitDistancePct: Number(expectedMovePct.toFixed(4)),
      stopDistancePct: Math.max(this.config.stopLossPct, Number((volatilityExpansion * this.config.trendPortfolioStopAtrMultiplier).toFixed(4))),
      estimatedRoundTripCostPct,
      projectedNetEdgePct,
      smartProjectedNetEdgePct,
      feeEdgeRatio: Number(feeEdgeRatio.toFixed(4)),
      roundTripFeePct,
      estimatedSlippagePct: this.config.estimatedSlippagePct,
      estimatedTpProbability: Number(probability.toFixed(3)),
      executionType: breakoutContinuation && tier === "ELITE" ? "MARKET_TAKER" : "POST_ONLY_LIMIT",
      intendedExecutionType: breakoutContinuation && tier === "ELITE" ? "MARKET_TAKER" : "POST_ONLY_LIMIT",
      marketRegimeType: marketProfile && marketProfile.primary,
      marketRegimeTags: marketProfile && marketProfile.tags,
      marketRegimeConfidence: marketProfile && marketProfile.confidence,
      marketRegimeReasons: marketProfile && marketProfile.reasons,
      marketRegimeV2: marketRegimeV2(this.config, marketProfile, {
        atrPct: volatilityExpansion,
        volatilityRegime: volatilityExpansion >= this.config.highVolatilityAtrPct ? "HIGH_VOLATILITY" : "NORMAL",
        breakSignal: breakoutContinuation,
        volumeSpike,
        multiTimeframeTrendScore: mtfScore,
        btcContradictsSide: breadth.directions.BTCUSDT === opposite,
        supportsTrend: confirmationTrend || htfTrend,
      }).regime,
      marketPersonality: "TREND_PORTFOLIO",
      regime: marketProfile && marketProfile.direction,
      regimeAggressionMultiplier: 1,
      regimeRiskMultiplier: 1,
      regimeLeverageMultiplier: 1,
      regimeHoldMultiplier: 1.4,
      regimeTrailingDistanceMultiplier: 1.4,
      sessionType: sessionProfile().session,
      sessionRegime: sessionProfile().sessionRegime,
      sessionHourUtc: sessionProfile().hourUtc,
      scoreBreakdown,
      reasons: scoreBreakdown,
      trendPortfolioMode: true,
      microBreakoutTriggered: false,
      fomoTrigger: false,
      fastMode: false,
    };
    signal.trendThesis.key = trendThesisKey(signal);
    signal.trendThesisKey = signal.trendThesis.key;
    signal.swingSignalFingerprint = signal.trendThesis.key;
    signal.eliteConditionKey = signal.trendThesis.key;
    if (!signal.setupType) signal.setupType = setupTypeFromSignal(signal);
    return signal;
  }

  applyAdaptiveGuidance(signal) {
    if (!this.adaptive || !this.config.adaptiveLearningEnabled) {
      return {
        confidence: 50,
        scoreAdjustment: 0,
        riskMultiplier: 1,
        leverageMultiplier: 1,
        policyMode: "DISABLED",
        reasons: ["adaptive learning disabled"],
      };
    }
    try {
      const adaptation = this.adaptive.evaluateSignal({
        ...signal,
        tradeCategory: "TREND_PORTFOLIO",
        explorationTrade: false,
      });
      return {
        confidence: numeric(adaptation.confidence, 50),
        scoreAdjustment: bounded(numeric(adaptation.scoreAdjustment), -8, 8),
        riskMultiplier: numeric(adaptation.riskMultiplier, 1),
        leverageMultiplier: numeric(adaptation.leverageMultiplier, 1),
        policyMode: adaptation.policy && adaptation.policy.mode,
        reasons: adaptation.reasons || [],
      };
    } catch (error) {
      this.log("WARN", "V14 adaptive guidance unavailable; trend thesis continues with neutral memory.", {
        error: error.message,
        symbol: signal.symbol,
      });
      return {
        confidence: 50,
        scoreAdjustment: 0,
        riskMultiplier: 1,
        leverageMultiplier: 1,
        policyMode: "NEUTRAL_FALLBACK",
        reasons: ["adaptive memory fallback neutralized after evaluation error"],
      };
    }
  }

  async analyzeSymbol(item, marketProfile) {
    try {
      const analyses = await this.candleSet(item.info.symbol);
      if (!analyses.entry || !analyses.confirmation || !analyses.trend || !analyses.macro || !analyses.macroLong) {
        this.log("DEBUG", "V14 symbol rejected: insufficient HTF candle history.", { symbol: item.info.symbol });
        return null;
      }
      this.cachedDirections[item.info.symbol] = emaDirection(analyses.confirmation);
      const longSignal = this.config.allowLongs ? this.scoreSide("LONG", item, analyses, marketProfile) : null;
      const shortSignal = this.config.allowShorts ? this.scoreSide("SHORT", item, analyses, marketProfile) : null;
      return [longSignal, shortSignal].filter(Boolean).sort((left, right) => right.score - left.score)[0] || null;
    } catch (error) {
      this.scanErrors += 1;
      this.log("WARN", "V14 symbol rejected because trend candles could not be read.", {
        symbol: item.info.symbol,
        error: error.message,
      });
      return null;
    }
  }

  async scan(marketProfile = null) {
    this.scanErrors = 0;
    const market = marketProfile || { direction: "CHOPPY", tags: [], primary: "UNKNOWN", confidence: 0 };
    const universe = await this.universe();
    const analyses = await mapLimited(universe, this.config.scanConcurrency, (item) => this.analyzeSymbol(item, market));
    analyses.sort((left, right) => right.score - left.score || right.continuationStrength - left.continuationStrength);
    const candidates = analyses.filter((item) => item.eligible);
    for (const item of analyses) {
      this.log(item.eligible ? "INFO" : "DEBUG", item.eligible ? "V14 trend thesis accepted." : "V14 trend thesis rejected.", {
        symbol: item.symbol,
        side: item.side,
        score: item.score,
        requiredScore: item.requiredScore,
        qualityTier: item.tradeQualityTier,
        trendThesis: item.trendThesis,
        setupType: item.setupType,
        continuationStrength: item.continuationStrength,
        expectedMovePct: item.expectedMovePct,
        projectedNetEdgePct: item.projectedNetEdgePct,
        smartProjectedNetEdgePct: item.smartProjectedNetEdgePct,
        feeEdgeRatio: item.feeEdgeRatio,
        estimatedTpProbability: item.estimatedTpProbability,
        rejected: item.rejected,
        scoreBreakdown: item.scoreBreakdown,
        scalpDecisionLogicReused: false,
      });
    }
    this.log("INFO", "V14_TREND_PORTFOLIO_SCAN_COMPLETED", {
      analyzed: analyses.length,
      candidates: candidates.length,
      rejected: analyses.length - candidates.length,
      marketRegimeType: market.primary,
      marketRegimeTags: market.tags,
      maxDeployableCapitalUsdt: this.config.maxDeployableCapitalUsdt,
      objective: "maximize net profit after fees, not trade count",
      apiErrors: this.scanErrors,
    });
    return {
      regime: market.direction,
      marketProfile: market,
      analyses,
      candidates,
      participationMetrics: {
        totalCandidates: analyses.length,
        acceptedCandidates: candidates.length,
        rejectedCandidates: analyses.length - candidates.length,
        rejectionCountsByCategory: analyses.reduce((acc, item) => {
          const key = item.rejectionCategory || "UNKNOWN";
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
        qualityTiers: analyses.reduce((acc, item) => {
          const key = item.tradeQualityTier || "UNCLASSIFIED";
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
        explorationTradesAccepted: 0,
      },
      nearMisses: [],
      hadApiErrors: this.scanErrors > 0,
    };
  }

  async analysisForPosition(position, marketProfile = null) {
    const ticker = await this.client.getTicker(position.symbol);
    if (!ticker) return null;
    const symbols = await this.client.getSymbols();
    const info = symbols.find((item) => item.symbol === position.symbol) || { symbol: position.symbol };
    const bid = Number(ticker.bid1Price);
    const ask = Number(ticker.ask1Price);
    const price = Number(ticker.lastPrice);
    const spreadPct = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
      ? ((ask - bid) / ((ask + bid) / 2)) * 100
      : 0;
    const item = {
      info,
      price,
      volume: Number(ticker.turnover24h || 0),
      spreadPct,
    };
    const analyses = await this.candleSet(position.symbol);
    if (!analyses.entry || !analyses.confirmation || !analyses.trend || !analyses.macro || !analyses.macroLong) return null;
    return this.scoreSide(position.side, item, analyses, marketProfile || { direction: "CHOPPY", tags: [] });
  }
}

module.exports = { TrendPortfolioEngine, TREND_SYMBOLS, trendThesisKey };
