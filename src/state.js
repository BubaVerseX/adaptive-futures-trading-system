"use strict";

const fs = require("node:fs");
const path = require("node:path");
const EXCHANGE_ID = "BYBIT_V5_LINEAR";
const CURRENT_STRATEGY_PROFILE = "BYBIT_ADAPTIVE_STAT_SCALP_V2";
const REMOVED_EXECUTION_PAUSE_REASONS = /(?:adaptive\s+)?maximum\s+daily\s+trades|daily\s+trade\s+limit|exploration\s+quota|participation\s+quota|maximum\s+daily\s+loss|daily\s+loss|daily\s+drawdown|daily\s+risk/i;

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

function emptyPerformance() {
  return {
    closedTrades: 0,
    wins: 0,
    losses: 0,
    winRatePct: 0,
    grossPnlUsdt: 0,
    realizedPnlUsdt: 0,
    totalFeesUsdt: 0,
    averageHoldSeconds: 0,
    bestSymbol: null,
    worstSymbol: null,
    symbols: {},
  };
}

function secondsBetween(start, end) {
  const startedAt = Date.parse(start || "");
  const endedAt = Date.parse(end || "");
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return 0;
  return (endedAt - startedAt) / 1000;
}

function initialState(config) {
  return {
    version: 1,
    exchange: EXCHANGE_ID,
    strategyProfile: CURRENT_STRATEGY_PROFILE,
    updatedAt: new Date().toISOString(),
    mode: config.dryRun ? "DRY_RUN" : "LIVE",
    paused: false,
    pauseReason: null,
    equity: {
      startingUsdt: config.accountStartUsdt,
      realizedPnlUsdt: 0,
      currentUsdt: config.accountStartUsdt,
    },
    daily: null,
    ladder: {
      activeLevel: 1,
      highestUnlockedLevel: 1,
      levelStartEquity: config.accountStartUsdt,
      riskDowngraded: false,
    },
    openPositions: [],
    lastPrices: {},
    symbolCooldowns: {},
    performance: emptyPerformance(),
    consecutiveApiErrors: 0,
    apiRecovery: {
      active: false,
      stage: 0,
      shutdownSuppressed: true,
    },
    liveValidation: config.liveValidationMode
      ? {
          level: 0,
          allocatedEquityLimitUsdt: config.liveValidationMaxAllocatedEquityUsdt,
          riskState: "RISK_STATE_NORMAL",
          promotionEligible: false,
          promotionBlockedReasons: [],
          namespace: "data/live-validation",
        }
      : null,
    profitControlled: config.profitControlledEquityMode
      ? {
          namespace: "data/profit-controlled-live",
          startEquityUsdt: null,
          lastSizingEquityBaseUsdt: null,
          sizingEquityBaseUsdt: null,
          usableMarginUsdt: null,
          exchangeReportedTotalEquityUsdt: null,
          riskState: "RISK_STATE_NORMAL",
          riskStateReasons: [],
          totalOpenStopRiskPctLimit: config.maxTotalOpenStopRiskPct,
          correlatedClusterStopRiskPctLimit: config.maxCorrelatedClusterStopRiskPct,
        }
      : null,
    activeAdaptiveScalper: config.activeAdaptiveScalperMode
      ? {
          namespace: "data/paper-trading",
          tradesRejected: 0,
          tradesAccepted: 0,
          rejectionReasons: {},
          recentRejectedTrades: [],
          lastReportAt: null,
          lastRejectionReportAt: null,
        }
      : null,
    trendPortfolio: config.trendPortfolioMode
      ? {
          namespace: "data/trend-portfolio",
          aggressiveMomentumMode: config.trendPortfolioAggressiveMomentumMode,
          multiStrategyPortfolioEngineEnabled: config.multiStrategyPortfolioEngineEnabled,
          activeOpportunityMode: config.activeOpportunityMode,
          strategies: ["TREND_BREAKOUT", "MULTI_TIMEFRAME_TREND", "TREND_PULLBACK"],
          priorScalpingMemoryIsolated: true,
        }
      : null,
    telegramUpdateOffset: 0,
  };
}

