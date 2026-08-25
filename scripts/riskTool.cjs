#!/usr/bin/env node
/**
 * scripts/riskTool.cjs
 *
 * Standalone risk/execution helper for MANUAL trading decisions.
 *
 * This tool does NOT generate signals, predictions, or recommendations of
 * any kind. It never decides whether or what to trade. It only sizes,
 * places, and protects a trade the user has already decided to take on
 * their own judgment — entry price, stop price, and side are always
 * supplied by the user, never computed here.
 *
 * This is deliberately NOT gated by I_HAVE_A_BACKTESTED_EDGE / EDGE_EVIDENCE.md
 * (see src/config.js, v33PowerPilot.cjs, etc). That gate means "an automated
 * strategy has a measured backtested edge" — this tool makes no such claim
 * and runs no strategy, so it would be dishonest to require or imply that
 * gate here. Same reasoning already used for scripts/overnightRegimeGatedLive.cjs,
 * which has its own distinct acknowledgement flag for the same reason. This
 * tool's flag is ACKNOWLEDGE_MANUAL_TRADE, required for any command that
 * places or modifies a real order.
 *
 * Reuses scripts/bybitRest.cjs (signed REST + instrument rounding, same
 * pattern as v33PowerPilot.cjs / overnightRegimeGatedLive.cjs) and
 * scripts/strategyLogic.cjs's atr() for the trailing-stop command.
 *
 * ============ ENV VARS ============
 *   BYBIT_API_KEY=...              (from .env)
 *   BYBIT_API_SECRET=...           (from .env)
 *   BYBIT_TESTNET=false
 *   ACKNOWLEDGE_MANUAL_TRADE=true  (required for `enter` and `trail --auto`)
 *
 * ============ COMMANDS ============
 *   node riskTool.cjs size   --symbol BTCUSDT --side LONG --entry 65000 --stop 63500 --risk-pct 1
 *   node riskTool.cjs enter  --symbol BTCUSDT --side LONG --entry 65000 --stop 63500 --risk-pct 1 [--take-profit 68000] [--dry-run]
 *   node riskTool.cjs trail  --symbol BTCUSDT [--atr-mult 2] [--auto] [--dry-run]
 *   node riskTool.cjs status
 *   node riskTool.cjs set-limit --daily-loss-usd 50
 *
 * ============ EMERGENCY STOP ============
 *   This tool has no background loop — closing a position or cancelling an
 *   order is done directly on the exchange (app/web) or via a future command
 *   here. STOP_BOT.txt has no effect on this tool since nothing here runs
 *   unattended.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { createBybitClient, roundQty, roundPrice } = require("./bybitRest.cjs");
const { atr: computeAtrSeries } = require("./strategyLogic.cjs");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data", "riskTool");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const cfg = {
  apiKey: process.env.BYBIT_API_KEY || "",
  apiSecret: process.env.BYBIT_API_SECRET || "",
  testnet: process.env.BYBIT_TESTNET === "true",
  ack: process.env.ACKNOWLEDGE_MANUAL_TRADE === "true",
};

const bybit = createBybitClient(cfg);

// ---------------- CLI arg parsing ----------------

function parseArgs(argv) {
  const command = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true; // boolean flag, e.g. --auto, --dry-run
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

function requireFlag(flags, name) {
  if (flags[name] === undefined) {
    console.error(`ERROR: --${name} is required for this command.`);
    process.exit(1);
  }
  return flags[name];
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ---------------- Local config (daily loss limit) ----------------

function loadLocalConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveLocalConfig(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2));
}

// ---------------- Credential validation (real read-only call, same pattern as other pilots) ----------------

async function validateCredentials() {
  if (!cfg.apiKey || !cfg.apiSecret) die("BYBIT_API_KEY / BYBIT_API_SECRET missing (check .env).");
  try {
    const equity = await bybit.getWalletEquity();
    console.log(`[credentials OK] real read-only wallet-balance call succeeded, equity=$${equity.toFixed(2)}`);
    return equity;
  } catch (err) {
    die(`credential validation failed: ${err.message}`);
  }
}

// ---------------- Sizing (shared by `size` and `enter`) ----------------

async function computeSizing({ symbol, side, entry, stop, riskPct, equityUsdt }) {
  if (!["LONG", "SHORT"].includes(side)) die(`--side must be LONG or SHORT, got "${side}"`);
  if (!(entry > 0) || !(stop > 0)) die("--entry and --stop must be positive numbers.");
  if (side === "LONG" && !(stop < entry)) die("LONG requires --stop below --entry.");
  if (side === "SHORT" && !(stop > entry)) die("SHORT requires --stop above --entry.");
  if (!(riskPct > 0)) die("--risk-pct must be a positive number.");

  const info = await bybit.getInstrumentInfo(symbol);
  const stopDistance = Math.abs(entry - stop);
  const stopDistancePct = (stopDistance / entry) * 100;
  const riskUsdt = equityUsdt * (riskPct / 100);
  const rawQty = riskUsdt / stopDistance;
  const qtyStr = roundQty(rawQty, info);
  const qty = Number(qtyStr);
  const actualRiskUsdt = qty * stopDistance;
  const notionalUsdt = qty * entry;
  const forcedByExchangeMin = qty > rawQty * 1.5; // roundQty bumped us up to minOrderQty

  return { info, stopDistance, stopDistancePct, riskUsdt, qtyStr, qty, actualRiskUsdt, notionalUsdt, forcedByExchangeMin };
}

function printSizingReport({ symbol, side, entry, stop, riskPct, equityUsdt, sizing }) {
  console.log("");
  console.log("=== Position Size ===");
  console.log(`Symbol: ${symbol}  Side: ${side}`);
  console.log(`Entry: ${entry}  Stop: ${stop}  Stop distance: ${sizing.stopDistance.toFixed(6)} (${sizing.stopDistancePct.toFixed(3)}%)`);
  console.log(`Account equity: $${equityUsdt.toFixed(2)}`);
  console.log(`Risk requested: ${riskPct}% of equity = $${sizing.riskUsdt.toFixed(2)}`);
  console.log(`Qty (rounded to instrument precision, step=${sizing.info.qtyStep}, min=${sizing.info.minOrderQty}): ${sizing.qtyStr}`);
  if (sizing.forcedByExchangeMin) {
    console.log(`  NOTE: rounded UP to the exchange minimum order size — actual $ at risk below is larger than requested.`);
  }
  console.log(`Actual $ at risk after rounding: $${sizing.actualRiskUsdt.toFixed(2)}`);
  console.log(`Notional: $${sizing.notionalUsdt.toFixed(2)}`);
  console.log("");
}

// ---------------- Daily PnL (for `status` and the `enter` guard) ----------------

function startOfUtcDayMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

async function getTodayRealizedPnlUsdt() {
  const startMs = startOfUtcDayMs();
  const endMs = Date.now();
  let cursor = undefined;
  let total = 0;
  let count = 0;
  for (let page = 0; page < 5; page++) {
    const q = { category: "linear", startTime: String(startMs), endTime: String(endMs), limit: "100" };
    if (cursor) q.cursor = cursor;
    const json = await bybit.bybitPrivateGet("/v5/position/closed-pnl", q);
    if (json.retCode !== 0) throw new Error("closed-pnl fetch failed: " + json.retMsg);
    const entries = json.result.list || [];
    for (const e of entries) {
      total += Number(e.closedPnl);
      count++;
    }
    cursor = json.result.nextPageCursor;
    if (!cursor || entries.length === 0) break;
  }
  return { totalPnl: total, tradeCount: count };
}

// ---------------- Commands ----------------

async function cmdSize(flags) {
  const symbol = requireFlag(flags, "symbol");
  const side = String(requireFlag(flags, "side")).toUpperCase();
  const entry = Number(requireFlag(flags, "entry"));
  const stop = Number(requireFlag(flags, "stop"));
  const riskPct = Number(requireFlag(flags, "risk-pct"));

  const equityUsdt = await validateCredentials();
  const sizing = await computeSizing({ symbol, side, entry, stop, riskPct, equityUsdt });
  printSizingReport({ symbol, side, entry, stop, riskPct, equityUsdt, sizing });
  console.log("(No order placed — this is a size-only calculation. Use `enter` to actually place the trade.)");
}

async function cmdEnter(flags) {
  const symbol = requireFlag(flags, "symbol");
  const side = String(requireFlag(flags, "side")).toUpperCase();
  const entry = Number(requireFlag(flags, "entry"));
  const stop = Number(requireFlag(flags, "stop"));
  const riskPct = Number(requireFlag(flags, "risk-pct"));
  const takeProfit = flags["take-profit"] !== undefined ? Number(flags["take-profit"]) : null;
  const dryRun = flags["dry-run"] === true;

  if (!dryRun && !cfg.ack) die("placing a real order requires ACKNOWLEDGE_MANUAL_TRADE=true (or pass --dry-run to preview).");
  if (takeProfit !== null) {
    if (side === "LONG" && !(takeProfit > entry)) die("LONG --take-profit must be above --entry.");
    if (side === "SHORT" && !(takeProfit < entry)) die("SHORT --take-profit must be below --entry.");
  }

  const equityUsdt = await validateCredentials();

  // Daily loss limit guard — fails closed, same convention as V33_MAX_DAILY_LOSS_USDT elsewhere in this repo.
  const localCfg = loadLocalConfig();
  if (localCfg.dailyLossLimitUsdt !== undefined) {
    const { totalPnl } = await getTodayRealizedPnlUsdt();
    if (totalPnl <= -Math.abs(localCfg.dailyLossLimitUsdt)) {
      die(`daily loss limit hit: today's realized PnL is $${totalPnl.toFixed(2)}, limit is -$${Math.abs(localCfg.dailyLossLimitUsdt).toFixed(2)}. Refusing to place a new entry. (Not enforced by the exchange — this is this tool's own check.)`);
    }
    console.log(`[daily loss check] today's realized PnL $${totalPnl.toFixed(2)} vs limit -$${Math.abs(localCfg.dailyLossLimitUsdt).toFixed(2)} — OK.`);
  } else {
    console.log(`[daily loss check] no daily loss limit configured (run \`set-limit --daily-loss-usd N\` to set one) — skipping.`);
  }

  const sizing = await computeSizing({ symbol, side, entry, stop, riskPct, equityUsdt });
  printSizingReport({ symbol, side, entry, stop, riskPct, equityUsdt, sizing });

  if (Number(sizing.qtyStr) <= 0) die("computed qty is zero — refusing to place an order.");

  const info = sizing.info;
  const orderSide = side === "LONG" ? "Buy" : "Sell";
  const stopLossStr = roundPrice(stop, info);

  console.log(`${dryRun ? "DRY_RUN " : ""}ENTRY ${side} ${symbol} qty=${sizing.qtyStr} SL=${stopLossStr}${takeProfit !== null ? ` (separate reduce-only TP will follow @ ${roundPrice(takeProfit, info)})` : ""}`);

  let entryResult;
  if (dryRun) {
    entryResult = { simulated: true };
  } else {
    const json = await bybit.bybitPrivatePost("/v5/order/create", {
      category: "linear", symbol, side: orderSide, orderType: "Market", qty: sizing.qtyStr,
      stopLoss: stopLossStr, timeInForce: "IOC",
    });
    if (json.retCode !== 0) die("place entry order failed: " + json.retMsg);
    entryResult = json.result;
  }

  let tpResult = null;
  if (takeProfit !== null) {
    const tpPriceStr = roundPrice(takeProfit, info);
    const closingSide = side === "LONG" ? "Sell" : "Buy";
    console.log(`${dryRun ? "DRY_RUN " : ""}place TP limit ${closingSide} qty=${sizing.qtyStr} @ ${tpPriceStr} (reduceOnly)`);
    if (dryRun) {
      tpResult = { simulated: true };
    } else {
      const json = await bybit.bybitPrivatePost("/v5/order/create", {
        category: "linear", symbol, side: closingSide, orderType: "Limit", qty: sizing.qtyStr, price: tpPriceStr,
        reduceOnly: true, timeInForce: "GTC",
      });
      if (json.retCode !== 0) die("place TP order failed: " + json.retMsg);
      tpResult = json.result;
    }
  }

  console.log("");
  console.log(dryRun ? "DRY RUN complete — no real orders were placed." : "Order(s) placed. Verify on the exchange before walking away.");
  return { entryResult, tpResult };
}

async function cmdTrail(flags) {
  const symbol = requireFlag(flags, "symbol");
  const atrMult = flags["atr-mult"] !== undefined ? Number(flags["atr-mult"]) : 2;
  const auto = flags["auto"] === true;
  const dryRun = flags["dry-run"] === true;

  if (auto && !dryRun && !cfg.ack) die("moving a real stop-loss requires ACKNOWLEDGE_MANUAL_TRADE=true (or pass --dry-run to preview).");

  await validateCredentials();

  const pos = await bybit.getOpenPosition(symbol);
  if (!pos) {
    console.log(`No open ${symbol} position on the exchange — nothing to trail.`);
    return;
  }

  const side = pos.side === "Buy" ? "LONG" : "SHORT";
  const entryPrice = Number(pos.avgPrice);
  const currentStop = Number(pos.stopLoss) || null; // "0" or "" means unset
  const qty = pos.size;

  const candles1h = await bybit.fetchCandles(symbol, "60", 100);
  const atrSeries = computeAtrSeries(candles1h, 14);
  const lastClose = candles1h[candles1h.length - 1].close;
  const currentAtr = atrSeries[atrSeries.length - 1];

  const suggestedStopRaw = side === "LONG" ? lastClose - atrMult * currentAtr : lastClose + atrMult * currentAtr;

  console.log("");
  console.log("=== Trail Stop ===");
  console.log(`Symbol: ${symbol}  Side: ${side}  Qty: ${qty}  Entry: ${entryPrice}`);
  console.log(`Current stop on exchange: ${currentStop !== null ? currentStop : "(none set)"}`);
  console.log(`Last 1h close: ${lastClose}  ATR(14) 1h: ${currentAtr.toFixed(6)}  (x${atrMult} = ${(atrMult * currentAtr).toFixed(6)})`);
  console.log(`Suggested new stop (raw): ${suggestedStopRaw.toFixed(6)}`);

  const tightens =
    side === "LONG"
      ? currentStop === null || suggestedStopRaw > currentStop
      : currentStop === null || suggestedStopRaw < currentStop;
  const stillValid = side === "LONG" ? suggestedStopRaw < lastClose : suggestedStopRaw > lastClose;

  if (!stillValid) {
    console.log("Suggested stop is on the wrong side of the current price — skipping, not moving anything.");
    return;
  }
  if (!tightens) {
    console.log(`Suggested stop (${suggestedStopRaw.toFixed(6)}) would LOOSEN risk vs current stop (${currentStop}) — refusing to move it. Trailing only tightens.`);
    return;
  }

  const info = await bybit.getInstrumentInfo(symbol);
  const newStopStr = roundPrice(suggestedStopRaw, info);
  console.log(`This tightens the stop from ${currentStop !== null ? currentStop : "(none)"} to ${newStopStr}.`);

  if (!auto) {
    console.log("(Suggestion only — pass --auto to actually move the stop on the exchange.)");
    return;
  }

  console.log(`${dryRun ? "DRY_RUN " : ""}moving stop-loss to ${newStopStr}`);
  if (dryRun) {
    console.log("DRY RUN complete — no real order was modified.");
    return;
  }
  const json = await bybit.bybitPrivatePost("/v5/position/trading-stop", {
    category: "linear", symbol, positionIdx: 0, stopLoss: newStopStr, tpslMode: "Full",
  });
  if (json.retCode !== 0 && json.retCode !== 34040) die("move stop-loss failed: " + json.retMsg);
  console.log("Stop-loss moved on the exchange. Verify before walking away.");
}

async function cmdStatus() {
  const equityUsdt = await validateCredentials();
  const { totalPnl, tradeCount } = await getTodayRealizedPnlUsdt();
  const localCfg = loadLocalConfig();

  console.log("");
  console.log("=== Status ===");
  console.log(`Account equity: $${equityUsdt.toFixed(2)}`);
  console.log(`Today's realized PnL (UTC day, all symbols): ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} across ${tradeCount} closed fill(s)`);
  if (localCfg.dailyLossLimitUsdt !== undefined) {
    const limit = Math.abs(localCfg.dailyLossLimitUsdt);
    const hit = totalPnl <= -limit;
    console.log(`Daily loss limit: -$${limit.toFixed(2)} (set ${localCfg.updatedAt || "unknown time"})`);
    console.log(`Limit hit: ${hit ? "YES — enter would refuse a new trade right now." : "no"}`);
  } else {
    console.log(`Daily loss limit: not set (run \`set-limit --daily-loss-usd N\` to set one)`);
  }
  console.log("");
}

async function cmdSetLimit(flags) {
  const raw = requireFlag(flags, "daily-loss-usd");
  const value = Number(raw);
  if (!(value > 0)) die("--daily-loss-usd must be a positive number (it's a loss magnitude, not signed).");
  const localCfg = loadLocalConfig();
  localCfg.dailyLossLimitUsdt = value;
  localCfg.updatedAt = new Date().toISOString();
  saveLocalConfig(localCfg);
  console.log(`Daily loss limit set to -$${value.toFixed(2)}. Saved to ${path.relative(ROOT, CONFIG_FILE)}.`);
}

function printUsage() {
  console.log(`Usage:
  node riskTool.cjs size      --symbol S --side LONG|SHORT --entry N --stop N --risk-pct N
  node riskTool.cjs enter     --symbol S --side LONG|SHORT --entry N --stop N --risk-pct N [--take-profit N] [--dry-run]
  node riskTool.cjs trail     --symbol S [--atr-mult N] [--auto] [--dry-run]
  node riskTool.cjs status
  node riskTool.cjs set-limit --daily-loss-usd N`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "size": return cmdSize(flags);
    case "enter": return cmdEnter(flags);
    case "trail": return cmdTrail(flags);
    case "status": return cmdStatus();
    case "set-limit": return cmdSetLimit(flags);
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
