"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  heuristicMicroPredictionBps,
  microCostGate,
  predictionBpsFromInput,
  sanitizeMicroFeatures,
} = require("./signalEngine");

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 8) {
  return Number(numeric(value).toFixed(places));
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writeJson(file, value) {
  ensureDir(file);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function summarizeMicroTrades(trades = []) {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const wins = closed.filter((trade) => numeric(trade.netPnlUsdt) > 0);
  const losses = closed.filter((trade) => numeric(trade.netPnlUsdt) < 0);
  const grossWin = wins.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt), 0));
  return {
    acceptedShadowTrades: trades.length,
    tradesTaken: closed.length,
    grossPnl: round(closed.reduce((sum, trade) => sum + numeric(trade.grossPnlUsdt), 0), 6),
    netPnl: round(closed.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt), 0), 6),
    fees: round(closed.reduce((sum, trade) => sum + numeric(trade.feeCostUsdt), 0), 6),
    winRate: closed.length ? round((wins.length / closed.length) * 100, 4) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : wins.length ? 999 : 0,
    averageHoldSeconds: closed.length ? round(closed.reduce((sum, trade) => sum + numeric(trade.holdSeconds), 0) / closed.length, 4) : 0,
    bySymbol: Object.fromEntries([...new Set(closed.map((trade) => trade.symbol))].map((symbol) => [
      symbol,
      round(closed.filter((trade) => trade.symbol === symbol).reduce((sum, trade) => sum + numeric(trade.netPnlUsdt), 0), 6),
    ])),
  };
}

