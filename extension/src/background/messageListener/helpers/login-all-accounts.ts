import { Store } from "redux";
import { wallet as sdkWallet } from "@shared/helpers/stellar";
import { StellarWallet } from "stellar-wallet-sdk";

import {
  getIsHardwareWalletActive,
} from "background/helpers/account";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import {
  KEY_ID,
  TEMPORARY_STORE_ID,
} from "constants/localStorageTypes";
import {
  clearSession,
  deriveKeyFromString,
  SessionTimer,
  storeActiveHashKey,
  storeEncryptedTemporaryData,
} from "background/helpers/session";
import {
  allAccountsSelector,
  logIn,
  publicKeySelector,
} from "background/ducks/session";
import { captureException } from "@sentry/browser";

export const loginToAllAccounts = async (
  password: string,
  localStore: DataStorageAccess,
  sessionStore: Store,
  _keyManager: any,
  sessionTimer: SessionTimer,
) => {
  let sdkPublicKeys: string[] = [];
  try {
    const hasWallet = await StellarWallet.hasStoredWallet();
    console.log("loginToAllAccounts - hasStoredWallet:", hasWallet);
    if (hasWallet) {
      sdkPublicKeys = await sdkWallet.restore(password);
      console.log("loginToAllAccounts - restore successful, keys:", sdkPublicKeys.length);
    } else {
      console.log("loginToAllAccounts - no stored wallet found");
    }
  } catch (e) {
    console.error("SDK restore failed in loginToAllAccounts:", e);
    throw e;
  }

  const activeKeyID = (await localStore.getItem(KEY_ID)) || "";
  let hwPublicKey = "";
  
  if (await getIsHardwareWalletActive({ localStore })) {
    hwPublicKey = activeKeyID.split(":")[1];
  }

  const hashKey = await deriveKeyFromString(password);

  if (
    !publicKeySelector(sessionStore.getState()) ||
    !allAccountsSelector(sessionStore.getState()).length
  ) {
    const allAccounts: any[] = [];
    
    for (const pubKey of sdkPublicKeys) {
        allAccounts.push({
            publicKey: pubKey,
            name: `Account ${allAccounts.length + 1}`,
            imported: (sdkWallet as any).vault?.accounts.find((a: any) => a.publicKey === pubKey)?.source === "imported"
        });
    }

    await sessionStore.dispatch(
      logIn({
        publicKey: hwPublicKey || sdkPublicKeys[0] || "",
        allAccounts: allAccounts,
        localStore,
      }) as any,
    );
  }

  await localStore.remove(TEMPORARY_STORE_ID);

  for (const pubKey of sdkPublicKeys) {
    const keypair = (sdkWallet as any).keypairs.get(pubKey);
    if (keypair) {
        try {
            await storeEncryptedTemporaryData({
                localStore,
                keyName: pubKey,
                temporaryData: keypair.secret(),
                hashKey,
            });
        } catch (e) {
            captureException(`Error storing encrypted secret for ${pubKey}: ${e}`);
        }
    }
  }

  const vaultMnemonic = (sdkWallet as any).vault?.encryptedMnemonic;
  if (vaultMnemonic) {
    try {
        // Mnemonic decryption is not directly on the instance, but can be done via secret key if needed
        // but Freighter stores the mnemonic separately in its own session logic.
        // We'll skip this SDK-level decryption for now to avoid the undefined call,
        // as Freighter already handles the mnemonic in its own storage if available.
    } catch (e) {
        // Vault might not have mnemonic if it was created from secret key only
    }
  }

  try {
    await storeActiveHashKey({
      sessionStore,
      hashKey,
    });
  } catch (e) {
    await clearSession({ localStore, sessionStore });
    captureException(`Error storing active hash key: ${JSON.stringify(e)}`);
  }

  sessionTimer.startSession();
};
