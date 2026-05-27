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

## Aggressive Strategy

Defaults are aggressive but less chaotic than the earlier hyper-scalper profile:

| Setting | Default |
| --- | ---: |
| `FAST_MODE` | `true` |
| `FOMO_BREAKOUT_MODE` | `true` |
| `MICRO_BREAKOUT_ENTRIES` | `true` |
| `MIN_SIGNAL_SCORE` | `35` |
| `MAX_OPEN_POSITIONS` | `3` |
| `MAX_TRADES_PER_DAY` | `60` |
| `MAX_LEVERAGE` | `8` |
| `SCAN_INTERVAL_MS` | `2000` |
| `POSITION_MONITOR_INTERVAL_MS` | `2000` |
| `TAKE_PROFIT_PCT` | `1.50` |
| `STOP_LOSS_PCT` | `0.70` |

The scanner ranks `USDT` linear perpetuals by EMA alignment or acceleration, breakout candles, one-minute momentum, volume spike, momentum persistence, RSI window, candle strength, volatility, projected net edge after fees/spread, and BTC/ETH direction context. Choppy benchmark conditions remain tradable when `ALLOW_CHOPPY_MARKET=true`, but weak chop entries are penalized or rejected when they lack breakout plus persistent volume/momentum.

Fee-efficiency controls:

| Setting | Default |
| --- | ---: |
| `ESTIMATED_FEE_PCT_PER_SIDE` | `0.055` |
| `MIN_PROJECTED_EDGE_PCT` | `0.35` |
| `SYMBOL_REENTRY_COOLDOWN_SECONDS` | `90` |
| `SYMBOL_LOSS_COOLDOWN_MINUTES` | `15` |

Signal-quality controls:

| Setting | Default |
| --- | ---: |
| `MIN_VOLUME_SPIKE` | `1.35` |
| `MIN_BURST_MOMENTUM_PCT` | `0.08` |
| `FOMO_MOMENTUM_PCT` | `0.12` |
| `MIN_MOMENTUM_PERSISTENCE_CANDLES` | `2` |
| `BTC_TREND_ALIGNMENT_BONUS` | `8` |
| `CHOPPY_MARKET_PENALTY` | `8` |
| `LOW_LIQUIDITY_SPIKE_PENALTY` | `10` |

## Native Protection And Lifecycle

- Entry market orders include native Bybit `takeProfit` and `stopLoss` parameters.
- Once a position appears in `/v5/position/list`, the bot confirms protection through `/v5/position/trading-stop`.
- Native trailing-stop configuration is sent when favorable movement reaches `TRAILING_START_PCT`.
- A candidate is rejected if estimated liquidation distance is too close to its stop loss.
- A confirmed live position whose reported liquidation distance violates the configured buffer is closed immediately.
- Entry orders are tracked as `NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, or `REJECTED`.
- Pending entry state expires after `ENTRY_CONFIRMATION_TIMEOUT_MS=15000`; absent positions are cleared automatically.
- REST reconciliation remains active even if private WebSocket updates disconnect.

Logs include `ENTRY SIGNAL`, `ORDER SENT`, `ORDER FILLED`, `POSITION OPENED`, `POSITION CLOSED`, `TP HIT`, `SL HIT`, `RECONCILIATION SUCCESS`, and `WEBSOCKET RECONNECTED`.

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

Every completed trade memory record stores symbol, side, setup type, score, timestamps, hold time, realized PnL, fees, leverage, BTC/market regime, volatility regime, volume condition, entry momentum, spread, slippage, result type, win/loss, session, and whether breakout/FOMO/micro-breakout logic fired.

The adaptive engine calculates:

- win rate by symbol, setup, UTC hour, BTC regime, volatility regime, session, and leverage bucket
- average PnL by setup and condition
- fee-adjusted PnL
- average hold time and slippage
- best/worst symbols, setups, sessions, and conditions
- rolling last-20/50/200 performance
- drawdown from realized trade memory

Adaptive behavior:

- Strong historical conditions add a confidence bonus to future matching setups.
- Weak historical conditions reduce score, risk, and leverage.
- Very poor repeated condition buckets can be temporarily blacklisted.
- If recent last-20 performance is poor, the bot enters `DEFENSIVE` mode: higher signal threshold, lower leverage, fewer positions, fewer trades/day.
- If recent last-20 performance is strong, the bot enters `CONTROLLED_AGGRESSIVE` mode within hard caps.
- High-volatility and abnormal-volatility setups automatically reduce risk/leverage.
- Low-volume setups are penalized unless the statistics and signal quality justify them.

Adaptive config:

| Setting | Default |
| --- | ---: |
| `ADAPTIVE_LEARNING_ENABLED` | `true` |
| `MIN_ADAPTIVE_TRADES` | `10` |
| `MIN_ADAPTIVE_BUCKET_TRADES` | `5` |
| `ADAPTIVE_MEMORY_MAX_TRADES` | `5000` |
| `DEFENSIVE_WIN_RATE_PCT` | `35` |
| `AGGRESSIVE_WIN_RATE_PCT` | `60` |
| `ADAPTIVE_CONFIDENCE_BONUS_MAX` | `12` |
| `ADAPTIVE_CONFIDENCE_PENALTY_MAX` | `18` |
| `ADAPTIVE_BLACKLIST_WIN_RATE_PCT` | `25` |
| `ADAPTIVE_BLACKLIST_MINUTES` | `60` |
| `ADAPTIVE_RISK_MIN_MULTIPLIER` | `0.45` |
| `ADAPTIVE_RISK_MAX_MULTIPLIER` | `1.25` |
| `HIGH_VOLATILITY_ATR_PCT` | `0.90` |
| `ABNORMAL_VOLATILITY_ATR_PCT` | `1.80` |

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
- `src/adaptiveEngine.js`: local trade memory, statistical learning, confidence scoring, adaptive policy, and analytics generation.
- `src/indicators.js`: EMA, RSI, ATR, momentum, and candle calculations.
- `src/riskManager.js`: ladder sizing, margin caps, and daily-loss protection.
- `src/state.js`: persistent Bybit runtime state and trade history.
- `src/telegram.js`: optional alerting and control commands.

Official documentation: [Bybit V5 Introduction](https://bybit-exchange.github.io/docs/v5/intro), [Order Create](https://bybit-exchange.github.io/docs/v5/order/create-order), [Positions](https://bybit-exchange.github.io/docs/v5/position), [WebSocket](https://bybit-exchange.github.io/docs/v5/ws/connect).
