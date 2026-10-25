"use strict";

const crypto = require("crypto");
const { EventEmitter } = require("events");
const WebSocket = require("ws");
const C = require("./constants.cjs");
const { base58Encode } = require("./base58.cjs");

const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
// Coin names are chosen by strangers: no control characters into the terminal.
const clean = (x, max) => String(x || "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max);

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
    name: clean(m.name, 40),
    symbol: clean(m.symbol, 16),
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

// Anchor event discriminator: first 8 bytes of sha256("event:<Name>").
const eventDiscriminator = (name) => crypto.createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const CREATE_EVENT = eventDiscriminator("CreateEvent");
const TRADE_EVENT = eventDiscriminator("TradeEvent");

// Minimal Borsh reader; throws past the end of the data.
function borsh(buf, offset) {
  let o = offset;
  const take = (n) => {
    if (o + n > buf.length) throw new RangeError("event data too short");
    o += n;
    return o - n;
  };
  return {
    u8: () => buf[take(1)],
    u64: () => Number(buf.readBigUInt64LE(take(8))),
    key: () => base58Encode(buf.subarray(take(32), o)),
    str: () => {
      const n = buf.readUInt32LE(take(4));
      if (n > 1000) throw new RangeError("string too long");
      return buf.toString("utf8", take(n), o);
    },
  };
}

// pump.fun CreateEvent starts name, symbol, uri, mint, bonding_curve, user; newer
// program versions append fields after these, which are not needed here.
function decodeCreateEvent(data) {
  const r = borsh(data, 8);
  return { name: r.str(), symbol: r.str(), uri: r.str(), mint: r.key(), bondingCurve: r.key(), user: r.key() };
}

// pump.fun TradeEvent starts mint, sol_amount, token_amount, is_buy, user (more appended).
function decodeTradeEvent(data) {
  const r = borsh(data, 8);
  return { mint: r.key(), solAmount: r.u64() / C.LAMPORTS_PER_SOL, tokenAmount: r.u64() / C.TOKEN_UNIT, isBuy: r.u8() === 1, user: r.key() };
}

// "Program data:" lines logged by the pump.fun program itself. The invoke stack tells
// which program is running, so another program in the same transaction can't fake one.
function pumpEventData(logs) {
  const stack = [];
  const out = [];
  for (const line of logs || []) {
    const call = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (call) stack.push(call[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if (line.startsWith("Program data: ") && stack[stack.length - 1] === C.PUMP_PROGRAM_ID) {
      out.push(Buffer.from(line.slice("Program data: ".length), "base64"));
    }
  }
  return out;
}

/**
 * Launches in a create transaction, read from the events pump.fun logs, so no extra
 * RPC call is needed. bondingCurveOf(mint), when given, must match each event's curve
 * address. [] when the logs hold no readable CreateEvent (e.g. truncated logs).
 */
function parseCreateLogs(logs, nowMs, bondingCurveOf = null) {
  const creates = [];
  const trades = [];
  for (const data of pumpEventData(logs)) {
    try {
      if (data.subarray(0, 8).equals(CREATE_EVENT)) creates.push(decodeCreateEvent(data));
      else if (data.subarray(0, 8).equals(TRADE_EVENT)) trades.push(decodeTradeEvent(data));
    } catch (_) { /* unreadable event: the caller falls back to fetching the transaction */ }
  }
  const out = [];
  for (const c of creates) {
    if (bondingCurveOf && bondingCurveOf(c.mint) !== c.bondingCurve) continue;
    // The creator's own buy inside the launch transaction (0 if they bought nothing).
    const devBuys = trades.filter((t) => t.isBuy && t.mint === c.mint && t.user === c.user);
    out.push({
      mint: c.mint,
      creator: c.user,
      bondingCurve: c.bondingCurve,
      name: clean(c.name, 40),
      symbol: clean(c.symbol, 16),
      devBuySol: devBuys.reduce((a, t) => a + t.solAmount, 0),
      devTokens: devBuys.reduce((a, t) => a + t.tokenAmount, 0),
      vSol: NaN,
      vTok: NaN,
      createdAtMs: nowMs,
    });
  }
  return out;
}

// A fetched create transaction: its logged events, else the token balances (a create
// leaves almost the whole supply in the curve's token account).
function parseCreateTx(tx, nowMs, bondingCurveOf = null) {
  const fromLogs = parseCreateLogs(tx && tx.meta && tx.meta.logMessages, nowMs, bondingCurveOf);
  if (fromLogs.length) return fromLogs[0];
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
 * Discovery straight from Solana: subscribe to pump.fun program logs and read each
 * launch from the events in them. Only launches whose logs can't be read cost an RPC
 * call (getTransaction, a few at a time, retried for up to maxWaitMs).
 */
class RpcLogsFeed extends EventEmitter {
  constructor({ conn, derive = null, maxWaitMs = 30000, concurrency = 3, clock = Date.now }) {
    super();
    this.conn = conn;
    this.bondingCurveOf = derive && derive.bondingCurve;
    this.maxWaitMs = maxWaitMs;
    this.concurrency = concurrency;
    this.clock = clock;
    this.queue = [];
    this.creates = 0;
    this.fromLogs = 0;
    this.launches = 0;
    this.missed = 0;
  }

  start() {
    const { PublicKey } = require("@solana/web3.js");
    this.subId = this.conn.onLogs(new PublicKey(C.PUMP_PROGRAM_ID), (l) => this.onLogs(l), "confirmed");
    this.timer = setInterval(() => this.drain(), 400);
    this.emit("status", "listening to pump.fun program logs via RPC");
  }

  onLogs(l) {
    if (!l || l.err || !l.logs || !l.logs.some((x) => /Instruction: Create(V2)?$/.test(x))) return;
    const now = this.clock();
    this.launches++;
    const evts = parseCreateLogs(l.logs, now, this.bondingCurveOf);
    if (!evts.length) this.queue.push({ sig: l.signature, at: now, tries: 0, next: now });
    this.fromLogs += evts.length;
    for (const e of evts) this.found(e);
    if (!this.warned && this.launches >= 20 && this.fromLogs < this.launches / 2) {
      this.warned = true;
      this.emit("status", `only ${this.fromLogs} of ${this.launches} launches were readable from the logs; the rest need a slower transaction lookup`);
    }
  }

  found(evt) {
    this.creates++;
    this.emit("create", evt);
  }

  async drain() {
    if (this.busy) return;
    const now = this.clock();
    const due = this.queue.filter((j) => j.next <= now).slice(0, this.concurrency);
    if (!due.length) return;
    this.busy = true;
    this.queue = this.queue.filter((j) => !due.includes(j));
    try {
      await Promise.all(due.map((job) => this.lookup(job)));
    } catch (e) {
      this.emit("status", `rpc feed error: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  async lookup(job) {
    const tx = await this.conn.getTransaction(job.sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (tx) {
      const evt = parseCreateTx(tx, job.at, this.bondingCurveOf);
      if (evt) this.found(evt);
      return;
    }
    // Not visible to this RPC node yet, or rate-limited: back off and try again.
    const now = this.clock();
    job.tries++;
    if (now - job.at < this.maxWaitMs) {
      job.next = now + Math.min(4000, 250 * 2 ** job.tries);
      this.queue.push(job);
    } else this.missed++;
  }

  stop() {
    clearInterval(this.timer);
    if (this.subId !== undefined) this.conn.removeOnLogsListener(this.subId).catch(() => {});
  }
}

module.exports = { PumpPortalFeed, RpcLogsFeed, normalizeCreate, parseCreateTx, parseCreateLogs, CREATE_EVENT, TRADE_EVENT };
