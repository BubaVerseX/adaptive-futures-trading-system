# Running This Repo Solo — Script Reference

Plain reference for every script in `scripts/` (plus the main bot's npm-script
entry points), so you don't need to ask an assistant what a command does.
Written 2026-08-25 at handoff, when the repo had no bots or cron jobs running.

## Kill switch (universal)

**`touch STOP_BOT.txt`** in the repo root. Every live/pilot script checks for
this file before doing anything and refuses to run (or, for scripts with a
loop, exits) if it exists. Remove the file to allow running again:
`rm STOP_BOT.txt`.

## Status snapshot as of 2026-08-25 (handoff time)

- No cron jobs, launchd agents, or background node processes running for this
  repo (checked: `crontab -l`, `launchctl list`, `ps aux`).
- `STOP_BOT.txt` does not exist (nothing is currently blocked, but nothing is
  currently running either — there's no live process to block).
- Directional/predictive live trading remains **stood down** since
  2026-07-16 — see `TRADING_STATUS.md`. Every strategy pilot below refuses
  real orders unless `I_HAVE_A_BACKTESTED_EDGE=true` **and** a genuine
  `EDGE_EVIDENCE.md` exists in the repo root meeting the bar in
  `EDGE_EVIDENCE_TEMPLATE.md`. `EDGE_EVIDENCE.md` does not currently exist.
  Fourteen independent hypotheses have failed that bar as of this date — see
  `TRADING_STATUS.md` for the full list before testing something "new."
- The one thing NOT gated behind that edge check is DCA (`dcaExecutor.cjs`)
  — it makes no prediction and no edge claim, just fixed-schedule spot
  accumulation, gated instead by its own `ACKNOWLEDGE_DCA` flag.
- DCA holdings as of 2026-08-25 (one real cycle run, `$18` total spend):
  BTC 0.000076, ETH 0.00244, SOL 0.0614 (~$17.98 invested total). Check
  `node scripts/dcaExecutor.cjs status` for current value — it re-fetches
  live prices every time, the numbers above will be stale immediately.
- `.env`'s `DRY_RUN` now defaults to `true` (fixed 2026-08-25 — it had been
  left at `false` from an earlier live session). Every script below still
  requires its own explicit acknowledgement flag before placing real
  orders, DRY_RUN alone won't do it, but this means a bare `node
  scripts/whatever.cjs` with no env overrides is safe by default again.

---

## This session's new tools (2026-08-25)

| Script | What it does | Run command |
|---|---|---|
| `scripts/dcaExecutor.cjs` | **LIVE-CAPABLE.** Single-shot spot DCA buyer — buys a fixed USDT amount of BTC/ETH/SOL (configurable) every time it runs, no price condition, no leverage, no stop-loss. Meant to be cron-scheduled. Skips any coin whose allocation is below Bybit's spot minimum notional rather than rounding up. | `node scripts/dcaExecutor.cjs` (one cycle) or `node scripts/dcaExecutor.cjs status` (report only, no orders) |
| `scripts/riskTool.cjs` | **LIVE-CAPABLE.** Manual trade sizing/execution helper — YOU decide the trade (symbol/side/entry/stop), it only sizes the position and can place the entry + native stop-loss + optional reduce-only take-profit, or trail an existing stop via ATR. Generates no signals or predictions itself. | `node scripts/riskTool.cjs size --symbol BTCUSDT --side LONG --entry 65000 --stop 63500 --risk-pct 1` (sizing only, no order) / `... enter ...` (places order) / `... trail --symbol BTCUSDT` / `... status` / `... set-limit --daily-loss-usd 50` |
| `scripts/bybitRest.cjs` | Not run directly — shared library (signed REST calls, instrument-precision rounding) required by `riskTool.cjs`. | n/a (library) |
| `scripts/freshGauntlet.cjs` | **Read-only backtest.** Runs supertrend/pullback/breakout/daily-trend Donchian through the standard 4-criteria gauntlet on BTC/ETH/SOL, live public Bybit data, no API key needed. Also a dependency of `backtestDCA.cjs` and `backtestMeanReversionGrid.cjs` below. | `node scripts/freshGauntlet.cjs [--no-cache]` |
| `scripts/backtestMeanReversionGrid.cjs` | **Read-only backtest.** Symmetric grid/mean-reversion hypothesis test on ETHUSDT (buy X% below EMA20, sell X% above entry, 2% stop) across 4 values of X, plus a regime (trending vs choppy) comparison. Result: no edge, see `TRADING_STATUS.md`. | `node scripts/backtestMeanReversionGrid.cjs [--no-cache]` |
| `scripts/backtestDCA.cjs` | **Read-only backtest.** DCA vs. lump-sum-day-1 vs. lump-sum-last-day comparison on BTC/ETH/SOL — no pass/fail verdict, just honest return numbers. | `node scripts/backtestDCA.cjs [--no-cache]` |
| `scripts/sessionEffectsCheck.cjs` | **Read-only backtest.** Raw candle-only (no indicators) check for time-of-day/day-of-week/funding-settlement patterns on BTC/ETH/SOL. Result: no edge. | `node scripts/sessionEffectsCheck.cjs [--no-cache]` |

---

## Backtests & research (all read-only — no orders, no exchange credentials required unless noted)

| Script | What it does | Run command |
|---|---|---|
| `scripts/backtestRegimeGatedPullback.cjs` | ADX/EMA-gated 15m pullback backtest, the most recently re-tested hypothesis before this session's new ones. Failed the gauntlet every time it's been run. | `node scripts/backtestRegimeGatedPullback.cjs [--no-cache]` |
| `scripts/backtestStrategies.cjs` | Backtests supertrend/pullback/breakout (the same logic `v33PowerPilot.cjs` runs live) against real historical data. | `node scripts/backtestStrategies.cjs` |
| `scripts/backtestBroadTrend.cjs` | Daily-trend Donchian/ATR strategy across the most liquid USDT perps on Bybit, not just BTC/ETH/SOL. | `node scripts/backtestBroadTrend.cjs` |
| `scripts/backtestDailyTrend.cjs` | Backtests `dailyTrendStrategy.cjs` against real daily candles. | `node scripts/backtestDailyTrend.cjs` |
| `scripts/backtestIntradayTrend.cjs` | Same Donchian breakout logic as daily, on 1h/4h candles instead. | `node scripts/backtestIntradayTrend.cjs` |
| `scripts/backtestFundingRate.cjs` | Backtests `fundingRateStrategy.cjs` (funding-rate reversal) with real funding payments included. | `node scripts/backtestFundingRate.cjs` |
| `scripts/backtestMTFConfluence.cjs` | Tests requiring a 4h trend filter to agree before taking a 5m/15m entry. | `node scripts/backtestMTFConfluence.cjs` |
| `scripts/backtestPairsTrading.cjs` | Backtests `pairsStrategy.cjs` (statistical pairs/spread trading), both legs' fees included. | `node scripts/backtestPairsTrading.cjs` |
| `scripts/simulateAggressive.cjs` | Bootstrap-resamples real historical per-trade outcomes at increasing risk-per-trade levels — shows the spread of possible outcomes without spending real money. | `node scripts/simulateAggressive.cjs` |
| `scripts/preV4Audit.js` | Reads accumulated report files under `data/` and produces a pre-v4 go/no-go decision audit. Read-only, no network calls. | `npm run audit:v4` |
| `scripts/backtestV15.js` | Older trend-portfolio backtest via `src/backtestEngine.js`. | `npm run backtest:v15` |
| `scripts/strategyLaboratory.js` | Strategy laboratory / expectancy search via `src/strategyLaboratory.js`. | `npm run lab:v21` |
| `scripts/researchV22.js` | V22 research platform — historical data engine + promotion optimizer. | `npm run research:v22` |
| `scripts/researchV23Validate.js` | V23 promotion-optimization validation pass (downloads fresh data). | `npm run research:v23:validate` |
| `scripts/v27FreqtradeResearch.cjs` | Older (2026-07) research pass building a `models/v27` profile. | `npm run v27:research` |
| `scripts/v28EthSupertrendOptimizer.cjs` | Optimizes Supertrend params for ETH, writes `models/v28/live-profile-v28.json` (still read by `v33PowerPilot.cjs` if present). | `npm run v28:optimize` |
| `scripts/v29EthSupertrendShadow.cjs` | Shadow-tests the V28 profile without placing real orders. | `npm run v29:shadow` |
| `scripts/microResearch.js` / `microTrain.js` / `microValidate.js` | Microstructure (orderbook feature) research → train → validate pipeline. Train/validate shell out to Python scripts under `python/microstructure/`. | `npm run micro:research` / `npm run micro:train` / `npm run micro:validate` |
| `scripts/microShadow.js` | Shadow-runs the trained microstructure model against live data, no real orders (`DRY_RUN=true` baked into the npm script). | `npm run micro:shadow` |
| `scripts/microFinalize.js` | Finalization/readiness gate for the microstructure pipeline going live. | `npm run micro:finalize` |

**Note:** `scripts/microLive.js` is NOT in this read-only table — its npm
script (`micro:live`) bakes in `DRY_RUN=false`. It's a live-order script, see
the gated table below.

---

## Live pilots — DIRECTIONAL/PREDICTIVE, gated behind `EDGE_EVIDENCE.md` (currently stood down, do not run live)

Every one of these refuses `DRY_RUN=false` unless **both**
`I_HAVE_A_BACKTESTED_EDGE=true` and a real `EDGE_EVIDENCE.md` exist. They also
each require their own script-specific `ACKNOWLEDGE_*` flag on top of that.
Safe to run with default `DRY_RUN=true` (now the `.env` default) to watch
what they'd do without risking money.

| Script | What it does | Live ack flag | Run command (dry-run by default now) |
|---|---|---|---|
| `scripts/v33PowerPilot.cjs` | Combined Supertrend + Pullback + Breakout across BTC/ETH/SOL/+more, one process. | `ACKNOWLEDGE_V33_LIVE=true` | `node scripts/v33PowerPilot.cjs` |
| `scripts/v32CombinedPilot.cjs` | Earlier version of the same idea (short-side signals, no trade cap). | `ACKNOWLEDGE_V32_LIVE=true` | `node scripts/v32CombinedPilot.cjs` |
| `scripts/v30ControlledLivePilot.cjs` | Earlier controlled pilot, Supertrend vote-threshold configurable. | `ACKNOWLEDGE_V30_LIVE=true` | `node scripts/v30ControlledLivePilot.cjs` |
| `scripts/dailyTrendLivePilot.cjs` | Single-shot daily Donchian breakout, meant for a once-a-day cron. | `ACKNOWLEDGE_DAILY_LIVE=true` | `node scripts/dailyTrendLivePilot.cjs` |
| `scripts/intradayTrendLivePilot.cjs` | Single-shot 1h Donchian breakout. | `ACKNOWLEDGE_INTRADAY_LIVE=true` | `node scripts/intradayTrendLivePilot.cjs` |
| `scripts/overnightRegimeGatedLive.cjs` | **Explicit knowingly-negative-EV override** — the regime-gated pullback strategy failed its gauntlet, this runs it live anyway by deliberate one-off user request, small and capped. Does NOT use the standard edge gate on purpose (see its own header) — uses `ACKNOWLEDGE_NO_EDGE_OVERNIGHT_TEST=true` instead. Treat this one as "already answered no, only re-run if you explicitly want to repeat that specific experiment." | `ACKNOWLEDGE_NO_EDGE_OVERNIGHT_TEST=true` | `node scripts/overnightRegimeGatedLive.cjs` |
| `scripts/microLive.js` | Live microstructure-model trading — uses the same central `src/config.js` gate as `npm run live` (`ACKNOWLEDGE_LIVE_TRADING` + `I_HAVE_A_BACKTESTED_EDGE` + `EDGE_EVIDENCE.md`), not a script-local flag. Its npm script bakes in `DRY_RUN=false`, so don't run `npm run micro:live` casually. | `ACKNOWLEDGE_LIVE_TRADING=true` (+ central edge gate) | `npm run micro:live` |

`src/bot.js` (the original, most feature-complete bot) is reached via npm
scripts, same edge gate applies to any non-dry-run/non-testnet variant:

| npm command | Mode |
|---|---|
| `npm run paper` | Paper/adaptive-scalper mode, `DRY_RUN=true` baked in — safe. |
| `npm run swing` / `npm run trend` | Swing/trend portfolio modes on **testnet**, `DRY_RUN=true` — safe. |
| `npm run testnet` | Bare bot on testnet. |
| `npm run demo:dry` | Bybit demo-trading endpoint, `DRY_RUN=true` — safe (fake money either way). |
| `npm run demo` | Bybit demo-trading endpoint, `DRY_RUN=false` — real orders against Bybit's demo/paper balance, not real money, but real order flow. |
| `npm run trend:live` / `npm run live` / `npm run live:validate` / `npm run live:profit-controlled` | **Real mainnet money**, `DRY_RUN=false`. Gated by the same `I_HAVE_A_BACKTESTED_EDGE`/`EDGE_EVIDENCE.md` check in `src/config.js`. Do not run without reading `TRADING_STATUS.md` first. |

`scripts/setupProfitControlled.js` (`npm run setup:profit-controlled`) is an
interactive setup wizard for the profit-controlled live mode — it requires
typing the literal phrase "I ACCEPT PROFIT CONTROLLED LIVE RISK" to proceed,
separate from the other gates.

---

## Maintenance commands

- `npm run check` — syntax-checks every `src/` and `scripts/` file that
  matters (`node --check`), no execution. Good sanity check after any edit.
- `npm test` — runs `test/bybitBot.test.js`.

---

## If you're not sure what to run

1. Check `TRADING_STATUS.md` first — it has the dated history of every
   hypothesis tested and why nothing is live right now.
2. Anything under "Backtests & research" above is safe to run any time —
   read-only, no orders, most need no API key at all (public market data).
3. Anything under "Live pilots" needs both the edge gate AND its own
   acknowledgement flag to place real orders — with today's `.env` fix,
   leaving `DRY_RUN` unset is safe by default.
4. `scripts/dcaExecutor.cjs` and `scripts/riskTool.cjs` are live-capable
   right now (no edge-gate requirement — they don't predict anything) —
   double-check the amount/symbol/flags before adding `DRY_RUN=false` to
   either one.
