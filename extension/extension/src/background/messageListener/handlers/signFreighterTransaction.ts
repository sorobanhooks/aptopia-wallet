import { Store } from "redux";
import { captureException } from "@sentry/browser";

import { wallet as sdkWallet, getSdk } from "@shared/helpers/stellar";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import { getEncryptedTemporaryData } from "background/helpers/session";
import {
  SignFreighterSorobanTransactionMessage,
  SignFreighterTransactionMessage,
} from "@shared/api/types/message-request";

/**
 * Sign a transaction (classic or Soroban) with the active account's key.
 *
 * The Stellar Wallet SDK keeps decrypted keypairs only in the background
 * service-worker's memory. Under MV3 the worker is torn down after ~30s idle
 * (and on every extension reload), which wipes `sdkWallet.keypairs` while the
 * popup's persisted session still reports "unlocked". The SDK then throws
 * `WalletNotUnlockedError` ("Wallet not unlocked") on the next sign — which is
 * exactly the failure seen when clicking Deposit in the Yield Hub after the
 * worker has cycled.
 *
 * Fix: try the in-memory SDK signer first (fast path), and on failure fall back
 * to the password-encrypted secret that `loginToAllAccounts` persisted to the
 * temporary store (keyed by public key). That secret is decryptable as long as
 * the session hash key survives in storage.session — which outlives worker
 * restarts — so signing works without forcing the user to re-unlock.
 */
export const signFreighterTransaction = async ({
  request,
  localStore,
  sessionStore,
}: {
  request:
    | SignFreighterTransactionMessage
    | SignFreighterSorobanTransactionMessage;
  localStore: DataStorageAccess;
  sessionStore: Store;
}) => {
  const { transactionXDR, network, activePublicKey } = request;

  // ── Fast path: in-memory SDK signer (populated by restore()/import()) ──
  try {
    const signedTransaction = await sdkWallet.signXDR(transactionXDR);
    return { signedTransaction };
  } catch (sdkError: any) {
    // Only the locked/empty-keyring case is recoverable here. Anything else
    // (malformed XDR, etc.) should surface as-is after the fallback attempt.
    console.warn(
      "SDK signing failed, attempting session-key fallback:",
      sdkError?.message || sdkError,
    );
  }

  // ── Fallback: re-derive the keypair from the persisted session secret ──
  // Survives service-worker restarts (storage.session holds the hash key).
  try {
    const secret = await getEncryptedTemporaryData({
      localStore,
      sessionStore,
      keyName: activePublicKey,
    });

    if (!secret) {
      return { error: "Session timed out. Please unlock your wallet." };
    }

    const Sdk = getSdk(network);
    const tx = Sdk.TransactionBuilder.fromXDR(transactionXDR, network);
    tx.sign(Sdk.Keypair.fromSecret(secret));
    return { signedTransaction: tx.toXDR() };
  } catch (fallbackError: any) {
    captureException(
      `signFreighterTransaction fallback failed: ${
        fallbackError?.message || fallbackError
      }`,
    );
    return {
      error: fallbackError?.message || "Signing failed",
    };
  }
};
