import { Horizon, TransactionBuilder } from "stellar-sdk";
import { wallet } from "@shared/helpers/stellar";
import { SubmitFreighterTransactionMessage } from "@shared/api/types/message-request";

export const submitFreighterTransaction = async ({
  request,
}: {
  request: SubmitFreighterTransactionMessage;
}) => {
  const { signedXDR, networkDetails } = request;

  // Configuration for SDK (legacy/fallback)
  wallet.setNetworkConfig({
    network: networkDetails.network === "public" ? "public" : "testnet",
    apiKey:
      (wallet as any).config?.apiKey || process.env.API_KEY || "unconfigured",
  } as any);

  try {
    // 1. DEFAULT: Try with SDK wallet first (proxy-based)
    const response = await wallet.submitXDR(signedXDR);
    return response;
  } catch (sdkError: any) {
    console.warn("Wallet SDK submission failed, trying direct Horizon fallback:", sdkError);

    // 2. FALLBACK: Direct Horizon submission to bypass proxy restrictions
    try {
      const server = new Horizon.Server(networkDetails.networkUrl);
      const transaction = TransactionBuilder.fromXDR(
        signedXDR,
        networkDetails.networkPassphrase,
      );
      const result = await server.submitTransaction(transaction);
      return result;
    } catch (fallbackError: any) {
      console.error("Direct Horizon submission fallback also failed:", fallbackError);
      
      // If Horizon explicitly says something is wrong (400), return codes for UI parsing
      if (fallbackError.response?.status === 400 && fallbackError.response?.data?.extras?.result_codes) {
        return { 
          error: fallbackError.message, 
          response: { extras: fallbackError.response.data.extras } 
        };
      }
      
      // Return original SDK error if fallback also fails or generic error occurs
      return { 
        error: sdkError.message || "Transaction submission failed", 
        response: sdkError.response?.data 
      };
    }
  }
};
