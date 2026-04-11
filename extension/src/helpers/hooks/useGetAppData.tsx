import { useReducer } from "react";
import { useDispatch, useSelector } from "react-redux";
import * as Sentry from "@sentry/browser";

import { reducer } from "../request";
import { RequestState } from "constants/request";
import { storeAccountMetricsData } from "../metrics";
import {
  loadAccount,
  loadBackendSettings,
  loadSettings,
} from "@shared/api/internal";
import {
  accountSelector,
  saveAccount,
  saveAccountError,
  saveApplicationState,
} from "../../popup/ducks/accountServices";
import {
  saveSettingsAction,
  saveBackendSettingsAction,
  settingsSelector,
} from "../../popup/ducks/settings";
import { APPLICATION_STATE } from "@shared/constants/applicationState";
import { ROUTES } from "popup/constants/routes";
import { POPUP_WIDTH } from "constants/dimensions";

export enum AppDataType {
  REROUTE = "re-route",
  RESOLVED = "resolved",
}
export interface NeedsReRoute {
  type: AppDataType.REROUTE;
  routeTarget: ROUTES.unlockAccount | ROUTES.welcome;
  shouldOpenTab: boolean;
}

interface ResolvedData {
  type: AppDataType.RESOLVED;
  account: Awaited<ReturnType<typeof loadAccount>>;
  settings: Awaited<ReturnType<typeof loadSettings>>;
}

export type AppData = NeedsReRoute | ResolvedData;

function useGetAppData() {
  const currentAccount = useSelector(accountSelector);
  const currentSettings = useSelector(settingsSelector);

  const [state, dispatch] = useReducer(
    reducer<AppData, unknown>,
    (currentAccount.publicKey
      ? {
          state: RequestState.SUCCESS,
          data: {
            type: AppDataType.RESOLVED,
            account: currentAccount,
            settings: currentSettings,
          },
          error: null,
        }
      : {
          state: RequestState.IDLE,
          data: null,
          error: null,
        }) as any,
  );

  const reduxDispatch = useDispatch();

  const fetchData = async (
    useCache = true,
    useBackendSettings = true,
  ): Promise<AppData | Error> => {
    const hasCache = !!(useCache && currentAccount.publicKey);

    // Only set loading state if we don't have cached data yet,
    // and if we're not already in a success state from a previous fetch
    const isRevalidating = hasCache || state.state === RequestState.SUCCESS;
    if (!isRevalidating) {
      dispatch({ type: "FETCH_DATA_START" });
      reduxDispatch(
        saveApplicationState(APPLICATION_STATE.APPLICATION_LOADING),
      );
    }
    try {
      if (hasCache) {
        const payload = {
          type: "resolved" as const,
          account: currentAccount,
          settings: currentSettings,
        } as ResolvedData;
        dispatch({ type: "FETCH_DATA_SUCCESS", payload });
        return payload;
      }
      const account = await loadAccount();
      const settings = await loadSettings();

      storeAccountMetricsData(account.publicKey, account.allAccounts);
      reduxDispatch(saveAccount(account));
      reduxDispatch(saveSettingsAction(settings));
      reduxDispatch(saveApplicationState(account.applicationState));

      if (
        !account.publicKey ||
        account.applicationState === APPLICATION_STATE.APPLICATION_STARTED
      ) {
        const hasOnboarded =
          account.applicationState ===
          APPLICATION_STATE.MNEMONIC_PHRASE_CONFIRMED;
        const payload = {
          type: "re-route",
          routeTarget: hasOnboarded ? ROUTES.unlockAccount : ROUTES.welcome,
          shouldOpenTab: window.innerWidth === POPUP_WIDTH && !hasOnboarded,
        } as NeedsReRoute;
        dispatch({ type: "FETCH_DATA_SUCCESS", payload });
        return payload;
      }

      let backendSettings = {};

      if (useBackendSettings) {
        backendSettings = await loadBackendSettings();
        reduxDispatch(saveBackendSettingsAction(backendSettings));
      }

      const payload = {
        type: "resolved",
        account,
        settings: { ...settings, ...backendSettings },
      } as ResolvedData;
      dispatch({ type: "FETCH_DATA_SUCCESS", payload });

      return payload;
    } catch (error) {
      dispatch({ type: "FETCH_DATA_ERROR", payload: error });
      reduxDispatch(saveAccountError(error));
      Sentry.captureException(`Error loading app data: ${error}`);
      throw new Error(`Failed to fetch app data - ${error}`);
    }
  };

  return {
    state,
    fetchData,
  };
}

export { useGetAppData };
