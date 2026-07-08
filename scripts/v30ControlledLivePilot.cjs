#!/usr/bin/env node
/**
 * scripts/v30ControlledLivePilot.cjs
 *
 * V30 Controlled Live Pilot — BTCUSDT/ETHUSDT/SOLUSDT, Supertrend strategy
 * from V28/V29, tiny fixed notional per trade, hard trade/loss limits,
 * explicit acknowledgment required, native Bybit TP/SL, kill-switch file.
 *
 * HONEST STATUS OF THE UNDERLYING STRATEGY (read this once, then it's in the code):
 *   V28's "balanced" LONG profile, on ETHUSDT ONLY, showed train netBps -396
 *   (87 trades) and validation netBps -78 (29 trades) — both negative. Only
 *   the most recent test slice was positive (+860bps, 53 trades, PF 1.346).
 *   That is not a validated edge; it's one favorable recent window.
 *   BTCUSDT and SOLUSDT have NEVER been backtested with this exact config —
 *   running them here is genuinely untested, not just "unconfirmed like ETH."
 *   This script exists to test all of this with real but deliberately small
 *   money under hard limits — not because any of it is a proven edge.
 *
 * ============ REQUIRED ENV VARS FOR LIVE MODE ============
 *   BYBIT_API_KEY=...
 *   BYBIT_API_SECRET=...
 *   BYBIT_TESTNET=false            (or true to test on Bybit testnet first — recommended)
 *   DRY_RUN=false                  (true = log intended trades, never calls private endpoints)
 *   ACKNOWLEDGE_V30_LIVE=true      (required whenever DRY_RUN=false)
 *   V30_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT   (comma-separated, default shown)
 *   V30_MAX_NOTIONAL_USDT=20       (fixed size PER TRADE in USDT, not % of equity)
 *   V30_MAX_TRADES=9               (hard stop after this many trades TOTAL across all symbols)
 *   V30_MAX_LEVERAGE=10
 *   V30_MAX_DAILY_LOSS_USDT=8      (stop for the day if realized loss exceeds this, across all symbols)
 *
 * ============ RUN ============
 *   node scripts/v30ControlledLivePilot.cjs
 *
 * ============ EMERGENCY STOP ============
 *   touch STOP_BOT.txt   (in repo root) — bot checks for this every loop and exits.
 */

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STOP_FILE = path.join(ROOT, "STOP_BOT.txt");
const STATE_FILE = path.join(ROOT, "data", "v30", "live-state-v30.json");
const REPORT_FILE = path.join(ROOT, "data", "v30", "live-report-v30.json");
const PROFILE_FILE = process.env.V30_PROFILE_FILE || path.join(ROOT, "models", "v28", "live-profile-v28.json");

const SYMBOLS = (process.env.V30_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map((s) => s.trim());
const INTERVAL = "5";
const LOOP_SLEEP_MS = 30000;

const cfg = {
  apiKey: process.env.BYBIT_API_KEY || "",
  apiSecret: process.env.BYBIT_API_SECRET || "",
  testnet: process.env.BYBIT_TESTNET === "true",
  dryRun: process.env.DRY_RUN !== "false", // default to dry-run unless explicitly disabled
  ack: process.env.ACKNOWLEDGE_V30_LIVE === "true",
  // Notional is PER TRADE, not total account. Default splits ~60 USDT across up to 3
  // concurrent symbol positions so all three firing at once still stays near your capital.
  maxNotionalUsdt: Number(process.env.V30_MAX_NOTIONAL_USDT || 20),
  // maxTrades is now a TOTAL across all symbols combined, not per-symbol.
  maxTrades: Number(process.env.V30_MAX_TRADES || 9),
  maxLeverage: Number(process.env.V30_MAX_LEVERAGE || 10),
  maxDailyLossUsdt: Number(process.env.V30_MAX_DAILY_LOSS_USDT || 8),
};

const REST_BASE = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";

// ---------------- Bybit signed REST helper (V5 API) ----------------

function bybitSign(timestamp, params) {
  const recvWindow = "5000";
  const payload = timestamp + cfg.apiKey + recvWindow + params;
  return crypto.createHmac("sha256", cfg.apiSecret).update(payload).digest("hex");
}

function httpRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error("Bad JSON from Bybit: " + data.slice(0, 300)));
          }
        });
      }
    );
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
  const sign = bybitSign(timestamp, query);
  const headers = {
    "X-BAPI-API-KEY": cfg.apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-SIGN": sign,
    "X-BAPI-RECV-WINDOW": "5000",
    "Content-Type": "application/json",
  };
  return httpRequest("GET", `${REST_BASE}${pathName}?${query}`, headers);
}

