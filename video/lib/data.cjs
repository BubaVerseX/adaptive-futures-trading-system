"use strict";

/**
 * Everything the bots recorded, turned into one story the video plays back.
 *
 *   pump.fun  data/pump/trades-live-*.jsonl    every trade (open, close, net SOL, exit reason)
 *             data/pump/research-*.jsonl       every coin the bot watched (ring lines)
 *             data/pump/buyfails-live-*.jsonl  buys that never filled (and the fees they cost)
 *   Bybit     /v5/position/closed-pnl          every closed position, straight from Bybit
 *                                              (read-only, cached in data/video/)
 *             data/v<N>/*.log                  the bot's own logs: which strategy opened each
 *                                              trade, how often it checked the market, how many
 *                                              signals the fee gate threw away
 *   SOL/USD   Bybit public daily candles       to put both bots in dollars (cached)
 *
 * Nothing here invents a number: a source that is missing just leaves its part empty.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const DAY = 24 * 3600 * 1000;
const MAX_LINES = 6000; // ring lines drawn per bot; more coins than this are grouped
const GAP_DAYS = 10; // quiet stretches longer than this become an "intermission"

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

// Small deterministic hash -> [0,1) so a coin always gets the same line shape.
function seedOf(text) {
  const h = crypto.createHash("sha1").update(String(text)).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

function listFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => pattern.test(n)).sort().map((n) => path.join(dir, n));
}

function readJsonlFiles(dir, pattern) {
  const out = [];
  for (const file of listFiles(dir, pattern)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
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
  return listFiles(dir, pattern).reduce((m, f) => Math.max(m, fs.statSync(f).mtimeMs), 0);
}

// ---------------------------------------------------------------- pump.fun

const EXIT_WORDS = {
  "take-profit-1": "TAKE PROFIT",
  "trailing-stop": "TRAILING STOP",
  "stop-loss": "STOP LOSS",
  "dev-sold": "DEV SOLD",
  "time-stop": "TIME STOP",
  "finish-exit": "EXIT",
  "late-fill": "LATE FILL",
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
 * pump.fun: trades + watched coins + failed buys -> bot timeline.
 * `research` may be empty (then the ring shows one line per trade).
 */
function pumpTimeline(trades, research, { fromMs = 0, toMs = Infinity, live = false, buyFails = [] } = {}) {
  const inRange = (ms) => Number.isFinite(ms) && ms >= fromMs && ms <= toMs;
  const done = trades
    .filter((t) => Number.isFinite(t.netSol) && Number.isFinite(t.closedAtMs) && inRange(t.closedAtMs))
    .sort((a, b) => a.closedAtMs - b.closedAtMs);

  const coins = research
    .filter((r) => r && r.mint && inRange(r.createdAtMs))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);

  // Group coins when there are too many to draw one line each (always said on screen).
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
      peak: Number.isFinite(t.peakGainPct) ? t.peakGainPct : null,
      why: exitWord(t),
      line,
    };
  });
  lines.sort((a, b) => a.t - b.t);
  const indexOf = new Map(lines.map((l, i) => [l, i]));
  for (const tr of out) tr.line = indexOf.get(tr.line);

  const fails = buyFails.filter((f) => inRange(f.atMs)).sort((a, b) => a.atMs - b.atMs);
  return {
    key: "pump",
    title: "PUMP.FUN",
    subtitle: "SOLANA MEME COINS",
    unit: "SOL",
    decimals: 4,
    status: live ? "LIVE" : "STOPPED",
    lineWord: research.length ? "coin watched" : "trade",
    perLine: research.length ? perLine : 1,
    watched: research.length ? coins.length : null,
    lines,
    trades: out,
    fails: fails.map((f) => ({
      t: f.atMs,
      label: String(f.symbol || (f.mint || "?").slice(0, 6)).slice(0, 10).toUpperCase(),
      feesSol: Number(f.feesSol) || 0,
    })),
  };
}

function pumpDir(repoRoot) {
  // same folder the pump bot writes to (it honours PUMP_DATA_DIR too)
  return process.env.PUMP_DATA_DIR ? path.resolve(repoRoot, process.env.PUMP_DATA_DIR) : path.join(repoRoot, "data", "pump");
}

