import { Federation, Horizon, MuxedAccount } from "stellar-sdk";
import { BigNumber } from "bignumber.js";
import {
  Account,
  AssetVisibility,
  HorizonOperation,
  IssuerKey,
  TokenBalances,
} from "@shared/api/types";
import { Balances, BalanceMap } from "@shared/api/types/backend-api";
import { AssetType } from "@shared/api/types/account-balance";
import { NetworkDetails } from "@shared/constants/stellar";
import { SorobanTokenInterface } from "@shared/constants/soroban/token";
export { isSorobanIssuer } from "@shared/helpers/stellar";

import {
  getCanonicalFromAsset,
  isFederationAddress,
  isMuxedAccount,
  isTestnet,
} from "helpers/stellar";
import { getAttrsFromSorobanHorizonOp } from "./soroban";
import { isAssetVisible } from "./settings";

export const LP_IDENTIFIER = ":lp";

export const sortBalances = (
  balances: Balances,
  sorobanBalances?: TokenBalances,
): AssetType[] => {
  const collection = [] as any[];
  const lpBalances = [] as any[];
  const _sorobanBalances = sorobanBalances || [];
  if (!balances) {
    return collection;
  }

  // put XLM at the top of the balance list, LP shares last
  Object.entries(balances).forEach(([k, v]) => {
    if (k === "native") {
      collection.unshift(v);
    } else if (k.includes(LP_IDENTIFIER)) {
      lpBalances.push(v);
    } else {
      collection.push(v);
    }
  });
  return collection.concat(_sorobanBalances).concat(lpBalances);
};

export const getIsPayment = (type: Horizon.HorizonApi.OperationResponseType) =>
  [
    Horizon.HorizonApi.OperationResponseType.payment,
    Horizon.HorizonApi.OperationResponseType.pathPayment,
    Horizon.HorizonApi.OperationResponseType.pathPaymentStrictSend,
  ].includes(type);

export const getIsSupportedSorobanOp = (
  operation: HorizonOperation,
  networkDetails: NetworkDetails,
) => {
  const attrs = getAttrsFromSorobanHorizonOp(operation, networkDetails);
  return (
    !!attrs &&
    Object.values(SorobanTokenInterface).includes(
      attrs.fnName as SorobanTokenInterface,
    )
  );
};

export const getIsSwap = (operation: HorizonOperation) =>
  operation.type_i === 13 && operation.source_account === operation.to;

export const getIsDustPayment = (
  publicKey: string,
  operation: HorizonOperation,
) =>
  getIsPayment(operation.type) &&
  "asset_type" in operation &&
  operation.asset_type === "native" &&
  "to" in operation &&
  operation.to === publicKey &&
  "amount" in operation &&
  new BigNumber(operation.amount!).lte(new BigNumber(0.1));

export const getIsCreateClaimableBalanceSpam = (
  operation: HorizonOperation,
) => {
  const op = operation;
  if (op.type === "create_claimable_balance") {
    if (op?.transaction_attr?.operation_count > 50) {
      return true;
    }
  }

  return false;
};

export interface AssetOperations {
  [key: string]: any[];
}

/**
 * Group already-built history operation rows by the asset they involve, keyed
 * the same way AssetDetail addresses them: native XLM under "native", every
 * other asset under its `CODE:ISSUER` canonical. Rows without a single
 * identifiable asset (swaps, contract calls, etc.) are skipped — they don't
 * belong to any one asset's detail view.
 */
export const sortOperationsByAsset = (
  rows: { metadata?: { assetCode?: string; assetIssuer?: string } }[],
): AssetOperations => {
  const result: AssetOperations = {};
  for (const row of rows || []) {
    const code = row?.metadata?.assetCode;
    if (!code) {
      continue;
    }
    const key =
      code === "XLM"
        ? "native"
        : row.metadata?.assetIssuer
          ? `${code}:${row.metadata.assetIssuer}`
          : code;
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(row);
  }
  return result;
};