class StateStore {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.state = initialState(config);
    this.trades = [];
  }

  load() {
    const loaded = readJson(this.config.stateFile, {});
    const trades = readJson(this.config.tradesFile, []);
    this.state = { ...initialState(this.config), ...loaded };
    this.state.equity = { ...initialState(this.config).equity, ...(loaded.equity || {}) };
    this.state.ladder = { ...initialState(this.config).ladder, ...(loaded.ladder || {}) };
    this.state.openPositions = Array.isArray(loaded.openPositions) ? loaded.openPositions : [];
    this.state.lastPrices = loaded.lastPrices || {};
    this.state.symbolCooldowns = loaded.symbolCooldowns || {};
    this.state.performance = { ...emptyPerformance(), ...(loaded.performance || {}) };
    this.state.liveValidation = this.config.liveValidationMode
      ? { ...initialState(this.config).liveValidation, ...(loaded.liveValidation || {}) }
      : null;
    this.state.profitControlled = this.config.profitControlledEquityMode
      ? { ...initialState(this.config).profitControlled, ...(loaded.profitControlled || {}) }
      : null;
    this.state.activeAdaptiveScalper = this.config.activeAdaptiveScalperMode
      ? { ...initialState(this.config).activeAdaptiveScalper, ...(loaded.activeAdaptiveScalper || {}) }
      : null;
    this.state.trendPortfolio = this.config.trendPortfolioMode
      ? { ...initialState(this.config).trendPortfolio, ...(loaded.trendPortfolio || {}) }
      : null;
    this.trades = Array.isArray(trades) ? trades : [];
    this.migrateExchange(loaded.exchange);
    this.resetCountersOnModeChange();
    this.removePositionsFromAnotherMode();
    this.migrateStrategyProfile(loaded.strategyProfile);
    this.clearRemovedExecutionPause();
    this.rebuildRealizedPnl();
    this.rebuildPerformance();
    this.saveAll();
    return this.state;
  }

  migrateExchange(previousExchange) {
    if (previousExchange === EXCHANGE_ID) return;
    const discardedIds = new Set(this.state.openPositions.map((position) => position.id));
    const discardedTrades = this.trades.length;
    this.trades = [];
    this.state.exchange = EXCHANGE_ID;
    this.state.openPositions = [];
    this.state.lastPrices = {};
    this.state.symbolCooldowns = {};
    this.state.performance = emptyPerformance();
    this.state.paused = false;
    this.state.pauseReason = null;
    this.state.daily = null;
    this.state.consecutiveApiErrors = 0;
    this.log("WARN", "Initialized clean Bybit runtime state; positions recorded for another exchange are not managed here.", {
      discardedManagedPositions: discardedIds.size,
      discardedHistoricalTrades: discardedTrades,
    });
  }

  removePositionsFromAnotherMode() {
    const mode = this.config.dryRun ? "DRY_RUN" : "LIVE";
    const incompatible = this.state.openPositions.filter((position) => position.mode !== mode);
    if (!incompatible.length) return;
    this.state.openPositions = this.state.openPositions.filter((position) => position.mode === mode);
    for (const position of incompatible) {
      const trade = this.trades.find((item) => item.id === position.id && item.status === "OPEN");
      if (trade) trade.status = "IGNORED_AFTER_MODE_CHANGE";
    }
    this.log("WARN", "Ignored persisted positions from another operating mode.", {
      requiredMode: mode,
      count: incompatible.length,
    });
  }

  resetCountersOnModeChange() {
    const mode = this.config.dryRun ? "DRY_RUN" : "LIVE";
    const priorMode = this.state.mode;
    if (!priorMode || priorMode === mode) {
      this.state.mode = mode;
      return;
    }
    const trackedLivePositions = this.state.openPositions.filter((position) => position.mode === "LIVE");
    if (mode === "DRY_RUN" && trackedLivePositions.length > 0) {
      throw new Error("DRY_RUN startup refused while tracked LIVE positions exist; verify and close live exposure first.");
    }
    const defaults = initialState(this.config);
    this.state.mode = mode;
    this.state.paused = false;
    this.state.pauseReason = null;
    this.state.equity = defaults.equity;
    this.state.daily = null;
    this.state.ladder = defaults.ladder;
    this.state.symbolCooldowns = {};
    this.state.performance = emptyPerformance();
    this.state.consecutiveApiErrors = 0;
    this.state.apiRecovery = defaults.apiRecovery;
    this.state.liveValidation = defaults.liveValidation;
    this.state.profitControlled = defaults.profitControlled;
    this.state.activeAdaptiveScalper = defaults.activeAdaptiveScalper;
    this.state.trendPortfolio = defaults.trendPortfolio;
    this.log("WARN", "Operating mode changed; performance counters reset for the new mode.", {
      fromMode: priorMode,
      toMode: mode,
    });
  }

  migrateStrategyProfile(previousProfile) {
    if (previousProfile === CURRENT_STRATEGY_PROFILE) return;
    this.state.strategyProfile = CURRENT_STRATEGY_PROFILE;
    if (this.state.openPositions.length === 0) {
      this.state.paused = false;
      this.state.pauseReason = null;
      this.state.daily = null;
      this.state.ladder.riskDowngraded = false;
      this.log("INFO", "Adaptive statistical scalping profile activated; continuous execution will rebuild performance state from current equity.", {
        strategyProfile: CURRENT_STRATEGY_PROFILE,
      });
    }
  }

  clearRemovedExecutionPause() {
    if (!this.config.continuousExecutionMode || !this.state.paused) return;
    if (!REMOVED_EXECUTION_PAUSE_REASONS.test(String(this.state.pauseReason || ""))) return;
    const oldReason = this.state.pauseReason;
    this.state.paused = false;
    this.state.pauseReason = null;
    this.log("WARN", "Continuous execution mode active; removed stale portfolio execution blocker from saved state.", {
      oldReason,
      dailyShutdownLogicRemoved: true,
    });
  }

  rebuildRealizedPnl() {
    this.state.equity.realizedPnlUsdt = this.trades
      .filter(
        (trade) =>
          trade.mode === this.state.mode &&
          trade.status === "CLOSED" &&
          Number.isFinite(Number(trade.pnlUsdt))
      )
      .reduce((total, trade) => total + Number(trade.pnlUsdt), 0);
  }

  rebuildPerformance() {
    const closedTrades = this.trades.filter(
      (trade) =>
        trade.mode === this.state.mode &&
        trade.status === "CLOSED" &&
        Number.isFinite(Number(trade.pnlUsdt))
    );
    const totals = emptyPerformance();
    let totalHoldSeconds = 0;

    for (const trade of closedTrades) {
      const symbol = trade.symbol || "UNKNOWN";
      const pnl = Number(trade.pnlUsdt || 0);
      const gross = Number.isFinite(Number(trade.grossPnlUsdt))
        ? Number(trade.grossPnlUsdt)
        : pnl + Number(trade.estimatedFeesUsdt || trade.feesUsdt || 0);
      const fees = Number(trade.feesUsdt || trade.estimatedFeesUsdt || 0);
      const holdSeconds = Number(trade.holdSeconds || secondsBetween(trade.openedAt || trade.entryTime, trade.exitedAt || trade.exitTime));
      totals.closedTrades += 1;
      totals.grossPnlUsdt += gross;
      totals.realizedPnlUsdt += pnl;
      totals.totalFeesUsdt += fees;
      totalHoldSeconds += holdSeconds;
      if (pnl > 0) totals.wins += 1;
      if (pnl < 0) totals.losses += 1;

      if (!totals.symbols[symbol]) {
        totals.symbols[symbol] = {
          closedTrades: 0,
          wins: 0,
          losses: 0,
          winRatePct: 0,
          grossPnlUsdt: 0,
          realizedPnlUsdt: 0,
          totalFeesUsdt: 0,
          averageHoldSeconds: 0,
          bestTradePnlUsdt: null,
          worstTradePnlUsdt: null,
        };
      }
      const stats = totals.symbols[symbol];
      stats.closedTrades += 1;
      stats.grossPnlUsdt += gross;
      stats.realizedPnlUsdt += pnl;
      stats.totalFeesUsdt += fees;
      stats.averageHoldSeconds += holdSeconds;
      stats.bestTradePnlUsdt = stats.bestTradePnlUsdt === null ? pnl : Math.max(stats.bestTradePnlUsdt, pnl);
      stats.worstTradePnlUsdt = stats.worstTradePnlUsdt === null ? pnl : Math.min(stats.worstTradePnlUsdt, pnl);
      if (pnl > 0) stats.wins += 1;
      if (pnl < 0) stats.losses += 1;
    }

    totals.winRatePct = totals.closedTrades ? Number(((totals.wins / totals.closedTrades) * 100).toFixed(2)) : 0;
    totals.averageHoldSeconds = totals.closedTrades ? Number((totalHoldSeconds / totals.closedTrades).toFixed(2)) : 0;

    for (const stats of Object.values(totals.symbols)) {
      stats.winRatePct = stats.closedTrades ? Number(((stats.wins / stats.closedTrades) * 100).toFixed(2)) : 0;
      stats.averageHoldSeconds = stats.closedTrades ? Number((stats.averageHoldSeconds / stats.closedTrades).toFixed(2)) : 0;
      stats.grossPnlUsdt = Number(stats.grossPnlUsdt.toFixed(6));
      stats.realizedPnlUsdt = Number(stats.realizedPnlUsdt.toFixed(6));
      stats.totalFeesUsdt = Number(stats.totalFeesUsdt.toFixed(6));
    }

    const symbolRows = Object.entries(totals.symbols);
    const best = symbolRows.sort((left, right) => right[1].realizedPnlUsdt - left[1].realizedPnlUsdt)[0];
    const worst = [...symbolRows].sort((left, right) => left[1].realizedPnlUsdt - right[1].realizedPnlUsdt)[0];
    totals.bestSymbol = best ? { symbol: best[0], realizedPnlUsdt: best[1].realizedPnlUsdt, winRatePct: best[1].winRatePct } : null;
    totals.worstSymbol = worst ? { symbol: worst[0], realizedPnlUsdt: worst[1].realizedPnlUsdt, winRatePct: worst[1].winRatePct } : null;
    totals.grossPnlUsdt = Number(totals.grossPnlUsdt.toFixed(6));
    totals.realizedPnlUsdt = Number(totals.realizedPnlUsdt.toFixed(6));
    totals.totalFeesUsdt = Number(totals.totalFeesUsdt.toFixed(6));
    this.state.performance = totals;
  }

  saveState() {
    this.state.updatedAt = new Date().toISOString();
    writeJson(this.config.stateFile, this.state);
  }

  saveTrades() {
    writeJson(this.config.tradesFile, this.trades);
  }

  saveAll() {
    this.saveState();
    this.saveTrades();
  }
}

module.exports = { EXCHANGE_ID, StateStore };
