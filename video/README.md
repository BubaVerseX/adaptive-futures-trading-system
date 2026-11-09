# Bot film

A short vertical film (1080×1920 MP4, made for a phone) of what the bots really
did: **pump.fun and Bybit merged into one story**, from the first trade to today.

```bash
node video/make.cjs              # the whole history, 30 seconds
node video/make.cjs --seconds 45 # a longer cut (more highlights fit)
node video/make.cjs --days 1     # just the last day
node video/make.cjs --demo       # look only: SAMPLE numbers, marked PREVIEW on screen
```

It opens a tab in your browser, draws the film there and saves it to
`video/out/` (Finder opens on it when done). Keep the tab open until it says
done. If Safari can't make it, add `--chrome`.

## The film

1. **Cold open**: "Two bots. Real money. Every trade, as it happened."
2. **Title**: the rings light up; dates, trades, coins watched.
3. **The replay**: one big scene. Each bot is a glowing ring, the two rings
   linked through each other: Bybit (amber) and pump.fun (cyan).
   - Bybit ring: one line per closed trade. pump.fun ring: one line per coin the
     bot watched. A trade's line flashes when it closes, then stays green-gold
     (profit) or red (loss); gold while pump.fun still holds the coin.
   - The clock at the top runs from the first trade to today; chapters change
     when a bot starts. Long pauses become an **intermission** (how the chapter
     ended → the pause → the next chapter).
   - Real highlights slow the replay down and zoom in: a bot going live, best and
     worst trade, win streaks, trade #100/#250/#500, coins-watched milestones.
     They are picked from the data; nothing is staged.
   - Bottom: total P&L of both bots in dollars, the cumulative P&L line
     (coloured by which bot moved it), and a ticker of the latest trades and
     failed buys.
4. **The record**: the final scorecard. Total P&L, and per bot: net, trades,
   win rate, fees, best/worst, and for Bybit market checks, fee-gate skips and
   entries by strategy; for pump.fun the funnel from coins watched to trades won.

## Where the numbers come from

| Data | Source |
|---|---|
| pump.fun trades | `data/pump/trades-live-*.jsonl` |
| pump.fun coins watched | `data/pump/research-*.jsonl` |
| pump.fun failed buys | `data/pump/buyfails-live-*.jsonl` |
| Bybit trades | your closed positions from Bybit's `/v5/position/closed-pnl`, with `BYBIT_API_KEY` / `BYBIT_API_SECRET` from `.env`. Read-only. Saved to `data/video/bybit-closed-pnl.json`, so later runs only fetch what's new. |
| Bybit strategies, market checks, fee-gate skips | the bot's own logs, `data/v<N>/*.log` |
| SOL price (for dollars) | Bybit's public daily SOL candles, saved to `data/video/sol-usd.json` |

A source that is missing just leaves its part out (no SOL price: pump.fun
stays in SOL and there is no combined dollar total).

Options: `--seconds N`, `--days N`, `--bybit-from 2026-05-01`, `--no-bybit`,
`--no-pump`, `--chrome`, `--no-open`, `--paper`.

Fonts: Space Grotesk and JetBrains Mono (SIL Open Font License, in
`vendor/fonts/`). MP4 packing: mp4-muxer (MIT, `vendor/`).
