# Bybit V5 Futures Aggressive Scalping Bot

This Node.js bot trades Bybit Unified Trading API V5 USDT linear perpetual contracts. It keeps fast multi-symbol momentum scanning, FOMO breakout entries, micro-breakout signals, long/short scoring, native TP/SL, WebSocket lifecycle handling, and live reconciliation.

This is still high risk. Profit is not guaranteed. The current profile is tuned to stay active while reducing fee drag, leverage stress, noisy chop entries, and same-symbol revenge re-entry.

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

## High-Conviction Momentum Strategy

Defaults now favor active but selective participation: more probing than the strict regime profile, while still avoiding spam scalping:

| Setting | Default |
| --- | ---: |
| `FAST_MODE` | `true` |
| `FOMO_BREAKOUT_MODE` | `true` |
| `MICRO_BREAKOUT_ENTRIES` | `true` |
| `MIN_SIGNAL_SCORE` | `46` |
| `MIN_CONVICTION_SCORE` | `55` |
| `MAX_OPEN_POSITIONS` | `3` |
| `MAX_TRADES_PER_DAY` | `40` |
| `MAX_LEVERAGE` | `8` |
| `SCAN_INTERVAL_MS` | `2000` |
| `POSITION_MONITOR_INTERVAL_MS` | `2000` |
| `TAKE_PROFIT_PCT` | `2.10` |
| `STOP_LOSS_PCT` | `0.80` |

The scanner ranks `USDT` linear perpetuals by EMA alignment or acceleration, breakout strength, momentum persistence, volume quality, RSI, candle strength, volatility quality, liquidity, projected edge after fees/spread/slippage, BTC/ETH direction context, market-regime intelligence, session context, and adaptive historical confidence. Choppy benchmark conditions remain tradable when `ALLOW_CHOPPY_MARKET=true`, but activity is heavily reduced unless the setup has exceptional breakout quality.

Fee-efficiency controls:

| Setting | Default |
| --- | ---: |
| `ESTIMATED_FEE_PCT_PER_SIDE` | `0.055` |
| `ESTIMATED_SLIPPAGE_PCT` | `0.08` |
| `MIN_PROJECTED_EDGE_PCT` | `0.65` |
| `MIN_EXPECTED_MOVE_PCT` | `1.10` |
| `MIN_EDGE_TO_COST_RATIO` | `2.10` |
| `SYMBOL_REENTRY_COOLDOWN_SECONDS` | `180` |
| `SYMBOL_LOSS_COOLDOWN_MINUTES` | `30` |

Controlled exploration adds a smaller, separately tagged entry path:

| Setting | Default |
| --- | ---: |
| `EXPLORATION_MODE_ENABLED` | `true` |
| `EXPLORATION_TRADE_RATIO` | `0.35` |
| `EXPLORATION_MIN_SIGNAL_SCORE` | `36` |
| `EXPLORATION_MIN_CONVICTION_SCORE` | `42` |
| `EXPLORATION_MIN_PROJECTED_EDGE_PCT` | `0.22` |
| `EXPLORATION_MIN_EDGE_TO_COST_RATIO` | `1.25` |
| `EXPLORATION_RISK_MULTIPLIER` | `0.40` |
| `EXPLORATION_MAX_CHOP_SCORE` | `4` |
| `EXPLORATION_MAX_TRADES_PER_DAY` | `14` |

Exploration trades still require positive fee-aware edge, acceptable liquidity, non-abnormal volatility, and anti-chop limits. They are smaller, counted separately in daily stats, marked as `EXPLORATION` in trade memory, and used to speed up adaptive learning. The current soft-aggression profile increases exploration allocation and lowers exploratory conviction enough to gather data without removing protection.

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
- Chop markets reduce score, leverage, sizing, and exploration budget.
- High-volatility breakout markets allow faster entries, but cap leverage and tighten trailing distance.
- Low-liquidity or dead markets suppress entries unless a symbol has exceptional fast momentum and liquidity.
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

