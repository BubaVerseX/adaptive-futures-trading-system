"use strict";

const { percentChange } = require("./indicators");

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
        lossLocked: false,
      };
      state.paused = false;
      state.pauseReason = null;
      this.log("INFO", "New UTC trading day initialized.", { date, startingEquity: equity.toFixed(4) });
    }
  }

  dailyPerformancePct(equity) {
    return percentChange(equity, this.store.state.daily.startingEquity);
  }

  dailyLock(equity) {
    const daily = this.store.state.daily;
    const pnlPct = this.dailyPerformancePct(equity);
    const pnlUsdt = equity - daily.startingEquity;
    if (
      pnlPct <= -this.config.maxDailyLossPct ||
      (this.config.maxDailyLossUsdt !== null && pnlUsdt <= -this.config.maxDailyLossUsdt)
    ) {
      daily.lossLocked = true;
      return { locked: true, closePositions: true, stopBot: true, reason: "maximum daily loss reached", pnlPct };
    }
    return { locked: false, pnlPct };
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
    const dailyProtection = this.dailyLock(equity);
    if (state.paused) return state.pauseReason || "manual pause is active";
    if (dailyProtection.locked) return dailyProtection.reason;
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
    const baseRiskPct = strongSetup ? this.config.aggressiveRiskPerTradePct : this.config.baseRiskPerTradePct;
    const adaptiveRiskMultiplier = Number(signal.adaptiveRiskMultiplier || 1);
    let qualitySizeMultiplier = 1;
    const highQualityContinuation =
      Number(signal.convictionScore || 0) >= this.config.minConvictionScore + 18 &&
      Number(signal.liquidityScore || 0) >= 70 &&
      signal.btcTrendAligned &&
      ["STRONG_VOLUME_SPIKE", "CONFIRMED_VOLUME"].includes(signal.volumeCondition) &&
      Number(signal.projectedNetEdgePct || 0) >= this.config.minProjectedEdgePct + 0.45;
    if (highQualityContinuation) {
      qualitySizeMultiplier = 1.12;
    } else if (
      Number(signal.convictionScore || 0) < this.config.minConvictionScore + 6 ||
      signal.volatilityRegime === "HIGH_VOLATILITY" ||
      signal.volatilityRegime === "NEWS_LIKE_ABNORMAL" ||
      Number(signal.feeEdgeRatio || 0) < this.config.minEdgeToCostRatio + 0.5
    ) {
      qualitySizeMultiplier = signal.volatilityRegime === "NEWS_LIKE_ABNORMAL" ? 0.55 : 0.75;
    }
    if (signal.explorationTrade) {
      qualitySizeMultiplier *= this.config.explorationRiskMultiplier;
    }
    qualitySizeMultiplier *= Number(signal.regimeRiskMultiplier || 1);
    qualitySizeMultiplier *= Number(signal.profitProtectionRiskMultiplier || 1);
    const riskPct = Math.max(
      this.config.baseRiskPerTradePct * this.config.adaptiveRiskMinMultiplier,
      Math.min(
        this.config.aggressiveRiskPerTradePct * this.config.adaptiveRiskMaxMultiplier,
        baseRiskPct * adaptiveRiskMultiplier * qualitySizeMultiplier
      )
    );
    // Position size uses only the unlocked milestone floor, never transient profit above it.
    const sizingEquity = Math.max(0, Math.min(equity, level.floor));
    const riskUsdt = sizingEquity * (riskPct / 100);
    const stopDistance = this.config.stopLossPct / 100;
    const riskBasedNotional = riskUsdt / stopDistance;
    // Margin cap keeps the bot from using the full account even in aggressive mode.
    const marginCappedNotional = equity * leverage * (this.config.maxMarginUsagePct / 100);
    const configuredNotionalCap = this.config.maxPositionNotionalUsdt || Number.POSITIVE_INFINITY;
    const notional = Math.min(riskBasedNotional, marginCappedNotional, configuredNotionalCap);
    const lot = symbolInfo.lotSizeFilter || {};
    const tickSize = symbolInfo.priceFilter && symbolInfo.priceFilter.tickSize;
    const step = Number(lot.qtyStep);
    const quantity = Math.floor(notional / signal.price / step + Number.EPSILON) * step;
    const size = quantity.toFixed(decimalPlaces(lot.qtyStep));
    const minimumSize = Number(lot.minOrderQty || 0);
    const minimumNotional = Number(lot.minNotionalValue || 0);

    if (!Number.isFinite(quantity) || quantity <= 0 || quantity < minimumSize || quantity * signal.price < minimumNotional) {
      return { rejected: true, reason: "risk-sized order is below this symbol's exchange minimum" };
    }
    const isLong = signal.side === "LONG";
    return {
      rejected: false,
      size,
      notional: Number((quantity * signal.price).toFixed(6)),
      leverage,
      riskPct,
      baseRiskPct,
      adaptiveRiskMultiplier: Number(adaptiveRiskMultiplier.toFixed(3)),
      qualitySizeMultiplier: Number(qualitySizeMultiplier.toFixed(3)),
      highQualityContinuation,
      explorationSizing: Boolean(signal.explorationTrade),
      riskUsdt: Number(riskUsdt.toFixed(6)),
      stopLossPrice: roundedPrice(signal.price * (isLong ? 1 - stopDistance : 1 + stopDistance), tickSize, !isLong),
      takeProfitPrice: roundedPrice(
        signal.price * (isLong ? 1 + this.config.takeProfitPct / 100 : 1 - this.config.takeProfitPct / 100),
        tickSize,
        !isLong
      ),
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
