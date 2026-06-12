"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const CONFIRMATION_PHRASE = "I ACCEPT PROFIT CONTROLLED LIVE RISK";

const REQUIRED_NON_SECRET_SETTINGS = Object.freeze({
  PROFIT_CONTROLLED_EQUITY_MODE: "true",
  BYBIT_DEMO_TRADING: "false",
  BYBIT_TESTNET: "false",
  DRY_RUN: "false",
  PROFIT_CONTROLLED_USE_EXCHANGE_EQUITY: "true",
  BYBIT_REST_BASE_URL: "https://api.bybit.com",
  BYBIT_PUBLIC_WS_BASE_URL: "wss://stream.bybit.com",
  BYBIT_PRIVATE_WS_BASE_URL: "wss://stream.bybit.com",
  BYBIT_WS_BASE_URL: "",
  MAX_TOTAL_OPEN_STOP_RISK_PCT: "2.25",
  MAX_CORRELATED_CLUSTER_STOP_RISK_PCT: "1.75",
  EXPLORATION_MAX_STOP_RISK_PCT: "0.25",
  NORMAL_MAX_STOP_RISK_PCT: "0.75",
  STRONG_MAX_STOP_RISK_PCT: "1.50",
  ELITE_MAX_STOP_RISK_PCT: "2.00",
  PROFIT_CONTROLLED_MAX_LEVERAGE: "5",
  PROFIT_CONTROLLED_EXPLORATION_MAX_LEVERAGE: "3",
  PROFIT_CONTROLLED_NORMAL_MAX_LEVERAGE: "4",
  PROFIT_EXPANSION_MODE: "true",
  PROFIT_MODE_MIN_QUALITY_SCORE: "70",
  PROFIT_MODE_STRONG_QUALITY_SCORE: "85",
  PROFIT_MODE_ELITE_QUALITY_SCORE: "95",
  PROFIT_MODE_MIN_REWARD_COST_RATIO: "1.85",
  PROFIT_MODE_MIN_NET_PROFIT_TO_COST_RATIO: "0.35",
  PROFESSIONAL_TREND_ENGINE_ENABLED: "true",
  MULTI_TIMEFRAME_TREND_ENGINE_ENABLED: "true",
  MACRO_OPPOSITE_REQUIRES_ELITE: "true",
  MTF_STRONG_ALIGNMENT_SCORE: "82",
  MTF_OPPOSITION_PENALTY_SCORE: "28",
  CONVICTION_THRESHOLD_TRENDING: "46",
  CONVICTION_THRESHOLD_BREAKOUT: "44",
  CONVICTION_THRESHOLD_SIDEWAYS_CHOP: "42",
  CONVICTION_THRESHOLD_VOLATILE: "45",
  CONVICTION_THRESHOLD_PANIC: "50",
  EXPECTANCY_OPTIMIZER_ENABLED: "true",
  EXPECTANCY_OPTIMIZER_WINDOW_TRADES: "50",
  EXPECTANCY_FEE_DRAG_TIGHTEN_RATIO: "0.65",
  EXPECTANCY_ENTRY_TIGHTENING_POINTS: "2",
  EXPECTANCY_CONTINUATION_BOOST_POINTS: "3",
  EXPECTANCY_RUNNER_EXTENSION_BOOST: "1.08",
  NEAR_MISS_LEARNING_ENABLED: "true",
  NEAR_MISS_MAX_POINT_GAP: "5",
  EDGE_MAXIMIZATION_MODE: "true",
  EDGE_REINFORCEMENT_MODE: "true",
  QUALITY_SIZE_MULTIPLIER_NORMAL: "1.0",
  QUALITY_SIZE_MULTIPLIER_STRONG: "1.2",
  QUALITY_SIZE_MULTIPLIER_ELITE: "1.5",
  SETUP_RANKING_BOOST_PROFIT_FACTOR: "1.3",
  SETUP_RANKING_REDUCE_PROFIT_FACTOR: "1.0",
  REGIME_MEMORY_BOOST_PROFIT_FACTOR: "1.3",
  REGIME_MEMORY_REDUCE_PROFIT_FACTOR: "1.0",
  SETUP_REGIME_MATRIX_BOOST_PROFIT_FACTOR: "1.3",
  SETUP_REGIME_MATRIX_REDUCE_PROFIT_FACTOR: "1.0",
  ASYMMETRIC_RUNNER_WEAK_TP1_PCT: "40",
  ASYMMETRIC_RUNNER_STRONG_TP1_PCT: "15",
  ASYMMETRIC_RUNNER_ELITE_TP1_PCT: "5",
  ASYMMETRIC_RUNNER_STRONG_TREND_SCORE: "82",
  ASYMMETRIC_RUNNER_ELITE_TREND_SCORE: "92",
  EXPECTANCY_AUTO_TUNING_WINDOW_TRADES: "100",
  EXPECTANCY_AUTO_TUNING_MAX_ADJUSTMENT_PCT: "5",
  EXPECTANCY_AUTO_TUNING_TIGHTEN_PROFIT_FACTOR: "1.0",
  EXPECTANCY_AUTO_TUNING_RELAX_PROFIT_FACTOR: "1.3",
  ADAPTIVE_EDGE_ACTIVITY_RECOVERY_MODE: "true",
  ADAPTIVE_EDGE_ACTIVITY_RECOVERY_WINDOW_MINUTES: "240",
  ADAPTIVE_EDGE_ACTIVITY_RECOVERY_TARGET_TRADES: "2",
  ADAPTIVE_EDGE_ACTIVITY_RECOVERY_MAX_RELAX_PCT: "3",
  ADAPTIVE_EDGE_ACTIVITY_RECOVERY_MIN_PROFIT_FACTOR: "1.0",
  ADAPTIVE_EDGE_ACTIVITY_RECOVERY_MAX_FEE_DRAG_RATIO: "0.65",
  TREND_DOMINANCE_MODE: "true",
  AGGRESSIVE_ADAPTIVE_MODE: "true",
  INACTIVITY_RECOVERY_MODE: "true",
  INACTIVITY_RECOVERY_4H_CONVICTION_RELAX_PCT: "2",
  INACTIVITY_RECOVERY_8H_CONVICTION_RELAX_PCT: "4",
  INACTIVITY_RECOVERY_12H_CONVICTION_RELAX_PCT: "6",
  AGGRESSIVE_ADAPTIVE_NORMAL_STOP_RISK_PCT: "0.75",
  AGGRESSIVE_ADAPTIVE_STRONG_STOP_RISK_PCT: "1.50",
  AGGRESSIVE_ADAPTIVE_ELITE_STOP_RISK_PCT: "2.00",
  TREND_DOMINANCE_STRONG_SCORE: "82",
  TREND_DOMINANCE_ELITE_SCORE: "92",
  TREND_DOMINANCE_ACTIVITY_BOOST_PCT: "5",
  TREND_DOMINANCE_SCORE_BOOST: "3",
  TREND_DOMINANCE_ETH_BTC_FOCUS_BOOST: "4",
  TREND_DOMINANCE_ETH_WEIGHT_MULTIPLIER: "1.40",
  TREND_DOMINANCE_BTC_WEIGHT_MULTIPLIER: "1.25",
  TREND_DOMINANCE_SOL_WEAK_BREAKOUT_MULTIPLIER: "0.82",
  TREND_DOMINANCE_SOL_WEAK_BREAKOUT_PENALTY: "4",
  TREND_DOMINANCE_STRONG_SIZING_MULTIPLIER: "1.18",
  TREND_DOMINANCE_ELITE_SIZING_MULTIPLIER: "1.25",
  TREND_DOMINANCE_RUNNER_EXTENSION_BOOST: "1.12",
  TRADE_CLUSTER_WINDOW_MINUTES: "45",
  TRADE_CLUSTER_MAX_SIZE_REDUCTION_PCT: "20",
  TRADE_FREQUENCY_RECOVERY_MODE: "true",
  TRADE_FREQUENCY_RECOVERY_MIN_SIGNAL_SCORE: "42",
  TRADE_FREQUENCY_RECOVERY_MIN_CONVICTION_SCORE: "45",
  MIN_SIGNAL_SCORE: "42",
  MIN_CONVICTION_SCORE: "45",
  ANTI_CHOP_PENALTY_MAX: "10",
  ANTI_CHOP_CONVICTION_PENALTY_MAX: "10",
  VOLUME_SURVIVABILITY_RELAXATION_MULTIPLIER: "0.80",
  WINNER_AMPLIFIER_ENABLED: "true",
  WINNER_AMPLIFIER_PARTIAL_TAKE_PROFIT_PCT: "30",
  RUNNER_BREAKEVEN_COST_CUSHION_PCT: "0.08",
  RUNNER_ATR_TRAILING_MULTIPLIER: "1.05",
  RUNNER_TREND_EXTENSION_MULTIPLIER: "1.35",
  LEARNING_PHASE_MODE: "false",
  EXPLORATION_MODE_ENABLED: "false",
  EXPLORATION_TRADE_RATIO: "0",
  FORCED_MARKET_SAMPLING_ENABLED: "false",
  FORCED_EXECUTION_SAMPLING_ACTIVE: "false",
  FOMO_BREAKOUT_MODE: "false",
  MICRO_BREAKOUT_ENTRIES: "false",
  UNCONFIRMED_MICRO_BREAKOUT_ENTRIES: "false",
  ALLOW_CHOPPY_MARKET: "false",
  ALLOW_CHOPPY_MARKET_UNCONDITIONALLY: "false",
  UNLIMITED_EXPLORATION_BUDGET: "false",
  AGGRESSIVE_LEARNING_PHASE: "false",
  DAILY_TRADE_LIMITS_DISABLED: "true",
  ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK: "true",
  ACKNOWLEDGE_LIVE_TRADING: "true",
  ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
});

