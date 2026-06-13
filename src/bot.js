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
const { classifyBybitError } = require("./bybitErrors");
const { ExecutionLedger } = require("./executionLedger");
const { edgeGate } = require("./costModel");
const { ProfitObjectiveEngine } = require("./profitObjective");
const {
  earnedRiskTier,
  adaptiveActivityRecovery,
  dynamicInactivityRecovery,
  ensureProfitControlledState,
  expectancyAutoTuning,
  expectancyOptimizer,
  leverageCapForTier,
  profitEdgeReport,
  profitExpectancyReport,
  profitControlledRiskCapPct,
  profitControlledRiskState,
  profitControlledSummary,
  profitSystemHealthReport,
  regimePerformanceMemory,
  qualityScoreForSignal,
  sizingEquityBaseFromBalance,
  setupRegimeMatrixMemory,
  setupRankingMemory,
  symbolPerformanceMemoryV3,
  tradeClusterRisk,
  trendDominanceSignal,
} = require("./profitControlled");
const {
  allocatedEquityLimitUsdt,
  liveValidationAllocation,
  promotionEvaluation,
  riskStateEvaluation,
  summarizeTrades,
} = require("./liveValidation");

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

function effectivelyUnchanged(currentValue, intendedValue, tolerancePct = 0.01) {
  if (intendedValue === undefined || intendedValue === null || intendedValue === "") return true;
  if (currentValue === undefined || currentValue === null || currentValue === "") return false;
  const current = Number(currentValue);
  const intended = Number(intendedValue);
  if (!Number.isFinite(current) || !Number.isFinite(intended)) {
    return String(currentValue) === String(intendedValue);
  }
  const basis = Math.max(Math.abs(current), Math.abs(intended), 1);
  return (Math.abs(current - intended) / basis) * 100 < tolerancePct;
}

function decimalPlaces(step) {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  const decimals = text.split(".")[1];
  return decimals ? decimals.replace(/0+$/, "").length : 0;
}

