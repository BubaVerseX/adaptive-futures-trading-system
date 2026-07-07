#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "data/research/cache");
const REPORT_DIR = path.join(ROOT, "data/research/reports");
const PROFILE_DIR = path.join(ROOT, "models/v27");

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const DAYS = Number(process.env.V27_DAYS || getArg("--days") || 21);
const REFRESH = process.argv.includes("--refresh");
const TOTAL_COST_BPS = Number(process.env.V27_TOTAL_COST_BPS || 12.2); // taker fee + slippage estimate
const MIN_TRADES = Number(process.env.V27_MIN_TRADES || 20);
const MIN_PROFIT_FACTOR = Number(process.env.V27_MIN_PROFIT_FACTOR || 1.2);
const MAX_DRAWDOWN_BPS = Number(process.env.V27_MAX_DRAWDOWN_BPS || 2000);

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error("JSON parse failed: " + err.message + " body=" + data.slice(0, 200)));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("HTTP timeout"));
    });
    req.on("error", reject);
  });
}

function intervalMs(interval) {
  if (interval === "D") return 24 * 60 * 60 * 1000;
  return Number(interval) * 60 * 1000;
}

function candleFromBybit(row) {
  return {
    ts: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

async function fetchBybitKlines(symbol, interval, days) {
  const cacheFile = path.join(CACHE_DIR, `v27_${symbol}_${interval}_${days}d.json`);
  if (!REFRESH && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Array.isArray(cached) && cached.length > 100) return cached;
  }

  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  const step = intervalMs(interval);
  let cursor = start;
  const seen = new Set();
  const candles = [];

  while (cursor < end) {
    const params = new URLSearchParams({
      category: "linear",
      symbol,
      interval,
      start: String(cursor),
      end: String(end),
      limit: "1000",
    });

    const url = `https://api.bybit.com/v5/market/kline?${params.toString()}`;
    const json = await httpsJson(url);

    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
      throw new Error(`Bybit kline failed for ${symbol} ${interval}: ${JSON.stringify(json).slice(0, 300)}`);
    }

    const batch = json.result.list.map(candleFromBybit).sort((a, b) => a.ts - b.ts);
    if (batch.length === 0) break;

    let added = 0;
    for (const c of batch) {
      if (!Number.isFinite(c.close) || c.close <= 0) continue;
      if (!seen.has(c.ts)) {
        seen.add(c.ts);
        candles.push(c);
        added++;
      }
    }

    const lastTs = batch[batch.length - 1].ts;
    const next = lastTs + step;
    if (next <= cursor || added === 0) break;
    cursor = next;

    await sleep(120);
  }

  candles.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(cacheFile, JSON.stringify(candles));
  return candles;
}

function sma(values, period) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += Number.isFinite(v) ? v : 0;
    if (i >= period) {
      const old = values[i - period];
      sum -= Number.isFinite(old) ? old : 0;
    }
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function std(values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1).filter(Number.isFinite);
    if (slice.length !== period) continue;
    const m = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - m, 2), 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (prev === null) prev = v;
    else prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (i >= period) {
      if (avgLoss === 0) out[i] = 100;
      else {
        const rs = avgGain / avgLoss;
        out[i] = 100 - 100 / (1 + rs);
      }
    }
  }

  return out;
}

function atr(candles, period = 10) {
  const tr = Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!prev) tr[i] = c.high - c.low;
    else tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }

  const out = Array(candles.length).fill(null);
  let prevAtr = null;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) continue;
    if (prevAtr === null) {
      const slice = tr.slice(i - period + 1, i + 1);
      prevAtr = slice.reduce((a, b) => a + b, 0) / period;
    } else {
      prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
    }
    out[i] = prevAtr;
  }
  return out;
}

