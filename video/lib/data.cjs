"use strict";

/**
 * Turns both bots' real records into the timeline the video plays back.
 *
 *   pump.fun  data/pump/trades-live-*.jsonl   every trade (open, close, net SOL)
 *             data/pump/research-*.jsonl      every coin the bot watched (ring lines)
 *   Bybit     /v5/position/closed-pnl         every closed position, straight from Bybit
 *             (read-only, cached in data/video/bybit-closed-pnl.json)
 *
 * Nothing here invents a number: a bot with no records shows up empty.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const DAY = 24 * 3600 * 1000;
const MAX_LINES = 6000; // ring lines drawn per bot; more coins than this are grouped

// Small deterministic hash -> [0,1) so a coin always gets the same line shape.
function seedOf(text) {
  const h = crypto.createHash("sha1").update(String(text)).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

function readJsonlFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => pattern.test(n)).sort()) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a half-written last line while the bot is running */
      }
    }
  }
  return out;
}

function newestMtime(dir, pattern) {
  if (!fs.existsSync(dir)) return 0;
  let newest = 0;
  for (const name of fs.readdirSync(dir).filter((n) => pattern.test(n))) {
    newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
  }
  return newest;
}

const EXIT_WORDS = {
  "take-profit-1": "TP",
  "trailing-stop": "TRAIL",
  "stop-loss": "STOP",
  "dev-sold": "DEV SOLD",
  "time-stop": "TIME",
  "finish-exit": "EXIT",
  "late-fill": "LATE",
  shutdown: "SHUTDOWN",
  "no-data": "NO DATA",
  gone: "GONE",
};

function exitWord(trade) {
  const exits = Array.isArray(trade.exits) ? trade.exits : [];
  const last = exits.length ? exits[exits.length - 1].reason : null;
  return EXIT_WORDS[last] || (last ? String(last).toUpperCase() : "SELL");
}

/**
 * pump.fun: trades + watched coins -> bot timeline.
 * `research` may be empty (then the ring shows one line per trade).
 */
function pumpTimeline(trades, research, { fromMs = 0, toMs = Infinity, live = false } = {}) {
  const inRange = (ms) => Number.isFinite(ms) && ms >= fromMs && ms <= toMs;
  const done = trades
    .filter((t) => Number.isFinite(t.netSol) && Number.isFinite(t.closedAtMs) && inRange(t.closedAtMs))
    .sort((a, b) => a.closedAtMs - b.closedAtMs);

  const coins = research
    .filter((r) => r && r.mint && inRange(r.createdAtMs))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);

  // Group coins when there are too many to draw one line each (always say so on screen).
  const traded = new Set(done.map((t) => t.mint));
  const perLine = Math.max(1, Math.ceil(coins.length / MAX_LINES));
  const lines = [];
  const lineOfMint = new Map();
  coins.forEach((c, i) => {
    if (perLine > 1 && i % perLine !== 0 && !traded.has(c.mint)) return;
    const line = { t: c.createdAtMs, seed: seedOf(c.mint), w: Math.min(1, Math.max(0, (c.maxRealSol || 0) / 30)) };
    lineOfMint.set(c.mint, line);
    lines.push(line);
  });

  const out = done.map((t) => {
    let line = lineOfMint.get(t.mint);
    if (!line) {
      line = { t: Number.isFinite(t.openedAtMs) ? t.openedAtMs : t.closedAtMs, seed: seedOf(t.mint), w: 0.5 };
      lineOfMint.set(t.mint, line);
      lines.push(line);
    }
    return {
      open: Number.isFinite(t.openedAtMs) ? t.openedAtMs : null,
      close: t.closedAtMs,
      label: String(t.symbol || t.mint.slice(0, 6)).slice(0, 10).toUpperCase(),
      side: "BUY",
      size: Number(t.sizeSol) || 0,
      pnl: t.netSol,
      pct: Number.isFinite(t.netPct) ? t.netPct : null,
      why: exitWord(t),
      line,
    };
  });
  lines.sort((a, b) => a.t - b.t);
  const indexOf = new Map(lines.map((l, i) => [l, i]));
  for (const tr of out) tr.line = indexOf.get(tr.line);

  return {
    key: "pump",
    title: "PUMP.FUN",
    subtitle: "SOLANA · NEW MEME COINS",
    unit: "SOL",
    decimals: 4,
    status: live ? "LIVE" : "STOPPED",
    lineWord: research.length ? "coin watched" : "trade",
    perLine: research.length ? perLine : 1,
    watched: research.length ? coins.length : null,
    lines,
    trades: out,
    chips: ["feed.logs", "tracker.curve", "risk.floor", "broker.buy", "broker.sell"],
  };
}

