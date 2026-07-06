"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { analyzeCandles, parseCandles } = require("../indicators");
const { bounded, numeric, round } = require("../strategyUtils");
const { EventDrivenBacktester, candleTime, summarizeResearchTrades } = require("./eventBacktester");
const { RESEARCH_SYMBOLS } = require("./historicalDataEngine");
const { PromotionOptimizer } = require("./promotionOptimizer");
const { analysisContext, createResearchStrategies } = require("./strategyPlugins");

const RESEARCH_WINDOWS_DAYS = Object.freeze([30, 90, 180, 365, 730]);
const NO_RESEARCH_EDGE_MESSAGE = "No strategy currently demonstrates positive historical expectancy.";

function candlesForSymbol(candlesBySymbol = {}, symbol, interval = "1m") {
  const value = candlesBySymbol[symbol];
  if (Array.isArray(value)) return parseCandles(value);
  if (value && Array.isArray(value[interval])) return parseCandles(value[interval]);
  if (value && Array.isArray(value["1m"])) return parseCandles(value["1m"]);
  return [];
}

function latestCandleTime(candles = []) {
  if (!candles.length) return Date.now();
  return Math.max(...candles.map((candle, index) => candleTime(candle, index)).filter(Number.isFinite));
}

function windowCandles(candles = [], days) {
  const latest = latestCandleTime(candles);
  const cutoff = latest - days * 24 * 60 * 60 * 1000;
  const filtered = candles.filter((candle, index) => candleTime(candle, index) >= cutoff);
  return filtered.length >= 70 ? filtered : candles;
}

function splitCandles(candles = [], trainPct = 0.55, validationPct = 0.25) {
  const parsed = parseCandles(candles || []);
  const trainEnd = Math.max(70, Math.floor(parsed.length * bounded(trainPct, 0.2, 0.8)));
  const validationEnd = Math.max(trainEnd + 10, Math.floor(parsed.length * bounded(trainPct + validationPct, 0.35, 0.95)));
  const warmup = 70;
  return {
    training: parsed.slice(0, Math.min(parsed.length, trainEnd)),
    validation: parsed.slice(Math.max(0, trainEnd - warmup), Math.min(parsed.length, validationEnd)),
    test: parsed.slice(Math.max(0, validationEnd - warmup)),
  };
}

function mergeTrades(results = []) {
  return results.flatMap((result) => result.trades || []).sort((left, right) => Date.parse(left.exitedAt) - Date.parse(right.exitedAt));
}

function performanceScore(metrics = {}) {
  const pf = numeric(metrics.profitFactor);
  const expectancy = numeric(metrics.expectancyUsdt);
  const net = numeric(metrics.netProfitUsdt);
  const drawdownPenalty = Math.min(30, numeric(metrics.maximumDrawdownUsdt) * 2.5);
  const tradePenalty = numeric(metrics.tradeCount) > 0 ? 0 : 25;
  return round(bounded(30 + Math.min(45, pf * 18) + expectancy * 18 + net * 1.8 - drawdownPenalty - tradePenalty, 0, 100), 4);
}

function eligibilityFromMetrics(config = {}, metrics = {}) {
  const minProfitFactor = numeric(config.v22MinProfitFactor, 1.2);
  const maxDrawdownUsdt = numeric(config.v22MaxDrawdownUsdt, 8);
  const minTradeCount = numeric(config.v22MinTradeCount, 12);
  const reasons = [];
  if (numeric(metrics.netProfitUsdt) <= 0) reasons.push("net profit is not positive");
  if (numeric(metrics.profitFactor) <= minProfitFactor) reasons.push(`profit factor ${metrics.profitFactor} <= ${minProfitFactor}`);
  if (numeric(metrics.maximumDrawdownUsdt) > maxDrawdownUsdt) reasons.push(`drawdown ${metrics.maximumDrawdownUsdt} > ${maxDrawdownUsdt}`);
  if (numeric(metrics.tradeCount) < minTradeCount) reasons.push(`trade count ${metrics.tradeCount} < ${minTradeCount}`);
  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function groupSummary(trades = [], keyFn) {
  const groups = {};
  for (const trade of trades) {
    const key = keyFn(trade) || "UNKNOWN";
    if (!groups[key]) groups[key] = [];
    groups[key].push(trade);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, bucket]) => [key, summarizeResearchTrades(bucket)]));
}

function parameterHeatmap(items = []) {
  const buckets = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item.params || {})) {
      const bucketKey = `${key}=${value}`;
      if (!buckets[bucketKey]) buckets[bucketKey] = [];
      buckets[bucketKey].push(item.validationScore);
    }
  }
  return Object.fromEntries(Object.entries(buckets).map(([key, values]) => [
    key,
    round(values.reduce((sum, value) => sum + numeric(value), 0) / Math.max(1, values.length), 4),
  ]));
}

function equityCurve(trades = []) {
  let equity = 0;
  let peak = 0;
  return trades.map((trade) => {
    equity += numeric(trade.netPnlUsdt);
    peak = Math.max(peak, equity);
    return {
      time: trade.exitedAt,
      equity: round(equity, 6),
      drawdown: round(peak - equity, 6),
    };
  });
}

