"use strict";

const C = require("./constants.cjs");
const curve = require("./curve.cjs");
const strategy = require("./strategy.cjs");
const { summarizeHolders, curveTokenBalance } = require("./tracker.cjs");

const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const label = (p) => `${p.symbol || "?"} (${p.mint.slice(0, 4)}…${p.mint.slice(-4)})`;
const signed = (x, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);

/**
 * One loop step: poll the curves, fill paper orders, manage exits, look for
 * entries, and hand finished coins to the research log. The same engine runs
 * paper, live and replay; only the broker and the data source change.
 */
class Engine {
  constructor({ cfg, tracker, broker, risk, recorder, rpc, log = () => {}, clock = Date.now }) {
    this.cfg = cfg;
    this.s = cfg.strategy;
    this.rt = cfg.runtime;
    this.tracker = tracker;
    this.broker = broker;
    this.risk = risk;
    this.recorder = recorder;
    this.rpc = rpc;
    this.log = log;
    this.clock = clock;
    this.positions = new Map();
    this.entered = new Map(); // mint -> { count, closedAtMs }
    this.inflight = new Set();
    this.holdersInFlight = 0;
    this.stopping = false;
    this.closedTrades = [];
    this.lastGate = null;
    this.lastPollWarnMs = 0;
    this.layoutWarned = false;
    this.lateFillChecks = []; // live buys that timed out: { mint, symbol, sizeSol, atMs }
    this.lateFillLookups = 0;
    this.stats = { buys: 0, buyFails: 0, sells: 0, sellFails: 0, pollErrors: 0, holdersChecks: 0, lateFills: 0 };
  }

  feeFraction() {
    return (this.cfg.costs.pumpFeePct + this.cfg.costs.portalFeePct) / 100;
  }

  onCreate(evt) {
    this.tracker.add(evt, this.clock());
  }

  // Every async broker/RPC chain goes through here: errors are logged, never left
  // as unhandled rejections (which would kill the process with positions open).
  track(promise) {
    const p = promise.catch((e) => this.log("warn", `internal error: ${e && e.message}`));
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return p;
  }

  busy() {
    return this.positions.size > 0 || this.lateFillChecks.length > 0 || this.lateFillLookups > 0;
  }

  // Waits for everything in flight, including work started by work that was in flight.
  async settle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  async tick(nowMs = this.clock()) {
    const targets = this.tracker.pollTargets(nowMs, new Set(this.positions.keys()));
    if (targets.length) {
      try {
        const accounts = await this.rpc.getAccounts(targets.map((t) => t.key));
        this.tracker.ingest(targets.map((t, i) => ({ ...t, account: accounts[i] })), nowMs);
      } catch (e) {
        this.stats.pollErrors++;
        if (nowMs - this.lastPollWarnMs > 30000) {
          this.lastPollWarnMs = nowMs;
          this.log("warn", `RPC poll failed (${this.stats.pollErrors} so far): ${e.message}`);
        }
      }
    }
    // A stray odd account is harmless (it is skipped); many would mean pump.fun changed its format.
    const st = this.tracker.stats;
    if (!this.layoutWarned && st.badLayout >= 5 && st.badLayout >= 0.2 * st.seen) {
      this.layoutWarned = true;
      this.log("warn", `${st.badLayout} of ${st.seen} coins have an unrecognised curve account; they are skipped. If this keeps growing, pump.fun changed something: tell Claude.`);
    }
    if (this.broker.onTick) this.broker.onTick(nowMs);
    this.checkLateFills(nowMs);
    // Let fills the paper broker just resolved run their handlers before deciding anything.
    await new Promise((r) => setImmediate(r));
    this.manageExits(nowMs);
    if (!this.stopping) this.considerEntries(nowMs);
    for (const t of this.tracker.expire(nowMs, new Set(this.positions.keys()))) this.recorder.recordToken(t);
  }

  manageExits(nowMs) {
    for (const pos of this.positions.values()) {
      if (pos.state !== "open" || nowMs < pos.nextSellAtMs) continue;
      const f = this.tracker.features(pos.mint, nowMs);
      if (pos.forceExit) {
        // A full exit left coins behind (dust, or the chain couldn't be read): finish it.
        this.sell(pos, { action: "sell", fraction: 1, reason: "finish-exit", gainPct: f ? (f.price / pos.entryPrice - 1) * 100 : 0 }, f, nowMs);
        continue;
      }
      if (!f) {
        // No price data for something we hold (e.g. a late fill): get out rather than hold blind.
        this.sell(pos, { action: "sell", fraction: 1, reason: "no-data", gainPct: 0 }, null, nowMs);
        continue;
      }
      strategy.updatePeaks(pos, f);
      pos.lastPrice = f.price;
      pos.lastF = f;
      const d = this.stopping
        ? { action: "sell", fraction: 1, reason: "shutdown", gainPct: (f.price / pos.entryPrice - 1) * 100 }
        : strategy.exitDecision(pos, f, this.s, nowMs);
      if (d.action === "sell") this.sell(pos, d, f, nowMs);
    }
  }

