# Backtest Report — "Regime-Gated Trend Pullback"

Date: 2026-07-18
Author: Claude (this repo), per an external strategy hypothesis reviewed by a
separate Claude instance. Tested exactly as specified, no parameter tuning.

Script: `scripts/backtestRegimeGatedPullback.cjs`
Command: `node scripts/backtestRegimeGatedPullback.cjs --symbols BTCUSDT,ETHUSDT,SOLUSDT --no-cache`
Raw output: `data/regimegatedpullback/report.json` (gitignored, local only)

## Hypothesis under test

An ADX(14)-based 1h regime filter (price > 200 EMA, 50 EMA > 200 EMA and
rising, ADX > 22) gates entries so trades only fire in confirmed trends,
fixing what killed earlier pullback/breakout tests in this repo (see
`TRADING_STATUS.md`). Entries on 15m pullback-and-reclaim; exits via
tiered take-profit, breakeven stop, and a 24h time stop. Full spec as given
— see script header for exact rules.

## Gauntlet result: **FAILED — all four criteria failed**

| # | Criterion | Required | Actual (basket) | Pass? |
|---|---|---|---|---|
| 1 | Window 1 (last 180d) PF > 1.3, 100+ trades | PF>1.3, N≥100 | PF **0.96**, N=630 | **FAIL** |
| 2 | Window 2 (prior 180d) PF > 1.3, 100+ trades, positive | PF>1.3, N≥100, net>0 | PF **0.79**, N=641, net **-21.49%** | **FAIL** |
| 3 | Beats buy-and-hold, both windows | strategy > B&H | W1: -6.33% vs B&H -39.32% (beats) / W2: -21.49% vs B&H -20.3% (misses by 1.2pp) | **FAIL** (window 2 only) |
| 4 | Survives 1.5x fees (21bps) on window 1 | net > 0 | net **-19.11%** | **FAIL** |

**Verdict: does NOT clear the bar. No live pilot will be built. No parameter
tweaking was applied to rescue this — one spec, one test, honest result.**

## Windows tested

- Window 1 (recent): 2026-01-19 → 2026-07-18
- Window 2 (prior, non-overlapping): 2025-07-23 → 2026-01-19
- Both were down markets for all three symbols (buy-and-hold negative in
  every case). The strategy's window-1 "beat" of buy-and-hold is a beat of
  a very bad benchmark (-39.32%), not evidence of a positive edge in
  absolute terms — the strategy itself still lost money (-6.33% portfolio,
  -18.3% pooled-trade basis).

## Basket (pooled 3-symbol) results

| Metric | Window 1 | Window 2 | Window 1 @ 21bps stress | Control (regime OFF), W1 | Control (regime OFF), W2 |
|---|---|---|---|---|---|
| Trades | 630 | 641 | 630 | 2470 | 2439 |
| Win rate | 37.0% | 32.4% | 37.0% | 31.4% | 32.8% |
| Profit factor | 0.96 | 0.79 | 0.84 | 0.71 | 0.74 |
| Avg R | 0.12 | 0.02 | 0.12 | -0.03 | -0.01 |
| Portfolio return (equal-weight, compounded) | -6.33% | -21.49% | -19.11% | -77.08% | -70.22% |
| Portfolio max drawdown | 14.72% | 25.44% | 23.60% | 77.08% | 71.69% |
| Buy-and-hold (basket avg) | -39.32% | -20.30% | — | — | — |

## Per-symbol (window 1 / window 2)

| Symbol | W1 PF | W1 trades | W1 win% | W1 avgR | W1 maxDD | W2 PF | W2 trades | W2 net |
|---|---|---|---|---|---|---|---|---|
| BTCUSDT | 0.96 | 234 | 39.7% | 0.12 | 25.05% | 0.73 | 240 | -32.64% |
| ETHUSDT | 0.89 | 207 | 33.8% | 0.08 | 26.91% | 0.61 | 198 | -37.77% |
| SOLUSDT | 1.02 | 189 | 37.0% | 0.15 | 11.18% | 1.07 | 203 | +5.93% |

Only SOLUSDT came close to a real edge (PF ~1.0-1.07 in both windows,
smallest drawdown) — not enough on its own, and not the basket-level result
required by the gauntlet.

## Does the regime filter actually do anything? (the control comparison)

Yes — this is the one part of the hypothesis that held up. With the regime
filter disabled, the exact same entry logic produced **2470 trades in
window 1** (vs 630 gated) and a **-77.08% portfolio return with 77% max
drawdown** (vs -6.33%/14.72% gated). The filter rejected 4019 of 4649
candidate setups (86.5%) in window 1 alone, and cut the damage by roughly
10x on both return and drawdown.

**So the regime filter is doing real, substantial work — it is not a no-op.
It just isn't doing *enough* work to turn a fee-heavy, low-win-rate entry
system into a positive-expectancy one.** The underlying entry/exit logic
(pullback + reclaim + tiered TP/breakeven/time-stop) still loses money on
its own; the filter reduces exposure to the losing periods rather than
finding a source of edge. This matches the pattern noted in
`TRADING_STATUS.md` for every strategy tested in this repo to date: real
Bybit fees plus a ~30-37% win rate on R-asymmetric exits do not clear
breakeven at 100+ trade sample sizes.

## Conclusion

Four independent results now point the same direction (three prior checks
in this repo plus a fourth external parallel investigation, per
`TRADING_STATUS.md`); this is a fifth. The ADX regime-filter hypothesis
specifically has now also been tested and falsified: it meaningfully
reduces bad-regime losses but does not create a profit-factor edge. Per the
gauntlet's own outcome-handling rule, this stops here — `EDGE_EVIDENCE.md`
was not created, `I_HAVE_A_BACKTESTED_EDGE` remains unset, and no live
pilot was built.