Profit protection reduces new-risk appetite after strong daily gains:

| Setting | Default |
| --- | ---: |
| `PROFIT_PROTECTION_ENABLED` | `true` |
| `PROFIT_PROTECTION_START_PCT` | `8` |
| `PROFIT_PROTECTION_RISK_MULTIPLIER` | `0.75` |
| `PROFIT_PROTECTION_EXPLORATION_MULTIPLIER` | `0.50` |
| `PROFIT_PROTECTION_SIGNAL_ADJUSTMENT` | `3` |

This is not a profit lock. It keeps the bot running, but reduces exploration, requires stronger conviction, and sizes new trades smaller when the day is already meaningfully positive.

Signal-quality controls:

| Setting | Default |
| --- | ---: |
| `MIN_VOLUME_SPIKE` | `1.45` |
| `MIN_BURST_MOMENTUM_PCT` | `0.10` |
| `FOMO_MOMENTUM_PCT` | `0.22` |
| `MIN_MOMENTUM_PERSISTENCE_CANDLES` | `2` |
| `BTC_TREND_ALIGNMENT_BONUS` | `12` |
| `CHOPPY_MARKET_PENALTY` | `10` |
| `LOW_LIQUIDITY_SPIKE_PENALTY` | `16` |
| `ANTI_CHOP_ENABLED` | `true` |
| `MAX_CHOP_SCORE` | `3` |
| `MIN_LIQUIDITY_SCORE` | `45` |

Fee-aware entry filtering rejects a candidate when the expected move is too small relative to estimated taker fees, spread, and slippage. Conviction filtering then requires alignment between volume, momentum, BTC trend, trend quality, liquidity, anti-chop score, and adaptive historical confidence.

Winner management is also less twitchy:

| Setting | Default |
| --- | ---: |
| `TRAILING_START_PCT` | `0.90` |
| `TRAILING_DISTANCE_PCT` | `0.45` |
| `MIN_HOLD_SECONDS_BEFORE_MOMENTUM_EXIT` | `120` |
| `CONTINUATION_MIN_SCORE` | `70` |
| `CONTINUATION_MIN_PNL_PCT` | `0.35` |

If a managed position still has same-side momentum, strong conviction, adequate volume, and positive PnL, the bot logs `Strong momentum continuation detected` and avoids premature momentum exits. Hard stops, native TP/SL, trailing stops, liquidation protection, and reduce-only shutdown behavior are unchanged.

## Native Protection And Lifecycle

