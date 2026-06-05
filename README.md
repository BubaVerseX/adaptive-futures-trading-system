# Bybit V5 Futures Aggressive Scalping Bot

This Node.js bot trades Bybit Unified Trading API V5 USDT linear perpetual contracts. It keeps fast multi-symbol momentum scanning, FOMO breakout entries, micro-breakout signals, long/short scoring, native TP/SL, WebSocket lifecycle handling, and live reconciliation.

This is still high risk. Profit is not guaranteed. The V4 profile is tuned to stay active while optimizing for verified net edge after fees, spread, slippage, and available funding estimates.

## Pre-V4 Profitability Audit

Run:

```bash
npm run audit:v4
```

The audit writes `data/reports/pre-v4-audit.json` without deleting any state, memory, CSV exports, or logs. On the current local records, no Bybit CSV was found under the project root, so exchange-native funding/per-fill CSV accounting was unavailable. Local `trades.json`, `tradeMemory.json`, `analytics.json`, `state.json`, and logs showed 552 closed trades, -46.270219 USDT net realized PnL, -8.800617 USDT gross PnL, 37.469605 USDT fees, 13.95% post-cost win rate, 0.1129 post-cost profit factor, and 116 trades that were gross-positive but net-negative. That is the reason V4 prioritizes post-cost edge quality, duplicate execution prevention, and risk-at-stop sizing.

## Safety Default

The provided `.env.example` starts with:

```env
BYBIT_TESTNET=true
DRY_RUN=true
```

`DRY_RUN=true` never submits orders. `BYBIT_TESTNET=true` selects Bybit testnet endpoints, but testnet orders are submitted only after you deliberately change `DRY_RUN=false` and provide testnet API keys.

## Bybit API Setup

1. Create a Bybit testnet Unified Trading account and fund it with test assets.
2. Create an API key with contract-trading permission and no withdrawal permission.
3. Create local configuration:

```bash
cd /path/to/bybit-v5-futures-hyper-scalper
cp .env.example .env
npm install
```

4. Put your testnet API key and secret in `.env` only when testing authenticated functions.

The bot uses Bybit V5 linear endpoints for instruments, tickers, klines, unified wallet balance, positions, leverage, order creation, open orders, order history, native trading stops, position mode changes, and order cancellation. It uses WebSocket streams for tickers and authenticated order, execution, and position updates.

## V5 Live Validation Mode

`npm run live:validate` is a separate real-money validation profile. It is not unrestricted live mode and it is not a profit guarantee.

The npm script sets live-validation mode, mainnet endpoints, and the 10 USDT allocation default, but it does **not** auto-acknowledge real-money risk. If the acknowledgement variables are missing, startup refuses with:

```text
LIVE VALIDATION NOT STARTED — REAL-MONEY ACKNOWLEDGEMENT REQUIRED
```

It refuses to start unless all of these are true:

- `BYBIT_DEMO_TRADING=false`
- `BYBIT_TESTNET=false`
- `DRY_RUN=false`
- `LIVE_VALIDATION_MODE=true`
- `ACKNOWLEDGE_LIVE_VALIDATION_RISK=true`
- `ACKNOWLEDGE_LIVE_TRADING=true`
- `LIVE_VALIDATION_MAX_ALLOCATED_EQUITY_USDT=10`
- live REST endpoint is `https://api.bybit.com`
- live private/public WebSocket endpoints are `wss://stream.bybit.com`

Startup prints:

```text
LIVE VALIDATION MODE — REAL FUNDS AT RISK — LIMITED INITIAL RISK PROFILE ACTIVE
```

Initial validation uses a 10 USDT allocation even if the account has more equity. Sizing is based on maximum loss at stop against that allocation:

| Tier | Max loss at stop |
| --- | ---: |
| `EXPLORATION_POSITIVE_EDGE` | `0.20%` of allocated validation equity |
| `NORMAL_CONTINUATION` | `0.35%` |
| `STRONG_CONTINUATION` | `0.50%` |
| `ELITE_CONTINUATION` | `0.75%` |

The bot logs `marginUsedUsdt`, `notionalExposureUsdt`, and `maxLossAtStopUsdt` separately before entries. Margin or notional is never described as risk.

Before live-validation entries, the bot loads Bybit instrument rules for `BTCUSDT`, `ETHUSDT`, and `SOLUSDT`, including tick size, quantity step, minimum order quantity, and minimum notional/order value where available. Each candidate is checked after risk sizing:

- if the rounded order is below the Bybit minimum, it logs `ORDER_BELOW_EXCHANGE_MINIMUM`
- if the smallest executable rounded order would exceed the active max-loss-at-stop limit, it logs `ROUNDED_ORDER_EXCEEDS_RISK_LIMIT` and rejects the entry
- feasible orders log `LIVE_VALIDATION_ORDER_SIZE_FEASIBLE` and `FINAL_ROUNDED_MAX_LOSS_AT_STOP_USDT`

The bot never silently increases size above the active validation risk limit just to satisfy exchange minimums.

Promotion is evidence-based:

- Level 0: 10 USDT allocation.
- Level 1: 20 USDT allocation only after at least 50 closed validation trades, positive net PnL after actual fees, profit factor at least `1.10`, clean execution ledger, verified protection, no unresolved reconciliation, and acceptable fee ratio.
- Level 2: 35 USDT allocation only after at least 100 cumulative closed validation trades, positive net PnL, profit factor at least `1.15`, positive last-25 expectancy, bounded drawdown, and stable protection/ledger state.
- Promotion beyond 35 USDT is not automatic.

Live-validation records are separate:

- `data/live-validation/state.json`
- `data/live-validation/trades.json`
- `data/live-validation/tradeMemory.json`
- `data/live-validation/executionLedger.json`
- `data/live-validation/analytics.json`
- `data/live-validation/reports/latest-summary.json`
- `data/live-validation/reports/daily/YYYY-MM-DD.json`

