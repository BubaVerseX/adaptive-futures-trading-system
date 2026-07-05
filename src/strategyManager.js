"use strict";

const fs = require("node:fs");
const { createDefaultStrategies, regimeName } = require("./strategies/quantStrategies");
const { validateStrategyInterface } = require("./strategies/interface");
const { bounded, clampScore, numeric, round } = require("./strategyUtils");

function returnStats(values) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return { average: 0, standardDeviation: 0, downsideDeviation: 0 };
  const average = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  const variance = usable.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / usable.length;
  const downside = usable.filter((value) => value < 0);
  const downsideVariance = downside.length ? downside.reduce((sum, value) => sum + Math.pow(value, 2), 0) / downside.length : 0;
  return {
    average,
    standardDeviation: Math.sqrt(variance),
    downsideDeviation: Math.sqrt(downsideVariance),
  };
}

function drawdown(values) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return maxDrawdown;
}

function summarizeStrategyTrades(trades = []) {
  const closed = trades.filter((trade) => Number.isFinite(numeric(trade.netPnlUsdt, Number.NaN)) || Number.isFinite(numeric(trade.pnlUsdt, Number.NaN)) || Number.isFinite(numeric(trade.realizedPnlUsdt, Number.NaN)));
  const pnls = closed.map((trade) => numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt, numeric(trade.realizedPnlUsdt))));
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const fees = closed.reduce((sum, trade) => sum + numeric(trade.feesUsdt, numeric(trade.totalFeesUsdt, numeric(trade.feesPaidUsdt))), 0);
  const holdSeconds = closed.map((trade) => numeric(trade.holdSeconds, numeric(trade.holdingTimeSeconds))).filter((value) => value > 0);
  const returns = returnStats(pnls);
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = closed.filter((trade) => {
    const when = Date.parse(trade.exitedAt || trade.closedAt || trade.timestamp || "");
    return Number.isFinite(when) && when >= recentCutoff;
  });
  const recentPnl = recent.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt, numeric(trade.pnlUsdt, numeric(trade.realizedPnlUsdt))), 0);
  return {
    trades: closed.length,
    netProfitUsdt: round(pnls.reduce((sum, value) => sum + value, 0), 6),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : wins.length ? 999 : 0,
    winRatePct: closed.length ? round((wins.length / closed.length) * 100, 2) : 0,
    averageWinnerUsdt: wins.length ? round(grossWin / wins.length, 6) : 0,
    averageLoserUsdt: losses.length ? round(grossLoss / losses.length, 6) : 0,
    averageHoldSeconds: holdSeconds.length ? round(holdSeconds.reduce((sum, value) => sum + value, 0) / holdSeconds.length, 2) : 0,
    feesUsdt: round(fees, 6),
    maximumDrawdownUsdt: round(drawdown(pnls), 6),
    sharpe: returns.standardDeviation > 0 ? round(returns.average / returns.standardDeviation, 4) : 0,
    sortino: returns.downsideDeviation > 0 ? round(returns.average / returns.downsideDeviation, 4) : 0,
    rolling30DayExpectancyUsdt: recent.length ? round(recentPnl / recent.length, 6) : 0,
  };
}

function performanceScore(metrics = {}) {
  const profitFactorScore = Math.min(40, numeric(metrics.profitFactor) * 18);
  const expectancyScore = bounded(numeric(metrics.rolling30DayExpectancyUsdt, numeric(metrics.netProfitUsdt) / Math.max(1, numeric(metrics.trades))) * 60, -20, 30);
  const winRateScore = bounded((numeric(metrics.winRatePct) - 45) * 0.35, -10, 15);
  const drawdownPenalty = Math.min(20, numeric(metrics.maximumDrawdownUsdt) * 2);
  const feePenalty = Math.min(10, numeric(metrics.feesUsdt) / Math.max(1, Math.abs(numeric(metrics.netProfitUsdt))) * 5);
  return round(bounded(35 + profitFactorScore + expectancyScore + winRateScore - drawdownPenalty - feePenalty, 0, 100), 4);
}

function rankingFromTrades(strategies, tradesByStrategy = {}) {
  return strategies
    .map((strategy) => {
      const trades = tradesByStrategy[strategy.strategyId] || tradesByStrategy[strategy.name] || [];
      const metrics = summarizeStrategyTrades(trades);
      return {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        ...metrics,
        performanceScore: performanceScore(metrics),
      };
    })
    .sort((left, right) => right.performanceScore - left.performanceScore);
}