class MicrostructureShadowEngine {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.openPositions = new Map();
    this.trades = readJson(config.microShadowTradesFile, []);
    this.initialTradeCount = this.trades.length;
    this.rejectionCounts = {};
    this.totalRawSignals = 0;
    this.signalMetrics = [];
    this.unitValidationWarnings = 0;
    this.unitValidationWarningDetails = {};
    this.modelReady = false;
    this.collectingDataOnly = false;
    this.modelStatus = "UNKNOWN";
  }

  reject(reason) {
    this.rejectionCounts[reason] = (this.rejectionCounts[reason] || 0) + 1;
  }

  setModelStatus({ ready = false, collectingDataOnly = false, status = "UNKNOWN" } = {}) {
    this.modelReady = Boolean(ready);
    this.collectingDataOnly = Boolean(collectingDataOnly);
    this.modelStatus = status;
  }

  recordValidationWarnings(symbol, warnings = [], details = []) {
    if (!warnings.length) return;
    this.unitValidationWarnings += 1;
    for (const detail of details) {
      const key = `${detail.feature || "unknown"}:${detail.reason || "UNKNOWN"}`;
      const current = this.unitValidationWarningDetails[key] || {
        feature: detail.feature || "unknown",
        reason: detail.reason || "UNKNOWN",
        count: 0,
        examples: [],
      };
      current.count += 1;
      if (current.examples.length < 5) current.examples.push({ value: detail.value, cap: detail.cap });
      this.unitValidationWarningDetails[key] = current;
    }
    this.log("WARN", "MICRO_FEATURE_VALIDATION_WARNING", { symbol, warnings, details });
  }

  recordRawSnapshot(snapshot) {
    this.totalRawSignals += 1;
    const validation = sanitizeMicroFeatures(snapshot.features || {}, this.config);
    this.recordValidationWarnings(snapshot.symbol, validation.warnings, validation.details);
    return { collected: true, validation };
  }

  evaluateSnapshot(snapshot, modelPrediction = null) {
    this.totalRawSignals += 1;
    const recent = summarizeMicroTrades(this.trades);
    const recentShadowPerformanceScore = recent.tradesTaken >= 10
      ? Math.max(-1, Math.min(1, numeric(recent.netPnl) / Math.max(1, Math.abs(numeric(recent.fees)))))
      : 0;
    const prediction = modelPrediction || { predictedReturnBps: heuristicMicroPredictionBps(snapshot.features || {}, this.config), recentShadowPerformanceScore };
    const gate = microCostGate(snapshot, prediction, this.config);
    this.signalMetrics.push({
      predictedReturnBps: gate.predictedReturnBps,
      expectedNetEdgeBps: gate.expectedNetEdgeBps,
      feeCostBps: gate.feeCostBps,
      spreadCostBps: gate.spreadCostBps,
      slippageCostBps: gate.slippageCostBps,
    });
    this.recordValidationWarnings(snapshot.symbol, gate.featureValidationWarnings || [], gate.featureValidationDetails || []);
    if (!gate.approved) {
      for (const reason of gate.blockedReasons) this.reject(reason);
      return { entered: false, gate };
    }
    const existing = this.openPositions.get(snapshot.symbol);
    if (existing) return { entered: false, gate, reason: "POSITION_ALREADY_OPEN" };
    const marginUsdt = gate.confidence >= 85
      ? this.config.microEliteTradeMarginUsdt
      : gate.confidence >= 72
        ? this.config.microStrongTradeMarginUsdt
        : this.config.microBaseTradeMarginUsdt;
    const position = {
      id: `micro-shadow-${snapshot.symbol}-${snapshot.timestamp}`,
      status: "OPEN",
      symbol: snapshot.symbol,
      side: gate.side,
      enteredAt: snapshot.isoTime,
      entryTimestamp: snapshot.timestamp,
      entryPrice: snapshot.features.midPrice,
      marginUsdt,
      predictedReturnBps: gate.predictedReturnBps,
      expectedNetEdgeBps: gate.expectedNetEdgeBps,
      feeCostBps: gate.feeCostBps,
      spreadCostBps: gate.spreadCostBps,
      slippageCostBps: gate.slippageCostBps,
      safetyBufferBps: gate.safetyBufferBps,
      maxFavorableExcursionPct: 0,
      maxAdverseExcursionPct: 0,
      topContributingFeatures: gate.topContributingFeatures,
    };
    this.openPositions.set(snapshot.symbol, position);
    this.trades.push(position);
    this.log("INFO", `MICRO_SIGNAL_${gate.side}`, {
      symbol: snapshot.symbol,
      confidence: gate.confidence,
      predictedReturnBps: gate.predictedReturnBps,
      expectedNetEdgeBps: gate.expectedNetEdgeBps,
      spreadCostBps: gate.spreadCostBps,
      feeCostBps: gate.feeCostBps,
      slippageCostBps: gate.slippageCostBps,
      features: gate.topContributingFeatures,
      shadowOnly: true,
    });
    return { entered: true, gate, position };
  }

  markToMarket(snapshot, modelPrediction = null) {
    const position = this.openPositions.get(snapshot.symbol);
    if (!position) return null;
    const price = numeric(snapshot.features && snapshot.features.midPrice);
    const movePct = position.side === "LONG"
      ? ((price - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - price) / position.entryPrice) * 100;
    position.maxFavorableExcursionPct = Math.max(position.maxFavorableExcursionPct, movePct);
    position.maxAdverseExcursionPct = Math.min(position.maxAdverseExcursionPct, movePct);
    const heldSeconds = Math.max(0, (snapshot.timestamp - position.entryTimestamp) / 1000);
    const predictionNow = modelPrediction
      ? predictionBpsFromInput(modelPrediction, snapshot.features || {}, this.config)
      : { value: heuristicMicroPredictionBps(snapshot.features || {}, this.config), valid: true };
    const predictionNowBps = predictionNow.valid ? predictionNow.value : 0;
    const signalFlip = (position.side === "LONG" && predictionNowBps < 0) || (position.side === "SHORT" && predictionNowBps > 0);
    const edgeGone = Math.abs(predictionNowBps) < numeric(this.config.microMinNetEdgeBps, 3);
    const maxHold = heldSeconds >= this.config.microMaxHoldSeconds;
    if (!signalFlip && !edgeGone && !maxHold) return null;
    return this.closePosition(snapshot, signalFlip ? "SIGNAL_FLIP" : edgeGone ? "EDGE_DISAPPEARED" : "MAX_HOLD_REACHED");
  }

  closePosition(snapshot, reason) {
    const position = this.openPositions.get(snapshot.symbol);
    if (!position) return null;
    const exitPrice = numeric(snapshot.features && snapshot.features.midPrice);
    const grossReturnPct = position.side === "LONG"
      ? ((exitPrice - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
    const grossReturnBps = grossReturnPct * 100;
    const feeCostBps = numeric(position.feeCostBps);
    const spreadCostBps = numeric(position.spreadCostBps);
    const slippageCostBps = numeric(position.slippageCostBps);
    const netReturnBps = grossReturnBps - feeCostBps - spreadCostBps - slippageCostBps;
    const notionalUsdt = position.marginUsdt * numeric(this.config.maxLeverage, 10);
    Object.assign(position, {
      status: "CLOSED",
      exitedAt: snapshot.isoTime,
      exitTimestamp: snapshot.timestamp,
      exitPrice,
      exitReason: reason,
      holdSeconds: Math.max(0, (snapshot.timestamp - position.entryTimestamp) / 1000),
      grossReturnPct: round(grossReturnPct, 6),
      grossReturnBps: round(grossReturnBps, 6),
      netReturnBps: round(netReturnBps, 6),
      netReturnPct: round(netReturnBps / 100, 6),
      grossPnlUsdt: round(notionalUsdt * grossReturnBps / 10000, 6),
      feeCostUsdt: round(notionalUsdt * feeCostBps / 10000, 6),
      spreadCostUsdt: round(notionalUsdt * spreadCostBps / 10000, 6),
      slippageCostUsdt: round(notionalUsdt * slippageCostBps / 10000, 6),
      netPnlUsdt: round(notionalUsdt * netReturnBps / 10000, 6),
    });
    this.openPositions.delete(snapshot.symbol);
    return position;
  }

  persistReport(featureImportance = []) {
    writeJson(this.config.microShadowTradesFile, this.trades);
    const runTrades = this.trades.slice(this.initialTradeCount);
    const summary = summarizeMicroTrades(runTrades);
    const historicalSummary = summarizeMicroTrades(this.trades);
    const average = (key) => {
      const values = this.signalMetrics.map((item) => numeric(item[key], Number.NaN)).filter(Number.isFinite);
      return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 6) : 0;
    };
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "MICROSTRUCTURE_SHADOW",
      noLiveOrders: true,
      modelReady: this.modelReady,
      modelStatus: this.modelStatus,
      collectingDataOnly: this.collectingDataOnly,
      ...summary,
      totalRawSignals: this.totalRawSignals,
      totalSignals: this.totalRawSignals,
      acceptedShadowTrades: summary.acceptedShadowTrades,
      historicalShadowTrades: historicalSummary.acceptedShadowTrades,
      historicalNetPnl: historicalSummary.netPnl,
      skippedDueToSpread: this.rejectionCounts.SPREAD_TOO_WIDE || 0,
      skippedDueToWeakEdge: this.rejectionCounts.EXPECTED_NET_EDGE_BELOW_MINIMUM_BPS || 0,
      skippedDueToFees: this.rejectionCounts.PREDICTED_RETURN_DOES_NOT_COVER_COSTS || 0,
      skippedDueToStaleData: this.rejectionCounts.STALE_ORDERBOOK_DATA || 0,
      skippedDueToBadFeatureValues: this.rejectionCounts.BAD_FEATURE_VALUES || 0,
      averagePredictedReturnBps: average("predictedReturnBps"),
      averageExpectedNetEdgeBps: average("expectedNetEdgeBps"),
      averageFeeCostBps: average("feeCostBps"),
      averageSpreadCostBps: average("spreadCostBps"),
      averageSlippageCostBps: average("slippageCostBps"),
      maxDrawdown: maxDrawdown(runTrades),
      unitValidationWarnings: this.unitValidationWarnings,
      unitValidationWarningDetails: Object.values(this.unitValidationWarningDetails)
        .sort((left, right) => right.count - left.count),
      bestSymbol: Object.entries(summary.bySymbol || {}).sort((left, right) => right[1] - left[1])[0]?.[0] || null,
      worstSymbol: Object.entries(summary.bySymbol || {}).sort((left, right) => left[1] - right[1])[0]?.[0] || null,
      featureImportance,
      rejectionCounts: this.rejectionCounts,
      liveEligibility: {
        minimumShadowSignals: this.config.microShadowMinSignals,
        positiveAfterFeesRequired: true,
        minimumProfitFactor: 1.2,
        maxDrawdownUsdt: this.config.microMaxDrawdownUsdt,
        noUnitValidationWarnings: true,
        eligible: this.totalRawSignals >= this.config.microShadowMinSignals &&
          summary.netPnl > this.config.microShadowMinimumNetPnlUsdt &&
          summary.profitFactor > 1.2 &&
          maxDrawdown(runTrades) <= this.config.microMaxDrawdownUsdt &&
          this.unitValidationWarnings === 0,
      },
    };
    writeJson(this.config.microLatestSummaryFile, report);
    return report;
  }
}

module.exports = {
  MicrostructureShadowEngine,
  summarizeMicroTrades,
};

function maxDrawdown(trades = []) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const trade of trades.filter((item) => item.status === "CLOSED")) {
    equity += numeric(trade.netPnlUsdt);
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return round(drawdown, 6);
}
