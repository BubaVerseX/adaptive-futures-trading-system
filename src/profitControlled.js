"use strict";

const { edgeTier } = require("./costModel");
const { summarizeTrades, closedTrades } = require("./liveValidation");

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 6) {
  return Number(numeric(value).toFixed(places));
}

function earnedRiskTier(signal = {}) {
  return edgeTier(signal);
}

function profitControlledRiskCapPct(config, tier) {
  if (tier === "ELITE_CONTINUATION" || tier === "TIER_3_ELITE_SETUP") return numeric(config.profitControlledEliteMaxStopRiskPct, 1.25);
  if (tier === "STRONG_CONTINUATION" || tier === "TIER_2_STRONG_SETUP") return numeric(config.profitControlledStrongMaxStopRiskPct, 0.85);
  if (tier === "EXPLORATION_POSITIVE_EDGE" || tier === "TIER_1_EXPLORATORY") return numeric(config.profitControlledExplorationMaxStopRiskPct, 0.25);
  return numeric(config.profitControlledNormalMaxStopRiskPct, 0.45);
}

function leverageCapForTier(config, tier) {
  if (tier === "EXPLORATION_POSITIVE_EDGE" || tier === "TIER_1_EXPLORATORY") return numeric(config.profitControlledExplorationMaxLeverage, 3);
  if (tier === "NORMAL_CONTINUATION") return numeric(config.profitControlledNormalMaxLeverage, 4);
  return numeric(config.profitControlledMaxLeverage, 5);
}

function sizingEquityBaseFromBalance(balance = {}, reservedMarginUsdt = 0) {
  const equity = numeric(balance.equity);
  const available = Math.max(
    numeric(balance.available),
    numeric(balance.transferableUsableMargin),
    numeric(balance.walletBalance)
  );
  const base = Math.max(0, Math.min(equity, available || equity));
  return {
    exchangeReportedTotalEquityUsdt: round(equity),
    usableMarginUsdt: round(available),
    sizingEquityBaseUsdt: round(base),
    reservedMarginUsdt: round(reservedMarginUsdt),
  };
}

function ensureProfitControlledState(state = {}, config = {}) {
  if (!state.profitControlled) {
    state.profitControlled = {
      namespace: "data/profit-controlled-live",
      startEquityUsdt: null,
      lastSizingEquityBaseUsdt: null,
      riskState: "RISK_STATE_NORMAL",
      riskStateReasons: [],
      totalOpenStopRiskPctLimit: numeric(config.maxTotalOpenStopRiskPct, 2.25),
      correlatedClusterStopRiskPctLimit: numeric(config.maxCorrelatedClusterStopRiskPct, 1.75),
    };
  }
  return state.profitControlled;
}

function profitControlledRiskState({ config, state = {}, currentEquityUsdt = 0, openPositions = [], unresolvedReason = null, trueApiFailure = false }) {
  const profile = ensureProfitControlledState(state, config);
  if (!(numeric(profile.startEquityUsdt) > 0) && numeric(currentEquityUsdt) > 0) {
    profile.startEquityUsdt = round(currentEquityUsdt);
  }
  const startEquity = numeric(profile.startEquityUsdt, numeric(currentEquityUsdt));
  const drawdownPct = startEquity > 0 ? Math.max(0, ((startEquity - numeric(currentEquityUsdt)) / startEquity) * 100) : 0;
  const reasons = [];
  const hasUnverifiedProtection = openPositions.some((position) => {
    if (!position || position.mode !== "LIVE") return false;
    return !position.nativeProtectionVerified || !(Number(position.stopLossPrice) > 0) || !(Number(position.takeProfitPrice) > 0);
  });
  if (unresolvedReason) reasons.push(unresolvedReason);
  if (hasUnverifiedProtection) reasons.push("TP/SL protection is missing or unverified");
  if (trueApiFailure) reasons.push("repeated true API failures make order state unsafe");
  if (drawdownPct >= numeric(config.profitControlledProtectionDrawdownPct, 7.5)) reasons.push("profit-controlled run drawdown reached protection threshold");
  if (reasons.length) {
    return {
      state: "RISK_STATE_PROTECTION_ONLY",
      riskMultiplier: 0,
      requireStrongOrElite: true,
      allowScanning: true,
      blockNewEntries: true,
      drawdownPct: round(drawdownPct, 4),
      reasons,
    };
  }
  if (drawdownPct >= numeric(config.profitControlledStrongOnlyDrawdownPct, 5)) {
    return {
      state: "RISK_STATE_STRONG_ONLY",
      riskMultiplier: 0.5,
      requireStrongOrElite: true,
      allowScanning: true,
      blockNewEntries: false,
      drawdownPct: round(drawdownPct, 4),
      reasons: ["drawdown reached strong-only risk state"],
    };
  }
  if (drawdownPct >= numeric(config.profitControlledReducedDrawdownPct, 2.5)) {
    return {
      state: "RISK_STATE_REDUCED",
      riskMultiplier: 0.6,
      requireStrongOrElite: false,
      allowScanning: true,
      blockNewEntries: false,
      drawdownPct: round(drawdownPct, 4),
      reasons: ["drawdown reached reduced-risk state"],
    };
  }
  return {
    state: "RISK_STATE_NORMAL",
    riskMultiplier: 1,
    requireStrongOrElite: false,
    allowScanning: true,
    blockNewEntries: false,
    drawdownPct: round(drawdownPct, 4),
    reasons: [],
  };
}

function profitControlledSummary(trades = [], currentEquityUsdt = 0, startEquityUsdt = 0, activity = {}) {
  const summary = summarizeTrades(trades);
  const rows = closedTrades(trades);
  const byExecutionType = {};
  const bySymbol = { BTCUSDT: 0, ETHUSDT: 0, SOLUSDT: 0 };
  for (const trade of rows) {
    const net = numeric(trade.netPnlAfterCostsUsdt, numeric(trade.pnlUsdt));
    const executionType = String(trade.makerOrTaker || trade.executionType || "UNKNOWN");
    byExecutionType[executionType] = round(numeric(byExecutionType[executionType]) + net);
    if (Object.prototype.hasOwnProperty.call(bySymbol, trade.symbol)) {
      bySymbol[trade.symbol] = round(numeric(bySymbol[trade.symbol]) + net);
    }
  }
  return {
    ...summary,
    currentExchangeEquityUsdt: round(currentEquityUsdt),
    startOfRunEquityUsdt: round(startEquityUsdt),
    unrealizedPnlUsdt: round(numeric(currentEquityUsdt) - numeric(startEquityUsdt) - numeric(summary.netPnlUsdt)),
    tradesPerHour: numeric(activity.executedTradesPerHour),
    candidatesFoundPerHour: numeric(activity.qualifiedCandidatesPerHour),
    edgeApprovedCandidatesPerHour: numeric(activity.edgeApprovedCandidatesPerHour),
    riskMinimumRejectedCandidatesPerHour: numeric(activity.rejectedRiskBudgetPerHour),
    bySymbol,
    byExecutionType,
  };
}

module.exports = {
  earnedRiskTier,
  ensureProfitControlledState,
  leverageCapForTier,
  profitControlledRiskCapPct,
  profitControlledRiskState,
  profitControlledSummary,
  sizingEquityBaseFromBalance,
};
