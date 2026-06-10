import React, { useEffect, useState, memo } from "react";
import { useSelector } from "react-redux";
import isEmpty from "lodash/isEmpty";
import { Asset, Horizon } from "stellar-sdk";
import { Icon } from "@stellar/design-system";
import BigNumber from "bignumber.js";
import isEqual from "lodash/isEqual";

import { ApiTokenPrices, AssetIcons, Balance } from "@shared/api/types";
import { retryAssetIcon } from "@shared/api/internal";
import { AccountBalances } from "helpers/hooks/useGetBalances";

import { getCanonicalFromAsset } from "helpers/stellar";
import { isSorobanIssuer } from "popup/helpers/account";
import { formatTokenAmount } from "popup/helpers/soroban";
import { useIsAssetSuspicious } from "popup/helpers/blockaid";
import { formatAmount, roundUsdValue } from "popup/helpers/formatters";
import {
  VaultPositions,
  BLEND_TESTNET_USDC_ISSUER,
} from "popup/views/Account/hooks/useUnifiedBalances";

import {
  ScreenReaderOnly,
  Sheet,
  SheetContent,
  SheetTitle,
} from "popup/basics/shadcn/Sheet";

import StellarLogo from "popup/assets/stellar-logo.png";
import { settingsNetworkDetailsSelector } from "popup/ducks/settings";
import { transactionSubmissionSelector } from "popup/ducks/transactionSubmission";
import { ScamAssetIcon } from "popup/components/account/ScamAssetIcon";
import ImageMissingIcon from "popup/assets/image-missing.svg?react";
import IconSoroban from "popup/assets/icon-soroban.svg?react";
import { getPriceDeltaColor } from "popup/helpers/balance";
import { AccountHistoryData } from "popup/views/Account/hooks/useGetAccountHistoryData";

import "./styles.scss";
import { AssetDetail } from "../AssetDetail";

const getIsXlm = (code: string) => code === "XLM";

export const SorobanTokenIcon = ({ noMargin }: { noMargin?: boolean }) => (
  <div
    className={`AccountAssets__asset--logo AccountAssets__asset--soroban-token ${
      noMargin ? "AccountAssets__asset--no-margin" : ""
    }`}
  >
    <IconSoroban />
  </div>
);

interface AssetIconProps {
  assetIcons: AssetIcons;
  code: string;
  issuerKey: string;
  retryAssetIconFetch?: (arg: { key: string; code: string }) => void;
  isLPShare?: boolean;
  isSorobanToken?: boolean;
  icon?: string | null;
  isSuspicious?: boolean;
  isModal?: boolean;
}

const shouldAssetIconSkipUpdate = (
  prevProps: AssetIconProps,
  nextProps: AssetIconProps,
) =>
  isEqual(prevProps.assetIcons, nextProps.assetIcons) &&
  prevProps.isSuspicious === nextProps.isSuspicious;

