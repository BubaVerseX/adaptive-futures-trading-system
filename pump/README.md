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
Live trades (with the real fill prices, every sale attempt and its timing) go to
`trades-live-*.jsonl`, buys that failed to `buyfails-live-*.jsonl`. The status
line's P&L counts trading only; money you send to or take from the wallet is
shown separately.
`replay.cjs` uses that data to tell you, with an honest out-of-sample test, whether
the rules actually make money. **Nothing here has been proven profitable yet.**

## Setup (once)

```bash
cd ~/adaptive-futures-trading-system
git fetch origin && git checkout pump-bot && npm install
```

Get a free Solana RPC (the public one blocks the holder check): sign up at
helius.dev, copy your mainnet RPC link, then run this and paste it when asked:

```bash
node pump/bot.cjs --set-rpc
```

If PumpPortal's coin feed is down, find new coins straight from Solana instead:
`echo 'PUMP_DISCOVERY=rpc' >> .env`
(it listens to launch transactions only and reads each launch from pump.fun's own
log events, so it costs no extra RPC calls and little websocket data).

Price checks (one call per second) go to the free public Solana RPC so they don't
use your Helius credits; Helius covers whenever the public one is busy
(`PUMP_POLL_RPC_URL=off` sends everything to Helius).

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

## Active mode

The default buy rules are deliberately picky. `--params pump/presets/active.json`
loosens the entry filters (earlier, smaller inflows, up to 5 minutes old) and lets
more of each winner ride. Same money rules. Expect more trades, more fees and more
bad coins; `replay --compare` shows whether looser rules pay on your data.

## Max mode

`--params pump/presets/max.json` is the default without the keep-floor: it never
stops buying while it has money, so it can lose the whole budget. The smallest
trade stays 0.01 SOL either way: each buy + sell costs about 0.0002 SOL in network
fees whatever the size, so a 0.001 SOL trade would lose ~25% to fees.

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
in the repo folder. Live mode also stops on the repo-wide `STOP_BOT.txt`. Other commands:

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
- The key never leaves your computer. PumpPortal only builds the transaction.
  Before signing, the bot checks it: the fee payer must be your wallet, only
  known programs (pump.fun, PumpSwap, token, system, compute budget, memo) may
  appear, nothing may reassign the wallet or approve its coins away, and a
  simulation must show the wallet losing no more than the trade plus fees.
  Anything else is refused and nothing is sent. (`--check` shows whether
  PumpPortal's transactions pass; `PUMP_EXTRA_PROGRAMS` exists only for a program
  you have checked yourself.)
- Sells that time out are never blindly repeated: anything that landed late is
  read from the chain first, and a partial sell is never re-sent (a retry is
  always a full exit), so the bot can't sell more than it holds or lose track
  of a position.
- `PUMP_MAX_BUDGET_SOL` caps what the bot may use even if the wallet holds more.
- No cap on coins held at once (the money is the limit), no pause after losing
  streaks and no daily loss limit by default (`PUMP_MAX_OPEN_POSITIONS`,
  `PUMP_LOSS_STREAK_PAUSE_MIN`, `PUMP_DAILY_LOSS_LIMIT_PCT` switch them on).
- Keep-floor (default 50%): no new buys once the account is below half of its
  best value, so a bad night can't take everything (`PUMP_KEEP_PCT=0` turns it
  off). New buys are sized so the cash left stays above that line even if every
  open coin went to zero. The best value is remembered across restarts in
  `~/.pump-bot/live-risk.json`; `--withdraw` clears it, or start once with
  `PUMP_RESET_FLOOR=1`.
- Trade size: 0.025 SOL base. Strong buying pressure (inflow well above the entry
  minimums) buys up to 2x, never more than half of the free cash
  (`PUMP_CONVICTION_MAX=1` turns that off). Profits are reinvested: the size limit
  grows with the account and shrinks back if the gains are lost (`PUMP_COMPOUND=0`
  keeps it fixed).
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
