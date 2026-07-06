"use strict";

const { parseCandles } = require("../indicators");
const { average, bounded, numeric, round } = require("../strategyUtils");
const { analysisContext } = require("./strategyPlugins");

const PARSED_CANDLE_CACHE = new WeakMap();

function cachedParseCandles(rawCandles = []) {
  if (!Array.isArray(rawCandles)) return parseCandles(rawCandles || []);
  if (!PARSED_CANDLE_CACHE.has(rawCandles)) {
    PARSED_CANDLE_CACHE.set(rawCandles, parseCandles(rawCandles));
  }
  return PARSED_CANDLE_CACHE.get(rawCandles);
}

function candleTime(candle, fallbackIndex = 0, candleSeconds = 60) {
  const raw = candle && (candle.time || candle.start || candle.timestamp);
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 1700000000000 + fallbackIndex * candleSeconds * 1000;
}

function detectCandleSeconds(candles = []) {
  if (!Array.isArray(candles) || candles.length < 2) return 60;
  const deltas = [];
  for (let index = 1; index < Math.min(candles.length, 40); index += 1) {
    const delta = candleTime(candles[index], index) - candleTime(candles[index - 1], index - 1);
    if (delta > 0) deltas.push(delta / 1000);
  }
  return deltas.length ? Math.max(1, Math.round(average(deltas))) : 60;
}

function executionPrice(price, side, action, slippagePct) {
  const pct = numeric(slippagePct) / 100;
  const value = numeric(price);
  if (side === "LONG") return action === "ENTRY" ? value * (1 + pct) : value * (1 - pct);
  return action === "ENTRY" ? value * (1 - pct) : value * (1 + pct);
}

function sideMovePct(side, entryPrice, referencePrice) {
  const entry = numeric(entryPrice);
  const reference = numeric(referencePrice);
  if (entry <= 0) return 0;
  return side === "LONG" ? ((reference - entry) / entry) * 100 : ((entry - reference) / entry) * 100;
}

function tradeDurationDays(trades = []) {
  const times = trades
    .flatMap((trade) => [Date.parse(trade.enteredAt), Date.parse(trade.exitedAt)])
    .filter(Number.isFinite);
  if (times.length < 2) return 0;
  return Math.max(1 / 24, (Math.max(...times) - Math.min(...times)) / (24 * 60 * 60 * 1000));
}

function returnStats(values = []) {
  const usable = values.map(Number).filter(Number.isFinite);
  if (!usable.length) return { average: 0, standardDeviation: 0, downsideDeviation: 0 };
  const avg = average(usable);
  const variance = usable.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / usable.length;
  const downside = usable.filter((value) => value < 0);
  const downsideVariance = downside.length ? downside.reduce((sum, value) => sum + Math.pow(value, 2), 0) / downside.length : 0;
  return {
    average: avg,
    standardDeviation: Math.sqrt(variance),
    downsideDeviation: Math.sqrt(downsideVariance),
  };
}

function equityCurveFromTrades(trades = []) {
  let equity = 0;
  let peak = 0;
  return trades.map((trade) => {
    equity += numeric(trade.netPnlUsdt);
    peak = Math.max(peak, equity);
    return {
      time: trade.exitedAt,
      equity: round(equity, 6),
      drawdown: round(peak - equity, 6),
    };
  });
}

function maxDrawdownFromTrades(trades = []) {
  return equityCurveFromTrades(trades).reduce((maximum, point) => Math.max(maximum, numeric(point.drawdown)), 0);
}

function summarizeResearchTrades(trades = []) {
  const closed = trades.filter((trade) => Number.isFinite(numeric(trade.netPnlUsdt, Number.NaN)));
  const wins = closed.filter((trade) => numeric(trade.netPnlUsdt) > 0);
  const losses = closed.filter((trade) => numeric(trade.netPnlUsdt) < 0);
  const grossWin = wins.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt), 0));
  const stats = returnStats(closed.map((trade) => numeric(trade.netReturnPct)));
  const days = tradeDurationDays(closed);
  return {
    tradeCount: closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    netProfitUsdt: round(closed.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt), 0), 6),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : wins.length ? 999 : 0,
    grossWinningUsdt: round(grossWin, 6),
    grossLosingUsdt: round(grossLoss, 6),
    expectancyUsdt: closed.length ? round(closed.reduce((sum, trade) => sum + numeric(trade.netPnlUsdt), 0) / closed.length, 6) : 0,
    winRatePct: closed.length ? round((wins.length / closed.length) * 100, 2) : 0,
    averageWinnerUsdt: wins.length ? round(grossWin / wins.length, 6) : 0,
    averageLoserUsdt: losses.length ? round(grossLoss / losses.length, 6) : 0,
    maximumDrawdownUsdt: round(maxDrawdownFromTrades(closed), 6),
    sharpeRatio: stats.standardDeviation > 0 ? round(stats.average / stats.standardDeviation, 4) : 0,
    sortinoRatio: stats.downsideDeviation > 0 ? round(stats.average / stats.downsideDeviation, 4) : 0,
    averageHoldSeconds: closed.length ? round(closed.reduce((sum, trade) => sum + numeric(trade.holdSeconds), 0) / closed.length, 2) : 0,
    averageTradeDurationSeconds: closed.length ? round(closed.reduce((sum, trade) => sum + numeric(trade.holdSeconds), 0) / closed.length, 2) : 0,
    feesPaidUsdt: round(closed.reduce((sum, trade) => sum + Math.abs(numeric(trade.feesUsdt)), 0), 6),
    tradesPerMonth: days > 0 ? round((closed.length / days) * 30, 4) : 0,
  };
}

