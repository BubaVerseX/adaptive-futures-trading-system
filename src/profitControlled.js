"use strict";

const { edgeTier } = require("./costModel");
const { summarizeTrades, closedTrades } = require("./liveValidation");

const FOCUSED_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value, places = 6) {
  return Number(numeric(value).toFixed(places));
}

function tradeNetPnl(trade) {
  return numeric(trade.netPnlAfterCostsUsdt, numeric(trade.pnlUsdt, numeric(trade.realizedPnlUsdt)));
}

function tradeFees(trade) {
  return numeric(trade.feesUsdt, numeric(trade.actualFeeUsdt, numeric(trade.feesPaidUsdt, numeric(trade.estimatedFeesUsdt))));
}

function tradeGrossPnl(trade) {
  return numeric(trade.grossPnlUsdt, tradeNetPnl(trade) + tradeFees(trade));
}

function earnedRiskTier(signal = {}) {
  if (signal.profitQualityTier === "ELITE") return "ELITE_CONTINUATION";
  if (signal.profitQualityTier === "STRONG") return "STRONG_CONTINUATION";
  if (signal.profitQualityTier === "NORMAL") return "NORMAL_CONTINUATION";
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

function closedSymbolTrades(trades = [], symbol) {
  return closedTrades(trades).filter((trade) => String(trade.symbol || "").toUpperCase() === String(symbol || "").toUpperCase());
}

function performanceForRows(rows = []) {
  const wins = rows.filter((trade) => tradeNetPnl(trade) > 0);
  const losses = rows.filter((trade) => tradeNetPnl(trade) < 0);
  const runnerRows = rows.filter((trade) => trade.runnerPartialTaken || numeric(trade.runnerNetContributionUsdt) !== 0);
  const runnerWins = runnerRows.filter((trade) => numeric(trade.runnerNetContributionUsdt) > 0);
  const netPnlUsdt = rows.reduce((total, trade) => total + tradeNetPnl(trade), 0);
  const winPnlUsdt = wins.reduce((total, trade) => total + tradeNetPnl(trade), 0);
  const lossPnlUsdt = losses.reduce((total, trade) => total + Math.abs(tradeNetPnl(trade)), 0);
  const totalFeesUsdt = rows.reduce((total, trade) => total + tradeFees(trade), 0);
  const grossProfitUsdt = rows.reduce((total, trade) => total + Math.max(0, tradeGrossPnl(trade)), 0);
  const runnerContributionUsdt = rows.reduce((total, trade) => total + numeric(trade.runnerNetContributionUsdt), 0);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownUsdt = 0;
  for (const trade of rows) {
    cumulative += tradeNetPnl(trade);
    peak = Math.max(peak, cumulative);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - cumulative);
  }
  return {
    samples: rows.length,
    winRatePct: rows.length ? round((wins.length / rows.length) * 100, 4) : 0,
    netPnlUsdt: round(netPnlUsdt),
    profitFactor: lossPnlUsdt ? round(winPnlUsdt / lossPnlUsdt, 4) : winPnlUsdt > 0 ? 999 : 0,
    expectancyUsdt: rows.length ? round(netPnlUsdt / rows.length) : 0,
    averageWinnerUsdt: wins.length ? round(winPnlUsdt / wins.length) : 0,
    averageLoserUsdt: losses.length ? round(-lossPnlUsdt / losses.length) : 0,
    totalFeesUsdt: round(totalFeesUsdt),
    feeImpactRatio: grossProfitUsdt > 0 ? round(totalFeesUsdt / grossProfitUsdt, 4) : totalFeesUsdt > 0 ? 999 : 0,
    runnerContributionUsdt: round(runnerContributionUsdt),
    averageRunnerProfitUsdt: rows.length ? round(runnerContributionUsdt / rows.length) : 0,
    runnerTrades: runnerRows.length,
    runnerWinRatePct: runnerRows.length ? round((runnerWins.length / runnerRows.length) * 100, 4) : 0,
    maxDrawdownUsdt: round(maxDrawdownUsdt),
  };
}

function setupFamily(value = "") {
  const text = String(value || "UNKNOWN").toUpperCase();
  if (/BREAKOUT/.test(text)) return "BREAKOUT";
  if (/CONTINUATION|RETEST|RESUMPTION|ACCELERATION/.test(text)) return "CONTINUATION";
  if (/FLIP|REVERSAL/.test(text)) return "FLIP";
  if (/SCALP|MOMENTUM/.test(text)) return "MOMENTUM";
  return text || "UNKNOWN";
}

function setupRankingKey(item = {}) {
  const symbol = String(item.symbol || "UNKNOWN").toUpperCase();
  const family = setupFamily(item.continuationSetupType || item.setupType || item.tradeCategory);
  return `${symbol}:${family}`;
}

function memoryWeightFromPerformance(performance, boostPf = 1.3, reducePf = 1) {
  if (!performance || performance.samples < 5) {
    return { weight: 1, bias: "NEUTRAL", reason: "small sample; no strong weighting" };
  }
  if (performance.profitFactor > boostPf && performance.expectancyUsdt > 0) {
    return { weight: 1.1, bias: "BOOST", reason: `profit factor ${performance.profitFactor} above ${boostPf}` };
  }
  if (performance.profitFactor < reducePf || performance.expectancyUsdt < 0) {
    return { weight: 0.9, bias: "REDUCE", reason: `profit factor ${performance.profitFactor} below ${reducePf} or expectancy negative` };
  }
  return { weight: 1, bias: "NEUTRAL", reason: "performance is neutral" };
}

function setupRankingMemory(trades = [], signal = {}, config = {}) {
  const rows = closedTrades(trades);
  const grouped = groupRows(rows, setupRankingKey);
  const key = setupRankingKey(signal);
  const performance = performanceForRows(grouped[key] || []);
  const weighting = memoryWeightFromPerformance(
    performance,
    numeric(config.setupRankingBoostProfitFactor, 1.3),
    numeric(config.setupRankingReduceProfitFactor, 1)
  );
  return {
    key,
    setupFamily: setupFamily(signal.continuationSetupType || signal.setupType || signal.tradeCategory),
    performance,
    ...weighting,
    neverDisabled: true,
  };
}

