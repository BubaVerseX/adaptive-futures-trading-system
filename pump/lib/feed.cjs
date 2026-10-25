"use strict";

const { EventEmitter } = require("events");
const WebSocket = require("ws");
const C = require("./constants.cjs");

const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PumpPortal "create" message -> the tracker's event shape.
function normalizeCreate(m, nowMs) {
  if (!m || m.txType !== "create" || typeof m.mint !== "string") return null;
  if (m.pool && m.pool !== "pump") return null;
  let vSol = num(m.vSolInBondingCurve);
  let vTok = num(m.vTokensInBondingCurve);
  let devTokens = num(m.initialBuy);
  if (vSol > 1e6) vSol /= C.LAMPORTS_PER_SOL; // lamports -> SOL
  if (vTok > 1e12) vTok /= C.TOKEN_UNIT; // raw units -> whole tokens
  if (devTokens > 1e12) devTokens /= C.TOKEN_UNIT;
  return {
    mint: m.mint,
    creator: typeof m.traderPublicKey === "string" ? m.traderPublicKey : null,
    bondingCurve: typeof m.bondingCurveKey === "string" ? m.bondingCurveKey : null,
    name: String(m.name || "").slice(0, 40),
    symbol: String(m.symbol || "").slice(0, 16),
    devBuySol: num(m.solAmount),
    devTokens,
    vSol,
    vTok,
    createdAtMs: nowMs,
  };
}

/**
 * New-coin discovery from PumpPortal's websocket. Only the free streams are used
 * (new tokens + migrations); per-trade data is metered there, so price and flow
 * come from polling the chain instead. One connection, auto-reconnect with backoff.
 */
class PumpPortalFeed extends EventEmitter {
  constructor({ url = C.PUMPPORTAL_WS_URL, apiKey = "", WebSocketImpl = WebSocket } = {}) {
    super();
    this.url = url;
    this.apiKey = apiKey;
    this.WS = WebSocketImpl;
    this.backoff = 1000;
    this.stopped = true;
    this.lastMsgAt = 0;
    this.creates = 0;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && Date.now() - this.lastMsgAt > 90000) {
        this.emit("status", "no data for 90s, reconnecting");
        try { this.ws.terminate(); } catch (_) { /* already gone */ }
      }
    }, 15000);
  }

  connect() {
    const url = this.apiKey ? `${this.url}?api-key=${encodeURIComponent(this.apiKey)}` : this.url;
    const ws = new this.WS(url);
    this.ws = ws;
    this.lastMsgAt = Date.now();
    let reconnecting = false;
    const again = (why) => {
      if (reconnecting || this.stopped) return;
      reconnecting = true;
      this.emit("status", `disconnected (${why}), reconnecting in ${this.backoff / 1000}s`);
      setTimeout(() => !this.stopped && this.connect(), this.backoff);
      this.backoff = Math.min(30000, this.backoff * 2);
    };
    ws.on("open", () => {
      this.backoff = 1000;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      this.emit("status", "connected to PumpPortal");
    });
    ws.on("message", (raw) => {
      this.lastMsgAt = Date.now();
      let m;
      try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      this.handle(m);
    });
    ws.on("error", (e) => this.emit("status", `websocket error: ${e.message}`));
    ws.on("close", (code) => again(`code ${code}`));
  }

  handle(m) {
    const evt = normalizeCreate(m, Date.now());
    if (evt) {
      this.creates++;
      this.emit("create", evt);
      return;
    }
    if (m && (m.txType === "migrate" || m.txType === "migration") && m.mint) this.emit("migration", m.mint);
    else if (m && m.message) this.emit("status", `PumpPortal: ${String(m.message).slice(0, 200)}`);
    else if (m && m.errors) this.emit("status", `PumpPortal error: ${JSON.stringify(m.errors).slice(0, 200)}`);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    try { if (this.ws) this.ws.close(); } catch (_) { /* ignore */ }
  }
}

// A create transaction leaves almost the whole supply in the curve's token account.
function parseCreateTx(tx, nowMs) {
  const balances = (tx && tx.meta && tx.meta.postTokenBalances) || [];
  const curveRow = balances.find((b) => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals > 5e8);
  if (!curveRow) return null;
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys || msg.accountKeys;
  const creator = keys[0].toBase58 ? keys[0].toBase58() : String(keys[0]);
  const devRow = balances.find((b) => b.mint === curveRow.mint && b.owner === creator);
  return {
    mint: curveRow.mint,
    creator,
    bondingCurve: null,
    name: "",
    symbol: "",
    devBuySol: NaN,
    devTokens: devRow ? Number(devRow.uiTokenAmount.amount) / 10 ** devRow.uiTokenAmount.decimals : 0,
    vSol: NaN,
    vTok: NaN,
    createdAtMs: nowMs,
  };
}

/**
 * Fallback discovery straight from Solana: subscribe to pump.fun program logs and
 * read each Create transaction. No PumpPortal needed, but heavier on the RPC.
 */
class RpcLogsFeed extends EventEmitter {
  constructor({ conn }) {
    super();
    this.conn = conn;
    this.queue = [];
    this.creates = 0;
  }

  start() {
    const { PublicKey } = require("@solana/web3.js");
    this.subId = this.conn.onLogs(
      new PublicKey(C.PUMP_PROGRAM_ID),
      (l) => {
        if (l.err || !l.logs.some((x) => /Instruction: Create(V2)?$/.test(x))) return;
        this.queue.push({ sig: l.signature, at: Date.now() });
      },
      "confirmed"
    );
    this.timer = setInterval(() => this.drain(), 400);
    this.emit("status", "listening to pump.fun program logs via RPC");
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      const retry = [];
      while (this.queue.length) {
        const job = this.queue.shift();
        const tx = await this.conn.getTransaction(job.sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
        if (!tx) {
          if (Date.now() - job.at < 8000) retry.push(job);
          continue;
        }
        const evt = parseCreateTx(tx, job.at);
        if (evt) { this.creates++; this.emit("create", evt); }
      }
      this.queue.push(...retry);
      if (retry.length) await sleep(200);
    } catch (e) {
      this.emit("status", `rpc feed error: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  stop() {
    clearInterval(this.timer);
    if (this.subId !== undefined) this.conn.removeOnLogsListener(this.subId).catch(() => {});
  }
}

module.exports = { PumpPortalFeed, RpcLogsFeed, normalizeCreate, parseCreateTx };