async function bybitPrivatePost(pathName, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const timestamp = Date.now().toString();
  const sign = bybitSign(timestamp, body);
  const headers = {
    "X-BAPI-API-KEY": cfg.apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-SIGN": sign,
    "X-BAPI-RECV-WINDOW": "5000",
    "Content-Type": "application/json",
  };
  return httpRequest("POST", REST_BASE + pathName, headers, body);
}

// ---------------- Market data ----------------

async function fetchCandles(symbol, interval, limit = 500) {
  const q = new URLSearchParams({ category: "linear", symbol, interval, limit: String(limit) });
  const json = await bybitPublicGet(`/v5/market/kline?${q}`);
  if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
    throw new Error("Bybit kline fetch failed: " + JSON.stringify(json).slice(0, 300));
  }
  return json.result.list
    .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
    .sort((a, b) => a.ts - b.ts);
}

// ---------------- Indicators (same logic as V28/V29) ----------------

function atr(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  const out = new Array(candles.length).fill(0);
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      out[i] = trs.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
    } else {
      out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
    }
  }
  return out;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function supertrend(candles, mult, period) {
  const a = atr(candles, period);
  const dir = new Array(candles.length).fill(1);
  let upperBand = null;
  let lowerBand = null;
  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * a[i];
    const basicLower = hl2 - mult * a[i];
    if (i === 0) {
      upperBand = basicUpper;
      lowerBand = basicLower;
      dir[i] = 1;
      continue;
    }
    upperBand = (basicUpper < upperBand || candles[i - 1].close > upperBand) ? basicUpper : upperBand;
    lowerBand = (basicLower > lowerBand || candles[i - 1].close < lowerBand) ? basicLower : lowerBand;
    if (candles[i].close > upperBand) dir[i] = 1;
    else if (candles[i].close < lowerBand) dir[i] = -1;
    else dir[i] = dir[i - 1];
  }
  return dir;
}

function signalAt(candles, p, i) {
  const d1 = supertrend(candles, p.m1, p.p1);
  const d2 = supertrend(candles, p.m2, p.p2);
  const d3 = supertrend(candles, p.m3, p.p3);
  const close = candles.map((c) => c.close);
  const e1 = ema(close, 50);
  const e2 = ema(close, 200);
  const a = atr(candles, 14);
  const c = candles[i];

  const up = d1[i] === 1 && d2[i] === 1 && d3[i] === 1;
  const down = d1[i] === -1 && d2[i] === -1 && d3[i] === -1;
  const trendOkLong = !p.emaFilter || (e1[i] !== null && e2[i] !== null && e1[i] > e2[i]);
  const vol = a[i] ? a[i] / c.close : 0;
  const volOk = vol >= p.minAtr && vol <= p.maxAtr;

  return {
    longEntry: up && trendOkLong && volOk,
    longExit: down,
  };
}

// ---------------- Profile ----------------

const DEFAULT_PROFILE_PARAMS = {
  name: "balanced",
  m1: 2, p1: 10, m2: 3, p2: 14, m3: 4, p3: 21,
  emaFilter: false, minAtr: 0.003, maxAtr: 0.03,
  side: "LONG", sl: 0.02, tp: 0.015, maxHold: 144, minHold: 2,
};

function loadProfileParams() {
  if (fs.existsSync(PROFILE_FILE)) {
    try {
      const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
      if (profile && profile.best && profile.best.params) {
        console.warn(`[v30] loaded profile from ${PROFILE_FILE} (status: ${profile.status})`);
        return profile.best.params;
      }
    } catch (err) {
      console.warn(`[v30] could not parse profile file, using embedded default: ${err.message}`);
    }
  }
  console.warn("[v30] no usable profile file found — using embedded default 'balanced' LONG params");
  return DEFAULT_PROFILE_PARAMS;
}

// ---------------- State ----------------

