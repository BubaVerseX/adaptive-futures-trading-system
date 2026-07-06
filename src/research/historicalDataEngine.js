"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RESEARCH_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
const RESEARCH_INTERVALS = Object.freeze(["1m", "5m", "15m", "1h", "4h", "1D"]);
const BYBIT_INTERVALS = Object.freeze({
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1D": "D",
});

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function normalizeKline(item) {
  if (Array.isArray(item)) {
    return {
      time: Number(item[0]),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5]),
      turnover: Number(item[6] || 0),
    };
  }
  return {
    time: Number(item.time || item.startTime || item.timestamp),
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.close),
    volume: Number(item.volume),
    turnover: Number(item.turnover || item.quoteVolume || 0),
  };
}

class HistoricalDataEngine {
  constructor({ cacheDir, restBaseUrl = "https://api.bybit.com", category = "linear", fetchImpl = global.fetch } = {}) {
    this.cacheDir = cacheDir || path.join(process.cwd(), "data", "research", "ohlcv");
    this.restBaseUrl = restBaseUrl;
    this.category = category;
    this.fetchImpl = fetchImpl;
  }

  cacheFile(symbol, interval) {
    return path.join(this.cacheDir, symbol, `${interval}.json`);
  }

  loadCached(symbol, interval) {
    const file = this.cacheFile(symbol, interval);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8")).map(normalizeKline).sort((left, right) => left.time - right.time);
  }

  saveCached(symbol, interval, candles) {
    const file = this.cacheFile(symbol, interval);
    ensureDir(file);
    fs.writeFileSync(file, `${JSON.stringify(candles.map(normalizeKline).sort((left, right) => left.time - right.time), null, 2)}\n`, "utf8");
    return file;
  }

  mergeAndCache(symbol, interval, candles) {
    const existing = this.loadCached(symbol, interval);
    const byTime = new Map([...existing, ...candles.map(normalizeKline)].filter((candle) => Number.isFinite(candle.time)).map((candle) => [candle.time, candle]));
    const merged = Array.from(byTime.values()).sort((left, right) => left.time - right.time);
    this.saveCached(symbol, interval, merged);
    return merged;
  }

  async downloadOHLCV(symbol, interval, { startTime = null, endTime = null, limit = 1000 } = {}) {
    if (!this.fetchImpl) throw new Error("HistoricalDataEngine requires fetch to download public OHLCV data.");
    const bybitInterval = BYBIT_INTERVALS[interval];
    if (!bybitInterval) throw new Error(`Unsupported research interval: ${interval}`);
    const params = new URLSearchParams({
      category: this.category,
      symbol,
      interval: bybitInterval,
      limit: String(Math.min(1000, limit)),
    });
    if (startTime !== null) params.set("start", String(startTime));
    if (endTime !== null) params.set("end", String(endTime));
    const url = `${this.restBaseUrl.replace(/\/$/, "")}/v5/market/kline?${params.toString()}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`Bybit OHLCV download failed: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.retCode && payload.retCode !== 0) throw new Error(`Bybit OHLCV download failed: ${payload.retMsg || payload.retCode}`);
    const candles = ((payload.result && payload.result.list) || []).map(normalizeKline);
    return this.mergeAndCache(symbol, interval, candles);
  }

  async ensureHistoricalData({ symbols = RESEARCH_SYMBOLS, intervals = RESEARCH_INTERVALS, download = false } = {}) {
    const result = {};
    for (const symbol of symbols) {
      result[symbol] = {};
      for (const interval of intervals) {
        let candles = this.loadCached(symbol, interval);
        if (download && !candles.length) candles = await this.downloadOHLCV(symbol, interval);
        result[symbol][interval] = candles;
      }
    }
    return result;
  }
}

module.exports = {
  BYBIT_INTERVALS,
  HistoricalDataEngine,
  RESEARCH_INTERVALS,
  RESEARCH_SYMBOLS,
  normalizeKline,
};
