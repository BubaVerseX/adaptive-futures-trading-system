"use strict";

const LIVE_VALIDATION_LEVELS = Object.freeze({
  0: { level: 0, name: "INITIAL_VALIDATION", allocatedEquityUsdt: 10 },
  1: { level: 1, name: "SMALL_SCALE_VALIDATION", allocatedEquityUsdt: 20 },
  2: { level: 2, name: "CONTROLLED_GROWTH", allocatedEquityUsdt: 35 },
});

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 6) {
  return Number(numeric(value).toFixed(places));
}

function tradeNetPnl(trade) {
  return numeric(trade.netPnlAfterCostsUsdt, numeric(trade.pnlUsdt || trade.realizedPnlUsdt));
}

function tradeFees(trade) {
  return numeric(trade.feesUsdt || trade.actualFeeUsdt || trade.feesPaidUsdt || trade.estimatedFeesUsdt);
}

function tradeGrossPnl(trade) {
  return numeric(trade.grossPnlUsdt, tradeNetPnl(trade) + tradeFees(trade));
}

function isContinuationTrade(trade) {
  return /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/i.test(
    String(trade.continuationSetupType || trade.setupType || trade.edgeTier || "")
  );
}

function closedTrades(trades = []) {
  return trades
    .filter((trade) => trade && trade.status === "CLOSED" && Number.isFinite(tradeNetPnl(trade)))
    .slice()
    .sort((left, right) => Date.parse(left.exitedAt || left.exitTime || "") - Date.parse(right.exitedAt || right.exitTime || ""));
}

function summarizeTrades(trades = []) {
  const rows = closedTrades(trades);
  const wins = rows.filter((trade) => tradeNetPnl(trade) > 0);
  const losses = rows.filter((trade) => tradeNetPnl(trade) < 0);
  const netPnlUsdt = rows.reduce((total, trade) => total + tradeNetPnl(trade), 0);
  const grossPnlUsdt = rows.reduce((total, trade) => total + tradeGrossPnl(trade), 0);
  const grossProfitUsdt = rows.reduce((total, trade) => total + Math.max(0, tradeGrossPnl(trade)), 0);
  const feesUsdt = rows.reduce((total, trade) => total + tradeFees(trade), 0);
  const winPnlUsdt = wins.reduce((total, trade) => total + tradeNetPnl(trade), 0);
  const lossPnlUsdt = losses.reduce((total, trade) => total + Math.abs(tradeNetPnl(trade)), 0);
  const continuationNetPnlUsdt = rows.filter(isContinuationTrade).reduce((total, trade) => total + tradeNetPnl(trade), 0);
  const flipNetPnlUsdt = rows.filter((trade) => trade.isFlip).reduce((total, trade) => total + tradeNetPnl(trade), 0);
  const reentryNetPnlUsdt = rows
    .filter((trade) => trade.isReentry || trade.intelligentReentryTriggered)
    .reduce((total, trade) => total + tradeNetPnl(trade), 0);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownUsdt = 0;
  for (const trade of rows) {
    cumulative += tradeNetPnl(trade);
    peak = Math.max(peak, cumulative);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - cumulative);
  }
  const bySymbol = new Map();
  for (const trade of rows) {
    const symbol = String(trade.symbol || "UNKNOWN");
    bySymbol.set(symbol, round(numeric(bySymbol.get(symbol)) + tradeNetPnl(trade)));
  }
  const sortedSymbols = [...bySymbol.entries()].sort((left, right) => right[1] - left[1]);
  return {
    closedTrades: rows.length,
    netPnlUsdt: round(netPnlUsdt),
    grossPnlUsdt: round(grossPnlUsdt),
    grossProfitUsdt: round(grossProfitUsdt),
    actualFeesUsdt: round(feesUsdt),
    postCostWinRatePct: rows.length ? round((wins.length / rows.length) * 100, 4) : 0,
    profitFactor: lossPnlUsdt ? round(winPnlUsdt / lossPnlUsdt, 4) : winPnlUsdt > 0 ? 999 : 0,
    expectancyUsdt: rows.length ? round(netPnlUsdt / rows.length) : 0,
    feeToGrossProfitRatio: grossProfitUsdt > 0 ? round(feesUsdt / grossProfitUsdt, 4) : feesUsdt > 0 ? 999 : 0,
    grossPositiveButNetNegativeTrades: rows.filter((trade) => tradeGrossPnl(trade) > 0 && tradeNetPnl(trade) < 0).length,
    continuationNetPnlUsdt: round(continuationNetPnlUsdt),
    flipNetPnlUsdt: round(flipNetPnlUsdt),
    reentryNetPnlUsdt: round(reentryNetPnlUsdt),
    maxDrawdownUsdt: round(maxDrawdownUsdt),
    bestSymbol: sortedSymbols[0] ? { symbol: sortedSymbols[0][0], netPnlUsdt: sortedSymbols[0][1] } : null,
    worstSymbol: sortedSymbols[sortedSymbols.length - 1]
      ? { symbol: sortedSymbols[sortedSymbols.length - 1][0], netPnlUsdt: sortedSymbols[sortedSymbols.length - 1][1] }
      : null,
  };
}