function setupRankingReport(trades = [], config = {}) {
  const grouped = groupRows(closedTrades(trades), setupRankingKey);
  return rankByNetPnl(grouped).map((item) => ({
    ...item,
    weighting: memoryWeightFromPerformance(
      item,
      numeric(config.setupRankingBoostProfitFactor, 1.3),
      numeric(config.setupRankingReduceProfitFactor, 1)
    ),
    neverDisabled: true,
  }));
}

function compactSymbol(symbol = "") {
  return String(symbol || "UNKNOWN").toUpperCase().replace(/USDT$/, "") || "UNKNOWN";
}

function compactRegime(value = "") {
  const text = String(value || "UNKNOWN").toUpperCase();
  if (/SIDEWAYS|CHOP/.test(text)) return "CHOP";
  if (/BREAKOUT/.test(text)) return "BREAKOUT";
  if (/PANIC/.test(text)) return "PANIC";
  if (/VOLATILE/.test(text)) return "VOLATILE";
  if (/TREND/.test(text)) return "TRENDING";
  return text || "UNKNOWN";
}

function setupRegimeMatrixKey(item = {}) {
  return `${compactSymbol(item.symbol)}_${setupFamily(item.continuationSetupType || item.setupType || item.tradeCategory)} x ${compactRegime(regimeKey(item))}`;
}

function setupRegimeMatrixMemory(trades = [], signal = {}, config = {}) {
  const grouped = groupRows(closedTrades(trades), setupRegimeMatrixKey);
  const key = setupRegimeMatrixKey(signal);
  const performance = performanceForRows(grouped[key] || []);
  const weighting = memoryWeightFromPerformance(
    performance,
    numeric(config.setupRegimeMatrixBoostProfitFactor, numeric(config.setupRankingBoostProfitFactor, 1.3)),
    numeric(config.setupRegimeMatrixReduceProfitFactor, numeric(config.setupRankingReduceProfitFactor, 1))
  );
  return {
    key,
    symbol: compactSymbol(signal.symbol),
    setupFamily: setupFamily(signal.continuationSetupType || signal.setupType || signal.tradeCategory),
    regime: compactRegime(regimeKey(signal)),
    performance,
    ...weighting,
    neverDisabled: true,
  };
}

function setupRegimeMatrixReport(trades = [], config = {}) {
  const grouped = groupRows(closedTrades(trades), setupRegimeMatrixKey);
  return rankByNetPnl(grouped).map((item) => ({
    ...item,
    weighting: memoryWeightFromPerformance(
      item,
      numeric(config.setupRegimeMatrixBoostProfitFactor, numeric(config.setupRankingBoostProfitFactor, 1.3)),
      numeric(config.setupRegimeMatrixReduceProfitFactor, numeric(config.setupRankingReduceProfitFactor, 1))
    ),
    neverDisabled: true,
  }));
}

function regimeKey(item = {}) {
  return String(item.marketRegimeV2 || item.marketRegimeType || item.marketRegime || "UNKNOWN").toUpperCase();
}

function regimePerformanceMemory(trades = [], signal = {}, config = {}) {
  const rows = closedTrades(trades);
  const grouped = groupRows(rows, regimeKey);
  const key = regimeKey(signal);
  const performance = performanceForRows(grouped[key] || []);
  const weighting = memoryWeightFromPerformance(
    performance,
    numeric(config.regimeMemoryBoostProfitFactor, 1.3),
    numeric(config.regimeMemoryReduceProfitFactor, 1)
  );
  return {
    key,
    performance,
    ...weighting,
    neverDisabled: true,
  };
}

function regimePerformanceReport(trades = [], config = {}) {
  const grouped = groupRows(closedTrades(trades), regimeKey);
  return rankByNetPnl(grouped).map((item) => ({
    ...item,
    weighting: memoryWeightFromPerformance(
      item,
      numeric(config.regimeMemoryBoostProfitFactor, 1.3),
      numeric(config.regimeMemoryReduceProfitFactor, 1)
    ),
    neverDisabled: true,
  }));
}

function symbolPerformanceMemoryV3(trades = [], symbol) {
  const rows = closedSymbolTrades(trades, symbol);
  const rolling50 = performanceForRows(rows.slice(-50));
  const rolling100 = performanceForRows(rows.slice(-100));
  const sampleWeight = clamp((rolling50.samples + rolling100.samples) / 80, 0, 1);
  let evidence = 0;
  if (rolling50.samples >= 8) {
    evidence += rolling50.netPnlUsdt > 0 ? 0.055 : rolling50.netPnlUsdt < 0 ? -0.055 : 0;
    evidence += rolling50.profitFactor >= 1.2 ? 0.045 : rolling50.profitFactor > 0 && rolling50.profitFactor < 0.85 ? -0.045 : 0;
    evidence += rolling50.runnerContributionUsdt > 0 ? 0.02 : rolling50.runnerContributionUsdt < 0 ? -0.02 : 0;
  }
  if (rolling100.samples >= 15) {
    evidence += rolling100.netPnlUsdt > 0 ? 0.045 : rolling100.netPnlUsdt < 0 ? -0.045 : 0;
    evidence += rolling100.profitFactor >= 1.15 ? 0.035 : rolling100.profitFactor > 0 && rolling100.profitFactor < 0.9 ? -0.035 : 0;
  }
  const weight = round(clamp(1 + evidence * Math.max(sampleWeight, 0.25), 0.78, 1.18), 4);
  return {
    symbol,
    rolling50,
    rolling100,
    weight,
    bias: weight > 1.03 ? "STRENGTHENED" : weight < 0.97 ? "DOWNWEIGHTED" : "NEUTRAL",
    neverDisabled: true,
  };
}

function symbolPerformanceMemoryV2(trades = [], symbol) {
  return symbolPerformanceMemoryV3(trades, symbol);
}

function symbolPerformanceMemoryV3Map(trades = []) {
  return Object.fromEntries(FOCUSED_SYMBOLS.map((symbol) => [symbol, symbolPerformanceMemoryV3(trades, symbol)]));
}

function symbolPerformanceMemoryV2Map(trades = []) {
  return symbolPerformanceMemoryV3Map(trades);
}