  // A coin is bought once, unless re-entry is switched on: then one more time, after a cooldown.
  blockedCoin(mint, nowMs) {
    const e = this.entered.get(mint);
    if (!e) return false;
    if (!this.s.reentryCooldownSec || e.count >= 2 || e.closedAtMs === null) return true;
    return nowMs - e.closedAtMs < this.s.reentryCooldownSec * 1000;
  }

  considerEntries(nowMs) {
    const exclude = new Set(this.positions.keys());
    for (const mint of this.entered.keys()) if (this.blockedCoin(mint, nowMs)) exclude.add(mint);
    const maxStale = (this.rt.pollMs / 1000) * 2 + 0.5;
    const ready = [];
    for (const f of this.tracker.candidates(nowMs, exclude, maxStale)) {
      const pre = strategy.preEntry(f, this.s);
      const t = this.tracker.tokens.get(f.mint);
      const wantHolders = pre.ok || f.realSol >= this.rt.holdersCheckMinRealSol;
      if (wantHolders && !t.holders && !t.holdersPending && f.ageSec >= this.s.entryMinAgeSec) this.checkHolders(t, nowMs, pre.ok);
      if (pre.ok && strategy.entryDecision(f, this.s).go) ready.push(f);
    }
    ready.sort((a, b) => b.inflow30 - a.inflow30);
    for (const f of ready) {
      const gate = this.risk.canEnter(nowMs, this.positions.size, this.broker.availableSol());
      this.lastGate = gate.ok ? null : gate.reason;
      if (!gate.ok) break;
      const sure = strategy.conviction(f, this.s, this.risk.r.convictionMax);
      this.buy(f, this.risk.sizeFor(this.broker.availableSol(), sure), nowMs, sure);
    }
  }

  checkHolders(t, nowMs, priority) {
    if (this.holdersInFlight >= (priority ? 4 : 2)) return;
    t.holdersPending = true;
    t.holdersAttempts = (t.holdersAttempts || 0) + 1;
    this.holdersInFlight++;
    this.stats.holdersChecks++;
    const ageMs = nowMs - t.createdAtMs;
    const vTok = t.last ? t.last.vTok : null;
    // The curve's own token account is excluded by address. Its token program may not be
    // known yet, so derive it for both programs.
    const curveAtas = t.curveAta
      ? [t.curveAta]
      : this.tracker.derive
        ? [C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID].map((p) => this.tracker.derive.ata(t.bondingCurve, t.mint, p))
        : [];
    this.track(
      this.rpc
        .getLargestHolders(t.mint)
        .then((rows) => {
          const h = summarizeHolders(rows, { curveAtas, curveBalance: vTok ? curveTokenBalance(vTok) : null });
          this.tracker.setHolders(t.mint, { ...h, ageMs });
        })
        .catch((e) => {
          // One retry on the next tick; after that, fail closed (no entry).
          if (t.holdersAttempts < 2) t.holdersPending = false;
          else this.tracker.setHolders(t.mint, { error: String(e.message).slice(0, 80), ageMs });
        })
        .finally(() => { this.holdersInFlight--; })
    );
  }

  buy(f, sizeSol, nowMs, sure = 1) {
    const prev = this.entered.get(f.mint);
    this.entered.set(f.mint, { count: (prev ? prev.count : 0) + 1, closedAtMs: null });
    const pos = {
      mint: f.mint,
      symbol: f.symbol,
      state: "buying",
      decidedAtMs: nowMs,
      openedAtMs: null,
      sizeSol,
      decisionPrice: f.price,
      entryPrice: f.price,
      tokens: 0,
      costSol: 0,
      proceedsSol: 0,
      peakPrice: f.price,
      peakRealSol: f.realSol,
      tp1Done: false,
      exits: [],
      sellFailures: 0,
      nextSellAtMs: 0,
      entry: {
        ageSec: r2(f.ageSec), mcapSol: r2(f.mcapSol), realSol: r2(f.realSol), inflow15: r2(f.inflow15),
        inflow30: r2(f.inflow30), inflow60: r2(f.inflow60), drawdownFromPeakPct: r2(f.drawdownFromPeakPct),
        devBuySol: f.devBuySol, holders: f.holders, conviction: r2(sure),
      },
    };
    this.positions.set(f.mint, pos);
    this.log("trade", `BUY    ${label(pos)}  ${sizeSol.toFixed(4)} SOL${sure > 1.05 ? ` (sure x${sure.toFixed(1)})` : ""} | mcap ${f.mcapSol.toFixed(0)} SOL | +${f.inflow30.toFixed(1)} SOL/30s | age ${f.ageSec.toFixed(0)}s`);
    this.track(
      this.broker
        .buy({ mint: f.mint, sol: sizeSol, decisionPrice: f.price, nowMs })
        .catch((e) => ({ ok: false, error: e.message, feesSol: 0 }))
        .then((res) => this.onBought(pos, res))
    );
  }

