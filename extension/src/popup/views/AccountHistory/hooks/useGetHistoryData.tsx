import React, { ReactNode, useReducer } from "react";
import { Horizon } from "stellar-sdk";
import { Icon } from "@stellar/design-system";

import { initialState, isError, reducer } from "helpers/request";
import { RequestState } from "constants/request";
import { AccountBalances, useGetBalances } from "helpers/hooks/useGetBalances";
import { HistoryResponse, useGetHistory } from "helpers/hooks/useGetHistory";
import {
  AppDataType,
  NeedsReRoute,
  useGetAppData,
} from "helpers/hooks/useGetAppData";
import { isMainnet } from "helpers/stellar";
import { APPLICATION_STATE } from "@shared/constants/applicationState";
import { NetworkDetails } from "@shared/constants/stellar";

export interface OperationDataRow {
  action: string | null;
  actionIcon: string;
  amount: string | null;
  date: string;
  id: string;
  metadata: {
    [key: string]: any;
  };
  rowIcon: ReactNode;
  rowText: ReactNode;
}

export const getRowIconByType = (iconType: string) => {
  switch (iconType) {
    case "fail": {
      return (
        <div className="HistoryItem__icon__bordered">
          <Icon.Wallet03 />

          <div className="HistoryItem__icon__small HistoryItem--failed">
            <Icon.XCircle />
          </div>
        </div>
      );
    }
    case "generic": {
      return (
        <div className="HistoryItem__icon__bordered">
          <Icon.User01 />
        </div>
      );
    }

    default:
      return <></>;
  }
};