function volumeQualityScore(signal = {}) {
  if (signal.volumeCondition === "STRONG_VOLUME_SPIKE") return 96;
  if (signal.volumeCondition === "CONFIRMED_VOLUME") return 84;
  if (numeric(signal.volumeSpike) >= 1.6) return 88;
  if (numeric(signal.volumeSpike) >= 1.15) return 68;
  if (signal.volumeCondition === "LOW_VOLUME") return 28;
  return 55;
}

function spreadQualityScore(config = {}, signal = {}) {
  const spread = Math.max(0, numeric(signal.spreadPct));
  const maxSpread = Math.max(0.0001, numeric(config.maxSpreadPct, 0.6));
  if (spread <= maxSpread * 0.25) return 96;
  if (spread <= maxSpread * 0.5) return 86;
  if (spread <= maxSpread * 0.85) return 72;
  if (spread <= maxSpread) return 58;
  return 24;
}

function regimeQualityScore(signal = {}) {
  const tags = Array.isArray(signal.marketRegimeTags) ? signal.marketRegimeTags : [];
  const personality = String(signal.marketPersonality || signal.marketRegimeType || "");
  if (tags.includes("STRONG_TRENDING_MARKET") || /TREND_ATTACK|HIGH_MOMENTUM_CONTINUATION|TREND/i.test(personality)) return 92;
  if (tags.includes("HIGH_VOLATILITY_BREAKOUT_MARKET") || /EXPLOSIVE|MOMENTUM/i.test(personality)) return 88;
  if (tags.includes("BTC_LED_MARKET") || tags.includes("ALTCOIN_MOMENTUM_MARKET")) return 78;
  if (tags.includes("SIDEWAYS_CHOP_MARKET") || /CHOP/i.test(personality)) return 38;
  if (tags.includes("FAKE_BREAKOUT_ENVIRONMENT")) return 30;
  if (tags.includes("DEAD_MARKET_CONDITIONS")) return 20;
  return 60;
}

function expectancyQualityScore(config = {}, signal = {}, edgeModel = {}) {
  const netEdge = Math.max(numeric(signal.smartProjectedNetEdgePct), numeric(signal.projectedNetEdgePct), numeric(edgeModel.expectedNetEdgePct));
  const rewardCost = Math.max(numeric(signal.feeEdgeRatio), numeric(edgeModel.expectedRewardCostRatio));
  const rewardRisk = numeric(edgeModel.expectedRewardRiskRatio, numeric(signal.expectedRewardRiskRatio, 1));
  const netFloor = Math.max(0.0001, numeric(config.edgeNormalMinNetPct, numeric(config.minProjectedEdgePct, 0.14)));
  const costFloor = Math.max(0.0001, numeric(config.edgeNormalMinRewardCostRatio, numeric(config.minEdgeToCostRatio, 1.55)));
  const netScore = clamp((netEdge / netFloor) * 52, 0, 100);
  const costScore = clamp((rewardCost / costFloor) * 36, 0, 100);
  const riskScore = clamp((rewardRisk / Math.max(1, numeric(config.edgeNormalMinRewardRiskRatio, 1.25))) * 12, 0, 100);
  return clamp(netScore + costScore + riskScore, 0, 100);
}

function expectancyOptimizer(trades = [], config = {}) {
  const rows = closedTrades(trades);
  const windowSize = Math.max(1, numeric(config.expectancyOptimizerWindowTrades, 50));
  const windowRows = rows.slice(-windowSize);
  const all = performanceForRows(rows);
  const rolling = performanceForRows(windowRows);
  const continuationRows = windowRows.filter((trade) =>
    /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/i.test(String(trade.continuationSetupType || trade.setupType || trade.tradeCategory || ""))
  );
  const runnerRows = windowRows.filter((trade) => trade.runnerPartialTaken || numeric(trade.runnerNetContributionUsdt) !== 0);
  const continuation = performanceForRows(continuationRows);
  const runner = performanceForRows(runnerRows);
  const feeDragRatio = rolling.feeImpactRatio;
  const feeDragTighteningActive =
    rolling.samples >= Math.min(windowSize, 10) &&
    feeDragRatio >= numeric(config.expectancyFeeDragTightenRatio, 0.65);
  const continuationOutperforming =
    continuation.samples >= 5 &&
    continuation.expectancyUsdt > rolling.expectancyUsdt &&
    continuation.profitFactor >= Math.max(1.01, rolling.profitFactor);
  const runnerContributionPositive = runner.runnerContributionUsdt > 0 || rolling.runnerContributionUsdt > 0;
  return {
    evaluatedEveryClosedTrades: windowSize,
    nextEvaluationAtClosedTrade: rows.length + (windowSize - (rows.length % windowSize || windowSize)),
    closedTrades: rows.length,
    lastWindow: rolling,
    fullHistory: all,
    continuation,
    runner,
    feeDragTighteningActive,
    entryTighteningPoints: feeDragTighteningActive ? numeric(config.expectancyEntryTighteningPoints, 2) : 0,
    continuationOutperforming,
    continuationWeightBoostPoints: continuationOutperforming ? numeric(config.expectancyContinuationBoostPoints, 3) : 0,
    runnerContributionPositive,
    runnerExtensionMultiplier: runnerContributionPositive ? numeric(config.expectancyRunnerExtensionBoost, 1.08) : 1,
  };
}

