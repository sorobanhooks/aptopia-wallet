import { wallet } from "@shared/helpers/stellar";
import { BuildTrustlineTransactionMessage } from "@shared/api/types/message-request";

export const buildTrustlineTransaction = async ({
  request,
}: {
  request: BuildTrustlineTransactionMessage;
}) => {
  const { assetCode, assetIssuer, limit, activePublicKey, networkDetails } =
    request;

  try {
    // Configure the wallet for the current network
    wallet.setNetworkConfig({
      network: networkDetails.network === "public" ? "public" : "testnet",
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

    // Use the SDK to build the trustline transaction
    return await wallet.buildTrustlineTransaction(assetCode, assetIssuer, limit);
  } catch (error: any) {
    console.error("SDK trustline build failed:", error);
    return { error: error.message || "Failed to build trustline transaction" };
  }
};