  onBought(pos, res) {
    const now = this.clock();
    if (!res.ok || !(res.tokens > 0)) {
      this.positions.delete(pos.mint);
      this.stats.buyFails++;
      this.risk.onFeesOnly(res.feesSol || 0, now);
      this.log("trade", `  buy failed ${label(pos)}: ${res.error || "no tokens received"}`);
      // An unconfirmed transaction can still land later; look again before giving up on it.
      // (One that failed on-chain is final.)
      if (this.broker.tokenBalance && res.sig && !res.final) this.lateFillChecks.push({ mint: pos.mint, symbol: pos.symbol, sizeSol: pos.sizeSol, atMs: now, entry: pos.entry });
      return;
    }
    this.stats.buys++;
    const f = this.tracker.features(pos.mint, now);
    pos.state = "open";
    pos.openedAtMs = now;
    pos.tokens = res.tokens;
    pos.costSol += res.solSpent;
    pos.entryPrice = res.fillPrice || (f ? f.price : pos.decisionPrice);
    pos.peakPrice = pos.entryPrice;
    if (f) {
      pos.peakRealSol = f.realSol;
      pos.lastF = f;
    }
    pos.estimated = !!res.estimated;
    const slip = (pos.entryPrice / pos.decisionPrice - 1) * 100;
    this.log("trade", `  filled ${label(pos)}  cost ${res.solSpent.toFixed(4)} SOL | slippage ${signed(slip, 1)}%${res.sig ? " | tx " + res.sig : ""}`);
  }

  // If coins from a "failed" buy show up after all, adopt them and sell at once.
  checkLateFills(nowMs) {
    const due = this.lateFillChecks.filter((c) => nowMs - c.atMs >= 45000);
    if (!due.length) return;
    this.lateFillChecks = this.lateFillChecks.filter((c) => nowMs - c.atMs < 45000);
    for (const c of due) {
      this.lateFillLookups++;
      this.track(
        this.broker.tokenBalance(c.mint).finally(() => this.lateFillLookups--).then(
          (tokens) => {
            if (!(tokens > 0) || this.positions.has(c.mint)) return;
            this.stats.lateFills++;
            const f = this.tracker.features(c.mint, this.clock());
            const price = f ? f.price : 0;
            const cost = this.broker.estimateBuyCost ? this.broker.estimateBuyCost(c.sizeSol) : c.sizeSol;
            if (this.broker.noteLateFill) this.broker.noteLateFill(cost);
            const pos = {
              mint: c.mint, symbol: c.symbol, state: "open", decidedAtMs: c.atMs, openedAtMs: c.atMs, sizeSol: c.sizeSol,
              decisionPrice: price, entryPrice: price, tokens, costSol: cost, proceedsSol: 0,
              peakPrice: price, peakRealSol: f ? f.realSol : 0, tp1Done: true, exits: [], sellFailures: 0, nextSellAtMs: 0,
              entry: c.entry, estimated: true,
            };
            this.positions.set(c.mint, pos);
            this.log("warn", `late fill: ${label(pos)} arrived after the buy timed out; selling it now`);
            this.sell(pos, { action: "sell", fraction: 1, reason: "late-fill", gainPct: 0 }, f, this.clock());
          },
          () => {
            // RPC hiccup: look again in ~15s, up to 5 times.
            c.tries = (c.tries || 0) + 1;
            if (c.tries < 5) this.lateFillChecks.push({ ...c, atMs: this.clock() - 30000 });
          }
        )
      );
    }
  }

  sell(pos, d, f, nowMs) {
    pos.state = "selling";
    const estimateSol = f ? curve.liquidationValueSol(f.vSol, f.vTok, pos.tokens * d.fraction, this.feeFraction()) : 0;
    this.log("trade", `SELL   ${label(pos)}  ${(d.fraction * 100).toFixed(0)}% | ${d.reason} | ${signed(d.gainPct, 1)}%`);
    this.track(
      this.broker
        .sell({ mint: pos.mint, fraction: d.fraction, nowMs, estimateSol, decisionPrice: f ? f.price : null })
        .catch((e) => ({ ok: false, error: e.message }))
        .then((res) => this.onSold(pos, d, res))
    );
  }

