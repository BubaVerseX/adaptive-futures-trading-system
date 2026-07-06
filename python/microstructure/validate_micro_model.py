#!/usr/bin/env python3
"""Validate V24 microstructure model outputs and create a live-profile gate."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def profit_factor(trades):
    wins = sum(max(0.0, float(item.get("netPnlUsdt", 0))) for item in trades)
    losses = abs(sum(min(0.0, float(item.get("netPnlUsdt", 0))) for item in trades))
    if losses > 0:
        return wins / losses
    return 999.0 if wins > 0 else 0.0


def max_drawdown(trades):
    equity = 0.0
    peak = 0.0
    drawdown = 0.0
    for trade in trades:
        equity += float(trade.get("netPnlUsdt", 0))
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return drawdown


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shadow-trades", default="data/microstructure/shadow-trades.json")
    parser.add_argument("--training-report", default="models/microstructure/training-report.json")
    parser.add_argument("--output-profile", default="models/microstructure/live-profile.json")
    parser.add_argument("--min-shadow-signals", type=int, default=500)
    parser.add_argument("--min-net-pnl", type=float, default=0.0)
    parser.add_argument("--min-profit-factor", type=float, default=1.05)
    args = parser.parse_args()

    trades_path = Path(args.shadow_trades)
    trades = json.loads(trades_path.read_text(encoding="utf-8")) if trades_path.exists() else []
    closed = [trade for trade in trades if trade.get("status") == "CLOSED"]
    net_pnl = sum(float(trade.get("netPnlUsdt", 0)) for trade in closed)
    fees = sum(float(trade.get("feeCostUsdt", 0)) for trade in closed)
    pf = profit_factor(closed)
    training_report = json.loads(Path(args.training_report).read_text(encoding="utf-8")) if Path(args.training_report).exists() else {}
    blocked = []
    if len(trades) < args.min_shadow_signals:
        blocked.append(f"shadow signals {len(trades)} < {args.min_shadow_signals}")
    if net_pnl <= args.min_net_pnl:
        blocked.append(f"net PnL after fees {net_pnl:.6f} <= {args.min_net_pnl}")
    if pf < args.min_profit_factor:
        blocked.append(f"profit factor {pf:.4f} < {args.min_profit_factor}")
    profile = {
        "status": "VALIDATED" if not blocked else "REJECTED",
        "shadowSignals": len(trades),
        "closedTrades": len(closed),
        "netPnlAfterFees": net_pnl,
        "fees": fees,
        "profitFactor": pf,
        "maxDrawdown": max_drawdown(closed),
        "blockedReasons": blocked,
        "trainingReport": training_report,
        "takerOnly": True,
        "liveOrdersAllowed": not blocked,
    }
    Path(args.output_profile).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output_profile).write_text(json.dumps(profile, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(profile, indent=2))


if __name__ == "__main__":
    main()
