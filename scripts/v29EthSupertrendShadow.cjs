#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = process.cwd();
const PROFILE_FILE = path.join(ROOT, "models/v28/live-profile-v28.json");
const REPORT_DIR = path.join(ROOT, "data/research/reports");
const STATE_FILE = path.join(ROOT, "models/v29/shadow-state-v29.json");
const REPORT_FILE = path.join(ROOT, "models/v29/shadow-report-v29.json");

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, "models/v29"), { recursive: true });

const SYMBOL = "ETHUSDT";
const INTERVAL = "5";
const COST_BPS = Number(process.env.V29_COST_BPS || 12.2);
const DURATION_MINUTES = Number(process.env.V29_DURATION_MINUTES || 180);

function loadProfile() {
  if (!fs.existsSync(PROFILE_FILE)) {
    throw new Error("V28 profile missing: " + PROFILE_FILE);
  }

  const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));

  if (profile.status !== "READY_FOR_SHADOW_ADAPTER") {
    throw new Error("V28 profile not ready. Status: " + profile.status);
  }

  return profile.best.params;
}

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

async function fetchCandles() {
  const q = new URLSearchParams({
    category: "linear",
    symbol: SYMBOL,
    interval: INTERVAL,
    limit: "500",
  });

  const json = await getJson(`https://api.bybit.com/v5/market/kline?${q}`);

  if (!json || json.retCode !== 0) {
    throw new Error("Bybit candle fetch failed: " + JSON.stringify(json).slice(0, 200));
  }

  return json.result.list.map(r => ({
    ts: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  })).sort((a, b) => a.ts - b.ts);
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

function signalAt(candles, p, i) {
  const d1 = supertrend(candles, p.m1, p.p1);
  const d2 = supertrend(candles, p.m2, p.p2);
  const d3 = supertrend(candles, p.m3, p.p3);

  const close = candles.map(c => c.close);
  const e1 = ema(close, 50);
  const e2 = ema(close, 200);
  const a = atr(candles, 14);

  const c = candles[i];

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
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }

  return {
    startedAt: new Date().toISOString(),
    lastClosedCandleTs: null,
    position: null,
    trades: [],
    netBps: 0,
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function writeReport(state, profileParams, status) {
  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;

  for (const t of state.trades) {
    if (t.netBps > 0) {
      wins++;
      grossWin += t.netBps;
    } else {
      grossLoss += Math.abs(t.netBps);
    }
  }

  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : grossWin / grossLoss;

  const report = {
    version: "V29_ETH_SUPERTREND_SHADOW",
    generatedAt: new Date().toISOString(),
    status,
    noLiveOrders: true,
    symbol: SYMBOL,
    timeframe: "5m",
    costBps: COST_BPS,
    profileParams,
    openPosition: state.position,
    trades: state.trades.length,
    netBps: Number(state.netBps.toFixed(2)),
    winRate: state.trades.length ? Number((wins / state.trades.length).toFixed(3)) : 0,
    profitFactor: Number(profitFactor.toFixed(3)),
    lastTrades: state.trades.slice(-10),
    liveEligibility: {
      eligible: state.trades.length >= 5 && state.netBps > 0 && profitFactor >= 1.15,
      minimumTrades: 5,
      positiveNetRequired: true,
      minimumProfitFactor: 1.15,
    },
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const profileParams = loadProfile();
  const state = loadState();

  console.log("V29 ETH Supertrend Shadow started. NO LIVE ORDERS.");
  console.log("Duration minutes:", DURATION_MINUTES);

  const endAt = Date.now() + DURATION_MINUTES * 60 * 1000;

  while (Date.now() < endAt) {
    try {
      const candles = await fetchCandles();

      const closedIndex = candles.length - 2;
      const nextIndex = candles.length - 1;

      const closed = candles[closedIndex];
      const next = candles[nextIndex];

      if (!closed || !next || closed.ts === state.lastClosedCandleTs) {
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }

      state.lastClosedCandleTs = closed.ts;

      const sig = signalAt(candles, profileParams, closedIndex);

      if (!state.position) {
        if ((profileParams.side === "LONG" || profileParams.side === "BOTH") && sig.longEntry) {
          state.position = {
            side: "LONG",
            entry: next.open,
            entryTs: next.ts,
            entryCandleTs: closed.ts,
            heldCandles: 0,
          };
          console.log("SHADOW_ENTRY_LONG", state.position);
        } else if ((profileParams.side === "SHORT" || profileParams.side === "BOTH") && sig.shortEntry) {
          state.position = {
            side: "SHORT",
            entry: next.open,
            entryTs: next.ts,
            entryCandleTs: closed.ts,
            heldCandles: 0,
          };
          console.log("SHADOW_ENTRY_SHORT", state.position);
        }
      } else {
        const pos = state.position;
        pos.heldCandles += 1;

        let exit = null;
        let reason = null;

        if (pos.side === "LONG") {
          if (closed.low <= pos.entry * (1 - profileParams.sl)) {
            exit = pos.entry * (1 - profileParams.sl);
            reason = "SL";
          } else if (closed.high >= pos.entry * (1 + profileParams.tp)) {
            exit = pos.entry * (1 + profileParams.tp);
            reason = "TP";
          } else if (sig.longExit && pos.heldCandles >= profileParams.minHold) {
            exit = next.open;
            reason = "SIGNAL";
          } else if (pos.heldCandles >= profileParams.maxHold) {
            exit = next.open;
            reason = "TIME";
          }
        } else {
          if (closed.high >= pos.entry * (1 + profileParams.sl)) {
            exit = pos.entry * (1 + profileParams.sl);
            reason = "SL";
          } else if (closed.low <= pos.entry * (1 - profileParams.tp)) {
            exit = pos.entry * (1 - profileParams.tp);
            reason = "TP";
          } else if (sig.shortExit && pos.heldCandles >= profileParams.minHold) {
            exit = next.open;
            reason = "SIGNAL";
          } else if (pos.heldCandles >= profileParams.maxHold) {
            exit = next.open;
            reason = "TIME";
          }
        }

        if (exit !== null) {
          const rawBps = pos.side === "LONG"
            ? ((exit - pos.entry) / pos.entry) * 10000
            : ((pos.entry - exit) / pos.entry) * 10000;

          const netBps = rawBps - COST_BPS;

          const trade = {
            side: pos.side,
            entry: Number(pos.entry.toFixed(4)),
            exit: Number(exit.toFixed(4)),
            entryTs: pos.entryTs,
            exitTs: next.ts,
            rawBps: Number(rawBps.toFixed(2)),
            netBps: Number(netBps.toFixed(2)),
            reason,
            heldCandles: pos.heldCandles,
          };

          state.trades.push(trade);
          state.netBps += netBps;
          state.position = null;

          console.log("SHADOW_EXIT", trade);
        }
      }

      saveState(state);
      const report = writeReport(state, profileParams, "RUNNING");
      console.log("SHADOW_STATUS", {
        trades: report.trades,
        netBps: report.netBps,
        profitFactor: report.profitFactor,
        eligible: report.liveEligibility.eligible,
      });

      await new Promise(r => setTimeout(r, 30000));
    } catch (err) {
      console.error("SHADOW_LOOP_ERROR", err.message);
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  const finalReport = writeReport(state, profileParams, "COMPLETED");
  console.log("V29_SHADOW_COMPLETED");
  console.log(JSON.stringify(finalReport.liveEligibility, null, 2));
  console.log("Report:", REPORT_FILE);
}

main().catch((err) => {
  console.error("V29_SHADOW_FAILED", err);
  process.exit(1);
});