function expectancyAutoTuning(trades = [], config = {}) {
  const rows = closedTrades(trades);
  const windowSize = Math.max(1, numeric(config.expectancyAutoTuningWindowTrades, 100));
  const maxAdjustmentPct = Math.min(5, Math.max(0, numeric(config.expectancyAutoTuningMaxAdjustmentPct, 5)));
  const recent = performanceForRows(rows.slice(-windowSize));
  const previous = performanceForRows(rows.slice(-windowSize * 2, -windowSize));
  const active = rows.length >= windowSize;
  let adjustmentPct = 0;
  let bias = "NEUTRAL";
  let reason = active ? "recent expectancy is neutral" : "waiting for enough closed trades";
  if (active && (recent.profitFactor < numeric(config.expectancyAutoTuningTightenProfitFactor, 1) || recent.expectancyUsdt < 0)) {
    adjustmentPct = maxAdjustmentPct;
    bias = "TIGHTEN";
    reason = `profit factor ${recent.profitFactor} below 1 or expectancy negative`;
  } else if (active && recent.profitFactor > numeric(config.expectancyAutoTuningRelaxProfitFactor, 1.3) && recent.expectancyUsdt > 0) {
    adjustmentPct = -maxAdjustmentPct;
    bias = "RELAX";
    reason = `profit factor ${recent.profitFactor} above 1.3 with positive expectancy`;
  }
  return {
    evaluatedEveryClosedTrades: windowSize,
    closedTrades: rows.length,
    active,
    maxAdjustmentPct,
    adjustmentPct: round(adjustmentPct, 4),
    thresholdMultiplier: round(1 + adjustmentPct / 100, 4),
    bias,
    reason,
    recent,
    previous,
    profitFactorTrend: metricTrend(recent.profitFactor, previous.profitFactor),
    expectancyTrend: metricTrend(recent.expectancyUsdt, previous.expectancyUsdt),
    feeDragRatio: recent.feeImpactRatio,
  };
}

function adaptiveActivityRecovery(trades = [], config = {}, now = Date.now()) {
  const rows = closedTrades(trades);
  const windowMinutes = numeric(config.adaptiveEdgeActivityRecoveryWindowMinutes, 240);
  const targetTrades = numeric(config.adaptiveEdgeActivityRecoveryTargetTrades, 2);
  const maxRelaxPct = clamp(numeric(config.adaptiveEdgeActivityRecoveryMaxRelaxPct, 3), 0, 5);
  const windowMs = Math.max(1, windowMinutes) * 60 * 1000;
  const recent = rows.filter((trade) => {
    const closedAt = Date.parse(trade.exitedAt || trade.exitTime || trade.closedAt || "");
    return Number.isFinite(closedAt) && now - closedAt >= 0 && now - closedAt <= windowMs;
  });
  const rolling = performanceForRows(rows.slice(-50));
  const feeDragOk =
    rolling.samples < 10 ||
    rolling.feeImpactRatio <= numeric(config.adaptiveEdgeActivityRecoveryMaxFeeDragRatio, 0.65);
  const expectancyOk =
    rolling.samples < 10 ||
    rolling.profitFactor >= numeric(config.adaptiveEdgeActivityRecoveryMinProfitFactor, 1);
  const active =
    Boolean(config.adaptiveEdgeActivityRecoveryMode) &&
    recent.length < targetTrades &&
    feeDragOk &&
    expectancyOk;
  return {
    active,
    recentClosedTrades: recent.length,
    targetClosedTrades: targetTrades,
    windowMinutes,
    maxRelaxPct,
    thresholdMultiplier: active ? round(1 - maxRelaxPct / 100, 4) : 1,
    scoreBoost: active ? round(maxRelaxPct * 0.45, 4) : 0,
    feeDragOk,
    expectancyOk,
    rollingProfitFactor: rolling.profitFactor,
    rollingExpectancyUsdt: rolling.expectancyUsdt,
    reason: active
      ? "qualified activity recovery nudges thresholds without bypassing edge, fee, or risk gates"
      : recent.length >= targetTrades
        ? "recent trade activity is sufficient"
        : !feeDragOk
          ? "fee drag too high; activity recovery withheld"
          : !expectancyOk
            ? "profit factor below recovery minimum; activity recovery withheld"
            : "activity recovery disabled",
    neverForcesTrades: true,
  };
}

function dynamicInactivityRecovery(config = {}, lastTradeOpenedAtMs = Date.now(), now = Date.now()) {
  const lastTradeMs = Number(lastTradeOpenedAtMs);
  const validLastTradeMs = Number.isFinite(lastTradeMs) ? lastTradeMs : now;
  const inactiveHours = Math.max(0, (now - validLastTradeMs) / 3600000);
  let convictionRelaxPoints = 0;
  let stage = "NONE";
  if (inactiveHours >= 12) {
    convictionRelaxPoints = numeric(config.inactivityRecoveryTwelveHourRelaxPoints, numeric(config.inactivityRecoveryTwelveHourRelaxPct, 6));
    stage = "INACTIVE_12H";
  } else if (inactiveHours >= 8) {
    convictionRelaxPoints = numeric(config.inactivityRecoveryEightHourRelaxPoints, numeric(config.inactivityRecoveryEightHourRelaxPct, 4));
    stage = "INACTIVE_8H";
  } else if (inactiveHours >= 4) {
    convictionRelaxPoints = numeric(config.inactivityRecoveryFourHourRelaxPoints, numeric(config.inactivityRecoveryFourHourRelaxPct, 2));
    stage = "INACTIVE_4H";
  }
  const active = Boolean(config.inactivityRecoveryMode) && convictionRelaxPoints > 0;
  return {
    active,
    stage,
    inactiveHours: round(inactiveHours, 4),
    convictionRelaxPct: active ? round(convictionRelaxPoints, 4) : 0,
    convictionRelaxPoints: active ? round(convictionRelaxPoints, 4) : 0,
    convictionThresholdMultiplier: 1,
    convictionThresholdDelta: active ? -round(convictionRelaxPoints, 4) : 0,
    resetAfterNewTrade: true,
    neverBypassesRisk: true,
    neverBypassesFees: true,
    reason: active
      ? `no trade opened for ${round(inactiveHours, 2)}h; conviction threshold relaxed by ${round(convictionRelaxPoints, 2)} points`
      : "recent trade activity keeps inactivity recovery reset",
  };
}

