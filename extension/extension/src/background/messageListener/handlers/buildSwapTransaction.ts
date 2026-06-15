import { wallet } from "@shared/helpers/stellar";
import { BuildSwapTransactionMessage } from "@shared/api/types/message-request";

export const buildSwapTransaction = async ({
  request,
}: {
  request: BuildSwapTransactionMessage;
}) => {
  const {
    sourceAsset,
    destAsset,
    amount,
    slippagePercent,
    memo,
    fee,
    timeoutSeconds,
    activePublicKey,
    networkDetails,
  } = request;

  try {
    // Configure the wallet for the current network
    wallet.setNetworkConfig({
      network: networkDetails.network === "public" ? "mainnet" : "testnet",
      apiKey:
        (wallet as any).config?.apiKey || process.env.API_KEY || "unconfigured",
    } as any);

    if (activePublicKey) {
      try {
        wallet.selectAccount(activePublicKey);
      } catch (e) {
        // ignore if account is not yet in the SDK's internal vault
      }
    }

    // Use the SDK method to build the swap transaction
    const xdr = await wallet.buildSwapTransaction({
      sourceAsset,
      destAsset,
      amount,
      slippagePercent: slippagePercent ? Number(slippagePercent) : 0,
      memo,
      fee,
      timeoutSeconds,
      sourceAccount: activePublicKey,
    });

    // Use the SDK method to get the quote
    const quote = await wallet.getSwapQuote({
      sourceAsset,
      destAsset,
      amount,
      mode: "strictSend",
    });

    return { xdr, quote };
  } catch (error: any) {
    console.error("SDK swap build failed:", error);
    return { error: error.message || "Failed to build swap transaction" };
  }
};