export const AssetIcon = memo(
  ({
    assetIcons,
    code,
    issuerKey,
    retryAssetIconFetch,
    isLPShare = false,
    isSorobanToken = false,
    icon,
    isSuspicious = false,
    isModal = false,
  }: AssetIconProps) => {
    /*
    We load asset icons in 2 ways:
    Method 1. We get an asset's issuer and use that to look up toml info to get the icon path
    Method 2. We get an icon path directly from an API (like in the trustline flow) and just pass it to this component to render
  */

    const isXlm = getIsXlm(code);

    // in Method 1, while we wait for the icon path to load, `assetIcons` will be empty until the promise resolves
    // This does not apply for XLM as there is no lookup as that logo lives in this codebase
    const isFetchingAssetIcons = isEmpty(assetIcons) && !isXlm;

    const [hasError, setHasError] = useState(false);

    // For all non-XLM assets (assets where we need to fetch the icon from elsewhere), start by showing a loading state as there is work to do
    const [isLoading, setIsLoading] = useState(true);

    const { soroswapTokens } = useSelector(transactionSubmissionSelector);

    const canonicalAsset = assetIcons[getCanonicalFromAsset(code, issuerKey)];
    let imgSrc = hasError ? ImageMissingIcon : canonicalAsset || "";
    if (icon) {
      imgSrc = icon;
    }

    const _isSorobanToken = !isSorobanToken
      ? issuerKey && isSorobanIssuer(issuerKey)
      : isSorobanToken;

    // If an LP share return early w/ hardcoded icon
    if (isLPShare) {
      return (
        <div className="AccountAssets__asset--logo AccountAssets__asset--lp-share">
          LP
        </div>
      );
    }

    // Get icons for Soroban tokens which are not present in assetIcons list
    if (_isSorobanToken && !icon && !canonicalAsset) {
      const soroswapTokenDetail = soroswapTokens.find(
        (token) => token.contract === issuerKey,
      );
      // check to see if we have an icon from an external service, like Soroswap
      if (soroswapTokenDetail?.icon) {
        imgSrc = soroswapTokenDetail?.icon;
      } else {
        return <SorobanTokenIcon />;
      }
    }

    // If we're waiting on the icon lookup (Method 1), just return the loader until this re-renders with `assetIcons`. We can't do anything until we have it.
    if (isFetchingAssetIcons) {
      return (
        <div
          data-testid="AccountAssets__asset--loading"
          className="AccountAssets__asset--logo AccountAssets__asset--loading"
        >
          <ScamAssetIcon isScamAsset={isSuspicious} />
        </div>
      );
    }

    // if we have an asset path, start loading the path in an `<img>`
    return canonicalAsset || isXlm || imgSrc ? (
      <div
        data-testid={`AccountAssets__asset--loading-${code}`}
        className={`AccountAssets__asset--logo ${
          hasError ? "AccountAssets__asset--error" : ""
        } ${isLoading ? "AccountAssets__asset--loading" : ""} ${
          isModal ? "AccountAssets__asset--modal" : ""
        }`}
      >
        <img
          alt={`${code} logo`}
          src={isXlm ? StellarLogo : imgSrc}
          onError={() => {
            if (retryAssetIconFetch) {
              retryAssetIconFetch({ key: issuerKey, code });
            }
            // we tried to load an image path but it failed, so show the broken image icon here
            setHasError(true);
          }}
          onLoad={() => {
            // we've sucessfully loaded an icon, end the "loading" state
            setIsLoading(false);
          }}
        />
        <ScamAssetIcon isScamAsset={isSuspicious} />
      </div>
    ) : (
      // the image path wasn't found, show a default broken image icon
      <div
        className={`AccountAssets__asset--logo AccountAssets__asset--error ${
          isModal ? "AccountAssets__asset--modal" : ""
        }`}
      >
        <ImageMissingIcon />
        <ScamAssetIcon isScamAsset={isSuspicious} />
      </div>
    );
  },
  shouldAssetIconSkipUpdate,
);

interface AccountAssetsProps {
  assetIcons: AssetIcons;
  balances: AccountBalances;
  historyData: AccountHistoryData | null;
  assetPrices?: ApiTokenPrices;
  /**
   * Yield Hub vault positions keyed by asset slug. When a row matches a
   * position the amount column shows the aggregate (wallet + vault) and a
   * chevron toggles an inline split (wallet / Yield Hub).
   */
  vaultPositions?: VaultPositions;
}

/** Base units per whole token across Baku (XLM, USDC, stXLM, stUSDC). */
const ONE_TOKEN = new BigNumber("10000000");

/**
 * Match a Horizon-side balance row to a Baku vault position. Returns the
 * vault asset key, or null if the row isn't a vault-eligible asset.
 *
 * - Native XLM → `xlm`
 * - Classic USDC issued by Blend's testnet issuer (GATALTGT...) → `usdc`
 * - Anything else (custom assets, LP shares, Soroban tokens, Circle USDC
 *   from a different issuer) returns null — those don't have a vault yet.
 */
const matchVaultAsset = (
  code: string,
  issuer: string,
  isLP: boolean,
): "xlm" | "usdc" | null => {
  if (isLP) return null;
  if (code === "XLM" && !issuer) return "xlm";
  if (code === "USDC" && issuer === BLEND_TESTNET_USDC_ISSUER) return "usdc";
  return null;
};

