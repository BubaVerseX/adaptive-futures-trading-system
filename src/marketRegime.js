"use strict";

const { emaDirection } = require("./indicators");
const { sessionType } = require("./adaptiveEngine");

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

function directionSign(direction) {
  if (direction === "UP") return 1;
  if (direction === "DOWN") return -1;
  return 0;
}

function trendStrength(analysis) {
  if (!analysis) return 0;
  const direction = emaDirection(analysis);
  const alignedMomentum = direction === "UP"
    ? numeric(analysis.momentumPct) > 0
    : direction === "DOWN"
      ? numeric(analysis.momentumPct) < 0
      : false;
  const momentumCandles = direction === "UP"
    ? numeric(analysis.upMomentumCandles)
    : direction === "DOWN"
      ? numeric(analysis.downMomentumCandles)
      : 0;
  const emaScore = clamp(Math.abs(numeric(analysis.emaGapPct)) * 18, 0, 28);
  const momentumScore = clamp(Math.abs(numeric(analysis.momentumPct)) * 36, 0, 24);
  const persistenceScore = clamp(momentumCandles * 6, 0, 24);
  const bodyScore = clamp(numeric(analysis.bodyStrength) * 14, 0, 14);
  const rangeScore = numeric(analysis.rangeExpansion) >= 1 ? clamp((numeric(analysis.rangeExpansion) - 1) * 8, 0, 10) : 0;
  return Number(clamp(emaScore + momentumScore + persistenceScore + bodyScore + rangeScore + (alignedMomentum ? 6 : 0), 0, 100).toFixed(2));
}

function sessionProfile(timestamp = Date.now()) {
  const date = new Date(timestamp || Date.now());
  const hour = date.getUTCHours();
  const session = sessionType(date.toISOString());
  const deadHours = hour >= 22 || hour < 1;
  const momentumWindow = hour >= 7 && hour < 20;
  return {
    session,
    hourUtc: hour,
    sessionRegime: deadHours ? "DEAD_HOURS" : session,
    deadHours,
    momentumWindow,
  };
}

function profileFromDirection(direction = "CHOPPY") {
  return {
    direction,
    primary: direction === "CHOPPY" ? "SIDEWAYS_CHOP_MARKET" : "STRONG_TRENDING_MARKET",
    tags: direction === "CHOPPY" ? ["SIDEWAYS_CHOP_MARKET"] : ["STRONG_TRENDING_MARKET"],
    confidence: direction === "CHOPPY" ? 45 : 55,
    btcDirection: direction,
    ethDirection: direction,
    btcTrendStrength: direction === "CHOPPY" ? 25 : 55,
    ethTrendStrength: direction === "CHOPPY" ? 25 : 55,
    btcVolatilityPct: 0,
    btcMomentumPct: 0,
    btcInstability: false,
    aggressionMultiplier: direction === "CHOPPY" ? 0.72 : 1.08,
    riskMultiplier: direction === "CHOPPY" ? 0.74 : 1.06,
    leverageMultiplier: direction === "CHOPPY" ? 0.75 : 1,
    explorationMultiplier: direction === "CHOPPY" ? 0.45 : 1.05,
    scoreAdjustment: direction === "CHOPPY" ? -6 : 4,
    minSignalAdjustment: direction === "CHOPPY" ? 4 : -2,
    minConvictionAdjustment: direction === "CHOPPY" ? 4 : -1,
    holdMultiplier: direction === "CHOPPY" ? 0.85 : 1.18,
    trailingDistanceMultiplier: direction === "CHOPPY" ? 0.85 : 1.1,
    reasons: [`fallback ${direction} market profile`],
  };
}

