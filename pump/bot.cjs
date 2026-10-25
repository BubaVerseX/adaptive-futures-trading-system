#!/usr/bin/env node
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { loadConfig, REPO_ROOT } = require("./lib/config.cjs");
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

// web3.js prints a line for every rate-limited RPC retry; count them for the status line instead.
let rpcRetries = 0;
const consoleError = console.error.bind(console);
console.error = (...a) => {
  if (typeof a[0] === "string" && a[0].startsWith("Server responded with 429")) { rpcRetries++; return; }
  consoleError(...a);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);
const signed = (x, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);

function log(level, msg) {
  const mark = level === "warn" ? "!" : level === "trade" ? ">" : " ";
  console.log(`[${ts()}] ${mark} ${msg}`);
}

const HELP = `pump.fun momentum bot

  node pump/bot.cjs                 paper trading with fake SOL on live data (default)
  node pump/bot.cjs --set-rpc       paste your Helius (or other) RPC link; it is tested and saved to .env
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
    else if (k === "--set-rpc") {
      a.setRpc = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) a.rpcUrl = argv[++i];
    }
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
  return cfg.discovery === "rpc" ? new RpcLogsFeed({ conn, derive: sol.derive }) : new PumpPortalFeed({ url: cfg.wsUrl, apiKey: cfg.pumpPortalApiKey });
}

function status(engine, broker, risk, tracker, price, startEquity, feed, poller) {
  const cash = broker.mode === "paper" ? broker.cash : broker.balanceSol;
  const equity = cash + engine.openValueSol();
  const pnl = equity - startEquity;
  const gate = risk.halted ? " | DAILY LOSS LIMIT HIT: no buys until 00:00 UTC"
    : risk.belowFloor() ? ` | KEEP-FLOOR HIT: no new buys, ${risk.r.keepPct}% of the best balance is kept`
    : Date.now() < risk.pausedUntil ? " | paused after a losing streak" : "";
  log(
    "info",
    `${broker.mode.toUpperCase()} | equity ${equity.toFixed(4)} SOL${price.fmt(equity)} | P&L ${signed(pnl)} SOL${price.fmt(pnl)} | open ${engine.positions.size} | ` +
      `trades ${risk.trades} (W${risk.wins}/L${risk.losses}) | watching ${tracker.tokens.size} of ${tracker.stats.seen} coins seen` +
      `${tracker.stats.nonStandard ? ` (${tracker.stats.nonStandard} odd-curve skipped)` : ""}` +
      `${rpcRetries ? ` | RPC busy, ${rpcRetries} retries` : ""}${feed && feed.missed ? ` | feed missed ${feed.missed}` : ""}` +
      `${poller && poller.resting() ? " | public RPC busy: price checks on your RPC for now" : ""}${gate}`
  );
  rpcRetries = 0;
}

async function run(cfg, args) {
  const live = !!args.live;
  if (live) requireLive(cfg);
  const conn = sol.connection(cfg.rpcUrl);
  const poller = new sol.AccountPoller({ main: conn, free: cfg.pollRpcUrl ? sol.connection(cfg.pollRpcUrl, { retryOnRateLimit: false }) : null });
  const rpc = { getAccounts: (keys) => poller.getAccounts(keys), getLargestHolders: (mint) => sol.getLargestHolders(conn, mint) };
  const tracker = new Tracker(cfg, sol.derive);
  const price = new SolPrice(cfg.solUsdOverride);
  await price.refresh();
  price.start();

  let broker, startSol, startEquity;
  if (live) {
    broker = new LiveBroker(cfg, { conn, keypair: loadWallet(cfg.walletFile), budgetSol: cfg.maxBudgetSol, extraPrograms: cfg.extraPrograms });
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
  log("info", `daily loss limit ${cfg.risk.dailyLossLimitPct}% (${((startSol * cfg.risk.dailyLossLimitPct) / 100).toFixed(4)} SOL)` +
    `${cfg.risk.keepPct ? ` | keeps at least ${cfg.risk.keepPct}% of the best balance` : ""}${cfg.risk.compound ? " | trade size grows with profits" : ""} | research log: ${cfg.dataDir}`);

  const risk = new RiskManager(cfg.risk, startSol);
  const recorder = new Recorder(cfg.dataDir, cfg.runtime);
  const engine = new Engine({ cfg, tracker, broker, risk, recorder, rpc, log });
  const feed = makeFeed(cfg, conn);
  feed.on("create", (e) => engine.onCreate(e));
  feed.on("status", (s) => log("info", `[feed] ${s}`));
  feed.on("slot", (s) => poller.seen(s));
  feed.start();
  if (cfg.pollRpcUrl) log("info", `price checks every ${cfg.runtime.pollMs / 1000}s via ${cfg.pollRpcUrl} (free); your RPC only when that one is busy`);

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
  // Live honours the repo-wide kill switch (STOP_BOT.txt) as well as its own, at every tick.
  const watchStopFiles = live ? cfg.stopFiles : [cfg.stopFiles[0]];
  let lastStatus = 0, lastBalance = Date.now(), stopAt = 0, haltedLogged = false;
  for (;;) {
    const now = Date.now();
    if (!stop && now >= endAt) stop = `${args.minutes} minutes are up`;
    if (!stop) {
      const hit = watchStopFiles.find((f) => fs.existsSync(f));
      if (hit) stop = `${path.basename(hit)} found`;
    }
    if (stop && !engine.stopping) {
      engine.stopping = true;
      stopAt = now;
      log("info", `stopping (${stop}): no new buys, closing ${engine.positions.size} open position(s)... press Ctrl+C again to quit at once`);
    }
    // Wait for open positions and for any buy that might still land after a timeout.
    if (engine.stopping && !engine.busy()) break;
    if (engine.stopping && now - stopAt > 180000) {
      log("warn", "positions still open after 3 minutes; quitting. Check with --wallet and sell with --sell-all");
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
      status(engine, broker, risk, tracker, price, startEquity, feed, poller);
      lastStatus = now;
    }
    await sleep(Math.max(50, cfg.runtime.pollMs - (Date.now() - now)));
  }
  feed.stop();
  price.stop();
  await engine.settle();
  if (live) await broker.refreshBalance().catch(() => {});
  status(engine, broker, risk, tracker, price, startEquity, feed, poller);
  const net = engine.closedTrades.reduce((a, t) => a + t.netSol, 0);
  console.log(`\nSession: ${engine.closedTrades.length} trades, ${risk.wins} wins / ${risk.losses} losses, net ${signed(net)} SOL${price.fmt(net)}`);
  console.log(`Trades log + research data: ${cfg.dataDir}   |   measure the strategy: node pump/replay.cjs`);
  process.exit(0);
}

async function tradeApiCheck(cfg, mint, publicKey, conn) {
  const res = await fetch(C.PUMPPORTAL_TRADE_LOCAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: publicKey.toBase58(), action: "buy", mint, amount: 0.001, denominatedInSol: "true", slippage: 20, priorityFee: cfg.costs.priorityFeeSol, pool: "pump" }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const tx = sol.web3.VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  if (!tx.message.staticAccountKeys[0].equals(publicKey)) throw new Error("fee payer is not the requested wallet");
  const ins = sol.inspectTransaction(tx, publicKey, cfg.extraPrograms);
  let sim = null;
  const tokenAccounts = [C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID].map((p) => sol.ataAddress(publicKey, mint, p));
  try { sim = await sol.simulateWalletChange(conn, tx, publicKey, tokenAccounts); } catch (e) { sim = { error: e.message }; }
  return { tx, ins, sim, instructions: tx.message.compiledInstructions.length };
}

// Prints what the chain says about a program the bot doesn't know.
async function reportUnknownProgram(conn, r, id, labels) {
  console.log(`        --- about ${id} ---`);
  try {
    const e = await sol.explainProgram(conn, id);
    console.log(`        program: ${e.executable ? "yes" : "NO (not a program?)"}, upgrade authority: ${e.upgradeAuthority || "?"}`);
    console.log(`        recent use: ${e.recentTx} transactions${e.spanSec !== null ? ` in the last ${e.spanSec}s` : ""}; of ${e.sampled} sampled, ${e.withPump} are pump.fun trades by ${e.distinctPayers} different wallets`);
  } catch (err) {
    console.log(`        could not look it up: ${err.message}`);
  }
  for (const ix of sol.instructionAccounts(r.tx, id)) {
    console.log(`        in this buy it gets ${ix.accounts.length} accounts (${ix.dataLen} bytes of data):`);
    for (const a of ix.accounts) console.log(`          ${a.address}${labels[a.address] ? ` = ${labels[a.address]}` : ""}${a.signer ? " [signer]" : ""}${a.writable ? " [writable]" : ""}`);
  }
  if (r.sim && r.sim.ok) {
    const lines = r.sim.logs.filter((l) => !/consumed|return:/.test(l)).slice(0, 24);
    if (lines.length) console.log(`        simulation log:\n${lines.map((l) => `          ${l}`).join("\n")}`);
  }
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
  if (cfg.pollRpcUrl) {
    try {
      const r = await sol.getAccountsAt(sol.connection(cfg.pollRpcUrl, { retryOnRateLimit: false }), [C.PUMP_PROGRAM_ID]);
      pass(`price checks go to ${cfg.pollRpcUrl} (free, slot ${r.slot}), saving your RPC's credits`);
    } catch (e) {
      console.log(`        ${cfg.pollRpcUrl} not reachable (${e.message}): price checks will use your RPC's credits`);
    }
  }

  console.log(`2) New-coin feed (${cfg.discovery})`);
  const feed = makeFeed(cfg, conn);
  const coins = await new Promise((resolve) => {
    const got = [];
    const timer = setTimeout(() => resolve(got), 45000);
    feed.on("status", (s) => console.log(`        ${s}`));
    feed.on("create", (e) => {
      got.push(e);
      if (got.length >= 3) { clearTimeout(timer); resolve(got); }
    });
    feed.start();
  });
  feed.stop();
  if (!coins.length) fail("no new coin within 45s (try PUMP_DISCOVERY=rpc or set PUMPPORTAL_API_KEY)");
  else pass(`${coins.length} new coin(s) seen`);
  if (feed.launches) {
    const slow = feed.launches - feed.fromLogs;
    if (!slow) pass(`all ${feed.launches} launches read straight from the pump.fun logs (no extra RPC calls)`);
    else console.log(`        ${slow} of ${feed.launches} launches needed a slower transaction lookup`);
  }

  let first = null, firstVTok = null;
  if (coins.length) {
    console.log("3) Reading their bonding curves on-chain");
    await sleep(1500);
    for (const c of coins) {
      const derived = sol.bondingCurveAddress(c.mint);
      if (c.bondingCurve && c.bondingCurve !== derived) fail(`curve address mismatch for ${c.mint}: feed ${c.bondingCurve}, derived ${derived}`);
      let accs = [null, null];
      for (let i = 0; i < 10 && !accs[0]; i++) {
        accs = await sol.getAccounts(conn, [derived, c.mint]).catch(() => [null, null]);
        if (!accs[0]) await sleep(800);
      }
      const [acc, mintAcc] = accs;
      const d = acc && curve.decodeBondingCurve(acc.data);
      if (!d || !d.discriminatorOk) { fail(`${c.mint}: bonding curve ${acc ? "has an unexpected layout" : "not found"}`); continue; }
      const base = d.vSol - d.realSol;
      const std = curve.isStandardCurve(base, d.vSol * d.vTok, d.totalSupply);
      const decimals = mintAcc && mintAcc.data.length > 44 ? mintAcc.data[44] : "?";
      const program = mintAcc ? (mintAcc.owner === C.TOKEN_2022_PROGRAM_ID ? "Token-2022" : mintAcc.owner === C.TOKEN_PROGRAM_ID ? "Token" : mintAcc.owner) : "?";
      pass(`${c.mint.slice(0, 8)}… ${std ? "standard curve" : "NON-STANDARD curve (the bot skips these)"}: ` +
        `${d.realSol.toFixed(3)} SOL in, virtual ${d.vSol.toFixed(3)} SOL / ${(d.vTok / 1e6).toFixed(2)}M tokens, supply ${(d.totalSupply / 1e6).toFixed(0)}M, ${decimals} decimals, ${program}`);
      if (!first && std) { first = c; firstVTok = d.vTok; }
    }
    if (!first) {
      console.log("        none of these coins use the standard curve; checking the rest with the first one anyway");
      first = coins[0];
    }
    try {
      const h = summarizeHolders(await sol.getLargestHolders(conn, first.mint), {
        curveAtas: [C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID].map((p) => sol.ataAddress(sol.bondingCurveAddress(first.mint), first.mint, p)),
        curveBalance: firstVTok ? curveTokenBalance(firstVTok) : null,
      });
      pass(`holder check works (largest holder ${h.top1Pct}%, top 10 ${h.top10Pct}%)`);
    } catch (e) {
      fail(`holder check failed: ${String(e.message).slice(0, 120)} (the free public RPC blocks this; use a free Helius RPC)`);
    }

    console.log("4) PumpPortal trade API (builds a transaction; nothing is signed or sent)");
    const who = fs.existsSync(cfg.walletFile) ? loadWallet(cfg.walletFile).publicKey : sol.web3.Keypair.generate().publicKey;
    try {
      const r = await tradeApiCheck(cfg, first.mint, who, conn);
      const labels = {
        [who.toBase58()]: "your bot wallet",
        [first.mint]: "the coin",
        [sol.bondingCurveAddress(first.mint)]: "the coin's bonding curve",
        [C.SYSTEM_PROGRAM_ID]: "System Program",
        [C.TOKEN_PROGRAM_ID]: "Token Program",
        [C.TOKEN_2022_PROGRAM_ID]: "Token-2022 Program",
        [C.PUMP_PROGRAM_ID]: "pump.fun program",
      };
      for (const p of [C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID]) labels[sol.ataAddress(who, first.mint, p)] = "your token account for the coin";
      for (const id of r.ins.unknownPrograms) await reportUnknownProgram(conn, r, id, labels);
      const odd = [...r.ins.risky, ...r.ins.unknownPrograms.map((p) => `unknown program ${p} is given the wallet's signature`)];
      if (r.ins.outflowSol > 0.001 * 1.03 + 0.006) fail(`the transaction sends ${r.ins.outflowSol} SOL straight out; the bot would refuse it`);
      else if (odd.length) fail(`the bot would refuse buys: ${odd.join("; ")}. Tell Claude; a program is only added after checking it`);
      else pass(`transaction built and inspected (${r.instructions} instructions)`);
      for (const p of r.ins.harmlessPrograms) console.log(`        note: also calls ${p}, which never gets the wallet, so it can't move your SOL or coins`);
      if (r.sim && r.sim.ok) {
        if (r.sim.tokensGained > 0) pass(`simulated: the wallet would spend ${r.sim.lossSol.toFixed(6)} SOL for a 0.001 SOL buy and receive ${r.sim.tokensGained.toFixed(0)} coins (first buys also open accounts; that rent comes back on sell)`);
        else fail(`simulated: ${r.sim.lossSol.toFixed(6)} SOL spent but no coins arrive; the bot would refuse this`);
      }
      else console.log(`        simulation skipped (${r.sim && (r.sim.simErr || r.sim.error)}); normal before the wallet is funded`);
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
  const broker = new LiveBroker(cfg, { conn, keypair: loadWallet(cfg.walletFile), budgetSol: cfg.maxBudgetSol, extraPrograms: cfg.extraPrograms });
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
      const standard = d && curve.isStandardCurve(d.vSol - d.realSol, d.vSol * d.vTok, d.totalSupply);
      if (!pick && d && d.discriminatorOk && standard && !d.complete && d.realSol >= 3) pick = e;
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
    if (!s.ok) console.log(`  SELL FAILED: ${s.error} -> run --sell-all`);
    else {
      console.log(`  sold ${s.tokensSold.toFixed(0)} tokens for ${(s.solReceived - s.rentRefund).toFixed(6)} SOL (tx ${s.sig || "an earlier attempt"})`);
      console.log(s.rentRefund ? `  closed the token account: ${s.rentRefund.toFixed(6)} SOL deposit back` : `  token account not closed yet (${s.closeError || "coins left"}); run --sell-all to get the deposit back`);
    }
  }
  const after = await broker.refreshBalance();
  console.log(`Wallet ${before.toFixed(6)} -> ${after.toFixed(6)} SOL: the round trip cost ${(before - after).toFixed(6)} SOL` +
    " (the very first trade also pays a one-time pump.fun account setup).");
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
  const broker = new LiveBroker(cfg, { conn, keypair: loadWallet(cfg.walletFile), extraPrograms: cfg.extraPrograms });
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

// Asks for the RPC link at a prompt (no shell quoting to get wrong), tests it, saves it to .env.
async function setRpc(url) {
  if (!url) {
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
    url = await new Promise((r) => rl.question("Paste your RPC link (from helius.dev) and press Enter: ", (x) => { rl.close(); r(x.trim()); }));
  }
  if (!/^https:\/\/\S+$/.test(url) || /PASTE|YOUR|abc123/i.test(url)) {
    throw new Error("that is not a real RPC link: it should start with https:// and end with your own api-key");
  }
  const slot = await sol.connection(url).getSlot();
  const envFile = path.join(REPO_ROOT, ".env");
  const keep = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("SOLANA_RPC_URL=")) : [];
  fs.writeFileSync(envFile, [...keep, `SOLANA_RPC_URL=${url}`].join("\n") + "\n", { mode: 0o600 });
  console.log(`Works (slot ${slot}). Saved to ${envFile}. Now run: node pump/bot.cjs --check`);
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
  if (args.setRpc) return setRpc(args.rpcUrl);
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