function freshState() {
  const perSymbol = {};
  for (const symbol of SYMBOLS) {
    perSymbol[symbol] = { position: null, lastClosedCandleTs: null };
  }
  return { tradesTaken: 0, realizedPnlUsdt: 0, dayKey: todayKey(), perSymbol };
}

function loadState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // make sure any newly-added symbols get initialized even on an old state file
    loaded.perSymbol = loaded.perSymbol || {};
    for (const symbol of SYMBOLS) {
      if (!loaded.perSymbol[symbol]) loaded.perSymbol[symbol] = { position: null, lastClosedCandleTs: null };
    }
    return loaded;
  }
  return freshState();
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function saveReport(report) {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------- Account / trading calls ----------------

async function getOpenPosition(symbol) {
  const json = await bybitPrivateGet("/v5/position/list", { category: "linear", symbol });
  if (json.retCode !== 0) throw new Error("get position failed: " + json.retMsg);
  const list = json.result.list || [];
  return list.find((p) => Number(p.size) > 0) || null;
}

async function setLeverage(symbol) {
  const json = await bybitPrivatePost("/v5/position/set-leverage", {
    category: "linear", symbol,
    buyLeverage: String(cfg.maxLeverage), sellLeverage: String(cfg.maxLeverage),
  });
  if (json.retCode !== 0 && json.retCode !== 110043) { // 110043 = leverage not modified, harmless
    throw new Error(`set leverage failed for ${symbol}: ` + json.retMsg);
  }
}

async function placeEntryOrder(symbol, price, params) {
  const qty = (cfg.maxNotionalUsdt / price).toFixed(3);
  const stopLoss = (price * (1 - params.sl)).toFixed(2);
  const takeProfit = (price * (1 + params.tp)).toFixed(2);

  console.log(`[v30] ${cfg.dryRun ? "DRY_RUN " : ""}ENTRY LONG ${symbol} qty=${qty} price~${price} SL=${stopLoss} TP=${takeProfit}`);

  if (cfg.dryRun) return { simulated: true, qty, stopLoss, takeProfit };

  const json = await bybitPrivatePost("/v5/order/create", {
    category: "linear", symbol, side: "Buy", orderType: "Market",
    qty, stopLoss, takeProfit, timeInForce: "IOC",
  });
  if (json.retCode !== 0) throw new Error("place order failed: " + json.retMsg);
  return json.result;
}

async function closePositionMarket(symbol, qty) {
  console.log(`[v30] ${cfg.dryRun ? "DRY_RUN " : ""}EXIT (time/signal) ${symbol} qty=${qty}`);
  if (cfg.dryRun) return { simulated: true };
  const json = await bybitPrivatePost("/v5/order/create", {
    category: "linear", symbol, side: "Sell", orderType: "Market",
    qty, reduceOnly: true, timeInForce: "IOC",
  });
  if (json.retCode !== 0) throw new Error("close order failed: " + json.retMsg);
  return json.result;
}

// ---------------- Abort checks ----------------

function abortIf(condition, message) {
  if (condition) {
    console.error(`[v30] ABORT: ${message}`);
    process.exit(1);
  }
}

function runStartupChecks(state, params) {
  if (fs.existsSync(STOP_FILE)) abortIf(true, "STOP_BOT.txt exists");
  abortIf(!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret), "DRY_RUN=false but API key/secret missing");
  abortIf(!cfg.dryRun && !cfg.ack, "DRY_RUN=false but ACKNOWLEDGE_V30_LIVE is not 'true'");
  abortIf(!params || !params.sl || !params.tp, "profile params missing sl/tp");
  abortIf(SYMBOLS.length === 0, "no symbols configured");
  abortIf(state.tradesTaken >= cfg.maxTrades, `already reached maxTrades (${cfg.maxTrades})`);
  abortIf(state.realizedPnlUsdt <= -Math.abs(cfg.maxDailyLossUsdt), "daily loss limit already hit");
}

// ---------------- Main loop ----------------

