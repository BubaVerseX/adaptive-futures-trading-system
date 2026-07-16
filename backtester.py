"""
backtester.py — Test a strategy against REAL historical price data, with
fees included, before ever running it live.

This is the step that was skipped every time so far: a strategy was written,
plugged straight into live trading, and only evaluated after money was
already at risk. This script closes that gap.

Usage:
    pip install requests --break-system-packages
    python3 backtester.py --symbol SOLUSDT --interval 15 --days 60

What it does:
    1. Pulls historical candles from Bybit's PUBLIC market-data endpoint
       (no API key needed — this only reads public price history, it
       cannot see your account and cannot place orders).
    2. Walks through the candles bar-by-bar, feeding closes into the
       strategy exactly like a live bot would.
    3. On a BUY/SELL signal, simulates the trade forward until stop-loss
       or take-profit is hit (or data runs out), deducting realistic
       fees (config in strategy.py).
    4. Prints an honest report: win rate, profit factor, net PnL, max
       drawdown, and trade count.

Read the report literally. If net PnL <= 0 or profit factor <= 1, the
strategy does not have an edge on that symbol/timeframe and should not go
live — full stop, regardless of how it "feels" it should perform.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field

from strategy import RSIBollingerStrategy, StrategyConfig, Signal

BYBIT_KLINE_URL = "https://api.bybit.com/v5/market/kline"


def fetch_klines(symbol: str, interval: str, days: int) -> list[dict]:
    """Fetch historical candles from Bybit's public kline endpoint.
    Paginates backward since Bybit returns at most 1000 candles per call."""
    import requests  # local import so the strategy module has zero deps

    interval_minutes = {"1": 1, "3": 3, "5": 5, "15": 15, "30": 30, "60": 60, "240": 240}
    if interval not in interval_minutes:
        raise ValueError(f"unsupported interval {interval}, use one of {list(interval_minutes)}")

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - days * 24 * 60 * 60 * 1000
    all_candles: list[dict] = []
    cursor_end = end_ms

    while cursor_end > start_ms:
        params = {
            "category": "linear",
            "symbol": symbol,
            "interval": interval,
            "end": cursor_end,
            "limit": 1000,
        }
        resp = requests.get(BYBIT_KLINE_URL, params=params, timeout=15)
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("retCode") != 0:
            raise RuntimeError(f"Bybit API error: {payload.get('retMsg')}")
        rows = payload["result"]["list"]  # newest first: [start, open, high, low, close, volume, turnover]
        if not rows:
            break
        for r in rows:
            all_candles.append({
                "timestamp": int(r[0]),
                "open": float(r[1]),
                "high": float(r[2]),
                "low": float(r[3]),
                "close": float(r[4]),
                "volume": float(r[5]),
            })
        oldest_ts = int(rows[-1][0])
        if oldest_ts >= cursor_end:
            break
        cursor_end = oldest_ts
        time.sleep(0.1)  # be polite to the public endpoint

    all_candles.sort(key=lambda c: c["timestamp"])
    # de-dup in case of overlapping pages
    seen = set()
    deduped = []
    for c in all_candles:
        if c["timestamp"] not in seen:
            seen.add(c["timestamp"])
            deduped.append(c)
    return deduped


@dataclass
class Trade:
    side: str
    entry_price: float
    entry_time: int
    exit_price: float | None = None
    exit_time: int | None = None
    exit_reason: str | None = None
    pnl_pct: float = 0.0


@dataclass
class BacktestResult:
    trades: list[Trade] = field(default_factory=list)

    def summary(self, fee_bps_round_trip: float) -> dict:
        closed = [t for t in self.trades if t.exit_price is not None]
        if not closed:
            return {"tradeCount": 0, "message": "No trades were generated over this period."}

        fee_frac = fee_bps_round_trip / 10000
        net_returns = [t.pnl_pct - fee_frac for t in closed]
        wins = [r for r in net_returns if r > 0]
        losses = [r for r in net_returns if r <= 0]

        equity = 1.0
        peak = 1.0
        max_dd = 0.0
        for r in net_returns:
            equity *= (1 + r)
            peak = max(peak, equity)
            max_dd = max(max_dd, (peak - equity) / peak)

        gross_win = sum(wins)
        gross_loss = abs(sum(losses))
        profit_factor = (gross_win / gross_loss) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0)

        return {
            "tradeCount": len(closed),
            "winRatePct": round(len(wins) / len(closed) * 100, 2),
            "avgWinPct": round((sum(wins) / len(wins)) * 100, 3) if wins else 0,
            "avgLossPct": round((sum(losses) / len(losses)) * 100, 3) if losses else 0,
            "profitFactor": round(profit_factor, 3) if profit_factor != float("inf") else "inf (no losses)",
            "netPnlPct": round((equity - 1) * 100, 3),
            "maxDrawdownPct": round(max_dd * 100, 3),
            "feeBpsRoundTripUsed": fee_bps_round_trip,
        }


def run_backtest(candles: list[dict], config: StrategyConfig) -> BacktestResult:
    strategy = RSIBollingerStrategy(config)
    closes: list[float] = []
    result = BacktestResult()
    open_trade: Trade | None = None

    for candle in candles:
        closes.append(candle["close"])

        if open_trade is not None:
            high, low = candle["high"], candle["low"]
            if open_trade.side == "LONG":
                sl = open_trade.entry_price * (1 - config.stop_loss_pct)
                tp = open_trade.entry_price * (1 + config.take_profit_pct)
                if low <= sl:
                    open_trade.exit_price, open_trade.exit_reason = sl, "stop_loss"
                elif high >= tp:
                    open_trade.exit_price, open_trade.exit_reason = tp, "take_profit"
            else:
                sl = open_trade.entry_price * (1 + config.stop_loss_pct)
                tp = open_trade.entry_price * (1 - config.take_profit_pct)
                if high >= sl:
                    open_trade.exit_price, open_trade.exit_reason = sl, "stop_loss"
                elif low <= tp:
                    open_trade.exit_price, open_trade.exit_reason = tp, "take_profit"

            if open_trade.exit_price is not None:
                open_trade.exit_time = candle["timestamp"]
                if open_trade.side == "LONG":
                    open_trade.pnl_pct = (open_trade.exit_price - open_trade.entry_price) / open_trade.entry_price
                else:
                    open_trade.pnl_pct = (open_trade.entry_price - open_trade.exit_price) / open_trade.entry_price
                result.trades.append(open_trade)
                open_trade = None
            continue  # one trade at a time, don't evaluate new signals mid-trade

        signal_result = strategy.generate_signal(closes)
        if signal_result.signal == Signal.BUY:
            open_trade = Trade(side="LONG", entry_price=candle["close"], entry_time=candle["timestamp"])
        elif signal_result.signal == Signal.SELL:
            open_trade = Trade(side="SHORT", entry_price=candle["close"], entry_time=candle["timestamp"])

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Backtest the RSI+BB edge-gated strategy against real Bybit history.")
    parser.add_argument("--symbol", default="SOLUSDT")
    parser.add_argument("--interval", default="15", help="candle interval in minutes: 1,3,5,15,30,60,240")
    parser.add_argument("--days", type=int, default=60)
    args = parser.parse_args()

    print(f"Fetching {args.days} days of {args.interval}m candles for {args.symbol} from Bybit public API...")
    candles = fetch_klines(args.symbol, args.interval, args.days)
    print(f"Fetched {len(candles)} candles.\n")

    config = StrategyConfig()
    result = run_backtest(candles, config)
    summary = result.summary(fee_bps_round_trip=config.taker_fee_bps)

    print(json.dumps(summary, indent=2))

    if summary.get("tradeCount", 0) > 0:
        net = summary["netPnlPct"]
        pf = summary["profitFactor"]
        print("\n--- Verdict ---")
        if isinstance(pf, str) or (isinstance(pf, (int, float)) and pf > 1 and net > 0):
            print("Positive edge on this backtest window. This does NOT guarantee future profit —")
            print("it means the strategy is at least worth testnet-validating further, on more")
            print("symbols/timeframes/periods, before any live capital.")
        else:
            print("No edge found on this symbol/timeframe/period. Do not run this live as-is.")
            print("Try a different symbol, timeframe, or revisit the strategy logic.")


if __name__ == "__main__":
    main()
