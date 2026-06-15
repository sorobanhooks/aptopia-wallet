import React, { ReactNode, useReducer } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Icon } from "@stellar/design-system";
import BigNumber from "bignumber.js";

import { initialState, isError, reducer } from "helpers/request";
import { RequestState } from "constants/request";
import { AccountBalances, useGetBalances } from "helpers/hooks/useGetBalances";
import {
  AppDataType,
  NeedsReRoute,
  useGetAppData,
} from "helpers/hooks/useGetAppData";
import { isMainnet } from "helpers/stellar";
import { APPLICATION_STATE } from "@shared/constants/applicationState";
import { NetworkDetails } from "@shared/constants/stellar";
import { AssetListResponse } from "@shared/constants/soroban/asset-list";
import { Collection } from "@shared/api/types";
import {
  getAccountHistory,
  getAssetDomains,
  getTokenDetails,
} from "@shared/api/internal";
import { getIconFromTokenLists } from "@shared/api/helpers/getIconFromTokenList";
import { getCombinedAssetListData } from "@shared/api/helpers/token-list";
import {
  SorobanCollectibleInterface,
  SorobanTokenInterface,
} from "@shared/constants/soroban/token";

import { getIsDustPayment } from "popup/helpers/account";
import {
  CLASSIC_ASSET_DECIMALS,
  formatTokenAmount,
  getAttrsFromSorobanHorizonOp,
} from "popup/helpers/soroban";
import {
  CollectibleInfoImage,
  getCollectibleName,
} from "popup/components/account/CollectibleInfo";
import {
  collectionsSelector,
  resolvedHistorySelector,
  saveResolvedHistory,
  tokensListsSelector,
} from "popup/ducks/cache";
import { AppDispatch } from "popup/App";

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
// Asset icon helper – shows the token-list icon when we have one, otherwise
// falls back to the first 2 chars of the asset code in a circle
// (matches the look in the original Freighter history view)
// ---------------------------------------------------------------------------
const createAssetIcon = (assetCode: string, iconUrl?: string): ReactNode => {
  if (iconUrl) {
    return (
      <div className="HistoryItem__icon__bordered">
        <img
          src={iconUrl}
          alt={assetCode}
          data-testid="history-item-icon"
          style={{ width: "100%", height: "100%", borderRadius: "50%" }}
        />
      </div>
    );
  }
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

// Trim trailing zeros from a classic-asset amount string ("1.0000000" → "1").
const trimAmount = (amount: string): string => {
  try {
    return new BigNumber(amount).toString();
  } catch (e) {
    return amount;
  }
};

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Format a history-row date as "MMM DD" in UTC so it is stable across
// timezones (e.g. "Dec 30"). Padding mirrors the original toDateString output
// of a single space for the leading day digit.
const toHistoryDate = (dateStr: string): string => {
  const txDate = new Date(dateStr);
  const month = MONTH_SHORT[txDate.getUTCMonth()];
  const day = txDate.getUTCDate();
  return `${month} ${day < 10 ? `0${day}` : day}`;
};

// ---------------------------------------------------------------------------
// Enrichment context resolved once per fetch and threaded through row builders
// ---------------------------------------------------------------------------
export interface EnrichmentContext {
  publicKey: string;
  networkDetails: NetworkDetails;
  // issuer -> home domain
  homeDomains: { [issuer: string]: string };
  // canonical "CODE:ISSUER" -> icon url
  icons: { [canonical: string]: string | undefined };
  assetsListsData: AssetListResponse[];
  collections: Collection[];
}

// ---------------------------------------------------------------------------
// Build a single OperationDataRow from a Horizon operation record. For payment
// and Soroban operations the row is enriched (signed/trimmed amount, token-list
// icon, collectible image, etc.). All other op types keep the existing
// presentation.
// ---------------------------------------------------------------------------
export const buildOperationRow = (
  op: any,
  ctx: EnrichmentContext,
  date: string,
): OperationDataRow => {
  const type = op.type as string;
  const { publicKey } = ctx;

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
        metadata: {
          type,
          isSwap: true,
          srcAssetCode: fromAsset,
          destAssetCode: toAsset,
          formattedSrcAmount: trimAmount(op.source_amount || op.amount || "0"),
          nonLabelAmount: trimAmount(op.amount || "0"),
          createdAt: op.created_at,
          feeCharged: op.transaction_attr?.fee_charged || "0",
        },
        rowIcon: (
          <div className="HistoryItem__icon__bordered">
            <Icon.RefreshCcw03 />
          </div>
        ),
        rowText: `${fromAsset} → ${toAsset}`,
      };
    }

    const isReceived = op.to === publicKey;
    const isNative = op.asset_type === "native" || !op.asset_code;
    const assetCode = isNative ? "XLM" : op.asset_code || "Unknown";
    const issuer = op.asset_issuer as string | undefined;
    const trimmed = trimAmount(op.amount || "0");
    const formattedAmount = isReceived
      ? `+${trimmed} ${assetCode}`
      : `-${trimmed} ${assetCode}`;

    const iconUrl = issuer ? ctx.icons[`${assetCode}:${issuer}`] : undefined;

    return {
      action: isReceived ? "Received" : "Sent",
      actionIcon: isReceived ? "received" : "sent",
      amount: formattedAmount,
      date,
      id: op.id,
      metadata: {
        type,
        isPayment: true,
        assetCode,
        destAssetCode: assetCode,
        assetIssuer: issuer,
        destIcon: iconUrl,
        nonLabelAmount: trimmed,
        isReceiving: isReceived,
        to: op.to,
        from: op.from || op.source_account,
        createdAt: op.created_at,
        feeCharged: op.transaction_attr?.fee_charged || "0",
      },
      rowIcon: createAssetIcon(assetCode, iconUrl),
      rowText: assetCode,
    };
  }

  // ── Soroban: invoke_host_function ────────────────────────────────────
  if (type === "invoke_host_function") {
    return buildInvokeHostFnRow(op, ctx, date);
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
      metadata: {
        type,
        assetCode,
        destAssetCode: assetCode,
        createdAt: op.created_at,
        feeCharged: op.transaction_attr?.fee_charged || "0",
      },
      rowIcon: createAssetIcon(assetCode),
      rowText: isRemove ? "Remove trustline" : "Add trustline",
    };
  }

  // ── Create account ───────────────────────────────────────────────────
  if (type === "create_account") {
    const isReceived = op.account === publicKey;
    const startBal = trimAmount(op.starting_balance || "0");
    return {
      action: isReceived ? "Received" : "Created",
      actionIcon: isReceived ? "received" : "sent",
      amount: isReceived ? `+${startBal} XLM` : `-${startBal} XLM`,
      date,
      id: op.id,
      metadata: {
        type,
        nonLabelAmount: startBal,
        isReceiving: isReceived,
        to: op.account,
        from: op.source_account || op.funder,
        createdAt: op.created_at,
        feeCharged: op.transaction_attr?.fee_charged || "0",
      },
      rowIcon: createAssetIcon("XLM"),
      rowText: "XLM",
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
      metadata: { type, createdAt: op.created_at },
      rowIcon: (
        <div className="HistoryItem__icon__bordered">
          <Icon.FileCode02 />
        </div>
      ),
      rowText:
        type === "extend_footprint_ttl" ? "Extend TTL" : "Restore Footprint",
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
      amount: op.amount ? `${trimAmount(op.amount)} ${sellingAsset}` : null,
      date,
      id: op.id,
      metadata: { type, createdAt: op.created_at },
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
      metadata: { type, createdAt: op.created_at },
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
      metadata: { type, createdAt: op.created_at },
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
      amount: op.amount ? `-${trimAmount(op.amount)} ${cbAssetCode}` : null,
      date,
      id: op.id,
      metadata: { type, createdAt: op.created_at },
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
      metadata: { type, createdAt: op.created_at },
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
      metadata: { type, name: op.name, createdAt: op.created_at },
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
    metadata: { type, createdAt: op.created_at },
    rowIcon: getRowIconByType("generic"),
    rowText: type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c: string) => c.toUpperCase()),
  };
};