function loadPump(repoRoot, opts = {}) {
  const dir = pumpDir(repoRoot);
  const mode = opts.mode || "live";
  const trades = readJsonlFiles(dir, new RegExp(`^trades-${mode}-.*\\.jsonl$`));
  const buyFails = readJsonlFiles(dir, new RegExp(`^buyfails-${mode}-.*\\.jsonl$`));
  const research = readJsonlFiles(dir, /^research-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const live = Date.now() - newestMtime(dir, /\.jsonl$/) < 30 * 60 * 1000;
  return pumpTimeline(trades, research, { ...opts, live, buyFails });
}

// ---------------------------------------------------------------- Bybit

/**
 * The Bybit bot's own logs (data/v33/live-run*.log and friends). Lines look like
 *   [v33] [ETHUSDT/supertrend] 2026-07-14T10:00:15.000Z no entry signal, waiting.
 *   [v33] [ETHUSDT/supertrend] entry REJECTED by fee gate: ...
 *   [v33] [ETHUSDT/supertrend] ENTRY recorded: {...}
 * An ENTRY line has no time of its own; it gets the last time seen above it
 * (the bot checks every ~15 s, so that is close).
 */
function parseBybitLogs(texts) {
  const entries = [];
  let checks = 0;
  let feeRejects = 0;
  const byStrategy = {};
  for (const text of texts) {
    let lastTs = null;
    for (const line of text.split("\n")) {
      const ts = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
      if (ts) lastTs = Date.parse(ts[1]);
      const m = line.match(/^\[v\d+\] \[([A-Z0-9]+)\/([A-Za-z]+)\] (.*)$/);
      if (!m) continue;
      const [, symbol, strategy, rest] = m;
      if (/no entry signal/.test(rest)) checks++;
      else if (/entry REJECTED by fee gate/.test(rest)) feeRejects++;
      else if (/^ENTRY recorded/.test(rest)) {
        byStrategy[strategy] = (byStrategy[strategy] || 0) + 1;
        if (lastTs) entries.push({ symbol, strategy, t: lastTs });
      }
    }
  }
  return { checks, feeRejects, byStrategy, entries: entries.sort((a, b) => a.t - b.t) };
}

function loadBybitLogs(repoRoot) {
  const dataDir = path.join(repoRoot, "data");
  if (!fs.existsSync(dataDir)) return null;
  const texts = [];
  for (const sub of fs.readdirSync(dataDir).filter((n) => /^v\d+$/.test(n))) {
    for (const f of listFiles(path.join(dataDir, sub), /\.log$/)) texts.push(fs.readFileSync(f, "utf8"));
  }
  return texts.length ? parseBybitLogs(texts) : null;
}

/** Bybit closed-pnl rows (+ optional bot logs) -> bot timeline. One ring line per closed position. */
function bybitTimeline(rows, { fromMs = 0, toMs = Infinity, logs = null } = {}) {
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

  // Which strategy opened it: the last logged entry on that symbol before the close.
  const entries = logs ? logs.entries : [];
  const strategyFor = (symbol, close) => {
    let best = null;
    for (const e of entries) {
      if (e.t > close) break;
      if (e.symbol === symbol && close - e.t < 3 * DAY) best = e.strategy;
    }
    return best;
  };

  const lines = list.map((r) => ({ t: Number(r.updatedTime), seed: seedOf(`${r.orderId}${r.updatedTime}`), w: 0.6 }));
  const trades = list.map((r, i) => {
    const entry = Number(r.cumEntryValue) || 0;
    const pnl = Number(r.closedPnl);
    const fee = Number(r.openFee || 0) + Number(r.closeFee || 0);
    const close = Number(r.updatedTime);
    return {
      open: null,
      close,
      label: String(r.symbol || "?").slice(0, 12),
      // closed-pnl's side is the closing order: a Sell closes a long.
      side: r.side === "Sell" ? "LONG" : "SHORT",
      size: entry,
      pnl,
      pct: null,
      fee: Number.isFinite(fee) ? fee : 0,
      why: strategyFor(r.symbol, close) || "",
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
    fails: [],
    logs: logs ? { checks: logs.checks, feeRejects: logs.feeRejects, byStrategy: logs.byStrategy } : null,
  };
}

// ---------------------------------------------------------------- Bybit API (read-only)

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

function getJson(url, headers = {}) {
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
  let cache = { rows: [], fromMs, untilMs: fromMs };
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
  // asked to go further back than the cache covers: read everything again
  const resume = cache.fromMs !== undefined && cache.fromMs <= fromMs ? Math.max(fromMs, (cache.untilMs || fromMs) - DAY) : fromMs;
  const now = Date.now();
  let rows = [...cache.rows];
  for (let a = resume; a < now; a += 7 * DAY) {
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
    log(`Bybit: read ${dayKey(a)} → ${dayKey(b)}`);
  }
  const seen = new Set();
  rows = rows.filter((r) => {
    const k = `${r.orderId}|${r.updatedTime}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fromMs: Math.min(fromMs, cache.fromMs ?? fromMs), untilMs: now, rows }));
  return { rows, note: null };
}

/** SOL/USD daily closes for the given days, from Bybit's public candles (no keys). Cached. */
async function fetchSolUsd(repoRoot, days, { log = () => {} } = {}) {
  const cacheFile = path.join(repoRoot, "data", "video", "sol-usd.json");
  let cache = {};
  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } catch {
      /* rebuild */
    }
  }
  const today = dayKey(Date.now());
  const missing = [...new Set(days)].filter((d) => !cache[d] || d === today).sort();
  if (missing.length) {
    const start = Date.parse(`${missing[0]}T00:00:00Z`);
    const end = Date.parse(`${missing[missing.length - 1]}T23:59:59Z`);
    for (let a = start; a <= end; a += 900 * DAY) {
      const b = Math.min(end, a + 900 * DAY);
      const json = await getJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=SOLUSDT&interval=D&start=${a}&end=${b}&limit=1000`);
      if (json.retCode !== 0) throw new Error(`Bybit said: ${json.retMsg}`);
      for (const k of json.result.list || []) cache[dayKey(Number(k[0]))] = Number(k[4]);
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    log(`SOL price: ${missing.length} day(s) read`);
  }
  return cache;
}

// ---------------------------------------------------------------- the story

/**
 * Puts both bots on one timeline and finds the moments worth showing.
 * `solUsd` maps YYYY-MM-DD -> SOL price; without it pump.fun stays in SOL and the
 * combined total is left out (never guessed).
 */
function buildStory(bots, solUsd = null) {
  const solPrice = (ms) => (solUsd ? solUsd[dayKey(ms)] || null : null);
  let priced = true;
  for (const bot of bots) {
    for (const t of bot.trades) {
      if (bot.unit === "SOL") {
        const p = solPrice(t.close);
        t.usd = p === null ? null : t.pnl * p;
        if (p === null) priced = false;
      } else t.usd = t.pnl;
    }
  }

  const all = [];
  bots.forEach((bot) => bot.trades.forEach((t, i) => all.push({ bot: bot.key, i, t })));
  all.sort((a, b) => a.t.close - b.t.close);

  const times = [];
  for (const bot of bots) {
    for (const l of bot.lines) times.push(l.t);
    for (const t of bot.trades) times.push(t.close);
  }
  times.sort((a, b) => a - b);
  const start = times.length ? times[0] : Date.now();
  const end = times.length ? times[times.length - 1] : Date.now();

  // Quiet stretches -> intermissions; the stretches between them -> chapters.
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > GAP_DAYS * DAY) gaps.push({ from: times[i - 1], to: times[i], days: Math.round((times[i] - times[i - 1]) / DAY) });
  }
  const bounds = [start, ...gaps.flatMap((g) => [g.from, g.to]), end];
  const chapters = [];
  for (let k = 0; k < bounds.length; k += 2) {
    const from = bounds[k];
    const to = bounds[k + 1];
    const active = bots.filter((b) => b.trades.some((t) => t.close >= from && t.close <= to) || b.lines.some((l) => l.t >= from && l.t <= to));
    chapters.push({ from, to, bots: active.map((b) => b.key), title: active.map((b) => b.title).join(" + ") || "QUIET" });
  }

  // Highlight candidates; the renderer keeps the ones that fit without crowding.
  const H = [];
  const money = (bot, v) => (bot.unit === "SOL" ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(4)} SOL` : `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`);
  const tradeText = (bot, t) => `${t.label}${bot.key === "bybit" ? ` ${t.side}` : t.pct !== null ? ` ${t.pct > 0 ? "+" : "−"}${Math.abs(t.pct).toFixed(0)}%` : ""}`;
  for (const bot of bots) {
    const T = bot.trades;
    if (!T.length) continue;
    H.push({ t: T[0].close, kind: "start", bot: bot.key, trade: 0, priority: 9, title: `${bot.title} BOT GOES LIVE`, value: tradeText(bot, T[0]), sub: `first trade · ${money(bot, T[0].pnl)}` });
    let bi = 0;
    let wi = 0;
    T.forEach((t, i) => {
      if (t.pnl > T[bi].pnl) bi = i;
      if (t.pnl < T[wi].pnl) wi = i;
    });
    if (T[bi].pnl > 0) H.push({ t: T[bi].close, kind: "best", bot: bot.key, trade: bi, priority: 10, title: `BEST ${bot.title} TRADE`, value: money(bot, T[bi].pnl), sub: tradeText(bot, T[bi]) + (T[bi].why ? ` · ${T[bi].why}` : "") });
    if (T[wi].pnl < 0) H.push({ t: T[wi].close, kind: "worst", bot: bot.key, trade: wi, priority: 8, title: `WORST ${bot.title} TRADE`, value: money(bot, T[wi].pnl), sub: tradeText(bot, T[wi]) + (T[wi].why ? ` · ${T[wi].why}` : "") });
    // longest run of wins
    let run = 0;
    let bestRun = 0;
    let runEnd = -1;
    T.forEach((t, i) => {
      run = t.pnl > 0 ? run + 1 : 0;
      if (run > bestRun) {
        bestRun = run;
        runEnd = i;
      }
    });
    if (bestRun >= 4) H.push({ t: T[runEnd].close, kind: "streak", bot: bot.key, trade: runEnd, priority: 6, title: `${bestRun} WINS IN A ROW`, value: bot.title, sub: `ended on ${T[runEnd].label}` });
    if (bot.status === "STOPPED") {
      const net = T.reduce((s, t) => s + t.pnl, 0);
      const fees = T.reduce((s, t) => s + (t.fee || 0), 0);
      H.push({ t: T[T.length - 1].close, kind: "stop", bot: bot.key, trade: T.length - 1, priority: 9, title: `${bot.title} BOT STOPPED`, value: `net ${money(bot, net)}`, sub: fees > 0 ? `fees paid $${fees.toFixed(2)}` : `${T.length} trades` });
    }
    if (bot.watched) {
      for (const m of [1000, 5000, 10000, 50000]) {
        if (bot.watched < m) break;
        const li = Math.min(bot.lines.length - 1, Math.floor(m / bot.perLine));
        H.push({ t: bot.lines[li].t, kind: "coins", bot: bot.key, line: li, priority: 4, title: `${m.toLocaleString("en-US")} COINS WATCHED`, value: bot.title, sub: "every one checked, most skipped" });
      }
    }
  }
  for (const m of [100, 250, 500, 1000, 2000]) {
    if (all.length < m) break;
    const x = all[m - 1];
    const bot = bots.find((b) => b.key === x.bot);
    H.push({ t: x.t.close, kind: "milestone", bot: x.bot, trade: x.i, priority: 5, title: `TRADE #${m}`, value: tradeText(bot, x.t), sub: money(bot, x.t.pnl) });
  }
  for (const g of gaps) H.push({ t: g.from + 1, kind: "gap", priority: 10, title: "INTERMISSION", value: `${g.days} DAYS`, sub: "no trading" });
  H.sort((a, b) => a.t - b.t);

  // Totals for the ending.
  const totals = bots.map((bot) => {
    const T = bot.trades;
    const wins = T.filter((t) => t.pnl > 0).length;
    return {
      key: bot.key,
      title: bot.title,
      unit: bot.unit,
      decimals: bot.decimals,
      trades: T.length,
      wins,
      pnl: T.reduce((s, t) => s + t.pnl, 0),
      usd: priced || bot.unit !== "SOL" ? T.reduce((s, t) => s + (t.usd || 0), 0) : null,
      fees: T.reduce((s, t) => s + (t.fee || 0), 0),
      best: T.length ? Math.max(...T.map((t) => t.pnl)) : 0,
      worst: T.length ? Math.min(...T.map((t) => t.pnl)) : 0,
      watched: bot.watched,
      attempts: T.length + bot.fails.length,
      failedBuys: bot.fails.length,
      failFeesSol: bot.fails.reduce((s, f) => s + f.feesSol, 0),
      symbols: new Set(T.map((t) => t.label)).size,
      logs: bot.logs || null,
      first: T.length ? T[0].close : null,
      last: T.length ? T[T.length - 1].close : null,
    };
  });
  return { start, end, gaps, chapters, highlights: H, totals, priced };
}

