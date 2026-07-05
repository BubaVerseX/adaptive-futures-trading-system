"use strict";

const { analyzeCandles, parseCandles } = require("./indicators");
const { PortfolioDecisionEngine } = require("./portfolioDecisionEngine");
const { StrategyManager } = require("./strategyManager");
const { evaluateTrendBreakout } = require("./strategies/trendBreakout");
const { evaluateMultiTimeframeTrend } = require("./strategies/multiTimeframeTrend");
const { evaluateTrendPullback } = require("./strategies/trendPullback");
const { rollingWalkForwardFactorValidation, summarizeFactorTrades } = require("./quantIntelligenceEngine");
const {
  gradeTradeQuality,
  summarizeInstitutionalTrades,
  walkForwardValidation: institutionalWalkForwardValidation,
} = require("./institutionalQuantEngine");
const { summarizeLabTrades } = require("./strategyLaboratory");
const { numeric } = require("./strategyUtils");

const STRATEGY_EVALUATORS = Object.freeze({
  TREND_BREAKOUT: evaluateTrendBreakout,
  MULTI_TIMEFRAME_TREND: evaluateMultiTimeframeTrend,
  TREND_PULLBACK: evaluateTrendPullback,
});

function round(value, digits = 6) {
  return Number(numeric(value).toFixed(digits));
}

function percentileReturns(values) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return { average: 0, downsideDeviation: 0, standardDeviation: 0 };
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

function summarizeTrades(trades) {
  const wins = trades.filter((trade) => trade.netPnlUsdt > 0);
  const losses = trades.filter((trade) => trade.netPnlUsdt < 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.netPnlUsdt, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnlUsdt, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnlUsdt;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const returns = percentileReturns(trades.map((trade) => trade.netReturnPct));
  return {
    trades: trades.length,
    netProfitUsdt: round(trades.reduce((sum, trade) => sum + trade.netPnlUsdt, 0)),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : wins.length ? 999 : 0,
    winRatePct: trades.length ? round((wins.length / trades.length) * 100, 2) : 0,
    averageWinnerUsdt: wins.length ? round(grossWin / wins.length) : 0,
    averageLoserUsdt: losses.length ? round(grossLoss / losses.length) : 0,
    averageHoldSeconds: trades.length ? round(trades.reduce((sum, trade) => sum + numeric(trade.holdSeconds), 0) / trades.length, 2) : 0,
    maxDrawdownUsdt: round(maxDrawdown),
    sharpeRatio: returns.standardDeviation > 0 ? round(returns.average / returns.standardDeviation, 4) : 0,
    sortinoRatio: returns.downsideDeviation > 0 ? round(returns.average / returns.downsideDeviation, 4) : 0,
    feesPaidUsdt: round(trades.reduce((sum, trade) => sum + trade.feesUsdt, 0)),
    strategyContributionPercentages: strategyContributionPercentages(trades),
  };
}

function compareSummaries(current = {}, previous = {}) {
  return {
    current: "V17_ACTIVE_OPPORTUNITY",
    previous: "PORTFOLIO_COMBINED",
    netProfitDeltaUsdt: round(numeric(current.netProfitUsdt) - numeric(previous.netProfitUsdt)),
    maxDrawdownDeltaUsdt: round(numeric(current.maxDrawdownUsdt) - numeric(previous.maxDrawdownUsdt)),
    feesDeltaUsdt: round(numeric(current.feesPaidUsdt) - numeric(previous.feesPaidUsdt)),
    tradeCountDelta: numeric(current.trades) - numeric(previous.trades),
    averageHoldSecondsDelta: round(numeric(current.averageHoldSeconds) - numeric(previous.averageHoldSeconds), 2),
    netProfit: {
      v17ActiveOpportunity: numeric(current.netProfitUsdt),
      previousCombinedPortfolio: numeric(previous.netProfitUsdt),
    },
    drawdown: {
      v17ActiveOpportunity: numeric(current.maxDrawdownUsdt),
      previousCombinedPortfolio: numeric(previous.maxDrawdownUsdt),
    },
    fees: {
      v17ActiveOpportunity: numeric(current.feesPaidUsdt),
      previousCombinedPortfolio: numeric(previous.feesPaidUsdt),
    },
    tradeCount: {
      v17ActiveOpportunity: numeric(current.trades),
      previousCombinedPortfolio: numeric(previous.trades),
    },
    averageHoldingTimeSeconds: {
      v17ActiveOpportunity: numeric(current.averageHoldSeconds),
      previousCombinedPortfolio: numeric(previous.averageHoldSeconds),
    },
  };
}

function strategyContributionPercentages(trades) {
  const counts = {};
  let total = 0;
  for (const trade of trades) {
    const contributions = Array.isArray(trade.strategyContributions) && trade.strategyContributions.length
      ? trade.strategyContributions
      : trade.strategyId
        ? [{ strategyId: trade.strategyId }]
        : [];
    for (const contribution of contributions) {
      const key = contribution.strategyId || "UNKNOWN";
      counts[key] = (counts[key] || 0) + 1;
      total += 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, total ? round((value / total) * 100, 2) : 0]));
}

