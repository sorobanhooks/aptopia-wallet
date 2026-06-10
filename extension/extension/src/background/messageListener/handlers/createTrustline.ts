import { wallet } from "@shared/helpers/stellar";
import { CreateTrustlineMessage } from "@shared/api/types/message-request";

export const createTrustline = async ({
  request,
}: {
  request: CreateTrustlineMessage;
}) => {
  const { assetCode, assetIssuer, limit, activePublicKey, networkDetails } = request;

  // Configure the wallet for the current network
  wallet.setNetworkConfig({
    network: networkDetails.network === "public" ? "public" : "testnet",
    apiKey: (wallet as any).config?.apiKey || "qomjjag2a9gq95uhlnzhl",
  } as any);

  if (activePublicKey) {
    try {
      wallet.selectAccount(activePublicKey);
    } catch (e) {
      // ignore
    }
  }

  return await wallet.createTrustline(assetCode, assetIssuer, limit);
};
