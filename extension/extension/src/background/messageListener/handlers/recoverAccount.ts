import { Store } from "redux";
import { wallet as sdkWallet } from "@shared/helpers/stellar";

import { RecoverAccountMessage } from "@shared/api/types/message-request";
import { removePreviousAccount } from "../helpers/remove-previous-account";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import {
  allAccountsSelector,
  buildHasPrivateKeySelector,
  publicKeySelector,
  reset,
} from "background/ducks/session";
import { getKeyIdList } from "background/helpers/account";
import {
  ACCOUNT_NAME_LIST_ID,
  APPLICATION_ID,
  KEY_DERIVATION_NUMBER_ID,
  KEY_ID_LIST,
} from "constants/localStorageTypes";
import { clearSession, SessionTimer } from "background/helpers/session";
import { storeAccount } from "../helpers/store-account";
import { KeyManager } from "@stellar/typescript-wallet-sdk-km";
import { captureException } from "@sentry/browser";
import { APPLICATION_STATE } from "@shared/constants/applicationState";
import { MAINNET_NETWORK_DETAILS } from "@shared/constants/stellar";
import { activatePublicKey } from "../helpers/activate-public-key";

export const recoverAccount = async ({
  request,
  localStore,
  sessionStore,
  keyManager,
  sessionTimer,
  numOfPublicKeysToCheck,
}: {
  request: RecoverAccountMessage;
  localStore: DataStorageAccess;
  sessionStore: Store;
  keyManager: KeyManager;
  sessionTimer: SessionTimer;
  numOfPublicKeysToCheck: number;
}) => {
  const { password, recoverMnemonic, isOverwritingAccount } = request;
  let applicationState;
  let error = "";

  if (isOverwritingAccount) {
    await removePreviousAccount({ localStore });
  }

  // Use ONLY Stellar Wallet SDK for recovery
  let firstPublicKey = "";
  try {
    firstPublicKey = await sdkWallet.importFromMnemonic(recoverMnemonic.trim(), password);
  } catch (e) {
    console.error(e);
    error = "Invalid mnemonic phrase";
    return { error };
  }

  const firstPrivateKey = (sdkWallet as any).keypairs.get(firstPublicKey).secret();
  const keyPair = {
    publicKey: firstPublicKey,
    privateKey: firstPrivateKey,
  };

  // resets accounts list
  sessionStore.dispatch(reset());

  const keyIdList = await getKeyIdList({ localStore });

  if (keyIdList.length) {
    /* Clear any existing account data while maintaining app settings */

    for (let i = 0; i < keyIdList.length; i += 1) {
      await localStore.remove(`stellarkeys:${keyIdList[i]}`);
    }

    await localStore.setItem(KEY_ID_LIST, []);
    await localStore.remove(ACCOUNT_NAME_LIST_ID);
  }

  await localStore.setItem(KEY_DERIVATION_NUMBER_ID, "0");

  await clearSession({ localStore, sessionStore });

  try {
    await storeAccount({
      mnemonicPhrase: recoverMnemonic,
      password,
      keyPair,
      isSettingHashKey: true,
      sessionStore,
      localStore,
      keyManager,
    });
  } catch (e) {
    captureException(`Error recovering account: ${JSON.stringify(e)}`);
  }

  // if we don't have an application state, assign them one
  applicationState =
    (await localStore.getItem(APPLICATION_ID)) ||
    APPLICATION_STATE.MNEMONIC_PHRASE_CONFIRMED;

  await localStore.setItem(APPLICATION_ID, applicationState);

  // lets check first couple of accounts and pre-load them if funded on mainnet
  // The SDK derives these sequentially via addAccount()
  for (let i = 1; i <= numOfPublicKeysToCheck; i += 1) {
    try {
      const nextPublicKey = await sdkWallet.addAccount(password);
      const nextPrivateKey = (sdkWallet as any).keypairs.get(nextPublicKey).secret();

      // Check if funded on Mainnet
      const resp = await fetch(
        `${MAINNET_NETWORK_DETAILS.networkUrl}/accounts/${nextPublicKey}`,
      );

      const j = await resp.json();
      if (j.account_id) {
        const newKeyPair = {
          publicKey: nextPublicKey,
          privateKey: nextPrivateKey,
        };

        await storeAccount({
          password,
          keyPair: newKeyPair,
          mnemonicPhrase: recoverMnemonic,
          imported: true,
          sessionStore,
          localStore,
          keyManager,
        });

        await localStore.setItem(KEY_DERIVATION_NUMBER_ID, String(i));
      }
    } catch (e) {
      captureException(
        `Error preloading account: ${JSON.stringify(e)} - ${i}`,
      );
      // continue
    }
  }

  // let's make the first public key the active one
  await activatePublicKey({
    publicKey: firstPublicKey,
    sessionStore,
    localStore,
  });

  // start the timer now that we have active private key
  sessionTimer.startSession();

  const currentState = sessionStore.getState();
  const hasPrivateKeySelector = buildHasPrivateKeySelector(localStore);

  return {
    allAccounts: allAccountsSelector(currentState),
    publicKey: publicKeySelector(currentState),
    applicationState: (await localStore.getItem(APPLICATION_ID)) || "",
    hasPrivateKey: await hasPrivateKeySelector(currentState),
    error,
  };
};
