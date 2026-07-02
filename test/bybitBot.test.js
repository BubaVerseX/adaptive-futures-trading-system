"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const packageJson = require("../package.json");

const { BybitClient, intervalForApi, normalizedOrderStatus, parseUnifiedUsdtBalance, queryString } = require("../src/bybitClient");
const { LadderBot } = require("../src/bot");
const { loadConfig } = require("../src/config");
const { Scanner, marketBreadthScore, multiTimeframeTrendConfirmation, portfolioAlphaScore } = require("../src/scanner");
const { TrendPortfolioEngine } = require("../src/trendPortfolioEngine");
const { AdaptiveEngine } = require("../src/adaptiveEngine");
const { marketProfileFromBenchmarks, marketRegimeV2, sessionProfile } = require("../src/marketRegime");
const { classifyBybitError } = require("../src/bybitErrors");
const { edgeGate } = require("../src/costModel");
const { ExecutionLedger } = require("../src/executionLedger");
const { ProfitObjectiveEngine } = require("../src/profitObjective");
const {
  allocatedEquityLimitUsdt,
  liveValidationAllocation,
  promotionEvaluation,
  riskStateEvaluation,
} = require("../src/liveValidation");
const {
  earnedRiskTier,
  adaptiveActivityRecovery,
  asymmetricRunnerAllocation,
  dynamicInactivityRecovery,
  expectancyAutoTuning,
  expectancyOptimizer,
  profitEdgeReport,
  profitExpectancyReport,
  profitSystemHealthReport,
  profitControlledRiskState,
  qualityScoreForSignal,
  regimePerformanceMemory,
  sizingEquityBaseFromBalance,
  setupRegimeMatrixMemory,
  setupRankingMemory,
  symbolPerformanceMemoryV2,
  symbolPerformanceMemoryV3,
  tradeClusterRisk,
  trendDominanceSignal,
} = require("../src/profitControlled");
const {
  CONFIRMATION_PHRASE,
} = require("../scripts/setupProfitControlled");

const ISOLATED_ENV_DEFAULTS = Object.freeze({
  BYBIT_API_KEY: "test-key",
  BYBIT_API_SECRET: "test-secret",
  BYBIT_TESTNET: "true",
  BYBIT_DEMO_TRADING: "false",
  DRY_RUN: "true",
  PAPER_TRADING_MODE: "false",
  ACTIVE_ADAPTIVE_SCALPER_MODE: "false",
  SWING_MOMENTUM_MODE: "false",
  TREND_PORTFOLIO_MODE: "false",
  LIVE_VALIDATION_MODE: "false",
  PROFIT_CONTROLLED_EQUITY_MODE: "false",
  ACKNOWLEDGE_LIVE_VALIDATION_RISK: "false",
  ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK: "false",
  ACKNOWLEDGE_LIVE_TRADING: "false",
  ACKNOWLEDGE_DEMO_TRADING: "false",
  ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "false",
  BYBIT_REST_BASE_URL: "",
  BYBIT_WS_BASE_URL: "",
  BYBIT_PUBLIC_WS_BASE_URL: "",
  BYBIT_PRIVATE_WS_BASE_URL: "",
  LEARNING_PHASE_MODE: "true",
  AGGRESSIVE_LEARNING_PHASE: "true",
  PROFIT_EXPANSION_MODE: "false",
  EXPLORATION_MODE_ENABLED: "true",
  EXPLORATION_TRADE_RATIO: "0.55",
  FORCED_MARKET_SAMPLING_ENABLED: "true",
  FORCED_EXECUTION_SAMPLING_ACTIVE: "false",
  FOMO_BREAKOUT_MODE: "true",
  MICRO_BREAKOUT_ENTRIES: "true",
  UNCONFIRMED_MICRO_BREAKOUT_ENTRIES: "false",
  ALLOW_CHOPPY_MARKET: "true",
  ALLOW_CHOPPY_MARKET_UNCONDITIONALLY: "false",
  UNLIMITED_EXPLORATION_BUDGET: "false",
  CONTINUOUS_EXECUTION_MODE: "true",
  DISABLE_DAILY_TRADE_LIMITS: "true",
  CONFIDENCE_SIZING_ENABLED: "false",
});

function config(overrides = {}) {
  const id = Math.random();
  const base = withEnv({}, () => loadConfig());
  return {
    ...base,
    apiKey: "test-key",
    apiSecret: "test-secret",
    apiRequestIntervalMs: 1,
    wsReconnectBaseMs: 1,
    projectRoot: `/private/tmp/bybit-bot-project-${id}`,
    logFile: `/private/tmp/bybit-bot-test-${id}.log`,
    stateFile: `/private/tmp/bybit-bot-state-${id}.json`,
    tradesFile: `/private/tmp/bybit-bot-trades-${id}.json`,
    tradeMemoryFile: `/private/tmp/bybit-bot-memory-${id}.json`,
    analyticsFile: `/private/tmp/bybit-bot-analytics-${id}.json`,
    executionLedgerFile: `/private/tmp/bybit-bot-ledger-${id}.json`,
    reportsDir: `/private/tmp/bybit-bot-reports-${id}`,
    ...overrides,
  };
}

function logCollector() {
  const events = [];
  return { events, log: (level, message, details = {}) => events.push({ level, message, details }) };
}

function withEnv(overrides, callback) {
  const applied = { ...ISOLATED_ENV_DEFAULTS, ...overrides };
  const previous = {};
  for (const key of Object.keys(applied)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(applied)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const key of Object.keys(applied)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function testDemoTradingConfigUsesDemoOnlyEndpoints() {
  const demoConfig = withEnv(
    {
      BYBIT_API_KEY: "demo-key",
      BYBIT_API_SECRET: "demo-secret",
      BYBIT_DEMO_TRADING: "true",
      BYBIT_TESTNET: "false",
      DRY_RUN: "false",
      ACKNOWLEDGE_DEMO_TRADING: "true",
      ACKNOWLEDGE_LIVE_TRADING: "false",
      ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
      BYBIT_REST_BASE_URL: "",
      BYBIT_WS_BASE_URL: "",
      BYBIT_PUBLIC_WS_BASE_URL: "",
      BYBIT_PRIVATE_WS_BASE_URL: "",
    },
    () => loadConfig()
  );
  assert.equal(demoConfig.exchangeEnvironment, "DEMO");
  assert.equal(demoConfig.restBaseUrl, "https://api-demo.bybit.com");
  assert.equal(demoConfig.publicWsBaseUrl, "wss://stream.bybit.com");
  assert.equal(demoConfig.privateWsBaseUrl, "wss://stream-demo.bybit.com");
  assert.ok(demoConfig.stateFile.endsWith("/data/demo/state.json"));
  assert.ok(demoConfig.executionLedgerFile.endsWith("/data/demo/executionLedger.json"));

  assert.throws(
    () =>
      withEnv(
        {
          BYBIT_API_KEY: "demo-key",
          BYBIT_API_SECRET: "demo-secret",
          BYBIT_DEMO_TRADING: "true",
          BYBIT_TESTNET: "false",
          DRY_RUN: "false",
          ACKNOWLEDGE_DEMO_TRADING: "true",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
          BYBIT_REST_BASE_URL: "https://api.bybit.com",
        },
        () => loadConfig()
      ),
    /Demo trading requires BYBIT_REST_BASE_URL/
  );

  assert.throws(
    () =>
      withEnv(
        {
          BYBIT_API_KEY: "demo-key",
          BYBIT_API_SECRET: "demo-secret",
          BYBIT_DEMO_TRADING: "true",
          BYBIT_TESTNET: "false",
          DRY_RUN: "false",
          ACKNOWLEDGE_DEMO_TRADING: "true",
          ACKNOWLEDGE_LIVE_TRADING: "true",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
          BYBIT_REST_BASE_URL: "",
          BYBIT_WS_BASE_URL: "",
          BYBIT_PUBLIC_WS_BASE_URL: "",
          BYBIT_PRIVATE_WS_BASE_URL: "",
        },
        () => loadConfig()
      ),
    /ACKNOWLEDGE_LIVE_TRADING=true/
  );
}

async function testLiveValidationConfigGuards() {
  assert.doesNotMatch(packageJson.scripts["live:validate"], /ACKNOWLEDGE_LIVE_VALIDATION_RISK=true/);
  assert.doesNotMatch(packageJson.scripts["live:validate"], /ACKNOWLEDGE_LIVE_TRADING=true/);
  assert.match(packageJson.scripts["live:validate"], /LIVE_VALIDATION_MODE=true/);
  assert.match(packageJson.scripts["live:validate"], /LIVE_VALIDATION_MAX_ALLOCATED_EQUITY_USDT=10/);

  const liveConfig = withEnv(
    {
      BYBIT_API_KEY: "live-key",
      BYBIT_API_SECRET: "live-secret",
      BYBIT_DEMO_TRADING: "false",
      BYBIT_TESTNET: "false",
      DRY_RUN: "false",
      LIVE_VALIDATION_MODE: "true",
      ACKNOWLEDGE_LIVE_VALIDATION_RISK: "true",
      ACKNOWLEDGE_LIVE_TRADING: "true",
      ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
      LIVE_VALIDATION_MAX_ALLOCATED_EQUITY_USDT: "10",
      BYBIT_REST_BASE_URL: "",
      BYBIT_WS_BASE_URL: "",
      BYBIT_PUBLIC_WS_BASE_URL: "",
      BYBIT_PRIVATE_WS_BASE_URL: "",
    },
    () => loadConfig()
  );
  assert.equal(liveConfig.exchangeEnvironment, "LIVE_VALIDATION");
  assert.equal(liveConfig.liveValidationMode, true);
  assert.equal(liveConfig.restBaseUrl, "https://api.bybit.com");
  assert.equal(liveConfig.privateWsBaseUrl, "wss://stream.bybit.com");
  assert.ok(liveConfig.stateFile.endsWith("/data/live-validation/state.json"));
  assert.ok(liveConfig.executionLedgerFile.endsWith("/data/live-validation/executionLedger.json"));

  assert.throws(
    () =>
      withEnv(
        {
          BYBIT_API_KEY: "live-key",
          BYBIT_API_SECRET: "live-secret",
          BYBIT_DEMO_TRADING: "false",
          BYBIT_TESTNET: "false",
          DRY_RUN: "false",
          LIVE_VALIDATION_MODE: "true",
          ACKNOWLEDGE_LIVE_VALIDATION_RISK: "false",
          ACKNOWLEDGE_LIVE_TRADING: "true",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
        },
        () => loadConfig()
      ),
    /LIVE VALIDATION NOT STARTED — REAL-MONEY ACKNOWLEDGEMENT REQUIRED/
  );

  assert.throws(
    () =>
      withEnv(
        {
          BYBIT_API_KEY: "live-key",
          BYBIT_API_SECRET: "live-secret",
          BYBIT_DEMO_TRADING: "false",
          BYBIT_TESTNET: "false",
          DRY_RUN: "false",
          LIVE_VALIDATION_MODE: "true",
          ACKNOWLEDGE_LIVE_VALIDATION_RISK: "true",
          ACKNOWLEDGE_LIVE_TRADING: "false",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
        },
        () => loadConfig()
      ),
    /LIVE VALIDATION NOT STARTED — REAL-MONEY ACKNOWLEDGEMENT REQUIRED/
  );

  assert.throws(
    () =>
      withEnv(
        {
          BYBIT_API_KEY: "live-key",
          BYBIT_API_SECRET: "live-secret",
          BYBIT_DEMO_TRADING: "false",
          BYBIT_TESTNET: "true",
          DRY_RUN: "false",
          LIVE_VALIDATION_MODE: "true",
          ACKNOWLEDGE_LIVE_VALIDATION_RISK: "true",
          ACKNOWLEDGE_LIVE_TRADING: "true",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
        },
        () => loadConfig()
      ),
    /BYBIT_DEMO_TRADING=false and BYBIT_TESTNET=false/
  );

  assert.throws(
    () =>
      withEnv(
        {
          BYBIT_API_KEY: "live-key",
          BYBIT_API_SECRET: "live-secret",
          BYBIT_DEMO_TRADING: "false",
          BYBIT_TESTNET: "false",
          DRY_RUN: "false",
          LIVE_VALIDATION_MODE: "true",
          ACKNOWLEDGE_LIVE_VALIDATION_RISK: "true",
          ACKNOWLEDGE_LIVE_TRADING: "true",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
          LIVE_VALIDATION_MAX_ALLOCATED_EQUITY_USDT: "20",
        },
        () => loadConfig()
      ),
    /cannot exceed 10/
  );

  assert.throws(
    () =>
      withEnv(
        {
          BYBIT_API_KEY: "live-key",
          BYBIT_API_SECRET: "live-secret",
          BYBIT_DEMO_TRADING: "false",
          BYBIT_TESTNET: "false",
          DRY_RUN: "false",
          LIVE_VALIDATION_MODE: "true",
          ACKNOWLEDGE_LIVE_VALIDATION_RISK: "true",
          ACKNOWLEDGE_LIVE_TRADING: "true",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
          BYBIT_REST_BASE_URL: "https://api-demo.bybit.com",
        },
        () => loadConfig()
      ),
    /live mainnet REST endpoint/
  );
}

function instrument(symbol, overrides = {}) {
  return {
    symbol,
    status: "Trading",
    priceFilter: { tickSize: overrides.tickSize || "0.01" },
    lotSizeFilter: {
      qtyStep: overrides.qtyStep || "0.001",
      minOrderQty: overrides.minOrderQty || "0.001",
      minNotionalValue: overrides.minNotionalValue || "1",
    },
  };
}

async function testLiveValidationStartupChecksProceedWithoutOrders() {
  const { events, log } = logCollector();
  let orderCalls = 0;
  const bot = new LadderBot(config({
    dryRun: false,
    liveValidationMode: true,
    liveValidationMaxAllocatedEquityUsdt: 10,
    liveValidationPromotionEnabled: true,
    bybitTestnet: false,
    bybitDemoTrading: false,
    exchangeEnvironment: "LIVE_VALIDATION",
    restBaseUrl: "https://api.bybit.com",
    publicWsBaseUrl: "wss://stream.bybit.com",
    privateWsBaseUrl: "wss://stream.bybit.com",
    acknowledgeLiveValidationRisk: true,
    acknowledgeLiveTrading: true,
  }));
  bot.log = log;
  bot.store.state = {
    mode: "LIVE",
    liveValidation: { level: 0, allocatedEquityLimitUsdt: 10 },
    openPositions: [],
    apiRecovery: { active: false },
    consecutiveApiErrors: 0,
    equity: { startingUsdt: 70, currentUsdt: 70, realizedPnlUsdt: 0 },
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    performance: {},
  };
  bot.store.trades = [];
  bot.store.saveState = () => {};
  bot.store.saveAll = () => {};
  bot.risk.store = bot.store;
  bot.client = {
    getSymbols: async () => ["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((symbol) => instrument(symbol)),
    getUsdtBalance: async () => ({ available: 10, equity: 70 }),
    getPositions: async () => [],
    placeMarketOrder: async () => {
      orderCalls += 1;
    },
    placeLimitOrder: async () => {
      orderCalls += 1;
    },
  };
  await bot.initializeLiveSafety();
  assert.equal(orderCalls, 0);
  assert.ok(events.some((event) => event.message === "USER_ACKNOWLEDGEMENT_CONFIRMED"));
  assert.ok(events.some((event) => event.message === "MAINNET_ENDPOINT_CONFIRMED"));
  assert.ok(events.some((event) => event.message === "VALIDATION_ALLOCATION_LIMIT_USDT"));
  assert.ok(events.some((event) => event.message === "INSTRUMENT_RULES_LOADED"));
  assert.ok(events.some((event) => event.message === "MINIMUM_ORDER_FEASIBILITY_CHECK_PASSED"));
  assert.ok(events.some((event) => event.message === "EXISTING_POSITIONS_RECONCILED"));
  assert.ok(events.some((event) => event.message === "PROTECTION_STATUS_CONFIRMED"));
}

async function testLiveValidationInstrumentRuleFailureBlocksExposure() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({
    dryRun: false,
    liveValidationMode: true,
    liveValidationMaxAllocatedEquityUsdt: 10,
  }));
  bot.log = log;
  bot.store.state = {
    mode: "LIVE",
    liveValidation: { level: 0, allocatedEquityLimitUsdt: 10 },
    openPositions: [],
    apiRecovery: { active: false },
    consecutiveApiErrors: 0,
  };
  bot.store.saveState = () => {};
  bot.client = {
    getSymbols: async () => [instrument("BTCUSDT"), instrument("ETHUSDT")],
  };
  await assert.rejects(() => bot.loadFocusedInstrumentRules(), /instrument rules missing/);
  assert.equal(bot.store.state.liveValidation.riskState, "RISK_STATE_PROTECTION_ONLY");
  assert.ok(events.some((event) => event.message === "HUMAN_REVIEW_REQUIRED"));
}

function validationTrade(id, pnlUsdt, overrides = {}) {
  return {
    id,
    mode: "LIVE",
    status: "CLOSED",
    symbol: "BTCUSDT",
    side: "LONG",
    setupType: "TREND_CONTINUATION",
    continuationSetupType: "TREND_CONTINUATION",
    pnlUsdt,
    netPnlAfterCostsUsdt: pnlUsdt,
    grossPnlUsdt: pnlUsdt + 0.01,
    feesUsdt: 0.01,
    exitedAt: new Date(Date.now() + Number(id.replace(/\D/g, "")) * 1000).toISOString(),
    ...overrides,
  };
}

async function testLiveValidationAllocationPromotionAndRiskStates() {
  const cfg = config({
    liveValidationMode: true,
    liveValidationMaxAllocatedEquityUsdt: 10,
    liveValidationPromotionEnabled: true,
    liveValidationProtectionDrawdownPct: 15,
    liveValidationMaxFeeToGrossProfitRatio: 0.65,
    liveValidationReducedFeeDragRatio: 0.8,
    liveValidationReducedRiskMultiplier: 0.6,
  });
  const state = { liveValidation: { level: 0 }, apiRecovery: { active: false } };
  assert.equal(allocatedEquityLimitUsdt(cfg, state), 10);
  assert.equal(liveValidationAllocation(cfg, state, 70, 58), 10);
  assert.equal(liveValidationAllocation(cfg, state, 7, 58), 7);

  const profitable = Array.from({ length: 50 }, (_, index) => validationTrade(`win-${index}`, 0.03));
  const promotion = promotionEvaluation({
    config: cfg,
    state,
    trades: profitable,
    executionLedger: {},
    openPositions: [],
    unresolvedReason: null,
  });
  assert.equal(promotion.eligible, true);
  assert.equal(promotion.nextLevel, 1);
  assert.equal(promotion.nextAllocatedEquityLimitUsdt, 20);

  const losing = Array.from({ length: 50 }, (_, index) => validationTrade(`loss-${index}`, -0.02));
  const blocked = promotionEvaluation({ config: cfg, state, trades: losing, executionLedger: {}, openPositions: [] });
  assert.equal(blocked.eligible, false);
  assert.ok(blocked.blockedReasons.some((reason) => /net PnL/.test(reason)));

  const level2 = promotionEvaluation({
    config: cfg,
    state: { liveValidation: { level: 2 }, apiRecovery: { active: false } },
    trades: profitable.concat(profitable.map((trade, index) => ({ ...trade, id: `w2-${index}` }))),
    executionLedger: {},
    openPositions: [],
  });
  assert.equal(level2.eligible, false);
  assert.ok(level2.blockedReasons.some((reason) => /beyond 35 USDT/.test(reason)));

  const reduced = riskStateEvaluation({
    config: cfg,
    state,
    trades: Array.from({ length: 8 }, (_, index) => validationTrade(`r-${index}`, -0.08)),
    openPositions: [],
  });
  assert.equal(reduced.state, "RISK_STATE_REDUCED");
  assert.equal(reduced.riskMultiplier, 0.6);

  const protection = riskStateEvaluation({
    config: cfg,
    state,
    trades: Array.from({ length: 6 }, (_, index) => validationTrade(`p-${index}`, -0.3)),
    openPositions: [],
  });
  assert.equal(protection.state, "RISK_STATE_PROTECTION_ONLY");

  const unprotected = riskStateEvaluation({
    config: cfg,
    state,
    trades: [],
    openPositions: [{ mode: "LIVE", symbol: "BTCUSDT", nativeProtectionVerified: false, stopLossPrice: 99, takeProfitPrice: 103 }],
  });
  assert.equal(unprotected.state, "RISK_STATE_PROTECTION_ONLY");
}

async function testClientContracts() {
  assert.equal(intervalForApi("1M"), "1");
  assert.equal(intervalForApi("15M"), "15");
  assert.equal(queryString({ symbol: "BTCUSDT", category: "linear" }), "category=linear&symbol=BTCUSDT");
  assert.equal(normalizedOrderStatus("PartiallyFilled"), "PARTIALLY_FILLED");

  const { log } = logCollector();
  const client = new BybitClient(config(), log);
  const calls = [];
  client.privateRequest = async (method, endpoint, params, body) => {
    calls.push({ method, endpoint, params, body });
    return { orderId: "order-1", orderLinkId: body.orderLinkId };
  };
  await client.placeMarketOrder({
    symbol: "BTCUSDT",
    side: "Buy",
    qty: "0.001",
    positionIdx: 0,
    orderLinkId: "entry-1",
    reduceOnly: false,
    takeProfit: "101",
    stopLoss: "99",
  });
  assert.equal(calls[0].endpoint, "/v5/order/create");
  assert.equal(calls[0].body.orderType, "Market");
  assert.equal(calls[0].body.takeProfit, "101");
  assert.equal(calls[0].body.stopLoss, "99");
  assert.equal(calls[0].body.tpslMode, "Full");

  await client.placeMarketOrder({
    symbol: "ETHUSDT",
    side: "Buy",
    qty: "0.01",
    positionIdx: 0,
    orderLinkId: "swing-entry-1",
    reduceOnly: false,
    stopLoss: "99",
  });
  assert.equal(calls[1].endpoint, "/v5/order/create");
  assert.equal(calls[1].body.stopLoss, "99");
  assert.equal(calls[1].body.slOrderType, "Market");
  assert.equal(calls[1].body.slTriggerBy, "MarkPrice");
  assert.equal(Object.hasOwn(calls[1].body, "takeProfit"), false);
  assert.equal(Object.hasOwn(calls[1].body, "tpOrderType"), false);

  await client.setTradingStop({
    symbol: "BTCUSDT",
    positionIdx: 0,
    takeProfit: "101",
    stopLoss: "99",
    trailingStop: "0.5",
    activePrice: "100.5",
  });
  assert.equal(calls[2].endpoint, "/v5/position/trading-stop");
  assert.equal(calls[2].body.trailingStop, "0.5");
}

async function testSignedRestHeaders() {
  const { events, log } = logCollector();
  const client = new BybitClient(config(), log);
  let request;
  client.request = async (url, options) => {
    request = { url, options };
    return {};
  };
  await client.setLeverage("BTCUSDT", 15);
  assert.ok(request.url.includes("/v5/position/set-leverage"));
  assert.equal(request.options.headers["X-BAPI-API-KEY"], "test-key");
  assert.equal(request.options.headers["X-BAPI-SIGN"].length, 64);
  assert.ok(String(request.options.body).includes("\"buyLeverage\":\"15\""));
  assert.ok(events.some((event) => event.message === "Bybit authenticated REST request signed."));
  assert.ok(!JSON.stringify(events).includes("test-secret"));
}

async function testBybitNotModifiedIsInformational() {
  const originalFetch = global.fetch;
  const { events, log } = logCollector();
  const client = new BybitClient(config(), log);
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ retCode: 34040, retMsg: "not modified", result: {} }),
    };
  };
  try {
    const response = await client.setTradingStop({
      symbol: "BTCUSDT",
      positionIdx: 0,
      takeProfit: "101",
      stopLoss: "99",
    });
    assert.equal(response.notModified, true);
    assert.equal(requests, 1);
    assert.ok(events.some((event) => event.message === "BYBIT_NO_CHANGE_TREATED_AS_SUCCESS"));
  } finally {
    global.fetch = originalFetch;
  }
}

async function testBybitRateLimitCooldownLogged() {
  const originalFetch = global.fetch;
  const { events, log } = logCollector();
  const client = new BybitClient(config({ apiRateLimitCooldownMs: 1 }), log);
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ retCode: 10006, retMsg: "rate limit" }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ retCode: 0, result: { recovered: true } }),
    };
  };
  try {
    const result = await client.request("https://api.bybit.com/v5/test");
    assert.equal(result.recovered, true);
    assert.equal(requests, 2);
    assert.ok(events.some((event) => event.message === "API_RATE_LIMIT_COOLDOWN"));
  } finally {
    global.fetch = originalFetch;
  }
}

async function testUnifiedWalletParsing() {
  const accountLevel = parseUnifiedUsdtBalance({
    list: [
      {
        totalAvailableBalance: "58.1234",
        totalEquity: "60.5",
        totalMarginBalance: "60.5",
        totalInitialMargin: "2.3",
        coin: [
          {
            coin: "USDT",
            walletBalance: "58.1234",
            equity: "58.1234",
            usdValue: "58.1234",
            totalPositionIM: "0",
            totalOrderIM: "0",
            locked: "0",
            bonus: "0",
            marginCollateral: true,
            collateralSwitch: true,
          },
        ],
      },
    ],
  });
  assert.equal(accountLevel.available, 58.1234);
  assert.equal(accountLevel.equity, 60.5);
  assert.equal(accountLevel.parseSource, "account.totalAvailableBalance");

  const coinFallback = parseUnifiedUsdtBalance({
    list: [
      {
        totalAvailableBalance: "",
        totalEquity: "",
        totalMarginBalance: "",
        totalInitialMargin: "",
        coin: [
          {
            coin: "USDT",
            walletBalance: "58",
            equity: "59",
            usdValue: "58",
            totalPositionIM: "2",
            totalOrderIM: "1",
            locked: "0.5",
            bonus: "0",
            marginCollateral: true,
            collateralSwitch: true,
            availableToWithdraw: "",
          },
        ],
      },
    ],
  });
  assert.equal(coinFallback.available, 54.5);
  assert.equal(coinFallback.equity, 59);
  assert.equal(coinFallback.parseSource, "USDT.walletBalance - totalPositionIM - totalOrderIM - locked - bonus");

  const zeroAccountAvailableButUsableCoin = parseUnifiedUsdtBalance({
    list: [
      {
        totalAvailableBalance: "0",
        totalEquity: "58",
        coin: [
          {
            coin: "USDT",
            walletBalance: "58",
            equity: "58",
            usdValue: "58",
            totalPositionIM: "",
            totalOrderIM: "",
            locked: "0",
            bonus: "0",
            marginCollateral: true,
            collateralSwitch: true,
          },
        ],
      },
    ],
  });
  assert.equal(zeroAccountAvailableButUsableCoin.available, 58);
  assert.equal(zeroAccountAvailableButUsableCoin.parseSource, "USDT.walletBalance - totalPositionIM - totalOrderIM - locked - bonus");
}

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = 3;
  }
}

