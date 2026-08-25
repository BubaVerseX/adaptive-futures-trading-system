#!/usr/bin/env node
/**
 * scripts/dcaExecutor.cjs
 *
 * Recurring-buy DCA executor. SINGLE-SHOT script (same pattern as
 * dailyTrendLivePilot.cjs / intradayTrendLivePilot.cjs) — checks once, buys
 * if the allocation clears each coin's exchange minimum, and exits.
 * Designed to be scheduled via cron (see bottom of this header), not run
 * continuously.
 *
 * SPOT ONLY. No leverage, no shorting, no stop-loss, no position, no signal,
 * no prediction of any kind — this is fixed-schedule accumulation, not a
 * directional bet. Deliberately does NOT go through this repo's
 * I_HAVE_A_BACKTESTED_EDGE / EDGE_EVIDENCE.md gate (see src/config.js,
 * v33PowerPilot.cjs, etc) — that gate means "an automated strategy has a
 * measured backtested edge," which doesn't apply here; same reasoning
 * already used for scripts/overnightRegimeGatedLive.cjs and
 * scripts/riskTool.cjs, which each have their own distinct acknowledgement
 * flag for the same reason. This script's flag is ACKNOWLEDGE_DCA.
 *
 * ============ ENV VARS ============
 *   BYBIT_API_KEY=...
 *   BYBIT_API_SECRET=...
 *   BYBIT_TESTNET=false
 *   DRY_RUN=false                        (true = log intended buys, no real orders — default true)
 *   ACKNOWLEDGE_DCA=true                 (required whenever DRY_RUN=false)
 *   DCA_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT  (spot pairs)
 *   DCA_TOTAL_USDT_PER_CYCLE=18          (split evenly across DCA_SYMBOLS — default
 *                                          chosen so the default 3-symbol split clears
 *                                          Bybit's current $5 spot minOrderAmt on all
 *                                          three with room to spare; $5/coin exactly
 *                                          would be too close to the floor. Override
 *                                          this for your own budget.)
 *
 * ============ RUN MANUALLY ============
 *   node scripts/dcaExecutor.cjs           (run one DCA cycle)
 *   node scripts/dcaExecutor.cjs status    (report holdings, no orders)
 *
 * ============ SCHEDULE (macOS cron) ============
 *   crontab -e
 *   Every 12 hours, at :05 past midnight and noon UTC-local-equivalent — adjust
 *   the hours to your local timezone, cron uses local system time:
 *     5 0,12 * * * cd /Users/alinavanempel/Documents/Pionex && \
 *       BYBIT_API_KEY=... BYBIT_API_SECRET=... BYBIT_TESTNET=false DRY_RUN=false \
 *       ACKNOWLEDGE_DCA=true node scripts/dcaExecutor.cjs >> data/dca/log.txt 2>&1
 *   Or once a day at 9:05am:
 *     5 9 * * * cd /Users/alinavanempel/Documents/Pionex && \
 *       BYBIT_API_KEY=... BYBIT_API_SECRET=... BYBIT_TESTNET=false DRY_RUN=false \
 *       ACKNOWLEDGE_DCA=true node scripts/dcaExecutor.cjs >> data/dca/log.txt 2>&1
 *   Only fires if the Mac is awake at that time — a missed cycle just means
 *   one less buy, nothing breaks or needs manual recovery.
 *
 * ============ EMERGENCY STOP ============
 *   touch STOP_BOT.txt
 */

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const ROOT = path.join(__dirname, "..");
const STOP_FILE = path.join(ROOT, "STOP_BOT.txt");
const DATA_DIR = path.join(ROOT, "data", "dca");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const TRADES_LOG_FILE = path.join(DATA_DIR, "trades.jsonl");

