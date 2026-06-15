// T5 — POST /vault/:asset/{deposit,withdraw}/build-tx
//
// Headline test: D10 regression — withdraw/build-tx MUST compute
// min_amount_out = preview * (10000 - max_slippage_bps) / 10000 and pass
// it to redeem() as the third positional arg. Wallet sends a tiny payload,
// server bakes the floor in.

import { describe, expect, mock, test } from "bun:test";

let previewRedeem = 0n;
let buildArgs: unknown[] | null = null;

mock.module("../src/rpc", () => ({
  simulateRead: async ({ method }: { method: string }) => {
    if (method === "preview_redeem") return previewRedeem;
    throw new Error(`unmocked simulateRead: ${method}`);
  },
  addrScVal: (addr: string) => ({ tag: "Address", value: addr }),
  i128ScVal: (amount: string | bigint) => ({ tag: "I128", value: String(amount) }),
  buildInvocationXdr: async (opts: { args: unknown[] }) => {
    buildArgs = opts.args;
    return "FAKE_XDR_PAYLOAD";
  },
  submitSignedXdr: async () => ({ hash: "FAKE", status: "SUCCESS", returnValue: null }),
}));

const { vaultRoutes } = await import("../src/routes/vault");

const USER = "GBXY4WRVA2ELQQKHM4LZEBM4PCMR43GDFXZ5GA62GU4HEKWV43BHWKVT";

async function postJson(path: string, body: unknown) {
  return vaultRoutes.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /vault/:asset/deposit/build-tx", () => {
  test("happy path: returns xdr + echoes vault/asset", async () => {
    buildArgs = null;
    const res = await postJson("/vault/usdc/deposit/build-tx", {
      user: USER,
      amount: "5000000",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.xdr).toBe("FAKE_XDR_PAYLOAD");
    expect(body.asset).toBe("usdc");
    expect(buildArgs).not.toBeNull();
    // [user, amount] — bound to the deposit() contract method signature.
    expect(buildArgs).toEqual([
      { tag: "Address", value: USER },
      { tag: "I128", value: "5000000" },
    ]);
  });

  test("missing fields → 400", async () => {
    const res = await postJson("/vault/usdc/deposit/build-tx", { user: USER });
    expect(res.status).toBe(400);
  });
});

describe("POST /vault/:asset/withdraw/build-tx (D10 regression)", () => {
  test("default 100 bps slippage → min_out = expected * 0.99", async () => {
    previewRedeem = 1_000_000n;
    buildArgs = null;
    const res = await postJson("/vault/usdc/withdraw/build-tx", {
      user: USER,
      shares: "1000000",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      preview: { expected: string; minOut: string; maxSlippageBps: number };
    };
    expect(body.preview.expected).toBe("1000000");
    expect(body.preview.minOut).toBe("990000"); // 1_000_000 * 9900 / 10_000
    expect(body.preview.maxSlippageBps).toBe(100);
    // Verify the XDR actually got the minOut as 3rd arg.
    expect(buildArgs).toEqual([
      { tag: "Address", value: USER },
      { tag: "I128", value: "1000000" },
      { tag: "I128", value: "990000" },
    ]);
  });

  test("explicit 500 bps → min_out = expected * 0.95", async () => {
    previewRedeem = 2_000_000n;
    const res = await postJson("/vault/usdc/withdraw/build-tx", {
      user: USER,
      shares: "2000000",
      max_slippage_bps: 500,
    });
    const body = (await res.json()) as { preview: { minOut: string } };
    expect(body.preview.minOut).toBe("1900000"); // 2_000_000 * 9500 / 10_000
  });

  test("0 bps → min_out equals expected exactly", async () => {
    previewRedeem = 1_234_567n;
    const res = await postJson("/vault/usdc/withdraw/build-tx", {
      user: USER,
      shares: "100",
      max_slippage_bps: 0,
    });
    const body = (await res.json()) as { preview: { minOut: string } };
    expect(body.preview.minOut).toBe("1234567");
  });

  test("max_slippage_bps out of [0, 10000] → 400", async () => {
    for (const bps of [-1, 10_001, 1.5]) {
      const res = await postJson("/vault/usdc/withdraw/build-tx", {
        user: USER,
        shares: "100",
        max_slippage_bps: bps,
      });
      expect(res.status).toBe(400);
    }
  });

  test("missing fields → 400", async () => {
    const res = await postJson("/vault/usdc/withdraw/build-tx", { user: USER });
    expect(res.status).toBe(400);
  });
});