async function testWebSocketTickerAndReconnect() {
  FakeWebSocket.instances = [];
  const { events, log } = logCollector();
  const client = new BybitClient(config(), log, FakeWebSocket);
  client.subscribeTickers(["BTCUSDT"]);
  client.startWebSockets();
  const first = FakeWebSocket.instances[0];
  first.emit("open");
  assert.ok(first.sent.some((message) => message.op === "subscribe" && message.args.includes("tickers.BTCUSDT")));
  first.emit("message", JSON.stringify({ topic: "tickers.BTCUSDT", data: { symbol: "BTCUSDT", lastPrice: "100" } }));
  assert.equal((await client.getTicker("BTCUSDT")).lastPrice, "100");
  first.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = FakeWebSocket.instances[1];
  second.emit("open");
  assert.ok(events.some((event) => event.message === "WEBSOCKET RECONNECTED"));
  client.stopWebSockets();
}

async function testApiAutoRecoveryDoesNotShutdown() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({
    dryRun: false,
    apiRecoveryBaseBackoffMs: 1,
    apiRecoveryMaxBackoffMs: 2,
    maxConsecutiveApiErrors: 1,
  }));
  bot.log = log;
  bot.adaptive.log = log;
  bot.store.state.openPositions = [];
  bot.store.state.consecutiveApiErrors = 3;
  bot.store.saveState = () => {};
  let reconnectReason = null;
  let sessionRefreshed = false;
  let positionsRead = false;
  bot.client = {
    reconnectWebSockets: (reason) => {
      reconnectReason = reason;
    },
    refreshSession: () => {
      sessionRefreshed = true;
    },
    getUsdtBalance: async () => ({ available: 10, equity: 10 }),
    getTicker: async (symbol) => ({ symbol, lastPrice: "100" }),
    getPositions: async () => {
      positionsRead = true;
      return [];
    },
  };
  bot.telegram = { send: async () => {} };
  bot.shutdown = async () => {
    throw new Error("shutdown should not run for recoverable API errors");
  };

  await bot.handleApiRecovery(new Error("simulated Bybit timeout"), { source: "TEST", countError: true });
  assert.equal(bot.stopping, false);
  assert.equal(reconnectReason, "api recovery stage 4");
  assert.equal(sessionRefreshed, true);
  assert.equal(positionsRead, true);
  assert.equal(bot.store.state.apiRecovery.active, false);
  assert.ok(events.some((event) => event.message === "API auto-recovery triggered."));
  assert.ok(events.some((event) => event.message === "Exchange state rebuilt."));
  assert.ok(events.some((event) => event.message === "Execution resumed automatically."));
}

async function testNotModifiedDoesNotTriggerRecovery() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({ dryRun: true }));
  bot.log = log;
  bot.store.state.consecutiveApiErrors = 2;
  bot.store.saveState = () => {};
  await bot.handleApiRecovery(new Error("Bybit request failed (HTTP 200, code 34040): not modified."), {
    source: "TEST",
    countError: true,
  });
  assert.equal(bot.store.state.consecutiveApiErrors, 2);
  assert.ok(events.some((event) => event.message === "BYBIT_NO_CHANGE_TREATED_AS_SUCCESS"));
}

async function testDuplicateTradingStopUpdateSkipped() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({ dryRun: false }));
  bot.log = log;
  let calls = 0;
  bot.client = {
    setTradingStop: async () => {
      calls += 1;
      return {};
    },
  };
  const position = {
    symbol: "BTCUSDT",
    positionIdx: 0,
    takeProfitPrice: 101,
    stopLossPrice: 99,
    nativeTakeProfit: "101.000001",
    nativeStopLoss: "99.000001",
  };
  await bot.ensureNativeProtection(position);
  assert.equal(calls, 0);
  assert.equal(position.nativeProtectionVerified, true);
  assert.ok(events.some((event) => event.message === "UNCHANGED_TPSL_UPDATE_SKIPPED"));
  assert.ok(events.some((event) => event.message === "Native Bybit TP/SL protection already current."));
}

async function testCentralizedBybitErrorClassification() {
  const error = new Error("Bybit request failed (HTTP 200, code 34040): not modified.");
  error.retCode = 34040;
  const classified = classifyBybitError(error);
  assert.equal(classified.type, "IDEMPOTENT_SUCCESS_OR_NO_CHANGE");
  assert.equal(classified.retryable, false);
  assert.equal(classified.countsAsApiError, false);
}

async function testExecutionLedgerAggregatesAndDeduplicatesFills() {
  const { events, log } = logCollector();
  const cfg = config();
  const ledger = new ExecutionLedger(cfg, log);
  ledger.load();
  ledger.beginTrade({ id: "logical-1", symbol: "BTCUSDT", side: "LONG", mode: "LIVE", status: "ENTRY_SUBMITTED" });
  ledger.recordOrder("logical-1", { orderId: "order-1", orderLinkId: "link-1" }, "ENTRY_SUBMITTED");
  assert.equal(ledger.logicalTradeIdForOrder({ orderId: "order-1" }), "logical-1");
  const fill = { execId: "fill-1", orderId: "order-1", orderLinkId: "link-1", execQty: "0.010", execPrice: "70000", execFee: "0.04" };
  const first = ledger.recordFill("logical-1", fill);
  const duplicate = ledger.recordFill("logical-1", fill);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(Number(ledger.trade("logical-1").totalActualFeeUsdt.toFixed(8)), 0.04);
  assert.equal(Number(ledger.trade("logical-1").totalFilledQty.toFixed(8)), 0.01);
  assert.ok(events.some((event) => event.message === "Duplicate execution event ignored by execution ledger."));
}

async function testNetEdgeGateApprovesOnlyPostCostOpportunities() {
  const cfg = config();
  const bad = edgeGate(cfg, {
    explorationTrade: true,
    expectedMovePct: 0.2,
    estimatedTpProbability: 0.35,
    spreadPct: 0.12,
    estimatedSlippagePct: 0.1,
    feeEdgeRatio: 0.9,
  }, { notional: 20, maxLossAtStopUsdt: 0.16 }, 70);
  assert.equal(bad.rejected, true);
  assert.match(bad.reason, /expected net edge|reward\/cost/i);

  const good = edgeGate(cfg, {
    continuationSetupType: "PULLBACK_CONTINUATION",
    expectedMovePct: 1.6,
    estimatedTpProbability: 0.72,
    continuationStrength: 75,
    spreadPct: 0.02,
    estimatedSlippagePct: 0.03,
    stopDistancePct: cfg.stopLossPct,
    takeProfitDistancePct: cfg.takeProfitPct,
  }, { notional: 80, maxLossAtStopUsdt: 0.64 }, 70);
  assert.equal(good.rejected, false);
  assert.equal(good.model.tier, "NORMAL_CONTINUATION");
  assert.ok(good.model.projectedNetProfitUsdt > 0);
  assert.ok(good.model.projectedTotalCostUsdt > 0);
}

async function testPortfolioRiskBlocksOnlyCriticalExecutionState() {
  const bot = new LadderBot(config({ dryRun: false }));
  bot.store.state = {
    openPositions: [
      {
        id: "unprotected",
        mode: "LIVE",
        status: "OPEN",
        symbol: "BTCUSDT",
        side: "LONG",
        stopLossPrice: 99,
        takeProfitPrice: 101,
        nativeProtectionVerified: false,
        maxLossAtStopUsdt: 0.4,
      },
    ],
    apiRecovery: { active: false },
  };
  let result = bot.portfolioRiskCheck({ symbol: "ETHUSDT", side: "LONG" }, { maxLossAtStopUsdt: 0.2 }, 70);
  assert.equal(result.rejected, true);
  assert.equal(result.humanReviewRequired, true);
  assert.match(result.reason, /missing verified TP\/SL protection/);

  bot.store.state.openPositions[0].nativeProtectionVerified = true;
  bot.store.state.openPositions[0].maxLossAtStopUsdt = 0.5;
  result = bot.portfolioRiskCheck({ symbol: "ETHUSDT", side: "LONG" }, { maxLossAtStopUsdt: 0.4 }, 70);
  assert.equal(result.rejected, false);
  assert.equal(result.currentRiskUsdt, 0.5);
  assert.equal(result.candidateRiskUsdt, 0.4);

  result = bot.portfolioRiskCheck({ symbol: "SOLUSDT", side: "LONG" }, { maxLossAtStopUsdt: 3 }, 70);
  assert.equal(result.rejected, true);
  assert.match(result.reason, /portfolio max loss/);
}

function reconciliationBot(position, trade, positions) {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({ dryRun: false, entryConfirmationTimeoutMs: 15000 }));
  bot.log = log;
  bot.adaptive.log = log;
  bot.store.state = {
    paused: false,
    pauseReason: null,
    openPositions: [position],
    lastPrices: {},
    daily: { tradesOpened: 0, realizedPnlUsdt: 0, losingTrades: 0 },
    equity: { realizedPnlUsdt: 0 },
  };
  bot.store.trades = [trade];
  bot.store.saveState = () => {};
  bot.store.saveAll = () => {};
  bot.risk.store = bot.store;
  bot.client = {
    getPositions: async () => positions,
    getOrder: async () => null,
    setTradingStop: async () => ({}),
  };
  bot.telegram = { send: async () => {} };
  return { bot, events };
}

async function testReconciliation() {
  const old = new Date(Date.now() - 20000).toISOString();
  const expired = reconciliationBot(
    { id: "failed", mode: "LIVE", status: "ENTRY_PENDING_CONFIRMATION", symbol: "BTCUSDT", side: "LONG", openedAt: old, positionIdx: 0 },
    { id: "failed", status: "ENTRY_PENDING_CONFIRMATION" },
    []
  );
  await expired.bot.reconcileLivePositions();
  assert.equal(expired.bot.store.state.openPositions.length, 0);
  assert.equal(expired.bot.store.trades[0].status, "ENTRY_FAILED");
  assert.equal(expired.bot.store.state.daily.tradesOpened, 0);

  const now = new Date().toISOString();
  const confirmed = reconciliationBot(
    {
      id: "open",
      mode: "LIVE",
      status: "ENTRY_PENDING_CONFIRMATION",
      entryOrderStatus: "FILLED",
      symbol: "BTCUSDT",
      side: "LONG",
      openedAt: now,
      entrySubmittedAt: now,
      positionIdx: 0,
      stopLossPrice: 99,
      takeProfitPrice: 101,
      entryPrice: 100,
      tickSize: "0.1",
    },
    { id: "open", status: "ENTRY_PENDING_CONFIRMATION" },
    [{ symbol: "BTCUSDT", side: "Buy", size: "0.01", avgPrice: "100", positionIdx: 0, leverage: "15", liqPrice: "94" }]
  );
  await confirmed.bot.reconcileLivePositions();
  assert.equal(confirmed.bot.store.state.openPositions[0].status, "OPEN");
  assert.equal(confirmed.bot.store.trades[0].status, "OPEN");
  assert.equal(confirmed.bot.store.state.daily.tradesOpened, 1);
  assert.ok(confirmed.events.some((event) => event.message === "POSITION OPENED"));
  assert.ok(confirmed.events.some((event) => event.message === "RECONCILIATION SUCCESS"));

  const hedgeConflict = reconciliationBot(
    {
      id: "managed",
      mode: "LIVE",
      status: "OPEN",
      symbol: "BTCUSDT",
      side: "LONG",
      openedAt: now,
      positionIdx: 1,
      stopLossPrice: 99,
      takeProfitPrice: 101,
      entryPrice: 100,
      nativeProtectionVerified: true,
    },
    { id: "managed", status: "OPEN" },
    [
      { symbol: "BTCUSDT", side: "Buy", size: "0.01", avgPrice: "100", positionIdx: 1, leverage: "15", liqPrice: "94" },
      { symbol: "BTCUSDT", side: "Sell", size: "0.01", avgPrice: "100", positionIdx: 2, leverage: "15", liqPrice: "106" },
    ]
  );
  await hedgeConflict.bot.reconcileLivePositions();
  assert.equal(hedgeConflict.bot.unmanagedLiveExposure, true);

  const nativeTakeProfit = reconciliationBot(
    {
      id: "tp",
      mode: "LIVE",
      status: "OPEN",
      symbol: "BTCUSDT",
      side: "LONG",
      openedAt: now,
      positionIdx: 0,
      size: "0.01",
      entryPrice: 100,
      stopLossPrice: 99,
      takeProfitPrice: 101,
      nativeProtectionVerified: true,
    },
    { id: "tp", status: "OPEN", mode: "LIVE" },
    []
  );
  await nativeTakeProfit.bot.handleOrderUpdate({
    symbol: "BTCUSDT",
    orderId: "native-tp",
    normalizedStatus: "FILLED",
    stopOrderType: "TakeProfit",
    avgPrice: "101",
  });
  assert.equal(nativeTakeProfit.bot.store.state.openPositions.length, 0);
  assert.ok(nativeTakeProfit.events.some((event) => event.message === "TP HIT"));
}

async function testLiveEntrySafetyUsesParsedUtaBalance() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({ dryRun: false, setLeverageOnEntry: false }));
  bot.log = log;
  bot.adaptive.log = log;
  bot.unmanagedLiveExposure = false;
  bot.client = {
    getOpenOrders: async () => [],
    getLeverage: async () => ({ leverage: 8, rawResponse: [{ symbol: "BTCUSDT", leverage: "8" }] }),
    getUsdtBalance: async () =>
      parseUnifiedUsdtBalance({
        list: [
          {
            totalAvailableBalance: "0",
            totalEquity: "58",
            coin: [
              {
                coin: "USDT",
                walletBalance: "58",
                equity: "58",
                usdValue: "58",
                totalPositionIM: "",
                totalOrderIM: "",
                locked: "0",
                bonus: "0",
                marginCollateral: true,
                collateralSwitch: true,
              },
            ],
          },
        ],
      }),
  };
  const safety = await bot.liveEntrySafety({ symbol: "BTCUSDT", side: "LONG" }, 58);
  assert.equal(safety.rejected, false);
  assert.equal(safety.availableBalanceUsdt, 58);
  assert.ok(events.some((event) => event.message === "Live order safety balance check."));
}

function scannerAnalysis(overrides = {}) {
  return {
    ema9: 105,
    ema21: 103,
    ema50: 100,
    emaGapPct: 1.2,
    previousEmaGapPct: 0.6,
    rsi14: 61,
    breakout: true,
    breakdown: false,
    volumeSpike: 2.2,
    momentumPct: 0.22,
    lastCandleMomentumPct: 0.09,
    upMomentumCandles: 3,
    downMomentumCandles: 0,
    bodyDirection: "UP",
    bodyStrength: 0.7,
    atrPct: 0.25,
    rangeExpansion: 1.5,
    rangePosition: 0.5,
    ...overrides,
  };
}

async function testSurvivabilityScannerScoring() {
  const { log } = logCollector();
  const cfg = config({
    learningPhaseMode: false,
    min24hVolumeUsdt: 100000,
    takeProfitPct: 1.5,
    estimatedFeePctPerSide: 0.055,
    minProjectedEdgePct: 0.35,
    minVolumeSpike: 1.35,
    minBurstMomentumPct: 0.08,
    minMomentumPersistenceCandles: 2,
  });
  const scanner = new Scanner(cfg, {}, log);
  const strongMarket = marketProfileFromBenchmarks(cfg, scannerAnalysis(), scannerAnalysis());
  scanner.cachedBenchmarkDirections = { BTCUSDT: "UP", ETHUSDT: "UP" };
  const item = { info: { symbol: "SOLUSDT" }, price: 100, volume: 2000000, spreadPct: 0.04 };
  const strong = scanner.scoreDirection("LONG", item, scannerAnalysis(), scannerAnalysis(), scannerAnalysis(), strongMarket, []);
  assert.equal(strong.eligible, true);
  assert.equal(strong.marketRegimeType, "STRONG_TRENDING_MARKET");
  assert.ok(strong.marketRegimeTags.includes("STRONG_TRENDING_MARKET"));
  assert.ok(strong.scoreBreakdown.some((reason) => reason.includes("BTC trend alignment")));
  assert.ok(strong.scoreBreakdown.some((reason) => reason.includes("strong trending regime")));
  assert.ok(strong.convictionScore >= cfg.minConvictionScore);
  assert.ok(strong.feeEdgeRatio >= cfg.minEdgeToCostRatio);

  scanner.cachedBenchmarkDirections = { BTCUSDT: "CHOPPY", ETHUSDT: "CHOPPY" };
  const chopMarket = marketProfileFromBenchmarks(
    cfg,
    scannerAnalysis({ ema9: 10, ema21: 10.01, ema50: 10.02, momentumPct: 0.02, upMomentumCandles: 1, breakout: true, volumeSpike: 0.8, bodyStrength: 0.2, rangeExpansion: 1.6, atrPct: 0.18 }),
    scannerAnalysis({ ema9: 10.02, ema21: 10.01, ema50: 10, momentumPct: -0.01, upMomentumCandles: 0, downMomentumCandles: 1, breakout: false, volumeSpike: 0.7, bodyStrength: 0.2, rangeExpansion: 1.5, atrPct: 0.16 })
  );
  const weak = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "NOISEUSDT" }, price: 10, volume: 120000, spreadPct: 0.2 },
    scannerAnalysis({
      ema9: 10,
      ema21: 10.01,
      ema50: 10.02,
      breakout: false,
      volumeSpike: 1.0,
      momentumPct: 0.09,
      lastCandleMomentumPct: 0.02,
      upMomentumCandles: 1,
      bodyStrength: 0.25,
      atrPct: 0.12,
    }),
    scannerAnalysis({
      ema9: 10,
      ema21: 10.01,
      ema50: 10.02,
      breakout: false,
      volumeSpike: 1.0,
      momentumPct: 0.04,
      lastCandleMomentumPct: 0.01,
      upMomentumCandles: 1,
      bodyStrength: 0.25,
      atrPct: 0.12,
    }),
    scannerAnalysis({ ema9: 10, ema21: 10.01, ema50: 10.02, momentumPct: 0 }),
    chopMarket,
    []
  );
  assert.equal(weak.eligible, false);
  assert.ok(weak.marketRegimeTags.includes("SIDEWAYS_CHOP_MARKET"));
  assert.ok(weak.rejected.some((reason) => reason.includes("volume confirmation")));
  assert.ok(weak.rejected.some((reason) => reason.includes("momentum did not persist")));
  assert.ok(weak.rejected.some((reason) => reason.includes("anti-chop filter")));
}

async function testNextGenerationContinuationScoring() {
  const { log } = logCollector();
  const cfg = config({
    min24hVolumeUsdt: 100000,
    continuationEngineEnabled: true,
    continuationMinStrength: 58,
    candleIntervalMacro: "60M",
    minSignalScore: 40,
    minConvictionScore: 45,
  });
  const scanner = new Scanner(cfg, {}, log);
  scanner.cachedBenchmarkDirections = { BTCUSDT: "UP", ETHUSDT: "UP" };
  const market = marketProfileFromBenchmarks(cfg, scannerAnalysis(), scannerAnalysis());
  const signal = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "SOLUSDT" }, price: 100, volume: 12000000, spreadPct: 0.025 },
    scannerAnalysis({ volumeSpike: 2.4, momentumPct: 0.28, lastCandleMomentumPct: 0.12, upMomentumCandles: 4 }),
    scannerAnalysis({ volumeSpike: 2.0, momentumPct: 0.18, upMomentumCandles: 4 }),
    scannerAnalysis({ momentumPct: 0.16, upMomentumCandles: 4 }),
    scannerAnalysis({ momentumPct: 0.12, upMomentumCandles: 3 }),
    market,
    []
  );
  assert.equal(signal.trend1h, "UP");
  assert.equal(signal.macroAligned, true);
  assert.ok(signal.continuationStrength >= cfg.continuationMinStrength);
  assert.notEqual(signal.continuationSetupType, "NONE");
  assert.ok(signal.scoreBreakdown.some((reason) => reason.includes("high-frequency continuation engine")));
  assert.ok(signal.scoreBreakdown.some((reason) => reason.includes("1h macro directional bias aligned")));
  assert.ok(signal.smartProjectedNetEdgePct > 0);
}

async function testV11ActiveMarketEngine() {
  const { log } = logCollector();
  const cfg = config({
    v11ActiveMarketEngine: true,
    v11MeanReversionEnabled: true,
    allowChoppyMarket: false,
    min24hVolumeUsdt: 100000,
    minSignalScore: 35,
    minConvictionScore: 35,
    nearMissLearningEnabled: true,
    nearMissMaxPointGap: 3,
    v11NearMissReevaluationMaxGap: 3,
  });
  const scanner = new Scanner(cfg, {}, log);
  scanner.cachedBenchmarkDirections = { BTCUSDT: "CHOPPY", ETHUSDT: "CHOPPY" };
  const chopMarket = {
    direction: "CHOPPY",
    primary: "SIDEWAYS_CHOP_MARKET",
    tags: ["SIDEWAYS_CHOP_MARKET"],
    confidence: 42,
    reasons: ["test chop range"],
    riskMultiplier: 1,
    aggressionMultiplier: 1,
  };
  const signal = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "SOLUSDT" }, price: 20, volume: 8000000, spreadPct: 0.02 },
    scannerAnalysis({
      ema9: 20,
      ema21: 20.01,
      ema50: 20,
      rsi14: 43,
      breakout: false,
      volumeSpike: 1.5,
      momentumPct: 0.01,
      lastCandleMomentumPct: 0.01,
      upMomentumCandles: 1,
      bodyStrength: 0.35,
      rangePosition: 0.08,
    }),
    scannerAnalysis({
      ema9: 20,
      ema21: 20.01,
      ema50: 20,
      rsi14: 42,
      breakout: false,
      volumeSpike: 1.45,
      momentumPct: 0.01,
      lastCandleMomentumPct: 0.01,
      upMomentumCandles: 1,
      bodyStrength: 0.35,
      rangeExpansion: 1.1,
      rangePosition: 0.06,
    }),
    scannerAnalysis({ ema9: 20, ema21: 20.01, ema50: 20, momentumPct: 0.01, breakout: false, upMomentumCandles: 1 }),
    scannerAnalysis({ ema9: 20, ema21: 20.01, ema50: 20, momentumPct: 0.01, breakout: false, upMomentumCandles: 1 }),
    scannerAnalysis({ ema9: 20, ema21: 20.01, ema50: 20, momentumPct: 0.01, breakout: false, upMomentumCandles: 1 }),
    chopMarket,
    []
  );
  assert.equal(signal.meanReversionActive, true);
  assert.equal(signal.setupType, "MEAN_REVERSION_RANGE");
  assert.equal(signal.continuationSetupType, "MEAN_REVERSION_RANGE");
  assert.ok(signal.scoreBreakdown.some((reason) => reason.includes("mean reversion module active")));
  assert.equal(signal.rejected.some((reason) => /choppy-market entries disabled/i.test(reason)), false);
  assert.equal(signal.rejected.some((reason) => /momentum did not persist/i.test(reason)), false);
  assert.ok(signal.atrExitPct > 0);
  const bot = new LadderBot(cfg);
  bot.store.state = {
    mode: "DRY_RUN",
    openPositions: [],
    daily: {},
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
  };
  bot.risk.store = bot.store;
  const plan = bot.risk.sizingPlan(
    { ...signal, score: 78, convictionScore: 70, profitQualityScore: 72, tradeCategory: "NORMAL_CONTINUATION" },
    100,
    instrument("SOLUSDT", { qtyStep: "0.1", minOrderQty: "0.1", minNotionalValue: "5" }),
    3
  );
  assert.equal(plan.rejected, false);
  assert.ok(plan.reasonsForSizingTier.some((reason) => /V11 mean reversion ATR exit target/i.test(reason)));
  assert.ok(plan.takeProfitPct >= cfg.minExpectedMovePct && plan.takeProfitPct <= cfg.takeProfitPct);

  const aligned = multiTimeframeTrendConfirmation(
    cfg,
    "LONG",
    scannerAnalysis({ momentumPct: 0.2, upMomentumCandles: 3 }),
    scannerAnalysis({ momentumPct: 0.18, upMomentumCandles: 3 }),
    scannerAnalysis({ momentumPct: 0.16, upMomentumCandles: 3 }),
    scannerAnalysis({ momentumPct: 0.14, upMomentumCandles: 3 }),
    scannerAnalysis({ momentumPct: 0.12, upMomentumCandles: 3 })
  );
  const conflicted = multiTimeframeTrendConfirmation(
    cfg,
    "LONG",
    scannerAnalysis({ momentumPct: 0.2, upMomentumCandles: 3 }),
    scannerAnalysis({ momentumPct: 0.18, upMomentumCandles: 3 }),
    scannerAnalysis({ ema9: 95, ema21: 97, ema50: 100, momentumPct: -0.18, downMomentumCandles: 3, bodyDirection: "DOWN" }),
    scannerAnalysis({ ema9: 95, ema21: 97, ema50: 100, momentumPct: -0.16, downMomentumCandles: 3, bodyDirection: "DOWN" }),
    scannerAnalysis({ ema9: 95, ema21: 97, ema50: 100, momentumPct: -0.14, downMomentumCandles: 3, bodyDirection: "DOWN" })
  );
  assert.equal(aligned.directions.macro4h, "UP");
  assert.ok(aligned.score > conflicted.score);
  assert.equal(conflicted.macroLongOpposite, true);
}

async function testV11ActivityReport() {
  const bot = new LadderBot(config({ profitControlledEquityMode: true, dryRun: true }));
  bot.store.state = {
    mode: "DRY_RUN",
    openPositions: [],
    profitControlled: {
      startEquityUsdt: 100,
      exchangeReportedTotalEquityUsdt: 100,
      sizingEquityBaseUsdt: 100,
      usableMarginUsdt: 100,
    },
    daily: {},
    ladder: {},
    symbolCooldowns: {},
  };
  bot.recordActivityEvent("scanCandidate", { count: 7 });
  bot.recordActivityEvent("scanRejected", { count: 4 });
  bot.recordActivityEvent("scanAccepted", { count: 3 });
  const report = bot.writeActivityReport();
  assert.equal(report.candidateCount, 7);
  assert.equal(report.rejectedCount, 4);
  assert.equal(report.acceptedCount, 3);
  assert.equal(report.safety.feeProtectionActive, true);
  assert.ok(fs.existsSync(path.join(bot.config.reportsDir, "activity-report.json")));
}

