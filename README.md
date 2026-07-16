# Pionex — a retail trading-edge search, with a negative result

This repo is a real-money experiment: could a small (~$60) account trade
Bybit USDT perpetual futures profitably, using retail-accessible signals
(price-action technicals, funding rate, multi-timeframe confluence, pairs
trading), after real fees and real execution? It was tested thoroughly,
honestly, and the answer is **no** — not "not yet," a checked no.

**As of 2026-07-16, live trading is stood down.** Every live-capable script
now refuses to place a real order unless it can prove a strategy actually
cleared a written evidence bar first (see below). This isn't a bug fix in
progress — it's the project's conclusion, on the record.

## The result, in numbers

Full detail, evidence, and the complete decision log are in
[`TRADING_STATUS.md`](./TRADING_STATUS.md). Headline numbers from the final
live session (2026-07-13 → 2026-07-16):

| | |
|---|---|
| Starting capital | $61.84 |
| Final equity | $54.68 |
| Total realized PnL | −$7.16 |
| Total fees paid | $6.32 |
| Gross PnL before fees | −$0.84 |

The loss is almost entirely fees, not bad calls — the underlying price-based
result was close to flat. That pattern held up across every check run
against this project:

1. **Real order history** (2026-06-07 → 2026-07-06): 287 round-trip trades,
   net −$5.65 after fees.
2. **39-symbol backtest**, split-half robustness check, 2 years of daily
   candles: 0 of 39 symbols showed edge that held in both halves.
   Buy-and-hold beat the average strategy result by ~26 points.
3. **Monte Carlo simulation**: raising risk-per-trade doesn't fix a
   flat-expectancy system — it just widens how badly a losing run can go.
4. **An independent parallel investigation** (a separate instance, 9
   strategies backtested independently) reached the same conclusion.

That's a legitimate, valuable finding on its own — a well-instrumented
negative result is worth having, not something to hide or keep re-testing
against.

## What's in this repo

- **`src/`** — the original, much larger adaptive-scalping engine
  (`src/bot.js` and friends). Iterated through many versions (V4 → V11) of
  increasingly elaborate signal scoring, regime detection, and adaptive
  memory, all in pursuit of the same edge. Still runnable in dry-run/testnet
  for reference; gated for real money like everything else here (see below).
- **`scripts/`** — a second, more surgical generation of standalone
  backtests and live pilots (`v27`–`v33`, daily/intraday trend, funding
  rate, pairs trading). This is where the final research (items 1–3 above)
  actually happened. `backtestBroadTrend.cjs` and `simulateAggressive.cjs`
  are the scripts behind that evidence — re-runnable any time.
- **`backtester.py` / `strategy.py`** — a small, independent Python
  backtesting tool (RSI+Bollinger mean-reversion with a fee-aware edge
  gate). Pulls public Bybit candles only, places no orders. Kept as working
  research infrastructure.
- **`TRADING_STATUS.md`** — the full history: every session, every
  risk-parameter decision and why, the final session report. Read this for
  the real story.
- **`EDGE_EVIDENCE_TEMPLATE.md`** — what a strategy has to prove, in
  writing, before it's allowed to trade real money again.

## If you want to test a new idea

The pipeline from here is: **backtest → check it holds on a second,
non-overlapping window → confirm it beats buy-and-hold over the same
period → stress-test it against 1.5x expected fees.** If it survives all
four, write up the result as `EDGE_EVIDENCE.md` (copy
`EDGE_EVIDENCE_TEMPLATE.md`) and only then consider live money.

Every live-capable script — the standalone pilots in `scripts/` and the
main bot via `src/config.js` — checks for two things before placing a real
order:

```env
DRY_RUN=false
I_HAVE_A_BACKTESTED_EDGE=true
```

...**and** a real `EDGE_EVIDENCE.md` file in the repo root. Missing either
one aborts startup before any order can be placed. This isn't a suggestion
to route around — if you're tempted to set the flag without the evidence
file actually being true, that defeats the entire point of this repo.

## Safety basics (still apply to everything here)

- `DRY_RUN=true` (the default) never submits real orders.
- `touch STOP_BOT.txt` in the repo root is the shared kill switch — every
  live script checks for it on startup and mid-loop, and exits if present.
  It's currently present.
- Real credentials go in `.env` (gitignored, never commit it). See
  `.env.example` for the shape of it.
- Use a dedicated Bybit API key with trading + read permissions only — no
  withdrawal permission.

## History

The detailed, version-by-version history of `src/bot.js` (V4 through V11:
elaborate scoring, regime detection, adaptive memory, profit-controlled
sizing tiers, etc.) is preserved in git history rather than duplicated here
— none of that tuning changed the fundamental result. If you're doing
archaeology on a specific version's exact settings, `git log` on
`src/*.js` and the earlier commits will have it.