function supertrendDirection(candles, multiplier, period) {
  const a = atr(candles, period);
  const dir = Array(candles.length).fill(0);
  const finalUpper = Array(candles.length).fill(null);
  const finalLower = Array(candles.length).fill(null);

  let trend = 1;

  for (let i = 0; i < candles.length; i++) {
    if (!a[i]) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * a[i];
    const basicLower = hl2 - multiplier * a[i];

    if (i === 0 || finalUpper[i - 1] === null) {
      finalUpper[i] = basicUpper;
      finalLower[i] = basicLower;
    } else {
      finalUpper[i] = basicUpper < finalUpper[i - 1] || candles[i - 1].close > finalUpper[i - 1] ? basicUpper : finalUpper[i - 1];
      finalLower[i] = basicLower > finalLower[i - 1] || candles[i - 1].close < finalLower[i - 1] ? basicLower : finalLower[i - 1];

      if (candles[i].close > finalUpper[i - 1]) trend = 1;
      else if (candles[i].close < finalLower[i - 1]) trend = -1;
    }

    dir[i] = trend;
  }

  return dir;
}

function heikinAshi(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    out.push({ ts: c.ts, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: c.volume });
  }
  return out;
}

function resampleTo1h(candles) {
  const buckets = new Map();
  for (const c of candles) {
    const b = Math.floor(c.ts / 3600000) * 3600000;
    if (!buckets.has(b)) {
      buckets.set(b, { ts: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      const x = buckets.get(b);
      x.high = Math.max(x.high, c.high);
      x.low = Math.min(x.low, c.low);
      x.close = c.close;
      x.volume += c.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

function rocr(values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    out[i] = values[i - period] ? values[i] / values[i - period] : null;
  }
  return out;
}

function mergeHourlyRoCR(candles1m) {
  const h1 = resampleTo1h(candles1m);
  const ha1h = heikinAshi(h1);
  const rocr1h = rocr(ha1h.map((c) => c.close), 168);
  const hourly = h1.map((c, i) => ({ ts: c.ts, rocr: rocr1h[i] }));

  let j = 0;
  return candles1m.map((c) => {
    while (j + 1 < hourly.length && hourly[j + 1].ts <= c.ts) j++;
    return hourly[j] ? hourly[j].rocr : null;
  });
}

function buildSupertrendSignals(candles, params) {
  const d1 = supertrendDirection(candles, params.a.mult, params.a.period);
  const d2 = supertrendDirection(candles, params.b.mult, params.b.period);
  const d3 = supertrendDirection(candles, params.c.mult, params.c.period);

  return candles.map((_, i) => {
    const allUp = d1[i] === 1 && d2[i] === 1 && d3[i] === 1;
    const allDown = d1[i] === -1 && d2[i] === -1 && d3[i] === -1;
    return {
      longEntry: allUp,
      shortEntry: allDown,
      longExit: allDown,
      shortExit: allUp,
    };
  });
}

const CLUC_PARAMS = {
  BTCUSDT: { bbdeltaClose: 0.01192, bbdeltaTail: 0.96183, closeBblower: 0.01212, closedeltaClose: 0.01039, rocr1h: 0.53422, sellFisher: 0.38414, sellBbMiddleClose: 0.98016 },
  ETHUSDT: { bbdeltaClose: 0.01566, bbdeltaTail: 0.8478, closeBblower: 0.00998, closedeltaClose: 0.00614, rocr1h: 0.61579, sellFisher: 0.38414, sellBbMiddleClose: 1.02894 },
  SOLUSDT: { bbdeltaClose: 0.01806, bbdeltaTail: 0.85912, closeBblower: 0.01158, closedeltaClose: 0.01466, rocr1h: 0.51901, sellFisher: 0.38414, sellBbMiddleClose: 0.96094 },
};

function buildClucSignals(symbol, candles) {
  const p = CLUC_PARAMS[symbol] || CLUC_PARAMS.SOLUSDT;
  const ha = heikinAshi(candles);
  const typical = ha.map((c) => (c.high + c.low + c.close) / 3);
  const mid = sma(typical, 40);
  const sd = std(typical, 40);
  const lower = mid.map((m, i) => (m === null || sd[i] === null ? null : m - 2 * sd[i]));

  const haClose = ha.map((c) => c.close);
  const haHigh = ha.map((c) => c.high);
  const haLow = ha.map((c) => c.low);
  const emaFast = ema(haClose, 3);
  const emaSlow = ema(haClose, 50);
  const r = rsi(candles.map((c) => c.close), 14);
  const fisher = r.map((x) => (x === null ? null : Math.tanh(0.1 * (x - 50))));
  const rocr1h = mergeHourlyRoCR(candles);

  const signals = candles.map(() => ({
    longEntry: false,
    shortEntry: false,
    longExit: false,
    shortExit: false,
  }));

  for (let i = 3; i < candles.length; i++) {
    const bbdelta = mid[i] !== null && lower[i] !== null ? Math.abs(mid[i] - lower[i]) : null;
    const closedelta = Math.abs(haClose[i] - haClose[i - 1]);
    const tail = Math.abs(haClose[i] - haLow[i]);

    const pullback =
      rocr1h[i] !== null &&
      rocr1h[i] > p.rocr1h &&
      lower[i - 1] &&
      lower[i - 1] > 0 &&
      bbdelta !== null &&
      bbdelta > haClose[i] * p.bbdeltaClose &&
      closedelta > haClose[i] * p.closedeltaClose &&
      tail < bbdelta * p.bbdeltaTail &&
      haClose[i] < lower[i - 1] &&
      haClose[i] <= haClose[i - 1];

    const deepBelow =
      lower[i] &&
      haClose[i] < emaSlow[i] &&
      haClose[i] < p.closeBblower * lower[i];

    const sell =
      fisher[i] !== null &&
      fisher[i] > p.sellFisher &&
      haHigh[i] <= haHigh[i - 1] &&
      haHigh[i - 1] <= haHigh[i - 2] &&
      haClose[i] <= haClose[i - 1] &&
      emaFast[i] > haClose[i] &&
      mid[i] &&
      haClose[i] * p.sellBbMiddleClose > mid[i] &&
      candles[i].volume > 0;

    signals[i].longEntry = Boolean((pullback || deepBelow) && candles[i].volume > 0);
    signals[i].longExit = Boolean(sell);
  }

  return signals;
}

function backtest(candles, signals, opts) {
  let pos = null;
  const trades = [];
  let equityBps = 0;
  let peakBps = 0;
  let maxDrawdownBps = 0;

  const start = opts.startIdx || 0;
  const end = opts.endIdx || candles.length - 1;

  for (let i = Math.max(start, 2); i < Math.min(end, candles.length - 2); i++) {
    const c = candles[i];
    const next = candles[i + 1];
    const sig = signals[i];

    if (!pos) {
      if (sig.longEntry) {
        pos = { side: "LONG", entryIdx: i + 1, entry: next.open, entryTs: next.ts };
      } else if (opts.allowShort && sig.shortEntry) {
        pos = { side: "SHORT", entryIdx: i + 1, entry: next.open, entryTs: next.ts };
      }
      continue;
    }

    const held = i - pos.entryIdx;
    let exit = null;
    let reason = null;

    if (pos.side === "LONG") {
      const stop = pos.entry * (1 - opts.stopLossPct);
      const take = pos.entry * (1 + opts.takeProfitPct);

      if (c.low <= stop) {
        exit = stop;
        reason = "STOP";
      } else if (c.high >= take) {
        exit = take;
        reason = "TAKE_PROFIT";
      } else if (sig.longExit) {
        exit = next.open;
        reason = "SIGNAL_EXIT";
      } else if (held >= opts.maxHoldCandles) {
        exit = next.open;
        reason = "MAX_HOLD";
      }
    } else {
      const stop = pos.entry * (1 + opts.stopLossPct);
      const take = pos.entry * (1 - opts.takeProfitPct);

      if (c.high >= stop) {
        exit = stop;
        reason = "STOP";
      } else if (c.low <= take) {
        exit = take;
        reason = "TAKE_PROFIT";
      } else if (sig.shortExit) {
        exit = next.open;
        reason = "SIGNAL_EXIT";
      } else if (held >= opts.maxHoldCandles) {
        exit = next.open;
        reason = "MAX_HOLD";
      }
    }

    if (exit !== null) {
      const rawBps = pos.side === "LONG"
        ? ((exit - pos.entry) / pos.entry) * 10000
        : ((pos.entry - exit) / pos.entry) * 10000;

      const netBps = rawBps - TOTAL_COST_BPS;
      trades.push({
        side: pos.side,
        entryTs: pos.entryTs,
        exitTs: next.ts,
        entry: pos.entry,
        exit,
        rawBps,
        netBps,
        reason,
        heldCandles: held,
      });

      equityBps += netBps;
      peakBps = Math.max(peakBps, equityBps);
      maxDrawdownBps = Math.max(maxDrawdownBps, peakBps - equityBps);
      pos = null;
    }
  }

  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;

  for (const t of trades) {
    if (t.netBps > 0) {
      wins++;
      grossWin += t.netBps;
    } else {
      losses++;
      grossLoss += Math.abs(t.netBps);
    }
  }

  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : grossWin / grossLoss;
  const winRate = trades.length ? wins / trades.length : 0;

  return {
    trades: trades.length,
    netBps: Number(equityBps.toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(4)),
    winRate: Number(winRate.toFixed(4)),
    maxDrawdownBps: Number(maxDrawdownBps.toFixed(4)),
    avgNetBps: trades.length ? Number((equityBps / trades.length).toFixed(4)) : 0,
    grossWin: Number(grossWin.toFixed(4)),
    grossLoss: Number(grossLoss.toFixed(4)),
    sampleTrades: trades.slice(-5),
  };
}

function candidatePasses(r) {
  return (
    r.validation.trades >= MIN_TRADES &&
    r.validation.netBps > 0 &&
    r.validation.profitFactor >= MIN_PROFIT_FACTOR &&
    r.validation.maxDrawdownBps <= MAX_DRAWDOWN_BPS &&
    r.training.netBps > 0
  );
}

async function evaluate() {
  console.log("V27_FREQTRADE_RESEARCH_START", {
    symbols: SYMBOLS,
    days: DAYS,
    totalCostBps: TOTAL_COST_BPS,
    minTrades: MIN_TRADES,
    minProfitFactor: MIN_PROFIT_FACTOR,
  });

  const allResults = [];
  const readyProfiles = [];

  for (const symbol of SYMBOLS) {
    console.log(`Downloading/loading ${symbol} candles...`);

    const candles1m = await fetchBybitKlines(symbol, "1", DAYS);
    const candles5m = await fetchBybitKlines(symbol, "5", DAYS);

    console.log(`${symbol}: 1m=${candles1m.length}, 5m=${candles5m.length}`);

    const supertrendParamSets = [
      {
        name: "Supertrend_3x_original",
        a: { mult: 3, period: 12 },
        b: { mult: 1, period: 10 },
        c: { mult: 2, period: 11 },
      },
      {
        name: "Supertrend_fast",
        a: { mult: 2, period: 7 },
        b: { mult: 3, period: 10 },
        c: { mult: 4, period: 14 },
      },
      {
        name: "Supertrend_slow",
        a: { mult: 3, period: 14 },
        b: { mult: 4, period: 18 },
        c: { mult: 5, period: 21 },
      },
    ];

    for (const params of supertrendParamSets) {
      const signals = buildSupertrendSignals(candles5m, params);
      for (const stopLossPct of [0.015, 0.025, 0.04, 0.07]) {
        for (const takeProfitPct of [0.015, 0.025, 0.04, 0.07, 0.1]) {
          for (const maxHoldCandles of [24, 48, 96, 192]) {
            const split = Math.floor(candles5m.length * 0.7);
            const opts = { stopLossPct, takeProfitPct, maxHoldCandles, allowShort: true };

            const training = backtest(candles5m, signals, { ...opts, startIdx: 0, endIdx: split });
            const validation = backtest(candles5m, signals, { ...opts, startIdx: split, endIdx: candles5m.length - 2 });

            allResults.push({
              symbol,
              strategy: params.name,
              timeframe: "5m",
              params: { ...params, stopLossPct, takeProfitPct, maxHoldCandles, allowShort: true },
              training,
              validation,
            });
          }
        }
      }
    }

    const clucSignals = buildClucSignals(symbol, candles1m);
    for (const stopLossPct of [0.015, 0.02, 0.035, 0.05, 0.08]) {
      for (const takeProfitPct of [0.008, 0.012, 0.02, 0.035, 0.05]) {
        for (const maxHoldCandles of [30, 60, 120, 240, 480]) {
          const split = Math.floor(candles1m.length * 0.7);
          const opts = { stopLossPct, takeProfitPct, maxHoldCandles, allowShort: false };

          const training = backtest(candles1m, clucSignals, { ...opts, startIdx: 0, endIdx: split });
          const validation = backtest(candles1m, clucSignals, { ...opts, startIdx: split, endIdx: candles1m.length - 2 });

          allResults.push({
            symbol,
            strategy: "ClucHAnix_pullback",
            timeframe: "1m",
            params: { stopLossPct, takeProfitPct, maxHoldCandles, allowShort: false, clucParams: CLUC_PARAMS[symbol] || CLUC_PARAMS.SOLUSDT },
            training,
            validation,
          });
        }
      }
    }
  }

  allResults.sort((a, b) => {
    const ap = candidatePasses(a) ? 1 : 0;
    const bp = candidatePasses(b) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.validation.netBps - a.validation.netBps;
  });

  for (const r of allResults) {
    if (candidatePasses(r)) readyProfiles.push(r);
  }

  const report = {
    version: "V27_FREQTRADE_STRATEGY_PACK",
    generatedAt: new Date().toISOString(),
    noLiveOrders: true,
    source: "werkkrew/freqtrade-strategies ideas translated into local research candidates",
    symbols: SYMBOLS,
    days: DAYS,
    totalCostBps: TOTAL_COST_BPS,
    gates: {
      minTrades: MIN_TRADES,
      minProfitFactor: MIN_PROFIT_FACTOR,
      maxDrawdownBps: MAX_DRAWDOWN_BPS,
      trainingNetPositiveRequired: true,
      validationNetPositiveRequired: true,
    },
    status: readyProfiles.length ? "READY_PROFILE_FOUND" : "NO_VALID_FREQTRADE_EDGE_FOUND",
    readyCount: readyProfiles.length,
    best: allResults[0] || null,
    readyProfiles: readyProfiles.slice(0, 10),
    top20: allResults.slice(0, 20),
  };

  const reportFile = path.join(REPORT_DIR, "v27-freqtrade-report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  const profileFile = path.join(PROFILE_DIR, "live-profile-v27.json");
  if (readyProfiles.length) {
    fs.writeFileSync(profileFile, JSON.stringify({
      version: "V27_FREQTRADE_STRATEGY_PACK",
      generatedAt: report.generatedAt,
      status: "READY_FOR_LIVE_ADAPTER",
      noLiveOrdersYet: true,
      note: "This is a research-approved profile. Live execution adapter still must be wired safely before real orders.",
      totalCostBps: TOTAL_COST_BPS,
      profiles: readyProfiles.slice(0, 5),
    }, null, 2));
  } else {
    fs.writeFileSync(profileFile, JSON.stringify({
      version: "V27_FREQTRADE_STRATEGY_PACK",
      generatedAt: report.generatedAt,
      status: "REJECTED",
      reason: "NO_VALID_FREQTRADE_EDGE_FOUND",
      best: allResults[0] || null,
    }, null, 2));
  }

  console.log("");
  console.log("=== V27 RESULT ===");
  console.log(report.status);
  console.log("Report:", reportFile);
  console.log("Profile:", profileFile);

  if (readyProfiles.length) {
    console.log("READY_PROFILE_FOUND");
    console.log("Best ready profile:");
    console.log(JSON.stringify(readyProfiles[0], null, 2));
    console.log("");
    console.log("NEXT: live adapter can be wired safely around models/v27/live-profile-v27.json");
  } else {
    console.log("NO_VALID_FREQTRADE_EDGE_FOUND");
    console.log("Best rejected candidate:");
    console.log(JSON.stringify(allResults[0] || null, null, 2));
  }
}

evaluate().catch((err) => {
  console.error("V27_FREQTRADE_RESEARCH_FAILED");
  console.error(err);
  process.exit(1);
});
