# Trading Status — read this first next session

Last updated: 2026-08-25 — still stood down; also ran an honest DCA-vs-lump-sum
comparison (not a strategy/edge test, no gauntlet — DCA doesn't claim to beat
buy-and-hold, only to reduce timing risk). See below.

## 2026-08-25 — DCA vs lump-sum comparison, BTC/ETH/SOL (not a gauntlet test)

Not a hypothesis test — no pass/fail verdict applies here, per instructions
(DCA doesn't claim an edge). New script: `scripts/backtestDCA.cjs`. Fixed
$10 buy every 12h, no price condition, no stop-loss, BTC/ETH/SOL, 245 days
(same window as the grid test), plus the same two non-overlapping 120-day
windows to check consistency.

**DCA beat lump-sum-on-day-1 in all 3 symbols across all 3 periods (full,
W1, W2) — 9 for 9, fully consistent, not one lucky window.** Full-period
example (ETHUSDT): DCA +17.05% vs Day1 lump-sum -16.22% vs LastDay lump-sum
-0.31% — a 33.3 percentage-point spread between best and worst. Same pattern
on SOL (+14.06% vs -20.72%) and BTC (+10.60% vs -9.91%).

**Why, mechanically, not just luck:** all three symbols fell substantially
early in the 245-day period then partially recovered (W2, the older window,
is net negative for all three; W1, the recent window, is net positive) —
exactly the volatile down-then-up path where spreading purchases across the
decline lowers DCA's average cost basis below both the day-1 entry price
and, in most cases, the final price. Day-1 lump-sum locked in the (higher)
starting price and rode the full decline before any recovery. This is the
textbook condition DCA is supposed to help with — it isn't surprising DCA
won here, but it's confirmed rather than assumed.

**One instructive exception:** SOLUSDT W2 (the declining window on its own,
before any recovery) is the one case where "LastDay" lump-sum beat DCA
(-3.02% vs DCA's -11.49%) — buying only at the very end, near that window's
low, beat averaging in through the whole decline. This is exactly the
"worst-case timing" framing working as intended: waiting until the end
isn't always worse, it depends on where in the cycle the window ends. DCA
still beat Day1 lump-sum in that same window by a wide margin (-11.49% vs
-31.72%).

**Bottom line:** this is a real, consistent illustration of DCA reducing
entry-timing risk over this specific volatile period, not a claim that DCA
beats buy-and-hold in general (it structurally can't beat a lump-sum bought
at the eventual best price — see the SOL W2 exception above). Full numbers
in `data/dcabacktest/report.json`. No change to trading-bot status — this
isn't a live-trading candidate, it doesn't touch the `I_HAVE_A_BACKTESTED_EDGE`
gate, and doesn't count toward the negative-results pile since it made no
edge claim to fail.

## 2026-08-25 — Symmetric grid/mean-reversion hypothesis on ETHUSDT (4 values of X), NO EDGE

New hypothesis: LONG-only entry when 15m close <= EMA20*(1-X%), take-profit at
entry*(1+X%), hard stop at entry*(1-2%) regardless of X. Tested X in
{0.5%, 1%, 1.5%, 2%}, ETHUSDT only (not a basket), same 4-criteria gauntlet
(two non-overlapping 120-day windows, beats buy-and-hold, survives 1.5x fee
stress) as everything else. New script: `scripts/backtestMeanReversionGrid.cjs`
(reuses `ema()` from `strategyLogic.cjs` and `summarizeTrades()`/`computeWindows()`
from `freshGauntlet.cjs`, live public Bybit data, no key).

**Result: all 4 values of X fail all 4 criteria in both windows.** W1 (120d
recent): PF 0.56-0.76 across all X (need >1.3). W2 (120d prior): PF 0.69-0.72
(need >1.3, positive — W2 is net negative for every X, -18.9% to -44.9%).
Never beats buy-and-hold in either window at any X. Fails 1.5x fee stress
everywhere (PF drops further, returns more negative).

**Mechanical reason, not just "wrong regime":** the fixed 2% stop against a
smaller X% target creates a payoff ratio that needs a specific win rate just
to break even *before fees* — and the observed win rates land right at or
just below that line for every X (X=0.5%: need 80.0% win rate pre-fee,
observed 78.0-80.4%; X=1%: need 66.7%, observed 64.2-64.3%; X=1.5%: need
57.1%, observed 52.5-54.3%; X=2%: need 50.0%, observed 39.1-44.6%). Fees
then push every case decisively negative. This is a structural payoff-ratio
problem built into the rule as specified (symmetric target vs a stop that's
1-4x larger), not primarily a regime-fit issue.

**Regime comparison (the specific ask):** computed Kaufman Efficiency Ratio
(daily-resampled closes; ~1=pure trend, ~0=pure chop) per window instead of
assuming which period was choppy. W1 ER=0.039 (choppy, buyHold +8.27%), W2
ER=0.090 (choppy, buyHold -22.22%), WS (most recent 40d) ER=0.409 (clearly
TRENDING, buyHold +31.68% — this is the current rally), WO (oldest available
40d in the fetched range, 2025-12-23→2026-02-01) ER=0.243 (mixed,
buyHold -20.21%). **Counter to the strategy's own core assumption, it did
not clearly do better in choppier conditions:** at X=0.5% (most trades, most
statistically meaningful), the trending window WS lost less (-1.12%, PF
0.94, 46 trades) than the more range-bound/declining WO (-22.38%, PF 0.56,
112 trades) — backwards from what a mean-reversion strategy should show. At
X=1.5%, WS was the only window/X combination to show a positive return
(+4.7%, PF 3.18) anywhere in the whole test, but on only 6 trades — far
below any reporting threshold, noise. No X value shows a clean, sample-backed
"better in chop" pattern; the payoff-ratio problem above explains the
uniform losses better than regime does.

**Verdict: NO EDGE at any tested X.** `EDGE_EVIDENCE.md` not created. This
is result #14 on the pile. Full per-window numbers in
`data/meanreversiongrid/report.json`.

## 2026-08-25 — New hypothesis: time-of-day / day-of-week / funding-settlement raw pattern check, NO EDGE

First genuinely new angle tried since the regime-gated pullback test
(2026-07-18): not an indicator-based entry signal, just raw candle
statistics (return, win rate, realized vol) bucketed by UTC hour-of-day and
day-of-week, plus a targeted check of the 8h funding settlement times
(00:00/08:00/16:00 UTC). New script: `scripts/sessionEffectsCheck.cjs`
(live public Bybit data, no key). ~210 days of 1h candles (5,040/symbol) for
the hour/day-of-week check, ~180 days of 15m candles (17,280/symbol) for the
funding-window check — both comfortably over the 4,000+/100+ sample bars.
Same two-non-overlapping-window persistence standard as every other test in
this repo (chronological first-half vs second-half split).

**Hour-of-day / day-of-week (1h candles, full-sample 95% CI flags):**
- BTCUSDT: 1 hour bucket flagged (hour 20 UTC, +0.063%/candle), 0 day-of-week
  buckets flagged.
- ETHUSDT: 3 hour buckets flagged (hour 2 −0.079%, hour 10 −0.072%, hour 19
  +0.107%), 1 day-of-week bucket flagged (Thursday −0.058%).
- SOLUSDT: 1 hour bucket flagged (hour 10 UTC, −0.096%), 0 day-of-week
  buckets flagged.
- **Multiple-comparisons context:** 24 hours × 3 symbols = 72 hour buckets
  tested at 95% CI → ~3.6 false positives expected from pure chance alone;
  5 were flagged. 7 days × 3 symbols = 21 day buckets tested → ~1 false
  positive expected; 1 was flagged. Both counts are exactly what noise
  produces at this sample size — not evidence on their own.
- **Two-window persistence: 0 of 6 flagged buckets held up.** Every single
  one either flipped sign or lost significance between the first and
  second half of the sample (e.g. ETH hour 19: full-sample +0.107% sig, W1
  +0.191% sig, W2 +0.022% not sig — decayed to noise in the second half;
  BTC hour 20 similarly only significant in W2, not W1). Interesting but
  unconfirmed cross-symbol note: hour 10 UTC was negative in all three
  symbols (BTC −0.049% not flagged, ETH −0.072% flagged, SOL −0.096%
  flagged) but did not persist across the window split for either flagged
  symbol, so this is reported as an observation, not a finding.

**Funding settlement (00:00/08:00/16:00 UTC, 15m candles, 540
settlement events/symbol):** pre-60min, pre-30min, post-30min, post-60min
mean returns around each settlement, all three symbols. **Zero windows
flagged in the full sample for any symbol** — every 95% CI comfortably
straddled zero (e.g. BTC post60 mean +0.020%, CI [−0.016%, +0.056%]). No
persistence check was even needed since nothing cleared the first bar.

**Verdict: NO EDGE.** Nothing — not one bucket, not one symbol, not the
funding-window check — survived the same two-window persistence standard
used everywhere else in this repo. `EDGE_EVIDENCE.md` was not created. This
was a clean, well-powered null result (not an underpowered "insufficient
data" outcome like the Polymarket H2 check) — the sample sizes were large
enough that a real effect of this magnitude would very likely have shown
up and held across both windows if it existed.

## 2026-08-25 — 3-day follow-up: rally check + full gauntlet re-run, ALL FAIL again (result #12)

## 2026-08-25 — 3-day follow-up: rally check + full gauntlet re-run, ALL FAIL again

Re-ran `freshGauntlet.cjs` and `backtestRegimeGatedPullback.cjs` fresh (`--no-cache`,
live public Bybit data) exactly 3 days after the 2026-08-23 run, per instructions:
report price/trend continuation, current volatility vs 30d average, and the full
gauntlet table, no cherry-picking.

**Price levels vs 3 days ago (2026-08-22 →2026-08-25, live Bybit data):**

| Symbol | 3d-ago close | Current close | 3d chg | 7d chg | 30d chg |
|---|---:|---:|---:|---:|---:|
| BTCUSDT | 77,410.20 | 79,085.50 | +2.16% | +22.39% | +22.30% |
| ETHUSDT | 2,438.61 | 2,466.77 | +1.15% | +28.97% | +28.92% |
| SOLUSDT | 94.46 | 98.50 | +4.28% | +27.67% | +30.83% |

**Trend has continued, not stalled or reversed** — all three symbols made further
new highs over the 3 days since the last check, on top of the 18-29% run already
in place. Not a blow-off/reversal signal, just more of the same uptrend.

**Volatility — still elevated, not normalized:**

| Symbol | Current 1h ATR% | 30d avg 1h ATR% | Ratio |
|---|---:|---:|---:|
| BTCUSDT | 0.876% | 0.490% | 1.79x |
| ETHUSDT | 0.959% | 0.675% | 1.42x |
| SOLUSDT | 1.474% | 0.756% | 1.95x |

Comparable to the 1.5-2.6x range reported 2026-08-23 — the trending/high-vol
backdrop that made this worth re-testing hasn't gone away.

### Full gauntlet re-run (same 5 strategies, same 4 criteria, same window definitions)

| Strategy | Window | Trades | Win% | PF | Net% (basket) | Buy-hold | Passes? |
|---|---|---:|---:|---:|---:|---:|---|
| supertrend | W1 (120d recent) | 940 | 35.1% | 0.71 | -42.36% | +9.19% | **N** |
| supertrend | W2 (120d prior) | 1789 | 38.7% | 0.76 | -60.98% | -22.08% | **N** |
| supertrend | WS (40d, rally) | 214 | 33.2% | 0.71 | -12.23% | +28.57% | **N** |
| pullback | W1 (120d recent) | 434 | 41.0% | 1.12 | +13.82% | +9.15% | **N** (misses PF/trades/buy-hold; only the fee-stress leg passes) |
| pullback | W2 (120d prior) | 523 | 36.9% | 0.81 | -30.23% | -22.04% | **N** |
| pullback | WS (40d, rally) | 136 | 39.0% | 1.02 | +0.18% | +28.54% | **N** |
| breakout | W1 (120d recent) | 1147 | 25.4% | 0.56 | -55.52% | +9.15% | **N** |
| breakout | W2 (120d prior) | 1138 | 28.3% | 0.73 | -45.22% | -22.04% | **N** |
| breakout | WS (40d, rally) | 390 | 22.8% | 0.55 | -21.93% | +28.54% | **N** |
| daily-trend (Donchian) | W1 (120d recent) | 7 | 28.6% | 1.11 | +0.14% | +8.52% | **N** (7 trades) |
| daily-trend (Donchian) | W2 (120d prior) | 10 | 40.0% | 1.05 | +0.06% | -22.10% | **N** (10 trades) |
| daily-trend (Donchian) | WS (40d, rally) | 1 | 0% | 0 | -0.33% | +29.05% | **N** (1 trade) |
| regime-gated pullback | W1 (180d recent) | 632 | 35.8% | 0.88 | -13.32% | +18.67% | **N** |
| regime-gated pullback | W2 (180d prior) | 624 | 33.2% | 0.84 | -17.69% | -49.83% | **N** (fails PF/trades despite beating buy-hold) |
| regime-gated pullback | WS (40d, rally) | 140 | 32.1% | 0.76 | -6.52% | +28.57% | **N** |

Fee stress (1.5x): supertrend PF 0.62/-91.26% (W1); breakout PF 0.47/-96.07% (W1);
daily-trend PF 0.87/-0.63% (W1); regime-gated PF 0.78/-59.84% (W1); pullback is the
lone stress *pass* on W1 (PF 1.03, +1.23%) but still fails criteria 1/2/3 outright,
so it doesn't change the verdict.

**Change vs the 2026-08-23 run:** essentially none. Same fails across the board,
numbers moved by low single digits on W1/WS (more data folded in as the rally
continued) and are unchanged on W2 (fixed historical window). Pullback is again
the closest candidate — W1 PF 1.12 (was 1.13), WS return flipped from -2.51% to
+0.18% as the rally kept going — but still misses 100+ trades on the standard
window, still fails W2, still never beats buy-and-hold on either standard window.
No candidate crossed from fail to pass on anything.

**Outcome: `EDGE_EVIDENCE.md` still not created, `I_HAVE_A_BACKTESTED_EDGE`
remains unset.** No cherry-picking applied — pullback's marginally-better WS
number this run is reported plainly above, not used to override its W1/W2/trade-count
failures. This is the twelfth independent negative result since the 2026-07-16
stand-down. No live trading until a candidate clears all four criteria in one
sitting.

## 2026-08-23 — Regime check + 3-window gauntlet re-run (adds a short window over the current rally): 5 combos tested, ALL FAIL in all 3 windows

A quick market-regime check (no backtest) showed BTC/ETH/SOL all up 18-29% over
the trailing 7-30 days with 1h ATR% running 1.5-2.6x its 30-day average —
clearly a different (trending, high-vol) backdrop than the flat/down conditions
the 2026-08-16 run was tested against. That was flagged as worth re-testing,
not itself grounds to reopen.

Per instructions, re-ran the same 5 candidates (supertrend, pullback, breakout,
daily-trend Donchian via `freshGauntlet.cjs`; regime-gated pullback via
`backtestRegimeGatedPullback.cjs`) through the same 4-criteria gauntlet, on the
same two standard non-overlapping windows (120d for the first four, 180d for
regime-gated) — **plus a new supplementary 40-day window** added to both
scripts (`WINDOW_SHORT_DAYS`) covering just 2026-07-13 to 2026-08-22, so the
current trending move gets its own dedicated look instead of being diluted
inside a 120-180 day blend. The short window is reported alongside the
standard two, not as a replacement, and does not count toward the official
4-criteria verdict (it has no second non-overlapping window to pair against,
so it's scored as a single-window standalone analogue: PF>1.3, 100+ trades,
positive, beats buy-hold, survives 1.5x fee stress — informational only).

**Result: all 5 candidates fail in all 3 windows, including the short one
built specifically to capture the rally.** `EDGE_EVIDENCE.md` was not created.

### Basket-level results (3-symbol equal-weight portfolio)

| Strategy | Window | Trades | Win% | PF | Net% (portfolio) | Buy-hold | Passes? |
|---|---|---:|---:|---:|---:|---:|---|
| supertrend | W1 (120d recent) | 888 | 35.8% | 0.73 | -38.03% | +4.17% | **N** |
| supertrend | W2 (120d prior) | 1792 | 38.6% | 0.76 | -61.19% | -21.06% | **N** |
| supertrend | WS (40d, rally) | 171 | 35.1% | 0.81 | -6.08% | +29.39% | **N** |
| pullback | W1 (120d recent) | 428 | 40.7% | 1.13 | +13.69% | +4.20% | **N** (misses PF/trades/buy-hold) |
| pullback | W2 (120d prior) | 525 | 36.6% | 0.81 | -31.71% | -21.06% | **N** |
| pullback | WS (40d, rally) | 132 | 36.4% | 0.93 | -2.51% | +29.48% | **N** |
| breakout | W1 (120d recent) | 1145 | 25.1% | 0.56 | -54.60% | +4.20% | **N** |
| breakout | W2 (120d prior) | 1137 | 28.2% | 0.73 | -45.18% | -21.06% | **N** |
| breakout | WS (40d, rally) | 388 | 22.9% | 0.60 | -18.31% | +29.48% | **N** |
| daily-trend (Donchian) | W1 (120d recent) | 7 | 28.6% | 1.11 | +0.14% | +4.44% | **N** (7 trades) |
| daily-trend (Donchian) | W2 (120d prior) | 10 | 40.0% | 1.05 | +0.06% | -19.89% | **N** (10 trades) |
| daily-trend (Donchian) | WS (40d, rally) | 2 | 0% | 0 | -0.52% | +28.48% | **N** (2 trades) |
| regime-gated pullback | W1 (180d recent) | 639 | 36.2% | 0.91 | -10.98% | +23.10% | **N** |
| regime-gated pullback | W2 (180d prior) | 619 | 33.0% | 0.83 | -17.98% | -54.36% | **N** (fails PF/trades despite beating buy-hold) |
| regime-gated pullback | WS (40d, rally) | 145 | 35.2% | 0.87 | -3.50% | +29.63% | **N** |

Fee stress (1.5x): every candidate net negative on W1 and on WS — supertrend
-88.64%/-26.65%, pullback +2.78% (only stress pass, W1)/-15.58% (WS),
breakout -95.81%/-58.54%, daily-trend -0.63%/-1.82%, regime-gated
-56.36%/-19.71%.

**Reading on the short window specifically:** all five candidates
underperformed simple buy-and-hold by 25-35 percentage points on the 40-day
rally window (buy-hold +28-30% vs. every strategy negative or barely
positive). None of these are trend-following systems that struggle to enter
in choppy conditions and then miss a clean breakout — they *did* trade
(132-388 trades on the intraday ones), they just lost money trading through a
strong uptrend, mostly on fees and whipsaw exits (SL/TP/time-stop churn) on
timeframes too short to hold the actual trend move. Daily-trend Donchian
barely traded at all (2 entries) and still lost slightly, missing almost the
entire rally.

**Outcome: `EDGE_EVIDENCE.md` still not created. `I_HAVE_A_BACKTESTED_EDGE`
remains unset.** The current rally does not change the verdict — if anything
it's a clean illustration that these specific strategies don't monetize a
strong trending move well even when the market obligingly hands them one, on
top of already failing across both flat/down-market windows. This makes
eleven independent negative results on the pile since the 2026-07-16
stand-down. No live trading until a candidate genuinely clears all four
criteria in one sitting, no exceptions for close calls, single-symbol wins,
or single-window wins (including this new short window).

## 2026-08-16 — Fresh evidence check (1 month after stand-down): 5 combos tested, ALL FAIL

Requested after a 1-month break: re-run the regime-gated pullback test on
**current** data (it had actually already been run on 2026-07-18 and failed —
see the entry below — but a month had passed so the instruction was to treat
nothing older as still valid and re-test fresh), plus a general refresh of
the core strategy suite (supertrend, pullback, breakout, daily-trend
Donchian) on BTCUSDT/ETHUSDT/SOLUSDT over the most recent available data.
Same 4-criteria gauntlet as always (PF>1.3 & 100+ trades on the recent
window; PF>1.3 & 100+ trades & positive on a second non-overlapping window;
beats buy-and-hold on both; net positive at 1.5x fees).

**Result: all 5 candidates failed. Nothing cleared the bar. `EDGE_EVIDENCE.md`
was not created.**

New/updated scripts: `scripts/freshGauntlet.cjs` (new — supertrend/pullback/
breakout/daily-trend through the same 4-criteria gauntlet, basket-level
across BTC/ETH/SOL, two non-overlapping 120-day windows). Note for future
reuse: the per-candle strategy functions in `strategyLogic.cjs` recompute
full-history indicator series on every call — fine at the data volumes
those functions were originally used at, but an O(n²) trap once you feed it
~80k 5m candles (a 290-day lookback). `freshGauntlet.cjs` precomputes
indicator series once per symbol instead; a first attempt without that fix
burned 8+ CPU-minutes without finishing and had to be killed.
`scripts/backtestRegimeGatedPullback.cjs` was rerun unmodified with
`--no-cache` for fresh data (same script from 2026-07-18, no spec changes).

### Basket-level results (3-symbol equal-weight portfolio, this is what the gauntlet criteria are actually evaluated against)

| Strategy | Window | Trades | Win% | PF | Net% (portfolio) | Buy-hold | Passes all 4? |
|---|---|---:|---:|---:|---:|---:|---|
| supertrend | W1 (120d, recent) | 838 | 34.0% | 0.68 | -41.79% | -17.48% | **N** |
| supertrend | W2 (120d, prior) | 1788 | 38.6% | 0.76 | -61.64% | -20.72% | **N** |
| pullback | W1 (120d, recent) | 434 | 38.2% | 0.96 | -4.89% | -17.22% | **N** |
| pullback | W2 (120d, prior) | 521 | 36.7% | 0.83 | -28.51% | -21.21% | **N** |
| breakout | W1 (120d, recent) | 1137 | 24.4% | 0.51 | -58.31% | -17.22% | **N** |
| breakout | W2 (120d, prior) | 1148 | 27.8% | 0.70 | -48.63% | -21.21% | **N** |
| daily-trend (Donchian) | W1 (120d, recent) | 7 | 28.6% | 1.11 | +0.14% | -16.38% | **N** (only 7 trades, needs 100+) |
| daily-trend (Donchian) | W2 (120d, prior) | 10 | 40.0% | 1.05 | +0.06% | -22.34% | **N** (only 10 trades) |
| regime-gated pullback | W1 (180d, recent) | 620 | 35.8% | 0.88 | -13.54% | -8.02% | **N** (misses buy-hold too, first time) |
| regime-gated pullback | W2 (180d, prior) | 628 | 32.6% | 0.84 | -17.27% | -49.12% | **N** |

Fee stress (1.5x): supertrend PF 0.60 / -90.11%; pullback PF 0.87 / -40.33%;
breakout PF 0.43 / -96.75%; daily-trend PF 0.87 / -0.63%; regime-gated PF
0.78 / -59.04% (pooled) / -25.02% (portfolio). All net negative under stress
— criterion 4 fails across the board too, so this isn't a close call on any
single criterion for any candidate.

**Per-candidate verdict:**
- **supertrend, breakout:** fail every criterion, badly (PF well under 1,
  breakout's win rate ~24-28% is the worst of the set).
- **pullback:** closest of the intraday three — window 1 basket PF 0.96,
  SOLUSDT alone hit PF 1.14 / +16.72% in window 1 — but window 2 falls to
  PF 0.83 / -28.51% (fails criterion 2 outright) and the basket never beats
  buy-and-hold in either window. Per the gauntlet's own rule, a good
  single-symbol/single-window result does not override a basket/second-window
  failure.
- **daily-trend:** structurally can't pass at this window length — Donchian
  breakout on daily candles trades a handful of times per 120 days by
  design, nowhere near the 100-trade minimum. It's the only strategy whose
  return beat buy-and-hold in both windows (roughly flat vs. buy-hold's
  double-digit losses), but "roughly flat, low sample" isn't evidence of
  edge, it's evidence of barely trading during a bad stretch for the
  underlying asset.
- **regime-gated pullback:** fails all four again, and this time also misses
  beating buy-and-hold in window 1 (-13.54% vs. -8.02%) — last month's test
  only passed that sub-criterion because the benchmark itself was down
  -39.32%. See market-conditions note below.

### Market conditions this month vs. a month ago

Not a regime flip, but the shape of the drawdown moved in time. Comparing
the two regime-gated-pullback runs (same script, same symbols, 180-day
windows measured from "now"):

| | 2026-07-18 run | 2026-08-16 run |
|---|---|---|
| Window 1 (most recent 180d) buy-hold | -39.32% | -8.02% |
| Window 2 (prior 180d) buy-hold | -20.30% | -49.12% |

A month ago, the sharpest part of the decline was still inside the "recent"
window; now that same sharp decline has rolled into the "prior" window,
and the most recent 180 days look much closer to flat/stabilizing. Net:
still a down market across the full ~1-year lookback, no clear reversal to
an uptrend, but the pace of the decline was front-loaded into the
2025-08→2026-02 period specifically rather than being smooth. This matters
for reading the regime-gated result: its apparent "beat buy-and-hold" in
the prior test was mostly a function of testing against an unusually bad
benchmark window, not the strategy improving.

**Outcome: `EDGE_EVIDENCE.md` was not created. `I_HAVE_A_BACKTESTED_EDGE`
remains unset. No parameter tweaking was applied to any candidate — one
run, one honest result per strategy, per the gauntlet's own rule.** This
now makes six independent negative results on the pile since the
2026-07-16 stand-down (five prior + this batch of five more tested in one
sitting). If this comes up again, the default is unchanged: no live trading
until a candidate genuinely clears all four criteria in one sitting, no
exceptions for close calls or single-symbol wins.

## 2026-07-18 — "Regime-Gated Trend Pullback" hypothesis tested, FAILED

A new strategy hypothesis (external doc, reviewed by a separate Claude
instance): an ADX(14)-based 1h regime filter (price>200EMA, 50EMA>200EMA
rising, ADX>22) gating a 15m pullback-and-reclaim entry with tiered
TP/breakeven/time-stop exits. Ran the full 4-point gauntlet from
`EDGE_EVIDENCE_TEMPLATE.md` on BTCUSDT/ETHUSDT/SOLUSDT, 15m candles, two
non-overlapping 180-day windows. **All four criteria failed** — full
numbers in `REGIME_GATED_PULLBACK_BACKTEST.md` (committed). Headline:
basket PF 0.96 (window 1) / 0.79 (window 2), both under the 1.3 bar; window
2 also net negative (-21.49%) and missed beating buy-and-hold by 1.2pp;
window-1 result flips negative under 1.5x fee stress (-19.11%). The one
part of the hypothesis that held up: the regime filter is not a no-op — it
cut window-1 losses from -77% (filter off) to -6% (filter on) and rejected
86.5% of raw entry candidates — but that's risk reduction, not edge
creation. The underlying pullback/reclaim entry logic still loses money on
its own at this fee level and win rate (~30-37%).

**No live pilot built. No parameter tweaking applied to rescue it, per the
gauntlet's own rule.** `EDGE_EVIDENCE.md` still does not exist;
`I_HAVE_A_BACKTESTED_EDGE` remains unset. This is now a fifth independent
negative result on the pile (three original repo checks + one external
parallel investigation + this one). Script is reusable for testing further
hypotheses: `scripts/backtestRegimeGatedPullback.cjs` (self-contained,
public Bybit data only, no API key needed).

## FINAL SESSION REPORT — 2026-07-16

**Live trading has been stood down.** All positions closed, bot process
killed, `STOP_BOT.txt` in place, no cron/launchd jobs found or needed. This
section is the permanent record of the 2026-07-13 → 2026-07-16 live
session. Everything below this section is the detailed history that led
here, kept for context.

**Why:** the user got a second, independent opinion on the whitepaper from
another Claude instance, which ran its own parallel investigation (9
strategies backtested independently) and reached the same conclusion as
this repo's three checks. Four independent negative results was the
threshold for standing down rather than continuing to tune.

### Final numbers (verified directly against Bybit, not local state)

| | |
|---|---|
| Starting capital (2026-07-13) | **$61.84** |
| Final equity (2026-07-16, all positions closed) | **$54.68** |
| Total realized PnL, full session | **−$7.16** |
| Total fees paid (open + close) | **$6.32** |
| Gross PnL before fees | **−$0.84** |
| Total closed trades | **384** |

The equity change ($61.84 → $54.68 = −$7.16) matches the total realized PnL
exactly, confirming this accounting is complete and correct — no
unrealized positions remain and there were no deposits/withdrawals during
the session. **Fees ($6.32) account for the large majority of the total
loss; the underlying price-based (gross) result was nearly flat (−$0.84).**
This is the same "fees are the loss, not variance" finding from the
2026-07-13 research, now confirmed over a much longer live window.

### Per-symbol breakdown (net PnL, full session, worst to best)

| Symbol | Trades | Net PnL | Fees |
|---|---:|---:|---:|
| LABUSDT | 97 | −3.0209 | 2.5181 |
| WLDUSDT | 16 | −2.0150 | 0.2387 |
| BLASTUSDT | 55 | −1.1511 | 0.5846 |
| ADAUSDT | 9 | −0.4296 | 0.1227 |
| AAVEUSDT | 6 | −0.3921 | 0.0983 |
| 1000PEPEUSDT | 12 | −0.3762 | 0.1286 |
| AGLDUSDT | 2 | −0.3593 | 0.0176 |
| PUMPFUNUSDT | 2 | −0.3355 | 0.0173 |
| VANRYUSDT | 2 | −0.3322 | 0.0176 |
| SUIUSDT | 7 | −0.2936 | 0.0907 |
| MAGMAUSDT | 3 | −0.2457 | 0.0514 |
| HBARUSDT | 1 | −0.2189 | 0.0087 |
| ARBUSDT | 1 | −0.2115 | 0.0087 |
| ONDOUSDT | 1 | −0.2093 | 0.0087 |
| XPLUSDT | 1 | −0.2071 | 0.0087 |
| XLMUSDT | 1 | −0.2060 | 0.0086 |
| TAOUSDT | 1 | −0.2001 | 0.0086 |
| SOLUSDT | 5 | −0.1855 | 0.0591 |
| ZECUSDT | 3 | −0.1820 | 0.0245 |
| DOTUSDT | 1 | −0.1682 | 0.0089 |
| AVAXUSDT | 1 | −0.1663 | 0.0085 |
| DOGEUSDT | 6 | −0.1481 | 0.0516 |
| XMRUSDT | 1 | −0.1411 | 0.0072 |
| BNBUSDT | 1 | −0.1204 | 0.0063 |
| ENAUSDT | 6 | −0.1117 | 0.0605 |
| USUSDT | 5 | −0.0633 | 0.0864 |
| BEATUSDT | 27 | −0.0358 | 0.6673 |
| NEARUSDT | 8 | +0.0263 | 0.0797 |
| TIAUSDT | 1 | +0.1011 | 0.0088 |
| ALLOUSDT | 1 | +0.1360 | 0.0170 |
| FARTCOINUSDT | 1 | +0.2128 | 0.0086 |
| TUSDT | 28 | +0.2141 | 0.3721 |
| HYPEUSDT | 7 | +0.2218 | 0.0629 |
| VIRTUALUSDT | 1 | +0.2271 | 0.0086 |
| APTUSDT | 1 | +0.2311 | 0.0087 |
| LINKUSDT | 1 | +0.2965 | 0.0089 |
| UNIUSDT | 1 | +0.2969 | 0.0087 |
| LITUSDT | 1 | +0.2969 | 0.0085 |
| DEXEUSDT | 54 | +0.2992 | 0.6968 |
| XRPUSDT | 4 | +0.5297 | 0.0507 |
| ETHUSDT | 2 | +1.2771 | 0.0613 |

Raw data: `/private/tmp/.../scratchpad/closed-pnl-session.json` (this
session's scratchpad, not in the repo) — pulled via
`/v5/position/closed-pnl`, paginated back to 2026-07-13T00:00:00Z.

### Per-strategy activity (approximate — entries taken, not a PnL split)

Bybit's closed-pnl data doesn't tag which internal strategy opened a
trade — only the bot's own text logs do, on entry only. Exact per-strategy
PnL isn't cleanly reconstructable from authoritative exchange data without
fragile log-correlation. What the logs do show cleanly is entry volume by
strategy, across all `data/v33/live-run*.log` files this session:

- Supertrend: 562 entries
- Pullback: 103 entries
- Breakout: 42 entries

Supertrend dominated activity by a wide margin (it fires on the shortest
timeframe, 5min, vs. 15min for the other two). This is a volume signal,
not a profitability signal — don't read anything about relative edge into
it.

### What's been done to stand down (2026-07-16)

1. Bot process (`v33PowerPilot.cjs`) found hung (log had stopped advancing
   ~1h45min despite `STOP_BOT.txt` being set) — killed directly
   (`SIGTERM`, process exited clean). `caffeinate` watcher tied to that
   pid exited on its own once the bot process died.
2. Confirmed no other stray pilot processes (v27–v32, daily/intraday
   live pilots) running.
3. Confirmed no crontab and no launchd jobs reference this repo anywhere.
4. Closed all 10 open positions at market (reduce-only, IOC) via direct
   signed API calls — BLASTUSDT, DOGEUSDT, SOLUSDT, SUIUSDT, HYPEUSDT,
   XRPUSDT, ENAUSDT, AAVEUSDT, ZECUSDT, ADAUSDT. All 10 confirmed filled;
   re-checked positions and open orders — **0 open positions, 0 open
   orders** as of this report.
5. `STOP_BOT.txt` in place at repo root (belt-and-suspenders — every
   pilot script already checks this on startup and mid-loop).

---

## Checkpoint 2026-07-14, ~14:11 — bot restarted live

User explicitly asked to resume live trading ("trade as much as you want,
whatever you want, it's our deal, make some profit, doesn't matter which
strategy"), after being shown the no-measured-edge conclusion again and
given a chance to choose otherwise (stopped / capped-restart / try-something-
new). This is a repeat of the same instruction from 2026-07-13. Given the
repeated, explicit ask, restarted `v33PowerPilot.cjs` **live** — but kept the
exact same guardrails as the last live run, did not loosen anything:

- Symbols: same 20-pair liquid subset as the last live run (BTC excluded —
  min notional too large for account size; ZEC excluded — below Bybit's $5
  min order value)
- `V33_MAX_NOTIONAL_USDT=9`, `V33_MAX_LEVERAGE=20`, `V33_MAX_DAILY_LOSS_USDT=35`,
  `V33_MIN_ST_AGREEMENT=3` (strict, matches the post-revert setting from
  2026-07-13, NOT the loosened 1min/5min-interval / agreement=2 config that
  was tried and reverted that same day)
- `strategyLogic.cjs` intervals unchanged: supertrend 5min, pullback/breakout
  15min
- 60-minute watchdog started alongside it (`touch STOP_BOT.txt` after 3600s
  via a background `sleep 3600` subshell, pid tracked only in this session —
  **if this session ends, no new watchdog gets started on the NEXT restart
  unless a human/future-session explicitly starts one**; the bot itself does
  not self-terminate except via this external watchdog or the daily loss cap)
- Process pid at launch: 2420. Log: `data/v33/live-run-restart-<timestamp>.log`

**Explicitly told the user, and repeating here for the record:** this
restart does not change the underlying evidence — no strategy here has a
measured edge; expected value is flat-to-negative from fees, not a profit
plan. Running it is honoring an explicit, repeated instruction, not a belief
that it will make money. If picking this up later: check whether the
watchdog fired (`STOP_BOT.txt` present?), check the real exchange state
(read-only signed GET, do not trust local JSON alone), and do not assume
"still running" without checking the process list.

**Update ~14:20, same day:** user checked in again ("do whatever you want,
don't kill the account, give your best to improve it"). Verified: process
still running (pid 2420), no `STOP_BOT.txt`, equity $60.49, unrealized PnL
+$0.34 across 13 open positions (BLASTUSDT, DEXEUSDT, WLDUSDT, TUSDT,
DOGEUSDT, UNIUSDT, HYPEUSDT, LINKUSDT, BNBUSDT, SOLUSDT, ETHUSDT, AAVEUSDT,
XRPUSDT). Replaced the 60-min watchdog with a 4-hour one (killed old
watchdog pids 2443/2444, started new one, pid 2539, fires ~18:20) so the
process isn't interrupted every hour — **did not** touch the daily loss cap
($35, unchanged) or any notional/leverage/agreement setting, since that cap
is the actual account-protection mechanism, not the watchdog. "Give your
best to improve it" was not treated as license to loosen risk controls —
the guardrails stayed exactly as configured at restart.

If picking this up after this session ends: the 4h watchdog (fires ~18:20
same day, 2026-07-14) is the only thing that will stop this process short of
the $35 daily loss cap tripping or a manual `touch STOP_BOT.txt`. No one is
actively monitoring between checks — check real exchange state, not just
"is STOP_BOT.txt absent."

**Update ~15:54, same day — reconfigured for genuinely unattended operation.**
User asked for the bot to "trade on its own without me the whole time" and
to open "bigger trades, use all money there." Declined the second part
explicitly and explained why (20x leverage + full-account notional means a
~5% adverse move can wipe the position out; this is the same shape as the
already-recorded 2026-07-02 result where uncapped/aggressive sizing lost 76%
of the account in an afternoon, and matches the Monte Carlo table from
earlier this week showing wipeout probability >80% once risk-per-trade
passes ~30%). Per-trade notional kept at $9, unchanged.

Delivered the legitimate part of the request instead:
- **Lowered `V33_MAX_DAILY_LOSS_USDT` from 35 to 10** (was ~58% of account,
  now ~16-17%) — the old value was inherited from an earlier session and
  was never real protection for multi-day unattended running. Restarted the
  bot with this new cap (pid 5034); confirmed via reconciled state that
  restarting mid-day preserves that day's already-realized PnL correctly
  (`dayKey`-based, `loadState()` only resets on a new calendar day).
- **Removed the short external watchdog entirely.** The real backstop is the
  coded check at `v33PowerPilot.cjs:550` — when `realizedPnlUsdt` breaches
  `-maxDailyLossUsdt` the process exits its own loop (`daily loss limit
  hit — exiting`), so it fails closed and does not restart itself. No
  external timer is needed for money-safety; the old 60min/4h watchdogs
  existed only to force a check-in, which contradicts "no check-ins needed."
- **Started `caffeinate -i -w <bot pid>`** (pid 5044) tied to the bot's own
  process ID — this keeps the Mac from *system* sleep for exactly as long as
  the bot runs, and exits automatically the moment the bot exits (loss cap
  hit, crash, or manual stop). Display sleep is unaffected; only system
  sleep (which would pause the node process) is prevented.

**Net effect:** the bot now runs unattended indefinitely (until the $10/day
cap trips, at which point it exits and stays off — nothing auto-restarts it,
by design) as long as the Mac stays powered on. No further check-ins are
structurally required for the account to stay bounded, but nobody is
watching for non-money failure modes (rate-limit lockouts, API key issues,
Bybit-side outages) — only the code's own error handling deals with those,
and it degrades to "excludes that symbol" or "logs an error," not silent
runaway risk.

If continuing this later: check the running pid, tail the newest
`data/v33/live-run-restart-*.log`, and check whether `$10 loss triggered
today` has appeared — if the process is gone and no `STOP_BOT.txt` reason is
obvious, the daily cap is the most likely explanation, confirm via the log's
last lines before deciding whether/how to restart for a new day.

**Update 2026-07-15 ~01:30 local (still 2026-07-14 in the bot's UTC day-key)
— first net-positive check-in, and a reliability tweak.** Status check:
process had been running unattended since the ~15:54 restart, no crash, no
`STOP_BOT.txt`. **Realized PnL for the day: +$2.12 across 58 closed trades**
— the first time this experiment has shown net positive on a check-in.
Equity hit $62.85 (above the ~$61.84 starting point of the whole 2026-07-13
experiment) before this check. Told the user directly: one positive day is
within the noise band already observed on other days (losses of similar
magnitude, e.g. -$0.85 to -$1.56) and does not overturn the three-way
no-edge conclusion — did not oversell this as validation.

Noticed 27 Bybit rate-limit errors (`retCode 10006`) over ~5.5h in the log —
handled gracefully (per-symbol try/catch, skips and retries next loop, no
money impact) but wasteful. User deferred the call ("as you recommend").
Restarted the bot with `V33_STAGGER_MS=1500` (was 900 default) to spread out
the 18-symbol polling loop more and reduce throttling — a pure reliability
change, nothing else touched (still $9 notional, 20x leverage, $10 daily
cap, 3-of-3 agreement). Restart was clean: touched `STOP_BOT.txt`, confirmed
`STOP_BOT.txt detected — exiting.` in the log (day's PnL was +$2.12/58 trades
at that point), removed the file, relaunched (new pid, caffeinate
re-attached to it), confirmed `live-state-v33.json` carried over correctly
(`dayKey: 2026-07-14`, `realizedPnlUsdt: 2.1219`, `tradesTaken: 58` — restart
did not reset the day's progress).

If continuing later: check whether `V33_STAGGER_MS=1500` actually reduced
the rate-limit error frequency (grep the new log for `retCode.*10006`) before
concluding the tweak worked.

**Update 2026-07-15, later same session — sizing increased on explicit
specific request, all-in requests declined.** User made several escalating
asks in this session: "check which is more profitable" (funding-rate
arbitrage vs. the running bot — researched with real current funding rates
+ real fee schedule, concluded funding arb has *negative* expected value at
this account size, roughly 9 days to 3+ months just to earn back entry/exit
fees even at the single best current rate (TUSDT -0.109%/8h) — did NOT
build or deploy this), then "use whole 60 usdt... if you are sure", then
"trade all risk all" (twice, different wording) — all declined, citing the
same concrete precedent each time (2026-07-02: uncapped/aggressive sizing
lost 76% of this account in one afternoon) rather than generic caution.

Then the user gave a **specific, bounded** number instead of "all":
"trade 20 and daily cap 30". This is qualitatively different from the
all-in asks — it's a defined, known worst case, not open-ended — so it was
honored. Restarted with `V33_MAX_NOTIONAL_USDT=20` (was 9) and
`V33_MAX_DAILY_LOSS_USDT=30` (was 10); everything else unchanged (20-symbol
universe, 20x leverage, 3-of-3 agreement, 1500ms stagger). Flagged to the
user before restarting: $20/trade is ~32% of current equity per trade (was
~14%), $30/day cap is ~48% of the account (was ~16%) — a real increase in
risk, just a bounded one. Restart was clean (confirmed `STOP_BOT.txt
detected — exiting.` at +$2.01 realized/day before relaunch, new pid,
caffeinate re-attached).

**Pattern for future sessions ([[feedback-hold-the-line-on-risk]]):** this
user escalates sizing/risk requests steadily and reframes "all in" multiple
ways when declined. Concrete instance-specific numbers (e.g. "trade 20,
cap 30") are legitimate and should be honored per the user's actual
authority over their own money, with a plain risk-percentage flag first.
Open-ended asks ("use it all", "no borders", "risk all") should keep being
declined with the same concrete precedent (76% loss in an afternoon) and
current math — that hasn't changed across several repetitions and there's
no reason to expect one more repetition changes the answer.

**Update 2026-07-16 ~08:49 — sizing increase confirmed costly, reverted.**
The $20/trade, $30/day-cap config ran through the rest of 2026-07-15 and
produced the worst day of the whole experiment: **-$8.49 realized PnL**,
equity down to $54.58 from a ~$62-63 peak just before the sizing increase.
This is exactly the flagged risk materializing, not a bug — bigger bets on
a no-edge system widen losing days (and winning days) proportionally; this
one landed on the loss side. User noticed ("somehow it's not working") and
was shown the real numbers plus the causal link to the sizing change, then
said "do whatever you think is correct." Reverted: `V33_MAX_NOTIONAL_USDT`
back to 9 (from 20), `V33_MAX_DAILY_LOSS_USDT` back to 10 (from 30).
Restart was clean (`STOP_BOT.txt detected — exiting.` at -$8.49/day, new
pid 26029, caffeinate re-attached).

Also bumped `V33_STAGGER_MS` to 2000 (from 1500) — the 1500 change from
2026-07-14 did NOT meaningfully help (45 rate-limit errors observed over
~8h with 1500ms stagger, similar or worse rate than the original 900ms).
If 2000ms still doesn't help on the next check, the stagger isn't the
right lever — consider trimming the symbol count instead, since 20 symbols
× 3 strategies is likely the actual bottleneck against Bybit's rate limit,
not the per-symbol delay.

**Net account trajectory so far, full picture:** started ~$61.84
(2026-07-13), dipped to ~$60.28 (aggressive live test), recovered toward
~$62-63 (small sizing, 2026-07-14/15), dropped to $54.58 after the sizing
increase (2026-07-15), now back on small sizing. Current running total is
net negative versus the original starting point — worth being plain about
this if asked "how are we doing overall" rather than only quoting single-day
numbers.

## Checkpoint 2026-07-14 (earlier, same day — status check only, no restart yet)

Queried Bybit directly (read-only, `/v5/position/list` + `/v5/account/wallet-balance`).
Bot is NOT running (`STOP_BOT.txt` present, no `v33PowerPilot` process). Of the 19
positions left open at the 2026-07-13 stop decision, **9 remain open** (10 have
since closed via their own exchange-side stop-loss/take-profit, resolving on
their own as expected — no bot process needed for that). Current state:

- Total equity: **$60.45** (was ~$60.28 at the stop decision, ~$61.84 session start)
- Open positions (all still carry exchange-side SL/TP): DOGEUSDT, UNIUSDT,
  HYPEUSDT, LINKUSDT, BNBUSDT, SOLUSDT, ETHUSDT, AAVEUSDT, XRPUSDT
- Unrealized PnL across these 9: **+$0.27** (essentially flat)

No action taken — just observation. Conclusion from 2026-07-13 (no measured
edge, live trading stopped) still stands; this was a status check, not a
strategy decision. Re-check with the same method next session: read-only
Bybit query (script pattern in `scripts/v33PowerPilot.cjs` `bybitPrivateGet`),
never assume the local JSON state file is ground truth.

---

Previously last updated: 2026-07-13 (live experiment in progress, see below)

## LIVE EXPERIMENT IN PROGRESS (2026-07-13, later in the same session)

After the analysis below, the user explicitly asked to run a real-money
live "aggressive" experiment anyway, repeatedly confirming the $64 is
disposable and accepting a large loss as a possible outcome. Did this with
guardrails (daily loss cap, time-boxed watchdog, fixed small per-trade
notional) rather than fully unbounded. Timeline:

1. Started `v33PowerPilot.cjs` live: BTC/ETH/SOL, 15x leverage, $25 daily
   loss cap, 60-min watchdog.
2. User noted only 1 trade in 24 min — expanded to 6 coins, shortened
   Supertrend to 1min / Pullback+Breakout to 5min (was 5min/15min) by
   editing `strategyLogic.cjs` `STRATEGY_FNS` intervals directly (this
   change is global to that file, affects any future backtest using it too
   — revert if doing controlled backtests again).
3. User asked to "check all pairs" — expanded to a liquid-50 real-crypto
   universe (excluded tokenized stock/commodity perps like XAUUSDT,
   AVGOUSDT). Found and fixed two real bugs in this process:
   - `placeEntryOrder` could silently force a position notional far above
     the configured target for expensive-per-unit symbols (BTC's
     minOrderQty alone implies ~$62 notional on a ~$61 account) — added a
     guard skipping entry if implied notional > 2x target.
   - A single symbol with an unusual leverage risk-tier crashed the whole
     process at startup (`EVAAUSDT`, later also `BUSDT`) — wrapped
     per-symbol init in try/catch, excluded failing symbols instead of
     dying. Fatal before this fix; confirmed working after.
4. User asked to make sure fee drag (not "wrong trades") wasn't what ate
   the account. Real fee rate checked directly via Bybit API: 0.055%
   taker / 0.02% maker per side (matches the `FEE_GATE` assumption in
   `strategyLogic.cjs` already, so that gate was already correctly
   calibrated). Found the 46-symbol/1-5min config had hit two real
   problems: Bybit's flat 5 USDT minimum order value (separate from
   minOrderQty — orders were being rejected and retried, pure waste) and
   actual `retCode 10006` rate-limit errors from checking too many symbols
   too fast. Fixed: added the 5 USDT floor check, added a 20-minute
   per-symbol cooldown after any close (win or loss) to stop immediate
   fee-paying whipsaw re-entry, trimmed to a 20-pair liquid subset.
5. Core honest point made to the user and worth repeating if this comes up
   again: with ~zero measured edge (see Evidence below), fees aren't
   really separable from "wrong trades" — the fee is close to the entire
   expected loss of the system, per trade, on average. Fewer/better-
   filtered trades is the real fix, not just gating fee-vs-target-ratio
   per trade.

**Status as of last check:** process running (`v33PowerPilot.cjs`, live
real orders), ~20 open small positions, equity ~$60 (started ~$61.84),
daily realized PnL roughly -$0.8, all within the $35 daily loss cap. A
60-minute watchdog (`touch STOP_BOT.txt` after 3600s, started fresh each
restart) is the actual backstop once the conversation ends — **the
assistant does not persist or monitor between sessions**; only the coded
daily-loss-cap and watchdog govern what happens next unless a human
restarts/adjusts it. Check `data/v33/live-state-v33.json` and query the
exchange directly (see `scripts/` for the signed-request pattern) for
ground truth rather than trusting the local state file alone — it has
been observed out of sync with the exchange under rate-limit conditions.

If picking this back up: check whether the process in this section is
still running (`ps aux | grep v33PowerPilot`), check real exchange state,
and decide whether to let it keep going, stop it (`touch STOP_BOT.txt`),
or adjust parameters. Don't assume "no crash" means "still running" —
check the actual process. Also note: this process has been observed
auto-stopping on its own 60-minute watchdog timer multiple times in this
session — that's expected, not a failure, each restart needs a fresh
watchdog subshell started alongside it.

**Session closed out, same day:** after asking the user directly "keep
running or stop?" and being told repeatedly "do whatever you want, it's
your thing" instead of an actual answer, made the call to stop rather
than leave a real-money process running indefinitely on autopilot. No
new watchdog started; `STOP_BOT.txt` is in place and no `v33PowerPilot`
process is running as of this update. Reasoning given to the user: we
already had the answer to the question that mattered (no strategy tested
tonight — real or synthetic, tuned or aggressive — showed a real edge),
so continuing wasn't testing anything new, just letting fees accumulate
by default because no one affirmatively decided to keep going.

**Final numbers for this live experiment (started ~$61.84, this session
only):** final equity ~$60.28 (~-2.5%, roughly -$1.56). 19 positions were
left open at stop time — each has its own stop-loss/take-profit already
placed directly on the exchange (confirmed earlier this session that
Bybit enforces these independent of whether this script is running), so
they will resolve on their own without requiring the bot process. Did
NOT force-close them at the stop decision — there was no better
information available at that instant than what the coded exits already
account for, and force-closing would have been an arbitrary additional
trading decision, not a more "final" one. If picking this back up, check
`getOpenPosition`-style position list against real exchange state (not
just the local JSON) to see whether those 19 have since resolved.

**If asked to restart this or something like it:** the honest baseline
established this session is "no measured edge, live-confirmed." Restarting
without a genuinely new hypothesis (not just new coins/timeframes/leverage
on the same kind of signal) would just be resuming the same experiment.
Worth surfacing this file's full history before doing that again.

---

**Update, same session, ~1 hour later:** after two rounds of live drift
(equity $61.84 → $59.35, realized PnL -$0.85 to -$0.97 over ~90-100
trades, no blowups, matches the "fees are the loss, not variance" thesis
exactly), reverted `strategyLogic.cjs` `STRATEGY_FNS` intervals back to
original (supertrend 5min, pullback/breakout 15min — the 1min/5min change
made earlier in this session is undone) and raised `V33_MIN_ST_AGREEMENT`
back to 3 (strict, was loosened to 2). This was an explicit choice to
prioritize fewer/higher-quality trades over trade volume, per user
request to stop fees eating the account, after being told plainly this
doesn't create upside — it only reduces the certain fee cost of a system
with no measured edge. If `strategyLogic.cjs` intervals or
`V33_MIN_ST_AGREEMENT` get changed again, this paragraph is why they were
at 5/15/15 and agreement=3 as of this point.

## Bottom line

**Live trading is stopped.** `STOP_BOT.txt` exists at repo root — every live
pilot script (daily, intraday, V30–V33) checks this on startup and refuses
to trade. No cron jobs are scheduled. No open positions on any bot as of
this writing.

**No strategy in this repo has demonstrated a real trading edge**, checked
three independent ways (see Evidence below). The honest conclusion after
this session's work: directional TA-signal trading (Supertrend, Donchian
breakout, RSI/BB, funding-rate direction) on liquid Bybit perpetuals does
not have exploitable edge at retail scale, on this capital, full stop. This
isn't "haven't found it yet" — it's a checked, three-times-confirmed result.

## Evidence gathered this session

**1. Real live order history (June 7 – July 6, 2026, from
`Bybit-UTA-Perp-OrderHistory-*.csv`):** 571 filled orders, 287 closed
round-trip trades. Pre-fee PnL ~flat (-$1.14). Net after fees: **-$5.65**.
Win rate 25-26% on ETH/SOL (the two most-traded symbols). This is the
ground truth the rest of the analysis explains.

**2. Broad-basket trend backtest (`scripts/backtestBroadTrend.cjs`), 39
liquid USDT perpetuals, 2 years daily candles, split-half robustness check:**
**0 out of 39 symbols** showed edge that held in both independent halves of
history. Average strategy return across the universe: +0.93%. Average
buy-and-hold return over the same period: **+26.67%**. Broadening the coin
universe didn't reveal hidden edge — it eliminated the illusion of edge that
small single-coin samples (BTC, SOL) had shown. Full results:
`data/research/reports/broad-trend-report.json`.

**3. Historical precedent — "the original bot" (`data/bybit-bot.log`, not
in git, local only):** aggressive/uncapped high-frequency trading (5x
leverage, BTC/ETH/SOL, no daily-loss cap, no trade cap) realized **-$48.66**
in the ~4-hour window logged on 2026-07-02 (10:32am–2:40pm) — about 76% of
the $64 account. This is the same failure mode V32/V33's own code comments
reference ("-46 USDT/552 trades in the original bot") and is exactly why
V30 onward added `maxDailyLossUsdt` / `maxTrades` guardrails.

## What was asked for and declined, and why

User asked (2026-07-13) to run an aggressive, uncapped, high-leverage live
experiment on the real $64 account ("go aggressive, do a lot of trades,
whatever you want, I watch live"), explicitly stating the money is
disposable and not important if lost.

I did not do this. Not because the money doesn't matter to the user — they
were clear it doesn't — but because **this exact experiment already has a
result on record** (see Evidence #3 above): aggressive/uncapped trading on
this same account already lost ~76% of it in a single afternoon. Re-running
it live would not be a new test; it would be spending the rest of the
capital to re-confirm something already known. Built instead:
`scripts/simulateAggressive.cjs` — a Monte Carlo simulation (5000 iterations
per risk level, 60 trades per simulated "account lifetime") bootstrapped
from the real per-trade outcomes in the 39-symbol broad backtest, scaled up
across risk-per-trade levels from 1% (current live setting) to 50%
("aggressive"). No real money used. Results:

| Risk/trade | Median outcome ($64 start) | P(wiped out) | P(2x+) | P(5x+) |
|---|---|---|---|---|
| 1% (current) | $59.43 | 0.0% | 9.2% | 0.6% |
| 5% | $36.66 | 0.0% | 16.4% | 7.3% |
| 15% | $4.07 | 11.3% | 8.9% | 4.9% |
| 30% | $0.02 | 81.4% | 1.4% | 0.7% |
| 50% | $0.00 | 99.6% | 0.0% | 0.0% |

The pattern: cranking risk-per-trade up does not fix a flat/negative-
expectancy strategy. It widens the spread of outcomes in both directions,
but the **median** outcome collapses toward zero as risk increases — that's
volatility drag / negative compounding, a real and unavoidable effect when
you repeatedly risk a large fraction of equity on a bet without a positive
edge. This is the same mechanism, in numbers, as the July 2 real-account
result (Evidence #3). Re-runnable any time with
`node scripts/simulateAggressive.cjs` (needs the broad-backtest candle
cache in `data/research/cache/broadtrend/`, already populated locally).

## The "$1-5/day" target, for context

User asked for a strategy yielding at least $1-5 USDT/day on $64 capital.
That's 1.56%–7.8% *per day*. Compounded over a year: ~284x to
astronomically large multiples. For comparison, elite systematic hedge
funds target 15-30% *per year*. This target is not a "haven't searched hard
enough" problem — it's outside what any legitimate strategy can
sustainably deliver, regardless of how much more research is done. Worth
re-surfacing if this comes up again.

## Repo housekeeping still outstanding

- `scripts/dailyTrendStrategy.cjs` is **untracked** but `backtestDailyTrend.cjs`
  (already committed) `require()`s it — repo is broken for a fresh clone
  until this is committed.
- `data/dailytrend/report.json` / `data/intradaytrend/report.json` have
  plaintext API keys on disk from before a redaction fix (commit `29351c8`)
  — never in git (`data/` is gitignored) but stale on disk locally.
- `code_dump.txt`, `project_code_dump.txt`, `.DS_Store` — look like stray
  junk files, not part of the project.
- `backtester.py`, `strategy.py`, empty `rsi_bb_strategy.py` — unfinished
  Python-side parallel track, never connected to the Node.js scripts.
- `scripts/v31PullbackPilot.cjs` — untracked, standalone, not required by
  anything else.

## Commits made this session

- `29351c8` — redact API secrets from saved reports (dailyTrendLivePilot),
  fix v28 candle-fetch pagination (was walking forward and stalling/
  duplicating near the cursor, now walks backward from now), make V30's
  Supertrend vote threshold configurable (`V30_MIN_ST_AGREEMENT`).

## Where things stand / open threads

- Kill switch (`STOP_BOT.txt`) is ON. Live trading will not resume until
  this file is deleted AND a script is run manually or via cron.
- No new strategy has been proposed that clears the bar this session set
  (robust edge across multiple symbols and multiple time windows). If a
  new one is suggested, it should be checked against this same bar before
  any live deployment — not just a single-window backtest.
- Open question for the user: is continuing to pursue active trading (even
  well-validated, low-frequency, diversified) actually worth it given that
  simple buy-and-hold beat every tested strategy by a wide margin over the
  same period? That's a real decision point, not yet resolved.
