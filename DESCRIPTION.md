## Thesis
Holds a Coinbase stock token on Aave and shorts the same shares on Hyperliquid, earning the short's funding plus Aave rewards with no stock price exposure.

## Strategy
- **Hedged stock:** Buys the chosen stock token on Base, deposits it on Aave, borrows about 45% in USDC and uses it to short the same number of shares on Hyperliquid.
- **Rebalancing:** Moves USDC between the Aave loan and the short once one side is 10 points closer to liquidation, so the stock can move equally far either way.
- **Weekends and closing:** Stays hedged through weekends by default; it can instead sell to USDC before each week's last US close, or sell to USDC at once when you choose close.

## Exposure
- **Holds:** Stock token plus short — Coinbase tokenized stock (GOOGLc by default) deposited on Aave, an equal short on Hyperliquid's trade[XYZ] market, and USDC on Base over weekends if you choose to exit them.
- **Venue:** Aave V4, Hyperliquid — Aave on Base and Hyperliquid's trade[XYZ] stock market; keep a little ETH on Base to pay for the agent's Aave and swap transactions.
- **Leverage:** About 2x on the short — The short is backed by USDC borrowed against the stock, about 45% of its value, with Hyperliquid's cap set to 3x so margin can still move between the two sides.
- **Costs:** Swaps, bridge, loan — Stock swaps and Hyperliquid trading fees on entry and exit (every week with weekend exits on), bridge fees between Base and Hyperliquid, and Aave's USDC borrow rate.
- **Data:** Circuit, Base, Merkl — mainnet.base.org to read the Aave position Circuit does not track, and api.merkl.xyz to claim the Aave rewards it pays.
- **On unwind:** USDC on Base — Choose close and wait for it to finish before stopping; stopping without it leaves the Aave deposit, loan and short open for you to close.
