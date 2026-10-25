"use strict";

const fs = require("fs");
const path = require("path");

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Append-only JSONL logs under data/pump/ (gitignored):
 *   research-YYYY-MM-DD.jsonl  every coin that showed any life: its curve path, dev
 *                              behaviour and holder check. replay.cjs re-runs the
 *                              strategy on these.
 *   trades-<mode>-YYYY-MM-DD.jsonl  every trade the bot made.
 */
class Recorder {
  constructor(dir, runtime, { enabled = true } = {}) {
    this.dir = dir;
    this.rt = runtime;
    this.enabled = enabled;
    this.counts = { research: 0, skipped: 0, trades: 0 };
    if (enabled) fs.mkdirSync(dir, { recursive: true });
  }

  // Logging must never take the bot down (full disk, deleted folder...).
  append(name, obj) {
    if (!this.enabled) return;
    try {
      fs.appendFileSync(path.join(this.dir, name), JSON.stringify(obj) + "\n");
    } catch (e) {
      this.counts.writeErrors = (this.counts.writeErrors || 0) + 1;
      if (this.counts.writeErrors === 1) console.error(`! could not write ${name}: ${e.message}`);
    }
  }

  static researchRecord(t) {
    return {
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      creator: t.creator,
      createdAtMs: t.createdAtMs,
      devBuySol: t.devBuySol,
      devTokensInitial: t.devTokensInitial,
      devSoldAgeMs: t.devSoldAtMs === null ? null : t.devSoldAtMs - t.createdAtMs,
      holders: t.holders,
      complete: t.complete,
      curve: t.curve || null,
      maxRealSol: Math.round(t.maxRealSol * 1e4) / 1e4,
      path: t.path,
    };
  }

  recordToken(t) {
    if (t.maxRealSol < this.rt.recordMinRealSol || t.path.length === 0) {
      this.counts.skipped++;
      return;
    }
    this.counts.research++;
    this.append(`research-${dayOf(t.createdAtMs)}.jsonl`, Recorder.researchRecord(t));
  }

  recordTrade(mode, trade) {
    this.counts.trades++;
    this.append(`trades-${mode}-${dayOf(trade.closedAtMs || trade.openedAtMs)}.jsonl`, trade);
  }
}

module.exports = { Recorder };
