import { useReducer } from "react";
import { useSelector } from "react-redux";

import { RequestState } from "constants/request";
import { initialState, isError, reducer } from "helpers/request";
import { ApiTokenPrices, AssetIcons, Collectibles } from "@shared/api/types";
import { ManageAssetCurrency } from "popup/components/manageAssets/ManageAssetRows";
import { isContractId } from "popup/helpers/soroban";
import { AccountBalances, useGetBalances } from "helpers/hooks/useGetBalances";
import {
  AssetDomains,
  useGetAssetDomainsWithBalances,
} from "helpers/hooks/useGetAssetDomainsWithBalances";
import { getBaseAccount } from "popup/helpers/account";
import { AppDataType, NeedsReRoute } from "helpers/hooks/useGetAppData";
import { APPLICATION_STATE } from "@shared/constants/applicationState";
import { isMainnet } from "helpers/stellar";
import { NetworkDetails } from "@shared/constants/stellar";
import { useGetTokenPrices } from "helpers/hooks/useGetTokenPrices";
import { useGetCollectibles } from "helpers/hooks/useGetCollectibles";
import { isCustomNetwork } from "@shared/helpers/stellar";
import { 
  formattedBalancesSelector, 
  iconsSelector, 
  tokenPricesSelector 
} from "popup/ducks/cache";

export interface ResolvedSendAmountData {
  type: AppDataType.RESOLVED;
  userBalances: AccountBalances;
  destinationBalances: AccountBalances;
  icons: AssetIcons;
  domains: ManageAssetCurrency[];
  applicationState: APPLICATION_STATE;
  publicKey: string;
  networkDetails: NetworkDetails;
  tokenPrices: ApiTokenPrices;
  collectibleData: Collectibles;
}

type SendAmountData = NeedsReRoute | ResolvedSendAmountData;

function useGetSendAmountData(
  options: {
    showHidden: boolean;
    includeIcons: boolean;
  },
  destinationAddress?: string, // NOTE: can be a G/C/M address
) {
  const [state, dispatch] = useReducer(
    reducer<SendAmountData, unknown>,
    initialState,
  );
  
  const cachedBalances = useSelector(formattedBalancesSelector);
  const cachedIcons = useSelector(iconsSelector);
  const cachedPrices = useSelector(tokenPricesSelector);

  const { fetchData: fetchBalances } = useGetBalances({
    showHidden: true,
    includeIcons: false,
  });
  const { fetchData: fetchTokenPrices } = useGetTokenPrices();
  const { fetchData: fetchAssetDomains } =
    useGetAssetDomainsWithBalances(options);
  const { fetchData: fetchCollectibles } = useGetCollectibles({
    useCache: true,
  });

  const fetchData = async () => {
    try {
      const userDomains = await fetchAssetDomains(true);
      if (isError<AssetDomains>(userDomains)) {
        throw new Error(userDomains.message);
      }

      if (userDomains.type === AppDataType.REROUTE) {
        dispatch({ type: "FETCH_DATA_SUCCESS", payload: userDomains });
        return userDomains;
      }

      const publicKey = userDomains.publicKey;
      const networkDetails = userDomains.networkDetails;
      const network = networkDetails.network;

      // STALE-WHILE-REVALIDATE: Show cached data first
      const userBalancesCache = cachedBalances[network]?.[publicKey];
      if (userBalancesCache && state.state === RequestState.IDLE) {
        const initialPayload = {
          type: AppDataType.RESOLVED,
          applicationState: userDomains.applicationState,
          publicKey,
          networkDetails,
          userBalances: userBalancesCache,
          destinationBalances: {} as AccountBalances,
          icons: cachedIcons || {},
          domains: userDomains.domains,
          tokenPrices: cachedPrices[publicKey] || {},
          collectibleData: {} as Collectibles,
        } as ResolvedSendAmountData;
        dispatch({ type: "FETCH_DATA_SUCCESS", payload: initialPayload });
      } else if (!userBalancesCache && state.state !== RequestState.SUCCESS) {
        dispatch({ type: "FETCH_DATA_START" });
      }

      let destinationAccount = await getBaseAccount(destinationAddress);
      const _isMainnet = isMainnet(userDomains.networkDetails);
      let destinationBalances = {} as AccountBalances;
      
      if (destinationAccount && !isContractId(destinationAccount)) {
        const balances = await fetchBalances(
          destinationAccount,
          _isMainnet,
          userDomains.networkDetails,
          true,
        );
        if (isError<AccountBalances>(balances)) {
          throw new Error(balances.message);
        }
        destinationBalances = balances;
      }

      let tokenPrices = {} as ApiTokenPrices;
      let collectibleData = {} as Collectibles;

      if (_isMainnet) {
        const fetchedTokenPrices = await fetchTokenPrices({
          publicKey: userDomains.publicKey,
          balances: userDomains.balances.balances,
          useCache: true,
        });

        tokenPrices = fetchedTokenPrices.tokenPrices || {};
      }

      if (!isCustomNetwork(userDomains.networkDetails)) {
        collectibleData = await fetchCollectibles({
          publicKey: userDomains.publicKey,
          networkDetails: userDomains.networkDetails,
        });
      }

      const payload = {
        type: AppDataType.RESOLVED,
        applicationState: userDomains.applicationState,
        publicKey: userDomains.publicKey,
        networkDetails: userDomains.networkDetails,
        userBalances: userDomains.balances,
        destinationBalances,
        icons: userDomains.balances.icons || {},
        domains: userDomains.domains,
        tokenPrices,
        collectibleData,
      } as ResolvedSendAmountData;
      dispatch({ type: "FETCH_DATA_SUCCESS", payload });
      return payload;
    } catch (error) {
      if (state.state !== RequestState.SUCCESS) {
        dispatch({ type: "FETCH_DATA_ERROR", payload: error });
      }
      return error;
    }
  };

  return {
    state,
    fetchData,
  };
}

export { useGetSendAmountData };