function makeAnalyses(candles, index, window = 90) {
  const slice = candles.slice(Math.max(0, index - window + 1), index + 1);
  const parsed = parseCandles(slice);
  const analysis = analyzeCandles(parsed, 55);
  return {
    entry: analysis,
    confirmation: analysis,
    trend: analysis,
    macro: analysis,
    macroLong: analysis,
    entryCandles: parsed,
    confirmationCandles: parsed,
    trendCandles: parsed,
    macroCandles: parsed,
    macroLongCandles: parsed,
  };
}

function syntheticMarketData(symbol, candles, index, analyses) {
  const latest = candles[index] || {};
  const previous = candles[Math.max(0, index - 4)] || latest;
  const priceChangePct = numeric(previous.close) > 0 ? ((numeric(latest.close) - numeric(previous.close)) / numeric(previous.close)) * 100 : 0;
  const relativeVolume = numeric(analyses.entry && analyses.entry.volumeSpike, 1);
  const oiDirection = Math.sign(priceChangePct || numeric(analyses.entry && analyses.entry.momentumPct));
  const oiChangePct = oiDirection * Math.min(6, Math.abs(priceChangePct) * 1.5 + Math.max(0, relativeVolume - 1) * 2);
  const syntheticOi = 1000000 + index * 1000 + (symbol === "BTCUSDT" ? 500000 : symbol === "ETHUSDT" ? 250000 : 125000);
  const fundingRate = Math.max(-0.0009, Math.min(0.0009, numeric(analyses.trend && analyses.trend.momentumPct) / 10000));
  return {
    symbol,
    price: numeric(latest.close),
    priceChangePct,
    fundingRate,
    fundingRatePct: fundingRate * 100,
    funding: {
      rate: fundingRate,
      ratePct: fundingRate * 100,
      source: "synthetic-backtest",
    },
    openInterest: {
      current: syntheticOi,
      previous: syntheticOi / (1 + oiChangePct / 100),
      changePct: oiChangePct,
      source: "synthetic-backtest",
    },
  };
}

