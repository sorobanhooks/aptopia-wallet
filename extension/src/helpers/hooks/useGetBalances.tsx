import React, { useCallback, useReducer } from "react";
import { useDispatch, useSelector } from "react-redux";
import BigNumber from "bignumber.js";
import { Horizon } from "stellar-sdk";
import { isAccountNotFoundError } from "stellar-wallet-sdk";
import { 
  saveFormattedBalances, 
  formattedBalancesSelector 
} from "popup/ducks/cache";
import { AppDispatch } from "popup/App";
import type {
  AccountBalance,
  TokenPriceData,
  SorobanTokenMetadata,
} from "stellar-wallet-sdk";

import { RequestState } from "constants/request";
import {
  wallet as sharedWallet,
} from "helpers/stellar";
import { initialState, reducer } from "helpers/request";
import { settingsSelector } from "popup/ducks/settings";
import { AssetType } from "@shared/api/types/account-balance";

export const SOROBAN_TOKENS_STORAGE_KEY = "stellar_soroban_tokens";

// API Key indicator
const API_KEY = "qomjjag2a9gq95uhlnzhl";

export function getStoredSorobanTokens(
  network: string,
): Array<{ contractId: string } & SorobanTokenMetadata> {
  try {
    const raw = localStorage.getItem(
      `${SOROBAN_TOKENS_STORAGE_KEY}_${network}`,
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface AccountBalances {
  balances: AssetType[];
  tokenPrices?: Record<string, TokenPriceData | null>;
  publicKey?: string;
  isUnfunded?: boolean;
  isFunded?: boolean;
  icons?: Record<string, any>;
  subentryCount: number;
  error?: any;
}
export interface BalancesOptions {
  showHidden?: boolean;
  includeIcons?: boolean;
}

function useGetBalances(_options: BalancesOptions = {}) {
  const reduxDispatch = useDispatch<AppDispatch>();
  const cachedBalances = useSelector(formattedBalancesSelector);
  const [state, dispatch] = useReducer(
    reducer<AccountBalances, any>,
    initialState,
  );
  const { networkDetails } = useSelector(settingsSelector);
  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const fetchData = useCallback(
    async (
      publicKey?: string,
      _isMainnet?: boolean,
      _networkDetails?: any,
      _useCache = false,
      _shouldSkipScan = false,
    ): Promise<AccountBalances> => {
      const targetPublicKey = publicKey;

      if (!targetPublicKey) {
        return {
          balances: [],
          tokenPrices: {},
          publicKey: "",
          subentryCount: 0,
        };
      }

      const activeNetworkDetails = _networkDetails || networkDetails;
      const network = activeNetworkDetails.network;

      // STALE-WHILE-REVALIDATE: Check Redux cache first
      const cachedData = cachedBalances[network]?.[targetPublicKey];
      if (_useCache && cachedData) {
        if (stateRef.current.state === RequestState.IDLE) {
          dispatch({ type: "FETCH_DATA_SUCCESS", payload: cachedData });
        }
      }

      const hasValidState =
        stateRef.current.state === RequestState.SUCCESS &&
        stateRef.current.data?.publicKey === targetPublicKey;

      if (_useCache && hasValidState) {
        return stateRef.current.data!;
      }

      if (!cachedData || !_useCache) {
        dispatch({ type: "FETCH_DATA_START" });
      }

      try {
        const horizonServer = new Horizon.Server(activeNetworkDetails.networkUrl);

        let isAccountNotFoundErrorResult = false;
        let b: any[] = [];
        let accountRecord: any = null;

        try {
          accountRecord = await horizonServer.loadAccount(targetPublicKey);
          b = accountRecord.balances.map((line: any) => ({
            assetType: line.asset_type,
            balance: line.balance,
            assetCode: line.asset_code,
            assetIssuer: line.asset_issuer,
            limit: line.limit,
          }));
        } catch (e) {
          if (isAccountNotFoundError(e)) {
            isAccountNotFoundErrorResult = true;
          } else {
            throw e;
          }
        }

        const sorobanTokens = network ? getStoredSorobanTokens(network) : [];
        const sorobanBalances: AccountBalance[] = sorobanTokens.map((t) => ({
          assetType: "credit_alphanum12" as const,
          balance: "0",
          assetCode: t.symbol,
          assetIssuer: t.contractId,
          name: t.name ?? t.symbol,
          decimals: t.decimals,
        }));

        const existingContractIds = new Set(
          b
            .filter((x: any) => x.assetIssuer?.startsWith("C"))
            .map((x: any) => x.assetIssuer),
        );
        const newSoroban = sorobanBalances.filter(
          (s) => !existingContractIds.has(s.assetIssuer as string),
        );
        const mergedSDKBalances = [...b, ...newSoroban];

        const formattedBalances: AssetType[] = mergedSDKBalances.map(
          (item: any) => {
            const isNative = item.assetType === "native";
            const balance = new BigNumber(item.balance);

            if (isNative) {
              return {
                token: { type: "native", code: "XLM" },
                total: balance,
                available: balance,
                sellingLiabilities: "0",
                buyingLiabilities: "0",
                blockaidData: {} as any,
              } as any;
            }

            if (!item.assetIssuer?.startsWith("C")) {
              return {
                token: {
                  type: item.assetType,
                  code: item.assetCode,
                  issuer: { key: item.assetIssuer },
                },
                total: balance,
                available: balance,
                sellingLiabilities: "0",
                buyingLiabilities: "0",
                blockaidData: {} as any,
              } as any;
            }

            return {
              contractId: item.assetIssuer,
              total: balance,
              symbol: item.assetCode,
              name: item.name || item.assetCode,
              decimals: item.decimals || 7,
              blockaidData: {} as any,
            } as any;
          },
        );

        let prices = {};
        if (API_KEY && mergedSDKBalances.length > 0 && sharedWallet) {
          try {
            prices = await sharedWallet.getTokenPrices(mergedSDKBalances);
          } catch (e) {
            console.warn("Failed to fetch token prices:", e);
          }
        }

        const payload: AccountBalances = {
          balances: formattedBalances,
          tokenPrices: prices,
          publicKey: targetPublicKey,
          isFunded: !isAccountNotFoundErrorResult,
          isUnfunded: isAccountNotFoundErrorResult,
          subentryCount: 0,
          icons: {},
        };

        dispatch({ type: "FETCH_DATA_SUCCESS", payload });
        
        // Persist to Redux cache
        reduxDispatch(
          saveFormattedBalances({
            publicKey: targetPublicKey,
            network,
            data: payload,
          }),
        );
        
        return payload;
      } catch (err) {
        const isNotFound = isAccountNotFoundError(err);
        const payload: AccountBalances = {
          balances: [],
          tokenPrices: {},
          publicKey: targetPublicKey,
          isUnfunded: isNotFound,
          isFunded: false,
          subentryCount: 0,
          error: err,
        };

        dispatch(
          isNotFound
            ? { type: "FETCH_DATA_SUCCESS", payload }
            : { type: "FETCH_DATA_ERROR", payload: err },
        );
        
        if (isNotFound) {
          reduxDispatch(
            saveFormattedBalances({
              publicKey: targetPublicKey,
              network,
              data: payload,
            }),
          );
        }
        
        return payload;
      }
    },
    [dispatch, networkDetails, cachedBalances, reduxDispatch],
  );

  return {
    state,
    fetchData,
  };
}

export { useGetBalances, RequestState };
