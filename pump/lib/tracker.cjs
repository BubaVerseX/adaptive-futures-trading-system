"use strict";

const C = require("./constants.cjs");
const curve = require("./curve.cjs");

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

function tokenAccountAmount(data) {
  if (!data || data.length < 72) return null;
  return Number(data.readBigUInt64LE(64)) / C.TOKEN_UNIT;
}

// Tokens still sitting in the curve's own token account (it starts with the full supply).
const curveTokenBalance = (vTok) => vTok - (C.INITIAL_VIRTUAL_TOKENS - C.TOTAL_SUPPLY_TOKENS);

/**
 * Top-holder concentration, excluding the bonding curve's token account.
 * largest: [{ address, uiAmount }] as returned by getTokenLargestAccounts.
 * curveAtas: candidate addresses of the curve's token account.
 */
function summarizeHolders(largest, { curveAtas = [], curveAta = null, curveBalance = null } = {}) {
  const exclude = new Set([...(curveAtas || []), ...(curveAta ? [curveAta] : [])]);
  let rows = (largest || []).filter((r) => r && Number.isFinite(r.uiAmount) && r.uiAmount > 0);
  const before = rows.length;
  rows = rows.filter((r) => !exclude.has(r.address));
  rows.sort((a, b) => b.uiAmount - a.uiAmount);
  if (rows.length === before && rows.length) {
    // Not recognised by address: the curve holds (close to) its expected balance and,
    // since it starts with the whole supply, is by far the largest holder early on.
    let idx = -1, best = Infinity;
    if (curveBalance !== null && curveBalance > 0) {
      rows.forEach((r, i) => {
        const d = Math.abs(r.uiAmount - curveBalance) / curveBalance;
        if (d < best) { best = d; idx = i; }
      });
      if (best > 0.05) idx = -1;
    }
    if (idx < 0 && rows[0].uiAmount >= 0.4 * C.TOTAL_SUPPLY_TOKENS) idx = 0;
    if (idx >= 0) rows.splice(idx, 1);
  }
  const pct = (x) => (x / C.TOTAL_SUPPLY_TOKENS) * 100;
  return {
    top1Pct: round(rows[0] ? pct(rows[0].uiAmount) : 0, 2),
    top10Pct: round(pct(rows.slice(0, 10).reduce((a, r) => a + r.uiAmount, 0)), 2),
  };
}

/**
 * Follows every new coin for a few minutes by polling its bonding-curve account
 * (and, once it shows activity, the creator's token account). Free on-chain data,
 * no metered trade stream needed.
 *
 * derive: { bondingCurve(mint), ata(owner, mint, tokenProgram) } -> address strings.
 */
class Tracker {
  constructor(cfg, derive) {
    this.s = cfg.strategy;
    this.rt = cfg.runtime;
    this.derive = derive;
    this.tokens = new Map();
    this.tickCount = 0;
    this.stats = { seen: 0, expired: 0, badLayout: 0, nonStandard: 0 };
  }

  add(evt, nowMs) {
    if (!evt || !evt.mint || this.tokens.has(evt.mint)) return null;
    const bondingCurve = evt.bondingCurve || (this.derive && this.derive.bondingCurve(evt.mint));
    if (!bondingCurve) return null;
    const seeded = Number.isFinite(evt.vSol) && evt.vSol > 0 && Number.isFinite(evt.vTok) && evt.vTok > 0;
    const realSol0 = seeded ? Math.max(0, evt.vSol - C.INITIAL_VIRTUAL_SOL) : 0;
    const t = {
      mint: evt.mint,
      symbol: evt.symbol || "?",
      name: evt.name || "",
      creator: evt.creator || null,
      bondingCurve,
      createdAtMs: evt.createdAtMs || nowMs,
      devBuySol: Number.isFinite(evt.devBuySol) ? evt.devBuySol : null,
      devTokensEvent: Number.isFinite(evt.devTokens) && evt.devTokens > 0 ? evt.devTokens : null,
      tokenProgram: null,
      mintRequested: false,
      devAta: null,
      curveAta: null,
      devTokensInitial: null,
      devTokensNow: null,
      devSoldAtMs: null,
      samples: [{ t: nowMs, realSol: realSol0 }],
      path: [],
      last: seeded ? { vSol: evt.vSol, vTok: evt.vTok, realSol: realSol0, complete: false, t: nowMs } : null,
      peakPrice: seeded ? curve.price(evt.vSol, evt.vTok) : 0,
      maxRealSol: realSol0,
      complete: false,
      holders: null,
      holdersPending: false,
      polled: false,
    };
    this.tokens.set(evt.mint, t);
    this.stats.seen++;
    return t;
  }

