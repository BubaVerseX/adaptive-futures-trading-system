# Edge Evidence — required before any live capital moves again

Live trading in this repo was stood down on 2026-07-16 after **four independent
negative results**: this repo's own three checks (real order history, a
39-symbol backtest, a Monte Carlo simulation) plus a fourth, separate parallel
investigation (9 strategies backtested independently) that reached the same
conclusion. See `TRADING_STATUS.md` for the full evidence and numbers.

Every live pilot script (and `src/config.js`, which gates the main bot) now
refuses to place real orders unless `I_HAVE_A_BACKTESTED_EDGE=true` is set
**and** a file named `EDGE_EVIDENCE.md` exists in the repo root. This file is
the template for that evidence file — copy it to `EDGE_EVIDENCE.md`, fill in
every section honestly with real backtest output, and only then is the
`I_HAVE_A_BACKTESTED_EDGE=true` flag meaningful rather than a lie to a config
check.

## The four required criteria

All four must be met, in writing, with the actual numbers and how they were
produced — not asserted, not "it felt good in testing."

1. **Profit factor > 1.3 on 100+ trades.** State the exact profit factor
   (gross profit / gross loss) and the exact trade count. Under 100 trades is
   not a large enough sample to distinguish edge from variance — this repo's
   own history shows single days swinging by several dollars on a $60 account
   with no real edge behind it.

2. **Holds on at least two non-overlapping historical windows.** Split the
   backtest history in half (or use two genuinely separate periods) and show
   the result independently on each. A result that only appears in one window
   is not a strategy, it's a curve fit. This is exactly the check that
   eliminated every candidate in the 39-symbol backtest on 2026-07-13.

3. **Beats buy-and-hold over the same windows.** State the buy-and-hold
   return over the identical period(s) and show the strategy beating it,
   not just beating zero. The 2026-07-13 backtest found buy-and-hold
   returned +26.67% on average against these strategies' +0.93% — "positive"
   is not the same as "worth the effort and risk of active trading."

4. **Survives a fee assumption 1.5x higher than expected.** Re-run the
   backtest (or re-derive the result) assuming round-trip fees 1.5x the real
   measured rate (real rate confirmed live: 0.055% taker / 0.02% maker per
   side). If the edge disappears under a modest fee-assumption stress test,
   it was fee-sensitive noise, not edge — this is exactly the failure mode
   that ate this account's realized PnL over the 2026-07-13→07-16 session
   ($6.32 in fees against a $7.16 total loss).

## Template — copy below into `EDGE_EVIDENCE.md`

```markdown
# Edge Evidence — [strategy name]

Date: [date]
Author: [who/what produced this]

## 1. Profit factor
Profit factor: [x.xx]
Trade count: [n]
Backtest script / command used: [path + exact invocation]

## 2. Two non-overlapping windows
Window A: [dates] — result: [...]
Window B: [dates] — result: [...]
Both positive / edge holds in both: [yes/no — if no, stop here]

## 3. Beats buy-and-hold
Buy-and-hold return, same period(s): [...]
Strategy return, same period(s): [...]
Strategy beats buy-and-hold: [yes/no — if no, stop here]

## 4. Fee stress test
Real measured fee rate used in backtest: [...]
Stress-tested at 1.5x that rate: [...]
Result still profitable at stressed fee rate: [yes/no — if no, stop here]

## Conclusion
All four criteria met: [yes/no]
If yes, proposed live parameters (notional, leverage, daily cap): [...]
```

If any answer above is "no" or "stop here," this strategy does not clear the
bar. Do not set `I_HAVE_A_BACKTESTED_EDGE=true` and do not create
`EDGE_EVIDENCE.md` for it. Keep testing in backtest-only mode.
