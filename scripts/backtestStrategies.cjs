#!/usr/bin/env node
/**
 * scripts/backtestStrategies.cjs
 *
 * Backtests supertrend/pullback/breakout — the exact same logic running in
 * v33PowerPilot.cjs, via the shared strategyLogic.cjs module — against real
 * historical Bybit data, with realistic fees included.
 *
 * WHY THIS EXISTS: pullback and breakout have been trading your real money
 * for hours with ZERO historical validation — they were designed, then went
 * straight to live. This closes that gap, the same way backtester.py did for
 * the earlier Python strategy. Read every result literally: a strategy/symbol
 * combo with a negative or barely-positive result here has no business
 * running live at real size, no matter how it "feels" while watching it.
 *
 * Uses ONLY public Bybit market data (no API key needed, read-only, cannot
 * see your account or place orders).
 *
 * ============ USAGE ============
 *   node scripts/backtestStrategies.cjs --days 120
 *   node scripts/backtestStrategies.cjs --days 120 --symbols BTCUSDT,ETHUSDT
 *   node scripts/backtestStrategies.cjs --days 120 --strategies pullback,breakout
 */

const https = require("https");
const { STRATEGY_FNS, DEFAULT_ST_PARAMS, intervalMs, passesFeeGate } = require("./strategyLogic.cjs");

const FEE_BPS_ROUND_TRIP = 14; // matches FEE_GATE in strategyLogic.cjs: 11 taker + 3 slippage buffer

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  return {
    days: Number(get("--days", 120)),
    symbols: get("--symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,BNBUSDT").split(",").map((s) => s.trim()),
    strategies: get("--strategies", "supertrend,pullback,breakout").split(",").map((s) => s.trim()),
    minAgreement: Number(get("--min-agreement", 2)),
  };
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