The mode has no daily trade-count cap. It still rejects negative expected-net-edge entries, unresolved execution state, missing TP/SL protection, unsafe leverage, insufficient wallet balance, and excessive aggregate risk-at-stop. If validation performance deteriorates, it enters `RISK_STATE_REDUCED` and trims sizing by default; it enters `RISK_STATE_PROTECTION_ONLY` only for validation drawdown, unsafe reconciliation/protection state, or repeated true API failures.

To prepare the environment later:

```bash
cp .env.live-validation.example .env
nano .env
```

Fill the API key/secret, then deliberately review and set:

```env
ACKNOWLEDGE_LIVE_VALIDATION_RISK=true
ACKNOWLEDGE_LIVE_TRADING=true
ACKNOWLEDGE_HIGH_LEVERAGE_RISK=true
```

Then launch:

```bash
npm run live:validate
```

Do not run live validation until you have reviewed open Bybit positions manually and accept that it uses real funds.

API key safety:

- use a dedicated Bybit API key for this bot
- never commit `.env`
- never print or screenshot the API secret
- do not expose keys in reports, logs, or screenshots
- enable only the permissions required for trading plus account/position reads
- do not enable withdrawal permissions
- avoid unnecessary fund-transfer permissions

## V6 Profit-Controlled Equity Mode

`npm run live:profit-controlled` is a separate real-money mainnet profile built on the V4/V5 profit-first systems. It is not demo mode, not testnet, and not a profit guarantee.

This mode fixes the old fixed `10 USDT` allocation problem by reading fresh Bybit-reported equity and usable margin before trading cycles and before possible entries. It still limits every position by maximum loss at stop and never treats margin or notional exposure as risk.

Profit-controlled startup refuses unless all of these are true in `.env`:

- `PROFIT_CONTROLLED_EQUITY_MODE=true`
- `BYBIT_DEMO_TRADING=false`
- `BYBIT_TESTNET=false`
- `DRY_RUN=false`
- `ACKNOWLEDGE_PROFIT_CONTROLLED_LIVE_RISK=true`
- `ACKNOWLEDGE_LIVE_TRADING=true`
- live REST endpoint is `https://api.bybit.com`
- live private/public WebSocket endpoints are `wss://stream.bybit.com`

The launch script sets the mode and mainnet endpoints, but it does **not** set acknowledgement flags. If acknowledgement is missing, startup refuses with:

```text
PROFIT-CONTROLLED LIVE NOT STARTED — REAL-MONEY ACKNOWLEDGEMENT REQUIRED
```

To prepare `.env` deliberately:

```bash
npm run setup:profit-controlled
```

The setup script verifies that `BYBIT_API_KEY` and `BYBIT_API_SECRET` already exist without printing them, creates a timestamped `.env` backup, preserves the key and secret exactly as-is, and asks you to type:

```text
I ACCEPT PROFIT CONTROLLED LIVE RISK
```

Only after that exact phrase does it set the real-money acknowledgement flags and the non-secret V6 settings. It does not start the bot.

After reviewing `.env`, the later launch command is:

```bash
npm run live:profit-controlled
```

Startup must print:

```text
PROFIT-CONTROLLED LIVE MODE — REAL FUNDS AT RISK — NO PROFIT GUARANTEE
USER_ACKNOWLEDGEMENT_CONFIRMED
MAINNET_ENDPOINT_CONFIRMED
API_KEY_PRESENT_BUT_NOT_PRINTED
EXCHANGE_REPORTED_TOTAL_EQUITY_USDT
USABLE_MARGIN_USDT
SIZING_EQUITY_BASE_USDT
EXISTING_POSITIONS_RECONCILED
INSTRUMENT_RULES_LOADED
FORCED_NEGATIVE_EDGE_PARTICIPATION_DISABLED
HIGH_ACTIVITY_SCANNING_PRESERVED
PORTFOLIO_STOP_RISK_LIMIT_CONFIRMED
READY_TO_SCAN_FOR_NET_POSITIVE_QUALIFIED_ENTRIES
```

Initial V6 loss-at-stop caps use the fresh sizing equity base:

| Tier | Max loss at stop |
| --- | ---: |
| `EXPLORATION_POSITIVE_EDGE` | `0.25%` |
| `NORMAL_CONTINUATION` | `0.45%` |
| `STRONG_CONTINUATION` | `0.85%` |
| `ELITE_CONTINUATION` | `1.25%` |

Portfolio controls allow multiple BTC/ETH/SOL positions when actual stop-risk fits:

- total open loss-at-stop risk limit: `2.25%` of sizing equity
- same-direction correlated BTC/ETH/SOL cluster limit: `1.75%`
- up to three simultaneous positions may remain open when risk and protection checks pass

V6 disables forced low-quality participation in this live profile:

- forced market sampling off
- forced execution sampling off
- FOMO breakout mode off
- unconfirmed micro-breakout entries off
- unconditional choppy-market permission off
- unlimited exploration budget off
- aggressive learning phase off

Scanning remains fast, BTC/ETH/SOL-only, and active. Entries still require positive projected net edge after fees, spread, slippage, and available funding estimates. BTC is allowed only when the earned setup tier and actual exchange minimum size fit the stop-risk cap; ETH and SOL can trade when they are qualified and executable.

### V7 Profit Expansion Mode

V7 is enabled inside profit-controlled mode with `PROFIT_EXPANSION_MODE=true`. It keeps V6 risk controls but forces `PROFIT_MODE`, disables learning-phase exploration behavior, and stops treating trade generation as data collection.

Profit-mode quality scoring:

| Score | Decision |
| --- | --- |
| `< 70` | Reject |
| `70-84` | Normal |
| `85-94` | Strong |
| `95+` | Elite |

The score combines trend strength, volume confirmation, spread quality, fee-adjusted expectancy, market regime, and BTC/ETH/SOL symbol performance memory. Sideways chop is not totally disabled, but it must earn a strong or elite score.

Winner amplifier behavior:

- TP1 closes 30% of the position in profit-controlled edge mode.
- The remaining 70% becomes a runner.
- Runner stop moves to breakeven plus cost cushion after TP1.
- ATR/volatility-aware trailing manages the runner.
- Strong trend continuation can extend the runner target instead of using a fixed profit cap.

V7 also writes:

```text
data/profit-controlled-live/reports/expectancy.json
```

