"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const REPORT_DIR = path.join(DATA_DIR, "reports");

function readJson(relativePath, fallback) {
  try {
    const fullPath = path.join(ROOT, relativePath);
    return fs.existsSync(fullPath) ? JSON.parse(fs.readFileSync(fullPath, "utf8")) : fallback;
  } catch (error) {
    return { unavailable: true, error: error.message };
  }
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + numeric(row[key]), 0);
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : 0;
}

function median(values) {
  const finite = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function round(value, places = 6) {
  return Number(numeric(value).toFixed(places));
}

function pct(numerator, denominator) {
  return denominator ? round((numerator / denominator) * 100, 4) : 0;
}

function tradeTimestamp(trade) {
  return Date.parse(trade.exitedAt || trade.exitTime || trade.openedAt || trade.entryTime || trade.timestamp || "");
}

function holdSeconds(trade) {
  return numeric(trade.holdSeconds || trade.holdingTimeSeconds);
}

function netPnl(trade) {
  return numeric(trade.pnlUsdt !== undefined ? trade.pnlUsdt : trade.realizedPnlUsdt);
}

function grossPnl(trade) {
  const explicit = trade.grossPnlUsdt !== undefined ? numeric(trade.grossPnlUsdt) : NaN;
  if (Number.isFinite(explicit)) return explicit;
  return netPnl(trade) + numeric(trade.feesUsdt || trade.feesPaidUsdt || trade.estimatedFeesUsdt);
}

function fees(trade) {
  return numeric(trade.feesUsdt || trade.feesPaidUsdt || trade.estimatedFeesUsdt);
}

function side(trade) {
  return String(trade.side || "UNKNOWN").toUpperCase();
}

function symbol(trade) {
  return String(trade.symbol || "UNKNOWN").toUpperCase();
}

function setupType(trade) {
  return String(trade.continuationSetupType || trade.setupType || "UNKNOWN");
}

function tradeCategory(trade) {
  if (trade.eliteSetup || trade.tradeCategory === "ELITE_SETUP") return "ELITE";
  if (trade.convictionTier === "TIER_2_STRONG_SETUP") return "STRONG";
  if (trade.explorationTrade || trade.tradeCategory === "EXPLORATION") return "EXPLORATION";
  return String(trade.tradeCategory || trade.convictionTier || "NORMAL");
}

function leverageBucket(trade) {
  const leverage = numeric(trade.leverage);
  if (!leverage) return "UNKNOWN";
  if (leverage <= 3) return "1-3x";
  if (leverage <= 8) return "4-8x";
  return "9x+";
}

function sizeTier(trade) {
  return String(trade.convictionTier || (trade.eliteSetup ? "TIER_3_ELITE_SETUP" : trade.explorationTrade ? "TIER_1_EXPLORATORY" : "UNCLASSIFIED"));
}

function sessionOf(trade) {
  if (trade.sessionRegime || trade.sessionType) return String(trade.sessionRegime || trade.sessionType);
  const date = new Date(tradeTimestamp(trade));
  const hour = date.getUTCHours();
  if (hour >= 0 && hour < 7) return "ASIA";
  if (hour >= 7 && hour < 13) return "EUROPE";
  if (hour >= 13 && hour < 22) return "US";
  return "LATE_US_ASIA_HANDOFF";
}

function summarizeTrades(rows) {
  const closed = rows.filter((trade) => ["CLOSED", "FILLED", "SETTLED"].includes(String(trade.status || "CLOSED").toUpperCase()) || trade.realizedPnlUsdt !== undefined);
  const wins = closed.filter((trade) => netPnl(trade) > 0);
  const losses = closed.filter((trade) => netPnl(trade) < 0);
  const grossWins = closed.filter((trade) => grossPnl(trade) > 0);
  const totalNet = sum(closed.map((trade) => ({ value: netPnl(trade) })), "value");
  const totalGross = sum(closed.map((trade) => ({ value: grossPnl(trade) })), "value");
  const totalFees = sum(closed.map((trade) => ({ value: fees(trade) })), "value");
  const winPnl = wins.reduce((total, trade) => total + netPnl(trade), 0);
  const lossPnl = losses.reduce((total, trade) => total + Math.abs(netPnl(trade)), 0);
  const grossProfit = grossWins.reduce((total, trade) => total + Math.max(0, grossPnl(trade)), 0);
  const grossLoss = closed.reduce((total, trade) => total + Math.abs(Math.min(0, grossPnl(trade))), 0);
  const positiveGrossNegativeNet = closed.filter((trade) => grossPnl(trade) > 0 && netPnl(trade) < 0);
  const quickHold = closed.filter((trade) => holdSeconds(trade) > 0 && holdSeconds(trade) < 45);
  return {
    trades: closed.length,
    netWins: wins.length,
    netLosses: losses.length,
    netWinRatePct: pct(wins.length, closed.length),
    grossWinRatePct: pct(grossWins.length, closed.length),
    grossRealizedPnlUsdt: round(totalGross),
    netRealizedPnlUsdt: round(totalNet),
    totalFeesUsdt: round(totalFees),
    averageNetWinnerUsdt: round(average(wins.map(netPnl))),
    averageNetLoserUsdt: round(average(losses.map(netPnl))),
    rewardRiskOutcomeRatio: losses.length ? round(average(wins.map(netPnl)) / Math.abs(average(losses.map(netPnl))), 4) : 0,
    profitFactorAfterCosts: lossPnl ? round(winPnl / lossPnl, 4) : winPnl > 0 ? 999 : 0,
    expectancyPerTradeUsdt: closed.length ? round(totalNet / closed.length) : 0,
    feesAsPctOfGrossProfit: pct(totalFees, grossProfit),
    feesAsPctOfTotalGrossLoss: pct(totalFees, grossLoss),
    averageHoldingSeconds: round(average(closed.map(holdSeconds)), 2),
    medianHoldingSeconds: round(median(closed.map(holdSeconds)), 2),
    closedTooQuicklyToRealisticallyOvercomeFees: quickHold.length,
    grossPositiveButNetNegativeTrades: positiveGrossNegativeNet.length,
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || "UNKNOWN");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([key, values]) => [key, summarizeTrades(values)]));
}

