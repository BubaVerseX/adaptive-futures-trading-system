#!/usr/bin/env node
/**
 * scripts/researchLowTurnover.cjs
 *
 * Tests strategy families this repo has NOT tried yet. They're all low-turnover,
 * long-or-cash, and judged against buy-and-hold on risk (Sharpe, max drawdown),
 * not just raw return.
 *
 * Why these: every strategy tried so far was short-horizon directional trading,
 * and fees ate it (live: gross -$0.84, fees $6.32). The 3-year re-test on
 * 2026-10-01 found the daily Donchian system weakly positive but still behind
 * buy-and-hold at equal exposure. The families below trade a few times a month
 * at most and only try to sidestep the worst drawdowns:
 *
 *   BH          buy and hold (benchmark)
 *   BH_VOLTGT   buy and hold, size scaled to a target volatility
 *   TREND_SMA   hold when close > 100-day SMA, else cash
 *   TSMOM_VT    hold when 60-day return > 0, sized to target volatility
 *   ROTATION    weekly: hold the top 3 coins by 60-day return (if positive), else cash
 *
 * Parameters are fixed up front and NOT optimized. Tuning them to this data
 * would make the result meaningless.
 *
 * Data: reuses the daily-candle cache written by backtestBroadTrend.cjs
 * (data/research/cache/broadtrend/<SYMBOL>_<days>d.json). No network, no keys.
 *
 * ============ USAGE ============
 *   node scripts/backtestBroadTrend.cjs --top 40 --days 1095 --refresh   # fills the cache once
 *   node scripts/researchLowTurnover.cjs --days 1095
 *   node scripts/researchLowTurnover.cjs --days 1095 --venue perp --fee-mult 1.5
 *
 * Execution model: a decision made on day t's close earns day t+1's return (no
 * lookahead). Costs are charged on every change in position size. Portfolios are
 * equal-weight across symbols, and daily rebalancing is approximated (costs are
 * only charged on signal changes, so the portfolio rows slightly understate costs).
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_EXCLUDE = [
  // Tokenized stocks, ETFs, metals, oil: not crypto, different market hours/behavior.
  "XAUUSDT", "XAGUSDT", "XAUTUSDT", "MSTRUSDT", "SOXLUSDT", "MUUSDT", "SNDKUSDT", "CLUSDT", "KORUUSDT",
];

const VENUES = {
  // Bybit spot: 0.1% per side, no funding, no liquidation. Simplest for a small account.
  spot: { feeBpsPerSide: 10, slippageBpsPerSide: 2, fundingBpsPerDayLong: 0 },
  // Bybit USDT perp, taker: 0.055% per side; longs typically pay ~0.01%/8h funding.
  perp: { feeBpsPerSide: 5.5, slippageBpsPerSide: 2, fundingBpsPerDayLong: 3 },
};

const PARAMS = {
  smaLen: 100,
  momLookback: 60,
  volLookback: 20,
  targetAnnualVol: 0.5, // crypto majors run ~50-80% annualized; 50% keeps size at or below 1x
  maxLeverage: 1, // long-or-cash only, never borrowed exposure
  rotationTopK: 3,
  rotationEveryDays: 7,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    days: Number(get("--days", 1095)),
    venue: get("--venue", "spot"),
    feeMult: Number(get("--fee-mult", 1)),
    cacheDir: get("--cache", path.join(process.cwd(), "data/research/cache/broadtrend")),
    exclude: new Set(get("--exclude", DEFAULT_EXCLUDE.join(",")).split(",").filter(Boolean)),
    minDays: Number(get("--min-days", 365)),
  };
}

function loadUniverse(cacheDir, days, exclude, minDays) {
  if (!fs.existsSync(cacheDir)) {
    throw new Error(`No candle cache at ${cacheDir}. Run: node scripts/backtestBroadTrend.cjs --top 40 --days ${days} --refresh`);
  }
  const suffix = `_${days}d.json`;
  const out = {};
  for (const file of fs.readdirSync(cacheDir)) {
    if (!file.endsWith(suffix)) continue;
    const symbol = file.slice(0, -suffix.length);
    if (exclude.has(symbol)) continue;
    const candles = JSON.parse(fs.readFileSync(path.join(cacheDir, file), "utf8"))
      .filter((c) => c.close > 0)
      .sort((a, b) => a.ts - b.ts);
    // Bybit's newest daily candle is still forming. Drop it so a partial day isn't treated as a close.
    if (candles.length && Date.now() - candles[candles.length - 1].ts < 24 * 3600 * 1000) candles.pop();
    if (candles.length >= minDays) out[symbol] = candles;
  }
  return out;
}

// ---------------- signals: position in [0, 1] decided at close of day i ----------------

function sma(closes, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += closes[k];
  return s / n;
}

function realizedAnnualVol(closes, i, n) {
  if (i < n) return null;
  const rets = [];
  for (let k = i - n + 1; k <= i; k++) rets.push(Math.log(closes[k] / closes[k - 1]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * 365);
}

function volScale(closes, i) {
  const vol = realizedAnnualVol(closes, i, PARAMS.volLookback);
  if (!vol) return null;
  return Math.min(PARAMS.maxLeverage, PARAMS.targetAnnualVol / vol);
}

const SLEEVE_STRATEGIES = {
  BH: () => 1,
  BH_VOLTGT: (closes, i) => volScale(closes, i),
  TREND_SMA: (closes, i) => {
    const m = sma(closes, i, PARAMS.smaLen);
    return m === null ? null : closes[i] > m ? 1 : 0;
  },
  TSMOM_VT: (closes, i) => {
    if (i < PARAMS.momLookback) return null;
    const scale = volScale(closes, i);
    if (scale === null) return null;
    return closes[i] / closes[i - PARAMS.momLookback] - 1 > 0 ? scale : 0;
  },
};

// Warm-up: every strategy starts on the same day so all are compared over the same window.
const WARMUP = Math.max(PARAMS.smaLen, PARAMS.momLookback, PARAMS.volLookback) + 1;

function costBps(venue, feeMult) {
  return (venue.feeBpsPerSide * feeMult + venue.slippageBpsPerSide) / 10000;
}

// Daily net returns for one symbol under one strategy, keyed by candle timestamp.
function sleeveReturns(candles, signalFn, venue, feeMult) {
  const closes = candles.map((c) => c.close);
  const out = new Map();
  let pos = 0;
  let turnover = 0;
  let exposure = 0;
  let days = 0;
  for (let i = WARMUP; i < candles.length; i++) {
    const r = closes[i] / closes[i - 1] - 1;
    // pos was decided at close of i-1 and earns day i's return.
    const funding = pos * (venue.fundingBpsPerDayLong / 10000);
    const target = signalFn(closes, i) ?? 0;
    const trade = Math.abs(target - pos);
    const net = pos * r - funding - trade * costBps(venue, feeMult);
    out.set(candles[i].ts, net);
    exposure += pos;
    turnover += trade;
    days++;
    pos = target;
  }
  return { returns: out, avgExposure: days ? exposure / days : 0, turnoverPerYear: days ? (turnover / days) * 365 : 0 };
}

// Weekly cross-sectional momentum across the whole universe.
function rotationReturns(universe, venue, feeMult) {
  const symbols = Object.keys(universe);
  const closeBy = {};
  const allTs = new Set();
  for (const s of symbols) {
    closeBy[s] = new Map(universe[s].map((c) => [c.ts, c.close]));
    universe[s].forEach((c) => allTs.add(c.ts));
  }
  const dates = [...allTs].sort((a, b) => a - b);
  const DAY = 24 * 3600 * 1000;
  const out = new Map();
  let weights = {};
  let turnover = 0;
  let exposure = 0;
  let days = 0;

  for (let d = WARMUP; d < dates.length; d++) {
    const ts = dates[d];
    const prevTs = ts - DAY;
    let gross = 0;
    for (const [s, w] of Object.entries(weights)) {
      const c = closeBy[s].get(ts), p = closeBy[s].get(prevTs);
      if (c && p) gross += w * (c / p - 1);
    }
    const held = Object.values(weights).reduce((a, b) => a + b, 0);
    let net = gross - held * (venue.fundingBpsPerDayLong / 10000);

    if ((d - WARMUP) % PARAMS.rotationEveryDays === 0) {
      const lookTs = ts - PARAMS.momLookback * DAY;
      const ranked = symbols
        .map((s) => {
          const c = closeBy[s].get(ts), p = closeBy[s].get(lookTs);
          return c && p ? { s, mom: c / p - 1 } : null;
        })
        .filter((x) => x && x.mom > 0)
        .sort((a, b) => b.mom - a.mom)
        .slice(0, PARAMS.rotationTopK);
      const next = {};
      for (const x of ranked) next[x.s] = 1 / PARAMS.rotationTopK;
      const keys = new Set([...Object.keys(weights), ...Object.keys(next)]);
      let trade = 0;
      for (const k of keys) trade += Math.abs((next[k] || 0) - (weights[k] || 0));
      net -= trade * costBps(venue, feeMult);
      turnover += trade;
      weights = next;
    }
    out.set(ts, net);
    exposure += held;
    days++;
  }
  return { returns: out, avgExposure: days ? exposure / days : 0, turnoverPerYear: days ? (turnover / days) * 365 : 0 };
}

// ---------------- metrics ----------------

function metrics(rets) {
  if (rets.length < 30) return null;
  let eq = 1, peak = 1, maxDD = 0;
  for (const r of rets) {
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const years = rets.length / 365;
  return {
    totalPct: (eq - 1) * 100,
    cagrPct: (Math.pow(eq, 1 / years) - 1) * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    maxDDPct: maxDD * 100,
  };
}

// Equal-weight portfolio: average of the sleeves that exist on each date.
function portfolioSeries(sleeves) {
  const byTs = new Map();
  for (const sl of sleeves) {
    for (const [ts, r] of sl.returns) {
      const cur = byTs.get(ts) || { sum: 0, n: 0 };
      cur.sum += r;
      cur.n++;
      byTs.set(ts, cur);
    }
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sum / v.n);
}

const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "  n/a" : x.toFixed(d));

function main() {
  const args = parseArgs();
  const venue = VENUES[args.venue];
  if (!venue) throw new Error(`--venue must be one of: ${Object.keys(VENUES).join(", ")}`);
  const universe = loadUniverse(args.cacheDir, args.days, args.exclude, args.minDays);
  const symbols = Object.keys(universe).sort();
  if (!symbols.length) throw new Error("No usable symbols in cache.");

  console.log(`Low-turnover strategy research | ${symbols.length} symbols | ${args.days}d cache | venue=${args.venue} | fee x${args.feeMult}`);
  console.log(`Symbols: ${symbols.join(", ")}\n`);
  console.log("Warning: today's top-by-turnover list favors coins that survived and did well (survivorship bias).");
  console.log("Absolute returns are inflated for EVERY strategy here, buy-and-hold included. Compare strategies with each other.\n");

  const results = {};
  for (const [name, fn] of Object.entries(SLEEVE_STRATEGIES)) {
    const sleeves = symbols.map((s) => sleeveReturns(universe[s], fn, venue, args.feeMult));
    results[name] = {
      series: portfolioSeries(sleeves),
      avgExposure: sleeves.reduce((a, s) => a + s.avgExposure, 0) / sleeves.length,
      turnoverPerYear: sleeves.reduce((a, s) => a + s.turnoverPerYear, 0) / sleeves.length,
    };
  }
  const rot = rotationReturns(universe, venue, args.feeMult);
  results.ROTATION = { series: [...rot.returns.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r), avgExposure: rot.avgExposure, turnoverPerYear: rot.turnoverPerYear };

  const header = "Strategy     | CAGR %  | Sharpe | MaxDD % | Exposure | Turnover/yr || H1 Sharpe | H1 MaxDD | H2 Sharpe | H2 MaxDD";
  console.log(header);
  console.log("-".repeat(header.length));
  const table = {};
  for (const [name, r] of Object.entries(results)) {
    const mid = Math.floor(r.series.length / 2);
    const full = metrics(r.series), h1 = metrics(r.series.slice(0, mid)), h2 = metrics(r.series.slice(mid));
    table[name] = { full, h1, h2, avgExposure: r.avgExposure, turnoverPerYear: r.turnoverPerYear };
    console.log(
      `${name.padEnd(12)} | ${fmt(full.cagrPct).padStart(7)} | ${fmt(full.sharpe).padStart(6)} | ${fmt(full.maxDDPct, 1).padStart(7)} | ` +
      `${fmt(r.avgExposure).padStart(8)} | ${fmt(r.turnoverPerYear, 1).padStart(11)} || ` +
      `${fmt(h1.sharpe).padStart(9)} | ${fmt(h1.maxDDPct, 1).padStart(8)} | ${fmt(h2.sharpe).padStart(9)} | ${fmt(h2.maxDDPct, 1).padStart(8)}`
    );
  }

  // Pre-registered bar: beat buy-and-hold on Sharpe AND have a smaller max drawdown, in BOTH halves.
  const bh = table.BH;
  console.log("\nVerdict vs buy-and-hold (needs higher Sharpe AND smaller max drawdown in BOTH halves):");
  for (const [name, t] of Object.entries(table)) {
    if (name === "BH") continue;
    const beats = (a, b) => a.sharpe > b.sharpe && a.maxDDPct < b.maxDDPct;
    const pass = beats(t.h1, bh.h1) && beats(t.h2, bh.h2);
    console.log(`  ${name.padEnd(12)} ${pass ? "PASS: candidate for paper trading" : "fail"}`);
  }
  console.log("\nA PASS is a reason to paper-trade, not to go live. Re-run with --fee-mult 1.5 and --venue perp before believing it.");

  const outFile = path.join(process.cwd(), "data/research/reports/low-turnover-report.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), args: { ...args, exclude: [...args.exclude] }, params: PARAMS, symbols, table }, null, 2));
  console.log(`\nFull results written to ${outFile}`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error("Fatal:", err.message); process.exit(1); }
}

module.exports = { sleeveReturns, rotationReturns, metrics, SLEEVE_STRATEGIES, VENUES, PARAMS };
