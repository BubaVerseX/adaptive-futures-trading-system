"use strict";

const WINDOWS_SECONDS = Object.freeze([1, 3, 5, 10, 30, 60]);

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 10) {
  return Number(numeric(value).toFixed(places));
}

function clip(value, min, max) {
  return Math.max(min, Math.min(max, numeric(value)));
}

function safeRatio(numerator, denominator) {
  const den = numeric(denominator);
  return Math.abs(den) > Number.EPSILON ? numeric(numerator) / den : 0;
}

function mean(values = []) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

function variance(values = []) {
  const avg = mean(values);
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / usable.length : 0;
}

function zScore(value, values = []) {
  const avg = mean(values);
  const std = Math.sqrt(variance(values));
  return std > 0 ? clip((numeric(value) - avg) / std, -8, 8) : 0;
}

function normalizeSide(side = "") {
  const raw = String(side).toLowerCase();
  if (raw === "buy" || raw === "long") return "BUY";
  if (raw === "sell" || raw === "short") return "SELL";
  return "UNKNOWN";
}

function parseBookLevel(level = []) {
  if (Array.isArray(level)) return { price: numeric(level[0]), size: numeric(level[1]) };
  return { price: numeric(level.price || level.p), size: numeric(level.size || level.qty || level.q) };
}

function normalizeOrderBook(data = {}) {
  const bids = Array.isArray(data.b) ? data.b.map(parseBookLevel) : Array.isArray(data.bids) ? data.bids.map(parseBookLevel) : [];
  const asks = Array.isArray(data.a) ? data.a.map(parseBookLevel) : Array.isArray(data.asks) ? data.asks.map(parseBookLevel) : [];
  const bestBid = bids[0] || { price: numeric(data.bidPrice), size: numeric(data.bidSize) };
  const bestAsk = asks[0] || { price: numeric(data.askPrice), size: numeric(data.askSize) };
  return {
    symbol: data.s || data.symbol,
    timestamp: numeric(data.ts || data.timestamp || data.time || Date.now()),
    bidPrice: bestBid.price,
    askPrice: bestAsk.price,
    bidSize: bestBid.size,
    askSize: bestAsk.size,
    bids,
    asks,
  };
}

function normalizeTrade(data = {}) {
  return {
    symbol: data.s || data.symbol,
    timestamp: numeric(data.T || data.ts || data.timestamp || data.time || Date.now()),
    side: normalizeSide(data.S || data.side),
    price: numeric(data.p || data.price),
    size: numeric(data.v || data.size || data.qty),
  };
}

class MicrostructureFeatureEngine {
  constructor({ windowsSeconds = WINDOWS_SECONDS, staleDataMs = 2000 } = {}) {
    this.windowsSeconds = windowsSeconds;
    this.staleDataMs = staleDataMs;
    this.orderBooks = new Map();
    this.trades = new Map();
    this.snapshots = new Map();
    this.lastSkipReasons = new Map();
  }

  recordOrderBook(symbol, data = {}) {
    const book = normalizeOrderBook({ ...data, symbol: data.symbol || symbol });
    if (!book.symbol || book.bidPrice <= 0 || book.askPrice <= 0) return null;
    this.orderBooks.set(book.symbol, book);
    return book;
  }

  recordTrade(symbol, data = {}) {
    const trade = normalizeTrade({ ...data, symbol: data.symbol || symbol });
    if (!trade.symbol || trade.price <= 0 || trade.size <= 0 || trade.side === "UNKNOWN") return null;
    if (!this.trades.has(trade.symbol)) this.trades.set(trade.symbol, []);
    const bucket = this.trades.get(trade.symbol);
    bucket.push(trade);
    const cutoff = trade.timestamp - Math.max(...this.windowsSeconds) * 1000 - 1000;
    while (bucket.length && bucket[0].timestamp < cutoff) bucket.shift();
    return trade;
  }

  rollingTrades(symbol, now, seconds) {
    const cutoff = now - seconds * 1000;
    return (this.trades.get(symbol) || []).filter((trade) => trade.timestamp >= cutoff && trade.timestamp <= now);
  }

  historyValues(symbol, key, limit = 120) {
    const history = this.snapshots.get(symbol) || [];
    return history.slice(-limit).map((snapshot) => numeric(snapshot.features && snapshot.features[key], Number.NaN)).filter(Number.isFinite);
  }