class EventDrivenBacktester {
  constructor(config = {}) {
    this.config = config;
  }

  feePctPerSide() {
    return numeric(this.config.estimatedTakerFeePctPerSide, numeric(this.config.estimatedFeePctPerSide, 0.055));
  }

  slippagePct() {
    return numeric(this.config.estimatedSlippagePct, 0.08);
  }

  fillRatio(candle = {}, notionalUsdt = 0) {
    const price = numeric(candle.open || candle.close);
    const turnover = numeric(candle.turnover) || numeric(candle.volume) * price;
    const multiple = numeric(this.config.v22PartialFillVolumeNotionalMultiple, 6);
    if (turnover <= 0 || notionalUsdt <= 0) return 1;
    return bounded(turnover / (Math.max(1, notionalUsdt) * multiple), numeric(this.config.v22PartialFillMinRatio, 0.35), 1);
  }

  closeTrade(position, candle, index, reason, exitReferencePrice = null) {
    const exitBase = numeric(exitReferencePrice, numeric(candle.open || candle.close));
    const exitPrice = executionPrice(exitBase, position.side, "EXIT", this.slippagePct());
    const exitNotional = position.quantity * exitPrice;
    const entryFee = position.entryNotionalUsdt * (this.feePctPerSide() / 100);
    const exitFee = exitNotional * (this.feePctPerSide() / 100);
    const grossPnl = position.side === "LONG"
      ? position.quantity * (exitPrice - position.entryPrice)
      : position.quantity * (position.entryPrice - exitPrice);
    const netPnl = grossPnl - entryFee - exitFee;
    const holdSeconds = Math.max(0, (index - position.entryIndex) * position.candleSeconds);
    return {
      id: `${position.strategyId}-${position.symbol}-${position.signalIndex}-${position.entryIndex}-${index}`,
      symbol: position.symbol,
      strategyId: position.strategyId,
      strategyName: position.strategyName,
      setupType: position.strategyId,
      side: position.side,
      confidence: position.confidence,
      params: position.params,
      signalIndex: position.signalIndex,
      entryIndex: position.entryIndex,
      exitIndex: index,
      entryExecutedOnFutureCandle: true,
      enteredAt: new Date(candleTime(position.entryCandle, position.entryIndex, position.candleSeconds)).toISOString(),
      exitedAt: new Date(candleTime(candle, index, position.candleSeconds)).toISOString(),
      entryPrice: round(position.entryPrice, 8),
      exitPrice: round(exitPrice, 8),
      entryNotionalUsdt: round(position.entryNotionalUsdt, 6),
      exitNotionalUsdt: round(exitNotional, 6),
      fillRatio: round(position.fillRatio, 4),
      partialFill: position.fillRatio < 0.999,
      quantity: round(position.quantity, 8),
      grossPnlUsdt: round(grossPnl, 6),
      feesUsdt: round(entryFee + exitFee, 6),
      fundingUsdt: 0,
      netPnlUsdt: round(netPnl, 6),
      netReturnPct: position.entryNotionalUsdt > 0 ? round((netPnl / position.entryNotionalUsdt) * 100, 4) : 0,
      grossReturnPct: position.entryNotionalUsdt > 0 ? round((grossPnl / position.entryNotionalUsdt) * 100, 4) : 0,
      holdSeconds,
      maximumFavorableExcursionPct: round(position.maximumFavorableExcursionPct, 4),
      maximumAdverseExcursionPct: round(position.maximumAdverseExcursionPct, 4),
      exitReason: reason,
      noCandleCheating: true,
    };
  }

