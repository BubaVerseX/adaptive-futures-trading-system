"use strict";

const C = require("./constants.cjs");

// A buy's own overhead besides the coins: token-account rent plus transaction fees.
const BUY_OVERHEAD_SOL = C.TOKEN_ACCOUNT_RENT_SOL + 0.0002;

/**
 * Position sizing and the hard stops: max open positions, a cash reserve for
 * rent/fees, a daily loss limit (trading halts for the rest of the UTC day), a
 * pause after a losing streak, and a keep-floor (no new buys once the account is
 * below keepPct of its best value). Account values count closed trades only; new buys
 * are sized so that the cash left stays above the floor even if every open coin went to zero.
 */
class RiskManager {
  constructor(risk, startSol, { buySlippagePct = 20 } = {}) {
    this.r = risk;
    this.buyMult = 1 + buySlippagePct / 100; // a live buy can cost this much more when the price moves
    this.startSol = startSol;
    this.dayKey = null;
    this.realizedToday = 0;
    this.realizedTotal = 0;
    this.feesOnlyTotal = 0;
    this.lossStreak = 0;
    this.pausedUntil = 0;
    this.halted = false;
    this.trades = 0;
    this.wins = 0;
    this.losses = 0;
    this.peakSol = startSol;
  }

  equitySol() {
    return this.startSol + this.realizedTotal;
  }

  floorSol() {
    return (this.peakSol * this.r.keepPct) / 100;
  }

  belowFloor() {
    return this.r.keepPct > 0 && this.equitySol() < this.floorSol();
  }

  rollDay(nowMs) {
    const k = new Date(nowMs).toISOString().slice(0, 10);
    if (k !== this.dayKey) {
      this.dayKey = k;
      this.realizedToday = 0;
      this.halted = false;
    }
  }

  dailyLimitSol() {
    return (this.startSol * this.r.dailyLossLimitPct) / 100;
  }

  canEnter(nowMs, openCount, availableSol) {
    this.rollDay(nowMs);
    if (this.halted) return { ok: false, reason: "daily-loss-limit" };
    if (this.belowFloor()) return { ok: false, reason: "keep-floor" };
    if (nowMs < this.pausedUntil) return { ok: false, reason: "loss-streak-pause" };
    if (openCount >= this.r.maxOpenPositions) return { ok: false, reason: "max-open" };
    if (this.sizeFor(availableSol) <= 0) {
      const short = availableSol - this.r.reserveSol < this.r.minTradeSol;
      return { ok: false, reason: !short && this.r.keepPct > 0 && this.roomSol(availableSol) < this.r.minTradeSol ? "keep-floor-room" : "insufficient-funds" };
    }
    return { ok: true };
  }

  // The most a new buy may cost so the cash left, after its worst-case fill, stays at or
  // above the keep-floor (and the reserve) even if every coin already bought went to zero.
  roomSol(availableSol) {
    const keep = Math.max(this.r.reserveSol, this.r.keepPct > 0 ? this.floorSol() : 0);
    return (availableSol - keep - BUY_OVERHEAD_SOL) / this.buyMult;
  }

  // conviction (1..convictionMax): a stronger signal buys proportionally more.
  sizeFor(availableSol, conviction = 1) {
    const free = availableSol - this.r.reserveSol;
    const room = this.roomSol(availableSol);
    if (free < this.r.minTradeSol || room < this.r.minTradeSol) return 0;
    // Compounding: the size limit grows with the account, never below its base value.
    const growth = this.r.compound ? Math.max(1, this.equitySol() / this.startSol) : 1;
    // A strong signal may also take a bigger share of the free cash, up to half of it.
    const share = Math.max(this.r.tradeFractionOfFree, Math.min(0.5, this.r.tradeFractionOfFree * conviction));
    const size = Math.min(this.r.maxTradeSol * growth * conviction, Math.max(this.r.minTradeSol, free * share));
    return Math.min(size, free, room);
  }

  record(netSol, nowMs) {
    this.rollDay(nowMs);
    this.realizedToday += netSol;
    this.realizedTotal += netSol;
    this.peakSol = Math.max(this.peakSol, this.equitySol());
    if (this.onPeak && this.peakSol > (this.savedPeak || 0)) {
      this.savedPeak = this.peakSol;
      this.onPeak(this.peakSol);
    }
    if (this.realizedToday <= -this.dailyLimitSol()) this.halted = true;
  }

  onTradeClosed(netSol, nowMs) {
    this.trades++;
    if (netSol > 0) {
      this.wins++;
      this.lossStreak = 0;
    } else {
      this.losses++;
      this.lossStreak++;
      if (this.lossStreak >= this.r.lossStreak) {
        this.pausedUntil = nowMs + this.r.lossStreakPauseMin * 60000;
        this.lossStreak = 0;
      }
    }
    this.record(netSol, nowMs);
  }

  // Failed transactions still cost their fee.
  onFeesOnly(feeSol, nowMs) {
    if (!(feeSol > 0)) return;
    this.feesOnlyTotal += feeSol;
    this.record(-feeSol, nowMs);
  }
}

/**
 * Best balance to start a live run from, so a restart after losses doesn't lower the
 * keep-floor. saved: { wallet, peakSol } from the last run. Clamped to the budget (a
 * lowered budget mustn't freeze the bot) and never below this run's own start.
 */
function carryPeak({ saved, owner, startSol, budgetSol, reset = false }) {
  if (reset || !saved || saved.wallet !== owner || !(saved.peakSol > 0)) return startSol;
  return Math.max(startSol, Math.min(saved.peakSol, budgetSol || saved.peakSol));
}

module.exports = { RiskManager, carryPeak };
