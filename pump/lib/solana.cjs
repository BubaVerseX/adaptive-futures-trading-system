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

const SYSTEM_PROGRAM_ID = web3.SystemProgram.programId.toBase58();

/**
 * Sums lamports that top-level System Program instructions move out of `wallet`
 * (Transfer, CreateAccount, ...). Signers are always static keys, so this works
 * without resolving address lookup tables. Used to refuse a third-party-built
 * transaction that tries to send our SOL somewhere it shouldn't.
 */
function systemOutflowLamports(vtx, wallet) {
  const msg = vtx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const me = pk(wallet).toBase58();
  let total = 0n;
  for (const ix of msg.compiledInstructions) {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM_ID) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 12) continue;
    const kind = data.readUInt32LE(0);
    const from = keys[ix.accountKeyIndexes[0]];
    if (from !== me) continue;
    // 0 CreateAccount, 2 Transfer, 11 TransferWithSeed: lamports u64 right after the index.
    if (kind === 0 || kind === 2 || kind === 11) total += data.readBigUInt64LE(4);
  }
  return Number(total);
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
  systemOutflowLamports,
  connection,
  getAccounts,
  getLargestHolders,
};