async function testActiveAdaptiveScalperPaperConfigAndSafety() {
  const cfg = withEnv(
    {
      PAPER_TRADING_MODE: "true",
      ACTIVE_ADAPTIVE_SCALPER_MODE: "true",
      BYBIT_TESTNET: "false",
      BYBIT_DEMO_TRADING: "false",
      DRY_RUN: "true",
    },
    () => loadConfig()
  );
  assert.equal(cfg.activeAdaptiveScalperMode, true);
  assert.equal(cfg.paperTradingMode, true);
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.exchangeEnvironment, "PAPER");
  assert.ok(cfg.dataDir.endsWith(path.join("data", "paper-trading")));
  assert.equal(cfg.minSignalScore, 38);
  assert.equal(cfg.minConvictionScore, 42);
  assert.equal(cfg.continuousExecutionMode, false);
  assert.equal(cfg.disableDailyTradeLimits, true);
  assert.equal(cfg.confidenceSizingEnabled, true);
  assert.ok(packageJson.scripts.paper.includes("DRY_RUN=true"));
  assert.ok(!packageJson.scripts.paper.includes("DRY_RUN=false"));

  assert.throws(
    () =>
      withEnv(
        {
          ACTIVE_ADAPTIVE_SCALPER_MODE: "true",
          DRY_RUN: "false",
          BYBIT_TESTNET: "false",
          ACKNOWLEDGE_LIVE_TRADING: "true",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
        },
        () => loadConfig()
      ),
    /requires DRY_RUN=true/
  );
}

async function testActiveAdaptiveScalperConfidenceSizingAndDailyLoss() {
  const cfg = config({
    activeAdaptiveScalperMode: true,
    paperTradingMode: true,
    confidenceSizingEnabled: true,
    continuousExecutionMode: false,
    paperDailyLossLimitPct: 3,
    dryRun: true,
  });
  const bot = new LadderBot(cfg);
  bot.store.state = {
    mode: "DRY_RUN",
    paused: false,
    pauseReason: null,
    equity: { startingUsdt: 100, realizedPnlUsdt: 0, currentUsdt: 100 },
    openPositions: [],
    symbolCooldowns: {},
    daily: {
      date: new Date().toISOString().slice(0, 10),
      startingEquity: 100,
      tradesOpened: 0,
      losingTrades: 0,
      realizedPnlUsdt: 0,
    },
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
  };
  bot.risk.store = bot.store;
  const symbolInfo = instrument("ETHUSDT", { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "1" });
  const baseSignal = {
    symbol: "ETHUSDT",
    side: "LONG",
    price: 100,
    score: 62,
    projectedNetEdgePct: 0.7,
    feeEdgeRatio: 2.1,
    liquidityScore: 80,
    volumeCondition: "CONFIRMED_VOLUME",
    btcTrendAligned: true,
    volatilityRegime: "NORMAL",
    continuationStrength: 55,
  };
  const small = bot.risk.sizingPlan({ ...baseSignal, convictionScore: 55 }, 100, symbolInfo, 3);
  const normal = bot.risk.sizingPlan({ ...baseSignal, convictionScore: 66 }, 100, symbolInfo, 3);
  const large = bot.risk.sizingPlan({ ...baseSignal, convictionScore: 78 }, 100, symbolInfo, 3);
  assert.equal(small.rejected, false);
  assert.equal(normal.rejected, false);
  assert.equal(large.rejected, false);
  assert.equal(small.convictionTier, "PAPER_CONFIDENCE_SMALL");
  assert.equal(normal.convictionTier, "PAPER_CONFIDENCE_NORMAL");
  assert.equal(large.convictionTier, "PAPER_CONFIDENCE_LARGE");
  assert.ok(large.maxLossAtStopUsdt >= normal.maxLossAtStopUsdt);
  assert.ok(normal.maxLossAtStopUsdt >= small.maxLossAtStopUsdt);

  bot.risk.updateEquity(96.5);
  assert.equal(bot.store.state.paused, true);
  assert.match(bot.store.state.pauseReason, /paper daily loss limit/i);
  assert.match(bot.risk.entryBlockReason(96.5, "ETHUSDT"), /paper daily loss limit/i);
}

async function testActiveAdaptiveScalperTradingReport() {
  const { events, log } = logCollector();
  const cfg = config({
    activeAdaptiveScalperMode: true,
    paperTradingMode: true,
    confidenceSizingEnabled: true,
    dryRun: true,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  bot.store.state = {
    mode: "DRY_RUN",
    openPositions: [],
    activeAdaptiveScalper: null,
    daily: {},
    ladder: {},
    performance: {
      closedTrades: 1,
      wins: 1,
      losses: 0,
      winRatePct: 100,
      grossPnlUsdt: 0.4,
      realizedPnlUsdt: 0.3,
      totalFeesUsdt: 0.1,
      symbols: {},
    },
  };
  bot.store.trades = [
    {
      id: "paper-1",
      mode: "DRY_RUN",
      status: "CLOSED",
      symbol: "ETHUSDT",
      setupType: "TREND_CONTINUATION",
      pnlUsdt: 0.3,
      feesUsdt: 0.1,
      maximumFavorableExcursionPct: 0.8,
      maximumAdverseExcursionPct: 0.25,
      softenedRejections: [{ reason: "volume confirmation below survivability threshold" }],
      inactivityRelaxedEntry: true,
      inactivityRelaxationSuccessful: true,
      openedAt: new Date().toISOString(),
      exitedAt: new Date().toISOString(),
    },
  ];
  bot.adaptive.load();
  bot.adaptive.syncFromClosedTrades(bot.store.trades);
  bot.recordRejectedTrade(
    {
      symbol: "BTCUSDT",
      side: "SHORT",
      score: 41,
      requiredScore: 42,
      convictionScore: 44,
      requiredConvictionScore: 45,
      setupType: "BREAKOUT_RETEST",
      marketRegimeV2: "SIDEWAYS_CHOP",
      antiChopContribution: -6,
      convictionContribution: -1,
      rejected: ["low conviction: 44 below 45"],
    },
    "low conviction: 44 below 45",
    { stage: "SCAN" }
  );
  const report = bot.writeTradingReport(true);
  const rejectionReport = bot.writeRejectionReport(true);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(report.tradesTaken, 1);
  assert.equal(report.tradesRejected, 1);
  assert.equal(report.rejectionReasons.CONVICTION_BELOW_THRESHOLD, 1);
  assert.equal(report.winRatePct, 100);
  assert.equal(report.pnlUsdt, 0.3);
  assert.equal(report.averageMaximumFavorableExcursionPct, 0.8);
  assert.equal(report.averageMaximumAdverseExcursionPct, 0.25);
  assert.equal(report.exitEfficiency.averageMaximumFavorableExcursionPct, 0.8);
  assert.equal(report.symbolPerformance.ETHUSDT.trades, 1);
  assert.equal(report.participation.inactivityRelaxation.closedTrades, 1);
  assert.equal(report.protections.dailyLossLimitActive, true);
  assert.equal(report.protections.liveOrdersDisabled, true);
  assert.ok(report.learningMemory.winRateBySymbol.ETHUSDT);
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "trading_report.json")));
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "edge-report.json")));
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "expectancy.json")));
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "system-health.json")));
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "latest-summary.json")));
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "rejection-report.json")));
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "daily", `${today}-diagnostics.json`)));
  assert.equal(rejectionReport.rankedRejectionReasons[0].reason, "CONVICTION_BELOW_THRESHOLD");
  assert.equal(rejectionReport.dailyDiagnostics.rejectedSignals[0].setupType, "BREAKOUT_RETEST");
  assert.equal(rejectionReport.exitEfficiency.averageMaximumFavorableExcursionPct, 0.8);
  assert.ok(events.some((event) => event.message === "PAPER_TRADE_REJECTED"));
}

async function testParticipationRecoverySoftensOnlyNonSafetyFilters() {
  const { log } = logCollector();
  const cfg = config({
    activeAdaptiveScalperMode: true,
    paperTradingMode: true,
    participationRecoveryMode: true,
    adaptiveLearningEnabled: false,
    allowChoppyMarket: false,
    minLiquidityScore: 85,
    minVolumeSpike: 1.3,
    minProjectedEdgePct: 0.01,
    minEdgeToCostRatio: 0.1,
    smartEdgeMinNetPct: 0.01,
    smartEdgeMinTpProbability: 0.1,
    maxChopScore: 0,
    antiChopPenaltyMax: 10,
  });
  const scanner = new Scanner(cfg, {}, log);
  scanner.runtimeContext.dynamicInactivityRecovery = {
    active: true,
    stage: "INACTIVE_8H",
    convictionThresholdMultiplier: 1,
    convictionThresholdDelta: -4,
    convictionRelaxPct: 4,
    convictionRelaxPoints: 4,
  };
  scanner.cachedBenchmarkDirections = { BTCUSDT: "CHOPPY", ETHUSDT: "CHOPPY" };
  const signal = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "ETHUSDT" }, price: 100, volume: 250000, spreadPct: 0.08 },
    scannerAnalysis({
      ema9: 100,
      ema21: 100.02,
      ema50: 100.01,
      breakout: false,
      volumeSpike: 0.65,
      momentumPct: 0.01,
      lastCandleMomentumPct: 0.01,
      upMomentumCandles: 1,
      bodyStrength: 0.2,
      rangeExpansion: 0.4,
      atrPct: 0.12,
    }),
    scannerAnalysis({
      ema9: 100,
      ema21: 100.01,
      ema50: 100,
      breakout: false,
      volumeSpike: 0.65,
      momentumPct: 0.01,
      lastCandleMomentumPct: 0.01,
      upMomentumCandles: 1,
      bodyStrength: 0.2,
      rangeExpansion: 0.4,
      atrPct: 0.12,
    }),
    scannerAnalysis({ ema9: 100, ema21: 100.01, ema50: 100, momentumPct: 0, rangeExpansion: 0.4 }),
    scannerAnalysis({ ema9: 100, ema21: 100.01, ema50: 100, momentumPct: 0, rangeExpansion: 0.4 }),
    {
      direction: "CHOPPY",
      primary: "SIDEWAYS_CHOP_MARKET",
      tags: ["SIDEWAYS_CHOP_MARKET", "LOW_LIQUIDITY_MARKET"],
      confidence: 40,
      reasons: ["test over-filtered chop"],
      riskMultiplier: 1,
      aggressionMultiplier: 1,
    },
    []
  );
  assert.equal(signal.participationRecoveryMode, true);
  assert.ok(signal.softenedRejections.some((item) => /volume confirmation below survivability/i.test(item.reason)));
  assert.ok(signal.softenedRejections.some((item) => item.inactivityRelaxed));
  assert.equal(signal.rejected.some((reason) => /volume confirmation below survivability/i.test(reason)), false);
  assert.ok(signal.scoreBreakdown.some((reason) => /participation recovery softened/i.test(reason)));
}

async function testProfitControlledRejectionReportAndDiagnostics() {
  const { events, log } = logCollector();
  const cfg = config({
    dryRun: true,
    profitControlledEquityMode: true,
    participationRecoveryMode: true,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  bot.store.state.mode = "PROFIT_CONTROLLED_EQUITY_MODE";
  bot.recordRejectedTrade(
    {
      symbol: "ETHUSDT",
      side: "LONG",
      score: 69,
      requiredScore: 70,
      convictionScore: 48,
      requiredConvictionScore: 45,
      setupType: "BREAKOUT_RETEST",
      marketRegimeV2: "SIDEWAYS_CHOP",
      rejected: [
        "smart edge filter: probability-adjusted edge 0.050% with TP probability 0.300",
        "fee inefficiency: expected move 0.120% vs cost 0.100% ratio 1.20",
      ],
    },
    "smart edge filter: probability-adjusted edge 0.050% with TP probability 0.300",
    { stage: "SCAN" }
  );
  bot.recordAcceptedRelaxedSignal(
    {
      symbol: "ETHUSDT",
      side: "LONG",
      score: 69,
      requiredScore: 70,
      convictionScore: 48,
      requiredConvictionScore: 45,
      setupType: "BREAKOUT_RETEST",
      marketRegimeV2: "SIDEWAYS_CHOP",
      nearMissTrade: true,
      nearMissGap: 1,
      softenedRejections: [{ reason: "momentum did not persist long enough" }],
    },
    "near-miss positive-edge signal accepted",
    { stage: "NEAR_MISS_SIGNAL" }
  );
  const report = bot.writeRejectionReport(true);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(report.mode, "PROFIT_CONTROLLED_EQUITY_MODE");
  assert.equal(report.rankedRejectionReasons[0].reason, "POST_COST_EDGE_INSUFFICIENT");
  assert.equal(report.rankedRejectionReasons[0].count, 1);
  assert.equal(report.totalAcceptedRelaxedSignals, 1);
  assert.equal(report.dailyDiagnostics.rejectedSignals[0].symbol, "ETHUSDT");
  assert.equal(report.dailyDiagnostics.acceptedRelaxedSignals[0].nearMiss, true);
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "rejection-report.json")));
  assert.ok(fs.existsSync(path.join(cfg.reportsDir, "daily", `${today}-diagnostics.json`)));
  assert.ok(events.some((event) => event.message === "REJECTION_REPORT_UPDATED"));
}

async function testMarketRegimeClassification() {
  const cfg = config();
  const strong = marketProfileFromBenchmarks(cfg, scannerAnalysis(), scannerAnalysis());
  assert.equal(strong.primary, "STRONG_TRENDING_MARKET");
  assert.ok(strong.tags.includes("STRONG_TRENDING_MARKET"));
  assert.ok(strong.aggressionMultiplier > 1);

  const fake = marketProfileFromBenchmarks(
    cfg,
    scannerAnalysis({ breakout: true, bodyStrength: 0.18, rangeExpansion: 1.8, momentumPct: 0.06, upMomentumCandles: 1 }),
    scannerAnalysis({
      ema9: 95,
      ema21: 97,
      ema50: 100,
      momentumPct: -0.25,
      downMomentumCandles: 4,
      upMomentumCandles: 0,
      breakdown: true,
      breakout: false,
      bodyDirection: "DOWN",
      bodyStrength: 0.2,
      rangeExpansion: 1.7,
    })
  );
  assert.equal(fake.primary, "FAKE_BREAKOUT_ENVIRONMENT");
  assert.ok(fake.tags.includes("FAKE_BREAKOUT_ENVIRONMENT"));
  assert.ok(fake.riskMultiplier < 1);

  const late = sessionProfile(Date.UTC(2026, 0, 1, 23, 30));
  assert.equal(late.sessionRegime, "DEAD_HOURS");
}

async function testFocusedUniverseRestriction() {
  const { events, log } = logCollector();
  const subscribed = [];
  const expectedUniverse = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const symbols = [...expectedUniverse, "WIFUSDT"].map((symbol) => ({
    symbol,
    contractType: "LinearPerpetual",
    status: "Trading",
    settleCoin: "USDT",
  }));
  const tickers = new Map(
    [...expectedUniverse, "WIFUSDT"].map((symbol, index) => [
      symbol,
      {
        symbol,
        turnover24h: String(10000000 - index * 1000),
        lastPrice: "100",
        bid1Price: "99.99",
        ask1Price: "100.01",
      },
    ])
  );
  const client = {
    getSymbols: async () => symbols,
    getTicker: async (symbol) => tickers.get(symbol),
    getTickers: async () => {
      throw new Error("focused universe should not fetch all tickers");
    },
    subscribeTickers: (list) => subscribed.push(...list),
  };
  const scanner = new Scanner(config({ maxSymbolsToScan: 3 }), client, log);
  const universe = await scanner.universe();
  assert.deepEqual(universe.map((item) => item.info.symbol), expectedUniverse);
  assert.deepEqual(subscribed, expectedUniverse);
  assert.ok(events.some((event) => event.message === "Focused trading universe enabled."));
  assert.ok(events.some((event) => event.message === "Focused BTC/ETH/SOL market universe enabled; noisy market universe filtered."));
  const prepared = events.find((event) => event.message === "Focused BTC/ETH/SOL active market universe prepared.");
  assert.equal(prepared.details.rejected.outsideFocus, 1);
}

async function testExplorationSignalPath() {
  const { log } = logCollector();
  const cfg = config({
    minSignalScore: 90,
    minConvictionScore: 80,
    explorationModeEnabled: true,
    explorationMinSignalScore: 40,
    explorationMinConvictionScore: 45,
    explorationMinProjectedEdgePct: 0.2,
    explorationMinEdgeToCostRatio: 1.3,
    explorationMaxChopScore: 3,
    min24hVolumeUsdt: 100000,
    maxSpreadPct: 0.6,
    minVolumeSpike: 1.35,
    minMomentumPersistenceCandles: 2,
  });
  const scanner = new Scanner(cfg, {}, log);
  scanner.cachedBenchmarkDirections = { BTCUSDT: "CHOPPY", ETHUSDT: "CHOPPY" };
  const exploratoryMarket = {
    direction: "UP",
    primary: "ALTCOIN_MOMENTUM_MARKET",
    tags: ["ALTCOIN_MOMENTUM_MARKET"],
    confidence: 55,
    btcDirection: "CHOPPY",
    ethDirection: "CHOPPY",
    aggressionMultiplier: 1,
    riskMultiplier: 1,
    leverageMultiplier: 1,
    explorationMultiplier: 1,
    scoreAdjustment: 0,
    minSignalAdjustment: 0,
    minConvictionAdjustment: 0,
    holdMultiplier: 1,
    trailingDistanceMultiplier: 1,
    reasons: ["test exploratory altcoin momentum market"],
  };
  const exploratory = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "ADAUSDT" }, price: 1, volume: 3000000, spreadPct: 0.04 },
    scannerAnalysis({ ema9: 1.02, ema21: 1.01, ema50: 1.03, breakout: false, volumeSpike: 1.5, momentumPct: 0.13, lastCandleMomentumPct: 0.04 }),
    scannerAnalysis({ ema9: 1.02, ema21: 1.01, ema50: 1.03, breakout: false, volumeSpike: 1.45, momentumPct: 0.1, lastCandleMomentumPct: 0.03 }),
    scannerAnalysis(),
    exploratoryMarket,
    []
  );
  assert.equal(exploratory.eligible, true);
  assert.equal(exploratory.explorationTrade, true);
  assert.equal(exploratory.tradeCategory, "EXPLORATION");
  assert.ok(exploratory.score < exploratory.requiredScore);
  assert.ok(Array.isArray(exploratory.explorationWaivedRejections));
}

async function testExplorationMemoryRelaxation() {
  const { log } = logCollector();
  const cfg = config({
    minSignalScore: 100,
    minConvictionScore: 90,
    explorationModeEnabled: true,
    explorationMinSignalScore: 36,
    explorationMinConvictionScore: 42,
    explorationMinProjectedEdgePct: 0.2,
    explorationMinEdgeToCostRatio: 1.2,
    min24hVolumeUsdt: 100000,
    minVolumeSpike: 1.35,
    minMomentumPersistenceCandles: 2,
  });
  const fakeAdaptive = {
    currentPolicy: () => ({
      mode: "BASELINE",
      minSignalScore: 100,
      explorationMinSignalScore: 36,
      explorationMinConvictionScore: 42,
    }),
    evaluateSignal: () => ({
      scoreAdjustment: -8,
      confidence: 35,
      riskMultiplier: 0.9,
      leverageMultiplier: 0.95,
      rejected: false,
      reasons: ["test historical caution"],
      policy: { mode: "BASELINE" },
    }),
  };
  const scanner = new Scanner(cfg, {}, log, fakeAdaptive);
  scanner.cachedBenchmarkDirections = { BTCUSDT: "UP", ETHUSDT: "UP" };
  const signal = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "ETHUSDT" }, price: 10, volume: 3000000, spreadPct: 0.04 },
    scannerAnalysis({ volumeSpike: 1.7, momentumPct: 0.16, lastCandleMomentumPct: 0.04 }),
    scannerAnalysis({ volumeSpike: 1.6, momentumPct: 0.12, lastCandleMomentumPct: 0.03 }),
    scannerAnalysis(),
    "UP",
    []
  );
  assert.equal(signal.eligible, true);
  assert.equal(signal.explorationTrade, true);
  assert.ok(signal.explorationMemoryRelaxation > 0);
  assert.ok(signal.scoreBreakdown.some((reason) => reason.includes("exploration memory relaxation")));
}

async function testFeeAwareStatsAndSymbolCooldown() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({
    dryRun: true,
    estimatedFeePctPerSide: 0.055,
    symbolLossCooldownMinutes: 15,
    symbolReentryCooldownSeconds: 90,
  }));
  bot.log = log;
  bot.adaptive.log = log;
  const openedAt = new Date(Date.now() - 45000).toISOString();
  const position = {
    id: "fee-test",
    mode: "DRY_RUN",
    status: "OPEN",
    symbol: "BTCUSDT",
    side: "LONG",
    size: "1",
    entryPrice: 100,
    openedAt,
    stopLossPrice: 99,
    takeProfitPrice: 101.5,
  };
  bot.store.state = {
    mode: "DRY_RUN",
    paused: false,
    pauseReason: null,
    equity: { realizedPnlUsdt: 0 },
    daily: { tradesOpened: 1, losingTrades: 0, realizedPnlUsdt: 0, feesUsdt: 0, wins: 0, closedTrades: 0 },
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    openPositions: [position],
    lastPrices: {},
    symbolCooldowns: {},
    performance: {},
  };
  bot.store.trades = [{ ...position, status: "OPEN" }];
  bot.store.saveState = () => {};
  bot.store.saveAll = () => {};
  bot.risk.store = bot.store;
  bot.telegram = { send: async () => {} };

  bot.finalizePosition(position, 99, "hard stop loss hit");
  const trade = bot.store.trades[0];
  assert.equal(bot.store.state.openPositions.length, 0);
  assert.ok(trade.grossPnlUsdt < 0);
  assert.ok(trade.feesUsdt > 0);
  assert.ok(trade.pnlUsdt < trade.grossPnlUsdt);
  assert.equal(bot.store.state.performance.closedTrades, 1);
  assert.equal(bot.store.state.performance.losses, 1);
  assert.ok(bot.store.state.performance.totalFeesUsdt > 0);
  assert.ok(Date.parse(bot.store.state.symbolCooldowns.BTCUSDT.lossCooldownUntil) > Date.now());
  assert.ok(events.some((event) => event.message === "Performance stats updated."));
}

async function testFeeAwareEntryAndDynamicSizing() {
  const { log } = logCollector();
  const bot = new LadderBot(config({ dryRun: true }));
  bot.log = log;
  const rejected = bot.feeAwareEntryCheck({
    projectedNetEdgePct: 0.1,
    feeEdgeRatio: 1.1,
    convictionScore: 85,
  });
  assert.equal(rejected.rejected, true);
  assert.match(rejected.reason, /edge|move/i);
  const exploratoryPass = bot.feeAwareEntryCheck({
    explorationTrade: true,
    expectedMovePct: bot.config.minExpectedMovePct,
    projectedNetEdgePct: bot.config.explorationMinProjectedEdgePct + 0.02,
    feeEdgeRatio: bot.config.explorationMinEdgeToCostRatio + 0.05,
    convictionScore: bot.config.explorationMinConvictionScore + 1,
  });
  assert.equal(exploratoryPass.rejected, false);
  const pacedLowEdge = bot.feeAwareEntryCheck({
    explorationTrade: true,
    qualityPacingActive: true,
    expectedMovePct: bot.config.minExpectedMovePct,
    projectedNetEdgePct: bot.config.explorationMinProjectedEdgePct + 0.02,
    feeEdgeRatio: bot.config.explorationMinEdgeToCostRatio + 0.05,
    convictionScore: bot.config.explorationMinConvictionScore + 8,
  });
  assert.equal(pacedLowEdge.rejected, true);
  assert.match(pacedLowEdge.reason, /low-edge|fee-aware/i);
  const microScalp = bot.feeAwareEntryCheck({
    explorationTrade: true,
    expectedMovePct: 0.2,
    projectedNetEdgePct: 1,
    smartProjectedNetEdgePct: 1,
    feeEdgeRatio: 4,
    convictionScore: 90,
  });
  assert.equal(microScalp.rejected, true);
  assert.equal(microScalp.microScalp, true);
  const weakSmartEdge = bot.feeAwareEntryCheck({
    expectedMovePct: 1.2,
    projectedNetEdgePct: 1,
    smartProjectedNetEdgePct: 0.01,
    estimatedTpProbability: 0.3,
    feeEdgeRatio: 4,
    convictionScore: 90,
  });
  assert.equal(weakSmartEdge.rejected, true);
  assert.match(weakSmartEdge.reason, /smart edge|EDGE_GATE/i);

  bot.store.state = {
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
  };
  bot.risk.store = bot.store;
  const symbolInfo = {
    lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "1" },
    priceFilter: { tickSize: "0.01" },
  };
  const strongPlan = bot.risk.sizingPlan(
    {
      score: 90,
      price: 10,
      side: "LONG",
      convictionScore: 86,
      liquidityScore: 82,
      btcTrendAligned: true,
      volumeCondition: "STRONG_VOLUME_SPIKE",
      projectedNetEdgePct: 1.4,
      feeEdgeRatio: 4,
      adaptiveRiskMultiplier: 1.05,
    },
    100,
    symbolInfo,
    5
  );
  assert.equal(strongPlan.rejected, false);
  assert.ok(strongPlan.qualitySizeMultiplier > 1);
  assert.equal(strongPlan.highQualityContinuation, true);
  assert.equal(strongPlan.convictionTier, "TIER_2_STRONG_SETUP");

  const elitePlan = bot.risk.sizingPlan(
    {
      score: 96,
      price: 10,
      side: "LONG",
      convictionScore: 90,
      liquidityScore: 90,
      btcTrendAligned: true,
      volumeCondition: "STRONG_VOLUME_SPIKE",
      projectedNetEdgePct: 1.5,
      smartProjectedNetEdgePct: 0.8,
      feeEdgeRatio: 4,
      adaptiveRiskMultiplier: 1.1,
      eliteSetup: true,
    },
    100,
    symbolInfo,
    5
  );
  assert.equal(elitePlan.rejected, false);
  assert.equal(elitePlan.convictionTier, "TIER_3_ELITE_SETUP");
  assert.equal(elitePlan.eliteSetup, true);
  assert.ok(elitePlan.targetMarginUsdt >= bot.config.tier3MarginMinUsdt);
  assert.ok(elitePlan.partialTakeProfitPrice > 0);
  assert.ok(elitePlan.runnerTakeProfitPrice > elitePlan.standardTakeProfitPrice);

  const weakPlan = bot.risk.sizingPlan(
    {
      score: 55,
      price: 10,
      side: "LONG",
      convictionScore: 63,
      liquidityScore: 50,
      btcTrendAligned: false,
      volumeCondition: "EARLY_VOLUME",
      projectedNetEdgePct: 0.8,
      feeEdgeRatio: 2.45,
      adaptiveRiskMultiplier: 1,
      volatilityRegime: "HIGH_VOLATILITY",
    },
    100,
    symbolInfo,
    5
  );
  assert.equal(weakPlan.rejected, false);
  assert.ok(weakPlan.qualitySizeMultiplier < 1);

  const explorationPlan = bot.risk.sizingPlan(
    {
      score: 50,
      price: 10,
      side: "LONG",
      convictionScore: 52,
      liquidityScore: 60,
      btcTrendAligned: true,
      volumeCondition: "CONFIRMED_VOLUME",
      projectedNetEdgePct: 0.4,
      feeEdgeRatio: 1.7,
      adaptiveRiskMultiplier: 1,
      explorationTrade: true,
    },
    100,
    symbolInfo,
    5
  );
  assert.equal(explorationPlan.rejected, false);
  assert.equal(explorationPlan.explorationSizing, true);
  assert.ok(explorationPlan.qualitySizeMultiplier <= bot.config.explorationRiskMultiplier);
}

