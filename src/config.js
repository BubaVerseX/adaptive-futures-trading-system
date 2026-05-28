"use strict";

require("dotenv").config();

const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");

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

function optionalPositiveNumber(name) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number when set; received "${raw}".`);
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

function loadConfig() {
  const bybitTestnet = booleanValue("BYBIT_TESTNET", true);
  const config = {
    projectRoot: PROJECT_ROOT,
    stateFile: path.join(PROJECT_ROOT, "data", "state.json"),
    tradesFile: path.join(PROJECT_ROOT, "data", "trades.json"),
    tradeMemoryFile: path.join(PROJECT_ROOT, "data", "tradeMemory.json"),
    analyticsFile: path.join(PROJECT_ROOT, "data", "analytics.json"),
    logFile: path.join(PROJECT_ROOT, "data", "bybit-bot.log"),
    emergencyStopFile: path.join(PROJECT_ROOT, path.basename(process.env.EMERGENCY_STOP_FILE || "STOP_BOT.txt")),
    apiKey: process.env.BYBIT_API_KEY || "",
    apiSecret: process.env.BYBIT_API_SECRET || "",
    bybitTestnet,
    restBaseUrl: String(
      process.env.BYBIT_REST_BASE_URL || (bybitTestnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com")
    ).replace(/\/$/, ""),
    wsBaseUrl: String(
      process.env.BYBIT_WS_BASE_URL || (bybitTestnet ? "wss://stream-testnet.bybit.com" : "wss://stream.bybit.com")
    ).replace(/\/$/, ""),
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
    disableDailyTradeLimits: booleanValue("DISABLE_DAILY_TRADE_LIMITS", true),
    forcedMarketSamplingEnabled: booleanValue("FORCED_MARKET_SAMPLING_ENABLED", true),
    forcedMarketSamplingAfterMinutes: numberValue("FORCED_MARKET_SAMPLING_AFTER_MINUTES", 15, { positive: true }),
    forcedSamplingMaxCandidates: numberValue("FORCED_SAMPLING_MAX_CANDIDATES", 2, { positive: true, integer: true, maximum: 10 }),
    forcedSamplingMinScore: numberValue("FORCED_SAMPLING_MIN_SCORE", 25, { positive: true, maximum: 100 }),
    forcedSamplingMinConviction: numberValue("FORCED_SAMPLING_MIN_CONVICTION", 30, { positive: true, maximum: 100 }),
    forcedSamplingMinProjectedEdgePct: numberValue("FORCED_SAMPLING_MIN_PROJECTED_EDGE_PCT", 0.05, { minimum: 0 }),
    forcedSamplingMinEdgeToCostRatio: numberValue("FORCED_SAMPLING_MIN_EDGE_TO_COST_RATIO", 1.0, { positive: true }),
    fastMode: booleanValue("FAST_MODE", true),
    fomoBreakoutMode: booleanValue("FOMO_BREAKOUT_MODE", true),
    microBreakoutEntries: booleanValue("MICRO_BREAKOUT_ENTRIES", true),
    allowChoppyMarket: booleanValue("ALLOW_CHOPPY_MARKET", true),
    allowPartialScanEntries: booleanValue("ALLOW_PARTIAL_SCAN_ENTRIES", true),
    maxOpenPositions: numberValue("MAX_OPEN_POSITIONS", 3, { positive: true, integer: true, maximum: 10 }),
    maxTradesPerDay: numberValue("MAX_TRADES_PER_DAY", 40, { positive: true, integer: true }),
    baseRiskPerTradePct: numberValue("BASE_RISK_PER_TRADE_PCT", 4, { positive: true }),
    aggressiveRiskPerTradePct: numberValue("AGGRESSIVE_RISK_PER_TRADE_PCT", 8, { positive: true }),
    aggressiveScoreThreshold: numberValue("AGGRESSIVE_SCORE_THRESHOLD", 72, { positive: true, maximum: 100 }),
    maxDailyLossPct: numberValue("MAX_DAILY_LOSS_PCT", 20, { positive: true }),
    maxDailyLossUsdt: optionalPositiveNumber("MAX_DAILY_LOSS_USDT"),
    maxLeverage: numberValue("MAX_LEVERAGE", 8, { positive: true, maximum: 15 }),
    setLeverageOnEntry: booleanValue("SET_LEVERAGE_ON_ENTRY", true),
    acknowledgeHighLeverageRisk: booleanValue("ACKNOWLEDGE_HIGH_LEVERAGE_RISK", false),
    acknowledgeLiveTrading: booleanValue("ACKNOWLEDGE_LIVE_TRADING", false),
    allowShorts: booleanValue("ALLOW_SHORTS", true),
    allowLongs: booleanValue("ALLOW_LONGS", true),
    scanIntervalMs: numberValue("SCAN_INTERVAL_MS", 2000, { positive: true, integer: true }),
    positionMonitorIntervalMs: numberValue("POSITION_MONITOR_INTERVAL_MS", 2000, { positive: true, integer: true }),
    entryConfirmationTimeoutMs: numberValue("ENTRY_CONFIRMATION_TIMEOUT_MS", 15000, { positive: true, integer: true }),
    scanConcurrency: numberValue("SCAN_CONCURRENCY", 4, { positive: true, integer: true, maximum: 10 }),
    marketRegimeCacheMs: numberValue("MARKET_REGIME_CACHE_MS", 120000, { positive: true, integer: true }),
    apiRequestIntervalMs: numberValue("API_REQUEST_INTERVAL_MS", 70, { positive: true, integer: true }),
    apiRateLimitCooldownMs: numberValue("API_RATE_LIMIT_COOLDOWN_MS", 10000, { positive: true, integer: true }),
    wsReconnectBaseMs: numberValue("WS_RECONNECT_BASE_MS", 1000, { positive: true, integer: true }),
    candleIntervalFast: String(process.env.CANDLE_INTERVAL_FAST || "1M").trim(),
    candleIntervalMain: String(process.env.CANDLE_INTERVAL_MAIN || "5M").trim(),
    candleIntervalTrend: String(process.env.CANDLE_INTERVAL_TREND || "15M").trim(),
    maxSymbolsToScan: numberValue("MAX_SYMBOLS_TO_SCAN", 120, { positive: true, integer: true }),
    min24hVolumeUsdt: numberValue("MIN_24H_VOLUME_USDT", 1000000, { minimum: 0 }),
    maxSpreadPct: numberValue("MAX_SPREAD_PCT", 0.6, { positive: true }),
    excludedSymbols: symbolsSet("EXCLUDED_SYMBOLS"),
    takeProfitPct: numberValue("TAKE_PROFIT_PCT", 2.1, { positive: true }),
    stopLossPct: numberValue("STOP_LOSS_PCT", 0.8, { positive: true }),
    trailingStopEnabled: booleanValue("TRAILING_STOP_ENABLED", true),
    trailingStartPct: numberValue("TRAILING_START_PCT", 0.9, { positive: true }),
    trailingDistancePct: numberValue("TRAILING_DISTANCE_PCT", 0.45, { positive: true }),
    minSignalScore: numberValue("MIN_SIGNAL_SCORE", 40, { positive: true, maximum: 100 }),
    closePositionOnExit: booleanValue("CLOSE_POSITION_ON_EXIT", true),
    maxPositionNotionalUsdt: numberValue("MAX_POSITION_NOTIONAL_USDT", 150, { positive: true }),
    maxMarginUsagePct: numberValue("MAX_MARGIN_USAGE_PCT", 55, { positive: true, maximum: 95 }),
    maxTotalMarginUsagePct: numberValue("MAX_TOTAL_MARGIN_USAGE_PCT", 90, { positive: true, maximum: 95 }),
    minLiquidationBufferPct: numberValue("MIN_LIQUIDATION_BUFFER_PCT", 2, { positive: true }),
    minVolumeSpike: numberValue("MIN_VOLUME_SPIKE", 1.15, { positive: true }),
    minBurstMomentumPct: numberValue("MIN_BURST_MOMENTUM_PCT", 0.07, { positive: true }),
    fomoMomentumPct: numberValue("FOMO_MOMENTUM_PCT", 0.16, { positive: true }),
    minMomentumPersistenceCandles: numberValue("MIN_MOMENTUM_PERSISTENCE_CANDLES", 2, { positive: true, integer: true, maximum: 6 }),
    estimatedFeePctPerSide: numberValue("ESTIMATED_FEE_PCT_PER_SIDE", 0.055, { minimum: 0 }),
    estimatedSlippagePct: numberValue("ESTIMATED_SLIPPAGE_PCT", 0.08, { minimum: 0 }),
    minProjectedEdgePct: numberValue("MIN_PROJECTED_EDGE_PCT", 0.35, { minimum: 0 }),
    minExpectedMovePct: numberValue("MIN_EXPECTED_MOVE_PCT", 0.75, { minimum: 0 }),
    expectedMoveAtrMultiplier: numberValue("EXPECTED_MOVE_ATR_MULTIPLIER", 1.0, { positive: true }),
    minEdgeToCostRatio: numberValue("MIN_EDGE_TO_COST_RATIO", 1.45, { positive: true }),
    minConvictionScore: numberValue("MIN_CONVICTION_SCORE", 48, { positive: true, maximum: 100 }),
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
    explorationTradeRatio: numberValue("EXPLORATION_TRADE_RATIO", 0.65, { minimum: 0, maximum: 1 }),
    explorationMinSignalScore: numberValue("EXPLORATION_MIN_SIGNAL_SCORE", 25, { positive: true, maximum: 100 }),
    explorationMinConvictionScore: numberValue("EXPLORATION_MIN_CONVICTION_SCORE", 32, { positive: true, maximum: 100 }),
    explorationMinProjectedEdgePct: numberValue("EXPLORATION_MIN_PROJECTED_EDGE_PCT", 0.05, { minimum: 0 }),
    explorationMinEdgeToCostRatio: numberValue("EXPLORATION_MIN_EDGE_TO_COST_RATIO", 1.0, { positive: true }),
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
    minHoldSecondsBeforeMomentumExit: numberValue("MIN_HOLD_SECONDS_BEFORE_MOMENTUM_EXIT", 120, { minimum: 0 }),
    continuationMinScore: numberValue("CONTINUATION_MIN_SCORE", 70, { minimum: 0, maximum: 100 }),
    continuationMinPnlPct: numberValue("CONTINUATION_MIN_PNL_PCT", 0.35, { minimum: 0 }),
    maxConsecutiveApiErrors: numberValue("MAX_CONSECUTIVE_API_ERRORS", 5, { positive: true, integer: true }),
  };

  const supportedIntervals = new Set(["1M", "3M", "5M", "15M", "30M", "60M", "120M", "240M", "360M", "720M", "1D", "1W", "1MO"]);
  for (const interval of [config.candleIntervalFast, config.candleIntervalMain, config.candleIntervalTrend]) {
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
  if (config.regimeDeadMarketVolumeSpike > config.regimeLowLiquidityVolumeSpike) {
    throw new Error("REGIME_DEAD_MARKET_VOLUME_SPIKE cannot exceed REGIME_LOW_LIQUIDITY_VOLUME_SPIKE.");
  }
  if (config.regimeDeadMarketAtrPct > config.regimeHighVolatilityAtrPct) {
    throw new Error("REGIME_DEAD_MARKET_ATR_PCT cannot exceed REGIME_HIGH_VOLATILITY_ATR_PCT.");
  }
  if (config.adaptiveSmallSampleMinWeight > 1) {
    throw new Error("ADAPTIVE_SMALL_SAMPLE_MIN_WEIGHT cannot exceed 1.");
  }
  if (!config.allowLongs && !config.allowShorts) {
    throw new Error("At least one of ALLOW_LONGS or ALLOW_SHORTS must be true.");
  }
  if (!config.dryRun && (!config.apiKey || !config.apiSecret)) {
    throw new Error("DRY_RUN=false requires BYBIT_API_KEY and BYBIT_API_SECRET.");
  }
  if (!config.dryRun && !config.bybitTestnet && !config.acknowledgeLiveTrading) {
    throw new Error("Mainnet trading requires ACKNOWLEDGE_LIVE_TRADING=true.");
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
