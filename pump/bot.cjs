#!/usr/bin/env node
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./lib/config.cjs");
const C = require("./lib/constants.cjs");
const curve = require("./lib/curve.cjs");
const sol = require("./lib/solana.cjs");
const { Tracker, summarizeHolders, curveTokenBalance } = require("./lib/tracker.cjs");
const { PaperBroker } = require("./lib/paperBroker.cjs");
const { LiveBroker } = require("./lib/liveBroker.cjs");
const { RiskManager } = require("./lib/risk.cjs");
const { Recorder } = require("./lib/recorder.cjs");
const { Engine } = require("./lib/engine.cjs");
const { PumpPortalFeed, RpcLogsFeed } = require("./lib/feed.cjs");
const { createWallet, loadWallet } = require("./lib/wallet.cjs");

const LIVE_ACK = "I_ACCEPT_LOSING_THIS_MONEY";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);
const signed = (x, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);

function log(level, msg) {
  const mark = level === "warn" ? "!" : level === "trade" ? ">" : " ";
  console.log(`[${ts()}] ${mark} ${msg}`);
}

const HELP = `pump.fun momentum bot

  node pump/bot.cjs                 paper trading with fake SOL on live data (default)
  node pump/bot.cjs --check         test RPC, coin feed, on-chain reads and the trade API (spends nothing)
  node pump/bot.cjs --new-wallet    create the bot's own wallet (fund it with only what you can lose)
  node pump/bot.cjs --wallet        show the bot wallet's address, balance and coins
  node pump/bot.cjs --self-test     live: one tiny real buy + sell (~0.003 SOL) to prove the pipeline
  node pump/bot.cjs --live          live trading (needs PUMP_LIVE_ACK and PUMP_MAX_BUDGET_SOL, see pump/README.md)
  node pump/bot.cjs --sell-all      live: sell every coin in the bot wallet and reclaim account rent
  node pump/bot.cjs --withdraw <address> --yes   send all SOL from the bot wallet to <address>

Options: --minutes N (stop after N minutes), --params file.json (strategy from replay)
Stop any time: Ctrl+C (sells open positions first) or create a file named STOP_PUMP.txt.`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--live") a.live = true;
    else if (k === "--paper") a.paper = true;
    else if (k === "--check") a.check = true;
    else if (k === "--new-wallet") a.newWallet = true;
    else if (k === "--wallet") a.wallet = true;
    else if (k === "--sell-all") a.sellAll = true;
    else if (k === "--withdraw") a.withdraw = argv[++i];
    else if (k === "--yes") a.yes = true;
    else if (k === "--self-test") a.selfTest = true;
    else if (k === "--minutes") a.minutes = Number(argv[++i]);
    else if (k === "--params") a.params = argv[++i];
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown option ${k} (see --help)`);
  }
  if (a.live && a.paper) throw new Error("choose --live or --paper, not both");
  return a;
}

class SolPrice {
  constructor(override) {
    this.usd = override || null;
    this.fixed = !!override;
  }
  async refresh() {
    if (this.fixed) return;
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j && j.solana && j.solana.usd > 0) this.usd = j.solana.usd;
    } catch (_) {
      // keep the last known price
    }
  }
  start() { this.timer = setInterval(() => this.refresh(), 300000); }
  stop() { clearInterval(this.timer); }
  fmt(solAmt) { return this.usd ? ` ($${(solAmt * this.usd).toFixed(2)})` : ""; }
}

function liveProblems(cfg) {
  const p = [];
  if (cfg.liveAck !== LIVE_ACK) p.push(`add PUMP_LIVE_ACK=${LIVE_ACK} to .env (confirms this is money you can afford to lose)`);
  if (!(cfg.maxBudgetSol > 0)) p.push("add PUMP_MAX_BUDGET_SOL to .env, e.g. 0.1 (about $10): the most the bot may ever put at risk");
  for (const f of cfg.stopFiles) if (fs.existsSync(f)) p.push(`${path.basename(f)} exists in this folder; delete it to allow live trading`);
  if (!fs.existsSync(cfg.walletFile)) p.push("no bot wallet yet: run  node pump/bot.cjs --new-wallet");
  return p;
}

function requireLive(cfg) {
  const p = liveProblems(cfg);
  if (p.length) {
    console.log("Live trading is locked:");
    for (const x of p) console.log(`  - ${x}`);
    process.exit(1);
  }
}

function makeFeed(cfg, conn) {
  return cfg.discovery === "rpc" ? new RpcLogsFeed({ conn }) : new PumpPortalFeed({ url: cfg.wsUrl, apiKey: cfg.pumpPortalApiKey });
}

function status(engine, broker, risk, tracker, price, startEquity) {
  const cash = broker.mode === "paper" ? broker.cash : broker.balanceSol;
  const equity = cash + engine.openValueSol();
  const pnl = equity - startEquity;
  const gate = risk.halted ? " | DAILY LOSS LIMIT HIT: no buys until 00:00 UTC" : Date.now() < risk.pausedUntil ? " | paused after a losing streak" : "";
  log(
    "info",
    `${broker.mode.toUpperCase()} | equity ${equity.toFixed(4)} SOL${price.fmt(equity)} | P&L ${signed(pnl)} SOL${price.fmt(pnl)} | open ${engine.positions.size} | ` +
      `trades ${risk.trades} (W${risk.wins}/L${risk.losses}) | watching ${tracker.tokens.size} of ${tracker.stats.seen} coins seen${gate}`
  );
}

async function run(cfg, args) {
  const live = !!args.live;
  if (live) requireLive(cfg);
  const conn = sol.connection(cfg.rpcUrl);
  const rpc = { getAccounts: (keys) => sol.getAccounts(conn, keys), getLargestHolders: (mint) => sol.getLargestHolders(conn, mint) };
  const tracker = new Tracker(cfg, sol.derive);
  const price = new SolPrice(cfg.solUsdOverride);
  await price.refresh();
  price.start();

  let broker, startSol, startEquity;
  if (live) {
    broker = new LiveBroker(cfg, { conn, keypair: loadWallet(cfg.walletFile), budgetSol: cfg.maxBudgetSol });
    await broker.refreshBalance();
    startSol = Math.min(broker.balanceSol, cfg.maxBudgetSol);
    startEquity = broker.balanceSol;
    const old = (await broker.holdings()).filter((h) => h.amount > 0);
    if (old.length) log("warn", `the wallet already holds ${old.length} coin(s); the bot leaves them alone (sell with --sell-all)`);
    if (startSol < cfg.risk.minTradeSol + cfg.risk.reserveSol) {
      log("warn", `not enough SOL: need at least ${(cfg.risk.minTradeSol + cfg.risk.reserveSol).toFixed(3)} SOL, wallet has ${broker.balanceSol.toFixed(4)}`);
      process.exit(1);
    }
    log("info", `LIVE TRADING with wallet ${broker.ownerStr}`);
    log("info", `balance ${broker.balanceSol.toFixed(4)} SOL${price.fmt(broker.balanceSol)}, budget ${cfg.maxBudgetSol} SOL, max ${cfg.risk.maxTradeSol} SOL per trade`);
  } else {
    broker = new PaperBroker(cfg, tracker, cfg.paperStartSol);
    startSol = cfg.paperStartSol;
    startEquity = startSol;
    log("info", `PAPER TRADING with ${startSol} SOL${price.fmt(startSol)} of fake money on real live data`);
  }
  log("info", `daily loss limit ${cfg.risk.dailyLossLimitPct}% (${((startSol * cfg.risk.dailyLossLimitPct) / 100).toFixed(4)} SOL) | research log: ${cfg.dataDir}`);

  const risk = new RiskManager(cfg.risk, startSol);
  const recorder = new Recorder(cfg.dataDir, cfg.runtime);
  const engine = new Engine({ cfg, tracker, broker, risk, recorder, rpc, log });
  const feed = makeFeed(cfg, conn);
  feed.on("create", (e) => engine.onCreate(e));
  feed.on("status", (s) => log("info", `[feed] ${s}`));
  feed.start();

  let stop = null;
  process.on("SIGINT", () => {
    if (stop) {
      log("warn", "forced exit. Any open coins stay in the wallet; sell them with --sell-all");
      process.exit(130);
    }
    stop = "Ctrl+C";
  });
  process.on("SIGTERM", () => { stop = stop || "SIGTERM"; });

  const endAt = args.minutes > 0 ? Date.now() + args.minutes * 60000 : Infinity;
  let lastStatus = 0, lastBalance = Date.now(), stopAt = 0, haltedLogged = false;
  for (;;) {
    const now = Date.now();
    if (!stop && now >= endAt) stop = `${args.minutes} minutes are up`;
    if (!stop && fs.existsSync(cfg.stopFiles[0])) stop = "STOP_PUMP.txt found";
    if (stop && !engine.stopping) {
      engine.stopping = true;
      stopAt = now;
      log("info", `stopping (${stop}): no new buys, closing ${engine.positions.size} open position(s)... press Ctrl+C again to quit at once`);
    }
    if (engine.stopping && engine.positions.size === 0) break;
    if (engine.stopping && now - stopAt > 180000) {
      log("warn", "positions still open after 3 minutes; quitting. Sell them with --sell-all");
      break;
    }
    if (risk.halted && !haltedLogged) {
      haltedLogged = true;
      log("warn", "daily loss limit reached: no new buys until 00:00 UTC (open positions are still managed)");
    }
    if (!risk.halted) haltedLogged = false;
    await engine.tick(now);
    if (live && now - lastBalance > 20000) {
      await broker.refreshBalance().catch(() => {});
      lastBalance = now;
    }
    if (now - lastStatus >= cfg.runtime.statusEverySec * 1000) {
      status(engine, broker, risk, tracker, price, startEquity);
      lastStatus = now;
    }
    await sleep(Math.max(50, cfg.runtime.pollMs - (Date.now() - now)));
  }
  feed.stop();
  price.stop();
  await engine.settle();
  if (live) await broker.refreshBalance().catch(() => {});
  status(engine, broker, risk, tracker, price, startEquity);
  const net = engine.closedTrades.reduce((a, t) => a + t.netSol, 0);
  console.log(`\nSession: ${engine.closedTrades.length} trades, ${risk.wins} wins / ${risk.losses} losses, net ${signed(net)} SOL${price.fmt(net)}`);
  console.log(`Trades log + research data: ${cfg.dataDir}   |   measure the strategy: node pump/replay.cjs`);
  process.exit(0);
}

async function tradeApiCheck(cfg, mint, publicKey) {
  const res = await fetch(C.PUMPPORTAL_TRADE_LOCAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: publicKey.toBase58(), action: "buy", mint, amount: 0.001, denominatedInSol: "true", slippage: 20, priorityFee: cfg.costs.priorityFeeSol, pool: "pump" }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const tx = sol.web3.VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  if (!tx.message.staticAccountKeys[0].equals(publicKey)) throw new Error("fee payer is not the requested wallet");
  return { outflow: sol.systemOutflowLamports(tx, publicKey) / C.LAMPORTS_PER_SOL, instructions: tx.message.compiledInstructions.length };
}

async function check(cfg) {
  let ok = true;
  const pass = (m) => console.log(`   OK   ${m}`);
  const fail = (m) => { ok = false; console.log(`   FAIL ${m}`); };
  const conn = sol.connection(cfg.rpcUrl);

  console.log(`1) Solana RPC (${cfg.rpcUrl.replace(/api-key=[^&]+/, "api-key=***")})`);
  try {
    const v = await conn.getVersion();
    pass(`connected, slot ${await conn.getSlot()}, solana-core ${v["solana-core"]}`);
  } catch (e) {
    fail(`cannot reach the RPC: ${e.message} (set SOLANA_RPC_URL in .env, e.g. a free Helius endpoint)`);
  }

  console.log(`2) New-coin feed (${cfg.discovery})`);
  const feed = makeFeed(cfg, conn);
  const first = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 45000);
    feed.on("status", (s) => console.log(`        ${s}`));
    feed.on("create", (e) => { clearTimeout(timer); resolve(e); });
    feed.start();
  });
  feed.stop();
  if (!first) fail("no new coin within 45s (try PUMP_DISCOVERY=rpc or set PUMPPORTAL_API_KEY)");
  else pass(`new coin ${first.symbol || "?"} ${first.mint} (dev bought ${Number.isFinite(first.devBuySol) ? first.devBuySol : "?"} SOL)`);

  if (first) {
    console.log("3) Reading that coin's bonding curve on-chain");
    const derived = sol.bondingCurveAddress(first.mint);
    if (first.bondingCurve && first.bondingCurve !== derived) fail(`curve address mismatch: feed ${first.bondingCurve}, derived ${derived}`);
    let acc = null;
    for (let i = 0; i < 12 && !acc; i++) {
      [acc] = await sol.getAccounts(conn, [derived]).catch(() => [null]);
      if (!acc) await sleep(800);
    }
    let vTok = null;
    if (!acc) fail("bonding curve account not found");
    else {
      const d = curve.decodeBondingCurve(acc.data);
      if (!d || !d.discriminatorOk) fail("unexpected bonding curve layout (pump.fun may have changed it)");
      else if (!(d.vSol >= 29 && d.vTok <= 1.0731e9 && d.vTok > 1e8)) fail(`reserves look wrong: ${d.vSol} SOL / ${d.vTok} tokens`);
      else {
        vTok = d.vTok;
        pass(`${d.realSol.toFixed(3)} SOL in the curve, market cap ${curve.mcapSol(d.vSol, d.vTok).toFixed(1)} SOL, graduated: ${d.complete}`);
      }
    }
    try {
      const h = summarizeHolders(await sol.getLargestHolders(conn, first.mint), { curveBalance: vTok ? curveTokenBalance(vTok) : null });
      pass(`holder check works (largest holder ${h.top1Pct}%, top 10 ${h.top10Pct}%)`);
    } catch (e) {
      fail(`holder check failed: ${e.message} (a free Helius/QuickNode RPC usually fixes this)`);
    }

    console.log("4) PumpPortal trade API (builds a transaction; nothing is signed or sent)");
    const who = fs.existsSync(cfg.walletFile) ? loadWallet(cfg.walletFile).publicKey : sol.web3.Keypair.generate().publicKey;
    try {
      const r = await tradeApiCheck(cfg, first.mint, who);
      if (r.outflow > 0.001 * 0.03 + 0.01) fail(`trade API transaction moves ${r.outflow} SOL directly; the bot would refuse it`);
      else pass(`transaction built (${r.instructions} instructions, direct SOL outflow ${r.outflow.toFixed(6)})`);
    } catch (e) {
      fail(`trade API: ${e.message}`);
    }
  }

  console.log("5) Bot wallet");
  if (fs.existsSync(cfg.walletFile)) {
    const kp = loadWallet(cfg.walletFile);
    try {
      pass(`${kp.publicKey.toBase58()} holds ${((await conn.getBalance(kp.publicKey)) / C.LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e) {
      fail(`${kp.publicKey.toBase58()}: could not read the balance (${e.message})`);
    }
  } else {
    console.log("        none yet (only needed for live trading): node pump/bot.cjs --new-wallet");
  }
  console.log(ok ? "\nAll checks passed." : "\nSome checks failed; see above.");
  process.exit(ok ? 0 : 1);
}

