import {
  decimalCompare,
  decimalDivide,
  decimalMin,
  decimalMultiply,
  decimalSub,
  type Holding,
  type RunFunction,
} from "circuit:sdk";
import { createPublicClient, encodeFunctionData, formatUnits, http, maxUint256, parseAbi, parseUnits } from "viem";
import { base } from "viem/chains";
import { inTradingWeek } from "./market-hours";

const BASE = "ethereum:8453";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CORE_USDC = "0";
const RPC = "https://mainnet.base.org";
const MERKL_DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";
// Aave V4 on Base: the Coinbase stocks spoke. Reserve ids 0-6 are the stock tokens, 7 is USDC.
const SPOKE = "0x17905Db0e4A3514467539956c084180616AE7B8D";
const USDC_RESERVE = 7n;
const STOCKS = {
  AAPL: { token: "0xb200000000000000000000c2e324d24d7eecd1fb", reserveId: 0n },
  AMZN: { token: "0xb200000000000000000000d9192b6b456483c2e8", reserveId: 1n },
  GOOGL: { token: "0xb2000000000000000000002d0ba3164cc74f58b7", reserveId: 2n },
  META: { token: "0xb2000000000000000000008bc8786b856e61707c", reserveId: 3n },
  MSFT: { token: "0xb200000000000000000000ab99cfa739e253872b", reserveId: 4n },
  NVDA: { token: "0xb20000000000000000000078ee7ce2fe4908108c", reserveId: 5n },
  TSLA: { token: "0xb2000000000000000000001e800a7f5189430cd0", reserveId: 6n },
} as const;
const STOCK_DECIMALS = 8;
const USDC_DECIMALS = 6;
// Smallest USDC transfer between Base and Hyperliquid (Hyperliquid's deposit bridge minimum).
const MIN_BRIDGE_USDC = 5;
// Hyperliquid refuses orders worth less than this.
const MIN_ORDER_USDC = 10;
// Smallest Aave repayment worth a transaction.
const MIN_REPAY_USDC = 1;
// Cross leverage cap on the short. Liquidation depends on the margin actually held (about 2x), not on this cap;
// 3x still lets rebalancing withdraw margin down to a third of the short's value.
const SHORT_LEVERAGE = 3;
// Maximum leverage on every trade[XYZ] stock market this agent trades (xyz:AAPL ... xyz:TSLA all list 20x).
const XYZ_MAX_LEVERAGE = 20;
// Each wake refreshes the Hyperliquid account through Circuit, whose provider rate-limits shared traffic; a 40% liquidation buffer leaves time to check every few minutes.
const IDLE_MS = 300_000;
const BUSY_MS = 10_000;

const spokeAbi = parseAbi([
  "function supply(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function repay(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)",
  "function getUserAccountData(address user) view returns (uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount)",
  "function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)",
  "function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)",
  "function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)",
]);
const tokenAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function multiplier() view returns (uint256)",
]);
const distributorAbi = parseAbi([
  "function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)",
]);

type MerklRewards = { rewards: { token: { address: `0x${string}` }; amount: string; claimed: string; proofs: `0x${string}`[] }[] }[];

