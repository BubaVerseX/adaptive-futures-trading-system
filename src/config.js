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
    fastMode: booleanValue("FAST_MODE", true),
    fomoBreakoutMode: booleanValue("FOMO_BREAKOUT_MODE", true),
    microBreakoutEntries: booleanValue("MICRO_BREAKOUT_ENTRIES", true),
    allowChoppyMarket: booleanValue("ALLOW_CHOPPY_MARKET", true),
    allowPartialScanEntries: booleanValue("ALLOW_PARTIAL_SCAN_ENTRIES", true),
    maxOpenPositions: numberValue("MAX_OPEN_POSITIONS", 3, { positive: true, integer: true, maximum: 10 }),
    maxTradesPerDay: numberValue("MAX_TRADES_PER_DAY", 60, { positive: true, integer: true }),
    baseRiskPerTradePct: numberValue("BASE_RISK_PER_TRADE_PCT", 4, { positive: true }),
    aggressiveRiskPerTradePct: numberValue("AGGRESSIVE_RISK_PER_TRADE_PCT", 8, { positive: true }),
    aggressiveScoreThreshold: numberValue("AGGRESSIVE_SCORE_THRESHOLD", 35, { positive: true, maximum: 100 }),
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
    maxSymbolsToScan: numberValue("MAX_SYMBOLS_TO_SCAN", 150, { positive: true, integer: true }),
    min24hVolumeUsdt: numberValue("MIN_24H_VOLUME_USDT", 100000, { minimum: 0 }),
    maxSpreadPct: numberValue("MAX_SPREAD_PCT", 1.5, { positive: true }),
    excludedSymbols: symbolsSet("EXCLUDED_SYMBOLS"),
    takeProfitPct: numberValue("TAKE_PROFIT_PCT", 1.5, { positive: true }),
    stopLossPct: numberValue("STOP_LOSS_PCT", 0.7, { positive: true }),
    trailingStopEnabled: booleanValue("TRAILING_STOP_ENABLED", true),
    trailingStartPct: numberValue("TRAILING_START_PCT", 0.35, { positive: true }),
    trailingDistancePct: numberValue("TRAILING_DISTANCE_PCT", 0.2, { positive: true }),
    minSignalScore: numberValue("MIN_SIGNAL_SCORE", 35, { positive: true, maximum: 100 }),
    closePositionOnExit: booleanValue("CLOSE_POSITION_ON_EXIT", true),
    maxPositionNotionalUsdt: numberValue("MAX_POSITION_NOTIONAL_USDT", 150, { positive: true }),
    maxMarginUsagePct: numberValue("MAX_MARGIN_USAGE_PCT", 55, { positive: true, maximum: 95 }),
    maxTotalMarginUsagePct: numberValue("MAX_TOTAL_MARGIN_USAGE_PCT", 90, { positive: true, maximum: 95 }),
    minLiquidationBufferPct: numberValue("MIN_LIQUIDATION_BUFFER_PCT", 2, { positive: true }),
    minVolumeSpike: numberValue("MIN_VOLUME_SPIKE", 1.35, { positive: true }),
    minBurstMomentumPct: numberValue("MIN_BURST_MOMENTUM_PCT", 0.08, { positive: true }),
    fomoMomentumPct: numberValue("FOMO_MOMENTUM_PCT", 0.12, { positive: true }),
    minMomentumPersistenceCandles: numberValue("MIN_MOMENTUM_PERSISTENCE_CANDLES", 2, { positive: true, integer: true, maximum: 6 }),
    estimatedFeePctPerSide: numberValue("ESTIMATED_FEE_PCT_PER_SIDE", 0.055, { minimum: 0 }),
    minProjectedEdgePct: numberValue("MIN_PROJECTED_EDGE_PCT", 0.35, { minimum: 0 }),
    symbolLossCooldownMinutes: numberValue("SYMBOL_LOSS_COOLDOWN_MINUTES", 15, { minimum: 0 }),
    symbolReentryCooldownSeconds: numberValue("SYMBOL_REENTRY_COOLDOWN_SECONDS", 90, { minimum: 0 }),
    btcTrendAlignmentBonus: numberValue("BTC_TREND_ALIGNMENT_BONUS", 8, { minimum: 0, maximum: 20 }),
    choppyMarketPenalty: numberValue("CHOPPY_MARKET_PENALTY", 8, { minimum: 0, maximum: 30 }),
    lowLiquiditySpikePenalty: numberValue("LOW_LIQUIDITY_SPIKE_PENALTY", 10, { minimum: 0, maximum: 30 }),
    adaptiveLearningEnabled: booleanValue("ADAPTIVE_LEARNING_ENABLED", true),
    minAdaptiveTrades: numberValue("MIN_ADAPTIVE_TRADES", 10, { positive: true, integer: true }),
    minAdaptiveBucketTrades: numberValue("MIN_ADAPTIVE_BUCKET_TRADES", 5, { positive: true, integer: true }),
    adaptiveMemoryMaxTrades: numberValue("ADAPTIVE_MEMORY_MAX_TRADES", 5000, { positive: true, integer: true }),
    defensiveWinRatePct: numberValue("DEFENSIVE_WIN_RATE_PCT", 35, { positive: true, maximum: 100 }),
    aggressiveWinRatePct: numberValue("AGGRESSIVE_WIN_RATE_PCT", 60, { positive: true, maximum: 100 }),
    adaptiveConfidenceBonusMax: numberValue("ADAPTIVE_CONFIDENCE_BONUS_MAX", 12, { minimum: 0, maximum: 30 }),
    adaptiveConfidencePenaltyMax: numberValue("ADAPTIVE_CONFIDENCE_PENALTY_MAX", 18, { minimum: 0, maximum: 40 }),
    adaptiveBlacklistWinRatePct: numberValue("ADAPTIVE_BLACKLIST_WIN_RATE_PCT", 25, { minimum: 0, maximum: 100 }),
    adaptiveBlacklistMinutes: numberValue("ADAPTIVE_BLACKLIST_MINUTES", 60, { minimum: 0 }),
    adaptiveRiskMinMultiplier: numberValue("ADAPTIVE_RISK_MIN_MULTIPLIER", 0.45, { positive: true, maximum: 1 }),
    adaptiveRiskMaxMultiplier: numberValue("ADAPTIVE_RISK_MAX_MULTIPLIER", 1.25, { positive: true, maximum: 2 }),
    highVolatilityAtrPct: numberValue("HIGH_VOLATILITY_ATR_PCT", 0.9, { positive: true }),
    abnormalVolatilityAtrPct: numberValue("ABNORMAL_VOLATILITY_ATR_PCT", 1.8, { positive: true }),
    lowVolumeMultiple: numberValue("LOW_VOLUME_MULTIPLE", 2, { positive: true }),
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
