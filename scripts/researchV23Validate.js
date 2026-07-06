"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const {
  EventDrivenBacktester,
  HistoricalDataEngine,
  PromotionOptimizer,
  V23_CANDIDATE_STRATEGIES,
  createResearchStrategies,
  splitCandles,
  summarizeResearchTrades,
} = require("../src/research");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

function parseArgs(argv) {
  const args = { download: true };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--output") args.output = argv[index + 1];
    if (token === "--no-download") args.download = false;
    if (token === "--download") args.download = true;
  }
  return args;
}

function flattenCoverageFailures(coverage = {}) {
  const failures = [];
  for (const [symbol, byInterval] of Object.entries(coverage)) {
    for (const [interval, item] of Object.entries(byInterval)) {
      if (!item.hasRequiredCoverage) {
        failures.push({
          symbol,
          interval,
          candleCount: item.candleCount,
          expectedCandles: item.expectedCandles,
          coverageDays: item.coverageDays,
        });
      }
    }
  }
  return failures;
}

function intervalInput(candlesBySymbol = {}, interval, symbols = []) {
  return Object.fromEntries(symbols.map((symbol) => [
    symbol,
    { [interval]: candlesBySymbol[symbol] && candlesBySymbol[symbol][interval] ? candlesBySymbol[symbol][interval] : [] },
  ]));
}

function promotionSummary(report = {}) {
  const promotion = report.v23PromotionOptimization || report;
  if (!promotion) return null;
  return {
    message: promotion.message,
    promotedStrategy: promotion.promotedStrategy,
    liveProfileGenerated: Boolean(promotion.liveProfile),
    strategyResults: Object.fromEntries(Object.entries(promotion.strategyResults || {}).map(([id, item]) => [id, {
      original: item.original,
      optimized: item.optimized,
      difference: item.difference,
      promotionEligible: item.promotionEligible,
      promotionBlockedReasons: item.promotionBlockedReasons,
      metricRealism: item.metricRealism,
    }])),
  };
}

function mergeTrades(results = []) {
  return results.flatMap((result) => result.trades || []).sort((left, right) => Date.parse(left.exitedAt) - Date.parse(right.exitedAt));
}

function candlesFor(symbolCandles = {}, symbol, interval) {
  return symbolCandles[symbol] && symbolCandles[symbol][interval] ? symbolCandles[symbol][interval] : [];
}