That report tracks expectancy, average winner, average loser, profit factor, fee impact, runner impact, and symbol ranking.

### V7.1 Trade Frequency Recovery Patch

V7.1 keeps V6/V7 risk controls, quality pacing, and fee protection intact, but reduces pre-evaluation suppression in profit-controlled mode:

| Control | Before | V7.1 |
| --- | ---: | ---: |
| Adaptive minimum score | `47` observed under pacing | `42` |
| Minimum conviction score | `50` | `45` |
| Anti-chop hard score penalty | `-24` max | `-10` max |
| Volume survivability floor | `100%` of active floor | `80%` of active floor |

The patch does not disable anti-chop or volume validation. It logs `TRADE_FREQUENCY_RECOVERY_ACTIVE` with candidate count, reject reason counts, anti-chop contribution, and conviction contribution so live behavior can be audited without changing portfolio risk.

### V8 Professional Trend Engine

V8 keeps V7 risk protections and fee gates intact while improving setup quality through multi-timeframe confirmation and rolling post-cost expectancy feedback.

Multi-timeframe trend engine:

| Timeframe | Role |
| --- | --- |
| `1m` | Entry trigger |
| `5m` | Confirmation |
| `15m` | Trend direction |
| `1h` | Macro bias |

The scanner writes `multiTimeframeTrendScore` from `0-100` and logs `MULTI_TIMEFRAME_ALIGNMENT`. Full 1m/5m/15m/1h alignment boosts continuation quality; 15m plus 1h opposition is heavily penalized; 1h opposition requires an elite setup.

Regime V2 labels are logged as `MARKET_REGIME_V2`:

- `TRENDING`: continuation trades preferred.
- `BREAKOUT`: slightly higher qualified participation.
- `SIDEWAYS_CHOP`: only strong or elite quality setups should pass.
- `VOLATILE`: sizing can be reduced slightly, without changing portfolio risk caps.
- `PANIC`: elite-only participation.

Adaptive conviction thresholds in V8:

| Regime | Threshold |
| --- | ---: |
| `TRENDING` | `46` |
| `BREAKOUT` | `44` |
| `SIDEWAYS_CHOP` | `42` |
| `VOLATILE` | `45` |
| `PANIC` | `50` |

The expectancy optimizer evaluates every 50 closed trades and updates:

```text
data/profit-controlled-live/reports/expectancy.json
data/profit-controlled-live/reports/system-health.json
```

It tracks average winner, average loser, expectancy, profit factor, fee impact, runner contribution, BTC/ETH/SOL rolling 50 and 100 trade memory, and near-miss stats. Fee drag can slightly tighten quality requirements; profitable continuation patterns can receive a small weighting boost; positive runner contribution can allow longer runner extension. Stop-loss safety, liquidation protection, leverage caps, and portfolio open-risk caps are not loosened.

### V9 Edge Maximization Engine

V9 keeps the V8 trend/expectancy stack and focuses on improving profit factor, expectancy, and average winner without weakening risk controls.

- Winner expansion now uses a `30%` TP1 close and leaves a `70%` ATR/volatility-aware runner.
- Setup ranking tracks symbol-specific families such as `BTCUSDT:BREAKOUT`, `ETHUSDT:CONTINUATION`, and `SOLUSDT:CONTINUATION`.
- Setup and regime memories store trade count, win rate, profit factor, expectancy, average winner, average loser, drawdown, and runner contribution.
- Profit factor above `1.3` creates a soft boost; profit factor below `1.0` reduces weighting. No setup, regime, or symbol is fully disabled by memory.
- V9 quality-size multipliers are `1.0x` normal, `1.2x` strong, and `1.5x` elite, still clamped by existing stop-risk, correlation, leverage, margin, and portfolio limits.
- `marketBreadthScore` compares BTC, ETH, and SOL trend direction. Full alignment adds confidence; conflicting breadth reduces confidence.

V9 writes:

```text
data/profit-controlled-live/reports/edge-report.json
```

The edge report includes best/worst setup, best/worst regime, runner contribution, profit factor, expectancy, average winner, and average loser.

## Focused BTC/ETH/SOL Universe

The executable trading universe is intentionally restricted to:

- `BTCUSDT`
- `ETHUSDT`
- `SOLUSDT`

The scanner still uses BTC and ETH for regime intelligence, but candidate generation, forced market sampling, exploration entries, and live execution are limited to those three high-liquidity USDT perpetuals. All other markets are ignored before candle analysis, so low-cap noise cannot consume learning attention or generate orders.

This keeps the bot active while concentrating adaptive memory on cleaner, deeper markets with better liquidity, lower slippage risk, and more meaningful pattern feedback.

## High-Conviction Momentum Strategy

Defaults now favor active but selective learning-phase participation: the bot stays free to trade, but weak micro-scalps, barely-profitable fee edges, and noisy chop entries face stronger quality checks.

| Setting | Default |
| --- | ---: |
| `LEARNING_PHASE_MODE` | `true` |
| `AGGRESSIVE_LEARNING_PHASE` | `true` |
| `HIGH_ACTIVITY_MODE` | `true` |
| `CONTINUOUS_EXECUTION_MODE` | `true` |
| `DISABLE_DAILY_TRADE_LIMITS` | `true` |
| `FAST_MODE` | `true` |
| `FOMO_BREAKOUT_MODE` | `true` |
| `MICRO_BREAKOUT_ENTRIES` | `true` |
| `MIN_SIGNAL_SCORE` | `42` |
| `MIN_CONVICTION_SCORE` | `45` |
| `MAX_OPEN_POSITIONS` | `3` |
| `MAX_TRADES_PER_DAY` | ignored while daily limits are disabled |
| `MAX_LEVERAGE` | `8` |
| `SCAN_INTERVAL_MS` | `1200` |
| `POSITION_MONITOR_INTERVAL_MS` | `1200` |
| `MAX_SYMBOLS_TO_SCAN` | `3` |
| `TAKE_PROFIT_PCT` | `2.10` |
| `STOP_LOSS_PCT` | `0.80` |