export const run: RunFunction = async (agent) => {
  const ticker = agent.settings.stock;
  const { token, reserveId } = STOCKS[ticker];
  const perp = `xyz:${ticker}`;
  const wallet = agent.walletAddress as `0x${string}`;
  const chain = createPublicClient({ chain: base, transport: http(RPC, { timeout: 10_000, retryCount: 0 }) });
  if ((await chain.getChainId()) !== base.id) throw new Error(`${RPC} is not serving Base.`);
  // Hyperliquid's maintenance margin is half the initial margin at maximum leverage.
  const maintenance = 1 / (2 * XYZ_MAX_LEVERAGE);
  const leverage = SHORT_LEVERAGE;

  const send = (to: `0x${string}`, data: `0x${string}`) =>
    agent.wallet.transactions.create({ network: BASE, request: { toAddress: to, valueWei: "0", data } });
  const spoke = (functionName: "supply" | "withdraw" | "borrow" | "repay", reserve: bigint, amount: bigint) =>
    send(SPOKE, encodeFunctionData({ abi: spokeAbi, functionName, args: [reserve, amount, wallet] }));
  // The spoke pulls tokens on supply and repay; a single unlimited approval per token covers every later call.
  const approveSpoke = async (asset: `0x${string}`, allowance: bigint, amount: bigint) => {
    if (allowance < amount) await send(asset, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [SPOKE, maxUint256] }));
  };

  let statusHour = -1;
  for (;;) {
    const pending = (await agent.operations.pending()).length;
    if (pending > 0 && statusDue()) await agent.log(`Waiting for ${pending} pending operation${pending > 1 ? "s" : ""} to settle before the next step.`);
    const acted = pending > 0 ? false : await step();
    await agent.next({ until: Date.now() + (acted || pending > 0 ? BUSY_MS : IDLE_MS) });
  }

  // Takes at most one action toward the target state and reports whether it did.
  async function step(): Promise<boolean> {
    const tokens = agent.allocation.holdings.filter((holding) => holding.kind === "token");
    const held = (network: string, asset: string) =>
      tokens.find((holding) => holding.network === network && holding.asset.toLowerCase() === asset)?.quantity ?? "0";
    const baseUsdc = held(BASE, USDC);
    const baseStock = held(BASE, token);
    const coreUsdc = held("hypercore", CORE_USDC);
    const short = agent.allocation.holdings.find((holding): holding is Extract<Holding, { kind: "perp" }> => holding.kind === "perp" && holding.asset === perp);
    const shortSize = short && decimalCompare(short.quantity, "0") < 0 ? decimalMultiply(short.quantity, "-1") : "0";
    const hasShort = decimalCompare(shortSize, "0") > 0;

    // One multicall per decision: Base's public endpoint allows 5 requests a second.
    const [account, suppliedRaw, debtRaw, [isCollateral], multiplierRaw, stockAllowance, usdcAllowance] = await chain.multicall({
      allowFailure: false,
      contracts: [
        { address: SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [wallet] },
        { address: SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [reserveId, wallet] },
        { address: SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [USDC_RESERVE, wallet] },
        { address: SPOKE, abi: spokeAbi, functionName: "getUserReserveStatus", args: [reserveId, wallet] },
        { address: token, abi: tokenAbi, functionName: "multiplier" },
        { address: token, abi: tokenAbi, functionName: "allowance", args: [wallet, SPOKE] },
        { address: USDC, abi: tokenAbi, functionName: "allowance", args: [wallet, SPOKE] },
      ],
    });
    const supplied = formatUnits(suppliedRaw, STOCK_DECIMALS);
    const debt = formatUnits(debtRaw, USDC_DECIMALS);
    const collateralUsd = Number(formatUnits(account[3], 26));
    const collateralFactor = Number(formatUnits(account[1], 18));
    const borrowLimit = collateralUsd * collateralFactor;
    // How far the stock can fall before Aave liquidates, and rise before Hyperliquid does.
    const aaveRoom = borrowLimit > 0 ? 1 - Number(debt) / borrowLimit : null;
    const markUsd = short?.priceUsd ? Number(short.priceUsd) : null;
    // Measured from the session's own margin: Hyperliquid's liquidation price covers the whole cross account, so other
    // USDC passing through the wallet's Hyperliquid account would make the short look safer than its margin allows.
    const shortEquity = short?.unrealizedPnlUsd != null ? Number(coreUsdc) + Number(short.unrealizedPnlUsd) : null;
    const shortRoom = hasShort && markUsd && shortEquity !== null ? (shortEquity / (Number(shortSize) * markUsd) + 1) / (1 + maintenance) - 1 : null;
    // Each token is worth `multiplier` shares once dividends are reinvested; the short matches shares.
    const targetShort = decimalMultiply(supplied, formatUnits(multiplierRaw, 18));
    const sharePriceUsd = markUsd ?? (decimalCompare(targetShort, "0") > 0 ? collateralUsd / Number(targetShort) : null);

    if (suppliedRaw === 0n && account[3] > 0n) {
      throw new Error(`This wallet's Aave position holds collateral other than ${ticker}c: switch the stock setting back to the one it bought, or close that position first.`);
    }

    const { position } = agent.settings;
    const open = position === "hold" || (position === "exit_weekends" && inTradingWeek(Date.now()));
    // A loan left without collateral (after a liquidation) is unwound like a weekend.
    const orphanLoan = suppliedRaw === 0n && debtRaw > 0n;
    const nextMode = !open ? "closed" : orphanLoan ? "orphan" : "open";
    if ((await agent.memory.get({ key: "mode" }))?.value !== nextMode) {
      await agent.memory.set({ key: "mode", value: nextMode });
      await agent.log({
        open: `US market week is open: holding ${ticker}c on Aave against a ${perp} short.`,
        closed: position === "close" ? `Closing: unwinding ${ticker} to USDC on Base.` : `US market is closed for the weekend: unwinding ${ticker} to USDC.`,
        orphan: `The ${debt} USDC Aave loan has no ${ticker}c behind it: closing the short and repaying the loan.`,
      }[nextMode]);
    }

    if (!open || orphanLoan) {
      if (hasShort) {
        await agent.hyperliquid.orders.create({ kind: "perpReduce", asset: perp, amount: { size: "max" } });
        await agent.log(`Closed the ${shortSize} ${perp} short for the weekend.`);
        return true;
      }
      if (Number(coreUsdc) >= MIN_BRIDGE_USDC) {
        // Hyperliquid holds USDC to 8 decimals; the bridge to Base refuses anything past Base USDC's 6.
        const amount = decimalDivide(coreUsdc, "1", USDC_DECIMALS);
        await agent.swaps.create({ from: { network: "hypercore", asset: CORE_USDC }, to: { network: BASE, asset: USDC }, amount });
        await agent.log(`Moved ${amount} USDC from Hyperliquid back to Base.`);
        return true;
      }
      if (decimalCompare(baseStock, "0") > 0) {
        await agent.swaps.create({ from: { network: BASE, asset: token }, to: { network: BASE, asset: USDC }, amount: "max" });
        await agent.log(`Sold ${baseStock} ${ticker}c for USDC.`);
        return true;
      }
      if (decimalCompare(debt, "0") > 0 && (decimalCompare(baseUsdc, debt) >= 0 || Number(baseUsdc) >= MIN_REPAY_USDC)) {
        const repay = decimalMin(baseUsdc, debt);
        const full = decimalCompare(baseUsdc, debt) >= 0;
        await approveSpoke(USDC, usdcAllowance, parseUnits(repay, USDC_DECIMALS));
        await spoke("repay", USDC_RESERVE, full ? maxUint256 : parseUnits(repay, USDC_DECIMALS));
        await agent.log(full ? `Repaid the ${debt} USDC Aave loan.` : `Repaid ${repay} of the ${debt} USDC Aave loan.`);
        return true;
      }
      if (decimalCompare(debt, "0") > 0) {
        // Not enough USDC came back to clear the loan: free enough stock to sell for the rest, keeping health above 1.05.
        if (suppliedRaw === 0n) throw new Error(`The ${debt} USDC Aave loan has no ${ticker}c left behind it and no USDC to repay it.`);
        const health = borrowLimit / Number(debt);
        const share = Math.min(1 - 1.05 / health, (1.01 * Math.max(Number(debt), MIN_REPAY_USDC)) / collateralUsd);
        if (share <= 0) throw new Error(`Aave health factor ${health.toFixed(3)} leaves no ${ticker}c free to sell against the ${debt} USDC loan.`);
        const amount = decimalMultiply(supplied, share.toFixed(10));
        await spoke("withdraw", reserveId, parseUnits(amount, STOCK_DECIMALS));
        await agent.log(`Withdrew ${amount} ${ticker}c from Aave to sell toward the remaining ${debt} USDC loan.`);
        return true;
      }
      if (suppliedRaw > 0n) {
        await spoke("withdraw", reserveId, maxUint256);
        await agent.log(`Withdrew all ${supplied} ${ticker}c from Aave.`);
        return true;
      }
      return claimMerkl();
    }

    if (decimalCompare(baseStock, "0") > 0) {
      await approveSpoke(token, stockAllowance, parseUnits(baseStock, STOCK_DECIMALS));
      await spoke("supply", reserveId, parseUnits(baseStock, STOCK_DECIMALS));
      await agent.log(`Supplied ${baseStock} ${ticker}c to Aave.`);
      return true;
    }
    if (suppliedRaw === 0n) {
      if (hasShort) {
        await agent.hyperliquid.orders.create({ kind: "perpReduce", asset: perp, amount: { size: "max" } });
        await agent.log(`Closed the ${shortSize} ${perp} short: no ${ticker}c is left on Aave to hedge.`);
        return true;
      }
      if (Number(baseUsdc) < MIN_ORDER_USDC) {
        if (statusDue()) await agent.log(`Waiting for at least ${MIN_ORDER_USDC} USDC on Base to buy ${ticker}c.`);
        return false;
      }
      await agent.swaps.create({ from: { network: BASE, asset: USDC }, to: { network: BASE, asset: token }, amount: "max" });
      await agent.log(`Bought ${ticker}c with ${baseUsdc} USDC.`);
      return true;
    }
    if (!isCollateral) {
      await send(SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "setUsingAsCollateral", args: [reserveId, true, wallet] }));
      await agent.log(`Enabled ${ticker}c as Aave collateral.`);
      return true;
    }
    if (debtRaw === 0n && !hasShort) {
      // Borrow the share of collateral that leaves the stock equally far from liquidation on Aave (falling) and Hyperliquid (rising).
      const share = (1 + 2 * maintenance) / (1 + (1 + maintenance) / collateralFactor);
      const amount = (collateralUsd * share).toFixed(USDC_DECIMALS);
      await spoke("borrow", USDC_RESERVE, parseUnits(amount, USDC_DECIMALS));
      await agent.swaps.create({ from: { network: BASE, asset: USDC }, to: { network: "hypercore", asset: CORE_USDC }, amount });
      await agent.log(`Borrowed ${amount} USDC on Aave (${(share * 100).toFixed(1)}% of collateral) and moved it to Hyperliquid as short margin.`);
      return true;
    }
    // Spare USDC on Base goes to whichever side is closer to liquidation.
    const aaveWeaker = hasShort && aaveRoom !== null && shortRoom !== null && aaveRoom < shortRoom;
    if (aaveWeaker && Number(baseUsdc) >= MIN_REPAY_USDC) {
      const repay = decimalMin(baseUsdc, debt);
      await approveSpoke(USDC, usdcAllowance, parseUnits(repay, USDC_DECIMALS));
      await spoke("repay", USDC_RESERVE, parseUnits(repay, USDC_DECIMALS));
      await agent.log(`Repaid ${repay} USDC on Aave.`);
      return true;
    }
    if (!aaveWeaker && Number(baseUsdc) >= MIN_BRIDGE_USDC) {
      await agent.swaps.create({ from: { network: BASE, asset: USDC }, to: { network: "hypercore", asset: CORE_USDC }, amount: baseUsdc });
      await agent.log(`Moved ${baseUsdc} USDC from Base to Hyperliquid margin.`);
      return true;
    }
    const gap = decimalSub(targetShort, shortSize);
    if (sharePriceUsd === null) throw new Error(`No ${ticker} price is available to size the ${perp} short.`);
    if (Math.abs(Number(gap)) * sharePriceUsd >= MIN_ORDER_USDC) {
      if (decimalCompare(gap, "0") > 0) {
        await agent.hyperliquid.orders.create({ kind: "perpOpen", asset: perp, side: "short", leverage, marginMode: "cross", amount: { size: gap } });
        await agent.log(`Shorted ${gap} ${perp} to match ${supplied} ${ticker}c on Aave.`);
      } else {
        const excess = decimalMultiply(gap, "-1");
        await agent.hyperliquid.orders.create({ kind: "perpReduce", asset: perp, expectedSide: "short", amount: { size: excess } });
        await agent.log(`Bought back ${excess} ${perp} to match ${supplied} ${ticker}c on Aave.`);
      }
      return true;
    }
    if (aaveRoom === null || shortRoom === null || markUsd === null) {
      if (statusDue()) await agent.log(`Waiting for Aave and Hyperliquid to report liquidation distances before rebalancing.`);
      return false;
    }
    if (Math.abs(aaveRoom - shortRoom) * 100 > agent.settings.rebalance_gap) {
      // USDC that brings both distances level: Aave's moves by 1/borrowLimit per dollar, the short's by 1/notional.
      const notional = Number(shortSize) * markUsd;
      const move = (aaveRoom - shortRoom) / (1 / borrowLimit + 1 / notional);
      // Hyperliquid releases only margin above notional / leverage, so a withdrawal stops short of that.
      const releasable = shortEquity !== null ? shortEquity - notional / leverage : 0;
      const size = move > 0 ? move : Math.min(-move, 0.98 * releasable);
      if (size >= MIN_BRIDGE_USDC) {
        const amount = size.toFixed(USDC_DECIMALS);
        const ahead = `${ticker} can fall ${pct(aaveRoom)} before Aave liquidates and rise ${pct(shortRoom)} before Hyperliquid does`;
        if (move > 0) {
          await spoke("borrow", USDC_RESERVE, parseUnits(amount, USDC_DECIMALS));
          await agent.swaps.create({ from: { network: BASE, asset: USDC }, to: { network: "hypercore", asset: CORE_USDC }, amount });
          await agent.log(`Borrowed ${amount} USDC more on Aave and added it to the short's margin: ${ahead}.`);
        } else {
          await agent.swaps.create({ from: { network: "hypercore", asset: CORE_USDC }, to: { network: BASE, asset: USDC }, amount });
          await agent.log(`Moved ${amount} USDC of short margin back to Base to repay Aave: ${ahead}.`);
        }
        return true;
      }
    }
    if (statusDue()) {
      await agent.log(`Holding ${supplied} ${ticker}c on Aave against a ${shortSize} ${perp} short: ${ticker} can fall ${pct(aaveRoom)} before Aave liquidates and rise ${pct(shortRoom)} before Hyperliquid does.`);
    }
    return claimMerkl();
  }

  // Claims the wallet's Merkl rewards, the Aave incentives paid in USDC, once each week.
  async function claimMerkl(): Promise<boolean> {
    const week = String(Math.floor(Date.now() / 604_800_000));
    if ((await agent.memory.get({ key: "merkl-week" }))?.value === week) return false;
    // Marked before the request so a Merkl outage fails one run, not every idle tick; rewards accumulate until next week.
    await agent.memory.set({ key: "merkl-week", value: week });
    const response = await fetch(`https://api.merkl.xyz/v4/users/${wallet}/rewards?chainId=${base.id}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Merkl rewards request failed with HTTP ${response.status}.`);
    const due = ((await response.json()) as MerklRewards).flatMap((chain) => chain.rewards).filter((reward) => BigInt(reward.amount) > BigInt(reward.claimed));
    if (due.length > 0) {
      await send(MERKL_DISTRIBUTOR, encodeFunctionData({
        abi: distributorAbi,
        functionName: "claim",
        args: [due.map(() => wallet), due.map((reward) => reward.token.address), due.map((reward) => BigInt(reward.amount)), due.map((reward) => reward.proofs)],
      }));
      await agent.log(`Claimed ${due.length} Merkl reward${due.length > 1 ? "s" : ""} earned on Aave.`);
    }
    return due.length > 0;
  }

  function statusDue(): boolean {
    const hour = Math.floor(Date.now() / 3_600_000);
    if (hour === statusHour) return false;
    statusHour = hour;
    return true;
  }
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

