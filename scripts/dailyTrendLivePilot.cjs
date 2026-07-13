#!/usr/bin/env node
/**
 * scripts/dailyTrendLivePilot.cjs
 *
 * Live daily trend-following (Donchian breakout) bot. SINGLE-SHOT script —
 * it checks once, acts if needed, and exits. Designed to be scheduled to
 * run once a day (see cron setup at the bottom of this comment), NOT run
 * continuously. Your Mac does not need to be on 24/7 for this.
 *
 * HONEST STATUS: the underlying signal showed a WEAK backtest result
 * (+2.45% vs +9.75% buy-and-hold over the same period, barely above
 * breakeven) and did notably worse than buy-and-hold in the bull-run test
 * window. This is not a strategy with demonstrated edge — it is the least
 * risky, most disciplined version of what was asked for: full capital
 * deployed, real leverage, real stop-loss, structural exits, no
 * "hold until profitable" (which has no real exit rule at all).
 *
 * ============ REQUIRED ENV VARS ============
 *   BYBIT_API_KEY=...
 *   BYBIT_API_SECRET=...
 *   BYBIT_TESTNET=false            (recommend true for the first several runs)
 *   DRY_RUN=false                  (true = log intended action, no real orders)
 *   ACKNOWLEDGE_DAILY_LIVE=true    (required whenever DRY_RUN=false)
 *   DAILY_SYMBOLS=BTCUSDT,ETHUSDT  (only these two were backtested)
 *   DAILY_CAPITAL_USDT=64
 *   DAILY_LEVERAGE=3               (deliberately modest — see honest note above)
 *
 * ============ RUN MANUALLY ============
 *   node scripts/dailyTrendLivePilot.cjs
 *
 * ============ SCHEDULE TO RUN ONCE A DAY (macOS) ============
 *   crontab -e
 *   Add this line to run at 9:05am daily (adjust path/env as needed):
 *     5 9 * * * cd /Users/alinavanempel/Documents/Pionex && \
 *       BYBIT_API_KEY=... BYBIT_API_SECRET=... BYBIT_TESTNET=false DRY_RUN=false \
 *       ACKNOWLEDGE_DAILY_LIVE=true node scripts/dailyTrendLivePilot.cjs >> data/dailytrend/log.txt 2>&1
 *   This only works if your Mac is awake (or set to auto-wake) at that time.
 *   If the Mac is fully off, that day's check gets skipped — the position's
 *   native stop-loss on the exchange still protects you either way.
 *
 * ============ EMERGENCY STOP ============
 *   touch STOP_BOT.txt (same kill-switch file used by everything else tonight)
 */

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { dailyTrendSignalAt, DAILY_TREND_PARAMS } = require("./dailyTrendStrategy.cjs");

const ROOT = path.join(__dirname, "..");
const STOP_FILE = path.join(ROOT, "STOP_BOT.txt");
const STATE_FILE = path.join(ROOT, "data", "dailytrend", "state.json");
const REPORT_FILE = path.join(ROOT, "data", "dailytrend", "report.json");