The scanner ranks only `BTCUSDT`, `ETHUSDT`, and `SOLUSDT` by EMA alignment or acceleration, continuation breakout quality, pullback/retest/resumption structure, momentum persistence, volume quality, RSI, candle strength, volatility quality, liquidity, projected edge after fees/spread/slippage, BTC/ETH direction context, 1h macro bias, market-regime intelligence, session context, and adaptive historical confidence. In learning phase, choppy and imperfect conditions are softened instead of treated as near-vetoes, so moderate setups can still generate feedback data inside the focused universe.

Daily shutdowns are removed. The bot does not stop, pause, close all positions, or disable entries because of daily loss, daily drawdown, daily trade count, exploration count, participation quota, or temporary API instability. Losing sessions are handled through adaptive recovery: sizing and leverage can be moderated, but continuous BTC/ETH/SOL execution remains active until manual stop, emergency stop, liquidation danger, corrupted execution state, or another catastrophic safety condition.

High activity mode keeps the focused universe hot without reopening low-cap chaos:

- scanner and position monitor defaults run every `1200ms`
- BTC/ETH/SOL regime cache refreshes every `45000ms`
- continuation setups receive a small participation boost when momentum, volume, BTC alignment, and edge are all acceptable
- smart edge filtering remains active, so high activity means more clean continuation attempts, not fee-blind spam

Learning-phase controls:

| Setting | Default |
| --- | ---: |
| `FORCED_MARKET_SAMPLING_ENABLED` | `true` |
| `FORCED_MARKET_SAMPLING_AFTER_MINUTES` | `4` |
| `FORCED_SAMPLING_MAX_CANDIDATES` | `3` |
| `FORCED_SAMPLING_MIN_SCORE` | `26` |
| `FORCED_SAMPLING_MIN_CONVICTION` | `32` |
| `FORCED_SAMPLING_MIN_PROJECTED_EDGE_PCT` | `0.10` |
| `FORCED_SAMPLING_MIN_EDGE_TO_COST_RATIO` | `1.15` |

If no trade has opened for the configured idle window, forced market sampling can promote moderate exploratory candidates on BTC, ETH, or SOL that still have positive projected edge, acceptable liquidity, non-abnormal volatility, no blacklist/exchange-minimum rejection, and no existing same-symbol position. This is designed for data collection, not all-in trading. Continuous execution mode removes trade-count blockers and stale saved daily-loss pauses. Aggressive learning phase treats symbol cooldowns as advisory, not execution blockers, so the bot can continue collecting focused feedback unless a core safety rule rejects the trade.

Fee-efficiency controls:

| Setting | Default |
| --- | ---: |
| `ESTIMATED_FEE_PCT_PER_SIDE` | `0.055` |
| `MAKER_FEE_PCT_PER_SIDE` | `0.020` |
| `TAKER_FEE_PCT_PER_SIDE` | `0.055` |
| `ESTIMATED_SLIPPAGE_PCT` | `0.08` |
| `MIN_PROJECTED_EDGE_PCT` | `0.55` |
| `MIN_EXPECTED_MOVE_PCT` | `0.95` |
| `MIN_EDGE_TO_COST_RATIO` | `1.80` |
| `SMART_EDGE_MIN_NET_PCT` | `0.22` |
| `SMART_EDGE_MIN_TP_PROBABILITY` | `0.46` |
| `SMART_EDGE_COST_BUFFER_MULTIPLIER` | `1.25` |
| `SYMBOL_REENTRY_COOLDOWN_SECONDS` | `180` |
| `SYMBOL_LOSS_COOLDOWN_MINUTES` | `30` |
| `ESTIMATED_FUNDING_PCT` | `0` |
| `EDGE_EXPLORATION_MIN_NET_PCT` | `0.06` |
| `EDGE_NORMAL_MIN_NET_PCT` | `0.14` |
| `EDGE_STRONG_MIN_NET_PCT` | `0.24` |
| `EDGE_ELITE_MIN_NET_PCT` | `0.36` |

The V4 profit objective is daily realized net PnL, not raw trade count or raw win rate. The edge gate estimates gross move, entry/exit fees, spread, slippage, funding estimate, continuation probability, reward/cost, reward/risk, projected net profit, projected total cost, and projected stop loss before entry. Exploration can still be frequent, but it must remain positive-edge after costs.

Next-generation continuation engine:

| Setting | Default |
| --- | ---: |
| `CONTINUATION_ENGINE_ENABLED` | `true` |
| `CONTINUATION_MIN_STRENGTH` | `58` |
| `PULLBACK_CONTINUATION_ENABLED` | `true` |
| `RETEST_ENTRY_ENABLED` | `true` |
| `MOMENTUM_RESUMPTION_ENABLED` | `true` |
| `TREND_ACCELERATION_ENABLED` | `true` |
| `CANDLE_INTERVAL_MACRO` | `60M` |
| `MACRO_TREND_WEIGHT` | `5` |

The scanner now reads 1m execution candles, 5m trend-continuation candles, 15m regime candles, and 1h macro-bias candles. It classifies continuation breakout, pullback continuation, breakout retest, momentum resumption, and trend acceleration setups, then feeds continuation strength into scoring, smart edge, re-entry, elite sizing, and adaptive memory.

Elite conviction sizing:

| Tier | Behavior |
| --- | --- |
| `TIER_1_EXPLORATORY` | roughly `2-4` USDT margin target for exploratory or weaker setups |
| `TIER_2_STRONG_SETUP` | roughly `5-10` USDT margin target for strong momentum setups |
| `TIER_3_ELITE_SETUP` | roughly `12-25` USDT margin target for rare high-confluence setups |

Sizing is now based primarily on maximum loss at stop relative to current equity, not just notional or margin. Default stop-risk bands are exploration `0.20-0.35%`, normal `0.40-0.60%`, strong `0.65-0.90%`, and elite `0.90-1.25%` of equity. Portfolio open stop-risk is capped around `2.60%` normally and `3.50%` only in explosive elite mode, with BTC/ETH/SOL same-direction correlation reducing individual sizing. Elite setup detection requires high score, strong adaptive/technical conviction, strong projected and smart edge, volume expansion, momentum persistence, trend quality, BTC alignment, continuation strength, and multi-timeframe or 1h macro confirmation.

