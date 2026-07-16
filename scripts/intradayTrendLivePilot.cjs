#!/usr/bin/env node
/**
 * scripts/intradayTrendLivePilot.cjs
 *
 * Live intraday (1h) trend-following (Donchian breakout) bot. SINGLE-SHOT —
 * checks once, acts if needed, exits. Designed to be scheduled to run once
 * per HOUR (not once a day, not continuously) via cron.
 *
 * HONEST STATUS: backtest evidence here is WEAKER than the daily strategy —
 * profit factor 1.03 in one window, 0.87 (negative) in an earlier window.
 * Both were beaten badly by simple buy-and-hold, especially during a rally.
 * This is not a strategy with demonstrated edge. It is being deployed
 * because you decided to, with real capital, after two days of thinking it
 * over — my job here was making sure you had the real picture, which you do.
 *
 * ============ REQUIRED ENV VARS ============
 *   BYBIT_API_KEY=...
 *   BYBIT_API_SECRET=...
 *   BYBIT_TESTNET=false
 *   DRY_RUN=false
 *   ACKNOWLEDGE_INTRADAY_LIVE=true
 *   INTRADAY_SYMBOLS=BTCUSDT,ETHUSDT
 *   INTRADAY_CAPITAL_USDT=64
 *   INTRADAY_LEVERAGE=3
 *
 * ============ RUN MANUALLY ============
 *   node scripts/intradayTrendLivePilot.cjs
 *
 * ============ SCHEDULE TO RUN EVERY HOUR (macOS) ============
 *   crontab -e
 *   Add (runs at the top of every hour):
 *     0 * * * * cd /Users/alinavanempel/Documents/Pionex && \
 *       BYBIT_API_KEY=... BYBIT_API_SECRET=... BYBIT_TESTNET=false DRY_RUN=false \
 *       ACKNOWLEDGE_INTRADAY_LIVE=true node scripts/intradayTrendLivePilot.cjs >> data/intradaytrend/log.txt 2>&1
 *
 * Do NOT run this at the same time as the daily bot's cron job trading the
 * same symbols with real money simultaneously — pick one, or run different
 * symbols on each (e.g. daily on ETHUSDT, intraday on BTCUSDT) to avoid
 * them fighting over the same position.
 *
 * ============ EMERGENCY STOP ============
 *   touch STOP_BOT.txt (shared kill-switch, same as everything else tonight)
 */

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { dailyTrendSignalAt } = require("./dailyTrendStrategy.cjs");

const ROOT = path.join(__dirname, "..");
const STOP_FILE = path.join(ROOT, "STOP_BOT.txt");
const STATE_FILE = path.join(ROOT, "data", "intradaytrend", "state.json");
const REPORT_FILE = path.join(ROOT, "data", "intradaytrend", "report.json");

