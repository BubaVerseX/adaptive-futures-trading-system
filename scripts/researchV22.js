"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { HistoricalDataEngine, NO_RESEARCH_EDGE_MESSAGE, ResearchPlatform } = require("../src/research");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

function parseArgs(argv) {
  const args = { download: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") args.input = argv[index + 1];
    if (token === "--output") args.output = argv[index + 1];
    if (token === "--interval") args.interval = argv[index + 1];
    if (token === "--download") args.download = true;
  }
  return args;
}

function emptyReport(output) {
  return {
    generatedAt: new Date().toISOString(),
    status: "NO_INPUT_DATA",
    noLiveOrders: true,
    liveExecutionEngineTouched: false,
    message: "Provide --input path/to/candles.json or pass --download to use cached/downloaded public OHLCV. No live or demo orders are placed.",
    expectedFormat: {
      BTCUSDT: [{ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, turnover: 0 }],
      ETHUSDT: [],
      SOLUSDT: [],
    },
    output,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const output = args.output || config.v22ResearchReportFile || path.join(config.reportsDir, "research-v22.json");
  let candlesBySymbol = null;
  if (args.input) {
    candlesBySymbol = readJson(args.input);
  } else if (args.download) {
    const data = new HistoricalDataEngine({
      cacheDir: config.v22ResearchCacheDir,
      restBaseUrl: config.restBaseUrl,
      category: config.category,
    });
    candlesBySymbol = await data.ensureHistoricalData({
      symbols: config.focusedTradingSymbolsList,
      intervals: [args.interval || config.v22ResearchPrimaryInterval || "1m"],
      download: true,
    });
  }
  if (!candlesBySymbol) {
    const report = emptyReport(output);
    writeJson(output, report);
    console.log(`V22 Quant Research Platform ready. No input data supplied; wrote ${output}`);
    console.log(report.message);
    return;
  }
  const platform = new ResearchPlatform(config, () => {});
  const report = platform.run(candlesBySymbol, { interval: args.interval || config.v22ResearchPrimaryInterval || "1m" });
  writeJson(output, report);
  if (report.v23PromotionOptimization) {
    writeJson(config.v23PromotionReportFile, report.v23PromotionOptimization);
    if (report.v23PromotionOptimization.liveProfile) {
      writeJson(config.v23LiveProfileFile, report.v23PromotionOptimization.liveProfile);
    }
  }
  console.log(`V22 Quant Research Platform completed. Wrote ${output}`);
  console.log(JSON.stringify({
    message: report.message,
    recommendedLiveStrategy: report.recommendedLiveStrategy
      ? {
          rank: report.recommendedLiveStrategy.rank,
          strategyId: report.recommendedLiveStrategy.strategyId,
          strategyName: report.recommendedLiveStrategy.strategyName,
          netProfitUsdt: report.recommendedLiveStrategy.netProfitUsdt,
          profitFactor: report.recommendedLiveStrategy.profitFactor,
          tradeCount: report.recommendedLiveStrategy.tradeCount,
        }
      : null,
    v23Promotion: report.v23PromotionOptimization
      ? {
          message: report.v23PromotionOptimization.message,
          promotedStrategy: report.v23PromotionOptimization.promotedStrategy,
          liveProfileFile: report.v23PromotionOptimization.liveProfile ? config.v23LiveProfileFile : null,
          promotionReportFile: config.v23PromotionReportFile,
        }
      : null,
    leaderboard: report.rankings.map((item) => ({
      rank: item.rank,
      strategyId: item.strategyId,
      score: item.score,
      eligibleForLive: item.eligibleForLive,
      netProfitUsdt: item.netProfitUsdt,
      profitFactor: item.profitFactor,
      maximumDrawdownUsdt: item.maximumDrawdownUsdt,
      tradeCount: item.tradeCount,
      outOfSampleValidated: item.outOfSampleValidated,
    })),
  }, null, 2));
  if (!report.promotedStrategies.length && !(report.v23PromotionOptimization && report.v23PromotionOptimization.liveProfile)) {
    console.log(NO_RESEARCH_EDGE_MESSAGE);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