- Entry market orders include native Bybit `takeProfit` and `stopLoss` parameters.
- Once a position appears in `/v5/position/list`, the bot confirms protection through `/v5/position/trading-stop`.
- Native trailing-stop configuration is sent when favorable movement reaches `TRAILING_START_PCT`.
- A candidate is rejected if estimated liquidation distance is too close to its stop loss.
- A confirmed live position whose reported liquidation distance violates the configured buffer is closed immediately.
- Entry orders are tracked as `NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, or `REJECTED`.
- Pending entry state expires after `ENTRY_CONFIRMATION_TIMEOUT_MS=15000`; absent positions are cleared automatically.
- REST reconciliation remains active even if private WebSocket updates disconnect.

Logs include `ENTRY SIGNAL`, `EXPLORATION TRADE OPENED`, `ORDER SENT`, `ORDER FILLED`, `POSITION OPENED`, `POSITION CLOSED`, `TP HIT`, `SL HIT`, `RECONCILIATION SUCCESS`, `WEBSOCKET RECONNECTED`, `Trending regime detected`, `Chop regime activated`, `Breakout volatility regime active`, `BTC instability detected`, `Liquidity too weak`, `adaptive regime confidence increased`, `Profit protection mode enabled`, `Exploration threshold softened`, `Adaptive activity floor engaged`, `Moderate chop accepted`, `Recovery aggression restored`, `Exploration expansion active`, fee-inefficiency rejections, low-conviction rejections, anti-chop activations, adaptive exploration activity, defensive recovery, adaptive size increases, and strong momentum continuation decisions.

## Performance Tracking

Closed trades are saved to `data/trades.json`. Runtime performance is rebuilt from that file on startup and stored in `data/state.json`, including:

- realized net PnL after tracked or estimated fees
- gross PnL
- fee totals
- win rate
- average hold time
- best and worst symbol statistics
- per-symbol cooldown state after closes and losing trades

## Adaptive Statistical Learning

The bot now maintains a local, deterministic trade-memory system. This is not a neural network and does not use cloud services or external APIs. It learns only from completed trades that the bot itself records.

Generated files:

- `data/tradeMemory.json`: completed trade memory plus rolling last-20, last-50, and last-200 trade statistics.
- `data/analytics.json`: aggregate analytics, leaderboards, drawdown, daily/weekly PnL, and the current adaptive policy.

Every completed trade memory record stores symbol, side, setup type, score, timestamps, hold time, realized PnL, fees, leverage, BTC/market regime, advanced market-regime tags, regime confidence, BTC trend strength, BTC volatility, volatility regime, volume condition, entry momentum, spread, slippage, result type, win/loss, session, and whether breakout/FOMO/micro-breakout logic fired.

The adaptive engine calculates:

- win rate by symbol, setup, UTC hour, BTC regime, advanced market regime, volatility regime, session, and leverage bucket
- average PnL by setup and condition
- fee-adjusted PnL
- average hold time and slippage
- best/worst symbols, setups, sessions, and conditions
- best/worst market regimes and regime/session combinations
- rolling last-20/50/200 performance
- drawdown from realized trade memory

Adaptive behavior:

- Strong historical conditions add a confidence bonus to future matching setups.
- Weak historical conditions reduce score, risk, and leverage.
- Very poor repeated condition buckets can be temporarily blacklisted.
- If recent last-20 performance is poor, the bot enters `DEFENSIVE` mode: reduced risk, lower leverage, fewer positions, fewer trades/day, but exploration can continue at smaller size.
- If the shorter recovery window improves, the bot enters `DEFENSIVE_RECOVERY` mode and restores aggression faster while staying under hard caps.
- If recent last-20 performance is strong, the bot enters `CONTROLLED_AGGRESSIVE` mode within hard caps.
- High-volatility and abnormal-volatility setups automatically reduce risk/leverage.
- Low-volume setups are penalized unless the statistics and signal quality justify them.
- Strong historical market regimes and sessions can add confidence; weak regimes and fake-breakout sessions reduce score, risk, leverage, and exploration intensity.
- The adaptive activity floor prevents extreme silence by keeping a minimum exploration budget and allowing moderate chop when fee edge, liquidity, and momentum are acceptable.

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
| `ADAPTIVE_CONFIDENCE_PENALTY_MAX` | `18` |
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
- `src/bot.js`: execution lifecycle, native stops, reconciliation, emergency shutdown, and logging.
- `src/scanner.js`: aggressive multi-symbol signal ranking.
- `src/marketRegime.js`: BTC/ETH regime classification, session profiling, and symbol-level regime overlays.
- `src/adaptiveEngine.js`: local trade memory, statistical learning, confidence scoring, adaptive policy, and analytics generation.
- `src/indicators.js`: EMA, RSI, ATR, momentum, and candle calculations.
- `src/riskManager.js`: ladder sizing, margin caps, and daily-loss protection.
- `src/state.js`: persistent Bybit runtime state and trade history.
- `src/telegram.js`: optional alerting and control commands.

Official documentation: [Bybit V5 Introduction](https://bybit-exchange.github.io/docs/v5/intro), [Order Create](https://bybit-exchange.github.io/docs/v5/order/create-order), [Positions](https://bybit-exchange.github.io/docs/v5/position), [WebSocket](https://bybit-exchange.github.io/docs/v5/ws/connect).