// ---------------------------------------------------------------------------
// Asset icon helper – shows first 2 chars of the asset code in a circle
// (matches the look in the original Freighter history view)
// ---------------------------------------------------------------------------
const createAssetIcon = (assetCode: string): ReactNode => {
  const label = assetCode.substring(0, 2).toUpperCase();
  return (
    <div
      className="HistoryItem__icon__bordered"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span
        style={{
          fontSize: "0.75rem",
          fontWeight: 600,
          lineHeight: 1,
          letterSpacing: "0.02em",
        }}
      >
        {label}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Build a single OperationDataRow from a Horizon operation record
// ---------------------------------------------------------------------------
const buildOperationRow = (
  op: any,
  publicKey: string,
  date: string,
): OperationDataRow => {
  const type = op.type as string;

  // ── Payment / path-payment ───────────────────────────────────────────
  if (
    type === "payment" ||
    type === "path_payment_strict_receive" ||
    type === "path_payment_strict_send"
  ) {
    // Swap detection: path-payment where sender === receiver
    const isSwap =
      (type === "path_payment_strict_receive" ||
        type === "path_payment_strict_send") &&
      op.source_account === op.to;

    if (isSwap) {
      const fromAsset =
        op.source_asset_type === "native"
          ? "XLM"
          : op.source_asset_code || "Unknown";
      const toAsset =
        op.asset_type === "native" ? "XLM" : op.asset_code || "Unknown";
      return {
        action: "Swap",
        actionIcon: "swap",
        amount: `${fromAsset} → ${toAsset}`,
        date,
        id: op.id,
        metadata: { type, fromAsset, toAsset },
        rowIcon: (
          <div className="HistoryItem__icon__bordered">
            <Icon.RefreshCcw03 />
          </div>
        ),
        rowText: `${fromAsset} → ${toAsset}`,
      };
    }

    const isReceived = op.to === publicKey;
    const assetCode =
      op.asset_type === "native" ? "XLM" : op.asset_code || "Unknown";
    const amount = op.amount || "0";
    const formattedAmount = isReceived
      ? `+${amount} ${assetCode}`
      : `-${amount} ${assetCode}`;

    return {
      action: isReceived ? "Received" : "Sent",
      actionIcon: isReceived ? "received" : "sent",
      amount: formattedAmount,
      date,
      id: op.id,
      metadata: {
        type,
        assetCode,
        assetIssuer: op.asset_issuer,
        to: op.to,
        from: op.from || op.source_account,
      },
      rowIcon: createAssetIcon(assetCode),
      rowText: assetCode,
    };
  }

  // ── Change trust ─────────────────────────────────────────────────────
  if (type === "change_trust") {
    const assetCode = op.asset_code || "Unknown";
    const isRemove = op.limit === "0";
    return {
      action: isRemove ? "Removed" : "Added",
      actionIcon: isRemove ? "remove" : "add",
      amount: null,
      date,
      id: op.id,
      metadata: { type, assetCode },
      rowIcon: createAssetIcon(assetCode),
      rowText: isRemove ? "Remove trustline" : "Add trustline",
    };
  }

  // ── Create account ───────────────────────────────────────────────────
  if (type === "create_account") {
    const isReceived = op.account === publicKey;
    const startBal = op.starting_balance || "0";
    return {
      action: isReceived ? "Received" : "Created",
      actionIcon: isReceived ? "received" : "sent",
      amount: isReceived ? `+${startBal} XLM` : `-${startBal} XLM`,
      date,
      id: op.id,
      metadata: { type },
      rowIcon: createAssetIcon("XLM"),
      rowText: "XLM",
    };
  }

  // ── Soroban: invoke_host_function ────────────────────────────────────
  if (type === "invoke_host_function") {
    return {
      action: "Contract call",
      actionIcon: "contractInteraction",
      amount: null,
      date,
      id: op.id,
      metadata: { type },
      rowIcon: (
        <div className="HistoryItem__icon__bordered">
          <Icon.FileCode02 />
        </div>
      ),
      rowText: "Smart Contract",
    };
  }

  // ── Soroban maintenance ──────────────────────────────────────────────
  if (type === "extend_footprint_ttl" || type === "restore_footprint") {
    return {
      action: "Soroban",
      actionIcon: "genericAction",
      amount: null,
      date,
      id: op.id,
      metadata: { type },
      rowIcon: (
        <div className="HistoryItem__icon__bordered">
          <Icon.FileCode02 />
        </div>
      ),
      rowText:
        type === "extend_footprint_ttl"
          ? "Extend TTL"
          : "Restore Footprint",
    };
  }

  // ── Manage offers (DEX) ──────────────────────────────────────────────
  if (
    type === "manage_sell_offer" ||
    type === "manage_buy_offer" ||
    type === "create_passive_sell_offer"
  ) {
    const sellingAsset =
      op.selling_asset_type === "native"
        ? "XLM"
        : op.selling_asset_code || "Unknown";
    const buyingAsset =
      op.buying_asset_type === "native"
        ? "XLM"
        : op.buying_asset_code || "Unknown";
    return {
      action: `${sellingAsset} → ${buyingAsset}`,
      actionIcon: "swap",
      amount: op.amount ? `${op.amount} ${sellingAsset}` : null,
      date,
      id: op.id,
      metadata: { type },
      rowIcon: (
        <div className="HistoryItem__icon__bordered">
          <Icon.RefreshCcw03 />
        </div>
      ),
      rowText: "Manage Offer",
    };
  }

  // ── Account merge ────────────────────────────────────────────────────
  if (type === "account_merge") {
    const isReceived = op.into === publicKey;
    return {
      action: isReceived ? "Merged in" : "Merged out",
      actionIcon: isReceived ? "received" : "sent",
      amount: null,
      date,
      id: op.id,
      metadata: { type },
      rowIcon: createAssetIcon("XLM"),
      rowText: "Account Merge",
    };
  }

  // ── Claimable balances ───────────────────────────────────────────────
  if (type === "claim_claimable_balance") {
    return {
      action: "Claimed",
      actionIcon: "received",
      amount: null,
      date,
      id: op.id,
      metadata: { type },
      rowIcon: (
        <div className="HistoryItem__icon__bordered">
          <Icon.CheckCircle />
        </div>
      ),
      rowText: "Claim Balance",
    };
  }
  if (type === "create_claimable_balance") {
    const cbAssetCode =
      op.asset?.split(":")?.[0] || (op.asset === "native" ? "XLM" : "");
    return {
      action: "Created",
      actionIcon: "sent",
      amount: op.amount ? `-${op.amount} ${cbAssetCode}` : null,
      date,
      id: op.id,
      metadata: { type },
      rowIcon: (
        <div className="HistoryItem__icon__bordered">
          <Icon.PlusCircle />
        </div>
      ),
      rowText: "Claimable Balance",
    };
  }

  // ── Set options ──────────────────────────────────────────────────────
  if (type === "set_options") {
    return {
      action: "Updated",
      actionIcon: "genericAction",
      amount: null,
      date,
      id: op.id,
      metadata: { type },
      rowIcon: getRowIconByType("generic"),
      rowText: "Set Options",
    };
  }

  // ── Manage data ──────────────────────────────────────────────────────
  if (type === "manage_data") {
    return {
      action: op.value ? "Set" : "Removed",
      actionIcon: op.value ? "add" : "remove",
      amount: null,
      date,
      id: op.id,
      metadata: { type, name: op.name },
      rowIcon: getRowIconByType("generic"),
      rowText: `Data: ${op.name || "entry"}`,
    };
  }

  // ── Default fallback ────────────────────────────────────────────────
  return {
    action: "Transaction",
    actionIcon: "genericAction",
    amount: null,
    date,
    id: op.id,
    metadata: { type },
    rowIcon: getRowIconByType("generic"),
    rowText: type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase()),
  };
};

// ---------------------------------------------------------------------------
// createHistorySections – enriches SDK transaction data with Horizon
// operation details so each row shows asset name, amount, direction, etc.
// ---------------------------------------------------------------------------
export interface HistorySection {
  monthYear: string;
  operations: OperationDataRow[];
}

const createHistorySections = async (
  transactions: any[],
  publicKey: string,
  networkDetails: NetworkDetails,
): Promise<HistorySection[]> => {
  // Fetch account operations from Horizon in a single call (much faster
  // than fetching per-transaction). Group them by transaction hash later.
  let accountOps: any[] = [];
  try {
    const server = new Horizon.Server(networkDetails.networkUrl);
    const opsPage = await server
      .operations()
      .forAccount(publicKey)
      .limit(200)
      .order("desc")
      .call();
    accountOps = opsPage.records;
  } catch (e) {
    console.error("Failed to fetch operations from Horizon:", e);
  }

  // Group operations by their parent transaction hash
  const opsByTxHash = new Map<string, any[]>();
  for (const op of accountOps) {
    const txHash = op.transaction_hash;
    if (!opsByTxHash.has(txHash)) {
      opsByTxHash.set(txHash, []);
    }
    opsByTxHash.get(txHash)!.push(op);
  }

  const sections: HistorySection[] = [];

  for (const tx of transactions) {
    const txHash = tx.hash || tx.id;
    const isFailed = tx.successful === false;
    const dateStr = tx.created_at || new Date().toISOString();
    const txDate = new Date(dateStr);
    const date = txDate.toDateString().split(" ").slice(1, 3).join(" ");
    const month = txDate.getMonth();
    const year = txDate.getFullYear();
    const monthYear = `${month}:${year}`;

    let rows: OperationDataRow[] = [];

    if (isFailed) {
      // Failed transactions get a single "Transaction Failed" row
      rows = [
        {
          action: "Failed",
          actionIcon: "failed",
          amount: null,
          date,
          id: txHash,
          metadata: {
            type: "transaction",
            transactionFailed: true,
            createdAt: tx.created_at,
          },
          rowIcon: getRowIconByType("fail"),
          rowText: "Transaction Failed",
        },
      ];
    } else {
      const ops = opsByTxHash.get(txHash) || [];
      if (ops.length > 0) {
        // We have detailed operations – build a row per operation
        rows = ops.map((op) => buildOperationRow(op, publicKey, date));
      } else {
        // Fallback: operations not found (e.g. outside the 200-op window)
        rows = [
          {
            action: "Transaction",
            actionIcon: "genericAction",
            amount: null,
            date,
            id: txHash,
            metadata: {
              type: "transaction",
              createdAt: tx.created_at,
              memo: tx.memo,
            },
            rowIcon: getRowIconByType("generic"),
            rowText: `Transaction (${tx.operation_count} ops)`,
          },
        ];
      }
    }

    // Insert rows into the correct month section
    for (const row of rows) {
      const lastSection =
        sections.length > 0 ? sections[sections.length - 1] : null;
      if (lastSection && lastSection.monthYear === monthYear) {
        lastSection.operations.push(row);
      } else {
        sections.push({ monthYear, operations: [row] });
      }
    }
  }

  return sections;
};

export interface ResolvedData {
  type: AppDataType.RESOLVED;
  balances: AccountBalances;
  history: HistorySection[];
  publicKey: string;
  applicationState: APPLICATION_STATE;
}

export type HistoryData = ResolvedData | NeedsReRoute;

import {
  resolvedHistorySelector,
  saveResolvedHistory,
} from "popup/ducks/cache";
import { AppDispatch } from "popup/App";
import { useDispatch, useSelector } from "react-redux";

function useGetHistoryData(
  balanceOptions: {
    showHidden: boolean;
    includeIcons: boolean;
  },
) {
  const reduxDispatch = useDispatch<AppDispatch>();
  const [state, dispatch] = useReducer(
    reducer<HistoryData, unknown>,
    initialState,
  );
  const cachedHistory = useSelector(resolvedHistorySelector);
  const { fetchData: fetchAppData } = useGetAppData();
  const { fetchData: fetchBalances } = useGetBalances(balanceOptions);
  const { fetchData: fetchHistory } = useGetHistory();

  const fetchData = async (
    useBalancesCache = false,
    useHistoryCache = false,
  ) => {
    try {
      const appData = await fetchAppData();
      if (isError(appData)) {
        throw new Error(appData.message);
      }

      if (appData.type === AppDataType.REROUTE) {
        dispatch({ type: "FETCH_DATA_SUCCESS", payload: appData });
        return appData;
      }

      const publicKey = appData.account.publicKey;
      const networkDetails = appData.settings.networkDetails;

      // STALE-WHILE-REVALIDATE: If we have cached data, show it first
      const cachedData = cachedHistory[networkDetails.network]?.[publicKey];
      if (cachedData && state.state === RequestState.IDLE) {
        dispatch({ type: "FETCH_DATA_SUCCESS", payload: cachedData });
      } else if (!cachedData && state.state !== RequestState.SUCCESS) {
        dispatch({ type: "FETCH_DATA_START" });
      }

      const isMainnetNetwork = isMainnet(networkDetails);
      const balancesResult = await fetchBalances(
        publicKey,
        isMainnetNetwork,
        networkDetails,
        useBalancesCache,
      );
      const history = await fetchHistory(
        publicKey,
        networkDetails,
        useHistoryCache,
      );

      if (isError<AccountBalances>(balancesResult)) {
        throw new Error(balancesResult.message);
      }

      if (isError<HistoryResponse>(history)) {
        throw new Error(history.message);
      }

      const payload = {
        type: AppDataType.RESOLVED,
        publicKey,
        balances: balancesResult,
        applicationState: appData.account.applicationState,
        history: await createHistorySections(
          history,
          publicKey,
          networkDetails,
        ),
      } as ResolvedData;

      dispatch({ type: "FETCH_DATA_SUCCESS", payload });
      
      // Persist resolved history to Redux cache
      reduxDispatch(
        saveResolvedHistory({
          publicKey,
          network: networkDetails.network,
          data: payload,
        }),
      );
      
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

export { useGetHistoryData };
