"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { runV15Backtest } = require("../src/backtestEngine");

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

function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const output = args.output || path.join(config.reportsDir, "v15-backtest.json");
  if (!args.input) {
    const empty = {
      generatedAt: new Date().toISOString(),
      status: "NO_INPUT_DATA",
      message: "Provide --input path/to/candles.json to evaluate V15 strategies offline. No live or demo orders are placed.",
      expectedFormat: {
        BTCUSDT: [{ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, turnover: 0 }],
        ETHUSDT: [],
        SOLUSDT: [],
      },
    };
    writeJson(output, empty);
    console.log(`V15 backtest framework ready. No input data supplied; wrote ${output}`);
    return;
  }
  const candlesBySymbol = readJson(args.input);
  const report = runV15Backtest(config, candlesBySymbol);
  writeJson(output, report);
  console.log(`V15 backtest completed. Wrote ${output}`);
  console.log(JSON.stringify(report.results, null, 2));
  if (report.quantIntelligence) {
    console.log("V19 factor performance:");
    console.log(JSON.stringify(report.quantIntelligence.factorPerformanceByMode, null, 2));
  }
  if (report.institutionalQuant) {
    console.log("V20 institutional validation:");
    console.log(JSON.stringify({
      walkForwardValidation: report.institutionalQuant.walkForwardValidation,
      dailyReport: report.institutionalQuant.dailyReport,
      shadowMode: report.institutionalQuant.shadowMode,
    }, null, 2));
  }
  if (report.recommendedHighestCapitalAllocation) {
    console.log("V18 recommended highest allocation:");
    console.log(JSON.stringify(report.recommendedHighestCapitalAllocation, null, 2));
  }
}

main();
