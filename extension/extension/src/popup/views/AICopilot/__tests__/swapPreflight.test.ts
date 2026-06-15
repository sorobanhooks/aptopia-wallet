// __tests__/swapPreflight.test.ts
import { preflightSwap, AccountState } from "../swapPreflight";

const funded = (over: Partial<AccountState> = {}): AccountState => ({
  funded: true,
  nativeXlm: "100",
  usdc: { hasTrustline: true, balance: "10" },
  ...over,
});

describe("preflightSwap", () => {
  it("ready when XLM→USDC has trustline and enough XLM", () => {
    expect(
      preflightSwap({ direction: "xlm_to_usdc", amountIn: "5", account: funded() }),
    ).toEqual({ status: "ready" });
  });

  it("unfunded short-circuits to a single blocker", () => {
    const r = preflightSwap({
      direction: "xlm_to_usdc",
      amountIn: "5",
      account: { funded: false, nativeXlm: "0", usdc: { hasTrustline: false, balance: "0" } },
    });
    expect(r).toEqual({ status: "blocked", blockers: [{ kind: "unfunded" }] });
  });

  it("XLM→USDC with no trustline (but enough XLM) → missing_usdc_trustline", () => {
    const r = preflightSwap({
      direction: "xlm_to_usdc",
      amountIn: "5",
      account: funded({ usdc: { hasTrustline: false, balance: "0" } }),
    });
    expect(r.status).toBe("blocked");
    expect((r as any).blockers[0]).toEqual({
      kind: "missing_usdc_trustline",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    });
  });

  it("insufficient XLM leads ahead of a missing trustline", () => {
    // need = 5 + 0.5 fee + 1 base + 0.5 trustline = 7; have 6 → short 1
    const r = preflightSwap({
      direction: "xlm_to_usdc",
      amountIn: "5",
      account: funded({ nativeXlm: "6", usdc: { hasTrustline: false, balance: "0" } }),
    });
    expect(r.status).toBe("blocked");
    expect((r as any).blockers[0].kind).toBe("insufficient_xlm");
    expect((r as any).blockers[0].shortfall).toBe("1");
  });

  it("USDC→XLM with too little USDC → insufficient_usdc", () => {
    const r = preflightSwap({
      direction: "usdc_to_xlm",
      amountIn: "5",
      account: funded({ usdc: { hasTrustline: true, balance: "3" } }),
    });
    expect(r.status).toBe("blocked");
    expect((r as any).blockers[0]).toMatchObject({
      kind: "insufficient_usdc",
      shortfall: "2",
    });
  });

  it("USDC→XLM needs no trustline when USDC balance is enough", () => {
    expect(
      preflightSwap({
        direction: "usdc_to_xlm",
        amountIn: "5",
        account: funded({ usdc: { hasTrustline: true, balance: "5" } }),
      }),
    ).toEqual({ status: "ready" });
  });
});
