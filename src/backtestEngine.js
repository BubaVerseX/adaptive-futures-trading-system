"use strict";

const { analyzeCandles, parseCandles } = require("./indicators");
const { PortfolioDecisionEngine } = require("./portfolioDecisionEngine");
const { evaluateTrendBreakout } = require("./strategies/trendBreakout");
const { evaluateMultiTimeframeTrend } = require("./strategies/multiTimeframeTrend");
const { evaluateTrendPullback } = require("./strategies/trendPullback");
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
  for (let cursor = index + 1; cursor < Math.min(candles.length, index + holdingBars + 1); cursor += 1) {
    const candle = candles[cursor];
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
    holdSeconds: Math.max(0, (Math.min(candles.length - 1, index + holdingBars) - index) * 15 * 60),
    grossPct: round(grossPct, 4),
    netReturnPct: round(netPct, 4),
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
  const notionalUsdt = numeric(options.notionalUsdt, 50);
  const symbols = Object.keys(candlesBySymbol || {});
  const grouped = {};
  for (const mode of ["PORTFOLIO_COMBINED", "V17_ACTIVE_OPPORTUNITY", ...Object.keys(STRATEGY_EVALUATORS)]) grouped[mode] = [];
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
      const decision = portfolio.evaluate(context);
      if (decision.eligible) {
        const selectedContributions = decision.strategyOutputs.map((output) => ({
          strategyId: output.strategyId,
          contributionPct: Math.round((output.weight || 0) * 10000) / 100,
          selectedSideConfidence: output.sideEvaluations[decision.side].confidence,
          oppositeSideConfidence: output.sideEvaluations[decision.side === "LONG" ? "SHORT" : "LONG"].confidence,
        }));
        grouped.PORTFOLIO_COMBINED.push({
          symbol,
          side: decision.side,
          strategyId: "PORTFOLIO_COMBINED",
          strategyCombination: decision.strategyCombination,
          strategyContributions: selectedContributions,
          ...simulateExit({
            side: decision.side,
            expectedMovePct: decision.expectedMovePct,
            stopDistancePct: decision.stopDistancePct,
            preferredHoldingTimeSeconds: decision.preferredHoldingTimeSeconds,
          }, candles, index, config, notionalUsdt),
        });
      }
      const v17 = portfolio.evaluateOpportunities(context);
      for (const opportunity of v17.opportunities) {
        grouped.V17_ACTIVE_OPPORTUNITY.push({
          symbol,
          side: opportunity.side,
          strategyId: opportunity.strategyCombination,
          strategyCombination: opportunity.strategyCombination,
          strategyContributions: [{
            strategyId: opportunity.strategyCombination,
            contributionPct: 100,
            selectedSideConfidence: opportunity.confidence,
            independentOpportunity: true,
          }],
          ...simulateExit({
            side: opportunity.side,
            expectedMovePct: opportunity.expectedMovePct,
            stopDistancePct: opportunity.stopDistancePct,
            preferredHoldingTimeSeconds: opportunity.preferredHoldingTimeSeconds,
          }, candles, index, config, notionalUsdt),
        });
      }
      for (const strategyId of Object.keys(STRATEGY_EVALUATORS)) {
        const signal = evaluateIndependentStrategy(strategyId, config, symbol, item, analyses, item.spreadPct);
        if (!signal) continue;
        grouped[strategyId].push({
          symbol,
          side: signal.side,
          strategyId,
          ...simulateExit(signal, candles, index, config, notionalUsdt),
        });
      }
    }
  }
  const results = Object.fromEntries(Object.entries(grouped).map(([key, trades]) => [key, summarizeTrades(trades)]));
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
    trades: grouped,
  };
}

module.exports = { runV15Backtest, summarizeTrades };