// ---------------------------------------------------------------------------
// Find a collectible in the cached collections that matches a given contract
// address + tokenId.
// ---------------------------------------------------------------------------
const findCollectible = (
  collections: Collection[],
  contractId: string,
  tokenId: string,
) => {
  for (const entry of collections) {
    const collection = entry.collection;
    if (!collection) {
      continue;
    }
    if (collection.address !== contractId) {
      continue;
    }
    const match = (collection.collectibles || []).find(
      (c) => String(c.tokenId) === String(tokenId),
    );
    if (match) {
      return { collection, collectible: match };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// invoke_host_function – may be a collectible transfer, a generic Soroban token
// transfer/mint, or a plain contract call. Note: this function is invoked from
// the synchronous row builder using attrs/token details resolved earlier.
// ---------------------------------------------------------------------------
const buildInvokeHostFnRow = (
  op: any,
  ctx: EnrichmentContext,
  date: string,
): OperationDataRow => {
  const attrs = op.__attrs as ReturnType<typeof getAttrsFromSorobanHorizonOp>;

  // Collectible transfer takes priority over a generic token transfer.
  if (op.__collectible) {
    const { collection, collectible } = op.__collectible as {
      collection: NonNullable<Collection["collection"]>;
      collectible: NonNullable<
        Collection["collection"]
      >["collectibles"][number];
    };
    const image = collectible.metadata?.image;
    const name = getCollectibleName(
      collectible.metadata?.name,
      collectible.tokenId,
    );

    return {
      action: "Sent",
      actionIcon: "sent",
      amount: null,
      date,
      id: op.id,
      metadata: {
        type: op.type,
        isInvokeHostFn: true,
        isCollectibleTransfer: true,
        collectionName: collection.name,
        collectibleName: name,
        tokenId: collectible.tokenId,
        image,
        amount: name,
        destAssetCode: collection.name,
        to: attrs?.to,
        from: attrs?.from,
        isReceiving: false,
        createdAt: op.created_at,
        feeCharged: op.transaction_attr?.fee_charged || "0",
      },
      rowIcon: (
        <CollectibleInfoImage image={image} name={name} isSmall isHistory />
      ),
      rowText: collection.name,
    };
  }

  // Generic Soroban token transfer / mint.
  if (
    attrs &&
    (attrs.fnName === SorobanTokenInterface.transfer ||
      attrs.fnName === SorobanCollectibleInterface.transfer ||
      attrs.fnName === SorobanTokenInterface.mint)
  ) {
    const tokenDetails = op.__tokenDetails as {
      symbol: string;
      decimals: number;
      name: string;
    } | null;
    const symbol = tokenDetails?.symbol || "Token";
    const decimals = tokenDetails?.decimals ?? CLASSIC_ASSET_DECIMALS;
    const iconUrl = op.__tokenIcon as string | undefined;

    const isMint = attrs.fnName === SorobanTokenInterface.mint;
    const isReceived = isMint
      ? attrs.to === ctx.publicKey
      : attrs.from !== ctx.publicKey;
    const rawAmount =
      attrs.amount !== undefined ? attrs.amount.toString() : "0";
    const formatted = formatTokenAmount(new BigNumber(rawAmount), decimals);
    const sign = isReceived ? "+" : "-";

    return {
      action: isReceived ? "Received" : "Sent",
      actionIcon: isReceived ? "received" : "sent",
      amount: `${sign}${formatted} ${symbol}`,
      date,
      id: op.id,
      metadata: {
        type: op.type,
        isInvokeHostFn: true,
        isTokenTransfer: !isMint,
        isTokenMint: isMint,
        assetCode: symbol,
        destAssetCode: symbol,
        destIcon: iconUrl,
        nonLabelAmount: formatted,
        isReceiving: isReceived,
        to: attrs.to,
        from: attrs.from,
        createdAt: op.created_at,
        feeCharged: op.transaction_attr?.fee_charged || "0",
      },
      rowIcon: createAssetIcon(symbol, iconUrl),
      rowText: symbol,
    };
  }

  // Plain contract call.
  return {
    action: "Contract call",
    actionIcon: "contractInteraction",
    amount: null,
    date,
    id: op.id,
    metadata: { type: op.type, isInvokeHostFn: true, createdAt: op.created_at },
    rowIcon: (
      <div className="HistoryItem__icon__bordered">
        <Icon.FileCode02 />
      </div>
    ),
    rowText: "Smart Contract",
  };
};

// ---------------------------------------------------------------------------
// createHistorySections – sources operations from getAccountHistory and builds
// enriched rows grouped by month. Resolves home domains (one batched request),
// token-list icons, collectible matches and Soroban token details.
// ---------------------------------------------------------------------------
export interface HistorySection {
  monthYear: string;
  operations: OperationDataRow[];
}

const createHistorySections = async (
  operations: any[],
  publicKey: string,
  networkDetails: NetworkDetails,
  options: {
    isHideDustEnabled: boolean;
    cachedTokenLists: AssetListResponse[];
    collections: Collection[];
    assetsLists: any;
  },
): Promise<HistorySection[]> => {
  // 1. Dust filtering – hide small native XLM payments received by this account.
  const visibleOps = options.isHideDustEnabled
    ? operations.filter((op) => !getIsDustPayment(publicKey, op))
    : operations;

  // 2. Collect unique non-native asset issuers in first-seen order.
  const issuerSet: string[] = [];
  for (const op of visibleOps) {
    const isPayment =
      op.type === "payment" ||
      op.type === "path_payment_strict_receive" ||
      op.type === "path_payment_strict_send";
    if (
      isPayment &&
      op.asset_type !== "native" &&
      op.asset_issuer &&
      !issuerSet.includes(op.asset_issuer)
    ) {
      issuerSet.push(op.asset_issuer);
    }
  }

  // 3. One batched request for all needed home domains.
  let homeDomains: { [issuer: string]: string } = {};
  if (issuerSet.length > 0) {
    try {
      homeDomains = await getAssetDomains({
        assetIssuerDomainsToFetch: issuerSet,
        networkDetails,
      });
    } catch (e) {
      console.error("Failed to fetch asset domains:", e);
    }
  }

  // 4. Resolve the combined asset list data (used for token-list icon lookups).
  let assetsListsData: AssetListResponse[] = [];
  try {
    assetsListsData = await getCombinedAssetListData({
      networkDetails,
      assetsLists: options.assetsLists,
      cachedAssetLists: options.cachedTokenLists,
    });
  } catch (e) {
    console.error("Failed to fetch combined asset list data:", e);
  }

  // 5. Resolve token-list icons for each unique non-native classic asset.
  const icons: { [canonical: string]: string | undefined } = {};
  const seenAssetIcons = new Set<string>();
  for (const op of visibleOps) {
    const isPayment =
      op.type === "payment" ||
      op.type === "path_payment_strict_receive" ||
      op.type === "path_payment_strict_send";
    if (isPayment && op.asset_type !== "native" && op.asset_issuer) {
      const code = op.asset_code as string;
      const issuer = op.asset_issuer as string;
      const canonical = `${code}:${issuer}`;
      if (!seenAssetIcons.has(canonical)) {
        seenAssetIcons.add(canonical);
        try {
          const { icon } = await getIconFromTokenLists({
            issuerId: issuer,
            code,
            assetsListsData,
          });
          icons[canonical] = icon;
        } catch (e) {
          console.error("Failed to resolve token-list icon:", e);
        }
      }
    }
  }

  const ctx: EnrichmentContext = {
    publicKey,
    networkDetails,
    homeDomains,
    icons,
    assetsListsData,
    collections: options.collections,
  };

  // 6. Pre-resolve Soroban attributes + collectible matches + token details for
  // invoke_host_function ops (async work must happen before the sync row build).
  for (const op of visibleOps) {
    if (op.type !== "invoke_host_function") {
      continue;
    }
    let attrs: ReturnType<typeof getAttrsFromSorobanHorizonOp> = null;
    try {
      attrs = getAttrsFromSorobanHorizonOp(op, networkDetails);
    } catch (e) {
      attrs = null;
    }
    op.__attrs = attrs;

    if (!attrs) {
      continue;
    }

    const isTransfer =
      attrs.fnName === SorobanTokenInterface.transfer ||
      attrs.fnName === SorobanCollectibleInterface.transfer;

    // Collectible match takes priority over a generic token transfer.
    if (isTransfer && attrs.tokenId !== undefined) {
      const match = findCollectible(
        options.collections,
        attrs.contractId,
        String(attrs.tokenId),
      );
      if (match) {
        op.__collectible = match;
        continue;
      }
    }

    // Otherwise treat it as a generic Soroban token transfer / mint.
    if (isTransfer || attrs.fnName === SorobanTokenInterface.mint) {
      try {
        op.__tokenDetails = await getTokenDetails({
          contractId: attrs.contractId,
          publicKey,
          networkDetails,
        });
      } catch (e) {
        op.__tokenDetails = null;
      }
      try {
        const { icon } = await getIconFromTokenLists({
          contractId: attrs.contractId,
          code: op.__tokenDetails?.symbol || "",
          assetsListsData,
        });
        op.__tokenIcon = icon;
      } catch (e) {
        op.__tokenIcon = undefined;
      }
    }
  }

  // 7. Build rows and group into month sections.
  const sections: HistorySection[] = [];

  for (const op of visibleOps) {
    const dateStr = op.created_at || new Date().toISOString();
    const txDate = new Date(dateStr);
    const date = toHistoryDate(dateStr);
    const month = txDate.getMonth();
    const year = txDate.getFullYear();
    const monthYear = `${month}:${year}`;

    const isFailed = op.transaction_successful === false;

    let row: OperationDataRow;
    if (isFailed) {
      row = {
        action: "Failed",
        actionIcon: "failed",
        amount: null,
        date,
        id: op.id,
        metadata: {
          type: "transaction",
          transactionFailed: true,
          createdAt: op.created_at,
          feeCharged: op.transaction_attr?.fee_charged || "0",
        },
        rowIcon: getRowIconByType("fail"),
        rowText: "Transaction Failed",
      };
    } else {
      row = buildOperationRow(op, ctx, date);
    }

    const lastSection =
      sections.length > 0 ? sections[sections.length - 1] : null;
    if (lastSection && lastSection.monthYear === monthYear) {
      lastSection.operations.push(row);
    } else {
      sections.push({ monthYear, operations: [row] });
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

function useGetHistoryData(balanceOptions: {
  showHidden: boolean;
  includeIcons: boolean;
}) {
  const reduxDispatch = useDispatch<AppDispatch>();
  const [state, dispatch] = useReducer(
    reducer<HistoryData, unknown>,
    initialState,
  );
  const cachedHistory = useSelector(resolvedHistorySelector);
  const cachedTokenLists = useSelector(tokensListsSelector);
  const cachedCollections = useSelector(collectionsSelector);
  const { fetchData: fetchAppData } = useGetAppData();
  const { fetchData: fetchBalances } = useGetBalances(balanceOptions);

  const fetchData = async (
    useBalancesCache = false,
    _useHistoryCache = false,
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
      const isHideDustEnabled = !!appData.settings.isHideDustEnabled;
      const assetsLists = (appData.settings as any).assetsLists;

      // STALE-WHILE-REVALIDATE: If we have cached data, show it first
      const cachedData = (cachedHistory || {})[networkDetails.network]?.[
        publicKey
      ];
      if (cachedData && state.state === RequestState.IDLE) {
        dispatch({ type: "FETCH_DATA_SUCCESS", payload: cachedData });
      } else if (!cachedData && state.state !== RequestState.SUCCESS) {
        dispatch({ type: "FETCH_DATA_START" });
      }

      const isMainnetNetwork = isMainnet(networkDetails);

      // Balances are fetched in parallel and are NOT a hard gate for rendering
      // history – the history view does not depend on balance data to display
      // rows, so we resolve history as soon as it is available and let balances
      // populate independently.
      const initialBalances: AccountBalances =
        (cachedData?.type === AppDataType.RESOLVED && cachedData.balances) ||
        ({
          balances: [],
          tokenPrices: {},
          publicKey,
          subentryCount: 0,
        } as AccountBalances);

      const operations = await getAccountHistory(publicKey, networkDetails);
      const collections =
        (cachedCollections || {})[networkDetails.network]?.[publicKey] || [];

      const sectionsResult = await createHistorySections(
        (operations as any[]) || [],
        publicKey,
        networkDetails,
        {
          isHideDustEnabled,
          cachedTokenLists: cachedTokenLists || [],
          collections,
          assetsLists,
        },
      );

      const payload = {
        type: AppDataType.RESOLVED,
        publicKey,
        balances: initialBalances,
        applicationState: appData.account.applicationState,
        history: sectionsResult,
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

      // Update balances in the background once they resolve. This keeps the
      // history rendering responsive while still surfacing fresh balance data.
      void fetchBalances(
        publicKey,
        isMainnetNetwork,
        networkDetails,
        useBalancesCache,
      )
        .then((balancesResult) => {
          if (!isError<AccountBalances>(balancesResult)) {
            const updatedPayload = {
              ...payload,
              balances: balancesResult,
            } as ResolvedData;
            dispatch({ type: "FETCH_DATA_SUCCESS", payload: updatedPayload });
            reduxDispatch(
              saveResolvedHistory({
                publicKey,
                network: networkDetails.network,
                data: updatedPayload,
              }),
            );
          }
        })
        .catch(() => {
          // Balance fetch failures should not break the history view.
        });

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