function findCsvFiles(dir) {
  const output = [];
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) output.push(...findCsvFiles(fullPath));
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) output.push(fullPath);
  }
  return output;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function loadCsvRows(files) {
  const rows = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8").trim();
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    const headers = parseCsvLine(lines[0]).map((header) => header.trim());
    for (const line of lines.slice(1)) {
      const values = parseCsvLine(line);
      const row = { sourceFile: path.relative(ROOT, file) };
      headers.forEach((header, index) => {
        row[header] = values[index];
      });
      rows.push(row);
    }
  }
  return rows;
}

function firstField(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== "") return row[name];
  }
  return "";
}

function parseFeeInfo(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return Object.values(parsed).reduce((total, item) => total + numeric(item), 0);
    }
  } catch (_error) {
    const match = raw.match(/USDT"?\s*:\s*"?(-?\d+(?:\.\d+)?)/i);
    if (match) return numeric(match[1]);
  }
  return numeric(raw);
}

function parseBybitCsvTimestamp(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})\s+(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, hour, minute, year, month, day] = match;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBybitCsvOrder(row, index) {
  const timestampMs =
    parseBybitCsvTimestamp(firstField(row, ["Order Time(UTC+0)", "Order Time", "Create Time"])) ||
    parseBybitCsvTimestamp(row["Create Time"]);
  const filledQuantity = numeric(firstField(row, ["Filled Quantity", "Filled Qty", "Qty"]));
  const filledPrice = numeric(firstField(row, ["Filled Price", "Average Price", "Avg Fill Price"]));
  const direction = String(firstField(row, ["Direction", "Side"]) || "UNKNOWN").trim().toUpperCase();
  const sign = direction === "LONG" ? 1 : direction === "SHORT" ? -1 : 0;
  return {
    rowIndex: index,
    sourceFile: row.sourceFile,
    symbol: String(firstField(row, ["Market", "Symbol"]) || "UNKNOWN").trim().toUpperCase(),
    orderQuantity: numeric(firstField(row, ["Order Quantity", "Qty", "Quantity"])),
    orderPrice: numeric(firstField(row, ["Order Price", "Price"])),
    triggerPrice: numeric(firstField(row, ["Trigger Price"])),
    filledQuantity,
    filledPrice,
    direction,
    sign,
    orderType: String(firstField(row, ["Order Type", "Type"]) || "UNKNOWN").trim().toUpperCase(),
    orderStatus: String(firstField(row, ["Order Status", "Status"]) || "UNKNOWN").trim().toUpperCase(),
    orderId: String(firstField(row, ["Order ID", "OrderId", "orderId"]) || "").trim(),
    timeInForce: String(firstField(row, ["Time In Force"]) || "").trim(),
    feeUsdt: parseFeeInfo(firstField(row, ["feeInfo", "Fee", "Trading Fee"])),
    timestampMs,
    timestamp: timestampMs ? new Date(timestampMs).toISOString() : null,
    notionalUsdt: filledQuantity && filledPrice ? Math.abs(filledQuantity * filledPrice) : 0,
  };
}

