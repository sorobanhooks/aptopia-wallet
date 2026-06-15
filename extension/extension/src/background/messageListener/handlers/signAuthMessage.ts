import { wallet as sdkWallet } from "@shared/helpers/stellar";

import { SignAuthMessageMessage } from "@shared/api/types/message-request";

/**
 * Sign a plain SEP-53 message with the active account key.
 *
 * Used by the agent-backend SIWE-style auth flow: the popup forwards the
 * canonical challenge string from `/v1/auth/challenge` here, and the background
 * service worker signs it with the Stellar Wallet SDK singleton (which holds the
 * decrypted keypair in memory after unlock). The base64 signature is sent to
 * `/v1/auth/verify`, where the server re-derives the SEP-53 hash and verifies it
 * with `Keypair.verify`.
 *
 * `wallet.signMessage` applies the same SEP-53 encoding the server expects:
 *   sha256("Stellar Signed Message:\n" + message)
 * so no manual hashing is needed here. Returns the signature as a base64 string.
 */
export const signAuthMessage = async ({
  request,
}: {
  request: SignAuthMessageMessage;
}) => {
  const { message } = request;

  if (typeof message !== "string" || message.length === 0) {
    return { error: "No message provided to sign" };
  }

  try {
    // SDK signMessage returns a base64-encoded ed25519 signature over the
    // SEP-53 hash of the message.
    const signature = sdkWallet.signMessage(message);
    return { signature };
  } catch (sdkError: any) {
    console.error("SDK signMessage failed:", sdkError);
    return {
      error:
        sdkError?.message ||
        "Wallet is locked. Please re-enter your password to continue.",
    };
  }
};