function neutralProfile(direction = "CHOPPY") {
  return {
    direction,
    primary: "NEUTRAL_MARKET",
    tags: [],
    confidence: 50,
    btcDirection: direction,
    ethDirection: direction,
    btcTrendStrength: 50,
    ethTrendStrength: 50,
    btcVolatilityPct: 0,
    btcMomentumPct: 0,
    btcInstability: false,
    aggressionMultiplier: 1,
    riskMultiplier: 1,
    leverageMultiplier: 1,
    explorationMultiplier: 1,
    scoreAdjustment: 0,
    minSignalAdjustment: 0,
    minConvictionAdjustment: 0,
    holdMultiplier: 1,
    trailingDistanceMultiplier: 1,
    reasons: ["market regime intelligence disabled"],
  };
}

function marketProfileFromBenchmarks(config, btc, eth) {
  if (!config.marketRegimeIntelligenceEnabled) {
    const fallbackDirection = btc && eth && emaDirection(btc) === emaDirection(eth) ? emaDirection(btc) : "CHOPPY";
    return neutralProfile(fallbackDirection);
  }
  if (!btc || !eth) {
    return profileFromDirection("CHOPPY");
  }

  const btcDirection = emaDirection(btc);
  const ethDirection = emaDirection(eth);
  const btcStrength = trendStrength(btc);
  const ethStrength = trendStrength(eth);
  const avgStrength = average([btcStrength, ethStrength]);
  const avgAtrPct = average([numeric(btc.atrPct), numeric(eth.atrPct)]);
  const avgVolumeSpike = average([numeric(btc.volumeSpike), numeric(eth.volumeSpike)]);
  const btcBreakout = Boolean(btc.breakout || btc.breakdown);
  const ethBreakout = Boolean(eth.breakout || eth.breakdown);
  const sameDirection = btcDirection !== "CHOPPY" && btcDirection === ethDirection;
  const directionalDisagreement =
    btcDirection !== "CHOPPY" &&
    ethDirection !== "CHOPPY" &&
    directionSign(btcDirection) !== directionSign(ethDirection);
  const direction = sameDirection ? btcDirection : "CHOPPY";

  const tags = [];
  const reasons = [];
  const strongTrend = sameDirection && avgStrength >= config.regimeStrongTrendScore;
  const highVolatilityBreakout =
    avgAtrPct >= config.regimeHighVolatilityAtrPct &&
    (btcBreakout || ethBreakout || avgVolumeSpike >= config.minVolumeSpike);
  const lowLiquidity = avgVolumeSpike <= config.regimeLowLiquidityVolumeSpike;
  const deadMarket =
    avgAtrPct <= config.regimeDeadMarketAtrPct &&
    avgVolumeSpike <= config.regimeDeadMarketVolumeSpike &&
    !btcBreakout &&
    !ethBreakout;
  const fakeBreakout =
    !sameDirection &&
    (btcBreakout || ethBreakout) &&
    avgAtrPct >= config.regimeDeadMarketAtrPct &&
    (
      directionalDisagreement ||
      average([numeric(btc.bodyStrength), numeric(eth.bodyStrength)]) < config.minDirectionalBodyStrength ||
      average([numeric(btc.rangeExpansion), numeric(eth.rangeExpansion)]) >= config.regimeFakeBreakoutRangeExpansion
    );
  const btcLed =
    btcDirection !== "CHOPPY" &&
    btcStrength >= config.regimeStrongTrendScore &&
    (ethDirection === "CHOPPY" || btcStrength >= ethStrength + 12);
  const chop =
    !strongTrend &&
    !highVolatilityBreakout &&
    (
      direction === "CHOPPY" ||
      avgStrength < config.regimeStrongTrendScore * config.regimeChopSensitivity ||
      directionalDisagreement
    );
  const btcInstability =
    directionalDisagreement ||
    (numeric(btc.atrPct) >= config.regimeHighVolatilityAtrPct && btcDirection === "CHOPPY") ||
    (btcBreakout && numeric(btc.bodyStrength) < config.minDirectionalBodyStrength);

  if (strongTrend) {
    tags.push("STRONG_TRENDING_MARKET");
    reasons.push("BTC and ETH trend in the same direction with strong EMA/momentum structure");
  }
  if (chop) {
    tags.push("SIDEWAYS_CHOP_MARKET");
    reasons.push("benchmark trend structure is mixed or compressed");
  }
  if (highVolatilityBreakout) {
    tags.push("HIGH_VOLATILITY_BREAKOUT_MARKET");
    reasons.push("benchmark volatility plus breakout/volume conditions are elevated");
  }
  if (lowLiquidity) {
    tags.push("LOW_LIQUIDITY_MARKET");
    reasons.push("benchmark volume expansion is weak");
  }
  if (btcLed) {
    tags.push("BTC_LED_MARKET");
    reasons.push("BTC is leading benchmark direction");
  }
  if (deadMarket) {
    tags.push("DEAD_MARKET_CONDITIONS");
    reasons.push("benchmark volatility and volume are both muted");
  }
  if (fakeBreakout) {
    tags.push("FAKE_BREAKOUT_ENVIRONMENT");
    reasons.push("breakout-like candle appears in mixed or unstable benchmark structure");
  }
  if (!tags.length) {
    tags.push("ALTCOIN_MOMENTUM_MARKET");
    reasons.push("benchmark market is not dominant; symbol-level momentum can lead");
  }

  let primary = tags[0];
  if (deadMarket) primary = "DEAD_MARKET_CONDITIONS";
  else if (fakeBreakout) primary = "FAKE_BREAKOUT_ENVIRONMENT";
  else if (highVolatilityBreakout) primary = "HIGH_VOLATILITY_BREAKOUT_MARKET";
  else if (strongTrend) primary = "STRONG_TRENDING_MARKET";
  else if (btcLed) primary = "BTC_LED_MARKET";
  else if (chop) primary = "SIDEWAYS_CHOP_MARKET";

  let aggressionMultiplier = 1;
  let riskMultiplier = 1;
  let leverageMultiplier = 1;
  let explorationMultiplier = 1;
  let scoreAdjustment = 0;
  let minSignalAdjustment = 0;
  let minConvictionAdjustment = 0;
  let holdMultiplier = 1;
  let trailingDistanceMultiplier = 1;

  if (strongTrend) {
    aggressionMultiplier *= 1.12;
    riskMultiplier *= 1.08;
    explorationMultiplier *= 1.05;
    scoreAdjustment += 5;
    minSignalAdjustment -= 2;
    minConvictionAdjustment -= 1;
    holdMultiplier *= 1.2;
    trailingDistanceMultiplier *= 1.12;
  }
  if (highVolatilityBreakout) {
    aggressionMultiplier *= 1.1;
    riskMultiplier *= 0.92;
    leverageMultiplier *= 0.85;
    explorationMultiplier *= 1;
    scoreAdjustment += 4;
    holdMultiplier *= 1.05;
    trailingDistanceMultiplier *= 0.78;
  }
  if (btcLed) {
    aggressionMultiplier *= 1.06;
    scoreAdjustment += 3;
  }
  if (chop) {
    aggressionMultiplier *= 0.72;
    riskMultiplier *= 0.78;
    leverageMultiplier *= 0.82;
    explorationMultiplier *= 0.65;
    scoreAdjustment -= 5;
    minSignalAdjustment += 2;
    minConvictionAdjustment += 2;
    holdMultiplier *= 0.88;
    trailingDistanceMultiplier *= 0.82;
  }
  if (lowLiquidity) {
    aggressionMultiplier *= 0.82;
    riskMultiplier *= 0.8;
    leverageMultiplier *= 0.88;
    explorationMultiplier *= 0.7;
    scoreAdjustment -= 3;
    minSignalAdjustment += 2;
  }
  if (deadMarket) {
    aggressionMultiplier *= 0.55;
    riskMultiplier *= 0.62;
    leverageMultiplier *= 0.7;
    explorationMultiplier *= 0.35;
    scoreAdjustment -= 8;
    minSignalAdjustment += 5;
    minConvictionAdjustment += 5;
  }
  if (fakeBreakout) {
    aggressionMultiplier *= 0.72;
    riskMultiplier *= 0.75;
    leverageMultiplier *= 0.82;
    explorationMultiplier *= 0.55;
    scoreAdjustment -= 6;
    minSignalAdjustment += 3;
    minConvictionAdjustment += 3;
    trailingDistanceMultiplier *= 0.82;
  }

  return {
    direction,
    primary,
    tags,
    confidence: Number(clamp(avgStrength + (highVolatilityBreakout ? 8 : 0) - (fakeBreakout ? 12 : 0) - (deadMarket ? 10 : 0), 1, 99).toFixed(2)),
    btcDirection,
    ethDirection,
    btcTrendStrength: btcStrength,
    ethTrendStrength: ethStrength,
    btcVolatilityPct: numeric(btc.atrPct),
    ethVolatilityPct: numeric(eth.atrPct),
    btcMomentumPct: numeric(btc.momentumPct),
    ethMomentumPct: numeric(eth.momentumPct),
    btcVolumeSpike: numeric(btc.volumeSpike),
    ethVolumeSpike: numeric(eth.volumeSpike),
    btcBreakout,
    ethBreakout,
    btcInstability,
    avgAtrPct: Number(avgAtrPct.toFixed(4)),
    avgVolumeSpike: Number(avgVolumeSpike.toFixed(4)),
    aggressionMultiplier: Number(clamp(aggressionMultiplier, 0.2, 1.35).toFixed(3)),
    riskMultiplier: Number(clamp(riskMultiplier, 0.25, 1.2).toFixed(3)),
    leverageMultiplier: Number(clamp(leverageMultiplier, 0.35, 1.05).toFixed(3)),
    explorationMultiplier: Number(clamp(explorationMultiplier, 0, 1.25).toFixed(3)),
    scoreAdjustment: Number(clamp(scoreAdjustment, -24, 14).toFixed(2)),
    minSignalAdjustment: Math.round(clamp(minSignalAdjustment, -5, 12)),
    minConvictionAdjustment: Math.round(clamp(minConvictionAdjustment, -4, 12)),
    holdMultiplier: Number(clamp(holdMultiplier, 0.65, 1.35).toFixed(3)),
    trailingDistanceMultiplier: Number(clamp(trailingDistanceMultiplier, 0.55, 1.25).toFixed(3)),
    reasons,
  };
}