function loadPump(repoRoot, opts = {}) {
  // same folder the pump bot writes to (it honours PUMP_DATA_DIR too)
  const dir = process.env.PUMP_DATA_DIR ? path.resolve(repoRoot, process.env.PUMP_DATA_DIR) : path.join(repoRoot, "data", "pump");
  const mode = opts.mode || "live";
  const trades = readJsonlFiles(dir, new RegExp(`^trades-${mode}-.*\\.jsonl$`));
  const research = opts.noResearch ? [] : readJsonlFiles(dir, /^research-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const live = Date.now() - newestMtime(dir, /\.jsonl$/) < 30 * 60 * 1000;
  return pumpTimeline(trades, research, { ...opts, live });
}

/** Bybit closed-pnl rows -> bot timeline. One ring line per closed position. */
function bybitTimeline(rows, { fromMs = 0, toMs = Infinity } = {}) {
  const seen = new Set();
  const list = rows
    .filter((r) => {
      const key = `${r.orderId}|${r.updatedTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const ms = Number(r.updatedTime);
      return Number.isFinite(ms) && ms >= fromMs && ms <= toMs && Number.isFinite(Number(r.closedPnl));
    })
    .sort((a, b) => Number(a.updatedTime) - Number(b.updatedTime));

  const lines = list.map((r) => ({ t: Number(r.updatedTime), seed: seedOf(`${r.orderId}${r.updatedTime}`), w: 0.6 }));
  const trades = list.map((r, i) => {
    const entry = Number(r.cumEntryValue) || 0;
    const pnl = Number(r.closedPnl);
    const fee = Number(r.openFee || 0) + Number(r.closeFee || 0);
    return {
      open: null,
      close: Number(r.updatedTime),
      label: String(r.symbol || "?").slice(0, 12),
      // closed-pnl's side is the closing order: a Sell closes a long.
      side: r.side === "Sell" ? "LONG" : "SHORT",
      size: entry,
      pnl,
      pct: null,
      fee: Number.isFinite(fee) ? fee : 0,
      why: "",
      line: i,
    };
  });
  const last = trades.length ? trades[trades.length - 1].close : 0;
  return {
    key: "bybit",
    title: "BYBIT",
    subtitle: "USDT PERPETUAL FUTURES",
    unit: "USDT",
    decimals: 2,
    status: Date.now() - last < 2 * DAY ? "LIVE" : "STOPPED",
    lineWord: "trade",
    perLine: 1,
    watched: null,
    lines,
    trades,
    chips: ["v5.candles", "supertrend", "pullback", "breakout", "closed-pnl"],
  };
}

// ---------------------------------------------------------------- Bybit (read-only)

function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function bybitKeys(repoRoot) {
  const file = readDotEnv(path.join(repoRoot, ".env"));
  const pick = (k) => process.env[k] || file[k] || "";
  return {
    apiKey: pick("BYBIT_API_KEY"),
    apiSecret: pick("BYBIT_API_SECRET"),
    base: pick("BYBIT_TESTNET") === "true" ? "https://api-testnet.bybit.com" : "https://api.bybit.com",
  };
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Bybit answered HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Bybit did not answer in 15s")));
    req.on("error", reject);
  });
}

async function closedPnlPage(keys, query) {
  const qs = new URLSearchParams(query).toString();
  const ts = Date.now().toString();
  const recv = "10000";
  const sign = crypto.createHmac("sha256", keys.apiSecret).update(ts + keys.apiKey + recv + qs).digest("hex");
  const json = await getJson(`${keys.base}/v5/position/closed-pnl?${qs}`, {
    "X-BAPI-API-KEY": keys.apiKey,
    "X-BAPI-TIMESTAMP": ts,
    "X-BAPI-RECV-WINDOW": recv,
    "X-BAPI-SIGN": sign,
  });
  if (json.retCode !== 0) throw new Error(`Bybit said: ${json.retMsg} (code ${json.retCode})`);
  return json.result || {};
}

/**
 * Every closed position from `fromMs` to now. Bybit allows 7 days per query, so walk
 * week by week. Cached: later runs only fetch what is new.
 */
async function fetchBybitClosedPnl(repoRoot, { fromMs, log = () => {} } = {}) {
  const cacheFile = path.join(repoRoot, "data", "video", "bybit-closed-pnl.json");
  let cache = { rows: [], untilMs: fromMs };
  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } catch {
      /* rebuild */
    }
  }
  const keys = bybitKeys(repoRoot);
  if (!keys.apiKey || !keys.apiSecret) {
    if (cache.rows.length) log(`Bybit: no API keys in .env, using the ${cache.rows.length} saved trades.`);
    return { rows: cache.rows, note: cache.rows.length ? null : "no Bybit API keys in .env" };
  }
  const start = Math.max(fromMs, (cache.untilMs || fromMs) - DAY);
  const now = Date.now();
  let rows = [...cache.rows];
  for (let a = start; a < now; a += 7 * DAY) {
    const b = Math.min(a + 7 * DAY - 1, now);
    let cursor = "";
    do {
      const q = { category: "linear", startTime: String(a), endTime: String(b), limit: "100" };
      if (cursor) q.cursor = cursor;
      const res = await closedPnlPage(keys, q);
      rows = rows.concat(res.list || []);
      cursor = res.nextPageCursor || "";
      await new Promise((r) => setTimeout(r, 120));
    } while (cursor);
    log(`Bybit: read ${new Date(a).toISOString().slice(0, 10)} → ${new Date(b).toISOString().slice(0, 10)}`);
  }
  const seen = new Set();
  rows = rows.filter((r) => {
    const k = `${r.orderId}|${r.updatedTime}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ untilMs: now, rows }));
  return { rows, note: null };
}

