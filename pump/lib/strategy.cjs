"use strict";

// Pure decision rules. The live bot, the paper bot and replay.cjs all call these,
// so what gets measured offline is exactly what trades.

// Checks that only need polled curve + dev data. Cheap, evaluated every tick.
function preEntry(f, s) {
  const reasons = [];
  if (f.complete) reasons.push("complete");
  if (f.ageSec < s.entryMinAgeSec) reasons.push("too-young");
  if (f.ageSec > s.entryMaxAgeSec) reasons.push("too-old");
  if (f.realSol < s.minRealSol) reasons.push("low-real-sol");
  if (f.realSol > s.maxRealSol) reasons.push("late");
  if (f.inflow30 < s.minInflow30) reasons.push("weak-inflow30");
  if (f.inflow15 < s.minInflow15) reasons.push("fading-inflow15");
  if (f.drawdownFromPeakPct > s.maxDrawdownFromPeakPct) reasons.push("off-peak");
  if (f.devBuySol !== null && f.devBuySol !== undefined && f.devBuySol > s.maxDevBuySol) reasons.push("big-dev-buy");
  if (f.devSold) reasons.push("dev-sold");
  // Thresholds are calibrated for pump.fun's standard curve; anything else is skipped.
  if (s.requireStandardCurve && f.standardCurve === false) reasons.push("non-standard-curve");
  return { ok: reasons.length === 0, reasons };
}

// null = not checked yet.
function holdersOk(h, s) {
  if (!h) return null;
  if (h.error) return false;
  return h.top1Pct <= s.maxTop1Pct && h.top10Pct <= s.maxTop10Pct;
}

function entryDecision(f, s) {
  const pre = preEntry(f, s);
  if (!pre.ok) return { go: false, reasons: pre.reasons };
  const h = holdersOk(f.holders, s);
  if (h === null) return { go: false, reasons: ["holders-unchecked"], needHolders: true };
  if (!h) return { go: false, reasons: ["concentrated-holders"] };
  return { go: true, reasons: [] };
}

function updatePeaks(pos, f) {
  if (f.price > pos.peakPrice) pos.peakPrice = f.price;
  if (f.realSol > pos.peakRealSol) pos.peakRealSol = f.realSol;
}

/**
 * pos: { entryPrice, openedAtMs, peakPrice, peakRealSol, tp1Done }
 * Gains are measured on the curve's mark price; fees are accounted separately.
 */
function exitDecision(pos, f, s, nowMs) {
  const gainPct = (f.price / pos.entryPrice - 1) * 100;
  const peakGainPct = (pos.peakPrice / pos.entryPrice - 1) * 100;
  const heldSec = (nowMs - pos.openedAtMs) / 1000;
  const all = (reason) => ({ action: "sell", fraction: 1, reason, gainPct });

  if (f.complete || f.progress >= s.exitProgress) return all("near-graduation");
  if (f.devSold) return all("dev-sold");
  if (gainPct <= -s.stopLossPct) return all("stop-loss");
  if (pos.peakRealSol > 0 && f.realSol <= pos.peakRealSol * (1 - s.outflowExitPct / 100)) return all("outflow");
  if (!pos.tp1Done && gainPct >= s.tp1Pct) {
    return { action: "sell", fraction: s.tp1Fraction, reason: "take-profit-1", gainPct };
  }
  if (peakGainPct >= s.trailArmPct && f.price <= pos.peakPrice * (1 - s.trailPct / 100)) return all("trailing-stop");
  // After the first take-profit the rest rides on the trailing stop instead.
  if (!pos.tp1Done && heldSec >= s.timeStopSec && gainPct < s.timeStopMinGainPct) return all("time-stop");
  if (heldSec >= s.maxHoldSec) return all("max-hold");
  return { action: "hold", gainPct };
}

module.exports = { preEntry, holdersOk, entryDecision, updatePeaks, exitDecision };
