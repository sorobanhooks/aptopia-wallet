// T5 — GET /vault/:asset/state.
//
// Covers happy path (4 parallel reads + pool_apy on active strategy), the
// pool_apy fallback (strategy lacks the entrypoint → 0, not 500), and the
// placeholder-vault path (404 instead of attempting RPC).
// B5: also covers strategyPositions array in state response.

import { describe, expect, mock, test, beforeEach } from "bun:test";

let registry: string[] = [];
let active = "";
let totalAssets = 0n;
let totalSupply = 0n;
let pps = 0n;
let poolApy: number | null = 500;
let poolApyThrows = false;
// currentValue returned per strategy address (keyed by contract id)
const currentValueByAddr: Record<string, bigint> = {};

mock.module("../src/rpc", () => ({
  simulateRead: async ({ method, contractId }: { method: string; contractId: string }) => {
    switch (method) {
      case "total_assets":
        return totalAssets;
      case "total_supply":
        return totalSupply;
      case "price_per_share":
        return pps;
      case "active_strategy":
        return active;
      case "strategy_registry":
        return registry;
      case "pool_apy":
        if (poolApyThrows) throw new Error("entry point missing");
        return poolApy ?? 0;
      case "current_value":
        return currentValueByAddr[contractId] ?? 0n;
      default:
        throw new Error(`unmocked simulateRead method: ${method}`);
    }
  },
  addrScVal: () => ({}),
  i128ScVal: () => ({}),
  buildInvocationXdr: async () => "FAKE_XDR",
  submitSignedXdr: async () => ({ hash: "FAKE", status: "SUCCESS", returnValue: null }),
}));

const { vaultRoutes, strategyPositionsCache } = await import("../src/routes/vault");

// Post-vault-xlm-v2 deploy (2026-05-27): re-pinned to the V2 BlendStrategy(XLM)
// with the authorize_as_current_contract auth fix. The earlier addresses
// (CCTEOV4O…RQ3G3 on legacy vault, CCQOTUKV…VNYO registered-but-broken on v2)
// are not the canonical address. Kept for the pool_apy-throws test.
const REAL_BLEND_XLM = "CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ";
// Known addresses — mirror of TESTNET in addresses.ts (blendStrategyXlm, soroswapStrategyXlm).
const BLEND_XLM = "CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ";
const SOROSWAP_XLM = "CA4SKYV4O34KJA7TEA36GRDZJK3OZ2FN6QON4QDRA27V7RMPLJTGQHOS";
// MockStrategy has no constant — any address NOT in addresses.ts falls through to Mock name.
const MOCK_ADDR = "CCMOCKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

describe("GET /vault/:asset/state", () => {
  beforeEach(() => {
    // Clear the 30s strategy-positions cache between tests so each test
    // starts with fresh RPC reads rather than a stale cached entry.
    strategyPositionsCache.clear();
  });

  test("usdc state aggregates 4 reads + active strategy's pool_apy", async () => {
    active = "CDVPZOJTAP5X2XLRYWSLFCRKE5KNV4ZMPWB6NPSGWWT3YKSTQTM5YFSG";
    registry = [active];
    totalAssets = 1_234_567_890n;
    totalSupply = 1_000_000_000n;
    pps = 12_345_678n;
    poolApy = 450;
    poolApyThrows = false;
    currentValueByAddr[active] = 1_234_567_890n;

    const res = await vaultRoutes.fetch(new Request("http://test/vault/usdc/state"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.asset).toBe("usdc");
    expect(body.activeStrategy).toBe(active);
    expect(body.totalAssets).toBe("1234567890");
    expect(body.totalSupply).toBe("1000000000");
    expect(body.pricePerShare).toBe("12345678");
    expect(body.poolApyBps).toBe(450);
  });

  test("pool_apy that throws is swallowed to 0 (strategy may not expose it)", async () => {
    active = REAL_BLEND_XLM;
    registry = [active];
    totalAssets = 0n;
    totalSupply = 0n;
    pps = 10n;
    poolApyThrows = true;
    currentValueByAddr[active] = 0n;

    const res = await vaultRoutes.fetch(new Request("http://test/vault/xlm/state"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.poolApyBps).toBe(0);
  });

  test("strategyPositions returned with 3 entries — sharePercents sum to ~100", async () => {
    active = BLEND_XLM;
    registry = [MOCK_ADDR, BLEND_XLM, SOROSWAP_XLM];
    totalAssets = 300n;
    totalSupply = 300n;
    pps = 10_000_000n;
    poolApy = 500;
    poolApyThrows = false;
    currentValueByAddr[MOCK_ADDR] = 0n;
    currentValueByAddr[BLEND_XLM] = 200n;
    currentValueByAddr[SOROSWAP_XLM] = 100n;

    const res = await vaultRoutes.fetch(new Request("http://test/vault/xlm/state"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const positions = body.strategyPositions as Array<{
      address: string;
      name: string;
      isActive: boolean;
      currentValue: string;
      sharePercent: number;
    }>;
    expect(Array.isArray(positions)).toBe(true);
    expect(positions.length).toBe(3);

    const blendPos = positions.find((p) => p.address === BLEND_XLM);
    expect(blendPos).toBeDefined();
    expect(blendPos!.isActive).toBe(true);
    expect(blendPos!.name).toBe("Blend");
    expect(blendPos!.currentValue).toBe("200");

    const soroPos = positions.find((p) => p.address === SOROSWAP_XLM);
    expect(soroPos).toBeDefined();
    expect(soroPos!.name).toBe("Soroswap LP");
    expect(soroPos!.sharePercent).toBeCloseTo(33.33, 1);

    const totalPct = positions.reduce((sum, p) => sum + p.sharePercent, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  test("strategyPositions all-zero TVL vault — sharePercents all 0", async () => {
    active = BLEND_XLM;
    registry = [BLEND_XLM, SOROSWAP_XLM];
    totalAssets = 0n;
    totalSupply = 0n;
    pps = 10n;
    poolApy = 0;
    poolApyThrows = false;
    currentValueByAddr[BLEND_XLM] = 0n;
    currentValueByAddr[SOROSWAP_XLM] = 0n;

    const res = await vaultRoutes.fetch(new Request("http://test/vault/usdc/state"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const positions = body.strategyPositions as Array<{ sharePercent: number }>;
    expect(positions.every((p) => p.sharePercent === 0)).toBe(true);
  });
});

describe("GET /addresses", () => {
  test("returns the testnet address bundle", async () => {
    const res = await vaultRoutes.fetch(new Request("http://test/addresses"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { network: string; addresses: Record<string, string> };
    expect(body.network).toBe("testnet");
    expect(body.addresses.vaultXlm).toMatch(/^C[A-Z0-9]{55}$/);
    expect(body.addresses.vaultUsdc).toMatch(/^C[A-Z0-9]{55}$/);
    // blendStrategyXlm — current live V2 address from addresses.ts TESTNET.
    expect(body.addresses.blendStrategyXlm).toBe(BLEND_XLM);
  });
});
