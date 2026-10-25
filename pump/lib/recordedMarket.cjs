"use strict";

const C = require("./constants.cjs");
const curve = require("./curve.cjs");

/**
 * Serves recorded (or synthetic) coins to the engine as if they were live: create
 * events at their launch time, bonding-curve / dev token accounts from the recorded
 * path at the current simulated time, and holder lists. Used by replay.cjs and tests,
 * so the exact live code path (tracker -> strategy -> paper broker) is what gets measured.
 */
class RecordedMarket {
  constructor(records, { clock }) {
    this.records = records.filter((r) => r && r.mint && Array.isArray(r.path) && r.path.length).sort((a, b) => a.createdAtMs - b.createdAtMs);
    this.byMint = new Map(this.records.map((r) => [r.mint, r]));
    this.clock = clock;
    this.cursor = 0;
    this.atas = new Map();
    this.unknownHolders = 0;
    this.derive = {
      bondingCurve: (mint) => `curve#${mint}`,
      ata: (owner, mint) => {
        const id = `ata#${owner}#${mint}`;
        this.atas.set(id, { owner, mint });
        return id;
      },
    };
  }

  creatorOf(r) {
    return r.creator || `dev#${r.mint}`;
  }

  nextEventMs() {
    return this.cursor < this.records.length ? this.records[this.cursor].createdAtMs : null;
  }

  newEvents(nowMs) {
    const out = [];
    while (this.cursor < this.records.length && this.records[this.cursor].createdAtMs <= nowMs) {
      const r = this.records[this.cursor++];
      out.push({
        mint: r.mint,
        creator: this.creatorOf(r),
        bondingCurve: this.derive.bondingCurve(r.mint),
        symbol: r.symbol,
        name: r.name,
        devBuySol: r.devBuySol === null || r.devBuySol === undefined ? NaN : r.devBuySol,
        devTokens: NaN,
        vSol: NaN,
        vTok: NaN,
        createdAtMs: r.createdAtMs,
      });
    }
    return out;
  }

  realSolAt(r, ageMs) {
    let v = null;
    for (const [a, rs] of r.path) {
      if (a <= ageMs) v = rs;
      else break;
    }
    return v;
  }

  curveAccount(r, now) {
    const age = now - r.createdAtMs;
    const rs = this.realSolAt(r, age);
    if (rs === null) return null;
    const { vSol, vTok } = curve.reservesFromRealSol(rs);
    const complete = !!r.complete && age >= r.path[r.path.length - 1][0];
    const realTok = Math.max(0, vTok - (C.INITIAL_VIRTUAL_TOKENS - C.INITIAL_REAL_TOKENS));
    return { data: curve.encodeBondingCurve({ vSol, vTok, realSol: rs, realTok, complete }), owner: C.PUMP_PROGRAM_ID };
  }

  devAccount(r, now) {
    const initial = r.devTokensInitial || 0;
    if (initial <= 0) return null;
    const sold = r.devSoldAgeMs !== null && r.devSoldAgeMs !== undefined && now - r.createdAtMs >= r.devSoldAgeMs;
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(BigInt(Math.round((sold ? 0 : initial) * C.TOKEN_UNIT)), 64);
    return { data, owner: C.TOKEN_PROGRAM_ID };
  }

  async getAccounts(keys) {
    const now = this.clock();
    return keys.map((k) => {
      if (k.startsWith("curve#")) {
        const r = this.byMint.get(k.slice(6));
        return r ? this.curveAccount(r, now) : null;
      }
      if (k.startsWith("ata#")) {
        const a = this.atas.get(k);
        const r = a && this.byMint.get(a.mint);
        return r && a.owner === this.creatorOf(r) ? this.devAccount(r, now) : null;
      }
      return this.byMint.has(k) ? { data: Buffer.alloc(82), owner: C.TOKEN_PROGRAM_ID } : null;
    });
  }

  async getLargestHolders(mint) {
    const r = this.byMint.get(mint);
    if (!r) throw new Error("unknown mint");
    const h = r.holders;
    if (h && h.error) throw new Error(h.error);
    let top1 = 3, rest = 2; // unknown: assume a healthy spread (counted, reported by replay)
    if (h && Number.isFinite(h.top1Pct)) {
      top1 = h.top1Pct;
      rest = Math.max(0, (h.top10Pct - h.top1Pct) / 9);
    } else {
      this.unknownHolders++;
    }
    const age = this.clock() - r.createdAtMs;
    const rs = this.realSolAt(r, age) || 0;
    const { vTok } = curve.reservesFromRealSol(rs);
    const rows = [{ address: this.derive.ata(this.derive.bondingCurve(mint), mint), uiAmount: vTok - (C.INITIAL_VIRTUAL_TOKENS - C.TOTAL_SUPPLY_TOKENS) }];
    rows.push({ address: `holder#1#${mint}`, uiAmount: (top1 / 100) * C.TOTAL_SUPPLY_TOKENS });
    for (let i = 2; i <= 10; i++) rows.push({ address: `holder#${i}#${mint}`, uiAmount: (rest / 100) * C.TOTAL_SUPPLY_TOKENS });
    return rows;
  }
}

module.exports = { RecordedMarket };
