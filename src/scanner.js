"use strict";

const { analyzeCandles, emaDirection, parseCandles } = require("./indicators");
const { setupTypeFromSignal } = require("./adaptiveEngine");

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

function bodyIsDirectional(analysis, direction) {
  return analysis.bodyDirection === direction && analysis.bodyStrength >= 0.35;
}

function volatilityRegime(config, atrPct) {
  if (atrPct >= config.abnormalVolatilityAtrPct) return "NEWS_LIKE_ABNORMAL";
  if (atrPct >= config.highVolatilityAtrPct) return "HIGH_VOLATILITY";
  if (atrPct < 0.12) return "LOW_VOLATILITY";
  return "NORMAL";
}

function volumeCondition(config, volumeSpike) {
  if (volumeSpike >= config.minVolumeSpike + 0.65) return "STRONG_VOLUME_SPIKE";
  if (volumeSpike >= config.minVolumeSpike) return "CONFIRMED_VOLUME";
  if (volumeSpike >= config.minVolumeSpike * 0.85) return "EARLY_VOLUME";
  return "LOW_VOLUME";
}

function clampScore(score) {
  return Math.max(0, Math.min(100, score));
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function liquidityScore(config, volume24hUsdt, spreadPct) {
  const volumeMultiple = config.min24hVolumeUsdt > 0 ? volume24hUsdt / config.min24hVolumeUsdt : 10;
  const volumeScore = bounded(Math.log10(Math.max(1, volumeMultiple)) * 35 + Math.min(30, volumeMultiple * 3), 0, 65);
  const spreadScore = bounded(35 * (1 - spreadPct / config.maxSpreadPct), 0, 35);
  return Number((volumeScore + spreadScore).toFixed(2));
}

function trendQualityScore(config, main, fast, supportsTrend, emaAccelerating, momentumPersistenceCandles, direction) {
  let score = 0;
  if (supportsTrend) score += 35;
  if (emaAccelerating) score += 18;
  if (main.bodyDirection === direction && main.bodyStrength >= config.minDirectionalBodyStrength) score += 15;
  if (fast.bodyDirection === direction && fast.bodyStrength >= config.minDirectionalBodyStrength) score += 10;
  if (main.rangeExpansion >= config.minRangeExpansion) score += 10;
  score += Math.min(12, momentumPersistenceCandles * 4);
  return bounded(score, 0, 100);
}

function antiChopScore(config, context) {
  if (!config.antiChopEnabled) return { score: 0, reasons: [] };
  const reasons = [];
  let score = 0;
  if (context.regime === "CHOPPY") {
    score += 1;
    reasons.push("benchmark regime is choppy");
  }
  if (context.mainTrend === "CHOPPY") {
    score += 1;
    reasons.push("symbol EMA trend is choppy");
  }
  if (Math.abs(context.emaGapPct) < 0.035) {
    score += 1;
    reasons.push("EMA gap is too compressed");
  }
  if (context.rangeExpansion < config.minRangeExpansion) {
    score += 1;
    reasons.push("range expansion is weak");
  }
  if (context.bodyStrength < config.minDirectionalBodyStrength) {
    score += 1;
    reasons.push("candle body is not decisive");
  }
  if (!context.hasMomentumPersistence) {
    score += 1;
    reasons.push("momentum persistence is weak");
  }
  if (context.volumeSpike < config.minVolumeSpike) {
    score += 1;
    reasons.push("volume confirmation is weak");
  }
  return { score, reasons };
}

function technicalConvictionScore(config, parts) {
  const volumeScore = bounded(((parts.volumeSpike - 1) / Math.max(0.1, config.minVolumeSpike)) * 22, 0, 22);
  const momentumScore = bounded((parts.directedFastMomentum / Math.max(0.01, config.minBurstMomentumPct)) * 18, 0, 18);
  const btcScore = parts.btcSupportsSide ? 13 : parts.btcContradictsSide ? 0 : 5;
  const breakoutScore = parts.breakSignal ? 12 : parts.microBreakoutTriggered ? 5 : 0;
  const edgeScore = bounded((parts.feeEdgeRatio / config.minEdgeToCostRatio) * 15, 0, 15);
  const trendScore = bounded(parts.trendQualityScore * 0.16, 0, 16);
  const liquidity = bounded(parts.liquidityScore * 0.14, 0, 14);
  const chopPenalty = Math.min(18, parts.chop.score * 4);
  const total = volumeScore + momentumScore + btcScore + breakoutScore + edgeScore + trendScore + liquidity - chopPenalty;
  return {
    score: Number(bounded(total, 0, 100).toFixed(2)),
    components: {
      volumeScore: Number(volumeScore.toFixed(2)),
      momentumScore: Number(momentumScore.toFixed(2)),
      btcScore,
      breakoutScore,
      edgeScore: Number(edgeScore.toFixed(2)),
      trendScore: Number(trendScore.toFixed(2)),
      liquidityScore: Number(liquidity.toFixed(2)),
      chopPenalty,
    },
  };
}

function explorationBlockReason(config, signal) {
  if (!config.explorationModeEnabled) return "exploration mode disabled";
  if (signal.volatilityRegime === "NEWS_LIKE_ABNORMAL") return "exploration blocked during news-like abnormal volatility";
  if (signal.volumeCondition === "LOW_VOLUME") return "exploration blocked by low volume condition";
  if (signal.liquidityScore < config.minLiquidityScore * 0.8) return "exploration blocked by weak liquidity";
  if (signal.antiChopScore > config.explorationMaxChopScore) return "exploration blocked by excessive chop";
  if (signal.projectedNetEdgePct < config.explorationMinProjectedEdgePct) return "exploration blocked by insufficient fee-adjusted edge";
  if (signal.feeEdgeRatio < config.explorationMinEdgeToCostRatio) return "exploration blocked by weak edge-to-cost ratio";
  if (signal.score < config.explorationMinSignalScore) return "exploration blocked by low adaptive score";
  if (signal.convictionScore < config.explorationMinConvictionScore) return "exploration blocked by low exploratory conviction";
  const blacklist = signal.rejected.find((reason) => /blacklist|choppy-market entries disabled/i.test(reason));
  if (blacklist) return blacklist;
  return null;
}

class Scanner {
  constructor(config, client, log, adaptive = null) {
    this.config = config;
    this.client = client;
    this.log = log;
    this.adaptive = adaptive;
    this.scanErrors = 0;
    this.cachedRegime = null;
    this.cachedRegimeExpiresAt = 0;
    this.cachedBenchmarkDirections = { BTCUSDT: "CHOPPY", ETHUSDT: "CHOPPY" };
  }

  async regimeForMarket() {
    if (this.cachedRegime && Date.now() < this.cachedRegimeExpiresAt) {
      this.log("DEBUG", "Using cached BTC/ETH market regime for faster scanning.", {
        direction: this.cachedRegime,
        benchmarks: this.cachedBenchmarkDirections,
      });
      return this.cachedRegime;
    }
    const directions = {};
    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      const candles = parseCandles(await this.client.getKlines(symbol, this.config.candleIntervalTrend, 80));
      directions[symbol] = emaDirection(analyzeCandles(candles));
    }
    const direction =
      directions.BTCUSDT === "UP" && directions.ETHUSDT === "UP"
        ? "UP"
        : directions.BTCUSDT === "DOWN" && directions.ETHUSDT === "DOWN"
          ? "DOWN"
          : "CHOPPY";
    this.log("INFO", "Market regime evaluated from BTC and ETH.", { direction, benchmarks: directions });
    this.cachedRegime = direction;
    this.cachedBenchmarkDirections = directions;
    this.cachedRegimeExpiresAt = Date.now() + this.config.marketRegimeCacheMs;
    return direction;
  }

  async universe() {
    const [symbols, tickers] = await Promise.all([
      this.client.getSymbols(),
      this.client.getTickers(),
    ]);
    const tickersBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
    const accepted = [];
    const rejected = { contract: 0, excluded: 0, volume: 0, spread: 0, marketData: 0 };

    for (const info of symbols) {
      const ticker = tickersBySymbol.get(info.symbol);
      const perpetual = info.contractType === "LinearPerpetual";
      if (!perpetual || info.status !== "Trading" || info.settleCoin !== "USDT" || !info.symbol.endsWith("USDT")) {
        rejected.contract += 1;
        continue;
      }
      if (this.config.excludedSymbols.has(info.symbol)) {
        rejected.excluded += 1;
        continue;
      }
      const volume = Number(ticker && ticker.turnover24h);
      const price = Number(ticker && ticker.lastPrice);
      const bid = Number(ticker && ticker.bid1Price);
      const ask = Number(ticker && ticker.ask1Price);
      if (![volume, price, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= 0) {
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

    accepted.sort((left, right) => right.volume - left.volume);
    const limited = accepted.slice(0, this.config.maxSymbolsToScan);
    this.client.subscribeTickers(limited.map((item) => item.info.symbol));
    this.log("INFO", "Liquid spread-filtered universe prepared.", {
      returned: symbols.length,
      eligible: accepted.length,
      analyzing: limited.length,
      rejected,
    });
    return limited;
  }

  async analyzeSymbol(item, regime) {
    let rawCandles;
    try {
      const candleLimit = this.config.fastMode ? 30 : 80;
      const candleRequests = [
        this.client.getKlines(item.info.symbol, this.config.candleIntervalFast, candleLimit),
      ];
      if (!(this.config.fastMode && this.config.fomoBreakoutMode)) {
        candleRequests.push(this.client.getKlines(item.info.symbol, this.config.candleIntervalMain, candleLimit));
      }
      if (!this.config.fastMode) {
        candleRequests.push(this.client.getKlines(item.info.symbol, this.config.candleIntervalTrend, 80));
      }
      rawCandles = await Promise.all(candleRequests);
    } catch (error) {
      this.scanErrors += 1;
      this.log("WARN", "Symbol rejected because candles could not be read.", { symbol: item.info.symbol, error: error.message });
      return null;
    }
    const minimumCandles = this.config.fastMode ? 24 : 55;
    const fast = analyzeCandles(parseCandles(rawCandles[0]), minimumCandles);
    const main = this.config.fastMode && this.config.fomoBreakoutMode
      ? fast
      : analyzeCandles(parseCandles(rawCandles[1]), minimumCandles);
    const trend = this.config.fastMode ? main : analyzeCandles(parseCandles(rawCandles[2]));
    if (!fast || !main || !trend) {
      this.log("DEBUG", "Symbol rejected: missing required candle history.", { symbol: item.info.symbol });
      return null;
    }
    // Volatility and fast moves are entry inputs in this profile, not hard rejections.
    const technicalReject = [];

    const signals = [];
    if (this.config.allowLongs) signals.push(this.scoreDirection("LONG", item, fast, main, trend, regime, technicalReject));
    if (this.config.allowShorts) signals.push(this.scoreDirection("SHORT", item, fast, main, trend, regime, technicalReject));
    signals.sort((left, right) => right.score - left.score);
    return signals[0];
  }

  scoreDirection(side, item, fast, main, trend, regime, commonReject) {
    const long = side === "LONG";
    const direction = long ? "UP" : "DOWN";
    let score = 0;
    const scoreBreakdown = [];
    const rejected = [...commonReject];
    const mainTrend = emaDirection(main);
    const trend15 = emaDirection(trend);
    const supportsTrend = long
      ? Number.isFinite(main.ema50) && main.ema9 > main.ema21 && main.ema21 > main.ema50
      : Number.isFinite(main.ema50) && main.ema9 < main.ema21 && main.ema21 < main.ema50;
    const emaAccelerating = long
      ? fast.ema9 > fast.ema21 && fast.emaGapPct > fast.previousEmaGapPct
      : fast.ema9 < fast.ema21 && fast.emaGapPct < fast.previousEmaGapPct;
    const rsi = this.config.fastMode ? fast.rsi14 : main.rsi14;
    const healthyRsi = long ? rsi >= 25 && rsi <= 90 : rsi >= 10 && rsi <= 75;
    const overheatedRsi = long ? rsi > 82 : rsi < 18;
    const breakSignal = long
      ? main.breakout || (this.config.microBreakoutEntries && fast.breakout)
      : main.breakdown || (this.config.microBreakoutEntries && fast.breakdown);
    const microBreakoutTriggered = this.config.microBreakoutEntries && (long ? fast.breakout && !main.breakout : fast.breakdown && !main.breakdown);
    const breakoutTriggered = Boolean(breakSignal);
    const volumeSpike = Math.max(fast.volumeSpike, main.volumeSpike);
    const directedFastMomentum = long ? fast.momentumPct : -fast.momentumPct;
    const directedMainMomentum = long ? main.momentumPct : -main.momentumPct;
    const directedLastCandleMomentum = long ? fast.lastCandleMomentumPct : -fast.lastCandleMomentumPct;
    const momentumPersistenceCandles = Math.max(
      long ? fast.upMomentumCandles : fast.downMomentumCandles,
      long ? main.upMomentumCandles : main.downMomentumCandles
    );
    const hasMomentumPersistence = momentumPersistenceCandles >= this.config.minMomentumPersistenceCandles;
    const momentumBurst =
      (directedFastMomentum >= this.config.minBurstMomentumPct && hasMomentumPersistence) ||
      (this.config.fastMode && directedMainMomentum >= this.config.minBurstMomentumPct && hasMomentumPersistence);
    const fomoTrigger =
      this.config.fomoBreakoutMode &&
      directedFastMomentum >= this.config.fomoMomentumPct &&
      directedLastCandleMomentum > 0 &&
      volumeSpike >= Math.max(1.1, this.config.minVolumeSpike * 0.85) &&
      bodyIsDirectional(fast, direction);
    const supportsMarket = long ? regime === "UP" : regime === "DOWN";
    const btcTrend = this.cachedBenchmarkDirections.BTCUSDT || "CHOPPY";
    const ethTrend = this.cachedBenchmarkDirections.ETHUSDT || "CHOPPY";
    const btcSupportsSide = long ? btcTrend === "UP" : btcTrend === "DOWN";
    const btcContradictsSide = long ? btcTrend === "DOWN" : btcTrend === "UP";
    const ethSupportsSide = long ? ethTrend === "UP" : ethTrend === "DOWN";
    const body = this.config.fastMode && fast.bodyDirection === direction ? fast : main;
    const strongBody = body.bodyStrength >= (this.config.fastMode ? 0.42 : 0.5) && body.bodyDirection === direction;
    const volatileEnough = Math.max(fast.atrPct, main.atrPct) >= 0.15;
    const roundTripFeePct = this.config.estimatedFeePctPerSide * 2;
    const estimatedRoundTripCostPct = roundTripFeePct + this.config.estimatedSlippagePct + item.spreadPct;
    const expectedMovePct = Math.min(
      this.config.takeProfitPct,
      Math.max(
        this.config.minExpectedMovePct,
        Math.abs(directedFastMomentum) * 2.5,
        Math.abs(directedMainMomentum) * 1.8,
        main.atrPct * this.config.expectedMoveAtrMultiplier
      )
    );
    const projectedNetEdgePct = expectedMovePct - estimatedRoundTripCostPct;
    const feeEdgeRatio = estimatedRoundTripCostPct > 0 ? expectedMovePct / estimatedRoundTripCostPct : 999;
    const symbolLiquidityScore = liquidityScore(this.config, item.volume, item.spreadPct);
    const symbolTrendQualityScore = trendQualityScore(
      this.config,
      main,
      fast,
      supportsTrend,
      emaAccelerating,
      momentumPersistenceCandles,
      direction
    );
    const chop = antiChopScore(this.config, {
      regime,
      mainTrend,
      emaGapPct: main.emaGapPct,
      rangeExpansion: main.rangeExpansion,
      bodyStrength: body.bodyStrength,
      hasMomentumPersistence,
      volumeSpike,
    });
    const lowLiquidityRandomSpike =
      item.volume < this.config.min24hVolumeUsdt * this.config.lowVolumeMultiple &&
      volumeSpike >= this.config.minVolumeSpike * 2 &&
      Math.max(Math.abs(fast.momentumPct), Math.abs(main.momentumPct)) >= this.config.fomoMomentumPct * 2 &&
      !supportsTrend &&
      !breakSignal;
    const addScore = (description, points) => {
      score += points;
      scoreBreakdown.push(`${description} ${points >= 0 ? "+" : ""}${points}`);
    };

    if (supportsTrend) {
      addScore("EMA alignment", 15);
    } else if (emaAccelerating) {
      addScore("early EMA cross acceleration", 8);
    }
    if (breakSignal) {
      addScore(long ? "breakout candle" : "breakdown candle", 20);
    }
    if (fomoTrigger) {
      addScore("FOMO 1m momentum trigger with volume", 22);
    }
    if (volumeSpike >= this.config.minVolumeSpike + 0.65) {
      addScore("sudden volume spike", 20);
    } else if (volumeSpike >= this.config.minVolumeSpike) {
      addScore("confirmed volume expansion", 14);
    } else if (volumeSpike >= this.config.minVolumeSpike * 0.85) {
      addScore("early volume expansion", 5);
    }
    if (momentumBurst) {
      addScore("persistent short momentum burst", 15);
    } else if (directedFastMomentum >= this.config.minBurstMomentumPct) {
      addScore("single-candle momentum without persistence", 6);
    }
    if (healthyRsi) {
      addScore("relaxed RSI window", 10);
    }
    if (overheatedRsi) {
      addScore("overextended RSI penalty", -7);
    }
    if (strongBody) {
      addScore("directional candle strength", 10);
    }
    if (volatileEnough) {
      addScore("tradable volatility", 5);
    }
    if (btcSupportsSide) {
      addScore("BTC trend alignment", this.config.btcTrendAlignmentBonus);
    } else if (btcContradictsSide) {
      addScore("BTC trend contradiction penalty", -Math.ceil(this.config.btcTrendAlignmentBonus / 2));
    }
    if (ethSupportsSide) {
      addScore("ETH trend alignment", 4);
    }
    if (supportsMarket) {
      addScore("BTC/ETH regime agrees", 3);
    } else if (regime === "CHOPPY") {
      const penalty = fomoTrigger && hasMomentumPersistence ? Math.ceil(this.config.choppyMarketPenalty / 2) : this.config.choppyMarketPenalty;
      addScore("BTC/ETH choppy context penalty", -penalty);
    }
    if (projectedNetEdgePct >= this.config.minProjectedEdgePct + 0.5 && feeEdgeRatio >= this.config.minEdgeToCostRatio + 0.75) {
      addScore("fee-aware expected edge clears costs", 8);
    } else if (projectedNetEdgePct < this.config.minProjectedEdgePct || feeEdgeRatio < this.config.minEdgeToCostRatio) {
      rejected.push(
        `fee inefficiency: expected move ${expectedMovePct.toFixed(3)}% vs cost ${estimatedRoundTripCostPct.toFixed(3)}% ratio ${feeEdgeRatio.toFixed(2)}`
      );
    }
    if (lowLiquidityRandomSpike) {
      addScore("low-liquidity random spike penalty", -this.config.lowLiquiditySpikePenalty);
    }
    if (symbolLiquidityScore < this.config.minLiquidityScore) {
      rejected.push(`low liquidity quality score ${symbolLiquidityScore.toFixed(1)} below ${this.config.minLiquidityScore}`);
    }
    const exceptionalChopBreakout =
      breakSignal &&
      supportsTrend &&
      volumeSpike >= this.config.minVolumeSpike + 0.65 &&
      feeEdgeRatio >= this.config.minEdgeToCostRatio + 0.75 &&
      symbolTrendQualityScore >= 65;
    if (chop.score > this.config.maxChopScore && !exceptionalChopBreakout) {
      addScore("anti-chop filter penalty", -Math.min(24, chop.score * 5));
      rejected.push(`anti-chop filter activated: ${chop.reasons.join("; ")}`);
    } else if (chop.score > 0) {
      addScore("minor chop-quality penalty", -Math.min(10, chop.score * 2));
    }

    if (regime === "CHOPPY" && !this.config.allowChoppyMarket) rejected.push("choppy-market entries disabled by configuration");
    if (volumeSpike < this.config.minVolumeSpike && !fomoTrigger) rejected.push("volume confirmation below survivability threshold");
    if (!hasMomentumPersistence && !fomoTrigger && !breakSignal) rejected.push("momentum did not persist long enough");
    if (
      regime === "CHOPPY" &&
      !fomoTrigger &&
      !breakSignal &&
      (!hasMomentumPersistence || volumeSpike < this.config.minVolumeSpike + 0.25)
    ) {
      rejected.push("weak chop entry lacks breakout plus persistent volume/momentum");
    }

    let finalScore = clampScore(score);
    const baseSignal = {
      symbol: item.info.symbol,
      info: item.info,
      side,
      score: finalScore,
      baseScore: finalScore,
      price: item.price,
      volume24hUsdt: item.volume,
      spreadPct: item.spreadPct,
      rsi,
      atrPct: main.atrPct,
      volumeSpike,
      momentumPersistenceCandles,
      momentum1mPct: fast.momentumPct,
      momentum5mPct: main.momentumPct,
      entryMomentumPct: directedFastMomentum,
      expectedMovePct,
      estimatedRoundTripCostPct,
      projectedNetEdgePct,
      feeEdgeRatio,
      roundTripFeePct,
      estimatedSlippagePct: this.config.estimatedSlippagePct,
      liquidityScore: symbolLiquidityScore,
      trendQualityScore: symbolTrendQualityScore,
      antiChopScore: chop.score,
      antiChopReasons: chop.reasons,
      btcTrend,
      ethTrend,
      btcTrendAligned: btcSupportsSide,
      trend15m: trend15,
      trend5m: mainTrend,
      reasons: scoreBreakdown,
      scoreBreakdown,
      rejected,
      fastMode: this.config.fastMode,
      fomoTrigger,
      breakoutTriggered,
      microBreakoutTriggered,
      volatilityRegime: volatilityRegime(this.config, main.atrPct),
      volumeCondition: volumeCondition(this.config, volumeSpike),
      regime,
      setupType: null,
      eligible: false,
    };
    baseSignal.setupType = setupTypeFromSignal(baseSignal);
    const conviction = technicalConvictionScore(this.config, {
      volumeSpike,
      directedFastMomentum,
      btcSupportsSide,
      btcContradictsSide,
      breakSignal,
      microBreakoutTriggered,
      feeEdgeRatio,
      trendQualityScore: symbolTrendQualityScore,
      liquidityScore: symbolLiquidityScore,
      chop,
    });
    baseSignal.technicalConvictionScore = conviction.score;
    baseSignal.convictionComponents = conviction.components;
    const signal = this.applyAdaptiveLearning(baseSignal);
    const requiredScore = this.adaptive && this.config.adaptiveLearningEnabled
      ? this.adaptive.currentPolicy().minSignalScore
      : this.config.minSignalScore;
    signal.requiredScore = requiredScore;
    signal.tradeCategory = "HIGH_CONVICTION";
    signal.explorationTrade = false;
    signal.strictRejectedReasons = [...signal.rejected];
    const highConvictionEligible = signal.score >= requiredScore && signal.rejected.length === 0;
    if (highConvictionEligible) {
      signal.eligible = true;
    } else {
      const explorationBlock = explorationBlockReason(this.config, signal);
      signal.explorationBlockReason = explorationBlock;
      signal.eligible = false;
      if (!explorationBlock) {
        signal.eligible = true;
        signal.tradeCategory = "EXPLORATION";
        signal.explorationTrade = true;
        signal.explorationWaivedRejections = signal.strictRejectedReasons;
        signal.rejected = [];
        signal.scoreBreakdown.push("adaptive exploration active +0");
      }
    }
    return signal;
  }

  applyAdaptiveLearning(signal) {
    if (!this.adaptive || !this.config.adaptiveLearningEnabled) {
      signal.adaptiveConfidence = 50;
      signal.adaptiveScoreAdjustment = 0;
      signal.adaptiveRiskMultiplier = 1;
      signal.adaptiveLeverageMultiplier = 1;
      signal.adaptivePolicyMode = "DISABLED";
      signal.adaptiveReasons = ["adaptive learning disabled"];
      signal.convictionScore = signal.technicalConvictionScore;
      if (signal.convictionScore < this.config.minConvictionScore) {
        signal.rejected.push(`low conviction: ${signal.convictionScore.toFixed(1)} below ${this.config.minConvictionScore}`);
      }
      return signal;
    }
    const adaptation = this.adaptive.evaluateSignal(signal);
    signal.adaptiveScoreAdjustment = adaptation.scoreAdjustment;
    signal.adaptiveConfidence = adaptation.confidence;
    signal.adaptiveRiskMultiplier = adaptation.riskMultiplier;
    signal.adaptiveLeverageMultiplier = adaptation.leverageMultiplier;
    signal.adaptivePolicyMode = adaptation.policy && adaptation.policy.mode;
    signal.adaptiveReasons = adaptation.reasons;
    signal.score = clampScore(signal.score + adaptation.scoreAdjustment);
    signal.convictionScore = Number(
      bounded(signal.technicalConvictionScore * 0.72 + adaptation.confidence * 0.28, 0, 100).toFixed(2)
    );
    if (adaptation.rejected) {
      signal.rejected.push(...adaptation.reasons);
    }
    if (adaptation.scoreAdjustment !== 0) {
      signal.scoreBreakdown.push(`adaptive historical confidence ${adaptation.scoreAdjustment >= 0 ? "+" : ""}${adaptation.scoreAdjustment}`);
    }
    if (signal.convictionScore < this.config.minConvictionScore) {
      signal.rejected.push(`low conviction: ${signal.convictionScore.toFixed(1)} below ${this.config.minConvictionScore}`);
    } else if (signal.convictionScore >= this.config.minConvictionScore + 14 && adaptation.scoreAdjustment > 0) {
      signal.scoreBreakdown.push(`conviction boost applied +${Math.min(6, Math.round((signal.convictionScore - this.config.minConvictionScore) / 4))}`);
    }
    return signal;
  }

  async scan(regimeOverride) {
    this.scanErrors = 0;
    const regime = regimeOverride || (await this.regimeForMarket());
    const universe = await this.universe();
    // Multiple analyses queue concurrently; the API client still paces actual requests to limit 429s.
    // FOMO + FAST mode needs only the 1-minute candle series for immediate-entry decisions.
    const analyses = await mapLimited(universe, this.config.scanConcurrency, (item) => this.analyzeSymbol(item, regime));
    analyses.sort((left, right) => right.score - left.score || right.volume24hUsdt - left.volume24hUsdt);
    for (const item of analyses.slice(0, 10)) {
      this.log(item.eligible ? "INFO" : "DEBUG", item.eligible ? "Candidate passed signal threshold." : "High-ranked candidate rejected.", {
        symbol: item.symbol,
        side: item.side,
        score: item.score,
        baseScore: item.baseScore,
        requiredScore: item.requiredScore,
        setupType: item.setupType,
        tradeCategory: item.tradeCategory,
        explorationTrade: item.explorationTrade,
        explorationBlockReason: item.explorationBlockReason,
        explorationWaivedRejections: item.explorationWaivedRejections,
        rsi: item.rsi.toFixed(2),
        spreadPct: item.spreadPct.toFixed(4),
        momentum1mPct: item.momentum1mPct.toFixed(3),
        momentum5mPct: item.momentum5mPct.toFixed(3),
        volumeSpike: item.volumeSpike.toFixed(2),
        momentumPersistenceCandles: item.momentumPersistenceCandles,
        atrPct: item.atrPct.toFixed(3),
        projectedNetEdgePct: item.projectedNetEdgePct.toFixed(3),
        expectedMovePct: item.expectedMovePct.toFixed(3),
        estimatedRoundTripCostPct: item.estimatedRoundTripCostPct.toFixed(3),
        feeEdgeRatio: item.feeEdgeRatio.toFixed(2),
        convictionScore: item.convictionScore,
        technicalConvictionScore: item.technicalConvictionScore,
        convictionComponents: item.convictionComponents,
        liquidityScore: item.liquidityScore,
        trendQualityScore: item.trendQualityScore,
        antiChopScore: item.antiChopScore,
        antiChopReasons: item.antiChopReasons,
        volatilityRegime: item.volatilityRegime,
        volumeCondition: item.volumeCondition,
        adaptiveConfidence: item.adaptiveConfidence,
        adaptiveScoreAdjustment: item.adaptiveScoreAdjustment,
        adaptivePolicyMode: item.adaptivePolicyMode,
        adaptiveReasons: item.adaptiveReasons,
        btcTrend: item.btcTrend,
        ethTrend: item.ethTrend,
        scoreBreakdown: item.scoreBreakdown,
        regime: item.regime,
        fastMode: item.fastMode,
        fomoTrigger: item.fomoTrigger,
        rejected: item.rejected,
      });
    }
    this.log("INFO", "Scalping scan completed.", {
      mode: this.config.fastMode ? "FAST" : "CONFIRMED",
      regime,
      analyzed: analyses.length,
      candidates: analyses.filter((item) => item.eligible).length,
      minimumScore: this.config.minSignalScore,
      minimumConvictionScore: this.config.minConvictionScore,
      adaptiveMinimumScore: this.adaptive && this.config.adaptiveLearningEnabled ? this.adaptive.currentPolicy().minSignalScore : this.config.minSignalScore,
      adaptiveMode: this.adaptive && this.config.adaptiveLearningEnabled ? this.adaptive.currentPolicy().mode : "DISABLED",
      analysisConcurrency: this.config.scanConcurrency,
      candleRequestsPerSymbol: this.config.fastMode && this.config.fomoBreakoutMode ? 1 : this.config.fastMode ? 2 : 3,
      apiErrors: this.scanErrors,
    });
    return { regime, analyses, candidates: analyses.filter((item) => item.eligible), hadApiErrors: this.scanErrors > 0 };
  }

  async analysisForPosition(position, regime) {
    const ticker = await this.client.getTicker(position.symbol);
    if (!ticker) return null;
    const bid = Number(ticker.bid1Price);
    const ask = Number(ticker.ask1Price);
    const info = { symbol: position.symbol };
    return this.analyzeSymbol(
      {
        info,
        price: Number(ticker.lastPrice),
        volume: Number(ticker.turnover24h),
        spreadPct: ((ask - bid) / ((ask + bid) / 2)) * 100,
      },
      regime
    );
  }
}

module.exports = { Scanner };
