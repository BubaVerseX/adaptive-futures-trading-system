"use strict";

const { analyzeCandles, emaDirection, parseCandles } = require("./indicators");
const { marketRegimeV2, sessionProfile } = require("./marketRegime");
const { setupTypeFromSignal } = require("./adaptiveEngine");
const { PortfolioDecisionEngine } = require("./portfolioDecisionEngine");

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
    this.portfolioDecision = new PortfolioDecisionEngine(config, log);
    this.multiStrategyEnabled = Boolean(config.multiStrategyPortfolioEngineEnabled || config.trendPortfolioMode);
    this.activeOpportunityMode = Boolean((config.activeOpportunityMode || config.trendPortfolioMode) && this.multiStrategyEnabled);
    this.quantResearchPlatformMode = Boolean(config.quantResearchPlatformMode || config.trendPortfolioMode);
  }

  async universe() {
    if (!this.focusUniverseLogged) {
      this.log("WARN", "V14_TREND_PORTFOLIO_ENGINE_ACTIVE", {
        symbols: TREND_SYMBOLS,
        engine: "independent trend-following thesis engine",
        scalpDecisionLogicReused: false,
        maximizeNetProfitAfterFees: true,
      });
      this.log("WARN", "V14_1_AGGRESSIVE_MOMENTUM_UPGRADE_ACTIVE", {
        aggressiveMomentumMode: this.config.trendPortfolioAggressiveMomentumMode,
        minScore: this.config.trendPortfolioMinScore,
        normalScore: this.config.trendPortfolioNormalScore,
        highScore: this.config.trendPortfolioStrongScore,
        eliteScore: this.config.trendPortfolioEliteScore,
        minNetEdgePct: this.config.trendPortfolioMinNetEdgePct,
        minRewardCostRatio: this.config.trendPortfolioMinRewardCostRatio,
        objective: "increase emerging-trend participation without returning to scalping",
      });
      this.log("WARN", "V15_MULTI_STRATEGY_PORTFOLIO_ENGINE_ACTIVE", {
        objective: "replace the single trend decision with modular strategy voting",
        strategies: ["TREND_BREAKOUT", "MULTI_TIMEFRAME_TREND", "TREND_PULLBACK"],
        fixedScalpTakeProfitUsed: false,
        publicConceptsOnly: true,
      });
      if (this.quantResearchPlatformMode) {
        this.log("WARN", "V18_QUANT_RESEARCH_PLATFORM_ACTIVE", {
          objective: "modular strategy research layer with independent signals, ranking, allocation, and walk-forward reporting",
          strategyLayerOnly: true,
          executionInfrastructurePreserved: true,
        });
      }
      if (this.activeOpportunityMode) {
        this.log("WARN", "V17_ACTIVE_OPPORTUNITY_MODE_ACTIVE", {
          objective: "allow any qualified strategy module to express an independent several-hour trend thesis",
          unanimousStrategyAgreementRequired: false,
          portfolioRiskControlsPreserved: true,
          symbols: TREND_SYMBOLS,
        });
      }
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
    const entryCandles = parseCandles(entryRaw);
    const confirmationCandles = parseCandles(confirmationRaw);
    const trendCandles = parseCandles(trendRaw);
    const macroCandles = parseCandles(macroRaw);
    const macroLongCandles = parseCandles(macroLongRaw);
    return {
      entry: analyzeCandles(entryCandles, 55),
      confirmation: analyzeCandles(confirmationCandles, 55),
      trend: analyzeCandles(trendCandles, 55),
      macro: analyzeCandles(macroCandles, 55),
      macroLong: analyzeCandles(macroLongCandles, 55),
      entryCandles,
      confirmationCandles,
      trendCandles,
      macroCandles,
      macroLongCandles,
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
    const developingTrend =
      directions.entry15m === expected &&
      directions.confirmation1h === expected &&
      directions.trend4h !== opposite;
    const mtfScore = clampScore(mtfRaw + (allAligned ? 8 : 0) + (developingTrend ? 6 : 0) - (trendAndMacroOpposite ? this.config.trendPortfolioMacroOppositionPenalty : macroOpposite ? 8 : 0));

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
    if (developingTrend) add("early developing trend participation", 8);
    if (directions.entry15m === expected && movingInSide(side, analyses.entry)) add("15m trigger moved with emerging trend", 5);
    if (breadth.allAligned) add("BTC/ETH/SOL portfolio alignment", 7);
    else if (breadth.conflictCount >= 2) add("portfolio trend conflict", -10);
    if (marketProfile && Array.isArray(marketProfile.tags) && marketProfile.tags.includes("SIDEWAYS_CHOP_MARKET")) add("market chop patience penalty", -4);
    if (trendAndMacroOpposite) add("4h plus daily opposition", -this.config.trendPortfolioMacroOppositionPenalty);
    else if (macroOpposite) add("daily macro opposition", -8);

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
      add("post-cost edge insufficient", -8);
    }

    let finalScore = clampScore(score);
    const rejected = [];
    const emergingTrendQualified =
      developingTrend &&
      mtfScore >= 40 &&
      (confirmationTrend || continuationMomentum || breakoutContinuation) &&
      volumeSpike >= this.config.minVolumeSpike * 0.65;
    if (mtfScore < 40 && !emergingTrendQualified) rejected.push(`trend thesis too weak: MTF score ${mtfScore}`);
    if (trendAndMacroOpposite) rejected.push("4h and daily trend oppose entry thesis");
    if (!confirmationTrend && !htfTrend && !emergingTrendQualified) rejected.push("no complete 1h/4h trend structure");
    if (!continuationMomentum && !breakoutContinuation && !(developingTrend && movingInSide(side, analyses.entry))) rejected.push("no momentum continuation or breakout continuation");
    if (volumeSpike < this.config.minVolumeSpike * 0.65) rejected.push("volume confirmation too weak for swing thesis");
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
    const confidenceClass = tier === "ELITE" ? "ELITE" : tier === "STRONG" ? "HIGH" : tier === "NORMAL" ? "STANDARD" : "REJECT";
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
      confidenceClass,
      scannerQualityTier: tier,
      qualityTier: tier,
      profitQualityTier: tier,
      tradeQualification: {
        tier,
        category: eligible ? "ACCEPTED" : "TREND_THESIS_REJECTED",
        reason: eligible ? "V14 complete trend thesis accepted" : rejected[0] || "V14 trend score below threshold",
        assignedBy: "trendPortfolioEngine.js",
        scalpDecisionLogicReused: false,
        earlyTrendParticipation: emergingTrendQualified,
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
        holdingIntent: "2h to 24h preferred; multiple days while trend remains valid",
        earlyTrendParticipation: emergingTrendQualified,
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
      earlyTrendParticipation: emergingTrendQualified,
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

  buildV15PortfolioSignal(item, analyses, marketProfile, options = {}) {
    const decision = options.decision || this.portfolioDecision.evaluate({
      symbol: item.info.symbol,
      price: item.price,
      spreadPct: item.spreadPct,
      volume: item.volume,
      analyses,
      marketProfile,
      strategyPerformanceStats: this.strategyPerformanceStats(),
      onlySide: options.onlySide,
    });
    const side = decision.side || options.onlySide || "LONG";
    const expected = directionForSide(side);
    const opposite = oppositeForSide(side);
    const directions = {
      entry15m: decision.marketRegime.directions.entry,
      confirmation1h: decision.marketRegime.directions.confirmation,
      trend4h: decision.marketRegime.directions.trend,
      macro1d: decision.marketRegime.directions.macro,
      macroLong: decision.marketRegime.directions.macroLong,
    };
    const volumeSpike = Math.max(analyses.entry.volumeSpike, analyses.confirmation.volumeSpike, analyses.trend.volumeSpike);
    const rangeExpansion = Math.max(analyses.entry.rangeExpansion, analyses.confirmation.rangeExpansion, analyses.trend.rangeExpansion);
    const volatilityExpansion = Math.max(analyses.entry.atrPct, analyses.confirmation.atrPct, analyses.trend.atrPct);
    const momentum15m = directedMomentum(side, analyses.entry);
    const momentum1h = directedMomentum(side, analyses.confirmation);
    const momentum4h = directedMomentum(side, analyses.trend);
    const momentumPersistenceCandles = Math.max(
      side === "LONG" ? analyses.entry.upMomentumCandles : analyses.entry.downMomentumCandles,
      side === "LONG" ? analyses.confirmation.upMomentumCandles : analyses.confirmation.downMomentumCandles,
      side === "LONG" ? analyses.trend.upMomentumCandles : analyses.trend.downMomentumCandles
    );
    const breadth = portfolioBreadth(side, {
      ...this.cachedDirections,
      [item.info.symbol]: directions.confirmation1h,
    });
    const baseSignal = {
      symbol: item.info.symbol,
      side,
      score: decision.confidence,
      rejected: decision.rejectionReasons,
      setupType: decision.setupType,
      continuationSetupType: decision.continuationSetupType,
      tradeCategory: decision.qualityTier === "ELITE" ? "ELITE_SETUP" : "V15_MULTI_STRATEGY_PORTFOLIO",
      explorationTrade: false,
    };
    const adaptive = this.applyAdaptiveGuidance(baseSignal);
    const adaptiveConfidenceAdjustment = Math.max(0, adaptive.scoreAdjustment);
    const finalScore = clampScore(decision.confidence + adaptiveConfidenceAdjustment);
    const finalTier = decision.eligible
      ? (decision.qualityTier && decision.qualityTier !== "REJECT" ? decision.qualityTier : qualityTier(this.config, finalScore))
      : "REJECT";
    const eligible = decision.eligible && finalTier !== "REJECT" && finalScore >= this.config.trendPortfolioMinScore;
    const confidenceClass = finalTier === "ELITE" ? "ELITE" : finalTier === "STRONG" ? "HIGH" : finalTier === "NORMAL" ? "STANDARD" : "REJECT";
    const signal = {
      symbol: item.info.symbol,
      info: item.info,
      side,
      price: item.price,
      score: finalScore,
      baseScore: decision.confidence,
      requiredScore: this.config.trendPortfolioMinScore,
      requiredConvictionScore: this.config.trendPortfolioMinScore,
      convictionScore: finalScore,
      technicalConvictionScore: decision.confidence,
      adaptiveConfidence: adaptive.confidence,
      adaptiveScoreAdjustment: adaptive.scoreAdjustment,
      adaptiveRiskMultiplier: adaptive.riskMultiplier,
      adaptiveLeverageMultiplier: adaptive.leverageMultiplier,
      adaptivePolicyMode: adaptive.policyMode,
      adaptiveReasons: adaptive.reasons,
      rejected: eligible ? [] : decision.rejectionReasons,
      eligible,
      tradeQualityTier: finalTier,
      confidenceClass,
      scannerQualityTier: finalTier,
      qualityTier: finalTier,
      profitQualityTier: finalTier,
      tradeQualification: {
        tier: finalTier,
        category: eligible ? "ACCEPTED" : "V15_PORTFOLIO_REJECTED",
        reason: eligible
          ? (decision.portfolioDecisionEngine === "V17_ACTIVE_OPPORTUNITY_ENGINE" ? "V17 independent strategy opportunity accepted" : "V16 weighted portfolio strategy decision accepted")
          : decision.rejectionReasons[0] || "portfolio strategy confidence below threshold",
        assignedBy: "portfolioDecisionEngine.js",
        scalpDecisionLogicReused: false,
      },
      tradeQualityAssignedBy: "portfolioDecisionEngine.js",
      rejectionCategory: eligible ? "ACCEPTED" : "V15_PORTFOLIO_DECISION",
      rejectionReason: eligible ? null : decision.rejectionReasons[0] || "V15 no trade",
      setupType: decision.setupType,
      tradeCategory: finalTier === "ELITE" ? "ELITE_SETUP" : decision.portfolioDecisionEngine === "V17_ACTIVE_OPPORTUNITY_ENGINE" ? "V17_ACTIVE_OPPORTUNITY" : "V16_MULTI_STRATEGY_PORTFOLIO",
      explorationTrade: false,
      forcedMarketSampling: false,
      eliteSetup: finalTier === "ELITE",
      highQualityContinuation: finalTier === "STRONG" || finalTier === "ELITE",
      eliteContinuationCandidate: finalTier === "ELITE",
      continuationStrength: Number(bounded(
        decision.confidence * 0.55 +
          Math.max(0, momentum1h) * 5 +
          Math.max(0, momentum4h) * 2.5 +
          (decision.supportingStrategies.includes("TREND_BREAKOUT") ? 10 : 0) +
          (decision.supportingStrategies.length >= 2 ? 8 : 0),
        0,
        100
      ).toFixed(2)),
      continuationSetupType: decision.continuationSetupType,
      continuationComponents: {
        strategyCombination: decision.strategyCombination,
        supportingStrategies: decision.supportingStrategies,
        opposingStrategies: decision.opposingStrategies,
        volumeSpike: Number(volumeSpike.toFixed(3)),
        rangeExpansion: Number(rangeExpansion.toFixed(3)),
        expectedRewardRisk: decision.expectedRewardRisk,
      },
      continuationBreakout: decision.supportingStrategies.includes("TREND_BREAKOUT"),
      pullbackContinuation: decision.supportingStrategies.includes("TREND_PULLBACK"),
      breakoutRetest: decision.supportingStrategies.includes("TREND_BREAKOUT") && decision.supportingStrategies.includes("MULTI_TIMEFRAME_TREND"),
      momentumResumption: decision.supportingStrategies.includes("MULTI_TIMEFRAME_TREND") || decision.supportingStrategies.includes("TREND_PULLBACK"),
      trendAcceleration: momentum15m > momentum1h && momentum1h >= 0,
      trendThesis: {
        key: null,
        expected,
        directions,
        mtfScore: decision.confidence,
        thesis: eligible
          ? `${decision.portfolioDecisionEngine === "V17_ACTIVE_OPPORTUNITY_ENGINE" ? "V17" : "V15"} ${decision.strategyCombination} trend thesis`
          : "No qualified portfolio trend thesis",
        holdingIntent: "2h to 24h preferred; multiple days while V15 trend thesis remains valid",
        strategyCombination: decision.strategyCombination,
      },
      trendThesisKey: null,
      swingSignalFingerprint: null,
      trend15m: directions.entry15m,
      trend5m: directions.entry15m,
      trend1h: directions.confirmation1h,
      trend4h: directions.trend4h,
      macroTrend: directions.macro1d,
      macroAligned: directions.macro1d === expected || directions.macroLong === expected,
      macroContradicts: directions.macro1d === opposite || directions.macroLong === opposite,
      multiTimeframeAligned: decision.marketRegime.directions.confirmation === expected && decision.marketRegime.directions.trend === expected,
      earlyTrendParticipation: false,
      multiTimeframeTrendScore: decision.confidence,
      multiTimeframeDirections: directions,
      multiTimeframeAllAligned: Object.values(directions).every((direction) => direction === expected),
      multiTimeframeTrendAndMacroOpposite: directions.trend4h === opposite && directions.macro1d === opposite,
      multiTimeframeMacroOpposite: directions.macro1d === opposite || directions.macroLong === opposite,
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
      atrPct: volatilityExpansion,
      entryMomentumPct: momentum15m,
      momentum1mPct: momentum15m,
      momentum5mPct: momentum1h,
      momentum4hPct: momentum4h,
      momentumPersistenceCandles,
      volumeSpike,
      volumeCondition: volumeSpike >= this.config.minVolumeSpike + 0.35 ? "STRONG_VOLUME_SPIKE" : volumeSpike >= this.config.minVolumeSpike ? "CONFIRMED_VOLUME" : "LOW_VOLUME",
      volatilityRegime: decision.marketRegime.regime === "HIGH_VOLATILITY" ? "HIGH_VOLATILITY" : volatilityExpansion < 0.12 ? "LOW_VOLATILITY" : "NORMAL",
      spreadPct: item.spreadPct,
      liquidityScore: Number(bounded(80 - item.spreadPct * 80 + Math.min(18, Math.log10(Math.max(1, item.volume / this.config.min24hVolumeUsdt)) * 8), 0, 100).toFixed(2)),
      trendQualityScore: Number(bounded(decision.confidence * 0.72 + (decision.supportingStrategies.length >= 2 ? 12 : 0), 0, 100).toFixed(2)),
      antiChopScore: decision.marketRegime.regime === "RANGE" || decision.marketRegime.regime === "LOW_VOLATILITY" ? 1 : 0,
      expectedMovePct: decision.expectedMovePct,
      takeProfitDistancePct: decision.expectedMovePct,
      stopDistancePct: Math.max(this.config.stopLossPct, decision.stopDistancePct),
      estimatedRoundTripCostPct: decision.estimatedRoundTripCostPct,
      projectedNetEdgePct: decision.projectedNetEdgePct,
      smartProjectedNetEdgePct: decision.projectedNetEdgePct,
      feeEdgeRatio: decision.feeEdgeRatio,
      roundTripFeePct: this.config.estimatedFeePctPerSide * 2,
      estimatedSlippagePct: this.config.estimatedSlippagePct,
      estimatedTpProbability: Number(bounded(0.34 + finalScore / 210 + decision.supportingStrategies.length * 0.03, 0.2, 0.84).toFixed(3)),
      executionType: decision.dominantStrategy && decision.dominantStrategy.strategyId === "TREND_BREAKOUT" && finalTier === "ELITE" ? "MARKET_TAKER" : "POST_ONLY_LIMIT",
      intendedExecutionType: decision.dominantStrategy && decision.dominantStrategy.strategyId === "TREND_BREAKOUT" && finalTier === "ELITE" ? "MARKET_TAKER" : "POST_ONLY_LIMIT",
      marketRegimeType: marketProfile && marketProfile.primary,
      marketRegimeTags: marketProfile && marketProfile.tags,
      marketRegimeConfidence: marketProfile && marketProfile.confidence,
      marketRegimeReasons: marketProfile && marketProfile.reasons,
      marketRegimeV2: decision.marketRegime.regime,
      marketPersonality: decision.portfolioDecisionEngine === "V17_ACTIVE_OPPORTUNITY_ENGINE" ? "V17_ACTIVE_OPPORTUNITY" : "V15_MULTI_STRATEGY_PORTFOLIO",
      regime: marketProfile && marketProfile.direction,
      regimeAggressionMultiplier: 1,
      regimeRiskMultiplier: 1,
      regimeLeverageMultiplier: 1,
      regimeHoldMultiplier: 1.55,
      regimeTrailingDistanceMultiplier: decision.marketRegime.regime === "HIGH_VOLATILITY" ? 1.25 : 1.45,
      sessionType: sessionProfile().session,
      sessionRegime: sessionProfile().sessionRegime,
      sessionHourUtc: sessionProfile().hourUtc,
      scoreBreakdown: decision.scoreBreakdown,
      reasons: decision.scoreBreakdown,
      trendPortfolioMode: true,
      v15MultiStrategyPortfolioMode: true,
      activeOpportunityMode: decision.portfolioDecisionEngine === "V17_ACTIVE_OPPORTUNITY_ENGINE",
      portfolioDecisionEngine: decision.portfolioDecisionEngine,
      strategyId: decision.dominantStrategy && decision.dominantStrategy.strategyId,
      strategyConfidence: decision.dominantStrategy && decision.dominantStrategy.confidence,
      strategyCombination: decision.strategyCombination,
      strategyOutputs: decision.strategyOutputs,
      strategyContributions: decision.strategyOutputs.map((output) => ({
        strategyId: output.strategyId,
        direction: output.direction,
        confidence: output.confidence,
        weight: output.portfolioWeight,
        enabled: output.enabled,
        reason: output.reason,
      })),
      strategyVotes: decision.votes,
      strategyPreferredHoldingTimeSeconds: decision.preferredHoldingTimeSeconds,
      strategyPositionSizeMultiplier: decision.positionSizeMultiplier,
      strategyCapitalTargetUsdt: decision.capitalTargetUsdt,
      strategyRegimeSizeMultiplier: decision.regimeSizeMultiplier,
      strategyExpectedRewardRisk: decision.expectedRewardRisk,
      strategyDynamicExit: decision.dynamicExit,
      adaptiveDefensiveThresholdFreezeAvoided: adaptive.scoreAdjustment < 0,
      marketRegimeV15: decision.marketRegime,
      microBreakoutTriggered: false,
      fomoTrigger: false,
      fastMode: false,
    };
    signal.trendThesis.key = trendThesisKey(signal);
    signal.trendThesisKey = signal.trendThesis.key;
    signal.swingSignalFingerprint = `${signal.trendThesis.key}:${signal.strategyCombination}`;
    signal.eliteConditionKey = signal.swingSignalFingerprint;
    if (!signal.setupType) signal.setupType = setupTypeFromSignal(signal);
    return signal;
  }

  buildV17OpportunitySignals(item, analyses, marketProfile) {
    const evaluation = this.portfolioDecision.evaluateOpportunities({
      symbol: item.info.symbol,
      price: item.price,
      spreadPct: item.spreadPct,
      volume: item.volume,
      analyses,
      marketProfile,
      strategyPerformanceStats: this.strategyPerformanceStats(),
    });
    const accepted = evaluation.opportunities.map((decision) => this.buildV15PortfolioSignal(item, analyses, marketProfile, { decision }));
    const rejected = evaluation.skipped.map((decision) => this.buildV15PortfolioSignal(item, analyses, marketProfile, { decision }));
    return [...accepted, ...rejected];
  }

  strategyPerformanceStats() {
    return this.adaptive && this.adaptive.memory && this.adaptive.memory.stats
      ? this.adaptive.memory.stats.byStrategy || {}
      : {};
  }

  async analyzeSymbol(item, marketProfile) {
    try {
      const analyses = await this.candleSet(item.info.symbol);
      if (!analyses.entry || !analyses.confirmation || !analyses.trend || !analyses.macro || !analyses.macroLong) {
        this.log("DEBUG", "V14 symbol rejected: insufficient HTF candle history.", { symbol: item.info.symbol });
        return null;
      }
      this.cachedDirections[item.info.symbol] = emaDirection(analyses.confirmation);
      if (this.activeOpportunityMode) {
        return this.buildV17OpportunitySignals(item, analyses, marketProfile);
      }
      if (this.multiStrategyEnabled) {
        return this.buildV15PortfolioSignal(item, analyses, marketProfile);
      }
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
    const rawAnalyses = await mapLimited(universe, this.config.scanConcurrency, (item) => this.analyzeSymbol(item, market));
    const analyses = rawAnalyses.flatMap((item) => (Array.isArray(item) ? item : [item])).filter(Boolean);
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
        confidenceClass: item.confidenceClass,
        earlyTrendParticipation: item.earlyTrendParticipation,
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
      activeOpportunityMode: this.activeOpportunityMode,
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
    if (this.multiStrategyEnabled) {
      return this.buildV15PortfolioSignal(item, analyses, marketProfile || { direction: "CHOPPY", tags: [] }, { onlySide: position.side });
    }
    return this.scoreSide(position.side, item, analyses, marketProfile || { direction: "CHOPPY", tags: [] });
  }
}

module.exports = { TrendPortfolioEngine, TREND_SYMBOLS, trendThesisKey };
