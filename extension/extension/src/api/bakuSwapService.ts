import { fetchJson } from "popup/helpers/fetch";
import { BAKU_API_URL } from "constants/env";
import { SubmitResponse } from "./yieldHubTypes";

export type SwapSymbol = "xlm" | "usdc";

export interface SwapPreview {
  venue: "soroswap";
  tokenIn: SwapSymbol;
  tokenOut: SwapSymbol;
  amountIn: string; // base units
  expectedOut: string; // base units
  minOut: string; // base units
  maxSlippageBps: number;
  rate: string;
}

export interface SwapBuildTxResponse {
  xdr: string;
  router: string;
  preview: SwapPreview;
}

class BakuSwapService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = BAKU_API_URL;
  }

  async buildSwap(params: {
    user: string;
    tokenIn: SwapSymbol;
    tokenOut: SwapSymbol;
    amountIn: string; // base units
    maxSlippageBps?: number;
  }): Promise<SwapBuildTxResponse> {
    return fetchJson<SwapBuildTxResponse>(`${this.baseUrl}/swap/build-tx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  }

  // Mirrors yieldHubService.submitSignedTx — both POST the generic Baku /tx/submit
  // endpoint. Kept per-feature so the swap flow uses one self-contained client.
  async submitSignedTx(signedXdr: string): Promise<SubmitResponse> {
    return fetchJson<SubmitResponse>(`${this.baseUrl}/tx/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signed_xdr: signedXdr }),
    });
  }
}

export const bakuSwapService = new BakuSwapService();
