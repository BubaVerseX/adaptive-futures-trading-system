"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("./constants.cjs");

// Starting guesses, not tuned values. `node pump/replay.cjs` measures them against
// recorded launches and writes better candidates to data/pump/best-params.json.
const DEFAULT_STRATEGY = {
  // Entry: confirmed momentum a little after launch, never the first-second snipe.
  entryMinAgeSec: 20,
  entryMaxAgeSec: 180,
  minRealSol: 6, // net SOL already in the curve (~40 SOL market cap)
  maxRealSol: 30, // ~110 SOL market cap; later than this the move is mostly done
  minInflow30: 2.5, // net SOL in over the last 30s
  minInflow15: 0.8, // still accelerating over the last 15s
  maxDrawdownFromPeakPct: 12,
  maxDevBuySol: 3,
  maxDevHoldPct: 100, // skip coins whose creator still holds more than this % of the supply (100 = off)
  allowDevSold: 0, // 1 = coins whose creator already sold out may be bought (nobody left to dump)
  maxTop1Pct: 10, // largest holder, excluding the curve itself
  maxTop10Pct: 35,
  // Exit
  stopLossPct: 15,
  tp1Pct: 35,
  tp1Fraction: 0.5,
  trailArmPct: 20,
  trailPct: 18,
  timeStopSec: 90,
  timeStopMinGainPct: 8,
  maxHoldSec: 420,
  outflowExitPct: 20, // real SOL in the curve fell this far from its peak since entry
  outflowGraceSec: 0, // ignore the outflow exit for this long after buying (stop-loss still applies)
  reentryCooldownSec: 0, // 0 = never buy the same coin twice; else allow one re-buy this long after selling
  exitProgress: 0.9, // sell before graduation to PumpSwap
  requireStandardCurve: 1, // 1 = only coins on pump.fun's standard curve (30 SOL / 1.073B virtual)
};

const DEFAULT_COSTS = {
  pumpFeePct: 1.25, // per side, bonding curve
  portalFeePct: 0.5, // per side, PumpPortal Local Transaction API
  priorityFeeSol: 0.0001, // per transaction
  buySlippagePct: 20,
  sellSlippagePct: 25,
  latencyMs: 1200, // paper: an order fills at the first poll at least this long after the decision
};

const DEFAULT_RISK = {
  maxOpenPositions: 20, // in practice: as many coins at once as the money allows
  maxTradeSol: 0.025, // base size; the strongest signals buy up to convictionMax times this
  minTradeSol: 0.01,
  tradeFractionOfFree: 0.4,
  reserveSol: 0.012, // kept back for token-account rent and transaction fees
  dailyLossLimitPct: 100, // 100 = off (keepPct is the stop); e.g. 40 halts buys until 00:00 UTC after -40%
  lossStreak: 3,
  lossStreakPauseMin: 0, // pause after lossStreak losses in a row, in minutes (0 = never pause)
  keepPct: 50, // no new buys once the account is below this % of its best value this run (0 = off)
  compound: 1, // 1 = the trade size limit grows with profits (and shrinks back if they are lost)
  convictionMax: 2, // strong buying pressure buys up to 2x the base size (1 = always the base size)
};

const DEFAULT_RUNTIME = {
  pollMs: 1500,
  slowEvery: 3, // tokens outside the entry window are polled every Nth tick
  watchSec: 360,
  watchSecActive: 630, // coins that reached holdersCheckMinRealSol: >= entryMaxAgeSec + maxHoldSec
  deadAfterSec: 60,
  deadBelowRealSol: 0.3,
  devTrackMinRealSol: 1,
  holdersCheckMinRealSol: 3,
  recordMinRealSol: 0.5,
  statusEverySec: 15,
};

// Repo root: stop files and the data folder live here no matter where the bot is started.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const envKey = (k) => "PUMP_" + k.replace(/[A-Z]/g, (m) => "_" + m).toUpperCase();

function applyEnv(defaults, env) {
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    const raw = env[envKey(k)];
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${envKey(k)} must be a number, got "${raw}"`);
    out[k] = n;
  }
  return out;
}

function applyOverrides(target, overrides, label) {
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in target)) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${label}.${k} must be a number`);
    target[k] = v;
  }
}

