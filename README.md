# STOCK CARRY

A [Circuit](https://circuit.org) agent that holds a Coinbase stock token on Aave and shorts the same shares on Hyperliquid. The two legs cancel out the stock's price moves, so the agent earns the short's funding payments plus Aave rewards, minus the cost of the loan.

Based on the [TokenLogic strategy](https://x.com/Token_Logic/status/2112921105933758924).

## How it works

1. Buys the chosen stock token (GOOGLc by default) with USDC on Base and supplies it to Aave V4 as collateral.
2. Borrows about 45% of the collateral's value in USDC and bridges it to Hyperliquid.
3. Shorts the same number of shares on Hyperliquid's trade[XYZ] market (`xyz:GOOGL`) with that USDC as margin. The leverage cap is set to 3x, and the short ends up at about 2x.
4. Watches both sides every 5 minutes. When one side gets more than `rebalance_gap` percentage points closer to liquidation than the other, it moves USDC to even them out: it borrows more and adds it to the short's margin, or it pulls margin back and repays Aave.
5. Claims Merkl rewards once a week.

The agent takes one action at a time and waits for it to settle before the next. The short's liquidation distance is worked out from the session's own margin, so other funds passing through the same Hyperliquid account don't distort it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `stock` | `GOOGL` | AAPL, AMZN, GOOGL, META, MSFT, NVDA or TSLA. Change it only while the agent is out of the market. |
| `position` | `hold` | `hold` stays hedged through weekends. `exit_weekends` sells to USDC before the week's last US close and rebuilds after the next open. `close` unwinds everything to USDC now. |
| `rebalance_gap` | `10` | How many percentage points apart the two liquidation distances can drift before the agent moves USDC (min 2, max 50). |

## Running

Requires the [Circuit CLI](https://docs.circuit.org), a wallet holding at least 127 USDC on Base, and a little ETH on Base for gas.

```bash
bun install
circuit check
bun test

# The agent is continuous: Circuit reads `continuous = true` from the uploaded agent, so upload after changing circuit.toml.
circuit upload

# Start a session with your Circuit wallet (code runs locally, wallet is hosted).
circuit run --target hosted-engine --wallet EVM --amount 150

# Unwind to USDC on Base, then stop.
circuit run --target hosted-engine --wallet EVM --setting position=close
circuit stop --target hosted --wallet EVM
```

Wait for the close to finish before stopping. Stopping first leaves the Aave deposit, the loan and the short open.

## Files

- `index.ts`: the agent.
- `market-hours.ts`: NYSE trading week (holidays and early closes for 2026–2028), used by `exit_weekends`.
- `circuit.toml`: agent config and settings.
- `DESCRIPTION.md`: the description shown on Circuit.

## Risks

- Aave prices the stock with an oracle that updates on a 0.5% move or every 24 hours and stays frozen over weekends, while Hyperliquid trades around the clock. The two can disagree for a while.
- Funding can turn negative, so the short pays instead of earning.
- Either side can still be liquidated after a large, fast move between checks.