const SYMBOLS = (process.env.INTRADAY_SYMBOLS || "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim());
const INTERVAL = "60"; // 1h
const PARAMS = { entryLookback: 120, exitLookback: 48, atrPeriod: 20, atrStopMultiple: 2, riskPerTradePct: 0.01 };

const cfg = {
  apiKey: process.env.BYBIT_API_KEY || "",
  apiSecret: process.env.BYBIT_API_SECRET || "",
  testnet: process.env.BYBIT_TESTNET === "true",
  dryRun: process.env.DRY_RUN !== "false",
  ack: process.env.ACKNOWLEDGE_INTRADAY_LIVE === "true",
  capitalUsdt: Number(process.env.INTRADAY_CAPITAL_USDT || 64),
  leverage: Number(process.env.INTRADAY_LEVERAGE || 3),
};

const REST_BASE = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
const notionalPerSymbol = cfg.capitalUsdt / SYMBOLS.length;

// ---------------- Bybit signed REST helper (same pattern as every bot tonight) ----------------

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

async function fetchCandles(symbol, lookbackBars = 200) {
  const q = new URLSearchParams({ category: "linear", symbol, interval: INTERVAL, limit: String(lookbackBars) });
  const json = await bybitPublicGet(`/v5/market/kline?${q}`);
  if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
    throw new Error(`kline fetch failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.result.list
    .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
    .sort((a, b) => a.ts - b.ts);
}

// ---------------- Instrument precision ----------------

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
  console.log(`[intraday] instrument ${symbol}: qtyStep=${qtyStep} minOrderQty=${minOrderQty} tickSize=${tickSize}`);
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
  const rawQty = (notionalPerSymbol * cfg.leverage) / entryPrice;
  const qty = roundQty(rawQty, info);
  const stopLoss = roundPrice(stopPrice, info);
  const orderSide = side === "LONG" ? "Buy" : "Sell";
  const actualNotional = (Number(qty) * entryPrice).toFixed(2);
  console.log(`[intraday] ${cfg.dryRun ? "DRY_RUN " : ""}ENTRY ${side} ${symbol} qty=${qty} (~${actualNotional} USDT, ${cfg.leverage}x) price~${entryPrice} SL=${stopLoss} (no fixed TP)`);
  if (cfg.dryRun) return { simulated: true, qty, stopLoss };
  const json = await bybitPrivatePost("/v5/order/create", { category: "linear", symbol, side: orderSide, orderType: "Market", qty, stopLoss, timeInForce: "IOC" });
  if (json.retCode !== 0) throw new Error("place order failed: " + json.retMsg);
  return json.result;
}
async function closePositionMarket(symbol, qty, positionSide) {
  const info = await getInstrumentInfo(symbol);
  const qtyStr = roundQty(Number(qty), info);
  const closingSide = positionSide === "LONG" ? "Sell" : "Buy";
  console.log(`[intraday] ${cfg.dryRun ? "DRY_RUN " : ""}EXIT (channel break) ${symbol} qty=${qtyStr}`);
  if (cfg.dryRun) return { simulated: true };
  const json = await bybitPrivatePost("/v5/order/create", { category: "linear", symbol, side: closingSide, orderType: "Market", qty: qtyStr, reduceOnly: true, timeInForce: "IOC" });
  if (json.retCode !== 0) throw new Error("close order failed: " + json.retMsg);
  return json.result;
}

// ---------------- Real PnL reconciliation ----------------

async function reconcileClosedPnl(symbol, state) {
  if (cfg.dryRun) return;
  const sym = state.perSymbol[symbol];
  const json = await bybitPrivateGet("/v5/position/closed-pnl", { category: "linear", symbol, limit: "20" });
  if (json.retCode !== 0) { console.error(`[intraday] [${symbol}] closed-pnl fetch failed: ${json.retMsg}`); return; }
  const entries = json.result.list || [];
  if (!sym.lastClosedPnlTs) {
    sym.lastClosedPnlTs = entries.length ? Math.max(...entries.map((e) => Number(e.updatedTime))) : Date.now();
    console.log(`[intraday] [${symbol}] closed-pnl baseline established (${entries.length} historical entries skipped).`);
    return;
  }
  const newEntries = entries.filter((e) => Number(e.updatedTime) > sym.lastClosedPnlTs).sort((a, b) => Number(a.updatedTime) - Number(b.updatedTime));
  for (const e of newEntries) {
    const pnl = Number(e.closedPnl);
    state.realizedPnlUsdt += pnl;
    state.tradesLog = state.tradesLog || [];
    state.tradesLog.push({ symbol, side: e.side, qty: e.qty, avgEntryPrice: e.avgEntryPrice, avgExitPrice: e.avgExitPrice, closedPnl: pnl, closedAt: new Date(Number(e.updatedTime)).toISOString() });
    console.log(`[intraday] [${symbol}] REAL closed PnL: ${pnl.toFixed(4)} USDT (running total: ${state.realizedPnlUsdt.toFixed(4)})`);
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

function abortIf(condition, message) {
  if (condition) { console.error(`[intraday] ABORT: ${message}`); process.exit(1); }
}

// ---------------- Main (single-shot) ----------------

async function processSymbol(symbol, state) {
  await reconcileClosedPnl(symbol, state);

  const exchangePosition = cfg.dryRun ? null : await getOpenPosition(symbol);
  const sym = state.perSymbol[symbol];
  const hasPosition = cfg.dryRun ? !!sym.position : !!exchangePosition;

  const candles = await fetchCandles(symbol, 200);
  const i = candles.length - 1;
  const sig = dailyTrendSignalAt(candles, i, PARAMS);

  if (sig.atr === null) {
    console.log(`[intraday] [${symbol}] not enough history yet.`);
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
      console.log(`[intraday] [${symbol}] channel-break exit triggered.`);
    } else {
      console.log(`[intraday] [${symbol}] holding ${side}, no exit signal this hour. (Native stop-loss still protects regardless.)`);
    }
    return;
  }

  const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
  if (!side) {
    console.log(`[intraday] [${symbol}] no entry signal this hour.`);
    return;
  }

  const entryPrice = candles[i].close;
  const stopDistance = PARAMS.atrStopMultiple * sig.atr;
  const stopPrice = side === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance;
  const result = await placeEntryOrder(symbol, side, entryPrice, stopPrice);
  sym.position = { side, entryPrice, qty: result.qty || null };
  console.log(`[intraday] [${symbol}] ENTRY recorded.`);
}

async function validateCredentials() {
  if (!cfg.apiKey || !cfg.apiSecret) {
    console.log("[intraday] No API key/secret provided — skipping credential check (fine for pure signal testing).");
    return;
  }
  console.log("[intraday] Validating API credentials with a read-only call...");
  const json = await bybitPrivateGet("/v5/account/wallet-balance", { accountType: "UNIFIED" });
  if (json.retCode !== 0) {
    console.error(`[intraday] ABORT: API credential check failed: ${json.retMsg}`);
    process.exit(1);
  }
  console.log("[intraday] API credentials valid.");
}

async function main() {
  console.log("=".repeat(60));
  console.log(`Intraday (1h) Trend Live Pilot — single-shot run — [${SYMBOLS.join(", ")}]`);
  console.log(`Mode: ${cfg.dryRun ? "DRY_RUN (no orders)" : "LIVE — REAL ORDERS"} | Network: ${cfg.testnet ? "TESTNET" : "MAINNET"}`);
  console.log(`Capital: ${cfg.capitalUsdt} USDT total (${notionalPerSymbol.toFixed(2)} per symbol) | Leverage: ${cfg.leverage}x | No fixed take-profit`);
  console.log("=".repeat(60));

  if (fs.existsSync(STOP_FILE)) abortIf(true, "STOP_BOT.txt exists");
  abortIf(!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret), "DRY_RUN=false but API key/secret missing");
  abortIf(!cfg.dryRun && !cfg.ack, "DRY_RUN=false but ACKNOWLEDGE_INTRADAY_LIVE is not 'true'");
  abortIf(!cfg.dryRun && process.env.I_HAVE_A_BACKTESTED_EDGE !== "true", "DRY_RUN=false requires I_HAVE_A_BACKTESTED_EDGE=true — see EDGE_EVIDENCE_TEMPLATE.md");
  abortIf(!cfg.dryRun && !fs.existsSync(path.join(ROOT, "EDGE_EVIDENCE.md")), "DRY_RUN=false requires EDGE_EVIDENCE.md in repo root, filled out per EDGE_EVIDENCE_TEMPLATE.md");

  await validateCredentials();

  const state = loadState();
  if (!cfg.dryRun) for (const s of SYMBOLS) await setLeverage(s);

  for (const symbol of SYMBOLS) {
    try { await processSymbol(symbol, state); }
    catch (err) { console.error(`[intraday] [${symbol}] error:`, err.message); }
  }

  saveState(state);
  const { apiKey, apiSecret, ...safeCfg } = cfg;
  saveReport({ generatedAt: new Date().toISOString(), state, config: safeCfg });
  console.log("\n[intraday] Run complete. Exiting until next scheduled run.");
}

main().catch((err) => { console.error("[intraday] fatal error:", err); process.exit(1); });
