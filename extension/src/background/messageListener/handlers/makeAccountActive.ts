import { Store } from "redux";
import { wallet as sdkWallet } from "@shared/helpers/stellar";
import { MakeAccountActiveMessage } from "@shared/api/types/message-request";
import { activatePublicKey } from "../helpers/activate-public-key";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import {
  buildHasPrivateKeySelector,
  publicKeySelector,
} from "background/ducks/session";
import { getBipPath } from "background/helpers/account";

export const makeAccountActive = async ({
  request,
  sessionStore,
  localStore,
}: {
  request: MakeAccountActiveMessage;
  sessionStore: Store;
  localStore: DataStorageAccess;
}) => {
  const { publicKey } = request;
  await activatePublicKey({ publicKey, sessionStore, localStore });

  // ── SDK Select Account Synchronization ──────────────────────────────
  // Synchronize the active account choice with the Stellar Wallet SDK.
  try {
    sdkWallet.selectAccount(publicKey);
  } catch (e) {
    console.warn(`SDK selectAccount failed for ${publicKey}:`, e);
  }

  const currentState = sessionStore.getState();
  const hasPrivateKeySelector = buildHasPrivateKeySelector(localStore);

  return {
    publicKey: publicKeySelector(currentState),
    hasPrivateKey: await hasPrivateKeySelector(currentState),
    bipPath: await getBipPath({ localStore }),
  };
};
