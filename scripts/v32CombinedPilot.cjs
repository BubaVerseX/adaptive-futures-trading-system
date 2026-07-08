#!/usr/bin/env node
/**
 * scripts/v32CombinedPilot.cjs
 *
 * V32 Combined Pilot — one script running THREE strategies across
 * BTCUSDT/ETHUSDT/SOLUSDT: Supertrend (V30), Pullback (V31), and a new
 * Donchian Breakout strategy. Replaces running V30 and V31 as two separate
 * processes — same safety rails, one terminal, one state file.
 *
 * HONEST STATUS OF EACH STRATEGY:
 *   - Supertrend: tested on ETHUSDT only (V28). Train/validation were
 *     negative, only the most recent test slice was positive. Running on
 *     BTC/SOL too is untested.
 *   - Pullback: inspired by your V23.1 backtest results (+5055 net, 1yr real
 *     data) but this is a NEW implementation — not the original code, not
 *     independently validated.
 *   - Breakout: brand new, inspired by your V22 TrendBreakout concept, has
 *     NEVER been backtested at all. Least evidence of the three.
 *   None of this is a recommendation to run it — it's what you asked for,
 *   built as honestly as I can describe it.
 *
 * SAME-SYMBOL CONFLICT RULE:
 *   Only one strategy may hold a position on a given symbol at a time.
 *   Whichever signals first claims that symbol; others skip entries on it
 *   until the position closes. This avoids Bybit netting two strategies'
 *   positions into one confusing merged position.
 *
 * ============ ENV VARS ============
 *   BYBIT_API_KEY=...
 *   BYBIT_API_SECRET=...
 *   BYBIT_TESTNET=false
 *   DRY_RUN=false
 *   ACKNOWLEDGE_V32_LIVE=true
 *   V32_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
 *   V32_STRATEGIES=supertrend,pullback,breakout   (comma list, remove any you don't want)
 *   V32_MAX_NOTIONAL_USDT=20        (per trade)
 *   V32_MAX_TRADES=9                (total, across all symbols+strategies)
 *   V32_MAX_LEVERAGE=10
 *   V32_MAX_DAILY_LOSS_USDT=8
 *   V32_MIN_ST_AGREEMENT=2          (Supertrend: 2-of-3 or 3-of-3)
 *
 * ============ RUN ============
 *   node scripts/v32CombinedPilot.cjs
 *
 * ============ EMERGENCY STOP ============
 *   touch STOP_BOT.txt (same kill-switch as V30/V31 — do not run V30/V31 at
 *   the same time as V32, they'd double up on the same symbols)
 */

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STOP_FILE = path.join(ROOT, "STOP_BOT.txt");
const STATE_FILE = path.join(ROOT, "data", "v32", "live-state-v32.json");
const REPORT_FILE = path.join(ROOT, "data", "v32", "live-report-v32.json");
const PROFILE_FILE = process.env.V30_PROFILE_FILE || path.join(ROOT, "models", "v28", "live-profile-v28.json");

const SYMBOLS = (process.env.V32_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map((s) => s.trim());
const STRATEGIES = (process.env.V32_STRATEGIES || "supertrend,pullback,breakout").split(",").map((s) => s.trim());
const LOOP_SLEEP_MS = 30000;

const cfg = {
  apiKey: process.env.BYBIT_API_KEY || "",
  apiSecret: process.env.BYBIT_API_SECRET || "",
  testnet: process.env.BYBIT_TESTNET === "true",
  dryRun: process.env.DRY_RUN !== "false",
  ack: process.env.ACKNOWLEDGE_V32_LIVE === "true",
  // Sized so 3 concurrent positions (one per symbol, per the conflict rule below) totals ~64 USDT.
  maxNotionalUsdt: Number(process.env.V32_MAX_NOTIONAL_USDT || 21),
  // No trade-count cap by default — you asked for "trade as much as he wants."
  // The daily loss cap below is what actually protects your capital; it is
  // intentionally NOT removed, because uncapped trades + uncapped losses is
  // the exact combination that produced -46 USDT/552 trades in the original bot.
  maxTrades: Number(process.env.V32_MAX_TRADES || 999999),
  maxLeverage: Number(process.env.V32_MAX_LEVERAGE || 10),
  maxDailyLossUsdt: Number(process.env.V32_MAX_DAILY_LOSS_USDT || 8),
  minAgreement: Number(process.env.V32_MIN_ST_AGREEMENT || 2),
};

const REST_BASE = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";

// ---------------- Bybit signed REST helper (V5 API) ----------------

function bybitSign(timestamp, params) {
  const payload = timestamp + cfg.apiKey + "5000" + params;
  return crypto.createHmac("sha256", cfg.apiSecret).update(payload).digest("hex");
}

function httpRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Bad JSON from Bybit: " + data.slice(0, 300))); }
      });
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
  const headers = {
    "X-BAPI-API-KEY": cfg.apiKey, "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-SIGN": bybitSign(timestamp, query), "X-BAPI-RECV-WINDOW": "5000", "Content-Type": "application/json",
  };
  return httpRequest("GET", `${REST_BASE}${pathName}?${query}`, headers);
}

