"""
strategy.py — RSI + Bollinger Band mean-reversion strategy with a fee-aware
"edge gate" and a trend filter.

Key change from the previous version: this strategy will NOT return a trade
signal just because RSI/BB conditions are met. It first estimates whether the
expected move is even large enough to plausibly clear round-trip costs
(spread + taker fees + slippage buffer). If not, it returns HOLD. This is the
mechanism that was missing before — it's why the old bot could show a low win
rate: it was taking every marginal setup regardless of whether there was
enough room to profit after costs.

This module makes NO network calls and places NO orders. It is pure signal
logic so it can be unit-tested and backtested before being wired into any
execution code.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class Signal(Enum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"


@dataclass
class StrategyConfig:
    rsi_period: int = 14
    rsi_oversold: float = 30.0
    rsi_overbought: float = 70.0
    bb_period: int = 20
    bb_std_dev: float = 2.0

    # Trend filter: only take mean-reversion LONGs above this EMA, and
    # mean-reversion SHORTs below it. Sideways/ranging markets are where
    # mean reversion actually has a chance; strong trends are where it
    # historically got destroyed (this was flagged as a risk earlier).
    trend_ema_period: int = 200
    use_trend_filter: bool = True

    # Fee-aware edge gate. Bybit UTA perp taker fee is commonly ~0.055%
    # (5.5 bps) per side, so a round trip is ~11 bps. Set generously to
    # avoid re-creating the fee-death problem from before.
    taker_fee_bps: float = 11.0       # round-trip, both legs
    slippage_buffer_bps: float = 3.0  # cushion for market impact/slippage
    min_edge_multiple: float = 1.5    # expected move must be >= costs * this

    stop_loss_pct: float = 0.02       # 2%
    take_profit_pct: float = 0.04     # 4% (keeps a >=1:1 reward:risk shape)

    # Position sizing: risk this fraction of account equity per trade,
    # sized off distance to stop-loss (not a flat % of capital in one
    # order, which is what made "put it all in" so dangerous earlier).
    risk_per_trade_pct: float = 0.01  # 1% of equity risked per trade


@dataclass
class SignalResult:
    signal: Signal
    reason: str
    rsi: Optional[float] = None
    bb_upper: Optional[float] = None
    bb_lower: Optional[float] = None
    bb_mid: Optional[float] = None
    expected_move_bps: Optional[float] = None
    cost_bps: Optional[float] = None
    suggested_stop_loss: Optional[float] = None
    suggested_take_profit: Optional[float] = None


def _sma(values: list[float], period: int) -> float:
    window = values[-period:]
    return sum(window) / len(window)


def _stdev(values: list[float], period: int, mean: float) -> float:
    window = values[-period:]
    variance = sum((v - mean) ** 2 for v in window) / len(window)
    return variance ** 0.5


def _ema_series(values: list[float], period: int) -> list[float]:
    if len(values) < period:
        return []
    k = 2 / (period + 1)
    ema = [sum(values[:period]) / period]
    for price in values[period:]:
        ema.append(price * k + ema[-1] * (1 - k))
    return ema


def compute_rsi(closes: list[float], period: int) -> Optional[float]:
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(-period, 0):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def compute_bollinger(closes: list[float], period: int, std_dev: float):
    if len(closes) < period:
        return None, None, None
    mid = _sma(closes, period)
    sd = _stdev(closes, period, mid)
    return mid + std_dev * sd, mid, mid - std_dev * sd


class RSIBollingerStrategy:
    def __init__(self, config: StrategyConfig | None = None):
        self.config = config or StrategyConfig()

    def generate_signal(self, closes: list[float]) -> SignalResult:
        cfg = self.config
        min_needed = max(cfg.rsi_period + 1, cfg.bb_period, cfg.trend_ema_period if cfg.use_trend_filter else 0)
        if len(closes) < min_needed:
            return SignalResult(Signal.HOLD, reason=f"insufficient history ({len(closes)}/{min_needed} bars)")

        rsi = compute_rsi(closes, cfg.rsi_period)
        bb_upper, bb_mid, bb_lower = compute_bollinger(closes, cfg.bb_period, cfg.bb_std_dev)
        price = closes[-1]

        trend_ok_long = trend_ok_short = True
        if cfg.use_trend_filter:
            ema_series = _ema_series(closes, cfg.trend_ema_period)
            if not ema_series:
                return SignalResult(Signal.HOLD, reason="insufficient history for trend filter")
            trend_ema = ema_series[-1]
            trend_ok_long = price >= trend_ema
            trend_ok_short = price <= trend_ema

        cost_bps = cfg.taker_fee_bps + cfg.slippage_buffer_bps

        # Candidate LONG: price at/below lower band, RSI oversold, uptrend (or filter off)
        if price <= bb_lower and rsi <= cfg.rsi_oversold and trend_ok_long:
            expected_move_bps = ((bb_mid - price) / price) * 10000
            if expected_move_bps < cost_bps * cfg.min_edge_multiple:
                return SignalResult(
                    Signal.HOLD, reason="long setup found but expected move too small to clear costs",
                    rsi=rsi, bb_upper=bb_upper, bb_lower=bb_lower, bb_mid=bb_mid,
                    expected_move_bps=expected_move_bps, cost_bps=cost_bps,
                )
            return SignalResult(
                Signal.BUY, reason="oversold + at lower band + trend filter passed + edge clears costs",
                rsi=rsi, bb_upper=bb_upper, bb_lower=bb_lower, bb_mid=bb_mid,
                expected_move_bps=expected_move_bps, cost_bps=cost_bps,
                suggested_stop_loss=price * (1 - cfg.stop_loss_pct),
                suggested_take_profit=price * (1 + cfg.take_profit_pct),
            )

        # Candidate SHORT: price at/above upper band, RSI overbought, downtrend (or filter off)
        if price >= bb_upper and rsi >= cfg.rsi_overbought and trend_ok_short:
            expected_move_bps = ((price - bb_mid) / price) * 10000
            if expected_move_bps < cost_bps * cfg.min_edge_multiple:
                return SignalResult(
                    Signal.HOLD, reason="short setup found but expected move too small to clear costs",
                    rsi=rsi, bb_upper=bb_upper, bb_lower=bb_lower, bb_mid=bb_mid,
                    expected_move_bps=expected_move_bps, cost_bps=cost_bps,
                )
            return SignalResult(
                Signal.SELL, reason="overbought + at upper band + trend filter passed + edge clears costs",
                rsi=rsi, bb_upper=bb_upper, bb_lower=bb_lower, bb_mid=bb_mid,
                expected_move_bps=expected_move_bps, cost_bps=cost_bps,
                suggested_stop_loss=price * (1 + cfg.stop_loss_pct),
                suggested_take_profit=price * (1 - cfg.take_profit_pct),
            )

        return SignalResult(Signal.HOLD, reason="no setup", rsi=rsi, bb_upper=bb_upper, bb_lower=bb_lower, bb_mid=bb_mid)

    def position_size(self, equity: float, entry_price: float, stop_loss_price: float) -> float:
        """Risk-based sizing: risk a fixed % of equity, sized off stop distance.
        Replaces flat '25% of capital per trade' / 'all-in' sizing."""
        cfg = self.config
        risk_amount = equity * cfg.risk_per_trade_pct
        stop_distance = abs(entry_price - stop_loss_price)
        if stop_distance <= 0:
            return 0.0
        qty = risk_amount / stop_distance
        max_qty_by_notional = equity / entry_price  # never exceed 1x equity notional
        return min(qty, max_qty_by_notional)