const SYMBOLS = (process.env.DAILY_SYMBOLS || "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim());

const cfg = {
  apiKey: process.env.BYBIT_API_KEY || "",
  apiSecret: process.env.BYBIT_API_SECRET || "",
  testnet: process.env.BYBIT_TESTNET === "true",
  dryRun: process.env.DRY_RUN !== "false",
  ack: process.env.ACKNOWLEDGE_DAILY_LIVE === "true",
  capitalUsdt: Number(process.env.DAILY_CAPITAL_USDT || 64),
  leverage: Number(process.env.DAILY_LEVERAGE || 3),
};

const REST_BASE = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
const notionalPerSymbol = cfg.capitalUsdt / SYMBOLS.length;

// ---------------- Bybit signed REST helper (same pattern as V33) ----------------

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

// ---------------- Market data ----------------

async function fetchDailyCandles(symbol, lookbackDays = 250) {
  const q = new URLSearchParams({ category: "linear", symbol, interval: "D", limit: String(lookbackDays) });
  const json = await bybitPublicGet(`/v5/market/kline?${q}`);
  if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
    throw new Error(`kline fetch failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.result.list
    .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
    .sort((a, b) => a.ts - b.ts);
}

// ---------------- Instrument precision (same fix as V33) ----------------

const instrumentCache = {};
function decimalsOf(step) {
  const str = String(step);
  if (str.includes("e-")) return parseInt(str.split("e-")[1], 10);
  const idx = str.indexOf(".");
  return idx === -1 ? 0 : str.length - idx - 1;
}
async function getInstrumentInfo(symbol) {
  if (instrumentCache[symbol]) return instrumentCache[symbol];
  const json = await bybitPublicGet(`/v5/market/instruments-info?category=linear&symbol=${symbol}`);
  if (json.retCode !== 0 || !json.result?.list?.length) throw new Error(`instrument info failed for ${symbol}`);
  const info = json.result.list[0];
  const qtyStep = parseFloat(info.lotSizeFilter.qtyStep);
  const minOrderQty = parseFloat(info.lotSizeFilter.minOrderQty);
  const tickSize = parseFloat(info.priceFilter.tickSize);
  const cached = { qtyStep, minOrderQty, tickSize, qtyDecimals: decimalsOf(qtyStep), priceDecimals: decimalsOf(tickSize) };
  instrumentCache[symbol] = cached;
  console.log(`[daily] instrument ${symbol}: qtyStep=${qtyStep} minOrderQty=${minOrderQty} tickSize=${tickSize}`);
  return cached;
}
function roundQty(rawQty, info) {
  const bumped = Math.max(rawQty, info.minOrderQty);
  return (Math.floor(bumped / info.qtyStep) * info.qtyStep).toFixed(info.qtyDecimals);
}
function roundPrice(rawPrice, info) {
  return (Math.round(rawPrice / info.tickSize) * info.tickSize).toFixed(info.priceDecimals);
}

// ---------------- Account / trading calls ----------------

async function getOpenPosition(symbol) {
  const json = await bybitPrivateGet("/v5/position/list", { category: "linear", symbol });
  if (json.retCode !== 0) throw new Error("get position failed: " + json.retMsg);
  return (json.result.list || []).find((p) => Number(p.size) > 0) || null;
}

async function setLeverage(symbol) {
  const json = await bybitPrivatePost("/v5/position/set-leverage", { category: "linear", symbol, buyLeverage: String(cfg.leverage), sellLeverage: String(cfg.leverage) });
  if (json.retCode !== 0 && json.retCode !== 110043) throw new Error(`set leverage failed for ${symbol}: ` + json.retMsg);
}

async function placeEntryOrder(symbol, side, entryPrice, stopPrice) {
  const info = await getInstrumentInfo(symbol);
  const rawQty = (notionalPerSymbol * cfg.leverage) / entryPrice; // full notional deployed, per the "use the whole 64" decision
  const qty = roundQty(rawQty, info);
  const stopLoss = roundPrice(stopPrice, info);
  const orderSide = side === "LONG" ? "Buy" : "Sell";
  const actualNotional = (Number(qty) * entryPrice).toFixed(2);
  console.log(`[daily] ${cfg.dryRun ? "DRY_RUN " : ""}ENTRY ${side} ${symbol} qty=${qty} (~${actualNotional} USDT notional, ${cfg.leverage}x) price~${entryPrice} SL=${stopLoss} (no fixed TP — structural exit only)`);
  if (cfg.dryRun) return { simulated: true, qty, stopLoss };
  const json = await bybitPrivatePost("/v5/order/create", { category: "linear", symbol, side: orderSide, orderType: "Market", qty, stopLoss, timeInForce: "IOC" });
  if (json.retCode !== 0) throw new Error("place order failed: " + json.retMsg);
  return json.result;
}

async function closePositionMarket(symbol, qty, positionSide) {
  const info = await getInstrumentInfo(symbol);
  const qtyStr = roundQty(Number(qty), info);
  const closingSide = positionSide === "LONG" ? "Sell" : "Buy";
  console.log(`[daily] ${cfg.dryRun ? "DRY_RUN " : ""}EXIT (channel break) ${symbol} qty=${qtyStr}`);
  if (cfg.dryRun) return { simulated: true };
  const json = await bybitPrivatePost("/v5/order/create", { category: "linear", symbol, side: closingSide, orderType: "Market", qty: qtyStr, reduceOnly: true, timeInForce: "IOC" });
  if (json.retCode !== 0) throw new Error("close order failed: " + json.retMsg);
  return json.result;
}

// ---------------- Real PnL reconciliation (same honesty fix as V33) ----------------

async function reconcileClosedPnl(symbol, state) {
  if (cfg.dryRun) return;
  const sym = state.perSymbol[symbol];
  const json = await bybitPrivateGet("/v5/position/closed-pnl", { category: "linear", symbol, limit: "20" });
  if (json.retCode !== 0) { console.error(`[daily] [${symbol}] closed-pnl fetch failed: ${json.retMsg}`); return; }
  const entries = json.result.list || [];

  if (!sym.lastClosedPnlTs) {
    sym.lastClosedPnlTs = entries.length ? Math.max(...entries.map((e) => Number(e.updatedTime))) : Date.now();
    console.log(`[daily] [${symbol}] closed-pnl baseline established (${entries.length} historical entries skipped).`);
    return;
  }
  const newEntries = entries.filter((e) => Number(e.updatedTime) > sym.lastClosedPnlTs).sort((a, b) => Number(a.updatedTime) - Number(b.updatedTime));
  for (const e of newEntries) {
    const pnl = Number(e.closedPnl);
    state.realizedPnlUsdt += pnl;
    state.tradesLog = state.tradesLog || [];
    state.tradesLog.push({ symbol, side: e.side, qty: e.qty, avgEntryPrice: e.avgEntryPrice, avgExitPrice: e.avgExitPrice, closedPnl: pnl, closedAt: new Date(Number(e.updatedTime)).toISOString() });
    console.log(`[daily] [${symbol}] REAL closed PnL: ${pnl.toFixed(4)} USDT (running total: ${state.realizedPnlUsdt.toFixed(4)})`);
    sym.lastClosedPnlTs = Math.max(sym.lastClosedPnlTs, Number(e.updatedTime));
  }
}

// ---------------- State ----------------

function loadState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    loaded.perSymbol = loaded.perSymbol || {};
    for (const s of SYMBOLS) if (!loaded.perSymbol[s]) loaded.perSymbol[s] = { position: null, lastClosedPnlTs: 0 };
    loaded.realizedPnlUsdt = loaded.realizedPnlUsdt || 0;
    return loaded;
  }
  const perSymbol = {};
  for (const s of SYMBOLS) perSymbol[s] = { position: null, lastClosedPnlTs: 0 };
  return { perSymbol, realizedPnlUsdt: 0, tradesLog: [] };
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function saveReport(report) {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
}

// ---------------- Abort checks ----------------

function abortIf(condition, message) {
  if (condition) { console.error(`[daily] ABORT: ${message}`); process.exit(1); }
}

// ---------------- Main (single-shot: runs once, then exits) ----------------

async function processSymbol(symbol, state) {
  await reconcileClosedPnl(symbol, state);

  const exchangePosition = cfg.dryRun ? null : await getOpenPosition(symbol);
  const sym = state.perSymbol[symbol];
  const hasPosition = cfg.dryRun ? !!sym.position : !!exchangePosition;

  const candles = await fetchDailyCandles(symbol, 250);
  const i = candles.length - 1; // today's (most recently closed) daily candle
  const sig = dailyTrendSignalAt(candles, i, DAILY_TREND_PARAMS);

  if (sig.atr === null) {
    console.log(`[daily] [${symbol}] not enough history yet for signal computation.`);
    return;
  }

  if (hasPosition) {
    const side = cfg.dryRun ? sym.position.side : exchangePosition.side === "Buy" ? "LONG" : "SHORT";
    const isLong = side === "LONG";
    const exitSignal = isLong ? sig.longExit : sig.shortExit;
    if (exitSignal) {
      const qty = cfg.dryRun ? sym.position.qty : exchangePosition.size;
      await closePositionMarket(symbol, qty, side);
      sym.position = null;
      console.log(`[daily] [${symbol}] channel-break exit triggered.`);
    } else {
      console.log(`[daily] [${symbol}] holding ${side} position, no exit signal today. (Native stop-loss protects overnight regardless of this script running.)`);
    }
    return;
  }

  const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
  if (!side) {
    console.log(`[daily] [${symbol}] no entry signal today.`);
    return;
  }

  const entryPrice = candles[i].close;
  const stopDistance = DAILY_TREND_PARAMS.atrStopMultiple * sig.atr;
  const stopPrice = side === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance;
  const result = await placeEntryOrder(symbol, side, entryPrice, stopPrice);
  sym.position = { side, entryPrice, qty: result.qty || null };
  console.log(`[daily] [${symbol}] ENTRY recorded.`);
}

async function main() {
  console.log("=".repeat(60));
  console.log(`Daily Trend Live Pilot — single-shot run — [${SYMBOLS.join(", ")}]`);
  console.log(`Mode: ${cfg.dryRun ? "DRY_RUN (no orders)" : "LIVE — REAL ORDERS"} | Network: ${cfg.testnet ? "TESTNET" : "MAINNET"}`);
  console.log(`Capital: ${cfg.capitalUsdt} USDT total (${notionalPerSymbol.toFixed(2)} per symbol) | Leverage: ${cfg.leverage}x | No fixed take-profit (structural exit only)`);
  console.log("=".repeat(60));

  if (fs.existsSync(STOP_FILE)) abortIf(true, "STOP_BOT.txt exists");
  abortIf(!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret), "DRY_RUN=false but API key/secret missing");
  abortIf(!cfg.dryRun && !cfg.ack, "DRY_RUN=false but ACKNOWLEDGE_DAILY_LIVE is not 'true'");

  const state = loadState();
  if (!cfg.dryRun) for (const s of SYMBOLS) await setLeverage(s);

  for (const symbol of SYMBOLS) {
    try { await processSymbol(symbol, state); }
    catch (err) { console.error(`[daily] [${symbol}] error:`, err.message); }
  }

  saveState(state);
  const { apiKey, apiSecret, ...safeCfg } = cfg;
  saveReport({ generatedAt: new Date().toISOString(), state, config: safeCfg });
  console.log("\n[daily] Run complete. Exiting until next scheduled run.");
}

main().catch((err) => { console.error("[daily] fatal error:", err); process.exit(1); });
