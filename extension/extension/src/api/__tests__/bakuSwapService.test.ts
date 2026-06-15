import * as fetchHelper from "popup/helpers/fetch";
import { bakuSwapService } from "../bakuSwapService";

describe("bakuSwapService.buildSwap", () => {
  it("POSTs the swap params and returns the build response", async () => {
    const spy = jest
      .spyOn(fetchHelper, "fetchJson")
      .mockResolvedValue({
        xdr: "XDR1",
        router: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
        preview: {
          venue: "soroswap",
          tokenIn: "usdc",
          tokenOut: "xlm",
          amountIn: "5000000",
          expectedOut: "38000000",
          minOut: "37810000",
          maxSlippageBps: 50,
          rate: "7.6",
        },
      });

    const res = await bakuSwapService.buildSwap({
      user: "GUSER", tokenIn: "usdc", tokenOut: "xlm", amountIn: "5000000", maxSlippageBps: 50,
    });

    expect(res.xdr).toBe("XDR1");
    expect(res.preview.minOut).toBe("37810000");
    const [url, opts] = spy.mock.calls[0];
    expect(url).toContain("/swap/build-tx");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      user: "GUSER", tokenIn: "usdc", tokenOut: "xlm", amountIn: "5000000", maxSlippageBps: 50,
    });
  });
});
