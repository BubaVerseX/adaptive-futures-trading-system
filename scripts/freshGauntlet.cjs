#!/usr/bin/env node
/**
 * scripts/freshGauntlet.cjs
 *
 * Runs the core strategy suite (supertrend, pullback, breakout, daily-trend
 * Donchian) through the same 4-criteria gauntlet used for the regime-gated
 * pullback test (see EDGE_EVIDENCE_TEMPLATE.md / backtestRegimeGatedPullback.cjs),
 * on BTCUSDT/ETHUSDT/SOLUSDT, two non-overlapping windows of recent data.
 *
 * Public Bybit data only, read-only, no API key needed.
 *
 * ============ USAGE ============
 *   node scripts/freshGauntlet.cjs
 *   node scripts/freshGauntlet.cjs --no-cache
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { STRATEGY_FNS, DEFAULT_ST_PARAMS, intervalMs, passesFeeGate, atr, ema, supertrendDir, PULLBACK_PARAMS, breakoutSignal } = require("./strategyLogic.cjs");
const { dailyTrendSignalAt, DAILY_TREND_PARAMS } = require("./dailyTrendStrategy.cjs");

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const WINDOW_DAYS = 120;
const WINDOW_SHORT_DAYS = 40; // supplementary recent-only window, requested alongside (not instead of) the standard two
const WARMUP_DAYS = 50;
const INTRADAY_FEE_BPS = 14;
const INTRADAY_STRESS_FEE_BPS = 21; // 1.5x
const DAILY_FEE_BPS = 28; // 2x intraday, per instructions
const DAILY_STRESS_FEE_BPS = 42; // 1.5x
const MIN_AGREEMENT = 2;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    noCache: args.includes("--no-cache"),
    cacheDir: path.join(__dirname, "..", "data", "freshgauntlet"),
  };
}

// ---------------- Data fetch ----------------

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Bad JSON: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function fetchCandles(symbol, interval, days) {
  const REST_BASE = "https://api.bybit.com";
  const stepMs = interval === "D" ? 24 * 60 * 60 * 1000 : intervalMs(interval);
  const limit = 1000;
  const windowEnd = Date.now();
  const wantedStart = windowEnd - days * 24 * 60 * 60 * 1000;
  let endTime = windowEnd;
  const seen = new Set();
  const out = [];
  while (endTime > wantedStart) {
    const startTime = Math.max(wantedStart, endTime - limit * stepMs);
    const url = `${REST_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&start=${startTime}&end=${endTime}&limit=${limit}`;
    const json = await httpGetJson(url);
    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
      throw new Error(`kline fetch failed for ${symbol}@${interval}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const rows = json.result.list
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .sort((a, b) => a.ts - b.ts);
    if (!rows.length) break;
    for (const c of rows) if (!seen.has(c.ts) && c.close > 0) { seen.add(c.ts); out.push(c); }
    const firstTs = rows[0].ts;
    const nextEnd = firstTs - stepMs;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    await new Promise((r) => setTimeout(r, 150));
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

async function fetchCandlesCached(symbol, interval, days, cacheDir, noCache) {
  const cacheFile = path.join(cacheDir, `${symbol}-${interval}-${days}d.json`);
  if (!noCache && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs < 6 * 60 * 60 * 1000) return cached.candles;
  }
  const candles = await fetchCandles(symbol, interval, days);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), candles }));
  return candles;
}

// ---------------- Windows ----------------

function computeWindows(lastTs, windowDays, shortWindowDays) {
  const dayMs = 24 * 60 * 60 * 1000;
  const w1End = lastTs + 1;
  const w1Start = w1End - windowDays * dayMs;
  const w2End = w1Start;
  const w2Start = w2End - windowDays * dayMs;
  const out = { window1: { start: w1Start, end: w1End }, window2: { start: w2Start, end: w2End } };
  if (shortWindowDays) {
    const wsEnd = w1End;
    const wsStart = wsEnd - shortWindowDays * dayMs;
    out.windowShort = { start: wsStart, end: wsEnd };
  }
  return out;
}

function buyHoldReturn(candles, startTs, endTs) {
  const inRange = candles.filter((c) => c.ts >= startTs && c.ts < endTs);
  if (inRange.length < 2) return null;
  const first = inRange[0].open, last = inRange[inRange.length - 1].close;
  return +(((last - first) / first) * 100).toFixed(2);
}

// ---------------- Signal precompute ----------------
// The per-i strategy functions in strategyLogic.cjs each recompute full-history
// indicator series (ema/atr/supertrendDir) from scratch on every call — fine at
// a few thousand candles, but an O(n^2) trap at the ~80k 5m candles a 290-day
// lookback produces (confirmed: original per-call approach didn't finish in 8+
// CPU-minutes and had to be killed). Compute each indicator series exactly once
// per symbol instead, then read from the precomputed arrays inside the O(n) walk.

function precomputeSupertrendSignals(candles, p, minAgreement) {
  const d1 = supertrendDir(candles, p.m1, p.p1);
  const d2 = supertrendDir(candles, p.m2, p.p2);
  const d3 = supertrendDir(candles, p.m3, p.p3);
  const close = candles.map((c) => c.close);
  const e1 = ema(close, 50);
  const e2 = ema(close, 200);
  const a = atr(candles, 14);
  const n = candles.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const votesUp = [d1[i], d2[i], d3[i]].filter((v) => v === 1).length;
    const votesDown = [d1[i], d2[i], d3[i]].filter((v) => v === -1).length;
    const up = votesUp >= minAgreement;
    const down = votesDown >= minAgreement;
    const trendOkLong = !p.emaFilter || (e1[i] != null && e2[i] != null && e1[i] > e2[i]);
    const trendOkShort = !p.emaFilter || (e1[i] != null && e2[i] != null && e1[i] < e2[i]);
    const vol = a[i] ? a[i] / candles[i].close : 0;
    const volOk = vol >= p.minAtr && vol <= p.maxAtr;
    out[i] = {
      longEntry: up && trendOkLong && volOk, longExit: down,
      shortEntry: down && trendOkShort && volOk, shortExit: up,
      sl: p.sl, tp: p.tp, maxHold: p.maxHold, minHold: p.minHold,
    };
  }
  return out;
}

function precomputePullbackSignals(candles) {
  const close = candles.map((c) => c.close);
  const e20 = ema(close, 20), e50 = ema(close, 50), e200 = ema(close, 200);
  const n = candles.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0 || e20[i] == null || e50[i] == null || e200[i] == null || e20[i - 1] == null) {
      out[i] = { longEntry: false, longExit: false, shortEntry: false, shortExit: false, ...PULLBACK_PARAMS };
      continue;
    }
    const uptrend = e50[i] > e200[i];
    const downtrend = e50[i] < e200[i];
    const wasPulledBackDown = close[i - 1] < e20[i - 1];
    const wasPulledBackUp = close[i - 1] > e20[i - 1];
    const resolvedUp = close[i] > e20[i];
    const resolvedDown = close[i] < e20[i];
    out[i] = {
      longEntry: uptrend && wasPulledBackDown && resolvedUp, longExit: e50[i] < e200[i],
      shortEntry: downtrend && wasPulledBackUp && resolvedDown, shortExit: e50[i] > e200[i],
      ...PULLBACK_PARAMS,
    };
  }
  return out;
}

function precomputeBreakoutSignals(candles) {
  const n = candles.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = breakoutSignal(candles, i);
  return out;
}

function precomputeSignals(candles, strategyName, params, minAgreement) {
  if (strategyName === "supertrend") return precomputeSupertrendSignals(candles, params, minAgreement);
  if (strategyName === "pullback") return precomputePullbackSignals(candles);
  if (strategyName === "breakout") return precomputeBreakoutSignals(candles);
  throw new Error(`unknown strategy: ${strategyName}`);
}

// ---------------- Intraday engine (supertrend/pullback/breakout) ----------------

function runIntradayBacktest(candles, signals, feeBps) {
  const trades = [];
  let position = null;

  for (let i = 1; i < candles.length - 1; i++) {
    const sig = signals[i];
    if (!sig) continue;

    if (position) {
      const heldCandles = i - position.entryIdx;
      const isLong = position.side === "LONG";
      const high = candles[i].high, low = candles[i].low;

      let exitPrice = null, exitReason = null;
      if (isLong) {
        const slPrice = position.entryPrice * (1 - sig.sl);
        const tpPrice = position.entryPrice * (1 + sig.tp);
        if (low <= slPrice) { exitPrice = slPrice; exitReason = "SL"; }
        else if (high >= tpPrice) { exitPrice = tpPrice; exitReason = "TP"; }
      } else {
        const slPrice = position.entryPrice * (1 + sig.sl);
        const tpPrice = position.entryPrice * (1 - sig.tp);
        if (high >= slPrice) { exitPrice = slPrice; exitReason = "SL"; }
        else if (low <= tpPrice) { exitPrice = tpPrice; exitReason = "TP"; }
      }
      const exitSignal = isLong ? sig.longExit : sig.shortExit;
      if (!exitPrice && exitSignal && heldCandles >= sig.minHold) { exitPrice = candles[i].close; exitReason = "SIGNAL"; }
      if (!exitPrice && heldCandles >= sig.maxHold) { exitPrice = candles[i].close; exitReason = "TIME"; }

      if (exitPrice) {
        const rawPct = isLong ? (exitPrice - position.entryPrice) / position.entryPrice : (position.entryPrice - exitPrice) / position.entryPrice;
        const pnlFraction = rawPct - feeBps / 10000;
        trades.push({ side: position.side, entryTs: position.entryTs, exitTs: candles[i].ts, pnlFraction });
        position = null;
      }
      continue;
    }

    const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
    if (side && passesFeeGate(sig)) {
      position = { side, entryPrice: candles[i].close, entryIdx: i, entryTs: candles[i].ts };
    }
  }

  return trades;
}

// ---------------- Daily-trend engine (Donchian) ----------------

function runDailyBacktest(candles, params, feeBps) {
  const atrSeries = atr(candles, params.atrPeriod);
  const trades = [];
  let position = null;

  for (let i = params.entryLookback + 1; i < candles.length; i++) {
    const sig = dailyTrendSignalAt(candles, i, params, atrSeries);
    if (sig.atr === null) continue;

    if (position) {
      const isLong = position.side === "LONG";
      const high = candles[i].high, low = candles[i].low, close = candles[i].close;
      let exitPrice = null;

      if (isLong && low <= position.stopPrice) { exitPrice = position.stopPrice; }
      else if (!isLong && high >= position.stopPrice) { exitPrice = position.stopPrice; }
      else if (isLong && sig.longExit) { exitPrice = close; }
      else if (!isLong && sig.shortExit) { exitPrice = close; }

      if (exitPrice) {
        const priceDelta = isLong ? (exitPrice - position.entryPrice) / position.entryPrice : (position.entryPrice - exitPrice) / position.entryPrice;
        const stopDistancePct = Math.abs(position.entryPrice - position.stopPrice) / position.entryPrice;
        const pnlFraction = (priceDelta / stopDistancePct) * params.riskPerTradePct - feeBps / 10000;
        trades.push({ side: position.side, entryTs: position.entryTs, exitTs: candles[i].ts, pnlFraction });
        position = null;
      }
      continue;
    }

    const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
    if (side) {
      const entryPrice = candles[i].close;
      const stopDistance = params.atrStopMultiple * sig.atr;
      const stopPrice = side === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance;
      position = { side, entryPrice, entryIdx: i, entryTs: candles[i].ts, stopPrice };
    }
  }

  return trades;
}

// ---------------- Summary stats (mirrors backtestRegimeGatedPullback.cjs) ----------------

function summarizeTrades(trades) {
  if (!trades.length) return { tradeCount: 0, profitFactor: 0, winRatePct: 0, netReturnPct: 0, maxDrawdownPct: 0 };
  const wins = trades.filter((t) => t.pnlFraction > 0);
  const losses = trades.filter((t) => t.pnlFraction <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlFraction, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlFraction, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs);
  let equity = 1, peak = 1, maxDD = 0;
  for (const t of sorted) {
    equity *= (1 + t.pnlFraction);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  return {
    tradeCount: trades.length,
    winRatePct: +((wins.length / trades.length) * 100).toFixed(1),
    profitFactor: profitFactor === Infinity ? "inf" : +profitFactor.toFixed(2),
    netReturnPct: +((equity - 1) * 100).toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
  };
}

function combineBasket(perSymbolTrades) {
  const allTrades = perSymbolTrades.flatMap((r) => r.trades);
  const summary = summarizeTrades(allTrades);
  const n = perSymbolTrades.length;
  const subs = perSymbolTrades.map(() => 1 / n);
  const events = perSymbolTrades.flatMap((r, si) => r.trades.map((t) => ({ ...t, si }))).sort((a, b) => a.entryTs - b.entryTs);
  let peak = 1, maxDD = 0;
  for (const ev of events) {
    subs[ev.si] *= (1 + ev.pnlFraction);
    const total = subs.reduce((a, b) => a + b, 0);
    peak = Math.max(peak, total);
    maxDD = Math.max(maxDD, (peak - total) / peak);
  }
  const finalTotal = subs.reduce((a, b) => a + b, 0);
  return {
    ...summary,
    portfolioNetReturnPct: +((finalTotal - 1) * 100).toFixed(2),
    portfolioMaxDrawdownPct: +(maxDD * 100).toFixed(2),
  };
}

function pf(v) { return v.profitFactor === "inf" ? Infinity : v.profitFactor; }

function gauntletVerdict(basketW1, basketW2, basketW1Stress, buyHoldW1, buyHoldW2) {
  const c1 = pf(basketW1) > 1.3 && basketW1.tradeCount >= 100;
  const c2 = pf(basketW2) > 1.3 && basketW2.tradeCount >= 100 && basketW2.netReturnPct > 0;
  const c3a = basketW1.portfolioNetReturnPct > buyHoldW1;
  const c3b = basketW2.portfolioNetReturnPct > buyHoldW2;
  const c3 = c3a && c3b;
  const c4 = basketW1Stress.netReturnPct > 0;
  return { c1, c2, c3, c3a, c3b, c4, allPass: c1 && c2 && c3 && c4 };
}

// Supplementary check only — the short window has no second non-overlapping
// window of its own to pair against, so this collapses C1/C2/C3/C4 into a
// single-window analogue (PF>1.3, 100+ trades, positive, beats buy-hold,
// survives 1.5x fee stress). It does NOT replace or count toward the
// official 4-criteria verdict above, which stays window1/window2 only.
function shortWindowVerdict(basketWS, basketWSStress, buyHoldWS) {
  const pfOk = pf(basketWS) > 1.3;
  const tradesOk = basketWS.tradeCount >= 100;
  const positiveOk = basketWS.netReturnPct > 0;
  const beatsBuyHold = basketWS.portfolioNetReturnPct > buyHoldWS;
  const stressOk = basketWSStress.netReturnPct > 0;
  return { pfOk, tradesOk, positiveOk, beatsBuyHold, stressOk, allPass: pfOk && tradesOk && positiveOk && beatsBuyHold && stressOk };
}

// ---------------- Main ----------------

async function loadIntradaySymbolData(symbol, interval, days, cacheDir, noCache) {
  return fetchCandlesCached(symbol, interval, days, cacheDir, noCache);
}

async function runStrategyOnSymbols(strategyName, candlesBySymbol, windowsBySymbol, feeBps, stressFeeBps, minAgreement) {
  const perSymbol = {};
  const w1 = [], w2 = [], w1Stress = [], wS = [], wSStress = [];
  for (const symbol of SYMBOLS) {
    const candles = candlesBySymbol[symbol];
    const params = strategyName === "supertrend" ? DEFAULT_ST_PARAMS : null;
    const signals = precomputeSignals(candles, strategyName, params, minAgreement);
    const allTrades = runIntradayBacktest(candles, signals, feeBps);
    const allTradesStress = runIntradayBacktest(candles, signals, stressFeeBps);
    const windows = windowsBySymbol[symbol];
    const w1Trades = allTrades.filter((t) => t.entryTs >= windows.window1.start && t.entryTs < windows.window1.end);
    const w2Trades = allTrades.filter((t) => t.entryTs >= windows.window2.start && t.entryTs < windows.window2.end);
    const w1TradesStress = allTradesStress.filter((t) => t.entryTs >= windows.window1.start && t.entryTs < windows.window1.end);
    const wSTrades = allTrades.filter((t) => t.entryTs >= windows.windowShort.start && t.entryTs < windows.windowShort.end);
    const wSTradesStress = allTradesStress.filter((t) => t.entryTs >= windows.windowShort.start && t.entryTs < windows.windowShort.end);

    w1.push({ symbol, trades: w1Trades });
    w2.push({ symbol, trades: w2Trades });
    w1Stress.push({ symbol, trades: w1TradesStress });
    wS.push({ symbol, trades: wSTrades });
    wSStress.push({ symbol, trades: wSTradesStress });

    perSymbol[symbol] = {
      window1: summarizeTrades(w1Trades),
      window2: summarizeTrades(w2Trades),
      windowShort: summarizeTrades(wSTrades),
      buyHoldWindow1Pct: buyHoldReturn(candles, windows.window1.start, windows.window1.end),
      buyHoldWindow2Pct: buyHoldReturn(candles, windows.window2.start, windows.window2.end),
      buyHoldWindowShortPct: buyHoldReturn(candles, windows.windowShort.start, windows.windowShort.end),
    };
  }
  const basketW1 = combineBasket(w1);
  const basketW2 = combineBasket(w2);
  const basketW1Stress = combineBasket(w1Stress);
  const basketWS = combineBasket(wS);
  const basketWSStress = combineBasket(wSStress);
  const buyHoldW1 = +(SYMBOLS.reduce((a, s) => a + perSymbol[s].buyHoldWindow1Pct, 0) / SYMBOLS.length).toFixed(2);
  const buyHoldW2 = +(SYMBOLS.reduce((a, s) => a + perSymbol[s].buyHoldWindow2Pct, 0) / SYMBOLS.length).toFixed(2);
  const buyHoldWS = +(SYMBOLS.reduce((a, s) => a + perSymbol[s].buyHoldWindowShortPct, 0) / SYMBOLS.length).toFixed(2);
  const gauntlet = gauntletVerdict(basketW1, basketW2, basketW1Stress, buyHoldW1, buyHoldW2);
  const shortWindow = shortWindowVerdict(basketWS, basketWSStress, buyHoldWS);
  return { strategyName, perSymbol, basketW1, basketW2, basketW1Stress, basketWS, basketWSStress, buyHoldW1, buyHoldW2, buyHoldWS, gauntlet, shortWindow };
}

async function runDailyTrendOnSymbols(candlesBySymbol, windowsBySymbol) {
  const perSymbol = {};
  const w1 = [], w2 = [], w1Stress = [], wS = [], wSStress = [];
  for (const symbol of SYMBOLS) {
    const candles = candlesBySymbol[symbol];
    const allTrades = runDailyBacktest(candles, DAILY_TREND_PARAMS, DAILY_FEE_BPS);
    const allTradesStress = runDailyBacktest(candles, DAILY_TREND_PARAMS, DAILY_STRESS_FEE_BPS);
    const windows = windowsBySymbol[symbol];
    const w1Trades = allTrades.filter((t) => t.entryTs >= windows.window1.start && t.entryTs < windows.window1.end);
    const w2Trades = allTrades.filter((t) => t.entryTs >= windows.window2.start && t.entryTs < windows.window2.end);
    const w1TradesStress = allTradesStress.filter((t) => t.entryTs >= windows.window1.start && t.entryTs < windows.window1.end);
    const wSTrades = allTrades.filter((t) => t.entryTs >= windows.windowShort.start && t.entryTs < windows.windowShort.end);
    const wSTradesStress = allTradesStress.filter((t) => t.entryTs >= windows.windowShort.start && t.entryTs < windows.windowShort.end);

    w1.push({ symbol, trades: w1Trades });
    w2.push({ symbol, trades: w2Trades });
    w1Stress.push({ symbol, trades: w1TradesStress });
    wS.push({ symbol, trades: wSTrades });
    wSStress.push({ symbol, trades: wSTradesStress });

    perSymbol[symbol] = {
      window1: summarizeTrades(w1Trades),
      window2: summarizeTrades(w2Trades),
      windowShort: summarizeTrades(wSTrades),
      buyHoldWindow1Pct: buyHoldReturn(candles, windows.window1.start, windows.window1.end),
      buyHoldWindow2Pct: buyHoldReturn(candles, windows.window2.start, windows.window2.end),
      buyHoldWindowShortPct: buyHoldReturn(candles, windows.windowShort.start, windows.windowShort.end),
    };
  }
  const basketW1 = combineBasket(w1);
  const basketW2 = combineBasket(w2);
  const basketW1Stress = combineBasket(w1Stress);
  const basketWS = combineBasket(wS);
  const basketWSStress = combineBasket(wSStress);
  const buyHoldW1 = +(SYMBOLS.reduce((a, s) => a + perSymbol[s].buyHoldWindow1Pct, 0) / SYMBOLS.length).toFixed(2);
  const buyHoldW2 = +(SYMBOLS.reduce((a, s) => a + perSymbol[s].buyHoldWindow2Pct, 0) / SYMBOLS.length).toFixed(2);
  const buyHoldWS = +(SYMBOLS.reduce((a, s) => a + perSymbol[s].buyHoldWindowShortPct, 0) / SYMBOLS.length).toFixed(2);
  const gauntlet = gauntletVerdict(basketW1, basketW2, basketW1Stress, buyHoldW1, buyHoldW2);
  const shortWindow = shortWindowVerdict(basketWS, basketWSStress, buyHoldWS);
  return { strategyName: "dailytrend", perSymbol, basketW1, basketW2, basketW1Stress, basketWS, basketWSStress, buyHoldW1, buyHoldW2, buyHoldWS, gauntlet, shortWindow };
}

async function main() {
  const args = parseArgs();
  const totalDays = WINDOW_DAYS * 2 + WARMUP_DAYS;
  console.log(`Fresh gauntlet — symbols: ${SYMBOLS.join(", ")}, window=${WINDOW_DAYS}d x2, warmup=${WARMUP_DAYS}d\n`);

  console.log("Fetching 5m candles (supertrend)...");
  const candles5m = {};
  for (const s of SYMBOLS) { candles5m[s] = await loadIntradaySymbolData(s, "5", totalDays, args.cacheDir, args.noCache); console.log(`  ${s}: ${candles5m[s].length} candles`); }

  console.log("Fetching 15m candles (pullback/breakout)...");
  const candles15m = {};
  for (const s of SYMBOLS) { candles15m[s] = await loadIntradaySymbolData(s, "15", totalDays, args.cacheDir, args.noCache); console.log(`  ${s}: ${candles15m[s].length} candles`); }

  console.log("Fetching daily candles (daily-trend)...");
  const candlesD = {};
  for (const s of SYMBOLS) { candlesD[s] = await loadIntradaySymbolData(s, "D", totalDays, args.cacheDir, args.noCache); console.log(`  ${s}: ${candlesD[s].length} candles`); }

  const windows5m = {}, windows15m = {}, windowsD = {};
  for (const s of SYMBOLS) {
    windows5m[s] = computeWindows(candles5m[s][candles5m[s].length - 1].ts, WINDOW_DAYS, WINDOW_SHORT_DAYS);
    windows15m[s] = computeWindows(candles15m[s][candles15m[s].length - 1].ts, WINDOW_DAYS, WINDOW_SHORT_DAYS);
    windowsD[s] = computeWindows(candlesD[s][candlesD[s].length - 1].ts, WINDOW_DAYS, WINDOW_SHORT_DAYS);
  }

  console.log("\nRunning strategies...\n");
  const results = [];
  results.push(await runStrategyOnSymbols("supertrend", candles5m, windows5m, INTRADAY_FEE_BPS, INTRADAY_STRESS_FEE_BPS, MIN_AGREEMENT));
  results.push(await runStrategyOnSymbols("pullback", candles15m, windows15m, INTRADAY_FEE_BPS, INTRADAY_STRESS_FEE_BPS, MIN_AGREEMENT));
  results.push(await runStrategyOnSymbols("breakout", candles15m, windows15m, INTRADAY_FEE_BPS, INTRADAY_STRESS_FEE_BPS, MIN_AGREEMENT));
  results.push(await runDailyTrendOnSymbols(candlesD, windowsD));

  const report = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    symbols: SYMBOLS,
    results: results.map((r) => ({
      strategy: r.strategyName,
      windows: {
        window1: windows15m[SYMBOLS[0]].window1,
        window2: windows15m[SYMBOLS[0]].window2,
        windowShort: windows15m[SYMBOLS[0]].windowShort,
      },
      basketW1: r.basketW1, basketW2: r.basketW2, basketW1Stress: r.basketW1Stress,
      basketWS: r.basketWS, basketWSStress: r.basketWSStress,
      buyHoldW1: r.buyHoldW1, buyHoldW2: r.buyHoldW2, buyHoldWS: r.buyHoldWS,
      perSymbol: r.perSymbol, gauntlet: r.gauntlet, shortWindow: r.shortWindow,
    })),
  };

  console.log("\n\n========== FRESH GAUNTLET RESULTS ==========\n");
  for (const r of results) {
    console.log(`-- ${r.strategyName} --`);
    console.log(`  W1 (${WINDOW_DAYS}d recent): PF=${r.basketW1.profitFactor} trades=${r.basketW1.tradeCount} win%=${r.basketW1.winRatePct} return=${r.basketW1.portfolioNetReturnPct}% buyHold=${r.buyHoldW1}%`);
    console.log(`  W2 (${WINDOW_DAYS}d prior): PF=${r.basketW2.profitFactor} trades=${r.basketW2.tradeCount} win%=${r.basketW2.winRatePct} return=${r.basketW2.portfolioNetReturnPct}% buyHold=${r.buyHoldW2}%`);
    console.log(`  W1 @ stress fee: PF=${r.basketW1Stress.profitFactor} return=${r.basketW1Stress.netReturnPct}%`);
    console.log(`  Gauntlet (standard, W1/W2 only): C1=${r.gauntlet.c1 ? "PASS" : "FAIL"} C2=${r.gauntlet.c2 ? "PASS" : "FAIL"} C3=${r.gauntlet.c3 ? "PASS" : "FAIL"} C4=${r.gauntlet.c4 ? "PASS" : "FAIL"} => ${r.gauntlet.allPass ? "ALL PASS" : "FAIL"}`);
    console.log(`  WS (${WINDOW_SHORT_DAYS}d recent, supplementary): PF=${r.basketWS.profitFactor} trades=${r.basketWS.tradeCount} win%=${r.basketWS.winRatePct} return=${r.basketWS.portfolioNetReturnPct}% buyHold=${r.buyHoldWS}% | stress PF=${r.basketWSStress.profitFactor} stress return=${r.basketWSStress.netReturnPct}% => ${r.shortWindow.allPass ? "WOULD PASS (single-window standalone)" : "FAIL"}`);
    console.log("");
  }

  const outPath = path.join(__dirname, "..", "data", "freshgauntlet", "report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Full report written to ${outPath}`);

  return report;
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runIntradayBacktest, runDailyBacktest, summarizeTrades, combineBasket, computeWindows, main };