  tradeFeatures(symbol, now, seconds, mid) {
    const trades = this.rollingTrades(symbol, now, seconds);
    const buyTrades = trades.filter((trade) => trade.side === "BUY");
    const sellTrades = trades.filter((trade) => trade.side === "SELL");
    const buyVolume = buyTrades.reduce((sum, trade) => sum + trade.size, 0);
    const sellVolume = sellTrades.reduce((sum, trade) => sum + trade.size, 0);
    const totalVolume = buyVolume + sellVolume;
    const signedTradeVolume = buyVolume - sellVolume;
    const buyNotional = buyTrades.reduce((sum, trade) => sum + trade.price * trade.size, 0);
    const sellNotional = sellTrades.reduce((sum, trade) => sum + trade.price * trade.size, 0);
    const prices = trades.map((trade) => trade.price);
    const sizes = trades.map((trade) => trade.size);
    const largest = sizes.length ? Math.max(...sizes) : 0;
    const vwapBuy = buyVolume > 0 ? buyNotional / buyVolume : mid;
    const vwapSell = sellVolume > 0 ? sellNotional / sellVolume : mid;
    return {
      signedTradeVolume,
      netOrderFlow: signedTradeVolume,
      buyVolume,
      sellVolume,
      tradeImbalance: safeRatio(buyVolume - sellVolume, totalVolume),
      vwapBuyToMidDeviation: safeRatio(vwapBuy - mid, mid),
      vwapSellToMidDeviation: safeRatio(vwapSell - mid, mid),
      totalTradedVolume: totalVolume,
      numberOfTrades: trades.length,
      tradePriceVariance: variance(prices),
      shortRealizedVolatility: Math.sqrt(variance(prices.map((price) => safeRatio(price - mid, mid)))),
      volumeConcentration: safeRatio(largest, totalVolume),
    };
  }

  generateSnapshot(symbol, timestamp = Date.now()) {
    const book = this.orderBooks.get(symbol);
    if (!book) {
      this.lastSkipReasons.set(symbol, { reason: "ORDERBOOK_MISSING" });
      return null;
    }
    const bidPrice = numeric(book.bidPrice);
    const askPrice = numeric(book.askPrice);
    const bidSize = numeric(book.bidSize);
    const askSize = numeric(book.askSize);
    const dataAgeMs = Math.max(0, timestamp - book.timestamp);
    if (!Number.isFinite(book.timestamp) || dataAgeMs > this.staleDataMs) {
      this.lastSkipReasons.set(symbol, { reason: "STALE_ORDERBOOK", dataAgeMs, staleDataMs: this.staleDataMs });
      return null;
    }
    if (bidPrice <= 0 || askPrice <= 0 || askPrice <= bidPrice || bidSize <= 0 || askSize <= 0) {
      this.lastSkipReasons.set(symbol, { reason: "INVALID_ORDERBOOK", bidPrice, askPrice, bidSize, askSize });
      return null;
    }
    const midPrice = (bidPrice + askPrice) / 2;
    const bidAskSpread = Math.max(0, askPrice - bidPrice);
    const relativeSpread = safeRatio(bidAskSpread, midPrice);
    const l1OrderBookImbalance = safeRatio(bidSize - askSize, bidSize + askSize);
    const microprice = safeRatio(askPrice * bidSize + bidPrice * askSize, bidSize + askSize);
    const micropriceDeviationFromMid = safeRatio(microprice - midPrice, midPrice);
    const baseTrades = this.tradeFeatures(symbol, timestamp, 1, midPrice);
    if (baseTrades.numberOfTrades <= 0) {
      this.lastSkipReasons.set(symbol, { reason: "EMPTY_TRADE_WINDOW", windowSeconds: 1 });
      return null;
    }
    const features = {
      midPrice: round(midPrice),
      bidAskSpread: round(bidAskSpread),
      relativeSpread: round(relativeSpread),
      bestBidSize: round(bidSize),
      bestAskSize: round(askSize),
      l1OrderBookImbalance: round(l1OrderBookImbalance),
      microprice: round(microprice),
      micropriceDeviationFromMid: round(micropriceDeviationFromMid),
      ...Object.fromEntries(Object.entries(baseTrades).map(([key, value]) => [key, round(value)])),
    };
    features.spreadZScore = round(zScore(relativeSpread, this.historyValues(symbol, "relativeSpread")));
    features.imbalanceZScore = round(zScore(l1OrderBookImbalance, this.historyValues(symbol, "l1OrderBookImbalance")));
    features.orderFlowPressureScore = round(
      clip(
        l1OrderBookImbalance * 35 +
        clip(micropriceDeviationFromMid * 10000, -50, 50) +
        baseTrades.tradeImbalance * 30 +
        clip(safeRatio(baseTrades.netOrderFlow, Math.max(1, bidSize + askSize)) * 35, -35, 35) -
        Math.max(0, features.spreadZScore) * 5,
        -100,
        100
      ),
      6
    );
    for (const seconds of this.windowsSeconds) {
      const rolling = this.tradeFeatures(symbol, timestamp, seconds, midPrice);
      for (const [key, value] of Object.entries(rolling)) {
        features[`${key}_${seconds}s`] = round(value);
      }
    }
    const badFeature = Object.entries(features).find(([, value]) => !Number.isFinite(Number(value)));
    if (badFeature) {
      this.lastSkipReasons.set(symbol, { reason: "NON_FINITE_FEATURE", feature: badFeature[0], value: badFeature[1] });
      return null;
    }
    const snapshot = {
      timestamp,
      isoTime: new Date(timestamp).toISOString(),
      symbol,
      bookTimestamp: book.timestamp,
      dataAgeMs,
      features,
    };
    if (!this.snapshots.has(symbol)) this.snapshots.set(symbol, []);
    const history = this.snapshots.get(symbol);
    history.push(snapshot);
    while (history.length > 600) history.shift();
    return snapshot;
  }
}

module.exports = {
  MicrostructureFeatureEngine,
  WINDOWS_SECONDS,
  normalizeOrderBook,
  normalizeTrade,
  safeRatio,
};