Adaptive quality pacing:

| Setting | Default |
| --- | ---: |
| `QUALITY_PACING_ENABLED` | `true` |
| `QUALITY_PACING_MIN_WIN_RATE_PCT` | `25` |
| `QUALITY_PACING_FEE_DRAG_RATIO` | `0.65` |
| `QUALITY_PACING_MIN_AVERAGE_HOLD_SECONDS` | `45` |
| `QUALITY_PACING_SIGNAL_ADJUSTMENT` | `4` |
| `QUALITY_PACING_EXPLORATION_ADJUSTMENT` | `3` |
| `QUALITY_PACING_EDGE_MULTIPLIER` | `1.25` |
| `QUALITY_PACING_RISK_MULTIPLIER` | `0.85` |

Quality pacing is a soft throttle, not a daily cap. When recent win rate is very weak, fees are consuming too much edge, or average holds are too short, it raises score/edge/conviction requirements and trims sizing while continuous execution remains active.

Controlled exploration adds a smaller, separately tagged entry path:

| Setting | Default |
| --- | ---: |
| `EXPLORATION_MODE_ENABLED` | `true` |
| `EXPLORATION_TRADE_RATIO` | `0.55` |
| `EXPLORATION_MIN_SIGNAL_SCORE` | `28` |
| `EXPLORATION_MIN_CONVICTION_SCORE` | `34` |
| `EXPLORATION_MIN_PROJECTED_EDGE_PCT` | `0.16` |
| `EXPLORATION_MIN_EDGE_TO_COST_RATIO` | `1.20` |
| `EXPLORATION_RISK_MULTIPLIER` | `0.35` |
| `EXPLORATION_MAX_CHOP_SCORE` | `6` |
| `EXPLORATION_MAX_TRADES_PER_DAY` | ignored while daily limits are disabled |

Exploration trades still require positive fee-aware edge, acceptable liquidity, non-abnormal volatility, TP/SL coverage, and now a real continuation clue such as breakout, FOMO momentum, persistent momentum, or BTC-aligned trend quality. They are smaller, counted separately in daily stats, marked as `EXPLORATION` in trade memory, and used to speed up adaptive learning. Daily trade and exploration quotas remain disabled, but weak random probing is filtered more aggressively.

## Market Regime Intelligence

The bot now builds a benchmark regime profile from BTC and ETH 15-minute candles, then overlays symbol-level liquidity and momentum context. It detects:

- `STRONG_TRENDING_MARKET`
- `SIDEWAYS_CHOP_MARKET`
- `HIGH_VOLATILITY_BREAKOUT_MARKET`
- `LOW_LIQUIDITY_MARKET`
- `BTC_LED_MARKET`
- `ALTCOIN_MOMENTUM_MARKET`
- `DEAD_MARKET_CONDITIONS`
- `FAKE_BREAKOUT_ENVIRONMENT`

Regime behavior is adaptive:

- Trending markets moderately increase continuation confidence, allow slightly wider trailing, and support longer momentum holds.
- Chop markets still reduce score, leverage, and sizing, but learning phase softens that reduction so moderate-quality setups can be sampled.
- High-volatility breakout markets allow faster entries, but cap leverage and tighten trailing distance.
- Low-liquidity or dead markets remain penalized, but no longer create broad inactivity by themselves when edge, liquidity, and momentum are acceptable.
- BTC-led markets reward trades aligned with BTC and penalize trades fighting BTC direction.
- Fake-breakout environments reject weak breakouts and reduce risk.

Regime config:

| Setting | Default |
| --- | ---: |
| `MARKET_REGIME_INTELLIGENCE_ENABLED` | `true` |
| `REGIME_STRONG_TREND_SCORE` | `55` |
| `REGIME_CHOP_SENSITIVITY` | `0.82` |
| `REGIME_HIGH_VOLATILITY_ATR_PCT` | `0.70` |
| `REGIME_LOW_LIQUIDITY_VOLUME_SPIKE` | `0.65` |
| `REGIME_DEAD_MARKET_ATR_PCT` | `0.10` |
| `REGIME_DEAD_MARKET_VOLUME_SPIKE` | `0.50` |
| `REGIME_FAKE_BREAKOUT_RANGE_EXPANSION` | `1.65` |
| `REGIME_MEMORY_WEIGHT` | `0.18` |

Session intelligence tags each setup as `ASIA`, `EUROPE`, `US`, `LATE_US_ASIA_HANDOFF`, or `DEAD_HOURS`. Historical session and regime performance are stored in trade memory, so the adaptive engine can increase confidence in sessions that work and reduce activity in sessions that produce fake breakouts.

Profit protection reduces sizing after strong daily gains without blocking entries:

| Setting | Default |
| --- | ---: |
| `PROFIT_PROTECTION_ENABLED` | `true` |
| `PROFIT_PROTECTION_START_PCT` | `8` |
| `PROFIT_PROTECTION_RISK_MULTIPLIER` | `0.75` |
| `PROFIT_PROTECTION_EXPLORATION_MULTIPLIER` | `0.50` |
| `PROFIT_PROTECTION_SIGNAL_ADJUSTMENT` | `2` |

This is not a profit lock or participation throttle. It keeps the bot running, sizes new trades smaller when the day is already meaningfully positive, and never rejects a candidate by itself. Learning-phase exploration can continue if the candidate still passes fee, wallet, liquidation, and position safety checks.

Signal-quality controls:

| Setting | Default |
| --- | ---: |
| `MIN_VOLUME_SPIKE` | `1.18` |
| `MIN_BURST_MOMENTUM_PCT` | `0.08` |
| `FOMO_MOMENTUM_PCT` | `0.18` |
| `MIN_MOMENTUM_PERSISTENCE_CANDLES` | `2` |
| `BTC_TREND_ALIGNMENT_BONUS` | `12` |
| `CHOPPY_MARKET_PENALTY` | `10` |
| `LOW_LIQUIDITY_SPIKE_PENALTY` | `16` |
| `ANTI_CHOP_ENABLED` | `true` |
| `MAX_CHOP_SCORE` | `3` |
| `MIN_LIQUIDITY_SCORE` | `45` |