async function selfTest(cfg) {
  requireLive(cfg);
  const conn = sol.connection(cfg.rpcUrl);
  const broker = new LiveBroker(cfg, { conn, keypair: loadWallet(cfg.walletFile), budgetSol: cfg.maxBudgetSol });
  const before = await broker.refreshBalance();
  const amount = 0.003;
  if (before < amount + 0.01) { console.log(`need at least ${amount + 0.01} SOL in ${broker.ownerStr}`); process.exit(1); }
  console.log(`Self-test: one real buy of ${amount} SOL and an immediate sell, on a coin with some activity.`);
  const feed = makeFeed(cfg, conn);
  const seen = [];
  feed.on("create", (e) => seen.push(e));
  feed.start();
  let pick = null;
  const deadline = Date.now() + 5 * 60000;
  while (!pick && Date.now() < deadline) {
    await sleep(3000);
    const fresh = seen.filter((e) => Date.now() - e.createdAtMs < 120000);
    const accs = await sol.getAccounts(conn, fresh.map((e) => sol.bondingCurveAddress(e.mint))).catch(() => []);
    fresh.forEach((e, i) => {
      const d = accs[i] && curve.decodeBondingCurve(accs[i].data);
      if (!pick && d && d.discriminatorOk && !d.complete && d.realSol >= 3) pick = e;
    });
  }
  feed.stop();
  if (!pick) { console.log("no suitable coin found in 5 minutes; try again"); process.exit(1); }
  console.log(`buying ${amount} SOL of ${pick.symbol} ${pick.mint}`);
  const b = await broker.buy({ mint: pick.mint, sol: amount });
  console.log(b.ok ? `  bought ${b.tokens.toFixed(0)} tokens for ${b.solSpent.toFixed(6)} SOL (tx ${b.sig})` : `  buy failed: ${b.error}`);
  if (b.ok) {
    await sleep(3000);
    const s = await broker.sell({ mint: pick.mint, fraction: 1 });
    console.log(s.ok ? `  sold for ${s.solReceived.toFixed(6)} SOL incl. ${s.rentRefund.toFixed(6)} rent back (tx ${s.sig})` : `  SELL FAILED: ${s.error} -> run --sell-all`);
  }
  const after = await broker.refreshBalance();
  console.log(`Wallet ${before.toFixed(6)} -> ${after.toFixed(6)} SOL: the round trip cost ${(before - after).toFixed(6)} SOL.`);
  process.exit(b.ok ? 0 : 1);
}

