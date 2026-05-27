"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const { BybitClient, intervalForApi, normalizedOrderStatus, parseUnifiedUsdtBalance, queryString } = require("../src/bybitClient");
const { LadderBot } = require("../src/bot");
const { loadConfig } = require("../src/config");
const { Scanner } = require("../src/scanner");
const { AdaptiveEngine } = require("../src/adaptiveEngine");

function config(overrides = {}) {
  const id = Math.random();
  return {
    ...loadConfig(),
    apiKey: "test-key",
    apiSecret: "test-secret",
    apiRequestIntervalMs: 1,
    wsReconnectBaseMs: 1,
    logFile: `/private/tmp/bybit-bot-test-${id}.log`,
    stateFile: `/private/tmp/bybit-bot-state-${id}.json`,
    tradesFile: `/private/tmp/bybit-bot-trades-${id}.json`,
    tradeMemoryFile: `/private/tmp/bybit-bot-memory-${id}.json`,
    analyticsFile: `/private/tmp/bybit-bot-analytics-${id}.json`,
    ...overrides,
  };
}

function logCollector() {
  const events = [];
  return { events, log: (level, message, details = {}) => events.push({ level, message, details }) };
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
    min24hVolumeUsdt: 100000,
    takeProfitPct: 1.5,
    estimatedFeePctPerSide: 0.055,
    minProjectedEdgePct: 0.35,
    minVolumeSpike: 1.35,
    minBurstMomentumPct: 0.08,
    minMomentumPersistenceCandles: 2,
  });
  const scanner = new Scanner(cfg, {}, log);
  scanner.cachedBenchmarkDirections = { BTCUSDT: "UP", ETHUSDT: "UP" };
  const item = { info: { symbol: "SOLUSDT" }, price: 100, volume: 2000000, spreadPct: 0.04 };
  const strong = scanner.scoreDirection("LONG", item, scannerAnalysis(), scannerAnalysis(), scannerAnalysis(), "UP", []);
  assert.equal(strong.eligible, true);
  assert.ok(strong.scoreBreakdown.some((reason) => reason.includes("BTC trend alignment")));
  assert.ok(strong.scoreBreakdown.some((reason) => reason.includes("projected edge clears fees/spread")));

  scanner.cachedBenchmarkDirections = { BTCUSDT: "CHOPPY", ETHUSDT: "CHOPPY" };
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
    "CHOPPY",
    []
  );
  assert.equal(weak.eligible, false);
  assert.ok(weak.rejected.some((reason) => reason.includes("volume confirmation")));
  assert.ok(weak.rejected.some((reason) => reason.includes("momentum did not persist")));
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
    volatilityRegime: "NORMAL",
    volumeConditions: "CONFIRMED_VOLUME",
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
  assert.equal(defensive.currentPolicy().mode, "DEFENSIVE");
  assert.ok(defensive.currentPolicy().minSignalScore > defensive.config.minSignalScore);
  assert.ok(defensive.currentPolicy().maxLeverage < defensive.config.maxLeverage);

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
    volatilityRegime: "NORMAL",
    volumeCondition: "CONFIRMED_VOLUME",
    btcTrendAligned: true,
  });
  assert.ok(good.scoreAdjustment > 0);
  assert.ok(good.confidence > 50);

  const bad = confident.evaluateSignal({
    symbol: "WIFUSDT",
    side: "SHORT",
    setupType: "FOMO_BREAKOUT",
    btcTrend: "CHOPPY",
    volatilityRegime: "HIGH_VOLATILITY",
    volumeCondition: "LOW_VOLUME",
    btcTrendAligned: false,
  });
  assert.equal(bad.rejected, true);
  assert.ok(bad.scoreAdjustment < 0);
}

async function run() {
  await testClientContracts();
  await testSignedRestHeaders();
  await testUnifiedWalletParsing();
  await testWebSocketTickerAndReconnect();
  await testReconciliation();
  await testLiveEntrySafetyUsesParsedUtaBalance();
  await testSurvivabilityScannerScoring();
  await testFeeAwareStatsAndSymbolCooldown();
  await testAdaptiveEnginePolicyAndConfidence();
  console.log("Bybit client and bot tests passed: REST signing, UTA balance parsing, live safety balance use, native protection payloads, WebSocket reconnect, reconciliation, hedge exposure detection, native TP events, survivability scoring, fee-aware stats, symbol cooldowns, and adaptive learning.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
