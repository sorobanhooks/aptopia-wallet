// vault/api/tests/swap-addresses.test.ts
import { describe, expect, test } from "bun:test";
import { swapTokenSacFor } from "../src/addresses";

describe("swapTokenSacFor", () => {
  test("xlm resolves to the native SAC", () => {
    expect(swapTokenSacFor("testnet", "xlm")).toBe(
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    );
  });
  test("usdc resolves to CIRCLE USDC (the Soroswap-paired token), not Blend USDC", () => {
    expect(swapTokenSacFor("testnet", "usdc")).toBe(
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    );
  });
});
