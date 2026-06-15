import { Store } from "redux";
import { captureException } from "@sentry/browser";
import { wallet } from "@shared/helpers/stellar";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import { getEncryptedTemporaryData } from "background/helpers/session";
import { KEY_ID } from "constants/localStorageTypes";
import {
  EntryQueue,
  ResponseQueue,
  SignAuthEntryMessage,
  SignAuthEntryResponse,
} from "@shared/api/types/message-request";

export const signAuthEntry = async ({
  request,
  localStore,
  sessionStore,
  authEntryQueue,
  responseQueue,
}: {
  request: SignAuthEntryMessage;
  localStore: DataStorageAccess;
  sessionStore: Store;
  authEntryQueue: EntryQueue;
  responseQueue: ResponseQueue<SignAuthEntryResponse>;
}) => {
  const { uuid, activePublicKey } = request;

  if (!uuid) {
    captureException("signAuthEntry: missing uuid in request");
    return { error: "Transaction not found" };
  }

  // Ensure the wallet session is unlocked before delegating to the SDK signer.
  const keyId = (await localStore.getItem(KEY_ID)) || "";
  let privateKey = "";
  try {
    privateKey = await getEncryptedTemporaryData({
      localStore,
      sessionStore,
      keyName: keyId,
    });
  } catch (e) {
    captureException(
      `signAuthEntry: No private key found: ${JSON.stringify(e)}`,
    );
  }

  if (!privateKey.length) {
    return { error: "Session timed out" };
  }

  try {
    const queueIndex = authEntryQueue.findIndex((item) => item.uuid === uuid);
    const authEntryQueueItem =
      queueIndex !== -1 ? authEntryQueue.splice(queueIndex, 1)[0] : undefined;
    const authEntryValue = authEntryQueueItem?.authEntry;

    if (!authEntryValue) {
      captureException(`signAuthEntry: no auth entry found for uuid ${uuid}`);
      return { error: "Transaction not found" };
    }

    // Configure the wallet for the correct network
    const isMainnet =
      authEntryValue.networkPassphrase ===
      "Public Global Stellar Network ; October 2015";
    wallet.setNetworkConfig({
      network: isMainnet ? "mainnet" : "testnet",
      apiKey:
        (wallet as any).config?.apiKey || process.env.API_KEY || "unconfigured",
    } as any);

    if (activePublicKey) {
      try {
        wallet.selectAccount(activePublicKey);
      } catch (e) {
        // ignore
      }
    }

    // Use the SDK to sign the auth entry (CAP-40 style)
    const base64Sig = wallet.signAuthEntry(authEntryValue.entry);
    const response = Buffer.from(base64Sig, "base64");

    const responseIndex = responseQueue.findIndex((item) => item.uuid === uuid);
    const entryResponse =
      responseIndex !== -1
        ? responseQueue.splice(responseIndex, 1)[0]
        : undefined;

    if (entryResponse && typeof entryResponse.response === "function") {
      entryResponse.response(response, activePublicKey);
      return {};
    }

    captureException(
      `signAuthEntry: no matching response found for uuid ${uuid}`,
    );
    return { error: "Response callback not found" };
  } catch (error: any) {
    console.error("SDK signAuthEntry failed:", error);
    return { error: error.message || "Failed to sign auth entry" };
  }
};