function tradeClusterRisk(trades = [], signal = {}, config = {}, now = Date.now()) {
  const windowMs = Math.max(1, numeric(config.tradeClusterWindowMinutes, 45)) * 60 * 1000;
  const key = setupRegimeMatrixKey(signal);
  const recent = (Array.isArray(trades) ? trades : []).filter((trade) => {
    if (["ENTRY_FAILED", "FAILED", "REJECTED"].includes(String(trade.status || "").toUpperCase())) return false;
    if (String(trade.symbol || "").toUpperCase() !== String(signal.symbol || "").toUpperCase()) return false;
    if (String(trade.side || "").toUpperCase() !== String(signal.side || "").toUpperCase()) return false;
    if (setupRegimeMatrixKey(trade) !== key) return false;
    const openedAt = Date.parse(trade.openedAt || trade.entryTime || trade.createdAt || "");
    return Number.isFinite(openedAt) && now - openedAt >= 0 && now - openedAt <= windowMs;
  });
  const recentLosses = recent.filter((trade) => tradeNetPnl(trade) < 0).length;
  const score = clamp(recent.length * 18 + recentLosses * 12, 0, 100);
  const maxReduction = clamp(numeric(config.tradeClusterMaxSizeReductionPct, 20), 0, 40) / 100;
  const sizeMultiplier = round(1 - maxReduction * (score / 100), 4);
  return {
    key,
    windowMinutes: numeric(config.tradeClusterWindowMinutes, 45),
    matchingTrades: recent.length,
    recentLosses,
    clusterRiskScore: round(score, 2),
    sizeMultiplier,
    action: score >= 60 ? "REDUCE_SIZE_MODESTLY" : score >= 30 ? "WATCH_CLUSTER" : "NORMAL",
    neverBlocksTrading: true,
  };
}

function clusterRiskReport(trades = [], config = {}) {
  const rows = closedTrades(trades).filter((trade) => numeric(trade.clusterRiskScore) > 0 || trade.clusterRisk);
  const scores = rows.map((trade) => numeric(trade.clusterRiskScore, trade.clusterRisk && trade.clusterRisk.clusterRiskScore)).filter((score) => score > 0);
  const byKey = rankByNetPnl(groupRows(rows, (trade) => (trade.clusterRisk && trade.clusterRisk.key) || setupRegimeMatrixKey(trade)));
  return {
    trackedTrades: rows.length,
    averageClusterRiskScore: scores.length ? round(scores.reduce((total, score) => total + score, 0) / scores.length, 4) : 0,
    maxClusterRiskScore: scores.length ? round(Math.max(...scores), 4) : 0,
    sizeReducedTrades: rows.filter((trade) => numeric(trade.clusterRiskSizeMultiplier, 1) < 1).length,
    worstCluster: byKey.length ? byKey[byKey.length - 1] : null,
    bestCluster: byKey[0] || null,
    neverBlocksTrading: true,
  };
}

function metricTrend(recent, previous) {
  const recentValue = numeric(recent);
  const previousValue = numeric(previous);
  return {
    recent: round(recentValue, 6),
    previous: round(previousValue, 6),
    change: round(recentValue - previousValue, 6),
    direction: recentValue > previousValue ? "UP" : recentValue < previousValue ? "DOWN" : "FLAT",
  };
}

function portfolioAlphaReport(trades = []) {
  const rows = closedTrades(trades).filter((trade) => numeric(trade.portfolioAlphaScore) > 0);
  const scores = rows.map((trade) => numeric(trade.portfolioAlphaScore)).filter((score) => score > 0);
  const aligned = rows.filter((trade) => numeric(trade.portfolioAlphaAlignedCount) >= 3);
  const mixed = rows.filter((trade) => numeric(trade.portfolioAlphaConflictCount) > 0);
  return {
    trackedTrades: rows.length,
    averagePortfolioAlphaScore: scores.length ? round(scores.reduce((total, score) => total + score, 0) / scores.length, 4) : 0,
    alignedTrades: aligned.length,
    mixedSignalTrades: mixed.length,
    alignedPerformance: performanceForRows(aligned),
    mixedSignalPerformance: performanceForRows(mixed),
  };
}

function weakSolBreakout(signal = {}) {
  const symbol = String(signal.symbol || "").toUpperCase();
  if (symbol !== "SOLUSDT") return false;
  const family = setupFamily(signal.continuationSetupType || signal.setupType || signal.tradeCategory);
  const regime = compactRegime(regimeKey(signal));
  return (
    family === "BREAKOUT" &&
    regime !== "TRENDING" &&
    numeric(signal.continuationStrength) < 72 &&
    numeric(signal.multiTimeframeTrendScore) < 78
  );
}

function trendDominanceSignal(config = {}, signal = {}, context = {}) {
  const symbol = String(signal.symbol || "").toUpperCase();
  const ethBtcFocus = ["BTCUSDT", "ETHUSDT"].includes(symbol);
  const setupRegime = context.setupRegimeMatrixMemory || signal.setupRegimeMatrixMemory || { weight: 1, bias: "NEUTRAL" };
  const activityRecovery = context.activityRecovery || signal.adaptiveActivityRecovery || { active: false, feeDragOk: true, expectancyOk: true };
  const solWeakBreakout = weakSolBreakout(signal);
  const symbolWeightMultiplier = symbol === "ETHUSDT"
    ? numeric(config.trendDominanceEthWeightMultiplier, 1.4)
    : symbol === "BTCUSDT"
      ? numeric(config.trendDominanceBtcWeightMultiplier, 1.25)
      : solWeakBreakout
        ? numeric(config.trendDominanceSolWeakBreakoutMultiplier, 0.82)
        : 1;
  const baseScore =
    numeric(signal.multiTimeframeTrendScore) * 0.28 +
    numeric(signal.trendQualityScore) * 0.23 +
    numeric(signal.continuationStrength) * 0.22 +
    numeric(signal.portfolioAlphaScore) * 0.17 +
    regimeQualityScore(signal) * 0.1;
  const matrixBoost = (numeric(setupRegime.weight, 1) - 1) * 16;
  const focusBoost = ethBtcFocus ? numeric(config.trendDominanceEthBtcFocusBoost, 4) : 0;
  const solWeakBreakoutPenalty = solWeakBreakout ? numeric(config.trendDominanceSolWeakBreakoutPenalty, 4) : 0;
  const score = round(clamp(baseScore * symbolWeightMultiplier + matrixBoost + focusBoost - solWeakBreakoutPenalty, 0, 100), 2);
  const strong = score >= numeric(config.trendDominanceStrongScore, 82);
  const elite = score >= numeric(config.trendDominanceEliteScore, 92) || String(signal.profitQualityTier || "").toUpperCase() === "ELITE";
  const activityEligible =
    Boolean(config.trendDominanceMode) &&
    strong &&
    (activityRecovery.active || elite) &&
    activityRecovery.feeDragOk !== false &&
    activityRecovery.expectancyOk !== false;
  const activityBoostPct = activityEligible ? numeric(config.trendDominanceActivityBoostPct, 4) : 0;
  const sizingMultiplier = elite
    ? numeric(config.trendDominanceEliteSizingMultiplier, 1.18)
    : strong
      ? numeric(config.trendDominanceStrongSizingMultiplier, 1.12)
      : 1;
  return {
    score,
    tier: elite ? "ELITE_TREND_DOMINANCE" : strong ? "STRONG_TREND_DOMINANCE" : "NO_DOMINANCE",
    ethBtcFocus,
    symbolWeightMultiplier: round(symbolWeightMultiplier, 4),
    solWeakBreakout,
    matrixBias: setupRegime.bias || "NEUTRAL",
    activityEligible,
    thresholdMultiplier: activityEligible ? round(1 - activityBoostPct / 100, 4) : 1,
    scoreBoost: round((strong ? numeric(config.trendDominanceScoreBoost, 3) + focusBoost * 0.35 : 0) - solWeakBreakoutPenalty, 4),
    sizingMultiplier,
    runnerExtensionMultiplier: strong ? numeric(config.trendDominanceRunnerExtensionBoost, 1.12) : 1,
    activityBoostPct,
    targetActivityIncreasePct: activityEligible ? "30-50" : "0",
    neverBypassesRisk: true,
    neverBypassesFees: true,
  };
}

