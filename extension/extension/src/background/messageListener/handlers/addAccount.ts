import { Store } from "redux";
import { wallet as sdkWallet } from "@shared/helpers/stellar";

import { AddAccountMessage } from "@shared/api/types/message-request";
import {
  clearSession,
  getEncryptedTemporaryData,
  SessionTimer,
} from "background/helpers/session";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import {
  KEY_DERIVATION_NUMBER_ID,
  TEMPORARY_STORE_EXTRA_ID,
} from "constants/localStorageTypes";
import { loginToAllAccounts } from "../helpers/login-all-accounts";
import { KeyManager } from "@stellar/typescript-wallet-sdk-km";
import { captureException } from "@sentry/browser";
import { storeAccount } from "../helpers/store-account";
import {
  allAccountsSelector,
  buildHasPrivateKeySelector,
  publicKeySelector,
} from "background/ducks/session";

export const addAccount = async ({
  request,
  localStore,
  sessionStore,
  keyManager,
  sessionTimer,
}: {
  request: AddAccountMessage;
  localStore: DataStorageAccess;
  sessionStore: Store;
  keyManager: KeyManager;
  sessionTimer: SessionTimer;
}) => {
  const password = request.password;

  let mnemonicPhrase = await getEncryptedTemporaryData({
    sessionStore,
    localStore,
    keyName: TEMPORARY_STORE_EXTRA_ID,
  });

  if (!mnemonicPhrase) {
    try {
      await loginToAllAccounts(
        password,
        localStore,
        sessionStore,
        keyManager,
        sessionTimer,
      );
      mnemonicPhrase = await getEncryptedTemporaryData({
        sessionStore,
        localStore,
        keyName: TEMPORARY_STORE_EXTRA_ID,
      });
    } catch (e) {
      captureException(
        `Error logging in to all accounts in Add Account - ${JSON.stringify(
          e,
        )}`,
      );
      return { error: "Unable to login" };
    }
  }

  // Verify password using SDK wallet
  try {
    await sdkWallet.restore(password);
  } catch (e) {
    console.error("SDK Password verification failed: ", e);
    return { error: "Incorrect password" };
  }

  // Use ONLY StellarWallet SDK (Kit) to add the account and get the public key
  let newPublicKey = "";
  try {
    if (!sdkWallet.canAddAccount()) {
      return { 
        error: "Cannot derive new account: This wallet was imported via secret key and does not have a recovery phrase stored. Please use 'Import Account' instead." 
      };
    }
    newPublicKey = await sdkWallet.addAccount(password);
  } catch (e: any) {
    console.error("SDK Account derivation error: ", e);
    return { error: `Error deriving account: ${e.message}` };
  }

  // Retrieve the secret key directly from the SDK's internal state for legacy storeAccount compatibility
  const privateKey = (sdkWallet as any).keypairs.get(newPublicKey).secret();

  // Ensure derived keys are consistent between SDK and legacy store
  const keyPair = {
    publicKey: newPublicKey,
    privateKey: privateKey,
  };

  // Add the new account to our data store
  try {
    await storeAccount({
      password,
      keyPair,
      mnemonicPhrase,
      sessionStore,
      keyManager,
      localStore,
    });
  } catch (e) {
    await clearSession({ localStore, sessionStore });
    captureException(`Error adding account: ${JSON.stringify(e)}`);
    return { error: "Error adding account" };
  }

  const newKeyDerivationNumber =
    Number(await localStore.getItem(KEY_DERIVATION_NUMBER_ID)) + 1;
  const keyDerivationNumberId = newKeyDerivationNumber.toString();
  await localStore.setItem(KEY_DERIVATION_NUMBER_ID, keyDerivationNumberId);

  const currentState = sessionStore.getState();
  const hasPrivateKeySelector = buildHasPrivateKeySelector(localStore);

  return {
    publicKey: publicKeySelector(currentState),
    allAccounts: allAccountsSelector(currentState),
    hasPrivateKey: await hasPrivateKeySelector(currentState),
  };
};
