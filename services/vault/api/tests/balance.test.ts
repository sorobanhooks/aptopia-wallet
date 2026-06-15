// T5/T11 — GET /balance/:address.
//
// Covers: address validation (G... 56 chars), 4-way Promise.all aggregation,
// per-contract balance() reads, and the 3-second TTL cache (T11) — second
// hit within the window must NOT call simulateRead again.

import { describe, expect, mock, test } from "bun:test";

let readsByContract: Record<string, bigint> = {};
let readCallCount = 0;

mock.module("../src/rpc", () => ({
  simulateRead: async ({ contractId, method }: { contractId: string; method: string }) => {
    readCallCount += 1;
    if (method !== "balance") throw new Error(`unexpected method: ${method}`);
    if (!(contractId in readsByContract)) {
      // Mimic an account-not-yet-funded read: throw, route swallows to 0.
      throw new Error(`no balance entry: ${contractId}`);
    }
    return readsByContract[contractId];
  },
  addrScVal: () => ({}),
  i128ScVal: () => ({}),
  buildInvocationXdr: async () => "FAKE_XDR",
  submitSignedXdr: async () => ({ hash: "FAKE", status: "SUCCESS", returnValue: null }),
}));

const { balanceRoutes } = await import("../src/routes/balance");
const { TESTNET } = await import("../src/addresses");

const USER_A = "GBXY4WRVA2ELQQKHM4LZEBM4PCMR43GDFXZ5GA62GU4HEKWV43BHWKVT";
const USER_B = "GA2HGBJIJKI6O4XPG4LHCQIUJGT2I63K7JN42CIGZW2KFMVKNXGZ5K7P";

describe("GET /balance/:address — address validation", () => {
  test("non-G prefix → 400", async () => {
    const res = await balanceRoutes.fetch(new Request("http://test/balance/CABCDEFG"));
    expect(res.status).toBe(400);
  });

  test("wrong length → 400", async () => {
    const res = await balanceRoutes.fetch(new Request("http://test/balance/GSHORT"));
    expect(res.status).toBe(400);
  });
});

describe("GET /balance/:address — aggregation", () => {
  test("returns 4 balances in parallel; missing entries default to 0", async () => {
    readsByContract = {
      [TESTNET.vaultXlm]: 1_000n,
      [TESTNET.vaultUsdc]: 2_000n,
      [TESTNET.xlmSac]: 3_000n,
      // usdc SAC intentionally absent → swallowed to "0".
    };
    readCallCount = 0;

    const res = await balanceRoutes.fetch(new Request(`http://test/balance/${USER_A}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.address).toBe(USER_A);
    expect(body.stxlm).toBe("1000");
    expect(body.stusdc).toBe("2000");
    expect(body.xlm).toBe("3000");
    expect(body.usdc).toBe("0");
    expect(readCallCount).toBe(4);
  });
});

describe("GET /balance/:address — T11 cache regression", () => {
  test("second read within TTL serves from cache (no extra RPC calls)", async () => {
    readsByContract = {
      [TESTNET.vaultXlm]: 7n,
      [TESTNET.vaultUsdc]: 7n,
      [TESTNET.xlmSac]: 7n,
      [TESTNET.usdcSac]: 7n,
    };
    readCallCount = 0;

    const url = `http://test/balance/${USER_B}`;
    await balanceRoutes.fetch(new Request(url));
    const before = readCallCount; // expect 4
    await balanceRoutes.fetch(new Request(url));
    expect(readCallCount).toBe(before); // no further reads — cached
  });
});