function trendDominanceReport(trades = []) {
  const rows = closedTrades(trades).filter((trade) => numeric(trade.trendDominanceScore) > 0);
  const dominant = rows.filter((trade) => numeric(trade.trendDominanceScore) >= 82);
  const ethBtc = rows.filter((trade) => ["BTCUSDT", "ETHUSDT"].includes(String(trade.symbol || "").toUpperCase()));
  return {
    trackedTrades: rows.length,
    dominantTrades: dominant.length,
    ethBtcTrackedTrades: ethBtc.length,
    dominantPerformance: performanceForRows(dominant),
    ethBtcPerformance: performanceForRows(ethBtc),
  };
}

function asymmetricRunnerAllocation(config = {}, signal = {}) {
  const trendScore = Math.max(
    numeric(signal.trendDominanceScore),
    numeric(signal.multiTimeframeTrendScore),
    numeric(signal.trendQualityScore),
    numeric(signal.continuationStrength),
    numeric(signal.portfolioAlphaScore)
  );
  const tier = String(signal.profitQualityTier || (signal.eliteSetup ? "ELITE" : "")).toUpperCase();
  if (tier === "ELITE" || trendScore >= numeric(config.asymmetricRunnerEliteTrendScore, 92)) {
    return {
      trendTier: "ELITE_TREND",
      tp1PartialPct: numeric(config.asymmetricRunnerEliteTp1Pct, 10),
      runnerPct: 100 - numeric(config.asymmetricRunnerEliteTp1Pct, 10),
      trendScore: round(trendScore, 2),
    };
  }
  if (tier === "STRONG" || trendScore >= numeric(config.asymmetricRunnerStrongTrendScore, 82)) {
    return {
      trendTier: "STRONG_TREND",
      tp1PartialPct: numeric(config.asymmetricRunnerStrongTp1Pct, 20),
      runnerPct: 100 - numeric(config.asymmetricRunnerStrongTp1Pct, 20),
      trendScore: round(trendScore, 2),
    };
  }
  return {
    trendTier: "WEAK_TREND",
    tp1PartialPct: numeric(config.asymmetricRunnerWeakTp1Pct, 50),
    runnerPct: 100 - numeric(config.asymmetricRunnerWeakTp1Pct, 50),
    trendScore: round(trendScore, 2),
  };
}