function liveValidationLevel(state = {}) {
  const level = numeric(state.liveValidation && state.liveValidation.level, 0);
  return LIVE_VALIDATION_LEVELS[level] ? level : 0;
}

function allocatedEquityLimitUsdt(config, state = {}) {
  const level = liveValidationLevel(state);
  if (level === 0) return Math.min(numeric(config.liveValidationMaxAllocatedEquityUsdt, 10), LIVE_VALIDATION_LEVELS[0].allocatedEquityUsdt);
  return LIVE_VALIDATION_LEVELS[level].allocatedEquityUsdt;
}

function liveValidationAllocation(config, state, accountEquityUsdt, availableBalanceUsdt) {
  const limit = allocatedEquityLimitUsdt(config, state);
  return Math.max(0, Math.min(limit, numeric(accountEquityUsdt), numeric(availableBalanceUsdt, accountEquityUsdt)));
}

function hasUnprotectedLivePosition(openPositions = []) {
  return openPositions.some((position) => {
    if (!position || position.mode !== "LIVE") return false;
    return !position.nativeProtectionVerified || !(Number(position.stopLossPrice) > 0) || !(Number(position.takeProfitPrice) > 0);
  });
}

function hasLedgerDuplicateEvidence(executionLedger) {
  const data = executionLedger && (executionLedger.data || executionLedger);
  return Boolean(data && (data.duplicateOrderDetected || data.duplicateFillDetected || data.duplicateLogicalTradeDetected));
}