async function testNearMissSmallTradeUsesExploratoryEdgeAndRisk() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({
    dryRun: true,
    profitControlledEquityMode: true,
    profitExpansionMode: true,
    nearMissSmallTradeEnabled: true,
    nearMissSmallTradeMaxGap: 3,
    adaptiveLearningEnabled: false,
    smartEdgeMinNetPct: 0.22,
    smartEdgeMinTpProbability: 0.46,
    profitModeMinQualityScore: 70,
  }));
  bot.log = log;
  const signal = {
    symbol: "ETHUSDT",
    side: "LONG",
    price: 100,
    nearMissTrade: true,
    explorationTrade: true,
    tradeCategory: "EXPLORATION",
    expectedMovePct: 1,
    projectedNetEdgePct: 0.2,
    smartProjectedNetEdgePct: 0.15,
    estimatedTpProbability: 0.42,
    feeEdgeRatio: 1.35,
    convictionScore: 35,
    explorationRequiredConvictionScore: 32,
    requiredConvictionScore: 45,
    spreadPct: 0.02,
    estimatedSlippagePct: 0.08,
    trendQualityScore: 80,
    continuationStrength: 78,
    volumeSpike: 1.3,
    volumeCondition: "CONFIRMED_VOLUME",
    marketRegimeTags: ["SIDEWAYS_CHOP_MARKET"],
    marketPersonality: "WEAK_CHOP",
    continuationSetupType: "BREAKOUT_RETEST",
    setupType: "BREAKOUT_RETEST",
    marketBreadthScore: 82,
    portfolioAlphaScore: 65,
    multiTimeframeTrendScore: 82,
  };
  const edge = bot.feeAwareEntryCheck(signal);
  assert.equal(edge.rejected, false);
  assert.equal(edge.edgeModel.tier, "EXPLORATION_POSITIVE_EDGE");
  assert.ok(edge.requiredSmartEdgePct < bot.config.smartEdgeMinNetPct);
  const quality = bot.profitModeQualityCheck(signal, edge.edgeModel);
  assert.equal(quality.rejected, false);
  assert.equal(quality.tier, "NEAR_MISS");
  assert.equal(signal.explorationTrade, true);
  assert.ok(events.some((event) => event.message === "PROFIT_MODE_QUALITY_APPROVED" && event.details.nearMissQualityAllowed));
}

async function testLiveValidationSizingExecutionAndReentryControls() {
  const bot = new LadderBot(config({
    dryRun: false,
    liveValidationMode: true,
    liveValidationMaxAllocatedEquityUsdt: 10,
    liveValidationEliteRiskAtStopMaxPct: 0.75,
    liveValidationStrongRiskAtStopMaxPct: 0.5,
    liveValidationNormalRiskAtStopMaxPct: 0.35,
    liveValidationExplorationRiskAtStopMaxPct: 0.2,
    enablePostOnlyEntries: true,
    minEdgeToCostRatio: 1.8,
  }));
  bot.store.state = {
    mode: "LIVE",
    liveValidation: { level: 0, allocatedEquityLimitUsdt: 10 },
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    openPositions: [],
    daily: { startingEquity: 70, tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 },
    symbolCooldowns: {},
    apiRecovery: { active: false },
    consecutiveApiErrors: 0,
  };
  bot.risk.store = bot.store;
  const symbolInfo = {
    lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "1" },
    priceFilter: { tickSize: "0.01" },
  };
  const elitePlan = bot.risk.sizingPlan(
    {
      score: 96,
      price: 10,
      side: "LONG",
      convictionScore: 95,
      liquidityScore: 90,
      btcTrendAligned: true,
      volumeCondition: "STRONG_VOLUME_SPIKE",
      projectedNetEdgePct: 1.6,
      smartProjectedNetEdgePct: 1.1,
      feeEdgeRatio: 4,
      adaptiveRiskMultiplier: 1.4,
      eliteSetup: true,
      liveValidationRiskState: "RISK_STATE_NORMAL",
      liveValidationRiskMultiplier: 1,
    },
    10,
    symbolInfo,
    8
  );
  assert.equal(elitePlan.rejected, false);
  assert.equal(elitePlan.liveValidationRiskCapPct, 0.75);
  assert.ok(elitePlan.riskPctOfEquity <= 0.75);
  assert.ok(elitePlan.reasonsForSizingTier.some((reason) => /live validation cap/.test(reason)));

  const reducedPlan = bot.risk.sizingPlan(
    {
      score: 82,
      price: 10,
      side: "LONG",
      convictionScore: 82,
      liquidityScore: 82,
      btcTrendAligned: true,
      volumeCondition: "STRONG_VOLUME_SPIKE",
      projectedNetEdgePct: 1.2,
      feeEdgeRatio: 3,
      liveValidationRiskState: "RISK_STATE_REDUCED",
      liveValidationRiskMultiplier: 0.6,
    },
    10,
    symbolInfo,
    8
  );
  assert.equal(reducedPlan.rejected, false);
  assert.equal(reducedPlan.liveValidationRiskMultiplier, 0.6);
  assert.ok(reducedPlan.riskPctOfEquity < elitePlan.riskPctOfEquity);

  const makerSignal = {
    continuationSetupType: "BREAKOUT_RETEST",
    edgeModel: { expectedRewardCostRatio: bot.config.edgeNormalMinRewardCostRatio + 0.5 },
  };
  assert.equal(bot.executionTypeForSignal(makerSignal), "POST_ONLY_LIMIT");
  assert.equal(bot.executionTypeForSignal({ ...makerSignal, fomoTrigger: true }), "MARKET_TAKER");

  const edgeDetails = bot.liveValidationEdgeExecutionDetails(
    { symbol: "BTCUSDT", side: "LONG", setupType: "BREAKOUT_RETEST" },
    { notional: 25, maxLossAtStopUsdt: 0.05 },
    {
      projectedGrossProfitUsdt: 0.4,
      estimatedEntryFeePct: 0.02,
      estimatedExitFeePct: 0.055,
      liveSpreadPct: 0.01,
      conservativeSlippagePct: 0.03,
      estimatedFundingPct: 0,
      projectedTotalCostUsdt: 0.025,
      projectedNetProfitUsdt: 0.18,
      expectedRewardRiskRatio: 2,
      expectedRewardCostRatio: 4,
    }
  );
  assert.equal(edgeDetails.edgeGateResult, "APPROVED");
  assert.equal(edgeDetails.expectedEntryFeeUsdt, 0.005);
  assert.equal(edgeDetails.expectedExitFeeUsdt, 0.01375);

  bot.store.trades = [
    validationTrade("recent-loss", -0.2, {
      symbol: "BTCUSDT",
      side: "LONG",
      exitedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    }),
  ];
  const weakReentry = bot.intelligentReentrySignal({
    symbol: "BTCUSDT",
    side: "LONG",
    multiTimeframeAligned: true,
    breakoutTriggered: true,
    momentumPersistenceCandles: 2,
    continuationStrength: bot.config.continuationMinStrength + 2,
    smartProjectedNetEdgePct: bot.config.smartEdgeMinNetPct,
    feeEdgeRatio: bot.config.minEdgeToCostRatio,
    continuationSetupType: "TREND_CONTINUATION",
  });
  assert.equal(weakReentry, false);

  const freshReentry = bot.intelligentReentrySignal({
    symbol: "BTCUSDT",
    side: "LONG",
    multiTimeframeAligned: true,
    breakoutTriggered: true,
    momentumPersistenceCandles: 3,
    continuationStrength: bot.config.continuationMinStrength + 14,
    smartProjectedNetEdgePct: bot.config.smartEdgeMinNetPct + 0.12,
    feeEdgeRatio: bot.config.minEdgeToCostRatio + 0.3,
    continuationSetupType: "BREAKOUT_RETEST",
  });
  assert.equal(freshReentry, true);

  bot.store.trades = [
    validationTrade("recent-short", -0.1, {
      symbol: "ETHUSDT",
      side: "SHORT",
      exitedAt: new Date(Date.now() - 30 * 1000).toISOString(),
    }),
  ];
  const flip = bot.flipEntryCheck({
    symbol: "ETHUSDT",
    side: "LONG",
    continuationStrength: 40,
    smartProjectedNetEdgePct: 0.1,
    projectedNetEdgePct: 0.1,
    feeEdgeRatio: 1,
    convictionScore: 55,
  });
  assert.equal(flip.rejected, true);
}

async function testLiveValidationMinimumOrderFeasibility() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({
    dryRun: false,
    liveValidationMode: true,
    liveValidationMaxAllocatedEquityUsdt: 10,
    liveValidationNormalRiskAtStopMaxPct: 0.35,
    liveValidationEliteRiskAtStopMaxPct: 0.75,
  }));
  bot.log = log;
  bot.instrumentRulesBySymbol.set("ETHUSDT", instrument("ETHUSDT", {
    qtyStep: "0.001",
    minOrderQty: "0.001",
    minNotionalValue: "1",
  }));
  const feasible = bot.liveValidationOrderFeasibility(
    {
      symbol: "ETHUSDT",
      side: "LONG",
      price: 100,
      tradeCategory: "HIGH_CONVICTION",
    },
    {
      size: "0.020",
      notional: 2,
      leverage: 8,
      riskPct: 0.35,
      liveValidationRiskCapPct: 0.35,
    },
    10,
    {
      expectedNetEdgePct: 0.5,
      estimatedEntryFeePct: 0.02,
      estimatedExitFeePct: 0.055,
    }
  );
  assert.equal(feasible.rejected, false);
  assert.ok(feasible.finalRoundedMaxLossAtStopUsdt <= feasible.allowedMaxLossAtStopUsdt);
  assert.ok(events.some((event) => event.message === "FINAL_ROUNDED_MAX_LOSS_AT_STOP_USDT"));
  assert.ok(events.some((event) => event.message === "LIVE_VALIDATION_ORDER_SIZE_FEASIBLE"));

  bot.instrumentRulesBySymbol.set("BTCUSDT", instrument("BTCUSDT", {
    qtyStep: "0.001",
    minOrderQty: "0.100",
    minNotionalValue: "1",
  }));
  const rejected = bot.liveValidationOrderFeasibility(
    {
      symbol: "BTCUSDT",
      side: "LONG",
      price: 100,
      eliteSetup: true,
      tradeCategory: "ELITE_SETUP",
    },
    {
      size: "0.001",
      notional: 0.1,
      leverage: 8,
      riskPct: 0.75,
      liveValidationRiskCapPct: 0.75,
    },
    10,
    {
      expectedNetEdgePct: 1,
      estimatedEntryFeePct: 0.02,
      estimatedExitFeePct: 0.055,
    }
  );
  assert.equal(rejected.rejected, true);
  assert.match(rejected.reason, /smallest executable order exceeds/);
  assert.ok(events.some((event) => event.message === "ORDER_BELOW_EXCHANGE_MINIMUM"));
  assert.ok(events.some((event) => event.message === "ROUNDED_ORDER_EXCEEDS_RISK_LIMIT"));
}

