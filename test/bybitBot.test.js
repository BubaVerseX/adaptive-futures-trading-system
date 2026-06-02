"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const packageJson = require("../package.json");

const { BybitClient, intervalForApi, normalizedOrderStatus, parseUnifiedUsdtBalance, queryString } = require("../src/bybitClient");
const { LadderBot } = require("../src/bot");
const { loadConfig } = require("../src/config");
const { Scanner } = require("../src/scanner");
const { AdaptiveEngine } = require("../src/adaptiveEngine");
const { marketProfileFromBenchmarks, sessionProfile } = require("../src/marketRegime");
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

function config(overrides = {}) {
  const id = Math.random();
  return {
    ...loadConfig(),
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
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const key of Object.keys(overrides)) {
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
    getSymbols: async () => [instrument("BTCUSDT"), instrument("ETHUSDT"), instrument("SOLUSDT")],
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

  await client.setTradingStop({
    symbol: "BTCUSDT",
    positionIdx: 0,
    takeProfit: "101",
    stopLoss: "99",
    trailingStop: "0.5",
    activePrice: "100.5",
  });
  assert.equal(calls[1].endpoint, "/v5/position/trading-stop");
  assert.equal(calls[1].body.trailingStop, "0.5");
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
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "WIFUSDT"].map((symbol) => ({
    symbol,
    contractType: "LinearPerpetual",
    status: "Trading",
    settleCoin: "USDT",
  }));
  const tickers = new Map(
    ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "WIFUSDT"].map((symbol, index) => [
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
  assert.deepEqual(universe.map((item) => item.info.symbol), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.deepEqual(subscribed, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.ok(events.some((event) => event.message === "Focused trading universe enabled."));
  assert.ok(events.some((event) => event.message === "BTC/ETH/SOL mode active; noisy market universe removed."));
  const prepared = events.find((event) => event.message === "Focused BTC/ETH/SOL universe prepared.");
  assert.equal(prepared.details.rejected.outsideFocus, 2);
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
    { info: { symbol: "LINKUSDT" }, price: 10, volume: 3000000, spreadPct: 0.04 },
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
  assert.equal(bot.forcedSamplingEligible({ ...promoted[0], symbol: "DOGEUSDT" }), false);
}

async function run() {
  await testDemoTradingConfigUsesDemoOnlyEndpoints();
  await testLiveValidationConfigGuards();
  await testLiveValidationStartupChecksProceedWithoutOrders();
  await testLiveValidationInstrumentRuleFailureBlocksExposure();
  await testClientContracts();
  await testSignedRestHeaders();
  await testBybitNotModifiedIsInformational();
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
  await testExplorationSignalPath();
  await testExplorationMemoryRelaxation();
  await testFeeAwareStatsAndSymbolCooldown();
  await testFeeAwareEntryAndDynamicSizing();
  await testLiveValidationAllocationPromotionAndRiskStates();
  await testLiveValidationSizingExecutionAndReentryControls();
  await testLiveValidationMinimumOrderFeasibility();
  await testProfitProtectionReducesExplorationAndRisk();
  await testMomentumContinuationHoldLogic();
  await testAdaptiveEnginePolicyAndConfidence();
  await testAdaptiveDefensiveRecoveryPolicy();
  await testAdaptiveActivityFloorPolicy();
  await testContinuousExecutionIgnoresDailyLossAndTradeCounts();
  await testContinuousExecutionClearsStaleTradeLimitPause();
  await testAggressiveLearningCooldownsAreAdvisory();
  await testForcedMarketSamplingPromotion();
  console.log("Bybit client and bot tests passed: REST signing, centralized 34040 no-change handling, duplicate TP/SL skip, execution ledger fill dedupe, net edge gate, portfolio risk-at-stop checks, UTA balance parsing, live safety balance use, native protection payloads, WebSocket reconnect, API auto-recovery without shutdown, reconciliation, hedge exposure detection, native TP events, regime intelligence, focused BTC/ETH/SOL universe restriction, survivability scoring, next-generation continuation scoring, exploration path, exploration memory relaxation, fee-aware stats, advisory symbol cooldowns, adaptive learning, continuation market memory, cautious active recovery, activity floor, daily shutdown removal, forced market sampling, profit protection sizing, fee-aware entries, dynamic sizing, live-validation guards, allocation ladder, risk degradation, promotion checks, execution-cost logging, and continuation holds.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
