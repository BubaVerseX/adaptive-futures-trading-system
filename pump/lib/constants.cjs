"use strict";

// pump.fun bonding-curve constants. Every coin starts from the same virtual
// reserves, so the curve state at any moment is fully determined by how much
// real SOL has gone in (k = virtualSol * virtualTokens stays constant; trading
// fees are paid outside the reserves).
const LAMPORTS_PER_SOL = 1e9;
const TOKEN_DECIMALS = 6;
const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;
const TOTAL_SUPPLY_TOKENS = 1_000_000_000;
const INITIAL_VIRTUAL_SOL = 30;
const INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
const INITIAL_REAL_TOKENS = 793_100_000;
const CURVE_K = INITIAL_VIRTUAL_SOL * INITIAL_VIRTUAL_TOKENS;
// Real SOL in the curve when all INITIAL_REAL_TOKENS are sold (graduation), ~85 SOL.
const GRADUATION_REAL_SOL = CURVE_K / (INITIAL_VIRTUAL_TOKENS - INITIAL_REAL_TOKENS) - INITIAL_VIRTUAL_SOL;

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"; // where coins trade after graduating
const PUMP_FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM_IDS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// Rent for a 165-byte SPL token account. Paid when the bot first buys a coin,
// refunded when the bot closes the empty account after selling.
const TOKEN_ACCOUNT_RENT_SOL = 0.00203928;
const BASE_FEE_SOL = 0.000005;

const PUMPPORTAL_WS_URL = "wss://pumpportal.fun/api/data";
const PUMPPORTAL_TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";
const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

module.exports = {
  LAMPORTS_PER_SOL,
  TOKEN_DECIMALS,
  TOKEN_UNIT,
  TOTAL_SUPPLY_TOKENS,
  INITIAL_VIRTUAL_SOL,
  INITIAL_VIRTUAL_TOKENS,
  INITIAL_REAL_TOKENS,
  CURVE_K,
  GRADUATION_REAL_SOL,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MEMO_PROGRAM_IDS,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_ACCOUNT_RENT_SOL,
  BASE_FEE_SOL,
  PUMPPORTAL_WS_URL,
  PUMPPORTAL_TRADE_LOCAL_URL,
  DEFAULT_RPC_URL,
};
