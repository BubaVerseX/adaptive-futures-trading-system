"use strict";

const C = require("./constants.cjs");
const sol = require("./solana.cjs");
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
 * it is checked, signed on this machine and sent through your own RPC. The private
 * key never leaves the computer.
 */
class LiveBroker {
  constructor(cfg, { conn, keypair, budgetSol = null, fetchImpl = globalThis.fetch, sleepFn = sleep }) {
    this.mode = "live";
    this.c = cfg.costs;
    this.conn = conn;
    this.kp = keypair;
    this.owner = keypair.publicKey;
    this.ownerStr = this.owner.toBase58();
    this.fetch = fetchImpl;
    this.sleep = sleepFn;
    this.budgetSol = budgetSol;
    this.balanceSol = 0;
    this.startBalanceSol = null;
    this.committed = 0;
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

  async tradeLocal(body, maxDirectOutflowSol) {
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
    const outflow = sol.systemOutflowLamports(tx, this.owner) / C.LAMPORTS_PER_SOL;
    if (outflow > maxDirectOutflowSol) {
      throw new Error(`refused transaction: sends ${outflow.toFixed(6)} SOL directly out of the wallet (limit ${maxDirectOutflowSol})`);
    }
    tx.sign([this.kp]);
    return this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  }

  async confirm(sig, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { value } = await this.conn.getSignatureStatuses([sig]);
        const st = value && value[0];
        if (st && st.err) return { ok: false, error: `on-chain error ${JSON.stringify(st.err)}` };
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { ok: true };
      } catch (_) {
        // transient RPC error: keep polling until the timeout
      }
      await this.sleep(600);
    }
    return { ok: false, error: "not confirmed in time", timeout: true };
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
      // The coin's SOL moves through the pump.fun program; only fees should be direct transfers.
      let sig;
      try {
        sig = await this.tradeLocal(body, amountSol * 0.03 + 0.01);
      } catch (e) {
        return { ok: false, error: e.message, feesSol: 0 };
      }
      const conf = await this.confirm(sig);
      if (!conf.ok) {
        // Timed out is not the same as failed: check whether the coins arrived anyway.
        const held = await this.tokenBalance(mint).catch(() => 0);
        if (held > 0) {
          return { ok: true, tokens: held, solSpent: amountSol + this.c.priorityFeeSol + C.TOKEN_ACCOUNT_RENT_SOL, estimated: true, sig };
        }
        return { ok: false, error: conf.error, sig, feesSol: conf.timeout ? 0 : this.c.priorityFeeSol + C.BASE_FEE_SOL };
      }
      const tx = await this.getTx(sig);
      if (!tx) {
        const held = await this.tokenBalance(mint).catch(() => 0);
        return { ok: held > 0, tokens: held, solSpent: amountSol + this.c.priorityFeeSol + C.TOKEN_ACCOUNT_RENT_SOL, estimated: true, sig, error: held > 0 ? null : "no tokens received" };
      }
      return { ok: true, tokens: tokenDelta(tx, this.ownerStr, mint), solSpent: -payerDeltaSol(tx), sig };
    } finally {
      this.committed -= amountSol;
      await this.refreshBalance().catch(() => {});
    }
  }

  // estimateSol: fallback proceeds if the transaction can't be read back.
  async sell({ mint, fraction, estimateSol = 0 }) {
    const full = fraction >= 0.999;
    const amount = full ? "100%" : `${Math.min(99, Math.max(1, Math.round(fraction * 100)))}%`;
    const slips = [this.c.sellSlippagePct, Math.min(50, this.c.sellSlippagePct * 1.6), Math.min(70, this.c.sellSlippagePct * 2.4)];
    let received = 0, tokensSold = 0, sig = null, done = false, lastErr = null;
    for (const slippage of slips) {
      try {
        sig = await this.tradeLocal(
          { publicKey: this.ownerStr, action: "sell", mint, amount, denominatedInSol: "false", slippage, priorityFee: this.c.priorityFeeSol, pool: "auto" },
          0.015
        );
        const conf = await this.confirm(sig);
        if (conf.ok) {
          const tx = await this.getTx(sig);
          received = tx ? payerDeltaSol(tx) : estimateSol;
          tokensSold = tx ? -tokenDelta(tx, this.ownerStr, mint) : 0;
          done = true;
          break;
        }
        lastErr = conf.error;
        if (conf.timeout && full && (await this.tokenBalance(mint).catch(() => null)) === 0) {
          received = estimateSol;
          done = true;
          break;
        }
      } catch (e) {
        lastErr = e.message;
      }
      await this.sleep(400);
    }
    if (!done) return { ok: false, error: lastErr, feesSol: 0 };

    let rentRefund = 0;
    if (full) {
      const left = await this.tokenBalance(mint).catch(() => 0);
      if (left > 0) {
        try {
          const s2 = await this.tradeLocal(
            { publicKey: this.ownerStr, action: "sell", mint, amount: "100%", denominatedInSol: "false", slippage: 60, priorityFee: this.c.priorityFeeSol, pool: "auto" },
            0.015
          );
          if ((await this.confirm(s2)).ok) {
            const tx2 = await this.getTx(s2);
            if (tx2) { received += payerDeltaSol(tx2); tokensSold += -tokenDelta(tx2, this.ownerStr, mint); }
          }
        } catch (_) {
          // dust stays; the account just can't be closed this time
        }
      }
      const closed = await this.closeEmptyAccounts(mint).catch(() => ({ refundSol: 0 }));
      rentRefund = closed.refundSol || 0;
    }
    await this.refreshBalance().catch(() => {});
    return { ok: true, solReceived: received + rentRefund, tokensSold, rentRefund, closed: full, sig };
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

  // Empty token accounts hold ~0.002 SOL of rent each; closing them gives it back.
  async closeEmptyAccounts(mint = null) {
    const filters = mint
      ? [{ mint: sol.pk(mint) }]
      : [{ programId: sol.pk(C.TOKEN_PROGRAM_ID) }, { programId: sol.pk(C.TOKEN_2022_PROGRAM_ID) }];
    const empties = [];
    for (const f of filters) {
      const res = await this.conn.getParsedTokenAccountsByOwner(this.owner, f, "confirmed");
      for (const v of res.value) if (v.account.data.parsed.info.tokenAmount.amount === "0") empties.push(v);
    }
    if (!empties.length) return { closed: 0, refundSol: 0 };
    let refundSol = 0;
    for (let i = 0; i < empties.length; i += 10) {
      const tx = new web3.Transaction();
      for (const v of empties.slice(i, i + 10)) tx.add(sol.closeAccountInstruction(v.pubkey, this.owner, this.owner, v.account.owner));
      const sig = await this.sendLegacy(tx);
      const t = await this.getTx(sig);
      refundSol += t ? payerDeltaSol(t) : Math.min(10, empties.length - i) * C.TOKEN_ACCOUNT_RENT_SOL;
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

  async withdrawAll(to) {
    await this.refreshBalance();
    const lamports = Math.floor(this.balanceSol * C.LAMPORTS_PER_SOL) - 5000;
    if (lamports <= 0) throw new Error("nothing to withdraw");
    const tx = new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: this.owner, toPubkey: sol.pk(to), lamports }));
    return this.sendLegacy(tx);
  }
}

module.exports = { LiveBroker, payerDeltaSol, tokenDelta };