Fee-aware entry filtering rejects candidates with non-positive or too-small edge relative to estimated taker fees, spread, and slippage. The current profile raises the expected move, edge-to-cost, and probability-adjusted net-edge requirements compared with the hyperactive learning mode, especially when quality pacing is active.

Winner management is also less twitchy:

| Setting | Default |
| --- | ---: |
| `TRAILING_START_PCT` | `1.10` |
| `TRAILING_DISTANCE_PCT` | `0.60` |
| `MIN_HOLD_SECONDS_BEFORE_MOMENTUM_EXIT` | `180` |
| `CONTINUATION_MIN_SCORE` | `62` |
| `CONTINUATION_MIN_PNL_PCT` | `0.35` |

If a managed position still has same-side momentum, strong conviction, adequate volume, and positive PnL, the bot logs `Strong momentum continuation detected` and avoids premature momentum exits. Hard stops, native TP/SL, trailing stops, liquidation protection, and reduce-only shutdown behavior are unchanged.

Elite trend rider mode is enabled for `ELITE_SETUP` positions. The native TP is placed farther out, the normal TP level becomes a bot-managed partial take-profit trigger, and the remaining runner trails with wider continuation logic. Continuation strength, 1h macro alignment, and continuation setup type can delay premature momentum exits when the move remains clean. The adaptive memory stores elite condition keys such as symbol, side, continuation type, regime, volume condition, macro alignment, session, and momentum persistence, then boosts future conviction when similar elite conditions have historically produced strong winners. Smart re-entry can tag fresh entries when a recent BTC/ETH/SOL trend remains valid after a pullback, retest, momentum resumption, or trend acceleration.

## API Auto-Recovery

Temporary REST timeouts, rate limits, delayed order acknowledgements, and WebSocket disconnects trigger staged recovery instead of a full bot stop:

| Setting | Default |
| --- | ---: |
| `API_AUTO_RECOVERY_ENABLED` | `true` |
| `MAX_CONSECUTIVE_API_ERRORS` | recovery escalation threshold, not a shutdown |
| `API_RECOVERY_BASE_BACKOFF_MS` | `1000` |
| `API_RECOVERY_MAX_BACKOFF_MS` | `30000` |

Recovery stages are retry after backoff, reconnect WebSockets, refresh REST session caches, rebuild exchange state through ticker and position reconciliation, then resume continuous execution. Only manual stop, emergency stop, liquidation danger, corrupted execution state, or another catastrophic safety issue should stop the bot.

Bybit `34040: not modified` responses are treated as idempotent success. Before sending leverage or trading-stop updates, the bot compares intended values with remembered exchange/native values using tick-size normalization and a small tolerance, then logs `UNCHANGED_TPSL_UPDATE_SKIPPED`, `UNCHANGED_LEVERAGE_UPDATE_SKIPPED`, `POSITION_PROTECTION_ALREADY_VALID`, or `BYBIT_NO_CHANGE_TREATED_AS_SUCCESS` instead of triggering recovery.

## Native Protection And Lifecycle

