"use strict";

const { percentChange } = require("./indicators");
const { profitControlledRiskCapPct } = require("./profitControlled");

const LADDER = [
  { level: 1, floor: 100, target: 130 },
  { level: 2, floor: 130, target: 170 },
  { level: 3, floor: 170, target: 250 },
  { level: 4, floor: 250, target: 400 },
  { level: 5, floor: 400, target: 600 },
  { level: 6, floor: 600, target: 1000 },
];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function decimalPlaces(step) {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  const decimals = text.split(".")[1];
  return decimals ? decimals.replace(/0+$/, "").length : 0;
}

function roundedPrice(value, step, roundUp) {
  const increment = Number(step || 0);
  if (!Number.isFinite(increment) || increment <= 0) return value;
  const units = value / increment;
  const rounded = (roundUp ? Math.ceil(units - Number.EPSILON) : Math.floor(units + Number.EPSILON)) * increment;
  return Number(rounded.toFixed(decimalPlaces(step)));
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function liveValidationRiskCapPct(config, convictionTier) {
  if (convictionTier === "TIER_3_ELITE_SETUP") return config.liveValidationEliteRiskAtStopMaxPct;
  if (convictionTier === "TIER_2_STRONG_SETUP") return config.liveValidationStrongRiskAtStopMaxPct;
  if (convictionTier === "TIER_1_EXPLORATORY") return config.liveValidationExplorationRiskAtStopMaxPct;
  return config.liveValidationNormalRiskAtStopMaxPct;
}

function closedLossStreak(trades, mode) {
  const closed = trades
    .filter((trade) => trade.mode === mode && trade.status === "CLOSED")
    .slice()
    .sort((left, right) => Date.parse(left.exitedAt || left.exitTime || "") - Date.parse(right.exitedAt || right.exitTime || ""));
  let streak = 0;
  for (let index = closed.length - 1; index >= 0; index -= 1) {
    if (Number(closed[index].pnlUsdt || 0) < 0) {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

class RiskManager {
  constructor(config, store, log, adaptive = null) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.adaptive = adaptive;
  }

  ladderForEquity(equity) {
    let selected = LADDER[0];
    for (const level of LADDER) {
      if (equity >= level.floor) selected = level;
    }
    return selected;
  }

  markToMarketEquity(prices = {}) {
    const state = this.store.state;
    const unrealizedPnl = state.openPositions.reduce((total, position) => {
      const price = Number(prices[position.symbol] || position.entryPrice);
      const change = position.side === "SHORT" ? position.entryPrice - price : price - position.entryPrice;
      return total + change * Number(position.size);
    }, 0);
    return this.config.accountStartUsdt + state.equity.realizedPnlUsdt + unrealizedPnl;
  }

  updateEquity(equity) {
    const state = this.store.state;
    const level = this.ladderForEquity(equity);
    const priorLevel = state.ladder.activeLevel;
    const previousHigh = state.ladder.highestUnlockedLevel;
    state.equity.currentUsdt = Number(equity.toFixed(6));
    state.ladder.activeLevel = level.level;
    state.ladder.highestUnlockedLevel = Math.max(previousHigh, level.level);

    if (level.level > priorLevel) {
      state.ladder.levelStartEquity = level.floor;
      state.ladder.riskDowngraded = false;
      this.log("INFO", "Ladder milestone reached; future eligible sizing may increase.", {
        level: level.level,
        equity: equity.toFixed(4),
        nextTarget: level.target,
      });
    }
    if (level.level < priorLevel) {
      state.ladder.riskDowngraded = true;
      state.ladder.levelStartEquity = level.floor;
      this.log("WARN", "Ladder level reduced after equity fell below a milestone.", {
        fromLevel: priorLevel,
        toLevel: level.level,
        equity: equity.toFixed(4),
      });
    }
    if (equity <= state.ladder.levelStartEquity * 0.8) {
      state.ladder.riskDowngraded = true;
    }

    this.resetDailyIfNeeded(equity);
    this.store.saveState();
    return level;
  }

  resetDailyIfNeeded(equity) {
    const state = this.store.state;
    const date = todayUtc();
    if (!state.daily || state.daily.date !== date) {
      const mode = state.mode;
      const todayTrades = this.store.trades.filter(
        (trade) =>
          trade.mode === mode &&
          !["ENTRY_FAILED", "FAILED"].includes(trade.status) &&
          String(trade.openedAt || trade.entryTime || "").startsWith(date)
      );
      const todayClosed = this.store.trades.filter(
        (trade) =>
          trade.mode === mode &&
          String(trade.exitedAt || trade.exitTime || "").startsWith(date) &&
          trade.status === "CLOSED"
      );
      state.daily = {
        date,
        startingEquity: Number(equity.toFixed(6)),
        tradesOpened: todayTrades.length,
        losingTrades: todayClosed.filter((trade) => Number(trade.pnlUsdt) < 0).length,
        realizedPnlUsdt: todayClosed.reduce((total, trade) => total + Number(trade.pnlUsdt || 0), 0),
        feesUsdt: todayClosed.reduce((total, trade) => total + Number(trade.feesUsdt || trade.estimatedFeesUsdt || 0), 0),
        wins: todayClosed.filter((trade) => Number(trade.pnlUsdt) > 0).length,
        closedTrades: todayClosed.length,
        explorationTrades: todayTrades.filter((trade) => trade.explorationTrade).length,
        recoveryModeActive: false,
      };
      state.paused = false;
      state.pauseReason = null;
      this.log("INFO", "New UTC performance day initialized; daily shutdown logic removed.", {
        date,
        startingEquity: equity.toFixed(4),
        continuousExecutionMode: this.config.continuousExecutionMode,
      });
    }
  }

  dailyPerformancePct(equity) {
    return percentChange(equity, this.store.state.daily.startingEquity);
  }

  continuousRecoveryStatus(equity) {
    const daily = this.store.state.daily;
    if (!daily) {
      return {
        active: false,
        pnlPct: 0,
        pnlUsdt: 0,
        losingStreak: 0,
        riskMultiplier: 1,
        leverageMultiplier: 1,
        signalAdjustment: 0,
      };
    }
    const pnlPct = this.dailyPerformancePct(equity);
    const pnlUsdt = equity - daily.startingEquity;
    const losingStreak = closedLossStreak(this.store.trades, this.store.state.mode);
    const losingTrades = Number(daily.losingTrades || 0);
    const intensity = Math.max(
      losingStreak >= 2 ? Math.min(1, losingStreak / 5) : 0,
      losingTrades >= 3 ? Math.min(1, losingTrades / 8) : 0,
      pnlPct < 0 ? Math.min(1, Math.abs(pnlPct) / 18) : 0
    );
    const active = intensity > 0;
    const status = {
      active,
      pnlPct: Number(pnlPct.toFixed(4)),
      pnlUsdt: Number(pnlUsdt.toFixed(6)),
      losingTrades,
      losingStreak,
      riskMultiplier: Number((1 - 0.22 * intensity).toFixed(3)),
      leverageMultiplier: Number((1 - 0.16 * intensity).toFixed(3)),
      signalAdjustment: Math.ceil(2 * intensity),
      stopBot: false,
      closePositions: false,
      reason: active ? "adaptive recovery mode active; losing streak handled without shutdown" : null,
    };
    daily.recoveryModeActive = active;
    daily.recoveryPnlPct = status.pnlPct;
    daily.recoveryLosingStreak = losingStreak;
    if (active) {
      const noticeKey = `${daily.date}:${Math.floor(Math.abs(pnlPct))}:${losingStreak}:${losingTrades}`;
      if (daily.recoveryNoticeKey !== noticeKey) {
        daily.recoveryNoticeKey = noticeKey;
        this.log("WARN", "Losing streak handled without shutdown; adaptive recovery mode active.", {
          dailyPnlPct: status.pnlPct,
          dailyPnlUsdt: status.pnlUsdt,
          losingTrades,
          losingStreak,
          riskMultiplier: status.riskMultiplier,
          leverageMultiplier: status.leverageMultiplier,
          continuousLearningPreserved: true,
          stopBot: false,
        });
      }
    }
    return status;
  }

  profitProtection(equity) {
    if (!this.config.profitProtectionEnabled || !this.store.state.daily) {
      return {
        active: false,
        pnlPct: this.store.state.daily ? this.dailyPerformancePct(equity) : 0,
        riskMultiplier: 1,
        leverageMultiplier: 1,
        explorationMultiplier: 1,
        signalAdjustment: 0,
      };
    }
    const pnlPct = this.dailyPerformancePct(equity);
    if (pnlPct < this.config.profitProtectionStartPct) {
      return {
        active: false,
        pnlPct,
        riskMultiplier: 1,
        leverageMultiplier: 1,
        explorationMultiplier: 1,
        signalAdjustment: 0,
      };
    }
    const intensity = Math.max(0.25, Math.min(1, pnlPct / Math.max(this.config.profitProtectionStartPct * 2, 1)));
    const riskMultiplier = 1 - (1 - this.config.profitProtectionRiskMultiplier) * intensity;
    const explorationMultiplier = 1 - (1 - this.config.profitProtectionExplorationMultiplier) * intensity;
    return {
      active: true,
      pnlPct,
      intensity: Number(intensity.toFixed(3)),
      riskMultiplier: Number(riskMultiplier.toFixed(3)),
      leverageMultiplier: Number(Math.max(0.65, riskMultiplier).toFixed(3)),
      explorationMultiplier: Number(explorationMultiplier.toFixed(3)),
      signalAdjustment: Math.ceil(this.config.profitProtectionSignalAdjustment * intensity),
      reason: "daily pnl is strongly positive; protecting gains by reducing new-risk appetite",
    };
  }

  entryBlockReason(equity, symbol) {
    const state = this.store.state;
    if (state.paused) {
      if (this.config.continuousExecutionMode && /(?:adaptive\s+)?maximum\s+daily\s+trades|daily\s+trade|exploration\s+quota|participation\s+quota|maximum\s+daily\s+loss|daily\s+loss|daily\s+drawdown|daily\s+risk/i.test(String(state.pauseReason || ""))) {
        state.paused = false;
        state.pauseReason = null;
        this.log("WARN", "Execution blocker removed; stale portfolio pause cleared in continuous execution mode.", { symbol });
      } else {
        return state.pauseReason || "manual pause is active";
      }
    }
    if (
      !this.config.dryRun &&
      state.openPositions.some((position) =>
        ["ENTRY_SUBMITTING", "ENTRY_SUBMITTED", "ENTRY_PENDING_CONFIRMATION", "ENTRY_STATUS_UNKNOWN"].includes(position.status)
      )
    ) {
      return "live entry reconciliation in progress";
    }
    const policy = this.adaptive && this.config.adaptiveLearningEnabled ? this.adaptive.currentPolicy() : null;
    const maxOpenPositions = policy ? policy.maxOpenPositions : this.config.maxOpenPositions;
    if (state.openPositions.length >= maxOpenPositions) return "maximum open positions reached";
    if (state.openPositions.some((position) => position.symbol === symbol)) return "symbol already has an open position; averaging down is forbidden";
    const cooldown = state.symbolCooldowns && state.symbolCooldowns[symbol];
    if (cooldown) {
      const now = Date.now();
      const lossCooldownUntil = Date.parse(cooldown.lossCooldownUntil || "");
      const reentryUntil = Date.parse(cooldown.reentryUntil || "");
      if ((Number.isFinite(lossCooldownUntil) && lossCooldownUntil > now) || (Number.isFinite(reentryUntil) && reentryUntil > now)) {
        this.log("INFO", "Portfolio suppression removed; symbol cooldown is advisory only.", {
          symbol,
          lossCooldownUntil: cooldown.lossCooldownUntil,
          reentryUntil: cooldown.reentryUntil,
        });
      }
    }
    return null;
  }

  sizingPlan(signal, equity, symbolInfo, leverage) {
    const level = this.ladderForEquity(equity);
    const strongSetup = signal.score >= this.config.aggressiveScoreThreshold && !this.store.state.ladder.riskDowngraded;
    const adaptiveRiskMultiplier = Number(signal.adaptiveRiskMultiplier || 1);
    let qualitySizeMultiplier = 1;
    let convictionTier = "TIER_1_EXPLORATORY";
    let tierMarginMin = this.config.tier1MarginMinUsdt;
    let tierMarginMax = this.config.tier1MarginMaxUsdt;
    let riskAtStopMinPct = this.config.explorationRiskAtStopMinPct;
    let riskAtStopMaxPct = this.config.explorationRiskAtStopMaxPct;
    const reasonsForSizingTier = [];
    const continuationStrength = Number(signal.continuationStrength || 0);
    const highQualityContinuation =
      (Number(signal.convictionScore || 0) >= this.config.minConvictionScore + 18 ||
        continuationStrength >= this.config.continuationMinStrength + 12) &&
      Number(signal.liquidityScore || 0) >= 70 &&
      signal.btcTrendAligned &&
      ["STRONG_VOLUME_SPIKE", "CONFIRMED_VOLUME"].includes(signal.volumeCondition) &&
      Number(signal.projectedNetEdgePct || 0) >= this.config.minProjectedEdgePct + (signal.highActivityContinuation ? 0.2 : 0.35);
    const profitQualityTier = String(signal.profitQualityTier || "").toUpperCase();
    const eliteSetup = Boolean(signal.eliteSetup || profitQualityTier === "ELITE");
    const profitStrongSetup = profitQualityTier === "STRONG";
    if (eliteSetup) {
      convictionTier = "TIER_3_ELITE_SETUP";
      tierMarginMin = this.config.tier3MarginMinUsdt;
      tierMarginMax = this.config.tier3MarginMaxUsdt;
      riskAtStopMinPct = this.config.eliteRiskAtStopMinPct;
      riskAtStopMaxPct = this.config.eliteRiskAtStopMaxPct;
      qualitySizeMultiplier = continuationStrength >= 82 ? 1.5 : 1.38;
      reasonsForSizingTier.push("elite setup with high-confluence continuation evidence");
    } else if (highQualityContinuation || profitStrongSetup) {
      convictionTier = "TIER_2_STRONG_SETUP";
      tierMarginMin = this.config.tier2MarginMinUsdt;
      tierMarginMax = this.config.tier2MarginMaxUsdt;
      riskAtStopMinPct = this.config.strongRiskAtStopMinPct;
      riskAtStopMaxPct = this.config.strongRiskAtStopMaxPct;
      qualitySizeMultiplier = continuationStrength >= 72 ? 1.22 : 1.12;
      reasonsForSizingTier.push(profitStrongSetup ? "V7 strong profit quality score earned larger protected sizing tier" : "strong continuation with liquidity, BTC alignment, volume, and edge");
    } else if (
      Number(signal.convictionScore || 0) < this.config.minConvictionScore + 6 ||
      signal.volatilityRegime === "HIGH_VOLATILITY" ||
      signal.volatilityRegime === "NEWS_LIKE_ABNORMAL" ||
      Number(signal.feeEdgeRatio || 0) < this.config.minEdgeToCostRatio + 0.5
    ) {
      qualitySizeMultiplier = signal.volatilityRegime === "NEWS_LIKE_ABNORMAL" ? 0.55 : 0.75;
      reasonsForSizingTier.push("weak or volatile setup reduced to smaller risk-at-stop sizing");
    } else {
      riskAtStopMinPct = this.config.normalRiskAtStopMinPct;
      riskAtStopMaxPct = this.config.normalRiskAtStopMaxPct;
      reasonsForSizingTier.push("normal positive-edge continuation sizing");
    }
    if (signal.explorationTrade) {
      convictionTier = "TIER_1_EXPLORATORY";
      tierMarginMin = this.config.tier1MarginMinUsdt;
      tierMarginMax = this.config.tier1MarginMaxUsdt;
      riskAtStopMinPct = this.config.explorationRiskAtStopMinPct;
      riskAtStopMaxPct = this.config.explorationRiskAtStopMaxPct;
      qualitySizeMultiplier *= this.config.explorationRiskMultiplier;
      reasonsForSizingTier.push("exploration trade uses smallest protected risk-at-stop tier");
    }
    if (signal.qualityPacingActive) {
      qualitySizeMultiplier *= this.config.qualityPacingRiskMultiplier;
    }
    qualitySizeMultiplier *= Number(signal.continuousRecoveryRiskMultiplier || 1);
    qualitySizeMultiplier *= Number(signal.regimeRiskMultiplier || 1);
    qualitySizeMultiplier *= Number(signal.profitProtectionRiskMultiplier || 1);
    qualitySizeMultiplier *= Number(signal.liveValidationRiskMultiplier || 1);
    qualitySizeMultiplier *= Number(signal.profitControlledRiskMultiplier || 1);
    const openPositions = Array.isArray(this.store.state.openPositions) ? this.store.state.openPositions : [];
    const sameDirectionCluster = openPositions.filter((position) => position.side === signal.side).length;
    const clusterMultiplier = sameDirectionCluster > 0 ? this.config.correlatedClusterRiskMultiplier : 1;
    if (sameDirectionCluster > 0) {
      reasonsForSizingTier.push(`correlated BTC/ETH/SOL ${signal.side} cluster reduced size across ${sameDirectionCluster} existing positions`);
    }
    const convictionScale = bounded(Math.max(Number(signal.convictionScore || 0), continuationStrength) / 100, 0, 1);
    const baseRiskAtStopPct = riskAtStopMinPct + (riskAtStopMaxPct - riskAtStopMinPct) * convictionScale;
    let riskPct = bounded(
      baseRiskAtStopPct * adaptiveRiskMultiplier * qualitySizeMultiplier * clusterMultiplier,
      this.config.explorationRiskAtStopMinPct * 0.5,
      this.config.eliteRiskAtStopMaxPct
    );
    const validationRiskCapPct = this.config.liveValidationMode ? liveValidationRiskCapPct(this.config, convictionTier) : null;
    if (validationRiskCapPct !== null && riskPct > validationRiskCapPct) {
      riskPct = validationRiskCapPct;
      reasonsForSizingTier.push(`live validation cap applied: max loss at stop <= ${validationRiskCapPct}% of allocated validation equity`);
    }
    const profitControlledRiskCap = this.config.profitControlledEquityMode ? profitControlledRiskCapPct(this.config, convictionTier) : null;
    if (profitControlledRiskCap !== null && riskPct > profitControlledRiskCap) {
      riskPct = profitControlledRiskCap;
      reasonsForSizingTier.push(`profit-controlled equity cap applied: max loss at stop <= ${profitControlledRiskCap}% of exchange sizing equity`);
    }
    // Position size uses only the unlocked milestone floor, never transient profit above it.
    const sizingEquity = this.config.profitControlledEquityMode ? Math.max(0, equity) : Math.max(0, Math.min(equity, level.floor));
    const riskUsdt = sizingEquity * (riskPct / 100);
    const stopDistance = this.config.stopLossPct / 100;
    const riskBasedNotional = riskUsdt / stopDistance;
    // Margin cap keeps the bot from using the full account even in aggressive mode.
    const marginCappedNotional = equity * leverage * (this.config.maxMarginUsagePct / 100);
    const configuredNotionalCap = this.config.maxPositionNotionalUsdt || Number.POSITIVE_INFINITY;
    const sizingConviction = Math.max(Number(signal.convictionScore || 0), Number(signal.profitQualityScore || 0), continuationStrength * 0.96);
    const targetMarginUsdt = bounded(
      tierMarginMin + (tierMarginMax - tierMarginMin) * bounded(sizingConviction / 100, 0, 1),
      tierMarginMin,
      tierMarginMax
    );
    const tierTargetNotional = targetMarginUsdt * leverage;
    const lot = symbolInfo.lotSizeFilter || {};
    const tickSize = symbolInfo.priceFilter && symbolInfo.priceFilter.tickSize;
    const minimumSize = Number(lot.minOrderQty || 0);
    const minimumNotional = Number(lot.minNotionalValue || 0);
    const exchangeMinimumNotional = Math.max(minimumNotional, minimumSize * signal.price);
    const hardNotionalCap = Math.min(riskBasedNotional, marginCappedNotional, configuredNotionalCap);
    let notional = Math.min(hardNotionalCap, tierTargetNotional);
    if (exchangeMinimumNotional > hardNotionalCap) {
      return {
        rejected: true,
        reason: "exchange minimum would exceed allowed max loss at stop or margin cap",
        exchangeMinimumNotional,
        hardNotionalCap,
      };
    }
    if (notional < exchangeMinimumNotional && exchangeMinimumNotional <= hardNotionalCap) {
      notional = exchangeMinimumNotional;
    }
    const step = Number(lot.qtyStep);
    const quantity = Math.floor(notional / signal.price / step + Number.EPSILON) * step;
    const size = quantity.toFixed(decimalPlaces(lot.qtyStep));

    if (!Number.isFinite(quantity) || quantity <= 0 || quantity < minimumSize || quantity * signal.price < minimumNotional) {
      return { rejected: true, reason: "risk-sized order is below this symbol's exchange minimum" };
    }
    const isLong = signal.side === "LONG";
    const standardTakeProfitPrice = roundedPrice(
      signal.price * (isLong ? 1 + this.config.takeProfitPct / 100 : 1 - this.config.takeProfitPct / 100),
      tickSize,
      !isLong
    );
    const winnerAmplifier = Boolean(this.config.profitControlledEquityMode && this.config.winnerAmplifierEnabled);
    const runnerMultiplier = eliteSetup
      ? this.config.eliteRunnerTakeProfitMultiplier
      : winnerAmplifier
        ? Math.max(1.12, Math.min(this.config.runnerTrendExtensionMultiplier, this.config.eliteRunnerTakeProfitMultiplier))
        : 1;
    const runnerTakeProfitPrice = roundedPrice(
      signal.price * (
        isLong
          ? 1 + (this.config.takeProfitPct * runnerMultiplier) / 100
          : 1 - (this.config.takeProfitPct * runnerMultiplier) / 100
      ),
      tickSize,
      !isLong
    );
    return {
      rejected: false,
      size,
      notional: Number((quantity * signal.price).toFixed(6)),
      leverage,
      riskPct,
      baseRiskPct: riskAtStopMaxPct,
      adaptiveRiskMultiplier: Number(adaptiveRiskMultiplier.toFixed(3)),
      qualitySizeMultiplier: Number(qualitySizeMultiplier.toFixed(3)),
      highQualityContinuation: highQualityContinuation || profitStrongSetup,
      continuationStrength,
      continuationSetupType: signal.continuationSetupType || "NONE",
      eliteSetup,
      convictionTier,
      targetMarginUsdt: Number(targetMarginUsdt.toFixed(6)),
      marginUsedUsdt: Number((quantity * signal.price / leverage).toFixed(6)),
      maxLossAtStopUsdt: Number(((quantity * signal.price) * stopDistance).toFixed(6)),
      riskPctOfEquity: equity > 0 ? Number((((quantity * signal.price) * stopDistance / equity) * 100).toFixed(4)) : 0,
      totalOpenPortfolioRiskUsdt: Number(openPositions.reduce((total, position) => total + Number(position.maxLossAtStopUsdt || 0), 0).toFixed(6)),
      correlatedClusterPositions: sameDirectionCluster,
      reasonsForSizingTier,
      tierMarginMinUsdt: tierMarginMin,
      tierMarginMaxUsdt: tierMarginMax,
      explorationSizing: Boolean(signal.explorationTrade),
      continuousRecoveryRiskMultiplier: Number(signal.continuousRecoveryRiskMultiplier || 1),
      liveValidationRiskMultiplier: Number(signal.liveValidationRiskMultiplier || 1),
      liveValidationRiskState: signal.liveValidationRiskState || null,
      liveValidationRiskCapPct: validationRiskCapPct,
      profitControlledRiskMultiplier: Number(signal.profitControlledRiskMultiplier || 1),
      profitControlledRiskState: signal.profitControlledRiskState || null,
      profitControlledRiskCapPct: profitControlledRiskCap,
      riskUsdt: Number(riskUsdt.toFixed(6)),
      stopLossPrice: roundedPrice(signal.price * (isLong ? 1 - stopDistance : 1 + stopDistance), tickSize, !isLong),
      takeProfitPrice: runnerTakeProfitPrice,
      partialTakeProfitPrice: eliteSetup || winnerAmplifier ? standardTakeProfitPrice : null,
      runnerTakeProfitPrice,
      standardTakeProfitPrice,
      winnerAmplifier,
      runnerTakeProfitMultiplier: runnerMultiplier,
      ladderLevel: level.level,
      sizingEquity,
      aggressive: strongSetup,
    };
  }

  registerOpen(explorationTrade = false) {
    if (!this.store.state.daily) {
      return;
    }
    this.store.state.daily.tradesOpened += 1;
    if (explorationTrade) {
      this.store.state.daily.explorationTrades = Number(this.store.state.daily.explorationTrades || 0) + 1;
    }
    this.store.saveState();
  }

  registerClose(pnlUsdt, feesUsdt = 0) {
    const daily = this.store.state.daily;
    if (daily) {
      daily.realizedPnlUsdt += pnlUsdt;
      daily.feesUsdt = Number(daily.feesUsdt || 0) + Number(feesUsdt || 0);
      daily.closedTrades = Number(daily.closedTrades || 0) + 1;
      if (pnlUsdt > 0) daily.wins = Number(daily.wins || 0) + 1;
      if (pnlUsdt < 0) daily.losingTrades += 1;
    }
    this.store.state.equity.realizedPnlUsdt += pnlUsdt;
    this.store.saveState();
  }
}

module.exports = { LADDER, RiskManager, roundedPrice };
