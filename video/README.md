# Bot film

A short vertical film (1080×1920 MP4, made for a phone) of what the bots
really did: **pump.fun and Bybit in one dashboard**, replayed from the first
trade to today. Results are shown **in percent only**, never in dollars or SOL.

```bash
node video/make.cjs              # the whole history, 30 seconds
node video/make.cjs --seconds 45 # a longer cut (more highlights fit)
node video/make.cjs --days 1     # just the last day
node video/make.cjs --demo       # look only: SAMPLE numbers (says so in the corner)
```

It opens a tab in your browser, draws the film there and saves it to
`video/out/` (Finder opens on it when done). Keep the tab open until it says
done. If Safari can't make it, add `--chrome`.

## What's on screen

- **Header**: the bots, their working parts (chips light up when a part acts),
  the replay date and time, the chapter, and a calendar strip of when each bot
  was busy.
- **Main window**: two glowing rings linked through each other, Bybit (amber)
  and pump.fun (cyan). Bybit: one line per closed trade. pump.fun: one line per
  coin the bot watched. A trade's line flashes when it closes, then stays
  gold/green (profit) or red (loss).
- **Side panels**: activity, win rate, return per trade (size-weighted), the
  spread of trade results, how trades ended (pump.fun exits) or which strategy
  opened them (Bybit, from its logs), and a live feed of the latest trades.
- **Bottom**: the P&L stream (shape only), results by bot, the range per trade
  (worst · average · best, and pump.fun's average peak vs exit), and the most
  traded markets.
- Real highlights slow the replay down and zoom in: a bot going live, best and
  worst trade, win streaks, trade milestones, coins-watched milestones. A long
  pause between the bots becomes a short "pause" card. The last seconds hold
  the final result.

**Return per trade** = everything won or lost ÷ everything put in (pump.fun:
the SOL each buy cost; Bybit: the margin). For both bots together it is done in
dollars at each day's SOL price; without a SOL price that line is left out.

## Where the numbers come from

| Data | Source |
|---|---|
| pump.fun trades | `data/pump/trades-live-*.jsonl` |
| pump.fun coins watched | `data/pump/research-*.jsonl` |
| pump.fun failed buys | `data/pump/buyfails-live-*.jsonl` |
| Bybit trades | your closed positions from Bybit's `/v5/position/closed-pnl`, with `BYBIT_API_KEY` / `BYBIT_API_SECRET` from `.env`. Read-only. Saved to `data/video/bybit-closed-pnl.json`, so later runs only fetch what's new. |
| Bybit strategy per trade | the bot's own logs, `data/v<N>/*.log` |
| SOL price | Bybit's public daily SOL candles, saved to `data/video/sol-usd.json` |

A source that is missing just leaves its part out.

Options: `--seconds N`, `--days N`, `--bybit-from 2026-05-01`, `--no-bybit`,
`--no-pump`, `--chrome`, `--no-open`, `--paper`.

Fonts: Space Grotesk and JetBrains Mono (SIL Open Font License, in
`vendor/fonts/`). MP4 packing: mp4-muxer (MIT, `vendor/`).