function parseEnv(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function hasValue(value) {
  return value !== undefined && String(value).trim() !== "";
}

function backupPath(envPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(path.dirname(envPath), `.env.backup-profit-controlled-${stamp}`);
}

function updateEnvContent(content, updates) {
  const seen = new Set();
  const lines = content.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(=.*)$/);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[2])) return line;
    seen.add(match[2]);
    return `${match[1]}${match[2]}=${updates[match[2]]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function ensureGitignored(projectRoot) {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const needed = [".env", ".env.backup-*"];
  const missing = needed.filter((entry) => !existing.split(/\r?\n/).some((line) => line.trim() === entry));
  if (!missing.length) return;
  fs.appendFileSync(gitignorePath, `${existing.endsWith("\n") || !existing ? "" : "\n"}${missing.join("\n")}\n`, "utf8");
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const projectRoot = process.cwd();
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(".env was not found. Create it first and add BYBIT_API_KEY plus BYBIT_API_SECRET.");
  }
  const original = fs.readFileSync(envPath, "utf8");
  const values = parseEnv(original);
  if (!hasValue(values.BYBIT_API_KEY) || !hasValue(values.BYBIT_API_SECRET)) {
    throw new Error("BYBIT_API_KEY and BYBIT_API_SECRET must already exist in .env. Values were not printed.");
  }

  console.log("Profit-controlled live setup will use real Bybit mainnet trading after you launch it.");
  console.log("API key and secret are present, but their values were not printed.");
  console.log("This mode uses real funds and does not guarantee profit.");
  console.log(`To set live-risk acknowledgement flags, type exactly: ${CONFIRMATION_PHRASE}`);
  const answer = await ask("Confirmation phrase: ");
  if (answer !== CONFIRMATION_PHRASE) {
    throw new Error("Confirmation phrase did not match. .env was not changed.");
  }

  ensureGitignored(projectRoot);
  const backup = backupPath(envPath);
  fs.copyFileSync(envPath, backup);
  const updated = updateEnvContent(original, REQUIRED_NON_SECRET_SETTINGS);
  fs.writeFileSync(envPath, updated, "utf8");
  console.log("Profit-controlled non-secret settings were written.");
  console.log(`A timestamped .env backup was created at ${path.basename(backup)}.`);
  console.log("No bot was started. Review .env before running npm run live:profit-controlled.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION_PHRASE,
  REQUIRED_NON_SECRET_SETTINGS,
  parseEnv,
  updateEnvContent,
};