function allocationWeights(config, rankings = []) {
  const floor = numeric(config.v18MinStrategyAllocationWeight, 0.15);
  const cap = numeric(config.v18MaxStrategyAllocationWeight, 0.55);
  const raw = {};
  for (const ranking of rankings) {
    raw[ranking.strategyId] = bounded(numeric(ranking.performanceScore) / 100, floor, cap);
  }
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(value / total, 4)]));
}

function walkForwardValidation(rankings = [], config = {}) {
  return rankings.map((ranking) => {
    const enoughTrades = ranking.trades >= numeric(config.v18WalkForwardMinTrades, 20);
    const passed =
      enoughTrades &&
      ranking.profitFactor >= numeric(config.v18WalkForwardMinProfitFactor, 1) &&
      ranking.rolling30DayExpectancyUsdt >= numeric(config.v18WalkForwardMinExpectancyUsdt, 0);
    return {
      strategyId: ranking.strategyId,
      strategyName: ranking.strategyName,
      status: passed ? "PASSED" : enoughTrades ? "FAILED" : "INSUFFICIENT_SAMPLE",
      active: passed || !config.v18RequireWalkForwardValidation,
      reason: passed
        ? "rolling validation metrics passed"
        : enoughTrades
          ? "minimum profit factor or expectancy failed"
          : "not enough completed strategy samples for strict walk-forward gating",
    };
  });
}

function liveStrategyIdFromLaboratory(strategyId) {
  if (strategyId === "LAB_TREND_BREAKOUT") return "TREND_BREAKOUT";
  if (strategyId === "LAB_TREND_PULLBACK") return "TREND_PULLBACK";
  if (strategyId === "LAB_MOMENTUM_CONTINUATION") return "MOMENTUM_CONTINUATION";
  if (strategyId === "LAB_MEAN_REVERSION") return "MEAN_REVERSION";
  if (strategyId === "LAB_VOLATILITY_EXPANSION") return "VOLATILITY_EXPANSION";
  return strategyId;
}

class StrategyManager {
  constructor(config, log = () => {}, strategies = createDefaultStrategies()) {
    this.config = config;
    this.log = log;
    this.strategies = strategies;
    for (const strategy of this.strategies) validateStrategyInterface(strategy);
    this.labEligibility = this.loadLaboratoryEligibility();
  }

  loadLaboratoryEligibility() {
    if (!this.config.v21RequireLabPromotionForLive) {
      return { required: false, promoted: null, reason: "V21 lab promotion gate disabled" };
    }
    try {
      const report = JSON.parse(fs.readFileSync(this.config.strategyLaboratoryReportFile, "utf8"));
      const promoted = new Set((report.promotedStrategies || []).flatMap((item) => [
        item.strategyId,
        liveStrategyIdFromLaboratory(item.strategyId),
      ]));
      if (!promoted.size) {
        return { required: true, promoted, reason: "No promoted V21 laboratory strategies; live strategy output disabled." };
      }
      return { required: true, promoted, reason: `V21 laboratory promoted ${promoted.size} strategy module(s).` };
    } catch (error) {
      return { required: true, promoted: new Set(), reason: `V21 laboratory report unavailable: ${error.message}` };
    }
  }

  laboratoryAllows(strategyId) {
    if (!this.labEligibility.required) return true;
    return this.labEligibility.promoted && this.labEligibility.promoted.has(strategyId);
  }

  rankingsFromAdaptiveStats(stats = {}) {
    const pseudoTradesByStrategy = {};
    for (const strategy of this.strategies) {
      const bucket = stats[strategy.strategyId] || stats[strategy.name];
      if (!bucket || !bucket.count) {
        pseudoTradesByStrategy[strategy.strategyId] = [];
        continue;
      }
      const average = numeric(bucket.averagePnlUsdt, numeric(bucket.feeAdjustedPnlUsdt) / Math.max(1, numeric(bucket.count)));
      pseudoTradesByStrategy[strategy.strategyId] = Array.from({ length: Math.max(1, Math.min(200, numeric(bucket.count))) }, (_, index) => ({
        netPnlUsdt: index < numeric(bucket.wins) ? Math.abs(average || 0.01) : -Math.abs(average || 0.01),
        feesUsdt: numeric(bucket.totalFeesUsdt) / Math.max(1, numeric(bucket.count)),
        holdSeconds: numeric(bucket.averageHoldSeconds),
        exitedAt: new Date().toISOString(),
      }));
    }
    return rankingFromTrades(this.strategies, pseudoTradesByStrategy);
  }