function validate(cfg) {
  const s = cfg.strategy, r = cfg.risk, c = cfg.costs;
  const fail = (m) => { throw new Error(`Invalid config: ${m}`); };
  if (!(s.entryMinAgeSec < s.entryMaxAgeSec)) fail("entryMinAgeSec must be < entryMaxAgeSec");
  if (!(s.minRealSol < s.maxRealSol)) fail("minRealSol must be < maxRealSol");
  if (!(s.stopLossPct > 0 && s.stopLossPct < 100)) fail("stopLossPct must be between 0 and 100");
  if (!(s.tp1Fraction > 0 && s.tp1Fraction <= 1)) fail("tp1Fraction must be in (0, 1]");
  if (!(s.trailPct > 0 && s.trailPct < 100)) fail("trailPct must be between 0 and 100");
  if (!(r.minTradeSol > 0 && r.minTradeSol <= r.maxTradeSol)) fail("need 0 < minTradeSol <= maxTradeSol");
  if (!(r.maxOpenPositions >= 1)) fail("maxOpenPositions must be >= 1");
  if (!(r.keepPct >= 0 && r.keepPct < 100)) fail("keepPct must be between 0 and 99");
  if (!(r.convictionMax >= 1 && r.convictionMax <= 5)) fail("convictionMax must be between 1 and 5");
  if (!(c.priorityFeeSol >= 0 && c.priorityFeeSol <= 0.01)) fail("priorityFeeSol must be between 0 and 0.01");
  if (!(c.buySlippagePct > 0 && c.sellSlippagePct > 0)) fail("slippage must be > 0");
  if (cfg.runtime.watchSecActive < s.entryMaxAgeSec + s.maxHoldSec) fail("watchSecActive must be >= entryMaxAgeSec + maxHoldSec");
}

/**
 * Builds the full config from defaults, environment variables (PUMP_MIN_REAL_SOL=8, ...)
 * and an optional JSON params file ({ "strategy": {...}, "risk": {...}, "costs": {...} }
 * or a flat object of strategy keys, as written by replay.cjs).
 */
function loadConfig({ env = process.env, paramsFile = null, cwd = REPO_ROOT } = {}) {
  const cfg = {
    strategy: applyEnv(DEFAULT_STRATEGY, env),
    costs: applyEnv(DEFAULT_COSTS, env),
    risk: applyEnv(DEFAULT_RISK, env),
    runtime: applyEnv(DEFAULT_RUNTIME, env),
  };
  if (paramsFile) {
    const parsed = JSON.parse(fs.readFileSync(paramsFile, "utf8"));
    const nested = parsed.strategy || parsed.risk || parsed.costs || parsed.runtime;
    applyOverrides(cfg.strategy, nested ? parsed.strategy : parsed, "strategy");
    if (nested) {
      applyOverrides(cfg.risk, parsed.risk, "risk");
      applyOverrides(cfg.costs, parsed.costs, "costs");
      applyOverrides(cfg.runtime, parsed.runtime, "runtime");
    }
  }
  cfg.rpcUrl = env.SOLANA_RPC_URL || C.DEFAULT_RPC_URL;
  cfg.wsUrl = env.PUMPPORTAL_WS_URL || C.PUMPPORTAL_WS_URL;
  cfg.pumpPortalApiKey = env.PUMPPORTAL_API_KEY || "";
  cfg.discovery = (env.PUMP_DISCOVERY || "pumpportal").toLowerCase();
  if (!["pumpportal", "rpc"].includes(cfg.discovery)) throw new Error("PUMP_DISCOVERY must be pumpportal or rpc");
  cfg.walletFile = env.PUMP_WALLET_FILE || path.join(os.homedir(), ".pump-bot", "wallet.json");
  cfg.liveAck = env.PUMP_LIVE_ACK || "";
  cfg.maxBudgetSol = env.PUMP_MAX_BUDGET_SOL ? Number(env.PUMP_MAX_BUDGET_SOL) : null;
  cfg.paperStartSol = env.PAPER_START_SOL ? Number(env.PAPER_START_SOL) : 0.1;
  cfg.solUsdOverride = env.PUMP_SOL_USD ? Number(env.PUMP_SOL_USD) : null;
  cfg.extraPrograms = (env.PUMP_EXTRA_PROGRAMS || "").split(",").map((x) => x.trim()).filter(Boolean);
  cfg.dataDir = path.resolve(cwd, env.PUMP_DATA_DIR || "data/pump");
  cfg.stopFiles = [path.resolve(cwd, "STOP_PUMP.txt"), path.resolve(cwd, "STOP_BOT.txt")];
  validate(cfg);
  return cfg;
}

module.exports = { DEFAULT_STRATEGY, DEFAULT_COSTS, DEFAULT_RISK, DEFAULT_RUNTIME, REPO_ROOT, loadConfig, envKey, validate };