function runStrategyDefaultValidation(config, strategies, candlesBySymbol, interval, symbols, { fullOutOfSample = true } = {}) {
  const backtester = new EventDrivenBacktester(config);
  const strategyReports = {};
  const rankings = [];
  for (const strategy of strategies) {
    const params = strategy.defaultParams || {};
    const fullResults = [];
    const trainingResults = [];
    const validationResults = [];
    const testResults = [];
    const bySymbol = {};
    for (const symbol of symbols) {
      const candles = candlesFor(candlesBySymbol, symbol, interval);
      const full = backtester.run({ symbol, candles, strategy, params });
      fullResults.push(full);
      bySymbol[symbol] = summarizeResearchTrades(full.trades);
      if (fullOutOfSample) {
        const split = splitCandles(candles, config.v22TrainPct, config.v22ValidationPct);
        trainingResults.push(backtester.run({ symbol, candles: split.training, strategy, params }));
        validationResults.push(backtester.run({ symbol, candles: split.validation, strategy, params }));
        testResults.push(backtester.run({ symbol, candles: split.test, strategy, params }));
      }
    }
    const trades = mergeTrades(fullResults);
    const aggregate = summarizeResearchTrades(trades);
    const training = fullOutOfSample ? summarizeResearchTrades(mergeTrades(trainingResults)) : {};
    const validation = fullOutOfSample ? summarizeResearchTrades(mergeTrades(validationResults)) : {};
    const test = fullOutOfSample ? summarizeResearchTrades(mergeTrades(testResults)) : {};
    const keptOutOfSample = fullOutOfSample && training.netProfitUsdt > 0 && validation.netProfitUsdt > 0 && test.netProfitUsdt > 0;
    const report = {
      strategyId: strategy.strategyId,
      strategyName: strategy.name,
      fixedEntryParams: true,
      selectedParams: params,
      optimization: {
        fixedExistingEntryLogic: true,
        keptOutOfSample,
        training,
        validation,
        test,
        evaluatedParameterSets: [{
          params,
          training,
          validation,
          test,
          keptOutOfSample,
        }],
      },
      aggregate,
      bySymbol,
      tradesGenerated: aggregate.tradeCount,
    };
    strategyReports[strategy.strategyId] = report;
    rankings.push({
      strategyId: strategy.strategyId,
      strategyName: strategy.name,
      selectedParams: params,
      outOfSampleValidated: keptOutOfSample,
      ...aggregate,
    });
  }
  rankings.sort((left, right) => Number(right.netProfitUsdt || 0) - Number(left.netProfitUsdt || 0));
  return {
    strategyReports,
    rankings: rankings.map((item, index) => ({ rank: index + 1, ...item })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = {
    ...loadConfig(),
    v22ResearchPlatformMode: true,
    v23PromotionOptimizationMode: true,
    v231ResearchValidationMode: true,
    v23RejectImpossibleMetrics: true,
  };
  const output = args.output || config.v231ValidationReportFile;
  const symbols = config.focusedTradingSymbolsList;
  const intervals = config.v231RequiredIntervals;
  const engine = new HistoricalDataEngine({
    cacheDir: config.v22ResearchCacheDir,
    restBaseUrl: config.v231ResearchRestBaseUrl,
    category: config.category,
  });
  const candlesBySymbol = await engine.ensureHistoricalData({
    symbols,
    intervals,
    download: args.download,
    minimumDays: config.v231MinimumHistoryDays,
    maxPages: config.v231MaxDownloadPages,
  });
  const coverage = engine.coverageReport(candlesBySymbol, {
    symbols,
    intervals,
    minimumDays: config.v231MinimumHistoryDays,
  });
  const coverageFailures = flattenCoverageFailures(coverage);
  if (coverageFailures.length) {
    const report = {
      generatedAt: new Date().toISOString(),
      status: "INSUFFICIENT_REAL_DATA",
      noLiveOrders: true,
      liveExecutionEngineTouched: false,
      realDownloadedDataRequired: true,
      minimumHistoryDays: config.v231MinimumHistoryDays,
      requiredIntervals: intervals,
      symbols,
      coverage,
      coverageFailures,
      message: "V23.1 validation refused to run promotion because one or more required real OHLCV datasets do not cover at least one year.",
    };
    writeJson(output, report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const primaryInterval = intervals.includes(config.v231PrimaryInterval) ? config.v231PrimaryInterval : (intervals[0] || "15m");
  const intervalReports = {};
  const strategies = createResearchStrategies().filter((strategy) => V23_CANDIDATE_STRATEGIES.includes(strategy.strategyId));
  for (const interval of intervals) {
    if (interval !== primaryInterval) {
      intervalReports[interval] = {
        interval,
        supportingIntervalCoverageOnly: true,
        rankings: [],
        v23PromotionOptimization: null,
        message: "Real OHLCV coverage verified for supporting interval; promotion validation runs on the primary interval.",
      };
      continue;
    }
    const intervalConfig = {
      ...config,
      v23PromotionOptimizationMode: interval === primaryInterval,
    };
    const validation = runStrategyDefaultValidation(intervalConfig, strategies, candlesBySymbol, interval, symbols, {
      fullOutOfSample: interval === primaryInterval,
    });
    const v23PromotionOptimization = interval === primaryInterval
      ? new PromotionOptimizer(intervalConfig, () => {}, strategies).run(intervalInput(candlesBySymbol, interval, symbols), validation.strategyReports, { interval, symbols })
      : null;
    intervalReports[interval] = {
      interval,
      strategyReports: validation.strategyReports,
      rankings: validation.rankings,
      v23PromotionOptimization,
      message: v23PromotionOptimization
        ? v23PromotionOptimization.message
        : "Real-data fixed-entry validation completed for interval.",
    };
  }
  const primary = intervalReports[primaryInterval];
  const validationReport = {
    generatedAt: new Date().toISOString(),
    status: "COMPLETED",
    noLiveOrders: true,
    liveExecutionEngineTouched: false,
    realDownloadedDataOnly: true,
    minimumHistoryDays: config.v231MinimumHistoryDays,
    requiredIntervals: intervals,
    primaryInterval,
    symbols,
    coverage,
    verification: {
      tradesGenerated: Object.fromEntries(Object.entries(intervalReports).map(([interval, report]) => [
        interval,
        report.rankings.reduce((sum, item) => sum + Number(item.tradeCount || 0), 0),
      ])),
      feesIncluded: true,
      slippageIncluded: true,
      drawdownCalculatedFromEquityCurve: true,
      impossibleMetricProfilesRejected: true,
      maxAllowedProfitFactor: config.v231MaxRealisticProfitFactor,
    },
    intervalSummaries: Object.fromEntries(Object.entries(intervalReports).map(([interval, report]) => [interval, {
      message: report.message,
      rankings: report.rankings.map((item) => ({
        rank: item.rank,
        strategyId: item.strategyId,
        netProfitUsdt: item.netProfitUsdt,
        profitFactor: item.profitFactor,
        maximumDrawdownUsdt: item.maximumDrawdownUsdt,
        tradeCount: item.tradeCount,
        feesPaidUsdt: item.feesPaidUsdt,
        losingTrades: item.losingTrades,
        outOfSampleValidated: item.outOfSampleValidated,
      })),
      v23Promotion: promotionSummary(report),
    }])),
    selectedPromotionReport: primary ? primary.v23PromotionOptimization : null,
    message: primary && primary.v23PromotionOptimization
      ? primary.v23PromotionOptimization.message
      : "V23.1 real-data validation completed without a promotion report.",
  };
  writeJson(output, validationReport);
  if (primary && primary.v23PromotionOptimization) {
    writeJson(config.v231PromotionReportFile, primary.v23PromotionOptimization);
    if (primary.v23PromotionOptimization.liveProfile) {
      writeJson(config.v231LiveProfileFile, primary.v23PromotionOptimization.liveProfile);
    } else {
      writeJson(config.v231LiveProfileFile, {
        generatedAt: new Date().toISOString(),
        status: "NOT_GENERATED",
        noLiveOrders: true,
        liveExecutionEngineTouched: false,
        message: "No LIVE_PROFILE_V23_REAL was generated because no strategy satisfied V23.1 real-data promotion constraints.",
      });
    }
  }
  console.log(JSON.stringify({
    status: validationReport.status,
    output,
    promotionReportFile: primary && primary.v23PromotionOptimization ? config.v231PromotionReportFile : null,
    liveProfileFile: primary && primary.v23PromotionOptimization && primary.v23PromotionOptimization.liveProfile ? config.v231LiveProfileFile : null,
    message: validationReport.message,
    tradesGenerated: validationReport.verification.tradesGenerated,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
