import { Store } from "redux";

import { wallet as sdkWallet } from "@shared/helpers/stellar";
import { logOut, publicKeySelector } from "background/ducks/session";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import {
  APPLICATION_ID,
  TEMPORARY_STORE_ID,
} from "constants/localStorageTypes";

export const signOut = async ({
  localStore,
  sessionStore,
}: {
  localStore: DataStorageAccess;
  sessionStore: Store;
}) => {
  sessionStore.dispatch(logOut());
  await localStore.remove(TEMPORARY_STORE_ID);

  try {
    await sdkWallet.logout();
  } catch (e) {
    console.error("SDK logout failed:", e);
  }


  return {
    publicKey: publicKeySelector(sessionStore.getState()),
    applicationState: (await localStore.getItem(APPLICATION_ID)) || "",
  };
};