function qualityScoreForSignal(config = {}, signal = {}, edgeModel = {}, symbolMemory = null, optimizer = null, edgeMemory = {}) {
  const trend = clamp(
    Math.max(
      numeric(signal.trendQualityScore),
      numeric(signal.continuationStrength),
      numeric(signal.convictionScore) * 0.9,
      Math.abs(numeric(signal.momentum5mPct)) * 18
    ),
    0,
    100
  );
  const volume = volumeQualityScore(signal);
  const spread = spreadQualityScore(config, signal);
  const expectancy = expectancyQualityScore(config, signal, edgeModel);
  const regime = regimeQualityScore(signal);
  const memory = symbolMemory || { weight: 1, rolling50: { samples: 0 }, rolling100: { samples: 0 } };
  const memoryScore = clamp(58 + (numeric(memory.weight, 1) - 1) * 145, 35, 84);
  const setupMemory = edgeMemory.setupMemory || { weight: 1, bias: "NEUTRAL" };
  const regimeMemory = edgeMemory.regimeMemory || { weight: 1, bias: "NEUTRAL" };
  const matrixMemory = edgeMemory.setupRegimeMatrixMemory || { weight: 1, bias: "NEUTRAL" };
  const autoTuning = edgeMemory.autoTuning || { thresholdMultiplier: 1, adjustmentPct: 0, bias: "NEUTRAL" };
  const activityRecovery = edgeMemory.activityRecovery || { thresholdMultiplier: 1, scoreBoost: 0, active: false };
  const inactivityRecovery = edgeMemory.inactivityRecovery || {
    active: false,
    convictionThresholdMultiplier: 1,
    convictionThresholdDelta: 0,
    convictionRelaxPct: 0,
    convictionRelaxPoints: 0,
  };
  const trendDominance = edgeMemory.trendDominance || { thresholdMultiplier: 1, scoreBoost: 0, sizingMultiplier: 1 };
  const clusterRisk = edgeMemory.clusterRisk || { clusterRiskScore: 0 };
  let score =
    trend * 0.25 +
    volume * 0.17 +
    spread * 0.13 +
    expectancy * 0.28 +
    regime * 0.12 +
    memoryScore * 0.05;
  score += (numeric(setupMemory.weight, 1) - 1) * 18;
  score += (numeric(regimeMemory.weight, 1) - 1) * 12;
  score += (numeric(matrixMemory.weight, 1) - 1) * 22;
  if (numeric(signal.marketBreadthScore) >= 80) score += 3;
  else if (numeric(signal.marketBreadthScore) > 0 && numeric(signal.marketBreadthScore) < 45) score -= 3;
  if (numeric(signal.portfolioAlphaScore) >= 82) score += 4;
  else if (numeric(signal.portfolioAlphaScore) > 0 && numeric(signal.portfolioAlphaScore) < 45) score -= 4;
  score += numeric(activityRecovery.scoreBoost);
  score += numeric(trendDominance.scoreBoost);
  if (numeric(clusterRisk.clusterRiskScore) >= 60) score -= 3;
  const tags = Array.isArray(signal.marketRegimeTags) ? signal.marketRegimeTags : [];
  if (tags.includes("STRONG_TRENDING_MARKET") && /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/i.test(String(signal.continuationSetupType || signal.setupType || ""))) {
    score += 4;
  }
  if (numeric(signal.multiTimeframeTrendScore) >= numeric(config.mtfStrongAlignmentScore, 82)) {
    score += 3;
  } else if (numeric(signal.multiTimeframeTrendScore) < 35) {
    score -= 4;
  }
  if (optimizer && optimizer.continuationOutperforming && /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/i.test(String(signal.continuationSetupType || signal.setupType || ""))) {
    score += numeric(optimizer.continuationWeightBoostPoints, 0);
  }
  if (tags.includes("SIDEWAYS_CHOP_MARKET") || tags.includes("FAKE_BREAKOUT_ENVIRONMENT")) {
    score -= 5;
  }
  score = round(clamp(score, 0, 100), 2);
  const thresholdTightening = optimizer && optimizer.feeDragTighteningActive ? numeric(config.expectancyEntryTighteningPoints, 2) : 0;
  const autoTuneMultiplier = clamp(numeric(autoTuning.thresholdMultiplier, 1), 0.95, 1.05);
  const activityRecoveryMultiplier = clamp(numeric(activityRecovery.thresholdMultiplier, 1), 0.95, 1);
  const trendDominanceMultiplier = clamp(numeric(trendDominance.thresholdMultiplier, 1), 0.94, 1);
  const normalThreshold = round(numeric(config.profitModeMinQualityScore, 70) * autoTuneMultiplier * activityRecoveryMultiplier * trendDominanceMultiplier + thresholdTightening, 2);
  const strongThreshold = round(numeric(config.profitModeStrongQualityScore, 85) * autoTuneMultiplier * activityRecoveryMultiplier * trendDominanceMultiplier + Math.ceil(thresholdTightening / 2), 2);
  const eliteThreshold = numeric(config.profitModeEliteQualityScore, 95);
  const tier = score >= eliteThreshold ? "ELITE" : score >= strongThreshold ? "STRONG" : score >= normalThreshold ? "NORMAL" : "REJECT";
  const chopRequiresStrong =
    (tags.includes("SIDEWAYS_CHOP_MARKET") || tags.includes("FAKE_BREAKOUT_ENVIRONMENT")) &&
    !signal.meanReversionActive &&
    !["STRONG", "ELITE"].includes(tier);
  return {
    score,
    tier: chopRequiresStrong ? "REJECT" : tier,
    rawTier: tier,
    rejected: tier === "REJECT" || chopRequiresStrong,
    reason: tier === "REJECT"
      ? `quality score ${score} below profit-mode minimum ${normalThreshold}`
      : chopRequiresStrong
        ? "sideways chop requires strong or elite quality score"
        : "profit-mode quality score approved",
    components: {
      trend: round(trend, 2),
      volume: round(volume, 2),
      spread: round(spread, 2),
      expectancy: round(expectancy, 2),
      regime: round(regime, 2),
      symbolMemory: round(memoryScore, 2),
      symbolMemoryWeight: numeric(memory.weight, 1),
      setupRankingWeight: numeric(setupMemory.weight, 1),
      regimeMemoryWeight: numeric(regimeMemory.weight, 1),
      setupRegimeMatrixWeight: numeric(matrixMemory.weight, 1),
      marketBreadth: round(numeric(signal.marketBreadthScore), 2),
      portfolioAlpha: round(numeric(signal.portfolioAlphaScore), 2),
      clusterRisk: round(numeric(clusterRisk.clusterRiskScore), 2),
      trendDominance: round(numeric(trendDominance.score), 2),
      multiTimeframeTrend: round(numeric(signal.multiTimeframeTrendScore), 2),
      expectancyOptimizer: optimizer && optimizer.continuationOutperforming ? round(numeric(optimizer.continuationWeightBoostPoints), 2) : 0,
      expectancyAutoTuningPct: numeric(autoTuning.adjustmentPct),
      adaptiveActivityRecovery: activityRecovery.active ? round(numeric(activityRecovery.scoreBoost), 2) : 0,
      inactivityRecoveryConvictionRelaxPct: inactivityRecovery.active ? round(numeric(inactivityRecovery.convictionRelaxPct), 2) : 0,
      inactivityRecoveryConvictionRelaxPoints: inactivityRecovery.active ? round(numeric(inactivityRecovery.convictionRelaxPoints), 2) : 0,
    },
    thresholds: {
      rejectBelow: normalThreshold,
      normal: normalThreshold,
      strong: strongThreshold,
      elite: eliteThreshold,
    },
    symbolMemory: memory,
    setupMemory,
    regimeMemory,
    setupRegimeMatrixMemory: matrixMemory,
    expectancyAutoTuning: autoTuning,
    adaptiveActivityRecovery: activityRecovery,
    dynamicInactivityRecovery: inactivityRecovery,
    trendDominance,
    clusterRisk,
    expectancyOptimizer: optimizer,
  };
}

