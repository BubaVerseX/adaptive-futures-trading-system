"use strict";

const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { MicrostructureFeatureEngine } = require("./featureEngine");

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function appendJsonl(file, value) {
  ensureDir(file);
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function snapshotFile(config, symbol, timestamp = Date.now()) {
  const day = new Date(timestamp).toISOString().slice(0, 10);
  return path.join(config.microSnapshotDir, day, `${symbol}.jsonl`);
}

class MicrostructureCollector extends EventEmitter {
  constructor(config, log = () => {}, WebSocketImpl = WebSocket, featureEngine = new MicrostructureFeatureEngine()) {
    super();
    this.config = config;
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.featureEngine = featureEngine;
    this.socket = null;
    this.snapshotTimer = null;
    this.stopped = true;
  }

  topics() {
    const symbols = this.config.microSymbols || this.config.focusedTradingSymbolsList || ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    return symbols.flatMap((symbol) => [`orderbook.1.${symbol}`, `publicTrade.${symbol}`]);
  }

  start() {
    this.stopped = false;
    const baseUrl = this.config.publicWsBaseUrl || this.config.wsBaseUrl || "wss://stream.bybit.com";
    this.socket = new this.WebSocketImpl(`${String(baseUrl).replace(/\/$/, "")}/v5/public/linear`);
    this.socket.on("open", () => {
      this.log("INFO", "V24_MICROSTRUCTURE_PUBLIC_WS_CONNECTED", { takerOnly: true });
      this.socket.send(JSON.stringify({ op: "subscribe", args: this.topics() }));
    });
    this.socket.on("message", (raw) => this.handleMessage(raw));
    this.socket.on("error", (error) => this.log("WARN", "V24_MICROSTRUCTURE_WS_ERROR", { error: error.message }));
    this.socket.on("close", () => {
      if (!this.stopped) this.log("WARN", "V24_MICROSTRUCTURE_WS_CLOSED", { reconnectRequired: true });
    });
    this.snapshotTimer = setInterval(() => this.flushSnapshots(), this.config.microSnapshotIntervalMs || 1000);
  }

  stop() {
    this.stopped = true;
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
    if (this.socket) this.socket.close();
    this.socket = null;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (_error) {
      return;
    }
    const topic = String(message.topic || "");
    if (!topic || !message.data) return;
    if (topic.startsWith("orderbook.")) {
      const symbol = topic.split(".").pop();
      this.featureEngine.recordOrderBook(symbol, { ...message.data, ts: message.ts || message.data.ts });
      return;
    }
    if (topic.startsWith("publicTrade.")) {
      const symbol = topic.split(".").pop();
      const trades = Array.isArray(message.data) ? message.data : [message.data];
      for (const trade of trades) this.featureEngine.recordTrade(symbol, { ...trade, symbol });
    }
  }

  flushSnapshots(timestamp = Date.now()) {
    for (const symbol of this.config.microSymbols || this.config.focusedTradingSymbolsList || []) {
      const snapshot = this.featureEngine.generateSnapshot(symbol, timestamp);
      if (!snapshot) continue;
      appendJsonl(snapshotFile(this.config, symbol, timestamp), snapshot);
      this.emit("snapshot", snapshot);
    }
  }
}

module.exports = {
  MicrostructureCollector,
  appendJsonl,
  snapshotFile,
};