async function walletInfo(cfg) {
  const conn = sol.connection(cfg.rpcUrl);
  const broker = new LiveBroker(cfg, { conn, keypair: loadWallet(cfg.walletFile) });
  const bal = await broker.refreshBalance();
  console.log(`Bot wallet: ${broker.ownerStr}\nBalance:    ${bal.toFixed(6)} SOL`);
  const h = await broker.holdings();
  const held = h.filter((x) => x.amount > 0);
  console.log(held.length ? held.map((x) => `  ${x.mint}: ${x.amount}`).join("\n") : "No coins held.");
  const empty = h.length - held.length;
  if (empty) console.log(`${empty} empty token account(s) holding rent; --sell-all reclaims it.`);
}

async function sellAll(cfg) {
  const conn = sol.connection(cfg.rpcUrl);
  const broker = new LiveBroker(cfg, { conn, keypair: loadWallet(cfg.walletFile) });
  await broker.refreshBalance();
  const held = (await broker.holdings()).filter((x) => x.amount > 0);
  for (const h of held) {
    process.stdout.write(`selling ${h.mint} ... `);
    const r = await broker.sell({ mint: h.mint, fraction: 1 });
    console.log(r.ok ? `+${r.solReceived.toFixed(6)} SOL` : `failed: ${r.error}`);
  }
  const c = await broker.closeEmptyAccounts().catch((e) => ({ closed: 0, refundSol: 0, error: e.message }));
  if (c.closed) console.log(`closed ${c.closed} empty account(s): +${c.refundSol.toFixed(6)} SOL rent`);
  console.log(`balance now ${(await broker.refreshBalance()).toFixed(6)} SOL`);
}