// ---------------------------------------------------------------- sample data (preview only)

function demoBots(seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);

  // Bybit: two runs in June/July
  const syms = ["LABUSDT", "BLASTUSDT", "DEXEUSDT", "WLDUSDT", "SOLUSDT", "ETHUSDT", "XRPUSDT", "1000PEPEUSDT", "SUIUSDT", "ADAUSDT"];
  const rows = [];
  const runs = [[Date.UTC(2026, 5, 7, 8), 27 * DAY, 287], [Date.UTC(2026, 6, 13, 6), 3.2 * DAY, 384]];
  let id = 0;
  for (const [t0, span, n] of runs) {
    for (let i = 0; i < n; i++) {
      const t = t0 + rnd() * span;
      const entry = 15 + rnd() * 40;
      const pnl = (rnd() - 0.53) * entry * 0.02;
      rows.push({ orderId: `d${id++}`, symbol: syms[Math.floor(rnd() * syms.length)], side: rnd() < 0.5 ? "Sell" : "Buy", closedPnl: String(pnl), cumEntryValue: String(entry), leverage: "3", openFee: String(entry * 0.00055), closeFee: String(entry * 0.00055), updatedTime: String(Math.round(t)) });
    }
  }
  const strat = ["supertrend", "pullback", "breakout"];
  const logEntries = rows.filter((r) => Number(r.updatedTime) > runs[1][0]).map((r) => ({ symbol: r.symbol, strategy: strat[Math.floor(rnd() * 3)], t: Number(r.updatedTime) - 3600e3 })).sort((a, b) => a.t - b.t);
  const logs = { checks: 48210, feeRejects: 312, byStrategy: { supertrend: 562, pullback: 103, breakout: 42 }, entries: logEntries };
  const bybit = bybitTimeline(rows, { logs });
  bybit.status = "STOPPED";

  // pump.fun: three days in November
  const t0 = Date.UTC(2026, 10, 6, 9);
  const research = [];
  for (let i = 0; i < 5200; i++) research.push({ mint: `demo${i}`, createdAtMs: t0 + rnd() * 72 * 3600e3, maxRealSol: rnd() < 0.08 ? 10 + rnd() * 70 : rnd() * 8 });
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
  const buyFails = [];
  for (let i = 0; i < 31; i++) buyFails.push({ atMs: t0 + rnd() * 72 * 3600e3, symbol: names[i % names.length], feesSol: 0.000005 });
  const pump = pumpTimeline(trades, research, { live: true, buyFails });
  const solUsd = {};
  for (let d = Date.UTC(2026, 5, 1); d < Date.UTC(2026, 10, 12); d += DAY) solUsd[dayKey(d)] = 150 + 40 * Math.sin(d / (20 * DAY));
  return { bots: [pump, bybit], solUsd };
}

module.exports = {
  DAY,
  dayKey,
  seedOf,
  readJsonlFiles,
  pumpTimeline,
  loadPump,
  parseBybitLogs,
  loadBybitLogs,
  bybitTimeline,
  fetchBybitClosedPnl,
  fetchSolUsd,
  buildStory,
  readDotEnv,
  demoBots,
  MAX_LINES,
  GAP_DAYS,
};