class ResearchPlatform {
  constructor(config = {}, log = () => {}, strategies = createResearchStrategies()) {
    this.config = config;
    this.log = log;
    this.strategies = strategies;
    this.backtester = new EventDrivenBacktester(config);
  }

  evaluateParameterSet(strategy, params, symbolCandles) {
    const trainResults = [];
    const validationResults = [];
    const testResults = [];
    for (const [symbol, candles] of Object.entries(symbolCandles)) {
      const split = splitCandles(candles, numeric(this.config.v22TrainPct, 0.55), numeric(this.config.v22ValidationPct, 0.25));
      trainResults.push(this.backtester.run({ symbol, candles: split.training, strategy, params }));
      validationResults.push(this.backtester.run({ symbol, candles: split.validation, strategy, params }));
      testResults.push(this.backtester.run({ symbol, candles: split.test, strategy, params }));
    }
    const trainingTrades = mergeTrades(trainResults);
    const validationTrades = mergeTrades(validationResults);
    const testTrades = mergeTrades(testResults);
    const training = summarizeResearchTrades(trainingTrades);
    const validation = summarizeResearchTrades(validationTrades);
    const test = summarizeResearchTrades(testTrades);
    return {
      params,
      training,
      validation,
      test,
      validationScore: performanceScore(validation),
      testScore: performanceScore(test),
      keptOutOfSample: numeric(training.netProfitUsdt) > 0 && numeric(validation.netProfitUsdt) > 0,
    };
  }

  selectParameters(strategy, symbolCandles) {
    const evaluated = strategy.parameterSets().map((params) => this.evaluateParameterSet(strategy, params, symbolCandles));
    const sorted = evaluated
      .slice()
      .sort((left, right) => (right.keptOutOfSample ? 20 : 0) + right.validationScore + right.testScore * 0.35 - ((left.keptOutOfSample ? 20 : 0) + left.validationScore + left.testScore * 0.35));
    return {
      selected: sorted[0] || { params: strategy.defaultParams || {}, validationScore: 0, testScore: 0, keptOutOfSample: false },
      evaluated,
      heatmap: parameterHeatmap(evaluated),
    };
  }

  runStrategy(strategy, symbolCandles, params) {
    const bySymbolTrades = {};
    const allTrades = [];
    for (const [symbol, candles] of Object.entries(symbolCandles)) {
      const result = this.backtester.run({ symbol, candles, strategy, params });
      bySymbolTrades[symbol] = result.trades;
      allTrades.push(...result.trades);
    }
    allTrades.sort((left, right) => Date.parse(left.exitedAt) - Date.parse(right.exitedAt));
    const windows = {};
    for (const days of RESEARCH_WINDOWS_DAYS) {
      const windowTrades = [];
      for (const [symbol, candles] of Object.entries(symbolCandles)) {
        windowTrades.push(...this.backtester.run({ symbol, candles: windowCandles(candles, days), strategy, params }).trades);
      }
      windows[`${days}d`] = summarizeResearchTrades(windowTrades);
    }
    return {
      trades: allTrades,
      bySymbolTrades,
      aggregate: summarizeResearchTrades(allTrades),
      windows,
    };
  }

