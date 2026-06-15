import { Store } from "redux";
import { captureException } from "@sentry/browser";
import { KeyManager } from "@stellar/typescript-wallet-sdk-km";
import { wallet as sdkWallet } from "@shared/helpers/stellar";

import { CreateAccountMessage } from "@shared/api/types/message-request";
import { clearAccount } from "../helpers/clear-account";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import {
  APPLICATION_ID,
  KEY_DERIVATION_NUMBER_ID,
} from "constants/localStorageTypes";
import { clearSession, SessionTimer } from "background/helpers/session";
import { storeAccount } from "../helpers/store-account";
import { APPLICATION_STATE } from "@shared/constants/applicationState";
import {
  allAccountsSelector,
  buildHasPrivateKeySelector,
  publicKeySelector,
  reset,
} from "background/ducks/session";

export const createAccount = async ({
  request,
  localStore,
  sessionStore,
  keyManager,
  sessionTimer,
}: {
  request: CreateAccountMessage;
  localStore: DataStorageAccess;
  sessionStore: Store;
  keyManager: KeyManager;
  sessionTimer: SessionTimer;
}) => {
  const { password, isOverwritingAccount } = request;

  if (isOverwritingAccount) {
    await clearAccount(localStore);
    sessionStore.dispatch(reset());
  }

  // Use ONLY StellarWallet SDK (Kit) to create the account
  const { mnemonic: mnemonicPhrase, publicKey: derivedPublicKey } =
    await sdkWallet.create(password);

  // Retrieve the secret key directly from the SDK's internal state
  const privateKey = (sdkWallet as any).keypairs.get(derivedPublicKey).secret();

  const keyPair = {
    publicKey: derivedPublicKey,
    privateKey: privateKey,
  };

  // Keep derivation index in sync
  await localStore.setItem(KEY_DERIVATION_NUMBER_ID, "0");

  await clearSession({ localStore, sessionStore });

  try {
    await storeAccount({
      password,
      keyPair,
      mnemonicPhrase,
      isSettingHashKey: true,
      localStore,
      sessionStore,
      keyManager,
    });
  } catch (e) {
    console.error(e);
    captureException(`Error creating account: ${JSON.stringify(e)}`);
    return { error: "Error creating account" };
  }

  await localStore.setItem(APPLICATION_ID, APPLICATION_STATE.PASSWORD_CREATED);

  const currentState = sessionStore.getState();

  sessionTimer.startSession();
  const hasPrivateKeySelector = buildHasPrivateKeySelector(localStore);

  return {
    allAccounts: allAccountsSelector(currentState),
    publicKey: publicKeySelector(currentState),
    hasPrivateKey: await hasPrivateKeySelector(currentState),
  };
};