  onSold(pos, d, res) {
    const now = this.clock();
    pos.costSol += res.feesSol || 0; // fees of attempts that failed on-chain
    if (!res.ok && res.goneWithoutSale) {
      // The wallet holds none of this coin and no sale of ours explains it. Re-check a few
      // times (a node can lag); then book it as lost so it doesn't block the bot forever.
      pos.goneChecks = (pos.goneChecks || 0) + 1;
      if (pos.goneChecks >= 3) {
        this.log("warn", `  ${label(pos)}: the coins are not in the wallet and no sale was found; booked as lost (check with --wallet)`);
        pos.exits.push({ reason: "gone", fraction: 1, gainPct: -100, sol: 0, atMs: now });
        pos.estimated = true;
        pos.tokens = 0;
        this.closePosition(pos, now);
        return;
      }
    }
    if (!res.ok) {
      pos.state = "open";
      pos.sellFailures++;
      pos.nextSellAtMs = now + Math.min(30000, 1000 * 2 ** Math.min(5, pos.sellFailures));
      this.stats.sellFails++;
      this.log("warn", `  sell failed ${label(pos)} (${pos.sellFailures}x): ${res.error}`);
      return;
    }
    this.stats.sells++;
    if (res.closeError) this.log("warn", `  sold, but closing the empty token account failed (${res.closeError}); --sell-all reclaims that rent later`);
    pos.proceedsSol += res.solReceived;
    pos.tokens = Math.max(0, pos.tokens - (res.tokensSold || 0));
    if (res.estimated) pos.estimated = true;
    pos.exits.push({ reason: d.reason, fraction: d.fraction, gainPct: r2(d.gainPct), sol: r6(res.solReceived), atMs: now });
    // `closed` comes from the chain (paper: from the simulation), not from what was asked for.
    if (!res.closed) {
      if (d.reason === "take-profit-1" && res.tokensSold > 0) pos.tp1Done = true;
      if (d.fraction >= 0.999) pos.forceExit = true;
      pos.state = "open";
      this.log("trade", `  sold part of ${label(pos)}  +${res.solReceived.toFixed(4)} SOL`);
      return;
    }
    this.closePosition(pos, now);
  }

  closePosition(pos, now) {
    pos.state = "closed";
    const e = this.entered.get(pos.mint);
    if (e) e.closedAtMs = now;
    const net = pos.proceedsSol - pos.costSol;
    this.risk.onTradeClosed(net, now);
    const trade = {
      mode: this.broker.mode,
      mint: pos.mint,
      symbol: pos.symbol,
      openedAtMs: pos.openedAtMs,
      closedAtMs: now,
      holdSec: r2((now - pos.openedAtMs) / 1000),
      sizeSol: r6(pos.sizeSol),
      costSol: r6(pos.costSol),
      proceedsSol: r6(pos.proceedsSol),
      netSol: r6(net),
      netPct: r2((net / pos.costSol) * 100),
      peakGainPct: r2((pos.peakPrice / pos.entryPrice - 1) * 100),
      exits: pos.exits,
      entry: pos.entry,
      estimated: pos.estimated || undefined,
    };
    this.closedTrades.push(trade);
    this.positions.delete(pos.mint);
    this.recorder.recordTrade(this.broker.mode, trade);
    this.log("trade", `CLOSED ${label(pos)}  net ${signed(net)} SOL (${signed(trade.netPct, 1)}%) after ${trade.holdSec.toFixed(0)}s`);
  }

  // Gain or loss of the coins held now, as if sold at the current curve price (after exit
  // fees, with the token-account rent that comes back on a full exit).
  unrealizedSol() {
    let v = 0;
    for (const p of this.positions.values()) {
      if (p.state === "closed" || !(p.costSol > 0)) continue;
      const value = p.lastF && p.tokens > 0 ? curve.liquidationValueSol(p.lastF.vSol, p.lastF.vTok, p.tokens, this.feeFraction()) + C.TOKEN_ACCOUNT_RENT_SOL : 0;
      v += value + p.proceedsSol - p.costSol;
    }
    return v;
  }

  // Value of open positions at the current curve price, after exit fees.
  openValueSol() {
    let v = 0;
    for (const p of this.positions.values()) {
      if (p.state === "closed" || !p.lastF || !(p.tokens > 0)) continue;
      v += curve.liquidationValueSol(p.lastF.vSol, p.lastF.vTok, p.tokens, this.feeFraction());
    }
    return v;
  }
}

module.exports = { Engine, label };
