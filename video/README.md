# Bot film

A short vertical film (1080×1920 MP4, made for a phone) of what the bots
really did: **pump.fun and Bybit in one picture**, replayed from the first
trade to today. Results are shown **in percent only**, never in dollars or SOL.

```bash
node video/make.cjs              # the whole history, 30 seconds
node video/make.cjs --seconds 45 # a longer cut (more highlights fit)
node video/make.cjs --days 1     # just the last day
node video/make.cjs --demo       # look only: SAMPLE numbers (says so in the corner)
```

It opens a tab in your browser, draws the film there and saves it to
`video/out/` (Finder opens on it when done). Keep the tab open until it says
done. Use `--chrome` if your default browser can't make it (it needs WebGL2
and a video encoder; Chrome has both).

## The idea: the chain

Every chapter of the story (a stretch of trading with no pause longer than 10
days) forges **one link of a chain**. A link is a ring woven from that
chapter's real records, placed around the ring by time: the forge point
travels once around while the chapter plays, and a tick marks every day.

- One thread = one trade, or one coin the pump.fun bot watched.
- A trade's thread is gold while the position is open, flashes when it closes,
  then keeps its result colour.
- How far a trade sits from the ring's core is its result in percent:
  **winners flare outward, losers sink inward**. A good run looks like a bright
  shell, a bad one like a glowing core.
- The next chapter's link is forged through the last one. Every new run of a
  bot adds a link, so the chain grows with the history.

Real highlights slow the replay down, zoom in and light up the thread they are
about: a bot going live, best and worst trade, win streaks, trade and
coins-watched milestones. A long pause becomes a short card while the camera
moves to the next link. The last seconds step back to show the whole chain
over the final result.

## The panels

- **Header**: the bots and their working parts (a chip lights up when that part
  acts), the replay date and time, the current link, and a calendar strip of
  when each bot was busy.
- **Side**: activity, win rate, return per trade (size-weighted), the spread of
  trade results, how trades ended (pump.fun exits) or which strategy opened
  them (Bybit, from its logs), and a live feed.
- **Bottom**: the P&L stream (shape only), results by bot, the range per trade
  (worst · average · best, and pump.fun's average peak vs exit), and the most
  traded markets.

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

## How it is drawn

`scene.js` is the 3D scene (WebGL2): threads and sparks are drawn as light
into a half-float buffer, so dense areas keep their colour instead of clipping
to white, then bloom, an anamorphic streak and a filmic tone map.
`render.js` is everything else: the replay clock, the highlight plan, the
camera, the panels, and the MP4 encoder (WebCodecs + mp4-muxer).

Fonts: Space Grotesk and JetBrains Mono (SIL Open Font License, in
`vendor/fonts/`). MP4 packing: mp4-muxer (MIT, `vendor/`).