function fundingFromCsvRows(rows) {
  const fundingKeys = rows.length
    ? Object.keys(rows[0]).filter((key) => /funding/i.test(key))
    : [];
  if (!fundingKeys.length) {
    return {
      available: false,
      fundingUsdt: 0,
      reason: "The imported Bybit order-history CSV has no funding columns. Funding must be imported from Bybit funding/transaction history for exact funding accounting.",
    };
  }
  const fundingUsdt = rows.reduce((total, row) => {
    return total + fundingKeys.reduce((keyTotal, key) => keyTotal + numeric(row[key]), 0);
  }, 0);
  return {
    available: true,
    fundingUsdt: round(fundingUsdt),
    fundingColumns: fundingKeys,
  };
}

function summarizeOrderStatuses(orders) {
  return orders.reduce((statusCounts, order) => {
    statusCounts[order.orderStatus] = (statusCounts[order.orderStatus] || 0) + 1;
    return statusCounts;
  }, {});
}

function closeCsvLot({ completedTrades, lot, order, closeQuantity, entryFeeUsdt, exitFeeUsdt, sequence }) {
  const grossPnlUsdt =
    lot.sign > 0
      ? (order.filledPrice - lot.price) * closeQuantity
      : (lot.price - order.filledPrice) * closeQuantity;
  const totalFeesUsdt = entryFeeUsdt + exitFeeUsdt;
  const netPnlUsdt = grossPnlUsdt - totalFeesUsdt;
  completedTrades.push({
    id: `csv-roundtrip-${String(sequence).padStart(4, "0")}`,
    source: "BYBIT_ORDER_HISTORY_CSV_RECONSTRUCTED",
    sourceAssumption: "Direction=Long is treated as positive signed fill; Direction=Short is treated as negative signed fill. Order-history CSV lacks explicit buy/sell reduce-only fields.",
    status: "CLOSED",
    symbol: lot.symbol,
    side: lot.sign > 0 ? "LONG" : "SHORT",
    size: round(closeQuantity, 8),
    entryPrice: round(lot.price, 8),
    exitPrice: round(order.filledPrice, 8),
    openedAt: lot.openedAt,
    exitedAt: order.timestamp,
    holdSeconds: lot.openedAt && order.timestamp ? round((Date.parse(order.timestamp) - Date.parse(lot.openedAt)) / 1000, 2) : 0,
    entryOrderId: lot.orderId,
    exitOrderId: order.orderId,
    orderIds: [lot.orderId, order.orderId].filter(Boolean),
    grossPnlUsdt: round(grossPnlUsdt),
    actualEntryFeeUsdt: round(entryFeeUsdt),
    actualExitFeeUsdt: round(exitFeeUsdt),
    feesUsdt: round(totalFeesUsdt),
    actualFundingUsdt: 0,
    pnlUsdt: round(netPnlUsdt),
    realizedPnlUsdt: round(netPnlUsdt),
    tradeCategory: "EXCHANGE_RECONSTRUCTED",
    setupType: "CSV_RECONSTRUCTED",
    winLoss: netPnlUsdt > 0 ? "WIN" : netPnlUsdt < 0 ? "LOSS" : "BREAKEVEN",
  });
}

function reconstructCsvCompletedTrades(orders) {
  const filled = orders
    .filter((order) => order.orderStatus === "FILLED" && order.filledQuantity > 0 && order.filledPrice > 0 && order.sign !== 0 && order.timestampMs)
    .sort((left, right) => left.timestampMs - right.timestampMs || left.rowIndex - right.rowIndex);
  const positions = new Map();
  const completedTrades = [];
  let sequence = 1;

  for (const order of filled) {
    if (!positions.has(order.symbol)) positions.set(order.symbol, []);
    const lots = positions.get(order.symbol);
    const absoluteOrderQuantity = Math.abs(order.filledQuantity);
    let remainingQuantity = absoluteOrderQuantity;
    const incomingFeeUsdt = order.feeUsdt;

    while (remainingQuantity > 1e-12 && lots.length && lots[0].sign !== order.sign) {
      const lot = lots[0];
      const closeQuantity = Math.min(remainingQuantity, lot.quantity);
      const entryFeeUsdt = lot.feeRemainingUsdt * (closeQuantity / lot.quantity);
      const exitFeeUsdt = incomingFeeUsdt * (closeQuantity / absoluteOrderQuantity);
      closeCsvLot({
        completedTrades,
        lot,
        order,
        closeQuantity,
        entryFeeUsdt,
        exitFeeUsdt,
        sequence,
      });
      sequence += 1;
      lot.quantity -= closeQuantity;
      lot.feeRemainingUsdt -= entryFeeUsdt;
      remainingQuantity -= closeQuantity;
      if (lot.quantity <= 1e-12) lots.shift();
    }

    if (remainingQuantity > 1e-12) {
      lots.push({
        symbol: order.symbol,
        sign: order.sign,
        quantity: remainingQuantity,
        price: order.filledPrice,
        feeRemainingUsdt: incomingFeeUsdt * (remainingQuantity / absoluteOrderQuantity),
        openedAt: order.timestamp,
        timestampMs: order.timestampMs,
        orderId: order.orderId,
      });
    }
  }

  const openLots = [...positions.entries()].flatMap(([positionSymbol, lots]) =>
    lots.map((lot) => ({
      symbol: positionSymbol,
      side: lot.sign > 0 ? "LONG" : "SHORT",
      quantity: round(lot.quantity, 8),
      entryPrice: round(lot.price, 8),
      openedAt: lot.openedAt,
      entryFeeStillOpenUsdt: round(lot.feeRemainingUsdt),
      orderId: lot.orderId,
    }))
  );

  return {
    filledOrders: filled,
    completedTrades,
    openLots,
  };
}

