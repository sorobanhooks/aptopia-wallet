// __tests__/accountState.test.ts
import { accountStateFromHorizonBalances, fetchAccountState } from "../accountState";
import { SWAP_USDC_ISSUER } from "../swapAssets";
import { TESTNET_NETWORK_DETAILS } from "@shared/constants/stellar";

const native = (balance: string) => ({ asset_type: "native", balance });
const usdcLine = (balance: string, issuer = SWAP_USDC_ISSUER) => ({
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: issuer,
  balance,
});

describe("accountStateFromHorizonBalances", () => {
  it("maps native XLM and a present USDC trustline (matched by code+issuer)", () => {
    expect(accountStateFromHorizonBalances([native("42.5"), usdcLine("7")])).toEqual({
      funded: true,
      nativeXlm: "42.5",
      usdc: { hasTrustline: true, balance: "7" },
    });
  });

  it("reports no trustline when only native is present", () => {
    expect(accountStateFromHorizonBalances([native("5")])).toEqual({
      funded: true,
      nativeXlm: "5",
      usdc: { hasTrustline: false, balance: "0" },
    });
  });

  it("ignores a USDC from a DIFFERENT issuer (e.g. the Blend vault USDC)", () => {
    const r = accountStateFromHorizonBalances([
      native("5"),
      usdcLine("9", "GATALTGTWIATBUOCYH3HOOTHFLNDGAS6AYAEGZHKCY3YJTFXZTJDDP2A"),
    ]);
    expect(r.usdc).toEqual({ hasTrustline: false, balance: "0" });
  });

  it("handles empty / undefined balances", () => {
    expect(accountStateFromHorizonBalances(undefined)).toEqual({
      funded: true,
      nativeXlm: "0",
      usdc: { hasTrustline: false, balance: "0" },
    });
  });
});

describe("fetchAccountState", () => {
  afterEach(() => jest.restoreAllMocks());

  it("treats a Horizon 404 as an unfunded account", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ status: 404, ok: false } as Response);
    await expect(fetchAccountState("GABC", TESTNET_NETWORK_DETAILS)).resolves.toEqual({
      funded: false,
      nativeXlm: "0",
      usdc: { hasTrustline: false, balance: "0" },
    });
  });

  it("maps a funded Horizon account", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ balances: [native("100"), usdcLine("10")] }),
    } as Response);
    await expect(fetchAccountState("GABC", TESTNET_NETWORK_DETAILS)).resolves.toEqual({
      funded: true,
      nativeXlm: "100",
      usdc: { hasTrustline: true, balance: "10" },
    });
  });

  it("calls Horizon /accounts/<pk> on the network's Horizon URL", async () => {
    const spy = jest.spyOn(global, "fetch").mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ balances: [] }),
    } as Response);
    await fetchAccountState("GXYZ", TESTNET_NETWORK_DETAILS);
    expect(spy).toHaveBeenCalledWith("https://horizon-testnet.stellar.org/accounts/GXYZ");
  });
});