async function bybitPrivatePost(pathName, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const timestamp = Date.now().toString();
  const headers = {
    "X-BAPI-API-KEY": cfg.apiKey, "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-SIGN": bybitSign(timestamp, body), "X-BAPI-RECV-WINDOW": "5000", "Content-Type": "application/json",
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

// ---------------- Shared indicators ----------------

function atr(candles, period) {
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low :
    Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  const out = new Array(candles.length).fill(0);
  for (let i = 0; i < trs.length; i++) {
    out[i] = i < period ? trs.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1) : (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    prev = prev === null ? values.slice(0, period).reduce((a, b) => a + b, 0) / period : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function supertrendDir(candles, mult, period) {
  const a = atr(candles, period);
  const dir = new Array(candles.length).fill(1);
  let upperBand = null, lowerBand = null;
  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * a[i];
    const basicLower = hl2 - mult * a[i];
    if (i === 0) { upperBand = basicUpper; lowerBand = basicLower; dir[i] = 1; continue; }
    upperBand = (basicUpper < upperBand || candles[i - 1].close > upperBand) ? basicUpper : upperBand;
    lowerBand = (basicLower > lowerBand || candles[i - 1].close < lowerBand) ? basicLower : lowerBand;
    if (candles[i].close > upperBand) dir[i] = 1;
    else if (candles[i].close < lowerBand) dir[i] = -1;
    else dir[i] = dir[i - 1];
  }
  return dir;
}

// ---------------- Strategy 1: Supertrend (from V28/V30) ----------------

const DEFAULT_ST_PARAMS = {
  m1: 2, p1: 10, m2: 3, p2: 14, m3: 4, p3: 21,
  emaFilter: false, minAtr: 0.003, maxAtr: 0.03,
  sl: 0.02, tp: 0.015, maxHold: 144, minHold: 2,
};

function loadSupertrendParams() {
  if (fs.existsSync(PROFILE_FILE)) {
    try {
      const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
      if (profile && profile.best && profile.best.params) return profile.best.params;
    } catch (err) { /* fall through to default */ }
  }
  return DEFAULT_ST_PARAMS;
}

function supertrendSignal(candles, i, p) {
  const d1 = supertrendDir(candles, p.m1, p.p1);
  const d2 = supertrendDir(candles, p.m2, p.p2);
  const d3 = supertrendDir(candles, p.m3, p.p3);
  const close = candles.map((c) => c.close);
  const e1 = ema(close, 50);
  const e2 = ema(close, 200);
  const a = atr(candles, 14);
  const votesUp = [d1[i], d2[i], d3[i]].filter((v) => v === 1).length;
  const votesDown = [d1[i], d2[i], d3[i]].filter((v) => v === -1).length;
  const up = votesUp >= cfg.minAgreement;
  const down = votesDown >= cfg.minAgreement;
  const trendOkLong = !p.emaFilter || (e1[i] !== null && e2[i] !== null && e1[i] > e2[i]);
  const trendOkShort = !p.emaFilter || (e1[i] !== null && e2[i] !== null && e1[i] < e2[i]);
  const vol = a[i] ? a[i] / candles[i].close : 0;
  const volOk = vol >= p.minAtr && vol <= p.maxAtr;
  return {
    longEntry: up && trendOkLong && volOk, longExit: down,
    shortEntry: down && trendOkShort && volOk, shortExit: up,
    sl: p.sl, tp: p.tp, maxHold: p.maxHold, minHold: p.minHold,
  };
}

// ---------------- Strategy 2: Pullback (from V31) ----------------

const PULLBACK_PARAMS = { sl: 0.02, tp: 0.03, maxHold: 100, minHold: 1 };

function pullbackSignal(candles, i) {
  const close = candles.map((c) => c.close);
  const e20 = ema(close, 20), e50 = ema(close, 50), e200 = ema(close, 200);
  if (e20[i] === null || e50[i] === null || e200[i] === null || e20[i - 1] === null) {
    return { longEntry: false, longExit: false, shortEntry: false, shortExit: false, ...PULLBACK_PARAMS };
  }
  const uptrend = e50[i] > e200[i];
  const downtrend = e50[i] < e200[i];
  const wasPulledBackDown = close[i - 1] < e20[i - 1]; // dipped below in an uptrend
  const wasPulledBackUp = close[i - 1] > e20[i - 1];   // popped above in a downtrend
  const resolvedUp = close[i] > e20[i];
  const resolvedDown = close[i] < e20[i];
  return {
    longEntry: uptrend && wasPulledBackDown && resolvedUp, longExit: e50[i] < e200[i],
    shortEntry: downtrend && wasPulledBackUp && resolvedDown, shortExit: e50[i] > e200[i],
    ...PULLBACK_PARAMS,
  };
}

// ---------------- Strategy 3: Donchian Breakout (new) ----------------

const BREAKOUT_PARAMS = { sl: 0.025, tp: 0.04, maxHold: 80, minHold: 1, donchianPeriod: 20, volumeMultiple: 1.2 };

function breakoutSignal(candles, i) {
  const p = BREAKOUT_PARAMS.donchianPeriod;
  if (i < p + 1) return { longEntry: false, longExit: false, shortEntry: false, shortExit: false, ...BREAKOUT_PARAMS };
  const window = candles.slice(i - p, i); // prior N candles, excludes current
  const priorHigh = Math.max(...window.map((c) => c.high));
  const priorLow = Math.min(...window.map((c) => c.low));
  const priorMid = (priorHigh + priorLow) / 2;
  const avgVolume = window.reduce((a, c) => a + c.volume, 0) / window.length;
  const breakoutUp = candles[i].close > priorHigh;
  const breakoutDown = candles[i].close < priorLow;
  const volumeConfirmed = candles[i].volume > avgVolume * BREAKOUT_PARAMS.volumeMultiple;
  return {
    longEntry: breakoutUp && volumeConfirmed, longExit: candles[i].close < priorMid,
    shortEntry: breakoutDown && volumeConfirmed, shortExit: candles[i].close > priorMid,
    ...BREAKOUT_PARAMS,
  };
}

// ---------------- Strategy registry ----------------

const STRATEGY_FNS = {
  supertrend: { interval: "5", needParams: true, fn: (candles, i, params) => supertrendSignal(candles, i, params) },
  pullback: { interval: "15", needParams: false, fn: (candles, i) => pullbackSignal(candles, i) },
  breakout: { interval: "15", needParams: false, fn: (candles, i) => breakoutSignal(candles, i) },
};

// ---------------- State ----------------

function freshState() {
  const perSymbol = {};
  for (const symbol of SYMBOLS) perSymbol[symbol] = { position: null, lastClosedCandleTs: {} };
  return { tradesTaken: 0, realizedPnlUsdt: 0, dayKey: todayKey(), perSymbol };
}

function loadState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    loaded.perSymbol = loaded.perSymbol || {};
    for (const symbol of SYMBOLS) {
      if (!loaded.perSymbol[symbol]) loaded.perSymbol[symbol] = { position: null, lastClosedCandleTs: {} };
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

function todayKey() { return new Date().toISOString().slice(0, 10); }

// ---------------- Account / trading calls ----------------

async function getOpenPosition(symbol) {
  const json = await bybitPrivateGet("/v5/position/list", { category: "linear", symbol });
  if (json.retCode !== 0) throw new Error("get position failed: " + json.retMsg);
  return (json.result.list || []).find((p) => Number(p.size) > 0) || null;
}

async function setLeverage(symbol) {
  const json = await bybitPrivatePost("/v5/position/set-leverage", {
    category: "linear", symbol, buyLeverage: String(cfg.maxLeverage), sellLeverage: String(cfg.maxLeverage),
  });
  if (json.retCode !== 0 && json.retCode !== 110043) throw new Error(`set leverage failed for ${symbol}: ` + json.retMsg);
}

async function placeEntryOrder(symbol, price, sig, side) {
  const qty = (cfg.maxNotionalUsdt / price).toFixed(3);
  const stopLoss = side === "LONG" ? (price * (1 - sig.sl)).toFixed(2) : (price * (1 + sig.sl)).toFixed(2);
  const takeProfit = side === "LONG" ? (price * (1 + sig.tp)).toFixed(2) : (price * (1 - sig.tp)).toFixed(2);
  const orderSide = side === "LONG" ? "Buy" : "Sell";
  console.log(`[v32] ${cfg.dryRun ? "DRY_RUN " : ""}ENTRY ${side} ${symbol} qty=${qty} price~${price} SL=${stopLoss} TP=${takeProfit}`);
  if (cfg.dryRun) return { simulated: true, qty, stopLoss, takeProfit };
  const json = await bybitPrivatePost("/v5/order/create", {
    category: "linear", symbol, side: orderSide, orderType: "Market", qty, stopLoss, takeProfit, timeInForce: "IOC",
  });
  if (json.retCode !== 0) throw new Error("place order failed: " + json.retMsg);
  return json.result;
}

async function closePositionMarket(symbol, qty, positionSide) {
  const closingSide = positionSide === "LONG" ? "Sell" : "Buy"; // opposite side, reduceOnly
  console.log(`[v32] ${cfg.dryRun ? "DRY_RUN " : ""}EXIT ${positionSide} ${symbol} qty=${qty}`);
  if (cfg.dryRun) return { simulated: true };
  const json = await bybitPrivatePost("/v5/order/create", {
    category: "linear", symbol, side: closingSide, orderType: "Market", qty, reduceOnly: true, timeInForce: "IOC",
  });
  if (json.retCode !== 0) throw new Error("close order failed: " + json.retMsg);
  return json.result;
}

// ---------------- Abort checks ----------------

function abortIf(condition, message) {
  if (condition) { console.error(`[v32] ABORT: ${message}`); process.exit(1); }
}

function runStartupChecks(state) {
  if (fs.existsSync(STOP_FILE)) abortIf(true, "STOP_BOT.txt exists");
  abortIf(!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret), "DRY_RUN=false but API key/secret missing");
  abortIf(!cfg.dryRun && !cfg.ack, "DRY_RUN=false but ACKNOWLEDGE_V32_LIVE is not 'true'");
  abortIf(SYMBOLS.length === 0, "no symbols configured");
  abortIf(STRATEGIES.some((s) => !STRATEGY_FNS[s]), `unknown strategy in V32_STRATEGIES: ${STRATEGIES.join(",")}`);
  abortIf(state.tradesTaken >= cfg.maxTrades, `already reached maxTrades (${cfg.maxTrades})`);
  abortIf(state.realizedPnlUsdt <= -Math.abs(cfg.maxDailyLossUsdt), "daily loss limit already hit");
}

// ---------------- Main loop ----------------

async function processSymbol(symbol, state, supertrendParams) {
  const sym = state.perSymbol[symbol];
  const candlesByInterval = {};

  const exchangePosition = cfg.dryRun ? null : await getOpenPosition(symbol);
  const hasPosition = cfg.dryRun ? !!sym.position : !!exchangePosition;

  if (hasPosition && sym.position) {
    const interval = STRATEGY_FNS[sym.position.strategy].interval;
    if (!candlesByInterval[interval]) candlesByInterval[interval] = await fetchCandles(symbol, interval, 500);
    const candles = candlesByInterval[interval];
    const idx = candles.length - 2;
    const strategyFn = STRATEGY_FNS[sym.position.strategy].fn;
    const sig = strategyFn(candles, idx, supertrendParams);
    sym.position.heldCandles += 1;
    const isLong = sym.position.side === "LONG";
    const exitSignal = isLong ? sig.longExit : sig.shortExit;
    const hitTime = sym.position.heldCandles >= sig.maxHold;
    const hitExit = exitSignal && sym.position.heldCandles >= sig.minHold;
    if (cfg.dryRun && (hitTime || hitExit)) {
      const latestPrice = candles[candles.length - 1].close;
      const qty = (cfg.maxNotionalUsdt / sym.position.entryPrice).toFixed(3);
      await closePositionMarket(symbol, qty, sym.position.side);
      const priceDelta = isLong ? (latestPrice - sym.position.entryPrice) : (sym.position.entryPrice - latestPrice);
      const pnlUsdt = (priceDelta / sym.position.entryPrice) * cfg.maxNotionalUsdt;
      state.realizedPnlUsdt += pnlUsdt;
      console.log(`[v32] [${symbol}/${sym.position.strategy}] DRY_RUN exit reason=${hitTime ? "TIME" : "EXIT_SIGNAL"} pnlUsdt=${pnlUsdt.toFixed(4)}`);
      sym.position = null;
    } else if (!cfg.dryRun && hitTime) {
      const qty = (cfg.maxNotionalUsdt / sym.position.entryPrice).toFixed(3);
      await closePositionMarket(symbol, qty, sym.position.side);
      console.log(`[v32] [${symbol}/${sym.position.strategy}] time-stop close.`);
      sym.position = null;
    }
    return;
  }

  if (state.tradesTaken >= cfg.maxTrades) return;

  for (const strategyName of STRATEGIES) {
    const strategyDef = STRATEGY_FNS[strategyName];
    if (!candlesByInterval[strategyDef.interval]) {
      candlesByInterval[strategyDef.interval] = await fetchCandles(symbol, strategyDef.interval, 500);
    }
    const candles = candlesByInterval[strategyDef.interval];
    const idx = candles.length - 2;
    const closed = candles[idx];
    if (closed.ts === sym.lastClosedCandleTs[strategyName]) continue;
    sym.lastClosedCandleTs[strategyName] = closed.ts;

    const sig = strategyDef.fn(candles, idx, supertrendParams);
    const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
    if (side) {
      const latestPrice = candles[candles.length - 1].close;
      const result = await placeEntryOrder(symbol, latestPrice, sig, side);
      sym.position = { strategy: strategyName, side, entryPrice: latestPrice, entryTs: closed.ts, heldCandles: 0 };
      state.tradesTaken += 1;
      console.log(`[v32] [${symbol}/${strategyName}] ENTRY recorded:`, result);
      break;
    } else {
      console.log(`[v32] [${symbol}/${strategyName}] ${new Date().toISOString()} no entry signal, waiting.`);
    }
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log(`V32 Combined Pilot — symbols=[${SYMBOLS.join(", ")}] strategies=[${STRATEGIES.join(", ")}]`);
  console.log(`Mode: ${cfg.dryRun ? "DRY_RUN (no orders will be placed)" : "LIVE — REAL ORDERS"}`);
  console.log(`Network: ${cfg.testnet ? "TESTNET" : "MAINNET"}`);
  console.log(`Limits: maxNotionalPerTrade=${cfg.maxNotionalUsdt} USDT | maxTradesTotal=${cfg.maxTrades} | maxLeverage=${cfg.maxLeverage}x | maxDailyLoss=${cfg.maxDailyLossUsdt} USDT`);
  console.log("NOTE: pullback and breakout are NEW, UNVALIDATED implementations. Supertrend is ETH-tested only.");
  console.log("Rule: one strategy per symbol at a time — whichever signals first claims it.");
  console.log("=".repeat(60));

  const supertrendParams = loadSupertrendParams();
  let state = loadState();
  if (state.dayKey !== todayKey()) { state = freshState(); saveState(state); }

  runStartupChecks(state);
  if (!cfg.dryRun) for (const symbol of SYMBOLS) await setLeverage(symbol);

  while (true) {
    if (fs.existsSync(STOP_FILE)) { console.log("[v32] STOP_BOT.txt detected — exiting."); break; }
    if (state.tradesTaken >= cfg.maxTrades) { console.log(`[v32] maxTrades (${cfg.maxTrades}) reached — exiting.`); break; }
    if (state.realizedPnlUsdt <= -Math.abs(cfg.maxDailyLossUsdt)) { console.log(`[v32] daily loss limit hit — exiting.`); break; }

    for (const symbol of SYMBOLS) {
      try { await processSymbol(symbol, state, supertrendParams); }
      catch (err) { console.error(`[v32] [${symbol}] loop error:`, err.message); }
    }

    saveState(state);
    saveReport({ generatedAt: new Date().toISOString(), state, config: cfg });
    await new Promise((r) => setTimeout(r, LOOP_SLEEP_MS));
  }
}

main().catch((err) => { console.error("[v32] fatal error:", err); process.exit(1); });
