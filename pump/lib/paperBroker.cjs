"use strict";

const C = require("./constants.cjs");
const curve = require("./curve.cjs");

/**
 * Simulated execution against the real curve state. An order decided at tick N
 * fills at the first poll at least `latencyMs` later, at that poll's reserves,
 * which is roughly how long a real PumpPortal request + Solana confirmation takes.
 * Charges pump.fun + PumpPortal fees, priority/base fees and token-account rent
 * (refunded when the position is fully closed), exactly like the live bot pays.
 */
class PaperBroker {
  constructor(cfg, tracker, startSol) {
    this.mode = "paper";
    this.c = cfg.costs;
    this.tracker = tracker;
    this.cash = startSol;
    this.pending = [];
    this.holdings = new Map(); // mint -> tokens
  }

  feeFraction() {
    return (this.c.pumpFeePct + this.c.portalFeePct) / 100;
  }

  txCostSol() {
    return this.c.priorityFeeSol + C.BASE_FEE_SOL;
  }

  availableSol() {
    const committed = this.pending.filter((o) => o.type === "buy").reduce((a, o) => a + o.sol, 0);
    return this.cash - committed;
  }

  buy({ mint, sol, decisionPrice, nowMs }) {
    return new Promise((resolve) => this.pending.push({ type: "buy", mint, sol, decisionPrice, at: nowMs, resolve }));
  }

  sell({ mint, fraction, nowMs }) {
    return new Promise((resolve) => this.pending.push({ type: "sell", mint, fraction, at: nowMs, resolve }));
  }

  onTick(nowMs) {
    const still = [];
    for (const o of this.pending) {
      const t = this.tracker.tokens.get(o.mint);
      const last = t && t.last;
      const ready = nowMs - o.at >= this.c.latencyMs && last && last.t > o.at;
      // A token that vanished from the tracker can't be priced; fail buys, keep sells waiting.
      if (!t && o.type === "buy") { o.resolve({ ok: false, error: "token-gone", feesSol: 0 }); continue; }
      if (!ready) { still.push(o); continue; }
      o.resolve(o.type === "buy" ? this.fillBuy(o, last) : this.fillSell(o, last));
    }
    this.pending = still;
  }

  fillBuy(o, last) {
    const tx = this.txCostSol();
    const mark = curve.price(last.vSol, last.vTok);
    if (last.complete) {
      this.cash -= tx;
      return { ok: false, error: "complete", feesSol: tx };
    }
    if ((mark / o.decisionPrice - 1) * 100 > this.c.buySlippagePct) {
      this.cash -= tx; // a slippage-failed transaction still pays its fee
      return { ok: false, error: "slippage", feesSol: tx };
    }
    const rent = this.holdings.has(o.mint) ? 0 : C.TOKEN_ACCOUNT_RENT_SOL;
    if (o.sol + tx + rent > this.cash) return { ok: false, error: "insufficient-funds", feesSol: 0 };
    const intoCurve = o.sol / (1 + this.feeFraction());
    const tokens = curve.quoteBuyTokens(last.vSol, last.vTok, intoCurve);
    this.cash -= o.sol + tx + rent;
    this.holdings.set(o.mint, (this.holdings.get(o.mint) || 0) + tokens);
    return { ok: true, tokens, solSpent: o.sol + tx + rent, rentSol: rent, fillPrice: mark, feesSol: o.sol - intoCurve + tx };
  }

  fillSell(o, last) {
    const tx = this.txCostSol();
    const held = this.holdings.get(o.mint) || 0;
    if (held <= 0) return { ok: false, error: "nothing-to-sell", feesSol: 0 };
    const full = o.fraction >= 0.999;
    const tokens = full ? held : held * o.fraction;
    const fee = this.feeFraction();
    let gross;
    if (last.complete) {
      // Graduated mid-hold: no curve to price against. Haircut the last mark heavily.
      gross = tokens * curve.price(last.vSol, last.vTok) * 0.9;
    } else {
      gross = curve.quoteSellSol(last.vSol, last.vTok, tokens);
    }
    const out = gross * (1 - fee);
    let received = out - tx;
    let rentRefund = 0;
    if (full) {
      this.holdings.delete(o.mint);
      rentRefund = C.TOKEN_ACCOUNT_RENT_SOL;
      received += rentRefund - tx; // close-account transaction refunds the rent
    } else {
      this.holdings.set(o.mint, held - tokens);
    }
    this.cash += received;
    return { ok: true, tokensSold: tokens, solReceived: received, rentRefund, closed: full, feesSol: gross - out + tx * (full ? 2 : 1) };
  }

  // Value of everything held right now, if sold at the current curve price.
  markToMarketSol() {
    let v = 0;
    for (const [mint, tokens] of this.holdings) {
      const t = this.tracker.tokens.get(mint);
      if (!t || !t.last) continue;
      v += curve.liquidationValueSol(t.last.vSol, t.last.vTok, tokens, this.feeFraction()) + C.TOKEN_ACCOUNT_RENT_SOL;
    }
    return v;
  }
}

module.exports = { PaperBroker };
