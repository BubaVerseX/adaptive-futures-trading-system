"use strict";

/**
 * Position sizing and the hard stops: max open positions, a cash reserve for
 * rent/fees, a daily loss limit (trading halts for the rest of the UTC day), a
 * pause after a losing streak, and a keep-floor (no new buys once the account is
 * below keepPct of its best value this run). Account values count closed trades only.
 */
class RiskManager {
  constructor(risk, startSol) {
    this.r = risk;
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
    if (this.sizeFor(availableSol) <= 0) return { ok: false, reason: "insufficient-funds" };
    return { ok: true };
  }

  // conviction (1..convictionMax): a stronger signal buys proportionally more.
  sizeFor(availableSol, conviction = 1) {
    const free = availableSol - this.r.reserveSol;
    if (free < this.r.minTradeSol) return 0;
    // Compounding: the size limit grows with the account, never below its base value.
    const growth = this.r.compound ? Math.max(1, this.equitySol() / this.startSol) : 1;
    // A strong signal may also take a bigger share of the free cash, up to half of it.
    const share = Math.max(this.r.tradeFractionOfFree, Math.min(0.5, this.r.tradeFractionOfFree * conviction));
    const size = Math.min(this.r.maxTradeSol * growth * conviction, Math.max(this.r.minTradeSol, free * share));
    return Math.min(size, free);
  }

  record(netSol, nowMs) {
    this.rollDay(nowMs);
    this.realizedToday += netSol;
    this.realizedTotal += netSol;
    this.peakSol = Math.max(this.peakSol, this.equitySol());
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

module.exports = { RiskManager };
