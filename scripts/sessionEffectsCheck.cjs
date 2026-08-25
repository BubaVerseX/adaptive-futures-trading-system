#!/usr/bin/env node
/**
 * scripts/sessionEffectsCheck.cjs
 *
 * Time-of-day / day-of-week pattern check on raw candle data only (price,
 * volume, timestamp -- no indicators). New hypothesis, not yet tested
 * elsewhere in this repo.
 *
 * For each symbol (BTCUSDT, ETHUSDT, SOLUSDT):
 *   - Buckets every 1h candle over ~210 days by UTC hour-of-day (0-23) and
 *     by UTC day-of-week (0=Sun..6=Sat).
 *   - Reports avg return, win rate, avg realized vol per bucket.
 *   - Flags buckets whose 95% CI on mean return excludes zero.
 *   - Splits the sample into two non-overlapping halves and checks whether
 *     any flagged bucket holds the same sign/significance in both halves
 *     (same two-window persistence standard used elsewhere in this repo).
 *
 * Separately, funding settlement check (00:00/08:00/16:00 UTC) using 15m
 * candles (finer resolution needed to isolate a 30-60min pre/post window):
 *   - mean return in the 60min/30min window before and after each
 *     settlement timestamp, aggregated across all settlements in the
 *     sample, with 95% CI and a two-window persistence check.
 *
 * Public Bybit data only, read-only, no API key needed.
 *
 * ============ USAGE ============
 *   node scripts/sessionEffectsCheck.cjs
 *   node scripts/sessionEffectsCheck.cjs --no-cache
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const HOURLY_DAYS = 210; // ~7 months, aiming for 4000+ 1h candles/symbol
const FUNDING_DAYS = 180; // 15m candles for the finer-grained settlement check
const SETTLEMENT_HOURS_UTC = [0, 8, 16];

function parseArgs() {
  const args = process.argv.slice(2);
  return { noCache: args.includes("--no-cache") };
}

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

function intervalMs(interval) {
  if (interval === "60") return 60 * 60 * 1000;
  if (interval === "15") return 15 * 60 * 1000;
  throw new Error("unsupported interval " + interval);
}

async function fetchCandles(symbol, interval, days) {
  const REST_BASE = "https://api.bybit.com";
  const stepMs = intervalMs(interval);
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

// ---------------- Stats ----------------

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdev(arr, m) {
  if (arr.length < 2) return 0;
  const mu = m === undefined ? mean(arr) : m;
  const variance = arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}
function ci95(arr) {
  const n = arr.length;
  const mu = mean(arr);
  const sd = stdev(arr, mu);
  const se = sd / Math.sqrt(n);
  return { mean: mu, se, lo: mu - 1.96 * se, hi: mu + 1.96 * se, n, sd };
}
function excludesZero(ciObj) { return ciObj.lo > 0 || ciObj.hi < 0; }

// ---------------- Bucketing ----------------

function candleStats(c) {
  const ret = ((c.close - c.open) / c.open) * 100;
  const green = c.close > c.open;
  const rv = ((c.high - c.low) / c.open) * 100;
  return { ret, green, rv };
}

function bucketByHour(candles) {
  const buckets = Array.from({ length: 24 }, () => []);
  for (const c of candles) {
    const h = new Date(c.ts).getUTCHours();
    buckets[h].push(candleStats(c));
  }
  return buckets;
}

function bucketByDow(candles) {
  const buckets = Array.from({ length: 7 }, () => []);
  for (const c of candles) {
    const d = new Date(c.ts).getUTCDay(); // 0=Sun
    buckets[d].push(candleStats(c));
  }
  return buckets;
}

function summarizeBucket(items) {
  const rets = items.map((i) => i.ret);
  const wins = items.filter((i) => i.green).length;
  const rvs = items.map((i) => i.rv);
  const c = ci95(rets);
  return {
    n: items.length,
    meanRet: c.mean,
    ciLo: c.lo,
    ciHi: c.hi,
    winRate: items.length ? (wins / items.length) * 100 : 0,
    avgRv: items.length ? mean(rvs) : 0,
    sig: items.length >= 30 ? excludesZero(c) : false,
  };
}

function splitHalves(candles) {
  const sorted = [...candles].sort((a, b) => a.ts - b.ts);
  const mid = Math.floor(sorted.length / 2);
  return { w1: sorted.slice(0, mid), w2: sorted.slice(mid) };
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function runHourDowAnalysis(symbol, candles) {
  console.log(`\n===================== ${symbol}: hour-of-day / day-of-week (1h candles) =====================`);
  console.log(`Total 1h candles: ${candles.length}  (${(candles[candles.length - 1].ts - candles[0].ts) / (24 * 3600 * 1000)} days span)`);

  const { w1, w2 } = splitHalves(candles);
  console.log(`Window split: W1 (older) n=${w1.length}, W2 (newer) n=${w2.length}`);

  // ---- Full sample ----
  const hourBuckets = bucketByHour(candles);
  const dowBuckets = bucketByDow(candles);

  console.log(`\n-- Hour-of-day (UTC), full sample --`);
  console.log("hour | n    | meanRet%  | 95% CI              | winRate% | avgRV% | sig(full)");
  const hourFlags = [];
  hourBuckets.forEach((items, h) => {
    const s = summarizeBucket(items);
    if (s.sig) hourFlags.push(h);
    console.log(
      `${String(h).padStart(4)} | ${String(s.n).padStart(4)} | ${s.meanRet.toFixed(4).padStart(9)} | ` +
      `[${s.ciLo.toFixed(4)}, ${s.ciHi.toFixed(4)}] | ${s.winRate.toFixed(1).padStart(6)} | ${s.avgRv.toFixed(3).padStart(6)} | ${s.sig ? "**FLAG**" : ""}`
    );
  });

  console.log(`\n-- Day-of-week (UTC), full sample --`);
  console.log("dow | n    | meanRet%  | 95% CI              | winRate% | avgRV% | sig(full)");
  const dowFlags = [];
  dowBuckets.forEach((items, d) => {
    const s = summarizeBucket(items);
    if (s.sig) dowFlags.push(d);
    console.log(
      `${DOW_NAMES[d].padStart(3)} | ${String(s.n).padStart(4)} | ${s.meanRet.toFixed(4).padStart(9)} | ` +
      `[${s.ciLo.toFixed(4)}, ${s.ciHi.toFixed(4)}] | ${s.winRate.toFixed(1).padStart(6)} | ${s.avgRv.toFixed(3).padStart(6)} | ${s.sig ? "**FLAG**" : ""}`
    );
  });

  // ---- Two-window persistence check on flagged buckets ----
  const hourBucketsW1 = bucketByHour(w1);
  const hourBucketsW2 = bucketByHour(w2);
  const dowBucketsW1 = bucketByDow(w1);
  const dowBucketsW2 = bucketByDow(w2);

  console.log(`\n-- Persistence check: hour-of-day buckets flagged in full sample --`);
  if (hourFlags.length === 0) console.log("  (none flagged in full sample)");
  const hourPersist = [];
  for (const h of hourFlags) {
    const full = summarizeBucket(hourBuckets[h]);
    const s1 = summarizeBucket(hourBucketsW1[h]);
    const s2 = summarizeBucket(hourBucketsW2[h]);
    const sameSignBoth = Math.sign(s1.meanRet) === Math.sign(full.meanRet) && Math.sign(s2.meanRet) === Math.sign(full.meanRet);
    const sigBoth = s1.sig && s2.sig;
    console.log(
      `  hour=${h}: full mean=${full.meanRet.toFixed(4)}% (sig) | W1 mean=${s1.meanRet.toFixed(4)}% n=${s1.n} sig=${s1.sig} | ` +
      `W2 mean=${s2.meanRet.toFixed(4)}% n=${s2.n} sig=${s2.sig} | persists(same-sign both)=${sameSignBoth} | persists(sig both)=${sigBoth}`
    );
    if (sameSignBoth && sigBoth) hourPersist.push(h);
  }

  console.log(`\n-- Persistence check: day-of-week buckets flagged in full sample --`);
  if (dowFlags.length === 0) console.log("  (none flagged in full sample)");
  const dowPersist = [];
  for (const d of dowFlags) {
    const full = summarizeBucket(dowBuckets[d]);
    const s1 = summarizeBucket(dowBucketsW1[d]);
    const s2 = summarizeBucket(dowBucketsW2[d]);
    const sameSignBoth = Math.sign(s1.meanRet) === Math.sign(full.meanRet) && Math.sign(s2.meanRet) === Math.sign(full.meanRet);
    const sigBoth = s1.sig && s2.sig;
    console.log(
      `  dow=${DOW_NAMES[d]}: full mean=${full.meanRet.toFixed(4)}% (sig) | W1 mean=${s1.meanRet.toFixed(4)}% n=${s1.n} sig=${s1.sig} | ` +
      `W2 mean=${s2.meanRet.toFixed(4)}% n=${s2.n} sig=${s2.sig} | persists(same-sign both)=${sameSignBoth} | persists(sig both)=${sigBoth}`
    );
    if (sameSignBoth && sigBoth) dowPersist.push(d);
  }

  return { hourFlags, dowFlags, hourPersist, dowPersist };
}

// ---------------- Funding settlement analysis ----------------

function findCandleAt(candles, ts) {
  // candles sorted; find candle whose ts === ts (exact 15m grid match)
  let lo = 0, hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts === ts) return candles[mid];
    if (candles[mid].ts < ts) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

function pctChange(a, b) { return ((b - a) / a) * 100; }

function runFundingAnalysis(symbol, candles15m) {
  console.log(`\n===================== ${symbol}: funding settlement window (15m candles) =====================`);
  console.log(`Total 15m candles: ${candles15m.length}`);

  const byTs = new Map(candles15m.map((c) => [c.ts, c]));
  const stepMs = 15 * 60 * 1000;

  const events = []; // per settlement: pre60, pre30, post30, post60 returns; also RV
  for (const c of candles15m) {
    const d = new Date(c.ts);
    if (d.getUTCMinutes() !== 0) continue;
    if (!SETTLEMENT_HOURS_UTC.includes(d.getUTCHours())) continue;
    const t0 = c.ts; // settlement instant candle open ts
    const tMinus60 = t0 - 4 * stepMs;
    const tMinus30 = t0 - 2 * stepMs;
    const tPlus30 = t0 + 2 * stepMs;
    const tPlus60 = t0 + 4 * stepMs;

    const cMinus60 = byTs.get(tMinus60);
    const cMinus30 = byTs.get(tMinus30);
    const cAt = byTs.get(t0);
    const cPlus30 = byTs.get(tPlus30 - stepMs); // last candle ending at tPlus30
    const cPlus60 = byTs.get(tPlus60 - stepMs); // last candle ending at tPlus60

    if (!cMinus60 || !cMinus30 || !cAt || !cPlus30 || !cPlus60) continue;

    events.push({
      t0,
      pre60: pctChange(cMinus60.open, cAt.open),
      pre30: pctChange(cMinus30.open, cAt.open),
      post30: pctChange(cAt.open, cPlus30.close),
      post60: pctChange(cAt.open, cPlus60.close),
    });
  }

  console.log(`Settlement events with complete pre/post data: ${events.length}`);

  function summarizeWindow(label, key) {
    const vals = events.map((e) => e[key]);
    const c = ci95(vals);
    const sig = vals.length >= 30 && excludesZero(c);
    console.log(`  ${label.padEnd(6)}: n=${c.n} mean=${c.mean.toFixed(4)}% CI=[${c.lo.toFixed(4)}, ${c.hi.toFixed(4)}] sig=${sig}`);
    return { ...c, sig };
  }

  console.log(`\n-- Full sample --`);
  const full = {
    pre60: summarizeWindow("pre60", "pre60"),
    pre30: summarizeWindow("pre30", "pre30"),
    post30: summarizeWindow("post30", "post30"),
    post60: summarizeWindow("post60", "post60"),
  };

  const sorted = [...events].sort((a, b) => a.t0 - b.t0);
  const mid = Math.floor(sorted.length / 2);
  const e1 = sorted.slice(0, mid);
  const e2 = sorted.slice(mid);

  function summarizeSplit(evs, key) {
    const vals = evs.map((e) => e[key]);
    const c = ci95(vals);
    return { ...c, sig: vals.length >= 30 && excludesZero(c) };
  }

  console.log(`\n-- Two-window persistence (W1 n=${e1.length}, W2 n=${e2.length}) --`);
  const windows = ["pre60", "pre30", "post30", "post60"];
  const flagged = [];
  for (const key of windows) {
    if (!full[key].sig) continue;
    const s1 = summarizeSplit(e1, key);
    const s2 = summarizeSplit(e2, key);
    const sameSignBoth = Math.sign(s1.mean) === Math.sign(full[key].mean) && Math.sign(s2.mean) === Math.sign(full[key].mean);
    const sigBoth = s1.sig && s2.sig;
    console.log(
      `  ${key}: full mean=${full[key].mean.toFixed(4)}% (sig) | W1 mean=${s1.mean.toFixed(4)}% sig=${s1.sig} | W2 mean=${s2.mean.toFixed(4)}% sig=${s2.sig} | ` +
      `persists(same-sign both)=${sameSignBoth} persists(sig both)=${sigBoth}`
    );
    if (sameSignBoth && sigBoth) flagged.push(key);
  }
  if (windows.every((k) => !full[k].sig)) console.log("  (nothing flagged in full sample -- no persistence check needed)");

  return { nEvents: events.length, full, flagged };
}

async function main() {
  const { noCache } = parseArgs();
  const cacheDir = path.join(__dirname, "..", "data", "sessioneffects");

  const allHourDow = {};
  const allFunding = {};

  for (const symbol of SYMBOLS) {
    const hourly = await fetchCandlesCached(symbol, "60", HOURLY_DAYS, cacheDir, noCache);
    allHourDow[symbol] = runHourDowAnalysis(symbol, hourly);
  }

  for (const symbol of SYMBOLS) {
    const fine = await fetchCandlesCached(symbol, "15", FUNDING_DAYS, cacheDir, noCache);
    allFunding[symbol] = runFundingAnalysis(symbol, fine);
  }

  console.log(`\n\n========================= SUMMARY =========================`);
  for (const symbol of SYMBOLS) {
    const r = allHourDow[symbol];
    console.log(`${symbol}: hour-of-day flagged(full)=${r.hourFlags.length} persisted(both windows)=${r.hourPersist.length} [${r.hourPersist.join(",")}]`);
    console.log(`${symbol}: day-of-week flagged(full)=${r.dowFlags.length} persisted(both windows)=${r.dowPersist.length} [${r.dowPersist.map(d=>DOW_NAMES[d]).join(",")}]`);
  }
  for (const symbol of SYMBOLS) {
    const f = allFunding[symbol];
    console.log(`${symbol}: funding-window flagged(full, persisted)=${f.flagged.length} [${f.flagged.join(",")}]  n_settlement_events=${f.nEvents}`);
  }

  const anyPersisted =
    SYMBOLS.some((s) => allHourDow[s].hourPersist.length > 0 || allHourDow[s].dowPersist.length > 0) ||
    SYMBOLS.some((s) => allFunding[s].flagged.length > 0);
  console.log(`\n========== OVERALL VERDICT: ${anyPersisted ? "EDGE CANDIDATE (some bucket persisted both windows -- needs strategy-level gauntlet)" : "NO EDGE (nothing persisted across both windows)"} ==========`);
}

main().catch((e) => { console.error(e); process.exit(1); });
