"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function emptyLedger() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    logicalTrades: {},
    orderLinkIndex: {},
    exchangeOrderIndex: {},
    processedFillIds: {},
  };
}

class ExecutionLedger {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.file = config.executionLedgerFile;
    this.data = emptyLedger();
  }

  load() {
    this.data = { ...emptyLedger(), ...readJson(this.file, emptyLedger()) };
    this.data.logicalTrades = this.data.logicalTrades || {};
    this.data.orderLinkIndex = this.data.orderLinkIndex || {};
    this.data.exchangeOrderIndex = this.data.exchangeOrderIndex || {};
    this.data.processedFillIds = this.data.processedFillIds || {};
    this.save();
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    writeJson(this.file, this.data);
  }

  trade(logicalTradeId) {
    return this.data.logicalTrades[logicalTradeId] || null;
  }

  beginTrade(position, details = {}) {
    const logicalTradeId = position.id;
    const existing = this.data.logicalTrades[logicalTradeId] || {};
    const entry = {
      logicalTradeId,
      symbol: position.symbol,
      side: position.side,
      mode: position.mode,
      orderLinkIds: Array.from(new Set([...(existing.orderLinkIds || []), position.entryOrderLinkId].filter(Boolean))),
      exchangeOrderIds: Array.from(new Set([...(existing.exchangeOrderIds || []), position.entryOrderId].filter(Boolean))),
      fillIds: existing.fillIds || [],
      totalFilledQty: numeric(existing.totalFilledQty),
      weightedAverageFillPrice: numeric(existing.weightedAverageFillPrice),
      totalActualFeeUsdt: numeric(existing.totalActualFeeUsdt),
      lifecycleState: existing.lifecycleState || position.status || "ENTRY_SUBMITTING",
      tpSlConfirmationState: existing.tpSlConfirmationState || (position.nativeProtectionVerified ? "CONFIRMED" : "PENDING"),
      finalNetResultUsdt: existing.finalNetResultUsdt,
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...details,
    };
    this.data.logicalTrades[logicalTradeId] = entry;
    for (const orderLinkId of entry.orderLinkIds) this.data.orderLinkIndex[orderLinkId] = logicalTradeId;
    for (const orderId of entry.exchangeOrderIds) this.data.exchangeOrderIndex[orderId] = logicalTradeId;
    this.save();
    return entry;
  }

  recordOrder(logicalTradeId, order = {}, lifecycleState) {
    const entry = this.data.logicalTrades[logicalTradeId] || this.beginTrade({ id: logicalTradeId });
    if (order.orderLinkId) {
      entry.orderLinkIds = Array.from(new Set([...(entry.orderLinkIds || []), order.orderLinkId]));
      this.data.orderLinkIndex[order.orderLinkId] = logicalTradeId;
    }
    if (order.orderId) {
      entry.exchangeOrderIds = Array.from(new Set([...(entry.exchangeOrderIds || []), order.orderId]));
      this.data.exchangeOrderIndex[order.orderId] = logicalTradeId;
    }
    if (lifecycleState) entry.lifecycleState = lifecycleState;
    entry.updatedAt = new Date().toISOString();
    this.save();
    return entry;
  }

  logicalTradeIdForOrder(order = {}) {
    if (order.orderLinkId && this.data.orderLinkIndex[order.orderLinkId]) return this.data.orderLinkIndex[order.orderLinkId];
    if (order.orderId && this.data.exchangeOrderIndex[order.orderId]) return this.data.exchangeOrderIndex[order.orderId];
    return null;
  }

  fillKey(execution = {}) {
    return String(
      execution.execId ||
        execution.executionId ||
        `${execution.orderId || execution.orderLinkId || "unknown"}:${execution.execTime || execution.updatedTime || ""}:${execution.execQty || ""}:${execution.execPrice || ""}:${execution.execFee || ""}`
    );
  }

  recordFill(logicalTradeId, execution = {}) {
    const key = this.fillKey(execution);
    if (this.data.processedFillIds[key]) {
      this.log("DEBUG", "Duplicate execution event ignored by execution ledger.", {
        logicalTradeId,
        fillId: key,
        orderId: execution.orderId,
        orderLinkId: execution.orderLinkId,
      });
      return { duplicate: true, entry: this.data.logicalTrades[logicalTradeId] || null };
    }
    const entry = this.data.logicalTrades[logicalTradeId] || this.beginTrade({ id: logicalTradeId });
    const qty = numeric(execution.execQty);
    const price = numeric(execution.execPrice);
    const fee = numeric(execution.execFee || execution.fee);
    const oldQty = numeric(entry.totalFilledQty);
    const newQty = oldQty + Math.max(0, qty);
    if (newQty > 0 && price > 0 && qty > 0) {
      entry.weightedAverageFillPrice = ((numeric(entry.weightedAverageFillPrice) * oldQty) + price * qty) / newQty;
      entry.totalFilledQty = newQty;
    }
    entry.totalActualFeeUsdt = numeric(entry.totalActualFeeUsdt) + fee;
    entry.fillIds = Array.from(new Set([...(entry.fillIds || []), key]));
    entry.updatedAt = new Date().toISOString();
    this.data.processedFillIds[key] = {
      logicalTradeId,
      orderId: execution.orderId,
      orderLinkId: execution.orderLinkId,
      processedAt: new Date().toISOString(),
    };
    this.recordOrder(logicalTradeId, execution);
    this.save();
    this.log("DEBUG", "Execution ledger fill aggregated.", {
      logicalTradeId,
      fillId: key,
      totalFilledQty: entry.totalFilledQty,
      weightedAverageFillPrice: Number(numeric(entry.weightedAverageFillPrice).toFixed(8)),
      totalActualFeeUsdt: Number(entry.totalActualFeeUsdt.toFixed(8)),
    });
    return { duplicate: false, entry };
  }

  markProtection(logicalTradeId, state, details = {}) {
    const entry = this.data.logicalTrades[logicalTradeId] || this.beginTrade({ id: logicalTradeId });
    entry.tpSlConfirmationState = state;
    entry.protection = { ...(entry.protection || {}), ...details, updatedAt: new Date().toISOString() };
    entry.updatedAt = new Date().toISOString();
    this.save();
  }

  finalize(logicalTradeId, result = {}) {
    const entry = this.data.logicalTrades[logicalTradeId] || this.beginTrade({ id: logicalTradeId });
    entry.lifecycleState = "CLOSED";
    entry.finalNetResultUsdt = numeric(result.netPnlUsdt);
    entry.finalGrossPnlUsdt = numeric(result.grossPnlUsdt);
    entry.finalFeesUsdt = numeric(result.feesUsdt, numeric(entry.totalActualFeeUsdt));
    entry.closedAt = result.closedAt || new Date().toISOString();
    entry.updatedAt = new Date().toISOString();
    this.save();
  }
}

module.exports = { ExecutionLedger };
