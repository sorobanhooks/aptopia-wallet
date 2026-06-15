import { wallet } from "@shared/helpers/stellar";
import { AddCollectibleMessage } from "@shared/api/types/message-request";
import { CollectibleContract } from "@shared/api/types/types";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import { COLLECTIBLES_ID } from "constants/localStorageTypes";

export const addCollectible = async ({
  request,
  localStore,
}: {
  request: AddCollectibleMessage;
  localStore: DataStorageAccess;
}) => {
  const { network, publicKey, collectibleContractAddress, collectibleTokenId } =
    request;

  try {
    // Configure network for the wallet (needed for Soroban RPC)
    wallet.setNetworkConfig({
      network: network === "public" ? "public" : "testnet",
      apiKey:
        (wallet as any).config?.apiKey || process.env.API_KEY || "unconfigured",
    } as any);

    // Temporarily set the selected public key to bypass WalletNotUnlockedError since we only need read access
    (wallet as any).selectedPublicKey = publicKey;

    // Use the SDK to fetch collectible metadata
    const metadata = await wallet.addCollectible(
      collectibleContractAddress,
      collectibleTokenId,
    );

    const collectibles = (await localStore.getItem(COLLECTIBLES_ID)) || {};
    const networkCollectibles = collectibles[network] || {};

    const accountCollectibles: (CollectibleContract & { metadata?: any })[] =
      networkCollectibles[publicKey] || [];

    // does collectible contract already exist?
    const collectibleContract = accountCollectibles.find(
      (contract) => contract.id === collectibleContractAddress,
    );
    if (collectibleContract?.tokenIds.includes(collectibleTokenId)) {
      return { error: "Collectible contract already exists" };
    }

    if (collectibleContract) {
      collectibleContract.tokenIds.push(collectibleTokenId);
      // Update metadata maybe? Or store per tokenId?
      // For now we just follow the existing structure but add the metadata we got
    } else {
      accountCollectibles.push({
        id: collectibleContractAddress,
        tokenIds: [collectibleTokenId],
        metadata, // Store the fetched metadata
      });
    }

    await localStore.setItem(COLLECTIBLES_ID, {
      ...collectibles,
      [network]: {
        ...networkCollectibles,
        [publicKey]: accountCollectibles,
      },
    });

    return { collectiblesList: accountCollectibles };
  } catch (error: any) {
    console.error("SDK addCollectible failed:", error);
    const errorMessage = error?.response?.data?.error || error?.message || "Failed to add collectible";
    return { error: typeof errorMessage === "string" ? errorMessage : JSON.stringify(errorMessage) };
  }
};
