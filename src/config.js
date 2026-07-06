"use strict";

require("dotenv").config();

const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const FOCUSED_TRADING_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
const DEMO_REST_BASE_URL = "https://api-demo.bybit.com";
const DEMO_PRIVATE_WS_BASE_URL = "wss://stream-demo.bybit.com";
const MAINNET_PUBLIC_WS_BASE_URL = "wss://stream.bybit.com";
const MAINNET_REST_BASE_URL = "https://api.bybit.com";
const LIVE_VALIDATION_ACK_MESSAGE = "LIVE VALIDATION NOT STARTED — REAL-MONEY ACKNOWLEDGEMENT REQUIRED";
const PROFIT_CONTROLLED_ACK_MESSAGE = "PROFIT-CONTROLLED LIVE NOT STARTED — REAL-MONEY ACKNOWLEDGEMENT REQUIRED";

function booleanValue(name, fallback) {
  const raw = String(process.env[name] ?? fallback).trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false"; received "${raw}".`);
}

function numberValue(name, fallback, options = {}) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || (options.positive && value <= 0) || (options.minimum !== undefined && value < options.minimum)) {
    throw new Error(`${name} has an invalid value: "${raw}".`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer; received "${raw}".`);
  }
  if (options.maximum !== undefined && value > options.maximum) {
    throw new Error(`${name} cannot be greater than ${options.maximum}; received "${raw}".`);
  }
  return value;
}

function symbolsSet(name) {
  return new Set(
    String(process.env[name] || "")
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean)
  );
}

function enumValue(name, fallback, accepted) {
  const value = String(process.env[name] || fallback).trim().toUpperCase();
  if (!accepted.includes(value)) {
    throw new Error(`${name} must be one of ${accepted.join(", ")}; received "${value}".`);
  }
  return value;
}

function normalizedUrl(value) {
  return String(value).replace(/\/$/, "");
}

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch (_error) {
    return "";
  }
}

function loadConfig() {
  const bybitTestnet = booleanValue("BYBIT_TESTNET", true);
  const bybitDemoTrading = booleanValue("BYBIT_DEMO_TRADING", false);
  const liveValidationMode = booleanValue("LIVE_VALIDATION_MODE", false);
  const profitControlledEquityMode = booleanValue("PROFIT_CONTROLLED_EQUITY_MODE", false);
  const paperTradingMode = booleanValue("PAPER_TRADING_MODE", false);
  const activeAdaptiveScalperMode = booleanValue("ACTIVE_ADAPTIVE_SCALPER_MODE", paperTradingMode ? true : false);
  const swingMomentumMode = booleanValue("SWING_MOMENTUM_MODE", false);
  const trendPortfolioMode = booleanValue("TREND_PORTFOLIO_MODE", false);
  const exchangeEnvironment = profitControlledEquityMode
    ? "PROFIT_CONTROLLED_LIVE"
    : liveValidationMode
      ? "LIVE_VALIDATION"
      : bybitDemoTrading
        ? "DEMO"
        : paperTradingMode || activeAdaptiveScalperMode
          ? "PAPER"
          : bybitTestnet
            ? "TESTNET"
            : "MAINNET";
  const dataDir = path.join(
    PROJECT_ROOT,
    "data",
    trendPortfolioMode ? "trend-portfolio" : profitControlledEquityMode ? "profit-controlled-live" : liveValidationMode ? "live-validation" : bybitDemoTrading ? "demo" : (paperTradingMode || activeAdaptiveScalperMode) ? "paper-trading" : ""
  );
  const defaultRestBaseUrl = bybitDemoTrading
    ? DEMO_REST_BASE_URL
    : bybitTestnet
      ? "https://api-testnet.bybit.com"
      : MAINNET_REST_BASE_URL;
  const defaultWsBaseUrl = bybitTestnet ? "wss://stream-testnet.bybit.com" : MAINNET_PUBLIC_WS_BASE_URL;
  const defaultPublicWsBaseUrl = bybitDemoTrading ? MAINNET_PUBLIC_WS_BASE_URL : defaultWsBaseUrl;
  const defaultPrivateWsBaseUrl = bybitDemoTrading ? DEMO_PRIVATE_WS_BASE_URL : defaultWsBaseUrl;
  const restBaseUrl = normalizedUrl(process.env.BYBIT_REST_BASE_URL || defaultRestBaseUrl);
  const publicWsBaseUrl = normalizedUrl(
    process.env.BYBIT_PUBLIC_WS_BASE_URL || (!bybitDemoTrading ? process.env.BYBIT_WS_BASE_URL : "") || defaultPublicWsBaseUrl
  );
  const privateWsBaseUrl = normalizedUrl(
    process.env.BYBIT_PRIVATE_WS_BASE_URL || process.env.BYBIT_WS_BASE_URL || defaultPrivateWsBaseUrl
  );
  const config = {
    projectRoot: PROJECT_ROOT,
    dataDir,
    stateFile: path.join(dataDir, "state.json"),
    tradesFile: path.join(dataDir, "trades.json"),
    tradeMemoryFile: path.join(dataDir, "tradeMemory.json"),
    analyticsFile: path.join(dataDir, "analytics.json"),
    executionLedgerFile: path.join(dataDir, "executionLedger.json"),
    reportsDir: path.join(dataDir, "reports"),
    logFile: path.join(dataDir, "bybit-bot.log"),
    logRotationEnabled: booleanValue("LOG_ROTATION_ENABLED", true),
    logMaxBytes: numberValue("LOG_MAX_BYTES", 5_000_000, { positive: true, integer: true }),
    logArchiveCount: numberValue("LOG_ARCHIVE_COUNT", 5, { positive: true, integer: true, maximum: 50 }),
    emergencyStopFile: path.join(PROJECT_ROOT, path.basename(process.env.EMERGENCY_STOP_FILE || "STOP_BOT.txt")),
    apiKey: process.env.BYBIT_API_KEY || "",
    apiSecret: process.env.BYBIT_API_SECRET || "",
    bybitTestnet,
    bybitDemoTrading,
    liveValidationMode,
    profitControlledEquityMode,
    paperTradingMode,
    activeAdaptiveScalperMode,
    swingMomentumMode,
    trendPortfolioMode,
    exchangeEnvironment,
    restBaseUrl,
    publicWsBaseUrl,
    privateWsBaseUrl,
    wsBaseUrl: privateWsBaseUrl,
    recvWindowMs: numberValue("BYBIT_RECV_WINDOW_MS", 5000, { positive: true, integer: true }),
    category: "linear",
    settleCoin: "USDT",
    bybitPositionMode: enumValue("BYBIT_POSITION_MODE", "ONE_WAY", ["ONE_WAY", "HEDGE"]),
    ensurePositionMode: booleanValue("BYBIT_ENSURE_POSITION_MODE", false),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    dryRun: booleanValue("DRY_RUN", true),
    accountStartUsdt: numberValue("ACCOUNT_START_USDT", 100, { positive: true }),
    x10Mode: booleanValue("X10_MODE", true),
    learningPhaseMode: booleanValue("LEARNING_PHASE_MODE", true),
    aggressiveLearningPhase: booleanValue("AGGRESSIVE_LEARNING_PHASE", true),
    highActivityMode: booleanValue("HIGH_ACTIVITY_MODE", true),
    continuousExecutionMode: booleanValue("CONTINUOUS_EXECUTION_MODE", true),
    disableDailyTradeLimits: booleanValue("DISABLE_DAILY_TRADE_LIMITS", true),
    forcedMarketSamplingEnabled: booleanValue("FORCED_MARKET_SAMPLING_ENABLED", true),
    forcedMarketSamplingAfterMinutes: numberValue("FORCED_MARKET_SAMPLING_AFTER_MINUTES", 4, { positive: true }),
    forcedSamplingMaxCandidates: numberValue("FORCED_SAMPLING_MAX_CANDIDATES", 3, { positive: true, integer: true, maximum: 10 }),
    forcedSamplingMinScore: numberValue("FORCED_SAMPLING_MIN_SCORE", 26, { positive: true, maximum: 100 }),
    forcedSamplingMinConviction: numberValue("FORCED_SAMPLING_MIN_CONVICTION", 32, { positive: true, maximum: 100 }),
    forcedSamplingMinProjectedEdgePct: numberValue("FORCED_SAMPLING_MIN_PROJECTED_EDGE_PCT", 0.1, { minimum: 0 }),
    forcedSamplingMinEdgeToCostRatio: numberValue("FORCED_SAMPLING_MIN_EDGE_TO_COST_RATIO", 1.15, { positive: true }),
    fastMode: booleanValue("FAST_MODE", true),
    fomoBreakoutMode: booleanValue("FOMO_BREAKOUT_MODE", true),
    microBreakoutEntries: booleanValue("MICRO_BREAKOUT_ENTRIES", true),
    allowChoppyMarket: booleanValue("ALLOW_CHOPPY_MARKET", true),
    allowPartialScanEntries: booleanValue("ALLOW_PARTIAL_SCAN_ENTRIES", true),
    maxOpenPositions: numberValue("MAX_OPEN_POSITIONS", 3, { positive: true, integer: true, maximum: 10 }),
    maxPositionsPerSymbol: numberValue("MAX_POSITIONS_PER_SYMBOL", 3, { positive: true, integer: true, maximum: 10 }),
    maxDeployableCapitalUsdt: numberValue("MAX_DEPLOYABLE_CAPITAL_USDT", 0, { minimum: 0 }),
    maxTradesPerDay: numberValue("MAX_TRADES_PER_DAY", 40, { positive: true, integer: true }),
    baseRiskPerTradePct: numberValue("BASE_RISK_PER_TRADE_PCT", 4, { positive: true }),
    aggressiveRiskPerTradePct: numberValue("AGGRESSIVE_RISK_PER_TRADE_PCT", 8, { positive: true }),
    aggressiveScoreThreshold: numberValue("AGGRESSIVE_SCORE_THRESHOLD", 72, { positive: true, maximum: 100 }),
    maxLeverage: numberValue("MAX_LEVERAGE", 8, { positive: true, maximum: 15 }),
    setLeverageOnEntry: booleanValue("SET_LEVERAGE_ON_ENTRY", true),
    acknowledgeHighLeverageRisk: booleanValue("ACKNOWLEDGE_HIGH_LEVERAGE_RISK", false),
    acknowledgeLiveTrading: booleanValue("ACKNOWLEDGE_LIVE_TRADING", false),
    acknowledgeDemoTrading: booleanValue("ACKNOWLEDGE_DEMO_TRADING", false),
    acknowledgeLiveValidationRisk: booleanValue("ACKNOWLEDGE_LIVE_VALIDATION_RISK", false),
    acknowledgeProfitControlledLiveRisk: booleanValue("ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK", false),
    liveValidationMaxAllocatedEquityUsdt: numberValue("LIVE_VALIDATION_MAX_ALLOCATED_EQUITY_USDT", 10, { positive: true }),
    liveValidationPromotionEnabled: booleanValue("LIVE_VALIDATION_PROMOTION_ENABLED", false),
    liveValidationProtectionDrawdownPct: numberValue("LIVE_VALIDATION_PROTECTION_DRAWDOWN_PCT", 15, { positive: true, maximum: 100 }),
    liveValidationReducedRiskMultiplier: numberValue("LIVE_VALIDATION_REDUCED_RISK_MULTIPLIER", 0.6, { positive: true, maximum: 1 }),
    liveValidationMaxFeeToGrossProfitRatio: numberValue("LIVE_VALIDATION_MAX_FEE_TO_GROSS_PROFIT_RATIO", 0.65, { positive: true }),
    liveValidationReducedFeeDragRatio: numberValue("LIVE_VALIDATION_REDUCED_FEE_DRAG_RATIO", 0.8, { positive: true }),
    liveValidationMaxPromotionDrawdownPct: numberValue("LIVE_VALIDATION_MAX_PROMOTION_DRAWDOWN_PCT", 15, { positive: true, maximum: 100 }),
    liveValidationExplorationRiskAtStopMaxPct: numberValue("LIVE_VALIDATION_EXPLORATION_RISK_AT_STOP_MAX_PCT", 0.2, { positive: true, maximum: 5 }),
    liveValidationNormalRiskAtStopMaxPct: numberValue("LIVE_VALIDATION_NORMAL_RISK_AT_STOP_MAX_PCT", 0.35, { positive: true, maximum: 5 }),
    liveValidationStrongRiskAtStopMaxPct: numberValue("LIVE_VALIDATION_STRONG_RISK_AT_STOP_MAX_PCT", 0.5, { positive: true, maximum: 5 }),
    liveValidationEliteRiskAtStopMaxPct: numberValue("LIVE_VALIDATION_ELITE_RISK_AT_STOP_MAX_PCT", 0.75, { positive: true, maximum: 5 }),
    profitControlledUseExchangeEquity: booleanValue("PROFIT_CONTROLLED_USE_EXCHANGE_EQUITY", true),
    maxTotalOpenStopRiskPct: numberValue("MAX_TOTAL_OPEN_STOP_RISK_PCT", 2.25, { positive: true, maximum: 10 }),
    maxCorrelatedClusterStopRiskPct: numberValue("MAX_CORRELATED_CLUSTER_STOP_RISK_PCT", 1.75, { positive: true, maximum: 10 }),
    profitControlledExplorationMaxStopRiskPct: numberValue("EXPLORATION_MAX_STOP_RISK_PCT", 0.25, { positive: true, maximum: 5 }),
    profitControlledNormalMaxStopRiskPct: numberValue("NORMAL_MAX_STOP_RISK_PCT", 0.45, { positive: true, maximum: 5 }),
    profitControlledStrongMaxStopRiskPct: numberValue("STRONG_MAX_STOP_RISK_PCT", 0.85, { positive: true, maximum: 5 }),
    profitControlledEliteMaxStopRiskPct: numberValue("ELITE_MAX_STOP_RISK_PCT", 1.25, { positive: true, maximum: 5 }),
    profitControlledMaxLeverage: numberValue("PROFIT_CONTROLLED_MAX_LEVERAGE", 5, { positive: true, maximum: 5 }),
    profitControlledExplorationMaxLeverage: numberValue("PROFIT_CONTROLLED_EXPLORATION_MAX_LEVERAGE", 3, { positive: true, maximum: 5 }),
    profitControlledNormalMaxLeverage: numberValue("PROFIT_CONTROLLED_NORMAL_MAX_LEVERAGE", 4, { positive: true, maximum: 5 }),
    profitControlledReducedDrawdownPct: numberValue("PROFIT_CONTROLLED_REDUCED_DRAWDOWN_PCT", 2.5, { positive: true, maximum: 100 }),
    profitControlledStrongOnlyDrawdownPct: numberValue("PROFIT_CONTROLLED_STRONG_ONLY_DRAWDOWN_PCT", 5, { positive: true, maximum: 100 }),
    profitControlledProtectionDrawdownPct: numberValue("PROFIT_CONTROLLED_PROTECTION_DRAWDOWN_PCT", 7.5, { positive: true, maximum: 100 }),
    profitExpansionMode: booleanValue("PROFIT_EXPANSION_MODE", profitControlledEquityMode ? true : false),
    profitModeMinQualityScore: numberValue("PROFIT_MODE_MIN_QUALITY_SCORE", 70, { minimum: 0, maximum: 100 }),
    profitModeStrongQualityScore: numberValue("PROFIT_MODE_STRONG_QUALITY_SCORE", 85, { minimum: 0, maximum: 100 }),
    profitModeEliteQualityScore: numberValue("PROFIT_MODE_ELITE_QUALITY_SCORE", 95, { minimum: 0, maximum: 100 }),
    profitModeMinRewardCostRatio: numberValue("PROFIT_MODE_MIN_REWARD_COST_RATIO", 1.85, { positive: true }),
    profitModeMinNetProfitToCostRatio: numberValue("PROFIT_MODE_MIN_NET_PROFIT_TO_COST_RATIO", 0.35, { minimum: 0 }),
    professionalTrendEngineEnabled: booleanValue("PROFESSIONAL_TREND_ENGINE_ENABLED", profitControlledEquityMode ? true : false),
    multiTimeframeTrendEngineEnabled: booleanValue("MULTI_TIMEFRAME_TREND_ENGINE_ENABLED", profitControlledEquityMode ? true : false),
    macroOppositeRequiresElite: booleanValue("MACRO_OPPOSITE_REQUIRES_ELITE", profitControlledEquityMode ? true : false),
    mtfStrongAlignmentScore: numberValue("MTF_STRONG_ALIGNMENT_SCORE", 82, { minimum: 0, maximum: 100 }),
    mtfOppositionPenaltyScore: numberValue("MTF_OPPOSITION_PENALTY_SCORE", 28, { minimum: 0, maximum: 60 }),
    convictionThresholdTrending: numberValue("CONVICTION_THRESHOLD_TRENDING", 46, { positive: true, maximum: 100 }),
    convictionThresholdBreakout: numberValue("CONVICTION_THRESHOLD_BREAKOUT", 44, { positive: true, maximum: 100 }),
    convictionThresholdSidewaysChop: numberValue("CONVICTION_THRESHOLD_SIDEWAYS_CHOP", 42, { positive: true, maximum: 100 }),
    convictionThresholdVolatile: numberValue("CONVICTION_THRESHOLD_VOLATILE", 45, { positive: true, maximum: 100 }),
    convictionThresholdPanic: numberValue("CONVICTION_THRESHOLD_PANIC", 50, { positive: true, maximum: 100 }),
    expectancyOptimizerEnabled: booleanValue("EXPECTANCY_OPTIMIZER_ENABLED", profitControlledEquityMode ? true : false),
    expectancyOptimizerWindowTrades: numberValue("EXPECTANCY_OPTIMIZER_WINDOW_TRADES", 50, { positive: true, integer: true }),
    expectancyFeeDragTightenRatio: numberValue("EXPECTANCY_FEE_DRAG_TIGHTEN_RATIO", 0.65, { minimum: 0 }),
    expectancyEntryTighteningPoints: numberValue("EXPECTANCY_ENTRY_TIGHTENING_POINTS", 2, { minimum: 0, maximum: 8 }),
    expectancyContinuationBoostPoints: numberValue("EXPECTANCY_CONTINUATION_BOOST_POINTS", 3, { minimum: 0, maximum: 8 }),
    expectancyRunnerExtensionBoost: numberValue("EXPECTANCY_RUNNER_EXTENSION_BOOST", 1.08, { positive: true, maximum: 1.5 }),
    nearMissLearningEnabled: booleanValue("NEAR_MISS_LEARNING_ENABLED", profitControlledEquityMode ? true : false),
    nearMissMaxPointGap: numberValue("NEAR_MISS_MAX_POINT_GAP", 5, { positive: true, maximum: 20 }),
    nearMissSmallTradeEnabled: booleanValue("NEAR_MISS_SMALL_TRADE_ENABLED", profitControlledEquityMode ? true : false),
    nearMissSmallTradeMaxGap: numberValue("NEAR_MISS_SMALL_TRADE_MAX_GAP", 3, { positive: true, maximum: 10 }),
    edgeMaximizationMode: booleanValue("EDGE_MAXIMIZATION_MODE", profitControlledEquityMode ? true : false),
    edgeReinforcementMode: booleanValue("EDGE_REINFORCEMENT_MODE", profitControlledEquityMode ? true : false),
    qualitySizeMultiplierNormal: numberValue("QUALITY_SIZE_MULTIPLIER_NORMAL", 1, { positive: true, maximum: 1.5 }),
    qualitySizeMultiplierStrong: numberValue("QUALITY_SIZE_MULTIPLIER_STRONG", 1.2, { positive: true, maximum: 1.5 }),
    qualitySizeMultiplierElite: numberValue("QUALITY_SIZE_MULTIPLIER_ELITE", 1.5, { positive: true, maximum: 1.5 }),
    setupRankingBoostProfitFactor: numberValue("SETUP_RANKING_BOOST_PROFIT_FACTOR", 1.3, { positive: true }),
    setupRankingReduceProfitFactor: numberValue("SETUP_RANKING_REDUCE_PROFIT_FACTOR", 1, { positive: true }),
    regimeMemoryBoostProfitFactor: numberValue("REGIME_MEMORY_BOOST_PROFIT_FACTOR", 1.3, { positive: true }),
    regimeMemoryReduceProfitFactor: numberValue("REGIME_MEMORY_REDUCE_PROFIT_FACTOR", 1, { positive: true }),
    setupRegimeMatrixBoostProfitFactor: numberValue("SETUP_REGIME_MATRIX_BOOST_PROFIT_FACTOR", 1.3, { positive: true }),
    setupRegimeMatrixReduceProfitFactor: numberValue("SETUP_REGIME_MATRIX_REDUCE_PROFIT_FACTOR", 1, { positive: true }),
    asymmetricRunnerWeakTp1Pct: numberValue("ASYMMETRIC_RUNNER_WEAK_TP1_PCT", 50, { positive: true, maximum: 90 }),
    asymmetricRunnerStrongTp1Pct: numberValue("ASYMMETRIC_RUNNER_STRONG_TP1_PCT", 20, { positive: true, maximum: 90 }),
    asymmetricRunnerEliteTp1Pct: numberValue("ASYMMETRIC_RUNNER_ELITE_TP1_PCT", 10, { positive: true, maximum: 90 }),
    asymmetricRunnerStrongTrendScore: numberValue("ASYMMETRIC_RUNNER_STRONG_TREND_SCORE", 82, { minimum: 0, maximum: 100 }),
    asymmetricRunnerEliteTrendScore: numberValue("ASYMMETRIC_RUNNER_ELITE_TREND_SCORE", 92, { minimum: 0, maximum: 100 }),
    expectancyAutoTuningWindowTrades: numberValue("EXPECTANCY_AUTO_TUNING_WINDOW_TRADES", 100, { positive: true, integer: true }),
    expectancyAutoTuningMaxAdjustmentPct: numberValue("EXPECTANCY_AUTO_TUNING_MAX_ADJUSTMENT_PCT", 5, { minimum: 0, maximum: 5 }),
    expectancyAutoTuningTightenProfitFactor: numberValue("EXPECTANCY_AUTO_TUNING_TIGHTEN_PROFIT_FACTOR", 1, { positive: true }),
    expectancyAutoTuningRelaxProfitFactor: numberValue("EXPECTANCY_AUTO_TUNING_RELAX_PROFIT_FACTOR", 1.3, { positive: true }),
    adaptiveEdgeActivityRecoveryMode: booleanValue("ADAPTIVE_EDGE_ACTIVITY_RECOVERY_MODE", profitControlledEquityMode ? true : false),
    adaptiveEdgeActivityRecoveryWindowMinutes: numberValue("ADAPTIVE_EDGE_ACTIVITY_RECOVERY_WINDOW_MINUTES", 240, { positive: true }),
    adaptiveEdgeActivityRecoveryTargetTrades: numberValue("ADAPTIVE_EDGE_ACTIVITY_RECOVERY_TARGET_TRADES", 2, { minimum: 0 }),
    adaptiveEdgeActivityRecoveryMaxRelaxPct: numberValue("ADAPTIVE_EDGE_ACTIVITY_RECOVERY_MAX_RELAX_PCT", 3, { minimum: 0, maximum: 5 }),
    adaptiveEdgeActivityRecoveryMinProfitFactor: numberValue("ADAPTIVE_EDGE_ACTIVITY_RECOVERY_MIN_PROFIT_FACTOR", 1, { positive: true }),
    adaptiveEdgeActivityRecoveryMaxFeeDragRatio: numberValue("ADAPTIVE_EDGE_ACTIVITY_RECOVERY_MAX_FEE_DRAG_RATIO", 0.65, { minimum: 0 }),
    trendDominanceMode: booleanValue("TREND_DOMINANCE_MODE", profitControlledEquityMode ? true : false),
    aggressiveAdaptiveMode: booleanValue("AGGRESSIVE_ADAPTIVE_MODE", profitControlledEquityMode ? true : false),
    inactivityRecoveryMode: booleanValue("INACTIVITY_RECOVERY_MODE", profitControlledEquityMode ? true : false),
    inactivityRecoveryFourHourRelaxPct: numberValue("INACTIVITY_RECOVERY_4H_CONVICTION_RELAX_PCT", 2, { minimum: 0, maximum: 10 }),
    inactivityRecoveryEightHourRelaxPct: numberValue("INACTIVITY_RECOVERY_8H_CONVICTION_RELAX_PCT", 4, { minimum: 0, maximum: 10 }),
    inactivityRecoveryTwelveHourRelaxPct: numberValue("INACTIVITY_RECOVERY_12H_CONVICTION_RELAX_PCT", 6, { minimum: 0, maximum: 10 }),
    inactivityRecoveryFourHourRelaxPoints: numberValue("INACTIVITY_RECOVERY_4H_CONVICTION_RELAX_POINTS", 2, { minimum: 0, maximum: 10 }),
    inactivityRecoveryEightHourRelaxPoints: numberValue("INACTIVITY_RECOVERY_8H_CONVICTION_RELAX_POINTS", 4, { minimum: 0, maximum: 10 }),
    inactivityRecoveryTwelveHourRelaxPoints: numberValue("INACTIVITY_RECOVERY_12H_CONVICTION_RELAX_POINTS", 6, { minimum: 0, maximum: 10 }),
    aggressiveAdaptiveNormalStopRiskPct: numberValue("AGGRESSIVE_ADAPTIVE_NORMAL_STOP_RISK_PCT", 0.75, { positive: true, maximum: 5 }),
    aggressiveAdaptiveStrongStopRiskPct: numberValue("AGGRESSIVE_ADAPTIVE_STRONG_STOP_RISK_PCT", 1.5, { positive: true, maximum: 5 }),
    aggressiveAdaptiveEliteStopRiskPct: numberValue("AGGRESSIVE_ADAPTIVE_ELITE_STOP_RISK_PCT", 2, { positive: true, maximum: 5 }),
    trendDominanceStrongScore: numberValue("TREND_DOMINANCE_STRONG_SCORE", 82, { minimum: 0, maximum: 100 }),
    trendDominanceEliteScore: numberValue("TREND_DOMINANCE_ELITE_SCORE", 92, { minimum: 0, maximum: 100 }),
    trendDominanceActivityBoostPct: numberValue("TREND_DOMINANCE_ACTIVITY_BOOST_PCT", 5, { minimum: 0, maximum: 6 }),
    trendDominanceScoreBoost: numberValue("TREND_DOMINANCE_SCORE_BOOST", 3, { minimum: 0, maximum: 8 }),
    trendDominanceEthBtcFocusBoost: numberValue("TREND_DOMINANCE_ETH_BTC_FOCUS_BOOST", 4, { minimum: 0, maximum: 8 }),
    trendDominanceEthWeightMultiplier: numberValue("TREND_DOMINANCE_ETH_WEIGHT_MULTIPLIER", 1.4, { positive: true, maximum: 2 }),
    trendDominanceBtcWeightMultiplier: numberValue("TREND_DOMINANCE_BTC_WEIGHT_MULTIPLIER", 1.25, { positive: true, maximum: 2 }),
    trendDominanceSolWeakBreakoutMultiplier: numberValue("TREND_DOMINANCE_SOL_WEAK_BREAKOUT_MULTIPLIER", 0.82, { positive: true, maximum: 1 }),
    trendDominanceSolWeakBreakoutPenalty: numberValue("TREND_DOMINANCE_SOL_WEAK_BREAKOUT_PENALTY", 4, { minimum: 0, maximum: 12 }),
    trendDominanceStrongSizingMultiplier: numberValue("TREND_DOMINANCE_STRONG_SIZING_MULTIPLIER", 1.18, { positive: true, maximum: 1.25 }),
    trendDominanceEliteSizingMultiplier: numberValue("TREND_DOMINANCE_ELITE_SIZING_MULTIPLIER", 1.25, { positive: true, maximum: 1.25 }),
    trendDominanceRunnerExtensionBoost: numberValue("TREND_DOMINANCE_RUNNER_EXTENSION_BOOST", 1.12, { positive: true, maximum: 1.3 }),
    tradeClusterWindowMinutes: numberValue("TRADE_CLUSTER_WINDOW_MINUTES", 45, { positive: true }),
    tradeClusterMaxSizeReductionPct: numberValue("TRADE_CLUSTER_MAX_SIZE_REDUCTION_PCT", 20, { minimum: 0, maximum: 40 }),
    tradeFrequencyRecoveryMode: booleanValue("TRADE_FREQUENCY_RECOVERY_MODE", profitControlledEquityMode ? true : false),
    tradeFrequencyRecoveryMinSignalScore: numberValue("TRADE_FREQUENCY_RECOVERY_MIN_SIGNAL_SCORE", 42, { positive: true, maximum: 100 }),
    tradeFrequencyRecoveryMinConvictionScore: numberValue("TRADE_FREQUENCY_RECOVERY_MIN_CONVICTION_SCORE", 45, { positive: true, maximum: 100 }),
    antiChopPenaltyMax: numberValue("ANTI_CHOP_PENALTY_MAX", 10, { minimum: 0, maximum: 30 }),
    antiChopConvictionPenaltyMax: numberValue("ANTI_CHOP_CONVICTION_PENALTY_MAX", 10, { minimum: 0, maximum: 30 }),
    volumeSurvivabilityRelaxationMultiplier: numberValue("VOLUME_SURVIVABILITY_RELAXATION_MULTIPLIER", 0.8, { positive: true, maximum: 1 }),
    winnerAmplifierEnabled: booleanValue("WINNER_AMPLIFIER_ENABLED", profitControlledEquityMode ? true : false),
    winnerAmplifierPartialTakeProfitPct: numberValue("WINNER_AMPLIFIER_PARTIAL_TAKE_PROFIT_PCT", 50, { positive: true, maximum: 90 }),
    runnerBreakevenCostCushionPct: numberValue("RUNNER_BREAKEVEN_COST_CUSHION_PCT", 0.08, { minimum: 0 }),
    runnerAtrTrailingMultiplier: numberValue("RUNNER_ATR_TRAILING_MULTIPLIER", 1.05, { positive: true, maximum: 4 }),
    runnerTrendExtensionMultiplier: numberValue("RUNNER_TREND_EXTENSION_MULTIPLIER", 1.35, { positive: true, maximum: 4 }),
    forcedExecutionSamplingActive: booleanValue("FORCED_EXECUTION_SAMPLING_ACTIVE", false),
    unconfirmedMicroBreakoutEntries: booleanValue("UNCONFIRMED_MICRO_BREAKOUT_ENTRIES", false),
    allowChoppyMarketUnconditionally: booleanValue("ALLOW_CHOPPY_MARKET_UNCONDITIONALLY", false),
    unlimitedExplorationBudget: booleanValue("UNLIMITED_EXPLORATION_BUDGET", false),
    dailyTradeLimitsDisabled: booleanValue("DAILY_TRADE_LIMITS_DISABLED", true),
    activeScalperMinSignalScore: numberValue("ACTIVE_SCALPER_MIN_SIGNAL_SCORE", 38, { positive: true, maximum: 100 }),
    activeScalperMinConvictionScore: numberValue("ACTIVE_SCALPER_MIN_CONVICTION_SCORE", 42, { positive: true, maximum: 100 }),
    activeScalperExplorationMinSignalScore: numberValue("ACTIVE_SCALPER_EXPLORATION_MIN_SIGNAL_SCORE", 26, { positive: true, maximum: 100 }),
    activeScalperExplorationMinConvictionScore: numberValue("ACTIVE_SCALPER_EXPLORATION_MIN_CONVICTION_SCORE", 32, { positive: true, maximum: 100 }),
    activeScalperMaxLossCooldownMinutes: numberValue("ACTIVE_SCALPER_MAX_LOSS_COOLDOWN_MINUTES", 10, { minimum: 0 }),
    activeScalperMaxReentryCooldownSeconds: numberValue("ACTIVE_SCALPER_MAX_REENTRY_COOLDOWN_SECONDS", 60, { minimum: 0 }),
    participationRecoveryMode: booleanValue("PARTICIPATION_RECOVERY_MODE", profitControlledEquityMode || activeAdaptiveScalperMode ? true : false),
    participationRecoverySofteningMultiplier: numberValue("PARTICIPATION_RECOVERY_SOFTENING_MULTIPLIER", 0.55, { positive: true, maximum: 1 }),
    participationRecoveryInactivitySofteningMultiplier: numberValue("PARTICIPATION_RECOVERY_INACTIVITY_SOFTENING_MULTIPLIER", 0.35, { positive: true, maximum: 1 }),
    paperDailyLossLimitPct: numberValue("PAPER_DAILY_LOSS_LIMIT_PCT", 3, { positive: true, maximum: 100 }),
    confidenceSizingEnabled: booleanValue("CONFIDENCE_SIZING_ENABLED", activeAdaptiveScalperMode ? true : false),
    confidenceSmallMinScore: numberValue("CONFIDENCE_SMALL_MIN_SCORE", 50, { minimum: 0, maximum: 100 }),
    confidenceNormalMinScore: numberValue("CONFIDENCE_NORMAL_MIN_SCORE", 60, { minimum: 0, maximum: 100 }),
    confidenceLargeMinScore: numberValue("CONFIDENCE_LARGE_MIN_SCORE", 75, { minimum: 0, maximum: 100 }),
    activeScalperRejectedLogMax: numberValue("ACTIVE_SCALPER_REJECTED_LOG_MAX", 500, { positive: true, integer: true }),
    allowShorts: booleanValue("ALLOW_SHORTS", true),
    allowLongs: booleanValue("ALLOW_LONGS", true),
    scanIntervalMs: numberValue("SCAN_INTERVAL_MS", 1200, { positive: true, integer: true }),
    positionMonitorIntervalMs: numberValue("POSITION_MONITOR_INTERVAL_MS", 1200, { positive: true, integer: true }),
    entryConfirmationTimeoutMs: numberValue("ENTRY_CONFIRMATION_TIMEOUT_MS", 15000, { positive: true, integer: true }),
    scanConcurrency: numberValue("SCAN_CONCURRENCY", 4, { positive: true, integer: true, maximum: 10 }),
    marketRegimeCacheMs: numberValue("MARKET_REGIME_CACHE_MS", 45000, { positive: true, integer: true }),
    apiRequestIntervalMs: numberValue("API_REQUEST_INTERVAL_MS", 70, { positive: true, integer: true }),
    apiRateLimitCooldownMs: numberValue("API_RATE_LIMIT_COOLDOWN_MS", 10000, { positive: true, integer: true }),
    apiAutoRecoveryEnabled: booleanValue("API_AUTO_RECOVERY_ENABLED", true),
    apiRecoveryBaseBackoffMs: numberValue("API_RECOVERY_BASE_BACKOFF_MS", 1000, { positive: true, integer: true }),
    apiRecoveryMaxBackoffMs: numberValue("API_RECOVERY_MAX_BACKOFF_MS", 30000, { positive: true, integer: true }),
    wsReconnectBaseMs: numberValue("WS_RECONNECT_BASE_MS", 1000, { positive: true, integer: true }),
    candleIntervalFast: String(process.env.CANDLE_INTERVAL_FAST || "1M").trim(),
    candleIntervalMain: String(process.env.CANDLE_INTERVAL_MAIN || "5M").trim(),
    candleIntervalTrend: String(process.env.CANDLE_INTERVAL_TREND || "15M").trim(),
    candleIntervalMacro: String(process.env.CANDLE_INTERVAL_MACRO || "60M").trim(),
    candleIntervalMacroLong: String(process.env.CANDLE_INTERVAL_MACRO_LONG || "240M").trim(),
    v11ActiveMarketEngine: booleanValue("V11_ACTIVE_MARKET_ENGINE", profitControlledEquityMode ? true : false),
    v11NearMissReevaluationMaxGap: numberValue("V11_NEAR_MISS_REEVALUATION_MAX_GAP", 3, { minimum: 0, maximum: 10 }),
    v11MeanReversionEnabled: booleanValue("V11_MEAN_REVERSION_ENABLED", profitControlledEquityMode ? true : false),
    v11MeanReversionRangeEdgePct: numberValue("V11_MEAN_REVERSION_RANGE_EDGE_PCT", 0.22, { minimum: 0, maximum: 0.5 }),
    v11MeanReversionScoreBoost: numberValue("V11_MEAN_REVERSION_SCORE_BOOST", 10, { minimum: 0, maximum: 20 }),
    v11VolatileBreakoutBoost: numberValue("V11_VOLATILE_BREAKOUT_BOOST", 8, { minimum: 0, maximum: 20 }),
    v11PanicRiskMultiplier: numberValue("V11_PANIC_RISK_MULTIPLIER", 0.55, { positive: true, maximum: 1 }),
    v11HigherTimeframeAlignmentBoost: numberValue("V11_HIGHER_TIMEFRAME_ALIGNMENT_BOOST", 7, { minimum: 0, maximum: 20 }),
    v11HigherTimeframeConflictPenalty: numberValue("V11_HIGHER_TIMEFRAME_CONFLICT_PENALTY", 9, { minimum: 0, maximum: 20 }),
    maxSymbolsToScan: numberValue("MAX_SYMBOLS_TO_SCAN", 3, { positive: true, integer: true }),
    min24hVolumeUsdt: numberValue("MIN_24H_VOLUME_USDT", 1000000, { minimum: 0 }),
    maxSpreadPct: numberValue("MAX_SPREAD_PCT", 0.6, { positive: true }),
    excludedSymbols: symbolsSet("EXCLUDED_SYMBOLS"),
    focusedTradingSymbolsList: [...FOCUSED_TRADING_SYMBOLS],
    focusedTradingSymbols: new Set(FOCUSED_TRADING_SYMBOLS),
    takeProfitPct: numberValue("TAKE_PROFIT_PCT", 2.1, { positive: true }),
    stopLossPct: numberValue("STOP_LOSS_PCT", 0.8, { positive: true }),
    trailingStopEnabled: booleanValue("TRAILING_STOP_ENABLED", true),
    trailingStartPct: numberValue("TRAILING_START_PCT", 1.1, { positive: true }),
    trailingDistancePct: numberValue("TRAILING_DISTANCE_PCT", 0.6, { positive: true }),
    swingTakeProfitPct: numberValue("SWING_TAKE_PROFIT_PCT", 6, { positive: true }),
    swingStopLossPct: numberValue("SWING_STOP_LOSS_PCT", 2.2, { positive: true }),
    swingTrailingStartPct: numberValue("SWING_TRAILING_START_PCT", 2.2, { positive: true }),
    swingTrailingDistancePct: numberValue("SWING_TRAILING_DISTANCE_PCT", 1.4, { positive: true }),
    swingRunnerAtrTrailingMultiplier: numberValue("SWING_RUNNER_ATR_TRAILING_MULTIPLIER", 1.8, { positive: true, maximum: 6 }),
    swingMinimumHoldSeconds: numberValue("SWING_MIN_HOLD_SECONDS", 7200, { minimum: 0 }),
    swingProfitExitMinHoldSeconds: numberValue("SWING_PROFIT_EXIT_MIN_HOLD_SECONDS", 7200, { minimum: 0 }),
    swingTrailingMinHoldSeconds: numberValue("SWING_TRAILING_MIN_HOLD_SECONDS", 1800, { minimum: 0 }),
    swingThesisFailureMinHoldSeconds: numberValue("SWING_THESIS_FAILURE_MIN_HOLD_SECONDS", 3600, { minimum: 0 }),
    swingTrendExitMinHoldSeconds: numberValue("SWING_TREND_EXIT_MIN_HOLD_SECONDS", 14400, { minimum: 0 }),
    swingMaxHoldSeconds: numberValue("SWING_MAX_HOLD_SECONDS", 259200, { positive: true }),
    swingScanIntervalMs: numberValue("SWING_SCAN_INTERVAL_MS", 15000, { positive: true, integer: true }),
    swingPositionMonitorIntervalMs: numberValue("SWING_POSITION_MONITOR_INTERVAL_MS", 30000, { positive: true, integer: true }),
    swingTrendDeteriorationExitEnabled: booleanValue("SWING_TREND_DETERIORATION_EXIT_ENABLED", true),
    swingAdoptExistingPositions: booleanValue("SWING_ADOPT_EXISTING_POSITIONS", true),
    swingDuplicateEntryWindowMinutes: numberValue("SWING_DUPLICATE_ENTRY_WINDOW_MINUTES", 240, { minimum: 0 }),
    swingDisableNativeTakeProfit: booleanValue("SWING_DISABLE_NATIVE_TAKE_PROFIT", true),
    swingMinTargetMarginUsdt: numberValue("SWING_MIN_TARGET_MARGIN_USDT", 20, { positive: true }),
    swingNormalTargetMarginUsdt: numberValue("SWING_NORMAL_TARGET_MARGIN_USDT", 22, { positive: true }),
    swingStrongTargetMarginUsdt: numberValue("SWING_STRONG_TARGET_MARGIN_USDT", 28, { positive: true }),
    swingEliteTargetMarginUsdt: numberValue("SWING_ELITE_TARGET_MARGIN_USDT", 40, { positive: true }),
    trendPortfolioAggressiveMomentumMode: booleanValue("TREND_PORTFOLIO_AGGRESSIVE_MOMENTUM_MODE", true),
    trendPortfolioMinScore: numberValue("TREND_PORTFOLIO_MIN_SCORE", 46, { positive: true, maximum: 100 }),
    trendPortfolioNormalScore: numberValue("TREND_PORTFOLIO_NORMAL_SCORE", 58, { positive: true, maximum: 100 }),
    trendPortfolioStrongScore: numberValue("TREND_PORTFOLIO_STRONG_SCORE", 66, { positive: true, maximum: 100 }),
    trendPortfolioEliteScore: numberValue("TREND_PORTFOLIO_ELITE_SCORE", 76, { positive: true, maximum: 100 }),
    trendPortfolioMinNetEdgePct: numberValue("TREND_PORTFOLIO_MIN_NET_EDGE_PCT", 0.14, { minimum: 0 }),
    trendPortfolioMinRewardCostRatio: numberValue("TREND_PORTFOLIO_MIN_REWARD_COST_RATIO", 1.8, { positive: true }),
    trendPortfolioExpectedMoveAtrMultiplier: numberValue("TREND_PORTFOLIO_EXPECTED_MOVE_ATR_MULTIPLIER", 2.8, { positive: true }),
    trendPortfolioMacroOppositionPenalty: numberValue("TREND_PORTFOLIO_MACRO_OPPOSITION_PENALTY", 22, { minimum: 0, maximum: 50 }),
    trendPortfolioStopAtrMultiplier: numberValue("TREND_PORTFOLIO_STOP_ATR_MULTIPLIER", 1.9, { positive: true, maximum: 8 }),
    trendPortfolioTargetAtrMultiplier: numberValue("TREND_PORTFOLIO_TARGET_ATR_MULTIPLIER", 4.8, { positive: true, maximum: 16 }),
    trendPortfolioPyramidWindowMinutes: numberValue("TREND_PORTFOLIO_PYRAMID_WINDOW_MINUTES", 360, { minimum: 0 }),
    multiStrategyPortfolioEngineEnabled: booleanValue("MULTI_STRATEGY_PORTFOLIO_ENGINE_ENABLED", trendPortfolioMode ? true : false),
    quantResearchPlatformMode: booleanValue("QUANT_RESEARCH_PLATFORM_MODE", trendPortfolioMode ? true : false),
    quantIntelligenceEngineMode: booleanValue("QUANT_INTELLIGENCE_ENGINE_MODE", trendPortfolioMode ? true : false),
    institutionalQuantEngineMode: booleanValue("INSTITUTIONAL_QUANT_ENGINE_MODE", trendPortfolioMode ? true : false),
    strategyLaboratoryMode: booleanValue("STRATEGY_LABORATORY_MODE", false),
    strategyLaboratoryShadowMode: booleanValue("STRATEGY_LABORATORY_SHADOW_MODE", true),
    v21RequireLabPromotionForLive: booleanValue("V21_REQUIRE_LAB_PROMOTION_FOR_LIVE", false),
    strategyLaboratoryReportFile: process.env.STRATEGY_LABORATORY_REPORT_FILE || path.join(dataDir, "reports", "strategy-laboratory-v21.json"),
    v21LabMinEntryConfidence: numberValue("V21_LAB_MIN_ENTRY_CONFIDENCE", 45, { positive: true, maximum: 100 }),
    v21MinProfitFactor: numberValue("V21_MIN_PROFIT_FACTOR", 1.2, { minimum: 0 }),
    v21MaxDrawdownUsdt: numberValue("V21_MAX_DRAWDOWN_USDT", 8, { minimum: 0 }),
    v21MinTradeCount: numberValue("V21_MIN_TRADE_COUNT", 12, { minimum: 0, integer: true }),
    v21LabPositionNotionalUsdt: numberValue("V21_LAB_POSITION_NOTIONAL_USDT", 32, { positive: true }),
    v21DonchianLookback: numberValue("V21_DONCHIAN_LOOKBACK", 20, { positive: true, integer: true, maximum: 120 }),
    v21PullbackLookback: numberValue("V21_PULLBACK_LOOKBACK", 10, { positive: true, integer: true, maximum: 80 }),
    v21StopAtrMultiplier: numberValue("V21_STOP_ATR_MULTIPLIER", 1.6, { positive: true, maximum: 8 }),
    v21TrailAtrPct: numberValue("V21_TRAIL_ATR_PCT", 0.25, { minimum: 0, maximum: 5 }),
    v22ResearchPlatformMode: booleanValue("V22_RESEARCH_PLATFORM_MODE", false),
    v22ResearchCacheDir: process.env.V22_RESEARCH_CACHE_DIR || path.join(PROJECT_ROOT, "data", "research", "ohlcv"),
    v22ResearchReportFile: process.env.V22_RESEARCH_REPORT_FILE || path.join(PROJECT_ROOT, "data", "research", "reports", "research-v22.json"),
    v22ResearchPrimaryInterval: String(process.env.V22_RESEARCH_PRIMARY_INTERVAL || "1m").trim(),
    v22ResearchMinEntryConfidence: numberValue("V22_RESEARCH_MIN_ENTRY_CONFIDENCE", 45, { positive: true, maximum: 100 }),
    v22ResearchNotionalUsdt: numberValue("V22_RESEARCH_NOTIONAL_USDT", 50, { positive: true }),
    v22MinProfitFactor: numberValue("V22_MIN_PROFIT_FACTOR", 1.2, { minimum: 0 }),
    v22MaxDrawdownUsdt: numberValue("V22_MAX_DRAWDOWN_USDT", 8, { minimum: 0 }),
    v22MinTradeCount: numberValue("V22_MIN_TRADE_COUNT", 12, { minimum: 0, integer: true }),
    v22TrainPct: numberValue("V22_TRAIN_PCT", 0.55, { positive: true, maximum: 0.8 }),
    v22ValidationPct: numberValue("V22_VALIDATION_PCT", 0.25, { positive: true, maximum: 0.5 }),
    v22PartialFillMinRatio: numberValue("V22_PARTIAL_FILL_MIN_RATIO", 0.35, { positive: true, maximum: 1 }),
    v22PartialFillVolumeNotionalMultiple: numberValue("V22_PARTIAL_FILL_VOLUME_NOTIONAL_MULTIPLE", 6, { positive: true }),
    v22TrailingActivationR: numberValue("V22_TRAILING_ACTIVATION_R", 1.25, { positive: true, maximum: 6 }),
    v22MinimumTrailDistancePct: numberValue("V22_MINIMUM_TRAIL_DISTANCE_PCT", 0.18, { minimum: 0, maximum: 5 }),
    v20MinConfidence: numberValue("V20_MIN_CONFIDENCE", 45, { positive: true, maximum: 100 }),
    v20MarketRegimeWeight: numberValue("V20_MARKET_REGIME_WEIGHT", 0.14, { minimum: 0, maximum: 1 }),
    v20TrendWeight: numberValue("V20_TREND_WEIGHT", 0.24, { minimum: 0, maximum: 1 }),
    v20VolumeWeight: numberValue("V20_VOLUME_WEIGHT", 0.13, { minimum: 0, maximum: 1 }),
    v20VolatilityWeight: numberValue("V20_VOLATILITY_WEIGHT", 0.12, { minimum: 0, maximum: 1 }),
    v20FundingWeight: numberValue("V20_FUNDING_WEIGHT", 0.1, { minimum: 0, maximum: 1 }),
    v20OpenInterestWeight: numberValue("V20_OPEN_INTEREST_WEIGHT", 0.17, { minimum: 0, maximum: 1 }),
    v20StrategyWeight: numberValue("V20_STRATEGY_WEIGHT", 0.1, { minimum: 0, maximum: 1 }),
    v20SingleFactorConfidenceFloor: numberValue("V20_SINGLE_FACTOR_CONFIDENCE_FLOOR", 18, { minimum: 0, maximum: 50 }),
    v20CapitalTierExplorationUsdt: numberValue("V20_CAPITAL_TIER_EXPLORATION_USDT", 20, { minimum: 0 }),
    v20CapitalTierNormalUsdt: numberValue("V20_CAPITAL_TIER_NORMAL_USDT", 32, { minimum: 0 }),
    v20CapitalTierStrongUsdt: numberValue("V20_CAPITAL_TIER_STRONG_USDT", 48, { minimum: 0 }),
    v20CapitalTierEliteUsdt: numberValue("V20_CAPITAL_TIER_ELITE_USDT", 64, { minimum: 0 }),
    v20HighVolatilityAtrPct: numberValue("V20_HIGH_VOLATILITY_ATR_PCT", 0.8, { minimum: 0 }),
    v20LowVolatilityAtrPct: numberValue("V20_LOW_VOLATILITY_ATR_PCT", 0.1, { minimum: 0 }),
    v20ExpansionRangeMultiple: numberValue("V20_EXPANSION_RANGE_MULTIPLE", 1.35, { positive: true }),
    v20ExpansionVolumeMultiple: numberValue("V20_EXPANSION_VOLUME_MULTIPLE", 1.35, { positive: true }),
    v20CompressionRangeMultiple: numberValue("V20_COMPRESSION_RANGE_MULTIPLE", 0.72, { positive: true }),
    v20TrendingEmaGapPct: numberValue("V20_TRENDING_EMA_GAP_PCT", 0.12, { minimum: 0 }),
    v20IncompatibleStrategyPenaltyMultiplier: numberValue("V20_INCOMPATIBLE_STRATEGY_PENALTY_MULTIPLIER", 0.72, { minimum: 0, maximum: 1 }),
    v20ShadowModeEnabled: booleanValue("V20_SHADOW_MODE_ENABLED", true),
    v20ShadowMinConfidence: numberValue("V20_SHADOW_MIN_CONFIDENCE", 40, { minimum: 0, maximum: 100 }),
    v19MinConfidence: numberValue("V19_MIN_CONFIDENCE", 45, { positive: true, maximum: 100 }),
    v19FundingWeight: numberValue("V19_FUNDING_WEIGHT", 0.12, { minimum: 0, maximum: 1 }),
    v19OpenInterestWeight: numberValue("V19_OPEN_INTEREST_WEIGHT", 0.18, { minimum: 0, maximum: 1 }),
    v19TrendWeight: numberValue("V19_TREND_WEIGHT", 0.26, { minimum: 0, maximum: 1 }),
    v19VolumeWeight: numberValue("V19_VOLUME_WEIGHT", 0.14, { minimum: 0, maximum: 1 }),
    v19VolatilityWeight: numberValue("V19_VOLATILITY_WEIGHT", 0.12, { minimum: 0, maximum: 1 }),
    v19RegimeWeight: numberValue("V19_REGIME_WEIGHT", 0.1, { minimum: 0, maximum: 1 }),
    v19StrategyWeight: numberValue("V19_STRATEGY_WEIGHT", 0.08, { minimum: 0, maximum: 1 }),
    v19SingleFactorConfidenceFloor: numberValue("V19_SINGLE_FACTOR_CONFIDENCE_FLOOR", 18, { minimum: 0, maximum: 50 }),
    v19ExtremeFundingRatePct: numberValue("V19_EXTREME_FUNDING_RATE_PCT", 0.05, { minimum: 0 }),
    v19OpenInterestChangeThresholdPct: numberValue("V19_OPEN_INTEREST_CHANGE_THRESHOLD_PCT", 0.75, { minimum: 0 }),
    v19VolumeSpikeThreshold: numberValue("V19_VOLUME_SPIKE_THRESHOLD", 1.45, { positive: true }),
    v19InstitutionalVolumeSpike: numberValue("V19_INSTITUTIONAL_VOLUME_SPIKE", 2.2, { positive: true }),
    v19LowParticipationVolumeSpike: numberValue("V19_LOW_PARTICIPATION_VOLUME_SPIKE", 0.72, { positive: true }),
    v19DeadMarketAtrPct: numberValue("V19_DEAD_MARKET_ATR_PCT", 0.1, { minimum: 0 }),
    v19VolatilityExpansionAtrPct: numberValue("V19_VOLATILITY_EXPANSION_ATR_PCT", 0.7, { minimum: 0 }),
    v19CapitalTierExplorationUsdt: numberValue("V19_CAPITAL_TIER_EXPLORATION_USDT", 20, { minimum: 0 }),
    v19CapitalTierNormalUsdt: numberValue("V19_CAPITAL_TIER_NORMAL_USDT", 28, { minimum: 0 }),
    v19CapitalTierStrongUsdt: numberValue("V19_CAPITAL_TIER_STRONG_USDT", 40, { minimum: 0 }),
    v19CapitalTierEliteUsdt: numberValue("V19_CAPITAL_TIER_ELITE_USDT", 64, { minimum: 0 }),
    v19LearningFullWeightTrades: numberValue("V19_LEARNING_FULL_WEIGHT_TRADES", 100, { positive: true, integer: true }),
    v19WalkForwardWindowTrades: numberValue("V19_WALK_FORWARD_WINDOW_TRADES", 50, { positive: true, integer: true }),
    v18MinStrategyAllocationWeight: numberValue("V18_MIN_STRATEGY_ALLOCATION_WEIGHT", 0.15, { minimum: 0, maximum: 1 }),
    v18MaxStrategyAllocationWeight: numberValue("V18_MAX_STRATEGY_ALLOCATION_WEIGHT", 0.55, { minimum: 0, maximum: 1 }),
    v18WalkForwardMinTrades: numberValue("V18_WALK_FORWARD_MIN_TRADES", 20, { minimum: 0, integer: true }),
    v18WalkForwardMinProfitFactor: numberValue("V18_WALK_FORWARD_MIN_PROFIT_FACTOR", 1, { minimum: 0 }),
    v18WalkForwardMinExpectancyUsdt: numberValue("V18_WALK_FORWARD_MIN_EXPECTANCY_USDT", 0, { minimum: -100 }),
    v18RequireWalkForwardValidation: booleanValue("V18_REQUIRE_WALK_FORWARD_VALIDATION", false),
    v15TrendBreakoutWeight: numberValue("V15_TREND_BREAKOUT_WEIGHT", 0.25, { minimum: 0 }),
    v15MultiTimeframeTrendWeight: numberValue("V15_MULTI_TIMEFRAME_TREND_WEIGHT", 0.45, { minimum: 0 }),
    v15TrendPullbackWeight: numberValue("V15_TREND_PULLBACK_WEIGHT", 0.3, { minimum: 0 }),
    v15DonchianEntryLookback: numberValue("V15_DONCHIAN_ENTRY_LOOKBACK", 20, { positive: true, integer: true, maximum: 80 }),
    v15DonchianConfirmationLookback: numberValue("V15_DONCHIAN_CONFIRMATION_LOOKBACK", 20, { positive: true, integer: true, maximum: 80 }),
    v15PullbackLookback: numberValue("V15_PULLBACK_LOOKBACK", 10, { positive: true, integer: true, maximum: 40 }),
    v15StrategyMinConfidence: numberValue("V15_STRATEGY_MIN_CONFIDENCE", 52, { positive: true, maximum: 100 }),
    v15MinRewardRisk: numberValue("V15_MIN_REWARD_RISK", 1.3, { positive: true, maximum: 10 }),
    v16PortfolioMinConfidence: numberValue("V16_PORTFOLIO_MIN_CONFIDENCE", 46, { positive: true, maximum: 100 }),
    activeOpportunityMode: booleanValue("ACTIVE_OPPORTUNITY_MODE", trendPortfolioMode ? true : false),
    v17TrendBreakoutMinConfidence: numberValue("V17_TREND_BREAKOUT_MIN_CONFIDENCE", 56, { positive: true, maximum: 100 }),
    v17MultiTimeframeTrendMinConfidence: numberValue("V17_MULTI_TIMEFRAME_TREND_MIN_CONFIDENCE", 52, { positive: true, maximum: 100 }),
    v17TrendPullbackMinConfidence: numberValue("V17_TREND_PULLBACK_MIN_CONFIDENCE", 54, { positive: true, maximum: 100 }),
    v17OpportunityMinRewardRisk: numberValue("V17_OPPORTUNITY_MIN_REWARD_RISK", 1.3, { positive: true, maximum: 10 }),
    v16TrendRegimeSizeMultiplier: numberValue("V16_TREND_REGIME_SIZE_MULTIPLIER", 1, { minimum: 0, maximum: 2 }),
    v16RangeRegimeSizeMultiplier: numberValue("V16_RANGE_REGIME_SIZE_MULTIPLIER", 0.7, { minimum: 0, maximum: 2 }),
    v16ChoppyRegimeSizeMultiplier: numberValue("V16_CHOPPY_REGIME_SIZE_MULTIPLIER", 0.5, { minimum: 0, maximum: 2 }),
    v16LowVolatilityRegimeSizeMultiplier: numberValue("V16_LOW_VOLATILITY_REGIME_SIZE_MULTIPLIER", 0.5, { minimum: 0, maximum: 2 }),
    v16ExtremeRegimeSizeMultiplier: numberValue("V16_EXTREME_REGIME_SIZE_MULTIPLIER", 0, { minimum: 0, maximum: 2 }),
    v15MinAtrPct: numberValue("V15_MIN_ATR_PCT", 0.08, { minimum: 0, maximum: 5 }),
    v15MinStopAtrMultiplier: numberValue("V15_MIN_STOP_ATR_MULTIPLIER", 1.25, { positive: true, maximum: 8 }),
    minSignalScore: numberValue("MIN_SIGNAL_SCORE", 42, { positive: true, maximum: 100 }),
    closePositionOnExit: booleanValue("CLOSE_POSITION_ON_EXIT", true),
    maxPositionNotionalUsdt: numberValue("MAX_POSITION_NOTIONAL_USDT", 150, { positive: true }),
    maxMarginUsagePct: numberValue("MAX_MARGIN_USAGE_PCT", 55, { positive: true, maximum: 95 }),
    maxTotalMarginUsagePct: numberValue("MAX_TOTAL_MARGIN_USAGE_PCT", 90, { positive: true, maximum: 95 }),
    minLiquidationBufferPct: numberValue("MIN_LIQUIDATION_BUFFER_PCT", 2, { positive: true }),
    minVolumeSpike: numberValue("MIN_VOLUME_SPIKE", 1.18, { positive: true }),
    minBurstMomentumPct: numberValue("MIN_BURST_MOMENTUM_PCT", 0.08, { positive: true }),
    fomoMomentumPct: numberValue("FOMO_MOMENTUM_PCT", 0.18, { positive: true }),
    minMomentumPersistenceCandles: numberValue("MIN_MOMENTUM_PERSISTENCE_CANDLES", 2, { positive: true, integer: true, maximum: 6 }),
    estimatedFeePctPerSide: numberValue("ESTIMATED_FEE_PCT_PER_SIDE", 0.055, { minimum: 0 }),
    estimatedMakerFeePctPerSide: numberValue("MAKER_FEE_PCT_PER_SIDE", 0.02, { minimum: 0 }),
    estimatedTakerFeePctPerSide: numberValue("TAKER_FEE_PCT_PER_SIDE", 0.055, { minimum: 0 }),
    estimatedSlippagePct: numberValue("ESTIMATED_SLIPPAGE_PCT", 0.08, { minimum: 0 }),
    estimatedFundingPct: numberValue("ESTIMATED_FUNDING_PCT", 0, { minimum: -2 }),
    minProjectedEdgePct: numberValue("MIN_PROJECTED_EDGE_PCT", 0.55, { minimum: 0 }),
    minExpectedMovePct: numberValue("MIN_EXPECTED_MOVE_PCT", 0.95, { minimum: 0 }),
    expectedMoveAtrMultiplier: numberValue("EXPECTED_MOVE_ATR_MULTIPLIER", 1.15, { positive: true }),
    minEdgeToCostRatio: numberValue("MIN_EDGE_TO_COST_RATIO", 1.8, { positive: true }),
    minConvictionScore: numberValue("MIN_CONVICTION_SCORE", 45, { positive: true, maximum: 100 }),
    smartEdgeMinNetPct: numberValue("SMART_EDGE_MIN_NET_PCT", 0.22, { minimum: 0 }),
    smartEdgeMinTpProbability: numberValue("SMART_EDGE_MIN_TP_PROBABILITY", 0.46, { minimum: 0, maximum: 1 }),
    smartEdgeCostBufferMultiplier: numberValue("SMART_EDGE_COST_BUFFER_MULTIPLIER", 1.25, { positive: true }),
    edgeExplorationMinNetPct: numberValue("EDGE_EXPLORATION_MIN_NET_PCT", 0.06, { minimum: 0 }),
    edgeNormalMinNetPct: numberValue("EDGE_NORMAL_MIN_NET_PCT", 0.14, { minimum: 0 }),
    edgeStrongMinNetPct: numberValue("EDGE_STRONG_MIN_NET_PCT", 0.24, { minimum: 0 }),
    edgeEliteMinNetPct: numberValue("EDGE_ELITE_MIN_NET_PCT", 0.36, { minimum: 0 }),
    edgeExplorationMinRewardCostRatio: numberValue("EDGE_EXPLORATION_MIN_REWARD_COST_RATIO", 1.2, { positive: true }),
    edgeNormalMinRewardCostRatio: numberValue("EDGE_NORMAL_MIN_REWARD_COST_RATIO", 1.55, { positive: true }),
    edgeStrongMinRewardCostRatio: numberValue("EDGE_STRONG_MIN_REWARD_COST_RATIO", 1.9, { positive: true }),
    edgeEliteMinRewardCostRatio: numberValue("EDGE_ELITE_MIN_REWARD_COST_RATIO", 2.35, { positive: true }),
    edgeExplorationMinRewardRiskRatio: numberValue("EDGE_EXPLORATION_MIN_REWARD_RISK_RATIO", 1.05, { positive: true }),
    edgeNormalMinRewardRiskRatio: numberValue("EDGE_NORMAL_MIN_REWARD_RISK_RATIO", 1.25, { positive: true }),
    edgeStrongMinRewardRiskRatio: numberValue("EDGE_STRONG_MIN_REWARD_RISK_RATIO", 1.45, { positive: true }),
    edgeEliteMinRewardRiskRatio: numberValue("EDGE_ELITE_MIN_REWARD_RISK_RATIO", 1.65, { positive: true }),
    eliteTrendRiderEnabled: booleanValue("ELITE_TREND_RIDER_ENABLED", true),
    elitePartialTakeProfitPct: numberValue("ELITE_PARTIAL_TAKE_PROFIT_PCT", 50, { positive: true, maximum: 90 }),
    eliteRunnerTakeProfitMultiplier: numberValue("ELITE_RUNNER_TAKE_PROFIT_MULTIPLIER", 1.55, { positive: true, maximum: 4 }),
    eliteRunnerTrailingDistanceMultiplier: numberValue("ELITE_RUNNER_TRAILING_DISTANCE_MULTIPLIER", 1.18, { positive: true, maximum: 3 }),
    eliteMinScore: numberValue("ELITE_MIN_SCORE", 78, { positive: true, maximum: 100 }),
    eliteMinConvictionScore: numberValue("ELITE_MIN_CONVICTION_SCORE", 72, { positive: true, maximum: 100 }),
    eliteMinProjectedEdgePct: numberValue("ELITE_MIN_PROJECTED_EDGE_PCT", 0.8, { minimum: 0 }),
    eliteMinFeeEdgeRatio: numberValue("ELITE_MIN_FEE_EDGE_RATIO", 2.2, { positive: true }),
    eliteMinVolumeSpike: numberValue("ELITE_MIN_VOLUME_SPIKE", 1.65, { positive: true }),
    eliteMinTrendQuality: numberValue("ELITE_MIN_TREND_QUALITY", 68, { positive: true, maximum: 100 }),
    eliteMinMomentumPersistenceCandles: numberValue("ELITE_MIN_MOMENTUM_PERSISTENCE_CANDLES", 2, { positive: true, integer: true, maximum: 8 }),
    smartReentryWindowMinutes: numberValue("SMART_REENTRY_WINDOW_MINUTES", 35, { minimum: 0 }),
    continuationEngineEnabled: booleanValue("CONTINUATION_ENGINE_ENABLED", true),
    continuationMinStrength: numberValue("CONTINUATION_MIN_STRENGTH", 58, { minimum: 0, maximum: 100 }),
    pullbackContinuationEnabled: booleanValue("PULLBACK_CONTINUATION_ENABLED", true),
    retestEntryEnabled: booleanValue("RETEST_ENTRY_ENABLED", true),
    momentumResumptionEnabled: booleanValue("MOMENTUM_RESUMPTION_ENABLED", true),
    trendAccelerationEnabled: booleanValue("TREND_ACCELERATION_ENABLED", true),
    macroTrendWeight: numberValue("MACRO_TREND_WEIGHT", 5, { minimum: 0, maximum: 12 }),
    symbolSpecializationEnabled: booleanValue("SYMBOL_SPECIALIZATION_ENABLED", true),
    sessionAggressionEnabled: booleanValue("SESSION_AGGRESSION_ENABLED", true),
    tier1MarginMinUsdt: numberValue("TIER1_MARGIN_MIN_USDT", 2, { positive: true }),
    tier1MarginMaxUsdt: numberValue("TIER1_MARGIN_MAX_USDT", 4, { positive: true }),
    tier2MarginMinUsdt: numberValue("TIER2_MARGIN_MIN_USDT", 5, { positive: true }),
    tier2MarginMaxUsdt: numberValue("TIER2_MARGIN_MAX_USDT", 10, { positive: true }),
    tier3MarginMinUsdt: numberValue("TIER3_MARGIN_MIN_USDT", 12, { positive: true }),
    tier3MarginMaxUsdt: numberValue("TIER3_MARGIN_MAX_USDT", 25, { positive: true }),
    explorationRiskAtStopMinPct: numberValue("EXPLORATION_RISK_AT_STOP_MIN_PCT", 0.2, { positive: true }),
    explorationRiskAtStopMaxPct: numberValue("EXPLORATION_RISK_AT_STOP_MAX_PCT", 0.35, { positive: true }),
    normalRiskAtStopMinPct: numberValue("NORMAL_RISK_AT_STOP_MIN_PCT", 0.4, { positive: true }),
    normalRiskAtStopMaxPct: numberValue("NORMAL_RISK_AT_STOP_MAX_PCT", 0.6, { positive: true }),
    strongRiskAtStopMinPct: numberValue("STRONG_RISK_AT_STOP_MIN_PCT", 0.65, { positive: true }),
    strongRiskAtStopMaxPct: numberValue("STRONG_RISK_AT_STOP_MAX_PCT", 0.9, { positive: true }),
    eliteRiskAtStopMinPct: numberValue("ELITE_RISK_AT_STOP_MIN_PCT", 0.9, { positive: true }),
    eliteRiskAtStopMaxPct: numberValue("ELITE_RISK_AT_STOP_MAX_PCT", 1.25, { positive: true }),
    portfolioMaxOpenRiskPct: numberValue("PORTFOLIO_MAX_OPEN_RISK_PCT", 2.6, { positive: true, maximum: 10 }),
    portfolioExplosiveMaxOpenRiskPct: numberValue("PORTFOLIO_EXPLOSIVE_MAX_OPEN_RISK_PCT", 3.5, { positive: true, maximum: 10 }),
    correlatedClusterRiskMultiplier: numberValue("CORRELATED_CLUSTER_RISK_MULTIPLIER", 0.72, { positive: true, maximum: 1 }),
    flipConfirmationMinStrength: numberValue("FLIP_CONFIRMATION_MIN_STRENGTH", 76, { minimum: 0, maximum: 100 }),
    flipMinNetEdgePct: numberValue("FLIP_MIN_NET_EDGE_PCT", 0.28, { minimum: 0 }),
    opportunityCaptureMode: booleanValue("OPPORTUNITY_CAPTURE_MODE", true),
    enablePostOnlyEntries: booleanValue("ENABLE_POST_ONLY_ENTRIES", false),
    postOnlyMaxWaitMs: numberValue("POST_ONLY_MAX_WAIT_MS", 4000, { positive: true, integer: true }),
    breakevenCostCushionPct: numberValue("BREAKEVEN_COST_CUSHION_PCT", 0.08, { minimum: 0 }),
    qualityPacingEnabled: booleanValue("QUALITY_PACING_ENABLED", true),
    qualityPacingMinWinRatePct: numberValue("QUALITY_PACING_MIN_WIN_RATE_PCT", 25, { minimum: 0, maximum: 100 }),
    qualityPacingFeeDragRatio: numberValue("QUALITY_PACING_FEE_DRAG_RATIO", 0.65, { minimum: 0 }),
    qualityPacingMinAverageHoldSeconds: numberValue("QUALITY_PACING_MIN_AVERAGE_HOLD_SECONDS", 45, { minimum: 0 }),
    qualityPacingSignalAdjustment: numberValue("QUALITY_PACING_SIGNAL_ADJUSTMENT", 4, { minimum: 0, maximum: 20 }),
    qualityPacingExplorationAdjustment: numberValue("QUALITY_PACING_EXPLORATION_ADJUSTMENT", 3, { minimum: 0, maximum: 20 }),
    qualityPacingEdgeMultiplier: numberValue("QUALITY_PACING_EDGE_MULTIPLIER", 1.25, { positive: true }),
    qualityPacingRiskMultiplier: numberValue("QUALITY_PACING_RISK_MULTIPLIER", 0.85, { positive: true, maximum: 1 }),
    symbolLossCooldownMinutes: numberValue("SYMBOL_LOSS_COOLDOWN_MINUTES", 30, { minimum: 0 }),
    symbolReentryCooldownSeconds: numberValue("SYMBOL_REENTRY_COOLDOWN_SECONDS", 180, { minimum: 0 }),
    btcTrendAlignmentBonus: numberValue("BTC_TREND_ALIGNMENT_BONUS", 12, { minimum: 0, maximum: 20 }),
    choppyMarketPenalty: numberValue("CHOPPY_MARKET_PENALTY", 10, { minimum: 0, maximum: 30 }),
    lowLiquiditySpikePenalty: numberValue("LOW_LIQUIDITY_SPIKE_PENALTY", 16, { minimum: 0, maximum: 30 }),
    antiChopEnabled: booleanValue("ANTI_CHOP_ENABLED", true),
    maxChopScore: numberValue("MAX_CHOP_SCORE", 3, { minimum: 0, maximum: 10 }),
    minRangeExpansion: numberValue("MIN_RANGE_EXPANSION", 0.72, { positive: true }),
    minDirectionalBodyStrength: numberValue("MIN_DIRECTIONAL_BODY_STRENGTH", 0.45, { positive: true, maximum: 1 }),
    minLiquidityScore: numberValue("MIN_LIQUIDITY_SCORE", 45, { minimum: 0, maximum: 100 }),
    explorationModeEnabled: booleanValue("EXPLORATION_MODE_ENABLED", true),
    explorationTradeRatio: numberValue("EXPLORATION_TRADE_RATIO", 0.55, { minimum: 0, maximum: 1 }),
    explorationMinSignalScore: numberValue("EXPLORATION_MIN_SIGNAL_SCORE", 28, { positive: true, maximum: 100 }),
    explorationMinConvictionScore: numberValue("EXPLORATION_MIN_CONVICTION_SCORE", 34, { positive: true, maximum: 100 }),
    explorationMinProjectedEdgePct: numberValue("EXPLORATION_MIN_PROJECTED_EDGE_PCT", 0.16, { minimum: 0 }),
    explorationMinEdgeToCostRatio: numberValue("EXPLORATION_MIN_EDGE_TO_COST_RATIO", 1.2, { positive: true }),
    explorationRiskMultiplier: numberValue("EXPLORATION_RISK_MULTIPLIER", 0.35, { positive: true, maximum: 1 }),
    explorationMaxChopScore: numberValue("EXPLORATION_MAX_CHOP_SCORE", 6, { minimum: 0, maximum: 10 }),
    explorationMaxTradesPerDay: numberValue("EXPLORATION_MAX_TRADES_PER_DAY", 999999, { minimum: 0, integer: true }),
    marketRegimeIntelligenceEnabled: booleanValue("MARKET_REGIME_INTELLIGENCE_ENABLED", true),
    regimeStrongTrendScore: numberValue("REGIME_STRONG_TREND_SCORE", 55, { positive: true, maximum: 100 }),
    regimeChopSensitivity: numberValue("REGIME_CHOP_SENSITIVITY", 0.82, { positive: true, maximum: 2 }),
    regimeHighVolatilityAtrPct: numberValue("REGIME_HIGH_VOLATILITY_ATR_PCT", 0.7, { positive: true }),
    regimeLowLiquidityVolumeSpike: numberValue("REGIME_LOW_LIQUIDITY_VOLUME_SPIKE", 0.65, { positive: true }),
    regimeDeadMarketAtrPct: numberValue("REGIME_DEAD_MARKET_ATR_PCT", 0.1, { minimum: 0 }),
    regimeDeadMarketVolumeSpike: numberValue("REGIME_DEAD_MARKET_VOLUME_SPIKE", 0.5, { positive: true }),
    regimeFakeBreakoutRangeExpansion: numberValue("REGIME_FAKE_BREAKOUT_RANGE_EXPANSION", 1.65, { positive: true }),
    regimeMemoryWeight: numberValue("REGIME_MEMORY_WEIGHT", 0.18, { minimum: 0, maximum: 1 }),
    profitProtectionEnabled: booleanValue("PROFIT_PROTECTION_ENABLED", true),
    profitProtectionStartPct: numberValue("PROFIT_PROTECTION_START_PCT", 8, { positive: true }),
    profitProtectionRiskMultiplier: numberValue("PROFIT_PROTECTION_RISK_MULTIPLIER", 0.75, { positive: true, maximum: 1 }),
    profitProtectionExplorationMultiplier: numberValue("PROFIT_PROTECTION_EXPLORATION_MULTIPLIER", 0.5, { minimum: 0, maximum: 1 }),
    profitProtectionSignalAdjustment: numberValue("PROFIT_PROTECTION_SIGNAL_ADJUSTMENT", 2, { minimum: 0, maximum: 20 }),
    adaptiveActivityFloorEnabled: booleanValue("ADAPTIVE_ACTIVITY_FLOOR_ENABLED", true),
    activityFloorMinTradesPerDay: numberValue("ACTIVITY_FLOOR_MIN_TRADES_PER_DAY", 18, { positive: true, integer: true }),
    activityFloorMinExplorationBudget: numberValue("ACTIVITY_FLOOR_MIN_EXPLORATION_BUDGET", 4, { minimum: 0, integer: true }),
    activityFloorSignalRelaxPoints: numberValue("ACTIVITY_FLOOR_SIGNAL_RELAX_POINTS", 3, { minimum: 0, maximum: 12 }),
    activityFloorConvictionRelaxPoints: numberValue("ACTIVITY_FLOOR_CONVICTION_RELAX_POINTS", 4, { minimum: 0, maximum: 12 }),
    activityFloorChopToleranceBonus: numberValue("ACTIVITY_FLOOR_CHOP_TOLERANCE_BONUS", 1, { minimum: 0, maximum: 4 }),
    adaptiveLearningEnabled: booleanValue("ADAPTIVE_LEARNING_ENABLED", true),
    minAdaptiveTrades: numberValue("MIN_ADAPTIVE_TRADES", 5, { positive: true, integer: true }),
    minAdaptiveBucketTrades: numberValue("MIN_ADAPTIVE_BUCKET_TRADES", 2, { positive: true, integer: true }),
    adaptiveMemoryMaxTrades: numberValue("ADAPTIVE_MEMORY_MAX_TRADES", 5000, { positive: true, integer: true }),
    defensiveWinRatePct: numberValue("DEFENSIVE_WIN_RATE_PCT", 32, { positive: true, maximum: 100 }),
    aggressiveWinRatePct: numberValue("AGGRESSIVE_WIN_RATE_PCT", 55, { positive: true, maximum: 100 }),
    adaptiveRecoveryWinRatePct: numberValue("ADAPTIVE_RECOVERY_WIN_RATE_PCT", 40, { positive: true, maximum: 100 }),
    adaptiveRecoveryLookbackTrades: numberValue("ADAPTIVE_RECOVERY_LOOKBACK_TRADES", 6, { positive: true, integer: true }),
    adaptiveConfidenceBonusMax: numberValue("ADAPTIVE_CONFIDENCE_BONUS_MAX", 12, { minimum: 0, maximum: 30 }),
    adaptiveConfidencePenaltyMax: numberValue("ADAPTIVE_CONFIDENCE_PENALTY_MAX", 10, { minimum: 0, maximum: 40 }),
    adaptiveConfidenceFloor: numberValue("ADAPTIVE_CONFIDENCE_FLOOR", 22, { positive: true, maximum: 50 }),
    adaptivePenaltyScale: numberValue("ADAPTIVE_PENALTY_SCALE", 0.55, { minimum: 0, maximum: 1 }),
    adaptiveSmallSampleFullWeightTrades: numberValue("ADAPTIVE_SMALL_SAMPLE_FULL_WEIGHT_TRADES", 120, { positive: true, integer: true }),
    adaptiveSmallSampleMinWeight: numberValue("ADAPTIVE_SMALL_SAMPLE_MIN_WEIGHT", 0.2, { minimum: 0, maximum: 1 }),
    explorationMemoryPenaltyMultiplier: numberValue("EXPLORATION_MEMORY_PENALTY_MULTIPLIER", 0.45, { minimum: 0, maximum: 1 }),
    adaptiveBlacklistScorePenalty: numberValue("ADAPTIVE_BLACKLIST_SCORE_PENALTY", 8, { minimum: 0, maximum: 40 }),
    technicalOverrideEnabled: booleanValue("TECHNICAL_OVERRIDE_ENABLED", true),
    technicalOverrideMinConviction: numberValue("TECHNICAL_OVERRIDE_MIN_CONVICTION", 76, { positive: true, maximum: 100 }),
    technicalOverrideMinFeeEdgeRatio: numberValue("TECHNICAL_OVERRIDE_MIN_FEE_EDGE_RATIO", 2.6, { positive: true }),
    technicalOverrideMinProjectedEdgePct: numberValue("TECHNICAL_OVERRIDE_MIN_PROJECTED_EDGE_PCT", 0.85, { minimum: 0 }),
    technicalOverrideMinVolumeSpike: numberValue("TECHNICAL_OVERRIDE_MIN_VOLUME_SPIKE", 1.8, { positive: true }),
    adaptiveBlacklistWinRatePct: numberValue("ADAPTIVE_BLACKLIST_WIN_RATE_PCT", 20, { minimum: 0, maximum: 100 }),
    adaptiveBlacklistMinutes: numberValue("ADAPTIVE_BLACKLIST_MINUTES", 20, { minimum: 0 }),
    adaptiveRiskMinMultiplier: numberValue("ADAPTIVE_RISK_MIN_MULTIPLIER", 0.5, { positive: true, maximum: 1 }),
    adaptiveRiskMaxMultiplier: numberValue("ADAPTIVE_RISK_MAX_MULTIPLIER", 1.3, { positive: true, maximum: 2 }),
    highVolatilityAtrPct: numberValue("HIGH_VOLATILITY_ATR_PCT", 0.8, { positive: true }),
    abnormalVolatilityAtrPct: numberValue("ABNORMAL_VOLATILITY_ATR_PCT", 1.6, { positive: true }),
    lowVolumeMultiple: numberValue("LOW_VOLUME_MULTIPLE", 4, { positive: true }),
    minHoldSecondsBeforeMomentumExit: numberValue("MIN_HOLD_SECONDS_BEFORE_MOMENTUM_EXIT", 180, { minimum: 0 }),
    continuationMinScore: numberValue("CONTINUATION_MIN_SCORE", 62, { minimum: 0, maximum: 100 }),
    continuationMinPnlPct: numberValue("CONTINUATION_MIN_PNL_PCT", 0.35, { minimum: 0 }),
    maxConsecutiveApiErrors: numberValue("MAX_CONSECUTIVE_API_ERRORS", 5, { positive: true, integer: true }),
  };

  if (config.profitControlledEquityMode) {
    config.profitExpansionMode = true;
    config.professionalTrendEngineEnabled = true;
    config.multiTimeframeTrendEngineEnabled = true;
    config.expectancyOptimizerEnabled = true;
    config.nearMissLearningEnabled = true;
    config.edgeMaximizationMode = true;
    config.edgeReinforcementMode = true;
    config.adaptiveEdgeActivityRecoveryMode = true;
    config.trendDominanceMode = true;
    config.aggressiveAdaptiveMode = true;
    config.v11ActiveMarketEngine = true;
    config.v11MeanReversionEnabled = true;
    config.inactivityRecoveryMode = true;
    config.participationRecoveryMode = true;
    config.nearMissSmallTradeEnabled = true;
    config.nearMissMaxPointGap = Math.min(config.nearMissMaxPointGap, config.v11NearMissReevaluationMaxGap);
    if (config.aggressiveAdaptiveMode) {
      config.profitControlledNormalMaxStopRiskPct = Math.max(
        config.profitControlledNormalMaxStopRiskPct,
        config.aggressiveAdaptiveNormalStopRiskPct
      );
      config.profitControlledStrongMaxStopRiskPct = Math.max(
        config.profitControlledStrongMaxStopRiskPct,
        config.aggressiveAdaptiveStrongStopRiskPct
      );
      config.profitControlledEliteMaxStopRiskPct = Math.max(
        config.profitControlledEliteMaxStopRiskPct,
        config.aggressiveAdaptiveEliteStopRiskPct
      );
      config.normalRiskAtStopMaxPct = Math.max(config.normalRiskAtStopMaxPct, config.aggressiveAdaptiveNormalStopRiskPct);
      config.strongRiskAtStopMaxPct = Math.max(config.strongRiskAtStopMaxPct, config.aggressiveAdaptiveStrongStopRiskPct);
      config.eliteRiskAtStopMaxPct = Math.max(config.eliteRiskAtStopMaxPct, config.aggressiveAdaptiveEliteStopRiskPct);
      config.asymmetricRunnerWeakTp1Pct = Math.min(config.asymmetricRunnerWeakTp1Pct, 40);
      config.asymmetricRunnerStrongTp1Pct = Math.min(config.asymmetricRunnerStrongTp1Pct, 15);
      config.asymmetricRunnerEliteTp1Pct = Math.min(config.asymmetricRunnerEliteTp1Pct, 5);
    }
    config.winnerAmplifierEnabled = true;
    config.winnerAmplifierPartialTakeProfitPct = 30;
    config.tradeFrequencyRecoveryMode = true;
    config.minSignalScore = Math.min(config.minSignalScore, config.tradeFrequencyRecoveryMinSignalScore);
    config.minConvictionScore = Math.min(config.minConvictionScore, config.tradeFrequencyRecoveryMinConvictionScore);
    config.antiChopPenaltyMax = Math.min(config.antiChopPenaltyMax, 10);
    config.antiChopConvictionPenaltyMax = Math.min(config.antiChopConvictionPenaltyMax, 10);
    config.learningPhaseMode = false;
    config.aggressiveLearningPhase = false;
    config.forcedMarketSamplingEnabled = false;
    config.forcedExecutionSamplingActive = false;
    config.fomoBreakoutMode = false;
    config.microBreakoutEntries = false;
    config.unconfirmedMicroBreakoutEntries = false;
    config.allowChoppyMarket = false;
    config.allowChoppyMarketUnconditionally = false;
    config.unlimitedExplorationBudget = false;
    config.explorationModeEnabled = false;
    config.explorationTradeRatio = 0;
    config.explorationMaxTradesPerDay = 0;
    config.adaptiveActivityFloorEnabled = false;
    config.disableDailyTradeLimits = true;
    config.dailyTradeLimitsDisabled = true;
    config.continuousExecutionMode = true;
    config.highActivityMode = true;
    config.enablePostOnlyEntries = true;
    config.maxLeverage = Math.min(config.maxLeverage, config.profitControlledMaxLeverage);
  }

  if (config.activeAdaptiveScalperMode) {
    config.minSignalScore = Math.min(config.minSignalScore, config.activeScalperMinSignalScore);
    config.minConvictionScore = Math.min(config.minConvictionScore, config.activeScalperMinConvictionScore);
    config.explorationMinSignalScore = Math.min(config.explorationMinSignalScore, config.activeScalperExplorationMinSignalScore);
    config.explorationMinConvictionScore = Math.min(config.explorationMinConvictionScore, config.activeScalperExplorationMinConvictionScore);
    config.symbolLossCooldownMinutes = Math.min(config.symbolLossCooldownMinutes, config.activeScalperMaxLossCooldownMinutes);
    config.symbolReentryCooldownSeconds = Math.min(config.symbolReentryCooldownSeconds, config.activeScalperMaxReentryCooldownSeconds);
    config.confidenceSizingEnabled = true;
    config.participationRecoveryMode = true;
    config.learningPhaseMode = true;
    config.aggressiveLearningPhase = false;
    config.highActivityMode = true;
    config.continuousExecutionMode = false;
    config.disableDailyTradeLimits = true;
    config.dailyTradeLimitsDisabled = true;
    config.paperTradingMode = true;
  }

  if (config.swingMomentumMode) {
    config.focusedTradingSymbolsList = [...FOCUSED_TRADING_SYMBOLS];
    config.focusedTradingSymbols = new Set(FOCUSED_TRADING_SYMBOLS);
    config.maxDeployableCapitalUsdt = config.maxDeployableCapitalUsdt > 0
      ? config.maxDeployableCapitalUsdt
      : 64;
    if (!process.env.CANDLE_INTERVAL_FAST) config.candleIntervalFast = "15M";
    if (!process.env.CANDLE_INTERVAL_MAIN) config.candleIntervalMain = "60M";
    if (!process.env.CANDLE_INTERVAL_TREND) config.candleIntervalTrend = "240M";
    if (!process.env.CANDLE_INTERVAL_MACRO) config.candleIntervalMacro = "1D";
    if (!process.env.CANDLE_INTERVAL_MACRO_LONG) config.candleIntervalMacroLong = "1D";
    config.fastMode = false;
    config.fomoBreakoutMode = false;
    config.microBreakoutEntries = false;
    config.forcedMarketSamplingEnabled = false;
    config.forcedExecutionSamplingActive = false;
    config.v11MeanReversionEnabled = false;
    config.learningPhaseMode = false;
    config.aggressiveLearningPhase = false;
    config.highActivityMode = true;
    config.continuationEngineEnabled = true;
    config.pullbackContinuationEnabled = true;
    config.retestEntryEnabled = true;
    config.momentumResumptionEnabled = true;
    config.trendAccelerationEnabled = true;
    config.minSignalScore = Math.min(config.minSignalScore, 40);
    config.minConvictionScore = Math.min(config.minConvictionScore, 42);
    config.continuationMinStrength = Math.min(config.continuationMinStrength, 52);
    config.continuationMinScore = Math.min(config.continuationMinScore, 56);
    config.minMomentumPersistenceCandles = Math.min(config.minMomentumPersistenceCandles, 2);
    config.takeProfitPct = Math.max(config.takeProfitPct, config.swingTakeProfitPct);
    config.stopLossPct = Math.max(config.stopLossPct, config.swingStopLossPct);
    config.trailingStartPct = Math.max(config.trailingStartPct, config.swingTrailingStartPct);
    config.trailingDistancePct = Math.max(config.trailingDistancePct, config.swingTrailingDistancePct);
    config.runnerAtrTrailingMultiplier = Math.max(config.runnerAtrTrailingMultiplier, config.swingRunnerAtrTrailingMultiplier);
    config.minHoldSecondsBeforeMomentumExit = Math.max(config.minHoldSecondsBeforeMomentumExit, config.swingMinimumHoldSeconds);
    config.swingProfitExitMinHoldSeconds = Math.max(config.swingProfitExitMinHoldSeconds, config.swingMinimumHoldSeconds);
    config.swingTrendExitMinHoldSeconds = Math.max(config.swingTrendExitMinHoldSeconds, config.swingThesisFailureMinHoldSeconds);
    config.scanIntervalMs = Math.max(config.scanIntervalMs, config.swingScanIntervalMs);
    config.positionMonitorIntervalMs = Math.max(config.positionMonitorIntervalMs, config.swingPositionMonitorIntervalMs);
    config.maxOpenPositions = Math.max(
      config.maxOpenPositions,
      Math.min(10, config.focusedTradingSymbolsList.length * config.maxPositionsPerSymbol)
    );
    config.normalRiskAtStopMaxPct = Math.max(config.normalRiskAtStopMaxPct, 0.9);
    config.strongRiskAtStopMaxPct = Math.max(config.strongRiskAtStopMaxPct, 1.5);
    config.eliteRiskAtStopMaxPct = Math.max(config.eliteRiskAtStopMaxPct, 2);
    config.tier1MarginMinUsdt = Math.max(config.tier1MarginMinUsdt, config.swingMinTargetMarginUsdt * 0.6);
    config.tier1MarginMaxUsdt = Math.max(config.tier1MarginMaxUsdt, config.swingNormalTargetMarginUsdt);
    config.tier2MarginMinUsdt = Math.max(config.tier2MarginMinUsdt, config.swingMinTargetMarginUsdt);
    config.tier2MarginMaxUsdt = Math.max(config.tier2MarginMaxUsdt, config.swingStrongTargetMarginUsdt);
    config.tier2MarginMaxUsdt = Math.max(config.tier2MarginMaxUsdt, config.maxDeployableCapitalUsdt * 0.25);
    config.tier3MarginMinUsdt = Math.max(config.tier3MarginMinUsdt, config.maxDeployableCapitalUsdt * 0.25);
    config.tier3MarginMinUsdt = Math.max(config.tier3MarginMinUsdt, config.swingStrongTargetMarginUsdt);
    config.tier3MarginMaxUsdt = Math.max(config.tier3MarginMaxUsdt, config.maxDeployableCapitalUsdt * 0.45, config.swingEliteTargetMarginUsdt);
    config.maxPositionNotionalUsdt = Math.max(config.maxPositionNotionalUsdt, config.tier3MarginMaxUsdt * Math.max(1, config.maxLeverage));
    config.explorationModeEnabled = false;
    config.explorationTradeRatio = 0;
    config.allowChoppyMarket = false;
    config.allowChoppyMarketUnconditionally = false;
  }

  if (config.trendPortfolioMode) {
    config.focusedTradingSymbolsList = [...FOCUSED_TRADING_SYMBOLS];
    config.focusedTradingSymbols = new Set(FOCUSED_TRADING_SYMBOLS);
    config.maxLeverage = Math.max(config.maxLeverage, 10);
    config.maxDeployableCapitalUsdt = config.maxDeployableCapitalUsdt > 0
      ? config.maxDeployableCapitalUsdt
      : 64;
    config.maxPositionsPerSymbol = Math.max(config.maxPositionsPerSymbol, 3);
    if (!process.env.CANDLE_INTERVAL_FAST) config.candleIntervalFast = "15M";
    if (!process.env.CANDLE_INTERVAL_MAIN) config.candleIntervalMain = "60M";
    if (!process.env.CANDLE_INTERVAL_TREND) config.candleIntervalTrend = "240M";
    if (!process.env.CANDLE_INTERVAL_MACRO) config.candleIntervalMacro = "1D";
    if (!process.env.CANDLE_INTERVAL_MACRO_LONG) config.candleIntervalMacroLong = "1D";
    config.fastMode = false;
    config.fomoBreakoutMode = false;
    config.microBreakoutEntries = false;
    config.forcedMarketSamplingEnabled = false;
    config.forcedExecutionSamplingActive = false;
    config.learningPhaseMode = false;
    config.aggressiveLearningPhase = false;
    config.multiStrategyPortfolioEngineEnabled = true;
    config.activeOpportunityMode = true;
    config.quantResearchPlatformMode = true;
    config.quantIntelligenceEngineMode = true;
    config.institutionalQuantEngineMode = true;
    config.explorationModeEnabled = false;
    config.explorationTradeRatio = 0;
    config.allowChoppyMarket = false;
    config.allowChoppyMarketUnconditionally = false;
    config.highActivityMode = false;
    config.continuationEngineEnabled = true;
    config.pullbackContinuationEnabled = true;
    config.retestEntryEnabled = true;
    config.momentumResumptionEnabled = true;
    config.trendAccelerationEnabled = true;
    config.takeProfitPct = Math.max(config.takeProfitPct, 8);
    config.stopLossPct = Math.max(config.stopLossPct, 2.4);
    config.trailingStartPct = Math.max(config.trailingStartPct, 3.2);
    config.trailingDistancePct = Math.max(config.trailingDistancePct, 1.8);
    config.minHoldSecondsBeforeMomentumExit = Math.max(config.minHoldSecondsBeforeMomentumExit, 7200);
    config.swingMinimumHoldSeconds = Math.max(config.swingMinimumHoldSeconds, 7200);
    config.swingProfitExitMinHoldSeconds = Math.max(config.swingProfitExitMinHoldSeconds, 7200);
    config.swingThesisFailureMinHoldSeconds = Math.max(config.swingThesisFailureMinHoldSeconds, 7200);
    config.swingTrendExitMinHoldSeconds = Math.max(config.swingTrendExitMinHoldSeconds, 14400);
    config.swingMaxHoldSeconds = Math.max(config.swingMaxHoldSeconds, 259200);
    config.swingDisableNativeTakeProfit = true;
    config.scanIntervalMs = Math.max(config.scanIntervalMs, 60000);
    config.positionMonitorIntervalMs = Math.max(config.positionMonitorIntervalMs, 60000);
    config.maxOpenPositions = Math.max(
      config.maxOpenPositions,
      Math.min(10, config.focusedTradingSymbolsList.length * config.maxPositionsPerSymbol)
    );
    config.tier1MarginMinUsdt = Math.max(config.tier1MarginMinUsdt, 10);
    config.tier1MarginMaxUsdt = Math.max(config.tier1MarginMaxUsdt, 18);
    config.swingStrongTargetMarginUsdt = Math.max(config.swingStrongTargetMarginUsdt, config.maxDeployableCapitalUsdt * 0.55);
    config.swingEliteTargetMarginUsdt = Math.max(config.swingEliteTargetMarginUsdt, config.maxDeployableCapitalUsdt * 0.85);
    config.tier2MarginMinUsdt = Math.max(config.tier2MarginMinUsdt, 24);
    config.tier2MarginMaxUsdt = Math.max(config.tier2MarginMaxUsdt, config.maxDeployableCapitalUsdt * 0.6);
    config.tier3MarginMinUsdt = Math.max(config.tier3MarginMinUsdt, config.maxDeployableCapitalUsdt * 0.5);
    config.tier3MarginMaxUsdt = Math.max(config.tier3MarginMaxUsdt, config.maxDeployableCapitalUsdt * 0.88);
    config.maxPositionNotionalUsdt = Math.max(config.maxPositionNotionalUsdt, config.tier3MarginMaxUsdt * Math.max(1, config.maxLeverage));
  }

  const supportedIntervals = new Set(["1M", "3M", "5M", "15M", "30M", "60M", "120M", "240M", "360M", "720M", "1D", "1W", "1MO"]);
  for (const interval of [config.candleIntervalFast, config.candleIntervalMain, config.candleIntervalTrend, config.candleIntervalMacro, config.candleIntervalMacroLong]) {
    if (!supportedIntervals.has(interval.toUpperCase())) throw new Error(`Unsupported candle interval: ${interval}.`);
  }
  if (config.maxMarginUsagePct > config.maxTotalMarginUsagePct) {
    throw new Error("MAX_MARGIN_USAGE_PCT cannot exceed MAX_TOTAL_MARGIN_USAGE_PCT.");
  }
  if (config.aggressiveRiskPerTradePct < config.baseRiskPerTradePct) {
    throw new Error("AGGRESSIVE_RISK_PER_TRADE_PCT must be at least BASE_RISK_PER_TRADE_PCT.");
  }
  if (config.explorationMinSignalScore > config.minSignalScore) {
    throw new Error("EXPLORATION_MIN_SIGNAL_SCORE cannot exceed MIN_SIGNAL_SCORE.");
  }
  if (config.explorationMinConvictionScore > config.minConvictionScore) {
    throw new Error("EXPLORATION_MIN_CONVICTION_SCORE cannot exceed MIN_CONVICTION_SCORE.");
  }
  if (config.explorationMinProjectedEdgePct > config.minProjectedEdgePct) {
    throw new Error("EXPLORATION_MIN_PROJECTED_EDGE_PCT cannot exceed MIN_PROJECTED_EDGE_PCT.");
  }
  if (config.explorationMinEdgeToCostRatio > config.minEdgeToCostRatio) {
    throw new Error("EXPLORATION_MIN_EDGE_TO_COST_RATIO cannot exceed MIN_EDGE_TO_COST_RATIO.");
  }
  for (const [minKey, maxKey] of [
    ["tier1MarginMinUsdt", "tier1MarginMaxUsdt"],
    ["tier2MarginMinUsdt", "tier2MarginMaxUsdt"],
    ["tier3MarginMinUsdt", "tier3MarginMaxUsdt"],
    ["explorationRiskAtStopMinPct", "explorationRiskAtStopMaxPct"],
    ["normalRiskAtStopMinPct", "normalRiskAtStopMaxPct"],
    ["strongRiskAtStopMinPct", "strongRiskAtStopMaxPct"],
    ["eliteRiskAtStopMinPct", "eliteRiskAtStopMaxPct"],
  ]) {
    if (config[minKey] > config[maxKey]) {
      throw new Error(`${minKey.toUpperCase()} cannot exceed ${maxKey.toUpperCase()}.`);
    }
  }
  if (config.regimeDeadMarketVolumeSpike > config.regimeLowLiquidityVolumeSpike) {
    throw new Error("REGIME_DEAD_MARKET_VOLUME_SPIKE cannot exceed REGIME_LOW_LIQUIDITY_VOLUME_SPIKE.");
  }
  if (config.regimeDeadMarketAtrPct > config.regimeHighVolatilityAtrPct) {
    throw new Error("REGIME_DEAD_MARKET_ATR_PCT cannot exceed REGIME_HIGH_VOLATILITY_ATR_PCT.");
  }
  if (config.apiRecoveryBaseBackoffMs > config.apiRecoveryMaxBackoffMs) {
    throw new Error("API_RECOVERY_BASE_BACKOFF_MS cannot exceed API_RECOVERY_MAX_BACKOFF_MS.");
  }
  if (config.adaptiveSmallSampleMinWeight > 1) {
    throw new Error("ADAPTIVE_SMALL_SAMPLE_MIN_WEIGHT cannot exceed 1.");
  }
  if (!config.allowLongs && !config.allowShorts) {
    throw new Error("At least one of ALLOW_LONGS or ALLOW_SHORTS must be true.");
  }
  if (config.liveValidationMode && config.profitControlledEquityMode) {
    throw new Error("LIVE_VALIDATION_MODE and PROFIT_CONTROLLED_EQUITY_MODE are separate launch profiles; enable only one.");
  }
  if (config.activeAdaptiveScalperMode && (config.liveValidationMode || config.profitControlledEquityMode)) {
    throw new Error("ACTIVE_ADAPTIVE_SCALPER_MODE is a paper-only profile; do not combine it with live validation or profit-controlled live modes.");
  }
  if (config.activeAdaptiveScalperMode && config.swingMomentumMode) {
    throw new Error("SWING_MOMENTUM_MODE is a medium-term profile and cannot be combined with ACTIVE_ADAPTIVE_SCALPER_MODE.");
  }
  if (config.trendPortfolioMode && (config.activeAdaptiveScalperMode || config.swingMomentumMode)) {
    throw new Error("TREND_PORTFOLIO_MODE is an independent V14 trend profile; do not combine it with scalper or V13 swing modes.");
  }
  if (config.swingMomentumMode && config.maxDeployableCapitalUsdt <= 0) {
    throw new Error("SWING_MOMENTUM_MODE requires MAX_DEPLOYABLE_CAPITAL_USDT to resolve to a positive budget.");
  }
  if (config.trendPortfolioMode && config.maxDeployableCapitalUsdt <= 0) {
    throw new Error("TREND_PORTFOLIO_MODE requires MAX_DEPLOYABLE_CAPITAL_USDT to resolve to a positive budget.");
  }
  if (config.activeAdaptiveScalperMode && !config.dryRun) {
    throw new Error("ACTIVE_ADAPTIVE_SCALPER_MODE requires DRY_RUN=true. Paper trading must be validated before live deployment.");
  }
  if (config.confidenceSmallMinScore > config.confidenceNormalMinScore || config.confidenceNormalMinScore > config.confidenceLargeMinScore) {
    throw new Error("Confidence sizing thresholds must be ordered: small <= normal <= large.");
  }
  if (config.profitControlledEquityMode && config.dryRun) {
    throw new Error("PROFIT_CONTROLLED_EQUITY_MODE=true is a real-money profile and requires DRY_RUN=false.");
  }
  if (config.profitControlledEquityMode && (config.bybitDemoTrading || config.bybitTestnet)) {
    throw new Error("PROFIT_CONTROLLED_EQUITY_MODE=true requires BYBIT_DEMO_TRADING=false and BYBIT_TESTNET=false.");
  }
  if (config.profitControlledEquityMode && !config.acknowledgeProfitControlledLiveRisk) {
    throw new Error(`${PROFIT_CONTROLLED_ACK_MESSAGE}: set ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK=true deliberately.`);
  }
  if (config.profitControlledEquityMode && !config.acknowledgeLiveTrading) {
    throw new Error(`${PROFIT_CONTROLLED_ACK_MESSAGE}: set ACKNOWLEDGE_LIVE_TRADING=true deliberately.`);
  }
  if (config.profitControlledEquityMode && hostname(config.restBaseUrl) !== "api.bybit.com") {
    throw new Error("PROFIT_CONTROLLED_EQUITY_MODE requires the live mainnet REST endpoint https://api.bybit.com.");
  }
  if (config.profitControlledEquityMode && hostname(config.privateWsBaseUrl) !== "stream.bybit.com") {
    throw new Error("PROFIT_CONTROLLED_EQUITY_MODE requires the live mainnet private WebSocket endpoint wss://stream.bybit.com.");
  }
  if (config.profitControlledEquityMode && hostname(config.publicWsBaseUrl) !== "stream.bybit.com") {
    throw new Error("PROFIT_CONTROLLED_EQUITY_MODE requires the live mainnet public WebSocket endpoint wss://stream.bybit.com.");
  }
  if (config.maxCorrelatedClusterStopRiskPct > config.maxTotalOpenStopRiskPct) {
    throw new Error("MAX_CORRELATED_CLUSTER_STOP_RISK_PCT cannot exceed MAX_TOTAL_OPEN_STOP_RISK_PCT.");
  }
  if (config.v18MinStrategyAllocationWeight > config.v18MaxStrategyAllocationWeight) {
    throw new Error("V18_MIN_STRATEGY_ALLOCATION_WEIGHT cannot exceed V18_MAX_STRATEGY_ALLOCATION_WEIGHT.");
  }
  if (config.profitControlledStrongOnlyDrawdownPct < config.profitControlledReducedDrawdownPct) {
    throw new Error("PROFIT_CONTROLLED_STRONG_ONLY_DRAWDOWN_PCT cannot be below PROFIT_CONTROLLED_REDUCED_DRAWDOWN_PCT.");
  }
  if (config.profitControlledProtectionDrawdownPct < config.profitControlledStrongOnlyDrawdownPct) {
    throw new Error("PROFIT_CONTROLLED_PROTECTION_DRAWDOWN_PCT cannot be below PROFIT_CONTROLLED_STRONG_ONLY_DRAWDOWN_PCT.");
  }
  if (config.profitModeStrongQualityScore < config.profitModeMinQualityScore) {
    throw new Error("PROFIT_MODE_STRONG_QUALITY_SCORE cannot be below PROFIT_MODE_MIN_QUALITY_SCORE.");
  }
  if (config.profitModeEliteQualityScore < config.profitModeStrongQualityScore) {
    throw new Error("PROFIT_MODE_ELITE_QUALITY_SCORE cannot be below PROFIT_MODE_STRONG_QUALITY_SCORE.");
  }
  if (config.asymmetricRunnerStrongTp1Pct > config.asymmetricRunnerWeakTp1Pct) {
    throw new Error("ASYMMETRIC_RUNNER_STRONG_TP1_PCT cannot exceed ASYMMETRIC_RUNNER_WEAK_TP1_PCT.");
  }
  if (config.asymmetricRunnerEliteTp1Pct > config.asymmetricRunnerStrongTp1Pct) {
    throw new Error("ASYMMETRIC_RUNNER_ELITE_TP1_PCT cannot exceed ASYMMETRIC_RUNNER_STRONG_TP1_PCT.");
  }
  if (config.liveValidationMode && config.dryRun) {
    throw new Error("LIVE_VALIDATION_MODE=true is a real-money validation profile and requires DRY_RUN=false.");
  }
  if (config.liveValidationMode && (config.bybitDemoTrading || config.bybitTestnet)) {
    throw new Error("LIVE_VALIDATION_MODE=true requires BYBIT_DEMO_TRADING=false and BYBIT_TESTNET=false.");
  }
  if (config.liveValidationMode && !config.acknowledgeLiveValidationRisk) {
    throw new Error(`${LIVE_VALIDATION_ACK_MESSAGE}: set ACKNOWLEDGE_LIVE_VALIDATION_RISK=true deliberately.`);
  }
  if (config.liveValidationMode && !config.acknowledgeLiveTrading) {
    throw new Error(`${LIVE_VALIDATION_ACK_MESSAGE}: set ACKNOWLEDGE_LIVE_TRADING=true deliberately.`);
  }
  if (config.liveValidationMode && config.liveValidationMaxAllocatedEquityUsdt > 10) {
    throw new Error("LIVE_VALIDATION_MAX_ALLOCATED_EQUITY_USDT cannot exceed 10 during initial validation launch.");
  }
  if (config.liveValidationMode && hostname(config.restBaseUrl) !== "api.bybit.com") {
    throw new Error("LIVE_VALIDATION_MODE requires the live mainnet REST endpoint https://api.bybit.com.");
  }
  if (config.liveValidationMode && hostname(config.privateWsBaseUrl) !== "stream.bybit.com") {
    throw new Error("LIVE_VALIDATION_MODE requires the live mainnet private WebSocket endpoint wss://stream.bybit.com.");
  }
  if (config.liveValidationMode && hostname(config.publicWsBaseUrl) !== "stream.bybit.com") {
    throw new Error("LIVE_VALIDATION_MODE requires the live mainnet public WebSocket endpoint wss://stream.bybit.com.");
  }
  if (config.bybitDemoTrading && config.bybitTestnet) {
    throw new Error("BYBIT_DEMO_TRADING=true requires BYBIT_TESTNET=false. Demo Trading is separate from Bybit testnet.");
  }
  if (config.bybitDemoTrading && hostname(config.restBaseUrl) !== "api-demo.bybit.com") {
    throw new Error("Demo trading requires BYBIT_REST_BASE_URL to be blank or https://api-demo.bybit.com.");
  }
  if (config.bybitDemoTrading && hostname(config.privateWsBaseUrl) !== "stream-demo.bybit.com") {
    throw new Error("Demo trading requires BYBIT_PRIVATE_WS_BASE_URL/BYBIT_WS_BASE_URL to be blank or wss://stream-demo.bybit.com.");
  }
  if (config.bybitDemoTrading && hostname(config.publicWsBaseUrl) !== "stream.bybit.com") {
    throw new Error("Demo trading requires public market WebSocket to use wss://stream.bybit.com.");
  }
  if (config.bybitDemoTrading && config.acknowledgeLiveTrading) {
    throw new Error("Demo trading refuses to start while ACKNOWLEDGE_LIVE_TRADING=true. Use demo credentials and the npm run demo launch path.");
  }
  if (!config.dryRun && config.bybitDemoTrading && !config.acknowledgeDemoTrading) {
    throw new Error("Bybit Demo Trading orders require ACKNOWLEDGE_DEMO_TRADING=true.");
  }
  if (!config.dryRun && !config.bybitDemoTrading && !config.bybitTestnet && !config.acknowledgeLiveTrading) {
    throw new Error("Mainnet trading requires ACKNOWLEDGE_LIVE_TRADING=true.");
  }
  if (!config.dryRun && (!config.apiKey || !config.apiSecret)) {
    throw new Error("DRY_RUN=false requires BYBIT_API_KEY and BYBIT_API_SECRET.");
  }
  if (!config.dryRun && config.maxLeverage > 3 && !config.acknowledgeHighLeverageRisk) {
    throw new Error("Trading above 3x leverage requires ACKNOWLEDGE_HIGH_LEVERAGE_RISK=true.");
  }
  if (Boolean(config.telegramBotToken) !== Boolean(config.telegramChatId)) {
    throw new Error("Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or leave both empty.");
  }

  return Object.freeze(config);
}

module.exports = { loadConfig };