  isFast(t, nowMs, held) {
    if (held.has(t.mint) || !t.polled) return true;
    const ageSec = (nowMs - t.createdAtMs) / 1000;
    return ageSec <= this.s.entryMaxAgeSec + 30 && t.maxRealSol >= this.rt.devTrackMinRealSol;
  }

  // Accounts to fetch this tick: [{ key, mint, kind: "curve" | "mint" | "devAta" }].
  pollTargets(nowMs, held = new Set()) {
    this.tickCount++;
    const slowTurn = this.tickCount % this.rt.slowEvery === 0;
    const out = [];
    for (const t of this.tokens.values()) {
      if (!this.isFast(t, nowMs, held) && !slowTurn) continue;
      out.push({ key: t.bondingCurve, mint: t.mint, kind: "curve" });
      const active = t.maxRealSol >= this.rt.devTrackMinRealSol || held.has(t.mint);
      if (active && t.creator && !t.tokenProgram && !t.mintRequested) {
        out.push({ key: t.mint, mint: t.mint, kind: "mint" });
      }
      if (active && t.devAta) out.push({ key: t.devAta, mint: t.mint, kind: "devAta" });
    }
    return out;
  }

  // results: pollTargets() entries with `account` = { data: Buffer, owner: string } | null.
  ingest(results, nowMs) {
    for (const r of results) {
      const t = this.tokens.get(r.mint);
      if (!t) continue;
      if (r.kind === "curve") this.ingestCurve(t, r.account, nowMs);
      else if (r.kind === "mint") this.ingestMint(t, r.account);
      else if (r.kind === "devAta") this.ingestDevAta(t, r.account, nowMs);
    }
  }

  ingestCurve(t, account, nowMs) {
    if (!account) return; // not visible to this RPC node yet
    const dec = curve.decodeBondingCurve(account.data);
    if (!dec || !dec.discriminatorOk) {
      this.stats.badLayout++; // not a pump.fun bonding curve as we know it: never trade on it
      return;
    }
    if (!(dec.vSol > 0) || !(dec.vTok > 0)) {
      t.complete = true; // emptied curve: the coin graduated to PumpSwap
      return;
    }
    if (!t.curve) {
      // vSol - realSol and vSol * vTok are constant for a coin's whole life on the curve.
      const base = dec.vSol - dec.realSol;
      const k = dec.vSol * dec.vTok;
      t.curve = { base: round(base, 6), k: Math.round(k), totalSupply: dec.totalSupply, standard: curve.isStandardCurve(base, k, dec.totalSupply) };
      if (!t.curve.standard) this.stats.nonStandard++;
    }
    t.polled = true;
    t.last = { vSol: dec.vSol, vTok: dec.vTok, realSol: dec.realSol, complete: dec.complete, t: nowMs };
    t.samples.push({ t: nowMs, realSol: dec.realSol });
    // Keep ~2 minutes of samples; inflow windows only look back 60s.
    while (t.samples.length > 2 && t.samples[1].t < nowMs - 120000) t.samples.shift();
    const p = curve.price(dec.vSol, dec.vTok);
    if (p > t.peakPrice) t.peakPrice = p;
    if (dec.realSol > t.maxRealSol) t.maxRealSol = dec.realSol;
    if (dec.complete) t.complete = true;
    const ageMs = nowMs - t.createdAtMs;
    const prev = t.path[t.path.length - 1];
    const rs = round(dec.realSol, 4);
    if (!prev || prev[1] !== rs || ageMs - prev[0] >= 10000) t.path.push([ageMs, rs]);
  }

  ingestMint(t, account) {
    t.mintTries = (t.mintTries || 0) + 1;
    if (!account || !account.owner) {
      t.mintRequested = t.mintTries >= 3; // RPC lag: retry a couple of times, then give up
      return;
    }
    t.mintRequested = true;
    t.tokenProgram = account.owner;
    if (this.derive) {
      if (t.creator) t.devAta = this.derive.ata(t.creator, t.mint, t.tokenProgram);
      t.curveAta = this.derive.ata(t.bondingCurve, t.mint, t.tokenProgram);
    }
  }

