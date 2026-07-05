"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { NO_POSITIVE_EXPECTANCY_MESSAGE, StrategyLaboratory } = require("../src/strategyLaboratory");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") args.input = argv[index + 1];
    if (token === "--output") args.output = argv[index + 1];
  }
  return args;
}

function emptyReport(output) {
  return {
    generatedAt: new Date().toISOString(),
    status: "NO_INPUT_DATA",
    noLiveOrders: true,
    message: "Provide --input path/to/candles.json to run V21 Strategy Laboratory. No live or demo orders are placed.",
    expectedFormat: {
      BTCUSDT: [{ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, turnover: 0 }],
      ETHUSDT: [],
      SOLUSDT: [],
    },
    output,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const output = args.output || path.join(config.reportsDir, "strategy-laboratory-v21.json");
  if (!args.input) {
    const report = emptyReport(output);
    writeJson(output, report);
    console.log(`V21 Strategy Laboratory ready. No input data supplied; wrote ${output}`);
    console.log(report.message);
    return;
  }
  const candlesBySymbol = readJson(args.input);
  const laboratory = new StrategyLaboratory(config, () => {});
  const report = laboratory.run(candlesBySymbol);
  writeJson(output, report);
  console.log(`V21 Strategy Laboratory completed. Wrote ${output}`);
  console.log(JSON.stringify({
    message: report.message,
    promotedStrategies: report.promotedStrategies.map((item) => ({
      rank: item.rank,
      strategyId: item.strategyId,
      strategyName: item.strategyName,
      netProfitUsdt: item.netProfitUsdt,
      profitFactor: item.profitFactor,
      tradeCount: item.tradeCount,
    })),
    rankings: report.rankings.map((item) => ({
      rank: item.rank,
      strategyId: item.strategyId,
      score: item.score,
      eligibleForLive: item.eligibleForLive,
      netProfitUsdt: item.netProfitUsdt,
      profitFactor: item.profitFactor,
      maximumDrawdownUsdt: item.maximumDrawdownUsdt,
      tradeCount: item.tradeCount,
    })),
  }, null, 2));
  if (!report.promotedStrategies.length) {
    console.log(NO_POSITIVE_EXPECTANCY_MESSAGE);
  }
}

main();