const SYMBOLS = (process.env.DCA_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map((s) => s.trim());

const cfg = {
  apiKey: process.env.BYBIT_API_KEY || "",
  apiSecret: process.env.BYBIT_API_SECRET || "",
  testnet: process.env.BYBIT_TESTNET === "true",
  dryRun: process.env.DRY_RUN !== "false",
  ack: process.env.ACKNOWLEDGE_DCA === "true",
  totalUsdtPerCycle: Number(process.env.DCA_TOTAL_USDT_PER_CYCLE || 18),
};

const REST_BASE = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
const perSymbolUsdt = cfg.totalUsdtPerCycle / SYMBOLS.length;

// ---------------- Bybit signed REST helper (same pattern as v33PowerPilot.cjs) ----------------

function bybitSign(timestamp, params) {
  return crypto.createHmac("sha256", cfg.apiSecret).update(timestamp + cfg.apiKey + "5000" + params).digest("hex");
}
function httpRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Bad JSON: " + data.slice(0, 300))); } });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
async function bybitPublicGet(pathAndQuery) {
  return httpRequest("GET", REST_BASE + pathAndQuery, { "Content-Type": "application/json" });
}
async function bybitPrivateGet(pathName, queryObj) {
  const query = new URLSearchParams(queryObj).toString();
  const timestamp = Date.now().toString();
  const headers = { "X-BAPI-API-KEY": cfg.apiKey, "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-SIGN": bybitSign(timestamp, query), "X-BAPI-RECV-WINDOW": "5000", "Content-Type": "application/json" };
  return httpRequest("GET", `${REST_BASE}${pathName}?${query}`, headers);
}
async function bybitPrivatePost(pathName, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const timestamp = Date.now().toString();
  const headers = { "X-BAPI-API-KEY": cfg.apiKey, "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-SIGN": bybitSign(timestamp, body), "X-BAPI-RECV-WINDOW": "5000", "Content-Type": "application/json" };
  return httpRequest("POST", REST_BASE + pathName, headers, body);
}

// ---------------- Spot instrument info (category=spot — different shape from linear) ----------------

const instrumentCache = {};
function decimalsOf(step) {
  const str = String(step);
  if (str.includes("e-")) return parseInt(str.split("e-")[1], 10);
  const idx = str.indexOf(".");
  return idx === -1 ? 0 : str.length - idx - 1;
}
async function getSpotInstrumentInfo(symbol) {
  if (instrumentCache[symbol]) return instrumentCache[symbol];
  const json = await bybitPublicGet(`/v5/market/instruments-info?category=spot&symbol=${symbol}`);
  if (json.retCode !== 0 || !json.result?.list?.length) throw new Error(`spot instrument info failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
  const info = json.result.list[0];
  const lot = info.lotSizeFilter;
  const cached = {
    basePrecision: parseFloat(lot.basePrecision),
    quotePrecision: parseFloat(lot.quotePrecision),
    minOrderQty: parseFloat(lot.minOrderQty),
    minOrderAmt: parseFloat(lot.minOrderAmt), // minimum quote-currency (USDT) notional — this is the check we actually need
    tickSize: parseFloat(info.priceFilter.tickSize),
    quoteDecimals: decimalsOf(lot.quotePrecision),
  };
  instrumentCache[symbol] = cached;
  return cached;
}

async function getSpotPrice(symbol) {
  const json = await bybitPublicGet(`/v5/market/tickers?category=spot&symbol=${symbol}`);
  if (json.retCode !== 0 || !json.result?.list?.length) throw new Error(`spot ticker fetch failed for ${symbol}`);
  return Number(json.result.list[0].lastPrice);
}

// ---------------- Credential validation (real read-only call, same fix as intradayTrendLivePilot.cjs) ----------------

async function validateCredentials() {
  if (!cfg.apiKey || !cfg.apiSecret) {
    console.log("[dca] No API key/secret provided — skipping credential check (fine for dry-run-only testing).");
    return;
  }
  console.log("[dca] Validating API credentials with a read-only call...");
  const json = await bybitPrivateGet("/v5/account/wallet-balance", { accountType: "UNIFIED" });
  if (json.retCode !== 0) {
    console.error(`[dca] ABORT: API credential check failed: ${json.retMsg}`);
    process.exit(1);
  }
  console.log("[dca] API credentials valid.");
}

// ---------------- Spot market buy (by quote amount, so we spend exactly the allocated USDT) ----------------

async function waitForFill(symbol, orderId, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const json = await bybitPrivateGet("/v5/order/realtime", { category: "spot", symbol, orderId });
    const order = json.result?.list?.[0];
    if (order && order.orderStatus === "Filled") return order;
    if (order && (order.orderStatus === "Cancelled" || order.orderStatus === "Rejected")) {
      throw new Error(`order ${orderId} ended in status ${order.orderStatus}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Fallback: market orders that already left the "realtime" list are in history.
  const histJson = await bybitPrivateGet("/v5/order/history", { category: "spot", symbol, orderId });
  const histOrder = histJson.result?.list?.[0];
  if (histOrder && histOrder.orderStatus === "Filled") return histOrder;
  throw new Error(`order ${orderId} did not confirm as Filled after ${maxAttempts}s — check the exchange manually.`);
}

async function placeSpotMarketBuy(symbol, quoteAmountUsdt) {
  const info = await getSpotInstrumentInfo(symbol);
  const qtyStr = quoteAmountUsdt.toFixed(info.quoteDecimals);
  console.log(`[dca] ${cfg.dryRun ? "DRY_RUN " : ""}BUY ${symbol} spend=${qtyStr} USDT (marketUnit=quoteCoin)`);
  if (cfg.dryRun) {
    const price = await getSpotPrice(symbol);
    const simulatedQty = Number(qtyStr) / price;
    return { simulated: true, spentUsdt: Number(qtyStr), qtyReceived: simulatedQty, avgPrice: price };
  }
  const json = await bybitPrivatePost("/v5/order/create", {
    category: "spot", symbol, side: "Buy", orderType: "Market", qty: qtyStr, marketUnit: "quoteCoin",
  });
  if (json.retCode !== 0) throw new Error(`spot market buy failed for ${symbol}: ${json.retMsg}`);
  const orderId = json.result.orderId;
  const filled = await waitForFill(symbol, orderId);
  return {
    simulated: false,
    orderId,
    spentUsdt: Number(filled.cumExecValue),
    qtyReceived: Number(filled.cumExecQty),
    avgPrice: Number(filled.avgPrice),
  };
}

// ---------------- State ----------------

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    loaded.perSymbol = loaded.perSymbol || {};
    for (const s of SYMBOLS) if (!loaded.perSymbol[s]) loaded.perSymbol[s] = { totalInvestedUsdt: 0, totalQty: 0, buyCount: 0 };
    return loaded;
  }
  const perSymbol = {};
  for (const s of SYMBOLS) perSymbol[s] = { totalInvestedUsdt: 0, totalQty: 0, buyCount: 0 };
  return { perSymbol };
}
function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function logTrade(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(TRADES_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

// ---------------- Abort checks ----------------

function abortIf(condition, message) {
  if (condition) { console.error(`[dca] ABORT: ${message}`); process.exit(1); }
}

// ---------------- Per-cycle run ----------------

async function processSymbol(symbol, state) {
  const info = await getSpotInstrumentInfo(symbol);
  if (perSymbolUsdt < info.minOrderAmt) {
    console.log(`[dca] [${symbol}] SKIP this cycle — allocation $${perSymbolUsdt.toFixed(2)} is below this coin's exchange minimum order notional ($${info.minOrderAmt}). Not rounding up past the intended budget; this coin sits out until DCA_TOTAL_USDT_PER_CYCLE or DCA_SYMBOLS changes.`);
    return { symbol, skipped: true, reason: `allocation $${perSymbolUsdt.toFixed(2)} < minOrderAmt $${info.minOrderAmt}` };
  }

  const result = await placeSpotMarketBuy(symbol, perSymbolUsdt);
  const sym = state.perSymbol[symbol];
  sym.totalInvestedUsdt += result.spentUsdt;
  sym.totalQty += result.qtyReceived;
  sym.buyCount += 1;

  console.log(`[dca] [${symbol}] ${cfg.dryRun ? "(simulated) " : ""}bought ${result.qtyReceived.toFixed(8)} @ ~${result.avgPrice} for $${result.spentUsdt.toFixed(2)}. Running total: $${sym.totalInvestedUsdt.toFixed(2)} invested, ${sym.totalQty.toFixed(8)} held.`);
  logTrade({
    symbol, dryRun: cfg.dryRun, spentUsdt: result.spentUsdt, qtyReceived: result.qtyReceived,
    avgPrice: result.avgPrice, orderId: result.orderId || null,
  });
  return { symbol, skipped: false, ...result };
}

async function runCycle() {
  console.log("=".repeat(60));
  console.log(`DCA Executor — single-shot run — [${SYMBOLS.join(", ")}]`);
  console.log(`Mode: ${cfg.dryRun ? "DRY_RUN (no orders)" : "LIVE — REAL SPOT ORDERS"} | Network: ${cfg.testnet ? "TESTNET" : "MAINNET"}`);
  console.log(`Budget: $${cfg.totalUsdtPerCycle} total this cycle ($${perSymbolUsdt.toFixed(2)} per symbol, spot only, no leverage)`);
  console.log("=".repeat(60));

  if (fs.existsSync(STOP_FILE)) abortIf(true, "STOP_BOT.txt exists — remove it first if you want to run.");
  abortIf(!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret), "DRY_RUN=false but API key/secret missing");
  abortIf(!cfg.dryRun && !cfg.ack, "DRY_RUN=false but ACKNOWLEDGE_DCA is not 'true'");

  await validateCredentials();

  const state = loadState();
  const results = [];
  for (const symbol of SYMBOLS) {
    try { results.push(await processSymbol(symbol, state)); }
    catch (err) { console.error(`[dca] [${symbol}] error:`, err.message); results.push({ symbol, error: err.message }); }
  }

  saveState(state);
  console.log("\n[dca] Run complete. Exiting until next scheduled run.");
  return results;
}

// ---------------- Status command ----------------

async function runStatus() {
  const state = loadState();
  console.log("=".repeat(60));
  console.log("DCA Status");
  console.log("=".repeat(60));

  let totalInvestedAll = 0, totalValueAll = 0;
  for (const symbol of SYMBOLS) {
    const sym = state.perSymbol[symbol] || { totalInvestedUsdt: 0, totalQty: 0, buyCount: 0 };
    let price = null, valueUsdt = null, returnPct = null;
    try {
      price = await getSpotPrice(symbol);
      valueUsdt = sym.totalQty * price;
      returnPct = sym.totalInvestedUsdt > 0 ? ((valueUsdt - sym.totalInvestedUsdt) / sym.totalInvestedUsdt) * 100 : null;
    } catch (err) {
      console.error(`[dca] [${symbol}] price fetch failed: ${err.message}`);
    }
    totalInvestedAll += sym.totalInvestedUsdt;
    if (valueUsdt !== null) totalValueAll += valueUsdt;

    console.log(`\n${symbol}:`);
    console.log(`  Buys so far: ${sym.buyCount}`);
    console.log(`  Total invested: $${sym.totalInvestedUsdt.toFixed(2)}`);
    console.log(`  Total held: ${sym.totalQty.toFixed(8)}`);
    if (price !== null) {
      console.log(`  Current price: $${price}`);
      console.log(`  Current value: $${valueUsdt.toFixed(2)}`);
      if (returnPct !== null) {
        console.log(`  Return vs cost basis: ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}%`);
      } else {
        console.log(`  Return vs cost basis: n/a (no buys yet)`);
      }
    }
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(`TOTAL invested: $${totalInvestedAll.toFixed(2)}`);
  console.log(`TOTAL current value: $${totalValueAll.toFixed(2)}`);
  if (totalInvestedAll > 0) {
    const overallReturn = ((totalValueAll - totalInvestedAll) / totalInvestedAll) * 100;
    console.log(`OVERALL return vs cost basis: ${overallReturn >= 0 ? "+" : ""}${overallReturn.toFixed(2)}%`);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "status") return runStatus();
  return runCycle();
}

main().catch((err) => { console.error("[dca] fatal error:", err); process.exit(1); });
