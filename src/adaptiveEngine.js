"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MEMORY_VERSION = 1;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function sessionType(timestamp) {
  const hour = new Date(timestamp || Date.now()).getUTCHours();
  if (hour >= 0 && hour < 7) return "ASIA";
  if (hour >= 7 && hour < 13) return "EUROPE";
  if (hour >= 13 && hour < 22) return "US";
  return "LATE_US_ASIA_HANDOFF";
}

function resultType(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("take profit")) return "TP";
  if (text.includes("stop loss")) return "SL";
  if (text.includes("trailing")) return "TRAILING_STOP";
  if (text.includes("liquidation")) return "LIQUIDATION_PROTECTION";
  return "OTHER_EXIT";
}

function setupTypeFromSignal(signal = {}) {
  const reasons = Array.isArray(signal.scoreBreakdown) ? signal.scoreBreakdown.join(" ").toLowerCase() : "";
  if (signal.continuationSetupType && signal.continuationSetupType !== "NONE") return signal.continuationSetupType;
  if (signal.pullbackContinuation) return "PULLBACK_CONTINUATION";
  if (signal.breakoutRetest) return "BREAKOUT_RETEST";
  if (signal.momentumResumption) return "MOMENTUM_RESUMPTION";
  if (signal.trendAcceleration) return "TREND_ACCELERATION";
  if (signal.continuationBreakout) return "CONTINUATION_BREAKOUT";
  if (signal.fomoTrigger) return "FOMO_BREAKOUT";
  if (signal.microBreakoutTriggered) return "MICRO_BREAKOUT";
  if (signal.breakoutTriggered || reasons.includes("breakout") || reasons.includes("breakdown")) return "BREAKOUT";
  if (reasons.includes("ema alignment")) return "TREND_MOMENTUM";
  if (reasons.includes("volume")) return "VOLUME_MOMENTUM";
  return "MOMENTUM_SCALP";
}

function eliteConditionKeyFromSignal(signal = {}) {
  const tags = Array.isArray(signal.marketRegimeTags) ? signal.marketRegimeTags : [];
  const regime = tags.includes("HIGH_VOLATILITY_BREAKOUT_MARKET")
    ? "BREAKOUT_VOL"
    : tags.includes("STRONG_TRENDING_MARKET")
      ? "TREND"
      : signal.marketRegimeType || signal.marketRegime || signal.regime || "UNKNOWN";
  const momentum = numeric(signal.momentumPersistenceCandles) >= 4 ? "PERSIST_4" : "PERSIST_2";
  const volume = signal.volumeCondition || signal.volumeConditions || "UNKNOWN_VOLUME";
  const continuation = signal.continuationSetupType || "NO_CONTINUATION";
  const macro = signal.macroAligned ? "MACRO_ALIGNED" : signal.macroContradicts ? "MACRO_CONTRA" : "MACRO_NEUTRAL";
  return `${signal.symbol || "UNKNOWN"}:${signal.side || "SIDE"}:${signal.setupType || setupTypeFromSignal(signal)}:${continuation}:${regime}:${volume}:${momentum}:${macro}:${signal.sessionRegime || signal.sessionType || "SESSION"}`;
}

function bucketNumber(value, buckets) {
  const numericValue = numeric(value);
  for (const bucket of buckets) {
    if (numericValue <= bucket.max) return bucket.name;
  }
  return buckets[buckets.length - 1].name;
}

function spreadBucket(value) {
  return bucketNumber(value, [
    { max: 0.03, name: "TIGHT_SPREAD" },
    { max: 0.08, name: "NORMAL_SPREAD" },
    { max: 0.18, name: "WIDE_SPREAD" },
    { max: Number.POSITIVE_INFINITY, name: "VERY_WIDE_SPREAD" },
  ]);
}

function volatilityBucket(value, label) {
  if (label && label !== "UNKNOWN") return label;
  return bucketNumber(value, [
    { max: 0.35, name: "LOW_VOLATILITY" },
    { max: 0.9, name: "NORMAL_VOLATILITY" },
    { max: 1.6, name: "HIGH_VOLATILITY" },
    { max: Number.POSITIVE_INFINITY, name: "ABNORMAL_VOLATILITY" },
  ]);
}

function costBucket(value) {
  return bucketNumber(value, [
    { max: 0.18, name: "LOW_COST" },
    { max: 0.35, name: "NORMAL_COST" },
    { max: 0.6, name: "HIGH_COST" },
    { max: Number.POSITIVE_INFINITY, name: "VERY_HIGH_COST" },
  ]);
}

function summarize(records) {
  const summary = {
    count: records.length,
    wins: 0,
    losses: 0,
    winRatePct: 0,
    totalPnlUsdt: 0,
    totalPnlPct: 0,
    feeAdjustedPnlUsdt: 0,
    totalFeesUsdt: 0,
    averagePnlUsdt: 0,
    averagePnlPct: 0,
    averageHoldSeconds: 0,
    averageSlippagePct: 0,
    profitFactor: 0,
  };
  let grossWins = 0;
  let grossLosses = 0;
  for (const record of records) {
    const pnl = numeric(record.realizedPnlUsdt);
    const pnlPct = numeric(record.realizedPnlPct);
    const fees = numeric(record.feesPaidUsdt);
    summary.totalPnlUsdt += pnl;
    summary.totalPnlPct += pnlPct;
    summary.feeAdjustedPnlUsdt += pnl;
    summary.totalFeesUsdt += fees;
    summary.averageHoldSeconds += numeric(record.holdingTimeSeconds);
    summary.averageSlippagePct += numeric(record.slippagePct);
    if (pnl > 0) {
      summary.wins += 1;
      grossWins += pnl;
    }
    if (pnl < 0) {
      summary.losses += 1;
      grossLosses += Math.abs(pnl);
    }
  }
  if (records.length) {
    summary.winRatePct = Number(((summary.wins / records.length) * 100).toFixed(2));
    summary.averagePnlUsdt = Number((summary.totalPnlUsdt / records.length).toFixed(6));
    summary.averagePnlPct = Number((summary.totalPnlPct / records.length).toFixed(4));
    summary.averageHoldSeconds = Number((summary.averageHoldSeconds / records.length).toFixed(2));
    summary.averageSlippagePct = Number((summary.averageSlippagePct / records.length).toFixed(4));
  }
  summary.profitFactor = grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(3)) : grossWins > 0 ? 999 : 0;
  summary.totalPnlUsdt = Number(summary.totalPnlUsdt.toFixed(6));
  summary.totalPnlPct = Number(summary.totalPnlPct.toFixed(4));
  summary.feeAdjustedPnlUsdt = Number(summary.feeAdjustedPnlUsdt.toFixed(6));
  summary.totalFeesUsdt = Number(summary.totalFeesUsdt.toFixed(6));
  return summary;
}

function groupBy(records, keyFn) {
  const groups = {};
  for (const record of records) {
    const key = String(keyFn(record) || "UNKNOWN");
    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }
  const output = {};
  for (const [key, rows] of Object.entries(groups)) {
    output[key] = summarize(rows);
  }
  return output;
}

function leaderboard(grouped, direction = "best", limit = 10) {
  return Object.entries(grouped)
    .map(([key, stats]) => ({ key, ...stats }))
    .sort((left, right) =>
      direction === "best"
        ? right.feeAdjustedPnlUsdt - left.feeAdjustedPnlUsdt || right.winRatePct - left.winRatePct
        : left.feeAdjustedPnlUsdt - right.feeAdjustedPnlUsdt || left.winRatePct - right.winRatePct
    )
    .slice(0, limit);
}

function drawdown(records) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const record of records) {
    equity += numeric(record.realizedPnlUsdt);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  return {
    maxDrawdownUsdt: Number(maxDrawdown.toFixed(6)),
  };
}

