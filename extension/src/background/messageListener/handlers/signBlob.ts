import { captureException } from "@sentry/browser";
import { wallet } from "@shared/helpers/stellar";
import {
  BlobQueue,
  ResponseQueue,
  SignBlobMessage,
  SignBlobResponse,
} from "@shared/api/types/message-request";

export const signBlob = async ({
  request,
  blobQueue,
  responseQueue,
}: {
  request: SignBlobMessage;
  blobQueue: BlobQueue;
  responseQueue: ResponseQueue<SignBlobResponse>;
}) => {
  const { uuid, activePublicKey } = request;

  if (!uuid) {
    captureException("signBlob: missing uuid in request");
    return { error: "Transaction not found" };
  }

  try {
    const queueIndex = blobQueue.findIndex((item) => item.uuid === uuid);
    const blobQueueItem =
      queueIndex !== -1 ? blobQueue.splice(queueIndex, 1)[0] : undefined;
    const blob = blobQueueItem?.blob;

    if (!blob) {
      captureException(`signBlob: no blob found in queue for uuid ${uuid}`);
      return { error: "Transaction not found" };
    }

    // Configure the wallet for the correct network
    const isMainnet = blob.networkPassphrase === "Public Global Stellar Network ; October 2015";
    wallet.setNetworkConfig({
      network: isMainnet ? "mainnet" : "testnet",
      apiKey: (wallet as any).config?.apiKey || "qomjjag2a9gq95uhlnzhl",
    } as any);

    if (activePublicKey) {
      try {
        wallet.selectAccount(activePublicKey);
      } catch (e) {
        // ignore
      }
    }

    // Use the SDK to sign the message (SEP-53 style)
    const base64Sig = wallet.signMessage(blob.message);
    const response = Buffer.from(base64Sig, "base64");

    const responseIndex = responseQueue.findIndex((item) => item.uuid === uuid);
    const blobResponse =
      responseIndex !== -1
        ? responseQueue.splice(responseIndex, 1)[0]
        : undefined;

    if (blobResponse && typeof blobResponse.response === "function") {
      blobResponse.response(response, activePublicKey);
      return {};
    }

    captureException(`signBlob: no matching response found for uuid ${uuid}`);
    return { error: "Response callback not found" };
  } catch (error: any) {
    console.error("SDK signMessage failed:", error);
    return { error: error.message || "Failed to sign message" };
  }
};
