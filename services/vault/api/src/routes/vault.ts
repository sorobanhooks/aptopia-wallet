// /vault/* routes — state, strategies, build-tx for deposit/withdraw.

import { Hono } from "hono";
import { forNetwork, type Network, type NetworkAddresses, vaultFor } from "../addresses";
import { addrScVal, buildInvocationXdr, i128ScVal, simulateRead } from "../rpc";
import { TtlCache } from "../cache";

const DEFAULT_NETWORK = (process.env.NETWORK ?? "testnet") as Network;
const READ_SOURCE = process.env.ADMIN_ADDR ?? "GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV";
const DEFAULT_SLIPPAGE_BPS = 100; // 1%

export const vaultRoutes = new Hono();

const VALID_ASSETS = new Set(["xlm", "usdc"]);

/** True when `:asset` is a recognised vault asset; false otherwise. */
function isKnownAsset(asset: string): asset is "xlm" | "usdc" {
  return VALID_ASSETS.has(asset);
}

/** 30-second cache for strategy position data — RPC-heavy (N reads per strategy). */
export const strategyPositionsCache = new TtlCache<StrategyPosition[]>(30_000);
/** 30-second cache for the allocator per-child breakdown (null = not an allocator). */
export const breakdownCache = new TtlCache<BreakdownEntry[] | null>(30_000);

interface StrategyPosition {
  address: string;
  name: string;
  isActive: boolean;
  currentValue: string;
  sharePercent: number;
}

/** One sleeve of a weighted-allocator vault (a child strategy or the native buffer). */
interface BreakdownEntry {
  label: string;
  kind: "blend" | "soroswap" | "native" | "other";
  address: string;
  /** Target weight in basis points (child weight, or native_bps for the buffer). */
  weightBps: number;
  currentValue: string;
  /** Actual share of the allocator's value, in percent. */
  sharePercent: number;
  authoritative?: boolean;
}

/** Decoded shape of `allocator.children()` (Vec<ChildSlot>) via scValToNative. */
interface ChildSlot {
  strategy: string;
  weight_bps: number;
  authoritative: boolean;
}

/**
 * Human-readable strategy name from its contract address, using the resolved
 * (env-overridable) address book. Falls back to a short truncated address.
 */
function strategyName(address: string, a: NetworkAddresses): string {
  if (a.allocatorXlm && address === a.allocatorXlm) return "Allocator (30/40/30)";
  if (address === a.blendStrategyXlm || address === a.blendStrategyUsdc) return "Blend";
  if (address === a.soroswapStrategyXlm) return "Soroswap LP";
  if (address === a.defindexStrategyUsdc) return "DeFindex";
  return `Strategy (${address.slice(0, 6)}…)`;
}

/** Classify a sleeve for the UI from the resolved address book. */
function sleeveKind(address: string, a: NetworkAddresses): BreakdownEntry["kind"] {
  if (address === a.blendStrategyXlm || address === a.blendStrategyUsdc) return "blend";
  if (address === a.soroswapStrategyXlm) return "soroswap";
  return "other";
}

/**
 * If `activeStrategy` is a weighted meta-allocator, return its per-sleeve
 * breakdown (each child strategy by value + the native cash buffer). Returns
 * null for a leaf strategy (no `children()` view). Reads are simulation-only.
 */
