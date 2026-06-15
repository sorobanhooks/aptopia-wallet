// vault/api/tests/swap-build.test.ts
import { describe, expect, mock, test } from "bun:test";

let simulateAmounts: bigint[] = [];
let simulateThrow: string | null = null;
let buildArgs: unknown[] | null = null;
let buildContract: string | null = null;
let buildMethod: string | null = null;

mock.module("../src/rpc", () => ({
  simulateRead: async ({ method }: { method: string }) => {
    if (simulateThrow) throw new Error(simulateThrow);
    if (method === "swap_exact_tokens_for_tokens") return simulateAmounts;
    throw new Error(`unmocked simulateRead: ${method}`);
  },
  addrScVal: (addr: string) => ({ tag: "Address", value: addr }),
  i128ScVal: (amount: string | bigint) => ({ tag: "I128", value: String(amount) }),
  u64ScVal: (v: string | number | bigint) => ({ tag: "U64", value: String(v) }),
  pathScVal: (addrs: string[]) => ({ tag: "Vec", value: addrs }),
  buildInvocationXdr: async (opts: {
    contractId: string;
    method: string;
    args: unknown[];
  }) => {
    buildContract = opts.contractId;
    buildMethod = opts.method;
    buildArgs = opts.args;
    return "FAKE_SWAP_XDR";
  },
}));

const { swapRoutes } = await import("../src/routes/swap");

const USER = "GBXY4WRVA2ELQQKHM4LZEBM4PCMR43GDFXZ5GA62GU4HEKWV43BHWKVT";
const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

async function postJson(path: string, body: unknown) {
  return swapRoutes.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /swap/build-tx", () => {
  test("happy path: router call, arg order, min-out floor", async () => {
    simulateThrow = null;
    simulateAmounts = [5000000n, 38000000n]; // 5 USDC -> 38 XLM
    buildArgs = null;
    const res = await postJson("/swap/build-tx", {
      user: USER, tokenIn: "usdc", tokenOut: "xlm", amountIn: "5000000", maxSlippageBps: 50,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.xdr).toBe("FAKE_SWAP_XDR");
    expect(buildContract).toBe(ROUTER);
    expect(buildMethod).toBe("swap_exact_tokens_for_tokens");
    expect(body.preview.expectedOut).toBe("38000000");
    // minOut = 38000000 * (10000-50) / 10000 = 37810000
    expect(body.preview.minOut).toBe("37810000");
    expect(body.preview.tokenIn).toBe("usdc");
    expect(body.preview.tokenOut).toBe("xlm");
    // arg order MUST match the router: [amountIn, amountOutMin, path, to, deadline]
    expect(buildArgs?.[0]).toEqual({ tag: "I128", value: "5000000" });
    expect(buildArgs?.[1]).toEqual({ tag: "I128", value: "37810000" });
    expect((buildArgs?.[2] as any).tag).toBe("Vec");
    expect(buildArgs?.[3]).toEqual({ tag: "Address", value: USER });
    expect((buildArgs?.[4] as any).tag).toBe("U64");
  });

  test("rejects identical tokenIn/tokenOut", async () => {
    const res = await postJson("/swap/build-tx", { user: USER, tokenIn: "xlm", tokenOut: "xlm", amountIn: "1" });
    expect(res.status).toBe(400);
  });

  test("rejects unknown token", async () => {
    const res = await postJson("/swap/build-tx", { user: USER, tokenIn: "doge", tokenOut: "xlm", amountIn: "1" });
    expect(res.status).toBe(400);
  });

  test("rejects non-integer base-unit amountIn", async () => {
    const res = await postJson("/swap/build-tx", { user: USER, tokenIn: "usdc", tokenOut: "xlm", amountIn: "5.5" });
    expect(res.status).toBe(400);
  });

  test("rejects missing user", async () => {
    const res = await postJson("/swap/build-tx", { tokenIn: "usdc", tokenOut: "xlm", amountIn: "1" });
    expect(res.status).toBe(400);
  });

  test("insufficient balance simulation → friendly 400", async () => {
    simulateThrow = "HostError: Error(Contract, #10) ... insufficient balance";
    const res = await postJson("/swap/build-tx", {
      user: USER, tokenIn: "usdc", tokenOut: "xlm", amountIn: "5000000", maxSlippageBps: 50,
    });
    simulateThrow = null;
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/holds enough USDC/i);
  });
});