  openPosition({ symbol, strategy, signal, candles, signalIndex, entryIndex, params }) {
    const entryCandle = candles[entryIndex];
    const entryBase = numeric(entryCandle.open || entryCandle.close);
    const entryPrice = executionPrice(entryBase, signal.direction, "ENTRY", this.slippagePct());
    const sizing = strategy.positionSizing(signal, { config: this.config });
    const requestedNotional = numeric(sizing.notionalUsdt, numeric(this.config.v22ResearchNotionalUsdt, 50));
    const fillRatio = this.fillRatio(entryCandle, requestedNotional);
    const entryNotionalUsdt = Math.max(0, requestedNotional * fillRatio);
    return {
      symbol,
      strategyId: strategy.strategyId,
      strategyName: strategy.name,
      side: signal.direction,
      confidence: signal.confidence,
      params,
      signalIndex,
      entryIndex,
      entryCandle,
      candleSeconds: detectCandleSeconds(candles),
      entryPrice,
      quantity: entryPrice > 0 ? entryNotionalUsdt / entryPrice : 0,
      entryNotionalUsdt,
      requestedNotionalUsdt: requestedNotional,
      fillRatio,
      stopPrice: numeric(signal.stopPrice),
      initialStopPrice: numeric(signal.stopPrice),
      stopDistancePct: numeric(signal.stopDistancePct),
      expectedHoldingTimeSeconds: numeric(signal.expectedHoldingTimeSeconds, strategy.defaultHoldingSeconds),
      maximumFavorableExcursionPct: 0,
      maximumAdverseExcursionPct: 0,
      trailingActive: false,
    };
  }

  updateExcursionsAndTrailing(position, candle) {
    const high = numeric(candle.high);
    const low = numeric(candle.low);
    const favorablePct = position.side === "LONG"
      ? sideMovePct(position.side, position.entryPrice, high)
      : sideMovePct(position.side, position.entryPrice, low);
    const adversePct = position.side === "LONG"
      ? -sideMovePct(position.side, position.entryPrice, low)
      : -sideMovePct(position.side, position.entryPrice, high);
    position.maximumFavorableExcursionPct = Math.max(position.maximumFavorableExcursionPct, favorablePct);
    position.maximumAdverseExcursionPct = Math.max(position.maximumAdverseExcursionPct, adversePct);
    const activationR = numeric(this.config.v22TrailingActivationR, 1.25);
    if (position.maximumFavorableExcursionPct >= position.stopDistancePct * activationR) {
      const trailDistancePct = Math.max(position.stopDistancePct * 0.65, numeric(this.config.v22MinimumTrailDistancePct, 0.18));
      position.trailingActive = true;
      position.stopPrice = position.side === "LONG"
        ? Math.max(position.stopPrice, high * (1 - trailDistancePct / 100))
        : Math.min(position.stopPrice, low * (1 + trailDistancePct / 100));
    }
  }

  stopTriggered(position, candle) {
    if (position.side === "LONG" && numeric(candle.low) <= position.stopPrice) return true;
    if (position.side === "SHORT" && numeric(candle.high) >= position.stopPrice) return true;
    return false;
  }

  run({ symbol, candles: rawCandles = [], strategy, params = strategy.defaultParams } = {}) {
    const candles = cachedParseCandles(rawCandles || []);
    const trades = [];
    if (!strategy || candles.length < 70) {
      return { trades, metrics: summarizeResearchTrades(trades), equityCurve: [], drawdownCurve: [] };
    }
    let position = null;
    const warmup = Math.max(60, numeric(this.config.v22ResearchWarmupBars, 60));
    for (let index = warmup; index < candles.length - 1; index += 1) {
      const context = { ...analysisContext(candles, index), symbol, index, config: this.config };
      if (position && index > position.entryIndex) {
        this.updateExcursionsAndTrailing(position, candles[index]);
        if (this.stopTriggered(position, candles[index])) {
          trades.push(this.closeTrade(position, candles[index], index, position.trailingActive ? "TRAILING_STOP" : "STOP_LOSS", position.stopPrice));
          position = null;
        } else {
          const heldSeconds = (index - position.entryIndex) * position.candleSeconds;
          const maxHold = numeric(position.expectedHoldingTimeSeconds, strategy.defaultHoldingSeconds);
          const exit = strategy.generateExit(position, context);
          if ((exit && exit.exit) || heldSeconds >= maxHold) {
            trades.push(this.closeTrade(position, candles[index + 1], index + 1, exit && exit.exit ? exit.reason : "EXPECTED_HOLD_COMPLETE"));
            position = null;
            index += 1;
          }
        }
      }
      if (position || index >= candles.length - 1) continue;
      const signal = strategy.generateEntry(context, params);
      if (!signal || !["LONG", "SHORT"].includes(signal.direction)) continue;
      if (numeric(signal.confidence) < numeric(this.config.v22ResearchMinEntryConfidence, 45)) continue;
      const entryIndex = index + 1;
      position = this.openPosition({ symbol, strategy, signal, candles, signalIndex: index, entryIndex, params });
      if (position.quantity <= 0 || position.entryNotionalUsdt <= 0) position = null;
    }
    if (position) {
      const lastIndex = candles.length - 1;
      trades.push(this.closeTrade(position, candles[lastIndex], lastIndex, "END_OF_DATA"));
    }
    const equityCurve = equityCurveFromTrades(trades);
    return {
      trades,
      metrics: summarizeResearchTrades(trades),
      equityCurve,
      drawdownCurve: equityCurve.map((point) => ({ time: point.time, drawdown: point.drawdown })),
    };
  }
}

module.exports = {
  EventDrivenBacktester,
  candleTime,
  detectCandleSeconds,
  equityCurveFromTrades,
  summarizeResearchTrades,
};