async function allocatorBreakdown(
  activeStrategy: string,
  a: NetworkAddresses,
): Promise<BreakdownEntry[] | null> {
  let children: ChildSlot[];
  try {
    children = await simulateRead<ChildSlot[]>({
      contractId: activeStrategy,
      method: "children",
      args: [],
      source: READ_SOURCE,
    });
  } catch {
    return null; // leaf strategy — no allocator breakdown
  }

  const [nativeBps, buffer, childValues] = await Promise.all([
    simulateRead<number>({ contractId: activeStrategy, method: "native_bps", args: [], source: READ_SOURCE }).catch(() => 0),
    simulateRead<bigint>({ contractId: activeStrategy, method: "buffer", args: [], source: READ_SOURCE }).catch(() => 0n),
    Promise.all(
      children.map((ch) =>
        simulateRead<bigint>({ contractId: ch.strategy, method: "current_value", args: [], source: READ_SOURCE }).catch(() => 0n),
      ),
    ),
  ]);

  const total = childValues.reduce((acc, v) => acc + v, 0n) + buffer;
  const pct = (v: bigint) => (total === 0n ? 0 : Number((v * 10_000n) / total) / 100);

  return [
    ...children.map((ch, i): BreakdownEntry => ({
      label: strategyName(ch.strategy, a),
      kind: sleeveKind(ch.strategy, a),
      address: ch.strategy,
      weightBps: ch.weight_bps,
      currentValue: childValues[i].toString(),
      sharePercent: pct(childValues[i]),
      authoritative: ch.authoritative,
    })),
    {
      label: "Native (cash buffer)",
      kind: "native",
      address: activeStrategy,
      weightBps: nativeBps,
      currentValue: buffer.toString(),
      sharePercent: pct(buffer),
    },
  ];
}

vaultRoutes.get("/vault/:asset/state", async (c) => {
  const asset = c.req.param("asset");
  if (!isKnownAsset(asset)) {
    return c.json({ error: "asset must be 'xlm' or 'usdc'" }, 400);
  }
  const vault = vaultFor(DEFAULT_NETWORK, asset);
  if (vault.startsWith("PLACEHOLDER_")) {
    return c.json({ error: `vault not yet deployed for asset=${asset}` }, 404);
  }

  // Run reads in parallel — they're all simulation-only and independent.
  const [totalAssets, totalSupply, pricePerShare, activeStrategy] = await Promise.all([
    simulateRead<bigint>({ contractId: vault, method: "total_assets", args: [], source: READ_SOURCE }),
    simulateRead<bigint>({ contractId: vault, method: "total_supply", args: [], source: READ_SOURCE }),
    simulateRead<bigint>({ contractId: vault, method: "price_per_share", args: [], source: READ_SOURCE }),
    simulateRead<string>({ contractId: vault, method: "active_strategy", args: [], source: READ_SOURCE }),
  ]);

  // pool_apy lives on the strategy, not the vault.
  let poolApyBps = 0;
  try {
    poolApyBps = await simulateRead<number>({
      contractId: activeStrategy,
      method: "pool_apy",
      args: [],
      source: READ_SOURCE,
    });
  } catch {
    // Strategy may not expose pool_apy yet (e.g. raw SAC); leave as 0.
  }

  const a = forNetwork(DEFAULT_NETWORK);

  // If the active strategy is a weighted meta-allocator, expose its per-sleeve
  // 30/40/30 breakdown (children + native buffer). null for leaf strategies.
  // Cached 30s to limit RPC fan-out.
  const breakdown = await breakdownCache.getOrCompute(
    `${DEFAULT_NETWORK}:${asset}:breakdown`,
    () => allocatorBreakdown(activeStrategy, a),
  );

  // Per-strategy position breakdown — cached 30s to limit RPC fan-out.
  const strategyPositions = await strategyPositionsCache.getOrCompute(
    `${DEFAULT_NETWORK}:${asset}`,
    async () => {
      // Read strategy registry alongside the already-known active strategy.
      const registry = await simulateRead<string[]>({
        contractId: vault,
        method: "strategy_registry",
        args: [],
        source: READ_SOURCE,
      });

      // Read current_value from every registered strategy in parallel.
      const values = await Promise.all(
        registry.map((addr) =>
          simulateRead<bigint>({
            contractId: addr,
            method: "current_value",
            args: [],
            source: READ_SOURCE,
          }).catch(() => 0n),
        ),
      );

      // Sum for share-percent denominator; guard zero-TVL vaults (all zeros).
      const total = values.reduce((acc, v) => acc + v, 0n);

      return registry.map((address, i): StrategyPosition => {
        const cv = values[i];
        const sharePercent =
          total === 0n ? 0 : Number((cv * 10_000n) / total) / 100;
        return {
          address,
          name: strategyName(address, a),
          isActive: address === activeStrategy,
          currentValue: cv.toString(),
          sharePercent,
        };
      });
    },
  );

  return c.json({
    network: DEFAULT_NETWORK,
    asset,
    vault,
    activeStrategy,
    totalAssets: totalAssets.toString(),
    totalSupply: totalSupply.toString(),
    pricePerShare: pricePerShare.toString(),
    poolApyBps,
    strategyPositions,
    // Present only when the active strategy is a weighted meta-allocator.
    breakdown,
  });
});

