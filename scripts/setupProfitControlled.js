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
  NORMAL_MAX_STOP_RISK_PCT: "0.45",
  STRONG_MAX_STOP_RISK_PCT: "0.85",
  ELITE_MAX_STOP_RISK_PCT: "1.25",
  PROFIT_CONTROLLED_MAX_LEVERAGE: "5",
  PROFIT_CONTROLLED_EXPLORATION_MAX_LEVERAGE: "3",
  PROFIT_CONTROLLED_NORMAL_MAX_LEVERAGE: "4",
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