- Entry market orders include native Bybit `takeProfit` and `stopLoss` parameters.
- Once a position appears in `/v5/position/list`, the bot confirms protection through `/v5/position/trading-stop`.
- Native trailing-stop configuration is sent when favorable movement reaches `TRAILING_START_PCT`.
- A candidate is rejected if estimated liquidation distance is too close to its stop loss.
- A confirmed live position whose reported liquidation distance violates the configured buffer is closed immediately.
- Entry orders are tracked as `NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, or `REJECTED`.
- `data/executionLedger.json` deduplicates fill events, aggregates partial fills into one logical trade, records actual fees, and prevents delayed acknowledgements from becoming duplicate logical entries.
- Pending entry state expires after `ENTRY_CONFIRMATION_TIMEOUT_MS=15000`; absent positions are cleared automatically.
- REST reconciliation remains active even if private WebSocket updates disconnect.

Logs include `ENTRY SIGNAL`, `EDGE_GATE_APPROVED`, `EDGE_GATE_REJECTED`, `EXPECTED_NET_EDGE_USDT`, `ORDER SENT`, `ORDER FILLED`, `POSITION OPENED`, `POSITION CLOSED`, `TP HIT`, `SL HIT`, `RECONCILIATION SUCCESS`, `BYBIT_NO_CHANGE_TREATED_AS_SUCCESS`, `UNCHANGED_TPSL_UPDATE_SKIPPED`, `UNCHANGED_LEVERAGE_UPDATE_SKIPPED`, `POSITION_PROTECTION_ALREADY_VALID`, `MEMORY_BUCKET_UPDATED`, `NET_POSITIVE_PATTERN_STRENGTHENED`, `NET_NEGATIVE_PATTERN_DOWNWEIGHTED`, `Duplicate execution event ignored by execution ledger`, and the continuation/regime/adaptive learning events described above.

## Performance Tracking

Closed trades are saved to `data/trades.json`. Runtime performance is rebuilt from that file on startup and stored in `data/state.json`, including:

- realized net PnL after tracked or estimated fees
- gross PnL
- fee totals
- win rate
- average hold time
- best and worst symbol statistics
- elite condition leaderboards and market personality performance
- per-symbol cooldown state after closes and losing trades

## Adaptive Statistical Learning

The bot now maintains a local, deterministic trade-memory system. This is not a neural network and does not use cloud services or external APIs. It learns only from completed trades that the bot itself records.

Generated files:

- `data/tradeMemory.json`: completed trade memory plus rolling last-20, last-50, and last-200 trade statistics.
- `data/analytics.json`: aggregate analytics, leaderboards, drawdown, daily/weekly PnL, and the current adaptive policy.
- `data/executionLedger.json`: logical trade lifecycle, order IDs, processed fill IDs, aggregated fill quantity, average fill price, actual fees, TP/SL confirmation state, and final net result.
- `data/reports/latest-summary.json` and `data/reports/daily/YYYY-MM-DD.json`: account, activity, quality, breakdown, and current actionability summaries.

Every completed trade memory record stores symbol, side, setup type, continuation setup type, continuation strength, score, timestamps, hold time, realized PnL, fees, leverage, BTC/market regime, advanced market-regime tags, 1h macro alignment, regime confidence, BTC trend strength, BTC volatility, volatility regime, volume condition, entry momentum, spread, slippage, result type, win/loss, session, and whether breakout/FOMO/micro-breakout logic fired.

The adaptive engine calculates:

- win rate by symbol, setup, UTC hour, BTC regime, advanced market regime, volatility regime, session, and leverage bucket
- win rate and fee-adjusted edge by continuation setup, continuation-strength bucket, symbol-continuation pair, market personality, and macro alignment
- average PnL by setup and condition
- fee-adjusted PnL
- average hold time and slippage
- best/worst symbols, setups, sessions, and conditions
- best/worst market regimes and regime/session combinations
- best continuation setups and BTC/ETH/SOL specialization patterns
- rolling last-20/50/200 performance
- drawdown from realized trade memory

Adaptive behavior:

- Strong historical conditions add a confidence bonus to future matching setups.
- Weak historical conditions reduce score, risk, and leverage, but penalties are sample-weighted and softened so memory acts as guidance instead of a veto.
- Adaptive confidence has a floor, so it does not collapse to near-zero after a small losing sample.
- Very poor repeated condition buckets become temporary caution zones with a bounded penalty instead of automatic permanent rejection.
- Strong technical setups can override weak historical memory when conviction, volume, momentum, and fee-adjusted edge are all strong.
- Exploration trades receive lighter historical penalties because their purpose is learning and setup discovery.
- If recent last-20 performance is poor during aggressive learning phase, the bot enters `CAUTIOUS_ACTIVE`: risk and leverage are moderated, but participation and exploration continue.
- If the shorter recovery window improves, the bot enters `AGGRESSIVE_LEARNING_RECOVERY` and restores aggression faster while staying under hard caps.
- If recent last-20 performance is strong, the bot enters `CONTROLLED_AGGRESSIVE` mode within hard caps.
- High-volatility and abnormal-volatility setups automatically reduce risk/leverage.
- Low-volume setups are penalized unless the statistics and signal quality justify them.
- Strong historical market regimes and sessions can add confidence; weak regimes and fake-breakout sessions reduce score, risk, leverage, and exploration intensity.
- Strong historical continuation patterns and symbol-specialized personalities can add conviction; weak BTC/ETH/SOL continuation buckets become softer cautions instead of hard vetoes.
- The adaptive activity floor and forced market sampling prevent extreme silence by allowing moderate exploratory setups when fee edge, liquidity, and momentum are acceptable.

Adaptive config:

| Setting | Default |
| --- | ---: |
| `ADAPTIVE_LEARNING_ENABLED` | `true` |
| `MIN_ADAPTIVE_TRADES` | `5` |
| `MIN_ADAPTIVE_BUCKET_TRADES` | `2` |
| `ADAPTIVE_MEMORY_MAX_TRADES` | `5000` |
| `DEFENSIVE_WIN_RATE_PCT` | `32` |
| `AGGRESSIVE_WIN_RATE_PCT` | `55` |
| `ADAPTIVE_RECOVERY_WIN_RATE_PCT` | `40` |
| `ADAPTIVE_RECOVERY_LOOKBACK_TRADES` | `6` |
| `ADAPTIVE_CONFIDENCE_BONUS_MAX` | `12` |
| `ADAPTIVE_CONFIDENCE_PENALTY_MAX` | `10` |
| `ADAPTIVE_CONFIDENCE_FLOOR` | `22` |
| `ADAPTIVE_PENALTY_SCALE` | `0.55` |
| `ADAPTIVE_SMALL_SAMPLE_FULL_WEIGHT_TRADES` | `120` |
| `ADAPTIVE_SMALL_SAMPLE_MIN_WEIGHT` | `0.20` |
| `EXPLORATION_MEMORY_PENALTY_MULTIPLIER` | `0.45` |
| `ADAPTIVE_BLACKLIST_SCORE_PENALTY` | `8` |
| `TECHNICAL_OVERRIDE_ENABLED` | `true` |
| `TECHNICAL_OVERRIDE_MIN_CONVICTION` | `76` |
| `TECHNICAL_OVERRIDE_MIN_FEE_EDGE_RATIO` | `2.60` |
| `TECHNICAL_OVERRIDE_MIN_PROJECTED_EDGE_PCT` | `0.85` |
| `TECHNICAL_OVERRIDE_MIN_VOLUME_SPIKE` | `1.80` |
| `ADAPTIVE_BLACKLIST_WIN_RATE_PCT` | `20` |
| `ADAPTIVE_BLACKLIST_MINUTES` | `20` |
| `ADAPTIVE_RISK_MIN_MULTIPLIER` | `0.50` |
| `ADAPTIVE_RISK_MAX_MULTIPLIER` | `1.30` |
| `HIGH_VOLATILITY_ATR_PCT` | `0.80` |
| `ABNORMAL_VOLATILITY_ATR_PCT` | `1.60` |
| `REGIME_MEMORY_WEIGHT` | `0.18` |
| `ADAPTIVE_ACTIVITY_FLOOR_ENABLED` | `true` |
| `ACTIVITY_FLOOR_MIN_TRADES_PER_DAY` | `18` |
| `ACTIVITY_FLOOR_MIN_EXPLORATION_BUDGET` | `4` |
| `ACTIVITY_FLOOR_SIGNAL_RELAX_POINTS` | `3` |
| `ACTIVITY_FLOOR_CONVICTION_RELAX_POINTS` | `4` |
| `ACTIVITY_FLOOR_CHOP_TOLERANCE_BONUS` | `1` |

## Position Mode

Bybit supports one-way and hedge modes for linear contracts:

```env
BYBIT_POSITION_MODE=ONE_WAY
BYBIT_ENSURE_POSITION_MODE=false
```

Set `BYBIT_POSITION_MODE=HEDGE` when your account is configured for hedge positions. Setting `BYBIT_ENSURE_POSITION_MODE=true` allows the bot to request the selected mode for USDT linear contracts at live startup; changing mode can fail when positions or orders already exist.

## Run In Dry-Run Mode

```bash
cd /path/to/bybit-v5-futures-hyper-scalper
cp .env.example .env
npm install
rm -f STOP_BOT.txt
npm run testnet
```

This scans Bybit testnet market data and simulates entries and exits only.

## Run With Testnet Orders

Start with testnet before mainnet:

```bash
cd /path/to/bybit-v5-futures-hyper-scalper
cp .env.example .env
npm install
nano .env
```

Set testnet credentials and intentional order configuration:

```env
BYBIT_API_KEY=your_testnet_key
BYBIT_API_SECRET=your_testnet_secret
BYBIT_TESTNET=true
DRY_RUN=false
ACKNOWLEDGE_HIGH_LEVERAGE_RISK=true
```

Then run:

```bash
rm -f STOP_BOT.txt
npm run testnet
```

Testnet live mode submits actual Bybit testnet market orders with native TP/SL.

## Run With Bybit Demo Trading Orders

Bybit Demo Trading is not the same as testnet. Demo keys must be created from the main Bybit account after switching into Demo Trading, and the bot enforces the official demo REST/private-WebSocket domains when `BYBIT_DEMO_TRADING=true`.

```bash
cd /path/to/bybit-v5-futures-hyper-scalper
cp .env.demo.example .env
npm install
nano .env
```

Fill in only the demo key and secret:

```env
BYBIT_API_KEY=your_demo_trading_key
BYBIT_API_SECRET=your_demo_trading_secret
BYBIT_DEMO_TRADING=true
BYBIT_TESTNET=false
DRY_RUN=false
ACKNOWLEDGE_DEMO_TRADING=true
ACKNOWLEDGE_HIGH_LEVERAGE_RISK=true
ACKNOWLEDGE_LIVE_TRADING=false
BYBIT_REST_BASE_URL=https://api-demo.bybit.com
BYBIT_WS_BASE_URL=
BYBIT_PUBLIC_WS_BASE_URL=wss://stream.bybit.com
BYBIT_PRIVATE_WS_BASE_URL=wss://stream-demo.bybit.com
```

Then start demo mode:

```bash
rm -f STOP_BOT.txt
npm run demo
```

`npm run demo` forces `BYBIT_DEMO_TRADING=true`, `BYBIT_TESTNET=false`, `DRY_RUN=false`, `ACKNOWLEDGE_DEMO_TRADING=true`, `ACKNOWLEDGE_LIVE_TRADING=false`, `ACKNOWLEDGE_HIGH_LEVERAGE_RISK=true`, and the official demo endpoints for that process. In demo mode the bot writes runtime files under `data/demo/`, so demo analytics, execution ledger, trade memory, state, and logs do not contaminate prior live/local history. The bot refuses to start demo mode if the REST URL is not `https://api-demo.bybit.com`, if the private WebSocket URL is not `wss://stream-demo.bybit.com`, if the public market WebSocket is not `wss://stream.bybit.com`, or if `ACKNOWLEDGE_LIVE_TRADING=true`.