function profitExpectancyReport(trades = [], config = {}) {
  const rows = closedTrades(trades);
  const winners = rows.filter((trade) => tradeNetPnl(trade) > 0);
  const losers = rows.filter((trade) => tradeNetPnl(trade) < 0);
  const summary = summarizeTrades(rows);
  const totalFees = rows.reduce((total, trade) => total + tradeFees(trade), 0);
  const grossProfit = rows.reduce((total, trade) => total + Math.max(0, tradeGrossPnl(trade)), 0);
  const runnerImpact = rows.reduce((total, trade) => total + numeric(trade.runnerNetContributionUsdt), 0);
  const symbolMemory = symbolPerformanceMemoryV3Map(rows);
  const optimizer = expectancyOptimizer(rows, config);
  const symbolRanking = Object.values(symbolMemory).sort((left, right) => {
    if (right.rolling100.netPnlUsdt !== left.rolling100.netPnlUsdt) return right.rolling100.netPnlUsdt - left.rolling100.netPnlUsdt;
    return right.weight - left.weight;
  });
  return {
    generatedAt: new Date().toISOString(),
    closedTrades: rows.length,
    expectancyUsdt: summary.expectancyUsdt,
    averageWinnerUsdt: winners.length ? round(winners.reduce((total, trade) => total + tradeNetPnl(trade), 0) / winners.length) : 0,
    averageLoserUsdt: losers.length ? round(losers.reduce((total, trade) => total + tradeNetPnl(trade), 0) / losers.length) : 0,
    profitFactor: summary.profitFactor,
    feeImpact: {
      totalFeesUsdt: round(totalFees),
      feeToGrossProfitRatio: grossProfit > 0 ? round(totalFees / grossProfit, 4) : totalFees > 0 ? 999 : 0,
      grossPositiveButNetNegativeTrades: summary.grossPositiveButNetNegativeTrades,
    },
    runnerImpact: {
      runnerContributionUsdt: round(runnerImpact),
      runnerTrades: rows.filter((trade) => trade.runnerPartialTaken).length,
      averageRunnerContributionUsdt: rows.length ? round(runnerImpact / rows.length) : 0,
    },
    optimizer,
    symbolRanking,
  };
}

function rankByNetPnl(grouped) {
  return Object.entries(grouped)
    .map(([key, rows]) => ({ key, ...performanceForRows(rows) }))
    .sort((left, right) => right.netPnlUsdt - left.netPnlUsdt);
}

function groupRows(rows, selector) {
  return rows.reduce((groups, row) => {
    const key = selector(row) || "UNKNOWN";
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
    return groups;
  }, {});
}

function profitSystemHealthReport(trades = [], config = {}) {
  const rows = closedTrades(trades);
  const expectancy = profitExpectancyReport(rows, config);
  const bySymbol = rankByNetPnl(groupRows(rows, (trade) => trade.symbol));
  const bySetup = rankByNetPnl(groupRows(rows, (trade) => trade.continuationSetupType || trade.setupType || trade.tradeCategory));
  return {
    generatedAt: new Date().toISOString(),
    closedTrades: rows.length,
    expectancy: expectancy.expectancyUsdt,
    profitFactor: expectancy.profitFactor,
    feeDragRatio: expectancy.feeImpact.feeToGrossProfitRatio,
    bestSymbol: bySymbol[0] || null,
    worstSymbol: bySymbol.length ? bySymbol[bySymbol.length - 1] : null,
    bestSetup: bySetup[0] || null,
    worstSetup: bySetup.length ? bySetup[bySetup.length - 1] : null,
    runnerContribution: expectancy.runnerImpact,
    optimizer: expectancy.optimizer,
    symbolPerformanceMemoryV3: expectancy.symbolRanking,
  };
}

function profitEdgeReport(trades = [], config = {}) {
  const rows = closedTrades(trades);
  const expectancy = profitExpectancyReport(rows, config);
  const setupRanking = setupRankingReport(rows, config);
  const regimeRanking = regimePerformanceReport(rows, config);
  const setupRegimeMatrix = setupRegimeMatrixReport(rows, config);
  const autoTuning = expectancyAutoTuning(rows, config);
  const activityRecovery = adaptiveActivityRecovery(rows, config);
  const recent100 = performanceForRows(rows.slice(-100));
  const previous100 = performanceForRows(rows.slice(-200, -100));
  return {
    generatedAt: new Date().toISOString(),
    closedTrades: rows.length,
    bestSetup: setupRanking[0] || null,
    worstSetup: setupRanking.length ? setupRanking[setupRanking.length - 1] : null,
    bestSetupRegime: setupRegimeMatrix[0] || null,
    worstSetupRegime: setupRegimeMatrix.length ? setupRegimeMatrix[setupRegimeMatrix.length - 1] : null,
    bestRegime: regimeRanking[0] || null,
    worstRegime: regimeRanking.length ? regimeRanking[regimeRanking.length - 1] : null,
    runnerContribution: expectancy.runnerImpact,
    runnerWinRatePct: recent100.runnerWinRatePct,
    averageRunnerProfitUsdt: recent100.averageRunnerProfitUsdt,
    profitFactor: expectancy.profitFactor,
    expectancy: expectancy.expectancyUsdt,
    averageWinner: expectancy.averageWinnerUsdt,
    averageLoser: expectancy.averageLoserUsdt,
    clusterRiskStatistics: clusterRiskReport(rows, config),
    portfolioAlphaStatistics: portfolioAlphaReport(rows),
    trendDominanceStatistics: trendDominanceReport(rows),
    expectancyTrend: metricTrend(recent100.expectancyUsdt, previous100.expectancyUsdt),
    profitFactorTrend: metricTrend(recent100.profitFactor, previous100.profitFactor),
    expectancyAutoTuning: autoTuning,
    adaptiveActivityRecovery: activityRecovery,
    setupRanking,
    setupRegimeMatrix,
    regimeRanking,
    symbolRanking: expectancy.symbolRanking,
  };
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
  adaptiveActivityRecovery,
  asymmetricRunnerAllocation,
  clusterRiskReport,
  dynamicInactivityRecovery,
  ensureProfitControlledState,
  expectancyAutoTuning,
  expectancyOptimizer,
  leverageCapForTier,
  portfolioAlphaReport,
  profitEdgeReport,
  profitExpectancyReport,
  qualityScoreForSignal,
  profitControlledRiskCapPct,
  profitControlledRiskState,
  profitControlledSummary,
  profitSystemHealthReport,
  regimePerformanceMemory,
  regimePerformanceReport,
  sizingEquityBaseFromBalance,
  setupRegimeMatrixMemory,
  setupRegimeMatrixReport,
  setupRankingMemory,
  setupRankingReport,
  symbolPerformanceMemoryV2,
  symbolPerformanceMemoryV2Map,
  symbolPerformanceMemoryV3,
  symbolPerformanceMemoryV3Map,
  tradeClusterRisk,
  trendDominanceReport,
  trendDominanceSignal,
};