function emptyMemory() {
  return {
    version: MEMORY_VERSION,
    updatedAt: new Date().toISOString(),
    trades: [],
    rolling: {
      last20: summarize([]),
      last50: summarize([]),
      last200: summarize([]),
    },
    stats: {},
    adaptive: {
      mode: "BASELINE",
      blacklists: {},
      policy: {},
    },
  };
}

class AdaptiveEngine {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.memory = emptyMemory();
    this.analytics = {};
  }

  load() {
    const loaded = readJson(this.config.tradeMemoryFile, emptyMemory());
    this.memory = {
      ...emptyMemory(),
      ...loaded,
      trades: Array.isArray(loaded.trades) ? loaded.trades : [],
      adaptive: { ...emptyMemory().adaptive, ...(loaded.adaptive || {}) },
    };
    this.rebuild();
    this.save();
  }

  syncFromClosedTrades(trades) {
    if (!this.config.adaptiveLearningEnabled) return;
    const existing = new Set(this.memory.trades.map((trade) => trade.id).filter(Boolean));
    let imported = 0;
    for (const trade of trades) {
      if (trade.status !== "CLOSED" || existing.has(trade.id)) continue;
      this.memory.trades.push(this.memoryRecordFromTrade(trade));
      existing.add(trade.id);
      imported += 1;
    }
    if (imported) {
      this.log("INFO", "Imported legacy closed trades into adaptive trade memory.", { imported });
      this.rebuild();
      this.save();
    }
  }

  memoryRecordFromTrade(trade) {
    const timestamp = trade.exitedAt || trade.openedAt || new Date().toISOString();
    const setupType = trade.setupType || setupTypeFromSignal(trade);
    const pnlUsdt = numeric(trade.pnlUsdt);
    const plannedEntry = numeric(trade.plannedEntryPrice, numeric(trade.entryPrice));
    const entry = numeric(trade.entryPrice, plannedEntry);
    const slippagePct =
      trade.slippagePct !== undefined
        ? numeric(trade.slippagePct)
        : trade.side === "SHORT"
          ? ((plannedEntry - entry) / plannedEntry) * 100
          : ((entry - plannedEntry) / plannedEntry) * 100;
    return {
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      setupType,
      score: numeric(trade.signalScore),
      timestamp,
      openedAt: trade.openedAt || null,
      exitedAt: trade.exitedAt || null,
      holdingTimeSeconds: numeric(trade.holdSeconds),
      realizedPnlPct: numeric(trade.pnlPct),
      realizedPnlUsdt: pnlUsdt,
      feesPaidUsdt: numeric(trade.feesUsdt || trade.estimatedFeesUsdt),
      grossPnlUsdt: numeric(trade.grossPnlUsdt),
      leverage: numeric(trade.leverage),
      btcMarketRegime: trade.btcMarketRegime || trade.btcTrend || trade.signalRegime || "UNKNOWN",
      marketRegime: trade.signalRegime || "UNKNOWN",
      marketRegimeType: trade.marketRegimeType || trade.primaryMarketRegime || trade.signalMarketRegimeType || "UNKNOWN",
      marketRegimeTags: Array.isArray(trade.marketRegimeTags) ? trade.marketRegimeTags : [],
      marketRegimeConfidence: numeric(trade.marketRegimeConfidence),
      btcTrendStrength: numeric(trade.btcTrendStrength),
      btcVolatilityPct: numeric(trade.btcVolatilityPct),
      btcMomentumPct: numeric(trade.btcMomentumPct),
      btcInstability: Boolean(trade.btcInstability),
      volatilityRegime: trade.volatilityRegime || "UNKNOWN",
      volumeConditions: trade.volumeCondition || "UNKNOWN",
      entryMomentumPct: numeric(trade.entryMomentumPct || trade.momentum1mPct),
      spreadPct: numeric(trade.spreadPct),
      slippagePct: Number.isFinite(slippagePct) ? Number(slippagePct.toFixed(4)) : 0,
      expectedMovePct: numeric(trade.expectedMovePct),
      estimatedRoundTripCostPct: numeric(trade.estimatedRoundTripCostPct),
      projectedTotalCostUsdt: numeric(trade.projectedTotalCostUsdt),
      projectedNetProfitUsdt: numeric(trade.projectedNetProfitUsdt),
      actualFundingUsdt: numeric(trade.actualFundingUsdt),
      feeEdgeRatio: numeric(trade.feeEdgeRatio),
      projectedNetEdgePct: numeric(trade.projectedNetEdgePct),
      convictionScore: numeric(trade.convictionScore),
      convictionTier: trade.convictionTier || "UNCLASSIFIED",
      edgeTier: trade.edgeTier || "UNCLASSIFIED",
      sizingTier: trade.convictionTier || trade.edgeTier || trade.tradeCategory || "UNCLASSIFIED",
      riskPctOfEquity: numeric(trade.riskPctOfEquity),
      maxLossAtStopUsdt: numeric(trade.maxLossAtStopUsdt),
      eliteSetup: Boolean(trade.eliteSetup),
      eliteConditionKey: trade.eliteConditionKey || eliteConditionKeyFromSignal(trade),
      smartProjectedNetEdgePct: numeric(trade.smartProjectedNetEdgePct),
      estimatedTpProbability: numeric(trade.estimatedTpProbability),
      marketPersonality: trade.marketPersonality || "UNKNOWN",
      continuationStrength: numeric(trade.continuationStrength),
      continuationSetupType: trade.continuationSetupType || setupType,
      continuationComponents: trade.continuationComponents || {},
      macroTrend: trade.trend1h || trade.macroTrend || "UNKNOWN",
      macroAligned: Boolean(trade.macroAligned),
      macroContradicts: Boolean(trade.macroContradicts),
      trendPersistence: numeric(trade.momentumPersistenceCandles),
      liquidityScore: numeric(trade.liquidityScore),
      trendQualityScore: numeric(trade.trendQualityScore),
      antiChopScore: numeric(trade.antiChopScore),
      tradeCategory: trade.tradeCategory || (trade.explorationTrade ? "EXPLORATION" : "HIGH_CONVICTION"),
      explorationTrade: Boolean(trade.explorationTrade),
      isReentry: Boolean(trade.isReentry || trade.intelligentReentryTriggered),
      isFlip: Boolean(trade.isFlip),
      continuationVsFlip: trade.isFlip ? "FLIP" : /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/.test(setupType) ? "CONTINUATION" : "OTHER",
      explorationThresholdSoftened: Boolean(trade.explorationThresholdSoftened),
      explorationMemoryRelaxation: numeric(trade.explorationMemoryRelaxation),
      moderateChopAccepted: Boolean(trade.moderateChopAccepted),
      result: trade.result || resultType(trade.exitReason),
      winLoss: pnlUsdt > 0 ? "WIN" : pnlUsdt < 0 ? "LOSS" : "FLAT",
      sessionType: trade.sessionType || sessionType(timestamp),
      sessionRegime: trade.sessionRegime || trade.sessionType || sessionType(timestamp),
      breakoutTriggered: Boolean(trade.breakoutTriggered),
      fomoTriggered: Boolean(trade.fomoTrigger || trade.fomoTriggered),
      microBreakoutTriggered: Boolean(trade.microBreakoutTriggered),
      spreadBucket: trade.spreadBucket || spreadBucket(trade.spreadPct),
      volatilityBucket: trade.volatilityBucket || volatilityBucket(trade.btcVolatilityPct || trade.atrPct, trade.volatilityRegime),
      costBucket: trade.costBucket || costBucket(trade.estimatedRoundTripCostPct),
      grossPositiveNetNegative: Boolean(trade.grossPositiveNetNegative || (numeric(trade.grossPnlUsdt) > 0 && pnlUsdt < 0)),
      executionType: trade.executionType || "UNKNOWN",
      runnerPartialTaken: Boolean(trade.runnerPartialTaken),
      runnerNetContributionUsdt: numeric(trade.runnerNetContributionUsdt || trade.partialRealizedPnlUsdt),
      adaptiveConfidenceAtEntry: numeric(trade.adaptiveConfidence, 50),
      adaptiveModeAtEntry: trade.adaptiveMode || "BASELINE",
    };
  }

  recordClosedTrade(trade) {
    if (!this.config.adaptiveLearningEnabled || !trade || trade.status !== "CLOSED") return;
    const record = this.memoryRecordFromTrade(trade);
    const existingIndex = this.memory.trades.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      this.memory.trades[existingIndex] = record;
    } else {
      this.memory.trades.push(record);
    }
    if (this.memory.trades.length > this.config.adaptiveMemoryMaxTrades) {
      this.memory.trades = this.memory.trades.slice(-this.config.adaptiveMemoryMaxTrades);
    }
    this.rebuild();
    this.save();
    this.log("INFO", "MEMORY_BUCKET_UPDATED", {
      symbol: record.symbol,
      setupType: record.setupType,
      result: record.result,
      winLoss: record.winLoss,
      realizedPnlUsdt: record.realizedPnlUsdt,
      feesPaidUsdt: record.feesPaidUsdt,
      netLearningSource: "completed reconciled trade after available costs",
      rolling20WinRatePct: this.memory.rolling.last20.winRatePct,
      adaptiveMode: this.memory.adaptive.mode,
      continuationSetupType: record.continuationSetupType,
      continuationStrength: record.continuationStrength,
      marketPersonality: record.marketPersonality,
      macroAligned: record.macroAligned,
    });
    const bucket =
      this.memory.stats.byContinuationSetup[record.continuationSetupType] ||
      this.memory.stats.bySetupType[record.setupType];
    if (bucket && bucket.count >= this.config.minAdaptiveBucketTrades) {
      if (bucket.feeAdjustedPnlUsdt > 0 && bucket.profitFactor >= 1.1) {
        this.log("INFO", "NET_POSITIVE_PATTERN_STRENGTHENED", {
          setupType: record.continuationSetupType,
          samples: bucket.count,
          netPnlUsdt: bucket.feeAdjustedPnlUsdt,
          profitFactor: bucket.profitFactor,
        });
      } else if (bucket.feeAdjustedPnlUsdt < 0 && bucket.profitFactor < 1) {
        this.log("INFO", "NET_NEGATIVE_PATTERN_DOWNWEIGHTED", {
          setupType: record.continuationSetupType,
          samples: bucket.count,
          netPnlUsdt: bucket.feeAdjustedPnlUsdt,
          profitFactor: bucket.profitFactor,
        });
      }
    }
  }

  rebuild() {
    const records = [...this.memory.trades].sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
    this.memory.trades = records;
    this.memory.rolling = {
      last20: summarize(records.slice(-20)),
      last50: summarize(records.slice(-50)),
      last200: summarize(records.slice(-200)),
    };
    const bySymbol = groupBy(records, (record) => record.symbol);
    const bySetupType = groupBy(records, (record) => record.setupType);
    const byHour = groupBy(records, (record) => new Date(record.timestamp || 0).getUTCHours());
    const byBtcRegime = groupBy(records, (record) => record.btcMarketRegime);
    const bySession = groupBy(records, (record) => record.sessionType);
    const bySessionRegime = groupBy(records, (record) => record.sessionRegime || record.sessionType);
    const byMarketRegimeType = groupBy(records, (record) => record.marketRegimeType || record.marketRegime);
    const byMarketRegimeTag = groupBy(records, (record) =>
      Array.isArray(record.marketRegimeTags) && record.marketRegimeTags.length ? record.marketRegimeTags.join("+") : record.marketRegimeType || "UNKNOWN"
    );
    const byVolatilityRegime = groupBy(records, (record) => record.volatilityRegime);
    const byLeverage = groupBy(records, (record) => `${Math.round(numeric(record.leverage))}x`);
    const byCondition = groupBy(records, (record) => `${record.setupType}:${record.side}:${record.btcMarketRegime}:${record.volatilityRegime}`);
    const byRegimeCondition = groupBy(records, (record) =>
      `${record.marketRegimeType || record.marketRegime}:${record.setupType}:${record.side}`
    );
    const byRegimeSession = groupBy(records, (record) =>
      `${record.marketRegimeType || record.marketRegime}:${record.sessionRegime || record.sessionType}`
    );
    const byEliteCondition = groupBy(
      records.filter((record) => record.eliteSetup || record.realizedPnlPct >= 1.2 || record.realizedPnlUsdt >= 1),
      (record) => record.eliteConditionKey || eliteConditionKeyFromSignal(record)
    );
    const byMarketPersonality = groupBy(records, (record) => record.marketPersonality || "UNKNOWN");
    const byContinuationSetup = groupBy(records, (record) => record.continuationSetupType || record.setupType || "UNKNOWN");
    const byContinuationStrength = groupBy(records, (record) => {
      const strength = numeric(record.continuationStrength);
      if (strength >= 80) return "ELITE_80_PLUS";
      if (strength >= 65) return "STRONG_65_79";
      if (strength >= 50) return "MODERATE_50_64";
      return "WEAK_UNDER_50";
    });
    const bySymbolContinuation = groupBy(records, (record) =>
      `${record.symbol}:${record.continuationSetupType || record.setupType || "UNKNOWN"}`
    );
    const bySymbolPersonality = groupBy(records, (record) =>
      `${record.symbol}:${record.marketPersonality || "UNKNOWN"}`
    );
    const byMacroAlignment = groupBy(records, (record) =>
      record.macroAligned ? "MACRO_ALIGNED" : record.macroContradicts ? "MACRO_CONTRA" : "MACRO_NEUTRAL"
    );
    const byCostBucket = groupBy(records, (record) => record.costBucket || costBucket(record.estimatedRoundTripCostPct));
    const bySpreadBucket = groupBy(records, (record) => record.spreadBucket || spreadBucket(record.spreadPct));
    const bySizeTier = groupBy(records, (record) => record.sizingTier || record.convictionTier || record.edgeTier || "UNKNOWN");
    const byContinuationFlip = groupBy(records, (record) => record.continuationVsFlip || (record.isFlip ? "FLIP" : "OTHER"));
    const byExecutionType = groupBy(records, (record) => record.executionType || "UNKNOWN");

    this.memory.stats = {
      all: summarize(records),
      bySymbol,
      bySetupType,
      byHour,
      byBtcRegime,
      bySession,
      bySessionRegime,
      byMarketRegimeType,
      byMarketRegimeTag,
      byVolatilityRegime,
      byLeverage,
      byCondition,
      byRegimeCondition,
      byRegimeSession,
      byEliteCondition,
      byMarketPersonality,
      byContinuationSetup,
      byContinuationStrength,
      bySymbolContinuation,
      bySymbolPersonality,
      byMacroAlignment,
      byCostBucket,
      bySpreadBucket,
      bySizeTier,
      byContinuationFlip,
      byExecutionType,
      bestSymbols: leaderboard(bySymbol, "best"),
      worstSymbols: leaderboard(bySymbol, "worst"),
      bestSetups: leaderboard(bySetupType, "best"),
      worstSetups: leaderboard(bySetupType, "worst"),
      strongestSessions: leaderboard(bySession, "best"),
      weakestSessions: leaderboard(bySession, "worst"),
      bestMarketRegimes: leaderboard(byMarketRegimeType, "best"),
      worstMarketRegimes: leaderboard(byMarketRegimeType, "worst"),
      bestEliteConditions: leaderboard(byEliteCondition, "best"),
      bestContinuationSetups: leaderboard(byContinuationSetup, "best"),
      worstContinuationSetups: leaderboard(byContinuationSetup, "worst"),
      bestSymbolSpecializations: leaderboard(bySymbolPersonality, "best"),
      drawdown: drawdown(records),
    };
    this.memory.adaptive.policy = this.buildPolicy();
    this.memory.adaptive.mode = this.memory.adaptive.policy.mode;
    this.analytics = this.buildAnalytics();
    this.memory.updatedAt = new Date().toISOString();
  }

  buildPolicy() {
    const last20 = this.memory.rolling.last20;
    const recoveryWindow = summarize(this.memory.trades.slice(-this.config.adaptiveRecoveryLookbackTrades));
    const enough = last20.count >= this.config.minAdaptiveTrades;
    const weakRecentPerformance =
      enough &&
      last20.feeAdjustedPnlUsdt < 0 &&
      (last20.winRatePct < this.config.defensiveWinRatePct || last20.averagePnlPct < -0.25);
    const feeDragRatio = last20.count > 0
      ? last20.totalFeesUsdt / Math.max(Math.abs(last20.totalPnlUsdt), 0.000001)
      : 0;
    const shortHoldPressure =
      enough &&
      last20.averageHoldSeconds > 0 &&
      last20.averageHoldSeconds < this.config.qualityPacingMinAverageHoldSeconds &&
      last20.feeAdjustedPnlUsdt <= 0;
    const qualityPacingActive = Boolean(
      this.config.qualityPacingEnabled &&
      enough &&
      (
        last20.winRatePct < this.config.qualityPacingMinWinRatePct ||
        feeDragRatio >= this.config.qualityPacingFeeDragRatio ||
        shortHoldPressure
      )
    );
    const continuousExecution = this.config.continuousExecutionMode || this.config.aggressiveLearningPhase;
    let mode = this.config.aggressiveLearningPhase ? "AGGRESSIVE_LEARNING_PHASE" : this.config.learningPhaseMode ? "LEARNING_PHASE" : "BASELINE";
    let riskMultiplier = 1;
    let signalThresholdAdjustment = 0;
    let maxLeverage = this.config.maxLeverage;
    let maxOpenPositions = this.config.maxOpenPositions;
    let maxTradesPerDay = this.config.maxTradesPerDay;
    let explorationMultiplier = 1;
    let recoveryAggressionRestored = false;

    if (weakRecentPerformance) {
      mode = this.config.aggressiveLearningPhase ? "CAUTIOUS_ACTIVE" : this.config.learningPhaseMode ? "CAUTIOUS_LEARNING" : "DEFENSIVE";
      riskMultiplier = this.config.aggressiveLearningPhase ? 0.97 : this.config.learningPhaseMode ? 0.94 : 0.88;
      signalThresholdAdjustment = this.config.aggressiveLearningPhase ? -1 : this.config.learningPhaseMode ? 0 : 1;
      maxLeverage = Math.max(1, Math.floor(this.config.maxLeverage * (this.config.aggressiveLearningPhase ? 1 : this.config.learningPhaseMode ? 0.95 : 0.9)));
      maxOpenPositions = Math.max(1, Math.ceil(this.config.maxOpenPositions * (this.config.learningPhaseMode ? 1 : 0.9)));
      maxTradesPerDay = this.config.learningPhaseMode ? this.config.maxTradesPerDay : Math.max(12, Math.floor(this.config.maxTradesPerDay * 0.85));
      explorationMultiplier = this.config.aggressiveLearningPhase ? 2.25 : this.config.learningPhaseMode ? 1.45 : 1.05;
      const recoveryImproved =
        recoveryWindow.count >= Math.min(this.config.minAdaptiveTrades, this.config.adaptiveRecoveryLookbackTrades) &&
        (
          recoveryWindow.winRatePct >= this.config.adaptiveRecoveryWinRatePct ||
          recoveryWindow.feeAdjustedPnlUsdt > 0 ||
          recoveryWindow.winRatePct >= last20.winRatePct + 12
        );
      if (
        recoveryImproved
      ) {
        mode = this.config.aggressiveLearningPhase ? "AGGRESSIVE_LEARNING_RECOVERY" : this.config.learningPhaseMode ? "LEARNING_RECOVERY" : "DEFENSIVE_RECOVERY";
        riskMultiplier = this.config.aggressiveLearningPhase ? 1.08 : this.config.learningPhaseMode ? 1.05 : 1;
        signalThresholdAdjustment = this.config.aggressiveLearningPhase ? -3 : this.config.learningPhaseMode ? -2 : -1;
        maxLeverage = Math.max(1, Math.floor(this.config.maxLeverage * (this.config.learningPhaseMode ? 1 : 0.95)));
        maxOpenPositions = Math.max(1, Math.ceil(this.config.maxOpenPositions * (this.config.learningPhaseMode ? 1 : 0.9)));
        maxTradesPerDay = this.config.learningPhaseMode ? this.config.maxTradesPerDay : Math.max(14, Math.floor(this.config.maxTradesPerDay * 0.9));
        explorationMultiplier = this.config.aggressiveLearningPhase ? 2.5 : this.config.learningPhaseMode ? 1.7 : 1.25;
        recoveryAggressionRestored = true;
      }
    } else if (enough && last20.winRatePct > this.config.aggressiveWinRatePct && last20.feeAdjustedPnlUsdt > 0) {
      mode = "CONTROLLED_AGGRESSIVE";
      riskMultiplier = 1.15;
      signalThresholdAdjustment = -3;
      maxLeverage = this.config.maxLeverage;
      maxOpenPositions = this.config.maxOpenPositions;
      maxTradesPerDay = this.config.maxTradesPerDay;
      explorationMultiplier = this.config.aggressiveLearningPhase ? 2.2 : this.config.learningPhaseMode ? 1.5 : 1.15;
    }

    if (!this.config.learningPhaseMode && last20.count >= this.config.minAdaptiveTrades && last20.totalFeesUsdt > Math.abs(last20.totalPnlUsdt) * 0.7) {
      signalThresholdAdjustment += 2;
      riskMultiplier *= 0.92;
    }
    let qualityPacingReason = null;
    if (qualityPacingActive) {
      signalThresholdAdjustment += this.config.qualityPacingSignalAdjustment;
      riskMultiplier *= this.config.qualityPacingRiskMultiplier;
      explorationMultiplier *= 0.75;
      if (last20.winRatePct < this.config.qualityPacingMinWinRatePct) {
        qualityPacingReason = `recent winrate ${last20.winRatePct}% below ${this.config.qualityPacingMinWinRatePct}%`;
      } else if (feeDragRatio >= this.config.qualityPacingFeeDragRatio) {
        qualityPacingReason = `fee drag ratio ${feeDragRatio.toFixed(2)} exceeds ${this.config.qualityPacingFeeDragRatio}`;
      } else {
        qualityPacingReason = `average hold ${last20.averageHoldSeconds}s below ${this.config.qualityPacingMinAverageHoldSeconds}s`;
      }
    }
    let highActivityAdjustment = 0;
    if (this.config.highActivityMode) {
      highActivityAdjustment = qualityPacingActive ? -1 : -2;
      signalThresholdAdjustment += highActivityAdjustment;
      explorationMultiplier *= qualityPacingActive ? 1.1 : 1.35;
      riskMultiplier *= qualityPacingActive ? 1.02 : 1.06;
    }
    let activityFloorEngaged = false;
    const preFloorMaxTradesPerDay = maxTradesPerDay;
    if (this.config.adaptiveActivityFloorEnabled) {
      maxTradesPerDay = Math.min(this.config.maxTradesPerDay, Math.max(maxTradesPerDay, this.config.activityFloorMinTradesPerDay));
      activityFloorEngaged = maxTradesPerDay > preFloorMaxTradesPerDay;
    }
    let explorationBudget = this.config.explorationModeEnabled
      ? this.config.disableDailyTradeLimits || continuousExecution
        ? Number.MAX_SAFE_INTEGER
        : Math.min(
            this.config.explorationMaxTradesPerDay,
            Math.max(1, Math.floor(maxTradesPerDay * this.config.explorationTradeRatio * explorationMultiplier))
          )
      : 0;
    const preFloorExplorationBudget = explorationBudget;
    if (this.config.adaptiveActivityFloorEnabled && this.config.explorationModeEnabled && !this.config.disableDailyTradeLimits && !this.config.aggressiveLearningPhase) {
      explorationBudget = Math.min(
        this.config.explorationMaxTradesPerDay,
        Math.max(explorationBudget, this.config.activityFloorMinExplorationBudget)
      );
      activityFloorEngaged = activityFloorEngaged || explorationBudget > preFloorExplorationBudget;
    }
    const bestRegime = leaderboard(this.memory.stats.byMarketRegimeType || {}, "best", 1)[0] || null;
    const worstRegime = leaderboard(this.memory.stats.byMarketRegimeType || {}, "worst", 1)[0] || null;

    const policy = {
      mode,
      sampleSize: last20.count,
      rollingWinRatePct: last20.winRatePct,
      rollingPnlUsdt: last20.feeAdjustedPnlUsdt,
      recoverySampleSize: recoveryWindow.count,
      recoveryWinRatePct: recoveryWindow.winRatePct,
      recoveryPnlUsdt: recoveryWindow.feeAdjustedPnlUsdt,
      recoveryAggressionRestored,
      learningPhaseActive: this.config.learningPhaseMode,
      aggressiveLearningPhaseActive: this.config.aggressiveLearningPhase,
      highActivityModeActive: this.config.highActivityMode,
      highActivityAdjustment,
      continuousExecutionMode: this.config.continuousExecutionMode,
      qualityPacingActive,
      qualityPacingReason,
      feeDragRatio: Number(feeDragRatio.toFixed(3)),
      shortHoldPressure,
      dailyTradeLimitsDisabled: this.config.disableDailyTradeLimits || continuousExecution,
      explorationDailyCapDisabled: this.config.disableDailyTradeLimits || continuousExecution,
      riskMultiplier: clamp(riskMultiplier, this.config.adaptiveRiskMinMultiplier, this.config.adaptiveRiskMaxMultiplier),
      signalThresholdAdjustment,
      minSignalScore: clamp(this.config.minSignalScore + signalThresholdAdjustment, 1, 100),
      explorationEnabled: this.config.explorationModeEnabled && explorationBudget > 0,
      explorationBudget,
      explorationExpansionActive: explorationBudget > preFloorExplorationBudget || explorationMultiplier > 1,
      activityFloorEngaged,
      activityFloorSignalRelaxPoints: activityFloorEngaged ? this.config.activityFloorSignalRelaxPoints : 0,
      activityFloorConvictionRelaxPoints: activityFloorEngaged ? this.config.activityFloorConvictionRelaxPoints : 0,
      activityFloorChopToleranceBonus: activityFloorEngaged ? this.config.activityFloorChopToleranceBonus : 0,
      explorationMinSignalScore: clamp(
        this.config.explorationMinSignalScore +
          Math.max(0, Math.floor(signalThresholdAdjustment / 2)) +
          (qualityPacingActive ? this.config.qualityPacingExplorationAdjustment : 0) -
          (activityFloorEngaged ? this.config.activityFloorSignalRelaxPoints : 0),
        1,
        100
      ),
      explorationMinConvictionScore: clamp(
        this.config.explorationMinConvictionScore +
          Math.max(0, Math.floor(signalThresholdAdjustment / 2)) +
          (qualityPacingActive ? this.config.qualityPacingExplorationAdjustment : 0) -
          (activityFloorEngaged ? this.config.activityFloorConvictionRelaxPoints : 0),
        1,
        100
      ),
      regimeSelfTuning: {
        bestRegime: bestRegime && bestRegime.count >= this.config.minAdaptiveBucketTrades ? bestRegime.key : null,
        worstRegime: worstRegime && worstRegime.count >= this.config.minAdaptiveBucketTrades ? worstRegime.key : null,
        memoryWeight: this.config.regimeMemoryWeight,
      },
      maxLeverage: clamp(maxLeverage, 1, this.config.maxLeverage),
      maxOpenPositions: clamp(maxOpenPositions, 1, this.config.maxOpenPositions),
      maxTradesPerDay: this.config.disableDailyTradeLimits || continuousExecution ? Number.MAX_SAFE_INTEGER : clamp(maxTradesPerDay, 1, this.config.maxTradesPerDay),
    };
    if (this.config.profitControlledEquityMode && this.config.profitExpansionMode) {
      return {
        ...policy,
        mode: "PROFIT_MODE",
        learningPhaseActive: false,
        aggressiveLearningPhaseActive: false,
        explorationEnabled: false,
        explorationBudget: 0,
        explorationExpansionActive: false,
        activityFloorEngaged: false,
        activityFloorSignalRelaxPoints: 0,
        activityFloorConvictionRelaxPoints: 0,
        activityFloorChopToleranceBonus: 0,
        dailyTradeLimitsDisabled: true,
        explorationDailyCapDisabled: true,
        highActivityModeActive: true,
        minSignalScore: this.config.tradeFrequencyRecoveryMode
          ? this.config.tradeFrequencyRecoveryMinSignalScore
          : policy.minSignalScore,
        maxTradesPerDay: Number.MAX_SAFE_INTEGER,
      };
    }
    return policy;
  }

  buildAnalytics() {
    const stats = this.memory.stats || {};
    return {
      version: MEMORY_VERSION,
      updatedAt: new Date().toISOString(),
      totalPnl: stats.all || summarize([]),
      rolling: this.memory.rolling,
      dailyPnl: groupBy(this.memory.trades, (record) => String(record.timestamp || "").slice(0, 10)),
      weeklyPnl: groupBy(this.memory.trades, (record) => {
        const date = new Date(record.timestamp || 0);
        const year = date.getUTCFullYear();
        const first = Date.UTC(year, 0, 1);
        const week = Math.ceil((((date.getTime() - first) / 86400000) + new Date(first).getUTCDay() + 1) / 7);
        return `${year}-W${String(week).padStart(2, "0")}`;
      }),
      symbolLeaderboard: {
        best: stats.bestSymbols || [],
        worst: stats.worstSymbols || [],
      },
      setupLeaderboard: {
        best: stats.bestSetups || [],
        worst: stats.worstSetups || [],
      },
      sessionLeaderboard: {
        strongest: stats.strongestSessions || [],
        weakest: stats.weakestSessions || [],
      },
      marketRegimeLeaderboard: {
        best: stats.bestMarketRegimes || [],
        worst: stats.worstMarketRegimes || [],
      },
      eliteConditionLeaderboard: {
        best: stats.bestEliteConditions || [],
      },
      continuationLeaderboard: {
        best: stats.bestContinuationSetups || [],
        worst: stats.worstContinuationSetups || [],
      },
      symbolSpecializationLeaderboard: {
        best: stats.bestSymbolSpecializations || [],
      },
      marketPersonalityPerformance: stats.byMarketPersonality || {},
      continuationPerformance: stats.byContinuationSetup || {},
      continuationVsFlipPerformance: stats.byContinuationFlip || {},
      continuationStrengthPerformance: stats.byContinuationStrength || {},
      symbolContinuationPerformance: stats.bySymbolContinuation || {},
      macroAlignmentPerformance: stats.byMacroAlignment || {},
      costBucketPerformance: stats.byCostBucket || {},
      spreadBucketPerformance: stats.bySpreadBucket || {},
      sizeTierPerformance: stats.bySizeTier || {},
      executionTypePerformance: stats.byExecutionType || {},
      regimeSessionPerformance: stats.byRegimeSession || {},
      bestWorstConditions: {
        best: leaderboard(stats.byCondition || {}, "best"),
        worst: leaderboard(stats.byCondition || {}, "worst"),
      },
      leverageEffectiveness: stats.byLeverage || {},
      averageTradeDurationSeconds: stats.all ? stats.all.averageHoldSeconds : 0,
      drawdown: stats.drawdown || drawdown([]),
      adaptivePolicy: this.memory.adaptive.policy || {},
    };
  }

  save() {
    writeJson(this.config.tradeMemoryFile, this.memory);
    writeJson(this.config.analyticsFile, this.analytics);
  }

  currentPolicy() {
    if (!this.config.adaptiveLearningEnabled) {
      return {
        mode: "DISABLED",
        riskMultiplier: 1,
        minSignalScore: this.config.minSignalScore,
        maxLeverage: this.config.maxLeverage,
        maxOpenPositions: this.config.maxOpenPositions,
        maxTradesPerDay: this.config.maxTradesPerDay,
      };
    }
    const policy = this.memory.adaptive && this.memory.adaptive.policy;
    return policy && Object.keys(policy).length ? policy : this.buildPolicy();
  }

  statsFor(groupName, key) {
    return this.memory.stats && this.memory.stats[groupName] ? this.memory.stats[groupName][key] : null;
  }

  sampleWeight(count) {
    const fullWeightTrades = Math.max(1, this.config.adaptiveSmallSampleFullWeightTrades);
    const raw = numeric(count) / fullWeightTrades;
    return clamp(raw, this.config.adaptiveSmallSampleMinWeight, 1);
  }

  adjustmentFromStats(stats, weight) {
    if (!stats || stats.count < this.config.minAdaptiveBucketTrades) return { adjustment: 0, confidence: 50, reasons: [] };
    const winEdge = (stats.winRatePct - 50) * weight;
    const pnlEdge = clamp(stats.averagePnlPct * 1.5, -8, 8);
    const feeAdjustedEdge = stats.feeAdjustedPnlUsdt > 0 && stats.profitFactor >= 1.2 ? 2 : stats.feeAdjustedPnlUsdt < 0 ? -3 : 0;
    const rawAdjustment = winEdge + pnlEdge + feeAdjustedEdge;
    const sampleWeight = this.sampleWeight(stats.count);
    const weightedAdjustment = rawAdjustment < 0
      ? rawAdjustment * this.config.adaptivePenaltyScale * sampleWeight
      : rawAdjustment * clamp(0.85 + sampleWeight * 0.25, 0.85, 1.1);
    const adjustment = clamp(weightedAdjustment, -this.config.adaptiveConfidencePenaltyMax, this.config.adaptiveConfidenceBonusMax);
    const confidence = clamp(50 + adjustment * 2, this.config.adaptiveConfidenceFloor, 99);
    const reasons = [`sample=${stats.count} winrate=${stats.winRatePct}% avgPnl=${stats.averagePnlPct}% profitFactor=${stats.profitFactor}`];
    if (rawAdjustment < 0 && Math.abs(adjustment) < Math.abs(rawAdjustment)) {
      reasons.push(`adaptive penalty softened from ${rawAdjustment.toFixed(2)} to ${adjustment.toFixed(2)}`);
    }
    if (rawAdjustment < 0 && sampleWeight < 0.99) {
      reasons.push(`small-sample penalty reduced with weight ${sampleWeight.toFixed(2)}`);
    }
    return {
      adjustment,
      confidence,
      sampleWeight: Number(sampleWeight.toFixed(3)),
      rawAdjustment: Number(rawAdjustment.toFixed(3)),
      reasons,
    };
  }

  strongTechnicalOverride(signal) {
    if (!this.config.technicalOverrideEnabled) return false;
    const strongVolume =
      numeric(signal.volumeSpike) >= this.config.technicalOverrideMinVolumeSpike ||
      ["STRONG_VOLUME_SPIKE", "CONFIRMED_VOLUME"].includes(signal.volumeCondition);
    const strongTrigger = Boolean(
      signal.breakoutTriggered ||
        signal.fomoTrigger ||
        signal.microBreakoutTriggered ||
        numeric(signal.continuationStrength) >= this.config.continuationMinStrength + 12 ||
        (Array.isArray(signal.marketRegimeTags) && signal.marketRegimeTags.includes("HIGH_VOLATILITY_BREAKOUT_MARKET"))
    );
    return Boolean(
      numeric(signal.technicalConvictionScore) >= this.config.technicalOverrideMinConviction &&
        numeric(signal.feeEdgeRatio) >= this.config.technicalOverrideMinFeeEdgeRatio &&
        numeric(signal.projectedNetEdgePct) >= this.config.technicalOverrideMinProjectedEdgePct &&
        strongVolume &&
        numeric(signal.momentumPersistenceCandles) >= this.config.minMomentumPersistenceCandles &&
        strongTrigger
    );
  }

  blacklistKey(signal) {
    return `${signal.symbol}:${signal.setupType}:${signal.side}:${signal.btcTrend || signal.regime || "UNKNOWN"}`;
  }

  evaluateSignal(signal) {
    if (!this.config.adaptiveLearningEnabled) {
      return {
        scoreAdjustment: 0,
        confidence: 50,
        riskMultiplier: 1,
        leverageMultiplier: 1,
        rejected: false,
        reasons: ["adaptive learning disabled"],
      };
    }
    const now = Date.now();
    const key = this.blacklistKey(signal);
    const technicalOverride = this.strongTechnicalOverride(signal);
    const blacklist = this.memory.adaptive.blacklists && this.memory.adaptive.blacklists[key];
    const activeBlacklist = blacklist && Date.parse(blacklist.until) > now ? blacklist : null;

    const setupStats = this.statsFor("bySetupType", signal.setupType);
    const symbolStats = this.statsFor("bySymbol", signal.symbol);
    const currentSession = signal.sessionRegime || signal.sessionType || sessionType();
    const sessionStats = this.statsFor("bySessionRegime", currentSession) || this.statsFor("bySession", currentSession);
    const regimeStats = this.statsFor("byBtcRegime", signal.btcTrend || signal.regime);
    const conditionStats = this.statsFor("byCondition", `${signal.setupType}:${signal.side}:${signal.btcTrend}:${signal.volatilityRegime}`);
    const marketRegimeStats = this.statsFor("byMarketRegimeType", signal.marketRegimeType || signal.regime);
    const regimeConditionStats = this.statsFor("byRegimeCondition", `${signal.marketRegimeType || signal.regime}:${signal.setupType}:${signal.side}`);
    const regimeSessionStats = this.statsFor("byRegimeSession", `${signal.marketRegimeType || signal.regime}:${currentSession}`);
    const eliteKey = signal.eliteConditionKey || eliteConditionKeyFromSignal(signal);
    const eliteStats = this.statsFor("byEliteCondition", eliteKey);
    const continuationSetup = signal.continuationSetupType || signal.setupType;
    const continuationStrength = numeric(signal.continuationStrength);
    const continuationBucket =
      continuationStrength >= 80 ? "ELITE_80_PLUS" :
      continuationStrength >= 65 ? "STRONG_65_79" :
      continuationStrength >= 50 ? "MODERATE_50_64" :
      "WEAK_UNDER_50";
    const continuationStats = this.statsFor("byContinuationSetup", continuationSetup);
    const continuationStrengthStats = this.statsFor("byContinuationStrength", continuationBucket);
    const symbolContinuationStats = this.statsFor("bySymbolContinuation", `${signal.symbol}:${continuationSetup}`);
    const symbolPersonalityStats = this.statsFor("bySymbolPersonality", `${signal.symbol}:${signal.marketPersonality || "UNKNOWN"}`);
    const macroStats = this.statsFor(
      "byMacroAlignment",
      signal.macroAligned ? "MACRO_ALIGNED" : signal.macroContradicts ? "MACRO_CONTRA" : "MACRO_NEUTRAL"
    );
    const adjustments = [
      this.adjustmentFromStats(setupStats, 0.28),
      this.adjustmentFromStats(symbolStats, 0.24),
      this.adjustmentFromStats(sessionStats, 0.16),
      this.adjustmentFromStats(regimeStats, 0.16),
      this.adjustmentFromStats(conditionStats, 0.32),
      this.adjustmentFromStats(marketRegimeStats, 0.24 * this.config.regimeMemoryWeight),
      this.adjustmentFromStats(regimeConditionStats, 0.34 * this.config.regimeMemoryWeight),
      this.adjustmentFromStats(regimeSessionStats, 0.2 * this.config.regimeMemoryWeight),
      this.adjustmentFromStats(continuationStats, 0.28),
      this.adjustmentFromStats(continuationStrengthStats, 0.18),
      this.adjustmentFromStats(symbolContinuationStats, 0.3),
      this.adjustmentFromStats(symbolPersonalityStats, 0.24),
      this.adjustmentFromStats(macroStats, 0.14),
    ];
    let scoreAdjustment = adjustments.reduce((total, item) => total + item.adjustment, 0);
    const reasons = adjustments.flatMap((item) => item.reasons).filter(Boolean);

    let riskMultiplier = 1 + scoreAdjustment / 50;
    let leverageMultiplier = 1 + scoreAdjustment / 100;
    let rejected = false;

    if (activeBlacklist) {
      const blacklistPenalty = technicalOverride
        ? this.config.adaptiveBlacklistScorePenalty * 0.25
        : this.config.adaptiveBlacklistScorePenalty;
      scoreAdjustment -= blacklistPenalty;
      riskMultiplier *= technicalOverride ? 0.94 : 0.82;
      leverageMultiplier *= technicalOverride ? 0.95 : 0.88;
      reasons.push(
        technicalOverride
          ? `technical override activated: adaptive caution list softened for ${key}`
          : `adaptive caution list active until ${activeBlacklist.until}: ${activeBlacklist.reason}`
      );
    }

    if (signal.volatilityRegime === "HIGH_VOLATILITY") {
      riskMultiplier *= 0.8;
      leverageMultiplier *= 0.8;
      reasons.push("high volatility: risk/leverage reduced");
    }
    if (signal.volatilityRegime === "NEWS_LIKE_ABNORMAL") {
      riskMultiplier *= 0.55;
      leverageMultiplier *= 0.6;
      scoreAdjustment -= 10;
      reasons.push("news-like abnormal volatility: confidence reduced");
    }
    if (signal.volumeCondition === "LOW_VOLUME") {
      riskMultiplier *= 0.7;
      scoreAdjustment -= 6;
      reasons.push("low-volume setup: confidence reduced");
    }
    if (signal.btcTrendAligned) {
      riskMultiplier *= 1.05;
      reasons.push("BTC alignment supports setup");
    }
    if (numeric(signal.technicalConvictionScore) >= this.config.minConvictionScore + 15 && numeric(signal.feeEdgeRatio) >= this.config.minEdgeToCostRatio + 0.75) {
      riskMultiplier *= 1.08;
      scoreAdjustment += 3;
      reasons.push("conviction boost applied: strong technical conviction plus fee edge");
    }
    if (eliteStats && eliteStats.count >= this.config.minAdaptiveBucketTrades && eliteStats.winRatePct >= 55 && eliteStats.feeAdjustedPnlUsdt > 0) {
      const eliteBonus = clamp((eliteStats.winRatePct - 50) / 10 + Math.min(4, eliteStats.averagePnlPct), 1, 8);
      scoreAdjustment += eliteBonus;
      riskMultiplier *= 1 + Math.min(0.16, eliteBonus / 60);
      leverageMultiplier *= 1 + Math.min(0.1, eliteBonus / 90);
      reasons.push(`elite memory matched: ${eliteKey} winrate ${eliteStats.winRatePct}% over ${eliteStats.count} samples`);
    }
    if (continuationStats && continuationStats.count >= this.config.minAdaptiveBucketTrades && continuationStats.winRatePct >= 52 && continuationStats.feeAdjustedPnlUsdt > 0) {
      const continuationBonus = clamp((continuationStats.winRatePct - 48) / 12 + Math.min(3, continuationStats.averagePnlPct), 0.75, 6);
      scoreAdjustment += continuationBonus;
      riskMultiplier *= 1 + Math.min(0.12, continuationBonus / 70);
      reasons.push(`adaptive market memory matched continuation ${continuationSetup}: ${continuationStats.winRatePct}% winrate`);
    }
    if (this.config.symbolSpecializationEnabled && symbolContinuationStats && symbolContinuationStats.count >= this.config.minAdaptiveBucketTrades) {
      if (symbolContinuationStats.winRatePct >= 55 && symbolContinuationStats.feeAdjustedPnlUsdt > 0) {
        scoreAdjustment += 2;
        riskMultiplier *= 1.04;
        reasons.push(`symbol specialization memory: ${signal.symbol} ${continuationSetup} has favorable edge`);
      } else if (symbolContinuationStats.winRatePct <= 35 && symbolContinuationStats.feeAdjustedPnlUsdt < 0) {
        scoreAdjustment -= 2;
        riskMultiplier *= 0.92;
        reasons.push(`symbol specialization caution: ${signal.symbol} ${continuationSetup} has weak history`);
      }
    }
    if (macroStats && macroStats.count >= this.config.minAdaptiveBucketTrades && signal.macroAligned && macroStats.feeAdjustedPnlUsdt > 0) {
      scoreAdjustment += 1.5;
      riskMultiplier *= 1.03;
      reasons.push(`1h macro memory supports aligned trades: ${macroStats.winRatePct}% winrate`);
    }
    if (numeric(signal.technicalConvictionScore) < this.config.minConvictionScore) {
      riskMultiplier *= 0.75;
      scoreAdjustment -= 5;
      reasons.push("low technical conviction: risk and score reduced");
    }
    if (numeric(signal.projectedNetEdgePct) < this.config.minProjectedEdgePct) {
      riskMultiplier *= 0.75;
      scoreAdjustment -= 6;
      reasons.push("fee-aware edge below threshold: confidence reduced");
    }
    if (Array.isArray(signal.marketRegimeTags)) {
      if (signal.marketRegimeTags.includes("STRONG_TRENDING_MARKET") && signal.btcTrendAligned) {
        riskMultiplier *= 1.06;
        scoreAdjustment += 2;
        reasons.push("adaptive regime confidence increased: strong trending market supports continuation");
      }
      if (signal.marketRegimeTags.includes("HIGH_VOLATILITY_BREAKOUT_MARKET") && (signal.breakoutTriggered || signal.fomoTrigger)) {
        riskMultiplier *= 1.03;
        scoreAdjustment += 2;
        reasons.push("breakout volatility regime active: fast momentum entry allowed with controlled risk");
      }
      if (signal.marketRegimeTags.includes("SIDEWAYS_CHOP_MARKET")) {
        riskMultiplier *= 0.72;
        scoreAdjustment -= 5;
        reasons.push("chop regime activated: risk and confidence reduced");
      }
      if (signal.marketRegimeTags.includes("LOW_LIQUIDITY_MARKET")) {
        riskMultiplier *= 0.7;
        scoreAdjustment -= 5;
        reasons.push("liquidity too weak: aggression reduced");
      }
      if (signal.marketRegimeTags.includes("FAKE_BREAKOUT_ENVIRONMENT")) {
        riskMultiplier *= 0.62;
        scoreAdjustment -= 7;
        reasons.push("fake breakout environment: weak breakouts penalized");
      }
      if (signal.marketRegimeTags.includes("DEAD_MARKET_CONDITIONS")) {
        riskMultiplier *= 0.55;
        scoreAdjustment -= 8;
        reasons.push("dead market conditions: activity strongly reduced");
      }
    }
    if (marketRegimeStats && marketRegimeStats.count >= this.config.minAdaptiveBucketTrades) {
      if (marketRegimeStats.winRatePct >= 58 && marketRegimeStats.feeAdjustedPnlUsdt > 0) {
        scoreAdjustment += 2;
        riskMultiplier *= 1.04;
        reasons.push(`adaptive regime confidence increased: ${signal.marketRegimeType} has ${marketRegimeStats.winRatePct}% winrate`);
      } else if (marketRegimeStats.winRatePct <= 38 && marketRegimeStats.feeAdjustedPnlUsdt < 0) {
        scoreAdjustment -= 3;
        riskMultiplier *= 0.88;
        reasons.push(`self-tuning regime penalty: ${signal.marketRegimeType} has weak historical performance`);
      }
    }
    if (this.config.sessionAggressionEnabled && sessionStats && sessionStats.count >= this.config.minAdaptiveBucketTrades) {
      if (sessionStats.winRatePct >= 58 && sessionStats.feeAdjustedPnlUsdt > 0) {
        scoreAdjustment += 1.5;
        riskMultiplier *= 1.03;
        reasons.push(`session aggression increased: ${currentSession} has favorable history`);
      } else if (sessionStats.winRatePct <= 38 && sessionStats.feeAdjustedPnlUsdt < 0) {
        scoreAdjustment -= 2;
        riskMultiplier *= 0.9;
        reasons.push(`session risk reduced: ${currentSession} has poor historical performance`);
      }
    }
    riskMultiplier *= Number(signal.regimeRiskMultiplier || 1);
    leverageMultiplier *= Number(signal.regimeLeverageMultiplier || 1);

    const poorCondition =
      conditionStats &&
      conditionStats.count >= this.config.minAdaptiveBucketTrades &&
      conditionStats.winRatePct <= this.config.adaptiveBlacklistWinRatePct &&
      conditionStats.feeAdjustedPnlUsdt < 0;
    if (poorCondition) {
      const until = new Date(now + this.config.adaptiveBlacklistMinutes * 60 * 1000).toISOString();
      this.memory.adaptive.blacklists[key] = {
        until,
        reason: `poor condition stats: ${conditionStats.winRatePct}% winrate over ${conditionStats.count} trades`,
      };
      this.save();
      const cautionPenalty = technicalOverride
        ? this.config.adaptiveBlacklistScorePenalty * 0.25
        : this.config.adaptiveBlacklistScorePenalty;
      scoreAdjustment -= cautionPenalty;
      riskMultiplier *= technicalOverride ? 0.95 : 0.85;
      reasons.push(
        technicalOverride
          ? `technical override activated: poor historical bucket became light caution until ${until}`
          : `adaptive caution created until ${until}; penalty softened to ${cautionPenalty}`
      );
    }

    const policy = this.currentPolicy();
    if (policy.mode === "DEFENSIVE_RECOVERY" || policy.mode === "LEARNING_RECOVERY" || policy.mode === "AGGRESSIVE_LEARNING_RECOVERY") {
      scoreAdjustment += 3;
      riskMultiplier *= 1.08;
      reasons.push(policy.recoveryAggressionRestored ? "recovery aggression restored: recent performance stabilized" : "defensive recovery activated: recent performance improved");
    } else if (policy.mode === "CAUTIOUS_ACTIVE" || policy.mode === "CAUTIOUS_LEARNING") {
      scoreAdjustment += policy.mode === "CAUTIOUS_ACTIVE" ? 2 : 1;
      riskMultiplier *= policy.mode === "CAUTIOUS_ACTIVE" ? 1.04 : 1.02;
      reasons.push(policy.mode === "CAUTIOUS_ACTIVE" ? "cautious active mode enabled: risk is moderated but execution remains active" : "cautious mode participation enabled: learning phase keeps trading active");
    } else if (policy.mode === "AGGRESSIVE_LEARNING_PHASE" || policy.mode === "LEARNING_PHASE") {
      scoreAdjustment += 2;
      riskMultiplier *= policy.mode === "AGGRESSIVE_LEARNING_PHASE" ? 1.05 : 1.03;
      reasons.push(policy.mode === "AGGRESSIVE_LEARNING_PHASE" ? "aggressive learning phase active: continuous market participation active" : "continuous learning priority active: participation favored within safety limits");
    } else if (policy.mode === "CONTROLLED_AGGRESSIVE") {
      scoreAdjustment += 2;
      reasons.push("adaptive aggression increased: recent performance supports more activity");
    }
    if (policy.qualityPacingActive) {
      reasons.push(`adaptive pacing engaged: execution quality improved with stronger filters (${policy.qualityPacingReason})`);
    }
    if (this.config.highActivityMode && signal.highActivityContinuation) {
      scoreAdjustment += signal.eliteContinuationCandidate ? 3 : 2;
      riskMultiplier *= signal.eliteContinuationCandidate ? 1.06 : 1.03;
      reasons.push(
        signal.eliteContinuationCandidate
          ? "elite continuation detected: high activity mode increased trend participation"
          : "high activity mode active: continuation setup receives participation boost"
      );
    }
    if (technicalOverride && scoreAdjustment < 0) {
      const before = scoreAdjustment;
      scoreAdjustment *= 0.25;
      riskMultiplier = Math.max(riskMultiplier, 0.9);
      leverageMultiplier = Math.max(leverageMultiplier, 0.85);
      rejected = false;
      reasons.push(`technical override activated: adaptive historical penalty softened from ${before.toFixed(2)} to ${scoreAdjustment.toFixed(2)}`);
    }
    if ((policy.recoveryPnlUsdt > 0 || policy.recoveryWinRatePct >= this.config.adaptiveRecoveryWinRatePct) && scoreAdjustment < 0) {
      const before = scoreAdjustment;
      scoreAdjustment *= 0.75;
      riskMultiplier *= 1.03;
      reasons.push(`adaptive confidence recovering: penalty eased from ${before.toFixed(2)} to ${scoreAdjustment.toFixed(2)}`);
    }
    riskMultiplier *= policy.riskMultiplier || 1;
    const confidenceBeforeFloor = 50 + scoreAdjustment * 2;
    const confidence = clamp(confidenceBeforeFloor, this.config.adaptiveConfidenceFloor, 99);
    if (confidence > confidenceBeforeFloor) {
      reasons.push(`adaptive confidence floor applied at ${this.config.adaptiveConfidenceFloor}`);
    }
    return {
      scoreAdjustment: Number(clamp(scoreAdjustment, -this.config.adaptiveConfidencePenaltyMax, this.config.adaptiveConfidenceBonusMax).toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
      riskMultiplier: Number(clamp(riskMultiplier, this.config.adaptiveRiskMinMultiplier, this.config.adaptiveRiskMaxMultiplier).toFixed(3)),
      leverageMultiplier: Number(clamp(leverageMultiplier, 0.5, 1.15).toFixed(3)),
      rejected,
      reasons,
      policy,
    };
  }
}

module.exports = {
  AdaptiveEngine,
  sessionType,
  setupTypeFromSignal,
  summarize,
};