  portfolioOutputs(context = {}) {
    const rankings = context.strategyRankings || this.rankingsFromAdaptiveStats(context.strategyPerformanceStats || {});
    const allocations = allocationWeights(this.config, rankings);
    const validation = walkForwardValidation(rankings, this.config);
    const validationByStrategy = Object.fromEntries(validation.map((item) => [item.strategyId, item]));
    const regime = context.marketRegime || {};
    const outputs = this.strategies.map((strategy) => {
      const laboratoryAllowed = this.laboratoryAllows(strategy.strategyId);
      const sideEvaluations = {};
      for (const side of ["LONG", "SHORT"]) {
        const signal = strategy.generateSignal({ ...context, config: this.config, onlySide: side });
        const compatibility = strategy.marketCompatibility(regime);
        const validationStatus = validationByStrategy[strategy.strategyId] || { active: true, status: "NOT_EVALUATED" };
        const sizing = strategy.positionSizing(signal, { allocationWeight: allocations[strategy.strategyId] || (1 / this.strategies.length) });
        sideEvaluations[side] = {
          ...signal,
          evaluatedSide: side,
          direction: side,
          rawDirection: signal.direction,
          rawConfidence: numeric(signal.confidence),
          confidence: validationStatus.active && laboratoryAllowed ? clampScore(numeric(signal.confidence) * bounded(0.78 + compatibility * 0.22, 0, 1.05)) : 0,
          strategyAllocationWeight: allocations[strategy.strategyId] || 0,
          strategyAllocationMultiplier: sizing.performanceMultiplier,
          positionSizeMultiplier: sizing.positionSizeMultiplier,
          marketCompatibilityScore: round(compatibility, 4),
          walkForwardValidation: laboratoryAllowed ? validationStatus : {
            ...validationStatus,
            active: false,
            status: "V21_LAB_NOT_PROMOTED",
            reason: this.labEligibility.reason,
          },
          v21LaboratoryAllowed: laboratoryAllowed,
          portfolioWeight: allocations[strategy.strategyId] || 0,
        };
      }
      const selectedSide = sideEvaluations.LONG.confidence >= sideEvaluations.SHORT.confidence ? "LONG" : "SHORT";
      this.log("DEBUG", "V18_STRATEGY_MANAGER_SIGNAL", {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        selectedSide,
        confidence: sideEvaluations[selectedSide].confidence,
        allocationWeight: allocations[strategy.strategyId] || 0,
        marketCompatibility: sideEvaluations[selectedSide].marketCompatibilityScore,
        validation: sideEvaluations[selectedSide].walkForwardValidation.status,
        v21LaboratoryAllowed: laboratoryAllowed,
      });
      return {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        weight: allocations[strategy.strategyId] || 0,
        direction: selectedSide,
        confidence: sideEvaluations[selectedSide].confidence,
        sideEvaluations,
        scoreBreakdown: [
          `${strategy.name} LONG ${sideEvaluations.LONG.confidence}`,
          `${strategy.name} SHORT ${sideEvaluations.SHORT.confidence}`,
        ],
      };
    });
    return {
      outputs,
      rankings,
      allocations,
      validation,
      regime: regimeName(regime),
    };
  }

  dashboard(tradesByStrategy = {}) {
    const rankings = rankingFromTrades(this.strategies, tradesByStrategy);
    const allocations = allocationWeights(this.config, rankings);
    const validation = walkForwardValidation(rankings, this.config);
    const recommended = rankings[0] || null;
    return {
      activeStrategies: this.strategies.map((strategy) => strategy.name),
      performanceRanking: rankings,
      currentAllocation: allocations,
      profitContributionByStrategy: Object.fromEntries(rankings.map((item) => [item.strategyId, item.netProfitUsdt])),
      rollingExpectancy: Object.fromEntries(rankings.map((item) => [item.strategyId, item.rolling30DayExpectancyUsdt])),
      walkForwardValidation: validation,
      recommendedHighestAllocation: recommended ? {
        strategyId: recommended.strategyId,
        strategyName: recommended.strategyName,
        reason: `highest V18 performance score ${recommended.performanceScore}`,
      } : null,
    };
  }
}

module.exports = {
  StrategyManager,
  allocationWeights,
  rankingFromTrades,
  summarizeStrategyTrades,
  walkForwardValidation,
};
