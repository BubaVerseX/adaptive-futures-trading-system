#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = process.cwd();
const CACHE = path.join(ROOT, "data/research/cache");
const REPORTS = path.join(ROOT, "data/research/reports");
const MODELS = path.join(ROOT, "models/v28");

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(REPORTS, { recursive: true });
fs.mkdirSync(MODELS, { recursive: true });

const SYMBOL = "ETHUSDT";
const DAYS = Number(process.env.V28_DAYS || 120);
const COST_BPS = Number(process.env.V28_COST_BPS || 12.2);
const REFRESH = process.argv.includes("--refresh");

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchCandles(interval) {
  const file = path.join(CACHE, `v28_${SYMBOL}_${interval}_${DAYS}d.json`);
  if (!REFRESH && fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.length > 100) return data;
  }

  const now = Date.now();
  const start = now - DAYS * 24 * 60 * 60 * 1000;
  const step = Number(interval) * 60 * 1000;
  let cursor = start;
  const seen = new Set();
  const out = [];

  while (cursor < now) {
    const q = new URLSearchParams({
      category: "linear",
      symbol: SYMBOL,
      interval,
      start: String(cursor),
      end: String(now),
      limit: "1000",
    });

    const json = await getJson(`https://api.bybit.com/v5/market/kline?${q}`);
    if (!json || json.retCode !== 0) {
      throw new Error("Bybit download failed: " + JSON.stringify(json).slice(0, 200));
    }

    const rows = json.result.list.map(r => ({
      ts: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    })).sort((a, b) => a.ts - b.ts);

    if (!rows.length) break;

    for (const c of rows) {
      if (!seen.has(c.ts) && c.close > 0) {
        seen.add(c.ts);
        out.push(c);
      }
    }

    const next = rows[rows.length - 1].ts + step;
    if (next <= cursor) break;
    cursor = next;
    await sleep(100);
  }

  out.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

function atr(candles, period) {
  const tr = candles.map((c, i) => {
    const p = candles[i - 1];
    if (!p) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  });

  const out = Array(candles.length).fill(null);
  let v = null;

  for (let i = 0; i < candles.length; i++) {
    if (i < period) continue;
    if (v === null) {
      v = tr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    } else {
      v = (v * (period - 1) + tr[i]) / period;
    }
    out[i] = v;
  }

  return out;
}

function supertrend(candles, mult, period) {
  const a = atr(candles, period);
  const dir = Array(candles.length).fill(0);
  const upper = Array(candles.length).fill(null);
  const lower = Array(candles.length).fill(null);
  let trend = 1;

  for (let i = 0; i < candles.length; i++) {
    if (!a[i]) continue;

    const hl2 = (candles[i].high + candles[i].low) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];

    if (i === 0 || upper[i - 1] === null) {
      upper[i] = bu;
      lower[i] = bl;
    } else {
      upper[i] = bu < upper[i - 1] || candles[i - 1].close > upper[i - 1] ? bu : upper[i - 1];
      lower[i] = bl > lower[i - 1] || candles[i - 1].close < lower[i - 1] ? bl : lower[i - 1];

      if (candles[i].close > upper[i - 1]) trend = 1;
      if (candles[i].close < lower[i - 1]) trend = -1;
    }

    dir[i] = trend;
  }

  return dir;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }

  return out;
}

function signals(candles, p) {
  const d1 = supertrend(candles, p.m1, p.p1);
  const d2 = supertrend(candles, p.m2, p.p2);
  const d3 = supertrend(candles, p.m3, p.p3);
  const close = candles.map(c => c.close);
  const e1 = ema(close, 50);
  const e2 = ema(close, 200);
  const a = atr(candles, 14);

  return candles.map((c, i) => {
    const up = d1[i] === 1 && d2[i] === 1 && d3[i] === 1;
    const down = d1[i] === -1 && d2[i] === -1 && d3[i] === -1;
    const trendOkLong = !p.emaFilter || e1[i] > e2[i];
    const trendOkShort = !p.emaFilter || e1[i] < e2[i];
    const vol = a[i] ? a[i] / c.close : 0;
    const volOk = vol >= p.minAtr && vol <= p.maxAtr;

    return {
      longEntry: up && trendOkLong && volOk,
      shortEntry: down && trendOkShort && volOk,
      longExit: down,
      shortExit: up,
    };
  });
}

