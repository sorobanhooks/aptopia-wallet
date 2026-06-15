import { wallet } from "@shared/helpers/stellar";
import {
  getTokenPricesDeduped,
  __resetTokenPriceDedupe,
  TOKEN_PRICE_TTL_MS,
} from "@shared/helpers/tokenPrices";

const nativeBalances = [{ assetType: "native", balance: "0" }];
const usdcBalances = [
  {
    assetType: "credit_alphanum4",
    assetCode: "USDC",
    assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    balance: "0",
  },
];

describe("getTokenPricesDeduped", () => {
  afterEach(() => {
    __resetTokenPriceDedupe();
    jest.restoreAllMocks();
  });

  it("collapses concurrent calls for the same assets into a single SDK request", async () => {
    const spy = jest.spyOn(wallet, "getTokenPrices").mockResolvedValue({
      native: { currentPrice: 1, percentagePriceChange24h: null },
    } as any);

    const [a, b, c] = await Promise.all([
      getTokenPricesDeduped(nativeBalances),
      getTokenPricesDeduped(nativeBalances),
      getTokenPricesDeduped(nativeBalances),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("serves cached prices for repeat calls within the TTL window", async () => {
    const spy = jest.spyOn(wallet, "getTokenPrices").mockResolvedValue({
      native: { currentPrice: 1, percentagePriceChange24h: null },
    } as any);

    await getTokenPricesDeduped(nativeBalances);
    await getTokenPricesDeduped(nativeBalances);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL window has elapsed", async () => {
    const spy = jest.spyOn(wallet, "getTokenPrices").mockResolvedValue({
      native: { currentPrice: 1, percentagePriceChange24h: null },
    } as any);
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);

    await getTokenPricesDeduped(nativeBalances);
    nowSpy.mockReturnValue(1_000_000 + TOKEN_PRICE_TTL_MS + 1_000);
    await getTokenPricesDeduped(nativeBalances);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("fetches separately for distinct asset sets", async () => {
    const spy = jest
      .spyOn(wallet, "getTokenPrices")
      .mockResolvedValue({} as any);

    await getTokenPricesDeduped(nativeBalances);
    await getTokenPricesDeduped(usdcBalances);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns an empty map for no balances without calling the SDK", async () => {
    const spy = jest
      .spyOn(wallet, "getTokenPrices")
      .mockResolvedValue({} as any);

    const result = await getTokenPricesDeduped([]);

    expect(result).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });
});