  run(candlesBySymbol = {}, options = {}) {
    const interval = options.interval || "1m";
    const symbols = (options.symbols || RESEARCH_SYMBOLS).filter((symbol) => candlesForSymbol(candlesBySymbol, symbol, interval).length >= 70);
    const symbolCandles = Object.fromEntries(symbols.map((symbol) => [symbol, candlesForSymbol(candlesBySymbol, symbol, interval)]));
    const strategyReports = {};
    const rankingItems = [];
    let allTrades = [];
    for (const strategy of this.strategies) {
      const optimization = this.selectParameters(strategy, symbolCandles);
      const run = this.runStrategy(strategy, symbolCandles, optimization.selected.params);
      allTrades = allTrades.concat(run.trades);
      const eligibility = eligibilityFromMetrics(this.config, run.aggregate);
      const rankItem = {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        score: performanceScore(run.aggregate),
        eligibleForLive: eligibility.eligible,
        promotionBlockedReasons: eligibility.reasons,
        selectedParams: optimization.selected.params,
        outOfSampleValidated: optimization.selected.keptOutOfSample,
        ...run.aggregate,
      };
      rankingItems.push(rankItem);
      strategyReports[strategy.strategyId] = {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        pluginInterface: ["generateEntry", "generateExit", "positionSizing"],
        selectedParams: optimization.selected.params,
        optimization: {
          bestValidationScore: optimization.selected.validationScore,
          bestTestScore: optimization.selected.testScore,
          keptOutOfSample: optimization.selected.keptOutOfSample,
          parameterHeatmap: optimization.heatmap,
          evaluatedParameterSets: optimization.evaluated.map((item) => ({
            params: item.params,
            training: item.training,
            validation: item.validation,
            test: item.test,
            validationScore: item.validationScore,
            testScore: item.testScore,
            keptOutOfSample: item.keptOutOfSample,
          })),
        },
        aggregate: run.aggregate,
        windows: run.windows,
        bySymbol: Object.fromEntries(Object.entries(run.bySymbolTrades).map(([symbol, trades]) => [symbol, summarizeResearchTrades(trades)])),
        tradeDistribution: groupSummary(run.trades, (trade) => trade.symbol),
        strengths: [
          "Evaluated with next-candle execution",
          "Post-cost metrics include fees and slippage",
          optimization.selected.keptOutOfSample ? "Selected parameters improved validation data" : "Needs better out-of-sample proof",
        ],
        weaknesses: eligibility.reasons,
        eligibleForLive: eligibility.eligible,
        promotionBlockedReasons: eligibility.reasons,
      };
    }
    const rankings = rankingItems.sort((left, right) => right.score - left.score).map((item, index) => ({ rank: index + 1, ...item }));
    const promotedStrategies = rankings.filter((item) => item.eligibleForLive);
    const v23PromotionOptimization = this.config.v23PromotionOptimizationMode
      ? new PromotionOptimizer(this.config, this.log, this.strategies).run(candlesBySymbol, strategyReports, { interval, symbols })
      : null;
    const curve = equityCurve(allTrades.sort((left, right) => Date.parse(left.exitedAt) - Date.parse(right.exitedAt)));
    const dashboard = {
      bestStrategy: rankings[0] || null,
      worstStrategy: rankings[rankings.length - 1] || null,
      currentLeaderboard: rankings.map((item) => ({
        rank: item.rank,
        strategyId: item.strategyId,
        strategyName: item.strategyName,
        netProfitUsdt: item.netProfitUsdt,
        maximumDrawdownUsdt: item.maximumDrawdownUsdt,
        sharpeRatio: item.sharpeRatio,
        trades: item.tradeCount,
        expectancyUsdt: item.expectancyUsdt,
        eligibleForLive: item.eligibleForLive,
      })),
      parameterHeatmaps: Object.fromEntries(Object.entries(strategyReports).map(([id, report]) => [id, report.optimization.parameterHeatmap])),
      tradeDistribution: groupSummary(allTrades, (trade) => `${trade.strategyId}:${trade.symbol}`),
      equityCurve: curve,
      drawdownCurve: curve.map((point) => ({ time: point.time, drawdown: point.drawdown })),
    };
    const report = {
      generatedAt: new Date().toISOString(),
      objective: "V22 Quant Research Platform: statistically prove strategies before live eligibility",
      noLiveOrders: true,
      liveExecutionEngineTouched: false,
      symbols,
      interval,
      windowsDays: RESEARCH_WINDOWS_DAYS,
      thresholds: {
        minProfitFactor: numeric(this.config.v22MinProfitFactor, 1.2),
        positiveNetProfitRequired: true,
        maxDrawdownUsdt: numeric(this.config.v22MaxDrawdownUsdt, 8),
        minTradeCount: numeric(this.config.v22MinTradeCount, 12),
      },
      strategies: strategyReports,
      rankings,
      promotedStrategies,
      recommendedLiveStrategy: promotedStrategies[0] || null,
      dashboard,
      v23PromotionOptimization,
      message: promotedStrategies.length
        ? `Promote ${promotedStrategies[0].strategyName} first; it ranked #${promotedStrategies[0].rank}.`
        : v23PromotionOptimization && v23PromotionOptimization.liveProfile
          ? v23PromotionOptimization.message
        : NO_RESEARCH_EDGE_MESSAGE,
    };
    this.log("INFO", "V22_QUANT_RESEARCH_PLATFORM_COMPLETED", {
      strategies: this.strategies.length,
      symbols,
      promotedStrategies: promotedStrategies.map((item) => item.strategyId),
      message: report.message,
    });
    return report;
  }

  shadowEvaluate(context = {}) {
    const candles = parseCandles(context.candles || context.entryCandles || []);
    if (candles.length < 30) return [];
    const index = candles.length - 1;
    const ctx = {
      ...analysisContext(candles, index),
      symbol: context.symbol,
      index,
      config: this.config,
      analysis: context.analysis || analyzeCandles(candles, 55),
      price: numeric(context.price, candles[index].close),
    };
    return this.strategies.map((strategy) => {
      const signal = strategy.generateEntry(ctx, strategy.defaultParams);
      return signal ? {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        direction: signal.direction,
        confidence: signal.confidence,
        expectedRewardRisk: signal.expectedRewardRisk,
        expectedHoldingTimeSeconds: signal.expectedHoldingTimeSeconds,
        shadowOnly: true,
        liveOrderGenerated: false,
        trackingStatus: "PENDING_FUTURE_OUTCOME",
      } : {
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
        shadowOnly: true,
        liveOrderGenerated: false,
        trackingStatus: "NO_SIGNAL",
      };
    });
  }

  writeReport(report, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return file;
  }
}

module.exports = {
  NO_RESEARCH_EDGE_MESSAGE,
  RESEARCH_WINDOWS_DAYS,
  ResearchPlatform,
  candlesForSymbol,
  eligibilityFromMetrics,
  splitCandles,
};