function backtest(candles, sig, p, start, end) {
  let pos = null;
  let equity = 0;
  let peak = 0;
  let dd = 0;
  let wins = 0;
  let gw = 0;
  let gl = 0;
  const trades = [];

  for (let i = Math.max(start, 250); i < Math.min(end, candles.length - 2); i++) {
    const c = candles[i];
    const next = candles[i + 1];
    const s = sig[i];

    if (!pos) {
      if ((p.side === "LONG" || p.side === "BOTH") && s.longEntry) {
        pos = { side: "LONG", entry: next.open, entryTs: next.ts, idx: i + 1 };
      } else if ((p.side === "SHORT" || p.side === "BOTH") && s.shortEntry) {
        pos = { side: "SHORT", entry: next.open, entryTs: next.ts, idx: i + 1 };
      }
      continue;
    }

    const held = i - pos.idx;
    let exit = null;
    let reason = null;

    if (pos.side === "LONG") {
      if (c.low <= pos.entry * (1 - p.sl)) {
        exit = pos.entry * (1 - p.sl);
        reason = "SL";
      } else if (c.high >= pos.entry * (1 + p.tp)) {
        exit = pos.entry * (1 + p.tp);
        reason = "TP";
      } else if (s.longExit && held >= p.minHold) {
        exit = next.open;
        reason = "SIGNAL";
      } else if (held >= p.maxHold) {
        exit = next.open;
        reason = "TIME";
      }
    } else {
      if (c.high >= pos.entry * (1 + p.sl)) {
        exit = pos.entry * (1 + p.sl);
        reason = "SL";
      } else if (c.low <= pos.entry * (1 - p.tp)) {
        exit = pos.entry * (1 - p.tp);
        reason = "TP";
      } else if (s.shortExit && held >= p.minHold) {
        exit = next.open;
        reason = "SIGNAL";
      } else if (held >= p.maxHold) {
        exit = next.open;
        reason = "TIME";
      }
    }

    if (exit !== null) {
      const raw = pos.side === "LONG"
        ? ((exit - pos.entry) / pos.entry) * 10000
        : ((pos.entry - exit) / pos.entry) * 10000;

      const net = raw - COST_BPS;
      equity += net;
      peak = Math.max(peak, equity);
      dd = Math.max(dd, peak - equity);

      if (net > 0) {
        wins++;
        gw += net;
      } else {
        gl += Math.abs(net);
      }

      trades.push({
        side: pos.side,
        rawBps: Number(raw.toFixed(2)),
        netBps: Number(net.toFixed(2)),
        reason,
        held,
      });

      pos = null;
    }
  }

  return {
    trades: trades.length,
    netBps: Number(equity.toFixed(2)),
    profitFactor: gl === 0 ? (gw > 0 ? 999 : 0) : Number((gw / gl).toFixed(3)),
    winRate: trades.length ? Number((wins / trades.length).toFixed(3)) : 0,
    maxDrawdownBps: Number(dd.toFixed(2)),
    sample: trades.slice(-5),
  };
}

function pass(r) {
  return (
    r.train.trades >= 8 &&
    r.val.trades >= 5 &&
    r.test.trades >= 5 &&
    r.train.netBps > 0 &&
    r.val.netBps > 0 &&
    r.test.netBps > 0 &&
    r.val.profitFactor >= 1.15 &&
    r.test.profitFactor >= 1.15 &&
    r.test.maxDrawdownBps < 1200
  );
}

async function main() {
  console.log("V28 ETH Supertrend optimizer started...");
  const candles = await fetchCandles("5");
  console.log("candles:", candles.length);

  const split1 = Math.floor(candles.length * 0.5);
  const split2 = Math.floor(candles.length * 0.75);
  const results = [];

  const stSets = [
    { name: "fast", m1: 2, p1: 7, m2: 3, p2: 10, m3: 4, p3: 14 },
    { name: "balanced", m1: 2, p1: 10, m2: 3, p2: 14, m3: 4, p3: 21 },
    { name: "slow", m1: 3, p1: 14, m2: 4, p2: 21, m3: 5, p3: 28 },
    { name: "original", m1: 3, p1: 12, m2: 1, p2: 10, m3: 2, p3: 11 },
  ];

  for (const st of stSets) {
    for (const emaFilter of [true, false]) {
      for (const minAtr of [0, 0.001, 0.002, 0.003]) {
        for (const maxAtr of [0.03, 0.06, 0.1]) {
          const base = { ...st, emaFilter, minAtr, maxAtr };
          const sig = signals(candles, base);

          for (const side of ["LONG", "SHORT", "BOTH"]) {
            for (const sl of [0.01, 0.015, 0.02, 0.03]) {
              for (const tp of [0.015, 0.025, 0.04, 0.06]) {
                for (const maxHold of [24, 48, 96, 144]) {
                  const p = { ...base, side, sl, tp, maxHold, minHold: 2 };

                  const train = backtest(candles, sig, p, 0, split1);
                  const val = backtest(candles, sig, p, split1, split2);
                  const test = backtest(candles, sig, p, split2, candles.length - 2);

                  results.push({
                    symbol: SYMBOL,
                    strategy: "V28_ETH_SUPERTREND",
                    timeframe: "5m",
                    params: p,
                    train,
                    val,
                    test,
                    totalNetBps: Number((train.netBps + val.netBps + test.netBps).toFixed(2)),
                    ready: false,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  for (const r of results) r.ready = pass(r);

  results.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return (
      (b.test.netBps + b.val.netBps * 0.6 + b.train.netBps * 0.3) -
      (a.test.netBps + a.val.netBps * 0.6 + a.train.netBps * 0.3)
    );
  });

  const ready = results.filter(r => r.ready);
  const best = results[0];

  const report = {
    version: "V28_SIMPLE_ETH_SUPERTREND",
    generatedAt: new Date().toISOString(),
    noLiveOrders: true,
    status: ready.length ? "READY_PROFILE_FOUND" : "REJECTED",
    reason: ready.length ? null : "NO_STABLE_ETH_SUPERTREND_EDGE_FOUND",
    readyCount: ready.length,
    best,
    top10: results.slice(0, 10),
  };

  fs.writeFileSync(path.join(REPORTS, "v28-eth-supertrend-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(MODELS, "live-profile-v28.json"), JSON.stringify({
    version: "V28_SIMPLE_ETH_SUPERTREND",
    generatedAt: report.generatedAt,
    status: ready.length ? "READY_FOR_SHADOW_ADAPTER" : "REJECTED",
    reason: ready.length ? null : "NO_STABLE_ETH_SUPERTREND_EDGE_FOUND",
    best: ready[0] || best,
    profiles: ready.slice(0, 5),
  }, null, 2));

  console.log("V28 finished:", report.status);
  console.log("Ready profiles:", ready.length);
  console.log("Check: cat models/v28/live-profile-v28.json");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
