#!/usr/bin/env node
/**
 * scripts/backtestRegimeGatedPullback.cjs
 *
 * "Regime-Gated Trend Pullback" — tests the hypothesis that an ADX-based
 * 1h regime filter fixes what killed earlier pullback/breakout tests in
 * this repo. Spec is fixed by the strategy document; this script does not
 * take creative liberties with it. See EDGE_EVIDENCE_TEMPLATE.md for the
 * pass/fail bar this feeds into.
 *
 * REGIME (1h): price > EMA200, EMA50 > EMA200, EMA50 rising (vs 5 bars ago),
 *   ADX(14) > 22. Mirrored for shorts.
 * ENTRY (15m, only while regime valid): price within 0.3% of 20 or 50 EMA,
 *   RSI(14) 38-55 (long) / 45-62 (short), close reclaims prior bar's
 *   high/low, volume > prior bar. Enter at close.
 * EXIT: stop = tighter of (10-bar swing low/high, entry -/+ 1.25*ATR14);
 *   50% off at +1.5R, rest at +2.5R; stop to breakeven at +1R; time stop
 *   96 bars (24h).
 * FEES: 14bps round-trip, split 7bps entry / 7bps exit, exit fee
 *   distributed across partial-exit legs proportional to size.
 *
 * Uses only public Bybit market data (read-only, no API key).
 *
 * ============ USAGE ============
 *   node scripts/backtestRegimeGatedPullback.cjs
 *   node scripts/backtestRegimeGatedPullback.cjs --symbols BTCUSDT,ETHUSDT,SOLUSDT
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { ema: emaSeriesRaw, atr: atrSeriesRaw } = require("./strategyLogic.cjs");

const FEE_BPS_ROUND_TRIP = 14;
const STRESS_FEE_BPS_ROUND_TRIP = 21;
const ADX_THRESHOLD = 22;
const RISK_PER_TRADE_PCT = 0.01;
const TIME_STOP_BARS = 96; // 24h of 15m candles
const WINDOW_DAYS = 180;
const WARMUP_DAYS = 40;

// ---------------- CLI ----------------

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    symbols: get("--symbols", "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map((s) => s.trim()).filter(Boolean),
    cacheDir: get("--cache-dir", path.join(__dirname, "..", "data", "regimegatedpullback")),
    noCache: args.includes("--no-cache"),
    totalDaysOverride: args.includes("--smoke-test-days") ? Number(get("--smoke-test-days", 0)) : null,
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
  const stepMs = Number(interval) * 60 * 1000;
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
    if (ageMs < 6 * 60 * 60 * 1000) return cached.candles; // 6h cache TTL
  }
  const candles = await fetchCandles(symbol, interval, days);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), candles }));
  return candles;
}

// ---------------- Indicators ----------------

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain; avgLoss += loss;
      if (i === period) {
        avgGain /= period; avgLoss /= period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function adxSeries(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }
  const smPlusDM = new Array(n).fill(null), smMinusDM = new Array(n).fill(null), smTR = new Array(n).fill(null);
  let sp = 0, sm = 0, st = 0;
  for (let i = 1; i <= period && i < n; i++) { sp += plusDM[i]; sm += minusDM[i]; st += tr[i]; }
  if (period < n) { smPlusDM[period] = sp; smMinusDM[period] = sm; smTR[period] = st; }
  for (let i = period + 1; i < n; i++) {
    smPlusDM[i] = smPlusDM[i - 1] - smPlusDM[i - 1] / period + plusDM[i];
    smMinusDM[i] = smMinusDM[i - 1] - smMinusDM[i - 1] / period + minusDM[i];
    smTR[i] = smTR[i - 1] - smTR[i - 1] / period + tr[i];
  }
  const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (smTR[i] > 0) {
      plusDI[i] = 100 * smPlusDM[i] / smTR[i];
      minusDI[i] = 100 * smMinusDM[i] / smTR[i];
      const diSum = plusDI[i] + minusDI[i];
      dx[i] = diSum > 0 ? 100 * Math.abs(plusDI[i] - minusDI[i]) / diSum : 0;
    }
  }
  const adx = new Array(n).fill(null);
  let dxSum = 0, count = 0, seeded = false, prevAdx = null;
  for (let i = period; i < n; i++) {
    if (dx[i] == null) continue;
    if (!seeded) {
      dxSum += dx[i]; count++;
      if (count === period) { prevAdx = dxSum / period; adx[i] = prevAdx; seeded = true; }
    } else {
      prevAdx = (prevAdx * (period - 1) + dx[i]) / period;
      adx[i] = prevAdx;
    }
  }
  return adx;
}

// ---------------- Regime (1h) ----------------

function buildRegime1h(candles1h) {
  const closes = candles1h.map((c) => c.close);
  const ema50 = emaSeriesRaw(closes, 50);
  const ema200 = emaSeriesRaw(closes, 200);
  const adx14 = adxSeries(candles1h, 14);
  const tsIndex = new Map();
  candles1h.forEach((c, i) => tsIndex.set(c.ts, i));
  const regime = candles1h.map((c, i) => {
    const e50 = ema50[i], e200 = ema200[i], e50prev = i >= 5 ? ema50[i - 5] : null, a = adx14[i];
    if (e50 == null || e200 == null || e50prev == null || a == null) {
      return { ready: false, longOk: false, shortOk: false };
    }
    const longOk = c.close > e200 && e50 > e200 && e50 > e50prev && a > ADX_THRESHOLD;
    const shortOk = c.close < e200 && e50 < e200 && e50 < e50prev && a > ADX_THRESHOLD;
    return { ready: true, longOk, shortOk, adx: a };
  });
  return { regime, tsIndex };
}

function hourBucketStart(ts) {
  return Math.floor(ts / 3600000) * 3600000 - 3600000; // most recently CLOSED 1h candle
}

// ---------------- 15m entry preconditions ----------------

function buildEntrySignals15m(candles15m) {
  const closes = candles15m.map((c) => c.close);
  const ema20 = emaSeriesRaw(closes, 20);
  const ema50 = emaSeriesRaw(closes, 50);
  const rsi14 = rsiSeries(closes, 14);
  const atr14 = atrSeriesRaw(candles15m, 14);
  const n = candles15m.length;
  const signals = new Array(n).fill(null);
  for (let i = 50; i < n; i++) {
    if (ema20[i] == null || ema50[i] == null || rsi14[i] == null) continue;
    const close = closes[i];
    const prev = candles15m[i - 1];
    const withinPct20 = Math.abs(close - ema20[i]) / close <= 0.003;
    const withinPct50 = Math.abs(close - ema50[i]) / close <= 0.003;
    const pullbackOk = withinPct20 || withinPct50;
    const volOk = candles15m[i].volume > prev.volume;
    const reclaimLong = close > prev.high;
    const reclaimShort = close < prev.low;
    const rsiOkLong = rsi14[i] >= 38 && rsi14[i] <= 55;
    const rsiOkShort = rsi14[i] >= 45 && rsi14[i] <= 62;
    signals[i] = {
      longPrecondition: pullbackOk && rsiOkLong && reclaimLong && volOk,
      shortPrecondition: pullbackOk && rsiOkShort && reclaimShort && volOk,
      atr: atr14[i],
    };
  }
  return signals;
}

// ---------------- Backtest engine ----------------

function runBacktest(candles15m, signals, regimeData, opts) {
  const { regimeEnabled, feeBpsRoundTrip, windowStartTs, windowEndTs } = opts;
  const { regime, tsIndex } = regimeData;
  const n = candles15m.length;
  const trades = [];
  let position = null;
  let regimeRejected = 0, regimeAllowed = 0;
  const entryFeeFrac = (feeBpsRoundTrip / 2) / 10000;
  const exitFeeFrac = (feeBpsRoundTrip / 2) / 10000;

  function closeLeg(pos, exitTs, exitPrice, reason, sizeFraction) {
    // R multiple must be denominated against the ORIGINAL stop distance (pos.R,
    // fixed at entry) — pos.stopPrice itself mutates (moves to breakeven), so
    // recomputing distance from it here would divide by ~0 on later legs.
    const isLong = pos.side === "LONG";
    const priceMove = (exitPrice - pos.entryPrice) * (isLong ? 1 : -1);
    const rMultiple = priceMove / pos.R;
    const legPnlFraction = rMultiple * RISK_PER_TRADE_PCT * sizeFraction;
    const legFeeFraction = exitFeeFrac * sizeFraction;
    pos.equityImpact += legPnlFraction - legFeeFraction;
    pos.rMultipleSum += rMultiple * sizeFraction;
    pos.legs.push({ exitPrice, reason, sizeFraction, exitTs });
  }

  for (let i = 50; i < n; i++) {
    const c = candles15m[i];
    const inWindow = c.ts >= windowStartTs && c.ts < windowEndTs;

    if (position) {
      const isLong = position.side === "LONG";
      const barsHeld = i - position.entryIdx;
      let done = false;

      if (barsHeld >= TIME_STOP_BARS) {
        closeLeg(position, c.ts, c.close, "TIME_STOP", position.remainingFraction);
        done = true;
      } else {
        const stopHit = isLong ? c.low <= position.stopPrice : c.high >= position.stopPrice;
        if (stopHit) {
          const reason = position.movedToBE ? "BREAKEVEN_STOP" : "STOP_LOSS";
          closeLeg(position, c.ts, position.stopPrice, reason, position.remainingFraction);
          done = true;
        } else if (!position.tp1Taken) {
          const tp1Hit = isLong ? c.high >= position.tp1 : c.low <= position.tp1;
          if (tp1Hit) {
            closeLeg(position, c.ts, position.tp1, "TP1", 0.5);
            position.tp1Taken = true;
            position.remainingFraction = 0.5;
            const tp2Hit = isLong ? c.high >= position.tp2 : c.low <= position.tp2;
            if (tp2Hit) {
              closeLeg(position, c.ts, position.tp2, "TP2", position.remainingFraction);
              done = true;
            }
          }
        } else {
          const tp2Hit = isLong ? c.high >= position.tp2 : c.low <= position.tp2;
          if (tp2Hit) {
            closeLeg(position, c.ts, position.tp2, "TP2", position.remainingFraction);
            done = true;
          }
        }
      }

      if (!done && position) {
        const favorable = isLong ? (c.high - position.entryPrice) : (position.entryPrice - c.low);
        if (favorable >= position.R && !position.movedToBE) {
          position.stopPrice = position.entryPrice;
          position.movedToBE = true;
        }
      }

      if (done) {
        trades.push(finalizeTrade(position));
        position = null;
      }
      continue;
    }

    const sig = signals[i];
    if (!sig || !inWindow) continue;
    if (!sig.longPrecondition && !sig.shortPrecondition) continue;

    const hourTs = hourBucketStart(c.ts);
    const hourIdx = tsIndex.get(hourTs);
    const reg = hourIdx != null ? regime[hourIdx] : null;
    const regimeReady = reg && reg.ready;

    let side = null;
    if (sig.longPrecondition) {
      if (!regimeReady) { /* not enough regime data yet, skip silently */ }
      else if (reg.longOk) { side = "LONG"; regimeAllowed++; }
      else if (regimeEnabled) { regimeRejected++; }
      else { side = "LONG"; }
    } else if (sig.shortPrecondition) {
      if (!regimeReady) { /* skip */ }
      else if (reg.shortOk) { side = "SHORT"; regimeAllowed++; }
      else if (regimeEnabled) { regimeRejected++; }
      else { side = "SHORT"; }
    }

    if (regimeEnabled && side === null) continue;
    if (!side) continue;

    const entryPrice = c.close;
    const isLong = side === "LONG";
    const lookback = candles15m.slice(Math.max(0, i - 9), i + 1);
    const swingLow = Math.min(...lookback.map((x) => x.low));
    const swingHigh = Math.max(...lookback.map((x) => x.high));
    const atrStop = isLong ? entryPrice - 1.25 * sig.atr : entryPrice + 1.25 * sig.atr;
    const stopPrice = isLong ? Math.max(swingLow, atrStop) : Math.min(swingHigh, atrStop);
    const R = isLong ? entryPrice - stopPrice : stopPrice - entryPrice;
    if (!(R > 0) || sig.atr == null) continue;

    position = {
      side, entryIdx: i, entryTs: c.ts, entryPrice, stopPrice, R,
      tp1: isLong ? entryPrice + 1.5 * R : entryPrice - 1.5 * R,
      tp2: isLong ? entryPrice + 2.5 * R : entryPrice - 2.5 * R,
      tp1Taken: false, movedToBE: false, remainingFraction: 1,
      legs: [],
      equityImpact: -entryFeeFrac, // entry fee charged up front
      rMultipleSum: 0,
    };
  }

  // close any still-open position at the last available bar (data ran out)
  if (position && n > 0) {
    const last = candles15m[n - 1];
    closeLeg(position, last.ts, last.close, "DATA_END", position.remainingFraction);
    trades.push(finalizeTrade(position));
  }

  return { trades, regimeRejected, regimeAllowed };
}