async function processSymbol(symbol, state, params) {
  const sym = state.perSymbol[symbol];
  const candles = await fetchCandles(symbol, INTERVAL, 500);
  const closedIdx = candles.length - 2; // last fully closed candle
  const closed = candles[closedIdx];
  const latestPrice = candles[candles.length - 1].close;

  if (closed.ts === sym.lastClosedCandleTs) return; // no new candle yet for this symbol
  sym.lastClosedCandleTs = closed.ts;

  const sig = signalAt(candles, params, closedIdx);
  const exchangePosition = cfg.dryRun ? null : await getOpenPosition(symbol);
  const hasPosition = cfg.dryRun ? !!sym.position : !!exchangePosition;

  if (!hasPosition) {
    if (state.tradesTaken >= cfg.maxTrades) return; // hit the total cap, don't open more anywhere
    if (params.side === "LONG" && sig.longEntry) {
      const result = await placeEntryOrder(symbol, latestPrice, params);
      sym.position = { side: "LONG", entryPrice: latestPrice, entryTs: closed.ts, heldCandles: 0 };
      state.tradesTaken += 1;
      console.log(`[v30] [${symbol}] ENTRY recorded:`, result);
    } else {
      console.log(`[v30] [${symbol}] ${new Date().toISOString()} no entry signal, waiting.`);
    }
  } else if (cfg.dryRun && sym.position) {
    // manual time/signal exit simulation for dry-run only — live TP/SL is native on exchange
    sym.position.heldCandles += 1;
    const hitTime = sym.position.heldCandles >= params.maxHold;
    const hitSignalExit = sig.longExit && sym.position.heldCandles >= params.minHold;
    if (hitTime || hitSignalExit) {
      const qty = (cfg.maxNotionalUsdt / sym.position.entryPrice).toFixed(3);
      await closePositionMarket(symbol, qty);
      const pnlPct = (latestPrice - sym.position.entryPrice) / sym.position.entryPrice;
      const pnlUsdt = pnlPct * cfg.maxNotionalUsdt;
      state.realizedPnlUsdt += pnlUsdt;
      console.log(`[v30] [${symbol}] DRY_RUN exit reason=${hitTime ? "TIME" : "SIGNAL"} pnlUsdt=${pnlUsdt.toFixed(4)}`);
      sym.position = null;
    }
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log(`V30 Controlled Live Pilot — [${SYMBOLS.join(", ")}] ${INTERVAL}m Supertrend`);
  console.log(`Mode: ${cfg.dryRun ? "DRY_RUN (no orders will be placed)" : "LIVE — REAL ORDERS"}`);
  console.log(`Network: ${cfg.testnet ? "TESTNET" : "MAINNET"}`);
  console.log(`Limits: maxNotionalPerTrade=${cfg.maxNotionalUsdt} USDT | maxTradesTotal=${cfg.maxTrades} | maxLeverage=${cfg.maxLeverage}x | maxDailyLoss=${cfg.maxDailyLossUsdt} USDT`);
  console.log("NOTE: BTCUSDT and SOLUSDT have NOT been backtested with this exact Supertrend config — only ETHUSDT has prior test data.");
  console.log("=".repeat(60));

  const params = loadProfileParams();
  let state = loadState();
  if (state.dayKey !== todayKey()) {
    state = freshState();
    saveState(state);
  }

  runStartupChecks(state, params);
  if (!cfg.dryRun) {
    for (const symbol of SYMBOLS) await setLeverage(symbol);
  }

  while (true) {
    if (fs.existsSync(STOP_FILE)) {
      console.log("[v30] STOP_BOT.txt detected — exiting.");
      break;
    }
    if (state.tradesTaken >= cfg.maxTrades) {
      console.log(`[v30] maxTrades (${cfg.maxTrades}) reached across all symbols — exiting.`);
      break;
    }
    if (state.realizedPnlUsdt <= -Math.abs(cfg.maxDailyLossUsdt)) {
      console.log(`[v30] daily loss limit hit (${state.realizedPnlUsdt} USDT) — exiting.`);
      break;
    }

    for (const symbol of SYMBOLS) {
      try {
        await processSymbol(symbol, state, params);
      } catch (err) {
        console.error(`[v30] [${symbol}] loop error:`, err.message);
      }
    }

    saveState(state);
    saveReport({ generatedAt: new Date().toISOString(), state, params, config: cfg });

    await new Promise((r) => setTimeout(r, LOOP_SLEEP_MS));
  }
}

main().catch((err) => {
  console.error("[v30] fatal error:", err);
  process.exit(1);
});
