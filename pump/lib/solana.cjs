"use strict";

const web3 = require("@solana/web3.js");
const C = require("./constants.cjs");

const PUMP_PROGRAM = new web3.PublicKey(C.PUMP_PROGRAM_ID);
const ATA_PROGRAM = new web3.PublicKey(C.ASSOCIATED_TOKEN_PROGRAM_ID);

const pk = (x) => (x instanceof web3.PublicKey ? x : new web3.PublicKey(x));

function bondingCurveAddress(mint) {
  return web3.PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), pk(mint).toBuffer()], PUMP_PROGRAM)[0].toBase58();
}

function ataAddress(owner, mint, tokenProgram = C.TOKEN_PROGRAM_ID) {
  return web3.PublicKey.findProgramAddressSync(
    [pk(owner).toBuffer(), pk(tokenProgram).toBuffer(), pk(mint).toBuffer()],
    ATA_PROGRAM
  )[0].toBase58();
}

const derive = { bondingCurve: bondingCurveAddress, ata: ataAddress };

// SPL Token / Token-2022 CloseAccount (instruction 9): refunds the account's rent to `destination`.
function closeAccountInstruction(account, destination, owner, tokenProgram) {
  return new web3.TransactionInstruction({
    programId: pk(tokenProgram),
    keys: [
      { pubkey: pk(account), isSigner: false, isWritable: true },
      { pubkey: pk(destination), isSigner: false, isWritable: true },
      { pubkey: pk(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

const BASE_ALLOWED_PROGRAMS = [
  C.COMPUTE_BUDGET_PROGRAM_ID,
  C.SYSTEM_PROGRAM_ID,
  C.ASSOCIATED_TOKEN_PROGRAM_ID,
  C.TOKEN_PROGRAM_ID,
  C.TOKEN_2022_PROGRAM_ID,
  C.PUMP_PROGRAM_ID,
  C.PUMPSWAP_PROGRAM_ID,
  C.PUMP_FEE_PROGRAM_ID,
  ...C.MEMO_PROGRAM_IDS,
];
const TOKEN_PROGRAMS = new Set([C.TOKEN_PROGRAM_ID, C.TOKEN_2022_PROGRAM_ID]);
// SPL Token: Transfer 3, Approve 4, SetAuthority 6, TransferChecked 12, ApproveChecked 13.
const TOKEN_GIVEAWAY = new Set([3, 4, 6, 12, 13]);

/**
 * Static look at a third-party-built transaction before signing it. Only top-level
 * instructions are visible here (anything a program does internally is caught by the
 * simulation check instead). Signers are always static keys, so no lookup tables needed.
 *   outflowSol       SOL that System transfers / account creations take from the wallet
 *   unknownPrograms  programs outside the pump.fun / token / system set
 *   risky            anything else that touches the wallet (assign, seeds, token approvals...)
 */
function inspectTransaction(vtx, wallet, extraAllowed = []) {
  const allowed = new Set([...BASE_ALLOWED_PROGRAMS, ...extraAllowed]);
  const keys = vtx.message.staticAccountKeys.map((k) => k.toBase58());
  const me = pk(wallet).toBase58();
  const unknown = new Set();
  const harmless = new Set();
  const risky = [];
  let outflow = 0n;
  for (const ix of vtx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    const data = Buffer.from(ix.data);
    const accounts = ix.accountKeyIndexes.map((i) => keys[i]);
    // A program can only move the wallet's SOL or coins if the wallet (and so its
    // signature) is passed to it. Unknown programs that never see the wallet can't.
    if (!allowed.has(program)) (accounts.includes(me) ? unknown : harmless).add(program);
    if (!accounts.includes(me)) continue;
    if (program === C.SYSTEM_PROGRAM_ID) {
      const kind = data.length >= 4 ? data.readUInt32LE(0) : -1;
      if (kind === 2 && accounts[0] !== me) continue; // incoming transfer
      if ((kind === 0 || kind === 2) && accounts[0] === me && data.length >= 12) outflow += data.readBigUInt64LE(4);
      else risky.push(`system instruction #${kind} on the wallet`);
    } else if (TOKEN_PROGRAMS.has(program) && data.length >= 1) {
      if (TOKEN_GIVEAWAY.has(data[0])) risky.push(`token instruction #${data[0]} signed by the wallet`);
      else if (data[0] === 9 && accounts[1] !== me) risky.push("closes a token account into someone else's wallet");
    }
  }
  return { outflowSol: Number(outflow) / C.LAMPORTS_PER_SOL, unknownPrograms: [...unknown], harmlessPrograms: [...harmless].filter((p) => !unknown.has(p)), risky };
}

/**
 * Simulates the transaction and reports how much SOL the wallet would lose and who
 * would own it afterwards. Catches drains hidden inside program calls.
 */
async function simulateWalletChange(conn, vtx, wallet) {
  const addr = pk(wallet).toBase58();
  const [pre, sim] = await Promise.all([
    conn.getBalance(pk(wallet), "processed"),
    conn.simulateTransaction(vtx, { sigVerify: false, commitment: "processed", accounts: { encoding: "base64", addresses: [addr] } }),
  ]);
  const v = sim.value;
  if (v.err) return { ok: false, simErr: JSON.stringify(v.err), logs: (v.logs || []).slice(-4) };
  const acc = v.accounts && v.accounts[0];
  if (!acc) return { ok: true, lossSol: pre / C.LAMPORTS_PER_SOL, owner: null }; // wallet would be emptied/closed
  return { ok: true, lossSol: (pre - acc.lamports) / C.LAMPORTS_PER_SOL, owner: acc.owner };
}

function connection(rpcUrl) {
  return new web3.Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: false });
}

// Batched getMultipleAccountsInfo: keys -> [{ data: Buffer, owner: string } | null].
async function getAccounts(conn, keys, { batch = 100, commitment = "processed" } = {}) {
  const out = new Array(keys.length).fill(null);
  for (let i = 0; i < keys.length; i += batch) {
    const slice = keys.slice(i, i + batch);
    const infos = await conn.getMultipleAccountsInfo(slice.map(pk), commitment);
    infos.forEach((info, j) => {
      out[i + j] = info ? { data: info.data, owner: info.owner.toBase58() } : null;
    });
  }
  return out;
}

async function getLargestHolders(conn, mint) {
  const res = await conn.getTokenLargestAccounts(pk(mint), "confirmed");
  return res.value.map((r) => ({ address: r.address.toBase58(), uiAmount: r.uiAmount === null ? Number(r.amount) / C.TOKEN_UNIT : r.uiAmount }));
}

module.exports = {
  web3,
  pk,
  derive,
  bondingCurveAddress,
  ataAddress,
  closeAccountInstruction,
  inspectTransaction,
  simulateWalletChange,
  connection,
  getAccounts,
  getLargestHolders,
};