function simulateExit(signal, candles, index, config, notionalUsdt) {
  const side = signal.side || signal.direction;
  const entry = Number(candles[index].close);
  const stopPct = Math.max(numeric(signal.stopDistancePct), numeric(config.stopLossPct));
  const targetPct = Math.max(numeric(signal.expectedMovePct), stopPct * numeric(config.v15MinRewardRisk, 1.2));
  const holdingBars = Math.max(4, Math.min(96, Math.round(numeric(signal.preferredHoldingTimeSeconds, 6 * 60 * 60) / (15 * 60))));
  const stop = side === "LONG" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  const target = side === "LONG" ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100);
  let exit = Number(candles[Math.min(candles.length - 1, index + holdingBars)].close);
  let reason = "TIME_EXIT";
  let maxFavorablePct = 0;
  let maxAdversePct = 0;
  for (let cursor = index + 1; cursor < Math.min(candles.length, index + holdingBars + 1); cursor += 1) {
    const candle = candles[cursor];
    const favorablePct = side === "LONG" ? ((Number(candle.high) - entry) / entry) * 100 : ((entry - Number(candle.low)) / entry) * 100;
    const adversePct = side === "LONG" ? ((entry - Number(candle.low)) / entry) * 100 : ((Number(candle.high) - entry) / entry) * 100;
    maxFavorablePct = Math.max(maxFavorablePct, favorablePct);
    maxAdversePct = Math.max(maxAdversePct, adversePct);
    if (side === "LONG" && Number(candle.low) <= stop) {
      exit = stop;
      reason = "ATR_STOP";
      break;
    }
    if (side === "SHORT" && Number(candle.high) >= stop) {
      exit = stop;
      reason = "ATR_STOP";
      break;
    }
    if (side === "LONG" && Number(candle.high) >= target) {
      exit = target;
      reason = "TREND_TARGET_REFERENCE";
      break;
    }
    if (side === "SHORT" && Number(candle.low) <= target) {
      exit = target;
      reason = "TREND_TARGET_REFERENCE";
      break;
    }
  }
  const grossPct = side === "LONG" ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
  const feesPct = numeric(config.estimatedFeePctPerSide) * 2 + numeric(config.estimatedSlippagePct);
  const netPct = grossPct - feesPct;
  return {
    entry,
    exit,
    reason,
    enteredAt: new Date(Number(candles[index].time || Date.now())).toISOString(),
    exitedAt: new Date(Number(candles[Math.min(candles.length - 1, index + holdingBars)].time || Date.now())).toISOString(),
    holdSeconds: Math.max(0, (Math.min(candles.length - 1, index + holdingBars) - index) * 15 * 60),
    grossPct: round(grossPct, 4),
    netReturnPct: round(netPct, 4),
    maximumFavorableExcursionPct: round(maxFavorablePct, 4),
    maximumAdverseExcursionPct: round(maxAdversePct, 4),
    grossPnlUsdt: round(notionalUsdt * (grossPct / 100)),
    feesUsdt: round(notionalUsdt * (feesPct / 100)),
    netPnlUsdt: round(notionalUsdt * (netPct / 100)),
  };
}

function evaluateIndependentStrategy(strategyId, config, symbol, item, analyses, spreadPct) {
  const evaluator = STRATEGY_EVALUATORS[strategyId];
  if (!evaluator) return null;
  const output = evaluator({
    symbol,
    price: item.price,
    spreadPct,
    volume: item.volume,
    analyses,
    config,
    marketProfile: { direction: "CHOPPY", tags: [] },
    estimatedRoundTripCostPct: numeric(config.estimatedFeePctPerSide) * 2 + numeric(config.estimatedSlippagePct) + spreadPct,
  });
  if (!["LONG", "SHORT"].includes(output.direction)) return null;
  return {
    side: output.direction,
    confidence: output.confidence,
    expectedMovePct: output.expectedMovePct,
    stopDistancePct: output.stopDistancePct,
    preferredHoldingTimeSeconds: output.preferredHoldingTimeSeconds,
    setupType: output.setupType,
    strategyId,
  };
}