async function fetchHistoricalCandles(symbol, interval, days) {
  const REST_BASE = "https://api.bybit.com";
  const stepMs = intervalMs(interval);
  const limit = 1000;
  const wantedStart = Date.now() - days * 24 * 60 * 60 * 1000;
  let endTime = Date.now();
  const seen = new Set();
  const out = [];

  while (endTime > wantedStart) {
    const startTime = Math.max(wantedStart, endTime - limit * stepMs);
    const url = `${REST_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&start=${startTime}&end=${endTime}&limit=${limit}`;
    const json = await httpGetJson(url);
    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
      throw new Error(`Bybit kline fetch failed for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const rows = json.result.list
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .sort((a, b) => a.ts - b.ts);
    if (!rows.length) break;
    for (const c of rows) {
      if (!seen.has(c.ts) && c.close > 0) { seen.add(c.ts); out.push(c); }
    }
    const firstTs = rows[0].ts;
    const nextEnd = firstTs - stepMs;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    await new Promise((r) => setTimeout(r, 150)); // be polite to the public endpoint
  }

  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ---------------- Backtest engine ----------------
// Walks candle-by-candle, exactly mirroring how the live bot consumes data:
// only ever looks at candles up to and including the current index (no
// lookahead), enters/exits next-candle-open style, applies the same fee gate.

function runBacktest(candles, strategyName, params, minAgreement) {
  const strategyDef = STRATEGY_FNS[strategyName];
  const trades = [];
  let position = null; // { side, entryPrice, entryIdx }

  for (let i = 1; i < candles.length - 1; i++) {
    const sig = strategyDef.fn(candles, i, params, minAgreement);

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
        const netPct = rawPct - FEE_BPS_ROUND_TRIP / 10000;
        trades.push({ side: position.side, entryPrice: position.entryPrice, exitPrice, exitReason, heldCandles, netPct });
        position = null;
      }
      continue; // one position at a time, matches live bot's same-symbol conflict rule
    }

    const side = sig.longEntry ? "LONG" : sig.shortEntry ? "SHORT" : null;
    if (side && passesFeeGate(sig)) {
      position = { side, entryPrice: candles[i].close, entryIdx: i };
    }
  }

  return trades;
}

function summarize(trades) {
  if (!trades.length) return { tradeCount: 0 };
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  let equity = 1, peak = 1, maxDD = 0;
  for (const t of trades) {
    equity *= 1 + t.netPct;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  const grossWin = wins.reduce((a, t) => a + t.netPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPct, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  return {
    tradeCount: trades.length,
    winRatePct: +((wins.length / trades.length) * 100).toFixed(1),
    netPnlPct: +((equity - 1) * 100).toFixed(2),
    profitFactor: profitFactor === Infinity ? "inf" : +profitFactor.toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    avgHeldCandles: +(trades.reduce((a, t) => a + t.heldCandles, 0) / trades.length).toFixed(1),
  };
}

function verdict(summary) {
  if (summary.tradeCount < 10) return "INSUFFICIENT_DATA (fewer than 10 trades — not enough to judge)";
  const pf = summary.profitFactor === "inf" ? Infinity : summary.profitFactor;
  if (summary.netPnlPct > 0 && pf > 1.2) return "POSSIBLE_EDGE (positive, but verify across more periods before trusting it)";
  return "NO_EDGE (do not run this combo live at meaningful size)";
}

async function main() {
  const args = parseArgs();
  console.log(`Backtesting strategies=[${args.strategies.join(", ")}] symbols=[${args.symbols.join(", ")}] over ${args.days} days`);
  console.log(`Fee assumption: ${FEE_BPS_ROUND_TRIP}bps round-trip (matches the live bot's fee gate)\n`);

  const results = [];

  for (const symbol of args.symbols) {
    for (const strategyName of args.strategies) {
      const strategyDef = STRATEGY_FNS[strategyName];
      if (!strategyDef) { console.log(`Skipping unknown strategy: ${strategyName}`); continue; }
      try {
        const candles = await fetchHistoricalCandles(symbol, strategyDef.interval, args.days);
        const params = strategyName === "supertrend" ? DEFAULT_ST_PARAMS : null;
        const trades = runBacktest(candles, strategyName, params, args.minAgreement);
        const summary = summarize(trades);
        const v = verdict(summary);
        results.push({ symbol, strategy: strategyName, candles: candles.length, ...summary, verdict: v });
        console.log(`${symbol.padEnd(9)} ${strategyName.padEnd(11)} candles=${candles.length}  ${JSON.stringify(summary)}`);
        console.log(`  -> ${v}\n`);
      } catch (err) {
        console.error(`${symbol} ${strategyName} FAILED: ${err.message}\n`);
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY TABLE");
  console.log("=".repeat(70));
  console.log("symbol".padEnd(10) + "strategy".padEnd(12) + "trades".padEnd(8) + "win%".padEnd(8) + "netPnl%".padEnd(10) + "PF".padEnd(8) + "maxDD%".padEnd(9) + "verdict");
  for (const r of results) {
    if (r.tradeCount === undefined || r.tradeCount === 0) continue;
    console.log(
      r.symbol.padEnd(10) + r.strategy.padEnd(12) + String(r.tradeCount).padEnd(8) +
      String(r.winRatePct ?? "-").padEnd(8) + String(r.netPnlPct ?? "-").padEnd(10) +
      String(r.profitFactor ?? "-").padEnd(8) + String(r.maxDrawdownPct ?? "-").padEnd(9) +
      r.verdict.split(" ")[0]
    );
  }

  const possibleEdge = results.filter((r) => r.verdict && r.verdict.startsWith("POSSIBLE_EDGE"));
  console.log("\n" + "-".repeat(70));
  if (possibleEdge.length) {
    console.log(`${possibleEdge.length} combo(s) showed possible edge: ${possibleEdge.map((r) => `${r.symbol}/${r.strategy}`).join(", ")}`);
    console.log("Still not proof — re-run over a different --days window before trusting any of these.");
  } else {
    console.log("No combo showed a trustworthy edge in this window. That's a real, useful answer, not a failure of the tool.");
  }
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

module.exports = { runBacktest, summarize, verdict, fetchHistoricalCandles };
