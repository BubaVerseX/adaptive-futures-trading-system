"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");

const { BybitClient, intervalForApi, normalizedOrderStatus, parseUnifiedUsdtBalance, queryString } = require("../src/bybitClient");
const { LadderBot } = require("../src/bot");
const { loadConfig } = require("../src/config");
const { Scanner } = require("../src/scanner");
const { AdaptiveEngine } = require("../src/adaptiveEngine");
const { marketProfileFromBenchmarks, sessionProfile } = require("../src/marketRegime");

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
  assert.match(weakSmartEdge.reason, /smart edge/i);

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
  });
  assert.ok(good.scoreAdjustment > 0);
  assert.ok(good.confidence > 50);
  assert.ok(good.reasons.some((reason) => reason.includes("adaptive regime confidence") || reason.includes("strong trending")));

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
  await testClientContracts();
  await testSignedRestHeaders();
  await testUnifiedWalletParsing();
  await testWebSocketTickerAndReconnect();
  await testApiAutoRecoveryDoesNotShutdown();
  await testReconciliation();
  await testLiveEntrySafetyUsesParsedUtaBalance();
  await testMarketRegimeClassification();
  await testFocusedUniverseRestriction();
  await testSurvivabilityScannerScoring();
  await testExplorationSignalPath();
  await testExplorationMemoryRelaxation();
  await testFeeAwareStatsAndSymbolCooldown();
  await testFeeAwareEntryAndDynamicSizing();
  await testProfitProtectionReducesExplorationAndRisk();
  await testMomentumContinuationHoldLogic();
  await testAdaptiveEnginePolicyAndConfidence();
  await testAdaptiveDefensiveRecoveryPolicy();
  await testAdaptiveActivityFloorPolicy();
  await testContinuousExecutionIgnoresDailyLossAndTradeCounts();
  await testContinuousExecutionClearsStaleTradeLimitPause();
  await testAggressiveLearningCooldownsAreAdvisory();
  await testForcedMarketSamplingPromotion();
  console.log("Bybit client and bot tests passed: REST signing, UTA balance parsing, live safety balance use, native protection payloads, WebSocket reconnect, API auto-recovery without shutdown, reconciliation, hedge exposure detection, native TP events, regime intelligence, focused BTC/ETH/SOL universe restriction, survivability scoring, exploration path, exploration memory relaxation, fee-aware stats, advisory symbol cooldowns, adaptive learning, cautious active recovery, activity floor, daily shutdown removal, forced market sampling, profit protection sizing, fee-aware entries, dynamic sizing, and continuation holds.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
