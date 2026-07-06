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
const INTERVAL_MS = Object.freeze({
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
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

function uniqueSortedCandles(candles = []) {
  const byTime = new Map(
    candles
      .map(normalizeKline)
      .filter((candle) => Number.isFinite(candle.time) && candle.time > 0)
      .map((candle) => [candle.time, candle])
  );
  return Array.from(byTime.values()).sort((left, right) => left.time - right.time);
}

function expectedCandlesForDays(interval, days) {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) return 0;
  return Math.floor((Number(days) * 24 * 60 * 60 * 1000) / intervalMs);
}

function coverageReportForCandles(candles = [], interval, minimumDays = 365) {
  const sorted = uniqueSortedCandles(candles);
  const expectedCandles = expectedCandlesForDays(interval, minimumDays);
  if (!sorted.length) {
    return {
      interval,
      candleCount: 0,
      expectedCandles,
      firstTime: null,
      lastTime: null,
      coverageDays: 0,
      hasRequiredCoverage: false,
    };
  }
  const firstTime = sorted[0].time;
  const lastTime = sorted[sorted.length - 1].time;
  const coverageDays = (lastTime - firstTime) / (24 * 60 * 60 * 1000);
  const intervalDays = (INTERVAL_MS[interval] || 0) / (24 * 60 * 60 * 1000);
  const hasExpectedCandleCount = expectedCandles > 0 && sorted.length >= expectedCandles;
  return {
    interval,
    candleCount: sorted.length,
    expectedCandles,
    firstTime,
    lastTime,
    firstIso: new Date(firstTime).toISOString(),
    lastIso: new Date(lastTime).toISOString(),
    coverageDays: Number(coverageDays.toFixed(4)),
    hasRequiredCoverage: hasExpectedCandleCount || (coverageDays >= minimumDays - intervalDays - 0.001 && sorted.length >= Math.floor(expectedCandles * 0.9)),
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
    fs.writeFileSync(file, `${JSON.stringify(uniqueSortedCandles(candles), null, 2)}\n`, "utf8");
    return file;
  }

  mergeAndCache(symbol, interval, candles) {
    const existing = this.loadCached(symbol, interval);
    const merged = uniqueSortedCandles([...existing, ...candles]);
    this.saveCached(symbol, interval, merged);
    return merged;
  }

  async fetchOHLCVPage(symbol, interval, { startTime = null, endTime = null, limit = 1000 } = {}) {
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
    return uniqueSortedCandles((payload.result && payload.result.list) || []);
  }

  async downloadOHLCV(symbol, interval, { startTime = null, endTime = null, limit = 1000 } = {}) {
    const candles = await this.fetchOHLCVPage(symbol, interval, { startTime, endTime, limit });
    return this.mergeAndCache(symbol, interval, candles);
  }

  async downloadOHLCVHistory(symbol, interval, {
    startTime = Date.now() - 365 * 24 * 60 * 60 * 1000,
    endTime = Date.now(),
    limit = 1000,
    maxPages = 80,
  } = {}) {
    const intervalMs = INTERVAL_MS[interval];
    if (!intervalMs) throw new Error(`Unsupported research interval: ${interval}`);
    const collected = [];
    let cursorEnd = Number(endTime);
    for (let page = 0; page < maxPages && cursorEnd >= startTime; page += 1) {
      const candles = await this.fetchOHLCVPage(symbol, interval, { startTime, endTime: cursorEnd, limit });
      if (!candles.length) break;
      collected.push(...candles);
      const earliest = candles[0].time;
      if (earliest <= startTime) break;
      const nextEnd = earliest - intervalMs;
      if (nextEnd >= cursorEnd) break;
      cursorEnd = nextEnd;
    }
    return this.mergeAndCache(symbol, interval, collected);
  }

  hasMinimumCoverage(candles, interval, minimumDays) {
    return coverageReportForCandles(candles, interval, minimumDays).hasRequiredCoverage;
  }

  coverageReport(data = {}, { symbols = RESEARCH_SYMBOLS, intervals = RESEARCH_INTERVALS, minimumDays = 365 } = {}) {
    const report = {};
    for (const symbol of symbols) {
      report[symbol] = {};
      for (const interval of intervals) {
        report[symbol][interval] = coverageReportForCandles(data[symbol] && data[symbol][interval], interval, minimumDays);
      }
    }
    return report;
  }

  async ensureHistoricalData({
    symbols = RESEARCH_SYMBOLS,
    intervals = RESEARCH_INTERVALS,
    download = false,
    minimumDays = null,
    endTime = Date.now(),
    maxPages = 80,
  } = {}) {
    const result = {};
    for (const symbol of symbols) {
      result[symbol] = {};
      for (const interval of intervals) {
        let candles = this.loadCached(symbol, interval);
        if (download && minimumDays && !this.hasMinimumCoverage(candles, interval, minimumDays)) {
          candles = await this.downloadOHLCVHistory(symbol, interval, {
            startTime: endTime - minimumDays * 24 * 60 * 60 * 1000,
            endTime,
            maxPages,
          });
        } else if (download && !candles.length) {
          candles = await this.downloadOHLCV(symbol, interval);
        }
        result[symbol][interval] = candles;
      }
    }
    return result;
  }
}

module.exports = {
  BYBIT_INTERVALS,
  HistoricalDataEngine,
  INTERVAL_MS,
  RESEARCH_INTERVALS,
  RESEARCH_SYMBOLS,
  coverageReportForCandles,
  expectedCandlesForDays,
  normalizeKline,
};