function finalizeTrade(position) {
  const lastLeg = position.legs[position.legs.length - 1];
  return {
    side: position.side,
    entryIdx: position.entryIdx,
    entryTs: position.entryTs,
    exitTs: lastLeg.exitTs,
    heldBars: null, // filled by caller context if needed
    pnlFraction: position.equityImpact,
    rMultiple: position.rMultipleSum,
    exitReasons: position.legs.map((l) => l.reason).join("+"),
  };
}

// ---------------- Summary stats ----------------

function summarizeTrades(trades) {
  if (!trades.length) return { tradeCount: 0, profitFactor: 0, winRatePct: 0, avgR: 0, netReturnPct: 0, maxDrawdownPct: 0 };
  const wins = trades.filter((t) => t.pnlFraction > 0);
  const losses = trades.filter((t) => t.pnlFraction <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlFraction, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlFraction, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // sequential equity curve (compounded, starting equity = 1), trades sorted by entry time
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
    avgR: +(trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length).toFixed(2),
    netReturnPct: +((equity - 1) * 100).toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    grossWin, grossLoss,
  };
}

function combineBasket(perSymbolResults) {
  const allTrades = perSymbolResults.flatMap((r) => r.trades);
  const summary = summarizeTrades(allTrades);
  // equal-weight (1/3 each) combined portfolio equity curve, chronological across symbols
  const n = perSymbolResults.length;
  const subs = perSymbolResults.map(() => 1 / n);
  const events = perSymbolResults.flatMap((r, si) => r.trades.map((t) => ({ ...t, si }))).sort((a, b) => a.entryTs - b.entryTs);
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

function buyHoldReturn(candles15m, startTs, endTs) {
  const inRange = candles15m.filter((c) => c.ts >= startTs && c.ts < endTs);
  if (inRange.length < 2) return null;
  const first = inRange[0].open, last = inRange[inRange.length - 1].close;
  return +(((last - first) / first) * 100).toFixed(2);
}

// ---------------- Main ----------------

async function loadSymbolData(symbol, cacheDir, noCache, totalDaysOverride) {
  const totalDays = totalDaysOverride || (WINDOW_DAYS * 2 + WARMUP_DAYS);
  console.log(`  Fetching ${symbol} 15m candles (${totalDays}d)...`);
  const candles15m = await fetchCandlesCached(symbol, "15", totalDays, cacheDir, noCache);
  console.log(`  Fetching ${symbol} 1h candles (${totalDays}d)...`);
  const candles1h = await fetchCandlesCached(symbol, "60", totalDays, cacheDir, noCache);
  console.log(`  ${symbol}: ${candles15m.length} 15m candles, ${candles1h.length} 1h candles`);
  return { symbol, candles15m, candles1h };
}

function computeWindows(candles15m) {
  const lastTs = candles15m[candles15m.length - 1].ts;
  const dayMs = 24 * 60 * 60 * 1000;
  const window1End = lastTs + 15 * 60 * 1000; // include last bar
  const window1Start = window1End - WINDOW_DAYS * dayMs;
  const window2End = window1Start;
  const window2Start = window2End - WINDOW_DAYS * dayMs;
  return { window1: { start: window1Start, end: window1End }, window2: { start: window2Start, end: window2End } };
}

async function main() {
  const args = parseArgs();
  console.log(`Regime-Gated Trend Pullback backtest — symbols: ${args.symbols.join(", ")}\n`);

  const symbolData = [];
  for (const symbol of args.symbols) {
    symbolData.push(await loadSymbolData(symbol, args.cacheDir, args.noCache, args.totalDaysOverride));
  }

  const report = { symbols: args.symbols, generatedAt: new Date().toISOString(), windows: {}, perSymbol: {} };

  const runFor = (data, window, regimeEnabled, feeBps) => {
    const regimeData = buildRegime1h(data.candles1h);
    const signals = buildEntrySignals15m(data.candles15m);
    const result = runBacktest(data.candles15m, signals, regimeData, {
      regimeEnabled, feeBpsRoundTrip: feeBps, windowStartTs: window.start, windowEndTs: window.end,
    });
    return result;
  };

  // Use the first symbol's candle series to define window boundaries (all symbols fetched over the same lookback).
  const windows = computeWindows(symbolData[0].candles15m);
  report.windows = windows;

  console.log("\n=== Running gauntlet ===\n");

  const results = { window1: [], window2: [], window1Stress: [], window1Control: [], window2Control: [] };
  const buyHold = { window1: {}, window2: {} };

  for (const data of symbolData) {
    console.log(`-- ${data.symbol} --`);
    const w1 = runFor(data, windows.window1, true, FEE_BPS_ROUND_TRIP);
    const w2 = runFor(data, windows.window2, true, FEE_BPS_ROUND_TRIP);
    const w1Stress = runFor(data, windows.window1, true, STRESS_FEE_BPS_ROUND_TRIP);
    const w1Control = runFor(data, windows.window1, false, FEE_BPS_ROUND_TRIP);
    const w2Control = runFor(data, windows.window2, false, FEE_BPS_ROUND_TRIP);

    results.window1.push({ symbol: data.symbol, ...w1 });
    results.window2.push({ symbol: data.symbol, ...w2 });
    results.window1Stress.push({ symbol: data.symbol, ...w1Stress });
    results.window1Control.push({ symbol: data.symbol, ...w1Control });
    results.window2Control.push({ symbol: data.symbol, ...w2Control });

    buyHold.window1[data.symbol] = buyHoldReturn(data.candles15m, windows.window1.start, windows.window1.end);
    buyHold.window2[data.symbol] = buyHoldReturn(data.candles15m, windows.window2.start, windows.window2.end);

    report.perSymbol[data.symbol] = {
      window1: summarizeTrades(w1.trades),
      window2: summarizeTrades(w2.trades),
      window1Stress21bps: summarizeTrades(w1Stress.trades),
      window1ControlNoRegime: summarizeTrades(w1Control.trades),
      window2ControlNoRegime: summarizeTrades(w2Control.trades),
      regimeRejectedWindow1: w1.regimeRejected,
      regimeAllowedWindow1: w1.regimeAllowed,
      regimeRejectedWindow2: w2.regimeRejected,
      regimeAllowedWindow2: w2.regimeAllowed,
      buyHoldWindow1Pct: buyHold.window1[data.symbol],
      buyHoldWindow2Pct: buyHold.window2[data.symbol],
    };
  }

  const basketW1 = combineBasket(results.window1);
  const basketW2 = combineBasket(results.window2);
  const basketW1Stress = combineBasket(results.window1Stress);
  const basketW1Control = combineBasket(results.window1Control);
  const basketW2Control = combineBasket(results.window2Control);
  const basketBHW1 = +((Object.values(buyHold.window1).reduce((a, b) => a + b, 0) / args.symbols.length)).toFixed(2);
  const basketBHW2 = +((Object.values(buyHold.window2).reduce((a, b) => a + b, 0) / args.symbols.length)).toFixed(2);

  report.basket = {
    window1: basketW1, window2: basketW2, window1Stress21bps: basketW1Stress,
    window1ControlNoRegime: basketW1Control, window2ControlNoRegime: basketW2Control,
    buyHoldWindow1Pct: basketBHW1, buyHoldWindow2Pct: basketBHW2,
  };

  // ---------------- Gauntlet verdicts ----------------
  const pf = (v) => (v.profitFactor === "inf" ? Infinity : v.profitFactor);
  const c1 = pf(basketW1) > 1.3 && basketW1.tradeCount >= 100;
  const c2 = pf(basketW2) > 1.3 && basketW2.tradeCount >= 100 && basketW2.netReturnPct > 0;
  const c3a = basketW1.portfolioNetReturnPct > basketBHW1;
  const c3b = basketW2.portfolioNetReturnPct > basketBHW2;
  const c3 = c3a && c3b;
  const c4 = basketW1Stress.netReturnPct > 0;
  const allPass = c1 && c2 && c3 && c4;

  report.gauntlet = {
    criterion1_window1_pf_gt_1_3_100plus_trades: { pass: c1, pf: basketW1.profitFactor, tradeCount: basketW1.tradeCount },
    criterion2_window2_pf_gt_1_3_positive: { pass: c2, pf: basketW2.profitFactor, tradeCount: basketW2.tradeCount, netReturnPct: basketW2.netReturnPct },
    criterion3_beats_buyhold_both_windows: {
      pass: c3,
      window1: { strategy: basketW1.portfolioNetReturnPct, buyHold: basketBHW1, beats: c3a },
      window2: { strategy: basketW2.portfolioNetReturnPct, buyHold: basketBHW2, beats: c3b },
    },
    criterion4_survives_1_5x_fees: { pass: c4, netReturnPct: basketW1Stress.netReturnPct },
    ALL_PASS: allPass,
  };

  // ---------------- Print table ----------------
  console.log("\n\n========== GAUNTLET RESULTS ==========\n");
  console.log(`Window 1 (recent 180d, ${new Date(windows.window1.start).toISOString().slice(0,10)} to ${new Date(windows.window1.end).toISOString().slice(0,10)}):`);
  console.log(`  Basket PF: ${basketW1.profitFactor}  Trades: ${basketW1.tradeCount}  Win%: ${basketW1.winRatePct}  AvgR: ${basketW1.avgR}  MaxDD: ${basketW1.portfolioMaxDrawdownPct}%  Return: ${basketW1.portfolioNetReturnPct}%  BuyHold: ${basketBHW1}%`);
  console.log(`  >> Criterion 1 (PF>1.3, 100+ trades): ${c1 ? "PASS" : "FAIL"}`);
  console.log(`  >> Criterion 3a (beats buy-hold): ${c3a ? "PASS" : "FAIL"}`);

  console.log(`\nWindow 2 (prior 180d, ${new Date(windows.window2.start).toISOString().slice(0,10)} to ${new Date(windows.window2.end).toISOString().slice(0,10)}):`);
  console.log(`  Basket PF: ${basketW2.profitFactor}  Trades: ${basketW2.tradeCount}  Win%: ${basketW2.winRatePct}  AvgR: ${basketW2.avgR}  MaxDD: ${basketW2.portfolioMaxDrawdownPct}%  Return: ${basketW2.portfolioNetReturnPct}%  BuyHold: ${basketBHW2}%`);
  console.log(`  >> Criterion 2 (PF>1.3, 100+ trades, positive): ${c2 ? "PASS" : "FAIL"}`);
  console.log(`  >> Criterion 3b (beats buy-hold): ${c3b ? "PASS" : "FAIL"}`);

  console.log(`\nWindow 1 @ 21bps fee stress:`);
  console.log(`  Basket PF: ${basketW1Stress.profitFactor}  Trades: ${basketW1Stress.tradeCount}  Return: ${basketW1Stress.netReturnPct}%`);
  console.log(`  >> Criterion 4 (net positive at 1.5x fees): ${c4 ? "PASS" : "FAIL"}`);

  console.log(`\n---- Control: regime filter DISABLED ----`);
  console.log(`Window 1 control: PF ${basketW1Control.profitFactor}  Trades ${basketW1Control.tradeCount}  Win% ${basketW1Control.winRatePct}  Return ${basketW1Control.portfolioNetReturnPct}%  MaxDD ${basketW1Control.portfolioMaxDrawdownPct}%`);
  console.log(`Window 2 control: PF ${basketW2Control.profitFactor}  Trades ${basketW2Control.tradeCount}  Win% ${basketW2Control.winRatePct}  Return ${basketW2Control.portfolioNetReturnPct}%  MaxDD ${basketW2Control.portfolioMaxDrawdownPct}%`);

  const totalRejectedW1 = symbolData.reduce((a, d) => a + report.perSymbol[d.symbol].regimeRejectedWindow1, 0);
  const totalAllowedW1 = symbolData.reduce((a, d) => a + report.perSymbol[d.symbol].regimeAllowedWindow1, 0);
  console.log(`\nRegime filter selectivity (window 1): rejected ${totalRejectedW1} candidate entries, allowed ${totalAllowedW1}`);

  console.log(`\nPer-symbol breakdown:`);
  for (const data of symbolData) {
    const s = report.perSymbol[data.symbol];
    console.log(`  ${data.symbol}: W1 PF=${s.window1.profitFactor} trades=${s.window1.tradeCount} win%=${s.window1.winRatePct} avgR=${s.window1.avgR} maxDD=${s.window1.maxDrawdownPct}% | W2 PF=${s.window2.profitFactor} trades=${s.window2.tradeCount}`);
  }

  console.log(`\n========== FINAL VERDICT: ${allPass ? "ALL FOUR PASS" : "FAILED — DO NOT BUILD LIVE VERSION"} ==========\n`);

  const outPath = path.join(__dirname, "..", "data", "regimegatedpullback", "report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Full report written to ${outPath}`);

  return report;
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runBacktest, summarizeTrades, combineBasket, buildRegime1h, buildEntrySignals15m, adxSeries, rsiSeries, main };
