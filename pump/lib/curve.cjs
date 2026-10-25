"use strict";

const crypto = require("crypto");
const C = require("./constants.cjs");

// Anchor account discriminator: first 8 bytes of sha256("account:BondingCurve").
const BONDING_CURVE_DISCRIMINATOR = crypto.createHash("sha256").update("account:BondingCurve").digest().subarray(0, 8);

/**
 * Decodes a pump.fun BondingCurve account. Layout (after the 8-byte discriminator):
 * virtual_token_reserves u64, virtual_sol_reserves u64, real_token_reserves u64,
 * real_sol_reserves u64, token_total_supply u64, complete bool, ... (newer fields appended).
 * Returns whole-token / SOL numbers.
 */
function decodeBondingCurve(buf) {
  if (!buf || buf.length < 49) return null;
  const discriminatorOk = buf.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR);
  return {
    discriminatorOk,
    vTok: Number(buf.readBigUInt64LE(8)) / C.TOKEN_UNIT,
    vSol: Number(buf.readBigUInt64LE(16)) / C.LAMPORTS_PER_SOL,
    realTok: Number(buf.readBigUInt64LE(24)) / C.TOKEN_UNIT,
    realSol: Number(buf.readBigUInt64LE(32)) / C.LAMPORTS_PER_SOL,
    totalSupply: Number(buf.readBigUInt64LE(40)) / C.TOKEN_UNIT,
    complete: buf[48] === 1,
  };
}

// Inverse of decodeBondingCurve, used by tests and the synthetic market.
function encodeBondingCurve({ vTok, vSol, realTok, realSol, totalSupply = C.TOTAL_SUPPLY_TOKENS, complete = false }) {
  const buf = Buffer.alloc(81);
  BONDING_CURVE_DISCRIMINATOR.copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(Math.round(vTok * C.TOKEN_UNIT)), 8);
  buf.writeBigUInt64LE(BigInt(Math.round(vSol * C.LAMPORTS_PER_SOL)), 16);
  buf.writeBigUInt64LE(BigInt(Math.round(realTok * C.TOKEN_UNIT)), 24);
  buf.writeBigUInt64LE(BigInt(Math.round(realSol * C.LAMPORTS_PER_SOL)), 32);
  buf.writeBigUInt64LE(BigInt(Math.round(totalSupply * C.TOKEN_UNIT)), 40);
  buf[48] = complete ? 1 : 0;
  return buf;
}

const price = (vSol, vTok) => vSol / vTok; // SOL per whole token
const mcapSol = (vSol, vTok) => price(vSol, vTok) * C.TOTAL_SUPPLY_TOKENS;

// Constant-product quotes on the curve, excluding fees.
function quoteBuyTokens(vSol, vTok, solIn) {
  return vTok - (vSol * vTok) / (vSol + solIn);
}
function quoteSellSol(vSol, vTok, tokensIn) {
  return vSol - (vSol * vTok) / (vTok + tokensIn);
}

// Reserves of a standard curve after `realSol` net SOL has gone in.
function reservesFromRealSol(realSol) {
  const vSol = C.INITIAL_VIRTUAL_SOL + Math.max(0, realSol);
  return { vSol, vTok: C.CURVE_K / vSol };
}

// Every standard pump.fun coin starts at 30 virtual SOL / 1.073B virtual tokens, 1B supply.
function isStandardCurve(base, k, totalSupply) {
  return Math.abs(base - C.INITIAL_VIRTUAL_SOL) < 0.5 && Math.abs(k / C.CURVE_K - 1) < 0.02 && Math.abs(totalSupply - C.TOTAL_SUPPLY_TOKENS) < 1e6;
}

function progressFromRealSol(realSol) {
  return Math.min(1, Math.max(0, realSol / C.GRADUATION_REAL_SOL));
}

// Seller-side value of `tokens` right now, after fees: what a full exit would return.
function liquidationValueSol(vSol, vTok, tokens, feeFraction) {
  return quoteSellSol(vSol, vTok, tokens) * (1 - feeFraction);
}

module.exports = {
  BONDING_CURVE_DISCRIMINATOR,
  decodeBondingCurve,
  encodeBondingCurve,
  price,
  mcapSol,
  quoteBuyTokens,
  quoteSellSol,
  reservesFromRealSol,
  isStandardCurve,
  progressFromRealSol,
  liquidationValueSol,
};