function roundedQuantity(value, step, roundUp) {
  const increment = Number(step || 0);
  if (!Number.isFinite(increment) || increment <= 0) return value;
  const units = value / increment;
  const rounded = (roundUp ? Math.ceil(units - Number.EPSILON) : Math.floor(units + Number.EPSILON)) * increment;
  return Number(rounded.toFixed(decimalPlaces(step)));
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
    this.executionLedger = new ExecutionLedger(config, this.log);
    this.profitObjective = new ProfitObjectiveEngine(config, this.store, this.log);
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
    this.lastMarketPersonality = null;
    this.apiRecoveryActive = false;
    this.lastApiRecoveryNoticeAt = 0;
    this.lastProfitObjectiveReportAt = 0;
    this.lastLiveValidationStatusAt = 0;
    this.lastProfitControlledStatusAt = 0;
    this.lastProfitControlledSizingEquityBaseUsdt = null;
    this.activityEvents = [];
    this.instrumentRulesBySymbol = new Map();
    this.startedAt = Date.now();
  }

  async start() {
    this.store.load();
    this.executionLedger.load();
    this.adaptive.load();
    this.adaptive.syncFromClosedTrades(this.store.trades);
    process.once("SIGINT", () => void this.shutdown("CTRL+C / SIGINT"));
    process.once("SIGTERM", () => void this.shutdown("SIGTERM"));

    this.log("INFO", "Starting Bybit Unified Futures Aggressive Scalping Bot.", {
      mode: this.config.dryRun ? "DRY_RUN" : "LIVE",
      environment: this.config.exchangeEnvironment,
      restBaseUrl: this.config.restBaseUrl,
      publicWsBaseUrl: this.config.publicWsBaseUrl,
      privateWsBaseUrl: this.config.privateWsBaseUrl,
      accountStartUsdt: this.config.accountStartUsdt,
      x10Mode: this.config.x10Mode,
      learningPhaseMode: this.config.learningPhaseMode,
      aggressiveLearningPhase: this.config.aggressiveLearningPhase,
      highActivityMode: this.config.highActivityMode,
      continuousExecutionMode: this.config.continuousExecutionMode,
      apiAutoRecoveryEnabled: this.config.apiAutoRecoveryEnabled,
      dailyTradeLimitsDisabled: this.config.disableDailyTradeLimits,
      forcedMarketSamplingEnabled: this.config.forcedMarketSamplingEnabled,
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
      marketRegimeIntelligenceEnabled: this.config.marketRegimeIntelligenceEnabled,
      focusedTradingUniverse: this.config.focusedTradingSymbolsList,
      continuationEngineEnabled: this.config.continuationEngineEnabled,
      continuationMinStrength: this.config.continuationMinStrength,
      macroCandleInterval: this.config.candleIntervalMacro,
      macroLongCandleInterval: this.config.candleIntervalMacroLong,
      symbolSpecializationEnabled: this.config.symbolSpecializationEnabled,
      sessionAggressionEnabled: this.config.sessionAggressionEnabled,
      profitProtectionEnabled: this.config.profitProtectionEnabled,
      scanIntervalMs: this.config.scanIntervalMs,
      scanConcurrency: this.config.scanConcurrency,
      maxPositionNotionalUsdt: this.config.maxPositionNotionalUsdt,
      positionMonitorIntervalMs: this.config.positionMonitorIntervalMs,
      entryConfirmationTimeoutMs: this.config.entryConfirmationTimeoutMs,
      positionMode: this.config.bybitPositionMode,
      liveValidationMode: this.config.liveValidationMode,
      profitControlledEquityMode: this.config.profitControlledEquityMode,
      profitControlledUseExchangeEquity: this.config.profitControlledUseExchangeEquity,
      maxTotalOpenStopRiskPct: this.config.maxTotalOpenStopRiskPct,
      maxCorrelatedClusterStopRiskPct: this.config.maxCorrelatedClusterStopRiskPct,
      liveValidationMaxAllocatedEquityUsdt: this.config.liveValidationMaxAllocatedEquityUsdt,
      liveValidationPromotionEnabled: this.config.liveValidationPromotionEnabled,
      emergencyStopFile: path.basename(this.config.emergencyStopFile),
    });
    if (this.config.bybitDemoTrading) {
      this.log("WARN", "DEMO TRADING — NO REAL FUNDS AT RISK.", {
        environment: this.config.exchangeEnvironment,
        restBaseUrl: this.config.restBaseUrl,
        publicWsBaseUrl: this.config.publicWsBaseUrl,
        privateWsBaseUrl: this.config.privateWsBaseUrl,
        demoDataDir: this.config.dataDir,
        mainnetLiveAcknowledgement: this.config.acknowledgeLiveTrading,
      });
    }
    if (this.config.activeAdaptiveScalperMode) {
      this.log("WARN", "ACTIVE ADAPTIVE SCALPER PAPER MODE — NO LIVE ORDERS WILL BE PLACED.", {
        environment: this.config.exchangeEnvironment,
        dataNamespace: this.config.dataDir,
        minSignalScore: this.config.minSignalScore,
        minConvictionScore: this.config.minConvictionScore,
        confidenceSizingEnabled: this.config.confidenceSizingEnabled,
        confidenceBands: {
          small: `${this.config.confidenceSmallMinScore}-${this.config.confidenceNormalMinScore}`,
          normal: `${this.config.confidenceNormalMinScore}-${this.config.confidenceLargeMinScore}`,
          larger: `${this.config.confidenceLargeMinScore}+`,
        },
        dailyLossLimitPct: this.config.paperDailyLossLimitPct,
        maxOpenPositions: this.config.maxOpenPositions,
        maxMarginUsagePct: this.config.maxMarginUsagePct,
        tpSlRequired: true,
      });
    }
    if (this.config.liveValidationMode) {
      this.log("ERROR", "LIVE VALIDATION MODE — REAL FUNDS AT RISK — LIMITED INITIAL RISK PROFILE ACTIVE", {
        environment: this.config.exchangeEnvironment,
        restBaseUrl: this.config.restBaseUrl,
        publicWsBaseUrl: this.config.publicWsBaseUrl,
        privateWsBaseUrl: this.config.privateWsBaseUrl,
        dataNamespace: this.config.dataDir,
        allocationLimitUsdt: this.config.liveValidationMaxAllocatedEquityUsdt,
        protectionDrawdownPct: this.config.liveValidationProtectionDrawdownPct,
        protectionDrawdownUsdt: Number((this.config.liveValidationMaxAllocatedEquityUsdt * (this.config.liveValidationProtectionDrawdownPct / 100)).toFixed(6)),
        promotionEnabled: this.config.liveValidationPromotionEnabled,
        guaranteedProfit: false,
      });
      this.log("WARN", "Live validation is real-money validation, not unrestricted live trading and not a profitability guarantee.", {
        noDailyTradeCapAdded: true,
        negativeEdgeForcedEntriesPermitted: false,
        activeUniverse: this.config.focusedTradingSymbolsList,
      });
    }
    if (this.config.profitControlledEquityMode) {
      this.log("ERROR", "PROFIT-CONTROLLED LIVE MODE — REAL FUNDS AT RISK — NO PROFIT GUARANTEE", {
        environment: this.config.exchangeEnvironment,
        restBaseUrl: this.config.restBaseUrl,
        publicWsBaseUrl: this.config.publicWsBaseUrl,
        privateWsBaseUrl: this.config.privateWsBaseUrl,
        dataNamespace: this.config.dataDir,
        useExchangeEquity: this.config.profitControlledUseExchangeEquity,
        maxTotalOpenStopRiskPct: this.config.maxTotalOpenStopRiskPct,
        maxCorrelatedClusterStopRiskPct: this.config.maxCorrelatedClusterStopRiskPct,
        guaranteedProfit: false,
      });
    }
    this.log("WARN", "This strategy attempts aggressive growth but cannot guarantee profit.", {
      stopLossPct: this.config.stopLossPct,
    });
    if (this.config.activeAdaptiveScalperMode) {
      this.log("WARN", "Paper daily loss limit active; new entries pause after the configured daily paper drawdown.", {
        dailyLossLimitPct: this.config.paperDailyLossLimitPct,
        dailyTradeCountCapDisabled: this.config.disableDailyTradeLimits,
        existingPositionsStillManaged: true,
      });
    } else {
      this.log("WARN", "Daily shutdown logic removed; 24/7 execution enabled until manual or catastrophic stop.", {
        continuousExecutionMode: this.config.continuousExecutionMode,
        dailyTradeLimitsDisabled: this.config.disableDailyTradeLimits,
        dailyLossShutdownRemoved: true,
        continuousLearningPreserved: true,
      });
    }
    this.log("WARN", "Focused trading universe enabled; V11 active market mode active.", {
      symbols: this.config.focusedTradingSymbolsList,
      noisyMarketUniverseRemoved: true,
      adaptiveFocusModeEnabled: true,
      concentratedLiquidityTradingActive: true,
      focusedExplorationActive: this.config.explorationModeEnabled,
    });
    this.log("WARN", "Next-generation continuation engine active.", {
      continuationBreakoutEntries: this.config.continuationEngineEnabled,
      pullbackContinuationEntries: this.config.pullbackContinuationEnabled,
      breakoutRetestEntries: this.config.retestEntryEnabled,
      momentumResumptionEntries: this.config.momentumResumptionEnabled,
      trendAccelerationEntries: this.config.trendAccelerationEnabled,
      oneHourMacroBias: this.config.candleIntervalMacro,
      smartPositionTiers: {
        weak: `${this.config.tier1MarginMinUsdt}-${this.config.tier1MarginMaxUsdt} USDT`,
        strong: `${this.config.tier2MarginMinUsdt}-${this.config.tier2MarginMaxUsdt} USDT`,
        elite: `${this.config.tier3MarginMinUsdt}-${this.config.tier3MarginMaxUsdt} USDT`,
      },
    });
    if (this.config.learningPhaseMode) {
      this.log("WARN", "Learning phase mode active; continuous learning priority active.", {
        aggressiveLearningPhase: this.config.aggressiveLearningPhase,
        dailyTradeLimitsDisabled: this.config.disableDailyTradeLimits,
        aggressiveExplorationActive: this.config.explorationModeEnabled,
        forcedMarketSamplingEnabled: this.config.forcedMarketSamplingEnabled,
      });
      if (this.config.aggressiveLearningPhase) {
        this.log("WARN", "Aggressive learning phase active; adaptive participation unrestricted by daily execution quotas.", {
          forcedExecutionSamplingActive: this.config.forcedMarketSamplingEnabled,
          portfolioSuppressionRemoved: true,
          continuousMarketParticipationActive: true,
        });
      }
      if (this.config.continuousExecutionMode) {
        this.log("WARN", "Continuous execution mode active; all daily trade-count blockers and participation quotas are disabled.", {
          portfolioExecutionSuppressionRemoved: true,
          explorationExecutionForceApproved: true,
          adaptiveParticipationUnrestricted: true,
        });
      }
      if (this.config.disableDailyTradeLimits) {
        this.log("WARN", "Daily execution limits disabled; trading continues until manual stop, emergency stop, liquidation danger, or core catastrophic safety blocks it.");
      }
    }
    if (this.config.highActivityMode) {
      this.log("WARN", "High activity mode active; BTC/ETH/SOL monitoring intensified while smart edge filtering remains enabled.", {
        scanIntervalMs: this.config.scanIntervalMs,
        positionMonitorIntervalMs: this.config.positionMonitorIntervalMs,
        marketRegimeCacheMs: this.config.marketRegimeCacheMs,
        focusedSymbols: this.config.focusedTradingSymbolsList,
      });
    }
    if (this.config.apiAutoRecoveryEnabled) {
      this.log("WARN", "Resilient execution engine active; API errors trigger recovery instead of automatic shutdown.", {
        maxConsecutiveApiErrorsBeforeEscalation: this.config.maxConsecutiveApiErrors,
        apiRecoveryBaseBackoffMs: this.config.apiRecoveryBaseBackoffMs,
        apiRecoveryMaxBackoffMs: this.config.apiRecoveryMaxBackoffMs,
        nonstopExecutionPreserved: true,
      });
    }

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
      `Bybit Aggressive Scalping Bot started in ${this.config.dryRun ? "DRY RUN" : `${this.config.exchangeEnvironment} ORDER`} mode. Profit is not guaranteed.`
    );
    this.telegram.start((command) => this.handleTelegramCommand(command));
    this.schedulePositionMonitor();
    await this.runCycle();
  }

  async initializeLiveSafety() {
    if (this.config.liveValidationMode) {
      this.log("ERROR", "LIVE VALIDATION MODE — REAL FUNDS AT RISK", {
        limitedInitialRiskProfile: true,
        guaranteedProfit: false,
      });
      this.log("INFO", "USER_ACKNOWLEDGEMENT_CONFIRMED", {
        acknowledgeLiveValidationRisk: this.config.acknowledgeLiveValidationRisk,
        acknowledgeLiveTrading: this.config.acknowledgeLiveTrading,
      });
      this.log("INFO", "MAINNET_ENDPOINT_CONFIRMED", {
        restBaseUrl: this.config.restBaseUrl,
        publicWsBaseUrl: this.config.publicWsBaseUrl,
        privateWsBaseUrl: this.config.privateWsBaseUrl,
      });
      this.log("INFO", "VALIDATION_ALLOCATION_LIMIT_USDT", {
        allocatedEquityLimitUsdt: this.config.liveValidationMaxAllocatedEquityUsdt,
        drawdownProtectionPct: this.config.liveValidationProtectionDrawdownPct,
      });
      this.log("INFO", "ENVIRONMENT_CONFIRMED_MAINNET", {
        restBaseUrl: this.config.restBaseUrl,
        publicWsBaseUrl: this.config.publicWsBaseUrl,
        privateWsBaseUrl: this.config.privateWsBaseUrl,
        bybitDemoTrading: this.config.bybitDemoTrading,
        bybitTestnet: this.config.bybitTestnet,
      });
      this.log("INFO", "LIVE_VALIDATION_ACKNOWLEDGED", {
        acknowledgeLiveValidationRisk: this.config.acknowledgeLiveValidationRisk,
        acknowledgeLiveTrading: this.config.acknowledgeLiveTrading,
      });
      this.log("INFO", "ALLOCATION_LIMIT_CONFIRMED", {
        allocatedEquityLimitUsdt: this.config.liveValidationMaxAllocatedEquityUsdt,
        launchMaximumAllowedUsdt: 10,
        drawdownProtectionPct: this.config.liveValidationProtectionDrawdownPct,
      });
      await this.loadFocusedInstrumentRules();
    }
    if (this.config.profitControlledEquityMode) {
      this.log("ERROR", "PROFIT-CONTROLLED LIVE MODE — REAL FUNDS AT RISK — NO PROFIT GUARANTEE", {
        guaranteedProfit: false,
        profile: "PROFIT_CONTROLLED_EQUITY_MODE",
      });
      this.log("INFO", "USER_ACKNOWLEDGEMENT_CONFIRMED", {
        acknowledgeProfitControlledLiveRisk: this.config.acknowledgeProfitControlledLiveRisk,
        acknowledgeLiveTrading: this.config.acknowledgeLiveTrading,
      });
      this.log("INFO", "MAINNET_ENDPOINT_CONFIRMED", {
        restBaseUrl: this.config.restBaseUrl,
        publicWsBaseUrl: this.config.publicWsBaseUrl,
        privateWsBaseUrl: this.config.privateWsBaseUrl,
      });
      this.log("INFO", "API_KEY_PRESENT_BUT_NOT_PRINTED", {
        apiKeyPresent: Boolean(this.config.apiKey),
        apiSecretPresent: Boolean(this.config.apiSecret),
      });
      await this.loadFocusedInstrumentRules();
      await this.refreshProfitControlledEquityBase();
    }
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
    if (this.config.profitControlledEquityMode) {
      if (positions.length) {
        this.unmanagedLiveExposure = true;
        this.enterProfitControlledProtectionOnly("existing mainnet exposure discovered at profit-controlled startup", {
          positions: positions.map((position) => ({ symbol: position.symbol, side: position.side, size: position.size })),
        });
      } else {
        this.log("INFO", "EXISTING_POSITIONS_RECONCILED", {
          managedOpenPositions: this.store.state.openPositions.length,
          manuallyOpenPositions: positions.length,
        });
      }
      const unresolved = this.unresolvedExecutionStateReason();
      this.log(unresolved ? "ERROR" : "INFO", unresolved ? "HUMAN_REVIEW_REQUIRED" : "PROTECTION_STATUS_CONFIRMED", {
        unresolvedReason: unresolved,
        openPositions: this.store.state.openPositions.length,
      });
      if (unresolved) {
        this.enterProfitControlledProtectionOnly(unresolved);
      }
      this.log("INFO", "FORCED_NEGATIVE_EDGE_PARTICIPATION_DISABLED", {
        forcedMarketSamplingEnabled: this.config.forcedMarketSamplingEnabled,
        forcedExecutionSamplingActive: this.config.forcedExecutionSamplingActive,
        fomoBreakoutMode: this.config.fomoBreakoutMode,
        microBreakoutEntries: this.config.microBreakoutEntries,
        allowChoppyMarketUnconditionally: this.config.allowChoppyMarketUnconditionally,
        unlimitedExplorationBudget: this.config.unlimitedExplorationBudget,
      });
      this.log("INFO", "HIGH_ACTIVITY_SCANNING_PRESERVED", {
        scanIntervalMs: this.config.scanIntervalMs,
        scanConcurrency: this.config.scanConcurrency,
        focusedTradingUniverse: this.config.focusedTradingSymbolsList,
      });
      this.log("INFO", "PROFIT_FIRST_LIVE_PROFILE_ACTIVE", {
        forcedNegativeEdgeParticipationDisabled: true,
        highActivityScanningPreserved: true,
        dailyTradeCountCapDisabled: true,
      });
      this.log("INFO", "PROFIT_MODE_ACTIVE", {
        adaptiveMode: "PROFIT_MODE",
        explorationExpansionActive: false,
        forcedSampling: false,
        aggressiveLearning: false,
        unlimitedExploration: false,
        tradeForDataCollection: false,
      });
      this.log("INFO", "WINNER_AMPLIFIER_ENGINE_ACTIVE", {
        enabled: this.config.winnerAmplifierEnabled,
        tp1PartialPct: this.config.winnerAmplifierPartialTakeProfitPct,
        runnerPct: 100 - this.config.winnerAmplifierPartialTakeProfitPct,
        runnerBreakevenAfterTp1: true,
        atrTrailingStop: this.config.trailingStopEnabled,
      });
      this.log("INFO", "V9_EDGE_MAXIMIZATION_ENGINE_ACTIVE", {
        edgeMaximizationMode: this.config.edgeMaximizationMode,
        normalQualitySizeMultiplier: this.config.qualitySizeMultiplierNormal,
        strongQualitySizeMultiplier: this.config.qualitySizeMultiplierStrong,
        eliteQualitySizeMultiplier: this.config.qualitySizeMultiplierElite,
        setupRankingBoostProfitFactor: this.config.setupRankingBoostProfitFactor,
        regimeMemoryBoostProfitFactor: this.config.regimeMemoryBoostProfitFactor,
        riskControlsUnchanged: true,
        feeProtectionUnchanged: true,
      });
      this.log("INFO", "V9_5_ADAPTIVE_EDGE_REINFORCEMENT_ACTIVE", {
        edgeReinforcementMode: this.config.edgeReinforcementMode,
        regimeSetupMatrixEnabled: true,
        asymmetricRunnerAllocation: {
          weakTrend: `${this.config.asymmetricRunnerWeakTp1Pct}% TP1 / ${100 - this.config.asymmetricRunnerWeakTp1Pct}% runner`,
          strongTrend: `${this.config.asymmetricRunnerStrongTp1Pct}% TP1 / ${100 - this.config.asymmetricRunnerStrongTp1Pct}% runner`,
          eliteTrend: `${this.config.asymmetricRunnerEliteTp1Pct}% TP1 / ${100 - this.config.asymmetricRunnerEliteTp1Pct}% runner`,
        },
        expectancyAutoTuningWindowTrades: this.config.expectancyAutoTuningWindowTrades,
        expectancyAutoTuningMaxAdjustmentPct: this.config.expectancyAutoTuningMaxAdjustmentPct,
        adaptiveActivityRecoveryMode: this.config.adaptiveEdgeActivityRecoveryMode,
        adaptiveActivityRecoveryMaxRelaxPct: this.config.adaptiveEdgeActivityRecoveryMaxRelaxPct,
        tradeClusterWindowMinutes: this.config.tradeClusterWindowMinutes,
        maxClusterSizeReductionPct: this.config.tradeClusterMaxSizeReductionPct,
        noMartingale: true,
        noAveragingDown: true,
        noRevengeTrading: true,
        leverageIncrease: false,
        stopLossLogicWeakened: false,
      });
      this.log("INFO", "V10_TREND_DOMINANCE_ENGINE_ACTIVE", {
        trendDominanceMode: this.config.trendDominanceMode,
        aggressiveAdaptiveMode: this.config.aggressiveAdaptiveMode,
        inactivityRecoveryMode: this.config.inactivityRecoveryMode,
        strongScore: this.config.trendDominanceStrongScore,
        eliteScore: this.config.trendDominanceEliteScore,
        targetActivityIncreasePct: "30-50",
        ethBtcFocusBoost: this.config.trendDominanceEthBtcFocusBoost,
        ethWeightMultiplier: this.config.trendDominanceEthWeightMultiplier,
        btcWeightMultiplier: this.config.trendDominanceBtcWeightMultiplier,
        solWeakBreakoutMultiplier: this.config.trendDominanceSolWeakBreakoutMultiplier,
        stopRiskCapsPct: {
          normal: this.config.profitControlledNormalMaxStopRiskPct,
          strong: this.config.profitControlledStrongMaxStopRiskPct,
          elite: this.config.profitControlledEliteMaxStopRiskPct,
        },
        strongTrendSizingMultiplier: this.config.trendDominanceStrongSizingMultiplier,
        eliteTrendSizingMultiplier: this.config.trendDominanceEliteSizingMultiplier,
        riskControlsUnchanged: true,
        feeProtectionUnchanged: true,
        stopLossLogicUnchanged: true,
        portfolioCapsUnchanged: true,
      });
      this.log("INFO", "V8_PROFESSIONAL_TREND_ENGINE_ACTIVE", {
        multiTimeframeTrendEngineEnabled: this.config.multiTimeframeTrendEngineEnabled,
        timeframes: {
          entryTrigger: this.config.candleIntervalFast,
          confirmation: this.config.candleIntervalMain,
          trendDirection: this.config.candleIntervalTrend,
          macroBias: this.config.candleIntervalMacro,
          macroLongBias: this.config.candleIntervalMacroLong,
        },
        macroOppositeRequiresElite: this.config.macroOppositeRequiresElite,
        expectancyOptimizerEnabled: this.config.expectancyOptimizerEnabled,
        nearMissLearningEnabled: this.config.nearMissLearningEnabled,
      });
      this.log("INFO", "V11_ACTIVE_MARKET_ENGINE_ACTIVE", {
        symbols: this.config.focusedTradingSymbolsList,
        marketRegimeSplit: ["TRENDING", "SIDEWAYS_CHOP", "VOLATILE", "PANIC"],
        meanReversionEnabled: this.config.v11MeanReversionEnabled,
        nearMissReevaluationMaxGap: this.config.v11NearMissReevaluationMaxGap,
        inactivityRecoveryPoints: {
          fourHours: this.config.inactivityRecoveryFourHourRelaxPoints,
          eightHours: this.config.inactivityRecoveryEightHourRelaxPoints,
          twelveHours: this.config.inactivityRecoveryTwelveHourRelaxPoints,
        },
        highActivityScanningPreserved: true,
        riskControlsUnchanged: true,
        feeProtectionUnchanged: true,
      });
      this.log("INFO", "ADAPTIVE_CONVICTION_ACTIVE", {
        TRENDING: this.config.convictionThresholdTrending,
        BREAKOUT: this.config.convictionThresholdBreakout,
        SIDEWAYS_CHOP: this.config.convictionThresholdSidewaysChop,
        VOLATILE: this.config.convictionThresholdVolatile,
        PANIC: this.config.convictionThresholdPanic,
      });
      if (this.config.tradeFrequencyRecoveryMode) {
        this.log("INFO", "TRADE_FREQUENCY_RECOVERY_ACTIVE", {
          adaptiveMinimumScore: this.adaptive.currentPolicy().minSignalScore,
          minimumConvictionScore: this.config.minConvictionScore,
          antiChopPenaltyMax: this.config.antiChopPenaltyMax,
          antiChopConvictionPenaltyMax: this.config.antiChopConvictionPenaltyMax,
          volumeSurvivabilityRelaxationMultiplier: this.config.volumeSurvivabilityRelaxationMultiplier,
          qualityPacingEnabled: this.config.qualityPacingEnabled,
          feeModelUnchanged: true,
          portfolioRiskUnchanged: true,
        });
      }
      this.log("INFO", "DAILY_TRADE_COUNT_CAP_DISABLED", {
        disableDailyTradeLimits: this.config.disableDailyTradeLimits,
        dailyTradeLimitsDisabled: this.config.dailyTradeLimitsDisabled,
      });
      this.log("INFO", "QUALIFIED_OPPORTUNITY_CAPTURE_ACTIVE", {
        opportunityFamilies: [
          "TREND_CONTINUATION",
          "PULLBACK_RESUMPTION",
          "BREAKOUT_RETEST",
          "MOMENTUM_ACCELERATION",
          "SAME_DIRECTION_REENTRY",
          "PROFIT_QUALIFIED_CONTINUATION",
        ],
      });
      this.log("INFO", "PORTFOLIO_STOP_RISK_LIMIT_CONFIRMED", {
        maxTotalOpenStopRiskPct: this.config.maxTotalOpenStopRiskPct,
        maxCorrelatedClusterStopRiskPct: this.config.maxCorrelatedClusterStopRiskPct,
        maxSimultaneousPositions: this.config.maxOpenPositions,
      });
      if (!unresolved && !positions.length) {
        this.log("INFO", "READY_TO_SCAN_FOR_NET_POSITIVE_QUALIFIED_ENTRIES", {
          negativeEdgeForcedEntriesPermitted: false,
          noDailyTradeCountCap: true,
        });
      }
      this.writeProfitControlledStatusReport(true);
    }
    if (this.config.liveValidationMode) {
      if (positions.length) {
        this.unmanagedLiveExposure = true;
        this.log("ERROR", "HUMAN_REVIEW_REQUIRED", {
          reason: "Existing mainnet exposure discovered at live-validation startup; new entries remain blocked until manually reviewed.",
          positions: positions.map((position) => ({ symbol: position.symbol, side: position.side, size: position.size })),
        });
      } else {
        this.log("INFO", "EXISTING_POSITIONS_RECONCILED", {
          managedOpenPositions: this.store.state.openPositions.length,
          manuallyOpenPositions: positions.length,
        });
      }
      const unresolved = this.unresolvedExecutionStateReason();
      this.log(unresolved ? "ERROR" : "INFO", unresolved ? "HUMAN_REVIEW_REQUIRED" : "PROTECTION_STATUS_CONFIRMED", {
        unresolvedReason: unresolved,
        openPositions: this.store.state.openPositions.length,
      });
      if (!unresolved && !positions.length) {
        this.log("INFO", "READY_TO_SCAN_FOR_NEW_QUALIFIED_ENTRIES", {
          opportunityFamilies: [
            "TREND_CONTINUATION",
            "PULLBACK_RESUMPTION",
            "BREAKOUT_RETEST",
            "MOMENTUM_ACCELERATION",
            "SAME_DIRECTION_REENTRY",
            "EXPLORATION_POSITIVE_EDGE",
          ],
          noDailyTradeCountCap: true,
        });
      }
      this.writeLiveValidationStatusReport(true);
    }
    this.log("WARN", "Bybit live trading enabled after safety checks; entries include native TP/SL orders.", {
      positionMode: this.positionMode,
      maxLeverage: this.config.maxLeverage,
    });
  }

  enterLiveValidationProtectionOnly(reason, details = {}) {
    if (!this.config.liveValidationMode) return;
    if (!this.store.state.liveValidation) this.store.state.liveValidation = {};
    this.store.state.liveValidation.riskState = "RISK_STATE_PROTECTION_ONLY";
    this.store.state.liveValidation.riskStateReasons = [reason];
    this.store.state.liveValidation.lastRiskCheckedAt = new Date().toISOString();
    this.store.saveState();
    this.log("ERROR", "HUMAN_REVIEW_REQUIRED", {
      reason,
      riskState: "RISK_STATE_PROTECTION_ONLY",
      newEntriesBlocked: true,
      ...details,
    });
  }

  enterProfitControlledProtectionOnly(reason, details = {}) {
    if (!this.config.profitControlledEquityMode) return;
    const profile = ensureProfitControlledState(this.store.state, this.config);
    profile.riskState = "RISK_STATE_PROTECTION_ONLY";
    profile.riskStateReasons = [reason];
    profile.lastRiskCheckedAt = new Date().toISOString();
    this.store.saveState();
    this.log("ERROR", "HUMAN_REVIEW_REQUIRED", {
      reason,
      riskState: "RISK_STATE_PROTECTION_ONLY",
      newEntriesBlocked: true,
      positionMonitoringContinues: true,
      ...details,
    });
  }

  async loadFocusedInstrumentRules() {
    if (!this.config.liveValidationMode && !this.config.profitControlledEquityMode) return this.instrumentRulesBySymbol;
    try {
      const symbols = await this.client.getSymbols();
      const rules = new Map();
      const missing = [];
      const loaded = [];
      for (const symbol of this.config.focusedTradingSymbolsList) {
        const info = symbols.find((item) => item && item.symbol === symbol);
        const lot = info && info.lotSizeFilter ? info.lotSizeFilter : {};
        const price = info && info.priceFilter ? info.priceFilter : {};
        const hasRequiredRuleData =
          info &&
          Number(lot.qtyStep) > 0 &&
          Number(lot.minOrderQty) > 0 &&
          Number(price.tickSize) > 0;
        if (!hasRequiredRuleData) {
          missing.push(symbol);
          continue;
        }
        rules.set(symbol, info);
        loaded.push({
          symbol,
          tickSize: price.tickSize,
          qtyStep: lot.qtyStep,
          minOrderQty: lot.minOrderQty,
          minNotionalValue: lot.minNotionalValue || null,
        });
      }
      if (missing.length) {
        const reason = this.config.profitControlledEquityMode
          ? "instrument rules missing for focused profit-controlled symbols"
          : "instrument rules missing for focused live-validation symbols";
        this.enterLiveValidationProtectionOnly(reason, { missingSymbols: missing });
        this.enterProfitControlledProtectionOnly(reason, { missingSymbols: missing });
        throw new Error(`Live startup refused: ${reason}: ${missing.join(", ")}.`);
      }
      this.instrumentRulesBySymbol = rules;
      this.log("INFO", "INSTRUMENT_RULES_LOADED", {
        focusedSymbols: this.config.focusedTradingSymbolsList,
        rules: loaded,
      });
      this.log("INFO", "MINIMUM_ORDER_FEASIBILITY_CHECK_PASSED", {
        instrumentRulesLoaded: true,
        candidateSpecificRiskRecheckBeforeEntry: true,
        neverIncreaseAboveRiskLimitForExchangeMinimum: true,
      });
      return rules;
    } catch (error) {
      if (!/Live startup refused|Live validation startup refused/.test(error.message)) {
        this.enterLiveValidationProtectionOnly("instrument-rule load failure blocks new exposure", { error: error.message });
        this.enterProfitControlledProtectionOnly("instrument-rule load failure blocks new exposure", { error: error.message });
      }
      throw error;
    }
  }

  emergencyStopRequested() {
    return fs.existsSync(this.config.emergencyStopFile);
  }

  async measureEquity() {
    if (this.config.dryRun) return this.risk.markToMarketEquity(this.store.state.lastPrices);
    return (await this.client.getUsdtBalance()).equity;
  }

  async refreshProfitControlledEquityBase() {
    if (!this.config.profitControlledEquityMode) return null;
    const balance = await this.client.getUsdtBalance();
    const snapshot = sizingEquityBaseFromBalance(balance, this.reservedMarginUsdt());
    const profile = ensureProfitControlledState(this.store.state, this.config);
    if (!(numeric(profile.startEquityUsdt) > 0) && snapshot.exchangeReportedTotalEquityUsdt > 0) {
      profile.startEquityUsdt = snapshot.exchangeReportedTotalEquityUsdt;
    }
    const previousSizingEquityBaseUsdt = this.lastProfitControlledSizingEquityBaseUsdt;
    const changed =
      previousSizingEquityBaseUsdt !== null &&
      !effectivelyUnchanged(previousSizingEquityBaseUsdt, snapshot.sizingEquityBaseUsdt, 0.01);
    profile.exchangeReportedTotalEquityUsdt = snapshot.exchangeReportedTotalEquityUsdt;
    profile.usableMarginUsdt = snapshot.usableMarginUsdt;
    profile.sizingEquityBaseUsdt = snapshot.sizingEquityBaseUsdt;
    profile.lastSizingEquityBaseUsdt = snapshot.sizingEquityBaseUsdt;
    profile.lastEquityCheckedAt = new Date().toISOString();
    this.lastProfitControlledSizingEquityBaseUsdt = snapshot.sizingEquityBaseUsdt;
    this.store.saveState();
    this.log("INFO", "PROFIT_CONTROLLED_EQUITY_MODE_ACTIVE", {
      useExchangeEquity: this.config.profitControlledUseExchangeEquity,
    });
    this.log("INFO", "EXCHANGE_REPORTED_TOTAL_EQUITY_USDT", {
      equityUsdt: snapshot.exchangeReportedTotalEquityUsdt,
      balanceParseSource: balance.parseSource,
      equityParseSource: balance.equitySource,
    });
    this.log("INFO", "USABLE_MARGIN_USDT", {
      usableMarginUsdt: snapshot.usableMarginUsdt,
      availableBalanceUsdt: balance.available,
      transferableUsableMarginUsdt: balance.transferableUsableMargin,
    });
    this.log("INFO", "SIZING_EQUITY_BASE_USDT", {
      sizingEquityBaseUsdt: snapshot.sizingEquityBaseUsdt,
      reservedMarginUsdt: Number(this.reservedMarginUsdt().toFixed(6)),
    });
    this.log("INFO", "EQUITY_BASE_CHANGED_SINCE_LAST_CYCLE", {
      changed,
      previousSizingEquityBaseUsdt,
      sizingEquityBaseUsdt: snapshot.sizingEquityBaseUsdt,
    });
    return { balance, ...snapshot };
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
        if (adaptivePolicy.mode === "DEFENSIVE_RECOVERY" || adaptivePolicy.mode === "LEARNING_RECOVERY") {
          this.log("INFO", "Recovery aggression restored; defensive penalties are decaying while reduced-risk learning continues.", adaptivePolicy);
        }
        if (adaptivePolicy.mode === "CONTROLLED_AGGRESSIVE") {
          this.log("INFO", "Adaptive aggression increased after improved recent performance.", adaptivePolicy);
        }
      }
      this.lastAdaptiveMode = adaptivePolicy.mode;
      if (adaptivePolicy.activityFloorEngaged) {
        this.log("INFO", "Adaptive activity floor engaged.", {
          maxTradesPerDay: adaptivePolicy.maxTradesPerDay,
          explorationBudget: adaptivePolicy.explorationBudget,
          explorationMinSignalScore: adaptivePolicy.explorationMinSignalScore,
          explorationMinConvictionScore: adaptivePolicy.explorationMinConvictionScore,
          activityFloorSignalRelaxPoints: adaptivePolicy.activityFloorSignalRelaxPoints,
          activityFloorConvictionRelaxPoints: adaptivePolicy.activityFloorConvictionRelaxPoints,
        });
      }
      if (adaptivePolicy.explorationExpansionActive) {
        this.log("INFO", "Exploration expansion active; adaptive participation increased.", {
          explorationBudget: adaptivePolicy.explorationBudget,
          explorationTradeRatio: this.config.explorationTradeRatio,
          adaptiveMode: adaptivePolicy.mode,
        });
      }
      if (adaptivePolicy.mode === "CAUTIOUS_LEARNING") {
        this.log("INFO", "Cautious mode participation enabled; risk is moderated but learning participation remains active.", adaptivePolicy);
      }
      if (adaptivePolicy.mode === "CAUTIOUS_ACTIVE") {
        this.log("INFO", "Cautious active mode enabled; sizing is moderated but execution participation continues.", adaptivePolicy);
      }
      if (adaptivePolicy.qualityPacingActive) {
        this.log("WARN", "Adaptive pacing engaged; execution quality improved without disabling continuous execution.", {
          reason: adaptivePolicy.qualityPacingReason,
          rollingWinRatePct: adaptivePolicy.rollingWinRatePct,
          rollingPnlUsdt: adaptivePolicy.rollingPnlUsdt,
          feeDragRatio: adaptivePolicy.feeDragRatio,
          minSignalScore: adaptivePolicy.minSignalScore,
          explorationMinSignalScore: adaptivePolicy.explorationMinSignalScore,
          explorationMinConvictionScore: adaptivePolicy.explorationMinConvictionScore,
        });
        this.log("INFO", "Smart pacing engaged; low-quality fee bleed is being filtered while activity stays enabled.", {
          continuousExecutionMode: this.config.continuousExecutionMode,
          forcedMarketSamplingEnabled: this.config.forcedMarketSamplingEnabled,
          qualityPacingReason: adaptivePolicy.qualityPacingReason,
        });
      }
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
        adaptiveMaxTradesPerDay: this.config.disableDailyTradeLimits ? "unlimited" : adaptivePolicy.maxTradesPerDay,
        dailyTradeLimitsDisabled: adaptivePolicy.dailyTradeLimitsDisabled,
        qualityPacingActive: adaptivePolicy.qualityPacingActive,
        qualityPacingReason: adaptivePolicy.qualityPacingReason,
        adaptiveRiskMultiplier: adaptivePolicy.riskMultiplier,
        explorationEnabled: adaptivePolicy.explorationEnabled,
        explorationBudget: adaptivePolicy.explorationBudget,
        explorationExpansionActive: adaptivePolicy.explorationExpansionActive,
        activityFloorEngaged: adaptivePolicy.activityFloorEngaged,
        dailyExplorationTrades: this.store.state.daily.explorationTrades || 0,
        winRatePct: this.store.state.performance.winRatePct,
        realizedPnlUsdt: this.store.state.performance.realizedPnlUsdt,
        feesUsdt: this.store.state.performance.totalFeesUsdt,
      });

      const marketProfile = await this.scanner.marketProfile();
      await this.managePositions(marketProfile);
      const equity = await this.measureEquity();
      if (this.config.profitControlledEquityMode) {
        await this.refreshProfitControlledEquityBase();
      }
      this.risk.updateEquity(equity);
      const recoveryStatus = this.risk.continuousRecoveryStatus(equity);
      const profitProtection = this.risk.profitProtection(equity);
      if (profitProtection.active) {
        this.store.state.daily.profitProtectionActive = true;
        this.store.state.daily.profitProtectionPnlPct = Number(profitProtection.pnlPct.toFixed(4));
        this.store.saveState();
        this.log("WARN", "Profit protection sizing mode enabled; entries remain active.", profitProtection);
      } else if (this.store.state.daily) {
        this.store.state.daily.profitProtectionActive = false;
        this.store.state.daily.profitProtectionPnlPct = Number(profitProtection.pnlPct.toFixed(4));
      }

      if (recoveryStatus.active) {
        this.log("INFO", "Continuous learning preserved; recovery adjusts sizing without pausing execution.", recoveryStatus);
      }

      const inactivityRecovery = this.config.inactivityRecoveryMode
        ? dynamicInactivityRecovery(this.config, this.lastTradeOpenedAtMs())
        : { active: false, convictionThresholdMultiplier: 1, convictionThresholdDelta: 0, convictionRelaxPct: 0, convictionRelaxPoints: 0, stage: "NONE" };
      if (this.scanner.setRuntimeContext) {
        this.scanner.setRuntimeContext({ dynamicInactivityRecovery: inactivityRecovery });
      }
      if (inactivityRecovery.active) {
        this.log("INFO", "DYNAMIC_INACTIVITY_RECOVERY_ACTIVE", {
          stage: inactivityRecovery.stage,
          inactiveHours: inactivityRecovery.inactiveHours,
          convictionRelaxPct: inactivityRecovery.convictionRelaxPct,
          convictionRelaxPoints: inactivityRecovery.convictionRelaxPoints,
          convictionThresholdMultiplier: inactivityRecovery.convictionThresholdMultiplier,
          convictionThresholdDelta: inactivityRecovery.convictionThresholdDelta,
          resetAfterNewTrade: inactivityRecovery.resetAfterNewTrade,
          feeProtectionUnchanged: true,
          riskControlsUnchanged: true,
        });
      }

      const scan = await this.scanner.scan(marketProfile);
      this.recordPaperScanRejections(scan);
      if (this.config.profitControlledEquityMode && this.config.nearMissLearningEnabled) {
        this.updateNearMissStats(scan.nearMisses || [], scan.analyses || []);
      }
      if (this.config.liveValidationMode || this.config.profitControlledEquityMode) {
        this.recordActivityEvent("scanCandidate", { count: scan.analyses.length });
        this.recordActivityEvent("scanAccepted", { count: scan.candidates.length });
        this.recordActivityEvent("scanRejected", { count: Math.max(0, scan.analyses.length - scan.candidates.length) });
        for (const candidate of scan.candidates) {
          this.recordActivityEvent("qualifiedCandidate", { symbol: candidate.symbol, side: candidate.side });
        }
      }
      if (scan.hadApiErrors) {
        await this.handleApiRecovery(new Error("partial scan API data failure"), {
          source: "PARTIAL_SCAN",
          countError: false,
          nonBlocking: true,
        });
      } else if (this.store.state.consecutiveApiErrors > 0) {
        this.log("INFO", "Execution resumed automatically after API recovery.", {
          previousConsecutiveApiErrors: this.store.state.consecutiveApiErrors,
        });
        this.store.state.consecutiveApiErrors = 0;
      }
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
      const candidates = this.candidatesWithForcedSampling(scan, equity);
      await this.openBestCandidates(candidates, equity, profitProtection, recoveryStatus);
    } catch (error) {
      this.log("ERROR", "Trading cycle failed; API recovery will retry without shutting down the bot.", {
        error: error.message,
        consecutiveApiErrors: this.store.state.consecutiveApiErrors,
      });
      await this.handleApiRecovery(error, { source: "TRADING_CYCLE", countError: true });
    } finally {
      this.cycleActive = false;
      this.writePeriodicProfitObjectiveReport();
      this.writeLiveValidationStatusReport();
      this.writeProfitControlledStatusReport();
      this.writeTradingReport();
      if (!this.stopping) {
        this.timer = setTimeout(() => void this.runCycle(), this.config.scanIntervalMs);
      }
    }
  }

  writePeriodicProfitObjectiveReport(force = false) {
    const intervalMs = Math.max(30000, this.config.scanIntervalMs * 10);
    if (!force && Date.now() - this.lastProfitObjectiveReportAt < intervalMs) return;
    try {
      this.profitObjective.report();
      this.lastProfitObjectiveReportAt = Date.now();
      this.log("DEBUG", "Profit objective summary refreshed.", {
        latestSummary: path.join(this.config.reportsDir || path.join(this.config.projectRoot, "data", "reports"), "latest-summary.json"),
      });
    } catch (error) {
      this.log("WARN", "Profit objective report update failed.", { error: error.message });
    }
  }

  recordActivityEvent(type, details = {}) {
    if (!this.config.liveValidationMode && !this.config.profitControlledEquityMode) return;
    const event = { type, time: Date.now(), ...details };
    this.activityEvents.push(event);
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.activityEvents = this.activityEvents.filter((item) => item.time >= cutoff);
  }

  ensureActiveScalperState() {
    if (!this.config.activeAdaptiveScalperMode) return null;
    if (!this.store.state.activeAdaptiveScalper) {
      this.store.state.activeAdaptiveScalper = {
        namespace: "data/paper-trading",
        tradesRejected: 0,
        tradesAccepted: 0,
        rejectionReasons: {},
        recentRejectedTrades: [],
        lastReportAt: null,
      };
    }
    if (!this.store.state.activeAdaptiveScalper.rejectionReasons) this.store.state.activeAdaptiveScalper.rejectionReasons = {};
    if (!Array.isArray(this.store.state.activeAdaptiveScalper.recentRejectedTrades)) this.store.state.activeAdaptiveScalper.recentRejectedTrades = [];
    return this.store.state.activeAdaptiveScalper;
  }

  recordRejectedTrade(signal = {}, reason = "UNKNOWN_REJECTION", details = {}) {
    const state = this.ensureActiveScalperState();
    if (!state) return null;
    const normalizedReason = String(reason || "UNKNOWN_REJECTION").replace(/:\s.*$/, "");
    const record = {
      timestamp: new Date().toISOString(),
      stage: details.stage || "ENTRY_EVALUATION",
      symbol: signal.symbol || details.symbol || "UNKNOWN",
      side: signal.side || details.side || "UNKNOWN",
      score: Number(signal.score || details.score || 0),
      requiredScore: Number(signal.requiredScore || details.requiredScore || 0),
      convictionScore: Number(signal.convictionScore || details.convictionScore || 0),
      requiredConvictionScore: Number(signal.requiredConvictionScore || details.requiredConvictionScore || 0),
      setupType: signal.setupType || signal.continuationSetupType || details.setupType || "UNKNOWN",
      marketRegime: signal.marketRegimeV2 || signal.marketRegimeType || signal.regime || details.marketRegime || "UNKNOWN",
      reason: normalizedReason,
      antiChopContribution: Number(signal.antiChopContribution || 0),
      convictionContribution: Number(signal.convictionContribution || 0),
      allReasons: Array.isArray(details.rejected)
        ? details.rejected
        : Array.isArray(signal.rejected)
          ? signal.rejected
          : [normalizedReason],
    };
    state.tradesRejected = Number(state.tradesRejected || 0) + 1;
    state.rejectionReasons[normalizedReason] = Number(state.rejectionReasons[normalizedReason] || 0) + 1;
    state.recentRejectedTrades.push(record);
    state.recentRejectedTrades = state.recentRejectedTrades.slice(-this.config.activeScalperRejectedLogMax);
    this.log("INFO", "PAPER_TRADE_REJECTED", {
      reason: record.reason,
      score: record.score,
      symbol: record.symbol,
      side: record.side,
      stage: record.stage,
      requiredScore: record.requiredScore,
      convictionScore: record.convictionScore,
      requiredConvictionScore: record.requiredConvictionScore,
      antiChopContribution: record.antiChopContribution,
      convictionContribution: record.convictionContribution,
    });
    this.store.saveState();
    return record;
  }

  recordPaperScanRejections(scan) {
    if (!this.config.activeAdaptiveScalperMode || !scan || !Array.isArray(scan.analyses)) return;
    for (const item of scan.analyses) {
      if (item.eligible) continue;
      const reasons = Array.isArray(item.rejected) && item.rejected.length
        ? item.rejected
        : [
            Number(item.score || 0) < Number(item.requiredScore || 0)
              ? `score below threshold: ${Number(item.score || 0).toFixed(1)} < ${Number(item.requiredScore || 0).toFixed(1)}`
              : item.explorationBlockReason || "candidate did not pass signal evaluation",
          ];
      this.recordRejectedTrade(item, reasons[0], { stage: "SCAN", rejected: reasons });
    }
  }

  writeTradingReport(force = false) {
    if (!this.config.activeAdaptiveScalperMode) return null;
    const intervalMs = Math.max(15000, this.config.scanIntervalMs * 5);
    const state = this.ensureActiveScalperState();
    if (!force && state.lastReportAt && Date.now() - Date.parse(state.lastReportAt) < intervalMs) return null;
    const mode = this.store.state.mode;
    const trades = this.store.trades.filter((trade) => trade.mode === mode);
    const closedTrades = trades.filter((trade) => trade.status === "CLOSED" && Number.isFinite(Number(trade.pnlUsdt)));
    const tradesTaken = trades.filter((trade) => !["ENTRY_FAILED", "FAILED", "REJECTED", "IGNORED_AFTER_MODE_CHANGE"].includes(String(trade.status || "").toUpperCase())).length;
    const pnl = closedTrades.reduce((total, trade) => total + Number(trade.pnlUsdt || 0), 0);
    const wins = closedTrades.filter((trade) => Number(trade.pnlUsdt || 0) > 0).length;
    const fees = closedTrades.reduce((total, trade) => total + Number(trade.feesUsdt || trade.estimatedFeesUsdt || 0), 0);
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "ACTIVE_ADAPTIVE_SCALPER_PAPER",
      paperTradingMode: true,
      tradesTaken,
      openPositions: this.store.state.openPositions.length,
      closedTrades: closedTrades.length,
      tradesRejected: Number(state.tradesRejected || 0),
      rejectionReasons: state.rejectionReasons || {},
      recentRejectedTrades: state.recentRejectedTrades || [],
      winRatePct: closedTrades.length ? Number(((wins / closedTrades.length) * 100).toFixed(2)) : 0,
      pnlUsdt: Number(pnl.toFixed(6)),
      feesUsdt: Number(fees.toFixed(6)),
      drawdown: this.adaptive.memory.stats && this.adaptive.memory.stats.drawdown,
      performance: this.store.state.performance,
      learningMemory: {
        rolling: this.adaptive.memory.rolling,
        winRateBySymbol: this.adaptive.memory.stats && this.adaptive.memory.stats.bySymbol,
        winRateBySetup: this.adaptive.memory.stats && this.adaptive.memory.stats.bySetupType,
        winRateByHour: this.adaptive.memory.stats && this.adaptive.memory.stats.byHour,
      },
      protections: {
        dailyLossLimitActive: true,
        dailyLossLimitPct: this.config.paperDailyLossLimitPct,
        emergencyStopFile: path.basename(this.config.emergencyStopFile),
        maxMarginUsagePct: this.config.maxMarginUsagePct,
        maxOpenPositions: this.config.maxOpenPositions,
        takeProfitPct: this.config.takeProfitPct,
        stopLossPct: this.config.stopLossPct,
        feeProtectionActive: true,
        liveOrdersDisabled: this.config.dryRun,
      },
    };
    fs.mkdirSync(this.config.reportsDir, { recursive: true });
    const file = path.join(this.config.reportsDir, "trading_report.json");
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    state.lastReportAt = report.generatedAt;
    this.store.saveState();
    this.log("INFO", "TRADING_REPORT_UPDATED", {
      file,
      tradesTaken: report.tradesTaken,
      tradesRejected: report.tradesRejected,
      winRatePct: report.winRatePct,
      pnlUsdt: report.pnlUsdt,
    });
    return report;
  }

  activityRates() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const events = this.activityEvents.filter((event) => event.time >= cutoff);
    const count = (type) =>
      events
        .filter((event) => event.type === type)
        .reduce((total, event) => total + Math.max(0, Number(event.count || 1)), 0);
    const closed = this.store.trades.filter(
      (trade) =>
        trade.status === "CLOSED" &&
        trade.mode === this.store.state.mode &&
        Date.parse(trade.exitedAt || trade.exitTime || "") >= cutoff
    );
    const executed = Math.max(count("executedTrade"), 1);
    return {
      qualifiedCandidatesPerHour: count("qualifiedCandidate"),
      candidateCountPerHour: count("scanCandidate"),
      rejectedCandidatesPerHour: count("scanRejected"),
      acceptedCandidatesPerHour: count("scanAccepted"),
      executedTradesPerHour: count("executedTrade"),
      rejectedNegativeNetEdgePerHour: count("rejectedNegativeNetEdge"),
      rejectedRiskBudgetPerHour: count("rejectedRiskBudget"),
      continuationEntriesPerHour: count("continuationEntry"),
      edgeApprovedCandidatesPerHour: count("edgeApprovedCandidate"),
      netPnlPerExecutedTrade: Number(
        (closed.reduce((total, trade) => total + numeric(trade.netPnlAfterCostsUsdt, numeric(trade.pnlUsdt)), 0) / executed).toFixed(6)
      ),
    };
  }

  liveValidationPromotionStatus(unresolvedReason = this.unresolvedExecutionStateReason()) {
    if (!this.config.liveValidationMode) return null;
    const evaluation = promotionEvaluation({
      config: this.config,
      state: this.store.state,
      trades: this.store.trades,
      executionLedger: this.executionLedger,
      openPositions: this.store.state.openPositions,
      unresolvedReason,
    });
    if (!this.store.state.liveValidation) this.store.state.liveValidation = {};
    this.store.state.liveValidation.level = evaluation.level;
    this.store.state.liveValidation.allocatedEquityLimitUsdt = evaluation.allocatedEquityLimitUsdt;
    this.store.state.liveValidation.promotionEligible = evaluation.eligible;
    this.store.state.liveValidation.promotionBlockedReasons = evaluation.blockedReasons;
    this.store.state.liveValidation.lastPromotionCheckedAt = new Date().toISOString();
    if (evaluation.eligible && this.config.liveValidationPromotionEnabled) {
      this.store.state.liveValidation.level = evaluation.nextLevel;
      this.store.state.liveValidation.allocatedEquityLimitUsdt = evaluation.nextAllocatedEquityLimitUsdt;
      this.store.state.liveValidation.lastPromotedAt = new Date().toISOString();
      this.log("WARN", "PROMOTION_ELIGIBLE", {
        fromLevel: evaluation.level,
        toLevel: evaluation.nextLevel,
        allocatedEquityLimitUsdt: evaluation.nextAllocatedEquityLimitUsdt,
        verifiedNetPnlUsdt: evaluation.summary.netPnlUsdt,
        profitFactor: evaluation.summary.profitFactor,
      });
    } else {
      this.log("INFO", evaluation.eligible ? "PROMOTION_ELIGIBLE" : "PROMOTION_BLOCKED_REASON", {
        liveValidationLevel: evaluation.level,
        allocatedEquityLimitUsdt: evaluation.allocatedEquityLimitUsdt,
        promotionEnabled: evaluation.promotionEnabled,
        eligible: evaluation.eligible,
        blockedReasons: evaluation.blockedReasons,
        closedTrades: evaluation.summary.closedTrades,
        netPnlUsdt: evaluation.summary.netPnlUsdt,
        profitFactor: evaluation.summary.profitFactor,
      });
    }
    this.store.saveState();
    return evaluation;
  }

  liveValidationRiskStatus(unresolvedReason = this.unresolvedExecutionStateReason()) {
    if (!this.config.liveValidationMode) return null;
    const status = riskStateEvaluation({
      config: this.config,
      state: this.store.state,
      trades: this.store.trades,
      openPositions: this.store.state.openPositions,
      unresolvedReason,
      trueApiFailure: Number(this.store.state.consecutiveApiErrors || 0) >= this.config.maxConsecutiveApiErrors,
    });
    if (!this.store.state.liveValidation) this.store.state.liveValidation = {};
    this.store.state.liveValidation.riskState = status.state;
    this.store.state.liveValidation.riskStateReasons = status.reasons;
    this.store.state.liveValidation.drawdownLimitUsdt = status.drawdownLimitUsdt;
    this.store.state.liveValidation.lastRiskCheckedAt = new Date().toISOString();
    this.store.saveState();
    if (status.state === "RISK_STATE_REDUCED") {
      this.log("WARN", "LIVE_VALIDATION_RISK_STATE_REDUCED", {
        reasons: status.reasons,
        riskMultiplier: status.riskMultiplier,
        scanningContinuesAtFullSpeed: true,
        arbitraryTradeBlocking: false,
      });
    }
    if (status.state === "RISK_STATE_PROTECTION_ONLY") {
      this.log("ERROR", "HUMAN_REVIEW_REQUIRED", {
        riskState: status.state,
        reasons: status.reasons,
        newEntriesBlocked: true,
        positionMonitoringContinues: true,
      });
    }
    return status;
  }

  profitControlledRiskStatus(currentEquityUsdt = numeric(this.store.state.equity && this.store.state.equity.currentUsdt), unresolvedReason = this.unresolvedExecutionStateReason()) {
    if (!this.config.profitControlledEquityMode) return null;
    const status = profitControlledRiskState({
      config: this.config,
      state: this.store.state,
      currentEquityUsdt,
      openPositions: this.store.state.openPositions,
      unresolvedReason,
      trueApiFailure: Number(this.store.state.consecutiveApiErrors || 0) >= this.config.maxConsecutiveApiErrors,
    });
    const profile = ensureProfitControlledState(this.store.state, this.config);
    profile.riskState = status.state;
    profile.riskStateReasons = status.reasons;
    profile.drawdownPct = status.drawdownPct;
    profile.lastRiskCheckedAt = new Date().toISOString();
    this.store.saveState();
    if (status.state === "RISK_STATE_REDUCED") {
      this.log("WARN", "PROFIT_CONTROLLED_RISK_STATE_REDUCED", {
        reasons: status.reasons,
        riskMultiplier: status.riskMultiplier,
        scanningContinuesAtFullSpeed: status.allowScanning,
        arbitraryTradeBlocking: false,
      });
    }
    if (status.state === "RISK_STATE_STRONG_ONLY") {
      this.log("WARN", "PROFIT_CONTROLLED_RISK_STATE_STRONG_ONLY", {
        reasons: status.reasons,
        riskMultiplier: status.riskMultiplier,
        scanningContinuesAtFullSpeed: status.allowScanning,
        minimumTier: "STRONG_OR_ELITE",
      });
    }
    if (status.state === "RISK_STATE_PROTECTION_ONLY") {
      this.log("ERROR", "HUMAN_REVIEW_REQUIRED", {
        riskState: status.state,
        reasons: status.reasons,
        newEntriesBlocked: true,
        positionMonitoringContinues: true,
      });
    }
    return status;
  }

  liveValidationAllocatedEquity(accountEquityUsdt, availableBalanceUsdt) {
    if (!this.config.liveValidationMode) return Math.min(accountEquityUsdt, availableBalanceUsdt);
    return liveValidationAllocation(this.config, this.store.state, accountEquityUsdt, availableBalanceUsdt);
  }

  instrumentInfoForSignal(signal) {
    return this.instrumentRulesBySymbol.get(signal.symbol) || signal.info || {};
  }

  liveValidationRiskCapForSignal(signal, plan = null) {
    if (plan && Number.isFinite(Number(plan.liveValidationRiskCapPct))) return Number(plan.liveValidationRiskCapPct);
    if (signal.eliteSetup || signal.tradeCategory === "ELITE_SETUP" || signal.convictionTier === "TIER_3_ELITE_SETUP") {
      return this.config.liveValidationEliteRiskAtStopMaxPct;
    }
    if (signal.eliteContinuationCandidate || signal.convictionTier === "TIER_2_STRONG_SETUP") {
      return this.config.liveValidationStrongRiskAtStopMaxPct;
    }
    if (signal.explorationTrade || signal.tradeCategory === "EXPLORATION") return this.config.liveValidationExplorationRiskAtStopMaxPct;
    return this.config.liveValidationNormalRiskAtStopMaxPct;
  }

  profitControlledRiskCapForSignal(signal, plan = null) {
    if (plan && Number.isFinite(Number(plan.profitControlledRiskCapPct))) return Number(plan.profitControlledRiskCapPct);
    return profitControlledRiskCapPct(this.config, earnedRiskTier(signal));
  }

  activeEntryRiskCapForSignal(signal, plan = null) {
    if (this.config.profitControlledEquityMode) return this.profitControlledRiskCapForSignal(signal, plan);
    if (this.config.liveValidationMode) return this.liveValidationRiskCapForSignal(signal, plan);
    return Number(plan && plan.riskPct) || this.config.normalRiskAtStopMaxPct;
  }

  logProfitControlledPreMutationRejection(signal, reason, details = {}) {
    if (!this.config.profitControlledEquityMode) return;
    this.log("INFO", "ENTRY_REJECTED_BEFORE_ANY_EXCHANGE_MUTATION", {
      symbol: signal && signal.symbol,
      side: signal && signal.side,
      reason,
      leverageMutationDeferred: true,
      orderMutationSubmitted: false,
      ...details,
    });
  }

  liveValidationOrderFeasibility(signal, plan, allocatedEquity, edgeModel = null) {
    if (!this.config.liveValidationMode && !this.config.profitControlledEquityMode) return { rejected: false };
    const info = this.instrumentInfoForSignal(signal);
    const lot = info.lotSizeFilter || {};
    const priceFilter = info.priceFilter || {};
    const price = Number(signal.price || plan.entryPrice || 0);
    const step = Number(lot.qtyStep || 0);
    const minOrderQty = Number(lot.minOrderQty || 0);
    const minNotionalValue = Number(lot.minNotionalValue || lot.minOrderAmt || 0);
    const tickSize = Number(priceFilter.tickSize || 0);
    const stopDistancePct = Number(signal.stopDistancePct || this.config.stopLossPct);
    const riskLimitPct = Number(plan.riskPct || this.activeEntryRiskCapForSignal(signal, plan));
    const allowedMaxLossAtStopUsdt = Number((allocatedEquity * (riskLimitPct / 100)).toFixed(6));
    if (!(price > 0) || !(step > 0) || !(minOrderQty > 0) || !(tickSize > 0)) {
      this.log("ERROR", "ORDER_BELOW_EXCHANGE_MINIMUM", {
        symbol: signal.symbol,
        reason: "instrument rule data incomplete",
        price,
        qtyStep: lot.qtyStep,
        minOrderQty: lot.minOrderQty,
        tickSize: priceFilter.tickSize,
      });
      return { rejected: true, reason: "instrument rule data incomplete; minimum order feasibility cannot be verified" };
    }
    const minQtyFromNotional = minNotionalValue > 0 ? minNotionalValue / price : 0;
    const minimumExecutableQty = roundedQuantity(Math.max(minOrderQty, minQtyFromNotional), step, true);
    const minimumExecutableNotional = minimumExecutableQty * price;
    const minimumExecutableMaxLossAtStopUsdt = minimumExecutableNotional * (stopDistancePct / 100);
    const plannedQty = roundedQuantity(Number(plan.size || 0), step, false);
    const plannedNotional = plannedQty * price;
    const finalRoundedMaxLossAtStopUsdt = plannedNotional * (stopDistancePct / 100);
    const estimatedEntryFeePct = Number(edgeModel && edgeModel.estimatedEntryFeePct) || this.config.estimatedTakerFeePctPerSide;
    const estimatedExitFeePct = Number(edgeModel && edgeModel.estimatedExitFeePct) || this.config.estimatedTakerFeePctPerSide;
    const estimatedFeesUsdt = plannedNotional * ((estimatedEntryFeePct + estimatedExitFeePct) / 100);
    const projectedNetResultUsdt =
      edgeModel && Number.isFinite(Number(edgeModel.expectedNetEdgePct))
        ? plannedNotional * (Number(edgeModel.expectedNetEdgePct) / 100)
        : Number(edgeModel && edgeModel.projectedNetProfitUsdt) || 0;
    const details = {
      symbol: signal.symbol,
      side: signal.side,
      setupType: signal.continuationSetupType || signal.setupType,
      earnedRiskTier: earnedRiskTier(signal),
      currentEquityUsdt: Number(allocatedEquity.toFixed(6)),
      price,
      tickSize,
      qtyStep: step,
      minOrderQty,
      minNotionalValue,
      minimumExecutableQty,
      exchangeMinimumExecutableQty: minimumExecutableQty,
      minimumExecutableNotional: Number(minimumExecutableNotional.toFixed(6)),
      exchangeMinimumNotionalUsdt: Number(minimumExecutableNotional.toFixed(6)),
      minimumExecutableMaxLossAtStopUsdt: Number(minimumExecutableMaxLossAtStopUsdt.toFixed(6)),
      minimumExecutableLossAtStopUsdt: Number(minimumExecutableMaxLossAtStopUsdt.toFixed(6)),
      plannedQty,
      finalOrderQty: plannedQty,
      plannedNotional: Number(plannedNotional.toFixed(6)),
      finalNotionalUsdt: Number(plannedNotional.toFixed(6)),
      marginRequiredUsdt: Number((plannedNotional / Number(plan.leverage || 1)).toFixed(6)),
      finalMarginRequiredUsdt: Number((plannedNotional / Number(plan.leverage || 1)).toFixed(6)),
      allowedMaxLossAtStopUsdt,
      maxAllowedLossAtStopUsdt: allowedMaxLossAtStopUsdt,
      riskLimitPct,
      estimatedFeesUsdt: Number(estimatedFeesUsdt.toFixed(6)),
      finalExpectedFeeUsdt: Number(estimatedFeesUsdt.toFixed(6)),
      projectedNetResultUsdt: Number(projectedNetResultUsdt.toFixed(6)),
      finalExpectedNetProfitUsdt: Number(projectedNetResultUsdt.toFixed(6)),
    };
    if (plannedQty < minimumExecutableQty || plannedNotional + Number.EPSILON < minNotionalValue) {
      this.log("WARN", "ORDER_BELOW_EXCHANGE_MINIMUM", {
        ...details,
        reason: "rounded planned order is below Bybit minimum quantity or notional",
      });
      if (minimumExecutableMaxLossAtStopUsdt > allowedMaxLossAtStopUsdt + 0.000001) {
        this.log("WARN", "ROUNDED_ORDER_EXCEEDS_RISK_LIMIT", {
          ...details,
          minimumExecutableMaxLossAtStopUsdt: Number(minimumExecutableMaxLossAtStopUsdt.toFixed(6)),
          finalRoundedMaxLossAtStopUsdt: Number(finalRoundedMaxLossAtStopUsdt.toFixed(6)),
          reason: "smallest executable Bybit order would exceed active validation risk limit",
        });
        return {
          rejected: true,
          reason: "smallest executable order exceeds active validation max-loss-at-stop limit",
          decision: "REJECTED",
          decisionReason: "smallest executable Bybit order would exceed active max-loss-at-stop limit",
          ...details,
        };
      }
      return {
        rejected: true,
        reason: "planned order is below exchange minimum; refusing silent size increase",
        decision: "REJECTED",
        decisionReason: "planned order is below exchange minimum; refusing silent size increase",
        ...details,
      };
    }
    if (finalRoundedMaxLossAtStopUsdt > allowedMaxLossAtStopUsdt + 0.000001) {
      this.log("WARN", "ROUNDED_ORDER_EXCEEDS_RISK_LIMIT", {
        ...details,
        finalRoundedMaxLossAtStopUsdt: Number(finalRoundedMaxLossAtStopUsdt.toFixed(6)),
        reason: "final rounded order exceeds active validation risk limit",
      });
      return {
        rejected: true,
        reason: "rounded order exceeds active validation max-loss-at-stop limit",
        decision: "REJECTED",
        decisionReason: "final rounded order exceeds active max-loss-at-stop limit",
        ...details,
      };
    }
    this.log("INFO", "FINAL_ROUNDED_MAX_LOSS_AT_STOP_USDT", {
      ...details,
      finalRoundedMaxLossAtStopUsdt: Number(finalRoundedMaxLossAtStopUsdt.toFixed(6)),
    });
    this.log("INFO", "LIVE_VALIDATION_ORDER_SIZE_FEASIBLE", {
      ...details,
      finalRoundedMaxLossAtStopUsdt: Number(finalRoundedMaxLossAtStopUsdt.toFixed(6)),
      notionalExposureUsdt: Number(plannedNotional.toFixed(6)),
      marginRequiredUsdt: Number((plannedNotional / Number(plan.leverage || 1)).toFixed(6)),
      maxLossAtStopUsdt: Number(finalRoundedMaxLossAtStopUsdt.toFixed(6)),
    });
    if (this.config.profitControlledEquityMode) {
      this.log("INFO", "PROFIT_CONTROLLED_ENTRY_FEASIBILITY_DECISION", {
        ...details,
        mode: "PROFIT_CONTROLLED_EQUITY_MODE",
        decision: "APPROVED",
        decisionReason: "final rounded order fits earned tier and exchange minimums",
        finalRoundedMaxLossAtStopUsdt: Number(finalRoundedMaxLossAtStopUsdt.toFixed(6)),
      });
    }
    return {
      rejected: false,
      decision: "APPROVED",
      decisionReason: "final rounded order fits earned tier and exchange minimums",
      ...details,
      finalRoundedMaxLossAtStopUsdt: Number(finalRoundedMaxLossAtStopUsdt.toFixed(6)),
    };
  }

  liveValidationEdgeExecutionDetails(signal, plan, edgeModel) {
    const notional = Number(plan.notional || 0);
    const entryFee = notional * (Number(edgeModel.estimatedEntryFeePct || 0) / 100);
    const exitFee = notional * (Number(edgeModel.estimatedExitFeePct || 0) / 100);
    const spreadSlippage = notional * ((Number(edgeModel.liveSpreadPct || 0) + Number(edgeModel.conservativeSlippagePct || 0)) / 100);
    const funding = notional * (Math.max(0, Number(edgeModel.estimatedFundingPct || 0)) / 100);
    return {
      setupType: signal.continuationSetupType || signal.setupType,
      symbol: signal.symbol,
      side: signal.side,
      expectedGrossMoveUsdt: Number(edgeModel.projectedGrossProfitUsdt || 0),
      expectedEntryFeeUsdt: Number(entryFee.toFixed(6)),
      expectedExitFeeUsdt: Number(exitFee.toFixed(6)),
      expectedSpreadAndSlippageUsdt: Number(spreadSlippage.toFixed(6)),
      expectedFundingUsdt: Number(funding.toFixed(6)),
      expectedTotalCostUsdt: Number(edgeModel.projectedTotalCostUsdt || 0),
      expectedNetProfitUsdt: Number(edgeModel.projectedNetProfitUsdt || 0),
      expectedRewardRiskRatio: Number(edgeModel.expectedRewardRiskRatio || 0),
      expectedRewardCostRatio: Number(edgeModel.expectedRewardCostRatio || 0),
      edgeGateResult: "APPROVED",
    };
  }

  writeLiveValidationStatusReport(force = false) {
    if (!this.config.liveValidationMode) return null;
    const intervalMs = 15 * 60 * 1000;
    if (!force && Date.now() - this.lastLiveValidationStatusAt < intervalMs) return null;
    const unresolvedReason = this.unresolvedExecutionStateReason();
    const riskStatus = this.liveValidationRiskStatus(unresolvedReason);
    const promotion = this.liveValidationPromotionStatus(unresolvedReason);
    const summary = summarizeTrades(this.store.trades);
    const activity = this.activityRates();
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "LIVE_VALIDATION",
      liveValidationLevel: this.store.state.liveValidation && this.store.state.liveValidation.level,
      allocatedEquityLimitUsdt: allocatedEquityLimitUsdt(this.config, this.store.state),
      equityCurrentlyUsedUsdt: Number(this.reservedMarginUsdt().toFixed(6)),
      totalOpenMaxLossAtStopRiskUsdt: Number(this.totalOpenRiskAtStopUsdt().toFixed(6)),
      tradesClosedInValidationRun: summary.closedTrades,
      netPnlAfterActualFeesUsdt: summary.netPnlUsdt,
      actualFeesUsdt: summary.actualFeesUsdt,
      grossPositiveButNetNegativeTradeCount: summary.grossPositiveButNetNegativeTrades,
      postCostWinRatePct: summary.postCostWinRatePct,
      profitFactor: summary.profitFactor,
      expectancyPerTradeUsdt: summary.expectancyUsdt,
      tradesPerHour: activity.executedTradesPerHour,
      bestPerformingSymbol: summary.bestSymbol,
      worstPerformingSymbol: summary.worstSymbol,
      flipTradeNetPnlUsdt: summary.flipNetPnlUsdt,
      reentryNetPnlUsdt: summary.reentryNetPnlUsdt,
      continuationNetPnlUsdt: summary.continuationNetPnlUsdt,
      currentRiskState: riskStatus && riskStatus.state,
      promotionEligibilityStatus: promotion
        ? { eligible: promotion.eligible, blockedReasons: promotion.blockedReasons, nextLevel: promotion.nextLevel }
        : null,
      activity,
    };
    const reportsDir = this.config.reportsDir || path.join(this.config.projectRoot, "data", "live-validation", "reports");
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(reportsDir, "daily"), { recursive: true });
    fs.writeFileSync(path.join(reportsDir, "latest-summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(reportsDir, "daily", `${today}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    this.lastLiveValidationStatusAt = Date.now();
    this.log("INFO", "LIVE_VALIDATION_STATUS_SUMMARY", report);
    return report;
  }

  updateNearMissStats(nearMisses = [], analyses = []) {
    const profile = ensureProfitControlledState(this.store.state, this.config);
    const stats = profile.nearMissStats || {
      tracked: 0,
      correctRejects: 0,
      missedOpportunities: 0,
      unresolved: 0,
      bySymbol: {},
      byRegime: {},
      pending: [],
      recent: [],
    };
    const latestBySymbol = new Map((analyses || []).map((item) => [item.symbol, item]));
    const stillPending = [];
    for (const miss of stats.pending || []) {
      const latest = latestBySymbol.get(miss.symbol);
      if (!latest || !(numeric(miss.price) > 0)) {
        stillPending.push(miss);
        continue;
      }
      const movePct = ((numeric(latest.price) - numeric(miss.price)) / numeric(miss.price)) * 100;
      const directionalMovePct = miss.direction === "LONG" ? movePct : -movePct;
      const favorableThreshold = Math.max(0.05, numeric(miss.expectedMovePct) * 0.45);
      const adverseThreshold = Math.max(0.05, this.config.stopLossPct * 0.35);
      if (directionalMovePct >= favorableThreshold) {
        stats.missedOpportunities += 1;
        stats.recent.push({ ...miss, observedAt: new Date().toISOString(), outcome: "MISSED_OPPORTUNITY", directionalMovePct: Number(directionalMovePct.toFixed(4)) });
      } else if (directionalMovePct <= -adverseThreshold) {
        stats.correctRejects += 1;
        stats.recent.push({ ...miss, observedAt: new Date().toISOString(), outcome: "CORRECT_REJECT", directionalMovePct: Number(directionalMovePct.toFixed(4)) });
      } else {
        stillPending.push(miss);
      }
    }
    for (const miss of nearMisses) {
      const key = `${miss.symbol}:${miss.direction}:${miss.regime}`;
      const record = {
        ...miss,
        key,
        trackedAt: miss.timestamp || new Date().toISOString(),
      };
      stats.tracked += 1;
      stats.bySymbol[miss.symbol] = (stats.bySymbol[miss.symbol] || 0) + 1;
      stats.byRegime[miss.regime || "UNKNOWN"] = (stats.byRegime[miss.regime || "UNKNOWN"] || 0) + 1;
      stats.recent.push(record);
      stillPending.push(record);
      this.log("INFO", "NEAR_MISS_TRACKED", {
        symbol: miss.symbol,
        direction: miss.direction,
        conviction: miss.conviction,
        regime: miss.regime,
        gap: miss.gap,
      });
    }
    stats.recent = stats.recent.slice(-100);
    stats.pending = stillPending.slice(-100);
    stats.unresolved = stats.pending.length;
    profile.nearMissStats = stats;
    this.store.saveState();
    return stats;
  }

  writeProfitControlledStatusReport(force = false) {
    if (!this.config.profitControlledEquityMode) return null;
    const intervalMs = 15 * 60 * 1000;
    if (!force && Date.now() - this.lastProfitControlledStatusAt < intervalMs) return null;
    const profile = ensureProfitControlledState(this.store.state, this.config);
    const currentEquity = numeric(profile.exchangeReportedTotalEquityUsdt, numeric(this.store.state.equity && this.store.state.equity.currentUsdt));
    const riskStatus = this.profitControlledRiskStatus(currentEquity);
    const activity = this.activityRates();
    const summary = profitControlledSummary(this.store.trades, currentEquity, numeric(profile.startEquityUsdt), activity);
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "PROFIT_CONTROLLED_EQUITY_MODE",
      currentExchangeEquityUsdt: summary.currentExchangeEquityUsdt,
      startOfRunEquityUsdt: summary.startOfRunEquityUsdt,
      sizingEquityBaseUsdt: numeric(profile.sizingEquityBaseUsdt),
      usableMarginUsdt: numeric(profile.usableMarginUsdt),
      realizedNetPnlAfterActualFeesUsdt: summary.netPnlUsdt,
      unrealizedPnlUsdt: summary.unrealizedPnlUsdt,
      actualFeesUsdt: summary.actualFeesUsdt,
      postCostWinRatePct: summary.postCostWinRatePct,
      profitFactor: summary.profitFactor,
      expectancyPerTradeUsdt: summary.expectancyUsdt,
      tradesPerHour: summary.tradesPerHour,
      candidatesFoundPerHour: summary.candidatesFoundPerHour,
      edgeApprovedCandidatesPerHour: summary.edgeApprovedCandidatesPerHour,
      riskMinimumRejectedCandidatesPerHour: summary.riskMinimumRejectedCandidatesPerHour,
      btcPerformanceUsdt: summary.bySymbol.BTCUSDT,
      ethPerformanceUsdt: summary.bySymbol.ETHUSDT,
      solPerformanceUsdt: summary.bySymbol.SOLUSDT,
      symbolPerformanceUsdt: summary.bySymbol,
      makerVersusTakerOutcome: summary.byExecutionType,
      continuationNetPnlUsdt: summary.continuationNetPnlUsdt,
      flipTradeNetPnlUsdt: summary.flipNetPnlUsdt,
      currentRiskState: riskStatus && riskStatus.state,
      remainingTotalStopRiskBudgetUsdt: Number(
        Math.max(0, numeric(profile.sizingEquityBaseUsdt) * (this.config.maxTotalOpenStopRiskPct / 100) - this.totalOpenRiskAtStopUsdt()).toFixed(6)
      ),
      totalOpenStopRiskUsdt: Number(this.totalOpenRiskAtStopUsdt().toFixed(6)),
    };
    const reportsDir = this.config.reportsDir || path.join(this.config.projectRoot, "data", "profit-controlled-live", "reports");
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(reportsDir, "daily"), { recursive: true });
    fs.writeFileSync(path.join(reportsDir, "latest-summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(reportsDir, "daily", `${today}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    this.writeProfitExpectancyReport();
    this.writeProfitSystemHealthReport();
    this.writeProfitEdgeReport();
    this.writeActivityReport(summary, activity);
    this.lastProfitControlledStatusAt = Date.now();
    this.log("INFO", "PROFIT_CONTROLLED_STATUS_SUMMARY", report);
    return report;
  }

  writeActivityReport(summary = null, activity = null) {
    if (!this.config.profitControlledEquityMode) return null;
    const reportsDir = this.config.reportsDir || path.join(this.config.projectRoot, "data", "profit-controlled-live", "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const rates = activity || this.activityRates();
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const tradesToday = this.store.trades.filter((trade) => {
      const openedAt = trade.openedAt || trade.entryTime || trade.createdAt || "";
      return String(openedAt).slice(0, 10) === today && !["ENTRY_FAILED", "FAILED", "REJECTED"].includes(String(trade.status || "").toUpperCase());
    }).length;
    const lastTradeMs = this.lastTradeOpenedAtMs();
    const inactiveHours = Number(((now - lastTradeMs) / 3600000).toFixed(4));
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "V11_ACTIVE_MARKET_ENGINE",
      tradesToday,
      tradesPerDay: Number((rates.executedTradesPerHour * 24).toFixed(4)),
      inactiveHours: Math.max(0, inactiveHours),
      candidateCount: rates.candidateCountPerHour,
      rejectedCount: rates.rejectedCandidatesPerHour,
      acceptedCount: rates.acceptedCandidatesPerHour,
      qualifiedCandidatesPerHour: rates.qualifiedCandidatesPerHour,
      executedTradesPerHour: rates.executedTradesPerHour,
      rejectedNegativeNetEdgePerHour: rates.rejectedNegativeNetEdgePerHour,
      rejectedRiskBudgetPerHour: rates.rejectedRiskBudgetPerHour,
      continuationEntriesPerHour: rates.continuationEntriesPerHour,
      netPnlPerExecutedTrade: rates.netPnlPerExecutedTrade,
      summary: summary || profitControlledSummary(this.store.trades, 0, 0, rates),
      safety: {
        feeProtectionActive: true,
        stopLossLogicUnchanged: true,
        portfolioCapsUnchanged: true,
        liquidationProtectionUnchanged: true,
      },
    };
    fs.writeFileSync(path.join(reportsDir, "activity-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    this.log("INFO", "ACTIVITY_REPORT_UPDATED", {
      file: path.join(reportsDir, "activity-report.json"),
      tradesToday: report.tradesToday,
      inactiveHours: report.inactiveHours,
      candidateCount: report.candidateCount,
      rejectedCount: report.rejectedCount,
      acceptedCount: report.acceptedCount,
    });
    return report;
  }

  writeProfitExpectancyReport() {
    if (!this.config.profitControlledEquityMode) return null;
    const reportsDir = this.config.reportsDir || path.join(this.config.projectRoot, "data", "profit-controlled-live", "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const report = profitExpectancyReport(this.store.trades, this.config);
    fs.writeFileSync(path.join(reportsDir, "expectancy.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    this.log("INFO", "PORTFOLIO_EXPECTANCY_REPORT_UPDATED", {
      file: path.join(reportsDir, "expectancy.json"),
      expectancyUsdt: report.expectancyUsdt,
      averageWinnerUsdt: report.averageWinnerUsdt,
      averageLoserUsdt: report.averageLoserUsdt,
      profitFactor: report.profitFactor,
      feeImpact: report.feeImpact,
      runnerImpact: report.runnerImpact,
      symbolRanking: report.symbolRanking.map((item) => ({
        symbol: item.symbol,
        weight: item.weight,
        rolling50NetPnlUsdt: item.rolling50.netPnlUsdt,
        rolling100NetPnlUsdt: item.rolling100.netPnlUsdt,
      })),
    });
    return report;
  }

  writeProfitSystemHealthReport() {
    if (!this.config.profitControlledEquityMode) return null;
    const reportsDir = this.config.reportsDir || path.join(this.config.projectRoot, "data", "profit-controlled-live", "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const report = profitSystemHealthReport(this.store.trades, this.config);
    const profile = this.store.state.profitControlled || {};
    report.nearMissStats = profile.nearMissStats || {
      tracked: 0,
      correctRejects: 0,
      missedOpportunities: 0,
      pending: [],
    };
    fs.writeFileSync(path.join(reportsDir, "system-health.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    this.log("INFO", "SYSTEM_HEALTH_REPORT_UPDATED", {
      file: path.join(reportsDir, "system-health.json"),
      expectancy: report.expectancy,
      profitFactor: report.profitFactor,
      feeDragRatio: report.feeDragRatio,
      bestSymbol: report.bestSymbol && report.bestSymbol.key,
      worstSymbol: report.worstSymbol && report.worstSymbol.key,
      runnerContribution: report.runnerContribution,
      nearMissStats: report.nearMissStats,
    });
    return report;
  }

  writeProfitEdgeReport() {
    if (!this.config.profitControlledEquityMode) return null;
    const reportsDir = this.config.reportsDir || path.join(this.config.projectRoot, "data", "profit-controlled-live", "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const report = profitEdgeReport(this.store.trades, this.config);
    fs.writeFileSync(path.join(reportsDir, "edge-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    this.log("INFO", "EDGE_REPORT_UPDATED", {
      file: path.join(reportsDir, "edge-report.json"),
      bestSetup: report.bestSetup && report.bestSetup.key,
      worstSetup: report.worstSetup && report.worstSetup.key,
      bestSetupRegime: report.bestSetupRegime && report.bestSetupRegime.key,
      worstSetupRegime: report.worstSetupRegime && report.worstSetupRegime.key,
      bestRegime: report.bestRegime && report.bestRegime.key,
      worstRegime: report.worstRegime && report.worstRegime.key,
      profitFactor: report.profitFactor,
      expectancy: report.expectancy,
      runnerContribution: report.runnerContribution,
      clusterRiskStatistics: report.clusterRiskStatistics,
      portfolioAlphaStatistics: report.portfolioAlphaStatistics,
      expectancyTrend: report.expectancyTrend,
      profitFactorTrend: report.profitFactorTrend,
    });
    return report;
  }

  async handleApiRecovery(error, options = {}) {
    const classification = classifyBybitError(error);
    if (classification.type === "IDEMPOTENT_SUCCESS_OR_NO_CHANGE") {
      this.log("INFO", "BYBIT_NO_CHANGE_TREATED_AS_SUCCESS", {
        source: options.source || "UNKNOWN",
        error: error.message,
        classification: classification.type,
        consecutiveApiErrors: this.store.state.consecutiveApiErrors,
        executionCyclePreserved: true,
        recoveryEscalationAvoided: true,
      });
      return;
    }
    const source = options.source || "UNKNOWN";
    const countError = options.countError !== false;
    const nonBlocking = Boolean(options.nonBlocking);
    if (countError) this.store.state.consecutiveApiErrors += 1;
    const consecutiveApiErrors = Number(this.store.state.consecutiveApiErrors || 0);
    const stage = Math.max(1, Math.min(5, nonBlocking ? Math.max(1, Math.min(2, consecutiveApiErrors || 1)) : consecutiveApiErrors || 1));
    const backoffMs = Math.min(
      this.config.apiRecoveryMaxBackoffMs,
      this.config.apiRecoveryBaseBackoffMs * 2 ** Math.max(0, stage - 1)
    );
    this.store.state.apiRecovery = {
      active: true,
      stage,
      source,
      lastError: error.message,
      lastTriggeredAt: new Date().toISOString(),
      consecutiveApiErrors,
      shutdownSuppressed: true,
    };
    this.store.saveState();

    if (!this.config.apiAutoRecoveryEnabled) {
      this.log("WARN", "API auto-recovery disabled, but shutdown on repeated API errors is still suppressed.", {
        source,
        error: error.message,
        consecutiveApiErrors,
        nonstopExecutionPreserved: true,
      });
      return;
    }

    if (this.apiRecoveryActive && nonBlocking) {
      this.log("DEBUG", "API recovery already active; partial scan recovery signal coalesced.", {
        source,
        error: error.message,
      });
      return;
    }

    this.apiRecoveryActive = true;
    this.log("WARN", "API auto-recovery triggered.", {
      source,
      stage,
      error: error.message,
      consecutiveApiErrors,
      maxConsecutiveApiErrorsBeforeEscalation: this.config.maxConsecutiveApiErrors,
      automaticShutdownRemoved: true,
      backoffMs: nonBlocking ? 0 : backoffMs,
    });

    const now = Date.now();
    if (now - this.lastApiRecoveryNoticeAt > 60000) {
      this.lastApiRecoveryNoticeAt = now;
      await this.telegram.send(`API auto-recovery triggered (${source}, stage ${stage}): ${error.message}`);
    }

    try {
      if (!nonBlocking) {
        this.log("INFO", "API recovery stage 1: retry request after backoff.", { backoffMs });
        await sleep(backoffMs);
      }
      if (stage >= 2) {
        this.log("WARN", "API recovery stage 2: websocket reconnect requested.", { source });
        if (typeof this.client.reconnectWebSockets === "function") {
          this.client.reconnectWebSockets(`api recovery stage ${stage}`);
        }
      }
      if (stage >= 3) {
        this.log("WARN", "API recovery stage 3: refreshing REST session caches.", { source });
        if (typeof this.client.refreshSession === "function") this.client.refreshSession();
        if (!this.config.dryRun && typeof this.client.getUsdtBalance === "function") {
          await this.client.getUsdtBalance();
        }
      }
      if (stage >= 4) {
        this.log("WARN", "API recovery stage 4: rebuilding exchange state.", { source });
        await this.rebuildExchangeState();
      }
      if (stage >= 5) {
        this.log("WARN", "API recovery stage 5: continuous execution resume after full state rebuild.", {
          source,
          catastrophicStopOnly: true,
        });
      }
      this.store.state.apiRecovery = {
        active: false,
        stage,
        source,
        lastError: error.message,
        recoveredAt: new Date().toISOString(),
        consecutiveApiErrors,
        shutdownSuppressed: true,
      };
      this.store.saveState();
      this.log("INFO", "Execution resumed automatically.", {
        source,
        stage,
        consecutiveApiErrors,
        nextScanIntervalMs: this.config.scanIntervalMs,
        nonstopExecutionPreserved: true,
      });
    } catch (recoveryError) {
      this.store.state.apiRecovery = {
        active: true,
        stage,
        source,
        lastError: error.message,
        recoveryError: recoveryError.message,
        lastFailedAt: new Date().toISOString(),
        shutdownSuppressed: true,
      };
      this.store.saveState();
      this.log("ERROR", "API auto-recovery step failed; bot will keep retrying on the next cycle.", {
        source,
        stage,
        error: error.message,
        recoveryError: recoveryError.message,
        automaticShutdownRemoved: true,
      });
    } finally {
      this.apiRecoveryActive = false;
    }
  }

  async rebuildExchangeState() {
    const tickerResults = [];
    for (const symbol of this.config.focusedTradingSymbolsList) {
      try {
        if (typeof this.client.getTicker === "function") {
          const ticker = await this.client.getTicker(symbol);
          tickerResults.push({ symbol, ok: Boolean(ticker) });
        }
      } catch (error) {
        tickerResults.push({ symbol, ok: false, error: error.message });
      }
    }
    if (!this.config.dryRun && typeof this.client.getPositions === "function") {
      await this.reconcileLivePositions();
    }
    this.log("WARN", "Exchange state rebuilt.", {
      tickers: tickerResults,
      liveReconciled: !this.config.dryRun,
      openPositions: this.store.state.openPositions.length,
    });
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
      this.risk.continuousRecoveryStatus(equity);
    } catch (error) {
      this.log("ERROR", "Fast position-protection monitor failed.", { error: error.message });
      await this.telegram.send(`Position monitor error: ${error.message}`);
      await this.handleApiRecovery(error, { source: "POSITION_MONITOR", countError: true, nonBlocking: true });
    } finally {
      this.monitorActive = false;
      this.schedulePositionMonitor();
    }
  }

  async openBestCandidates(candidates, equity, profitProtection = null, recoveryStatus = null) {
    const adaptivePolicy = this.adaptive.currentPolicy();
    const protection = profitProtection || { active: false, riskMultiplier: 1, leverageMultiplier: 1, explorationMultiplier: 1, signalAdjustment: 0 };
    const recovery = recoveryStatus || { active: false, riskMultiplier: 1, leverageMultiplier: 1, signalAdjustment: 0 };
    const liveValidationRisk = this.config.liveValidationMode ? this.liveValidationRiskStatus() : null;
    const profitControlledRisk = this.config.profitControlledEquityMode ? this.profitControlledRiskStatus(equity) : null;
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
      if (!this.config.focusedTradingSymbols.has(signal.symbol)) {
        this.log("WARN", "Candidate rejected outside focused BTC/ETH/SOL universe.", {
          symbol: signal.symbol,
          allowedSymbols: this.config.focusedTradingSymbolsList,
        });
        continue;
      }
      if (this.config.profitControlledEquityMode && this.config.profitExpansionMode) {
        signal.explorationTrade = false;
        signal.forcedMarketSampling = false;
        signal.explorationExpansionActive = false;
        signal.adaptivePolicyMode = "PROFIT_MODE";
      }
      if (signal.explorationTrade) {
        const dailyExplorationTrades = Number(this.store.state.daily.explorationTrades || 0);
        const explorationBudget = adaptivePolicy.explorationBudget;
        this.log("INFO", "Exploration execution approved; no daily exploration budget is enforced.", {
          symbol: signal.symbol,
          dailyExplorationTrades,
          explorationOpenedThisCycle,
          explorationBudgetReference: Number.isFinite(explorationBudget) ? explorationBudget : "unlimited",
          profitProtectionActive: protection.active,
          aggressiveLearningPhase: this.config.aggressiveLearningPhase,
        });
        this.log("INFO", "Adaptive exploration active for candidate.", {
          symbol: signal.symbol,
          side: signal.side,
          score: signal.score,
          convictionScore: signal.convictionScore,
          explorationMinScore: adaptivePolicy.explorationMinSignalScore,
          explorationMinConviction: adaptivePolicy.explorationMinConvictionScore,
          explorationRequiredScore: signal.explorationRequiredScore,
          explorationRequiredConvictionScore: signal.explorationRequiredConvictionScore,
          explorationThresholdSoftened: signal.explorationThresholdSoftened,
          explorationMemoryRelaxation: signal.explorationMemoryRelaxation,
          waivedStrictRejections: signal.explorationWaivedRejections,
        });
        if (signal.explorationThresholdSoftened) {
          this.log("INFO", "Exploration threshold softened for adaptive probing.", {
            symbol: signal.symbol,
            requiredScore: signal.explorationRequiredScore,
            requiredConvictionScore: signal.explorationRequiredConvictionScore,
            activityFloorEngaged: adaptivePolicy.activityFloorEngaged,
          });
        }
        if (signal.explorationMemoryRelaxation) {
          this.log("INFO", "Exploration memory relaxation active.", {
            symbol: signal.symbol,
            restoredScorePoints: signal.explorationMemoryRelaxation,
            adaptiveScoreAdjustment: signal.adaptiveScoreAdjustment,
            convictionScore: signal.convictionScore,
          });
        }
        if (signal.forcedMarketSampling) {
          this.log("WARN", "Forced market sampling engaged for exploratory learning trade.", {
            symbol: signal.symbol,
            side: signal.side,
            inactiveMinutes: signal.forcedSamplingInactiveMinutes,
            originalRejections: signal.forcedSamplingOriginalRejections,
            projectedNetEdgePct: signal.projectedNetEdgePct,
            feeEdgeRatio: signal.feeEdgeRatio,
          });
        }
      }
      if (signal.moderateChopAccepted) {
        this.log("INFO", "Moderate chop accepted for controlled participation.", {
          symbol: signal.symbol,
          side: signal.side,
          antiChopScore: signal.antiChopScore,
          maxChopScore: this.config.maxChopScore,
          volumeCondition: signal.volumeCondition,
          projectedNetEdgePct: signal.projectedNetEdgePct,
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
        eliteSetup: signal.eliteSetup,
        marketPersonality: signal.marketPersonality,
        continuationSetupType: signal.continuationSetupType,
        continuationStrength: signal.continuationStrength,
        macroTrend: signal.trend1h,
        macroAligned: signal.macroAligned,
        multiTimeframeTrendScore: signal.multiTimeframeTrendScore,
        multiTimeframeDirections: signal.multiTimeframeDirections,
        marketBreadthScore: signal.marketBreadthScore,
        marketBreadthDirections: signal.marketBreadthDirections,
        marketRegimeV2: signal.marketRegimeV2,
        marketRegimeV2Participation: signal.marketRegimeV2Participation,
        adaptiveConvictionThreshold: signal.adaptiveConvictionThreshold,
        highActivityContinuation: signal.highActivityContinuation,
        eliteContinuationCandidate: signal.eliteContinuationCandidate,
        explorationTrade: signal.explorationTrade,
        forcedMarketSampling: signal.forcedMarketSampling,
        explorationThresholdSoftened: signal.explorationThresholdSoftened,
        moderateChopAccepted: signal.moderateChopAccepted,
        regime: signal.regime,
        marketRegimeType: signal.marketRegimeType,
        marketRegimeTags: signal.marketRegimeTags,
        marketRegimeConfidence: signal.marketRegimeConfidence,
        sessionRegime: signal.sessionRegime,
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
        smartProjectedNetEdgePct: Number(signal.smartProjectedNetEdgePct || 0).toFixed(3),
        estimatedTpProbability: signal.estimatedTpProbability,
        estimatedRoundTripFeePct: signal.roundTripFeePct.toFixed(3),
        btcTrend: signal.btcTrend,
        ethTrend: signal.ethTrend,
        btcTrendStrength: signal.btcTrendStrength,
        btcVolatilityPct: signal.btcVolatilityPct,
        btcInstability: signal.btcInstability,
      });
      await this.telegram.send(`Candidate selected: ${signal.symbol} ${signal.side}, score ${signal.score}.`);
      if (signal.marketPersonality && signal.marketPersonality !== this.lastMarketPersonality) {
        this.log("INFO", "Adaptive market personality switched.", {
          from: this.lastMarketPersonality,
          to: signal.marketPersonality,
          symbol: signal.symbol,
          marketRegimeTags: signal.marketRegimeTags,
        });
        this.lastMarketPersonality = signal.marketPersonality;
      }
      if (this.intelligentReentrySignal(signal)) {
        signal.intelligentReentryTriggered = true;
        this.log("WARN", "Intelligent re-entry triggered.", {
          symbol: signal.symbol,
          side: signal.side,
          score: signal.score,
          projectedNetEdgePct: signal.projectedNetEdgePct,
          smartProjectedNetEdgePct: signal.smartProjectedNetEdgePct,
          momentumPersistenceCandles: signal.momentumPersistenceCandles,
          continuationSetupType: signal.continuationSetupType,
          continuationStrength: signal.continuationStrength,
          macroAligned: signal.macroAligned,
        });
      }
      if (signal.eliteContinuationCandidate) {
        this.log("WARN", "Elite continuation detected; high activity mode is prioritizing trend-following participation.", {
          symbol: signal.symbol,
          side: signal.side,
          score: signal.score,
          convictionScore: signal.convictionScore,
          momentumPersistenceCandles: signal.momentumPersistenceCandles,
          continuationSetupType: signal.continuationSetupType,
          continuationStrength: signal.continuationStrength,
          volumeSpike: signal.volumeSpike,
          marketPersonality: signal.marketPersonality,
        });
      }
      const block = this.risk.entryBlockReason(equity, signal.symbol);
      if (block) {
        this.log("INFO", "Candidate entry rejected by portfolio safety rule.", { symbol: signal.symbol, reason: block });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: block });
        this.recordRejectedTrade(signal, block, { stage: "PORTFOLIO_SAFETY" });
        continue;
      }
      if (liveValidationRisk && liveValidationRisk.state === "RISK_STATE_PROTECTION_ONLY") {
        this.log("ERROR", "Candidate rejected by live-validation protection-only state.", {
          symbol: signal.symbol,
          side: signal.side,
          reasons: liveValidationRisk.reasons,
          scanningContinues: true,
          newEntriesBlockedUntilHumanReview: true,
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: "LIVE_VALIDATION_PROTECTION_ONLY" });
        this.recordRejectedTrade(signal, "LIVE_VALIDATION_PROTECTION_ONLY", { stage: "PORTFOLIO_SAFETY" });
        continue;
      }
      if (profitControlledRisk && profitControlledRisk.state === "RISK_STATE_PROTECTION_ONLY") {
        this.log("ERROR", "Candidate rejected by profit-controlled protection-only state.", {
          symbol: signal.symbol,
          side: signal.side,
          reasons: profitControlledRisk.reasons,
          scanningContinues: true,
          newEntriesBlockedUntilHumanReview: true,
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: "PROFIT_CONTROLLED_PROTECTION_ONLY" });
        this.recordRejectedTrade(signal, "PROFIT_CONTROLLED_PROTECTION_ONLY", { stage: "PORTFOLIO_SAFETY" });
        this.logProfitControlledPreMutationRejection(signal, "PROFIT_CONTROLLED_PROTECTION_ONLY", {
          riskState: profitControlledRisk.state,
          reasons: profitControlledRisk.reasons,
        });
        continue;
      }
      const protectionCheck = this.profitProtectionEntryCheck(signal, protection);
      if (protectionCheck.rejected) {
        this.log("INFO", "Candidate rejected by profit protection mode.", {
          symbol: signal.symbol,
          reason: protectionCheck.reason,
          dailyPnlPct: protection.pnlPct,
          requiredScore: protectionCheck.requiredScore,
          score: signal.score,
          convictionScore: signal.convictionScore,
        });
        this.recordRejectedTrade(signal, protectionCheck.reason, { stage: "PROFIT_PROTECTION" });
        continue;
      }
      signal.profitProtectionRiskMultiplier = protection.riskMultiplier;
      signal.profitProtectionLeverageMultiplier = protection.leverageMultiplier;
      signal.continuousRecoveryRiskMultiplier = recovery.riskMultiplier;
      signal.continuousRecoveryLeverageMultiplier = recovery.leverageMultiplier;
      signal.continuousRecoverySignalAdjustment = recovery.signalAdjustment;
      if (liveValidationRisk) {
        signal.liveValidationRiskState = liveValidationRisk.state;
        signal.liveValidationRiskMultiplier = liveValidationRisk.riskMultiplier;
      }
      if (profitControlledRisk) {
        signal.profitControlledRiskState = profitControlledRisk.state;
        signal.profitControlledRiskMultiplier = profitControlledRisk.riskMultiplier;
      }
      const profitControlledEarnedTier = this.config.profitControlledEquityMode ? earnedRiskTier(signal) : null;
      if (
        profitControlledRisk &&
        profitControlledRisk.requireStrongOrElite &&
        !this.config.profitExpansionMode &&
        !["STRONG_CONTINUATION", "ELITE_CONTINUATION"].includes(profitControlledEarnedTier)
      ) {
        this.log("INFO", "Candidate rejected by profit-controlled strong-only risk state.", {
          symbol: signal.symbol,
          side: signal.side,
          earnedRiskTier: profitControlledEarnedTier,
          riskState: profitControlledRisk.state,
          reasons: profitControlledRisk.reasons,
          scanningContinues: profitControlledRisk.allowScanning,
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: "PROFIT_CONTROLLED_STRONG_ONLY_TIER_REQUIRED" });
        this.recordRejectedTrade(signal, "PROFIT_CONTROLLED_STRONG_ONLY_TIER_REQUIRED", { stage: "RISK_STATE" });
        this.logProfitControlledPreMutationRejection(signal, "PROFIT_CONTROLLED_STRONG_ONLY_TIER_REQUIRED", {
          earnedRiskTier: profitControlledEarnedTier,
          riskState: profitControlledRisk.state,
        });
        continue;
      }
      if (recovery.active) {
        this.log("INFO", "Adaptive recovery mode active; losing streak handled without shutdown.", {
          symbol: signal.symbol,
          side: signal.side,
          dailyPnlPct: recovery.pnlPct,
          losingStreak: recovery.losingStreak,
          riskMultiplier: recovery.riskMultiplier,
          leverageMultiplier: recovery.leverageMultiplier,
          continuousExecutionMode: this.config.continuousExecutionMode,
        });
      }
      signal.qualityPacingActive = adaptivePolicy.qualityPacingActive;
      signal.qualityPacingReason = adaptivePolicy.qualityPacingReason;
      const flipCheck = this.flipEntryCheck(signal);
      if (flipCheck.rejected) {
        this.log("INFO", "Random flip rejected; opposite direction requires confirmed reversal or exceptional post-cost edge.", {
          symbol: signal.symbol,
          side: signal.side,
          reason: flipCheck.reason,
          previousSide: flipCheck.previousSide,
          secondsSincePreviousExit: flipCheck.secondsSincePreviousExit,
          continuationStrength: signal.continuationStrength,
          projectedNetEdgePct: signal.projectedNetEdgePct,
          smartProjectedNetEdgePct: signal.smartProjectedNetEdgePct,
          flipMinNetEdgePct: this.config.flipMinNetEdgePct,
          flipConfirmationMinStrength: this.config.flipConfirmationMinStrength,
        });
        this.recordRejectedTrade(signal, flipCheck.reason, { stage: "FLIP_FILTER" });
        continue;
      }
      const edgeCheck = this.feeAwareEntryCheck(signal);
      if (edgeCheck.rejected) {
        this.log("INFO", edgeCheck.microScalp ? "Micro-scalp filtered before execution." : "EDGE_GATE_REJECTED", {
          symbol: signal.symbol,
          reason: edgeCheck.reason,
          expectedMovePct: signal.expectedMovePct,
          estimatedRoundTripCostPct: signal.estimatedRoundTripCostPct,
          feeEdgeRatio: signal.feeEdgeRatio,
          projectedNetEdgePct: signal.projectedNetEdgePct,
          convictionScore: signal.convictionScore,
          requiredProjectedEdgePct: edgeCheck.requiredProjectedEdgePct,
          requiredEdgeToCostRatio: edgeCheck.requiredEdgeToCostRatio,
          expectedNetEdgeUsdt: edgeCheck.edgeModel && edgeCheck.edgeModel.projectedNetProfitUsdt,
          expectedTotalCostPct: edgeCheck.edgeModel && edgeCheck.edgeModel.expectedTotalCostPct,
          edgeReason: edgeCheck.reason,
          qualityPacingActive: adaptivePolicy.qualityPacingActive,
        });
        this.recordActivityEvent("rejectedNegativeNetEdge", { symbol: signal.symbol, reason: edgeCheck.reason });
        this.recordRejectedTrade(signal, edgeCheck.reason, { stage: "FEE_EDGE_GATE" });
        continue;
      }
      this.log("INFO", "EDGE_GATE_APPROVED", {
        symbol: signal.symbol,
        side: signal.side,
        projectedNetEdgePct: signal.projectedNetEdgePct,
        smartProjectedNetEdgePct: signal.smartProjectedNetEdgePct,
        expectedMovePct: signal.expectedMovePct,
        estimatedTpProbability: signal.estimatedTpProbability,
        feeEdgeRatio: signal.feeEdgeRatio,
        requiredSmartEdgePct: edgeCheck.requiredSmartEdgePct,
        expectedNetEdgePct: edgeCheck.edgeModel.expectedNetEdgePct,
        expectedTotalCostPct: edgeCheck.edgeModel.expectedTotalCostPct,
        expectedRewardCostRatio: edgeCheck.edgeModel.expectedRewardCostRatio,
        edgeTier: edgeCheck.edgeModel.tier,
      });
      const profitQuality = this.profitModeQualityCheck(signal, edgeCheck.edgeModel);
      if (profitQuality.rejected) {
        this.recordActivityEvent("rejectedNegativeNetEdge", { symbol: signal.symbol, reason: profitQuality.reason });
        this.recordRejectedTrade(signal, profitQuality.reason, { stage: "QUALITY_GATE" });
        this.logProfitControlledPreMutationRejection(signal, profitQuality.reason, {
          profitQualityScore: profitQuality.score,
          profitQualityTier: profitQuality.rawTier,
          qualityComponents: profitQuality.components,
        });
        continue;
      }
      if (
        profitControlledRisk &&
        profitControlledRisk.requireStrongOrElite &&
        !["STRONG", "ELITE"].includes(profitQuality.tier)
      ) {
        this.log("INFO", "Candidate rejected by profit-controlled strong-only risk state.", {
          symbol: signal.symbol,
          side: signal.side,
          profitQualityTier: profitQuality.tier,
          profitQualityScore: profitQuality.score,
          riskState: profitControlledRisk.state,
          reasons: profitControlledRisk.reasons,
          scanningContinues: profitControlledRisk.allowScanning,
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: "PROFIT_CONTROLLED_STRONG_ONLY_QUALITY_REQUIRED" });
        this.recordRejectedTrade(signal, "PROFIT_CONTROLLED_STRONG_ONLY_QUALITY_REQUIRED", { stage: "RISK_STATE" });
        this.logProfitControlledPreMutationRejection(signal, "PROFIT_CONTROLLED_STRONG_ONLY_QUALITY_REQUIRED", {
          profitQualityScore: profitQuality.score,
          profitQualityTier: profitQuality.tier,
          riskState: profitControlledRisk.state,
        });
        continue;
      }
      if (profitQuality.tier === "ELITE") {
        this.log("WARN", "V7_ELITE_QUALITY_SETUP_DETECTED", {
          symbol: signal.symbol,
          side: signal.side,
          qualityScore: profitQuality.score,
          qualityComponents: profitQuality.components,
          winnerAmplifierEnabled: this.config.winnerAmplifierEnabled,
        });
      } else if (profitQuality.tier === "STRONG") {
        this.log("INFO", "V7_STRONG_QUALITY_SETUP_ACCEPTED", {
          symbol: signal.symbol,
          side: signal.side,
          qualityScore: profitQuality.score,
          qualityComponents: profitQuality.components,
        });
      }
      this.recordActivityEvent("edgeApprovedCandidate", { symbol: signal.symbol, side: signal.side });
      const requestedLeverage = this.config.profitControlledEquityMode
        ? this.profitControlledLeverageForSignal(signal, adaptivePolicy)
        : this.adaptiveLeverageForSignal(signal, adaptivePolicy);
      if (this.config.profitControlledEquityMode) {
        this.log("INFO", "LEVERAGE_MUTATION_DEFERRED_UNTIL_FINAL_APPROVAL", {
          symbol: signal.symbol,
          side: signal.side,
          requestedLeverage,
          earnedRiskTier: earnedRiskTier(signal),
        });
      }
      const liveSafety = this.config.dryRun
        ? { leverage: requestedLeverage, availableBalanceUsdt: equity, balance: { equity, available: equity } }
        : this.config.profitControlledEquityMode
          ? await this.liveEntryPreflight(signal, equity, requestedLeverage)
          : await this.liveEntrySafety(signal, equity, requestedLeverage);
      if (liveSafety.rejected) {
        this.log("WARN", "Candidate rejected by live order safety check.", { symbol: signal.symbol, reason: liveSafety.reason });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: liveSafety.reason });
        this.recordRejectedTrade(signal, liveSafety.reason, { stage: "LIVE_SAFETY" });
        this.logProfitControlledPreMutationRejection(signal, liveSafety.reason);
        continue;
      }
      const profitControlledSnapshot =
        this.config.profitControlledEquityMode && !this.config.dryRun
          ? sizingEquityBaseFromBalance(liveSafety.balance || {}, this.reservedMarginUsdt())
          : null;
      if (profitControlledSnapshot) {
        const profile = ensureProfitControlledState(this.store.state, this.config);
        profile.exchangeReportedTotalEquityUsdt = profitControlledSnapshot.exchangeReportedTotalEquityUsdt;
        profile.usableMarginUsdt = profitControlledSnapshot.usableMarginUsdt;
        profile.sizingEquityBaseUsdt = profitControlledSnapshot.sizingEquityBaseUsdt;
        profile.lastSizingEquityBaseUsdt = profitControlledSnapshot.sizingEquityBaseUsdt;
        if (!(numeric(profile.startEquityUsdt) > 0) && profitControlledSnapshot.exchangeReportedTotalEquityUsdt > 0) {
          profile.startEquityUsdt = profitControlledSnapshot.exchangeReportedTotalEquityUsdt;
        }
        this.log("INFO", "EXCHANGE_REPORTED_TOTAL_EQUITY_USDT", {
          symbol: signal.symbol,
          equityUsdt: profitControlledSnapshot.exchangeReportedTotalEquityUsdt,
          source: "pre-entry preflight",
        });
        this.log("INFO", "USABLE_MARGIN_USDT", {
          symbol: signal.symbol,
          usableMarginUsdt: profitControlledSnapshot.usableMarginUsdt,
          source: "pre-entry preflight",
        });
        this.log("INFO", "SIZING_EQUITY_BASE_USDT", {
          symbol: signal.symbol,
          sizingEquityBaseUsdt: profitControlledSnapshot.sizingEquityBaseUsdt,
          source: "pre-entry preflight",
        });
      }
      const allocatedEquity =
        this.config.dryRun
          ? equity
          : this.config.profitControlledEquityMode
            ? profitControlledSnapshot.sizingEquityBaseUsdt
            : this.liveValidationAllocatedEquity(equity, liveSafety.availableBalanceUsdt);
      if (this.config.liveValidationMode && allocatedEquity <= 0) {
        this.log("ERROR", "Candidate rejected by live-validation allocation guard.", {
          symbol: signal.symbol,
          accountEquityUsdt: equity,
          availableBalanceUsdt: liveSafety.availableBalanceUsdt,
          allocationLimitUsdt: allocatedEquityLimitUsdt(this.config, this.store.state),
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: "LIVE_VALIDATION_ALLOCATION_EMPTY" });
        this.recordRejectedTrade(signal, "LIVE_VALIDATION_ALLOCATION_EMPTY", { stage: "ALLOCATION" });
        continue;
      }
      if (this.config.profitControlledEquityMode && allocatedEquity <= 0) {
        this.log("ERROR", "Candidate rejected by profit-controlled equity base guard.", {
          symbol: signal.symbol,
          exchangeReportedTotalEquityUsdt: profitControlledSnapshot && profitControlledSnapshot.exchangeReportedTotalEquityUsdt,
          usableMarginUsdt: profitControlledSnapshot && profitControlledSnapshot.usableMarginUsdt,
          sizingEquityBaseUsdt: allocatedEquity,
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: "PROFIT_CONTROLLED_EQUITY_BASE_EMPTY" });
        this.recordRejectedTrade(signal, "PROFIT_CONTROLLED_EQUITY_BASE_EMPTY", { stage: "ALLOCATION" });
        this.logProfitControlledPreMutationRejection(signal, "PROFIT_CONTROLLED_EQUITY_BASE_EMPTY");
        continue;
      }
      const plan = this.risk.sizingPlan(signal, allocatedEquity, signal.info, liveSafety.leverage);
      if (plan.rejected) {
        if ((this.config.liveValidationMode || this.config.profitControlledEquityMode) && /exchange minimum|below this symbol/i.test(String(plan.reason || ""))) {
          const minimumRiskCheck = this.liveValidationOrderFeasibility(
            signal,
            {
              size: "0",
              notional: 0,
              leverage: liveSafety.leverage,
              riskPct: this.activeEntryRiskCapForSignal(signal),
            },
            allocatedEquity,
            edgeCheck.edgeModel
          );
          this.log("INFO", this.config.profitControlledEquityMode ? "Profit-controlled minimum order feasibility rejected before entry." : "Live-validation minimum order feasibility rejected before entry.", {
            symbol: signal.symbol,
            reason: minimumRiskCheck.reason || plan.reason,
            exchangeMinimumNotional: plan.exchangeMinimumNotional,
            hardNotionalCap: plan.hardNotionalCap,
            earnedRiskTier: earnedRiskTier(signal),
          });
        }
        this.log("INFO", "Candidate rejected because risk-sized quantity is invalid.", {
          symbol: signal.symbol,
          reason: plan.reason,
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: plan.reason });
        this.recordRejectedTrade(signal, plan.reason, { stage: "SIZING" });
        this.logProfitControlledPreMutationRejection(signal, plan.reason, { earnedRiskTier: earnedRiskTier(signal) });
        continue;
      }
      signal.executionType = this.executionTypeForSignal(signal);
      const finalEdgeGate = edgeGate(this.config, signal, plan, allocatedEquity);
      if (finalEdgeGate.rejected) {
        this.log("INFO", "EDGE_GATE_REJECTED", {
          symbol: signal.symbol,
          side: signal.side,
          reason: finalEdgeGate.reason,
          edgeTier: finalEdgeGate.model.tier,
          expectedNetEdgePct: finalEdgeGate.model.expectedNetEdgePct,
          expectedNetEdgeUsdt: finalEdgeGate.model.projectedNetProfitUsdt,
          expectedTotalCostUsdt: finalEdgeGate.model.projectedTotalCostUsdt,
          projectedMaxLossAtStopUsdt: finalEdgeGate.model.projectedMaxLossAtStopUsdt,
          requirements: finalEdgeGate.requirements,
        });
        this.recordActivityEvent("rejectedNegativeNetEdge", { symbol: signal.symbol, reason: finalEdgeGate.reason });
        this.recordRejectedTrade(signal, finalEdgeGate.reason, { stage: "FINAL_EDGE_GATE" });
        this.logProfitControlledPreMutationRejection(signal, finalEdgeGate.reason, {
          expectedNetEdgeUsdt: finalEdgeGate.model.projectedNetProfitUsdt,
          expectedTotalCostUsdt: finalEdgeGate.model.projectedTotalCostUsdt,
          edgeTier: finalEdgeGate.model.tier,
        });
        continue;
      }
      if (this.config.profitControlledEquityMode && this.config.profitExpansionMode) {
        const rewardCost = Number(finalEdgeGate.model.expectedRewardCostRatio || 0);
        const projectedNetProfitUsdt = Number(finalEdgeGate.model.projectedNetProfitUsdt || 0);
        const projectedTotalCostUsdt = Number(finalEdgeGate.model.projectedTotalCostUsdt || 0);
        const minimumRewardCost = Math.max(this.config.profitModeMinRewardCostRatio, finalEdgeGate.requirements.minRewardCostRatio);
        const minimumNetProfitUsdt = projectedTotalCostUsdt * this.config.profitModeMinNetProfitToCostRatio;
        if (projectedNetProfitUsdt <= 0 || rewardCost < minimumRewardCost || projectedNetProfitUsdt < minimumNetProfitUsdt) {
          this.log("INFO", "FEE_KILLER_REJECTED_FINAL_SIZED_ENTRY", {
            symbol: signal.symbol,
            side: signal.side,
            projectedNetProfitUsdt,
            projectedTotalCostUsdt,
            expectedRewardCostRatio: rewardCost,
            minimumRewardCostRatio: minimumRewardCost,
            minimumNetProfitUsdt,
            noGrossPositiveNetNegativeIntentionalEntries: true,
          });
          this.recordActivityEvent("rejectedNegativeNetEdge", { symbol: signal.symbol, reason: "FEE_KILLER_FINAL_SIZED_ENTRY" });
          this.recordRejectedTrade(signal, "FEE_KILLER_FINAL_SIZED_ENTRY", { stage: "FEE_KILLER" });
          this.logProfitControlledPreMutationRejection(signal, "FEE_KILLER_FINAL_SIZED_ENTRY", {
            projectedNetProfitUsdt,
            projectedTotalCostUsdt,
            expectedRewardCostRatio: rewardCost,
          });
          continue;
        }
      }
      signal.edgeTier = finalEdgeGate.model.tier;
      signal.edgeModel = finalEdgeGate.model;
      const minimumOrderFeasibility = this.liveValidationOrderFeasibility(signal, plan, allocatedEquity, finalEdgeGate.model);
      if (minimumOrderFeasibility.rejected) {
        if (this.config.profitControlledEquityMode) {
          this.log("WARN", "PROFIT_CONTROLLED_ENTRY_FEASIBILITY_DECISION", {
            symbol: signal.symbol,
            side: signal.side,
            setupType: signal.continuationSetupType || signal.setupType,
            earnedRiskTier: earnedRiskTier(signal),
            currentEquityUsdt: allocatedEquity,
            maxAllowedLossAtStopUsdt: minimumOrderFeasibility.allowedMaxLossAtStopUsdt,
            exchangeMinimumExecutableQty: minimumOrderFeasibility.exchangeMinimumExecutableQty,
            exchangeMinimumNotionalUsdt: minimumOrderFeasibility.exchangeMinimumNotionalUsdt,
            minimumExecutableLossAtStopUsdt: minimumOrderFeasibility.minimumExecutableLossAtStopUsdt,
            finalOrderQty: minimumOrderFeasibility.finalOrderQty,
            finalNotionalUsdt: minimumOrderFeasibility.finalNotionalUsdt,
            finalMarginRequiredUsdt: minimumOrderFeasibility.finalMarginRequiredUsdt,
            finalExpectedFeeUsdt: minimumOrderFeasibility.finalExpectedFeeUsdt,
            finalExpectedNetProfitUsdt: minimumOrderFeasibility.finalExpectedNetProfitUsdt,
            decision: "REJECTED",
            decisionReason: minimumOrderFeasibility.reason,
          });
        }
        this.log("INFO", "Candidate rejected by live-validation minimum order feasibility check.", {
          symbol: signal.symbol,
          side: signal.side,
          reason: minimumOrderFeasibility.reason,
          allowedMaxLossAtStopUsdt: minimumOrderFeasibility.allowedMaxLossAtStopUsdt,
          minimumExecutableMaxLossAtStopUsdt: minimumOrderFeasibility.minimumExecutableMaxLossAtStopUsdt,
          finalRoundedMaxLossAtStopUsdt: minimumOrderFeasibility.finalRoundedMaxLossAtStopUsdt,
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: minimumOrderFeasibility.reason });
        this.recordRejectedTrade(signal, minimumOrderFeasibility.reason, { stage: "MINIMUM_ORDER_FEASIBILITY" });
        this.logProfitControlledPreMutationRejection(signal, minimumOrderFeasibility.reason, {
          allowedMaxLossAtStopUsdt: minimumOrderFeasibility.allowedMaxLossAtStopUsdt,
          minimumExecutableMaxLossAtStopUsdt: minimumOrderFeasibility.minimumExecutableMaxLossAtStopUsdt,
          finalRoundedMaxLossAtStopUsdt: minimumOrderFeasibility.finalRoundedMaxLossAtStopUsdt,
        });
        continue;
      }
      plan.finalRoundedMaxLossAtStopUsdt = minimumOrderFeasibility.finalRoundedMaxLossAtStopUsdt;
      plan.maxLossAtStopUsdt = minimumOrderFeasibility.finalRoundedMaxLossAtStopUsdt;
      const portfolioRisk = this.portfolioRiskCheck(signal, plan, allocatedEquity);
      if (portfolioRisk.rejected) {
        this.log(portfolioRisk.humanReviewRequired ? "ERROR" : "INFO", portfolioRisk.humanReviewRequired ? "HUMAN_REVIEW_REQUIRED" : "Candidate rejected by portfolio max loss-at-stop control.", {
          symbol: signal.symbol,
          side: signal.side,
          reason: portfolioRisk.reason,
          portfolioRisk,
        });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: portfolioRisk.reason });
        this.recordRejectedTrade(signal, portfolioRisk.reason, { stage: "PORTFOLIO_RISK" });
        this.logProfitControlledPreMutationRejection(signal, portfolioRisk.reason, portfolioRisk);
        continue;
      }
      if (
        this.reservedMarginUsdt() + plan.notional / plan.leverage >
        allocatedEquity * (this.config.maxTotalMarginUsagePct / 100)
      ) {
        this.log("INFO", "Candidate rejected by aggregate margin allocation cap.", { symbol: signal.symbol });
        this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: "AGGREGATE_MARGIN_CAP" });
        this.recordRejectedTrade(signal, "AGGREGATE_MARGIN_CAP", { stage: "PORTFOLIO_MARGIN" });
        this.logProfitControlledPreMutationRejection(signal, "AGGREGATE_MARGIN_CAP", {
          reservedMarginUsdt: this.reservedMarginUsdt(),
          requiredMarginUsdt: plan.notional / plan.leverage,
          allocatedEquityUsdt: allocatedEquity,
          maxTotalMarginUsagePct: this.config.maxTotalMarginUsagePct,
        });
        continue;
      }
      if (this.config.profitControlledEquityMode && !this.config.dryRun) {
        const leverageApproval = await this.finalizeLeverageAfterApproval(signal, requestedLeverage);
        if (leverageApproval.rejected) {
          this.log("ERROR", "Candidate rejected during final leverage approval.", {
            symbol: signal.symbol,
            side: signal.side,
            reason: leverageApproval.reason,
            finalApprovalReached: true,
          });
          this.recordActivityEvent("rejectedRiskBudget", { symbol: signal.symbol, reason: leverageApproval.reason });
          this.recordRejectedTrade(signal, leverageApproval.reason, { stage: "LEVERAGE_APPROVAL" });
          continue;
        }
        plan.leverage = leverageApproval.leverage;
        plan.marginUsedUsdt = Number((plan.notional / plan.leverage).toFixed(6));
      }
      const edgeExecutionDetails = this.liveValidationEdgeExecutionDetails(signal, plan, finalEdgeGate.model);
      this.log("INFO", "EDGE_GATE_APPROVED_WITH_EXECUTION_COSTS", {
        ...edgeExecutionDetails,
        allocatedEquityUsdt: Number(allocatedEquity.toFixed(6)),
        marginUsedUsdt: plan.marginUsedUsdt,
        notionalExposureUsdt: plan.notional,
        maxLossAtStopUsdt: plan.maxLossAtStopUsdt,
        riskPctOfEquity: plan.riskPctOfEquity,
        liveValidationMode: this.config.liveValidationMode,
      });
      if (plan.highQualityContinuation && plan.qualitySizeMultiplier > 1) {
        this.log("INFO", "High-conviction setup prioritized with adaptive size increase.", {
          symbol: signal.symbol,
          convictionScore: signal.convictionScore,
          liquidityScore: signal.liquidityScore,
          feeEdgeRatio: signal.feeEdgeRatio,
          qualitySizeMultiplier: plan.qualitySizeMultiplier,
          adaptiveRiskMultiplier: plan.adaptiveRiskMultiplier,
          maxLossAtStopUsdt: plan.maxLossAtStopUsdt,
          riskPctOfEquity: plan.riskPctOfEquity,
          totalOpenPortfolioRiskUsdt: portfolioRisk.currentRiskUsdt,
        });
        this.log("INFO", "High-quality setup prioritized.", {
          symbol: signal.symbol,
          convictionTier: plan.convictionTier,
          smartProjectedNetEdgePct: signal.smartProjectedNetEdgePct,
          multiTimeframeAligned: signal.multiTimeframeAligned,
          continuationSetupType: signal.continuationSetupType,
          continuationStrength: signal.continuationStrength,
        });
      }
      if (plan.eliteSetup) {
        this.log("WARN", "Elite setup detected; aggressive elite sizing activated.", {
          symbol: signal.symbol,
          side: signal.side,
          convictionTier: plan.convictionTier,
          targetMarginUsdt: plan.targetMarginUsdt,
          plannedNotionalUsdt: plan.notional,
          eliteConditionKey: signal.eliteConditionKey,
          smartProjectedNetEdgePct: signal.smartProjectedNetEdgePct,
          estimatedTpProbability: signal.estimatedTpProbability,
          continuationSetupType: signal.continuationSetupType,
          continuationStrength: signal.continuationStrength,
        });
        this.log("INFO", "High-confluence setup confirmed; adaptive conviction strong.", {
          symbol: signal.symbol,
          convictionScore: signal.convictionScore,
          adaptiveConfidence: signal.adaptiveConfidence,
          trendQualityScore: signal.trendQualityScore,
          volumeSpike: signal.volumeSpike,
          multiTimeframeAligned: signal.multiTimeframeAligned,
          macroAligned: signal.macroAligned,
        });
      } else if (plan.convictionTier === "TIER_2_STRONG_SETUP") {
        this.log("INFO", "Conviction tier upgraded for strong setup.", {
          symbol: signal.symbol,
          convictionTier: plan.convictionTier,
          targetMarginUsdt: plan.targetMarginUsdt,
          qualitySizeMultiplier: plan.qualitySizeMultiplier,
        });
      }
      if (adaptivePolicy.qualityPacingActive && plan.qualitySizeMultiplier < 1) {
        this.log("INFO", "Adaptive pacing engaged; position size reduced while keeping execution active.", {
          symbol: signal.symbol,
          qualitySizeMultiplier: plan.qualitySizeMultiplier,
          qualityPacingReason: adaptivePolicy.qualityPacingReason,
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
          forcedMarketSampling: signal.forcedMarketSampling,
          inactiveMinutesBeforeForcedSampling: signal.forcedSamplingInactiveMinutes,
          waivedStrictRejections: signal.explorationWaivedRejections,
        });
      }
      if (this.config.profitControlledEquityMode) {
        this.log("WARN", "FINAL_ENTRY_APPROVAL_COMPLETE", {
          symbol: signal.symbol,
          side: signal.side,
          setupType: signal.continuationSetupType || signal.setupType,
          tier: earnedRiskTier(signal),
          quantity: plan.size,
          notional: plan.notional,
          margin: plan.marginUsedUsdt,
          leverage: plan.leverage,
          stopRiskUsdt: plan.maxLossAtStopUsdt,
          stopRiskPct: plan.riskPctOfEquity,
          expectedFeesUsdt: finalEdgeGate.model.projectedTotalCostUsdt,
          expectedSlippageUsdt: Number(
            (plan.notional * ((Number(finalEdgeGate.model.liveSpreadPct || 0) + Number(finalEdgeGate.model.conservativeSlippagePct || 0)) / 100)).toFixed(6)
          ),
          expectedNetProfitUsdt: finalEdgeGate.model.projectedNetProfitUsdt,
          totalOpenRiskAfterEntryUsdt: Number((portfolioRisk.currentRiskUsdt + portfolioRisk.candidateRiskUsdt).toFixed(6)),
          correlatedOpenRiskAfterEntryUsdt: portfolioRisk.correlatedClusterRiskAfterEntryUsdt,
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
        forcedMarketSampling: signal.forcedMarketSampling,
        explorationThresholdSoftened: signal.explorationThresholdSoftened,
        moderateChopAccepted: signal.moderateChopAccepted,
        marketRegimeType: signal.marketRegimeType,
        marketRegimeTags: signal.marketRegimeTags,
        marketRegimeConfidence: signal.marketRegimeConfidence,
        sessionRegime: signal.sessionRegime,
        trigger: signal.fomoTrigger ? "FOMO_1M_MOMENTUM" : "SCORE_THRESHOLD",
        leverage: plan.leverage,
        plannedNotionalUsdt: plan.notional,
        convictionTier: plan.convictionTier,
        highActivityContinuation: signal.highActivityContinuation,
        eliteContinuationCandidate: signal.eliteContinuationCandidate,
        continuationSetupType: signal.continuationSetupType,
        continuationStrength: signal.continuationStrength,
        macroTrend: signal.trend1h,
        macroAligned: signal.macroAligned,
        targetMarginUsdt: plan.targetMarginUsdt,
        riskPct: plan.riskPct,
        qualitySizeMultiplier: plan.qualitySizeMultiplier,
        adaptiveRiskMultiplier: plan.adaptiveRiskMultiplier,
        entryPrice: signal.price,
        stopLossPrice: plan.stopLossPrice,
        takeProfitPrice: plan.takeProfitPrice,
        projectedNetEdgePct: signal.projectedNetEdgePct,
        expectedNetEdgeUsdt: finalEdgeGate.model.projectedNetProfitUsdt,
        expectedTotalCostUsdt: finalEdgeGate.model.projectedTotalCostUsdt,
        projectedMaxLossAtStopUsdt: finalEdgeGate.model.projectedMaxLossAtStopUsdt,
        totalOpenPortfolioRiskUsdt: portfolioRisk.currentRiskUsdt + portfolioRisk.candidateRiskUsdt,
        reasonsForSizingTier: plan.reasonsForSizingTier,
        smartProjectedNetEdgePct: signal.smartProjectedNetEdgePct,
        estimatedTpProbability: signal.estimatedTpProbability,
        expectedMovePct: signal.expectedMovePct,
        estimatedRoundTripCostPct: signal.estimatedRoundTripCostPct,
        feeEdgeRatio: signal.feeEdgeRatio,
        convictionScore: signal.convictionScore,
        estimatedRoundTripFeePct: signal.roundTripFeePct,
        momentumPersistenceCandles: signal.momentumPersistenceCandles,
        volatilityRegime: signal.volatilityRegime,
        volumeCondition: signal.volumeCondition,
        regimeRiskMultiplier: signal.regimeRiskMultiplier,
        profitProtectionRiskMultiplier: signal.profitProtectionRiskMultiplier,
        profitProtectionActive: protection.active,
        adaptiveReasons: signal.adaptiveReasons,
        scoreBreakdown: signal.scoreBreakdown,
      });
      await this.openPosition(signal, plan);
      this.recordActivityEvent("executedTrade", { symbol: signal.symbol, side: signal.side });
      if (/CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/i.test(String(signal.continuationSetupType || signal.setupType || ""))) {
        this.recordActivityEvent("continuationEntry", { symbol: signal.symbol, side: signal.side });
      }
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

  totalOpenRiskAtStopUsdt() {
    return this.store.state.openPositions.reduce((total, position) => total + Number(position.maxLossAtStopUsdt || 0), 0);
  }

  unresolvedExecutionStateReason() {
    if (this.apiRecoveryActive || (this.store.state.apiRecovery && this.store.state.apiRecovery.active)) {
      return "API recovery or exchange state rebuild is active";
    }
    const pending = this.store.state.openPositions.find((position) => PENDING_LIVE_ENTRY_STATUSES.has(position.status));
    if (pending) return `position reconciliation unresolved for ${pending.symbol}`;
    const unprotected = this.store.state.openPositions.find((position) => {
      const hasLocalStops = Number(position.stopLossPrice) > 0 && Number(position.takeProfitPrice) > 0;
      const liveProtectionUnknown = position.mode === "LIVE" && !position.nativeProtectionVerified;
      return !hasLocalStops || liveProtectionUnknown;
    });
    if (unprotected) return `existing ${unprotected.symbol} position is missing verified TP/SL protection`;
    return null;
  }

  portfolioRiskCheck(signal, plan, equity) {
    const unresolved = this.unresolvedExecutionStateReason();
    if (unresolved) {
      return { rejected: true, reason: unresolved, humanReviewRequired: true };
    }
    const currentRisk = this.totalOpenRiskAtStopUsdt();
    const candidateRisk = Number(plan.maxLossAtStopUsdt || 0);
    if (this.config.profitControlledEquityMode) {
      const totalBudgetPct = this.config.maxTotalOpenStopRiskPct;
      const clusterBudgetPct = this.config.maxCorrelatedClusterStopRiskPct;
      const totalBudgetUsdt = equity * (totalBudgetPct / 100);
      const sameDirectionRisk = this.store.state.openPositions
        .filter((position) => position.side === signal.side)
        .reduce((total, position) => total + Number(position.maxLossAtStopUsdt || 0), 0);
      const clusterAfter = sameDirectionRisk + candidateRisk;
      const clusterBudgetUsdt = equity * (clusterBudgetPct / 100);
      const totalAfter = currentRisk + candidateRisk;
      const base = {
        currentRiskUsdt: Number(currentRisk.toFixed(6)),
        candidateRiskUsdt: Number(candidateRisk.toFixed(6)),
        budgetUsdt: Number(totalBudgetUsdt.toFixed(6)),
        budgetPct: totalBudgetPct,
        correlatedClusterRiskUsdt: Number(sameDirectionRisk.toFixed(6)),
        correlatedClusterRiskAfterEntryUsdt: Number(clusterAfter.toFixed(6)),
        correlatedClusterBudgetUsdt: Number(clusterBudgetUsdt.toFixed(6)),
        correlatedClusterBudgetPct: clusterBudgetPct,
        remainingRiskBudgetUsdt: Number(Math.max(0, totalBudgetUsdt - currentRisk).toFixed(6)),
      };
      this.log("INFO", "TOTAL_OPEN_STOP_RISK_USDT", {
        value: base.currentRiskUsdt,
        candidateRiskUsdt: base.candidateRiskUsdt,
        afterEntryUsdt: Number(totalAfter.toFixed(6)),
      });
      this.log("INFO", "TOTAL_OPEN_STOP_RISK_PCT", {
        value: equity > 0 ? Number(((currentRisk / equity) * 100).toFixed(4)) : 0,
        afterEntryPct: equity > 0 ? Number(((totalAfter / equity) * 100).toFixed(4)) : 0,
        limitPct: totalBudgetPct,
      });
      this.log("INFO", "CORRELATED_CLUSTER_STOP_RISK_USDT", {
        side: signal.side,
        value: base.correlatedClusterRiskUsdt,
        afterEntryUsdt: base.correlatedClusterRiskAfterEntryUsdt,
        limitUsdt: base.correlatedClusterBudgetUsdt,
      });
      this.log("INFO", "REMAINING_RISK_BUDGET_USDT", {
        value: base.remainingRiskBudgetUsdt,
      });
      if (totalAfter > totalBudgetUsdt + 0.000001) {
        this.log("INFO", "ENTRY_REJECTED_CORRELATION_OR_RISK_BUDGET", {
          ...base,
          reason: "total open stop-risk budget exceeded",
        });
        return {
          rejected: true,
          reason: "total open stop-risk budget exceeded",
          ...base,
        };
      }
      if (clusterAfter > clusterBudgetUsdt + 0.000001) {
        this.log("INFO", "ENTRY_REJECTED_CORRELATION_OR_RISK_BUDGET", {
          ...base,
          reason: "correlated same-direction BTC/ETH/SOL stop-risk budget exceeded",
        });
        return {
          rejected: true,
          reason: "correlated same-direction BTC/ETH/SOL stop-risk budget exceeded",
          ...base,
        };
      }
      this.log("INFO", "ENTRY_APPROVED_WITHIN_PORTFOLIO_RISK", base);
      return {
        rejected: false,
        ...base,
      };
    }
    const explosive = signal.marketPersonality === "EXPLOSIVE_TRENDING" || signal.eliteSetup || signal.eliteContinuationCandidate;
    const budgetPct = explosive ? this.config.portfolioExplosiveMaxOpenRiskPct : this.config.portfolioMaxOpenRiskPct;
    const budgetUsdt = equity * (budgetPct / 100);
    if (currentRisk + candidateRisk > budgetUsdt) {
      return {
        rejected: true,
        reason: "portfolio max loss at stop budget exceeded",
        currentRiskUsdt: Number(currentRisk.toFixed(6)),
        candidateRiskUsdt: Number(candidateRisk.toFixed(6)),
        budgetUsdt: Number(budgetUsdt.toFixed(6)),
        budgetPct,
      };
    }
    return {
      rejected: false,
      currentRiskUsdt: Number(currentRisk.toFixed(6)),
      candidateRiskUsdt: Number(candidateRisk.toFixed(6)),
      budgetUsdt: Number(budgetUsdt.toFixed(6)),
      budgetPct,
    };
  }

  executionTypeForSignal(signal) {
    if (!this.config.enablePostOnlyEntries) {
      if (this.config.profitControlledEquityMode) {
        this.log("INFO", "EXECUTION_TYPE_SELECTED", {
          symbol: signal.symbol,
          executionType: "MARKET_TAKER",
          reason: "post-only entries disabled",
        });
      }
      return "MARKET_TAKER";
    }
    const setupType = String(signal.continuationSetupType || signal.setupType || "");
    const slowerStructure = /PULLBACK|RETEST/.test(setupType);
    const exceptionalMomentum = Boolean(signal.fomoTrigger || signal.eliteContinuationCandidate || signal.marketPersonality === "EXPLOSIVE_TRENDING");
    const rewardCost = Number(signal.edgeModel && signal.edgeModel.expectedRewardCostRatio);
    if (
      slowerStructure &&
      !exceptionalMomentum &&
      Number.isFinite(rewardCost) &&
      rewardCost >= this.config.edgeNormalMinRewardCostRatio + 0.25
    ) {
      this.log("INFO", "MAKER_ENTRY_PREFERRED", {
        symbol: signal.symbol,
        setupType,
        expectedRewardCostRatio: rewardCost,
        reason: "pullback/retest structure can wait for a lower-cost post-only fill",
      });
      this.log("INFO", "EXECUTION_TYPE_SELECTED", {
        symbol: signal.symbol,
        executionType: "POST_ONLY_LIMIT",
        makerOrTaker: "MAKER_INTENDED",
      });
      return "POST_ONLY_LIMIT";
    }
    if (this.config.profitControlledEquityMode && exceptionalMomentum) {
      this.log("INFO", "TAKER_URGENCY_JUSTIFIED", {
        symbol: signal.symbol,
        setupType,
        expectedRewardCostRatio: rewardCost,
        eliteContinuationCandidate: signal.eliteContinuationCandidate,
        fomoTrigger: signal.fomoTrigger,
        marketPersonality: signal.marketPersonality,
      });
    }
    if (this.config.profitControlledEquityMode) {
      this.log("INFO", "EXECUTION_TYPE_SELECTED", {
        symbol: signal.symbol,
        executionType: "MARKET_TAKER",
        makerOrTaker: "TAKER_INTENDED",
      });
    }
    return "MARKET_TAKER";
  }

  postOnlyEntryPrice(position, signal) {
    const tickSize = position.tickSize || (signal.info && signal.info.priceFilter && signal.info.priceFilter.tickSize);
    const spreadPct = Math.max(Number(signal.spreadPct || 0), 0.01);
    const offsetPct = Math.min(0.05, Math.max(0.005, spreadPct * 0.55));
    const rawPrice =
      position.side === "LONG"
        ? Number(position.entryPrice) * (1 - offsetPct / 100)
        : Number(position.entryPrice) * (1 + offsetPct / 100);
    return roundedPrice(rawPrice, tickSize, position.side === "SHORT");
  }

  lastTradeOpenedAtMs() {
    const currentMode = this.config.dryRun ? "DRY_RUN" : "LIVE";
    const openedTimes = this.store.trades
      .filter((trade) => trade.mode === currentMode && !["ENTRY_FAILED", "FAILED", "IGNORED_AFTER_MODE_CHANGE"].includes(trade.status))
      .map((trade) => Date.parse(trade.openedAt || trade.entryTime || ""))
      .filter(Number.isFinite);
    return openedTimes.length ? Math.max(...openedTimes) : this.startedAt;
  }

  candidatesWithForcedSampling(scan) {
    if (!this.config.learningPhaseMode || !this.config.forcedMarketSamplingEnabled) return scan.candidates;
    const inactiveMinutes = (Date.now() - this.lastTradeOpenedAtMs()) / 60000;
    if (inactiveMinutes < this.config.forcedMarketSamplingAfterMinutes) return scan.candidates;
    const existing = new Set(scan.candidates.map((candidate) => `${candidate.symbol}:${candidate.side}`));
    const forced = scan.analyses
      .filter((signal) => !existing.has(`${signal.symbol}:${signal.side}`))
      .filter((signal) => this.forcedSamplingEligible(signal))
      .sort((left, right) =>
        right.projectedNetEdgePct - left.projectedNetEdgePct ||
        right.convictionScore - left.convictionScore ||
        right.score - left.score
      )
      .slice(0, this.config.forcedSamplingMaxCandidates)
      .map((signal) => this.promoteForcedSamplingSignal(signal, inactiveMinutes));
    if (forced.length) {
      this.log("WARN", "Forced market sampling engaged.", {
        inactiveMinutes: Number(inactiveMinutes.toFixed(2)),
        promoted: forced.map((signal) => ({
          symbol: signal.symbol,
          side: signal.side,
          score: signal.score,
          convictionScore: signal.convictionScore,
          projectedNetEdgePct: signal.projectedNetEdgePct,
          originalRejections: signal.forcedSamplingOriginalRejections,
        })),
      });
      return [...scan.candidates, ...forced];
    }
    return scan.candidates;
  }

  forcedSamplingEligible(signal) {
    if (!signal) return false;
    if (!this.config.focusedTradingSymbols.has(signal.symbol)) return false;
    if (this.store.state.openPositions.some((position) => position.symbol === signal.symbol)) return false;
    if (signal.volatilityRegime === "NEWS_LIKE_ABNORMAL") return false;
    const adaptivePolicy = this.adaptive.currentPolicy();
    const edgeMultiplier = adaptivePolicy.qualityPacingActive ? this.config.qualityPacingEdgeMultiplier : 1;
    if (Number(signal.projectedNetEdgePct || 0) < this.config.forcedSamplingMinProjectedEdgePct * edgeMultiplier) return false;
    if (Number(signal.feeEdgeRatio || 0) < this.config.forcedSamplingMinEdgeToCostRatio * edgeMultiplier) return false;
    if (Number(signal.score || 0) < this.config.forcedSamplingMinScore) return false;
    if (Number(signal.convictionScore || 0) < this.config.forcedSamplingMinConviction) return false;
    const liquidityFloor = this.config.minLiquidityScore * (this.config.highActivityMode ? 0.55 : 0.65);
    if (Number(signal.liquidityScore || 0) < liquidityFloor) return false;
    const continuationClue =
      signal.fomoTrigger ||
      signal.breakoutTriggered ||
      Number(signal.continuationStrength || 0) >= this.config.continuationMinStrength ||
      ["PULLBACK_CONTINUATION", "BREAKOUT_RETEST", "MOMENTUM_RESUMPTION", "TREND_ACCELERATION", "CONTINUATION_BREAKOUT"].includes(signal.continuationSetupType) ||
      Number(signal.momentumPersistenceCandles || 0) >= this.config.minMomentumPersistenceCandles ||
      signal.highActivityContinuation ||
      (signal.btcTrendAligned && Number(signal.trendQualityScore || 0) >= (this.config.highActivityMode ? 52 : 58));
    if (!continuationClue) return false;
    if (Array.isArray(signal.rejected) && signal.rejected.some((reason) => /fee inefficiency|exchange minimum|blacklist/i.test(reason))) return false;
    return true;
  }

  intelligentReentrySignal(signal) {
    if (!signal || this.config.smartReentryWindowMinutes <= 0) return false;
    const cutoff = Date.now() - this.config.smartReentryWindowMinutes * 60 * 1000;
    const recent = this.store.trades
      .filter((trade) =>
        trade.symbol === signal.symbol &&
        trade.side === signal.side &&
        trade.status === "CLOSED" &&
        Date.parse(trade.exitedAt || trade.exitTime || "") >= cutoff
      )
      .sort((left, right) => Date.parse(right.exitedAt || right.exitTime || "") - Date.parse(left.exitedAt || left.exitTime || ""))[0];
    if (!recent) return false;
    const requiredFeeEdgeRatio = this.config.highActivityMode ? this.config.minEdgeToCostRatio * 0.9 : this.config.minEdgeToCostRatio;
    const requiredSmartEdgePct = this.config.highActivityMode ? this.config.smartEdgeMinNetPct * 0.85 : this.config.smartEdgeMinNetPct;
    const trendStillValid =
      (signal.multiTimeframeAligned ||
        signal.macroAligned ||
        Number(signal.continuationStrength || 0) >= this.config.continuationMinStrength + 8 ||
        (this.config.highActivityMode && signal.btcTrendAligned && Number(signal.trendQualityScore || 0) >= 58)) &&
      (signal.breakoutTriggered || signal.fomoTrigger || Number(signal.momentumPersistenceCandles || 0) >= this.config.minMomentumPersistenceCandles) &&
      Number(signal.smartProjectedNetEdgePct || 0) >= requiredSmartEdgePct &&
      Number(signal.feeEdgeRatio || 0) >= requiredFeeEdgeRatio;
    if ((this.config.liveValidationMode || this.config.profitControlledEquityMode) && numeric(recent.netPnlAfterCostsUsdt, numeric(recent.pnlUsdt)) < 0) {
      const freshQualifiedContinuation =
        ["PULLBACK_CONTINUATION", "BREAKOUT_RETEST", "MOMENTUM_RESUMPTION", "TREND_ACCELERATION", "CONTINUATION_BREAKOUT"].includes(
          signal.continuationSetupType
        ) &&
        Number(signal.continuationStrength || 0) >= this.config.continuationMinStrength + 10 &&
        Number(signal.smartProjectedNetEdgePct || signal.projectedNetEdgePct || 0) >= requiredSmartEdgePct + 0.08 &&
        Number(signal.feeEdgeRatio || 0) >= requiredFeeEdgeRatio + 0.15;
      if (!freshQualifiedContinuation) return false;
      this.log("INFO", "LOSING_REENTRY_REQUIRES_FRESH_QUALIFIED_SETUP", {
        symbol: signal.symbol,
        side: signal.side,
        previousNetPnlUsdt: numeric(recent.netPnlAfterCostsUsdt, numeric(recent.pnlUsdt)),
        continuationSetupType: signal.continuationSetupType,
        continuationStrength: signal.continuationStrength,
        smartProjectedNetEdgePct: signal.smartProjectedNetEdgePct,
      });
    }
    return Boolean(trendStillValid);
  }

  flipEntryCheck(signal) {
    const cutoff = Date.now() - Math.max(5, this.config.smartReentryWindowMinutes) * 60 * 1000;
    const previous = this.store.trades
      .filter((trade) =>
        trade.symbol === signal.symbol &&
        trade.status === "CLOSED" &&
        Date.parse(trade.exitedAt || trade.exitTime || "") >= cutoff
      )
      .sort((left, right) => Date.parse(right.exitedAt || right.exitTime || "") - Date.parse(left.exitedAt || left.exitTime || ""))[0];
    if (!previous || previous.side === signal.side) return { rejected: false };
    const previousExitMs = Date.parse(previous.exitedAt || previous.exitTime || "");
    const secondsSincePreviousExit = Number.isFinite(previousExitMs) ? (Date.now() - previousExitMs) / 1000 : null;
    const confirmedReversal =
      Number(signal.continuationStrength || 0) >= this.config.flipConfirmationMinStrength &&
      (signal.multiTimeframeAligned || signal.macroAligned || signal.breakoutTriggered || signal.fomoTrigger) &&
      Number(signal.smartProjectedNetEdgePct || signal.projectedNetEdgePct || 0) >= this.config.flipMinNetEdgePct;
    const exceptionalOppositeEdge =
      Number(signal.smartProjectedNetEdgePct || signal.projectedNetEdgePct || 0) >= this.config.flipMinNetEdgePct * 1.8 &&
      Number(signal.feeEdgeRatio || 0) >= this.config.edgeStrongMinRewardCostRatio &&
      Number(signal.convictionScore || 0) >= this.config.minConvictionScore + 16;
    if (confirmedReversal || exceptionalOppositeEdge) {
      return {
        rejected: false,
        previousSide: previous.side,
        secondsSincePreviousExit: secondsSincePreviousExit === null ? null : Number(secondsSincePreviousExit.toFixed(2)),
        confirmedReversal,
        exceptionalOppositeEdge,
      };
    }
    return {
      rejected: true,
      previousSide: previous.side,
      secondsSincePreviousExit: secondsSincePreviousExit === null ? null : Number(secondsSincePreviousExit.toFixed(2)),
      reason: "recent same-symbol opposite trade lacks confirmed reversal or exceptional positive net edge",
    };
  }

  promoteForcedSamplingSignal(signal, inactiveMinutes) {
    const promoted = { ...signal };
    promoted.eligible = true;
    promoted.tradeCategory = "EXPLORATION";
    promoted.explorationTrade = true;
    promoted.forcedMarketSampling = true;
    promoted.forcedSamplingInactiveMinutes = Number(inactiveMinutes.toFixed(2));
    promoted.forcedSamplingOriginalRejections = [...(signal.rejected || [])];
    promoted.explorationWaivedRejections = promoted.forcedSamplingOriginalRejections;
    promoted.rejected = [];
    promoted.scoreBreakdown = [...(signal.scoreBreakdown || []), "forced market sampling engaged +0"];
    promoted.adaptiveReasons = [...(signal.adaptiveReasons || []), "forced market sampling engaged for learning feedback"];
    promoted.requiredScore = Math.min(Number(promoted.requiredScore || this.config.minSignalScore), this.config.minSignalScore);
    promoted.explorationRequiredScore = Math.min(Number(promoted.explorationRequiredScore || this.config.explorationMinSignalScore), this.config.forcedSamplingMinScore);
    promoted.explorationRequiredConvictionScore = Math.min(
      Number(promoted.explorationRequiredConvictionScore || this.config.explorationMinConvictionScore),
      this.config.forcedSamplingMinConviction
    );
    return promoted;
  }

  profitProtectionEntryCheck(signal, protection) {
    if (!protection || !protection.active) return { rejected: false };
    if (this.config.learningPhaseMode && signal.explorationTrade) {
      return { rejected: false, reason: "learning phase keeps protected exploration active during profit protection" };
    }
    const requiredScore = Math.min(100, Number(signal.requiredScore || this.config.minSignalScore) + protection.signalAdjustment);
    const requiredConviction = Math.min(
      100,
      Number(signal.requiredConvictionScore || this.config.minConvictionScore) + Math.ceil(protection.signalAdjustment / 2)
    );
    const highQualityContinuation =
      Array.isArray(signal.marketRegimeTags) &&
      (signal.marketRegimeTags.includes("STRONG_TRENDING_MARKET") || signal.marketRegimeTags.includes("HIGH_VOLATILITY_BREAKOUT_MARKET")) &&
      signal.btcTrendAligned &&
      Number(signal.projectedNetEdgePct || 0) >= this.config.minProjectedEdgePct + 0.25;
    return {
      rejected: false,
      requiredScore,
      requiredConviction,
      highQualityContinuation,
      reason: "24/7 continuous execution keeps entries active; profit protection only adjusts sizing",
    };
  }

  profitModeQualityCheck(signal, edgeModel = {}) {
    if (!this.config.profitControlledEquityMode || !this.config.profitExpansionMode) {
      return { rejected: false, score: null, tier: null, reason: "profit expansion mode inactive" };
    }
    const memory = symbolPerformanceMemoryV3(this.store.trades, signal.symbol);
    const optimizer = this.config.expectancyOptimizerEnabled ? expectancyOptimizer(this.store.trades, this.config) : null;
    const setupMemory = this.config.edgeMaximizationMode ? setupRankingMemory(this.store.trades, signal, this.config) : null;
    const regimeMemory = this.config.edgeMaximizationMode ? regimePerformanceMemory(this.store.trades, signal, this.config) : null;
    const setupRegimeMatrix = this.config.edgeReinforcementMode ? setupRegimeMatrixMemory(this.store.trades, signal, this.config) : null;
    const autoTuning = this.config.edgeReinforcementMode ? expectancyAutoTuning(this.store.trades, this.config) : null;
    const activityRecovery = this.config.edgeReinforcementMode ? adaptiveActivityRecovery(this.store.trades, this.config) : null;
    const inactivityRecovery = signal.dynamicInactivityRecovery || (
      this.config.inactivityRecoveryMode
        ? dynamicInactivityRecovery(this.config, this.lastTradeOpenedAtMs())
        : { active: false, convictionThresholdMultiplier: 1, convictionThresholdDelta: 0, convictionRelaxPct: 0, convictionRelaxPoints: 0, stage: "NONE" }
    );
    const trendDominance = this.config.trendDominanceMode ? trendDominanceSignal(this.config, signal, {
      setupRegimeMatrixMemory: setupRegimeMatrix,
      activityRecovery,
    }) : null;
    const clusterRisk = this.config.edgeReinforcementMode ? tradeClusterRisk(this.store.trades, signal, this.config) : null;
    signal.clusterRisk = clusterRisk;
    signal.clusterRiskScore = clusterRisk ? clusterRisk.clusterRiskScore : 0;
    signal.clusterRiskSizeMultiplier = clusterRisk ? clusterRisk.sizeMultiplier : 1;
    const quality = qualityScoreForSignal(this.config, signal, edgeModel, memory, optimizer, {
      setupMemory,
      regimeMemory,
      setupRegimeMatrixMemory: setupRegimeMatrix,
      autoTuning,
      activityRecovery,
      inactivityRecovery,
      trendDominance,
      clusterRisk,
    });
    signal.profitQualityScore = quality.score;
    signal.profitQualityTier = quality.tier === "REJECT" ? null : quality.tier;
    signal.symbolPerformanceMemoryV2 = quality.symbolMemory;
    signal.symbolPerformanceMemoryV3 = quality.symbolMemory;
    signal.setupRankingMemory = setupMemory;
    signal.regimePerformanceMemory = regimeMemory;
    signal.setupRegimeMatrixMemory = setupRegimeMatrix;
    signal.expectancyAutoTuning = autoTuning;
    signal.adaptiveActivityRecovery = activityRecovery;
    signal.dynamicInactivityRecovery = inactivityRecovery;
    signal.trendDominance = trendDominance;
    signal.trendDominanceScore = trendDominance ? trendDominance.score : 0;
    signal.trendDominanceSizingMultiplier = trendDominance ? trendDominance.sizingMultiplier : 1;
    signal.expectancyOptimizer = optimizer;
    signal.runnerExtensionOptimizerMultiplier =
      (optimizer && optimizer.runnerContributionPositive ? optimizer.runnerExtensionMultiplier : 1) *
      (trendDominance ? trendDominance.runnerExtensionMultiplier : 1);
    signal.adaptiveMode = "PROFIT_MODE";
    signal.adaptivePolicyMode = "PROFIT_MODE";
    signal.explorationTrade = false;
    signal.forcedMarketSampling = false;
    if (quality.tier === "ELITE") {
      signal.eliteSetup = true;
      signal.tradeCategory = "ELITE_SETUP";
      signal.eliteContinuationCandidate = true;
    } else if (quality.tier === "STRONG") {
      signal.highQualityContinuation = true;
      if (!signal.tradeCategory || signal.tradeCategory === "EXPLORATION") signal.tradeCategory = "STRONG_CONTINUATION";
    } else if (quality.tier === "NORMAL") {
      if (!signal.tradeCategory || signal.tradeCategory === "EXPLORATION") signal.tradeCategory = "NORMAL_CONTINUATION";
    }
    this.log(quality.rejected ? "INFO" : "INFO", quality.rejected ? "PROFIT_MODE_QUALITY_REJECTED" : "PROFIT_MODE_QUALITY_APPROVED", {
      symbol: signal.symbol,
      side: signal.side,
      score: quality.score,
      tier: quality.tier,
      rawTier: quality.rawTier,
      reason: quality.reason,
      components: quality.components,
      thresholds: quality.thresholds,
      symbolMemoryBias: memory.bias,
      symbolMemoryWeight: memory.weight,
      setupRankingMemory: setupMemory,
      regimePerformanceMemory: regimeMemory,
      setupRegimeMatrixMemory: setupRegimeMatrix,
      expectancyAutoTuning: autoTuning,
      adaptiveActivityRecovery: activityRecovery,
      dynamicInactivityRecovery: inactivityRecovery,
      trendDominance,
      clusterRisk,
      portfolioAlphaScore: signal.portfolioAlphaScore,
      portfolioAlpha: signal.portfolioAlpha,
      rolling50: memory.rolling50,
      rolling100: memory.rolling100,
      expectancyOptimizer: optimizer,
    });
    if (optimizer) {
      this.log("INFO", "EXPECTANCY_OPTIMIZER_ACTIVE", {
        symbol: signal.symbol,
        closedTrades: optimizer.closedTrades,
        evaluatedEveryClosedTrades: optimizer.evaluatedEveryClosedTrades,
        averageWinner: optimizer.lastWindow.averageWinnerUsdt,
        averageLoser: optimizer.lastWindow.averageLoserUsdt,
        expectancy: optimizer.lastWindow.expectancyUsdt,
        profitFactor: optimizer.lastWindow.profitFactor,
        feeImpact: optimizer.lastWindow.feeImpactRatio,
        runnerContribution: optimizer.lastWindow.runnerContributionUsdt,
        feeDragTighteningActive: optimizer.feeDragTighteningActive,
        continuationOutperforming: optimizer.continuationOutperforming,
        runnerContributionPositive: optimizer.runnerContributionPositive,
      });
    }
    if (setupRegimeMatrix) {
      this.log("INFO", "REGIME_SETUP_MATRIX_ACTIVE", {
        symbol: signal.symbol,
        side: signal.side,
        key: setupRegimeMatrix.key,
        weight: setupRegimeMatrix.weight,
        bias: setupRegimeMatrix.bias,
        performance: setupRegimeMatrix.performance,
        neverDisabled: setupRegimeMatrix.neverDisabled,
      });
    }
    if (autoTuning) {
      this.log("INFO", "EXPECTANCY_AUTO_TUNING_ACTIVE", {
        closedTrades: autoTuning.closedTrades,
        evaluatedEveryClosedTrades: autoTuning.evaluatedEveryClosedTrades,
        active: autoTuning.active,
        bias: autoTuning.bias,
        adjustmentPct: autoTuning.adjustmentPct,
        thresholdMultiplier: autoTuning.thresholdMultiplier,
        profitFactorTrend: autoTuning.profitFactorTrend,
        expectancyTrend: autoTuning.expectancyTrend,
        maxAdjustmentPct: autoTuning.maxAdjustmentPct,
      });
    }
    if (activityRecovery) {
      this.log(activityRecovery.active ? "INFO" : "DEBUG", "ADAPTIVE_ACTIVITY_RECOVERY_ACTIVE", {
        active: activityRecovery.active,
        recentClosedTrades: activityRecovery.recentClosedTrades,
        targetClosedTrades: activityRecovery.targetClosedTrades,
        windowMinutes: activityRecovery.windowMinutes,
        thresholdMultiplier: activityRecovery.thresholdMultiplier,
        scoreBoost: activityRecovery.scoreBoost,
        reason: activityRecovery.reason,
        neverForcesTrades: activityRecovery.neverForcesTrades,
        riskControlsUnchanged: true,
        feeProtectionUnchanged: true,
      });
    }
    if (inactivityRecovery && inactivityRecovery.active) {
      this.log("INFO", "DYNAMIC_INACTIVITY_RECOVERY_ACTIVE", {
        symbol: signal.symbol,
        side: signal.side,
        stage: inactivityRecovery.stage,
        inactiveHours: inactivityRecovery.inactiveHours,
        convictionRelaxPct: inactivityRecovery.convictionRelaxPct,
        convictionRelaxPoints: inactivityRecovery.convictionRelaxPoints,
        convictionThresholdMultiplier: inactivityRecovery.convictionThresholdMultiplier,
        convictionThresholdDelta: inactivityRecovery.convictionThresholdDelta,
        resetAfterNewTrade: inactivityRecovery.resetAfterNewTrade,
        feeProtectionUnchanged: true,
        riskControlsUnchanged: true,
      });
    }
    if (trendDominance) {
      this.log(trendDominance.tier === "NO_DOMINANCE" ? "DEBUG" : "INFO", "TREND_DOMINANCE_ENGINE_EVALUATED", {
        symbol: signal.symbol,
        side: signal.side,
        score: trendDominance.score,
        tier: trendDominance.tier,
        ethBtcFocus: trendDominance.ethBtcFocus,
        symbolWeightMultiplier: trendDominance.symbolWeightMultiplier,
        solWeakBreakout: trendDominance.solWeakBreakout,
        thresholdMultiplier: trendDominance.thresholdMultiplier,
        scoreBoost: trendDominance.scoreBoost,
        sizingMultiplier: trendDominance.sizingMultiplier,
        runnerExtensionMultiplier: trendDominance.runnerExtensionMultiplier,
        targetActivityIncreasePct: trendDominance.targetActivityIncreasePct,
        neverBypassesRisk: trendDominance.neverBypassesRisk,
        neverBypassesFees: trendDominance.neverBypassesFees,
      });
    }
    if (clusterRisk) {
      this.log("INFO", "TRADE_CLUSTER_RISK_EVALUATED", {
        symbol: signal.symbol,
        side: signal.side,
        key: clusterRisk.key,
        clusterRiskScore: clusterRisk.clusterRiskScore,
        matchingTrades: clusterRisk.matchingTrades,
        recentLosses: clusterRisk.recentLosses,
        sizeMultiplier: clusterRisk.sizeMultiplier,
        action: clusterRisk.action,
        neverBlocksTrading: true,
      });
    }
    if (!quality.rejected && memory.bias === "STRENGTHENED") {
      this.log("INFO", "SYMBOL_PERFORMANCE_MEMORY_V3_STRENGTHENED", {
        symbol: signal.symbol,
        weight: memory.weight,
        rolling50: memory.rolling50,
        rolling100: memory.rolling100,
        neverDisabled: true,
      });
    } else if (!quality.rejected && memory.bias === "DOWNWEIGHTED") {
      this.log("INFO", "SYMBOL_PERFORMANCE_MEMORY_V3_DOWNWEIGHTED", {
        symbol: signal.symbol,
        weight: memory.weight,
        neverDisabled: true,
        rolling50: memory.rolling50,
        rolling100: memory.rolling100,
      });
    }
    if (setupMemory) {
      this.log("INFO", "SETUP_RANKING_ENGINE_ACTIVE", {
        key: setupMemory.key,
        weight: setupMemory.weight,
        bias: setupMemory.bias,
        performance: setupMemory.performance,
        neverDisabled: true,
      });
    }
    if (regimeMemory) {
      this.log("INFO", "REGIME_PERFORMANCE_MEMORY_ACTIVE", {
        key: regimeMemory.key,
        weight: regimeMemory.weight,
        bias: regimeMemory.bias,
        performance: regimeMemory.performance,
        neverDisabled: true,
      });
    }
    return quality;
  }

  feeAwareEntryCheck(signal) {
    const netEdgeGate = edgeGate(this.config, signal);
    if (netEdgeGate.rejected) {
      return {
        rejected: true,
        reason: `EDGE_GATE_REJECTED: ${netEdgeGate.reason}`,
        requiredProjectedEdgePct: netEdgeGate.requirements.minNetEdgePct,
        requiredEdgeToCostRatio: netEdgeGate.requirements.minRewardCostRatio,
        requiredSmartEdgePct: netEdgeGate.requirements.minNetEdgePct,
        edgeModel: netEdgeGate.model,
        edgeRequirements: netEdgeGate.requirements,
      };
    }
    const qualityMultiplier = signal.qualityPacingActive ? this.config.qualityPacingEdgeMultiplier : 1;
    const highActivityContinuation =
      this.config.highActivityMode &&
      Boolean(
        signal.highActivityContinuation ||
          signal.eliteContinuationCandidate ||
          signal.intelligentReentryTriggered ||
          signal.eliteSetup ||
          Number(signal.continuationStrength || 0) >= this.config.continuationMinStrength + 8
      ) &&
      Number(signal.feeEdgeRatio || 0) >= this.config.explorationMinEdgeToCostRatio &&
      Number(signal.smartProjectedNetEdgePct || signal.projectedNetEdgePct || 0) >= this.config.smartEdgeMinNetPct * 0.75;
    const activityMultiplier = highActivityContinuation ? 0.9 : 1;
    const minProjectedEdgePct =
      (signal.explorationTrade ? this.config.explorationMinProjectedEdgePct : this.config.minProjectedEdgePct) * qualityMultiplier * activityMultiplier;
    const minEdgeToCostRatio =
      (signal.explorationTrade ? this.config.explorationMinEdgeToCostRatio : this.config.minEdgeToCostRatio) * qualityMultiplier * activityMultiplier;
    const baseConvictionScore =
      Number(signal.requiredConvictionScore || signal.adaptiveConvictionThreshold || (signal.explorationTrade ? this.config.explorationMinConvictionScore : this.config.minConvictionScore));
    const minConvictionScore = baseConvictionScore + (signal.qualityPacingActive ? (signal.explorationTrade ? 2 : 3) : 0);
    const minExpectedMovePct = this.config.minExpectedMovePct * (signal.explorationTrade ? 0.75 : 1) * activityMultiplier;
    const minSmartEdgePct = this.config.smartEdgeMinNetPct * (signal.explorationTrade ? 0.65 : 1) * qualityMultiplier * activityMultiplier;
    const smartProjectedNetEdgePct = Number.isFinite(Number(signal.smartProjectedNetEdgePct))
      ? Number(signal.smartProjectedNetEdgePct)
      : Number(signal.projectedNetEdgePct || 0);
    const estimatedTpProbability = Number.isFinite(Number(signal.estimatedTpProbability))
      ? Number(signal.estimatedTpProbability)
      : this.config.smartEdgeMinTpProbability;
    if (Number(signal.expectedMovePct) < minExpectedMovePct) {
      return {
        rejected: true,
        microScalp: true,
        reason: "micro-scalp filtered: expected move is too small for the current fee profile",
        requiredProjectedEdgePct: Number(minProjectedEdgePct.toFixed(4)),
        requiredEdgeToCostRatio: Number(minEdgeToCostRatio.toFixed(4)),
        requiredSmartEdgePct: Number(minSmartEdgePct.toFixed(4)),
      };
    }
    if (smartProjectedNetEdgePct < minSmartEdgePct || estimatedTpProbability < this.config.smartEdgeMinTpProbability * (signal.explorationTrade ? 0.9 : 1)) {
      return {
        rejected: true,
        reason: "smart edge filter rejected low-profit setup: probability-adjusted edge barely exceeds execution costs",
        requiredProjectedEdgePct: Number(minProjectedEdgePct.toFixed(4)),
        requiredEdgeToCostRatio: Number(minEdgeToCostRatio.toFixed(4)),
        requiredSmartEdgePct: Number(minSmartEdgePct.toFixed(4)),
      };
    }
    if (Number(signal.projectedNetEdgePct) < minProjectedEdgePct) {
      return {
        rejected: true,
        reason: "low-edge setup rejected: projected edge after fees, spread, and slippage is too small",
        requiredProjectedEdgePct: Number(minProjectedEdgePct.toFixed(4)),
        requiredEdgeToCostRatio: Number(minEdgeToCostRatio.toFixed(4)),
        requiredSmartEdgePct: Number(minSmartEdgePct.toFixed(4)),
      };
    }
    if (Number(signal.feeEdgeRatio) < minEdgeToCostRatio) {
      return {
        rejected: true,
        reason: "fee-aware edge validation improved: expected move is too small relative to transaction costs",
        requiredProjectedEdgePct: Number(minProjectedEdgePct.toFixed(4)),
        requiredEdgeToCostRatio: Number(minEdgeToCostRatio.toFixed(4)),
        requiredSmartEdgePct: Number(minSmartEdgePct.toFixed(4)),
      };
    }
    if (this.config.profitControlledEquityMode && this.config.profitExpansionMode) {
      const rewardCost = Number(netEdgeGate.model.expectedRewardCostRatio || signal.feeEdgeRatio || 0);
      const projectedNetProfitUsdt = Number(netEdgeGate.model.projectedNetProfitUsdt || 0);
      const projectedTotalCostUsdt = Number(netEdgeGate.model.projectedTotalCostUsdt || 0);
      const requiredRewardCost = Math.max(this.config.profitModeMinRewardCostRatio, minEdgeToCostRatio);
      const requiredNetToCost = projectedTotalCostUsdt * this.config.profitModeMinNetProfitToCostRatio;
      const hasProjectedUsdt = projectedTotalCostUsdt > 0 || Number(netEdgeGate.model.projectedGrossProfitUsdt || 0) > 0;
      if ((hasProjectedUsdt && projectedNetProfitUsdt <= 0) || Number(netEdgeGate.model.expectedNetEdgePct || 0) <= 0) {
        return {
          rejected: true,
          reason: "fee killer rejected candidate: projected net result after costs is not positive",
          requiredProjectedEdgePct: Number(minProjectedEdgePct.toFixed(4)),
          requiredEdgeToCostRatio: Number(requiredRewardCost.toFixed(4)),
          requiredSmartEdgePct: Number(minSmartEdgePct.toFixed(4)),
          edgeModel: netEdgeGate.model,
        };
      }
      if (rewardCost < requiredRewardCost || (hasProjectedUsdt && projectedNetProfitUsdt < requiredNetToCost)) {
        return {
          rejected: true,
          reason: "fee killer rejected candidate: projected reward is too small relative to total execution cost",
          requiredProjectedEdgePct: Number(minProjectedEdgePct.toFixed(4)),
          requiredEdgeToCostRatio: Number(requiredRewardCost.toFixed(4)),
          requiredSmartEdgePct: Number(minSmartEdgePct.toFixed(4)),
          edgeModel: netEdgeGate.model,
        };
      }
    }
    if (Number(signal.convictionScore) < minConvictionScore) {
      return {
        rejected: true,
        reason: "quality filter strengthened: conviction score below threshold",
        requiredProjectedEdgePct: Number(minProjectedEdgePct.toFixed(4)),
        requiredEdgeToCostRatio: Number(minEdgeToCostRatio.toFixed(4)),
        requiredSmartEdgePct: Number(minSmartEdgePct.toFixed(4)),
      };
    }
    return {
      rejected: false,
      requiredProjectedEdgePct: Number(minProjectedEdgePct.toFixed(4)),
      requiredEdgeToCostRatio: Number(minEdgeToCostRatio.toFixed(4)),
      requiredSmartEdgePct: Number(minSmartEdgePct.toFixed(4)),
      edgeModel: netEdgeGate.model,
      edgeRequirements: netEdgeGate.requirements,
    };
  }

  adaptiveLeverageForSignal(signal, policy = this.adaptive.currentPolicy()) {
    const volatilityCap =
      signal.volatilityRegime === "NEWS_LIKE_ABNORMAL"
        ? Math.max(1, Math.floor(this.config.maxLeverage * 0.45))
        : signal.volatilityRegime === "HIGH_VOLATILITY"
          ? Math.max(1, Math.floor(this.config.maxLeverage * 0.7))
          : this.config.maxLeverage;
    const confidenceAdjusted = Math.max(
      1,
      Math.floor(
        (policy.maxLeverage || this.config.maxLeverage) *
          Number(signal.adaptiveLeverageMultiplier || 1) *
          Number(signal.regimeLeverageMultiplier || 1) *
          Number(signal.continuousRecoveryLeverageMultiplier || 1) *
          Number(signal.profitProtectionLeverageMultiplier || 1)
      )
    );
    return Math.max(1, Math.min(this.config.maxLeverage, volatilityCap, confidenceAdjusted));
  }

  profitControlledLeverageForSignal(signal, policy = this.adaptive.currentPolicy()) {
    const tier = earnedRiskTier(signal);
    const adaptive = this.adaptiveLeverageForSignal(signal, policy);
    const tierCap = leverageCapForTier(this.config, tier);
    return Math.max(1, Math.min(adaptive, tierCap, this.config.profitControlledMaxLeverage));
  }

  async liveEntryPreflight(signal, equity, requestedLeverage = this.config.maxLeverage) {
    if (this.unmanagedLiveExposure) return { rejected: true, reason: "unmanaged exchange position exists" };
    const openOrders = await this.client.getOpenOrders(signal.symbol);
    if (openOrders.length) return { rejected: true, reason: "selected symbol has pending exchange orders" };
    const approximateLiquidationDistancePct = 100 / requestedLeverage;
    if (approximateLiquidationDistancePct - this.config.stopLossPct < this.config.minLiquidationBufferPct) {
      return { rejected: true, reason: "stop-loss distance is too close to estimated liquidation distance" };
    }
    const balance = await this.client.getUsdtBalance();
    this.log("INFO", "Live order preflight balance check.", {
      symbol: signal.symbol,
      availableBalanceUsdt: balance.available,
      totalEquityUsdt: balance.equity,
      transferableUsableMarginUsdt: balance.transferableUsableMargin,
      requestedLeverage,
      balanceParseSource: balance.parseSource,
      equityParseSource: balance.equitySource,
      leverageMutationDeferredUntilFinalApproval: this.config.profitControlledEquityMode,
    });
    if (balance.available <= 0 || equity <= 0) return { rejected: true, reason: "no available USDT balance" };
    return { rejected: false, leverage: requestedLeverage, availableBalanceUsdt: balance.available, balance };
  }

  async finalizeLeverageAfterApproval(signal, requestedLeverage) {
    if (!this.config.setLeverageOnEntry) return { rejected: false, leverage: requestedLeverage };
    let leverageResponse = await this.client.getLeverage(signal.symbol, signal.side);
    let parsedLeverage = leverageResponse.leverage;
    let updateSucceeded = false;
    this.log("INFO", "Raw leverage response received after final entry approval.", {
      symbol: signal.symbol,
      rawLeverageResponse: leverageResponse.rawResponse,
      parsedLeverage,
      requestedLeverage,
    });
    if (Number.isFinite(parsedLeverage) && effectivelyUnchanged(parsedLeverage, requestedLeverage)) {
      this.log("INFO", "UNCHANGED_LEVERAGE_UPDATE_SKIPPED", {
        symbol: signal.symbol,
        parsedLeverage,
        requestedLeverage,
        duplicateProtectionPreventedApiSpam: true,
      });
    } else if (parsedLeverage !== requestedLeverage) {
      const updateResponse = await this.client.setLeverage(signal.symbol, requestedLeverage);
      updateSucceeded = true;
      this.log(updateResponse && updateResponse.notModified ? "INFO" : "WARN", updateResponse && updateResponse.notModified ? "BYBIT_NO_CHANGE_TREATED_AS_SUCCESS" : "Configured leverage update accepted after final entry approval.", {
        symbol: signal.symbol,
        requestedLeverage,
        rawLeverageUpdateResponse: updateResponse,
        recoveryEscalationAvoided: Boolean(updateResponse && updateResponse.notModified),
      });
      leverageResponse = await this.client.getLeverage(signal.symbol, signal.side);
      parsedLeverage = leverageResponse.leverage;
      this.log("INFO", "Raw leverage response received after approved update.", {
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
      finalEntryApprovalComplete: true,
      verificationSource: Number.isFinite(parsedLeverage)
        ? "GET /v5/position/list"
        : updateSucceeded
          ? "successful leverage update; empty readback accepted"
          : "readback unavailable; configured maximum used for liquidation protection",
    });
    return { rejected: false, leverage };
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
    if (this.config.setLeverageOnEntry && Number.isFinite(parsedLeverage) && effectivelyUnchanged(parsedLeverage, requestedLeverage)) {
      this.log("INFO", "UNCHANGED_LEVERAGE_UPDATE_SKIPPED", {
        symbol: signal.symbol,
        parsedLeverage,
        requestedLeverage,
        duplicateProtectionPreventedApiSpam: true,
      });
    } else if (this.config.setLeverageOnEntry && parsedLeverage !== requestedLeverage) {
      const updateResponse = await this.client.setLeverage(signal.symbol, requestedLeverage);
      updateSucceeded = true;
      this.log(updateResponse && updateResponse.notModified ? "INFO" : "WARN", updateResponse && updateResponse.notModified ? "BYBIT_NO_CHANGE_TREATED_AS_SUCCESS" : "Configured leverage update accepted for selected live symbol.", {
        symbol: signal.symbol,
        requestedLeverage,
        rawLeverageUpdateResponse: updateResponse,
        recoveryEscalationAvoided: Boolean(updateResponse && updateResponse.notModified),
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
      partialTakeProfitPrice: plan.partialTakeProfitPrice,
      runnerTakeProfitPrice: plan.runnerTakeProfitPrice,
      standardTakeProfitPrice: plan.standardTakeProfitPrice,
      eliteTrendRider: Boolean((plan.eliteSetup || plan.winnerAmplifier) && this.config.eliteTrendRiderEnabled),
      winnerAmplifier: Boolean(plan.winnerAmplifier),
      runnerPartialPct: plan.runnerPartialPct || (plan.winnerAmplifier ? this.config.winnerAmplifierPartialTakeProfitPct : plan.eliteSetup ? this.config.elitePartialTakeProfitPct : 0),
      runnerAllocation: plan.runnerAllocation,
      runnerTakeProfitMultiplier: plan.runnerTakeProfitMultiplier,
      runnerPartialTaken: false,
      runnerStopMovedToBreakeven: false,
      runnerExtensionCount: 0,
      peakPrice: signal.price,
      trailingStopPrice: null,
      openedAt: new Date().toISOString(),
      plannedEntryPrice: signal.price,
      ladderLevel: plan.ladderLevel,
      signalScore: signal.score,
      baseSignalScore: signal.baseScore,
      signalRegime: signal.regime,
      marketRegimeType: signal.marketRegimeType,
      marketRegimeV2: signal.marketRegimeV2,
      marketRegimeV2Participation: signal.marketRegimeV2Participation,
      marketRegimeTags: signal.marketRegimeTags,
      marketRegimeConfidence: signal.marketRegimeConfidence,
      regimeAggressionMultiplier: signal.regimeAggressionMultiplier,
      regimeRiskMultiplier: signal.regimeRiskMultiplier,
      regimeLeverageMultiplier: signal.regimeLeverageMultiplier,
      regimeHoldMultiplier: signal.regimeHoldMultiplier,
      regimeTrailingDistanceMultiplier: signal.regimeTrailingDistanceMultiplier,
      setupType: signal.setupType,
      tradeCategory: signal.tradeCategory,
      explorationTrade: signal.explorationTrade,
      explorationThresholdSoftened: signal.explorationThresholdSoftened,
      explorationMemoryRelaxation: signal.explorationMemoryRelaxation,
      explorationWaivedRejections: signal.explorationWaivedRejections,
      forcedMarketSampling: signal.forcedMarketSampling,
      forcedSamplingInactiveMinutes: signal.forcedSamplingInactiveMinutes,
      forcedSamplingOriginalRejections: signal.forcedSamplingOriginalRejections,
      btcMarketRegime: signal.btcTrend,
      ethMarketRegime: signal.ethTrend,
      marketBreadthScore: signal.marketBreadthScore,
      marketBreadthDirections: signal.marketBreadthDirections,
      marketBreadthAlignedCount: signal.marketBreadthAlignedCount,
      marketBreadthConflictCount: signal.marketBreadthConflictCount,
      btcTrendScore: signal.btcTrendScore,
      ethTrendScore: signal.ethTrendScore,
      solTrendScore: signal.solTrendScore,
      portfolioAlphaScore: signal.portfolioAlphaScore,
      portfolioAlphaAlignedCount: signal.portfolioAlphaAlignedCount,
      portfolioAlphaConflictCount: signal.portfolioAlphaConflictCount,
      portfolioAlpha: signal.portfolioAlpha,
      btcTrendStrength: signal.btcTrendStrength,
      ethTrendStrength: signal.ethTrendStrength,
      btcVolatilityPct: signal.btcVolatilityPct,
      btcMomentumPct: signal.btcMomentumPct,
      btcInstability: signal.btcInstability,
      volatilityRegime: signal.volatilityRegime,
      volumeCondition: signal.volumeCondition,
      entryMomentumPct: signal.entryMomentumPct,
      atrPct: signal.atrPct,
      spreadPct: signal.spreadPct,
      projectedNetEdgePct: signal.projectedNetEdgePct,
      smartProjectedNetEdgePct: signal.smartProjectedNetEdgePct,
      estimatedTpProbability: signal.estimatedTpProbability,
      expectedMovePct: signal.expectedMovePct,
      estimatedRoundTripCostPct: signal.estimatedRoundTripCostPct,
      feeEdgeRatio: signal.feeEdgeRatio,
      roundTripFeePct: signal.roundTripFeePct,
      convictionScore: signal.convictionScore,
      technicalConvictionScore: signal.technicalConvictionScore,
      liquidityScore: signal.liquidityScore,
      trendQualityScore: signal.trendQualityScore,
      antiChopScore: signal.antiChopScore,
      moderateChopAccepted: signal.moderateChopAccepted,
      marketPersonality: signal.marketPersonality,
      multiTimeframeAligned: signal.multiTimeframeAligned,
      multiTimeframeTrendScore: signal.multiTimeframeTrendScore,
      multiTimeframeDirections: signal.multiTimeframeDirections,
      adaptiveConvictionThreshold: signal.adaptiveConvictionThreshold,
      trend1h: signal.trend1h,
      macroTrend: signal.trend1h,
      macroAligned: signal.macroAligned,
      macroContradicts: signal.macroContradicts,
      continuationStrength: signal.continuationStrength,
      continuationSetupType: signal.continuationSetupType,
      continuationComponents: signal.continuationComponents,
      continuationBreakout: signal.continuationBreakout,
      pullbackContinuation: signal.pullbackContinuation,
      breakoutRetest: signal.breakoutRetest,
      momentumResumption: signal.momentumResumption,
      trendAcceleration: signal.trendAcceleration,
      intelligentReentryTriggered: signal.intelligentReentryTriggered,
      eliteContinuationCandidate: signal.eliteContinuationCandidate,
      eliteSetup: signal.eliteSetup,
      profitQualityScore: signal.profitQualityScore,
      profitQualityTier: signal.profitQualityTier,
      symbolPerformanceMemoryV2: signal.symbolPerformanceMemoryV2,
      symbolPerformanceMemoryV3: signal.symbolPerformanceMemoryV3,
      setupRankingMemory: signal.setupRankingMemory,
      regimePerformanceMemory: signal.regimePerformanceMemory,
      setupRegimeMatrixMemory: signal.setupRegimeMatrixMemory,
      expectancyAutoTuning: signal.expectancyAutoTuning,
      adaptiveActivityRecovery: signal.adaptiveActivityRecovery,
      dynamicInactivityRecovery: signal.dynamicInactivityRecovery,
      inactivityConvictionRelaxPct: signal.inactivityConvictionRelaxPct,
      trendDominance: signal.trendDominance,
      trendDominanceScore: signal.trendDominanceScore,
      trendDominanceSizingMultiplier: signal.trendDominanceSizingMultiplier,
      clusterRisk: signal.clusterRisk,
      clusterRiskScore: signal.clusterRiskScore,
      clusterRiskSizeMultiplier: signal.clusterRiskSizeMultiplier,
      expectancyOptimizer: signal.expectancyOptimizer,
      runnerExtensionOptimizerMultiplier: signal.runnerExtensionOptimizerMultiplier,
      eliteConditionKey: signal.eliteConditionKey,
      convictionTier: plan.convictionTier,
      targetMarginUsdt: plan.targetMarginUsdt,
      marginUsedUsdt: plan.marginUsedUsdt,
      maxLossAtStopUsdt: plan.maxLossAtStopUsdt,
      riskPctOfEquity: plan.riskPctOfEquity,
      totalOpenPortfolioRiskUsdt: plan.totalOpenPortfolioRiskUsdt,
      reasonsForSizingTier: plan.reasonsForSizingTier,
      edgeTier: signal.edgeTier,
      edgeModel: signal.edgeModel,
      projectedNetProfitUsdt: signal.edgeModel && signal.edgeModel.projectedNetProfitUsdt,
      projectedTotalCostUsdt: signal.edgeModel && signal.edgeModel.projectedTotalCostUsdt,
      executionType: signal.executionType || this.executionTypeForSignal(signal),
      makerOrTaker: /POST_ONLY|MAKER/i.test(String(signal.executionType || "")) ? "MAKER_INTENDED" : "TAKER_INTENDED",
      intendedPrice: signal.price,
      breakoutTriggered: signal.breakoutTriggered,
      microBreakoutTriggered: signal.microBreakoutTriggered,
      fastMode: signal.fastMode,
      fomoTrigger: signal.fomoTrigger,
      fomoTriggered: signal.fomoTrigger,
      sessionType: sessionType(),
      sessionRegime: signal.sessionRegime,
      sessionHourUtc: signal.sessionHourUtc,
      adaptiveConfidence: signal.adaptiveConfidence,
      adaptiveScoreAdjustment: signal.adaptiveScoreAdjustment,
      adaptiveRiskMultiplier: signal.adaptiveRiskMultiplier,
      adaptiveLeverageMultiplier: signal.adaptiveLeverageMultiplier,
      profitProtectionRiskMultiplier: signal.profitProtectionRiskMultiplier,
      profitProtectionLeverageMultiplier: signal.profitProtectionLeverageMultiplier,
      continuousRecoveryRiskMultiplier: signal.continuousRecoveryRiskMultiplier,
      continuousRecoveryLeverageMultiplier: signal.continuousRecoveryLeverageMultiplier,
      adaptiveMode: signal.adaptivePolicyMode,
      adaptiveReasons: signal.adaptiveReasons,
      entryReason: signal.scoreBreakdown,
      positionIdx: this.client.positionIdx(signal.side),
      nativeProtection: this.config.dryRun ? "SIMULATED" : "SUBMITTED_WITH_ENTRY",
      tickSize: signal.info.priceFilter && signal.info.priceFilter.tickSize,
      entryFeesUsdt: 0,
      exitFeesUsdt: 0,
      liveValidationMode: this.config.liveValidationMode,
      liveValidationLevel: this.store.state.liveValidation && this.store.state.liveValidation.level,
      liveValidationAllocatedEquityLimitUsdt: this.store.state.liveValidation && this.store.state.liveValidation.allocatedEquityLimitUsdt,
      liveValidationRiskState: signal.liveValidationRiskState,
      profitControlledEquityMode: this.config.profitControlledEquityMode,
      profitControlledRiskState: signal.profitControlledRiskState,
      profitControlledSizingEquityBaseUsdt: this.store.state.profitControlled && this.store.state.profitControlled.sizingEquityBaseUsdt,
      profitControlledEarnedRiskTier: earnedRiskTier(signal),
      expectedGrossMoveUsdt: signal.edgeModel && signal.edgeModel.projectedGrossProfitUsdt,
      expectedEntryFeeUsdt: signal.edgeModel && Number((plan.notional * (Number(signal.edgeModel.estimatedEntryFeePct || 0) / 100)).toFixed(6)),
      expectedExitFeeUsdt: signal.edgeModel && Number((plan.notional * (Number(signal.edgeModel.estimatedExitFeePct || 0) / 100)).toFixed(6)),
      expectedSpreadAndSlippageUsdt:
        signal.edgeModel &&
        Number((plan.notional * ((Number(signal.edgeModel.liveSpreadPct || 0) + Number(signal.edgeModel.conservativeSlippagePct || 0)) / 100)).toFixed(6)),
      expectedFundingUsdt: signal.edgeModel && Number((plan.notional * (Math.max(0, Number(signal.edgeModel.estimatedFundingPct || 0)) / 100)).toFixed(6)),
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
      convictionTier: plan.convictionTier,
      targetMarginUsdt: plan.targetMarginUsdt,
      riskUsdt: plan.riskUsdt,
      aggressiveSizing: plan.aggressive,
      reasons: signal.reasons,
    };

    // Persist the hard monitored stop before a live entry can be submitted.
    this.store.state.openPositions.push(position);
    this.store.trades.push(trade);
    this.executionLedger.beginTrade(position, {
      edgeModel: position.edgeModel,
      maxLossAtStopUsdt: position.maxLossAtStopUsdt,
      riskPctOfEquity: position.riskPctOfEquity,
      executionType: position.executionType,
    });
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
        const orderPayload = {
          orderLinkId: position.id,
          symbol: position.symbol,
          side: position.side === "LONG" ? "Buy" : "Sell",
          qty: position.size,
          positionIdx: position.positionIdx,
          reduceOnly: false,
          takeProfit: String(position.takeProfitPrice),
          stopLoss: String(position.stopLossPrice),
        };
        let result;
        if (position.executionType === "POST_ONLY_LIMIT") {
          orderPayload.price = String(this.postOnlyEntryPrice(position, signal));
          orderPayload.postOnly = true;
          result = await this.client.placeLimitOrder(orderPayload);
        } else {
          result = await this.client.placeMarketOrder(orderPayload);
        }
        position.status = "ENTRY_PENDING_CONFIRMATION";
        trade.status = "ENTRY_PENDING_CONFIRMATION";
        position.entryOrderId = result.orderId;
        position.entryOrderLinkId = result.orderLinkId || position.id;
        position.entryOrderStatus = "NEW";
        trade.entryOrderId = result.orderId;
        trade.entryOrderLinkId = position.entryOrderLinkId;
        trade.entryOrderStatus = "NEW";
        trade.executionType = position.executionType;
        trade.makerOrTaker = position.makerOrTaker;
        trade.intendedPrice = position.intendedPrice;
        this.executionLedger.recordOrder(position.id, {
          orderId: position.entryOrderId,
          orderLinkId: position.entryOrderLinkId,
        }, "ENTRY_SUBMITTED");
        this.log("WARN", "ORDER SENT", {
          operation: "ENTRY",
          executionType: position.executionType,
          makerOrTaker: position.makerOrTaker,
          symbol: position.symbol,
          side: position.side,
          orderId: position.entryOrderId,
          positionIdx: position.positionIdx,
          nativeTakeProfit: position.takeProfitPrice,
          partialTakeProfitPrice: position.partialTakeProfitPrice,
          eliteTrendRider: position.eliteTrendRider,
          nativeStopLoss: position.stopLossPrice,
          orderLinkId: position.entryOrderLinkId,
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
        partialTakeProfitPrice: position.partialTakeProfitPrice,
        eliteTrendRider: position.eliteTrendRider,
        convictionTier: position.convictionTier,
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

      const trailingDistancePct = position.eliteTrendRider && position.runnerPartialTaken
        ? this.runnerTrailingDistancePct(position)
        : this.config.trailingDistancePct * Number(position.regimeTrailingDistanceMultiplier || 1);
      const trailingStartPct = this.config.trailingStartPct * Number(position.regimeHoldMultiplier && position.regimeHoldMultiplier > 1 ? 1.05 : 1);
      if (this.config.trailingStopEnabled && favorablePct >= trailingStartPct) {
        const candidateStop = long
          ? position.peakPrice * (1 - trailingDistancePct / 100)
          : position.peakPrice * (1 + trailingDistancePct / 100);
        const improves = !position.trailingStopPrice || (long ? candidateStop > position.trailingStopPrice : candidateStop < position.trailingStopPrice);
        if (improves) {
          position.trailingStopPrice = candidateStop;
          if (!this.config.dryRun && !position.nativeTrailingConfigured) {
            const trailingDistance = roundedPrice(
              position.entryPrice * (trailingDistancePct / 100),
              position.tickSize,
              true
            );
            const activePrice = roundedPrice(
              position.entryPrice * (long ? 1 + trailingStartPct / 100 : 1 - trailingStartPct / 100),
              position.tickSize,
              long
            );
            const trailingUpdate = {
              symbol: position.symbol,
              positionIdx: position.positionIdx,
              takeProfit: String(position.takeProfitPrice),
              stopLoss: String(position.stopLossPrice),
              trailingStop: String(trailingDistance),
              activePrice: String(activePrice),
            };
            const updateResult = await this.applyTradingStopIfChanged(position, trailingUpdate, "trailing stop");
            position.nativeTrailingConfigured = true;
            position.nativeTrailingDistance = trailingDistance;
            position.nativeTrailingActivePrice = activePrice;
            if (updateResult && updateResult.skipped) {
              this.log("INFO", "UNCHANGED_TPSL_UPDATE_SKIPPED", {
                symbol: position.symbol,
                reason: "trailing stop already configured",
                duplicateProtectionPreventedApiSpam: true,
              });
            }
          }
          this.store.saveState();
          this.log("INFO", "Trailing stop moved to protect favorable movement.", {
            symbol: position.symbol,
            side: position.side,
            trailingStopPrice: candidateStop,
            trailingDistancePct,
            trailingStartPct,
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
      const partialTargetHit =
        position.eliteTrendRider &&
        !position.runnerPartialTaken &&
        Number(position.partialTakeProfitPrice) > 0 &&
        ((long && price >= position.partialTakeProfitPrice) || (!long && price <= position.partialTakeProfitPrice));
      if (partialTargetHit) {
        const analysis = options.priceProtectionOnly ? null : await this.scanner.analysisForPosition(position, regime);
        const continuation = analysis ? this.strongMomentumContinuation(position, analysis, pnlPct, { elite: true }) : true;
        if (continuation) {
          await this.closePartialPosition(position, price, "winner amplifier TP1 partial take profit", Number(position.runnerPartialPct || this.config.winnerAmplifierPartialTakeProfitPct) / 100);
          await this.moveRunnerStopToBreakeven(position);
          this.log("WARN", "Winner amplifier activated; TP1 secured and runner enabled.", {
            symbol: position.symbol,
            side: position.side,
            partialTakeProfitPrice: position.partialTakeProfitPrice,
            runnerTakeProfitPrice: position.runnerTakeProfitPrice,
            remainingSize: position.size,
            runnerPartialPct: position.runnerPartialPct,
            trailingDistancePct: this.runnerTrailingDistancePct(position, analysis),
          });
          await this.telegram.send(`Profit runner enabled: ${position.symbol} ${position.side}; TP1 partial taken and runner is trailing.`);
          continue;
        }
      }
      if ((long && price >= position.takeProfitPrice) || (!long && price <= position.takeProfitPrice)) {
        if (position.runnerPartialTaken) {
          const analysis = options.priceProtectionOnly ? null : await this.scanner.analysisForPosition(position, regime);
          const continuation = analysis ? this.strongMomentumContinuation(position, analysis, pnlPct, { elite: true }) : false;
          if (continuation) {
            await this.extendRunnerTarget(position, price, analysis);
            continue;
          }
        }
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
      const strongContinuation = this.strongMomentumContinuation(position, analysis, pnlPct, { elite: Boolean(position.eliteTrendRider) });
      if (strongContinuation) {
        this.log("INFO", position.eliteTrendRider ? "Elite continuation holding enabled." : "Strong momentum continuation detected; avoiding premature exit.", {
          symbol: position.symbol,
          side: position.side,
          pnlPct: pnlPct.toFixed(3),
          holdSeconds: secondsHeld(position).toFixed(1),
          continuationScore: analysis.convictionScore,
          continuationStrength: analysis.continuationStrength,
          continuationSetupType: analysis.continuationSetupType,
          macroAligned: analysis.macroAligned,
          marketRegimeTags: analysis.marketRegimeTags,
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
        if (this.feeSizedExit(position, pnlPct) && !trendReversed) {
          this.log("INFO", "Tiny profit exit avoided; expected value preservation kept position open.", {
            symbol: position.symbol,
            side: position.side,
            pnlPct: pnlPct.toFixed(3),
            estimatedRoundTripCostPct: position.estimatedRoundTripCostPct,
            feeEdgeRatio: position.feeEdgeRatio,
          });
          continue;
        }
        await this.closePosition(position, price, "momentum disappeared");
      }
    }
    this.store.saveState();
  }

  runnerTrailingDistancePct(position, analysis = null) {
    const atrPct = Math.max(numeric(analysis && analysis.atrPct), numeric(position.atrPct));
    const volatilityMultiplier =
      position.volatilityRegime === "HIGH_VOLATILITY" || (analysis && analysis.volatilityRegime === "HIGH_VOLATILITY")
        ? 1.18
        : position.volatilityRegime === "NEWS_LIKE_ABNORMAL"
          ? 1.35
          : 1;
    const regimeMultiplier = Number(position.regimeTrailingDistanceMultiplier || 1);
    return Math.max(
      this.config.trailingDistancePct * regimeMultiplier,
      atrPct * this.config.runnerAtrTrailingMultiplier * volatilityMultiplier,
      this.config.trailingDistancePct * this.config.eliteRunnerTrailingDistanceMultiplier * 0.85
    );
  }

  breakevenStopPrice(position) {
    const long = position.side === "LONG";
    const costPct =
      Math.max(
        numeric(position.estimatedRoundTripCostPct),
        numeric(position.roundTripFeePct) + numeric(position.spreadPct) + this.config.estimatedSlippagePct
      ) + this.config.runnerBreakevenCostCushionPct;
    const raw = long
      ? position.entryPrice * (1 + costPct / 100)
      : position.entryPrice * (1 - costPct / 100);
    return roundedPrice(raw, position.tickSize, !long);
  }

  async moveRunnerStopToBreakeven(position) {
    if (!position.runnerPartialTaken || position.runnerStopMovedToBreakeven) return;
    const long = position.side === "LONG";
    const breakevenStop = this.breakevenStopPrice(position);
    const improves = long ? breakevenStop > Number(position.stopLossPrice) : breakevenStop < Number(position.stopLossPrice);
    if (!improves) return;
    position.stopLossPrice = breakevenStop;
    position.runnerStopMovedToBreakeven = true;
    if (!this.config.dryRun) {
      await this.applyTradingStopIfChanged(position, {
        symbol: position.symbol,
        positionIdx: position.positionIdx,
        takeProfit: String(position.takeProfitPrice),
        stopLoss: String(position.stopLossPrice),
      }, "runner breakeven protection");
    }
    const trade = this.store.trades.find((item) => item.id === position.id);
    if (trade) {
      trade.stopLossPrice = position.stopLossPrice;
      trade.runnerStopMovedToBreakeven = true;
    }
    this.store.saveAll();
    this.log("WARN", "RUNNER_STOP_MOVED_TO_BREAKEVEN", {
      symbol: position.symbol,
      side: position.side,
      breakevenStopPrice: position.stopLossPrice,
      costCushionPct: this.config.runnerBreakevenCostCushionPct,
      runnerPartialTaken: true,
    });
  }

  async extendRunnerTarget(position, price, analysis = null) {
    const long = position.side === "LONG";
    const optimizerMultiplier = Number(position.runnerExtensionOptimizerMultiplier || 1);
    const distancePct = Math.max(
      this.runnerTrailingDistancePct(position, analysis) * this.config.runnerTrendExtensionMultiplier * optimizerMultiplier,
      this.config.takeProfitPct * 0.55
    );
    const candidate = roundedPrice(
      price * (long ? 1 + distancePct / 100 : 1 - distancePct / 100),
      position.tickSize,
      !long
    );
    const improves = long ? candidate > Number(position.takeProfitPrice) : candidate < Number(position.takeProfitPrice);
    if (!improves) return;
    position.takeProfitPrice = candidate;
    position.runnerTakeProfitPrice = candidate;
    position.runnerExtensionCount = Number(position.runnerExtensionCount || 0) + 1;
    if (!this.config.dryRun) {
      await this.applyTradingStopIfChanged(position, {
        symbol: position.symbol,
        positionIdx: position.positionIdx,
        takeProfit: String(position.takeProfitPrice),
        stopLoss: String(position.stopLossPrice),
      }, "dynamic runner extension");
    }
    const trade = this.store.trades.find((item) => item.id === position.id);
    if (trade) {
      trade.takeProfitPrice = position.takeProfitPrice;
      trade.runnerTakeProfitPrice = position.runnerTakeProfitPrice;
      trade.runnerExtensionCount = position.runnerExtensionCount;
    }
    this.store.saveAll();
    this.log("WARN", "DYNAMIC_RUNNER_EXTENSION_ACTIVE", {
      symbol: position.symbol,
      side: position.side,
      newRunnerTakeProfitPrice: position.takeProfitPrice,
      extensionDistancePct: Number(distancePct.toFixed(4)),
      continuationStrength: analysis && analysis.continuationStrength,
      trendStrengthIncreased: analysis && Number(analysis.continuationStrength || 0) > Number(position.continuationStrength || 0),
      expectancyOptimizerRunnerMultiplier: optimizerMultiplier,
      fixedProfitCapUsed: false,
    });
  }

  feeSizedExit(position, pnlPct) {
    const costPct = Math.max(numeric(position.estimatedRoundTripCostPct), numeric(position.roundTripFeePct) * 2);
    return pnlPct > 0 && pnlPct <= costPct + this.config.breakevenCostCushionPct;
  }

  strongMomentumContinuation(position, analysis, pnlPct, options = {}) {
    const sameSide = analysis.side === position.side;
    const alignedMomentum = position.side === "LONG"
      ? analysis.momentum1mPct > 0 && analysis.momentum5mPct >= 0
      : analysis.momentum1mPct < 0 && analysis.momentum5mPct <= 0;
    const tags = Array.isArray(analysis.marketRegimeTags) ? analysis.marketRegimeTags : Array.isArray(position.marketRegimeTags) ? position.marketRegimeTags : [];
    const continuationRegime = tags.includes("STRONG_TRENDING_MARKET") || tags.includes("HIGH_VOLATILITY_BREAKOUT_MARKET");
    const hostileRegime = tags.includes("SIDEWAYS_CHOP_MARKET") || tags.includes("FAKE_BREAKOUT_ENVIRONMENT") || tags.includes("DEAD_MARKET_CONDITIONS");
    const elite = Boolean(options.elite || position.eliteTrendRider);
    const strongContinuationStructure =
      Number(analysis.continuationStrength || position.continuationStrength || 0) >= this.config.continuationMinStrength + 8 ||
      analysis.macroAligned ||
      ["PULLBACK_CONTINUATION", "BREAKOUT_RETEST", "MOMENTUM_RESUMPTION", "TREND_ACCELERATION", "CONTINUATION_BREAKOUT"].includes(analysis.continuationSetupType);
    const requiredScore =
      this.config.continuationMinScore +
      (continuationRegime ? -6 : 0) +
      (hostileRegime && !strongContinuationStructure ? 8 : 0) +
      (elite ? -7 : 0) +
      (strongContinuationStructure ? -5 : 0);
    const requiredPnlPct = this.config.continuationMinPnlPct * (continuationRegime ? 0.85 : 1) * (elite ? 0.72 : 1) * (strongContinuationStructure ? 0.85 : 1);
    return Boolean(
      sameSide &&
      alignedMomentum &&
      pnlPct >= requiredPnlPct &&
      Number(analysis.convictionScore || 0) >= requiredScore &&
      Number(analysis.momentumPersistenceCandles || 0) >= this.config.minMomentumPersistenceCandles &&
      analysis.volumeCondition !== "LOW_VOLUME" &&
      analysis.volatilityRegime !== "NEWS_LIKE_ABNORMAL"
    );
  }

  async closePartialPosition(position, referencePrice, reason, fraction) {
    if (position.partialCloseSubmitted || position.runnerPartialTaken) return;
    const currentSize = numeric(position.size);
    const closeSize = currentSize * Math.max(0, Math.min(0.9, fraction));
    if (!Number.isFinite(closeSize) || closeSize <= 0) return;
    const remainingSize = Math.max(0, currentSize - closeSize);
    const sizeDecimals = String(position.size).includes(".") ? String(position.size).split(".")[1].length : 0;
    const closeQty = closeSize.toFixed(sizeDecimals);
    position.partialCloseSubmitted = true;
    if (!this.config.dryRun) {
      const result = await this.client.placeMarketOrder({
        orderLinkId: makeId("partial"),
        symbol: position.symbol,
        side: position.side === "LONG" ? "Sell" : "Buy",
        qty: closeQty,
        positionIdx: position.positionIdx,
        reduceOnly: true,
      });
      position.partialCloseOrderId = result.orderId;
      position.partialCloseOrderLinkId = result.orderLinkId;
      this.executionLedger.recordOrder(position.id, {
        orderId: position.partialCloseOrderId,
        orderLinkId: position.partialCloseOrderLinkId,
      }, "PARTIAL_CLOSE_SUBMITTED");
      this.log("WARN", "ORDER SENT", {
        operation: "PARTIAL_RUNNER_TP",
        symbol: position.symbol,
        side: position.side,
        orderId: result.orderId,
        reduceOnly: true,
        qty: closeQty,
        reason,
      });
    }
    const directionChange = position.side === "LONG" ? referencePrice - position.entryPrice : position.entryPrice - referencePrice;
    const partialGross = directionChange * closeSize;
    const entryNotional = position.entryPrice * closeSize;
    const exitNotional = referencePrice * closeSize;
    const partialFees = this.estimateSideFeeUsdt(entryNotional) + this.estimateSideFeeUsdt(exitNotional);
    position.partialRealizedGrossPnlUsdt = numeric(position.partialRealizedGrossPnlUsdt) + partialGross;
    position.partialRealizedFeesUsdt = numeric(position.partialRealizedFeesUsdt) + partialFees;
    position.partialRealizedPnlUsdt = numeric(position.partialRealizedPnlUsdt) + partialGross - partialFees;
    position.runnerPartialTaken = true;
    position.partialCloseSubmitted = false;
    position.size = remainingSize.toFixed(sizeDecimals);
    position.trailingStopPrice = null;
    const trade = this.store.trades.find((item) => item.id === position.id);
    if (trade) {
      trade.size = position.size;
      trade.partialRealizedGrossPnlUsdt = Number(position.partialRealizedGrossPnlUsdt.toFixed(6));
      trade.partialRealizedFeesUsdt = Number(position.partialRealizedFeesUsdt.toFixed(6));
      trade.partialRealizedPnlUsdt = Number(position.partialRealizedPnlUsdt.toFixed(6));
      trade.runnerPartialTaken = true;
    }
    this.store.saveAll();
    this.log("WARN", "PARTIAL RUNNER ENABLED", {
      symbol: position.symbol,
      side: position.side,
      closedQty: closeQty,
      remainingSize: position.size,
      referencePrice,
      partialGrossPnlUsdt: partialGross.toFixed(6),
      partialEstimatedFeesUsdt: partialFees.toFixed(6),
      partialNetPnlUsdt: (partialGross - partialFees).toFixed(6),
      reason,
    });
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
      this.executionLedger.recordOrder(position.id, {
        orderId: position.closeOrderId,
        orderLinkId: position.closeOrderLinkId,
      }, "CLOSE_SUBMITTED");
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
      (position.partialCloseOrderId && position.partialCloseOrderId === execution.orderId) ||
      (position.partialCloseOrderLinkId && position.partialCloseOrderLinkId === execution.orderLinkId) ||
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
    const remainingGrossPnlUsdt = directionChange * Number(position.size);
    const grossPnlUsdt = remainingGrossPnlUsdt + numeric(position.partialRealizedGrossPnlUsdt);
    const fees = this.feeBreakdownForClose(position, exitPrice);
    const totalFees = fees.total + numeric(position.partialRealizedFeesUsdt);
    const pnlUsdt = grossPnlUsdt - totalFees;
    const pnlPct =
      position.side === "LONG" ? percentChange(exitPrice, position.entryPrice) : percentChange(position.entryPrice, exitPrice);
    const holdSeconds = secondsHeld(position);
    const maxFavorableExcursionPct =
      position.side === "LONG"
        ? percentChange(numeric(position.peakPrice, position.entryPrice), position.entryPrice)
        : percentChange(position.entryPrice, numeric(position.peakPrice, position.entryPrice));
    const runnerNetContributionUsdt = position.runnerPartialTaken
      ? pnlUsdt - numeric(position.partialRealizedPnlUsdt)
      : 0;
    const trade = this.store.trades.find((item) => item.id === position.id);
    const closedAt = new Date().toISOString();
    const previousSameSymbol = this.store.trades
      .filter((item) => item.id !== position.id && item.symbol === position.symbol && item.status === "CLOSED")
      .sort((left, right) => Date.parse(right.exitedAt || right.exitTime || "") - Date.parse(left.exitedAt || left.exitTime || ""))[0];
    const isFlip =
      previousSameSymbol &&
      previousSameSymbol.side !== position.side &&
      Date.parse(position.openedAt || "") - Date.parse(previousSameSymbol.exitedAt || previousSameSymbol.exitTime || "") <= 5 * 60 * 1000;
    let completedTrade = null;
    if (trade) {
      Object.assign(trade, {
        status: "CLOSED",
        exitPrice,
        exitReason: reason,
        exitedAt: closedAt,
        holdSeconds: Number(holdSeconds.toFixed(2)),
        grossPnlUsdt: Number(grossPnlUsdt.toFixed(6)),
        feesUsdt: Number(totalFees.toFixed(6)),
        feeSource: fees.source,
        partialRealizedGrossPnlUsdt: Number(numeric(position.partialRealizedGrossPnlUsdt).toFixed(6)),
        partialRealizedFeesUsdt: Number(numeric(position.partialRealizedFeesUsdt).toFixed(6)),
        partialRealizedPnlUsdt: Number(numeric(position.partialRealizedPnlUsdt).toFixed(6)),
        runnerPartialTaken: Boolean(position.runnerPartialTaken),
        entryFeesUsdt: Number(fees.entryFee.toFixed(6)),
        exitFeesUsdt: Number(fees.exitFee.toFixed(6)),
        estimatedFeesUsdt: Number((fees.estimatedEntryFee + fees.estimatedExitFee + numeric(position.partialRealizedFeesUsdt)).toFixed(6)),
        pnlUsdt: Number(pnlUsdt.toFixed(6)),
        pnlPct: Number(pnlPct.toFixed(4)),
        netPnlAfterCostsUsdt: Number(pnlUsdt.toFixed(6)),
        grossPositiveNetNegative: grossPnlUsdt > 0 && pnlUsdt < 0,
        actualFundingUsdt: numeric(position.actualFundingUsdt),
        maxLossAtStopUsdt: Number(numeric(position.maxLossAtStopUsdt).toFixed(6)),
        riskPctOfEquity: Number(numeric(position.riskPctOfEquity).toFixed(4)),
        executionType: position.executionType || trade.executionType || "MARKET_TAKER",
        makerOrTaker: position.makerOrTaker || trade.makerOrTaker || "TAKER_INTENDED",
        intendedPrice: Number(numeric(position.intendedPrice, position.plannedEntryPrice || position.entryPrice).toFixed(8)),
        averageFillPrice: Number(numeric(position.entryPrice).toFixed(8)),
        fillLatencyMs: position.fillLatencyMs === null || position.fillLatencyMs === undefined ? null : Number(position.fillLatencyMs),
        cancelledOrMissedEntry: false,
        actualSlippagePct: Number(numeric(position.slippagePct).toFixed(4)),
        actualFeeUsdt: Number(totalFees.toFixed(6)),
        actualEntryFeeUsdt: Number(fees.entryFee.toFixed(6)),
        actualExitFeeUsdt: Number(fees.exitFee.toFixed(6)),
        isReentry: Boolean(position.intelligentReentryTriggered),
        isFlip: Boolean(isFlip),
        marketMode: position.marketPersonality || position.marketRegimeType || position.signalRegime || "UNKNOWN",
        edgeGateDecision: "APPROVED",
        projectedNetProfitUsdt: Number(numeric(position.projectedNetProfitUsdt).toFixed(6)),
        projectedTotalCostUsdt: Number(numeric(position.projectedTotalCostUsdt).toFixed(6)),
        runnerNetContributionUsdt: Number(runnerNetContributionUsdt.toFixed(6)),
        runnerExtensionCount: Number(position.runnerExtensionCount || 0),
        runnerStopMovedToBreakeven: Boolean(position.runnerStopMovedToBreakeven),
        maximumFavorableExcursionPct: Number(numeric(maxFavorableExcursionPct).toFixed(4)),
        profitGivenBackPct: Number(Math.max(0, numeric(maxFavorableExcursionPct) - pnlPct).toFixed(4)),
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
    this.risk.registerClose(pnlUsdt, totalFees);
    this.store.rebuildPerformance();
    this.executionLedger.finalize(position.id, {
      netPnlUsdt: pnlUsdt,
      grossPnlUsdt,
      feesUsdt: totalFees,
      closedAt,
    });
    if (completedTrade) this.adaptive.recordClosedTrade(completedTrade);
    this.store.saveAll();
    try {
      this.profitObjective.report();
    } catch (error) {
      this.log("WARN", "Profit objective report update failed.", { error: error.message });
    }
    this.writeLiveValidationStatusReport(true);
    this.writeProfitControlledStatusReport(true);
    this.log("INFO", "ACTUAL_TOTAL_FEE_USDT", {
      symbol: position.symbol,
      value: Number(totalFees.toFixed(6)),
      feeSource: fees.source,
    });
    this.log("INFO", "ACTUAL_NET_PNL_USDT", {
      symbol: position.symbol,
      value: Number(pnlUsdt.toFixed(6)),
      grossPnlUsdt: Number(grossPnlUsdt.toFixed(6)),
    });
    if (grossPnlUsdt > 0 && pnlUsdt < 0) {
      this.log("WARN", "GROSS_POSITIVE_NET_NEGATIVE_TRADE_DETECTED", {
        symbol: position.symbol,
        side: position.side,
        grossPnlUsdt: Number(grossPnlUsdt.toFixed(6)),
        totalFeesUsdt: Number(totalFees.toFixed(6)),
        netPnlUsdt: Number(pnlUsdt.toFixed(6)),
      });
    }
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
      feesUsdt: totalFees.toFixed(6),
      pnlUsdt: pnlUsdt.toFixed(6),
      holdSeconds: holdSeconds.toFixed(2),
      feeSource: fees.source,
    });
    this.log(pnlUsdt < 0 ? "WARN" : "INFO", "Managed position closed.", {
      symbol: position.symbol,
      side: position.side,
      reason,
      grossPnlUsdt: grossPnlUsdt.toFixed(6),
      feesUsdt: totalFees.toFixed(6),
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
        managed.exchangeTakeProfit = exchange.takeProfit || exchange.tp || managed.exchangeTakeProfit || null;
        managed.exchangeStopLoss = exchange.stopLoss || exchange.sl || managed.exchangeStopLoss || null;
        managed.exchangeTrailingStop = exchange.trailingStop || managed.exchangeTrailingStop || null;
        managed.exchangeTrailingActivePrice = exchange.activePrice || exchange.trailingActive || managed.exchangeTrailingActivePrice || null;
        managed.stopLossPrice =
          managed.side === "LONG"
            ? roundedPrice(entryPrice * (1 - this.config.stopLossPct / 100), managed.tickSize, false)
            : roundedPrice(entryPrice * (1 + this.config.stopLossPct / 100), managed.tickSize, true);
        managed.standardTakeProfitPrice =
          managed.side === "LONG"
            ? roundedPrice(entryPrice * (1 + this.config.takeProfitPct / 100), managed.tickSize, false)
            : roundedPrice(entryPrice * (1 - this.config.takeProfitPct / 100), managed.tickSize, true);
        managed.partialTakeProfitPrice = managed.eliteTrendRider ? managed.standardTakeProfitPrice : null;
        const managedRunnerMultiplier =
          managed.runnerTakeProfitMultiplier ||
          (managed.eliteSetup ? this.config.eliteRunnerTakeProfitMultiplier : managed.winnerAmplifier ? this.config.runnerTrendExtensionMultiplier : 1);
        managed.takeProfitPrice =
          managed.side === "LONG"
            ? roundedPrice(
                entryPrice * (1 + (this.config.takeProfitPct * managedRunnerMultiplier) / 100),
                managed.tickSize,
                false
              )
            : roundedPrice(
                entryPrice * (1 - (this.config.takeProfitPct * managedRunnerMultiplier) / 100),
                managed.tickSize,
                true
              );
        managed.runnerTakeProfitPrice = managed.takeProfitPrice;
        managed.status = "OPEN";
        if (entryWasPending) {
          managed.entryConfirmedAt = new Date().toISOString();
          const entrySubmittedMs = Date.parse(managed.entrySubmittedAt || managed.openedAt || "");
          managed.fillLatencyMs = Number.isFinite(entrySubmittedMs) ? Date.parse(managed.entryConfirmedAt) - entrySubmittedMs : null;
          const trade = this.store.trades.find((item) => item.id === managed.id);
          if (trade) {
            trade.status = "OPEN";
            trade.entryConfirmedAt = managed.entryConfirmedAt;
            trade.entryPrice = entryPrice;
            trade.slippagePct = managed.slippagePct;
            trade.actualSlippagePct = managed.slippagePct;
            trade.size = String(size);
            trade.positionIdx = managed.positionIdx;
            trade.fillLatencyMs = managed.fillLatencyMs;
            trade.averageFillPrice = entryPrice;
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

  currentTradingStopValues(position) {
    return {
      takeProfit: position.nativeTakeProfit || position.exchangeTakeProfit,
      stopLoss: position.nativeStopLoss || position.exchangeStopLoss,
      trailingStop: position.nativeTrailingDistance || position.exchangeTrailingStop,
      activePrice: position.nativeTrailingActivePrice || position.exchangeTrailingActivePrice,
    };
  }

  normalizedTradingStopIntent(position, intended) {
    const tickSize = position.tickSize || (position.info && position.info.priceFilter && position.info.priceFilter.tickSize);
    const output = { ...intended };
    for (const key of ["takeProfit", "stopLoss", "activePrice"]) {
      if (output[key] !== undefined && output[key] !== null && output[key] !== "" && tickSize) {
        output[key] = String(roundedPrice(Number(output[key]), tickSize, position.side !== "LONG"));
      }
    }
    return output;
  }

  tradingStopUnchanged(position, intended) {
    const normalized = this.normalizedTradingStopIntent(position, intended);
    const current = this.currentTradingStopValues(position);
    const checks = [];
    if (normalized.takeProfit !== undefined && normalized.takeProfit !== null && normalized.takeProfit !== "") {
      checks.push(effectivelyUnchanged(current.takeProfit, normalized.takeProfit));
    }
    if (normalized.stopLoss !== undefined && normalized.stopLoss !== null && normalized.stopLoss !== "") {
      checks.push(effectivelyUnchanged(current.stopLoss, normalized.stopLoss));
    }
    if (normalized.trailingStop !== undefined && normalized.trailingStop !== null && normalized.trailingStop !== "") {
      checks.push(effectivelyUnchanged(current.trailingStop, normalized.trailingStop));
    }
    if (normalized.activePrice !== undefined && normalized.activePrice !== null && normalized.activePrice !== "") {
      checks.push(effectivelyUnchanged(current.activePrice, normalized.activePrice));
    }
    return checks.length > 0 && checks.every(Boolean);
  }

  rememberTradingStopValues(position, intended) {
    if (intended.takeProfit !== undefined && intended.takeProfit !== null && intended.takeProfit !== "") {
      position.nativeTakeProfit = intended.takeProfit;
      position.exchangeTakeProfit = intended.takeProfit;
    }
    if (intended.stopLoss !== undefined && intended.stopLoss !== null && intended.stopLoss !== "") {
      position.nativeStopLoss = intended.stopLoss;
      position.exchangeStopLoss = intended.stopLoss;
    }
    if (intended.trailingStop !== undefined && intended.trailingStop !== null && intended.trailingStop !== "") {
      position.nativeTrailingDistance = intended.trailingStop;
      position.exchangeTrailingStop = intended.trailingStop;
    }
    if (intended.activePrice !== undefined && intended.activePrice !== null && intended.activePrice !== "") {
      position.nativeTrailingActivePrice = intended.activePrice;
      position.exchangeTrailingActivePrice = intended.activePrice;
    }
  }

  async applyTradingStopIfChanged(position, intended, reason) {
    const normalized = this.normalizedTradingStopIntent(position, intended);
    if (this.tradingStopUnchanged(position, normalized)) {
      this.log("INFO", "UNCHANGED_TPSL_UPDATE_SKIPPED", {
        symbol: position.symbol,
        reason,
        intended: normalized,
        current: this.currentTradingStopValues(position),
        duplicateProtectionPreventedApiSpam: true,
        recoveryEscalationAvoided: true,
      });
      this.log("DEBUG", "POSITION_PROTECTION_ALREADY_VALID", {
        symbol: position.symbol,
        reason,
        current: this.currentTradingStopValues(position),
      });
      this.rememberTradingStopValues(position, normalized);
      if (this.executionLedger) this.executionLedger.markProtection(position.id, "CONFIRMED", normalized);
      return { skipped: true };
    }
    const response = await this.client.setTradingStop(normalized);
    if (response && response.notModified) {
      this.log("INFO", "BYBIT_NO_CHANGE_TREATED_AS_SUCCESS", {
        symbol: position.symbol,
        reason,
        recoveryEscalationAvoided: true,
        executionCyclePreserved: true,
      });
    }
    this.rememberTradingStopValues(position, normalized);
    if (this.executionLedger) this.executionLedger.markProtection(position.id, "CONFIRMED", normalized);
    return response || {};
  }

  async ensureNativeProtection(position) {
    const intended = {
      symbol: position.symbol,
      positionIdx: position.positionIdx,
      takeProfit: String(position.takeProfitPrice),
      stopLoss: String(position.stopLossPrice),
    };
    const response = await this.applyTradingStopIfChanged(position, intended, "native TP/SL protection");
    position.nativeProtectionVerified = true;
    position.nativeProtection = "BYBIT_NATIVE_TP_SL_VERIFIED";
    this.log("INFO", response && response.skipped ? "Native Bybit TP/SL protection already current." : "Native Bybit TP/SL protection verified.", {
      symbol: position.symbol,
      stopLossPrice: position.stopLossPrice,
      takeProfitPrice: position.takeProfitPrice,
      positionIdx: position.positionIdx,
      updateSkipped: Boolean(response && response.skipped),
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
        (item.partialCloseOrderId && item.partialCloseOrderId === order.orderId) ||
        (item.partialCloseOrderLinkId && item.partialCloseOrderLinkId === order.orderLinkId) ||
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
        (item.partialCloseOrderId && item.partialCloseOrderId === execution.orderId) ||
        (item.partialCloseOrderLinkId && item.partialCloseOrderLinkId === execution.orderLinkId) ||
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
    const logicalTradeId = this.executionLedger.logicalTradeIdForOrder(execution) || position.id;
    const fillRecord = this.executionLedger.recordFill(logicalTradeId, execution);
    if (fillRecord.duplicate) {
      this.log("DEBUG", "Duplicate execution event did not mutate trade accounting.", {
        symbol: execution.symbol,
        orderId: execution.orderId,
        orderLinkId: execution.orderLinkId,
        execId: execution.execId,
      });
      return;
    }
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
      `Focused universe: ${(this.config.focusedTradingSymbolsList || []).join(", ")}`,
      `High activity mode: ${this.config.highActivityMode ? `active (${this.config.scanIntervalMs}ms scans)` : "off"}`,
      `Continuous execution: ${this.config.continuousExecutionMode ? "active" : "off"}`,
      `API recovery: ${this.config.apiAutoRecoveryEnabled ? `active, stage ${state.apiRecovery && state.apiRecovery.active ? state.apiRecovery.stage : "idle"}` : "off"}`,
      `Daily shutdowns: removed; 24/7 execution ${this.config.continuousExecutionMode ? "enabled" : "disabled"}`,
      `Learning phase: ${this.config.learningPhaseMode ? "active" : "off"}, daily trade limits: ${this.config.disableDailyTradeLimits ? "disabled" : "enabled"}`,
      `Quality pacing: ${adaptivePolicy.qualityPacingActive ? `active - ${adaptivePolicy.qualityPacingReason}` : "inactive"}`,
      `Adaptive recovery: ${daily.recoveryModeActive ? `active, daily PnL ${Number(daily.recoveryPnlPct || 0).toFixed(2)}%, loss streak ${daily.recoveryLosingStreak || 0}` : "inactive"}`,
      `Daily PnL realized: ${Number(daily.realizedPnlUsdt || 0).toFixed(4)} USDT`,
      `Daily trades/losses: ${daily.tradesOpened || 0}/${daily.losingTrades || 0}`,
      `Exploration trades today: ${daily.explorationTrades || 0}/${this.config.disableDailyTradeLimits ? "unlimited" : adaptivePolicy.explorationBudget || 0}`,
      `Forced sampling: ${this.config.forcedMarketSamplingEnabled ? `on after ${this.config.forcedMarketSamplingAfterMinutes} idle minutes` : "off"}`,
      `Profit protection: ${daily.profitProtectionActive ? `active at ${Number(daily.profitProtectionPnlPct || 0).toFixed(2)}% daily PnL` : "inactive"}`,
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
      if (this.emergencyStopRequested()) {
        return this.telegram.send("Resume refused: emergency stop file exists.");
      }
      this.risk.continuousRecoveryStatus(equity);
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
    this.writePeriodicProfitObjectiveReport(true);
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