  ingestDevAta(t, account, nowMs) {
    const amount = account ? tokenAccountAmount(account.data) : 0;
    if (amount === null) return;
    if (t.devTokensInitial === null) {
      // Trust the create event's dev buy unless it disagrees wildly with what the
      // chain shows (different units). Zero on-chain after a dev buy = dumped already.
      const ev = t.devTokensEvent;
      const plausible = ev !== null && (amount === 0 || Math.abs(amount / ev - 1) <= 0.5);
      t.devTokensInitial = plausible ? ev : amount;
    }
    t.devTokensNow = amount;
    if (t.devSoldAtMs === null && t.devTokensInitial > 0 && amount < t.devTokensInitial * 0.98) t.devSoldAtMs = nowMs;
  }

  realSolAt(t, ts) {
    let v = t.samples[0].realSol;
    for (const s of t.samples) {
      if (s.t <= ts) v = s.realSol;
      else break;
    }
    return v;
  }

  features(mint, nowMs) {
    const t = this.tokens.get(mint);
    if (!t || !t.last) return null;
    const { vSol, vTok, realSol } = t.last;
    const price = curve.price(vSol, vTok);
    return {
      mint,
      symbol: t.symbol,
      ageSec: (nowMs - t.createdAtMs) / 1000,
      staleSec: (nowMs - t.last.t) / 1000,
      vSol,
      vTok,
      price,
      mcapSol: price * (t.curve ? t.curve.totalSupply : C.TOTAL_SUPPLY_TOKENS),
      standardCurve: t.curve ? t.curve.standard : true,
      realSol,
      progress: curve.progressFromRealSol(realSol),
      complete: t.complete || t.last.complete,
      peakPrice: t.peakPrice,
      drawdownFromPeakPct: t.peakPrice > 0 ? Math.max(0, (1 - price / t.peakPrice) * 100) : 0,
      inflow15: realSol - this.realSolAt(t, nowMs - 15000),
      inflow30: realSol - this.realSolAt(t, nowMs - 30000),
      inflow60: realSol - this.realSolAt(t, nowMs - 60000),
      devBuySol: t.devBuySol,
      devSold: t.devSoldAtMs !== null,
      devSoldAtMs: t.devSoldAtMs,
      devHoldPct: t.devTokensNow === null ? null : (t.devTokensNow / (t.curve ? t.curve.totalSupply : C.TOTAL_SUPPLY_TOKENS)) * 100,
      holders: t.holders,
    };
  }

  // Fresh features for every watched token that could still be entered.
  candidates(nowMs, exclude, maxStaleSec) {
    const out = [];
    for (const t of this.tokens.values()) {
      if (exclude.has(t.mint) || !t.last) continue;
      const ageSec = (nowMs - t.createdAtMs) / 1000;
      if (ageSec > this.s.entryMaxAgeSec) continue;
      const f = this.features(t.mint, nowMs);
      if (f.staleSec <= maxStaleSec) out.push(f);
    }
    return out;
  }

  setHolders(mint, holders) {
    const t = this.tokens.get(mint);
    if (t) { t.holders = holders; t.holdersPending = false; }
  }

  // Tokens done being watched (not held). Returned for the research recorder.
  expire(nowMs, held = new Set()) {
    const out = [];
    for (const t of this.tokens.values()) {
      if (held.has(t.mint)) continue;
      if (t.curve && !t.curve.standard && this.s.requireStandardCurve) {
        this.tokens.delete(t.mint); // never traded: stop polling it, nothing to record
        continue;
      }
      const ageSec = (nowMs - t.createdAtMs) / 1000;
      const dead = ageSec >= this.rt.deadAfterSec && t.maxRealSol < this.rt.deadBelowRealSol;
      // Coins that could have been traded are followed long enough to cover any
      // possible hold, so replay never has to guess what happened after the recording.
      const limit = t.maxRealSol >= this.rt.holdersCheckMinRealSol ? this.rt.watchSecActive : this.rt.watchSec;
      if (ageSec >= limit || dead) {
        this.tokens.delete(t.mint);
        this.stats.expired++;
        out.push(t);
      }
    }
    return out;
  }
}

module.exports = { Tracker, summarizeHolders, curveTokenBalance, tokenAccountAmount };