async function testProfitControlledConfigGuardsAndSetupScript() {
  assert.match(packageJson.scripts["live:profit-controlled"], /PROFIT_CONTROLLED_EQUITY_MODE=true/);
  assert.doesNotMatch(packageJson.scripts["live:profit-controlled"], /ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK=true/);
  assert.doesNotMatch(packageJson.scripts["live:profit-controlled"], /ACKNOWLEDGE_LIVE_TRADING=true/);
  assert.match(packageJson.scripts["setup:profit-controlled"], /setupProfitControlled/);

  assert.throws(
    () =>
      withEnv(
        {
          BYBIT_DEMO_TRADING: "false",
          BYBIT_TESTNET: "false",
          DRY_RUN: "false",
          PROFIT_CONTROLLED_EQUITY_MODE: "true",
          ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK: "false",
          ACKNOWLEDGE_LIVE_TRADING: "true",
          ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
        },
        () => loadConfig()
      ),
    /PROFIT-CONTROLLED LIVE NOT STARTED — REAL-MONEY ACKNOWLEDGEMENT REQUIRED/
  );

  const profitConfig = withEnv(
    {
      BYBIT_DEMO_TRADING: "false",
      BYBIT_TESTNET: "false",
      DRY_RUN: "false",
      PROFIT_CONTROLLED_EQUITY_MODE: "true",
      ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK: "true",
      ACKNOWLEDGE_LIVE_TRADING: "true",
      ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
      BYBIT_REST_BASE_URL: "",
      BYBIT_WS_BASE_URL: "",
      BYBIT_PUBLIC_WS_BASE_URL: "",
      BYBIT_PRIVATE_WS_BASE_URL: "",
    },
    () => loadConfig()
  );
  assert.equal(profitConfig.exchangeEnvironment, "PROFIT_CONTROLLED_LIVE");
  assert.equal(profitConfig.profitControlledEquityMode, true);
  assert.ok(profitConfig.stateFile.endsWith("/data/profit-controlled-live/state.json"));
  assert.equal(profitConfig.forcedMarketSamplingEnabled, false);
  assert.equal(profitConfig.fomoBreakoutMode, false);
  assert.equal(profitConfig.microBreakoutEntries, false);
  assert.equal(profitConfig.allowChoppyMarket, false);
  assert.equal(profitConfig.unlimitedExplorationBudget, false);
  assert.equal(profitConfig.aggressiveLearningPhase, false);
  assert.equal(profitConfig.disableDailyTradeLimits, true);
  assert.equal(profitConfig.dailyTradeLimitsDisabled, true);
  assert.equal(profitConfig.continuousExecutionMode, true);
  assert.equal(profitConfig.participationRecoveryMode, true);
  assert.equal(profitConfig.nearMissSmallTradeEnabled, true);
  assert.equal(profitConfig.maxLeverage, 5);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "profit-controlled-setup-"));
  const secret = "do-not-print-this-secret";
  fs.writeFileSync(path.join(tempDir, ".env"), `BYBIT_API_KEY=test-key\nBYBIT_API_SECRET=${secret}\nACKNOWLEDGE_LIVE_TRADING=false\n`, "utf8");
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "setupProfitControlled.js")], {
    cwd: tempDir,
    input: `${CONFIRMATION_PHRASE}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  const updatedEnv = fs.readFileSync(path.join(tempDir, ".env"), "utf8");
  assert.match(updatedEnv, /BYBIT_API_KEY=test-key/);
  assert.match(updatedEnv, new RegExp(`BYBIT_API_SECRET=${secret}`));
  assert.match(updatedEnv, /ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK=true/);
  assert.match(updatedEnv, /ACKNOWLEDGE_LIVE_TRADING=true/);
  assert.match(updatedEnv, /PROFIT_CONTROLLED_EQUITY_MODE=true/);
  assert.ok(fs.readdirSync(tempDir).some((file) => file.startsWith(".env.backup-profit-controlled-")));
}

async function testProfitControlledStartupChecksProceedWithoutOrders() {
  const { events, log } = logCollector();
  let orderCalls = 0;
  const bot = new LadderBot(config({
    dryRun: false,
    profitControlledEquityMode: true,
    bybitTestnet: false,
    bybitDemoTrading: false,
    exchangeEnvironment: "PROFIT_CONTROLLED_LIVE",
    restBaseUrl: "https://api.bybit.com",
    publicWsBaseUrl: "wss://stream.bybit.com",
    privateWsBaseUrl: "wss://stream.bybit.com",
    acknowledgeProfitControlledLiveRisk: true,
    acknowledgeLiveTrading: true,
    maxTotalOpenStopRiskPct: 2.25,
    maxCorrelatedClusterStopRiskPct: 1.75,
  }));
  bot.log = log;
  bot.store.state = {
    mode: "LIVE",
    profitControlled: { namespace: "data/profit-controlled-live", riskState: "RISK_STATE_NORMAL" },
    openPositions: [],
    apiRecovery: { active: false },
    consecutiveApiErrors: 0,
    equity: { startingUsdt: 50, currentUsdt: 50, realizedPnlUsdt: 0 },
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    performance: {},
  };
  bot.store.trades = [];
  bot.store.saveState = () => {};
  bot.store.saveAll = () => {};
  bot.risk.store = bot.store;
  bot.client = {
    getSymbols: async () => ["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((symbol) => instrument(symbol)),
    getUsdtBalance: async () => ({ available: 49, equity: 50, transferableUsableMargin: 49, parseSource: "TEST" }),
    getPositions: async () => [],
    placeMarketOrder: async () => {
      orderCalls += 1;
    },
    placeLimitOrder: async () => {
      orderCalls += 1;
    },
  };
  await bot.initializeLiveSafety();
  assert.equal(orderCalls, 0);
  assert.ok(events.some((event) => event.message === "PROFIT-CONTROLLED LIVE MODE — REAL FUNDS AT RISK — NO PROFIT GUARANTEE"));
  assert.ok(events.some((event) => event.message === "USER_ACKNOWLEDGEMENT_CONFIRMED"));
  assert.ok(events.some((event) => event.message === "MAINNET_ENDPOINT_CONFIRMED"));
  assert.ok(events.some((event) => event.message === "API_KEY_PRESENT_BUT_NOT_PRINTED"));
  assert.ok(events.some((event) => event.message === "EXCHANGE_REPORTED_TOTAL_EQUITY_USDT"));
  assert.ok(events.some((event) => event.message === "SIZING_EQUITY_BASE_USDT"));
  assert.ok(events.some((event) => event.message === "INSTRUMENT_RULES_LOADED"));
  assert.ok(events.some((event) => event.message === "FORCED_NEGATIVE_EDGE_PARTICIPATION_DISABLED"));
  assert.ok(events.some((event) => event.message === "READY_TO_SCAN_FOR_NET_POSITIVE_QUALIFIED_ENTRIES"));
}

async function testProfitControlledMinimumOrderFeasibilityAndDeferredLeverage() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({
    dryRun: false,
    profitControlledEquityMode: true,
    maxLeverage: 5,
    profitControlledMaxLeverage: 5,
    profitControlledNormalMaxStopRiskPct: 0.45,
    profitControlledStrongMaxStopRiskPct: 0.85,
    profitControlledEliteMaxStopRiskPct: 1.25,
    stopLossPct: 0.8,
  }));
  bot.log = log;
  bot.store.state = {
    mode: "LIVE",
    profitControlled: { namespace: "data/profit-controlled-live", riskState: "RISK_STATE_NORMAL" },
    openPositions: [],
    apiRecovery: { active: false },
    consecutiveApiErrors: 0,
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    daily: { startingEquity: 50, tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 },
    symbolCooldowns: {},
  };
  bot.risk.store = bot.store;
  let setLeverageCalls = 0;
  bot.client = {
    getOpenOrders: async () => [],
    getUsdtBalance: async () => ({ available: 49.5, equity: 50, transferableUsableMargin: 49.5 }),
    getLeverage: async () => ({ leverage: 2, rawResponse: { leverage: 2 } }),
    setLeverage: async () => {
      setLeverageCalls += 1;
      return {};
    },
  };
  const preflight = await bot.liveEntryPreflight({ symbol: "BTCUSDT", side: "SHORT" }, 50, 4);
  assert.equal(preflight.rejected, false);
  assert.equal(setLeverageCalls, 0);

  bot.instrumentRulesBySymbol.set("ETHUSDT", instrument("ETHUSDT", {
    qtyStep: "0.01",
    minOrderQty: "0.01",
    minNotionalValue: "5",
  }));
  const ethFeasible = bot.liveValidationOrderFeasibility(
    { symbol: "ETHUSDT", side: "SHORT", price: 2500, setupType: "TREND_CONTINUATION" },
    { size: "0.01", notional: 25, leverage: 4, riskPct: 0.45, profitControlledRiskCapPct: 0.45 },
    50,
    { expectedNetEdgePct: 0.8, estimatedEntryFeePct: 0.02, estimatedExitFeePct: 0.055 }
  );
  assert.equal(ethFeasible.rejected, false);

  bot.instrumentRulesBySymbol.set("BTCUSDT", instrument("BTCUSDT", {
    qtyStep: "0.001",
    minOrderQty: "0.001",
    minNotionalValue: "5",
  }));
  const btcNormalRejected = bot.liveValidationOrderFeasibility(
    { symbol: "BTCUSDT", side: "SHORT", price: 70000, setupType: "TREND_CONTINUATION" },
    { size: "0.000", notional: 0, leverage: 4, riskPct: 0.45, profitControlledRiskCapPct: 0.45 },
    50,
    { expectedNetEdgePct: 0.8, estimatedEntryFeePct: 0.02, estimatedExitFeePct: 0.055 }
  );
  assert.equal(btcNormalRejected.rejected, true);
  assert.match(btcNormalRejected.reason, /smallest executable order exceeds/);
  assert.equal(setLeverageCalls, 0);

  const btcEliteFeasible = bot.liveValidationOrderFeasibility(
    { symbol: "BTCUSDT", side: "SHORT", price: 70000, eliteSetup: true, tradeCategory: "ELITE_SETUP" },
    { size: "0.001", notional: 70, leverage: 5, riskPct: 1.25, profitControlledRiskCapPct: 1.25 },
    50,
    { expectedNetEdgePct: 1.2, estimatedEntryFeePct: 0.02, estimatedExitFeePct: 0.055 }
  );
  assert.equal(btcEliteFeasible.rejected, false);
  assert.equal(earnedRiskTier({ eliteSetup: true }), "ELITE_CONTINUATION");
  assert.ok(events.some((event) => event.message === "ROUNDED_ORDER_EXCEEDS_RISK_LIMIT"));
}

async function testProfitControlledRiskDegradationAndExecutionRouting() {
  const cfg = config({
    dryRun: true,
    profitControlledEquityMode: true,
    enablePostOnlyEntries: true,
    edgeNormalMinRewardCostRatio: 1.55,
  });
  const state = { profitControlled: { startEquityUsdt: 50 }, apiRecovery: { active: false } };
  assert.equal(profitControlledRiskState({ config: cfg, state, currentEquityUsdt: 49, openPositions: [] }).state, "RISK_STATE_NORMAL");
  const reduced = profitControlledRiskState({ config: cfg, state, currentEquityUsdt: 48.5, openPositions: [] });
  assert.equal(reduced.state, "RISK_STATE_REDUCED");
  assert.equal(reduced.allowScanning, true);
  assert.equal(reduced.riskMultiplier, 0.6);
  const strongOnly = profitControlledRiskState({ config: cfg, state, currentEquityUsdt: 47.4, openPositions: [] });
  assert.equal(strongOnly.state, "RISK_STATE_STRONG_ONLY");
  assert.equal(strongOnly.requireStrongOrElite, true);
  const protectionOnly = profitControlledRiskState({ config: cfg, state, currentEquityUsdt: 46.2, openPositions: [] });
  assert.equal(protectionOnly.state, "RISK_STATE_PROTECTION_ONLY");
  assert.equal(protectionOnly.blockNewEntries, true);

  const bot = new LadderBot(cfg);
  bot.store.state = {
    mode: "LIVE",
    openPositions: [],
    apiRecovery: { active: false },
    consecutiveApiErrors: 0,
  };
  bot.risk.store = bot.store;
  assert.equal(
    bot.executionTypeForSignal({
      symbol: "ETHUSDT",
      setupType: "BREAKOUT_RETEST",
      continuationSetupType: "BREAKOUT_RETEST",
      edgeModel: { expectedRewardCostRatio: cfg.edgeNormalMinRewardCostRatio + 0.4 },
    }),
    "POST_ONLY_LIMIT"
  );
  assert.equal(
    bot.executionTypeForSignal({
      symbol: "SOLUSDT",
      setupType: "MOMENTUM_ACCELERATION",
      eliteContinuationCandidate: true,
      edgeModel: { expectedRewardCostRatio: cfg.edgeEliteMinRewardCostRatio + 1 },
    }),
    "MARKET_TAKER"
  );
  const snapshot = sizingEquityBaseFromBalance({ equity: 49.58, available: 48, transferableUsableMargin: 48 }, 0.5);
  assert.equal(snapshot.sizingEquityBaseUsdt, 48);
  assert.equal(snapshot.reservedMarginUsdt, 0.5);
}

async function testV7ProfitModePolicyAndQualityScore() {
  const { log } = logCollector();
  const cfg = config({
    dryRun: true,
    profitControlledEquityMode: true,
    profitExpansionMode: true,
    learningPhaseMode: false,
    aggressiveLearningPhase: false,
    explorationModeEnabled: false,
    forcedMarketSamplingEnabled: false,
    unlimitedExplorationBudget: false,
    minAdaptiveTrades: 5,
  });
  const adaptive = new AdaptiveEngine(cfg, log);
  adaptive.load();
  adaptive.memory.trades = Array.from({ length: 8 }, (_, index) =>
    memoryRecord({
      id: `profit-mode-loss-${index}`,
      symbol: "BTCUSDT",
      realizedPnlUsdt: -0.1,
      netPnlAfterCostsUsdt: -0.1,
      result: "SL",
      winLoss: "LOSS",
    })
  );
  adaptive.rebuild();
  const policy = adaptive.currentPolicy();
  assert.equal(policy.mode, "PROFIT_MODE");
  assert.equal(policy.learningPhaseActive, false);
  assert.equal(policy.aggressiveLearningPhaseActive, false);
  assert.equal(policy.explorationEnabled, false);
  assert.equal(policy.explorationBudget, 0);
  assert.equal(policy.explorationExpansionActive, false);
  assert.equal(policy.dailyTradeLimitsDisabled, true);

  const memory = symbolPerformanceMemoryV2([
    ...Array.from({ length: 12 }, (_, index) => ({
      ...memoryRecord({
        id: `sol-win-${index}`,
        symbol: "SOLUSDT",
        status: "CLOSED",
        netPnlAfterCostsUsdt: 0.12,
        pnlUsdt: 0.12,
        runnerNetContributionUsdt: 0.04,
      }),
    })),
  ], "SOLUSDT");
  assert.equal(memory.bias, "STRENGTHENED");
  assert.ok(memory.weight > 1);

  const weak = qualityScoreForSignal(cfg, {
    symbol: "BTCUSDT",
    trendQualityScore: 35,
    continuationStrength: 30,
    convictionScore: 45,
    volumeCondition: "LOW_VOLUME",
    spreadPct: 0.7,
    marketRegimeTags: ["SIDEWAYS_CHOP_MARKET"],
    projectedNetEdgePct: 0.12,
    feeEdgeRatio: 1.1,
  }, {
    expectedNetEdgePct: 0.12,
    expectedRewardCostRatio: 1.1,
    expectedRewardRiskRatio: 1,
  });
  assert.equal(weak.rejected, true);
  assert.equal(weak.tier, "REJECT");

  const elite = qualityScoreForSignal(cfg, {
    symbol: "SOLUSDT",
    trendQualityScore: 97,
    continuationStrength: 96,
    convictionScore: 95,
    volumeCondition: "STRONG_VOLUME_SPIKE",
    volumeSpike: 2.4,
    spreadPct: 0.02,
    marketRegimeTags: ["STRONG_TRENDING_MARKET", "ALTCOIN_MOMENTUM_MARKET"],
    continuationSetupType: "MOMENTUM_ACCELERATION",
    projectedNetEdgePct: 1.4,
    smartProjectedNetEdgePct: 1.2,
    feeEdgeRatio: 4,
  }, {
    expectedNetEdgePct: 1.2,
    expectedRewardCostRatio: 4,
    expectedRewardRiskRatio: 2,
  }, memory);
  assert.equal(elite.rejected, false);
  assert.equal(elite.tier, "ELITE");
  assert.ok(elite.score >= cfg.profitModeEliteQualityScore);

  const chopNormal = qualityScoreForSignal(cfg, {
    symbol: "ETHUSDT",
    trendQualityScore: 74,
    continuationStrength: 72,
    convictionScore: 74,
    volumeCondition: "CONFIRMED_VOLUME",
    spreadPct: 0.08,
    marketRegimeTags: ["SIDEWAYS_CHOP_MARKET"],
    projectedNetEdgePct: 0.6,
    smartProjectedNetEdgePct: 0.45,
    feeEdgeRatio: 2.1,
  }, {
    expectedNetEdgePct: 0.45,
    expectedRewardCostRatio: 2.1,
    expectedRewardRiskRatio: 1.4,
  });
  assert.equal(chopNormal.rejected, true);
  assert.match(chopNormal.reason, /sideways chop requires strong or elite/);
}

async function testV7FeeKillerAndWinnerAmplifier() {
  const { events, log } = logCollector();
  const cfg = config({
    dryRun: true,
    profitControlledEquityMode: true,
    profitExpansionMode: true,
    profitModeMinRewardCostRatio: 3.5,
    winnerAmplifierEnabled: true,
    winnerAmplifierPartialTakeProfitPct: 50,
    estimatedSlippagePct: 0.08,
    stopLossPct: 0.8,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  bot.store.state = {
    mode: "DRY_RUN",
    openPositions: [],
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    daily: { startingEquity: 50, tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 },
    symbolCooldowns: {},
  };
  bot.risk.store = bot.store;

  const costHeavy = bot.feeAwareEntryCheck({
    symbol: "ETHUSDT",
    side: "LONG",
    price: 2500,
    expectedMovePct: 1.2,
    estimatedTpProbability: 0.78,
    continuationStrength: 80,
    projectedNetEdgePct: 0.55,
    smartProjectedNetEdgePct: 0.5,
    feeEdgeRatio: 2.7,
    spreadPct: 0.25,
    previewNotionalUsdt: 50,
    convictionScore: 82,
    setupType: "TREND_CONTINUATION",
  });
  assert.equal(costHeavy.rejected, true);
  assert.match(costHeavy.reason, /fee killer rejected candidate/);

  cfg.profitModeMinRewardCostRatio = 1.8;
  const clean = bot.feeAwareEntryCheck({
    symbol: "ETHUSDT",
    side: "LONG",
    price: 2500,
    expectedMovePct: 1.8,
    estimatedTpProbability: 0.82,
    continuationStrength: 88,
    projectedNetEdgePct: 0.9,
    smartProjectedNetEdgePct: 0.85,
    feeEdgeRatio: 4,
    spreadPct: 0.03,
    previewNotionalUsdt: 50,
    convictionScore: 88,
    setupType: "TREND_CONTINUATION",
  });
  assert.equal(clean.rejected, false);

  const plan = bot.risk.sizingPlan({
    symbol: "ETHUSDT",
    side: "LONG",
    price: 2500,
    score: 84,
    convictionScore: 78,
    profitQualityTier: "NORMAL",
    profitQualityScore: 78,
    continuationStrength: 72,
    liquidityScore: 85,
    btcTrendAligned: true,
    volumeCondition: "CONFIRMED_VOLUME",
    projectedNetEdgePct: 0.8,
    feeEdgeRatio: 3.2,
  }, 50, instrument("ETHUSDT", { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "1" }), 4);
  assert.equal(plan.rejected, false);
  assert.equal(plan.winnerAmplifier, true);
  assert.ok(Number(plan.partialTakeProfitPrice) > 0);
  assert.notEqual(plan.takeProfitPrice, plan.standardTakeProfitPrice);

  const position = {
    id: "winner-runner-test",
    mode: "DRY_RUN",
    status: "OPEN",
    symbol: "ETHUSDT",
    side: "LONG",
    size: "0.020",
    entryPrice: 2500,
    openedAt: new Date(Date.now() - 240000).toISOString(),
    eliteTrendRider: true,
    winnerAmplifier: true,
    runnerPartialPct: 50,
    stopLossPrice: 2480,
    takeProfitPrice: 2580,
    runnerTakeProfitPrice: 2580,
    partialTakeProfitPrice: 2552.5,
    standardTakeProfitPrice: 2552.5,
    tickSize: "0.01",
    estimatedRoundTripCostPct: 0.22,
    atrPct: 0.65,
  };
  bot.store.state.openPositions = [position];
  bot.store.trades = [{ ...position, status: "OPEN" }];
  await bot.closePartialPosition(position, 2555, "winner amplifier TP1 partial take profit", 0.5);
  await bot.moveRunnerStopToBreakeven(position);
  assert.equal(position.runnerPartialTaken, true);
  assert.equal(position.size, "0.010");
  assert.equal(position.runnerStopMovedToBreakeven, true);
  assert.ok(position.stopLossPrice > position.entryPrice);
  assert.ok(events.some((event) => event.message === "RUNNER_STOP_MOVED_TO_BREAKEVEN"));
}

async function testV7ExpectancyReport() {
  const report = profitExpectancyReport([
    {
      id: "win",
      status: "CLOSED",
      symbol: "SOLUSDT",
      netPnlAfterCostsUsdt: 0.4,
      pnlUsdt: 0.4,
      grossPnlUsdt: 0.48,
      feesUsdt: 0.08,
      runnerPartialTaken: true,
      runnerNetContributionUsdt: 0.18,
    },
    {
      id: "loss",
      status: "CLOSED",
      symbol: "BTCUSDT",
      netPnlAfterCostsUsdt: -0.2,
      pnlUsdt: -0.2,
      grossPnlUsdt: -0.16,
      feesUsdt: 0.04,
      runnerNetContributionUsdt: 0,
    },
  ]);
  assert.equal(report.closedTrades, 2);
  assert.equal(report.expectancyUsdt, 0.1);
  assert.equal(report.averageWinnerUsdt, 0.4);
  assert.equal(report.averageLoserUsdt, -0.2);
  assert.equal(report.profitFactor, 2);
  assert.equal(report.feeImpact.totalFeesUsdt, 0.12);
  assert.equal(report.runnerImpact.runnerContributionUsdt, 0.18);
  assert.ok(report.symbolRanking.some((item) => item.symbol === "SOLUSDT"));
}

async function testV71TradeFrequencyRecoveryPatch() {
  const { log } = logCollector();
  const loaded = withEnv(
    {
      BYBIT_DEMO_TRADING: "false",
      BYBIT_TESTNET: "false",
      DRY_RUN: "false",
      PROFIT_CONTROLLED_EQUITY_MODE: "true",
      ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK: "true",
      ACKNOWLEDGE_LIVE_TRADING: "true",
      ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
      MIN_SIGNAL_SCORE: "47",
      MIN_CONVICTION_SCORE: "50",
      ANTI_CHOP_PENALTY_MAX: "24",
      ANTI_CHOP_CONVICTION_PENALTY_MAX: "18",
      BYBIT_REST_BASE_URL: "",
      BYBIT_WS_BASE_URL: "",
      BYBIT_PUBLIC_WS_BASE_URL: "",
      BYBIT_PRIVATE_WS_BASE_URL: "",
    },
    () => loadConfig()
  );
  assert.equal(loaded.tradeFrequencyRecoveryMode, true);
  assert.equal(loaded.minSignalScore, 42);
  assert.equal(loaded.minConvictionScore, 45);
  assert.equal(loaded.antiChopPenaltyMax, 10);
  assert.equal(loaded.antiChopConvictionPenaltyMax, 10);

  const cfg = config({
    dryRun: true,
    profitControlledEquityMode: true,
    profitExpansionMode: true,
    tradeFrequencyRecoveryMode: true,
    minSignalScore: 42,
    minConvictionScore: 45,
    tradeFrequencyRecoveryMinSignalScore: 42,
    tradeFrequencyRecoveryMinConvictionScore: 45,
    antiChopPenaltyMax: 10,
    antiChopConvictionPenaltyMax: 10,
    volumeSurvivabilityRelaxationMultiplier: 0.8,
    minVolumeSpike: 1.25,
    maxChopScore: 2,
    adaptiveLearningEnabled: true,
  });
  const adaptive = new AdaptiveEngine(cfg, log);
  adaptive.load();
  adaptive.memory.trades = Array.from({ length: 12 }, (_, index) =>
    memoryRecord({
      id: `v71-pacing-${index}`,
      symbol: "ETHUSDT",
      netPnlAfterCostsUsdt: -0.05,
      realizedPnlUsdt: -0.05,
      result: "SL",
      winLoss: "LOSS",
    })
  );
  adaptive.rebuild();
  const policy = adaptive.currentPolicy();
  assert.equal(policy.mode, "PROFIT_MODE");
  assert.equal(policy.minSignalScore, 42);
  assert.equal(cfg.minConvictionScore, 45);
  assert.equal(cfg.antiChopPenaltyMax, 10);
  assert.equal(cfg.antiChopConvictionPenaltyMax, 10);

  const scanner = new Scanner(cfg, {}, log, adaptive);
  scanner.cachedBenchmarkDirections = { BTCUSDT: "CHOPPY", ETHUSDT: "CHOPPY" };
  const chopMarket = marketProfileFromBenchmarks(
    cfg,
    scannerAnalysis({ ema9: 10, ema21: 10.01, ema50: 10.02, momentumPct: 0.02, upMomentumCandles: 1, breakout: false, volumeSpike: 0.75, bodyStrength: 0.2, rangeExpansion: 1.4, atrPct: 0.15 }),
    scannerAnalysis({ ema9: 10.02, ema21: 10.01, ema50: 10, momentumPct: -0.01, upMomentumCandles: 0, downMomentumCandles: 1, breakout: false, volumeSpike: 0.72, bodyStrength: 0.2, rangeExpansion: 1.4, atrPct: 0.15 })
  );
  const signal = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "ETHUSDT" }, price: 100, volume: 12000000, spreadPct: 0.03 },
    scannerAnalysis({
      ema9: 10,
      ema21: 10.01,
      ema50: 10.02,
      breakout: false,
      volumeSpike: 0.75,
      momentumPct: 0.05,
      lastCandleMomentumPct: 0.01,
      upMomentumCandles: 1,
      bodyStrength: 0.2,
      rangeExpansion: 0.55,
      atrPct: 0.12,
    }),
    scannerAnalysis({
      ema9: 10,
      ema21: 10.01,
      ema50: 10.02,
      breakout: false,
      volumeSpike: 0.75,
      momentumPct: 0.04,
      lastCandleMomentumPct: 0.01,
      upMomentumCandles: 1,
      bodyStrength: 0.2,
      rangeExpansion: 0.55,
      atrPct: 0.12,
    }),
    scannerAnalysis({ ema9: 10, ema21: 10.01, ema50: 10.02, momentumPct: 0, rangeExpansion: 0.55 }),
    scannerAnalysis({ ema9: 10, ema21: 10.01, ema50: 10.02, momentumPct: 0, rangeExpansion: 0.55 }),
    chopMarket,
    []
  );
  assert.ok(signal.scoreBreakdown.some((item) => item.includes("anti-chop filter penalty -10")));
  assert.ok(signal.antiChopContribution < 0);
  assert.ok(signal.convictionComponents.chopPenalty <= 10);
  assert.equal(signal.volumeSurvivabilityFloor, Number((cfg.minVolumeSpike * 0.7 * 0.8).toFixed(4)));
  assert.equal(signal.baseVolumeSurvivabilityFloor, Number((cfg.minVolumeSpike * 0.7).toFixed(4)));
  assert.equal(signal.tradeFrequencyRecoveryActive, true);
}

async function testV8ProfessionalTrendEngine() {
  const { log } = logCollector();
  const cfg = config({
    profitControlledEquityMode: true,
    professionalTrendEngineEnabled: true,
    multiTimeframeTrendEngineEnabled: true,
    macroOppositeRequiresElite: true,
    explorationModeEnabled: false,
    learningPhaseMode: false,
    aggressiveLearningPhase: false,
    minConvictionScore: 45,
  });
  const up = scannerAnalysis();
  const down = scannerAnalysis({
    ema9: 95,
    ema21: 98,
    ema50: 100,
    emaGapPct: -1.1,
    previousEmaGapPct: -0.6,
    breakout: false,
    breakdown: true,
    momentumPct: -0.22,
    lastCandleMomentumPct: -0.09,
    upMomentumCandles: 0,
    downMomentumCandles: 3,
    bodyDirection: "DOWN",
  });
  const aligned = multiTimeframeTrendConfirmation(cfg, "LONG", up, up, up, up);
  assert.ok(aligned.score >= 95);
  assert.equal(aligned.allAligned, true);
  const opposed = multiTimeframeTrendConfirmation(cfg, "LONG", up, up, down, down);
  assert.ok(opposed.score < 35);
  assert.equal(opposed.trendAndMacroOpposite, true);

  const trendProfile = marketProfileFromBenchmarks(cfg, up, up);
  const breakoutRegime = marketRegimeV2(cfg, trendProfile, {
    atrPct: 0.4,
    breakSignal: true,
    volumeSpike: 1.6,
    multiTimeframeTrendScore: aligned.score,
  });
  assert.equal(breakoutRegime.regime, "BREAKOUT");
  assert.equal(breakoutRegime.convictionThreshold, 44);

  const scanner = new Scanner(cfg, {}, log);
  scanner.cachedBenchmarkDirections = { BTCUSDT: "UP", ETHUSDT: "UP" };
  const signal = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "SOLUSDT" }, price: 100, volume: 12000000, spreadPct: 0.03 },
    up,
    up,
    up,
    up,
    trendProfile,
    []
  );
  assert.ok(signal.multiTimeframeTrendScore >= cfg.mtfStrongAlignmentScore);
  assert.equal(signal.marketRegimeV2, "BREAKOUT");
  assert.equal(signal.requiredConvictionScore, cfg.convictionThresholdBreakout);
  assert.ok(signal.scoreBreakdown.some((item) => item.includes("multi-timeframe trend engine strong alignment")));

  const weakUp = scannerAnalysis({
    breakout: false,
    volumeSpike: 1.05,
    momentumPct: 0.08,
    lastCandleMomentumPct: 0.02,
    upMomentumCandles: 2,
    bodyStrength: 0.48,
    rangeExpansion: 0.75,
  });
  const macroOpposed = scanner.scoreDirection(
    "LONG",
    { info: { symbol: "ETHUSDT" }, price: 100, volume: 12000000, spreadPct: 0.03 },
    weakUp,
    weakUp,
    weakUp,
    down,
    trendProfile,
    []
  );
  assert.equal(macroOpposed.multiTimeframeMacroOpposite, true);
  assert.ok(macroOpposed.rejected.some((reason) => /1h macro bias opposite requires elite/.test(reason)));
}

async function testV8ExpectancyOptimizerMemoryAndReports() {
  const cfg = config({
    profitControlledEquityMode: true,
    expectancyOptimizerEnabled: true,
    expectancyOptimizerWindowTrades: 50,
    expectancyFeeDragTightenRatio: 0.6,
    expectancyEntryTighteningPoints: 2,
    expectancyContinuationBoostPoints: 3,
  });
  const trades = [
    ...Array.from({ length: 30 }, (_, index) =>
      memoryRecord({
        id: `v8-win-${index}`,
        status: "CLOSED",
        symbol: index % 2 ? "SOLUSDT" : "ETHUSDT",
        setupType: "TREND_CONTINUATION",
        continuationSetupType: "MOMENTUM_RESUMPTION",
        netPnlAfterCostsUsdt: 0.02,
        realizedPnlUsdt: 0.02,
        pnlUsdt: 0.02,
        grossPnlUsdt: 0.08,
        feesUsdt: 0.06,
        runnerPartialTaken: true,
        runnerNetContributionUsdt: 0.01,
      })
    ),
    ...Array.from({ length: 20 }, (_, index) =>
      memoryRecord({
        id: `v8-loss-${index}`,
        status: "CLOSED",
        symbol: "BTCUSDT",
        setupType: "FLIP",
        continuationSetupType: "NONE",
        netPnlAfterCostsUsdt: -0.03,
        realizedPnlUsdt: -0.03,
        pnlUsdt: -0.03,
        grossPnlUsdt: -0.02,
        feesUsdt: 0.01,
        runnerNetContributionUsdt: 0,
      })
    ),
  ];
  const optimizer = expectancyOptimizer(trades, cfg);
  assert.equal(optimizer.evaluatedEveryClosedTrades, 50);
  assert.equal(optimizer.feeDragTighteningActive, true);
  assert.equal(optimizer.continuationOutperforming, true);
  assert.equal(optimizer.runnerContributionPositive, true);

  const memory = symbolPerformanceMemoryV3(trades, "SOLUSDT");
  assert.ok(Object.prototype.hasOwnProperty.call(memory.rolling50, "expectancyUsdt"));
  assert.ok(Object.prototype.hasOwnProperty.call(memory.rolling50, "feeImpactRatio"));
  assert.equal(memory.neverDisabled, true);

  const quality = qualityScoreForSignal(cfg, {
    symbol: "SOLUSDT",
    trendQualityScore: 82,
    continuationStrength: 84,
    convictionScore: 78,
    volumeCondition: "CONFIRMED_VOLUME",
    volumeSpike: 1.6,
    spreadPct: 0.03,
    marketRegimeTags: ["STRONG_TRENDING_MARKET"],
    continuationSetupType: "MOMENTUM_RESUMPTION",
    projectedNetEdgePct: 0.8,
    smartProjectedNetEdgePct: 0.7,
    feeEdgeRatio: 3,
    multiTimeframeTrendScore: 88,
  }, {
    expectedNetEdgePct: 0.7,
    expectedRewardCostRatio: 3,
    expectedRewardRiskRatio: 1.5,
  }, memory, optimizer);
  assert.equal(quality.thresholds.normal, cfg.profitModeMinQualityScore + cfg.expectancyEntryTighteningPoints);
  assert.ok(quality.components.expectancyOptimizer > 0);

  const expectancy = profitExpectancyReport(trades, cfg);
  assert.equal(expectancy.closedTrades, 50);
  assert.ok(expectancy.optimizer.feeDragTighteningActive);
  assert.ok(expectancy.symbolRanking.every((item) => item.neverDisabled));
  const health = profitSystemHealthReport(trades, cfg);
  assert.ok(Object.prototype.hasOwnProperty.call(health, "feeDragRatio"));
  assert.ok(Object.prototype.hasOwnProperty.call(health, "runnerContribution"));
  assert.ok(health.bestSymbol);
  assert.ok(health.worstSetup);
}

async function testV8NearMissStatsAndSystemHealthFile() {
  const cfg = config({
    dryRun: true,
    profitControlledEquityMode: true,
    nearMissLearningEnabled: true,
  });
  const bot = new LadderBot(cfg);
  bot.store.state = {
    profitControlled: { namespace: "data/profit-controlled-live", startEquityUsdt: 50, sizingEquityBaseUsdt: 50 },
    openPositions: [],
    daily: { startingEquity: 50, tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 },
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    performance: {},
  };
  bot.store.saveState = () => {};
  bot.store.saveAll = () => {};
  bot.store.trades = [
    memoryRecord({
      id: "health-win",
      status: "CLOSED",
      symbol: "ETHUSDT",
      setupType: "TREND_CONTINUATION",
      netPnlAfterCostsUsdt: 0.12,
      pnlUsdt: 0.12,
      grossPnlUsdt: 0.16,
      feesUsdt: 0.04,
      runnerNetContributionUsdt: 0.05,
      runnerPartialTaken: true,
    }),
  ];
  const stats = bot.updateNearMissStats([
    {
      symbol: "ETHUSDT",
      direction: "LONG",
      conviction: 41,
      score: 69,
      requiredScore: 70,
      requiredConvictionScore: 42,
      regime: "SIDEWAYS_CHOP",
      gap: 1,
      price: 100,
      expectedMovePct: 1,
      rejected: ["quality score just below threshold"],
      timestamp: new Date().toISOString(),
    },
  ], []);
  assert.equal(stats.tracked, 1);
  const resolved = bot.updateNearMissStats([], [{ symbol: "ETHUSDT", price: 100.6 }]);
  assert.equal(resolved.missedOpportunities, 1);

  const report = bot.writeProfitSystemHealthReport();
  const file = path.join(cfg.reportsDir, "system-health.json");
  assert.ok(fs.existsSync(file));
  assert.equal(report.nearMissStats.tracked, 1);
}

async function testV9EdgeMaximizationEngine() {
  const loaded = withEnv(
    {
      BYBIT_DEMO_TRADING: "false",
      BYBIT_TESTNET: "false",
      DRY_RUN: "false",
      PROFIT_CONTROLLED_EQUITY_MODE: "true",
      ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK: "true",
      ACKNOWLEDGE_LIVE_TRADING: "true",
      ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
      WINNER_AMPLIFIER_PARTIAL_TAKE_PROFIT_PCT: "50",
      BYBIT_REST_BASE_URL: "",
      BYBIT_WS_BASE_URL: "",
      BYBIT_PUBLIC_WS_BASE_URL: "",
      BYBIT_PRIVATE_WS_BASE_URL: "",
    },
    () => loadConfig()
  );
  assert.equal(loaded.edgeMaximizationMode, true);
  assert.equal(loaded.winnerAmplifierPartialTakeProfitPct, 30);
  assert.equal(loaded.qualitySizeMultiplierNormal, 1);
  assert.equal(loaded.qualitySizeMultiplierStrong, 1.2);
  assert.equal(loaded.qualitySizeMultiplierElite, 1.5);

  const breadthAligned = marketBreadthScore("LONG", { BTCUSDT: "UP", ETHUSDT: "UP", SOLUSDT: "UP" });
  const breadthMixed = marketBreadthScore("LONG", { BTCUSDT: "UP", ETHUSDT: "DOWN", SOLUSDT: "DOWN" });
  assert.ok(breadthAligned.score > 90);
  assert.ok(breadthMixed.score < 45);

  const cfg = config({
    profitControlledEquityMode: true,
    edgeMaximizationMode: true,
    qualitySizeMultiplierNormal: 1,
    qualitySizeMultiplierStrong: 1.2,
    qualitySizeMultiplierElite: 1.5,
    winnerAmplifierPartialTakeProfitPct: 30,
    setupRankingBoostProfitFactor: 1.3,
    setupRankingReduceProfitFactor: 1,
    regimeMemoryBoostProfitFactor: 1.3,
    regimeMemoryReduceProfitFactor: 1,
  });
  const trades = [
    ...Array.from({ length: 8 }, (_, index) =>
      memoryRecord({
        id: `v9-setup-win-${index}`,
        status: "CLOSED",
        symbol: "SOLUSDT",
        setupType: "TREND_CONTINUATION",
        continuationSetupType: "MOMENTUM_RESUMPTION",
        marketRegimeV2: "TRENDING",
        netPnlAfterCostsUsdt: 0.12,
        pnlUsdt: 0.12,
        realizedPnlUsdt: 0.12,
        grossPnlUsdt: 0.15,
        feesUsdt: 0.03,
        runnerPartialTaken: true,
        runnerNetContributionUsdt: 0.04,
      })
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      memoryRecord({
        id: `v9-setup-loss-${index}`,
        status: "CLOSED",
        symbol: "BTCUSDT",
        setupType: "BREAKOUT",
        continuationSetupType: "BREAKOUT_RETEST",
        marketRegimeV2: "SIDEWAYS_CHOP",
        netPnlAfterCostsUsdt: -0.08,
        pnlUsdt: -0.08,
        realizedPnlUsdt: -0.08,
        grossPnlUsdt: -0.06,
        feesUsdt: 0.02,
        runnerNetContributionUsdt: 0,
      })
    ),
  ];
  const setupMemory = setupRankingMemory(trades, {
    symbol: "SOLUSDT",
    setupType: "TREND_CONTINUATION",
    continuationSetupType: "MOMENTUM_RESUMPTION",
  }, cfg);
  assert.equal(setupMemory.bias, "BOOST");
  assert.ok(setupMemory.weight > 1);
  assert.equal(setupMemory.neverDisabled, true);

  const weakSetupMemory = setupRankingMemory(trades, {
    symbol: "BTCUSDT",
    setupType: "BREAKOUT",
    continuationSetupType: "BREAKOUT_RETEST",
  }, cfg);
  assert.equal(weakSetupMemory.bias, "REDUCE");
  assert.ok(weakSetupMemory.weight < 1);

  const regimeMemory = regimePerformanceMemory(trades, { marketRegimeV2: "TRENDING" }, cfg);
  assert.equal(regimeMemory.bias, "BOOST");
  assert.ok(regimeMemory.performance.maxDrawdownUsdt >= 0);

  const quality = qualityScoreForSignal(cfg, {
    symbol: "SOLUSDT",
    trendQualityScore: 78,
    continuationStrength: 82,
    convictionScore: 80,
    volumeCondition: "CONFIRMED_VOLUME",
    volumeSpike: 1.7,
    spreadPct: 0.03,
    marketRegimeTags: ["STRONG_TRENDING_MARKET"],
    continuationSetupType: "MOMENTUM_RESUMPTION",
    setupType: "TREND_CONTINUATION",
    projectedNetEdgePct: 0.8,
    smartProjectedNetEdgePct: 0.7,
    feeEdgeRatio: 3,
    multiTimeframeTrendScore: 88,
    marketBreadthScore: breadthAligned.score,
  }, {
    expectedNetEdgePct: 0.7,
    expectedRewardCostRatio: 3,
    expectedRewardRiskRatio: 1.5,
  }, null, null, { setupMemory, regimeMemory });
  assert.ok(quality.components.setupRankingWeight > 1);
  assert.ok(quality.components.regimeMemoryWeight > 1);
  assert.ok(quality.components.marketBreadth > 90);

  const bot = new LadderBot(cfg);
  bot.store.state = {
    mode: "DRY_RUN",
    openPositions: [],
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    daily: { startingEquity: 60, tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 },
    symbolCooldowns: {},
  };
  bot.risk.store = bot.store;
  const normalPlan = bot.risk.sizingPlan({
    symbol: "ETHUSDT",
    side: "LONG",
    price: 2500,
    score: 76,
    convictionScore: 72,
    profitQualityTier: "NORMAL",
    profitQualityScore: 76,
    continuationStrength: 68,
    liquidityScore: 80,
    btcTrendAligned: true,
    volumeCondition: "CONFIRMED_VOLUME",
    projectedNetEdgePct: 0.8,
    feeEdgeRatio: 3,
  }, 60, instrument("ETHUSDT", { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "1" }), 4);
  assert.equal(normalPlan.qualitySizeMultiplier, 1);

  const strongPlan = bot.risk.sizingPlan({
    ...normalPlan,
    symbol: "ETHUSDT",
    side: "LONG",
    price: 2500,
    score: 88,
    convictionScore: 84,
    profitQualityTier: "STRONG",
    profitQualityScore: 88,
    continuationStrength: 78,
    liquidityScore: 85,
    btcTrendAligned: true,
    volumeCondition: "CONFIRMED_VOLUME",
    projectedNetEdgePct: 0.9,
    feeEdgeRatio: 3.2,
  }, 60, instrument("ETHUSDT", { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "1" }), 4);
  assert.ok(strongPlan.qualitySizeMultiplier <= cfg.qualitySizeMultiplierStrong);
  assert.ok(strongPlan.reasonsForSizingTier.some((reason) => /1\.2x/.test(reason)));

  const elitePlan = bot.risk.sizingPlan({
    ...strongPlan,
    symbol: "SOLUSDT",
    price: 150,
    score: 97,
    convictionScore: 95,
    profitQualityTier: "ELITE",
    profitQualityScore: 97,
    eliteSetup: true,
    continuationStrength: 90,
  }, 60, instrument("SOLUSDT", { qtyStep: "0.1", minOrderQty: "0.1", minNotionalValue: "1" }), 5);
  assert.ok(elitePlan.qualitySizeMultiplier <= cfg.qualitySizeMultiplierElite);
  assert.ok(elitePlan.reasonsForSizingTier.some((reason) => /1\.5x/.test(reason)));
  assert.equal(elitePlan.runnerPartialPct, cfg.elitePartialTakeProfitPct);

  const edgeReport = profitEdgeReport(trades, cfg);
  assert.ok(edgeReport.bestSetup);
  assert.ok(edgeReport.worstSetup);
  assert.ok(edgeReport.bestRegime);
  assert.ok(edgeReport.worstRegime);
  assert.ok(Object.prototype.hasOwnProperty.call(edgeReport, "averageWinner"));
  assert.ok(Object.prototype.hasOwnProperty.call(edgeReport, "averageLoser"));
  assert.ok(Object.prototype.hasOwnProperty.call(edgeReport, "runnerContribution"));
}

async function testV95AdaptiveEdgeReinforcement() {
  const loaded = withEnv(
    {
      PROFIT_CONTROLLED_EQUITY_MODE: "true",
      BYBIT_TESTNET: "false",
      BYBIT_DEMO_TRADING: "false",
      DRY_RUN: "false",
      ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK: "true",
      ACKNOWLEDGE_LIVE_TRADING: "true",
      ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
      BYBIT_REST_BASE_URL: "",
      BYBIT_WS_BASE_URL: "",
      BYBIT_PUBLIC_WS_BASE_URL: "",
      BYBIT_PRIVATE_WS_BASE_URL: "",
    },
    () => loadConfig()
  );
  assert.equal(loaded.edgeReinforcementMode, true);
  assert.equal(loaded.asymmetricRunnerWeakTp1Pct, 40);
  assert.equal(loaded.asymmetricRunnerStrongTp1Pct, 15);
  assert.equal(loaded.asymmetricRunnerEliteTp1Pct, 5);
  assert.equal(loaded.expectancyAutoTuningWindowTrades, 100);
  assert.equal(loaded.expectancyAutoTuningMaxAdjustmentPct, 5);
  assert.equal(loaded.adaptiveEdgeActivityRecoveryMode, true);
  assert.equal(loaded.adaptiveEdgeActivityRecoveryMaxRelaxPct, 3);

  const cfg = config({
    profitControlledEquityMode: true,
    edgeMaximizationMode: true,
    edgeReinforcementMode: true,
    winnerAmplifierEnabled: true,
    qualitySizeMultiplierNormal: 1,
    qualitySizeMultiplierStrong: 1.2,
    qualitySizeMultiplierElite: 1.5,
    setupRankingBoostProfitFactor: 1.3,
    setupRankingReduceProfitFactor: 1,
    regimeMemoryBoostProfitFactor: 1.3,
    regimeMemoryReduceProfitFactor: 1,
    setupRegimeMatrixBoostProfitFactor: 1.3,
    setupRegimeMatrixReduceProfitFactor: 1,
    asymmetricRunnerWeakTp1Pct: 40,
    asymmetricRunnerStrongTp1Pct: 15,
    asymmetricRunnerEliteTp1Pct: 5,
    asymmetricRunnerStrongTrendScore: 82,
    asymmetricRunnerEliteTrendScore: 92,
    expectancyAutoTuningWindowTrades: 100,
    expectancyAutoTuningMaxAdjustmentPct: 5,
    adaptiveEdgeActivityRecoveryMode: true,
    adaptiveEdgeActivityRecoveryWindowMinutes: 240,
    adaptiveEdgeActivityRecoveryTargetTrades: 2,
    adaptiveEdgeActivityRecoveryMaxRelaxPct: 3,
    adaptiveEdgeActivityRecoveryMinProfitFactor: 1,
    adaptiveEdgeActivityRecoveryMaxFeeDragRatio: 0.65,
    tradeClusterWindowMinutes: 45,
    tradeClusterMaxSizeReductionPct: 20,
  });

  const now = Date.now();
  const profitableEthTrending = Array.from({ length: 8 }, (_, index) =>
    memoryRecord({
      id: `v95-eth-trend-win-${index}`,
      status: "CLOSED",
      symbol: "ETHUSDT",
      side: "LONG",
      setupType: "TREND_CONTINUATION",
      continuationSetupType: "MOMENTUM_RESUMPTION",
      marketRegimeV2: "TRENDING",
      openedAt: new Date(now - (index + 1) * 120000).toISOString(),
      netPnlAfterCostsUsdt: 0.12,
      pnlUsdt: 0.12,
      realizedPnlUsdt: 0.12,
      grossPnlUsdt: 0.15,
      feesUsdt: 0.03,
      runnerPartialTaken: true,
      runnerNetContributionUsdt: 0.05,
      portfolioAlphaScore: 95,
      portfolioAlphaAlignedCount: 3,
      portfolioAlphaConflictCount: 0,
      clusterRiskScore: 20,
      clusterRiskSizeMultiplier: 0.96,
    })
  );
  const weakSolChop = Array.from({ length: 8 }, (_, index) =>
    memoryRecord({
      id: `v95-sol-chop-loss-${index}`,
      status: "CLOSED",
      symbol: "SOLUSDT",
      side: "LONG",
      setupType: "BREAKOUT",
      continuationSetupType: "BREAKOUT_RETEST",
      marketRegimeV2: "SIDEWAYS_CHOP",
      openedAt: new Date(now - 3600000 - index * 120000).toISOString(),
      netPnlAfterCostsUsdt: -0.08,
      pnlUsdt: -0.08,
      realizedPnlUsdt: -0.08,
      grossPnlUsdt: -0.06,
      feesUsdt: 0.02,
      runnerNetContributionUsdt: -0.01,
      portfolioAlphaScore: 35,
      portfolioAlphaAlignedCount: 1,
      portfolioAlphaConflictCount: 2,
      clusterRiskScore: 70,
      clusterRiskSizeMultiplier: 0.86,
    })
  );
  const trades = [...profitableEthTrending, ...weakSolChop];
  const matrixMemory = setupRegimeMatrixMemory(trades, {
    symbol: "ETHUSDT",
    side: "LONG",
    setupType: "TREND_CONTINUATION",
    continuationSetupType: "MOMENTUM_RESUMPTION",
    marketRegimeV2: "TRENDING",
  }, cfg);
  assert.equal(matrixMemory.key, "ETH_CONTINUATION x TRENDING");
  assert.equal(matrixMemory.bias, "BOOST");
  assert.ok(matrixMemory.weight > 1);
  assert.equal(matrixMemory.neverDisabled, true);

  const weakMatrix = setupRegimeMatrixMemory(trades, {
    symbol: "SOLUSDT",
    side: "LONG",
    setupType: "BREAKOUT",
    continuationSetupType: "BREAKOUT_RETEST",
    marketRegimeV2: "SIDEWAYS_CHOP",
  }, cfg);
  assert.equal(weakMatrix.key, "SOL_BREAKOUT x CHOP");
  assert.equal(weakMatrix.bias, "REDUCE");
  assert.ok(weakMatrix.weight < 1);

  const weakAllocation = asymmetricRunnerAllocation(cfg, { profitQualityTier: "NORMAL", trendQualityScore: 70 });
  const strongAllocation = asymmetricRunnerAllocation(cfg, { profitQualityTier: "STRONG", trendQualityScore: 86 });
  const eliteAllocation = asymmetricRunnerAllocation(cfg, { profitQualityTier: "ELITE", trendQualityScore: 96 });
  assert.equal(weakAllocation.tp1PartialPct, 40);
  assert.equal(weakAllocation.runnerPct, 60);
  assert.equal(strongAllocation.tp1PartialPct, 15);
  assert.equal(strongAllocation.runnerPct, 85);
  assert.equal(eliteAllocation.tp1PartialPct, 5);
  assert.equal(eliteAllocation.runnerPct, 95);

  const losingWindow = Array.from({ length: 100 }, (_, index) =>
    memoryRecord({
      id: `v95-auto-loss-${index}`,
      status: "CLOSED",
      symbol: index % 2 ? "BTCUSDT" : "ETHUSDT",
      setupType: "TREND_CONTINUATION",
      continuationSetupType: "MOMENTUM_RESUMPTION",
      marketRegimeV2: "TRENDING",
      netPnlAfterCostsUsdt: index % 4 === 0 ? 0.03 : -0.04,
      pnlUsdt: index % 4 === 0 ? 0.03 : -0.04,
      realizedPnlUsdt: index % 4 === 0 ? 0.03 : -0.04,
      grossPnlUsdt: index % 4 === 0 ? 0.05 : -0.02,
      feesUsdt: 0.02,
    })
  );
  const tightTune = expectancyAutoTuning(losingWindow, cfg);
  assert.equal(tightTune.active, true);
  assert.equal(tightTune.bias, "TIGHTEN");
  assert.equal(tightTune.adjustmentPct, 5);
  assert.equal(tightTune.thresholdMultiplier, 1.05);

  const winningWindow = Array.from({ length: 100 }, (_, index) =>
    memoryRecord({
      id: `v95-auto-win-${index}`,
      status: "CLOSED",
      symbol: "ETHUSDT",
      setupType: "TREND_CONTINUATION",
      continuationSetupType: "MOMENTUM_RESUMPTION",
      marketRegimeV2: "BREAKOUT",
      netPnlAfterCostsUsdt: index % 4 === 0 ? -0.03 : 0.09,
      pnlUsdt: index % 4 === 0 ? -0.03 : 0.09,
      realizedPnlUsdt: index % 4 === 0 ? -0.03 : 0.09,
      grossPnlUsdt: index % 4 === 0 ? -0.01 : 0.11,
      feesUsdt: 0.02,
    })
  );
  const relaxTune = expectancyAutoTuning(winningWindow, cfg);
  assert.equal(relaxTune.bias, "RELAX");
  assert.equal(relaxTune.adjustmentPct, -5);
  assert.equal(relaxTune.thresholdMultiplier, 0.95);

  const quietProfitableHistory = Array.from({ length: 12 }, (_, index) =>
    memoryRecord({
      id: `v95-activity-recovery-${index}`,
      status: "CLOSED",
      symbol: "ETHUSDT",
      setupType: "TREND_CONTINUATION",
      continuationSetupType: "MOMENTUM_RESUMPTION",
      marketRegimeV2: "TRENDING",
      openedAt: new Date(now - 8 * 60 * 60 * 1000 - index * 60000).toISOString(),
      exitedAt: new Date(now - 7 * 60 * 60 * 1000 - index * 60000).toISOString(),
      netPnlAfterCostsUsdt: index % 4 === 0 ? -0.02 : 0.08,
      pnlUsdt: index % 4 === 0 ? -0.02 : 0.08,
      realizedPnlUsdt: index % 4 === 0 ? -0.02 : 0.08,
      grossPnlUsdt: index % 4 === 0 ? 0 : 0.1,
      feesUsdt: 0.02,
    })
  );
  const activityRecovery = adaptiveActivityRecovery(quietProfitableHistory, cfg, now);
  assert.equal(activityRecovery.active, true);
  assert.equal(activityRecovery.thresholdMultiplier, 0.97);
  assert.ok(activityRecovery.scoreBoost > 0);
  assert.equal(activityRecovery.neverForcesTrades, true);

  const clusterTrades = Array.from({ length: 4 }, (_, index) =>
    memoryRecord({
      id: `v95-cluster-${index}`,
      status: "CLOSED",
      symbol: "ETHUSDT",
      side: "LONG",
      setupType: "TREND_CONTINUATION",
      continuationSetupType: "MOMENTUM_RESUMPTION",
      marketRegimeV2: "TRENDING",
      openedAt: new Date(now - (index + 1) * 5 * 60 * 1000).toISOString(),
      netPnlAfterCostsUsdt: index < 2 ? -0.04 : 0.02,
      pnlUsdt: index < 2 ? -0.04 : 0.02,
    })
  );
  const clusterRisk = tradeClusterRisk(clusterTrades, {
    symbol: "ETHUSDT",
    side: "LONG",
    setupType: "TREND_CONTINUATION",
    continuationSetupType: "MOMENTUM_RESUMPTION",
    marketRegimeV2: "TRENDING",
  }, cfg, now);
  assert.ok(clusterRisk.clusterRiskScore > 60);
  assert.ok(clusterRisk.sizeMultiplier < 1);
  assert.equal(clusterRisk.neverBlocksTrading, true);

  const alphaAligned = portfolioAlphaScore("LONG", { BTCUSDT: "UP", ETHUSDT: "UP", SOLUSDT: "UP" });
  const alphaMixed = portfolioAlphaScore("LONG", { BTCUSDT: "UP", ETHUSDT: "DOWN", SOLUSDT: "DOWN" });
  assert.ok(alphaAligned.score > 90);
  assert.ok(alphaMixed.score < 45);

  const quality = qualityScoreForSignal(cfg, {
    symbol: "ETHUSDT",
    trendQualityScore: 82,
    continuationStrength: 84,
    convictionScore: 82,
    volumeCondition: "CONFIRMED_VOLUME",
    volumeSpike: 1.7,
    spreadPct: 0.02,
    marketRegimeTags: ["STRONG_TRENDING_MARKET"],
    continuationSetupType: "MOMENTUM_RESUMPTION",
    setupType: "TREND_CONTINUATION",
    projectedNetEdgePct: 0.8,
    smartProjectedNetEdgePct: 0.7,
    feeEdgeRatio: 3.2,
    multiTimeframeTrendScore: 88,
    marketBreadthScore: alphaAligned.score,
    portfolioAlphaScore: alphaAligned.score,
  }, {
    expectedNetEdgePct: 0.7,
    expectedRewardCostRatio: 3.2,
    expectedRewardRiskRatio: 1.6,
  }, null, null, {
    setupRegimeMatrixMemory: matrixMemory,
    autoTuning: tightTune,
    activityRecovery,
    clusterRisk,
  });
  assert.ok(quality.components.setupRegimeMatrixWeight > 1);
  assert.equal(quality.components.expectancyAutoTuningPct, 5);
  assert.ok(quality.components.adaptiveActivityRecovery > 0);
  assert.ok(quality.components.clusterRisk > 60);
  assert.ok(quality.thresholds.normal > cfg.profitModeMinQualityScore);

  const bot = new LadderBot(cfg);
  bot.store.state = {
    mode: "DRY_RUN",
    openPositions: [],
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    daily: { startingEquity: 60, tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 },
    symbolCooldowns: {},
  };
  bot.risk.store = bot.store;
  const strongPlan = bot.risk.sizingPlan({
    symbol: "ETHUSDT",
    side: "LONG",
    price: 2500,
    score: 88,
    convictionScore: 84,
    profitQualityTier: "STRONG",
    profitQualityScore: 88,
    continuationStrength: 86,
    liquidityScore: 85,
    btcTrendAligned: true,
    volumeCondition: "CONFIRMED_VOLUME",
    projectedNetEdgePct: 0.9,
    feeEdgeRatio: 3.2,
    clusterRiskSizeMultiplier: clusterRisk.sizeMultiplier,
  }, 60, instrument("ETHUSDT", { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "1" }), 4);
  assert.equal(strongPlan.runnerPartialPct, 15);
  assert.equal(strongPlan.runnerAllocation.runnerPct, 85);
  assert.ok(strongPlan.qualitySizeMultiplier < cfg.qualitySizeMultiplierStrong);
  assert.ok(strongPlan.reasonsForSizingTier.some((reason) => /cluster risk reduced size/i.test(reason)));

  const elitePlan = bot.risk.sizingPlan({
    symbol: "SOLUSDT",
    side: "LONG",
    price: 150,
    score: 97,
    convictionScore: 95,
    profitQualityTier: "ELITE",
    profitQualityScore: 97,
    eliteSetup: true,
    continuationStrength: 95,
    liquidityScore: 88,
    btcTrendAligned: true,
    volumeCondition: "CONFIRMED_VOLUME",
    projectedNetEdgePct: 1.2,
    feeEdgeRatio: 4,
  }, 60, instrument("SOLUSDT", { qtyStep: "0.1", minOrderQty: "0.1", minNotionalValue: "1" }), 5);
  assert.equal(elitePlan.runnerPartialPct, 5);
  assert.equal(elitePlan.runnerAllocation.runnerPct, 95);

  const edgeReport = profitEdgeReport([...trades, ...clusterTrades], cfg);
  assert.ok(edgeReport.bestSetupRegime);
  assert.ok(edgeReport.worstSetupRegime);
  assert.ok(Object.prototype.hasOwnProperty.call(edgeReport, "clusterRiskStatistics"));
  assert.ok(Object.prototype.hasOwnProperty.call(edgeReport, "portfolioAlphaStatistics"));
  assert.ok(Object.prototype.hasOwnProperty.call(edgeReport, "expectancyTrend"));
  assert.ok(Object.prototype.hasOwnProperty.call(edgeReport, "profitFactorTrend"));
  assert.ok(Object.prototype.hasOwnProperty.call(edgeReport, "runnerWinRatePct"));
}

async function testV10TrendDominanceEngine() {
  const loaded = withEnv(
    {
      PROFIT_CONTROLLED_EQUITY_MODE: "true",
      BYBIT_TESTNET: "false",
      BYBIT_DEMO_TRADING: "false",
      DRY_RUN: "false",
      ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK: "true",
      ACKNOWLEDGE_LIVE_TRADING: "true",
      ACKNOWLEDGE_HIGH_LEVERAGE_RISK: "true",
      BYBIT_REST_BASE_URL: "",
      BYBIT_WS_BASE_URL: "",
      BYBIT_PUBLIC_WS_BASE_URL: "",
      BYBIT_PRIVATE_WS_BASE_URL: "",
    },
    () => loadConfig()
  );
  assert.equal(loaded.trendDominanceMode, true);
  assert.equal(loaded.aggressiveAdaptiveMode, true);
  assert.equal(loaded.inactivityRecoveryMode, true);
  assert.equal(loaded.profitControlledNormalMaxStopRiskPct, 0.75);
  assert.equal(loaded.profitControlledStrongMaxStopRiskPct, 1.5);
  assert.equal(loaded.profitControlledEliteMaxStopRiskPct, 2);
  assert.equal(loaded.trendDominanceStrongScore, 82);
  assert.equal(loaded.trendDominanceEliteScore, 92);
  assert.equal(loaded.trendDominanceActivityBoostPct, 5);
  assert.equal(loaded.trendDominanceEthWeightMultiplier, 1.4);
  assert.equal(loaded.trendDominanceBtcWeightMultiplier, 1.25);
  assert.equal(loaded.trendDominanceStrongSizingMultiplier, 1.18);
  assert.equal(loaded.trendDominanceEliteSizingMultiplier, 1.25);

  const cfg = config({
    profitControlledEquityMode: true,
    edgeReinforcementMode: true,
    trendDominanceMode: true,
    aggressiveAdaptiveMode: true,
    inactivityRecoveryMode: true,
    inactivityRecoveryFourHourRelaxPct: 2,
    inactivityRecoveryEightHourRelaxPct: 4,
    inactivityRecoveryTwelveHourRelaxPct: 6,
    inactivityRecoveryFourHourRelaxPoints: 2,
    inactivityRecoveryEightHourRelaxPoints: 4,
    inactivityRecoveryTwelveHourRelaxPoints: 6,
    profitControlledNormalMaxStopRiskPct: 0.75,
    profitControlledStrongMaxStopRiskPct: 1.5,
    profitControlledEliteMaxStopRiskPct: 2,
    winnerAmplifierEnabled: true,
    trendDominanceStrongScore: 82,
    trendDominanceEliteScore: 92,
    trendDominanceActivityBoostPct: 5,
    trendDominanceScoreBoost: 3,
    trendDominanceEthBtcFocusBoost: 4,
    trendDominanceEthWeightMultiplier: 1.4,
    trendDominanceBtcWeightMultiplier: 1.25,
    trendDominanceSolWeakBreakoutMultiplier: 0.82,
    trendDominanceSolWeakBreakoutPenalty: 4,
    trendDominanceStrongSizingMultiplier: 1.18,
    trendDominanceEliteSizingMultiplier: 1.25,
    trendDominanceRunnerExtensionBoost: 1.12,
    asymmetricRunnerWeakTp1Pct: 40,
    asymmetricRunnerStrongTp1Pct: 15,
    asymmetricRunnerEliteTp1Pct: 5,
  });
  const matrix = {
    weight: 1.1,
    bias: "BOOST",
    performance: { samples: 12, profitFactor: 1.6, expectancyUsdt: 0.04 },
  };
  const activityRecovery = {
    active: true,
    feeDragOk: true,
    expectancyOk: true,
  };
  const signal = {
    symbol: "ETHUSDT",
    side: "LONG",
    profitQualityTier: "STRONG",
    multiTimeframeTrendScore: 90,
    trendQualityScore: 86,
    continuationStrength: 88,
    portfolioAlphaScore: 92,
    marketRegimeTags: ["STRONG_TRENDING_MARKET"],
    continuationSetupType: "MOMENTUM_RESUMPTION",
    setupType: "TREND_CONTINUATION",
    convictionScore: 84,
    volumeCondition: "CONFIRMED_VOLUME",
    volumeSpike: 1.8,
    spreadPct: 0.02,
    projectedNetEdgePct: 0.85,
    smartProjectedNetEdgePct: 0.75,
    feeEdgeRatio: 3.3,
  };
  const dominance = trendDominanceSignal(cfg, signal, {
    setupRegimeMatrixMemory: matrix,
    activityRecovery,
  });
  assert.ok(dominance.score >= cfg.trendDominanceStrongScore);
  assert.equal(dominance.ethBtcFocus, true);
  assert.equal(dominance.symbolWeightMultiplier, 1.4);
  assert.equal(dominance.activityEligible, true);
  assert.equal(dominance.thresholdMultiplier, 0.95);
  assert.equal(dominance.targetActivityIncreasePct, "30-50");
  assert.ok(dominance.scoreBoost > cfg.trendDominanceScoreBoost);
  assert.equal(
    dominance.sizingMultiplier,
    dominance.tier === "ELITE_TREND_DOMINANCE" ? cfg.trendDominanceEliteSizingMultiplier : cfg.trendDominanceStrongSizingMultiplier
  );
  assert.equal(dominance.neverBypassesRisk, true);
  assert.equal(dominance.neverBypassesFees, true);

  const idle4h = dynamicInactivityRecovery(cfg, Date.now() - 4.1 * 60 * 60 * 1000);
  const idle8h = dynamicInactivityRecovery(cfg, Date.now() - 8.1 * 60 * 60 * 1000);
  const idle12h = dynamicInactivityRecovery(cfg, Date.now() - 12.1 * 60 * 60 * 1000);
  const recentTrade = dynamicInactivityRecovery(cfg, Date.now() - 30 * 60 * 1000);
  assert.equal(idle4h.convictionRelaxPoints, 2);
  assert.equal(idle8h.convictionRelaxPoints, 4);
  assert.equal(idle12h.convictionRelaxPoints, 6);
  assert.equal(idle4h.convictionThresholdDelta, -2);
  assert.equal(idle8h.convictionThresholdDelta, -4);
  assert.equal(idle12h.convictionThresholdDelta, -6);
  assert.equal(idle12h.convictionThresholdMultiplier, 1);
  assert.equal(recentTrade.active, false);
  assert.equal(idle12h.resetAfterNewTrade, true);

  const qualityWithDominance = qualityScoreForSignal(cfg, signal, {
    expectedNetEdgePct: 0.75,
    expectedRewardCostRatio: 3.3,
    expectedRewardRiskRatio: 1.6,
  }, null, null, {
    setupRegimeMatrixMemory: matrix,
    activityRecovery: { active: true, thresholdMultiplier: 0.97, scoreBoost: 1.35 },
    trendDominance: dominance,
  });
  const qualityWithoutDominance = qualityScoreForSignal(cfg, signal, {
    expectedNetEdgePct: 0.75,
    expectedRewardCostRatio: 3.3,
    expectedRewardRiskRatio: 1.6,
  }, null, null, {
    setupRegimeMatrixMemory: matrix,
  });
  assert.ok(qualityWithDominance.score >= qualityWithoutDominance.score);
  assert.ok(qualityWithDominance.thresholds.normal < qualityWithoutDominance.thresholds.normal);
  assert.ok(qualityWithDominance.components.trendDominance >= cfg.trendDominanceStrongScore);

  const weakSolDominance = trendDominanceSignal(cfg, {
    symbol: "SOLUSDT",
    side: "LONG",
    multiTimeframeTrendScore: 55,
    trendQualityScore: 56,
    continuationStrength: 58,
    portfolioAlphaScore: 50,
    marketRegimeV2: "SIDEWAYS_CHOP",
    continuationSetupType: "BREAKOUT_RETEST",
    setupType: "BREAKOUT",
    marketRegimeTags: ["SIDEWAYS_CHOP_MARKET"],
  }, {
    setupRegimeMatrixMemory: { weight: 1, bias: "NEUTRAL" },
    activityRecovery,
  });
  assert.equal(weakSolDominance.solWeakBreakout, true);
  assert.equal(weakSolDominance.symbolWeightMultiplier, cfg.trendDominanceSolWeakBreakoutMultiplier);
  assert.ok(weakSolDominance.scoreBoost < 0);

  const bot = new LadderBot(cfg);
  bot.store.state = {
    mode: "DRY_RUN",
    openPositions: [],
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    daily: { startingEquity: 60, tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 },
    symbolCooldowns: {},
  };
  bot.risk.store = bot.store;
  const plan = bot.risk.sizingPlan({
    ...signal,
    price: 2500,
    score: 90,
    profitQualityScore: 90,
    liquidityScore: 88,
    btcTrendAligned: true,
    trendDominanceScore: dominance.score,
    trendDominanceSizingMultiplier: dominance.sizingMultiplier,
  }, 60, instrument("ETHUSDT", { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "1" }), 4);
  assert.ok(plan.reasonsForSizingTier.some((reason) => /V10 trend dominance sizing multiplier/i.test(reason)));
  assert.ok(plan.maxLossAtStopUsdt <= 60 * (cfg.profitControlledStrongMaxStopRiskPct / 100) + 0.000001);
  assert.ok(plan.runnerAllocation.runnerPct >= 85);
}

async function testScannerInactivityRecoverySummaryScope() {
  const cfg = config({
    tradeFrequencyRecoveryMode: true,
    inactivityRecoveryMode: true,
    focusedTradingSymbolsList: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    focusedTradingSymbols: new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]),
    excludedSymbols: new Set(),
  });
  const logs = logCollector();
  const client = {
    getSymbols: async () => [],
    getTicker: async () => null,
    subscribeTickers: () => {},
  };
  const scanner = new Scanner(cfg, client, logs.log, null);
  scanner.setRuntimeContext({
    dynamicInactivityRecovery: {
      active: true,
      stage: "INACTIVE_8H",
      convictionRelaxPct: 4,
      convictionRelaxPoints: 4,
      convictionThresholdMultiplier: 1,
      convictionThresholdDelta: -4,
      resetAfterNewTrade: true,
    },
  });
  const scan = await scanner.scan({ direction: "CHOPPY", primary: "SIDEWAYS_CHOP_MARKET", tags: ["SIDEWAYS_CHOP_MARKET"], confidence: 40 });
  assert.equal(scan.candidates.length, 0);
  assert.equal(scan.hadApiErrors, false);
  const recoveryLog = logs.events.find((event) => event.message === "TRADE_FREQUENCY_RECOVERY_ACTIVE");
  const completedLog = logs.events.find((event) => event.message === "Scalping scan completed.");
  assert.equal(recoveryLog.details.inactivityRecovery.stage, "INACTIVE_8H");
  assert.equal(completedLog.details.inactivityRecovery.convictionRelaxPoints, 4);
  assert.equal(completedLog.details.inactivityRecovery.convictionThresholdDelta, -4);
}

async function testV12ScannerQualityAvoidsDuplicateBotVetoes() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({
    dryRun: true,
    profitControlledEquityMode: true,
    profitExpansionMode: true,
    nearMissSmallTradeEnabled: true,
    smartEdgeMinTpProbability: 0.35,
  }));
  bot.log = log;
  bot.store.trades = [];

  const scannerAcceptedExploration = {
    symbol: "ETHUSDT",
    side: "LONG",
    setupType: "TREND_CONTINUATION",
    continuationSetupType: "PULLBACK_CONTINUATION",
    tradeQualityTier: "EXPLORATION",
    scannerQualityTier: "EXPLORATION",
    tradeQualityAssignedBy: "scanner.js",
    tradeQualification: {
      tier: "EXPLORATION",
      category: "ACCEPTED",
      assignedBy: "scanner.js",
      reason: "near-threshold positive-edge exploration",
    },
    tradeCategory: "EXPLORATION",
    explorationTrade: true,
    score: 43,
    requiredScore: 70,
    convictionScore: 39,
    requiredConvictionScore: 55,
    projectedNetEdgePct: 0.08,
    smartProjectedNetEdgePct: 0.07,
    expectedMovePct: 0.38,
    estimatedTpProbability: 0.52,
    feeEdgeRatio: 1.12,
    spreadPct: 0.01,
    estimatedEntryFeePct: 0.02,
    estimatedExitFeePct: 0.02,
    estimatedSlippagePct: 0.01,
    continuationStrength: 55,
    marketRegimeV2: "SIDEWAYS_CHOP",
    marketRegimeTags: ["SIDEWAYS_CHOP_MARKET"],
    rejected: [],
  };

  const edgeCheck = bot.feeAwareEntryCheck(scannerAcceptedExploration);
  assert.equal(edgeCheck.rejected, false);
  assert.equal(edgeCheck.scannerQualityBypass, true);
  assert.ok(events.some((event) => event.message === "V12_DUPLICATE_EDGE_QUALITY_RECHECK_SKIPPED"));

  const qualityCheck = bot.profitModeQualityCheck(scannerAcceptedExploration, edgeCheck.edgeModel);
  assert.equal(qualityCheck.rejected, false);
  assert.equal(qualityCheck.tier, "EXPLORATION");
  assert.equal(qualityCheck.v12DuplicateQualityBypass, true);
  assert.equal(scannerAcceptedExploration.explorationTrade, true);

  const negativeEdge = {
    ...scannerAcceptedExploration,
    projectedNetEdgePct: -0.02,
    smartProjectedNetEdgePct: -0.02,
    expectedMovePct: 0.02,
    estimatedTpProbability: 0.2,
  };
  const negativeEdgeCheck = bot.feeAwareEntryCheck(negativeEdge);
  assert.equal(negativeEdgeCheck.rejected, true);
  assert.match(negativeEdgeCheck.reason, /not positive|EDGE_GATE_REJECTED/);
}

async function testProfitProtectionReducesExplorationAndRisk() {
  const bot = new LadderBot(config({
    dryRun: true,
    profitProtectionEnabled: true,
    profitProtectionStartPct: 5,
    profitProtectionRiskMultiplier: 0.7,
    profitProtectionExplorationMultiplier: 0.35,
  }));
  bot.store.state = {
    daily: { startingEquity: 100, tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 },
    ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
  };
  bot.risk.store = bot.store;
  const protection = bot.risk.profitProtection(109);
  assert.equal(protection.active, true);
  assert.ok(protection.riskMultiplier < 1);
  assert.ok(protection.explorationMultiplier < 1);

  const exploratory = bot.profitProtectionEntryCheck({
    explorationTrade: true,
    requiredScore: 48,
    requiredConvictionScore: 58,
    score: 70,
    convictionScore: 70,
    projectedNetEdgePct: 1,
    marketRegimeTags: ["SIDEWAYS_CHOP_MARKET"],
  }, protection);
  assert.equal(exploratory.rejected, false);
  assert.ok(exploratory.reason.includes("learning phase keeps protected exploration active"));

  const highQuality = bot.profitProtectionEntryCheck({
    explorationTrade: false,
    requiredScore: 48,
    requiredConvictionScore: 58,
    score: 78,
    convictionScore: 72,
    projectedNetEdgePct: 1,
    btcTrendAligned: true,
    marketRegimeTags: ["STRONG_TRENDING_MARKET"],
  }, protection);
  assert.equal(highQuality.rejected, false);
}

async function testMomentumContinuationHoldLogic() {
  const bot = new LadderBot(config({ dryRun: true }));
  const position = {
    symbol: "ADAUSDT",
    side: "LONG",
    openedAt: new Date(Date.now() - 180000).toISOString(),
  };
  const strong = bot.strongMomentumContinuation(position, {
    symbol: "ADAUSDT",
    side: "LONG",
    momentum1mPct: 0.3,
    momentum5mPct: 0.2,
    convictionScore: 78,
    momentumPersistenceCandles: 4,
    volumeCondition: "CONFIRMED_VOLUME",
    volatilityRegime: "NORMAL",
  }, 0.6);
  assert.equal(strong, true);

  const noisy = bot.strongMomentumContinuation(position, {
    symbol: "ADAUSDT",
    side: "SHORT",
    momentum1mPct: -0.1,
    momentum5mPct: -0.1,
    convictionScore: 50,
    momentumPersistenceCandles: 1,
    volumeCondition: "LOW_VOLUME",
    volatilityRegime: "NORMAL",
  }, 0.6);
  assert.equal(noisy, false);

  const elitePosition = {
    id: "elite-runner-test",
    mode: "DRY_RUN",
    status: "OPEN",
    symbol: "SOLUSDT",
    side: "LONG",
    size: "2.000",
    entryPrice: 10,
    openedAt: new Date(Date.now() - 240000).toISOString(),
    eliteTrendRider: true,
  };
  bot.store.state.openPositions = [elitePosition];
  bot.store.trades = [{ ...elitePosition, status: "OPEN" }];
  await bot.closePartialPosition(elitePosition, 10.2, "elite trend rider partial take profit", 0.5);
  assert.equal(elitePosition.runnerPartialTaken, true);
  assert.equal(elitePosition.size, "1.000");
  assert.ok(Number(elitePosition.partialRealizedPnlUsdt) > 0);
}

function memoryRecord(overrides = {}) {
  return {
    id: `m-${Math.random()}`,
    symbol: "ADAUSDT",
    side: "LONG",
    setupType: "BREAKOUT",
    score: 58,
    timestamp: new Date().toISOString(),
    openedAt: new Date(Date.now() - 60000).toISOString(),
    exitedAt: new Date().toISOString(),
    holdingTimeSeconds: 60,
    realizedPnlPct: 1,
    realizedPnlUsdt: 0.5,
    feesPaidUsdt: 0.02,
    grossPnlUsdt: 0.52,
    leverage: 5,
    btcMarketRegime: "UP",
    marketRegime: "UP",
    marketRegimeType: "STRONG_TRENDING_MARKET",
    marketRegimeTags: ["STRONG_TRENDING_MARKET", "BTC_LED_MARKET"],
    marketRegimeConfidence: 70,
    btcTrendStrength: 70,
    btcVolatilityPct: 0.4,
    btcMomentumPct: 0.2,
    btcInstability: false,
    volatilityRegime: "NORMAL",
    volumeConditions: "CONFIRMED_VOLUME",
    continuationSetupType: "CONTINUATION_BREAKOUT",
    continuationStrength: 72,
    marketPersonality: "HIGH_MOMENTUM_CONTINUATION",
    macroTrend: "UP",
    macroAligned: true,
    macroContradicts: false,
    entryMomentumPct: 0.15,
    spreadPct: 0.04,
    slippagePct: 0.01,
    result: "TP",
    winLoss: "WIN",
    sessionType: "US",
    breakoutTriggered: true,
    fomoTriggered: false,
    microBreakoutTriggered: false,
    adaptiveConfidenceAtEntry: 50,
    adaptiveModeAtEntry: "BASELINE",
    ...overrides,
  };
}

async function testAdaptiveEnginePolicyAndConfidence() {
  const { log } = logCollector();
  const defensive = new AdaptiveEngine(config({ minAdaptiveTrades: 5, minAdaptiveBucketTrades: 3 }), log);
  defensive.load();
  defensive.memory.trades = Array.from({ length: 10 }, (_, index) =>
    memoryRecord({
      id: `loss-${index}`,
      realizedPnlPct: -0.8,
      realizedPnlUsdt: -0.3,
      grossPnlUsdt: -0.28,
      result: "SL",
      winLoss: "LOSS",
    })
  );
  defensive.rebuild();
  assert.equal(defensive.currentPolicy().mode, "CAUTIOUS_ACTIVE");
  assert.equal(defensive.currentPolicy().learningPhaseActive, true);
  assert.equal(defensive.currentPolicy().aggressiveLearningPhaseActive, true);
  assert.equal(defensive.currentPolicy().dailyTradeLimitsDisabled, true);
  assert.equal(defensive.currentPolicy().qualityPacingActive, true);
  assert.ok(defensive.currentPolicy().riskMultiplier >= 0.8);
  assert.equal(defensive.currentPolicy().explorationBudget, Number.MAX_SAFE_INTEGER);

  const confident = new AdaptiveEngine(config({ minAdaptiveTrades: 5, minAdaptiveBucketTrades: 3 }), log);
  confident.load();
  confident.memory.trades = [
    ...Array.from({ length: 6 }, (_, index) => memoryRecord({ id: `win-${index}` })),
    ...Array.from({ length: 4 }, (_, index) =>
      memoryRecord({
        id: `bad-${index}`,
        symbol: "WIFUSDT",
        side: "SHORT",
        setupType: "FOMO_BREAKOUT",
        btcMarketRegime: "CHOPPY",
        marketRegime: "CHOPPY",
        marketRegimeType: "FAKE_BREAKOUT_ENVIRONMENT",
        marketRegimeTags: ["FAKE_BREAKOUT_ENVIRONMENT", "SIDEWAYS_CHOP_MARKET"],
        volatilityRegime: "HIGH_VOLATILITY",
        realizedPnlPct: -0.7,
        realizedPnlUsdt: -0.25,
        result: "SL",
        winLoss: "LOSS",
      })
    ),
  ];
  confident.rebuild();
  const good = confident.evaluateSignal({
    symbol: "ADAUSDT",
    side: "LONG",
    setupType: "BREAKOUT",
    btcTrend: "UP",
    marketRegimeType: "STRONG_TRENDING_MARKET",
    marketRegimeTags: ["STRONG_TRENDING_MARKET", "BTC_LED_MARKET"],
    sessionRegime: "US",
    volatilityRegime: "NORMAL",
    volumeCondition: "CONFIRMED_VOLUME",
    btcTrendAligned: true,
    projectedNetEdgePct: 1.2,
    technicalConvictionScore: 80,
    continuationSetupType: "CONTINUATION_BREAKOUT",
    continuationStrength: 76,
    marketPersonality: "HIGH_MOMENTUM_CONTINUATION",
    macroAligned: true,
  });
  assert.ok(good.scoreAdjustment > 0);
  assert.ok(good.confidence > 50);
  assert.ok(good.reasons.some((reason) => reason.includes("adaptive regime confidence") || reason.includes("strong trending")));
  assert.ok(good.reasons.some((reason) => reason.includes("adaptive market memory matched continuation") || reason.includes("symbol specialization memory")));
  assert.ok(confident.analytics.continuationLeaderboard.best.length > 0);
  assert.ok(confident.analytics.symbolSpecializationLeaderboard.best.length > 0);

  const bad = confident.evaluateSignal({
    symbol: "WIFUSDT",
    side: "SHORT",
    setupType: "FOMO_BREAKOUT",
    btcTrend: "CHOPPY",
    marketRegimeType: "FAKE_BREAKOUT_ENVIRONMENT",
    marketRegimeTags: ["FAKE_BREAKOUT_ENVIRONMENT", "SIDEWAYS_CHOP_MARKET"],
    sessionRegime: "US",
    volatilityRegime: "HIGH_VOLATILITY",
    volumeCondition: "LOW_VOLUME",
    btcTrendAligned: false,
    projectedNetEdgePct: 0.1,
    technicalConvictionScore: 35,
  });
  assert.equal(bad.rejected, false);
  assert.ok(bad.scoreAdjustment < 0);
  assert.ok(bad.confidence >= confident.config.adaptiveConfidenceFloor);
  assert.ok(bad.scoreAdjustment >= -confident.config.adaptiveConfidencePenaltyMax);
  assert.ok(bad.reasons.some((reason) => reason.includes("adaptive penalty softened") || reason.includes("small-sample penalty reduced")));

  const overridden = confident.evaluateSignal({
    symbol: "WIFUSDT",
    side: "SHORT",
    setupType: "FOMO_BREAKOUT",
    btcTrend: "CHOPPY",
    marketRegimeType: "FAKE_BREAKOUT_ENVIRONMENT",
    marketRegimeTags: ["HIGH_VOLATILITY_BREAKOUT_MARKET", "FAKE_BREAKOUT_ENVIRONMENT"],
    sessionRegime: "US",
    volatilityRegime: "HIGH_VOLATILITY",
    volumeCondition: "STRONG_VOLUME_SPIKE",
    volumeSpike: 2.4,
    momentumPersistenceCandles: 3,
    breakoutTriggered: true,
    btcTrendAligned: false,
    projectedNetEdgePct: 1.2,
    feeEdgeRatio: 3.2,
    technicalConvictionScore: 88,
  });
  assert.equal(overridden.rejected, false);
  assert.ok(overridden.confidence >= confident.config.adaptiveConfidenceFloor);
  assert.ok(overridden.scoreAdjustment > bad.scoreAdjustment);
  assert.ok(overridden.reasons.some((reason) => reason.includes("technical override activated")));
}

async function testAdaptiveDefensiveRecoveryPolicy() {
  const { log } = logCollector();
  const adaptive = new AdaptiveEngine(config({
    minAdaptiveTrades: 6,
    adaptiveRecoveryLookbackTrades: 8,
    adaptiveRecoveryWinRatePct: 45,
  }), log);
  adaptive.load();
  adaptive.memory.trades = [
    ...Array.from({ length: 12 }, (_, index) =>
      memoryRecord({
        id: `old-loss-${index}`,
        realizedPnlPct: -0.8,
        realizedPnlUsdt: -0.4,
        result: "SL",
        winLoss: "LOSS",
      })
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      memoryRecord({
        id: `recent-loss-${index}`,
        realizedPnlPct: -0.5,
        realizedPnlUsdt: -0.25,
        result: "SL",
        winLoss: "LOSS",
      })
    ),
    ...Array.from({ length: 6 }, (_, index) =>
      memoryRecord({
        id: `recent-win-${index}`,
        realizedPnlPct: 0.5,
        realizedPnlUsdt: 0.2,
        result: "TP",
        winLoss: "WIN",
      })
    ),
  ];
  adaptive.rebuild();
  const policy = adaptive.currentPolicy();
  assert.equal(policy.mode, "AGGRESSIVE_LEARNING_RECOVERY");
  assert.ok(policy.riskMultiplier >= 1);
  assert.ok(policy.explorationEnabled);
  assert.ok(policy.explorationBudget >= 1);
  assert.equal(policy.recoveryAggressionRestored, true);
}

async function testAdaptiveActivityFloorPolicy() {
  const { log } = logCollector();
  const adaptive = new AdaptiveEngine(config({
    maxTradesPerDay: 12,
    explorationTradeRatio: 0.1,
    explorationMaxTradesPerDay: 6,
    adaptiveActivityFloorEnabled: true,
    activityFloorMinTradesPerDay: 10,
    activityFloorMinExplorationBudget: 4,
    activityFloorSignalRelaxPoints: 3,
    activityFloorConvictionRelaxPoints: 4,
    minAdaptiveTrades: 5,
    aggressiveLearningPhase: false,
    continuousExecutionMode: false,
    qualityPacingEnabled: false,
    disableDailyTradeLimits: false,
  }), log);
  adaptive.load();
  adaptive.memory.trades = Array.from({ length: 8 }, (_, index) =>
    memoryRecord({
      id: `floor-loss-${index}`,
      realizedPnlPct: -0.4,
      realizedPnlUsdt: -0.1,
      result: "SL",
      winLoss: "LOSS",
    })
  );
  adaptive.rebuild();
  const policy = adaptive.currentPolicy();
  assert.equal(policy.activityFloorEngaged, true);
  assert.equal(policy.explorationBudget, 4);
  assert.ok(policy.maxTradesPerDay >= 10);
  assert.ok(policy.explorationMinSignalScore < adaptive.config.explorationMinSignalScore + 2);
  assert.ok(policy.explorationMinConvictionScore < adaptive.config.explorationMinConvictionScore + 2);
}

async function testContinuousExecutionIgnoresDailyLossAndTradeCounts() {
  const bot = new LadderBot(config({
    disableDailyTradeLimits: true,
    maxTradesPerDay: 1,
  }));
  bot.store.state.daily = {
    date: "2099-01-01",
    startingEquity: 100,
    tradesOpened: 999,
    losingTrades: 5,
    realizedPnlUsdt: -21,
  };
  bot.store.trades = Array.from({ length: 3 }, (_, index) => ({
    id: `loss-${index}`,
    mode: "DRY_RUN",
    status: "CLOSED",
    pnlUsdt: -1,
    exitedAt: new Date(Date.now() - (3 - index) * 1000).toISOString(),
  }));
  assert.equal(bot.risk.entryBlockReason(79, "BTCUSDT"), null);
  const recovery = bot.risk.continuousRecoveryStatus(79);
  assert.equal(recovery.active, true);
  assert.equal(recovery.stopBot, false);
  assert.equal(recovery.closePositions, false);
  assert.ok(recovery.riskMultiplier < 1);
  assert.ok(recovery.leverageMultiplier < 1);
}

async function testContinuousExecutionClearsStaleTradeLimitPause() {
  const cfg = config({
    continuousExecutionMode: true,
    dryRun: true,
  });
  fs.writeFileSync(
    cfg.stateFile,
    JSON.stringify({
      mode: "DRY_RUN",
      exchange: "BYBIT_V5_LINEAR",
      strategyProfile: "BYBIT_ADAPTIVE_STAT_SCALP_V2",
      paused: true,
      pauseReason: ["adaptive", "maximum", "daily", "trades", "reached"].join(" "),
      openPositions: [],
      equity: { realizedPnlUsdt: 0 },
      ladder: { activeLevel: 1, highestUnlockedLevel: 1, levelStartEquity: 100, riskDowngraded: false },
    }),
    "utf8"
  );
  fs.writeFileSync(cfg.tradesFile, "[]", "utf8");
  const bot = new LadderBot(cfg);
  bot.store.load();
  assert.equal(bot.store.state.paused, false);
  assert.equal(bot.store.state.pauseReason, null);
  bot.store.state.daily = { startingEquity: 100, tradesOpened: 9999, losingTrades: 0, realizedPnlUsdt: 0 };
  bot.risk.store = bot.store;
  assert.equal(bot.risk.entryBlockReason(100, "BTCUSDT"), null);

  bot.store.state.paused = true;
  bot.store.state.pauseReason = ["maximum", "daily", "loss", "reached"].join(" ");
  assert.equal(bot.risk.entryBlockReason(70, "BTCUSDT"), null);
  assert.equal(bot.store.state.paused, false);
}

async function testAggressiveLearningCooldownsAreAdvisory() {
  const bot = new LadderBot(config({
    aggressiveLearningPhase: true,
    dryRun: true,
  }));
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  bot.store.state = {
    paused: false,
    openPositions: [],
    symbolCooldowns: {
      BTCUSDT: {
        lossCooldownUntil: future,
        reentryUntil: future,
      },
    },
    daily: { startingEquity: 100, tradesOpened: 9999, losingTrades: 0, realizedPnlUsdt: 0 },
  };
  bot.risk.store = bot.store;
  assert.equal(bot.risk.entryBlockReason(100, "BTCUSDT"), null);
}

async function testForcedMarketSamplingPromotion() {
  const { events, log } = logCollector();
  const bot = new LadderBot(config({
    learningPhaseMode: true,
    forcedMarketSamplingEnabled: true,
    forcedMarketSamplingAfterMinutes: 15,
    forcedSamplingMinScore: 25,
    forcedSamplingMinConviction: 30,
    forcedSamplingMinProjectedEdgePct: 0.05,
    forcedSamplingMinEdgeToCostRatio: 1,
    minLiquidityScore: 45,
  }));
  bot.log = log;
  bot.startedAt = Date.now() - 20 * 60 * 1000;
  bot.store.state.openPositions = [];
  bot.store.trades = [];

  const promoted = bot.candidatesWithForcedSampling({
    candidates: [],
    analyses: [
      {
        symbol: "SOLUSDT",
        side: "LONG",
        score: 31,
        convictionScore: 34,
        projectedNetEdgePct: 0.12,
        feeEdgeRatio: 1.2,
        liquidityScore: 36,
        momentumPersistenceCandles: 2,
        breakoutTriggered: true,
        trendQualityScore: 60,
        volatilityRegime: "NORMAL",
        rejected: ["moderate chop accepted for learning sample"],
        scoreBreakdown: ["momentum +15"],
        adaptiveReasons: ["small sample needs feedback"],
      },
    ],
  });

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].forcedMarketSampling, true);
  assert.equal(promoted[0].explorationTrade, true);
  assert.equal(promoted[0].tradeCategory, "EXPLORATION");
  assert.equal(promoted[0].rejected.length, 0);
  assert.ok(promoted[0].forcedSamplingOriginalRejections.includes("moderate chop accepted for learning sample"));
  assert.ok(events.some((event) => event.message === "Forced market sampling engaged."));
  assert.equal(bot.forcedSamplingEligible({ ...promoted[0], symbol: "WIFUSDT" }), false);
}

async function testV13SwingMomentumConfigAndBudget() {
  const loaded = withEnv(
    {
      SWING_MOMENTUM_MODE: "true",
      MAX_DEPLOYABLE_CAPITAL_USDT: "75",
      MAX_POSITIONS_PER_SYMBOL: "3",
      CANDLE_INTERVAL_FAST: undefined,
      CANDLE_INTERVAL_MAIN: undefined,
      CANDLE_INTERVAL_TREND: undefined,
      CANDLE_INTERVAL_MACRO: undefined,
      CANDLE_INTERVAL_MACRO_LONG: undefined,
    },
    () => loadConfig()
  );
  assert.equal(loaded.swingMomentumMode, true);
  assert.deepEqual(loaded.focusedTradingSymbolsList, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.equal(loaded.maxDeployableCapitalUsdt, 75);
  assert.equal(loaded.maxPositionsPerSymbol, 3);
  assert.equal(loaded.candleIntervalFast, "15M");
  assert.equal(loaded.candleIntervalMain, "60M");
  assert.equal(loaded.candleIntervalTrend, "240M");
  assert.equal(loaded.candleIntervalMacro, "1D");
  assert.equal(loaded.fastMode, false);
  assert.equal(loaded.highActivityMode, true);
  assert.equal(loaded.fomoBreakoutMode, false);
  assert.equal(loaded.microBreakoutEntries, false);
  assert.equal(loaded.forcedMarketSamplingEnabled, false);
  assert.equal(loaded.explorationModeEnabled, false);
  assert.ok(packageJson.scripts.swing.includes("SWING_MOMENTUM_MODE=true"));
  assert.ok(packageJson.scripts.swing.includes("MAX_DEPLOYABLE_CAPITAL_USDT=64"));
  assert.ok(packageJson.scripts.swing.includes("DRY_RUN=true"));
  assert.equal(loaded.scanIntervalMs, 15000);
  assert.equal(loaded.normalRiskAtStopMaxPct, 0.9);
  assert.equal(loaded.strongRiskAtStopMaxPct, 1.5);
  assert.equal(loaded.eliteRiskAtStopMaxPct, 2);
  assert.equal(loaded.swingDisableNativeTakeProfit, true);
  assert.equal(loaded.swingProfitExitMinHoldSeconds, 7200);
  assert.ok(loaded.tier2MarginMaxUsdt >= 28);
  assert.ok(loaded.tier3MarginMaxUsdt >= 40);
  const fallback = withEnv(
    {
      SWING_MOMENTUM_MODE: "true",
      MAX_DEPLOYABLE_CAPITAL_USDT: undefined,
      CANDLE_INTERVAL_FAST: undefined,
      CANDLE_INTERVAL_MAIN: undefined,
      CANDLE_INTERVAL_TREND: undefined,
      CANDLE_INTERVAL_MACRO: undefined,
      CANDLE_INTERVAL_MACRO_LONG: undefined,
    },
    () => loadConfig()
  );
  assert.equal(fallback.maxDeployableCapitalUsdt, 64);
}

async function testV13SwingMultiEntryAndDuplicateGuard() {
  const cfg = config({
    swingMomentumMode: true,
    maxPositionsPerSymbol: 3,
    maxOpenPositions: 9,
    maxDeployableCapitalUsdt: 25,
    continuousExecutionMode: false,
  });
  const bot = new LadderBot(cfg);
  const now = new Date().toISOString();
  const signal = {
    symbol: "BTCUSDT",
    side: "LONG",
    continuationSetupType: "PULLBACK_CONTINUATION",
    marketRegimeV2: "TRENDING",
    trend1h: "UP",
  };
  const fingerprint = bot.swingSignalFingerprint(signal);
  bot.store.state.openPositions = [
    { id: "one", status: "OPEN", symbol: "BTCUSDT", side: "LONG", notional: 10, leverage: 2, openedAt: now, swingSignalFingerprint: "BTCUSDT:LONG:BREAKOUT_RETEST:TRENDING:UP" },
    { id: "two", status: "OPEN", symbol: "BTCUSDT", side: "LONG", notional: 8, leverage: 2, openedAt: now, swingSignalFingerprint: "BTCUSDT:LONG:MOMENTUM_RESUMPTION:TRENDING:UP" },
  ];
  assert.equal(bot.risk.entryBlockReason(100, "BTCUSDT"), null);
  assert.equal(bot.swingDuplicateEntryReason(signal), null);
  bot.store.state.openPositions.push({
    id: "duplicate",
    status: "OPEN",
    symbol: "BTCUSDT",
    side: "LONG",
    notional: 6,
    leverage: 2,
    openedAt: now,
    swingSignalFingerprint: fingerprint,
  });
  assert.match(bot.risk.entryBlockReason(100, "BTCUSDT"), /maximum positions per symbol/);
  assert.match(bot.swingDuplicateEntryReason(signal), /duplicate identical swing entry/);
  const budget = bot.deployableCapitalCheck({ marginUsedUsdt: 16, notional: 32, leverage: 2 });
  assert.equal(budget.rejected, true);
  assert.match(budget.reason, /deployable capital budget/);
}

async function testV13SwingAdoptsExchangePositionWithoutOrders() {
  const { events, log } = logCollector();
  const cfg = config({
    swingMomentumMode: true,
    dryRun: false,
    maxDeployableCapitalUsdt: 50,
    winnerAmplifierPartialTakeProfitPct: 50,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  let tradingStopCalls = 0;
  bot.client = {
    positionIdx: () => 0,
    setTradingStop: async () => {
      tradingStopCalls += 1;
      return {};
    },
  };
  bot.instrumentRulesBySymbol.set("ETHUSDT", {
    symbol: "ETHUSDT",
    priceFilter: { tickSize: "0.01" },
    lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "5" },
  });
  const adopted = await bot.adoptExchangePosition({
    symbol: "ETHUSDT",
    side: "Sell",
    avgPrice: "3000",
    size: "0.01",
    leverage: "3",
    positionIdx: 0,
    liqPrice: "3900",
    takeProfit: "",
    stopLoss: "",
  });
  assert.equal(adopted, true);
  assert.equal(tradingStopCalls, 1);
  assert.equal(bot.store.state.openPositions.length, 1);
  const position = bot.store.state.openPositions[0];
  assert.equal(position.symbol, "ETHUSDT");
  assert.equal(position.side, "SHORT");
  assert.equal(position.swingAdoptedFromExchange, true);
  assert.equal(position.nativeProtectionVerified, true);
  assert.ok(position.stopLossPrice > position.entryPrice);
  assert.ok(position.takeProfitPrice < position.entryPrice);
  assert.ok(events.some((event) => event.message === "SWING_EXISTING_POSITION_ADOPTED"));
}

async function testV13SwingUsesStopOnlyNativeProtection() {
  const { events, log } = logCollector();
  const cfg = config({
    swingMomentumMode: true,
    dryRun: false,
    swingDisableNativeTakeProfit: true,
    maxDeployableCapitalUsdt: 64,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  const calls = [];
  bot.client = {
    setTradingStop: async (payload) => {
      calls.push(payload);
      return {};
    },
  };
  const position = {
    id: "swing-stop-only",
    symbol: "ETHUSDT",
    side: "LONG",
    positionIdx: 0,
    entryPrice: 3000,
    takeProfitPrice: 3180,
    stopLossPrice: 2934,
    tickSize: "0.01",
  };
  await bot.ensureNativeProtection(position);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stopLoss, "2934");
  assert.equal(Object.hasOwn(calls[0], "takeProfit"), false);
  assert.equal(position.nativeProtection, "BYBIT_NATIVE_STOP_VERIFIED_SWING_TP_DISABLED");
  assert.ok(events.some((event) => event.message === "Native Bybit swing stop protection verified."));
}

async function testV13SwingBlocksEarlyTakeProfitExit() {
  const { events, log } = logCollector();
  const cfg = config({
    swingMomentumMode: true,
    dryRun: true,
    maxDeployableCapitalUsdt: 64,
    swingProfitExitMinHoldSeconds: 7200,
    swingMinimumHoldSeconds: 7200,
    swingTrailingMinHoldSeconds: 1800,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  bot.client = {
    getTicker: async () => ({ lastPrice: 107 }),
  };
  bot.scanner = {
    analysisForPosition: async () => ({
      side: "LONG",
      trend5m: "UP",
      trend1h: "UP",
      macroContradicts: false,
      momentum1mPct: 0.12,
      momentum5mPct: 0.2,
      continuationStrength: 70,
      continuationSetupType: "PULLBACK_CONTINUATION",
      marketRegimeTags: ["STRONG_TRENDING_MARKET"],
      volatilityRegime: "NORMAL",
      convictionScore: 80,
      momentumPersistenceCandles: 3,
      volumeCondition: "NORMAL_VOLUME",
    }),
  };
  const openedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const position = {
    id: "early-swing-profit",
    mode: "DRY_RUN",
    status: "OPEN",
    symbol: "ETHUSDT",
    side: "LONG",
    size: "0.01",
    entryPrice: 100,
    stopLossPrice: 94,
    takeProfitPrice: 106,
    partialTakeProfitPrice: 104,
    runnerTakeProfitPrice: 106,
    standardTakeProfitPrice: 104,
    eliteTrendRider: true,
    winnerAmplifier: true,
    runnerPartialPct: 40,
    runnerPartialTaken: false,
    peakPrice: 100,
    adversePrice: 100,
    openedAt,
    tickSize: "0.01",
  };
  bot.store.state.openPositions = [position];
  bot.store.trades = [{ ...position }];
  await bot.managePositions({});
  assert.equal(bot.store.state.openPositions.length, 1);
  assert.equal(bot.store.state.openPositions[0].runnerPartialTaken, false);
  assert.ok(events.some((event) => event.message === "SWING_TP1_HOLD_DELAYED"));
  assert.ok(!events.some((event) => event.message === "PARTIAL RUNNER ENABLED"));
}

async function testV13SwingHardStopStillExitsImmediately() {
  const { log } = logCollector();
  const cfg = config({
    swingMomentumMode: true,
    dryRun: true,
    maxDeployableCapitalUsdt: 64,
    swingProfitExitMinHoldSeconds: 7200,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  bot.client = {
    getTicker: async () => ({ lastPrice: 93 }),
  };
  const openedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const position = {
    id: "early-swing-stop",
    mode: "DRY_RUN",
    status: "OPEN",
    symbol: "ETHUSDT",
    side: "LONG",
    size: "0.01",
    entryPrice: 100,
    stopLossPrice: 94,
    takeProfitPrice: 112,
    peakPrice: 100,
    adversePrice: 100,
    openedAt,
  };
  bot.store.state.openPositions = [position];
  bot.store.trades = [{ ...position }];
  await bot.managePositions({});
  assert.equal(bot.store.state.openPositions.length, 0);
  assert.equal(bot.store.trades[0].exitReason, "hard stop loss hit");
}

function trendInstrument(symbol, overrides = {}) {
  return {
    ...instrument(symbol, overrides),
    contractType: "LinearPerpetual",
    settleCoin: "USDT",
  };
}

function trendCandles(direction = "UP", start = 100, count = 90) {
  const candles = [];
  let price = start;
  for (let index = 0; index < count; index += 1) {
    const drift = direction === "UP" ? 0.004 : -0.004;
    const open = price;
    const close = index === count - 1
      ? open * (1 + drift * 3.1)
      : open * (1 + drift);
    const high = Math.max(open, close) * (index === count - 1 ? 1.006 : 1.002);
    const low = Math.min(open, close) * (index === count - 1 ? 0.996 : 0.998);
    const volume = index === count - 1 ? 2800 : 1000 + index;
    candles.push({
      time: 1700000000000 + index * 60000,
      open: Number(open.toFixed(6)),
      high: Number(high.toFixed(6)),
      low: Number(low.toFixed(6)),
      close: Number(close.toFixed(6)),
      volume,
      turnover: Number((volume * close).toFixed(6)),
    });
    price = close;
  }
  return candles;
}

async function testV14TrendPortfolioConfigAndLaunchPath() {
  const loaded = withEnv(
    {
      TREND_PORTFOLIO_MODE: "true",
      MAX_DEPLOYABLE_CAPITAL_USDT: undefined,
      MAX_POSITIONS_PER_SYMBOL: "3",
      CANDLE_INTERVAL_FAST: undefined,
      CANDLE_INTERVAL_MAIN: undefined,
      CANDLE_INTERVAL_TREND: undefined,
      CANDLE_INTERVAL_MACRO: undefined,
      CANDLE_INTERVAL_MACRO_LONG: undefined,
    },
    () => loadConfig()
  );
  assert.equal(loaded.trendPortfolioMode, true);
  assert.equal(loaded.swingMomentumMode, false);
  assert.deepEqual(loaded.focusedTradingSymbolsList, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.equal(loaded.maxDeployableCapitalUsdt, 64);
  assert.equal(loaded.maxPositionsPerSymbol, 3);
  assert.equal(loaded.candleIntervalFast, "15M");
  assert.equal(loaded.candleIntervalMain, "60M");
  assert.equal(loaded.candleIntervalTrend, "240M");
  assert.equal(loaded.candleIntervalMacro, "1D");
  assert.equal(loaded.fastMode, false);
  assert.equal(loaded.fomoBreakoutMode, false);
  assert.equal(loaded.microBreakoutEntries, false);
  assert.equal(loaded.forcedMarketSamplingEnabled, false);
  assert.equal(loaded.explorationModeEnabled, false);
  assert.equal(loaded.swingDisableNativeTakeProfit, true);
  assert.ok(loaded.swingProfitExitMinHoldSeconds >= 7200);
  assert.ok(loaded.swingMaxHoldSeconds >= 259200);
  assert.ok(packageJson.scripts.trend.includes("TREND_PORTFOLIO_MODE=true"));
  assert.ok(packageJson.scripts.trend.includes("MAX_DEPLOYABLE_CAPITAL_USDT=64"));
  assert.ok(packageJson.scripts.check.includes("src/trendPortfolioEngine.js"));
  assert.throws(
    () => withEnv({ TREND_PORTFOLIO_MODE: "true", SWING_MOMENTUM_MODE: "true" }, () => loadConfig()),
    /independent V14 trend profile/
  );
}

async function testV14TrendPortfolioEngineBuildsIndependentThesis() {
  const { events, log } = logCollector();
  const cfg = config({
    trendPortfolioMode: true,
    adaptiveLearningEnabled: false,
    min24hVolumeUsdt: 1000,
    maxSpreadPct: 0.2,
    minVolumeSpike: 1.1,
    minRangeExpansion: 1.1,
    trendPortfolioMinScore: 54,
    trendPortfolioNormalScore: 58,
    trendPortfolioStrongScore: 68,
    trendPortfolioEliteScore: 78,
    trendPortfolioMinNetEdgePct: 0.01,
    trendPortfolioMinRewardCostRatio: 1.1,
    scanConcurrency: 3,
  });
  const subscribed = [];
  const baseBySymbol = { BTCUSDT: 100, ETHUSDT: 200, SOLUSDT: 50 };
  const client = {
    getSymbols: async () => [
      trendInstrument("BTCUSDT"),
      trendInstrument("ETHUSDT"),
      trendInstrument("SOLUSDT"),
      trendInstrument("DOGEUSDT"),
    ],
    getTicker: async (symbol) => ({
      symbol,
      lastPrice: String(baseBySymbol[symbol] || 1),
      turnover24h: "50000000",
      bid1Price: String((baseBySymbol[symbol] || 1) * 0.9998),
      ask1Price: String((baseBySymbol[symbol] || 1) * 1.0002),
    }),
    getKlines: async (symbol) => trendCandles("UP", baseBySymbol[symbol] || 100),
    subscribeTickers: (symbols) => subscribed.push(...symbols),
  };
  const engine = new TrendPortfolioEngine(cfg, client, log, null);
  const scan = await engine.scan({
    direction: "UP",
    primary: "TRENDING",
    tags: ["STRONG_TRENDING_MARKET"],
    confidence: 90,
    reasons: ["test trending tape"],
  });
  assert.deepEqual(subscribed, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.ok(scan.analyses.length >= 3);
  assert.ok(scan.candidates.length >= 1);
  const best = scan.candidates[0];
  assert.equal(best.tradeQualification.assignedBy, "trendPortfolioEngine.js");
  assert.equal(best.tradeQualification.scalpDecisionLogicReused, false);
  assert.equal(best.trendPortfolioMode, true);
  assert.equal(best.explorationTrade, false);
  assert.equal(best.forcedMarketSampling, false);
  assert.ok(["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(best.symbol));
  assert.ok(best.multiTimeframeTrendScore >= 60);
  assert.ok(best.trendThesis && best.trendThesis.holdingIntent.includes("multiple days"));
  assert.ok(events.some((event) => event.message === "V14_TREND_PORTFOLIO_ENGINE_ACTIVE"));
  assert.ok(events.some((event) => event.message === "V14_TREND_PORTFOLIO_SCAN_COMPLETED"));
}

async function testV14TrendUsesStopOnlyNativeProtection() {
  const cfg = config({
    trendPortfolioMode: true,
    dryRun: false,
    swingDisableNativeTakeProfit: true,
    maxDeployableCapitalUsdt: 64,
  });
  const bot = new LadderBot(cfg);
  const calls = [];
  bot.client = {
    setTradingStop: async (payload) => {
      calls.push(payload);
      return {};
    },
  };
  const position = {
    id: "v14-stop-only",
    symbol: "BTCUSDT",
    side: "SHORT",
    positionIdx: 0,
    entryPrice: 100,
    takeProfitPrice: 88,
    stopLossPrice: 104,
    tickSize: "0.01",
  };
  await bot.ensureNativeProtection(position);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stopLoss, "104");
  assert.equal(Object.hasOwn(calls[0], "takeProfit"), false);
  assert.equal(position.nativeProtection, "BYBIT_NATIVE_STOP_VERIFIED_SWING_TP_DISABLED");
}

async function testV14TrendAdoptsExchangePositionWithoutOrders() {
  const { events, log } = logCollector();
  const cfg = config({
    trendPortfolioMode: true,
    dryRun: false,
    maxDeployableCapitalUsdt: 64,
    swingDisableNativeTakeProfit: true,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  let tradingStopCalls = 0;
  bot.client = {
    positionIdx: () => 0,
    setTradingStop: async () => {
      tradingStopCalls += 1;
      return {};
    },
  };
  bot.instrumentRulesBySymbol.set("SOLUSDT", {
    symbol: "SOLUSDT",
    priceFilter: { tickSize: "0.001" },
    lotSizeFilter: { qtyStep: "0.1", minOrderQty: "0.1", minNotionalValue: "5" },
  });
  const adopted = await bot.adoptExchangePosition({
    symbol: "SOLUSDT",
    side: "Buy",
    avgPrice: "150",
    size: "0.2",
    leverage: "3",
    positionIdx: 0,
    liqPrice: "80",
    takeProfit: "",
    stopLoss: "",
  });
  assert.equal(adopted, true);
  assert.equal(tradingStopCalls, 1);
  assert.equal(bot.store.state.openPositions.length, 1);
  const position = bot.store.state.openPositions[0];
  assert.equal(position.trendPortfolioMode, true);
  assert.equal(position.swingMomentumMode, false);
  assert.equal(position.setupType, "ADOPTED_EXISTING_TREND_POSITION");
  assert.equal(position.tradeCategory, "TREND_PORTFOLIO_ADOPTED");
  assert.ok(position.stopLossPrice < position.entryPrice);
  assert.ok(events.some((event) => event.message === "TREND_EXISTING_POSITION_ADOPTED"));
}

async function testV14TrendBlocksEarlyTakeProfitExit() {
  const { events, log } = logCollector();
  const cfg = config({
    trendPortfolioMode: true,
    dryRun: true,
    maxDeployableCapitalUsdt: 64,
    swingProfitExitMinHoldSeconds: 7200,
    swingTrailingMinHoldSeconds: 1800,
  });
  const bot = new LadderBot(cfg);
  bot.log = log;
  bot.client = {
    getTicker: async () => ({ lastPrice: 107 }),
  };
  bot.trendPortfolio = {
    analysisForPosition: async () => ({
      side: "LONG",
      trend5m: "UP",
      trend1h: "UP",
      macroContradicts: false,
      momentum1mPct: 0.12,
      momentum5mPct: 0.2,
      continuationStrength: 76,
      continuationSetupType: "TREND_MOMENTUM_CONTINUATION",
      marketRegimeTags: ["STRONG_TRENDING_MARKET"],
      volatilityRegime: "NORMAL",
      convictionScore: 84,
      momentumPersistenceCandles: 4,
      volumeCondition: "CONFIRMED_VOLUME",
    }),
  };
  const openedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const position = {
    id: "early-v14-profit",
    mode: "DRY_RUN",
    status: "OPEN",
    symbol: "ETHUSDT",
    side: "LONG",
    size: "0.01",
    entryPrice: 100,
    stopLossPrice: 94,
    takeProfitPrice: 106,
    partialTakeProfitPrice: 104,
    runnerTakeProfitPrice: 106,
    standardTakeProfitPrice: 104,
    eliteTrendRider: true,
    winnerAmplifier: true,
    trendPortfolioMode: true,
    runnerPartialPct: 40,
    runnerPartialTaken: false,
    peakPrice: 100,
    adversePrice: 100,
    openedAt,
    tickSize: "0.01",
  };
  bot.store.state.openPositions = [position];
  bot.store.trades = [{ ...position }];
  await bot.managePositions({});
  assert.equal(bot.store.state.openPositions.length, 1);
  assert.equal(bot.store.state.openPositions[0].runnerPartialTaken, false);
  assert.ok(events.some((event) => event.message === "SWING_TP1_HOLD_DELAYED"));
}

async function testV14TrendPyramidingDuplicateAndBudgetGuards() {
  const cfg = config({
    trendPortfolioMode: true,
    maxPositionsPerSymbol: 3,
    maxOpenPositions: 9,
    maxDeployableCapitalUsdt: 25,
    continuousExecutionMode: false,
  });
  const bot = new LadderBot(cfg);
  const now = new Date().toISOString();
  const signal = {
    symbol: "BTCUSDT",
    side: "LONG",
    continuationSetupType: "TREND_BREAKOUT_CONTINUATION",
    marketRegimeV2: "TRENDING",
    trend1h: "UP",
    trend4h: "UP",
    macroTrend: "UP",
    trendThesisKey: "BTCUSDT:LONG:TREND_BREAKOUT_CONTINUATION:UP:UP:UP:UP",
  };
  const fingerprint = bot.swingSignalFingerprint(signal);
  bot.store.state.openPositions = [
    { id: "one", status: "OPEN", symbol: "BTCUSDT", side: "LONG", notional: 10, leverage: 2, openedAt: now, swingSignalFingerprint: "BTCUSDT:LONG:TREND_MOMENTUM_CONTINUATION:TRENDING:UP" },
    { id: "two", status: "OPEN", symbol: "BTCUSDT", side: "LONG", notional: 8, leverage: 2, openedAt: now, swingSignalFingerprint: "BTCUSDT:LONG:BREAKOUT_RETEST:TRENDING:UP" },
  ];
  assert.equal(bot.risk.entryBlockReason(100, "BTCUSDT"), null);
  assert.equal(bot.swingDuplicateEntryReason(signal), null);
  bot.store.state.openPositions.push({
    id: "duplicate",
    status: "OPEN",
    symbol: "BTCUSDT",
    side: "LONG",
    notional: 6,
    leverage: 2,
    openedAt: now,
    swingSignalFingerprint: fingerprint,
  });
  assert.match(bot.risk.entryBlockReason(100, "BTCUSDT"), /maximum positions per symbol/);
  assert.match(bot.swingDuplicateEntryReason(signal), /duplicate identical trend thesis/);
  const budget = bot.deployableCapitalCheck({ marginUsedUsdt: 16, notional: 32, leverage: 2 });
  assert.equal(budget.rejected, true);
  assert.match(budget.reason, /deployable capital budget/);
}

async function run() {
  await testDemoTradingConfigUsesDemoOnlyEndpoints();
  await testLiveValidationConfigGuards();
  await testLiveValidationStartupChecksProceedWithoutOrders();
  await testLiveValidationInstrumentRuleFailureBlocksExposure();
  await testClientContracts();
  await testSignedRestHeaders();
  await testBybitNotModifiedIsInformational();
  await testBybitRateLimitCooldownLogged();
  await testUnifiedWalletParsing();
  await testWebSocketTickerAndReconnect();
  await testApiAutoRecoveryDoesNotShutdown();
  await testNotModifiedDoesNotTriggerRecovery();
  await testDuplicateTradingStopUpdateSkipped();
  await testCentralizedBybitErrorClassification();
  await testExecutionLedgerAggregatesAndDeduplicatesFills();
  await testNetEdgeGateApprovesOnlyPostCostOpportunities();
  await testPortfolioRiskBlocksOnlyCriticalExecutionState();
  await testReconciliation();
  await testLiveEntrySafetyUsesParsedUtaBalance();
  await testMarketRegimeClassification();
  await testFocusedUniverseRestriction();
  await testSurvivabilityScannerScoring();
  await testNextGenerationContinuationScoring();
  await testV11ActiveMarketEngine();
  await testV11ActivityReport();
  await testActiveAdaptiveScalperPaperConfigAndSafety();
  await testActiveAdaptiveScalperConfidenceSizingAndDailyLoss();
  await testActiveAdaptiveScalperTradingReport();
  await testParticipationRecoverySoftensOnlyNonSafetyFilters();
  await testProfitControlledRejectionReportAndDiagnostics();
  await testExplorationSignalPath();
  await testExplorationMemoryRelaxation();
  await testFeeAwareStatsAndSymbolCooldown();
  await testFeeAwareEntryAndDynamicSizing();
  await testNearMissSmallTradeUsesExploratoryEdgeAndRisk();
  await testLiveValidationAllocationPromotionAndRiskStates();
  await testLiveValidationSizingExecutionAndReentryControls();
  await testLiveValidationMinimumOrderFeasibility();
  await testProfitControlledConfigGuardsAndSetupScript();
  await testProfitControlledStartupChecksProceedWithoutOrders();
  await testProfitControlledMinimumOrderFeasibilityAndDeferredLeverage();
  await testProfitControlledRiskDegradationAndExecutionRouting();
  await testV7ProfitModePolicyAndQualityScore();
  await testV7FeeKillerAndWinnerAmplifier();
  await testV7ExpectancyReport();
  await testV71TradeFrequencyRecoveryPatch();
  await testV8ProfessionalTrendEngine();
  await testV8ExpectancyOptimizerMemoryAndReports();
  await testV8NearMissStatsAndSystemHealthFile();
  await testV9EdgeMaximizationEngine();
  await testV95AdaptiveEdgeReinforcement();
  await testV10TrendDominanceEngine();
  await testScannerInactivityRecoverySummaryScope();
  await testV12ScannerQualityAvoidsDuplicateBotVetoes();
  await testProfitProtectionReducesExplorationAndRisk();
  await testMomentumContinuationHoldLogic();
  await testAdaptiveEnginePolicyAndConfidence();
  await testAdaptiveDefensiveRecoveryPolicy();
  await testAdaptiveActivityFloorPolicy();
  await testContinuousExecutionIgnoresDailyLossAndTradeCounts();
  await testContinuousExecutionClearsStaleTradeLimitPause();
  await testAggressiveLearningCooldownsAreAdvisory();
  await testForcedMarketSamplingPromotion();
  await testV13SwingMomentumConfigAndBudget();
  await testV13SwingMultiEntryAndDuplicateGuard();
  await testV13SwingAdoptsExchangePositionWithoutOrders();
  await testV13SwingUsesStopOnlyNativeProtection();
  await testV13SwingBlocksEarlyTakeProfitExit();
  await testV13SwingHardStopStillExitsImmediately();
  await testV14TrendPortfolioConfigAndLaunchPath();
  await testV14TrendPortfolioEngineBuildsIndependentThesis();
  await testV14TrendUsesStopOnlyNativeProtection();
  await testV14TrendAdoptsExchangePositionWithoutOrders();
  await testV14TrendBlocksEarlyTakeProfitExit();
  await testV14TrendPyramidingDuplicateAndBudgetGuards();
  console.log("Bybit client and bot tests passed: REST signing, centralized 34040 no-change handling, duplicate TP/SL skip, execution ledger fill dedupe, net edge gate, portfolio risk-at-stop checks, UTA balance parsing, live safety balance use, native protection payloads, WebSocket reconnect, API auto-recovery without shutdown, reconciliation, hedge exposure detection, native TP events, regime intelligence, V11 active market universe restriction, survivability scoring, next-generation continuation scoring, V11 mean reversion and activity reporting, active adaptive paper scalper mode, exploration path, exploration memory relaxation, fee-aware stats, advisory symbol cooldowns, adaptive learning, continuation market memory, cautious active recovery, activity floor, daily shutdown removal, forced market sampling, profit protection sizing, fee-aware entries, dynamic sizing, live-validation guards, allocation ladder, risk degradation, promotion checks, execution-cost logging, V6 profit-controlled config guards, setup preservation, deferred leverage mutation, exchange-minimum feasibility, risk degradation, maker/taker routing, V7 profit mode, quality score gate, fee killer, symbol memory V2/V3, expectancy report, winner amplifier continuation holds, V7.1 trade frequency recovery tuning, V8 professional trend/expectancy optimization, V9 edge maximization, V9.5 adaptive edge reinforcement, V10 aggressive adaptive trend dominance, and V11 active market engine.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
