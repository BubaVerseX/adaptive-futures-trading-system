"use strict";

const C = require("./constants.cjs");
const sol = require("./solana.cjs");
const { base58Encode } = require("./base58.cjs");
const { walletFill } = require("./feed.cjs");
const { web3 } = sol;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const payerDeltaSol = (tx) => (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / C.LAMPORTS_PER_SOL;

function tokenAmountFor(balances, owner, mint) {
  let total = 0;
  for (const b of balances || []) {
    if (b.owner === owner && b.mint === mint) total += Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;
  }
  return total;
}

const tokenDelta = (tx, owner, mint) => tokenAmountFor(tx.meta.postTokenBalances, owner, mint) - tokenAmountFor(tx.meta.preTokenBalances, owner, mint);

/**
 * Real orders. PumpPortal's Local Transaction API builds the pump.fun transaction;
 * the bot inspects and simulates it, signs it on this machine and sends it through
 * your own RPC. The private key never leaves the computer.
 *
 * Sells are the dangerous part: a transaction that "timed out" can still land a
 * minute later. So every sell attempt's signature is kept per coin, anything that
 * landed is booked from the chain before doing more, and a partial sell is never
 * re-sent (a retry is always a full exit, which can't oversell).
 */
class LiveBroker {
  // rebroadcastConn: a second endpoint the same signed bytes are re-sent through while a
  // transaction is unconfirmed (never the main RPC: its rate-limit retries would stall sends).
  constructor(cfg, { conn, keypair, budgetSol = null, fetchImpl = globalThis.fetch, sleepFn = sleep, confirmMs = 30000, extraPrograms = [], rebroadcastConn = null }) {
    this.mode = "live";
    this.c = cfg.costs;
    this.conn = conn;
    this.kp = keypair;
    this.owner = keypair.publicKey;
    this.ownerStr = this.owner.toBase58();
    this.fetch = fetchImpl;
    this.sleep = sleepFn;
    this.confirmMs = confirmMs;
    this.extraPrograms = extraPrograms;
    this.rebroadcast = rebroadcastConn;
    this.budgetSol = budgetSol;
    this.balanceSol = 0;
    this.startBalanceSol = null;
    this.committed = 0;
    this.flowSol = 0; // net SOL this run's own transactions moved (deposits/withdrawals are not in it)
    this.sellSigs = new Map(); // mint -> [{ sig, booked }]
  }

  txFeeSol() {
    return this.c.priorityFeeSol + C.BASE_FEE_SOL;
  }

  async refreshBalance() {
    this.balanceSol = (await this.conn.getBalance(this.owner, "confirmed")) / C.LAMPORTS_PER_SOL;
    if (this.startBalanceSol === null) this.startBalanceSol = this.balanceSol;
    return this.balanceSol;
  }

  // The bot never puts more than the budget at risk, even if the wallet holds more.
  // Profits made inside the budget can be reused, losses shrink it; money sent to the
  // wallet during a run is not profit and doesn't raise it.
  availableSol() {
    const cap = this.budgetSol ? this.budgetSol + this.flowSol : this.balanceSol;
    return Math.max(0, Math.min(this.balanceSol, cap) - this.committed);
  }

  // Deposits (+) or withdrawals (-) made by hand since the bot started.
  externalSol() {
    return this.startBalanceSol === null ? 0 : this.balanceSol - this.startBalanceSol - this.flowSol;
  }

  // A buy that "failed" but landed later and was adopted: its cost left the wallet.
  noteLateFill(costSol) {
    this.flowSol -= costSol;
  }

  async fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await this.fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gets one transaction from PumpPortal, checks it, signs and sends it.
   * Throws (nothing sent) if it is refused or would fail; otherwise returns
   * { sig, sendError } — the signature is computed locally, so even a send that
   * errored can still be looked up later.
   *   maxLossSol: the most SOL the wallet may lose to this transaction
   *   strict: refuse unknown programs even when the simulation looks fine (buys)
   */
  async tradeLocal(body, { maxLossSol, strict, expectCoinsOf = null }) {
    const t0 = Date.now();
    const res = await this.fetchWithTimeout(
      C.PUMPPORTAL_TRADE_LOCAL_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      10000
    );
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(`PumpPortal ${res.status}: ${text.slice(0, 200)}`);
    }
    const tx = web3.VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    const builtMs = Date.now() - t0;
    if (!tx.message.staticAccountKeys[0].equals(this.owner)) throw new Error("refused transaction: fee payer is not this wallet");
    const ins = sol.inspectTransaction(tx, this.owner, this.extraPrograms);
    const odd = [...ins.risky, ...ins.unknownPrograms.map((p) => `unknown program ${p}`)];
    if (ins.outflowSol > maxLossSol) throw new Error(`refused transaction: sends ${ins.outflowSol.toFixed(6)} SOL straight out (limit ${maxLossSol.toFixed(6)})`);
    if (strict && odd.length) throw new Error(`refused transaction: ${odd.join("; ")} (allow a program with PUMP_EXTRA_PROGRAMS only after checking it)`);

    // A buy must put the coins in this wallet's own token account (either token program).
    const tokenAccounts = expectCoinsOf ? [C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID].map((p) => sol.ataAddress(this.owner, expectCoinsOf, p)) : [];
    let sim;
    try {
      sim = await sol.simulateWalletChange(this.conn, tx, this.owner, tokenAccounts);
    } catch (e) {
      sim = { ok: false, error: e.message };
    }
    if (sim.simErr) throw new Error(`would fail on-chain: ${sim.simErr}`);
    if (sim.ok) {
      if (sim.owner !== C.SYSTEM_PROGRAM_ID) throw new Error("refused transaction: it would take over or close the wallet");
      if (sim.lossSol > maxLossSol) throw new Error(`refused transaction: wallet would lose ${sim.lossSol.toFixed(6)} SOL (limit ${maxLossSol.toFixed(6)})`);
      if (expectCoinsOf && !(sim.tokensGained > 0)) throw new Error("refused transaction: the simulation shows no coins arriving in this wallet");
    } else if (strict || odd.length || expectCoinsOf) {
      throw new Error(`refused transaction: could not simulate it (${sim.error})`);
    }

    const simMs = Date.now() - t0 - builtMs;
    tx.sign([this.kp]);
    const sig = base58Encode(tx.signatures[0]);
    const raw = tx.serialize();
    let sendError = null;
    try {
      await this.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    } catch (e) {
      sendError = e.message;
    }
    return { sig, sendError, raw, builtMs, simMs, sentAtMs: Date.now() };
  }

  // Polls the status every 300ms. While waiting, the same signed bytes are re-sent through
  // the rebroadcast endpoint every 2s (at once if the first send errored); identical bytes
  // can only ever execute once.
  async confirm(sig, timeoutMs = this.confirmMs, raw = null, sendErrored = false) {
    const start = Date.now();
    let lastPush = sendErrored ? 0 : start;
    for (;;) {
      if (raw && this.rebroadcast && Date.now() - lastPush >= 2000) {
        lastPush = Date.now();
        Promise.resolve()
          .then(() => this.rebroadcast.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }))
          .catch(() => {});
      }
      try {
        const { value } = await this.conn.getSignatureStatuses([sig]);
        const st = value && value[0];
        if (st && st.err) return { ok: false, onChainError: true, error: `failed on-chain: ${JSON.stringify(st.err)}` };
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { ok: true };
      } catch (_) {
        // transient RPC error: keep polling until the timeout
      }
      if (Date.now() - start >= timeoutMs) return { ok: false, timeout: true, error: "not confirmed in time" };
      await this.sleep(300);
    }
  }

  async getTx(sig) {
    for (let i = 0; i < 6; i++) {
      const tx = await this.conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      if (tx && tx.meta) return tx;
      await this.sleep(700);
    }
    return null;
  }

  // Coins of `mint` in this wallet, read from its token accounts by address (the
  // token-owner index can lag behind for seconds right after a trade).
  async tokenBalance(mint) {
    const accounts = await this.tokenAccountsOf(mint);
    return accounts.reduce((a, x) => a + Number(x.amount), 0) / C.TOKEN_UNIT;
  }

  // Right after a sale some RPC nodes still show the old balance for a moment; wait for 0.
  async balanceAfterExit(mint) {
    let left = null;
    for (let i = 0; i < 5; i++) {
      left = await this.tokenBalance(mint).catch(() => null);
      if (left === 0) return 0;
      await this.sleep(800);
    }
    return left;
  }

  async buy({ mint, sol: amountSol }) {
    // Hold the worst case (price moved up to the slippage limit, plus rent and fees) until
    // the balance shows what the buy really cost.
    const hold = amountSol * (1 + this.c.buySlippagePct / 100) + C.TOKEN_ACCOUNT_RENT_SOL + this.txFeeSol();
    this.committed += hold;
    let res = null, postSol = null;
    try {
      res = await this.buyOnce(mint, amountSol, (sol) => { postSol = sol; });
      return res;
    } finally {
      const before = this.balanceSol;
      const fresh = await this.refreshBalance().then(() => true, () => false);
      // A node that hasn't applied the buy yet shows the old balance: never trust more than the tx left.
      if (postSol !== null) this.balanceSol = Math.min(this.balanceSol, postSol);
      else if (!fresh && res && res.ok) this.balanceSol = before - res.solSpent;
      if (res) this.flowSol -= res.ok ? res.solSpent : res.feesSol || 0;
      this.committed -= hold;
    }
  }

  async buyOnce(mint, amountSol, notePost) {
    const body = {
      publicKey: this.ownerStr,
      action: "buy",
      mint,
      amount: Number(amountSol.toFixed(9)),
      denominatedInSol: "true",
      slippage: this.c.buySlippagePct,
      priorityFee: this.c.priorityFeeSol,
      pool: "pump",
    };
    let sent;
    try {
      // Cost + pump.fun/PumpPortal fees + token-account rent + priority fee, with room to spare.
      sent = await this.tradeLocal(body, { maxLossSol: amountSol * 1.03 + 0.006, strict: true, expectCoinsOf: mint });
    } catch (e) {
      return { ok: false, error: e.message, feesSol: 0 };
    }
    const conf = await this.confirm(sent.sig, sent.sendError ? Math.min(12000, this.confirmMs) : this.confirmMs, sent.raw, !!sent.sendError);
    if (!conf.ok) {
      // Timed out is not the same as failed: check whether the coins arrived anyway.
      const held = await this.tokenBalance(mint).catch(() => 0);
      if (held > 0) {
        return { ok: true, tokens: held, solSpent: this.estimateBuyCost(amountSol), estimated: true, sig: sent.sig };
      }
      const error = sent.sendError && !conf.onChainError ? `send failed: ${sent.sendError}` : conf.error;
      return { ok: false, error, sig: sent.sig, feesSol: conf.onChainError ? this.txFeeSol() : 0, final: !!conf.onChainError };
    }
    const tx = await this.getTx(sent.sig);
    if (!tx) {
      const held = await this.tokenBalance(mint).catch(() => 0);
      if (held > 0) return { ok: true, tokens: held, solSpent: this.estimateBuyCost(amountSol), estimated: true, sig: sent.sig };
      return { ok: false, error: "confirmed but no coins received", sig: sent.sig, feesSol: this.txFeeSol() };
    }
    notePost(tx.meta.postBalances[0] / C.LAMPORTS_PER_SOL);
    const solSpent = -payerDeltaSol(tx);
    const fill = walletFill(tx.meta.logMessages, mint, this.ownerStr, true);
    return {
      ok: true, tokens: tokenDelta(tx, this.ownerStr, mint), solSpent, sig: sent.sig, slot: tx.slot,
      fillPrice: fill && fill.fillPrice, avgPrice: fill && fill.avgPrice, realSolAfter: fill && fill.realSolAfter, fillSource: fill && fill.fillPrice ? "event" : "mark",
      // What the price move cost on top of the order (PumpPortal fixes the coins, not the SOL).
      premiumPct: ((solSpent - C.TOKEN_ACCOUNT_RENT_SOL - this.txFeeSol()) / (amountSol * (1 + (this.c.pumpFeePct + this.c.portalFeePct) / 100)) - 1) * 100,
      timing: { buildMs: sent.builtMs, simMs: sent.simMs, landMs: Date.now() - sent.sentAtMs },
    };
  }

  estimateBuyCost(amountSol) {
    return amountSol * (1 + (this.c.pumpFeePct + this.c.portalFeePct) / 100) + C.TOKEN_ACCOUNT_RENT_SOL + this.txFeeSol();
  }

  // Books every earlier sell attempt for `mint` that has landed: SOL received, coins sold.
  async bookLanded(mint) {
    const list = this.sellSigs.get(mint) || [];
    const open = list.filter((x) => !x.booked);
    const out = { any: false, sol: 0, tokens: 0, unreadable: 0 };
    if (!open.length) return out;
    const { value } = await this.conn.getSignatureStatuses(open.map((x) => x.sig), { searchTransactionHistory: true });
    for (let i = 0; i < open.length; i++) {
      const st = value && value[i];
      if (!st) continue;
      if (st.err) { open[i].booked = true; continue; } // failed on-chain: nothing moved
      if (st.confirmationStatus !== "confirmed" && st.confirmationStatus !== "finalized") continue;
      if (open[i].covered) { open[i].booked = true; continue; } // already counted in an estimate
      const tx = await this.getTx(open[i].sig);
      if (!tx) { out.unreadable++; continue; }
      out.sol += payerDeltaSol(tx);
      out.tokens += -tokenDelta(tx, this.ownerStr, mint);
      const fill = walletFill(tx.meta.logMessages, mint, this.ownerStr, false);
      if (fill && fill.fillPrice) out.fillPrice = fill.fillPrice;
      out.any = true;
      open[i].booked = true;
    }
    return out;
  }

  /**
   * estimateSol: what the requested fraction is worth now; used only when coins left
   * the wallet through a transaction that can't be read back yet.
   * Returns { ok, solReceived, tokensSold, closed, rentRefund, feesSol, estimated }.
   * `closed` is the truth from the chain (wallet holds none of this coin).
   */
  async sell({ mint, fraction, estimateSol = 0 }) {
    if (!this.sellSigs.has(mint)) this.sellSigs.set(mint, []);
    const list = this.sellSigs.get(mint);
    let received = 0, sold = 0, feesSol = 0, acted = false, estimated = false, lastErr = null, lastSig = null, fillPrice = null;
    const attempts = [];

    // 1. Something from an earlier attempt landed after we stopped waiting: book it, don't sell again.
    const early = await this.bookLanded(mint).catch(() => ({ any: false }));
    if (early.any) { received += early.sol; sold += early.tokens; acted = true; }
    let startTokens = await this.tokenBalance(mint).catch(() => null);
    if (startTokens === 0 && !acted) {
      // No coins: a node that hasn't applied our buy yet, or an earlier attempt of ours that
      // sold them and can't be read back yet. Look again before concluding anything.
      await this.sleep(800);
      const again = await this.bookLanded(mint).catch(() => ({ any: false }));
      if (again.any) { received += again.sol; sold += again.tokens; acted = true; }
      startTokens = await this.tokenBalance(mint).catch(() => null);
      if (startTokens === 0 && !acted) {
        const pending = list.filter((x) => !x.booked);
        if (!pending.length) return { ok: false, goneWithoutSale: true, error: "no coins in the wallet and no sale of ours found", feesSol };
        received += estimateSol / Math.max(fraction, 1e-9); // the whole remaining position's value
        estimated = true;
        for (const x of pending) x.covered = true;
        acted = true;
      }
    }
    // Attempts that might still land make any partial sell unsafe: exit fully instead.
    let full = fraction >= 0.999 || list.some((x) => !x.booked);
    if (startTokens === 0) acted = true;

    // 2. Sell. A partial escalates its slippage step by step; a full exit is an exit, so it
    // takes a wide bound at once (the minimum is fixed when PumpPortal builds the transaction,
    // so it only costs anything if the price falls during the transaction's own flight).
    const s = this.c.sellSlippagePct;
    const partialSlips = [s, Math.min(50, s * 1.6), Math.min(70, s * 2.4)];
    const fullSlips = [Math.min(70, s * 2.4), 70, 70];
    const firstNew = list.length;
    for (let i = 0; !acted && i < partialSlips.length; i++) {
      const amount = full ? "100%" : `${Math.min(99, Math.max(1, Math.round(fraction * 100)))}%`;
      let sent;
      try {
        sent = await this.tradeLocal(
          { publicKey: this.ownerStr, action: "sell", mint, amount, denominatedInSol: "false", slippage: (full ? fullSlips : partialSlips)[i], priorityFee: this.c.priorityFeeSol, pool: "auto" },
          { maxLossSol: 0.006, strict: false }
        );
      } catch (e) {
        lastErr = e.message; // refused or would fail: nothing was sent
        attempts.push({ amount, outcome: "refused", error: String(e.message).slice(0, 120) });
        await this.sleep(400);
        continue;
      }
      const attempt = { amount, slip: (full ? fullSlips : partialSlips)[i], buildMs: sent.builtMs, simMs: sent.simMs, sig: sent.sig };
      attempts.push(attempt);
      const entry = { sig: sent.sig, booked: false };
      list.push(entry);
      // A full exit doesn't wait 30s on one attempt: after 10s the next one is built (the
      // unconfirmed one stays on the list and is booked if it lands after all).
      const limit = full && i < 2 ? Math.min(10000, this.confirmMs) : this.confirmMs;
      const conf = await this.confirm(sent.sig, sent.sendError ? Math.min(12000, limit) : limit, sent.raw, !!sent.sendError);
      attempt.outcome = conf.ok ? "landed" : conf.onChainError ? "onchain-fail" : "timeout";
      attempt.waitMs = Date.now() - sent.sentAtMs;
      if (conf.onChainError) {
        feesSol += this.txFeeSol();
        entry.booked = true; // failed on-chain: nothing moved
        lastErr = conf.error;
        if (!list.some((x) => !x.booked)) continue; // nothing else in flight: try again at once
      }
      const b = await this.bookLanded(mint).catch(() => ({ any: false }));
      if (b.any) { received += b.sol; sold += b.tokens; acted = true; lastSig = sent.sig; fillPrice = b.fillPrice || null; break; }
      lastErr = sent.sendError && !conf.onChainError ? `send failed: ${sent.sendError}` : conf.error;
      // Coins left the wallet through an attempt we can't read yet: count it, estimated.
      const left = await this.tokenBalance(mint).catch(() => null);
      if (left !== null && startTokens !== null && left < startTokens * 0.999) {
        const gone = startTokens - left;
        received += estimateSol * (gone / Math.max(1e-12, startTokens * fraction));
        sold += gone;
        acted = true;
        estimated = true;
        // The estimate stands for whichever of this call's attempts landed: never book them again.
        for (const x of list.slice(firstNew)) if (!x.booked) x.covered = true;
        break;
      }
      // A definite on-chain failure moved nothing, so a partial may stay partial; an attempt
      // whose outcome is unknown could still land, so only a full exit is safe after it.
      full = full || list.some((x) => !x.booked);
      await this.sleep(400);
    }
    if (!acted) {
      this.flowSol -= feesSol;
      return { ok: false, error: lastErr, feesSol, attempts };
    }

    // 3. Tidy up: after a full exit sweep any dust, then close the empty account for its rent.
    let left = full ? await this.balanceAfterExit(mint) : await this.tokenBalance(mint).catch(() => null);
    if (full && left > 0) {
      try {
        const sent = await this.tradeLocal(
          { publicKey: this.ownerStr, action: "sell", mint, amount: "100%", denominatedInSol: "false", slippage: 60, priorityFee: this.c.priorityFeeSol, pool: "auto" },
          { maxLossSol: 0.006, strict: false }
        );
        list.push({ sig: sent.sig, booked: false });
        if ((await this.confirm(sent.sig)).ok) {
          const b = await this.bookLanded(mint).catch(() => ({ any: false }));
          if (b.any) { received += b.sol; sold += b.tokens; }
        }
      } catch (_) {
        // dust stays; the next exit attempt or --sell-all picks it up
      }
      left = await this.balanceAfterExit(mint);
    }
    let rentRefund = 0, closeError = null;
    let closed = left === 0;
    if (closed) {
      // Two tries: the account can still look non-empty to the RPC for a moment.
      for (let i = 0; i < 2 && !rentRefund; i++) {
        if (i) await this.sleep(1500);
        const c = await this.closeEmptyAccounts(mint).catch((e) => ({ refundSol: 0, error: e.message }));
        rentRefund = c.refundSol || 0;
        closeError = rentRefund || c.gone ? null : c.error || "account not empty yet";
        if (c.gone) {
          // The sale closed the account itself; its rent came back with the sale (which an
          // estimate of an unreadable sale doesn't include yet).
          if (estimated) rentRefund = C.TOKEN_ACCOUNT_RENT_SOL;
          break;
        }
        if (c.nonEmpty && i === 1) {
          closed = false; // coins are still there: the position stays open and gets finished
          closeError = null;
        }
      }
      if (closed) this.sellSigs.delete(mint); // nothing left that a late attempt could sell
    }
    await this.refreshBalance().catch(() => {});
    this.flowSol += received + rentRefund - feesSol;
    return { ok: true, solReceived: received + rentRefund, tokensSold: sold, rentRefund, closed, feesSol, estimated, sig: lastSig, closeError, fillPrice, attempts };
  }

  async sendLegacy(tx) {
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.owner;
    tx.sign(this.kp);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const conf = await this.confirm(sig);
    if (!conf.ok) throw new Error(conf.error);
    return sig;
  }

  // This wallet's token accounts for one coin, read by address (no token-index lag).
  async tokenAccountsOf(mint) {
    const atas = [C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID].map((programId) => ({ programId, address: sol.ataAddress(this.owner, mint, programId) }));
    const infos = await this.conn.getMultipleAccountsInfo(atas.map((a) => sol.pk(a.address)), "confirmed");
    return atas.flatMap((a, i) => (infos[i] && infos[i].data && infos[i].data.length >= 72 ? [{ ...a, amount: infos[i].data.readBigUInt64LE(64) }] : []));
  }

  // Empty token accounts hold ~0.002 SOL of rent each; closing them gives it back.
  // For one coin, { gone: true } means it has no account left (a sale already closed it).
  async closeEmptyAccounts(mint = null) {
    let empties = [];
    if (mint) {
      const accounts = await this.tokenAccountsOf(mint);
      if (!accounts.length) return { closed: 0, refundSol: 0, gone: true };
      if (accounts.some((a) => a.amount > 0n)) return { closed: 0, refundSol: 0, nonEmpty: true };
      empties = accounts.filter((a) => a.amount === 0n);
    } else {
      for (const programId of [C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID]) {
        const res = await this.conn.getParsedTokenAccountsByOwner(this.owner, { programId: sol.pk(programId) }, "confirmed");
        for (const v of res.value) if (v.account.data.parsed.info.tokenAmount.amount === "0") empties.push({ address: v.pubkey, programId: v.account.owner });
      }
    }
    if (!empties.length) return { closed: 0, refundSol: 0 };
    let refundSol = 0;
    for (let i = 0; i < empties.length; i += 10) {
      const batch = empties.slice(i, i + 10);
      const tx = new web3.Transaction();
      for (const v of batch) tx.add(sol.closeAccountInstruction(v.address, this.owner, this.owner, v.programId));
      const sig = await this.sendLegacy(tx);
      const t = await this.getTx(sig);
      refundSol += t ? payerDeltaSol(t) : batch.length * C.TOKEN_ACCOUNT_RENT_SOL - C.BASE_FEE_SOL;
    }
    return { closed: empties.length, refundSol };
  }

  async holdings() {
    const out = [];
    for (const programId of [C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID]) {
      const res = await this.conn.getParsedTokenAccountsByOwner(this.owner, { programId: sol.pk(programId) }, "confirmed");
      for (const v of res.value) {
        const info = v.account.data.parsed.info;
        out.push({ account: v.pubkey.toBase58(), mint: info.mint, amount: Number(info.tokenAmount.uiAmount || 0) });
      }
    }
    return out;
  }

  // Sends the exact lamport balance minus the fee, so nothing below the rent minimum is left behind.
  async withdrawAll(to) {
    const lamports = (await this.conn.getBalance(this.owner, "confirmed")) - 5000;
    if (lamports <= 0) throw new Error("nothing to withdraw");
    const tx = new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: this.owner, toPubkey: sol.pk(to), lamports }));
    return this.sendLegacy(tx);
  }
}

module.exports = { LiveBroker, payerDeltaSol, tokenDelta };
