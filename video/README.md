# Bot video

A 30-second vertical video (1080×1920 MP4, made for a phone) of what the bots
really did: **pump.fun on the left, Bybit on the right**.

```bash
node video/make.cjs            # whole history
node video/make.cjs --days 1   # just the last day
node video/make.cjs --demo     # look only: SAMPLE numbers, marked PREVIEW on screen
```

It opens a tab in your browser, draws the video there and saves it to
`video/out/` (Finder opens on it when done). Keep the tab open until it says
done. If Safari can't make it, add `--chrome`.

## What you see

- **The glowing rings.** Left: every line is one coin the pump bot watched; a
  line turns gold while the bot holds that coin, then green (profit) or red
  (loss). Right: every line is one closed Bybit trade, green or red.
- **Net P&L, cumulative P&L, last 40 trades, numbers grid, trade log**: all
  from the records, nothing made up. The footer names the source.
- **Activity stream** at the bottom: when each bot traded, on its own timeline
  (the replay hurries through quiet hours).

## Where the numbers come from

| Bot | Source |
|---|---|
| pump.fun | `data/pump/trades-live-*.jsonl` (trades), `data/pump/research-*.jsonl` (watched coins) |
| Bybit | your closed positions from Bybit's `/v5/position/closed-pnl`, using `BYBIT_API_KEY` / `BYBIT_API_SECRET` from `.env`. Read-only. Saved to `data/video/bybit-closed-pnl.json` so later runs only fetch what's new. |

Options: `--days N`, `--bybit-from 2026-06-01`, `--no-bybit`, `--no-pump`,
`--chrome`, `--no-open`, `--paper`.
