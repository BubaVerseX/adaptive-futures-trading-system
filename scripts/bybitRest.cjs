/**
 * scripts/bybitRest.cjs
 *
 * Shared Bybit V5 signed-REST helper — same signing/rounding pattern that
 * v33PowerPilot.cjs and overnightRegimeGatedLive.cjs each already implement
 * inline. Extracted here so riskTool.cjs (and anything else added later)
 * can require() it instead of re-copying the pattern a fourth time. The
 * existing live pilots are left untouched — this module doesn't replace
 * their inline copies, it just avoids adding yet another one.
 *
 * Pure request/signing logic only. No strategy logic, no state.
 */

const https = require("https");
const crypto = require("crypto");

function decimalsOf(step) {
  const str = String(step);
  if (str.includes("e-")) return parseInt(str.split("e-")[1], 10);
  const idx = str.indexOf(".");
  return idx === -1 ? 0 : str.length - idx - 1;
}

function roundQty(rawQty, info) {
  const bumped = Math.max(rawQty, info.minOrderQty);
  const stepped = Math.floor(bumped / info.qtyStep) * info.qtyStep;
  return stepped.toFixed(info.qtyDecimals);
}

function roundPrice(rawPrice, info) {
  const stepped = Math.round(rawPrice / info.tickSize) * info.tickSize;
  return stepped.toFixed(info.priceDecimals);
}

function createBybitClient({ apiKey, apiSecret, testnet = false }) {
  const REST_BASE = testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
  const instrumentInfoCache = {};

  function bybitSign(timestamp, params) {
    const payload = timestamp + apiKey + "5000" + params;
    return crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");
  }

  function httpRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Bad JSON from Bybit: " + data.slice(0, 300))); }
        });
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  function bybitPublicGet(pathAndQuery) {
    return httpRequest("GET", REST_BASE + pathAndQuery, { "Content-Type": "application/json" });
  }

  function bybitPrivateGet(pathName, queryObj) {
    const query = new URLSearchParams(queryObj).toString();
    const timestamp = Date.now().toString();
    const headers = {
      "X-BAPI-API-KEY": apiKey, "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": bybitSign(timestamp, query), "X-BAPI-RECV-WINDOW": "5000", "Content-Type": "application/json",
    };
    return httpRequest("GET", `${REST_BASE}${pathName}?${query}`, headers);
  }

  function bybitPrivatePost(pathName, bodyObj) {
    const body = JSON.stringify(bodyObj);
    const timestamp = Date.now().toString();
    const headers = {
      "X-BAPI-API-KEY": apiKey, "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": bybitSign(timestamp, body), "X-BAPI-RECV-WINDOW": "5000", "Content-Type": "application/json",
    };
    return httpRequest("POST", REST_BASE + pathName, headers, body);
  }

  async function fetchCandles(symbol, interval, limit = 500) {
    const q = new URLSearchParams({ category: "linear", symbol, interval, limit: String(limit) });
    const json = await bybitPublicGet(`/v5/market/kline?${q}`);
    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) {
      throw new Error("Bybit kline fetch failed: " + JSON.stringify(json).slice(0, 300));
    }
    return json.result.list
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
      .sort((a, b) => a.ts - b.ts);
  }

  async function getInstrumentInfo(symbol) {
    if (instrumentInfoCache[symbol]) return instrumentInfoCache[symbol];
    const json = await bybitPublicGet(`/v5/market/instruments-info?category=linear&symbol=${symbol}`);
    if (json.retCode !== 0 || !json.result || !json.result.list || !json.result.list.length) {
      throw new Error(`could not fetch instrument info for ${symbol}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const info = json.result.list[0];
    const qtyStep = parseFloat(info.lotSizeFilter.qtyStep);
    const minOrderQty = parseFloat(info.lotSizeFilter.minOrderQty);
    const tickSize = parseFloat(info.priceFilter.tickSize);
    const cached = { qtyStep, minOrderQty, tickSize, qtyDecimals: decimalsOf(qtyStep), priceDecimals: decimalsOf(tickSize) };
    instrumentInfoCache[symbol] = cached;
    return cached;
  }

  async function getWalletEquity() {
    const json = await bybitPrivateGet("/v5/account/wallet-balance", { accountType: "UNIFIED" });
    if (json.retCode !== 0) throw new Error("wallet-balance failed: " + json.retMsg);
    const acct = json.result.list[0];
    return Number(acct.totalEquity);
  }

  async function getOpenPosition(symbol) {
    const json = await bybitPrivateGet("/v5/position/list", { category: "linear", symbol });
    if (json.retCode !== 0) throw new Error("get position failed: " + json.retMsg);
    return (json.result.list || []).find((p) => Number(p.size) > 0) || null;
  }

  return {
    REST_BASE,
    bybitPublicGet, bybitPrivateGet, bybitPrivatePost,
    fetchCandles, getInstrumentInfo, getWalletEquity, getOpenPosition,
  };
}

module.exports = { createBybitClient, roundQty, roundPrice, decimalsOf };