Confirm demo mode in logs by checking for:

```text
DEMO TRADING — NO REAL FUNDS AT RISK.
```

## Mainnet Live Mode

Mainnet is deliberately gated. Configure real API credentials locally and require both acknowledgements:

```env
BYBIT_API_KEY=your_mainnet_key
BYBIT_API_SECRET=your_mainnet_secret
DRY_RUN=false
BYBIT_TESTNET=false
ACKNOWLEDGE_HIGH_LEVERAGE_RISK=true
ACKNOWLEDGE_LIVE_TRADING=true
```

Some Bybit accounts registered through regional sites require the region-specific official REST and WebSocket domains. Set `BYBIT_REST_BASE_URL` and `BYBIT_WS_BASE_URL` to the endpoints for that account before mainnet use.

Start mainnet only after verifying testnet behavior:

```bash
rm -f STOP_BOT.txt
npm run live
```

## Stop Safely

Press `CTRL+C`, or create the emergency file:

```bash
touch STOP_BOT.txt
```

With the default `CLOSE_POSITION_ON_EXIT=true`, shutdown reconciles and submits reduce-only closes for managed positions before saving state. Always verify positions and conditional protection orders directly in Bybit after stopping.

## Telegram Commands

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured:

```text
/status
/pause
/resume
/panic
/dryrun
```

`/panic` submits closes for managed positions and stops the bot.

## Project Files

- `src/bybitClient.js`: Bybit V5 REST signing, endpoints, and WebSocket reconnect streams.
- `src/bybitErrors.js`: centralized Bybit response classification, including `34040` no-change success handling.
- `src/bot.js`: execution lifecycle, native stops, reconciliation, emergency shutdown, and logging.
- `src/scanner.js`: aggressive multi-symbol signal ranking.
- `src/costModel.js`: post-cost net edge, reward/cost, reward/risk, and edge-tier decisions.
- `src/executionLedger.js`: idempotent order/fill lifecycle tracking and duplicate fill prevention.
- `src/profitObjective.js`: latest and daily net-profit objective reports.
- `src/marketRegime.js`: BTC/ETH regime classification, session profiling, and symbol-level regime overlays.
- `src/adaptiveEngine.js`: local trade memory, statistical learning, confidence scoring, adaptive policy, and analytics generation.
- `src/indicators.js`: EMA, RSI, ATR, momentum, and candle calculations.
- `src/riskManager.js`: ladder sizing, margin caps, continuous recovery sizing, and catastrophic risk controls.
- `src/state.js`: persistent Bybit runtime state and trade history.
- `src/telegram.js`: optional alerting and control commands.
- `scripts/preV4Audit.js`: local historical audit tool that writes `data/reports/pre-v4-audit.json`.

Official documentation: [Bybit V5 Introduction](https://bybit-exchange.github.io/docs/v5/intro), [Order Create](https://bybit-exchange.github.io/docs/v5/order/create-order), [Positions](https://bybit-exchange.github.io/docs/v5/position), [WebSocket](https://bybit-exchange.github.io/docs/v5/ws/connect).
