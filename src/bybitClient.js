"use strict";

const crypto = require("node:crypto");
const EventEmitter = require("node:events");
const WebSocket = require("ws");
const { classifyBybitResult } = require("./bybitErrors");

const REQUEST_TIMEOUT_MS = 10000;
const REQUEST_RETRIES = 2;
const ACTIVE_ORDER_STATUSES = new Set(["New", "PartiallyFilled", "Untriggered", "Triggered", "Created"]);
const ORDER_STATUS_MAP = {
  New: "NEW",
  PartiallyFilled: "PARTIALLY_FILLED",
  Filled: "FILLED",
  Cancelled: "CANCELLED",
  Rejected: "REJECTED",
  Deactivated: "CANCELLED",
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function queryString(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function intervalForApi(interval) {
  const key = String(interval).trim().toUpperCase();
  const intervals = {
    "1M": "1",
    "3M": "3",
    "5M": "5",
    "15M": "15",
    "30M": "30",
    "60M": "60",
    "120M": "120",
    "240M": "240",
    "360M": "360",
    "720M": "720",
    "1D": "D",
    "1W": "W",
    "1MO": "M",
  };
  if (!intervals[key]) throw new Error(`Unsupported Bybit kline interval: ${interval}.`);
  return intervals[key];
}

function normalizedOrderStatus(status) {
  return ORDER_STATUS_MAP[status] || String(status || "").toUpperCase() || "UNKNOWN";
}

function hasExposure(position) {
  return Number(position && position.size) > 0 && ["Buy", "Sell"].includes(position.side);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value) {
  return Math.max(0, Number(value || 0));
}

function parseUnifiedUsdtBalance(result, settleCoin = "USDT") {
  const account = Array.isArray(result && result.list) ? result.list[0] : null;
  if (!account) {
    throw new Error("Bybit wallet response did not include a Unified account balance object.");
  }

  const coin = Array.isArray(account.coin)
    ? account.coin.find((item) => item.coin === settleCoin) || null
    : null;
  const accountAvailable = numberOrNull(account.totalAvailableBalance);
  const accountEquity = numberOrNull(account.totalEquity);
  const accountMarginBalance = numberOrNull(account.totalMarginBalance);
  const accountInitialMargin = numberOrNull(account.totalInitialMargin);
  const accountFallbackAvailable =
    accountMarginBalance !== null && accountInitialMargin !== null
      ? Math.max(0, accountMarginBalance - accountInitialMargin)
      : null;

  const coinEquity = numberOrNull(coin && coin.equity);
  const coinWalletBalance = numberOrNull(coin && coin.walletBalance);
  const coinUsdValue = numberOrNull(coin && coin.usdValue);
  const coinTotalOrderIM = nonNegative(numberOrNull(coin && coin.totalOrderIM));
  const coinTotalPositionIM = nonNegative(numberOrNull(coin && coin.totalPositionIM));
  const coinLocked = nonNegative(numberOrNull(coin && coin.locked));
  const coinBonus = nonNegative(numberOrNull(coin && coin.bonus));
  const coinCanBeUsedAsMargin =
    !coin || (coin.marginCollateral !== false && coin.collateralSwitch !== false);
  const coinAvailableFromWallet =
    coinCanBeUsedAsMargin && coinWalletBalance !== null
      ? Math.max(0, coinWalletBalance - coinTotalPositionIM - coinTotalOrderIM - coinLocked - coinBonus)
      : null;
  const coinAvailableFromEquity =
    coinCanBeUsedAsMargin && coinEquity !== null
      ? Math.max(0, coinEquity - coinTotalPositionIM - coinTotalOrderIM - coinLocked - coinBonus)
      : null;

  const availableCandidates = [
    { source: "account.totalAvailableBalance", value: accountAvailable },
    { source: `${settleCoin}.walletBalance - totalPositionIM - totalOrderIM - locked - bonus`, value: coinAvailableFromWallet },
    { source: `${settleCoin}.equity - totalPositionIM - totalOrderIM - locked - bonus`, value: coinAvailableFromEquity },
    { source: "account.totalMarginBalance - account.totalInitialMargin", value: accountFallbackAvailable },
  ].filter((candidate) => candidate.value !== null && Number.isFinite(candidate.value));
  const positiveCandidate = availableCandidates.find((candidate) => candidate.value > 0);
  const selectedAvailable = positiveCandidate || availableCandidates[0] || { source: "unavailable", value: 0 };
  const equityCandidates = [
    { source: "account.totalEquity", value: accountEquity },
    { source: `${settleCoin}.equity`, value: coinEquity },
    { source: `${settleCoin}.walletBalance`, value: coinWalletBalance },
    { source: `${settleCoin}.usdValue`, value: coinUsdValue },
  ].filter((candidate) => candidate.value !== null && Number.isFinite(candidate.value));
  const selectedEquity = equityCandidates.find((candidate) => candidate.value > 0) || equityCandidates[0] || { source: "unavailable", value: 0 };

  return {
    available: selectedAvailable.value,
    equity: selectedEquity.value,
    transferableUsableMargin: selectedAvailable.value,
    parseSource: selectedAvailable.source,
    equitySource: selectedEquity.source,
    accountAvailable,
    accountEquity,
    accountMarginBalance,
    accountInitialMargin,
    accountFallbackAvailable,
    coinAvailableFromWallet,
    coinAvailableFromEquity,
    coinEquity,
    coinWalletBalance,
    coinUsdValue,
    coinCanBeUsedAsMargin,
    coin: coin || null,
    account,
    rawResponse: result,
  };
}

class BybitClient extends EventEmitter {
  constructor(config, log, WebSocketImpl = WebSocket) {
    super();
    this.config = config;
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.nextRequestAt = 0;
    this.requestQueue = Promise.resolve();
    this.tickers = new Map();
    this.tickerTopics = new Set();
    this.instrumentCache = null;
    this.sockets = { public: null, private: null };
    this.heartbeatTimers = { public: null, private: null };
    this.reconnectTimers = { public: null, private: null };
    this.reconnectAttempts = { public: 0, private: 0 };
    this.streamsStopped = false;
    this.privateStreamEnabled = false;
  }

  positionIdx(side) {
    if (this.config.bybitPositionMode !== "HEDGE") return 0;
    return side === "LONG" ? 1 : 2;
  }

  async waitForRequestSlot() {
    const now = Date.now();
    const requestAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = requestAt + this.config.apiRequestIntervalMs;
    const delay = requestAt - now;
    if (delay > 0) await sleep(delay);
  }

  async request(url, options = {}, acceptedCodes = []) {
    const operation = this.requestQueue.then(() => this.performRequest(url, options, acceptedCodes));
    this.requestQueue = operation.catch(() => undefined);
    return operation;
  }

  async performRequest(url, options, acceptedCodes) {
    let lastError;
    for (let attempt = 1; attempt <= REQUEST_RETRIES + 1; attempt += 1) {
      await this.waitForRequestSlot();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const text = await response.text();
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch (_error) {
          const parseError = new Error(`Bybit returned non-JSON data with HTTP ${response.status}: ${text.slice(0, 160) || "<empty body>"}.`);
          parseError.retryable = response.status === 429 || response.status >= 500;
          parseError.rateLimited = response.status === 429;
          throw parseError;
        }
        if (!text) {
          const emptyError = new Error(`Bybit returned an empty response body with HTTP ${response.status}.`);
          emptyError.retryable = response.status === 429 || response.status >= 500;
          emptyError.rateLimited = response.status === 429;
          throw emptyError;
        }
        const classification = classifyBybitResult(payload, response.status);
        const retCode = classification.retCode;
        if (classification.type === "IDEMPOTENT_SUCCESS_OR_NO_CHANGE") {
          this.log("INFO", "BYBIT_NO_CHANGE_TREATED_AS_SUCCESS", {
            retCode,
            retMsg: classification.retMsg,
            recoveryEscalationAvoided: true,
            apiErrorCounterIgnored: true,
          });
          return { ...(payload.result || {}), notModified: true, retCode, retMsg: classification.retMsg };
        }
        if (!response.ok || (retCode !== 0 && !acceptedCodes.includes(retCode))) {
          const error = new Error(`Bybit request failed (HTTP ${response.status}, code ${payload.retCode}): ${payload.retMsg || "unknown error"}.`);
          error.retCode = retCode;
          error.bybitClassification = classification.type;
          error.rateLimited = classification.rateLimited;
          error.retryable = classification.retryable;
          throw error;
        }
        if (attempt > 1) this.log("INFO", "Bybit REST connection recovered.", { attempt });
        if (retCode !== 0 && acceptedCodes.includes(retCode)) {
          return { ...(payload.result || {}), acceptedRetCode: retCode, retMsg: payload.retMsg || "" };
        }
        return payload.result || {};
      } catch (caught) {
        lastError = caught.name === "AbortError" ? Object.assign(new Error("Bybit request timed out."), { retryable: true }) : caught;
        if (lastError.rateLimited) {
          this.log("WARN", "Bybit rate limit reached; cooling down before retry.", {
            cooldownMs: this.config.apiRateLimitCooldownMs,
          });
          this.log("WARN", "API_RATE_LIMIT_COOLDOWN", {
            cooldownMs: this.config.apiRateLimitCooldownMs,
            attempt,
            tradingBlockedOnlyForCooldown: true,
          });
          await sleep(this.config.apiRateLimitCooldownMs);
        }
        const retryable = lastError.retryable !== false && attempt <= REQUEST_RETRIES;
        if (!retryable) throw lastError;
        this.log("WARN", "Bybit request failed; retrying.", { attempt, error: lastError.message });
        await sleep(Math.min(2000, attempt * 300));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async publicGet(endpoint, params = {}) {
    const query = queryString(params);
    return this.request(`${this.config.restBaseUrl}${endpoint}${query ? `?${query}` : ""}`, {
      headers: { Accept: "application/json" },
    });
  }

  async privateRequest(method, endpoint, params = {}, body, acceptedCodes = []) {
    const requestMethod = String(method).toUpperCase();
    const timestamp = String(Date.now());
    const recvWindow = String(this.config.recvWindowMs);
    const query = queryString(params);
    const bodyText = requestMethod === "GET" ? "" : JSON.stringify(body || {});
    const signedContent = requestMethod === "GET" ? query : bodyText;
    const payloadToSign = `${timestamp}${this.config.apiKey}${recvWindow}${signedContent}`;
    const signature = crypto
      .createHmac("sha256", Buffer.from(this.config.apiSecret, "utf8"))
      .update(Buffer.from(payloadToSign, "utf8"))
      .digest("hex");
    this.log("DEBUG", "Bybit authenticated REST request signed.", {
      method: requestMethod,
      requestPath: endpoint,
      timestamp: Number(timestamp),
      signatureLength: signature.length,
    });
    const headers = {
      Accept: "application/json",
      "X-BAPI-API-KEY": this.config.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
    };
    if (requestMethod !== "GET") headers["Content-Type"] = "application/json";
    const url = `${this.config.restBaseUrl}${endpoint}${query ? `?${query}` : ""}`;
    return this.request(url, { method: requestMethod, headers, body: bodyText || undefined }, acceptedCodes);
  }

  async getSymbols() {
    if (this.instrumentCache && Date.now() - this.instrumentCache.time < 10 * 60 * 1000) return this.instrumentCache.list;
    const list = [];
    let cursor = "";
    do {
      const page = await this.publicGet("/v5/market/instruments-info", {
        category: this.config.category,
        status: "Trading",
        limit: 1000,
        cursor: cursor || undefined,
      });
      list.push(...(Array.isArray(page.list) ? page.list : []));
      cursor = page.nextPageCursor || "";
    } while (cursor);
    this.instrumentCache = { time: Date.now(), list };
    return list;
  }

  refreshSession() {
    this.instrumentCache = null;
    this.tickers.clear();
    this.log("INFO", "Bybit REST session cache refreshed.", {
      instrumentCacheCleared: true,
      tickerCacheCleared: true,
    });
  }

  async getTickers() {
    const result = await this.publicGet("/v5/market/tickers", { category: this.config.category });
    const list = Array.isArray(result.list) ? result.list : [];
    for (const ticker of list) this.tickers.set(ticker.symbol, { ...ticker, receivedAt: Date.now() });
    return list;
  }

  async getTicker(symbol) {
    const streamed = this.tickers.get(symbol);
    if (streamed && Date.now() - streamed.receivedAt < 5000) return streamed;
    const result = await this.publicGet("/v5/market/tickers", { category: this.config.category, symbol });
    const ticker = Array.isArray(result.list) ? result.list[0] : null;
    if (ticker) this.tickers.set(symbol, { ...ticker, receivedAt: Date.now() });
    return ticker;
  }

  async getKlines(symbol, interval, limit = 100) {
    const result = await this.publicGet("/v5/market/kline", {
      category: this.config.category,
      symbol,
      interval: intervalForApi(interval),
      limit,
    });
    return (Array.isArray(result.list) ? result.list : []).map((candle) => ({
      time: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5],
      turnover: candle[6],
    }));
  }

  async getPositions(symbol) {
    const list = [];
    let cursor = "";
    do {
      const page = await this.privateRequest("GET", "/v5/position/list", {
        category: this.config.category,
        symbol: symbol || undefined,
        settleCoin: symbol ? undefined : this.config.settleCoin,
        limit: 200,
        cursor: cursor || undefined,
      });
      list.push(...(Array.isArray(page.list) ? page.list : []));
      cursor = page.nextPageCursor || "";
    } while (cursor);
    return list;
  }

  async getOpenOrders(symbol) {
    const result = await this.privateRequest("GET", "/v5/order/realtime", {
      category: this.config.category,
      symbol: symbol || undefined,
      settleCoin: symbol ? undefined : this.config.settleCoin,
      openOnly: 0,
      limit: 50,
    });
    return (Array.isArray(result.list) ? result.list : []).filter((order) => ACTIVE_ORDER_STATUSES.has(order.orderStatus));
  }

  async getOrder(orderId, orderLinkId, symbol) {
    const params = {
      category: this.config.category,
      symbol,
      orderId: orderId || undefined,
      orderLinkId: orderId ? undefined : orderLinkId,
    };
    let result = await this.privateRequest("GET", "/v5/order/realtime", params);
    let order = Array.isArray(result.list) ? result.list[0] : null;
    if (!order) {
      result = await this.privateRequest("GET", "/v5/order/history", params);
      order = Array.isArray(result.list) ? result.list[0] : null;
    }
    return order ? { ...order, normalizedStatus: normalizedOrderStatus(order.orderStatus) } : null;
  }

  async getUsdtBalance() {
    const result = await this.privateRequest("GET", "/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: this.config.settleCoin,
    });
    const parsed = parseUnifiedUsdtBalance(result, this.config.settleCoin);
    this.log("INFO", "Bybit UTA wallet balance parsed.", {
      rawWalletResponse: parsed.rawResponse,
      parsedAvailableBalance: parsed.available,
      parsedTotalEquity: parsed.equity,
      parsedTransferableUsableMargin: parsed.transferableUsableMargin,
      parseSource: parsed.parseSource,
      equitySource: parsed.equitySource,
      accountAvailable: parsed.accountAvailable,
      coinAvailableFromWallet: parsed.coinAvailableFromWallet,
      coinAvailableFromEquity: parsed.coinAvailableFromEquity,
      coinCanBeUsedAsMargin: parsed.coinCanBeUsedAsMargin,
    });
    if (!Number.isFinite(parsed.available) || !Number.isFinite(parsed.equity)) {
      throw new Error("Could not read Unified Trading USDT available balance and equity from Bybit wallet response.");
    }
    return parsed;
  }

  async setLeverage(symbol, leverage) {
    return this.privateRequest(
      "POST",
      "/v5/position/set-leverage",
      {},
      { category: this.config.category, symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) },
      [110043, 34040]
    );
  }

  async getLeverage(symbol, side) {
    const positionIdx = this.positionIdx(side);
    const positions = await this.getPositions(symbol);
    const selected = positions.find((position) => Number(position.positionIdx) === positionIdx) || positions[0];
    const leverage = Number(selected && selected.leverage);
    return {
      leverage: Number.isFinite(leverage) ? leverage : null,
      rawResponse: positions,
    };
  }

  async switchPositionMode() {
    return this.privateRequest(
      "POST",
      "/v5/position/switch-mode",
      {},
      {
        category: this.config.category,
        coin: this.config.settleCoin,
        mode: this.config.bybitPositionMode === "HEDGE" ? 3 : 0,
      },
      [110025]
    );
  }

  async placeMarketOrder(order) {
    const body = {
      category: this.config.category,
      symbol: order.symbol,
      side: order.side,
      orderType: "Market",
      qty: order.qty,
      positionIdx: order.positionIdx,
      orderLinkId: order.orderLinkId,
      reduceOnly: Boolean(order.reduceOnly),
    };
    if (!body.reduceOnly) {
      if (order.takeProfit !== undefined && order.takeProfit !== null && order.takeProfit !== "") {
        Object.assign(body, {
          takeProfit: order.takeProfit,
          tpslMode: "Full",
          tpOrderType: "Market",
          tpTriggerBy: "MarkPrice",
        });
      }
      if (order.stopLoss !== undefined && order.stopLoss !== null && order.stopLoss !== "") {
        Object.assign(body, {
          stopLoss: order.stopLoss,
          tpslMode: "Full",
          slOrderType: "Market",
          slTriggerBy: "MarkPrice",
        });
      }
    }
    return this.privateRequest("POST", "/v5/order/create", {}, body);
  }

  async placeLimitOrder(order) {
    const body = {
      category: this.config.category,
      symbol: order.symbol,
      side: order.side,
      orderType: "Limit",
      qty: order.qty,
      price: order.price,
      timeInForce: order.postOnly ? "PostOnly" : "GTC",
      positionIdx: order.positionIdx,
      orderLinkId: order.orderLinkId,
      reduceOnly: Boolean(order.reduceOnly),
    };
    if (!body.reduceOnly) {
      if (order.takeProfit !== undefined && order.takeProfit !== null && order.takeProfit !== "") {
        Object.assign(body, {
          takeProfit: order.takeProfit,
          tpslMode: "Full",
          tpOrderType: "Market",
          tpTriggerBy: "MarkPrice",
        });
      }
      if (order.stopLoss !== undefined && order.stopLoss !== null && order.stopLoss !== "") {
        Object.assign(body, {
          stopLoss: order.stopLoss,
          tpslMode: "Full",
          slOrderType: "Market",
          slTriggerBy: "MarkPrice",
        });
      }
    }
    return this.privateRequest("POST", "/v5/order/create", {}, body);
  }

  async setTradingStop(position) {
    return this.privateRequest(
      "POST",
      "/v5/position/trading-stop",
      {},
      {
        category: this.config.category,
        symbol: position.symbol,
        positionIdx: position.positionIdx,
        tpslMode: "Full",
        takeProfit: position.takeProfit,
        stopLoss: position.stopLoss,
        tpTriggerBy: "MarkPrice",
        slTriggerBy: "MarkPrice",
        tpOrderType: "Market",
        slOrderType: "Market",
        trailingStop: position.trailingStop,
        activePrice: position.activePrice,
      },
      [34040]
    );
  }

  async cancelAllOrders(symbol) {
    return this.privateRequest("POST", "/v5/order/cancel-all", {}, { category: this.config.category, symbol });
  }

  startWebSockets({ privateStream = false } = {}) {
    this.streamsStopped = false;
    this.privateStreamEnabled = privateStream;
    this.connectStream("public");
    if (privateStream) this.connectStream("private");
  }

  reconnectWebSockets(reason = "api auto-recovery") {
    const privateStream = this.privateStreamEnabled;
    this.log("WARN", "API auto-recovery triggered: reconnecting websocket streams.", {
      reason,
      privateStream,
    });
    this.streamsStopped = true;
    for (const kind of ["public", "private"]) {
      this.stopHeartbeat(kind);
      if (this.reconnectTimers[kind]) clearTimeout(this.reconnectTimers[kind]);
      this.reconnectTimers[kind] = null;
      const socket = this.sockets[kind];
      if (socket) {
        try {
          socket.close();
        } catch (_error) {
          // A broken socket should not block recovery.
        }
      }
      this.sockets[kind] = null;
      this.reconnectAttempts[kind] = 0;
    }
    this.streamsStopped = false;
    this.startWebSockets({ privateStream });
  }

  subscribeTickers(symbols) {
    for (const symbol of symbols) this.tickerTopics.add(`tickers.${symbol}`);
    const socket = this.sockets.public;
    if (socket && socket.readyState === this.WebSocketImpl.OPEN) this.sendTickerSubscriptions(socket);
  }

  connectStream(kind) {
    if (this.streamsStopped) return;
    const endpoint = kind === "public" ? "/v5/public/linear" : "/v5/private";
    const baseUrl = kind === "public" ? this.config.publicWsBaseUrl || this.config.wsBaseUrl : this.config.privateWsBaseUrl || this.config.wsBaseUrl;
    const socket = new this.WebSocketImpl(`${baseUrl}${endpoint}`);
    this.sockets[kind] = socket;
    socket.on("open", () => {
      const wasReconnect = this.reconnectAttempts[kind] > 0;
      this.reconnectAttempts[kind] = 0;
      this.log("INFO", wasReconnect ? "WEBSOCKET RECONNECTED" : "WebSocket connected.", { stream: kind });
      this.startHeartbeat(kind, socket);
      if (kind === "public") {
        this.sendTickerSubscriptions(socket);
      } else {
        const expires = Date.now() + 10000;
        const signature = crypto
          .createHmac("sha256", Buffer.from(this.config.apiSecret, "utf8"))
          .update(Buffer.from(`GET/realtime${expires}`, "utf8"))
          .digest("hex");
        socket.send(JSON.stringify({ op: "auth", args: [this.config.apiKey, expires, signature] }));
      }
    });
    socket.on("message", (raw) => this.handleStreamMessage(kind, raw));
    socket.on("error", (error) => this.log("WARN", "WebSocket error.", { stream: kind, error: error.message }));
    socket.on("close", () => {
      this.stopHeartbeat(kind);
      if (this.streamsStopped) return;
      this.reconnectAttempts[kind] += 1;
      const waitMs = Math.min(30000, this.config.wsReconnectBaseMs * 2 ** Math.min(5, this.reconnectAttempts[kind] - 1));
      this.log("WARN", "WebSocket disconnected; reconnect scheduled.", { stream: kind, waitMs });
      this.reconnectTimers[kind] = setTimeout(() => this.connectStream(kind), waitMs);
    });
  }

  startHeartbeat(kind, socket) {
    this.stopHeartbeat(kind);
    this.heartbeatTimers[kind] = setInterval(() => {
      if (socket.readyState === this.WebSocketImpl.OPEN) socket.send(JSON.stringify({ op: "ping" }));
    }, 20000);
  }

  stopHeartbeat(kind) {
    if (this.heartbeatTimers[kind]) clearInterval(this.heartbeatTimers[kind]);
    this.heartbeatTimers[kind] = null;
  }

  sendTickerSubscriptions(socket) {
    const topics = [...this.tickerTopics];
    for (let index = 0; index < topics.length; index += 100) {
      socket.send(JSON.stringify({ op: "subscribe", args: topics.slice(index, index + 100) }));
    }
  }

  handleStreamMessage(kind, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (_error) {
      return;
    }
    if (kind === "private" && message.op === "auth" && message.success) {
      const socket = this.sockets.private;
      if (socket && socket.readyState === this.WebSocketImpl.OPEN) {
        socket.send(JSON.stringify({ op: "subscribe", args: ["order.linear", "execution.linear", "position.linear"] }));
      }
      this.log("INFO", "Private WebSocket authenticated.");
      return;
    }
    if (kind === "public" && String(message.topic || "").startsWith("tickers.") && message.data) {
      const symbol = message.data.symbol || String(message.topic).split(".")[1];
      this.tickers.set(symbol, { ...(this.tickers.get(symbol) || {}), ...message.data, receivedAt: Date.now() });
      this.emit("ticker", this.tickers.get(symbol));
      return;
    }
    if (kind !== "private" || !Array.isArray(message.data)) return;
    if (message.topic === "order.linear") {
      for (const order of message.data) this.emit("order", { ...order, normalizedStatus: normalizedOrderStatus(order.orderStatus) });
    } else if (message.topic === "execution.linear") {
      for (const execution of message.data) this.emit("execution", execution);
    } else if (message.topic === "position.linear") {
      for (const position of message.data) this.emit("position", position);
    }
  }

  stopWebSockets() {
    this.streamsStopped = true;
    for (const kind of ["public", "private"]) {
      this.stopHeartbeat(kind);
      if (this.reconnectTimers[kind]) clearTimeout(this.reconnectTimers[kind]);
      const socket = this.sockets[kind];
      if (socket) socket.close();
      this.sockets[kind] = null;
    }
  }
}

module.exports = {
  BybitClient,
  hasExposure,
  intervalForApi,
  normalizedOrderStatus,
  parseUnifiedUsdtBalance,
  queryString,
};
