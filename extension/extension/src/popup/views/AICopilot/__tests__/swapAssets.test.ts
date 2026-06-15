// __tests__/swapAssets.test.ts
import { StrKey } from "stellar-sdk";
import {
  SWAP_USDC_CODE,
  SWAP_USDC_ISSUER,
  SWAP_USDC_CANONICAL,
  ACCOUNT_BASE_MIN_XLM,
  PER_ENTRY_RESERVE_XLM,
} from "../swapAssets";

describe("swapAssets", () => {
  it("pins the swap USDC to Circle's testnet issuer (must match Baku tokenOut)", () => {
    // Circle testnet USDC issuer — see vault/api/src/addresses.ts (circleUsdcSac).
    // The Blend vault USDC (GATALTGT…) is a DIFFERENT asset and must NOT be used.
    expect(SWAP_USDC_ISSUER).toBe(
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
    expect(StrKey.isValidEd25519PublicKey(SWAP_USDC_ISSUER)).toBe(true);
    expect(SWAP_USDC_CANONICAL).toBe(`${SWAP_USDC_CODE}:${SWAP_USDC_ISSUER}`);
  });

  it("uses Stellar base-reserve math (0.5 XLM/subentry)", () => {
    expect(ACCOUNT_BASE_MIN_XLM).toBe(1);
    expect(PER_ENTRY_RESERVE_XLM).toBe(0.5);
  });
});
