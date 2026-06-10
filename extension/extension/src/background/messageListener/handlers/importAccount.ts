import { Store } from "redux";
import { wallet as sdkWallet } from "@shared/helpers/stellar";
import { KeyManager } from "@stellar/typescript-wallet-sdk-km";
import { captureException } from "@sentry/browser";

import { ImportAccountMessage } from "@shared/api/types/message-request";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import {
  getEncryptedTemporaryData,
  SessionTimer,
} from "background/helpers/session";
import { KEY_ID, TEMPORARY_STORE_EXTRA_ID } from "constants/localStorageTypes";
import { loginToAllAccounts } from "../helpers/login-all-accounts";
import { getNonHwKeyID } from "../helpers/get-non-hw-key-id";
import { unlockKeystore } from "../helpers/unlock-keystore";
import { getIsHardwareWalletActive } from "background/helpers/account";
import { storeAccount } from "../helpers/store-account";
import {
  allAccountsSelector,
  buildHasPrivateKeySelector,
  publicKeySelector,
} from "background/ducks/session";

export const importAccount = async ({
  request,
  sessionStore,
  localStore,
  keyManager,
  sessionTimer,
}: {
  request: ImportAccountMessage;
  sessionStore: Store;
  localStore: DataStorageAccess;
  keyManager: KeyManager;
  sessionTimer: SessionTimer;
}) => {
  const { password, privateKey, mnemonicPhrase } = request;

  let storedMnemonicPhrase = await getEncryptedTemporaryData({
    sessionStore,
    localStore,
    keyName: TEMPORARY_STORE_EXTRA_ID,
  });

  if (!storedMnemonicPhrase) {
    try {
      await loginToAllAccounts(
        password,
        localStore,
        sessionStore,
        keyManager,
        sessionTimer,
      );
      storedMnemonicPhrase = await getEncryptedTemporaryData({
        sessionStore,
        localStore,
        keyName: TEMPORARY_STORE_EXTRA_ID,
      });
    } catch (e) {
      captureException(
        `Error logging in to all accounts in Import Account - ${JSON.stringify(
          e,
        )}`,
      );
      return { error: "Unable to login" };
    }
  }

  const keyID = (await getIsHardwareWalletActive({ localStore }))
    ? await getNonHwKeyID({ localStore })
    : (await localStore.getItem(KEY_ID)) || "";

  try {
    if (keyID) {
      await unlockKeystore({ keyID, password, keyManager });
    }

    let importedPublicKey: string;

    if (mnemonicPhrase && mnemonicPhrase.trim()) {
      // ── Mnemonic import path (SDK ONLY) ───────────────────────────────────
      importedPublicKey = await sdkWallet.importFromMnemonic(
        mnemonicPhrase,
        password,
      );
    } else {
      // ── Secret-key import path (SDK ONLY) ─────────────────────────────────
      importedPublicKey = await sdkWallet.importFromSecretKey(
        privateKey,
        password,
      );
    }

    // Retrieve the secret key directly from the SDK's internal state
    // This removes the need for manual derivation/stellar-hd-wallet fetch
    const sdkKeypair = (sdkWallet as any).keypairs.get(importedPublicKey);
    const resolvedPrivateKey = sdkKeypair.secret();

    const keyPair = {
      publicKey: importedPublicKey,
      privateKey: resolvedPrivateKey,
    };

    await storeAccount({
      password,
      keyPair,
      mnemonicPhrase: storedMnemonicPhrase,
      imported: true,
      sessionStore,
      localStore,
      keyManager,
    });
  } catch (e: any) {
    console.error(e);
    const errMsg = e.message || "";
    if (errMsg.toLowerCase().includes("mnemonic")) {
      return { error: "Please enter a valid 12/24-word recovery phrase" };
    }
    return {
      error: e.error || "Please enter a valid secret key/password combination",
    };
  }

  const currentState = sessionStore.getState();
  const hasPrivateKeySelector = buildHasPrivateKeySelector(localStore);

  return {
    publicKey: publicKeySelector(currentState),
    allAccounts: allAccountsSelector(currentState),
    hasPrivateKey: await hasPrivateKeySelector(currentState),
  };
};