function promotionEvaluation({ config, state = {}, trades = [], executionLedger = null, openPositions = [], unresolvedReason = null }) {
  const level = liveValidationLevel(state);
  const summary = summarizeTrades(trades);
  const last25 = summarizeTrades(closedTrades(trades).slice(-25));
  const reasons = [];
  const duplicateOrders = hasLedgerDuplicateEvidence(executionLedger);
  const unprotected = hasUnprotectedLivePosition(openPositions);
  const recoveryActive = Boolean(state.apiRecovery && state.apiRecovery.active);
  const feeRatioLimit = numeric(config.liveValidationMaxFeeToGrossProfitRatio, 0.65);
  const feeRatioOk = summary.feeToGrossProfitRatio <= feeRatioLimit;
  if (level === 0) {
    if (summary.closedTrades < 50) reasons.push("fewer than 50 closed logical live-validation trades");
    if (summary.netPnlUsdt <= 0) reasons.push("net PnL after actual fees is not positive");
    if (summary.profitFactor < 1.1) reasons.push("profit factor below 1.10");
  } else if (level === 1) {
    if (summary.closedTrades < 100) reasons.push("fewer than 100 cumulative closed logical live-validation trades");
    if (summary.netPnlUsdt <= 0) reasons.push("net PnL after actual fees is not positive");
    if (summary.profitFactor < 1.15) reasons.push("profit factor below 1.15");
    if (last25.expectancyUsdt <= 0) reasons.push("rolling last-25-trades expectancy is not positive");
    if (summary.maxDrawdownUsdt > allocatedEquityLimitUsdt(config, state) * (numeric(config.liveValidationMaxPromotionDrawdownPct, 15) / 100)) {
      reasons.push("max drawdown exceeds validation promotion bound");
    }
  } else {
    reasons.push("promotion beyond 35 USDT requires explicit human approval");
  }
  if (duplicateOrders) reasons.push("duplicate order/fill evidence exists in execution ledger");
  if (unprotected) reasons.push("one or more live positions lack verified TP/SL protection");
  if (unresolvedReason) reasons.push(unresolvedReason);
  if (recoveryActive) reasons.push("API recovery or state rebuild is still active");
  if (!feeRatioOk) reasons.push("fee ratio is still destroying too much gross profit");
  const eligible = reasons.length === 0 && level < 2;
  return {
    level,
    currentLevelName: LIVE_VALIDATION_LEVELS[level].name,
    allocatedEquityLimitUsdt: allocatedEquityLimitUsdt(config, state),
    nextLevel: eligible ? level + 1 : null,
    nextAllocatedEquityLimitUsdt: eligible ? LIVE_VALIDATION_LEVELS[level + 1].allocatedEquityUsdt : null,
    promotionEnabled: Boolean(config.liveValidationPromotionEnabled),
    eligible,
    blockedReasons: reasons,
    summary,
    last25,
  };
}

function riskStateEvaluation({ config, state = {}, trades = [], openPositions = [], unresolvedReason = null, trueApiFailure = false }) {
  const allocation = allocatedEquityLimitUsdt(config, state);
  const summary = summarizeTrades(trades);
  const last25 = summarizeTrades(closedTrades(trades).slice(-25));
  const drawdownLimitUsdt = allocation * (numeric(config.liveValidationProtectionDrawdownPct, 15) / 100);
  const protectionReasons = [];
  if (unresolvedReason) protectionReasons.push(unresolvedReason);
  if (hasUnprotectedLivePosition(openPositions)) protectionReasons.push("TP/SL protection is missing or unverified");
  if (trueApiFailure) protectionReasons.push("repeated true API failures make exchange state unsafe");
  if (summary.maxDrawdownUsdt >= drawdownLimitUsdt && summary.closedTrades > 0) {
    protectionReasons.push("live-validation allocation drawdown reached protection threshold");
  }
  if (protectionReasons.length) {
    return {
      state: "RISK_STATE_PROTECTION_ONLY",
      riskMultiplier: 0,
      drawdownLimitUsdt: round(drawdownLimitUsdt),
      reasons: protectionReasons,
      summary,
      last25,
    };
  }
  const reducedReasons = [];
  if (last25.closedTrades >= 8 && last25.netPnlUsdt < -drawdownLimitUsdt * 0.35) {
    reducedReasons.push("rolling net PnL is materially negative");
  }
  if (summary.closedTrades >= 10 && summary.feeToGrossProfitRatio > numeric(config.liveValidationReducedFeeDragRatio, 0.8)) {
    reducedReasons.push("fee drag is excessive versus gross profit");
  }
  if (reducedReasons.length) {
    return {
      state: "RISK_STATE_REDUCED",
      riskMultiplier: numeric(config.liveValidationReducedRiskMultiplier, 0.6),
      drawdownLimitUsdt: round(drawdownLimitUsdt),
      reasons: reducedReasons,
      summary,
      last25,
    };
  }
  return {
    state: "RISK_STATE_NORMAL",
    riskMultiplier: 1,
    drawdownLimitUsdt: round(drawdownLimitUsdt),
    reasons: [],
    summary,
    last25,
  };
}

module.exports = {
  LIVE_VALIDATION_LEVELS,
  allocatedEquityLimitUsdt,
  closedTrades,
  liveValidationAllocation,
  liveValidationLevel,
  promotionEvaluation,
  riskStateEvaluation,
  summarizeTrades,
};
