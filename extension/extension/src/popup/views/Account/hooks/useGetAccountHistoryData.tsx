import { useReducer } from "react";

import { RequestState } from "constants/request";
import { initialState, isError, reducer } from "helpers/request";

import { getAccountHistory } from "@shared/api/internal";
import { AssetOperations, sortOperationsByAsset } from "popup/helpers/account";
import {
  buildOperationRow,
  EnrichmentContext,
} from "popup/views/AccountHistory/hooks/useGetHistoryData";
import {
  AppDataType,
  NeedsReRoute,
  useGetAppData,
} from "helpers/hooks/useGetAppData";

interface ResolvedAccountHistoryData {
  type: AppDataType.RESOLVED;
  operationsByAsset: AssetOperations;
}

export type AccountHistoryData = NeedsReRoute | ResolvedAccountHistoryData;

const formatOpDate = (createdAt?: string) =>
  createdAt
    ? new Date(createdAt).toDateString().split(" ").slice(1, 3).join(" ")
    : "";

function useGetAccountHistoryData() {
  const [state, dispatch] = useReducer(
    reducer<AccountHistoryData, unknown>,
    initialState,
  );
  const { fetchData: fetchAppData } = useGetAppData();

  const fetchData = async () => {
    dispatch({ type: "FETCH_DATA_START" });
    try {
      const appData = await fetchAppData(true);
      if (isError(appData)) {
        throw new Error(appData.message);
      }

      if (appData.type === AppDataType.REROUTE) {
        dispatch({ type: "FETCH_DATA_SUCCESS", payload: appData });
        return appData;
      }

      const publicKey = appData.account.publicKey;
      const networkDetails = appData.settings.networkDetails;

      const operations = await getAccountHistory(publicKey, networkDetails);

      // Build operation rows (same shape the AccountHistory view renders, so the
      // TransactionDetail modal works identically) and group them by asset for
      // the AssetDetail per-asset history list. No enrichment context is needed
      // here — the detail list only requires the per-operation row metadata.
      const ctx: EnrichmentContext = {
        publicKey,
        networkDetails,
        homeDomains: {},
        icons: {},
        assetsListsData: [],
        collections: [],
      };
      const rows = (operations || []).map((op: any) =>
        buildOperationRow(op, ctx, formatOpDate(op.created_at)),
      );

      const payload = {
        type: AppDataType.RESOLVED,
        operationsByAsset: sortOperationsByAsset(rows),
      } as ResolvedAccountHistoryData;

      dispatch({ type: "FETCH_DATA_SUCCESS", payload });
      return payload;
    } catch (error) {
      dispatch({ type: "FETCH_DATA_ERROR", payload: error });
      return error;
    }
  };

  return {
    state,
    fetchData,
  };
}

export { useGetAccountHistoryData, RequestState };
