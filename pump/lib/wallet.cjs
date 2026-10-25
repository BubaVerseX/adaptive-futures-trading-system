"use strict";

const fs = require("fs");
const path = require("path");
const { web3 } = require("./solana.cjs");
const { base58Decode } = require("./base58.cjs");

// A fresh wallet used only by the bot. It only ever holds what you send it.
function createWallet(file) {
  if (fs.existsSync(file)) throw new Error(`a wallet already exists at ${file}; refusing to overwrite it`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const kp = web3.Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: "wx" });
  return kp;
}

// Accepts the Solana CLI format ([12,34,...]) or a base58 private key string.
function loadWallet(file) {
  if (!fs.existsSync(file)) throw new Error(`no wallet at ${file}. Create one with: node pump/bot.cjs --new-wallet`);
  const raw = fs.readFileSync(file, "utf8").trim();
  const secret = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : base58Decode(raw);
  if (secret.length !== 64) throw new Error("wallet file must contain a 64-byte secret key");
  const mode = fs.statSync(file).mode & 0o077;
  if (mode !== 0 && process.platform !== "win32") fs.chmodSync(file, 0o600);
  return web3.Keypair.fromSecretKey(secret);
}

module.exports = { createWallet, loadWallet, base58Decode };