export const getStellarExpertUrl = (networkDetails: NetworkDetails) =>
  `https://stellar.expert/explorer/${
    isTestnet(networkDetails) ? "testnet" : "public"
  }`;

export const getApiStellarExpertUrl = (networkDetails: NetworkDetails) =>
  `https://api.stellar.expert/explorer/${
    isTestnet(networkDetails) ? "testnet" : "public"
  }`;

interface GetAvailableBalance {
  balance: AssetType;
  recommendedFee?: string;
  subentryCount: number;
}

export const getAvailableBalance = ({
  balance,
  recommendedFee,
  subentryCount,
}: GetAvailableBalance) => {
  let availBalance = "0";
  if (!balance) {
    return availBalance;
  }
  if (
    "token" in balance &&
    "type" in balance.token &&
    balance.token.type === "native"
  ) {
    // take base reserve into account for XLM payments
    const baseReserve = (2 + subentryCount) * 0.5;

    // needed for different wallet-sdk bignumber.js version
    const currentBal = new BigNumber(balance.total.toFixed());
    let newBalance = currentBal.minus(new BigNumber(baseReserve));

    if (recommendedFee) {
      newBalance = newBalance.minus(new BigNumber(Number(recommendedFee)));
    }

    availBalance = newBalance.toFixed();
  } else {
    availBalance = balance.total.toFixed();
  }

  return availBalance;
};

export const getIssuerFromBalance = (balance: AssetType) => {
  if ("token" in balance && "issuer" in balance.token) {
    return balance.token.issuer.key.toString();
  }

  return "";
};

export const isNetworkUrlValid = (
  networkUrl: string,
  isHttpAllowed: boolean,
) => {
  let isValid = true;

  try {
    new Horizon.Server(networkUrl, { allowHttp: isHttpAllowed });
  } catch (e) {
    console.error(e);
    isValid = false;
  }
  return isValid;
};

export const displaySorobanId = (
  fullStr: string,
  strLen: number,
  separator = "...",
) => {
  if (fullStr.length <= strLen) {
    return fullStr;
  }

  const sepLen = separator.length;
  const charsToShow = strLen - sepLen;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);

  return (
    fullStr.substring(0, frontChars) +
    separator +
    fullStr.substring(fullStr.length - backChars)
  );
};

export const filterHiddenBalances = (
  balances: BalanceMap,
  hiddenAssets: Record<IssuerKey, AssetVisibility>,
) => {
  const balanceKeys = Object.keys(balances);
  const hiddenKeys = balanceKeys.filter((key) => {
    if (key === "native") {
      return false;
    }
    const [code, issuer] = key.split(":");
    if (!issuer) {
      return true;
    }
    return !isAssetVisible(hiddenAssets, getCanonicalFromAsset(code, issuer));
  });

  return Object.fromEntries(
    Object.entries(balances).filter(([key]) => !hiddenKeys.includes(key)),
  ) as BalanceMap;
};

export const getBaseAccount = async (address?: string) => {
  if (address && isMuxedAccount(address)) {
    const mAccount = MuxedAccount.fromAddress(address, "0");
    return mAccount.baseAccount().accountId();
  }
  if (address && isFederationAddress(address)) {
    const fedResp = await Federation.Server.resolve(address);
    return fedResp.account_id;
  }
  return address;
};

export const signFlowAccountSelector = ({
  allAccounts,
  publicKey,
  accountToSign,
  setActiveAccount,
}: {
  allAccounts: Account[];
  publicKey: string;
  accountToSign: string | undefined;
  setActiveAccount: (publicKey: string) => void;
}) => {
  let currentAccount = allAccounts.find(
    (account) => account.publicKey === publicKey,
  );

  allAccounts.forEach((account) => {
    if (accountToSign) {
      // does the user have the `accountToSign` somewhere in the accounts list?
      if (account.publicKey === accountToSign) {
        // if the `accountToSign` is found, but it isn't active, make it active
        if (publicKey !== account.publicKey) {
          setActiveAccount(account.publicKey);
        }

        // save the details of the `accountToSign`
        currentAccount = account;
      }
    }
  });
  return currentAccount;
};
