#!/usr/bin/env node
/**
 * scripts/v33CombinedPilot.cjs
 *
 * V33 Combined Pilot — one script running THREE strategies across
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
 *   ACKNOWLEDGE_V33_LIVE=true
 *   V33_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
 *   V33_STRATEGIES=supertrend,pullback,breakout   (comma list, remove any you don't want)
 *   V33_MAX_NOTIONAL_USDT=20        (per trade)
 *   V33_MAX_TRADES=9                (total, across all symbols+strategies)
 *   V33_MAX_LEVERAGE=10
 *   V33_MAX_DAILY_LOSS_USDT=8
 *   V33_MIN_ST_AGREEMENT=2          (Supertrend: 2-of-3 or 3-of-3)
 *
 * ============ RUN ============
 *   node scripts/v33CombinedPilot.cjs
 *
 * ============ EMERGENCY STOP ============
 *   touch STOP_BOT.txt (same kill-switch as V30/V31 — do not run V30/V31 at
 *   the same time as V33, they'd double up on the same symbols)
 */

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STOP_FILE = path.join(ROOT, "STOP_BOT.txt");
const STATE_FILE = path.join(ROOT, "data", "v33", "live-state-v33.json");
const REPORT_FILE = path.join(ROOT, "data", "v33", "live-report-v33.json");
const PROFILE_FILE = process.env.V30_PROFILE_FILE || path.join(ROOT, "models", "v28", "live-profile-v28.json");

