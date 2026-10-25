# pump.fun momentum bot

Watches every new pump.fun coin, follows it on-chain for its first minutes, and
buys only coins that show **confirmed momentum**: real SOL flowing in fast, a few
dozen seconds after launch, no dev selling, no concentrated holders. It is not a
first-second sniper. It sells on a stop-loss, a take-profit (half), a trailing
stop, a time stop, a dev sell, heavy outflow, or right before graduation.

The same engine runs three ways:

| Mode | Money | What it is for |
|---|---|---|
| `paper` (default) | fake | real live coins, simulated fills with real fees and ~1.2s delay |
| `live` | real | same decisions, real orders, signed on your Mac |
| `replay` | none | re-runs the strategy on recorded coins; measures and tunes it |

Every run records each coin that showed any life to `data/pump/research-*.jsonl`.
`replay.cjs` uses that data to tell you, with an honest out-of-sample test, whether
the rules actually make money. **Nothing here has been proven profitable yet.**

## Setup (once)

```bash
cd ~/adaptive-futures-trading-system
git fetch origin && git checkout pump-bot && npm install
```

Get a free Solana RPC (the public one is slow and rate-limited): sign up at
helius.dev, copy your mainnet RPC URL, and add it to `.env` in this folder:

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

Then test everything (spends nothing):

```bash
node pump/bot.cjs --check
```

## 1. Paper trading (start here)

```bash
node pump/bot.cjs
```

Leave it running for a few hours. Stop with Ctrl+C. It prints trades as they
happen and a status line every 15 seconds.

## 2. Measure

```bash
node pump/replay.cjs              # how the rules did on everything recorded
node pump/replay.cjs --sweep      # search settings on the first half, judge on the second
```

The verdict checks the same bar as `EDGE_EVIDENCE_TEMPLATE.md`: 100+ trades,
profit factor above 1.3, profitable in both halves, still profitable at 1.5x fees.
`--sweep` writes `data/pump/best-params.json`; run the bot with
`--params data/pump/best-params.json` to use it.

## 3. Live, with a small fixed budget

```bash
node pump/bot.cjs --new-wallet    # the bot's own wallet; prints its address
```

Send it about 0.1 SOL (~$10) on the **Solana** network, for example by withdrawing
SOL from Bybit to that address. Then add to `.env`:

```
PUMP_LIVE_ACK=I_ACCEPT_LOSING_THIS_MONEY
PUMP_MAX_BUDGET_SOL=0.1
```

```bash
node pump/bot.cjs --self-test     # one tiny real buy + sell (~0.003 SOL) to prove the pipeline
node pump/bot.cjs --live
```

Stop: Ctrl+C (it sells open positions first), or create a file `STOP_PUMP.txt`
in this folder. Other commands:

```bash
node pump/bot.cjs --wallet                       # balance and coins held
node pump/bot.cjs --sell-all                     # sell everything, reclaim account rent
node pump/bot.cjs --withdraw <your address> --yes   # send all SOL back to you
```

## Costs per trade (why most small trades lose)

At 0.03 SOL per trade: pump.fun fee 1.25% + PumpPortal fee 0.5%, on both the buy
and the sell, plus three priority fees (buy, sell, close account) of 0.0001 SOL.
That is about **4.5% of the position per round trip**, so a trade has to gain
more than ~4.5% just to break even. Token-account rent (~0.002 SOL) is paid on
each buy and refunded when the bot closes the account after selling.

## Safety

- The bot uses its own wallet (`~/.pump-bot/wallet.json`, never inside the repo).
  It only ever holds what you send it. Never put your main wallet's key here.
- The key never leaves your computer. PumpPortal only builds the transaction;
  the bot checks that the fee payer is your wallet and that no SOL is sent out
  directly beyond fees, then signs and sends it through your own RPC.
- `PUMP_MAX_BUDGET_SOL` caps what the bot may use even if the wallet holds more.
- Daily loss limit (default 40% of the budget): no new buys until 00:00 UTC.
- After 3 losses in a row it pauses 10 minutes.
- Only dependencies: `@solana/web3.js`, `ws`, `dotenv`. No downloaded "bot" code.
  Free pump.fun bots from GitHub or Telegram are a known way wallets get emptied.

## Settings

Any default can be changed in `.env` with a `PUMP_` prefix in UPPER_SNAKE_CASE,
for example `PUMP_MIN_REAL_SOL=8`, `PUMP_MAX_TRADE_SOL=0.02`,
`PUMP_STOP_LOSS_PCT=12`, `PUMP_PRIORITY_FEE_SOL=0.0002`. All defaults and what
they mean are in `pump/lib/config.cjs`. Paper mode starts with
`PAPER_START_SOL=0.1`.

If the PumpPortal feed stops working (they may require an API key), set
`PUMPPORTAL_API_KEY=...` or switch to reading new coins straight from Solana
with `PUMP_DISCOVERY=rpc`.

## Tests

```bash
node test/pump.test.cjs
```
