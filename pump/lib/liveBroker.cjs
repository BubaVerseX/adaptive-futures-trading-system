"use strict";

const C = require("./constants.cjs");
const sol = require("./solana.cjs");
const { base58Encode } = require("./base58.cjs");
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
  constructor(cfg, { conn, keypair, budgetSol = null, fetchImpl = globalThis.fetch, sleepFn = sleep, confirmMs = 30000, extraPrograms = [] }) {
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
    this.budgetSol = budgetSol;
    this.balanceSol = 0;
    this.startBalanceSol = null;
    this.committed = 0;
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
  // Profits made inside the budget can be reused; losses shrink it.
  availableSol() {
    const start = this.startBalanceSol === null ? this.balanceSol : this.startBalanceSol;
    const cap = this.budgetSol ? this.budgetSol + (this.balanceSol - start) : this.balanceSol;
    return Math.max(0, Math.min(this.balanceSol, cap) - this.committed);
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

    tx.sign([this.kp]);
    const sig = base58Encode(tx.signatures[0]);
    let sendError = null;
    try {
      await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    } catch (e) {
      sendError = e.message;
    }
    return { sig, sendError };
  }

  async confirm(sig, timeoutMs = this.confirmMs) {
    const start = Date.now();
    for (;;) {
      try {
        const { value } = await this.conn.getSignatureStatuses([sig]);
        const st = value && value[0];
        if (st && st.err) return { ok: false, onChainError: true, error: `failed on-chain: ${JSON.stringify(st.err)}` };
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { ok: true };
      } catch (_) {
        // transient RPC error: keep polling until the timeout
      }
      if (Date.now() - start >= timeoutMs) return { ok: false, timeout: true, error: "not confirmed in time" };
      await this.sleep(600);
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

  async tokenBalance(mint) {
    const res = await this.conn.getParsedTokenAccountsByOwner(this.owner, { mint: sol.pk(mint) }, "confirmed");
    return res.value.reduce((a, v) => a + Number(v.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
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
    this.committed += amountSol;
    try {
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
      const conf = await this.confirm(sent.sig, sent.sendError ? Math.min(12000, this.confirmMs) : this.confirmMs);
      if (!conf.ok) {
        // Timed out is not the same as failed: check whether the coins arrived anyway.
        const held = await this.tokenBalance(mint).catch(() => 0);
        if (held > 0) {
          return { ok: true, tokens: held, solSpent: this.estimateBuyCost(amountSol), estimated: true, sig: sent.sig };
        }
        const error = sent.sendError && !conf.onChainError ? `send failed: ${sent.sendError}` : conf.error;
        return { ok: false, error, sig: sent.sig, feesSol: conf.onChainError ? this.txFeeSol() : 0 };
      }
      const tx = await this.getTx(sent.sig);
      if (!tx) {
        const held = await this.tokenBalance(mint).catch(() => 0);
        if (held > 0) return { ok: true, tokens: held, solSpent: this.estimateBuyCost(amountSol), estimated: true, sig: sent.sig };
        return { ok: false, error: "confirmed but no coins received", sig: sent.sig, feesSol: this.txFeeSol() };
      }
      return { ok: true, tokens: tokenDelta(tx, this.ownerStr, mint), solSpent: -payerDeltaSol(tx), sig: sent.sig };
    } finally {
      this.committed -= amountSol;
      await this.refreshBalance().catch(() => {});
    }
  }

  estimateBuyCost(amountSol) {
    return amountSol * (1 + (this.c.pumpFeePct + this.c.portalFeePct) / 100) + C.TOKEN_ACCOUNT_RENT_SOL + this.txFeeSol();
  }

  // Books every earlier sell attempt for `mint` that has landed: SOL received, coins sold.
  async bookLanded(mint) {
    const list = this.sellSigs.get(mint) || [];
    const open = list.filter((x) => !x.booked);
    const out = { any: false, sol: 0, tokens: 0 };
    if (!open.length) return out;
    const { value } = await this.conn.getSignatureStatuses(open.map((x) => x.sig), { searchTransactionHistory: true });
    for (let i = 0; i < open.length; i++) {
      const st = value && value[i];
      if (!st) continue;
      if (st.err) { open[i].booked = true; continue; } // failed on-chain: nothing moved
      if (st.confirmationStatus !== "confirmed" && st.confirmationStatus !== "finalized") continue;
      const tx = await this.getTx(open[i].sig);
      if (!tx) continue;
      out.sol += payerDeltaSol(tx);
      out.tokens += -tokenDelta(tx, this.ownerStr, mint);
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
    let received = 0, sold = 0, feesSol = 0, acted = false, estimated = false, lastErr = null, lastSig = null;

    // 1. Something from an earlier attempt landed after we stopped waiting: book it, don't sell again.
    const early = await this.bookLanded(mint).catch(() => ({ any: false }));
    if (early.any) { received += early.sol; sold += early.tokens; acted = true; }
    const startTokens = await this.tokenBalance(mint).catch(() => null);
    // Attempts that might still land make any partial sell unsafe: exit fully instead.
    let full = fraction >= 0.999 || list.some((x) => !x.booked);
    if (startTokens === 0) acted = true;

    // 2. Sell, escalating slippage. A partial is attempted at most once.
    const slips = [this.c.sellSlippagePct, Math.min(50, this.c.sellSlippagePct * 1.6), Math.min(70, this.c.sellSlippagePct * 2.4)];
    for (let i = 0; !acted && i < slips.length; i++) {
      const amount = full ? "100%" : `${Math.min(99, Math.max(1, Math.round(fraction * 100)))}%`;
      let sent;
      try {
        sent = await this.tradeLocal(
          { publicKey: this.ownerStr, action: "sell", mint, amount, denominatedInSol: "false", slippage: slips[i], priorityFee: this.c.priorityFeeSol, pool: "auto" },
          { maxLossSol: 0.006, strict: false }
        );
      } catch (e) {
        lastErr = e.message; // refused or would fail: nothing was sent
        await this.sleep(400);
        continue;
      }
      list.push({ sig: sent.sig, booked: false });
      const conf = await this.confirm(sent.sig, sent.sendError ? Math.min(12000, this.confirmMs) : this.confirmMs);
      if (conf.onChainError) feesSol += this.txFeeSol();
      const b = await this.bookLanded(mint).catch(() => ({ any: false }));
      if (b.any) { received += b.sol; sold += b.tokens; acted = true; lastSig = sent.sig; break; }
      lastErr = sent.sendError && !conf.onChainError ? `send failed: ${sent.sendError}` : conf.error;
      // Coins left the wallet through an attempt we can't read yet: count it, estimated.
      const left = await this.tokenBalance(mint).catch(() => null);
      if (left !== null && startTokens !== null && left < startTokens * 0.999) {
        const gone = startTokens - left;
        received += estimateSol * (gone / Math.max(1e-12, startTokens * fraction));
        sold += gone;
        acted = true;
        estimated = true;
        break;
      }
      full = true;
      await this.sleep(400);
    }
    if (!acted) return { ok: false, error: lastErr, feesSol };

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
    const closed = left === 0;
    if (closed) {
      // Two tries: the account can still look non-empty to the RPC for a moment.
      for (let i = 0; i < 2 && !rentRefund; i++) {
        if (i) await this.sleep(1500);
        const c = await this.closeEmptyAccounts(mint).catch((e) => ({ refundSol: 0, error: e.message }));
        rentRefund = c.refundSol || 0;
        closeError = rentRefund || c.gone ? null : c.error || "account not empty yet";
        if (c.gone) break; // the sale closed it itself; its rent came back with the sale
      }
      this.sellSigs.delete(mint); // nothing left that a late attempt could sell
    }
    await this.refreshBalance().catch(() => {});
    return { ok: true, solReceived: received + rentRefund, tokensSold: sold, rentRefund, closed, feesSol, estimated, sig: lastSig, closeError };
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
