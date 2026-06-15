// T10 tracer — proves GET /vault/usdc/strategies maps a 2-strategy registry
// to the expected JSON shape, with the active strategy flagged correctly.
//
// The vault-side registry behavior is covered by the Rust unit test
// `multi_strategy_registry_tracer` in crates/vault/src/test.rs. This file
// covers the API shape only — RPC is stubbed at the module boundary, so
// the test runs without testnet access and without a deployed Soroswap
// strategy. The live integration version (curl against the deployed API
// after `DEPLOY_USDC=1` + a future SoroswapStrategy deploy) is a
// post-deploy smoke check, not a CI test.

import { describe, expect, mock, test } from "bun:test";

const FAKE_BLEND_USDC = "CBO2FI6D6CCDSUT33QS537NQDCR7ZN5EMVOBQUTBA5YNUOXRFWWTWJZK";
const FAKE_SOROSWAP_USDC = "CASOROSWAPSTRATEGYUSDCFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFA";

mock.module("../src/rpc", () => ({
  simulateRead: async ({ method }: { method: string }) => {
    if (method === "strategy_registry") return [FAKE_BLEND_USDC, FAKE_SOROSWAP_USDC];
    if (method === "active_strategy") return FAKE_BLEND_USDC;
    throw new Error(`unexpected simulateRead in strategies tracer: ${method}`);
  },
  addrScVal: () => ({}),
  i128ScVal: () => ({}),
  buildInvocationXdr: async () => "FAKE_XDR",
  submitSignedXdr: async () => ({ hash: "FAKE", status: "SUCCESS", returnValue: null }),
}));

const { vaultRoutes } = await import("../src/routes/vault");

describe("GET /vault/usdc/strategies (T10 tracer)", () => {
  test("returns both Blend and Soroswap addresses with active flag on Blend", async () => {
    const res = await vaultRoutes.fetch(new Request("http://test/vault/usdc/strategies"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      network: string;
      asset: string;
      vault: string;
      active: string;
      registered: { address: string; isActive: boolean }[];
    };

    expect(body.asset).toBe("usdc");
    expect(body.network).toBe("testnet");
    expect(body.active).toBe(FAKE_BLEND_USDC);
    expect(body.registered).toHaveLength(2);
    expect(body.registered[0]).toEqual({ address: FAKE_BLEND_USDC, isActive: true });
    expect(body.registered[1]).toEqual({ address: FAKE_SOROSWAP_USDC, isActive: false });
  });
});