function runV15Backtest(config, candlesBySymbol, options = {}) {
  const portfolio = new PortfolioDecisionEngine(config, () => {});
  const strategyManager = new StrategyManager(config, () => {});
  const notionalUsdt = numeric(options.notionalUsdt, 50);
  const symbols = Object.keys(candlesBySymbol || {});
  const grouped = {};
  for (const mode of ["PORTFOLIO_COMBINED", "V17_ACTIVE_OPPORTUNITY", ...Object.keys(STRATEGY_EVALUATORS)]) grouped[mode] = [];
  const shadowOpportunities = [];
  const strategyLaboratoryShadowTrades = [];
  for (const symbol of symbols) {
    const candles = parseCandles(candlesBySymbol[symbol] || []);
    for (let index = 60; index < candles.length - 5; index += 1) {
      const analyses = makeAnalyses(candles, index);
      if (!analyses.entry) continue;
      const item = { price: candles[index].close, volume: candles[index].turnover || candles[index].volume, spreadPct: numeric(options.spreadPct, 0.025) };
      const context = {
        symbol,
        price: item.price,
        spreadPct: item.spreadPct,
        volume: item.volume,
        analyses,
        marketProfile: { direction: "CHOPPY", tags: [] },
      };
      context.marketData = syntheticMarketData(symbol, candles, index, analyses);
      const decision = portfolio.evaluate(context);
      if (decision.eligible) {
        const selectedContributions = decision.strategyOutputs.map((output) => ({
          strategyId: output.strategyId,
          contributionPct: Math.round((output.weight || 0) * 10000) / 100,
          selectedSideConfidence: output.sideEvaluations[decision.side].confidence,
          oppositeSideConfidence: output.sideEvaluations[decision.side === "LONG" ? "SHORT" : "LONG"].confidence,
        }));
        const simulated = simulateExit({
          side: decision.side,
          expectedMovePct: decision.expectedMovePct,
          stopDistancePct: decision.stopDistancePct,
          preferredHoldingTimeSeconds: decision.preferredHoldingTimeSeconds,
        }, candles, index, config, notionalUsdt);
        const trade = {
          symbol,
          side: decision.side,
          strategyId: "PORTFOLIO_COMBINED",
          strategyCombination: decision.strategyCombination,
          strategyContributions: selectedContributions,
          quantFactorScores: decision.quantFactorScores,
          quantFactorWeights: decision.quantFactorWeights,
          quantRegime: decision.quantIntelligence && decision.quantIntelligence.regime.regime,
          institutionalPortfolioHealth: decision.institutionalQuant && decision.institutionalQuant.portfolioHealth,
          institutionalExecutionPlan: decision.institutionalQuant && decision.institutionalQuant.executionPlan,
          ...simulated,
        };
        trade.institutionalTradeQuality = gradeTradeQuality(trade);
        grouped.PORTFOLIO_COMBINED.push(trade);
      }
      const v17 = portfolio.evaluateOpportunities(context);
      for (const opportunity of v17.opportunities) {
        const simulated = simulateExit({
          side: opportunity.side,
          expectedMovePct: opportunity.expectedMovePct,
          stopDistancePct: opportunity.stopDistancePct,
          preferredHoldingTimeSeconds: opportunity.preferredHoldingTimeSeconds,
        }, candles, index, config, notionalUsdt);
        const trade = {
          symbol,
          side: opportunity.side,
          strategyId: opportunity.strategyCombination,
          strategyCombination: opportunity.strategyCombination,
          quantFactorScores: opportunity.quantFactorScores,
          quantFactorWeights: opportunity.quantFactorWeights,
          quantRegime: opportunity.quantIntelligence && opportunity.quantIntelligence.regime.regime,
          institutionalPortfolioHealth: opportunity.institutionalQuant && opportunity.institutionalQuant.portfolioHealth,
          institutionalExecutionPlan: opportunity.institutionalQuant && opportunity.institutionalQuant.executionPlan,
          strategyContributions: [{
            strategyId: opportunity.strategyCombination,
            contributionPct: 100,
            selectedSideConfidence: opportunity.confidence,
            independentOpportunity: true,
          }],
          ...simulated,
        };
        trade.institutionalTradeQuality = gradeTradeQuality(trade);
        grouped.V17_ACTIVE_OPPORTUNITY.push(trade);
      }
      for (const skipped of v17.skipped) {
        if (skipped.shadowOpportunity) {
          const simulated = simulateExit({
            side: skipped.side,
            expectedMovePct: skipped.expectedMovePct,
            stopDistancePct: skipped.stopDistancePct,
            preferredHoldingTimeSeconds: skipped.preferredHoldingTimeSeconds,
          }, candles, index, config, notionalUsdt);
          shadowOpportunities.push({
            ...skipped.shadowOpportunity,
            ...simulated,
            wouldHaveWon: simulated.netPnlUsdt > 0,
            wouldHaveLost: simulated.netPnlUsdt < 0,
            maximumFavorableExcursionPct: simulated.maximumFavorableExcursionPct,
            maximumAdverseExcursionPct: simulated.maximumAdverseExcursionPct,
          });
        }
        for (const labShadow of skipped.strategyLaboratoryShadow || []) {
          if (!labShadow.wouldHaveEntered) continue;
          strategyLaboratoryShadowTrades.push({
            symbol,
            side: labShadow.direction,
            strategyId: labShadow.strategyId,
            strategyName: labShadow.strategyName,
            shadowOnly: true,
            liveOrderGenerated: false,
            ...simulateExit({
              side: labShadow.direction,
              expectedMovePct: labShadow.expectedMovePct,
              stopDistancePct: labShadow.stopDistancePct,
              preferredHoldingTimeSeconds: labShadow.expectedHoldingTimeSeconds,
            }, candles, index, config, notionalUsdt),
          });
        }
      }
      for (const strategyId of Object.keys(STRATEGY_EVALUATORS)) {
        const signal = evaluateIndependentStrategy(strategyId, config, symbol, item, analyses, item.spreadPct);
        if (!signal) continue;
        const trade = {
          symbol,
          side: signal.side,
          strategyId,
          ...simulateExit(signal, candles, index, config, notionalUsdt),
        };
        trade.institutionalTradeQuality = gradeTradeQuality(trade);
        grouped[strategyId].push(trade);
      }
    }
  }
  const results = Object.fromEntries(Object.entries(grouped).map(([key, trades]) => [key, summarizeTrades(trades)]));
  const quantFactorPerformance = Object.fromEntries(
    Object.entries(grouped).map(([key, trades]) => [key, summarizeFactorTrades(trades)])
  );
  const quantWalkForward = Object.fromEntries(
    Object.entries(grouped).map(([key, trades]) => [key, rollingWalkForwardFactorValidation(trades, numeric(config.v19WalkForwardWindowTrades, 50))])
  );
  const dashboard = strategyManager.dashboard({
    TREND_BREAKOUT: grouped.TREND_BREAKOUT,
    MULTI_TIMEFRAME_TREND: grouped.MULTI_TIMEFRAME_TREND,
    TREND_PULLBACK: grouped.TREND_PULLBACK,
  });
  return {
    generatedAt: new Date().toISOString(),
    symbols,
    assumptions: {
      notionalUsdt,
      estimatedFeePctPerSide: config.estimatedFeePctPerSide,
      estimatedSlippagePct: config.estimatedSlippagePct,
      noLiveOrders: true,
    },
    results,
    comparison: compareSummaries(results.V17_ACTIVE_OPPORTUNITY, results.PORTFOLIO_COMBINED),
    quantIntelligence: {
      factorPerformanceByMode: quantFactorPerformance,
      rollingWalkForwardByMode: quantWalkForward,
      objective: "attribute post-cost results to V19 factor scores without changing execution safety",
    },
    institutionalQuant: {
      walkForwardValidation: institutionalWalkForwardValidation(grouped.V17_ACTIVE_OPPORTUNITY, [30, 90, 180]),
      dailyReport: summarizeInstitutionalTrades(grouped.V17_ACTIVE_OPPORTUNITY),
      shadowMode: {
        opportunities: shadowOpportunities.length,
        wouldHaveWon: shadowOpportunities.filter((item) => item.wouldHaveWon).length,
        wouldHaveLost: shadowOpportunities.filter((item) => item.wouldHaveLost).length,
        averageMissedOpportunityScore: shadowOpportunities.length
          ? round(shadowOpportunities.reduce((sum, item) => sum + numeric(item.missedOpportunityScore), 0) / shadowOpportunities.length, 4)
          : 0,
      },
    },
    strategyLaboratoryShadow: {
      summary: summarizeLabTrades(strategyLaboratoryShadowTrades),
      byStrategy: Object.fromEntries(Object.entries(strategyLaboratoryShadowTrades.reduce((acc, trade) => {
        const key = trade.strategyId || "UNKNOWN";
        if (!acc[key]) acc[key] = [];
        acc[key].push(trade);
        return acc;
      }, {})).map(([key, trades]) => [key, summarizeLabTrades(trades)])),
    },
    dashboard,
    recommendedHighestCapitalAllocation: dashboard.recommendedHighestAllocation,
    trades: grouped,
    shadowOpportunities,
    strategyLaboratoryShadowTrades,
  };
}

module.exports = { runV15Backtest, summarizeTrades };