vaultRoutes.get("/vault/:asset/strategies", async (c) => {
  const asset = c.req.param("asset");
  if (!isKnownAsset(asset)) {
    return c.json({ error: "asset must be 'xlm' or 'usdc'" }, 400);
  }
  const vault = vaultFor(DEFAULT_NETWORK, asset);
  if (vault.startsWith("PLACEHOLDER_")) {
    return c.json({ error: `vault not yet deployed for asset=${asset}` }, 404);
  }

  const [registry, active] = await Promise.all([
    simulateRead<string[]>({ contractId: vault, method: "strategy_registry", args: [], source: READ_SOURCE }),
    simulateRead<string>({ contractId: vault, method: "active_strategy", args: [], source: READ_SOURCE }),
  ]);

  return c.json({
    network: DEFAULT_NETWORK,
    asset,
    vault,
    active,
    registered: registry.map((address) => ({ address, isActive: address === active })),
  });
});

vaultRoutes.post("/vault/:asset/deposit/build-tx", async (c) => {
  const asset = c.req.param("asset");
  if (!isKnownAsset(asset)) {
    return c.json({ error: "asset must be 'xlm' or 'usdc'" }, 400);
  }
  const vault = vaultFor(DEFAULT_NETWORK, asset);
  if (vault.startsWith("PLACEHOLDER_")) {
    return c.json({ error: `vault not yet deployed for asset=${asset}` }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const user = String(body.user ?? "");
  const amount = String(body.amount ?? "");
  if (!user || !amount) {
    return c.json({ error: "body must include { user, amount }" }, 400);
  }

  try {
    const xdr = await buildInvocationXdr({
      source: user,
      contractId: vault,
      method: "deposit",
      args: [addrScVal(user), i128ScVal(amount)],
    });
    return c.json({ xdr, vault, asset });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

vaultRoutes.post("/vault/:asset/withdraw/build-tx", async (c) => {
  const asset = c.req.param("asset");
  if (!isKnownAsset(asset)) {
    return c.json({ error: "asset must be 'xlm' or 'usdc'" }, 400);
  }
  const vault = vaultFor(DEFAULT_NETWORK, asset);
  if (vault.startsWith("PLACEHOLDER_")) {
    return c.json({ error: `vault not yet deployed for asset=${asset}` }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const user = String(body.user ?? "");
  const shares = String(body.shares ?? "");
  const maxSlippageBps = Number(body.max_slippage_bps ?? DEFAULT_SLIPPAGE_BPS);
  if (!user || !shares) {
    return c.json({ error: "body must include { user, shares }" }, 400);
  }
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) {
    return c.json({ error: "max_slippage_bps must be integer in [0, 10000]" }, 400);
  }

  try {
    // 1. Read the expected output from on-chain preview.
    const expected = await simulateRead<bigint>({
      contractId: vault,
      method: "preview_redeem",
      args: [i128ScVal(shares)],
      source: READ_SOURCE,
    });
    // 2. Apply slippage floor: min_out = expected * (10000 - bps) / 10000.
    const minOut =
      (expected * BigInt(10_000 - maxSlippageBps)) / 10_000n;

    const xdr = await buildInvocationXdr({
      source: user,
      contractId: vault,
      method: "redeem",
      args: [addrScVal(user), i128ScVal(shares), i128ScVal(minOut)],
    });
    return c.json({
      xdr,
      vault,
      asset,
      preview: { expected: expected.toString(), minOut: minOut.toString(), maxSlippageBps },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

vaultRoutes.get("/addresses", (c) => {
  return c.json({ network: DEFAULT_NETWORK, addresses: forNetwork(DEFAULT_NETWORK) });
});
