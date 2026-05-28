"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { loadConfig } = require("./config");
const { BybitClient, hasExposure } = require("./bybitClient");
const { Scanner } = require("./scanner");
const { RiskManager, roundedPrice } = require("./riskManager");
const { StateStore } = require("./state");
const { Telegram } = require("./telegram");
const { percentChange } = require("./indicators");
const { AdaptiveEngine, sessionType } = require("./adaptiveEngine");

const PENDING_LIVE_ENTRY_STATUSES = new Set([
  "ENTRY_SUBMITTING",
  "ENTRY_SUBMITTED",
  "ENTRY_PENDING_CONFIRMATION",
  "ENTRY_STATUS_UNKNOWN",
]);
const LEGACY_UNKNOWN_ENTRY_PAUSE = "live entry status unknown; verify exchange position manually";

function makeLogger(config) {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
  return (level, message, details = {}) => {
    const event = { time: new Date().toISOString(), level, message, ...details };
    const detailsText = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    console.log(`[${event.time}] [${level}] ${message}${detailsText}`);
    try {
      fs.appendFileSync(config.logFile, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      console.error(`[${event.time}] [WARN] Log file write failed: ${error.message}`);
    }
  };
}

function makeId(label) {
  return `x10-${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function liveExposure(raw) {
  return hasExposure(raw);
}

function pendingLiveEntry(position) {
  return position.mode === "LIVE" && PENDING_LIVE_ENTRY_STATUSES.has(position.status);
}

function entryConfirmationStartedAt(position) {
  const startedAt = Date.parse(position.entryReconciliationStartedAt || position.entrySubmittedAt || position.openedAt || "");
  return Number.isFinite(startedAt) ? startedAt : 0;
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function secondsHeld(position) {
  const openedAt = Date.parse(position.openedAt || "");
  if (!Number.isFinite(openedAt)) return 0;
  return Math.max(0, (Date.now() - openedAt) / 1000);
}

class LadderBot {
  constructor(config) {
    this.config = config;
    this.log = makeLogger(config);
    this.store = new StateStore(config, this.log);
    this.client = new BybitClient(config, this.log);
    this.adaptive = new AdaptiveEngine(config, this.log);
    this.scanner = new Scanner(config, this.client, this.log, this.adaptive);
    this.risk = new RiskManager(config, this.store, this.log, this.adaptive);
    this.telegram = new Telegram(config, this.store, this.log);
    this.timer = null;
    this.monitorTimer = null;
    this.cycleActive = false;
    this.monitorActive = false;
    this.stopping = false;
    this.positionMode = config.bybitPositionMode;
    this.unmanagedLiveExposure = false;
    this.closingPositionIds = new Set();
    this.lastAdaptiveMode = null;
  }

  async start() {
    this.store.load();
    this.adaptive.load();
    this.adaptive.syncFromClosedTrades(this.store.trades);
    process.once("SIGINT", () => void this.shutdown("CTRL+C / SIGINT"));
    process.once("SIGTERM", () => void this.shutdown("SIGTERM"));

    this.log("INFO", "Starting Bybit Unified Futures Aggressive Scalping Bot.", {
      mode: this.config.dryRun ? "DRY_RUN" : "LIVE",
      environment: this.config.bybitTestnet ? "TESTNET" : "MAINNET",
      accountStartUsdt: this.config.accountStartUsdt,
      x10Mode: this.config.x10Mode,
      fastMode: this.config.fastMode,
      fomoBreakoutMode: this.config.fomoBreakoutMode,
      microBreakoutEntries: this.config.microBreakoutEntries,
      allowChoppyMarket: this.config.allowChoppyMarket,
      minSignalScore: this.config.minSignalScore,
      maxLeverage: this.config.maxLeverage,
      setLeverageOnEntry: this.config.setLeverageOnEntry,
      maxOpenPositions: this.config.maxOpenPositions,
      maxTradesPerDay: this.config.maxTradesPerDay,
      takeProfitPct: this.config.takeProfitPct,
      stopLossPct: this.config.stopLossPct,
      estimatedRoundTripFeePct: this.config.estimatedFeePctPerSide * 2,
      minProjectedEdgePct: this.config.minProjectedEdgePct,
      symbolLossCooldownMinutes: this.config.symbolLossCooldownMinutes,
      symbolReentryCooldownSeconds: this.config.symbolReentryCooldownSeconds,
      adaptiveLearningEnabled: this.config.adaptiveLearningEnabled,
      adaptiveMode: this.adaptive.currentPolicy().mode,
      adaptiveMinSignalScore: this.adaptive.currentPolicy().minSignalScore,
      scanIntervalMs: this.config.scanIntervalMs,
      scanConcurrency: this.config.scanConcurrency,
      maxPositionNotionalUsdt: this.config.maxPositionNotionalUsdt,
      positionMonitorIntervalMs: this.config.positionMonitorIntervalMs,
      entryConfirmationTimeoutMs: this.config.entryConfirmationTimeoutMs,
      positionMode: this.config.bybitPositionMode,
      emergencyStopFile: path.basename(this.config.emergencyStopFile),
    });
    this.log("WARN", "This strategy attempts aggressive growth but cannot guarantee profit.", {
      stopLossPct: this.config.stopLossPct,
      maxDailyLossPct: this.config.maxDailyLossPct,
    });

    if (this.emergencyStopRequested()) {
      await this.shutdown(`emergency stop file detected: ${path.basename(this.config.emergencyStopFile)}`);
      return;
    }

    if (this.config.dryRun) {
      this.log("INFO", "DRY_RUN=true: orders and exits are simulations only.");
    } else {
      await this.initializeLiveSafety();
    }
    this.client.on("order", (order) => void this.handleOrderUpdate(order).catch((error) => this.log("ERROR", "Order event handling failed.", { error: error.message })));
    this.client.on("execution", (execution) => void this.handleExecutionUpdate(execution).catch((error) => this.log("ERROR", "Execution event handling failed.", { error: error.message })));
    this.client.on("position", (position) => void this.handlePositionUpdate(position).catch((error) => this.log("ERROR", "Position event handling failed.", { error: error.message })));
    this.client.startWebSockets({ privateStream: !this.config.dryRun });

    await this.telegram.send(
      `Bybit Aggressive Scalping Bot started in ${this.config.dryRun ? "DRY RUN" : this.config.bybitTestnet ? "TESTNET LIVE" : "MAINNET LIVE"} mode. Profit is not guaranteed.`
    );
    this.telegram.start((command) => this.handleTelegramCommand(command));
    this.schedulePositionMonitor();
    await this.runCycle();
  }

  async initializeLiveSafety() {
    await this.client.getUsdtBalance();
    if (this.config.ensurePositionMode) {
      await this.client.switchPositionMode();
      this.log("WARN", "Requested configured Bybit position mode for USDT linear symbols.", {
        positionMode: this.positionMode,
      });
    }
    const positions = (await this.client.getPositions()).filter(liveExposure);
    for (const position of positions) {
      if (Number(position.leverage) > this.config.maxLeverage) {
        throw new Error(`Live startup refused: ${position.symbol} reports leverage above MAX_LEVERAGE.`);
      }
    }
    await this.reconcileLivePositions();
    this.log("WARN", "Bybit live trading enabled after safety checks; entries include native TP/SL orders.", {
      positionMode: this.positionMode,
      maxLeverage: this.config.maxLeverage,
    });
  }

  emergencyStopRequested() {
    return fs.existsSync(this.config.emergencyStopFile);
  }

  async measureEquity() {
    if (this.config.dryRun) return this.risk.markToMarketEquity(this.store.state.lastPrices);
    return (await this.client.getUsdtBalance()).equity;
  }

  async runCycle() {
    if (this.stopping || this.cycleActive) return;
    this.cycleActive = true;
    try {
      if (this.emergencyStopRequested()) {
        await this.shutdown(`emergency stop file detected: ${path.basename(this.config.emergencyStopFile)}`);
        return;
      }
      if (!this.config.dryRun) await this.reconcileLivePositions();
      const beforeEquity = await this.measureEquity();
      const level = this.risk.updateEquity(beforeEquity);
      const adaptivePolicy = this.adaptive.currentPolicy();
      if (this.lastAdaptiveMode && this.lastAdaptiveMode !== adaptivePolicy.mode) {
        this.log("INFO", "Adaptive mode changed.", {
          from: this.lastAdaptiveMode,
          to: adaptivePolicy.mode,
          recoveryWinRatePct: adaptivePolicy.recoveryWinRatePct,
          recoveryPnlUsdt: adaptivePolicy.recoveryPnlUsdt,
          explorationEnabled: adaptivePolicy.explorationEnabled,
        });
        if (adaptivePolicy.mode === "DEFENSIVE_RECOVERY") {
          this.log("INFO", "Defensive recovery activated; penalties are decaying while reduced-risk learning continues.", adaptivePolicy);
        }
        if (adaptivePolicy.mode === "CONTROLLED_AGGRESSIVE") {
          this.log("INFO", "Adaptive aggression increased after improved recent performance.", adaptivePolicy);
        }
      }
      this.lastAdaptiveMode = adaptivePolicy.mode;
      this.log("INFO", "Cycle risk status.", {
        equityUsdt: beforeEquity.toFixed(4),
        ladderLevel: level.level,
        targetUsdt: level.target,
        dailyTrades: this.store.state.daily.tradesOpened,
        dailyLosingTrades: this.store.state.daily.losingTrades,
        openPositions: this.store.state.openPositions.length,
        adaptiveMode: adaptivePolicy.mode,
        adaptiveMinSignalScore: adaptivePolicy.minSignalScore,
        adaptiveMaxLeverage: adaptivePolicy.maxLeverage,
        adaptiveMaxOpenPositions: adaptivePolicy.maxOpenPositions,
        adaptiveMaxTradesPerDay: adaptivePolicy.maxTradesPerDay,
        adaptiveRiskMultiplier: adaptivePolicy.riskMultiplier,
        explorationEnabled: adaptivePolicy.explorationEnabled,
        explorationBudget: adaptivePolicy.explorationBudget,
        dailyExplorationTrades: this.store.state.daily.explorationTrades || 0,
        winRatePct: this.store.state.performance.winRatePct,
        realizedPnlUsdt: this.store.state.performance.realizedPnlUsdt,
        feesUsdt: this.store.state.performance.totalFeesUsdt,
      });

      const regime = await this.scanner.regimeForMarket();
      await this.managePositions(regime);
      const equity = await this.measureEquity();
      this.risk.updateEquity(equity);
      const lock = this.risk.dailyLock(equity);

      if (lock.locked) {
        this.store.state.paused = true;
        this.store.state.pauseReason = lock.reason;
        this.store.saveState();
        this.log("WARN", "New entries halted by daily protection.", { reason: lock.reason, dailyPnlPct: lock.pnlPct.toFixed(3) });
        if (lock.closePositions) await this.closeAllManagedPositions(lock.reason, true);
        if (lock.stopBot) {
          await this.shutdown(lock.reason, { forceClose: true });
          return;
        }
      }

      const scan = await this.scanner.scan(regime);
      this.store.state.consecutiveApiErrors = 0;
      this.store.saveState();
      if (scan.hadApiErrors && !(this.config.fastMode && this.config.allowPartialScanEntries && scan.candidates.length)) {
        this.log("WARN", "New entries skipped because at least one scanned symbol had an API data failure.");
        return;
      }
      if (scan.hadApiErrors) {
        this.log("WARN", "FAST_MODE continuing with fully analyzed candidates despite partial scan failures.", {
          candidates: scan.candidates.length,
        });
      }
      await this.openBestCandidates(scan.candidates, equity);
    } catch (error) {
      this.store.state.consecutiveApiErrors += 1;
      this.store.saveState();
      this.log("ERROR", "Trading cycle failed; no new risk will be added.", {
        error: error.message,
        consecutiveApiErrors: this.store.state.consecutiveApiErrors,
      });
      await this.telegram.send(`Aggressive Scalping Bot error: ${error.message}`);
      if (this.store.state.consecutiveApiErrors >= this.config.maxConsecutiveApiErrors) {
        await this.shutdown("automatic stop after repeated API errors");
        return;
      }
    } finally {
      this.cycleActive = false;
      if (!this.stopping) {
        this.timer = setTimeout(() => void this.runCycle(), this.config.scanIntervalMs);
      }
    }
  }

  schedulePositionMonitor() {
    if (this.stopping) return;
    this.monitorTimer = setTimeout(() => void this.runPositionMonitor(), this.config.positionMonitorIntervalMs);
  }

  async runPositionMonitor() {
    if (this.stopping) return;
    if (this.monitorActive) {
      this.schedulePositionMonitor();
      return;
    }
    this.monitorActive = true;
    try {
      if (this.emergencyStopRequested()) {
        await this.shutdown(`emergency stop file detected: ${path.basename(this.config.emergencyStopFile)}`);
        return;
      }
      if (!this.config.dryRun) await this.reconcileLivePositions();
      await this.managePositions(null, { priceProtectionOnly: true });
      const equity = await this.measureEquity();
      this.risk.updateEquity(equity);
      const lock = this.risk.dailyLock(equity);
      if (lock.locked && lock.closePositions) {
        this.store.state.paused = true;
        this.store.state.pauseReason = lock.reason;
        await this.closeAllManagedPositions(lock.reason, true);
      }
      if (lock.stopBot) await this.shutdown(lock.reason, { forceClose: true });
    } catch (error) {
      this.log("ERROR", "Fast position-protection monitor failed.", { error: error.message });
      await this.telegram.send(`Position monitor error: ${error.message}`);
    } finally {
      this.monitorActive = false;
      this.schedulePositionMonitor();
    }
  }

  async openBestCandidates(candidates, equity) {
    const adaptivePolicy = this.adaptive.currentPolicy();
    const maxOpenPositions = adaptivePolicy.maxOpenPositions || this.config.maxOpenPositions;
    const availableSlots = maxOpenPositions - this.store.state.openPositions.length;
    if (availableSlots <= 0) {
      this.log("INFO", "Entry skipped: maximum open positions already reached.", {
        maxOpenPositions,
        adaptiveMode: adaptivePolicy.mode,
      });
      return;
    }
    if (!candidates.length) {
      this.log("INFO", "No setup reached the minimum signal score this cycle.", { requiredScore: this.config.minSignalScore });
      return;
    }

    let opened = 0;
    let explorationOpenedThisCycle = 0;
    for (const signal of candidates) {
      if (opened >= availableSlots || this.stopping) break;
      if (signal.explorationTrade) {
        const dailyExplorationTrades = Number(this.store.state.daily.explorationTrades || 0);
        if (!adaptivePolicy.explorationEnabled || dailyExplorationTrades + explorationOpenedThisCycle >= adaptivePolicy.explorationBudget) {
          this.log("INFO", "Exploration candidate skipped because daily exploration budget is used.", {
            symbol: signal.symbol,
            dailyExplorationTrades,
            explorationOpenedThisCycle,
            explorationBudget: adaptivePolicy.explorationBudget,
          });
          continue;
        }
        this.log("INFO", "Adaptive exploration active for candidate.", {
          symbol: signal.symbol,
          side: signal.side,
          score: signal.score,
          convictionScore: signal.convictionScore,
          explorationMinScore: adaptivePolicy.explorationMinSignalScore,
          explorationMinConviction: adaptivePolicy.explorationMinConvictionScore,
          waivedStrictRejections: signal.explorationWaivedRejections,
        });
      }
      this.log("INFO", "Top-scoring candidate selected for safety evaluation.", {
        symbol: signal.symbol,
        side: signal.side,
        score: signal.score,
        baseScore: signal.baseScore,
        requiredScore: signal.requiredScore,
        setupType: signal.setupType,
        tradeCategory: signal.tradeCategory,
        explorationTrade: signal.explorationTrade,
        regime: signal.regime,
        volatilityRegime: signal.volatilityRegime,
        volumeCondition: signal.volumeCondition,
        fastMode: signal.fastMode,
        fomoTrigger: signal.fomoTrigger,
        microBreakoutTriggered: signal.microBreakoutTriggered,
        breakoutTriggered: signal.breakoutTriggered,
        adaptiveConfidence: signal.adaptiveConfidence,
        adaptiveScoreAdjustment: signal.adaptiveScoreAdjustment,
        adaptivePolicyMode: signal.adaptivePolicyMode,
        adaptiveReasons: signal.adaptiveReasons,
        scoreBreakdown: signal.scoreBreakdown,
        rsi: signal.rsi.toFixed(2),
        volumeSpike: signal.volumeSpike.toFixed(2),
        momentum1mPct: signal.momentum1mPct.toFixed(3),
        momentum5mPct: signal.momentum5mPct.toFixed(3),
        momentumPersistenceCandles: signal.momentumPersistenceCandles,
        atrPct: signal.atrPct.toFixed(3),
        projectedNetEdgePct: signal.projectedNetEdgePct.toFixed(3),
        estimatedRoundTripFeePct: signal.roundTripFeePct.toFixed(3),
        btcTrend: signal.btcTrend,
        ethTrend: signal.ethTrend,
      });
      await this.telegram.send(`Candidate selected: ${signal.symbol} ${signal.side}, score ${signal.score}.`);
      const block = this.risk.entryBlockReason(equity, signal.symbol);
      if (block) {
        this.log("INFO", "Candidate entry rejected by portfolio safety rule.", { symbol: signal.symbol, reason: block });
        continue;
      }
      const edgeCheck = this.feeAwareEntryCheck(signal);
      if (edgeCheck.rejected) {
        this.log("INFO", "Candidate rejected due to fee inefficiency or low conviction.", {
          symbol: signal.symbol,
          reason: edgeCheck.reason,
          expectedMovePct: signal.expectedMovePct,
          estimatedRoundTripCostPct: signal.estimatedRoundTripCostPct,
          feeEdgeRatio: signal.feeEdgeRatio,
          projectedNetEdgePct: signal.projectedNetEdgePct,
          convictionScore: signal.convictionScore,
        });
        continue;
      }
      const requestedLeverage = this.adaptiveLeverageForSignal(signal, adaptivePolicy);
      const liveSafety = this.config.dryRun ? { leverage: requestedLeverage } : await this.liveEntrySafety(signal, equity, requestedLeverage);
      if (liveSafety.rejected) {
        this.log("WARN", "Candidate rejected by live order safety check.", { symbol: signal.symbol, reason: liveSafety.reason });
        continue;
      }
      const allocatedEquity =
        this.config.dryRun ? equity : Math.min(equity, liveSafety.availableBalanceUsdt);
      const plan = this.risk.sizingPlan(signal, allocatedEquity, signal.info, liveSafety.leverage);
      if (plan.rejected) {
        this.log("INFO", "Candidate rejected because risk-sized quantity is invalid.", {
          symbol: signal.symbol,
          reason: plan.reason,
        });
        continue;
      }
      if (
        this.reservedMarginUsdt() + plan.notional / plan.leverage >
        allocatedEquity * (this.config.maxTotalMarginUsagePct / 100)
      ) {
        this.log("INFO", "Candidate rejected by aggregate margin allocation cap.", { symbol: signal.symbol });
        continue;
      }
      if (plan.highQualityContinuation && plan.qualitySizeMultiplier > 1) {
        this.log("INFO", "Adaptive size increase applied for high-conviction setup.", {
          symbol: signal.symbol,
          convictionScore: signal.convictionScore,
          liquidityScore: signal.liquidityScore,
          feeEdgeRatio: signal.feeEdgeRatio,
          qualitySizeMultiplier: plan.qualitySizeMultiplier,
          adaptiveRiskMultiplier: plan.adaptiveRiskMultiplier,
        });
      }
      if (signal.explorationTrade) {
        this.log("WARN", "EXPLORATION TRADE OPENED", {
          symbol: signal.symbol,
          side: signal.side,
          score: signal.score,
          convictionScore: signal.convictionScore,
          plannedNotionalUsdt: plan.notional,
          riskPct: plan.riskPct,
          explorationRiskMultiplier: this.config.explorationRiskMultiplier,
          waivedStrictRejections: signal.explorationWaivedRejections,
        });
      }
      this.log("WARN", "ENTRY SIGNAL", {
        symbol: signal.symbol,
        side: signal.side,
        score: signal.score,
        baseScore: signal.baseScore,
        adaptiveConfidence: signal.adaptiveConfidence,
        adaptivePolicyMode: signal.adaptivePolicyMode,
        setupType: signal.setupType,
        tradeCategory: signal.tradeCategory,
        explorationTrade: signal.explorationTrade,
        trigger: signal.fomoTrigger ? "FOMO_1M_MOMENTUM" : "SCORE_THRESHOLD",
        leverage: plan.leverage,
        plannedNotionalUsdt: plan.notional,
        riskPct: plan.riskPct,
        qualitySizeMultiplier: plan.qualitySizeMultiplier,
        adaptiveRiskMultiplier: plan.adaptiveRiskMultiplier,
        entryPrice: signal.price,
        stopLossPrice: plan.stopLossPrice,
        takeProfitPrice: plan.takeProfitPrice,
        projectedNetEdgePct: signal.projectedNetEdgePct,
        expectedMovePct: signal.expectedMovePct,
        estimatedRoundTripCostPct: signal.estimatedRoundTripCostPct,
        feeEdgeRatio: signal.feeEdgeRatio,
        convictionScore: signal.convictionScore,
        estimatedRoundTripFeePct: signal.roundTripFeePct,
        momentumPersistenceCandles: signal.momentumPersistenceCandles,
        volatilityRegime: signal.volatilityRegime,
        volumeCondition: signal.volumeCondition,
        adaptiveReasons: signal.adaptiveReasons,
        scoreBreakdown: signal.scoreBreakdown,
      });
      await this.openPosition(signal, plan);
      opened += 1;
      if (signal.explorationTrade) explorationOpenedThisCycle += 1;
    }
  }

  reservedMarginUsdt() {
    return this.store.state.openPositions.reduce(
      (total, position) => total + Number(position.notional || Number(position.size) * position.entryPrice) / Number(position.leverage || 1),
      0
    );
  }

  feeAwareEntryCheck(signal) {
    const minProjectedEdgePct = signal.explorationTrade ? this.config.explorationMinProjectedEdgePct : this.config.minProjectedEdgePct;
    const minEdgeToCostRatio = signal.explorationTrade ? this.config.explorationMinEdgeToCostRatio : this.config.minEdgeToCostRatio;
    const minConvictionScore = signal.explorationTrade ? this.config.explorationMinConvictionScore : this.config.minConvictionScore;
    if (Number(signal.projectedNetEdgePct) < this.config.minProjectedEdgePct) {
      if (!signal.explorationTrade || Number(signal.projectedNetEdgePct) < minProjectedEdgePct) {
      return { rejected: true, reason: "projected edge after fees, spread, and slippage is too small" };
      }
    }
    if (Number(signal.feeEdgeRatio) < minEdgeToCostRatio) {
      return { rejected: true, reason: "expected move is too small relative to transaction costs" };
    }
    if (Number(signal.convictionScore) < minConvictionScore) {
      return { rejected: true, reason: "conviction score below threshold" };
    }
    return { rejected: false };
  }

  adaptiveLeverageForSignal(signal, policy = this.adaptive.currentPolicy()) {
    const volatilityCap =
      signal.volatilityRegime === "NEWS_LIKE_ABNORMAL"
        ? Math.max(1, Math.floor(this.config.maxLeverage * 0.45))
        : signal.volatilityRegime === "HIGH_VOLATILITY"
          ? Math.max(1, Math.floor(this.config.maxLeverage * 0.7))
          : this.config.maxLeverage;
    const confidenceAdjusted = Math.max(1, Math.floor((policy.maxLeverage || this.config.maxLeverage) * Number(signal.adaptiveLeverageMultiplier || 1)));
    return Math.max(1, Math.min(this.config.maxLeverage, volatilityCap, confidenceAdjusted));
  }

  async liveEntrySafety(signal, equity, requestedLeverage = this.config.maxLeverage) {
    if (this.unmanagedLiveExposure) return { rejected: true, reason: "unmanaged exchange position exists" };
    const openOrders = await this.client.getOpenOrders(signal.symbol);
    if (openOrders.length) return { rejected: true, reason: "selected symbol has pending exchange orders" };
    let leverageResponse = await this.client.getLeverage(signal.symbol, signal.side);
    let parsedLeverage = leverageResponse.leverage;
    let updateSucceeded = false;
    this.log("INFO", "Raw leverage response received.", {
      symbol: signal.symbol,
      rawLeverageResponse: leverageResponse.rawResponse,
      parsedLeverage,
    });
    if (this.config.setLeverageOnEntry && parsedLeverage !== requestedLeverage) {
      const updateResponse = await this.client.setLeverage(signal.symbol, requestedLeverage);
      updateSucceeded = true;
      this.log("WARN", "Configured leverage update accepted for selected live symbol.", {
        symbol: signal.symbol,
        requestedLeverage,
        rawLeverageUpdateResponse: updateResponse,
      });
      leverageResponse = await this.client.getLeverage(signal.symbol, signal.side);
      parsedLeverage = leverageResponse.leverage;
      this.log("INFO", "Raw leverage response received after update.", {
        symbol: signal.symbol,
        rawLeverageResponse: leverageResponse.rawResponse,
        parsedLeverage,
      });
    }
    if (Number.isFinite(parsedLeverage) && parsedLeverage > this.config.maxLeverage) {
      return { rejected: true, reason: `selected leverage ${parsedLeverage} exceeds MAX_LEVERAGE` };
    }
    const leverage = Number.isFinite(parsedLeverage) ? Math.min(parsedLeverage, requestedLeverage) : requestedLeverage;
    this.log("INFO", "Leverage verification success.", {
      symbol: signal.symbol,
      parsedLeverage,
      leverageUsedForOrder: leverage,
      requestedLeverage,
      verificationSource: Number.isFinite(parsedLeverage)
          ? "GET /v5/position/list"
        : updateSucceeded
          ? "successful leverage update; empty readback accepted"
          : "readback unavailable; configured maximum used for liquidation protection",
    });
    const approximateLiquidationDistancePct = 100 / leverage;
    if (approximateLiquidationDistancePct - this.config.stopLossPct < this.config.minLiquidationBufferPct) {
      return { rejected: true, reason: "stop-loss distance is too close to estimated liquidation distance" };
    }
    const balance = await this.client.getUsdtBalance();
    this.log("INFO", "Live order safety balance check.", {
      symbol: signal.symbol,
      availableBalanceUsdt: balance.available,
      totalEquityUsdt: balance.equity,
      transferableUsableMarginUsdt: balance.transferableUsableMargin,
      balanceParseSource: balance.parseSource,
      equityParseSource: balance.equitySource,
    });
    if (balance.available <= 0 || equity <= 0) return { rejected: true, reason: "no available USDT balance" };
    return { rejected: false, leverage, availableBalanceUsdt: balance.available };
  }

  async openPosition(signal, plan) {
    const position = {
      id: makeId("trade"),
      mode: this.config.dryRun ? "DRY_RUN" : "LIVE",
      status: this.config.dryRun ? "OPEN" : "ENTRY_SUBMITTING",
      symbol: signal.symbol,
      side: signal.side,
      size: plan.size,
      notional: plan.notional,
      leverage: plan.leverage,
      entryPrice: signal.price,
      stopLossPrice: plan.stopLossPrice,
      takeProfitPrice: plan.takeProfitPrice,
      peakPrice: signal.price,
      trailingStopPrice: null,
      openedAt: new Date().toISOString(),
      plannedEntryPrice: signal.price,
      ladderLevel: plan.ladderLevel,
      signalScore: signal.score,
      baseSignalScore: signal.baseScore,
      signalRegime: signal.regime,
      setupType: signal.setupType,
      tradeCategory: signal.tradeCategory,
      explorationTrade: signal.explorationTrade,
      explorationWaivedRejections: signal.explorationWaivedRejections,
      btcMarketRegime: signal.btcTrend,
      ethMarketRegime: signal.ethTrend,
      volatilityRegime: signal.volatilityRegime,
      volumeCondition: signal.volumeCondition,
      entryMomentumPct: signal.entryMomentumPct,
      spreadPct: signal.spreadPct,
      projectedNetEdgePct: signal.projectedNetEdgePct,
      expectedMovePct: signal.expectedMovePct,
      estimatedRoundTripCostPct: signal.estimatedRoundTripCostPct,
      feeEdgeRatio: signal.feeEdgeRatio,
      roundTripFeePct: signal.roundTripFeePct,
      convictionScore: signal.convictionScore,
      technicalConvictionScore: signal.technicalConvictionScore,
      liquidityScore: signal.liquidityScore,
      trendQualityScore: signal.trendQualityScore,
      antiChopScore: signal.antiChopScore,
      breakoutTriggered: signal.breakoutTriggered,
      microBreakoutTriggered: signal.microBreakoutTriggered,
      fastMode: signal.fastMode,
      fomoTrigger: signal.fomoTrigger,
      fomoTriggered: signal.fomoTrigger,
      sessionType: sessionType(),
      adaptiveConfidence: signal.adaptiveConfidence,
      adaptiveScoreAdjustment: signal.adaptiveScoreAdjustment,
      adaptiveRiskMultiplier: signal.adaptiveRiskMultiplier,
      adaptiveLeverageMultiplier: signal.adaptiveLeverageMultiplier,
      adaptiveMode: signal.adaptivePolicyMode,
      adaptiveReasons: signal.adaptiveReasons,
      entryReason: signal.scoreBreakdown,
      positionIdx: this.client.positionIdx(signal.side),
      nativeProtection: this.config.dryRun ? "SIMULATED" : "SUBMITTED_WITH_ENTRY",
      tickSize: signal.info.priceFilter && signal.info.priceFilter.tickSize,
      entryFeesUsdt: 0,
      exitFeesUsdt: 0,
    };
    if (!this.config.dryRun) {
      position.entrySubmittedAt = new Date().toISOString();
      position.entryReconciliationStartedAt = position.entrySubmittedAt;
      position.entryReconciliationLogged = false;
    }
    const trade = {
      ...position,
      riskPct: plan.riskPct,
      baseRiskPct: plan.baseRiskPct,
      adaptiveRiskMultiplier: plan.adaptiveRiskMultiplier,
      riskUsdt: plan.riskUsdt,
      aggressiveSizing: plan.aggressive,
      reasons: signal.reasons,
    };

    // Persist the hard monitored stop before a live entry can be submitted.
    this.store.state.openPositions.push(position);
    this.store.trades.push(trade);
    this.store.saveAll();
    try {
      if (!this.config.dryRun) {
        this.log("INFO", "Entry reconciliation started.", {
          symbol: position.symbol,
          side: position.side,
          timeoutMs: this.config.entryConfirmationTimeoutMs,
        });
        position.entryReconciliationLogged = true;
        this.store.saveState();
        const result = await this.client.placeMarketOrder({
          orderLinkId: position.id,
          symbol: position.symbol,
          side: position.side === "LONG" ? "Buy" : "Sell",
          qty: position.size,
          positionIdx: position.positionIdx,
          reduceOnly: false,
          takeProfit: String(position.takeProfitPrice),
          stopLoss: String(position.stopLossPrice),
        });
        position.status = "ENTRY_PENDING_CONFIRMATION";
        trade.status = "ENTRY_PENDING_CONFIRMATION";
        position.entryOrderId = result.orderId;
        position.entryOrderLinkId = result.orderLinkId || position.id;
        position.entryOrderStatus = "NEW";
        trade.entryOrderId = result.orderId;
        trade.entryOrderLinkId = position.entryOrderLinkId;
        trade.entryOrderStatus = "NEW";
        this.log("WARN", "ORDER SENT", {
          operation: "ENTRY",
          symbol: position.symbol,
          side: position.side,
          orderId: position.entryOrderId,
          positionIdx: position.positionIdx,
          nativeTakeProfit: position.takeProfitPrice,
          nativeStopLoss: position.stopLossPrice,
        });
        this.store.saveAll();
        await this.reconcileLivePositions();
      } else {
        this.risk.registerOpen(Boolean(position.explorationTrade));
      }
      this.store.saveAll();
      this.log(this.config.dryRun ? "INFO" : "WARN", `${position.mode} ${position.side} position opened/submitted for reconciliation.`, {
        symbol: position.symbol,
        status: position.status,
        score: signal.score,
        entryReason: signal.scoreBreakdown,
        regime: signal.regime,
        fastMode: signal.fastMode,
        fomoTrigger: signal.fomoTrigger,
        size: position.size,
        plannedNotionalUsdt: position.notional,
        entryPrice: position.entryPrice,
        stopLossPrice: position.stopLossPrice,
        takeProfitPrice: position.takeProfitPrice,
        leverage: position.leverage,
        adaptiveConfidence: position.adaptiveConfidence,
        adaptiveMode: position.adaptiveMode,
        adaptiveRiskMultiplier: plan.adaptiveRiskMultiplier,
        ladderLevel: position.ladderLevel,
      });
      await this.telegram.send(
        `${position.mode} ${position.side} ${position.symbol} entry submitted at ${position.entryPrice}. Native stop ${position.stopLossPrice.toFixed(8)}, native TP ${position.takeProfitPrice.toFixed(8)}.`
      );
    } catch (error) {
      if (this.config.dryRun) {
        position.status = "ENTRY_FAILED";
        trade.status = "ENTRY_FAILED";
        this.store.state.openPositions = this.store.state.openPositions.filter((item) => item.id !== position.id);
      } else {
        position.status = "ENTRY_PENDING_CONFIRMATION";
        trade.status = "ENTRY_PENDING_CONFIRMATION";
        position.entrySubmitError = error.message;
        trade.entrySubmitError = error.message;
        this.log("WARN", "Live entry response was not confirmed; position reconciliation remains active until timeout.", {
          symbol: position.symbol,
          timeoutMs: this.config.entryConfirmationTimeoutMs,
          error: error.message,
        });
        await this.telegram.send(
          `Live entry response uncertain for ${position.symbol}. Rechecking exchange exposure for ${this.config.entryConfirmationTimeoutMs / 1000} seconds.`
        );
      }
      this.store.saveAll();
      throw error;
    }
  }

  async managePositions(regime, options = {}) {
    for (const position of [...this.store.state.openPositions]) {
      if (!this.config.dryRun && position.status !== "OPEN") {
        this.log("WARN", "Live position exit monitoring awaits exchange position confirmation.", {
          symbol: position.symbol,
          status: position.status,
        });
        continue;
      }
      const ticker = await this.client.getTicker(position.symbol);
      const price = Number(ticker && ticker.lastPrice);
      if (!Number.isFinite(price)) {
        this.log("WARN", "Open position skipped: latest price unavailable.", { symbol: position.symbol });
        continue;
      }
      this.store.state.lastPrices[position.symbol] = price;
      const long = position.side === "LONG";
      position.peakPrice = long
        ? Math.max(Number(position.peakPrice), price)
        : Math.min(Number(position.peakPrice), price);
      const favorablePct = long
        ? percentChange(position.peakPrice, position.entryPrice)
        : percentChange(position.entryPrice, position.peakPrice);

      if (this.config.trailingStopEnabled && favorablePct >= this.config.trailingStartPct) {
        const candidateStop = long
          ? position.peakPrice * (1 - this.config.trailingDistancePct / 100)
          : position.peakPrice * (1 + this.config.trailingDistancePct / 100);
        const improves = !position.trailingStopPrice || (long ? candidateStop > position.trailingStopPrice : candidateStop < position.trailingStopPrice);
        if (improves) {
          position.trailingStopPrice = candidateStop;
          if (!this.config.dryRun && !position.nativeTrailingConfigured) {
            const trailingDistance = roundedPrice(
              position.entryPrice * (this.config.trailingDistancePct / 100),
              position.tickSize,
              true
            );
            const activePrice = roundedPrice(
              position.entryPrice * (long ? 1 + this.config.trailingStartPct / 100 : 1 - this.config.trailingStartPct / 100),
              position.tickSize,
              long
            );
            await this.client.setTradingStop({
              symbol: position.symbol,
              positionIdx: position.positionIdx,
              takeProfit: String(position.takeProfitPrice),
              stopLoss: String(position.stopLossPrice),
              trailingStop: String(trailingDistance),
              activePrice: String(activePrice),
            });
            position.nativeTrailingConfigured = true;
            position.nativeTrailingDistance = trailingDistance;
          }
          this.store.saveState();
          this.log("INFO", "Trailing stop moved to protect favorable movement.", {
            symbol: position.symbol,
            side: position.side,
            trailingStopPrice: candidateStop,
            nativeTrailingConfigured: Boolean(position.nativeTrailingConfigured),
          });
          await this.telegram.send(`Trailing stop moved: ${position.symbol} ${position.side} stop ${candidateStop.toFixed(8)}.`);
        }
      }

      const pnlPct = long ? percentChange(price, position.entryPrice) : percentChange(position.entryPrice, price);
      this.log("INFO", "Managed position checked.", {
        symbol: position.symbol,
        side: position.side,
        price,
        pnlPct: pnlPct.toFixed(3),
        stopLossPrice: position.stopLossPrice,
        trailingStopPrice: position.trailingStopPrice,
        ladderLevel: position.ladderLevel,
      });
      if ((long && price <= position.stopLossPrice) || (!long && price >= position.stopLossPrice)) {
        await this.closePosition(position, price, "hard stop loss hit");
        continue;
      }
      if ((long && price >= position.takeProfitPrice) || (!long && price <= position.takeProfitPrice)) {
        await this.closePosition(position, price, "take profit hit");
        continue;
      }
      if (position.trailingStopPrice && ((long && price <= position.trailingStopPrice) || (!long && price >= position.trailingStopPrice))) {
        await this.closePosition(position, price, "trailing stop hit");
        continue;
      }

      if (options.priceProtectionOnly) continue;
      const analysis = await this.scanner.analysisForPosition(position, regime);
      if (!analysis) continue;
      const trendReversed = long ? analysis.trend5m === "DOWN" : analysis.trend5m === "UP";
      const momentumGone = long
        ? analysis.momentum1mPct < 0 && analysis.momentum5mPct < 0
        : analysis.momentum1mPct > 0 && analysis.momentum5mPct > 0;
      const strongContinuation = this.strongMomentumContinuation(position, analysis, pnlPct);
      if (strongContinuation) {
        this.log("INFO", "Strong momentum continuation detected; avoiding premature exit.", {
          symbol: position.symbol,
          side: position.side,
          pnlPct: pnlPct.toFixed(3),
          holdSeconds: secondsHeld(position).toFixed(1),
          continuationScore: analysis.convictionScore,
          volumeCondition: analysis.volumeCondition,
          momentumPersistenceCandles: analysis.momentumPersistenceCandles,
        });
      }
      if (trendReversed && !strongContinuation) {
        await this.closePosition(position, price, "EMA trend reversed");
      } else if (momentumGone) {
        const heldSeconds = secondsHeld(position);
        if (strongContinuation || (heldSeconds < this.config.minHoldSecondsBeforeMomentumExit && pnlPct > -this.config.stopLossPct * 0.5)) {
          this.log("INFO", "Momentum exit delayed to avoid over-fragmented micro-scalping.", {
            symbol: position.symbol,
            holdSeconds: heldSeconds.toFixed(1),
            minHoldSeconds: this.config.minHoldSecondsBeforeMomentumExit,
            pnlPct: pnlPct.toFixed(3),
          });
          continue;
        }
        await this.closePosition(position, price, "momentum disappeared");
      }
    }
    this.store.saveState();
  }

  strongMomentumContinuation(position, analysis, pnlPct) {
    const sameSide = analysis.side === position.side;
    const alignedMomentum = position.side === "LONG"
      ? analysis.momentum1mPct > 0 && analysis.momentum5mPct >= 0
      : analysis.momentum1mPct < 0 && analysis.momentum5mPct <= 0;
    return Boolean(
      sameSide &&
      alignedMomentum &&
      pnlPct >= this.config.continuationMinPnlPct &&
      Number(analysis.convictionScore || 0) >= this.config.continuationMinScore &&
      Number(analysis.momentumPersistenceCandles || 0) >= this.config.minMomentumPersistenceCandles &&
      analysis.volumeCondition !== "LOW_VOLUME" &&
      analysis.volatilityRegime !== "NEWS_LIKE_ABNORMAL"
    );
  }

  async closePosition(position, referencePrice, reason) {
    if (position.status === "CLOSE_SUBMITTED" || this.closingPositionIds.has(position.id)) return;
    this.closingPositionIds.add(position.id);
    try {
      if (this.config.dryRun) {
        if (this.store.state.openPositions.some((item) => item.id === position.id)) {
          this.finalizePosition(position, referencePrice, reason);
        }
        return;
      }
      if (position.status !== "OPEN") {
        this.log("ERROR", "Live close not submitted because exposure is not exchange-confirmed.", {
          symbol: position.symbol,
          status: position.status,
          reason,
        });
        await this.telegram.send(`URGENT: ${position.symbol} close requires manual verification; entry status is ${position.status}.`);
        return;
      }
      const result = await this.client.placeMarketOrder({
        orderLinkId: makeId("close"),
        symbol: position.symbol,
        side: position.side === "LONG" ? "Sell" : "Buy",
        qty: position.size,
        positionIdx: position.positionIdx,
        reduceOnly: true,
      });
      position.status = "CLOSE_SUBMITTED";
      position.closeOrderId = result.orderId;
      position.closeOrderLinkId = result.orderLinkId;
      position.requestedExitPrice = referencePrice;
      position.exitReason = reason;
      this.store.saveState();
      this.log("WARN", "ORDER SENT", {
        operation: "CLOSE",
        symbol: position.symbol,
        side: position.side,
        orderId: result.orderId,
        reduceOnly: true,
        reason,
      });
      await this.telegram.send(`Bybit reduce-only close submitted for ${position.symbol}: ${reason}.`);
    } finally {
      this.closingPositionIds.delete(position.id);
    }
  }

  estimateSideFeeUsdt(notionalUsdt) {
    return Math.max(0, numeric(notionalUsdt) * (this.config.estimatedFeePctPerSide / 100));
  }

  feeBreakdownForClose(position, exitPrice) {
    const size = numeric(position.size);
    const entryNotional = numeric(position.entryPrice) * size;
    const exitNotional = numeric(exitPrice) * size;
    const actualEntryFee = numeric(position.entryFeesUsdt);
    const actualExitFee = numeric(position.exitFeesUsdt);
    const estimatedEntryFee = this.estimateSideFeeUsdt(entryNotional);
    const estimatedExitFee = this.estimateSideFeeUsdt(exitNotional);
    const entryFee = actualEntryFee > 0 ? actualEntryFee : estimatedEntryFee;
    const exitFee = actualExitFee > 0 ? actualExitFee : estimatedExitFee;
    return {
      entryFee,
      exitFee,
      total: entryFee + exitFee,
      actualEntryFee,
      actualExitFee,
      estimatedEntryFee,
      estimatedExitFee,
      source: actualEntryFee > 0 || actualExitFee > 0 ? "ACTUAL_EXECUTION_WITH_ESTIMATED_GAPS" : "ESTIMATED_TAKER_FEES",
    };
  }

  applySymbolCooldown(symbol, pnlUsdt) {
    if (!this.store.state.symbolCooldowns) this.store.state.symbolCooldowns = {};
    const now = Date.now();
    const cooldown = {
      ...(this.store.state.symbolCooldowns[symbol] || {}),
      lastClosedAt: new Date(now).toISOString(),
      lastPnlUsdt: Number(pnlUsdt.toFixed(6)),
    };
    if (this.config.symbolReentryCooldownSeconds > 0) {
      cooldown.reentryUntil = new Date(now + this.config.symbolReentryCooldownSeconds * 1000).toISOString();
    }
    if (pnlUsdt < 0 && this.config.symbolLossCooldownMinutes > 0) {
      cooldown.lossCooldownUntil = new Date(now + this.config.symbolLossCooldownMinutes * 60 * 1000).toISOString();
    } else if (pnlUsdt >= 0) {
      cooldown.lossCooldownUntil = null;
    }
    this.store.state.symbolCooldowns[symbol] = cooldown;
    this.log(pnlUsdt < 0 ? "WARN" : "INFO", "Symbol cooldown updated after close.", {
      symbol,
      pnlUsdt: pnlUsdt.toFixed(6),
      reentryUntil: cooldown.reentryUntil,
      lossCooldownUntil: cooldown.lossCooldownUntil,
    });
  }

  recordExecutionFee(position, execution) {
    const fee = numeric(execution.execFee || execution.fee);
    if (fee <= 0) return;
    const entryMatch =
      (position.entryOrderId && position.entryOrderId === execution.orderId) ||
      (position.entryOrderLinkId && position.entryOrderLinkId === execution.orderLinkId);
    const closeMatch =
      (position.closeOrderId && position.closeOrderId === execution.orderId) ||
      (position.closeOrderLinkId && position.closeOrderLinkId === execution.orderLinkId);
    const executionSide = String(execution.side || "");
    const reducesPosition =
      closeMatch ||
      (position.side === "LONG" && executionSide === "Sell") ||
      (position.side === "SHORT" && executionSide === "Buy");
    const field = entryMatch && !reducesPosition ? "entryFeesUsdt" : "exitFeesUsdt";
    position[field] = numeric(position[field]) + fee;
    position.totalExecutionFeesUsdt = numeric(position.entryFeesUsdt) + numeric(position.exitFeesUsdt);
    const trade = this.store.trades.find((item) => item.id === position.id);
    if (trade) {
      trade[field] = numeric(trade[field]) + fee;
      trade.feesUsdt = numeric(trade.entryFeesUsdt) + numeric(trade.exitFeesUsdt);
    }
    this.log("DEBUG", "Execution fee tracked.", {
      symbol: position.symbol,
      orderId: execution.orderId,
      feeUsdt: fee,
      bucket: field,
      totalExecutionFeesUsdt: position.totalExecutionFeesUsdt,
    });
  }

  finalizePosition(position, exitPrice, reason) {
    const directionChange =
      position.side === "LONG" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
    const grossPnlUsdt = directionChange * Number(position.size);
    const fees = this.feeBreakdownForClose(position, exitPrice);
    const pnlUsdt = grossPnlUsdt - fees.total;
    const pnlPct =
      position.side === "LONG" ? percentChange(exitPrice, position.entryPrice) : percentChange(position.entryPrice, exitPrice);
    const holdSeconds = secondsHeld(position);
    const trade = this.store.trades.find((item) => item.id === position.id);
    let completedTrade = null;
    if (trade) {
      Object.assign(trade, {
        status: "CLOSED",
        exitPrice,
        exitReason: reason,
        exitedAt: new Date().toISOString(),
        holdSeconds: Number(holdSeconds.toFixed(2)),
        grossPnlUsdt: Number(grossPnlUsdt.toFixed(6)),
        feesUsdt: Number(fees.total.toFixed(6)),
        feeSource: fees.source,
        entryFeesUsdt: Number(fees.entryFee.toFixed(6)),
        exitFeesUsdt: Number(fees.exitFee.toFixed(6)),
        estimatedFeesUsdt: Number((fees.estimatedEntryFee + fees.estimatedExitFee).toFixed(6)),
        pnlUsdt: Number(pnlUsdt.toFixed(6)),
        pnlPct: Number(pnlPct.toFixed(4)),
        result: this.closedPositionReason(position, exitPrice).includes("take profit")
          ? "TP"
          : this.closedPositionReason(position, exitPrice).includes("stop loss")
            ? "SL"
            : reason.toLowerCase().includes("trailing")
              ? "TRAILING_STOP"
              : "OTHER_EXIT",
        winLoss: pnlUsdt > 0 ? "WIN" : pnlUsdt < 0 ? "LOSS" : "FLAT",
      });
      completedTrade = trade;
    }
    this.store.state.openPositions = this.store.state.openPositions.filter((item) => item.id !== position.id);
    this.applySymbolCooldown(position.symbol, pnlUsdt);
    this.risk.registerClose(pnlUsdt, fees.total);
    this.store.rebuildPerformance();
    if (completedTrade) this.adaptive.recordClosedTrade(completedTrade);
    this.store.saveAll();
    if (reason.toLowerCase().includes("take profit")) {
      this.log("WARN", "TP HIT", { symbol: position.symbol, side: position.side, exitPrice });
    }
    if (reason.toLowerCase().includes("stop loss")) {
      this.log("WARN", "SL HIT", { symbol: position.symbol, side: position.side, exitPrice });
    }
    this.log("WARN", "POSITION CLOSED", {
      symbol: position.symbol,
      side: position.side,
      reason,
      exitPrice,
      grossPnlUsdt: grossPnlUsdt.toFixed(6),
      feesUsdt: fees.total.toFixed(6),
      pnlUsdt: pnlUsdt.toFixed(6),
      holdSeconds: holdSeconds.toFixed(2),
      feeSource: fees.source,
    });
    this.log(pnlUsdt < 0 ? "WARN" : "INFO", "Managed position closed.", {
      symbol: position.symbol,
      side: position.side,
      reason,
      grossPnlUsdt: grossPnlUsdt.toFixed(6),
      feesUsdt: fees.total.toFixed(6),
      pnlUsdt: pnlUsdt.toFixed(6),
      pnlPct: pnlPct.toFixed(3),
      holdSeconds: holdSeconds.toFixed(2),
    });
    this.log("INFO", "Performance stats updated.", {
      closedTrades: this.store.state.performance.closedTrades,
      winRatePct: this.store.state.performance.winRatePct,
      totalFeesUsdt: this.store.state.performance.totalFeesUsdt,
      averageHoldSeconds: this.store.state.performance.averageHoldSeconds,
      bestSymbol: this.store.state.performance.bestSymbol,
      worstSymbol: this.store.state.performance.worstSymbol,
    });
    void this.telegram.send(`${reason}: ${position.symbol} ${position.side} closed. PnL ${pnlPct.toFixed(3)}% (${pnlUsdt.toFixed(4)} USDT).`);
  }

  async reconcileLivePositions() {
    const exchangePositions = (await this.client.getPositions()).filter(liveExposure);
    this.unmanagedLiveExposure = false;
    const matchedManagedPositions = new Set();
    for (const managed of [...this.store.state.openPositions]) {
      if (!this.store.state.openPositions.some((position) => position.id === managed.id)) continue;
      const exchange = exchangePositions.find(
        (raw) => raw.symbol === managed.symbol && Number(raw.positionIdx) === Number(managed.positionIdx || 0)
      );
      if (!exchange) {
        if (managed.status === "CLOSE_SUBMITTED" || managed.status === "OPEN") {
          const referencePrice = Number(managed.requestedExitPrice || this.store.state.lastPrices[managed.symbol] || managed.entryPrice);
          const reason = managed.exitReason || this.closedPositionReason(managed, referencePrice);
          this.finalizePosition(managed, referencePrice, reason);
          this.log("INFO", "RECONCILIATION SUCCESS", { symbol: managed.symbol, result: "POSITION_CLOSED" });
        } else if (pendingLiveEntry(managed)) {
          if (managed.entryOrderId && !["CANCELLED", "REJECTED"].includes(managed.entryOrderStatus)) {
            const order = await this.client.getOrder(managed.entryOrderId, managed.entryOrderLinkId, managed.symbol);
            if (order) managed.entryOrderStatus = order.normalizedStatus;
          }
          const elapsedMs = Date.now() - entryConfirmationStartedAt(managed);
          if (!managed.entryReconciliationLogged) {
            managed.entryReconciliationLogged = true;
            this.log("INFO", "Entry reconciliation started.", {
              symbol: managed.symbol,
              side: managed.side,
              timeoutMs: this.config.entryConfirmationTimeoutMs,
              recoveredPendingState: managed.status === "ENTRY_STATUS_UNKNOWN",
            });
          }
          if (["CANCELLED", "REJECTED"].includes(managed.entryOrderStatus)) {
            await this.clearPendingLiveEntry(managed, `Bybit entry order became ${managed.entryOrderStatus}`);
          } else if (elapsedMs >= this.config.entryConfirmationTimeoutMs) {
            this.log("WARN", "Entry reconciliation timeout.", {
              symbol: managed.symbol,
              elapsedMs,
              timeoutMs: this.config.entryConfirmationTimeoutMs,
              exchangePositionFound: false,
            });
            await this.clearPendingLiveEntry(managed, "exchange position not confirmed before reconciliation timeout");
          }
        }
        continue;
      }
      const entryPrice = Number(exchange.avgPrice);
      const size = Number(exchange.size);
      const exchangeSide = exchange.side === "Buy" ? "LONG" : exchange.side === "Sell" ? "SHORT" : null;
      if (exchangeSide === managed.side && Number.isFinite(entryPrice) && entryPrice > 0 && size > 0) {
        matchedManagedPositions.add(`${exchange.symbol}:${exchange.positionIdx}`);
        const entryWasPending = pendingLiveEntry(managed);
        const plannedEntryPrice = numeric(managed.plannedEntryPrice, numeric(managed.entryPrice, entryPrice));
        const slippagePct =
          managed.side === "SHORT"
            ? ((plannedEntryPrice - entryPrice) / plannedEntryPrice) * 100
            : ((entryPrice - plannedEntryPrice) / plannedEntryPrice) * 100;
        managed.entryPrice = entryPrice;
        managed.size = String(size);
        managed.slippagePct = Number.isFinite(slippagePct) ? Number(slippagePct.toFixed(4)) : 0;
        managed.positionIdx = Number(exchange.positionIdx);
        managed.leverage = Number(exchange.leverage) || managed.leverage;
        managed.liquidationPrice = Number(exchange.liqPrice) || null;
        managed.stopLossPrice =
          managed.side === "LONG"
            ? roundedPrice(entryPrice * (1 - this.config.stopLossPct / 100), managed.tickSize, false)
            : roundedPrice(entryPrice * (1 + this.config.stopLossPct / 100), managed.tickSize, true);
        managed.takeProfitPrice =
          managed.side === "LONG"
            ? roundedPrice(entryPrice * (1 + this.config.takeProfitPct / 100), managed.tickSize, false)
            : roundedPrice(entryPrice * (1 - this.config.takeProfitPct / 100), managed.tickSize, true);
        managed.status = "OPEN";
        if (entryWasPending) {
          managed.entryConfirmedAt = new Date().toISOString();
          const trade = this.store.trades.find((item) => item.id === managed.id);
          if (trade) {
            trade.status = "OPEN";
            trade.entryConfirmedAt = managed.entryConfirmedAt;
            trade.entryPrice = entryPrice;
            trade.slippagePct = managed.slippagePct;
            trade.size = String(size);
            trade.positionIdx = managed.positionIdx;
          }
          this.risk.registerOpen(Boolean(managed.explorationTrade));
          if (this.store.state.pauseReason === LEGACY_UNKNOWN_ENTRY_PAUSE) {
            this.store.state.paused = false;
            this.store.state.pauseReason = null;
          }
          if (managed.entryOrderId && !["FILLED", "PARTIALLY_FILLED"].includes(managed.entryOrderStatus)) {
            try {
              const entryOrder = await this.client.getOrder(managed.entryOrderId, managed.entryOrderLinkId, managed.symbol);
              if (entryOrder) managed.entryOrderStatus = entryOrder.normalizedStatus;
            } catch (error) {
              this.log("WARN", "Order status read failed after exchange exposure appeared; position protection continues.", {
                symbol: managed.symbol,
                error: error.message,
              });
            }
          }
          if (managed.entryOrderStatus === "FILLED" && !managed.entryFillLogged) {
            managed.entryFillLogged = true;
            if (trade) trade.entryOrderStatus = managed.entryOrderStatus;
            this.log("WARN", "ORDER FILLED", {
              operation: "ENTRY",
              symbol: managed.symbol,
              orderId: managed.entryOrderId,
              confirmationSource: "position reconciliation",
            });
          } else if (managed.entryOrderStatus !== "FILLED") {
            managed.entryOrderStatus = "PARTIALLY_FILLED";
            if (trade) trade.entryOrderStatus = managed.entryOrderStatus;
          }
          await this.ensureNativeProtection(managed);
          this.log("WARN", "POSITION OPENED", {
            symbol: managed.symbol,
            side: managed.side,
            entryPrice,
            size,
            leverage: managed.leverage,
            nativeStopLoss: managed.stopLossPrice,
            nativeTakeProfit: managed.takeProfitPrice,
          });
          this.log("INFO", "RECONCILIATION SUCCESS", { symbol: managed.symbol, result: "POSITION_CONFIRMED" });
          if (this.positionTooCloseToLiquidation(managed)) {
            this.log("ERROR", "Confirmed position violates liquidation-distance safety; closing immediately.", {
              symbol: managed.symbol,
              entryPrice: managed.entryPrice,
              liquidationPrice: managed.liquidationPrice,
            });
            await this.closePosition(managed, entryPrice, "liquidation-distance protection");
          }
        } else if (!managed.nativeProtectionVerified) {
          await this.ensureNativeProtection(managed);
        }
      } else {
        this.unmanagedLiveExposure = true;
        this.log("ERROR", "Exchange exposure does not match the tracked position side; new entries blocked.", {
          symbol: exchange.symbol,
          trackedSide: managed.side,
        });
      }
    }
    for (const exchange of exchangePositions) {
      if (!matchedManagedPositions.has(`${exchange.symbol}:${exchange.positionIdx}`)) {
        this.unmanagedLiveExposure = true;
        this.log("WARN", "Unmanaged live exchange position blocks new entries.", {
          symbol: exchange.symbol,
          positionIdx: exchange.positionIdx,
        });
      }
    }
    this.store.saveAll();
  }

  positionTooCloseToLiquidation(position) {
    const liquidationPrice = Number(position.liquidationPrice);
    const entryPrice = Number(position.entryPrice);
    if (!Number.isFinite(liquidationPrice) || liquidationPrice <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return false;
    }
    const distancePct =
      position.side === "LONG"
        ? ((entryPrice - liquidationPrice) / entryPrice) * 100
        : ((liquidationPrice - entryPrice) / entryPrice) * 100;
    return distancePct - this.config.stopLossPct < this.config.minLiquidationBufferPct;
  }

  async ensureNativeProtection(position) {
    await this.client.setTradingStop({
      symbol: position.symbol,
      positionIdx: position.positionIdx,
      takeProfit: String(position.takeProfitPrice),
      stopLoss: String(position.stopLossPrice),
    });
    position.nativeProtectionVerified = true;
    position.nativeProtection = "BYBIT_NATIVE_TP_SL_VERIFIED";
    this.log("INFO", "Native Bybit TP/SL protection verified.", {
      symbol: position.symbol,
      stopLossPrice: position.stopLossPrice,
      takeProfitPrice: position.takeProfitPrice,
      positionIdx: position.positionIdx,
    });
  }

  closedPositionReason(position, exitPrice) {
    const long = position.side === "LONG";
    if ((long && exitPrice >= position.takeProfitPrice) || (!long && exitPrice <= position.takeProfitPrice)) {
      return "take profit hit (native Bybit exit)";
    }
    if ((long && exitPrice <= position.stopLossPrice) || (!long && exitPrice >= position.stopLossPrice)) {
      return "stop loss hit (native Bybit exit)";
    }
    if (position.trailingStopPrice && ((long && exitPrice <= position.trailingStopPrice) || (!long && exitPrice >= position.trailingStopPrice))) {
      return "trailing stop hit (native Bybit exit)";
    }
    return "exchange position closed";
  }

  async clearPendingLiveEntry(position, reason) {
    const trade = this.store.trades.find((item) => item.id === position.id);
    const failedAt = new Date().toISOString();
    if (trade) {
      trade.status = "ENTRY_FAILED";
      trade.failedAt = failedAt;
      trade.failureReason = reason;
    }
    this.store.state.openPositions = this.store.state.openPositions.filter((item) => item.id !== position.id);
    if (this.store.state.pauseReason === LEGACY_UNKNOWN_ENTRY_PAUSE) {
      this.store.state.paused = false;
      this.store.state.pauseReason = null;
    }
    this.store.saveAll();
    this.log("WARN", "Pending position cleared.", {
      symbol: position.symbol,
      previousStatus: position.status,
      failedStatus: "ENTRY_FAILED",
      reason,
    });
    await this.telegram.send(`Bybit pending entry cleared for ${position.symbol}: no exchange position was confirmed.`);
  }

  async handleOrderUpdate(order) {
    let position = this.store.state.openPositions.find(
      (item) =>
        (item.entryOrderId && item.entryOrderId === order.orderId) ||
        (item.entryOrderLinkId && item.entryOrderLinkId === order.orderLinkId) ||
        (item.closeOrderId && item.closeOrderId === order.orderId) ||
        (item.closeOrderLinkId && item.closeOrderLinkId === order.orderLinkId)
    );
    if (!position && order.normalizedStatus === "FILLED") {
      position = this.store.state.openPositions.find((item) => item.symbol === order.symbol && item.status === "OPEN");
      const nativeOrderType = String(order.stopOrderType || order.createType || "");
      if (position && /take.?profit/i.test(nativeOrderType)) {
        position.exitReason = "take profit hit (native Bybit exit)";
      } else if (position && /stop.?loss/i.test(nativeOrderType)) {
        position.exitReason = "stop loss hit (native Bybit exit)";
      } else if (position && /trailing/i.test(nativeOrderType)) {
        position.exitReason = "trailing stop hit (native Bybit exit)";
      } else {
        position = null;
      }
      if (position) {
        position.requestedExitPrice = Number(order.avgPrice || order.triggerPrice || this.store.state.lastPrices[position.symbol] || position.entryPrice);
        this.store.saveState();
        await this.reconcileLivePositions();
      }
      return;
    }
    if (!position) return;
    if (
      (position.entryOrderId && position.entryOrderId === order.orderId) ||
      (position.entryOrderLinkId && position.entryOrderLinkId === order.orderLinkId)
    ) {
      position.entryOrderStatus = order.normalizedStatus;
      const trade = this.store.trades.find((item) => item.id === position.id);
      if (trade) trade.entryOrderStatus = order.normalizedStatus;
      if (order.normalizedStatus === "FILLED" && !position.entryFillLogged) {
        position.entryFillLogged = true;
        this.log("WARN", "ORDER FILLED", { operation: "ENTRY", symbol: position.symbol, orderId: order.orderId });
      }
      this.store.saveAll();
      if (["FILLED", "CANCELLED", "REJECTED"].includes(order.normalizedStatus)) await this.reconcileLivePositions();
    } else {
      position.closeOrderStatus = order.normalizedStatus;
      this.store.saveState();
      if (order.normalizedStatus === "FILLED") {
        this.log("WARN", "ORDER FILLED", { operation: "CLOSE", symbol: position.symbol, orderId: order.orderId });
        await this.reconcileLivePositions();
      }
    }
  }

  async handleExecutionUpdate(execution) {
    let position = this.store.state.openPositions.find(
      (item) =>
        (item.entryOrderId && item.entryOrderId === execution.orderId) ||
        (item.entryOrderLinkId && item.entryOrderLinkId === execution.orderLinkId) ||
        (item.closeOrderId && item.closeOrderId === execution.orderId) ||
        (item.closeOrderLinkId && item.closeOrderLinkId === execution.orderLinkId)
    );
    if (!position) {
      const executionSide = String(execution.side || "");
      position = this.store.state.openPositions.find(
        (item) =>
          item.symbol === execution.symbol &&
          item.status === "OPEN" &&
          ((item.side === "LONG" && executionSide === "Sell") || (item.side === "SHORT" && executionSide === "Buy"))
      );
    }
    if (!position) return;
    this.recordExecutionFee(position, execution);
    this.store.saveAll();
    this.log("DEBUG", "Bybit execution received.", {
      symbol: execution.symbol,
      orderId: execution.orderId,
      executionPrice: execution.execPrice,
      executionQuantity: execution.execQty,
      executionFee: execution.execFee,
    });
    await this.reconcileLivePositions();
  }

  async handlePositionUpdate(position) {
    if (!this.store.state.openPositions.some((managed) => managed.symbol === position.symbol)) return;
    await this.reconcileLivePositions();
  }

  async closeAllManagedPositions(reason, forceClose) {
    if (!forceClose) return;
    for (const position of [...this.store.state.openPositions]) {
      const referencePrice = Number(this.store.state.lastPrices[position.symbol] || position.entryPrice);
      try {
        if (!this.config.dryRun && pendingLiveEntry(position)) {
          await this.client.cancelAllOrders(position.symbol);
          this.log("WARN", "Cancelled pending entry orders during shutdown protection.", { symbol: position.symbol });
          await this.reconcileLivePositions();
          const confirmedDuringShutdown = this.store.state.openPositions.find((item) => item.id === position.id);
          if (confirmedDuringShutdown && confirmedDuringShutdown.status === "OPEN") {
            await this.closePosition(confirmedDuringShutdown, referencePrice, reason);
          }
          continue;
        }
        await this.closePosition(position, referencePrice, reason);
      } catch (error) {
        this.log("ERROR", "Could not close a managed position during protection event.", {
          symbol: position.symbol,
          error: error.message,
        });
        await this.telegram.send(`URGENT: unable to close ${position.symbol}: ${error.message}`);
      }
    }
  }

  statusMessage() {
    const state = this.store.state;
    const daily = state.daily || { tradesOpened: 0, losingTrades: 0, realizedPnlUsdt: 0 };
    const performance = state.performance || {};
    const adaptivePolicy = this.adaptive.currentPolicy();
    return [
      `Aggressive Scalping Bot status: ${this.config.dryRun ? "DRY RUN" : "LIVE"}`,
      `Equity: ${Number(state.equity.currentUsdt).toFixed(4)} USDT`,
      `Level: ${state.ladder.activeLevel} (highest ${state.ladder.highestUnlockedLevel})`,
      `Open positions: ${state.openPositions.length}/${adaptivePolicy.maxOpenPositions || this.config.maxOpenPositions}`,
      `Adaptive mode: ${adaptivePolicy.mode}, min score ${adaptivePolicy.minSignalScore}, max leverage ${adaptivePolicy.maxLeverage}x`,
      `Daily PnL realized: ${Number(daily.realizedPnlUsdt || 0).toFixed(4)} USDT`,
      `Daily trades/losses: ${daily.tradesOpened || 0}/${daily.losingTrades || 0}`,
      `Exploration trades today: ${daily.explorationTrades || 0}/${adaptivePolicy.explorationBudget || 0}`,
      `All-time win rate: ${Number(performance.winRatePct || 0).toFixed(2)}% over ${performance.closedTrades || 0} closed trades`,
      `Fees tracked: ${Number(performance.totalFeesUsdt || 0).toFixed(4)} USDT`,
      `Average hold: ${Number(performance.averageHoldSeconds || 0).toFixed(1)} seconds`,
      `Best symbol: ${performance.bestSymbol ? `${performance.bestSymbol.symbol} ${Number(performance.bestSymbol.realizedPnlUsdt).toFixed(4)} USDT` : "n/a"}`,
      `Worst symbol: ${performance.worstSymbol ? `${performance.worstSymbol.symbol} ${Number(performance.worstSymbol.realizedPnlUsdt).toFixed(4)} USDT` : "n/a"}`,
      `Paused: ${state.paused ? `yes - ${state.pauseReason}` : "no"}`,
    ].join("\n");
  }

  async handleTelegramCommand(command) {
    if (command === "/status") return this.telegram.send(this.statusMessage());
    if (command === "/dryrun") return this.telegram.send(`DRY_RUN=${this.config.dryRun}. Live orders ${this.config.dryRun ? "are disabled" : "may be submitted"}.`);
    if (command === "/pause") {
      this.store.state.paused = true;
      this.store.state.pauseReason = "paused by Telegram command";
      this.store.saveState();
      return this.telegram.send("New entries paused. Existing positions remain protected by the running exit monitor.");
    }
    if (command === "/resume") {
      const equity = await this.measureEquity();
      if (!this.store.state.daily) this.risk.updateEquity(equity);
      const lock = this.risk.dailyLock(equity);
      if (lock.locked || this.emergencyStopRequested()) {
        return this.telegram.send(`Resume refused: ${lock.reason || "emergency stop file exists"}.`);
      }
      this.store.state.paused = false;
      this.store.state.pauseReason = null;
      this.store.saveState();
      return this.telegram.send("New entries resumed.");
    }
    if (command === "/panic") {
      await this.telegram.send("PANIC received: closing all managed positions and stopping bot.");
      await this.shutdown("Telegram /panic", { forceClose: true });
    }
  }

  async shutdown(reason, options = {}) {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.client.stopWebSockets();
    this.telegram.stop();
    const closePositions = options.forceClose || this.config.closePositionOnExit;
    this.log("WARN", "Safe shutdown started.", {
      reason,
      closePositions,
      openPositions: this.store.state.openPositions.map((position) => `${position.symbol}:${position.side}`),
    });
    if (closePositions) {
      if (!this.config.dryRun) {
        try {
          await this.reconcileLivePositions();
        } catch (error) {
          this.log("ERROR", "Could not reconcile live positions before shutdown close attempt.", { error: error.message });
        }
      }
      await this.closeAllManagedPositions(reason, true);
      if (!this.config.dryRun) await this.awaitShutdownReconciliation();
    } else if (this.store.state.openPositions.length) {
      this.log("WARN", "Managed positions remain open because CLOSE_POSITION_ON_EXIT=false.", {
        positions: this.store.state.openPositions.map((position) => position.symbol),
      });
    }
    this.store.saveAll();
    await this.telegram.send(
      `Bybit Aggressive Scalping Bot stopped: ${reason}. Open managed positions remaining: ${this.store.state.openPositions.length}.`
    );
    this.log("INFO", "State saved; bot stopped.", { reason });
  }

  async awaitShutdownReconciliation() {
    const deadline = Date.now() + this.config.entryConfirmationTimeoutMs;
    while (this.store.state.openPositions.length && Date.now() < deadline) {
      for (const position of [...this.store.state.openPositions]) {
        if (position.status === "OPEN") {
          const referencePrice = Number(this.store.state.lastPrices[position.symbol] || position.entryPrice);
          await this.closePosition(position, referencePrice, "shutdown reconciliation close");
        }
      }
      await sleep(500);
      await this.reconcileLivePositions();
    }
    if (this.store.state.openPositions.length) {
      this.log("ERROR", "Shutdown completed with managed positions still reported open; verify Bybit immediately.", {
        symbols: this.store.state.openPositions.map((position) => position.symbol),
      });
    } else {
      this.log("INFO", "RECONCILIATION SUCCESS", { result: "SHUTDOWN_POSITIONS_CLEAR" });
    }
  }
}

async function main() {
  const config = loadConfig();
  const bot = new LadderBot(config);
  await bot.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${new Date().toISOString()}] [ERROR] Bot could not start: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { LadderBot, liveExposure, pendingLiveEntry, entryConfirmationStartedAt };
