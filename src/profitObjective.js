"use strict";

const fs = require("node:fs");
const path = require("node:path");

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 6) {
  return Number(numeric(value).toFixed(places));
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || "UNKNOWN");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([key, values]) => [key, summarize(values)]));
}

function summarize(trades) {
  const rows = trades.filter((trade) => Number.isFinite(Number(trade.pnlUsdt || trade.realizedPnlUsdt)));
  const wins = rows.filter((trade) => numeric(trade.pnlUsdt || trade.realizedPnlUsdt) > 0);
  const losses = rows.filter((trade) => numeric(trade.pnlUsdt || trade.realizedPnlUsdt) < 0);
  const netPnl = rows.reduce((total, trade) => total + numeric(trade.pnlUsdt || trade.realizedPnlUsdt), 0);
  const grossPnl = rows.reduce((total, trade) => total + numeric(trade.grossPnlUsdt, numeric(trade.pnlUsdt || trade.realizedPnlUsdt) + numeric(trade.feesUsdt || trade.feesPaidUsdt)), 0);
  const fees = rows.reduce((total, trade) => total + numeric(trade.feesUsdt || trade.feesPaidUsdt || trade.estimatedFeesUsdt), 0);
  const winPnl = wins.reduce((total, trade) => total + numeric(trade.pnlUsdt || trade.realizedPnlUsdt), 0);
  const lossPnl = losses.reduce((total, trade) => total + Math.abs(numeric(trade.pnlUsdt || trade.realizedPnlUsdt)), 0);
  const grossPositiveNetNegative = rows.filter((trade) => {
    const net = numeric(trade.pnlUsdt || trade.realizedPnlUsdt);
    const gross = numeric(trade.grossPnlUsdt, net + numeric(trade.feesUsdt || trade.feesPaidUsdt));
    return gross > 0 && net < 0;
  }).length;
  return {
    trades: rows.length,
    netPnlUsdt: round(netPnl),
    grossPnlUsdt: round(grossPnl),
    feesUsdt: round(fees),
    postCostWinRatePct: rows.length ? round((wins.length / rows.length) * 100, 4) : 0,
    profitFactor: lossPnl ? round(winPnl / lossPnl, 4) : winPnl > 0 ? 999 : 0,
    expectancyUsdt: rows.length ? round(netPnl / rows.length) : 0,
    averageWinnerUsdt: wins.length ? round(winPnl / wins.length) : 0,
    averageLoserUsdt: losses.length ? round(-lossPnl / losses.length) : 0,
    feeBleedRatio: Math.abs(netPnl) > 0 ? round(fees / Math.abs(netPnl), 4) : fees > 0 ? 999 : 0,
    grossPositiveButNetNegativeTrades: grossPositiveNetNegative,
  };
}

function setupKey(trade) {
  return trade.continuationSetupType || trade.setupType || "UNKNOWN";
}

function marketModeKey(trade) {
  return trade.marketPersonality || trade.marketMode || trade.marketRegimeType || trade.signalRegime || "UNKNOWN";
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

class ProfitObjectiveEngine {
  constructor(config, store, log) {
    this.config = config;
    this.store = store;
    this.log = log;
  }

  closedTrades() {
    return this.store.trades.filter((trade) => trade.status === "CLOSED" && trade.mode === this.store.state.mode);
  }

  report() {
    const closed = this.closedTrades();
    const today = new Date().toISOString().slice(0, 10);
    const todayTrades = closed.filter((trade) => String(trade.exitedAt || trade.exitTime || "").startsWith(today));
    const latestSummary = {
      generatedAt: new Date().toISOString(),
      objective: "MAXIMIZE_DAILY_REALIZED_NET_PNL_WITH_QUALIFIED_HIGH_ACTIVITY",
      account: {
        equity: this.store.state.equity,
        openPositions: this.store.state.openPositions.length,
        totalCostsUsdt: round(this.store.state.performance && this.store.state.performance.totalFeesUsdt),
        currentRiskLevel: this.store.state.openPositions.reduce((total, position) => total + numeric(position.maxLossAtStopUsdt), 0),
      },
      activity: {
        completedTradesToday: todayTrades.length,
        completedTradesAllTime: closed.length,
        continuationTradesToday: todayTrades.filter((trade) => /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/.test(setupKey(trade))).length,
        reentriesToday: todayTrades.filter((trade) => trade.intelligentReentryTriggered || trade.isReentry).length,
      },
      quality: {
        all: summarize(closed),
        last10: summarize(closed.slice(-10)),
        last25: summarize(closed.slice(-25)),
        last50: summarize(closed.slice(-50)),
        today: summarize(todayTrades),
      },
      breakdown: {
        bySymbol: groupBy(closed, (trade) => trade.symbol),
        bySetup: groupBy(closed, setupKey),
        byMarketMode: groupBy(closed, marketModeKey),
        continuationVsFlip: groupBy(closed, (trade) => trade.isFlip ? "FLIP" : /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/.test(setupKey(trade)) ? "CONTINUATION" : "OTHER"),
        byTier: groupBy(closed, (trade) => trade.convictionTier || trade.edgeTier || trade.tradeCategory || "UNKNOWN"),
      },
      actionability: {
        topProfitableSetup: Object.entries(groupBy(closed, setupKey)).sort((a, b) => b[1].netPnlUsdt - a[1].netPnlUsdt)[0] || null,
        worstLosingPattern: Object.entries(groupBy(closed, setupKey)).sort((a, b) => a[1].netPnlUsdt - b[1].netPnlUsdt)[0] || null,
        systemProducingPositiveEvidence: summarize(closed.slice(-25)).netPnlUsdt > 0,
      },
    };
    const reportsDir = path.join(this.config.projectRoot, "data", "reports");
    writeJson(path.join(reportsDir, "latest-summary.json"), latestSummary);
    writeJson(path.join(reportsDir, "daily", `${today}.json`), {
      generatedAt: latestSummary.generatedAt,
      date: today,
      account: latestSummary.account,
      activity: latestSummary.activity,
      quality: latestSummary.quality.today,
      breakdown: {
        bySymbol: groupBy(todayTrades, (trade) => trade.symbol),
        bySetup: groupBy(todayTrades, setupKey),
        byMarketMode: groupBy(todayTrades, marketModeKey),
      },
    });
    return latestSummary;
  }
}

module.exports = { ProfitObjectiveEngine, summarize };