async function withdraw(cfg, to, yes) {
  try { sol.pk(to); } catch (_) { throw new Error(`not a valid Solana address: ${to}`); }
  const conn = sol.connection(cfg.rpcUrl);
  const broker = new LiveBroker(cfg, { conn, keypair: loadWallet(cfg.walletFile) });
  const bal = await broker.refreshBalance();
  if (!yes) {
    console.log(`This sends ${bal.toFixed(6)} SOL (minus the network fee) to ${to}. Run again with --yes to confirm.`);
    return;
  }
  console.log(`sent: ${await broker.withdrawAll(to)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const cfg = loadConfig({ paramsFile: args.params });
  if (args.newWallet) {
    const kp = createWallet(cfg.walletFile);
    console.log(`Created the bot wallet: ${kp.publicKey.toBase58()}`);
    console.log(`Key file: ${cfg.walletFile} (keep it private, never share or upload it)`);
    console.log("Fund it by sending SOL on the Solana network to the address above, only what you can afford to lose.");
    return;
  }
  if (args.check) return check(cfg);
  if (args.wallet) return walletInfo(cfg);
  if (args.sellAll) return sellAll(cfg);
  if (args.withdraw) return withdraw(cfg, args.withdraw, args.yes);
  if (args.selfTest) return selfTest(cfg);
  return run(cfg, args);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