export const AccountAssets = ({
  assetIcons: inputAssetIcons,
  balances,
  assetPrices,
  historyData,
  vaultPositions = {},
}: AccountAssetsProps) => {
  const [assetIcons, setAssetIcons] = useState(inputAssetIcons);
  const networkDetails = useSelector(settingsNetworkDetailsSelector);
  const [hasIconFetchRetried, setHasIconFetchRetried] = useState(false);
  const isAssetSuspicious = useIsAssetSuspicious();
  const [selectedAsset, setSelectedAsset] = useState<string>("");
  // Canonical asset key of the row whose accordion is currently expanded.
  // Only one row at a time — opening another row collapses the previous.
  const [expandedAsset, setExpandedAsset] = useState<string>("");

  useEffect(() => {
    setAssetIcons(inputAssetIcons);
  }, [inputAssetIcons]);

  const retryAssetIconFetch = async ({
    key,
    code,
  }: {
    key: string;
    code: string;
  }) => {
    /* if we retried the toml and their link is still bad, just give up here */
    if (hasIconFetchRetried) {
      return;
    }
    try {
      const res = await retryAssetIcon({
        activePublicKey: null,
        key,
        code,
        assetIcons,
        networkDetails,
      });
      setAssetIcons(res);
      setHasIconFetchRetried(true);
    } catch (e) {
      console.error(e);
    }
  };

  const handleClick = (code: string) => {
    setSelectedAsset(getIsXlm(code) ? "native" : code);
  };

  const getLPShareCode = (reserves: Horizon.HorizonApi.Reserve[]) => {
    if (!reserves[0] || !reserves[1]) {
      return "";
    }

    let assetA = reserves[0].asset.split(":")[0];
    let assetB = reserves[1].asset.split(":")[0];

    if (assetA === Asset.native().toString()) {
      assetA = Asset.native().code;
    }
    if (assetB === Asset.native().toString()) {
      assetB = Asset.native().code;
    }

    return `${assetA} / ${assetB} `;
  };

  return (
    <>
      {balances.balances.map((rb) => {
        let isLP = false;
        let issuer = {
          key: "",
        };
        let code = "";
        if ("liquidityPoolId" in rb) {
          isLP = true;
          code = getLPShareCode(rb.reserves);
        } else if ("contractId" in rb && "symbol" in rb) {
          issuer = {
            key: rb.contractId,
          };
          code = rb.symbol;
        } else {
          if (rb.token && "issuer" in rb.token) {
            issuer = rb.token.issuer;
          }

          if (rb.token && "code" in rb.token) {
            code = rb.token.code;
          }
        }

        const canonicalAsset = getCanonicalFromAsset(code, issuer?.key);
        const assetPrice = assetPrices ? assetPrices[canonicalAsset] : null;

        const isSuspicious = isAssetSuspicious((rb as Balance).blockaidData);

        // Vault aggregation: only kicks in for XLM and Blend-issued USDC.
        // For every other asset, vaultAsset is null and the row renders
        // exactly as before (wallet-only amount, no chevron).
        const vaultAsset = matchVaultAsset(code, issuer?.key || "", isLP);
        const position = vaultAsset ? vaultPositions[vaultAsset] : undefined;
        const hasVaultPosition =
          !!position &&
          !new BigNumber(position.underlying).isZero();
        const walletWhole = new BigNumber(rb.total.toString());
        const vaultWhole = hasVaultPosition
          ? new BigNumber(position!.underlying).div(ONE_TOKEN)
          : new BigNumber(0);
        const aggregateWhole = walletWhole.plus(vaultWhole);

        // For Soroban tokens use the contract-aware formatter; for classic
        // (XLM / USDC / others) use the aggregated value when there's a
        // vault position, otherwise the existing wallet-only path.
        const amountVal =
          "contractId" in rb && "decimals" in rb
            ? formatTokenAmount(rb.total, rb.decimals)
            : hasVaultPosition
              ? aggregateWhole.toFixed()
              : rb.total.toFixed();

        const usdMultiplier = hasVaultPosition ? aggregateWhole : rb.total;
        const isExpanded = expandedAsset === canonicalAsset;

        return (
          <React.Fragment key={canonicalAsset}>
            <Sheet open={selectedAsset === canonicalAsset}>
              <div
                data-testid="account-assets-item"
                className={`AccountAssets__asset ${
                  !isLP ? "AccountAssets__asset--has-detail" : ""
                }`}
                onClick={isLP ? () => null : () => handleClick(canonicalAsset)}
              >
                <div className="AccountAssets__copy-left">
                  <AssetIcon
                    assetIcons={assetIcons}
                    code={code}
                    issuerKey={issuer?.key}
                    retryAssetIconFetch={retryAssetIconFetch}
                    isLPShare={"liquidityPoolId" in rb && !!rb.liquidityPoolId}
                    isSuspicious={isSuspicious}
                  />
                  <div className="asset-native-value">
                    <span className="asset-code">{code}</span>
                    <div
                      className="asset-native-amount"
                      data-testid="asset-amount"
                    >
                      {formatAmount(amountVal)}
                    </div>
                  </div>
                </div>
                <div className="AccountAssets__right-cluster">
                  {assetPrice ? (
                    <div className="AccountAssets__copy-right">
                      <div
                        className="asset-usd-amount"
                        data-testid={`asset-amount-${canonicalAsset}`}
                      >
                        $
                        {formatAmount(
                          roundUsdValue(
                            new BigNumber(assetPrice.currentPrice)
                              .multipliedBy(usdMultiplier)
                              .toString(),
                          ),
                        )}
                      </div>
                      {assetPrice.percentagePriceChange24h ? (
                        <div
                          data-testid={`asset-price-delta-${canonicalAsset}`}
                          className={`asset-value-delta ${getPriceDeltaColor(
                            new BigNumber(
                              roundUsdValue(
                                assetPrice.percentagePriceChange24h,
                              ),
                            ),
                          )}
                        `}
                        >
                          {formatAmount(
                            roundUsdValue(assetPrice.percentagePriceChange24h),
                          )}
                          %
                        </div>
                      ) : (
                        <div
                          data-testid={`asset-price-delta-${canonicalAsset}`}
                          className="asset-value-delta"
                        >
                          --
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      data-testid={`asset-price-delta-${canonicalAsset}`}
                      className="asset-value-delta"
                    >
                      --
                    </div>
                  )}
                  {hasVaultPosition && (
                    <button
                      type="button"
                      className="AccountAssets__chevron"
                      data-testid={`asset-accordion-${canonicalAsset}`}
                      aria-label={
                        isExpanded
                          ? "Hide balance split"
                          : "Show balance split"
                      }
                      aria-expanded={isExpanded}
                      onClick={(e) => {
                        // Don't open the asset detail sheet — this button
                        // owns the row's expand affordance.
                        e.stopPropagation();
                        setExpandedAsset(isExpanded ? "" : canonicalAsset);
                      }}
                    >
                      {isExpanded ? <Icon.ChevronUp /> : <Icon.ChevronDown />}
                    </button>
                  )}
                </div>
              </div>
              <SheetContent
                onOpenAutoFocus={(e) => e.preventDefault()}
                aria-describedby={undefined}
                side="bottom"
                className="AccountAssets__asset-detail__wrapper"
              >
                <ScreenReaderOnly>
                  <SheetTitle>{canonicalAsset}</SheetTitle>
                </ScreenReaderOnly>
                <AssetDetail
                  accountBalances={balances}
                  historyData={historyData}
                  selectedAsset={canonicalAsset}
                  handleClose={() => setSelectedAsset("")}
                  vaultPositions={vaultPositions}
                />
              </SheetContent>
            </Sheet>
            {hasVaultPosition && isExpanded && (
              <div
                className="AccountAssets__split"
                data-testid={`asset-split-${canonicalAsset}`}
              >
                <div className="AccountAssets__split__row">
                  <span className="AccountAssets__split__label">Wallet</span>
                  <span className="AccountAssets__split__value">
                    {formatAmount(walletWhole.toFixed())} {code}
                  </span>
                </div>
                <div className="AccountAssets__split__row">
                  <span className="AccountAssets__split__label">
                    Yield Hub
                  </span>
                  <span className="AccountAssets__split__value">
                    {formatAmount(vaultWhole.toFixed())} {code}
                  </span>
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};