function signalRegimeTags(config, marketProfile, parts) {
  const tags = new Set(marketProfile.tags || []);
  const strongSymbolMomentum =
    parts.volumeSpike >= config.minVolumeSpike + 0.35 &&
    parts.directedFastMomentum >= config.minBurstMomentumPct &&
    (parts.breakSignal || parts.fomoTrigger || parts.hasMomentumPersistence);
  if (
    strongSymbolMomentum &&
    !tags.has("BTC_LED_MARKET") &&
    !parts.btcContradictsSide
  ) {
    tags.add("ALTCOIN_MOMENTUM_MARKET");
  }
  if (parts.liquidityScore < config.minLiquidityScore || parts.spreadPct > config.maxSpreadPct * 0.85) {
    tags.add("LOW_LIQUIDITY_MARKET");
  }
  if (
    tags.has("SIDEWAYS_CHOP_MARKET") &&
    parts.breakSignal &&
    parts.volumeSpike < config.minVolumeSpike + 0.35 &&
    parts.trendQualityScore < 55
  ) {
    tags.add("FAKE_BREAKOUT_ENVIRONMENT");
  }
  if (
    tags.has("DEAD_MARKET_CONDITIONS") &&
    strongSymbolMomentum &&
    parts.liquidityScore >= config.minLiquidityScore + 10
  ) {
    tags.add("ALTCOIN_MOMENTUM_MARKET");
  }
  return [...tags];
}

module.exports = {
  marketProfileFromBenchmarks,
  neutralProfile,
  profileFromDirection,
  sessionProfile,
  signalRegimeTags,
  trendStrength,
};