const SYMBOLS = (process.env.V33_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,BNBUSDT").split(",").map((s) => s.trim());
const STRATEGIES = (process.env.V33_STRATEGIES || "supertrend,pullback,breakout").split(",").map((s) => s.trim());
const LOOP_SLEEP_MS = Number(process.env.V33_LOOP_SLEEP_MS || 15000); // now cheap to check often — candle cache skips redundant network calls

// Your total working capital, split evenly across symbols so up to 3 concurrent
// positions stay near this total rather than 3x over it. Override with
// V33_MAX_NOTIONAL_USDT directly if you want a different per-trade size.
const TOTAL_CAPITAL_USDT = Number(process.env.V33_TOTAL_CAPITAL_USDT || 64);

const cfg = {
  apiKey: process.env.BYBIT_API_KEY || "",
  apiSecret: process.env.BYBIT_API_SECRET || "",
  testnet: process.env.BYBIT_TESTNET === "true",
  dryRun: process.env.DRY_RUN !== "false",
  ack: process.env.ACKNOWLEDGE_V33_LIVE === "true",
  maxNotionalUsdt: Number(process.env.V33_MAX_NOTIONAL_USDT || (TOTAL_CAPITAL_USDT / SYMBOLS.length)),
  // No trade-count cap by default — you asked for "trade as much as he wants."
  // The daily loss cap below is what actually protects your capital; it is
  // intentionally NOT removed, because uncapped trades + uncapped losses is
  // the exact combination that produced -46 USDT/552 trades in the original bot.
  maxTrades: Number(process.env.V33_MAX_TRADES || 999999),
  maxLeverage: Number(process.env.V33_MAX_LEVERAGE || 10),
  maxDailyLossUsdt: Number(process.env.V33_MAX_DAILY_LOSS_USDT || 8),
  minAgreement: Number(process.env.V33_MIN_ST_AGREEMENT || 2),
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

// ---------------- Smart candle cache — only re-fetch when a new candle could actually exist ----------------

const candleCache = {};

function intervalMs(interval) {
  return Number(interval) * 60 * 1000;
}

async function getCandles(symbol, interval) {
  candleCache[symbol] = candleCache[symbol] || {};
  const cached = candleCache[symbol][interval];
  const now = Date.now();
  if (cached && now < cached.nextFetchAt) {
    return cached.candles; // no new candle could have closed yet, skip the network call entirely
  }
  const candles = await fetchCandles(symbol, interval, 500);
  const closed = candles[candles.length - 2];
  // FIXED (V33): `closed.ts` is the START time of the last CLOSED candle, so that candle
  // already finished at closed.ts + intervalMs — which is basically "now." The NEXT candle
  // closes one full interval AFTER that, at closed.ts + 2*intervalMs. The V32 version used
  // only +1 interval, which made the cache expire almost immediately — the caching fix looked
  // right but was functionally a no-op, which is why rate-limit errors kept happening at the
  // same frequency as before.
  const nextFetchAt = closed.ts + 2 * intervalMs(interval) + 5000;
  candleCache[symbol][interval] = { candles, nextFetchAt };
  return candles;
}

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

// ---------------- Instrument precision (qty step, min qty, price tick) ----------------

const instrumentInfoCache = {};

function decimalsOf(step) {
  const str = String(step);
  if (str.includes("e-")) return parseInt(str.split("e-")[1], 10);
  const idx = str.indexOf(".");
  return idx === -1 ? 0 : str.length - idx - 1;
}

async function getInstrumentInfo(symbol) {
  if (instrumentInfoCache[symbol]) return instrumentInfoCache[symbol];
  const json = await bybitPublicGet(`/v5/market/instruments-info?category=linear&symbol=${symbol}`);
  if (json.retCode !== 0 || !json.result || !json.result.list || !json.result.list.length) {
    throw new Error(`could not fetch instrument info for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const info = json.result.list[0];
  const qtyStep = parseFloat(info.lotSizeFilter.qtyStep);
  const minOrderQty = parseFloat(info.lotSizeFilter.minOrderQty);
  const tickSize = parseFloat(info.priceFilter.tickSize);
  const cached = { qtyStep, minOrderQty, tickSize, qtyDecimals: decimalsOf(qtyStep), priceDecimals: decimalsOf(tickSize) };
  instrumentInfoCache[symbol] = cached;
  console.log(`[v33] instrument info ${symbol}: qtyStep=${qtyStep} minOrderQty=${minOrderQty} tickSize=${tickSize}`);
  return cached;
}

function roundQty(rawQty, info) {
  const bumped = Math.max(rawQty, info.minOrderQty);
  const stepped = Math.floor(bumped / info.qtyStep) * info.qtyStep;
  return stepped.toFixed(info.qtyDecimals);
}

function roundPrice(rawPrice, info) {
  const stepped = Math.round(rawPrice / info.tickSize) * info.tickSize;
  return stepped.toFixed(info.priceDecimals);
}

// ---------------- Strategy logic ----------------
// FIXED (this refactor): all indicator math and signal functions now live in
// scripts/strategyLogic.cjs and are required here, instead of being
// duplicated inline. The backtester requires the exact same file, so there
// is no way for "what was tested" and "what's running live" to drift apart.

const {
  DEFAULT_ST_PARAMS, supertrendSignal,
  pullbackSignal, breakoutSignal,
  passesFeeGate: sharedPassesFeeGate,
  STRATEGY_FNS,
} = require("./strategyLogic.cjs");

function loadSupertrendParams() {
  if (fs.existsSync(PROFILE_FILE)) {
    try {
      const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
      if (profile && profile.best && profile.best.params) return profile.best.params;
    } catch (err) { /* fall through to default */ }
  }
  return DEFAULT_ST_PARAMS;
}

// Thin wrapper: keeps the same log line behavior as before, but the actual
// pass/fail decision comes from the shared module.
function passesFeeGate(symbol, strategyName, sig) {
  const passes = sharedPassesFeeGate(sig);
  if (!passes) {
    const { FEE_GATE } = require("./strategyLogic.cjs");
    const costBps = FEE_GATE.takerFeeBpsRoundTrip + FEE_GATE.slippageBufferBps;
    const targetBps = sig.tp * 10000;
    console.log(`[v33] [${symbol}/${strategyName}] entry REJECTED by fee gate: target=${targetBps.toFixed(1)}bps too small vs cost=${costBps}bps (needs >= ${(costBps * FEE_GATE.minEdgeMultiple).toFixed(1)}bps)`);
  }
  return passes;
}


// ---------------- State ----------------

function freshState() {
  const perSymbol = {};
  for (const symbol of SYMBOLS) perSymbol[symbol] = { position: null, lastClosedCandleTs: {}, lastReconcileAt: null, lastClosedPnlTs: 0 };
  return { tradesTaken: 0, realizedPnlUsdt: 0, dayKey: todayKey(), perSymbol, tradesLog: [] };
}

function loadState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    loaded.perSymbol = loaded.perSymbol || {};
    loaded.tradesLog = loaded.tradesLog || [];
    for (const symbol of SYMBOLS) {
      if (!loaded.perSymbol[symbol]) loaded.perSymbol[symbol] = { position: null, lastClosedCandleTs: {}, lastReconcileAt: null, lastClosedPnlTs: 0 };
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

// FIXED SAFETY GAP: previously, state.realizedPnlUsdt was only ever updated in the
// DRY_RUN branch. In live mode, nothing read back real fills, so the daily loss cap
// could never actually trigger — it looked active but silently did nothing. This
// pulls REAL realized PnL from Bybit's closed-pnl endpoint, which is ground truth
// (actual fills, actual fees), not an estimate.
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes per symbol

async function reconcileClosedPnl(symbol, state) {
  if (cfg.dryRun) return; // nothing on the exchange to reconcile against
  const sym = state.perSymbol[symbol];
  const now = Date.now();
  if (sym.lastReconcileAt && now - sym.lastReconcileAt < RECONCILE_INTERVAL_MS) return;
  sym.lastReconcileAt = now;

  const json = await bybitPrivateGet("/v5/position/closed-pnl", { category: "linear", symbol, limit: "20" });
  if (json.retCode !== 0) {
    console.error(`[v33] [${symbol}] closed-pnl fetch failed: ${json.retMsg}`);
    return;
  }
  const entries = json.result.list || [];

  // FIXED: on the very first reconciliation for a symbol, establish a baseline instead
  // of backfilling old historical trades (which could be from before this session, or
  // from the maxHold bug period) into today's realizedPnlUsdt / daily loss tracking.
  if (!sym.lastClosedPnlTs) {
    const newestTs = entries.length ? Math.max(...entries.map((e) => Number(e.updatedTime))) : now;
    sym.lastClosedPnlTs = newestTs;
    console.log(`[v33] [${symbol}] closed-pnl baseline established (${entries.length} historical entries skipped, not counted toward today's PnL).`);
    return;
  }

  const lastSeen = sym.lastClosedPnlTs;
  const newEntries = entries.filter((e) => Number(e.updatedTime) > lastSeen).sort((a, b) => Number(a.updatedTime) - Number(b.updatedTime));

  for (const e of newEntries) {
    const pnl = Number(e.closedPnl);
    state.realizedPnlUsdt += pnl;
    state.tradesLog = state.tradesLog || [];
    state.tradesLog.push({
      symbol, side: e.side, qty: e.qty, avgEntryPrice: e.avgEntryPrice, avgExitPrice: e.avgExitPrice,
      closedPnl: pnl, closedAt: new Date(Number(e.updatedTime)).toISOString(),
    });
    console.log(`[v33] [${symbol}] REAL closed PnL recorded: ${pnl.toFixed(4)} USDT (running total: ${state.realizedPnlUsdt.toFixed(4)})`);
    sym.lastClosedPnlTs = Math.max(sym.lastClosedPnlTs, Number(e.updatedTime));
  }
}

async function setLeverage(symbol) {
  const json = await bybitPrivatePost("/v5/position/set-leverage", {
    category: "linear", symbol, buyLeverage: String(cfg.maxLeverage), sellLeverage: String(cfg.maxLeverage),
  });
  if (json.retCode !== 0 && json.retCode !== 110043) throw new Error(`set leverage failed for ${symbol}: ` + json.retMsg);
}

async function placeEntryOrder(symbol, price, sig, side) {
  const info = await getInstrumentInfo(symbol);
  const rawQty = cfg.maxNotionalUsdt / price;
  const qty = roundQty(rawQty, info);
  if (Number(qty) <= 0) {
    console.log(`[v33] [${symbol}] skipping entry — computed qty rounds to 0 even after bumping to minOrderQty (${info.minOrderQty}). Notional too small for this symbol.`);
    return null;
  }
  const rawSl = side === "LONG" ? price * (1 - sig.sl) : price * (1 + sig.sl);
  const rawTp = side === "LONG" ? price * (1 + sig.tp) : price * (1 - sig.tp);
  const stopLoss = roundPrice(rawSl, info);
  const takeProfit = roundPrice(rawTp, info);
  const orderSide = side === "LONG" ? "Buy" : "Sell";
  const actualNotional = (Number(qty) * price).toFixed(2);
  console.log(`[v33] ${cfg.dryRun ? "DRY_RUN " : ""}ENTRY ${side} ${symbol} qty=${qty} (~${actualNotional} USDT notional) price~${price} SL=${stopLoss} TP=${takeProfit}`);
  if (cfg.dryRun) return { simulated: true, qty, stopLoss, takeProfit };
  const json = await bybitPrivatePost("/v5/order/create", {
    category: "linear", symbol, side: orderSide, orderType: "Market", qty, stopLoss, takeProfit, timeInForce: "IOC",
  });
  if (json.retCode !== 0) throw new Error("place order failed: " + json.retMsg);
  return json.result;
}

async function closePositionMarket(symbol, qty, positionSide) {
  const closingSide = positionSide === "LONG" ? "Sell" : "Buy"; // opposite side, reduceOnly
  const info = await getInstrumentInfo(symbol);
  const qtyStr = roundQty(Number(qty), info);
  console.log(`[v33] ${cfg.dryRun ? "DRY_RUN " : ""}EXIT ${positionSide} ${symbol} qty=${qtyStr}`);
  if (cfg.dryRun) return { simulated: true };
  const json = await bybitPrivatePost("/v5/order/create", {
    category: "linear", symbol, side: closingSide, orderType: "Market", qty: qtyStr, reduceOnly: true, timeInForce: "IOC",
  });
  if (json.retCode !== 0) throw new Error("close order failed: " + json.retMsg);
  return json.result;
}

// ---------------- Abort checks ----------------

function abortIf(condition, message) {
  if (condition) { console.error(`[v33] ABORT: ${message}`); process.exit(1); }
}

function runStartupChecks(state) {
  if (fs.existsSync(STOP_FILE)) abortIf(true, "STOP_BOT.txt exists");
  abortIf(!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret), "DRY_RUN=false but API key/secret missing");
  abortIf(!cfg.dryRun && !cfg.ack, "DRY_RUN=false but ACKNOWLEDGE_V33_LIVE is not 'true'");
  abortIf(SYMBOLS.length === 0, "no symbols configured");
  abortIf(STRATEGIES.some((s) => !STRATEGY_FNS[s]), `unknown strategy in V33_STRATEGIES: ${STRATEGIES.join(",")}`);
  abortIf(state.tradesTaken >= cfg.maxTrades, `already reached maxTrades (${cfg.maxTrades})`);
  abortIf(state.realizedPnlUsdt <= -Math.abs(cfg.maxDailyLossUsdt), "daily loss limit already hit");
}

// ---------------- Main loop ----------------

async function processSymbol(symbol, state, supertrendParams) {
  const sym = state.perSymbol[symbol];
  await reconcileClosedPnl(symbol, state);

  const exchangePosition = cfg.dryRun ? null : await getOpenPosition(symbol);
  const hasPosition = cfg.dryRun ? !!sym.position : !!exchangePosition;

  if (hasPosition && sym.position) {
    const interval = STRATEGY_FNS[sym.position.strategy].interval;
    const candles = await getCandles(symbol, interval);
    const idx = candles.length - 2;
    const strategyFn = STRATEGY_FNS[sym.position.strategy].fn;
    const sig = strategyFn(candles, idx, supertrendParams, cfg.minAgreement);

    // FIXED: heldCandles is derived from actual elapsed time / interval, not incremented
    // once per 30s loop tick. The old version could close a "100 candle" hold after ~50
    // minutes of wall-clock time instead of the intended ~25 hours on a 15m strategy.
    const heldCandles = Math.floor((Date.now() - sym.position.entryTs) / intervalMs(interval));

    const isLong = sym.position.side === "LONG";
    const exitSignal = isLong ? sig.longExit : sig.shortExit;
    const hitTime = heldCandles >= sig.maxHold;
    const hitExit = exitSignal && heldCandles >= sig.minHold;

    if (cfg.dryRun && (hitTime || hitExit)) {
      const latestPrice = candles[candles.length - 1].close;
      const qty = (cfg.maxNotionalUsdt / sym.position.entryPrice).toFixed(3);
      await closePositionMarket(symbol, qty, sym.position.side);
      const priceDelta = isLong ? (latestPrice - sym.position.entryPrice) : (sym.position.entryPrice - latestPrice);
      const pnlUsdt = (priceDelta / sym.position.entryPrice) * cfg.maxNotionalUsdt;
      state.realizedPnlUsdt += pnlUsdt;
      console.log(`[v33] [${symbol}/${sym.position.strategy}] DRY_RUN exit reason=${hitTime ? "TIME" : "EXIT_SIGNAL"} heldCandles=${heldCandles}/${sig.maxHold} pnlUsdt=${pnlUsdt.toFixed(4)}`);
      sym.position = null;
    } else if (!cfg.dryRun && hitTime) {
      const qty = (cfg.maxNotionalUsdt / sym.position.entryPrice).toFixed(3);
      await closePositionMarket(symbol, qty, sym.position.side);
      console.log(`[v33] [${symbol}/${sym.position.strategy}] time-stop close (held ${heldCandles}/${sig.maxHold} candles, ~${((Date.now() - sym.position.entryTs) / 3600000).toFixed(1)}h).`);
      sym.position = null;
    }
    return;
  }

  if (state.tradesTaken >= cfg.maxTrades) return;

  for (const strategyName of STRATEGIES) {
    const strategyDef = STRATEGY_FNS[strategyName];
    const candles = await getCandles(symbol, strategyDef.interval);
    const idx = candles.length - 2;
    const closed = candles[idx];
    if (closed.ts === sym.lastClosedCandleTs[strategyName]) continue;
    sym.lastClosedCandleTs[strategyName] = closed.ts;

    const sig = strategyDef.fn(candles, idx, supertrendParams, cfg.minAgreement);
    const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
    if (side && !passesFeeGate(symbol, strategyName, sig)) continue; // signal fired but reward too small vs cost — skip
    if (side) {
      const latestPrice = candles[candles.length - 1].close;
      const result = await placeEntryOrder(symbol, latestPrice, sig, side);
      if (result === null) continue; // skipped: notional too small for this symbol's minimum, try next strategy
      sym.position = { strategy: strategyName, side, entryPrice: latestPrice, entryTs: Date.now(), heldCandles: 0 };
      state.tradesTaken += 1;
      console.log(`[v33] [${symbol}/${strategyName}] ENTRY recorded:`, result);
      break;
    } else {
      console.log(`[v33] [${symbol}/${strategyName}] ${new Date().toISOString()} no entry signal, waiting.`);
    }
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log(`V33 Combined Pilot — symbols=[${SYMBOLS.join(", ")}] strategies=[${STRATEGIES.join(", ")}]`);
  console.log(`Mode: ${cfg.dryRun ? "DRY_RUN (no orders will be placed)" : "LIVE — REAL ORDERS"}`);
  console.log(`Network: ${cfg.testnet ? "TESTNET" : "MAINNET"}`);
  console.log(`Limits: maxNotionalPerTrade=${cfg.maxNotionalUsdt.toFixed(2)} USDT | maxTradesTotal=${cfg.maxTrades} | maxLeverage=${cfg.maxLeverage}x | maxDailyLoss=${cfg.maxDailyLossUsdt} USDT`);
  console.log("NOTE: pullback and breakout are NEW, UNVALIDATED implementations. Supertrend is ETH-tested only.");
  console.log("Rule: one strategy per symbol at a time — whichever signals first claims it.");
  console.log("=".repeat(60));

  const supertrendParams = loadSupertrendParams();
  let state = loadState();
  if (state.dayKey !== todayKey()) { state = freshState(); saveState(state); }

  runStartupChecks(state);
  for (const symbol of SYMBOLS) await getInstrumentInfo(symbol);
  if (!cfg.dryRun) for (const symbol of SYMBOLS) await setLeverage(symbol);

  while (true) {
    if (fs.existsSync(STOP_FILE)) { console.log("[v33] STOP_BOT.txt detected — exiting."); break; }
    if (state.tradesTaken >= cfg.maxTrades) { console.log(`[v33] maxTrades (${cfg.maxTrades}) reached — exiting.`); break; }
    if (state.realizedPnlUsdt <= -Math.abs(cfg.maxDailyLossUsdt)) { console.log(`[v33] daily loss limit hit — exiting.`); break; }

    for (const symbol of SYMBOLS) {
      try { await processSymbol(symbol, state, supertrendParams); }
      catch (err) { console.error(`[v33] [${symbol}] loop error:`, err.message); }
      await new Promise((r) => setTimeout(r, 500)); // small stagger to avoid rate-limit bursts
    }

    saveState(state);
    saveReport({ generatedAt: new Date().toISOString(), state, config: cfg });
    await new Promise((r) => setTimeout(r, LOOP_SLEEP_MS));
  }
}

main().catch((err) => { console.error("[v33] fatal error:", err); process.exit(1); });
