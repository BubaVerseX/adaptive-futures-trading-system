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
  if (signal.fomoTrigger) return "FOMO_BREAKOUT";
  if (signal.microBreakoutTriggered) return "MICRO_BREAKOUT";
  if (signal.breakoutTriggered || reasons.includes("breakout") || reasons.includes("breakdown")) return "BREAKOUT";
  if (reasons.includes("ema alignment")) return "TREND_MOMENTUM";
  if (reasons.includes("volume")) return "VOLUME_MOMENTUM";
  return "MOMENTUM_SCALP";
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
      volatilityRegime: trade.volatilityRegime || "UNKNOWN",
      volumeConditions: trade.volumeCondition || "UNKNOWN",
      entryMomentumPct: numeric(trade.entryMomentumPct || trade.momentum1mPct),
      spreadPct: numeric(trade.spreadPct),
      slippagePct: Number.isFinite(slippagePct) ? Number(slippagePct.toFixed(4)) : 0,
      result: trade.result || resultType(trade.exitReason),
      winLoss: pnlUsdt > 0 ? "WIN" : pnlUsdt < 0 ? "LOSS" : "FLAT",
      sessionType: trade.sessionType || sessionType(timestamp),
      breakoutTriggered: Boolean(trade.breakoutTriggered),
      fomoTriggered: Boolean(trade.fomoTrigger || trade.fomoTriggered),
      microBreakoutTriggered: Boolean(trade.microBreakoutTriggered),
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
    this.log("INFO", "Adaptive trade memory updated.", {
      symbol: record.symbol,
      setupType: record.setupType,
      result: record.result,
      winLoss: record.winLoss,
      realizedPnlUsdt: record.realizedPnlUsdt,
      rolling20WinRatePct: this.memory.rolling.last20.winRatePct,
      adaptiveMode: this.memory.adaptive.mode,
    });
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
    const byVolatilityRegime = groupBy(records, (record) => record.volatilityRegime);
    const byLeverage = groupBy(records, (record) => `${Math.round(numeric(record.leverage))}x`);
    const byCondition = groupBy(records, (record) => `${record.setupType}:${record.side}:${record.btcMarketRegime}:${record.volatilityRegime}`);

    this.memory.stats = {
      all: summarize(records),
      bySymbol,
      bySetupType,
      byHour,
      byBtcRegime,
      bySession,
      byVolatilityRegime,
      byLeverage,
      byCondition,
      bestSymbols: leaderboard(bySymbol, "best"),
      worstSymbols: leaderboard(bySymbol, "worst"),
      bestSetups: leaderboard(bySetupType, "best"),
      worstSetups: leaderboard(bySetupType, "worst"),
      strongestSessions: leaderboard(bySession, "best"),
      weakestSessions: leaderboard(bySession, "worst"),
      drawdown: drawdown(records),
    };
    this.memory.adaptive.policy = this.buildPolicy();
    this.memory.adaptive.mode = this.memory.adaptive.policy.mode;
    this.analytics = this.buildAnalytics();
    this.memory.updatedAt = new Date().toISOString();
  }

  buildPolicy() {
    const last20 = this.memory.rolling.last20;
    const enough = last20.count >= this.config.minAdaptiveTrades;
    let mode = "BASELINE";
    let riskMultiplier = 1;
    let signalThresholdAdjustment = 0;
    let maxLeverage = this.config.maxLeverage;
    let maxOpenPositions = this.config.maxOpenPositions;
    let maxTradesPerDay = this.config.maxTradesPerDay;

    if (enough && (last20.winRatePct < this.config.defensiveWinRatePct || last20.feeAdjustedPnlUsdt < 0)) {
      mode = "DEFENSIVE";
      riskMultiplier = 0.6;
      signalThresholdAdjustment = 8;
      maxLeverage = Math.max(1, Math.floor(this.config.maxLeverage * 0.65));
      maxOpenPositions = Math.max(1, Math.floor(this.config.maxOpenPositions * 0.6));
      maxTradesPerDay = Math.max(5, Math.floor(this.config.maxTradesPerDay * 0.5));
    } else if (enough && last20.winRatePct > this.config.aggressiveWinRatePct && last20.feeAdjustedPnlUsdt > 0) {
      mode = "CONTROLLED_AGGRESSIVE";
      riskMultiplier = 1.12;
      signalThresholdAdjustment = -2;
      maxLeverage = this.config.maxLeverage;
      maxOpenPositions = this.config.maxOpenPositions;
      maxTradesPerDay = this.config.maxTradesPerDay;
    }

    if (last20.count >= this.config.minAdaptiveTrades && last20.totalFeesUsdt > Math.abs(last20.totalPnlUsdt) * 0.7) {
      signalThresholdAdjustment += 4;
      riskMultiplier *= 0.85;
    }

    return {
      mode,
      sampleSize: last20.count,
      rollingWinRatePct: last20.winRatePct,
      rollingPnlUsdt: last20.feeAdjustedPnlUsdt,
      riskMultiplier: clamp(riskMultiplier, this.config.adaptiveRiskMinMultiplier, this.config.adaptiveRiskMaxMultiplier),
      signalThresholdAdjustment,
      minSignalScore: clamp(this.config.minSignalScore + signalThresholdAdjustment, 1, 100),
      maxLeverage: clamp(maxLeverage, 1, this.config.maxLeverage),
      maxOpenPositions: clamp(maxOpenPositions, 1, this.config.maxOpenPositions),
      maxTradesPerDay: clamp(maxTradesPerDay, 1, this.config.maxTradesPerDay),
    };
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
    return this.memory.adaptive.policy || this.buildPolicy();
  }

  statsFor(groupName, key) {
    return this.memory.stats && this.memory.stats[groupName] ? this.memory.stats[groupName][key] : null;
  }

  adjustmentFromStats(stats, weight) {
    if (!stats || stats.count < this.config.minAdaptiveBucketTrades) return { adjustment: 0, confidence: 50, reasons: [] };
    const winEdge = (stats.winRatePct - 50) * weight;
    const pnlEdge = clamp(stats.averagePnlPct * 1.5, -8, 8);
    const adjustment = clamp(winEdge + pnlEdge, -this.config.adaptiveConfidencePenaltyMax, this.config.adaptiveConfidenceBonusMax);
    const confidence = clamp(50 + adjustment * 2, 1, 99);
    return {
      adjustment,
      confidence,
      reasons: [`sample=${stats.count} winrate=${stats.winRatePct}% avgPnl=${stats.averagePnlPct}%`],
    };
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
    const blacklist = this.memory.adaptive.blacklists && this.memory.adaptive.blacklists[key];
    if (blacklist && Date.parse(blacklist.until) > now) {
      return {
        scoreAdjustment: -100,
        confidence: 1,
        riskMultiplier: this.config.adaptiveRiskMinMultiplier,
        leverageMultiplier: 0.5,
        rejected: true,
        reasons: [`adaptive temporary blacklist active until ${blacklist.until}: ${blacklist.reason}`],
      };
    }

    const setupStats = this.statsFor("bySetupType", signal.setupType);
    const symbolStats = this.statsFor("bySymbol", signal.symbol);
    const sessionStats = this.statsFor("bySession", sessionType());
    const regimeStats = this.statsFor("byBtcRegime", signal.btcTrend || signal.regime);
    const conditionStats = this.statsFor("byCondition", `${signal.setupType}:${signal.side}:${signal.btcTrend}:${signal.volatilityRegime}`);
    const adjustments = [
      this.adjustmentFromStats(setupStats, 0.28),
      this.adjustmentFromStats(symbolStats, 0.24),
      this.adjustmentFromStats(sessionStats, 0.16),
      this.adjustmentFromStats(regimeStats, 0.16),
      this.adjustmentFromStats(conditionStats, 0.32),
    ];
    let scoreAdjustment = adjustments.reduce((total, item) => total + item.adjustment, 0);
    const reasons = adjustments.flatMap((item) => item.reasons).filter(Boolean);

    let riskMultiplier = 1 + scoreAdjustment / 50;
    let leverageMultiplier = 1 + scoreAdjustment / 100;
    let rejected = false;

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
      rejected = true;
      scoreAdjustment -= this.config.adaptiveConfidencePenaltyMax;
      reasons.push(`adaptive blacklist created until ${until}`);
    }

    const policy = this.currentPolicy();
    riskMultiplier *= policy.riskMultiplier || 1;
    const confidence = clamp(50 + scoreAdjustment * 2, 1, 99);
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