function orderIdsForTrade(trade) {
  const values = [
    trade.entryOrderId,
    trade.exitOrderId,
    trade.closeOrderId,
    trade.orderId,
    trade.entryOrderLinkId,
    trade.closeOrderLinkId,
  ];
  if (Array.isArray(trade.orderIds)) values.push(...trade.orderIds);
  if (Array.isArray(trade.exchangeOrderIds)) values.push(...trade.exchangeOrderIds);
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function reconcileLocalAndExchange(localTrades, exchangeTrades, exchangeOrders) {
  const exchangeOrderIds = exchangeOrders.map((order) => order.orderId).filter(Boolean);
  const matchedLocalTrades = [];
  const unmatchedLocalTrades = [];
  for (const trade of localTrades) {
    const ids = orderIdsForTrade(trade);
    const matched = ids.some((id) =>
      exchangeOrderIds.some((exchangeId) => exchangeId === id || exchangeId.includes(id) || id.includes(exchangeId))
    );
    if (matched) matchedLocalTrades.push(trade);
    else unmatchedLocalTrades.push(trade);
  }
  const localSummary = summarizeTrades(localTrades);
  const exchangeSummary = summarizeTrades(exchangeTrades);
  return {
    localClosedTrades: localTrades.length,
    exchangeFilledOrders: exchangeOrders.length,
    exchangeReconstructedCompletedTrades: exchangeTrades.length,
    matchedLocalTradesByOrderId: matchedLocalTrades.length,
    unmatchedLocalTradesByOrderId: unmatchedLocalTrades.length,
    unmatchedLocalTradeExamples: unmatchedLocalTrades.slice(0, 20).map((trade) => ({
      id: trade.id,
      symbol: symbol(trade),
      side: side(trade),
      openedAt: trade.openedAt,
      exitedAt: trade.exitedAt,
      netPnlUsdt: round(netPnl(trade)),
      orderIds: orderIdsForTrade(trade),
    })),
    localNetPnlUsdt: localSummary.netRealizedPnlUsdt,
    exchangeReconstructedNetPnlUsdt: exchangeSummary.netRealizedPnlUsdt,
    netPnlDifferenceUsdt: round(localSummary.netRealizedPnlUsdt - exchangeSummary.netRealizedPnlUsdt),
    localFeesUsdt: localSummary.totalFeesUsdt,
    exchangeActualFeesUsdt: exchangeSummary.totalFeesUsdt,
    feeDifferenceUsdt: round(localSummary.totalFeesUsdt - exchangeSummary.totalFeesUsdt),
    assumptions: [
      "Bybit order-history CSV does not include explicit realized PnL, reduce-only, or funding fields.",
      "Exchange completed trades were reconstructed FIFO from signed Long/Short fills.",
      "Local bot records contain richer strategy/setup metadata; CSV records are treated as the fee and fill-price source of truth when present.",
    ],
  };
}

function continuationFlipBucket(trade) {
  if (trade.isFlip) return "FLIP";
  if (trade.continuationVsFlip) return String(trade.continuationVsFlip).toUpperCase();
  if (/CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/.test(setupType(trade))) return "CONTINUATION";
  return "OTHER";
}

function assessEdgeThresholds({ localOverall, exchangeOverall, localTrades }) {
  const projectedPositiveButLost = localTrades.filter((trade) => numeric(trade.projectedNetProfitUsdt) > 0 && netPnl(trade) < 0);
  const projectedPositiveNetPnl = summarizeTrades(localTrades.filter((trade) => numeric(trade.projectedNetProfitUsdt) > 0));
  const feeDragHigh = localOverall.feesAsPctOfGrossProfit > 35 || exchangeOverall.feesAsPctOfGrossProfit > 35;
  const profitFactorWeak = localOverall.profitFactorAfterCosts < 1 || exchangeOverall.profitFactorAfterCosts < 1;
  return {
    status: feeDragHigh || profitFactorWeak ? "EDGE_THRESHOLDS_APPEAR_NECESSARY_AND_SHOULD_NOT_BE_LOOSENED_YET" : "EDGE_THRESHOLDS_LOOK_REASONABLE_ON_AVAILABLE_SAMPLE",
    projectedPositiveButNetLosingTrades: projectedPositiveButLost.length,
    projectedPositiveNetPnlSummary: projectedPositiveNetPnl,
    evidence: [
      feeDragHigh ? "Fee drag remains material relative to gross profit." : "Fee drag is not dominant on the available sample.",
      profitFactorWeak ? "Profit factor after costs is still below 1 on available records." : "Profit factor after costs is above 1 on available records.",
      projectedPositiveButLost.length ? "Some trades with positive projected edge still closed net-negative, so the edge model needs calibration against actual fills." : "No projected-positive net losers were found in the available local records.",
    ],
    recommendation: "Do not loosen V4 edge thresholds from this audit alone. Validate in demo or very small controlled live mode and calibrate projected edge against actual net results.",
  };
}

function flipAnalysis(trades) {
  const ordered = [...trades].sort((left, right) => tradeTimestamp(left) - tradeTimestamp(right));
  const rapidFlips = [];
  const repeatLossReentries = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const deltaSeconds = (numeric(current.openedAt ? Date.parse(current.openedAt) : tradeTimestamp(current)) - tradeTimestamp(previous)) / 1000;
    if (symbol(previous) === symbol(current) && side(previous) !== side(current) && deltaSeconds >= 0 && deltaSeconds <= 300) {
      rapidFlips.push({
        previousTradeId: previous.id,
        currentTradeId: current.id,
        symbol: symbol(current),
        from: side(previous),
        to: side(current),
        secondsBetween: round(deltaSeconds, 2),
        previousNetPnlUsdt: round(netPnl(previous)),
        currentNetPnlUsdt: round(netPnl(current)),
      });
    }
    if (symbol(previous) === symbol(current) && side(previous) === side(current) && netPnl(previous) < 0 && deltaSeconds >= 0 && deltaSeconds <= 900) {
      repeatLossReentries.push({
        previousTradeId: previous.id,
        currentTradeId: current.id,
        symbol: symbol(current),
        side: side(current),
        secondsBetween: round(deltaSeconds, 2),
        previousNetPnlUsdt: round(netPnl(previous)),
        currentNetPnlUsdt: round(netPnl(current)),
      });
    }
  }
  return {
    rapidLongShortFlips: rapidFlips.length,
    rapidFlipNetPnlUsdt: round(rapidFlips.reduce((total, item) => total + item.currentNetPnlUsdt, 0)),
    repeatedReentriesAfterLoss: repeatLossReentries.length,
    reentryAfterLossNetPnlUsdt: round(repeatLossReentries.reduce((total, item) => total + item.currentNetPnlUsdt, 0)),
    rapidFlipExamples: rapidFlips.slice(0, 20),
    reentryAfterLossExamples: repeatLossReentries.slice(0, 20),
  };
}