// ---------------------------------------------------------------- sample data (preview only)

function demoBots(seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const t0 = Date.UTC(2026, 10, 6, 9);
  const research = [];
  for (let i = 0; i < 5200; i++) {
    const hour = rnd() * 72;
    research.push({ mint: `demo${i}`, createdAtMs: t0 + hour * 3600e3, maxRealSol: rnd() < 0.08 ? 10 + rnd() * 70 : rnd() * 8 });
  }
  const names = ["PETER", "LEGG", "HIKARI", "CROCS", "MOONCAT", "BONKZ", "WAGMI", "FROGE", "GIGA", "TURBO", "SNEK", "DOGWIF"];
  const trades = [];
  for (let i = 0; i < 96; i++) {
    const c = research[Math.floor(rnd() * research.length)];
    const open = c.createdAtMs + (20 + rnd() * 120) * 1000;
    const win = rnd() < 0.42;
    const pct = win ? 5 + rnd() * 60 : -(4 + rnd() * 30);
    const size = 0.01 + rnd() * 0.02;
    trades.push({
      mint: c.mint, symbol: names[i % names.length], openedAtMs: open, closedAtMs: open + (30 + rnd() * 400) * 1000,
      sizeSol: size, netSol: (size * pct) / 100, netPct: pct,
      exits: [{ reason: win ? (rnd() < 0.5 ? "take-profit-1" : "trailing-stop") : rnd() < 0.5 ? "stop-loss" : "dev-sold" }],
    });
  }
  const pump = pumpTimeline(trades, research, { live: true });

  const syms = ["LABUSDT", "BLASTUSDT", "DEXEUSDT", "WLDUSDT", "SOLUSDT", "ETHUSDT", "XRPUSDT", "1000PEPEUSDT", "SUIUSDT", "ADAUSDT"];
  const b0 = Date.UTC(2026, 6, 13, 6);
  const rows = [];
  for (let i = 0; i < 384; i++) {
    const t = b0 + rnd() * 3.2 * DAY;
    const entry = 15 + rnd() * 40;
    const pnl = (rnd() - 0.53) * entry * 0.02;
    rows.push({ orderId: `d${i}`, symbol: syms[Math.floor(rnd() * syms.length)], side: rnd() < 0.5 ? "Sell" : "Buy", closedPnl: String(pnl), cumEntryValue: String(entry), leverage: "3", openFee: String(entry * 0.00055), closeFee: String(entry * 0.00055), updatedTime: String(Math.round(t)) });
  }
  const bybit = bybitTimeline(rows);
  bybit.status = "STOPPED";
  return [pump, bybit];
}

module.exports = {
  seedOf,
  readJsonlFiles,
  pumpTimeline,
  loadPump,
  bybitTimeline,
  fetchBybitClosedPnl,
  readDotEnv,
  demoBots,
  MAX_LINES,
};
