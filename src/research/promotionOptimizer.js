"use strict";

const { parseCandles } = require("../indicators");
const { bounded, numeric, round } = require("../strategyUtils");
const { EventDrivenBacktester, summarizeResearchTrades } = require("./eventBacktester");
const { RESEARCH_SYMBOLS } = require("./historicalDataEngine");

const V23_CANDIDATE_STRATEGIES = Object.freeze(["MOMENTUM_CONTINUATION", "PULLBACK", "TREND_BREAKOUT"]);
const V23_DISABLED_STRATEGIES = Object.freeze(["MEAN_REVERSION", "VOLATILITY_EXPANSION"]);
const V23_WALK_FORWARD_WINDOWS_DAYS = Object.freeze([30, 90, 180, 365, 730]);

function candlesForSymbol(candlesBySymbol = {}, symbol, interval = "1m") {
  const value = candlesBySymbol[symbol];
  if (Array.isArray(value)) return parseCandles(value);
  if (value && Array.isArray(value[interval])) return parseCandles(value[interval]);
  if (value && Array.isArray(value["1m"])) return parseCandles(value["1m"]);
  return [];
}

function entryTime(trade) {
  const parsed = Date.parse(trade.enteredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function exitTime(trade) {
  const parsed = Date.parse(trade.exitedAt);
  return Number.isFinite(parsed) ? parsed : entryTime(trade);
}

function applyPortfolioOverlay(trades = [], riskParameters = {}) {
  const maxConcurrentPositions = Math.max(1, Math.round(numeric(riskParameters.maxConcurrentPositions, 3)));
  const maxSameSymbolPositions = Math.max(1, Math.round(numeric(riskParameters.maxSameSymbolPositions, 1)));
  const accepted = [];
  let skippedForOverlap = 0;
  for (const trade of trades.slice().sort((left, right) => entryTime(left) - entryTime(right))) {
    const when = entryTime(trade);
    const active = accepted.filter((item) => exitTime(item) > when);
    const sameSymbol = active.filter((item) => item.symbol === trade.symbol);
    if (active.length >= maxConcurrentPositions || sameSymbol.length >= maxSameSymbolPositions) {
      skippedForOverlap += 1;
      continue;
    }
    accepted.push({
      ...trade,
      portfolioOverlayAccepted: true,
      maxConcurrentPositions,
      maxSameSymbolPositions,
    });
  }
  return {
    trades: accepted,
    skippedForOverlap,
  };
}

function difference(original = {}, optimized = {}) {
  return {
    netProfitUsdt: round(numeric(optimized.netProfitUsdt) - numeric(original.netProfitUsdt), 6),
    netProfitPct: numeric(original.netProfitUsdt) !== 0
      ? round(((numeric(optimized.netProfitUsdt) - numeric(original.netProfitUsdt)) / Math.abs(numeric(original.netProfitUsdt))) * 100, 4)
      : 0,
    maximumDrawdownUsdt: round(numeric(optimized.maximumDrawdownUsdt) - numeric(original.maximumDrawdownUsdt), 6),
    maximumDrawdownPct: numeric(original.maximumDrawdownUsdt) !== 0
      ? round(((numeric(optimized.maximumDrawdownUsdt) - numeric(original.maximumDrawdownUsdt)) / Math.abs(numeric(original.maximumDrawdownUsdt))) * 100, 4)
      : 0,
    profitFactor: round(numeric(optimized.profitFactor) - numeric(original.profitFactor), 4),
    sharpeRatio: round(numeric(optimized.sharpeRatio) - numeric(original.sharpeRatio), 4),
    tradeCount: numeric(optimized.tradeCount) - numeric(original.tradeCount),
    averageHoldSeconds: round(numeric(optimized.averageHoldSeconds) - numeric(original.averageHoldSeconds), 2),
  };
}

function walkForwardValidation(trades = [], config = {}) {
  const times = trades.map((trade) => exitTime(trade)).filter((time) => time > 0);
  const latest = times.length ? Math.max(...times) : Date.now();
  return Object.fromEntries(V23_WALK_FORWARD_WINDOWS_DAYS.map((days) => {
    const cutoff = latest - days * 24 * 60 * 60 * 1000;
    const metrics = summarizeResearchTrades(trades.filter((trade) => exitTime(trade) >= cutoff));
    const passed = numeric(metrics.netProfitUsdt) > 0
      && numeric(metrics.profitFactor) > numeric(config.v23MinProfitFactor, 1.5)
      && numeric(metrics.maximumDrawdownUsdt) <= numeric(config.v23MaxDrawdownUsdt, 85)
      && numeric(metrics.tradeCount) >= Math.min(numeric(config.v23MinTradeCount, 12), 3);
    return [`${days}d`, {
      ...metrics,
      status: passed ? "PASSED" : metrics.tradeCount > 0 ? "FAILED" : "INSUFFICIENT_SAMPLE",
    }];
  }));
}

function dominates(left = {}, right = {}) {
  const leftNet = numeric(left.metrics && left.metrics.netProfitUsdt);
  const rightNet = numeric(right.metrics && right.metrics.netProfitUsdt);
  const leftDrawdown = numeric(left.metrics && left.metrics.maximumDrawdownUsdt);
  const rightDrawdown = numeric(right.metrics && right.metrics.maximumDrawdownUsdt);
  return leftNet >= rightNet && leftDrawdown <= rightDrawdown && (leftNet > rightNet || leftDrawdown < rightDrawdown);
}

function paretoFrontier(candidates = []) {
  return candidates
    .filter((candidate) => !candidates.some((other) => other !== candidate && dominates(other, candidate)))
    .sort((left, right) => numeric(right.metrics.netProfitUsdt) - numeric(left.metrics.netProfitUsdt))
    .slice(0, 20);
}

function optimizerScore(metrics = {}, original = {}, config = {}) {
  const drawdownLimit = numeric(config.v23MaxDrawdownUsdt, 85);
  const drawdownPressure = drawdownLimit > 0 ? Math.max(0, numeric(metrics.maximumDrawdownUsdt) - drawdownLimit) : 0;
  const net = numeric(metrics.netProfitUsdt);
  const pf = numeric(metrics.profitFactor);
  const drawdownImprovement = numeric(original.maximumDrawdownUsdt) - numeric(metrics.maximumDrawdownUsdt);
  return round(net * 1.3 + pf * 20 + drawdownImprovement * 0.8 - drawdownPressure * 2 + numeric(metrics.sharpeRatio) * 6, 6);
}

function riskParameterGrid(config = {}) {
  const capitalMultipliers = [1, 0.95, 0.9, 0.85];
  const stopMultipliers = [0.9, 1, 1.1];
  const trailingActivationR = [0.9, 1.25];
  const trailingDistances = [0.12, 0.18];
  const holdingMultipliers = [0.75, 1, 1.25];
  const maxConcurrentPositions = [1, 2, 3];
  const maxCandidates = Math.max(20, Math.round(numeric(config.v23MaxOptimizationCandidates, 432)));
  const output = [];
  for (const capitalAllocationMultiplier of capitalMultipliers) {
    for (const stopDistanceMultiplier of stopMultipliers) {
      for (const trailingActivation of trailingActivationR) {
        for (const minimumTrailDistancePct of trailingDistances) {
          for (const holdingMultiplier of holdingMultipliers) {
            for (const maxConcurrent of maxConcurrentPositions) {
              output.push({
                capitalAllocationMultiplier,
                stopDistanceMultiplier,
                trailingActivationR: trailingActivation,
                minimumTrailDistancePct,
                holdingMultiplier,
                maxConcurrentPositions: maxConcurrent,
                maxSameSymbolPositions: 1,
                pyramiding: false,
              });
            }
          }
        }
      }
    }
  }
  return output.slice(0, maxCandidates);
}

function riskAdjustedParams(baseParams = {}, riskParameters = {}) {
  const params = { ...baseParams };
  if (Object.prototype.hasOwnProperty.call(params, "atrStop")) {
    params.atrStop = round(Math.max(0.2, numeric(params.atrStop) * numeric(riskParameters.stopDistanceMultiplier, 1)), 4);
  }
  if (Object.prototype.hasOwnProperty.call(params, "holdingBars")) {
    params.holdingBars = Math.max(3, Math.round(numeric(params.holdingBars) * numeric(riskParameters.holdingMultiplier, 1)));
  }
  return params;
}

function promotionEvaluation(config = {}, metrics = {}, original = {}, context = {}) {
  const reasons = [];
  const maxNetReductionPct = numeric(config.v23MaxNetProfitReductionPct, 15);
  const preservedFloor = numeric(original.netProfitUsdt) > 0 ? numeric(original.netProfitUsdt) * (1 - maxNetReductionPct / 100) : 0;
  if (numeric(metrics.netProfitUsdt) <= 0) reasons.push("net profit is not positive");
  if (numeric(metrics.netProfitUsdt) < preservedFloor) reasons.push(`net profit reduction exceeds ${maxNetReductionPct}%`);
  if (numeric(metrics.profitFactor) <= numeric(config.v23MinProfitFactor, 1.5)) reasons.push(`profit factor ${metrics.profitFactor} <= ${numeric(config.v23MinProfitFactor, 1.5)}`);
  if (numeric(metrics.maximumDrawdownUsdt) > numeric(config.v23MaxDrawdownUsdt, 85)) reasons.push(`drawdown ${metrics.maximumDrawdownUsdt} > ${numeric(config.v23MaxDrawdownUsdt, 85)}`);
  if (numeric(metrics.tradeCount) < numeric(config.v23MinTradeCount, 12)) reasons.push(`trade count ${metrics.tradeCount} < ${numeric(config.v23MinTradeCount, 12)}`);
  if (config.v23RequireOutOfSampleValidation !== false && !context.outOfSampleValidated) reasons.push("out-of-sample validation did not pass");
  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function liveProfileFor(strategyResult = {}, config = {}) {
  if (!strategyResult || !strategyResult.promotionEligible) return null;
  return {
    profileName: "LIVE_PROFILE_V23",
    generatedAt: new Date().toISOString(),
    noLiveOrders: true,
    liveExecutionNotStarted: true,
    strategyId: strategyResult.strategyId,
    strategyName: strategyResult.strategyName,
    allowedStrategies: [strategyResult.strategyId],
    disabledStrategies: V23_DISABLED_STRATEGIES,
    doNotCombineStrategies: true,
    entryLogicUnchanged: true,
      optimizedRiskManagement: {
      selectedParams: strategyResult.optimizedParams,
      riskParameters: strategyResult.optimizedRiskParameters,
      maxDeployableCapitalUsdt: numeric(config.maxDeployableCapitalUsdt, 64) || 64,
      maxLeverage: numeric(config.maxLeverage, 10),
      maxPositionsPerSymbol: numeric(config.maxPositionsPerSymbol, 3),
    },
    promotionEvidence: strategyResult.optimized,
    walkForwardValidation: strategyResult.walkForwardValidation,
    outOfSampleValidated: strategyResult.outOfSampleValidated,
    originalEvidence: strategyResult.original,
    difference: strategyResult.difference,
    warning: "This research profile is not a live launch command and does not guarantee profit.",
  };
}

class PromotionOptimizer {
  constructor(config = {}, log = () => {}, strategies = []) {
    this.config = config;
    this.log = log;
    this.strategies = strategies.filter((strategy) => V23_CANDIDATE_STRATEGIES.includes(strategy.strategyId));
  }

  runCandidate(strategy, symbolCandles, baseParams, riskParameters) {
    const config = {
      ...this.config,
      v22ResearchNotionalUsdt: numeric(this.config.v22ResearchNotionalUsdt, 50) * numeric(riskParameters.capitalAllocationMultiplier, 1),
      v22TrailingActivationR: numeric(riskParameters.trailingActivationR, numeric(this.config.v22TrailingActivationR, 1.25)),
      v22MinimumTrailDistancePct: numeric(riskParameters.minimumTrailDistancePct, numeric(this.config.v22MinimumTrailDistancePct, 0.18)),
    };
    const params = riskAdjustedParams(baseParams, riskParameters);
    const backtester = new EventDrivenBacktester(config);
    const rawTrades = [];
    for (const [symbol, candles] of Object.entries(symbolCandles)) {
      rawTrades.push(...backtester.run({ symbol, candles, strategy, params }).trades);
    }
    const overlay = applyPortfolioOverlay(rawTrades, riskParameters);
    const metrics = summarizeResearchTrades(overlay.trades);
    return {
      params,
      riskParameters,
      rawTradeCount: rawTrades.length,
      skippedForOverlap: overlay.skippedForOverlap,
      trades: overlay.trades,
      metrics,
    };
  }

  optimizeStrategy(strategy, symbolCandles, strategyReport = {}) {
    const original = strategyReport.aggregate || {};
    const baseParams = strategyReport.selectedParams || strategy.defaultParams || {};
    const candidates = riskParameterGrid(this.config).map((riskParameters) => {
      const result = this.runCandidate(strategy, symbolCandles, baseParams, riskParameters);
      const evaluation = promotionEvaluation(this.config, result.metrics, original, {
        outOfSampleValidated: Boolean(strategyReport.optimization && strategyReport.optimization.keptOutOfSample),
      });
      return {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        optimizedParams: result.params,
        riskParameters,
        metrics: result.metrics,
        trades: result.trades,
        rawTradeCount: result.rawTradeCount,
        skippedForOverlap: result.skippedForOverlap,
        outOfSampleValidated: Boolean(strategyReport.optimization && strategyReport.optimization.keptOutOfSample),
        promotionEligible: evaluation.eligible,
        promotionBlockedReasons: evaluation.reasons,
        netProfitPreserved: !evaluation.reasons.some((reason) => /net profit reduction/i.test(reason)),
        score: optimizerScore(result.metrics, original, this.config),
      };
    });
    const eligible = candidates.filter((candidate) => candidate.promotionEligible);
    const sorted = candidates
      .slice()
      .sort((left, right) => {
        if (left.promotionEligible !== right.promotionEligible) return left.promotionEligible ? -1 : 1;
        return right.score - left.score;
      });
    const best = sorted[0] || null;
    const frontier = paretoFrontier(candidates);
    const recommendation = best && best.promotionEligible
      ? "PROMOTE"
      : best && numeric(best.metrics.netProfitUsdt) > 0
        ? "KEEP_RESEARCHING_RISK"
        : "REJECT";
    return {
      strategyId: strategy.strategyId,
      strategyName: strategy.name,
      original,
      optimized: best ? best.metrics : {},
      difference: best ? difference(original, best.metrics) : {},
      walkForwardValidation: best ? walkForwardValidation(best.trades, this.config) : {},
      outOfSampleValidated: Boolean(strategyReport.optimization && strategyReport.optimization.keptOutOfSample),
      optimizedParams: best ? best.optimizedParams : baseParams,
      optimizedRiskParameters: best ? best.riskParameters : null,
      promotionEligible: Boolean(best && best.promotionEligible),
      promotionBlockedReasons: best ? best.promotionBlockedReasons : ["no optimization candidates"],
      recommendation,
      evaluatedCandidates: candidates.length,
      eligibleCandidates: eligible.length,
      rejectedByNetProfitProtection: candidates.filter((candidate) => !candidate.netProfitPreserved).length,
      paretoFrontier: frontier.map((candidate) => ({
        netProfitUsdt: candidate.metrics.netProfitUsdt,
        maximumDrawdownUsdt: candidate.metrics.maximumDrawdownUsdt,
        profitFactor: candidate.metrics.profitFactor,
        tradeCount: candidate.metrics.tradeCount,
        riskParameters: candidate.riskParameters,
        params: candidate.optimizedParams,
        promotionEligible: candidate.promotionEligible,
      })),
    };
  }

  run(candlesBySymbol = {}, strategyReports = {}, options = {}) {
    const interval = options.interval || "1m";
    const symbols = (options.symbols || RESEARCH_SYMBOLS).filter((symbol) => candlesForSymbol(candlesBySymbol, symbol, interval).length >= 70);
    const symbolCandles = Object.fromEntries(symbols.map((symbol) => [symbol, candlesForSymbol(candlesBySymbol, symbol, interval)]));
    const strategyResults = {};
    for (const strategy of this.strategies) {
      strategyResults[strategy.strategyId] = this.optimizeStrategy(strategy, symbolCandles, strategyReports[strategy.strategyId] || {});
    }
    const orderedCandidates = V23_CANDIDATE_STRATEGIES
      .map((id) => strategyResults[id])
      .filter(Boolean);
    const promoted = orderedCandidates.find((item) => item.promotionEligible) || null;
    const liveProfile = liveProfileFor(promoted, this.config);
    const report = {
      generatedAt: new Date().toISOString(),
      objective: "V23 Promotion Optimization: keep entry logic fixed, optimize risk management for live eligibility",
      noLiveOrders: true,
      entryLogicUnchanged: true,
      candidateStrategies: V23_CANDIDATE_STRATEGIES,
      disabledStrategies: V23_DISABLED_STRATEGIES,
      thresholds: {
        minProfitFactor: numeric(this.config.v23MinProfitFactor, 1.5),
        maxDrawdownUsdt: numeric(this.config.v23MaxDrawdownUsdt, 85),
        minTradeCount: numeric(this.config.v23MinTradeCount, 12),
        maxNetProfitReductionPct: numeric(this.config.v23MaxNetProfitReductionPct, 15),
        requireOutOfSampleValidation: this.config.v23RequireOutOfSampleValidation !== false,
      },
      strategyResults,
      promotedStrategy: promoted ? {
        strategyId: promoted.strategyId,
        strategyName: promoted.strategyName,
        optimized: promoted.optimized,
        optimizedParams: promoted.optimizedParams,
        optimizedRiskParameters: promoted.optimizedRiskParameters,
      } : null,
      liveProfile,
      message: promoted
        ? `LIVE_PROFILE_V23 generated for ${promoted.strategyName}; entry logic is unchanged and only optimized risk management is applied.`
        : "No V23 strategy satisfied promotion constraints after risk optimization.",
    };
    this.log("INFO", "V23_PROMOTION_OPTIMIZATION_COMPLETED", {
      promotedStrategy: promoted && promoted.strategyId,
      candidateStrategies: V23_CANDIDATE_STRATEGIES,
      disabledStrategies: V23_DISABLED_STRATEGIES,
      message: report.message,
    });
    return report;
  }
}

module.exports = {
  PromotionOptimizer,
  V23_CANDIDATE_STRATEGIES,
  V23_DISABLED_STRATEGIES,
  applyPortfolioOverlay,
  liveProfileFor,
  paretoFrontier,
  promotionEvaluation,
  riskAdjustedParams,
  riskParameterGrid,
};