async function scanLog(file) {
  const summary = {
    available: fs.existsSync(file),
    bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    linesRead: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    messageCounts: {},
    bybit34040Mentions: 0,
    apiRecoveryMentions: 0,
    websocketReconnects: 0,
    duplicateProtectionMentions: 0,
    entrySignals: 0,
    forcedSampling: 0,
    lowEdgeRejections: 0,
    latestEquityUsdt: null,
    latestCycleRisk: null,
  };
  if (!summary.available) return summary;
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    summary.linesRead += 1;
    if (!line.trim()) continue;
    let event = null;
    try {
      event = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    if (event.time) {
      summary.firstTimestamp = summary.firstTimestamp || event.time;
      summary.lastTimestamp = event.time;
    }
    const message = String(event.message || "UNKNOWN");
    summary.messageCounts[message] = (summary.messageCounts[message] || 0) + 1;
    if (/34040|not modified/i.test(line)) summary.bybit34040Mentions += 1;
    if (/API auto-recovery|recovery/i.test(message)) summary.apiRecoveryMentions += 1;
    if (/WEBSOCKET RECONNECTED/i.test(message)) summary.websocketReconnects += 1;
    if (/unchanged|duplicate protection|already current|already valid/i.test(message)) summary.duplicateProtectionMentions += 1;
    if (message === "ENTRY SIGNAL") summary.entrySignals += 1;
    if (/Forced market sampling/i.test(message)) summary.forcedSampling += 1;
    if (/Low-edge setup rejected|Micro-scalp filtered|fee-aware/i.test(message)) summary.lowEdgeRejections += 1;
    if (message === "Cycle risk status") {
      summary.latestCycleRisk = event;
      summary.latestEquityUsdt = numeric(event.equityUsdt, summary.latestEquityUsdt);
    }
    if (message === "Bybit UTA wallet balance parsed") {
      summary.latestEquityUsdt = numeric(event.parsedTotalEquity, summary.latestEquityUsdt);
    }
  }
  summary.topMessages = Object.entries(summary.messageCounts)
    .map(([message, count]) => ({ message, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 25);
  delete summary.messageCounts;
  return summary;
}

function worstGroups(grouped, limit = 10) {
  return Object.entries(grouped)
    .map(([key, stats]) => ({ key, ...stats }))
    .sort((left, right) => left.netRealizedPnlUsdt - right.netRealizedPnlUsdt)
    .slice(0, limit);
}

function bestGroups(grouped, limit = 10) {
  return Object.entries(grouped)
    .map(([key, stats]) => ({ key, ...stats }))
    .sort((left, right) => right.netRealizedPnlUsdt - left.netRealizedPnlUsdt)
    .slice(0, limit);
}

async function main() {
  const trades = readJson("data/trades.json", []);
  const memory = readJson("data/tradeMemory.json", { trades: [] });
  const analytics = readJson("data/analytics.json", {});
  const state = readJson("data/state.json", {});
  const csvFiles = findCsvFiles(ROOT);
  const csvRows = loadCsvRows(csvFiles);
  const csvOrders = csvRows.map(normalizeBybitCsvOrder);
  const csvFunding = fundingFromCsvRows(csvRows);
  const csvReconstruction = reconstructCsvCompletedTrades(csvOrders);
  const csvCompletedTrades = csvReconstruction.completedTrades;
  const csvOverall = summarizeTrades(csvCompletedTrades);
  const csvBySymbol = groupBy(csvCompletedTrades, symbol);
  const csvBySide = groupBy(csvCompletedTrades, side);
  const closedTrades = Array.isArray(trades)
    ? trades.filter((trade) => String(trade.status || "").toUpperCase() === "CLOSED")
    : [];
  const memoryTrades = memory && Array.isArray(memory.trades) ? memory.trades : [];
  const allClosed = closedTrades.length ? closedTrades : memoryTrades;
  const overall = summarizeTrades(allClosed);
  const reconciliation = reconcileLocalAndExchange(allClosed, csvCompletedTrades, csvReconstruction.filledOrders);
  const bySymbol = groupBy(allClosed, symbol);
  const bySide = groupBy(allClosed, side);
  const byCategory = groupBy(allClosed, tradeCategory);
  const bySetup = groupBy(allClosed, setupType);
  const byExploration = groupBy(allClosed, (trade) => (trade.explorationTrade || trade.tradeCategory === "EXPLORATION" ? "EXPLORATION" : "NON_EXPLORATION"));
  const byContinuation = groupBy(allClosed, (trade) =>
    /CONTINUATION|RETEST|RESUMPTION|ACCELERATION|BREAKOUT/.test(setupType(trade)) ? "CONTINUATION_OR_BREAKOUT" : "MOMENTUM_OR_OTHER"
  );
  const byContinuationFlip = groupBy(allClosed, continuationFlipBucket);
  const byHour = groupBy(allClosed, (trade) => new Date(tradeTimestamp(trade)).getUTCHours());
  const bySession = groupBy(allClosed, sessionOf);
  const byRegime = groupBy(allClosed, (trade) => trade.marketRegimeType || trade.signalRegime || trade.marketRegime || "UNKNOWN");
  const bySizeTier = groupBy(allClosed, sizeTier);
  const byLeverage = groupBy(allClosed, leverageBucket);
  const grossPositiveNetNegative = allClosed
    .filter((trade) => grossPnl(trade) > 0 && netPnl(trade) < 0)
    .map((trade) => ({
      id: trade.id,
      symbol: symbol(trade),
      side: side(trade),
      grossPnlUsdt: round(grossPnl(trade)),
      netPnlUsdt: round(netPnl(trade)),
      feesUsdt: round(fees(trade)),
      holdSeconds: round(holdSeconds(trade), 2),
    }));
  const shortHolds = allClosed
    .filter((trade) => holdSeconds(trade) > 0 && holdSeconds(trade) < 45)
    .map((trade) => ({
      id: trade.id,
      symbol: symbol(trade),
      side: side(trade),
      netPnlUsdt: round(netPnl(trade)),
      feesUsdt: round(fees(trade)),
      holdSeconds: round(holdSeconds(trade), 2),
    }));
  const logSummary = await scanLog(path.join(DATA_DIR, "bybit-bot.log"));
  const flips = flipAnalysis(allClosed);
  const audit = {
    generatedAt: new Date().toISOString(),
    sourceAvailability: {
      bybitCsv: csvFiles.length ? csvFiles.map((file) => path.relative(ROOT, file)) : "UNAVAILABLE: no CSV files found under project root",
      bybitCsvRows: csvRows.length,
      tradesJson: Array.isArray(trades) ? trades.length : "UNAVAILABLE",
      tradeMemoryJson: memoryTrades.length,
      analyticsJson: analytics && !analytics.unavailable ? "available" : analytics.error || "unavailable",
      stateJson: state && !state.unavailable ? "available" : state.error || "unavailable",
      logFile: logSummary.available ? { path: "data/bybit-bot.log", bytes: logSummary.bytes, linesRead: logSummary.linesRead } : "UNAVAILABLE",
    },
    accountContext: {
      configuredStartEquityUsdt: numeric(state && state.daily && state.daily.startingEquity, null),
      currentStateEquityUsdt: numeric(state && state.equity && state.equity.currentUsdt, null),
      currentStateRealizedPnlUsdt: numeric(state && state.equity && state.equity.realizedPnlUsdt, null),
      latestLogEquityUsdt: logSummary.latestEquityUsdt,
      openPositions: Array.isArray(state.openPositions) ? state.openPositions.length : 0,
      note: "Equity is based on local state/log records. The imported Bybit CSV is order history, so it verifies fills and fees but not full account-equity history.",
    },
    overall,
    funding: {
      status: csvFunding.available || allClosed.some((trade) => numeric(trade.actualFundingUsdt || trade.fundingUsdt) !== 0) ? "PARTIAL" : "UNAVAILABLE",
      csv: csvFunding,
      localFundingUsdt: round(allClosed.reduce((total, trade) => total + numeric(trade.actualFundingUsdt || trade.fundingUsdt), 0)),
      reason: csvFunding.available
        ? "Funding was found in CSV columns."
        : "No funding fields were present in the imported Bybit order-history CSV. Local records mostly store actualFundingUsdt as zero when available.",
    },
    bybitCsvAnalysis: {
      files: csvFiles.map((file) => path.relative(ROOT, file)),
      rows: csvRows.length,
      orderStatusCounts: summarizeOrderStatuses(csvOrders),
      filledOrders: csvReconstruction.filledOrders.length,
      filledOrderNotionalUsdt: round(csvReconstruction.filledOrders.reduce((total, order) => total + order.notionalUsdt, 0)),
      totalActualFeesUsdt: round(csvReconstruction.filledOrders.reduce((total, order) => total + order.feeUsdt, 0)),
      completedTrades: csvCompletedTrades.length,
      openLotsRemainingAfterCsvReconstruction: csvReconstruction.openLots,
      overall: csvOverall,
      bySymbol: csvBySymbol,
      bySide: csvBySide,
      completedTradeLedger: csvCompletedTrades,
      notes: [
        "The CSV is order history, not Bybit closed-PnL history.",
        "Completed trades are reconstructed from filled orders with FIFO accounting.",
        "Funding is unavailable unless a separate funding/transaction export is imported.",
      ],
    },
    reconciliation,
    slippage: {
      averageSlippagePct: round(average(memoryTrades.map((trade) => trade.slippagePct)), 4),
      source: memoryTrades.some((trade) => trade.slippagePct !== undefined) ? "tradeMemory.slippagePct" : "UNAVAILABLE",
    },
    breakdowns: {
      bySymbol,
      legacySymbols: Object.fromEntries(Object.entries(bySymbol).filter(([key]) => !["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(key))),
      bySide,
      byTradeCategory: byCategory,
      bySetupType: bySetup,
      explorationVsNormal: byExploration,
      continuationVsOther: byContinuation,
      continuationVsFlip: byContinuationFlip,
      byHourUtc: byHour,
      bySession,
      byMarketRegime: byRegime,
      bySizeTier,
      byLeverage,
    },
    badBehaviorDetection: {
      grossPositiveButNetNegative: {
        count: grossPositiveNetNegative.length,
        netPnlUsdt: round(grossPositiveNetNegative.reduce((total, item) => total + item.netPnlUsdt, 0)),
        examples: grossPositiveNetNegative.slice(0, 25),
      },
      rapidFlips: flips,
      highFrequencyFeeBleed: {
        totalFeesUsdt: overall.totalFeesUsdt,
        feesAsPctOfGrossProfit: overall.feesAsPctOfGrossProfit,
        feeDragWarning: overall.feesAsPctOfGrossProfit > 50 || overall.profitFactorAfterCosts < 1,
      },
      shortHoldingTime: {
        countUnder45Seconds: shortHolds.length,
        netPnlUsdt: round(shortHolds.reduce((total, item) => total + item.netPnlUsdt, 0)),
        examples: shortHolds.slice(0, 25),
      },
      worstSymbols: worstGroups(bySymbol),
      worstSetups: worstGroups(bySetup),
      bestSymbols: bestGroups(bySymbol),
      bestSetups: bestGroups(bySetup),
      tpTooSmallEvidence: {
        status: "PARTIAL",
        evidence: "Gross-positive/net-negative trades and fee ratio indicate many moves were too small after costs. Exact TP-vs-stop effectiveness is limited by missing per-order CSV/funding data.",
      },
      oversizingEvidence: {
        status: "PARTIAL",
        latestOpenRiskUnavailable: "Historical equity-at-entry was not consistently stored. V4 should record maxLossAtStopUsdt and riskPctOfEquity for every future trade.",
      },
    },
    edgeThresholdAssessment: assessEdgeThresholds({ localOverall: overall, exchangeOverall: csvOverall, localTrades: allClosed }),
    logSummary,
    existingAnalyticsSnapshot: {
      totalPnl: analytics.totalPnl || null,
      rolling: analytics.rolling || null,
      adaptivePolicy: analytics.adaptivePolicy || null,
    },
    requiredFutureFields: [
      "actualFundingUsdt",
      "actualEntryFeeUsdt",
      "actualExitFeeUsdt",
      "maxLossAtStopUsdt",
      "riskPctOfEquity",
      "executionType",
      "fillDelayMs",
      "actualSlippagePct",
      "grossPositiveNetNegative",
      "isReentry",
      "isFlip",
      "marketMode",
      "edgeGateDecision",
      "projectedNetProfitUsdt",
      "projectedTotalCostUsdt",
      "runnerMfeUsdt",
      "runnerMaeUsdt",
      "runnerNetContributionUsdt"
    ],
    conclusions: {
      measuredPrimaryLossDrivers: [
        overall.profitFactorAfterCosts < 1 ? "Net profit factor after costs is below 1." : null,
        overall.feesAsPctOfGrossProfit > 50 ? "Fees consumed more than half of gross profit." : null,
        grossPositiveNetNegative.length ? "Some trades were gross-positive but net-negative after costs." : null,
        shortHolds.length ? "Many trades closed inside 45 seconds, making fee coverage harder." : null,
        flips.rapidLongShortFlips ? "Rapid same-symbol long/short flips were detected." : null,
      ].filter(Boolean),
      csvLimitation: csvFiles.length
        ? "Imported CSV provides filled orders and fees, but not explicit realized PnL/funding/reduce-only fields. Round trips are reconstructed from signed fills."
        : "No provided Bybit CSV was found, so exchange-native funding and per-fill CSV accounting could not be verified.",
    },
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, "pre-v4-audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");

  console.log("Pre-V4 audit written to data/reports/pre-v4-audit.json");
  console.log(JSON.stringify({
    sourceAvailability: audit.sourceAvailability,
    accountContext: audit.accountContext,
    overall: audit.overall,
    bybitCsvAnalysis: {
      filledOrders: audit.bybitCsvAnalysis.filledOrders,
      completedTrades: audit.bybitCsvAnalysis.completedTrades,
      totalActualFeesUsdt: audit.bybitCsvAnalysis.totalActualFeesUsdt,
      overall: audit.bybitCsvAnalysis.overall,
      openLotsRemainingAfterCsvReconstruction: audit.bybitCsvAnalysis.openLotsRemainingAfterCsvReconstruction,
    },
    reconciliation: audit.reconciliation,
    worstSymbols: audit.badBehaviorDetection.worstSymbols.slice(0, 3),
    worstSetups: audit.badBehaviorDetection.worstSetups.slice(0, 3),
    edgeThresholdAssessment: audit.edgeThresholdAssessment,
    detectedIssues: audit.conclusions.measuredPrimaryLossDrivers,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
