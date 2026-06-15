import React, { useState, useEffect, useCallback } from "react";
import {
  Heading,
  Button,
  Icon,
  Input,
  Loader,
  Text,
  Notification,
  Toggle,
} from "@stellar/design-system";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
import BigNumber from "bignumber.js";

import { AppDispatch } from "popup/App";
import { View } from "popup/basics/layout/View";
import { ROUTES } from "popup/constants/routes";
import { navigateTo } from "popup/helpers/navigate";
import { emitBalancesChanged } from "popup/helpers/balanceEvents";
import { publicKeySelector } from "popup/ducks/accountServices";
import { settingsNetworkDetailsSelector } from "popup/ducks/settings";
import {
  signFreighterTransaction,
  submitFreighterTransaction,
} from "popup/ducks/transactionSubmission";
import { useSignSorobanXdr } from "popup/hooks/useSignSorobanXdr";
import { getExplorerUrl, isMainnet } from "helpers/stellar";
import { yieldHubService } from "api/yieldHubService";
import {
  VaultAsset,
  VaultState,
  BalanceResponse,
  VaultPosition,
  SubmitResponse,
  StrategyPosition,
} from "api/yieldHubTypes";
import { agentBackendService } from "api/agentBackendService";
import { OffChainYieldSource } from "api/types";

import { useAutoYield, AutoYieldStatus } from "./hooks/useAutoYield";
import "./styles.scss";

/**
 * Base units per whole token. Baku uses 7 decimals everywhere (XLM, USDC, and
 * the vault share tokens stXLM/stUSDC).
 */
const ONE_TOKEN = new BigNumber("10000000");

enum FetchStatus {
  LOADING = "LOADING",
  READY = "READY",
  ERROR = "ERROR",
  NETWORK_UNSUPPORTED = "NETWORK_UNSUPPORTED",
}

interface PendingTx {
  asset: VaultAsset;
  kind: "deposit" | "withdraw" | "faucet" | "auto";
  hash?: string;
  status?: SubmitResponse["status"];
  error?: string;
}

const AUTO_STATUS_LABEL: Record<AutoYieldStatus, string> = {
  off: "Off",
  idle: "On · idle",
  ready: "On · ready",
  sweeping: "Depositing…",
  cooldown: "Cooling down",
  error: "Last sweep failed",
};

/**
 * Format an i128 decimal string in 7-decimal base units as a human-readable
 * token amount. e.g. "12345670" → "1.2346".
 */
const formatToken = (baseUnits: string, decimals = 4): string => {
  if (!baseUnits || baseUnits === "0") return "0";
  return new BigNumber(baseUnits).div(ONE_TOKEN).toFixed(decimals);
};

const formatApy = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/**
 * Map a strategy name to the CSS modifier used for dot/bar colours.
 * Falls back to "mock" for unknown names.
 */
function strategyColorKey(name: string): string {
  if (name.startsWith("Blend")) return "blend";
  if (name.startsWith("Soroswap")) return "soroswap";
  if (name.startsWith("DeFindex")) return "defindex";
  if (name.startsWith("Native")) return "mock"; // neutral/gray for the idle cash buffer
  return "mock";
}

/**
 * Positions for the strategy-mix panel. Prefer the allocator's per-sleeve
 * `breakdown` (Blend / Soroswap LP / native buffer) when present so the bar
 * shows the real 30/40/30 split; otherwise fall back to the vault's registry
 * positions (single-strategy vaults).
 */
function mixPositions(state: VaultState | null | undefined): StrategyPosition[] {
  if (!state) return [];
  if (state.breakdown && state.breakdown.length > 0) {
    return state.breakdown.map((b) => ({
      address: b.address,
      name: b.label,
      isActive: false,
      currentValue: b.currentValue,
      sharePercent: b.sharePercent,
    }));
  }
  return state.strategyPositions ?? [];
}

/**
 * Strategy mix panel — horizontal stacked bar + legend.
 * MUST be at module scope (see Shell comment: nested component definitions
 * cause React to unmount + remount on every parent render).
 */
const StrategyMixPanel: React.FC<{
  positions: StrategyPosition[];
  symbol: string;
}> = ({ positions, symbol }) => {
  if (!positions || positions.length === 0) return null;

  // Only render segments with non-zero share; include all in the legend.
  return (
    <div className="YieldHub__strategy-mix">
      <div className="YieldHub__strategy-mix__title">
        <Text as="p" size="xs" color="gray-500">
          Strategy mix
        </Text>
      </div>

      {/* Stacked bar */}
      <div className="YieldHub__strategy-mix__bar">
        {positions.map((pos) =>
          pos.sharePercent > 0 ? (
            <div
              key={pos.address}
              className={`YieldHub__strategy-mix__bar__segment YieldHub__strategy-mix__bar__segment--${strategyColorKey(pos.name)}`}
              style={{ width: `${pos.sharePercent}%` }}
              title={`${pos.name}: ${pos.sharePercent.toFixed(1)}%`}
            />
          ) : null,
        )}
      </div>

      {/* Legend */}
      <div className="YieldHub__strategy-mix__legend">
        {positions.map((pos) => (
          <div key={pos.address} className="YieldHub__strategy-mix__legend-row">
            <div className="YieldHub__strategy-mix__legend-row__left">
              <div
                className={`YieldHub__strategy-mix__legend-row__dot YieldHub__strategy-mix__legend-row__dot--${strategyColorKey(pos.name)}`}
              />
              <span className="YieldHub__strategy-mix__legend-row__name">
                {pos.name}
              </span>
              {pos.isActive && (
                <span className="YieldHub__strategy-mix__legend-row__active-badge">
                  Active
                </span>
              )}
            </div>
            <div className="YieldHub__strategy-mix__legend-row__right">
              <span className="YieldHub__strategy-mix__legend-row__pct">
                {pos.sharePercent.toFixed(1)}%
              </span>
              <span className="YieldHub__strategy-mix__legend-row__value">
                {formatToken(pos.currentValue)} {symbol}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Layout wrapper for YieldHub's content. Page mode gets a View.Content wrapper;
 * tab mode passes children through bare (the Account view already wraps the
 * MultiPaneSlider in View.Content, and a second wrapper would double padding).
 *
 * MUST be at module scope. When this was defined inside YieldHub's render body
 * it was a new component identity on every render, so React unmounted and
 * remounted the entire subtree on each keystroke — resetting scroll position
 * and blowing away input focus (see StrategyMixPanel comment).
 */
const Shell: React.FC<{ isTabMode: boolean; children: React.ReactNode }> = ({
  isTabMode,
  children,
}) => (isTabMode ? <>{children}</> : <View.Content>{children}</View.Content>);

/**
 * YieldHub renders the vault hub in two layouts:
 * - `page` (default): full screen with View.Content wrapper, back button,
 *   and large heading. Used when navigated to via ROUTES.yieldHub from the
 *   AccountHeader dropdown.
 * - `tab`: chrome-free body for embedding inside the Account view's
 *   MultiPaneSlider. Skips View.Content (Account already wraps the slider),
 *   omits the back button (no navigation hop), and drops the redundant
 *   "Yield Hub" heading (the tab strip already labels it).
 *
 * The unsupported / loading / error sub-states also adapt: in tab mode they
 * render inline panels without the page-chrome wrapper.
 */
export interface YieldHubProps {
  mode?: "page" | "tab";
}

export const YieldHub = ({ mode = "page" }: YieldHubProps = {}) => {
  const isTabMode = mode === "tab";
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch: AppDispatch = useDispatch();
  const publicKey = useSelector(publicKeySelector);
  const networkDetails = useSelector(settingsNetworkDetailsSelector);

  const signSorobanXdr = useSignSorobanXdr();

  const [status, setStatus] = useState<FetchStatus>(FetchStatus.LOADING);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<VaultPosition[]>([]);
  const [balances, setBalances] = useState<BalanceResponse | null>(null);
  const [vaultStates, setVaultStates] = useState<
    Record<VaultAsset, VaultState | null>
  >({ xlm: null, usdc: null });

  const [offChainSources, setOffChainSources] = useState<OffChainYieldSource[]>(
    [],
  );

  const [depositAmount, setDepositAmount] = useState<
    Record<VaultAsset, string>
  >({ xlm: "", usdc: "" });
  const [withdrawShares, setWithdrawShares] = useState<
    Record<VaultAsset, string>
  >({ xlm: "", usdc: "" });
  const [pending, setPending] = useState<PendingTx | null>(null);

  // Withdraw slippage slider — persisted per network:publicKey.
  // Range: 50–500 bps (0.5%–5%), default 100 (1%), step 25.
  const withdrawSlippageStorageKey =
    publicKey && networkDetails.network
      ? `aptopia:withdrawSlippage:${networkDetails.network}:${publicKey}`
      : null;
  const [withdrawSlippageBps, setWithdrawSlippageBps] = useState<number>(() => {
    if (!withdrawSlippageStorageKey) return 100;
    const stored = localStorage.getItem(withdrawSlippageStorageKey);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    return !isNaN(parsed) && parsed >= 50 && parsed <= 500 ? parsed : 100;
  });

  const handleWithdrawSlippageChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const bps = parseInt(e.target.value, 10);
    setWithdrawSlippageBps(bps);
    if (withdrawSlippageStorageKey) {
      localStorage.setItem(withdrawSlippageStorageKey, String(bps));
    }
  };

  const onMainnet = isMainnet(networkDetails);

  const loadAll = useCallback(async () => {
    if (!publicKey) return;
    if (onMainnet) {
      setStatus(FetchStatus.NETWORK_UNSUPPORTED);
      return;
    }
    setStatus(FetchStatus.LOADING);
    setError(null);
    try {
      // Health-check first so a Baku outage yields a clear message instead of
      // a generic vault-state error.
      await yieldHubService.getHealth();

      const [xlmState, usdcState, balance, offChain] = await Promise.all([
        yieldHubService.getVaultState("xlm"),
        yieldHubService.getVaultState("usdc"),
        yieldHubService.getBalance(publicKey),
        agentBackendService
          .getOffChainYieldSources()
          .catch(() => [] as OffChainYieldSource[]),
      ]);

      setVaultStates({ xlm: xlmState, usdc: usdcState });
      setBalances(balance);
      setOffChainSources(offChain);

      const computed: VaultPosition[] = (["xlm", "usdc"] as VaultAsset[]).map(
        (asset) => {
          const s = asset === "xlm" ? xlmState : usdcState;
          const shares = asset === "xlm" ? balance.stxlm : balance.stusdc;
          // underlying = shares * pricePerShare / ONE_TOKEN  (all in base units)
          const underlyingValue = new BigNumber(shares)
            .multipliedBy(new BigNumber(s.pricePerShare))
            .div(ONE_TOKEN)
            .toFixed(0);
          return {
            asset,
            vault: s.vault,
            activeStrategy: s.activeStrategy,
            shares,
            pricePerShare: s.pricePerShare,
            underlyingValue,
            apyBps: s.poolApyBps,
            totalAssets: s.totalAssets,
          };
        },
      );
      setPositions(computed);
      setStatus(FetchStatus.READY);
    } catch (e) {
      console.error("YieldHub: failed to load vault data", e);
      setError(e instanceof Error ? e.message : String(e));
      setStatus(FetchStatus.ERROR);
    }
  }, [publicKey, onMainnet]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Refresh when window regains focus (consistent with Dashboard).
  useEffect(() => {
    const handleFocus = () => loadAll();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [loadAll]);

  /**
   * Shared deposit pipeline: build → sign Soroban → submit → refresh.
   * Both the manual button (runDeposit) and the auto-yield sweeper call this.
   * Throws on failure so callers can react; updates `pending` for UI feedback.
   */
  const depositBaseUnits = useCallback(
    async (asset: VaultAsset, baseUnits: string, kind: PendingTx["kind"]) => {
      if (!publicKey || onMainnet)
        throw new Error("Auto-yield is testnet-only.");
      setPending({ asset, kind, status: "PENDING" });
      try {
        const { xdr } = await yieldHubService.buildDeposit(
          asset,
          publicKey,
          baseUnits,
        );
        const signedXdr = await signSorobanXdr(xdr);
        const submitRes = await yieldHubService.submitSignedTx(signedXdr);
        setPending({
          asset,
          kind,
          hash: submitRes.hash,
          status: submitRes.status,
          error: submitRes.error,
        });
        await loadAll();
        if (submitRes.error || submitRes.status === "FAILED") {
          throw new Error(submitRes.error || "Deposit submission failed.");
        }
        // Tell the Account view to re-fetch wallet balances so the Tokens tab
        // reflects the spent funds without a close/reopen.
        emitBalancesChanged();
      } catch (e) {
        setPending({
          asset,
          kind,
          status: "FAILED",
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },
    [publicKey, onMainnet, signSorobanXdr, loadAll],
  );

  const runDeposit = async (asset: VaultAsset) => {
    if (!publicKey || onMainnet) return;
    const raw = depositAmount[asset];
    if (!raw) return;
    const baseUnits = new BigNumber(raw).multipliedBy(ONE_TOKEN).toFixed(0);
    try {
      await depositBaseUnits(asset, baseUnits, "deposit");
      setDepositAmount((p) => ({ ...p, [asset]: "" }));
    } catch {
      // depositBaseUnits already populated `pending` with FAILED + error.
    }
  };

  const { state: autoYield, setEnabled: setAutoEnabled } = useAutoYield({
    publicKey: publicKey || undefined,
    network: networkDetails.network,
    balances: balances ? { xlm: balances.xlm, usdc: balances.usdc } : null,
    onSweep: useCallback(
      async (asset: VaultAsset, baseUnits: string) => {
        await depositBaseUnits(asset, baseUnits, "auto");
      },
      [depositBaseUnits],
    ),
  });

  const runBlendFaucet = async () => {
    // Blend's testnet faucet delivers USDC, BLND, wETH, and wBTC plus the
    // matching trustlines in a single classic tx. The upstream returns an
    // envelope partially signed by the asset issuer; the wallet co-signs as
    // the user (for the change_trust ops) and submits to horizon.
    if (!publicKey || onMainnet) return;
    setPending({ asset: "usdc", kind: "faucet", status: "PENDING" });
    try {
      const { xdr } = await yieldHubService.getBlendTestnetFaucet(publicKey);
      const signRes = await dispatch(
        signFreighterTransaction({
          transactionXDR: xdr,
          network: networkDetails.networkPassphrase,
        }),
      );
      if (!signFreighterTransaction.fulfilled.match(signRes)) {
        throw new Error(
          signRes.payload?.errorMessage ||
            "Failed to sign Blend faucet transaction.",
        );
      }
      const submitRes = await dispatch(
        submitFreighterTransaction({
          publicKey,
          signedXDR: signRes.payload.signedTransaction,
          networkDetails,
        }),
      );
      if (!submitFreighterTransaction.fulfilled.match(submitRes)) {
        throw new Error(
          (submitRes.payload as { errorMessage?: string } | undefined)
            ?.errorMessage || "Faucet submission failed.",
        );
      }
      const hash = (submitRes.payload as { hash?: string } | undefined)?.hash;
      setPending({
        asset: "usdc",
        kind: "faucet",
        status: "SUCCESS",
        hash,
      });
      await loadAll();
    } catch (e) {
      setPending({
        asset: "usdc",
        kind: "faucet",
        status: "FAILED",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const runWithdraw = async (asset: VaultAsset) => {
    if (!publicKey || onMainnet) return;
    const raw = withdrawShares[asset];
    if (!raw) return;
    const baseUnits = new BigNumber(raw).multipliedBy(ONE_TOKEN).toFixed(0);

    setPending({ asset, kind: "withdraw", status: "PENDING" });
    try {
      const { xdr } = await yieldHubService.buildWithdraw(
        asset,
        publicKey,
        baseUnits,
        withdrawSlippageBps,
      );
      const signedXdr = await signSorobanXdr(xdr);
      const submitRes = await yieldHubService.submitSignedTx(signedXdr);
      setPending({
        asset,
        kind: "withdraw",
        hash: submitRes.hash,
        status: submitRes.status,
        error: submitRes.error,
      });
      setWithdrawShares((p) => ({ ...p, [asset]: "" }));
      await loadAll();
      if (submitRes.status !== "FAILED" && !submitRes.error) {
        emitBalancesChanged();
      }
    } catch (e) {
      setPending({
        asset,
        kind: "withdraw",
        status: "FAILED",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (status === FetchStatus.NETWORK_UNSUPPORTED) {
    return (
      <Shell isTabMode={isTabMode}>
        <div className="YieldHub__error">
          <Notification
            variant="warning"
            title={t("Yield Hub is testnet-only")}
          >
            {t(
              "Baku vaults live on Stellar testnet. Switch your network to Testnet from the wallet header to use Yield Hub.",
            )}
          </Notification>
          {!isTabMode && (
            <Button
              size="md"
              variant="secondary"
              isFullWidth
              onClick={() => navigateTo(ROUTES.account, navigate)}
            >
              {t("Back to wallet")}
            </Button>
          )}
        </div>
      </Shell>
    );
  }

  if (status === FetchStatus.LOADING) {
    return (
      <Shell isTabMode={isTabMode}>
        <div className="YieldHub__loading">
          <Loader />
          <Text as="p" size="sm" color="gray-500">
            {t("Loading vault positions…")}
          </Text>
        </div>
      </Shell>
    );
  }

  if (status === FetchStatus.ERROR) {
    return (
      <Shell isTabMode={isTabMode}>
        <div className="YieldHub__error">
          <Notification variant="error" title={t("Yield Hub unavailable")}>
            {error || t("Baku API did not respond.")}
          </Notification>
          <Button
            size="md"
            variant="secondary"
            isFullWidth
            onClick={() => loadAll()}
            icon={<Icon.RefreshCw01 />}
            iconPosition="left"
          >
            {t("Retry")}
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell isTabMode={isTabMode}>
      <div className="YieldHub">
        {!isTabMode && (
          <header className="YieldHub__header">
            <div className="YieldHub__header__left">
              <div
                className="YieldHub__header__back-btn"
                onClick={() => navigateTo(ROUTES.account, navigate)}
              >
                <Icon.ArrowLeft />
              </div>
              <Heading
                as="h1"
                size="sm"
                addlClassName="YieldHub__header__title"
              >
                {t("Yield Hub")}
              </Heading>
            </div>
            <div
              className="YieldHub__header__refresh"
              onClick={() => loadAll()}
              title={t("Refresh")}
            >
              <Icon.RefreshCw01 />
            </div>
          </header>
        )}
        {isTabMode && (
          <div
            className="YieldHub__tab-refresh"
            onClick={() => loadAll()}
            title={t("Refresh")}
          >
            <Icon.RefreshCw01 />
          </div>
        )}

        {balances && (
          <div className="YieldHub__wallet">
            <Text as="p" size="xs" color="gray-500">
              {t("Wallet")}
            </Text>
            <div className="YieldHub__wallet__row">
              <span>XLM</span>
              <span>{formatToken(balances.xlm)}</span>
            </div>
            <div className="YieldHub__wallet__row">
              <span>USDC</span>
              <span>{formatToken(balances.usdc)}</span>
            </div>
            <Button
              size="sm"
              variant="tertiary"
              isFullWidth
              onClick={() => runBlendFaucet()}
              isLoading={
                pending?.kind === "faucet" && pending?.status === "PENDING"
              }
            >
              {t("Get testnet assets (Blend faucet)")}
            </Button>
          </div>
        )}

        <div className="YieldHub__auto-yield">
          <div className="YieldHub__auto-yield__heading">
            <Text as="p" size="xs" color="gray-500">
              {t("Auto-yield")}
            </Text>
            <Text as="p" size="xs" color="gray-500">
              {t(
                "Sweep idle wallet balance into the active vault on a 1-minute cadence (5-minute cool-down). Withdraw any time.",
              )}
            </Text>
          </div>
          {(["xlm", "usdc"] as VaultAsset[]).map((asset) => {
            const entry = autoYield[asset];
            const symbol = asset.toUpperCase();
            const showSurplus =
              entry.enabled && new BigNumber(entry.surplus).gt(0);
            return (
              <div className="YieldHub__auto-yield__row" key={asset}>
                <div className="YieldHub__auto-yield__row__left">
                  <Toggle
                    id={`auto-yield-${asset}`}
                    fieldSize="sm"
                    checked={entry.enabled}
                    onChange={() => setAutoEnabled(asset, !entry.enabled)}
                  />
                  <span>{symbol}</span>
                </div>
                <span
                  className={`YieldHub__auto-yield__status YieldHub__auto-yield__status--${entry.status}`}
                  data-testid={`auto-yield-status-${asset}`}
                >
                  {AUTO_STATUS_LABEL[entry.status]}
                  {showSurplus
                    ? ` · ${new BigNumber(entry.surplus).toFixed(4)} ${symbol}`
                    : ""}
                </span>
              </div>
            );
          })}
          {(autoYield.xlm.lastError || autoYield.usdc.lastError) && (
            <Text as="p" size="xs" color="gray-500">
              {autoYield.xlm.lastError || autoYield.usdc.lastError}
            </Text>
          )}
        </div>

        {positions.map((p) => {
          const symbol = p.asset.toUpperCase();
          const shareSymbol = `st${symbol}`;
          const walletUnderlying =
            balances && p.asset === "xlm"
              ? balances.xlm
              : balances?.usdc || "0";

          return (
            <section key={p.asset} className="YieldHub__vault">
              <div className="YieldHub__vault__header">
                <div className="YieldHub__vault__header__title">
                  <Heading as="h2" size="xs">
                    {shareSymbol}
                  </Heading>
                  <span className="YieldHub__vault__header__apy">
                    {formatApy(p.apyBps)} APY
                  </span>
                </div>
                <Text as="p" size="xs" color="gray-500">
                  {vaultStates[p.asset]?.network} · TVL{" "}
                  {formatToken(p.totalAssets)} {symbol}
                </Text>
              </div>

              <div className="YieldHub__vault__position">
                <div className="YieldHub__vault__position__row">
                  <span>{t("Your shares")}</span>
                  <span>
                    {formatToken(p.shares)} {shareSymbol}
                  </span>
                </div>
                <div className="YieldHub__vault__position__row">
                  <span>{t("Underlying value")}</span>
                  <span>
                    {formatToken(p.underlyingValue)} {symbol}
                  </span>
                </div>
                <div className="YieldHub__vault__position__row YieldHub__vault__position__row--muted">
                  <span>{t("Price / share")}</span>
                  <span>
                    {new BigNumber(p.pricePerShare).div(ONE_TOKEN).toFixed(6)}
                  </span>
                </div>
              </div>

              {/* B5: Strategy mix panel — below vault stats, above deposit/withdraw.
                  Shows the allocator's 30/40/30 per-sleeve breakdown when present. */}
              <StrategyMixPanel
                positions={mixPositions(vaultStates[p.asset])}
                symbol={symbol}
              />

              <div className="YieldHub__vault__actions">
                <div className="YieldHub__vault__action">
                  <Input
                    fieldSize="sm"
                    id={`deposit-${p.asset}`}
                    label={t("Deposit {{symbol}}", { symbol })}
                    type="text"
                    placeholder={`0.0 (max ${formatToken(walletUnderlying)})`}
                    value={depositAmount[p.asset]}
                    onChange={(e) =>
                      setDepositAmount((prev) => ({
                        ...prev,
                        [p.asset]: e.target.value,
                      }))
                    }
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    isFullWidth
                    onClick={() => runDeposit(p.asset)}
                    isLoading={
                      pending?.asset === p.asset &&
                      pending?.kind === "deposit" &&
                      pending?.status === "PENDING"
                    }
                    disabled={!depositAmount[p.asset]}
                  >
                    {t("Deposit")}
                  </Button>
                </div>

                <div className="YieldHub__vault__action">
                  <Input
                    fieldSize="sm"
                    id={`withdraw-${p.asset}`}
                    label={t("Redeem shares")}
                    type="text"
                    placeholder={`0.0 (max ${formatToken(p.shares)})`}
                    value={withdrawShares[p.asset]}
                    onChange={(e) =>
                      setWithdrawShares((prev) => ({
                        ...prev,
                        [p.asset]: e.target.value,
                      }))
                    }
                  />
                  <div className="YieldHub__slippage">
                    <div className="YieldHub__slippage__header">
                      <Text as="span" size="xs" color="gray-10">
                        {t("Max slippage")}
                      </Text>
                      <Text as="span" size="xs" color="gray-12">
                        {(withdrawSlippageBps / 100).toFixed(2)}%
                      </Text>
                    </div>
                    <input
                      className="YieldHub__slippage__range"
                      type="range"
                      min={50}
                      max={500}
                      step={25}
                      value={withdrawSlippageBps}
                      onChange={handleWithdrawSlippageChange}
                    />
                    {withdrawSlippageBps > 200 && (
                      <Text
                        as="p"
                        size="xs"
                        color="gray-10"
                        addlClassName="YieldHub__slippage__warning"
                      >
                        {t(
                          "High slippage — confirm acceptable before submitting.",
                        )}
                      </Text>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    isFullWidth
                    onClick={() => runWithdraw(p.asset)}
                    isLoading={
                      pending?.asset === p.asset &&
                      pending?.kind === "withdraw" &&
                      pending?.status === "PENDING"
                    }
                    disabled={
                      !withdrawShares[p.asset] ||
                      new BigNumber(p.shares).isZero()
                    }
                  >
                    {t("Withdraw")}
                  </Button>
                </div>
              </div>
            </section>
          );
        })}

        {/* B4: Off-chain yield sources — read-only display */}
        {offChainSources.length > 0 && (
          <section className="YieldHub__off-chain">
            <div className="YieldHub__off-chain__header">
              <Text as="p" size="xs" color="gray-500">
                {t("Off-chain yield sources")}
              </Text>
            </div>
            {offChainSources.map((source) => (
              <a
                key={source.id}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="YieldHub__off-chain__row"
              >
                <div className="YieldHub__off-chain__row__left">
                  <span className="YieldHub__off-chain__row__name">
                    {source.name}
                  </span>
                  <span className="YieldHub__off-chain__row__asset">
                    {source.asset}
                  </span>
                </div>
                <div className="YieldHub__off-chain__row__right">
                  <span className="YieldHub__off-chain__row__apy">
                    {source.apyPercent.toFixed(1)}% APY
                  </span>
                  <span className="YieldHub__off-chain__row__badge">
                    {t("External")} ↗
                  </span>
                </div>
              </a>
            ))}
            <Text
              as="p"
              size="xs"
              color="gray-10"
              addlClassName="YieldHub__off-chain__disclaimer"
            >
              {t("Rates self-reported by providers. Not custodied by Aptopia.")}
            </Text>
          </section>
        )}

        {pending && (pending.hash || pending.error || pending.status) && (
          <div className="YieldHub__pending">
            <Notification
              variant={
                pending.status === "SUCCESS"
                  ? "success"
                  : pending.status === "FAILED"
                    ? "error"
                    : "primary"
              }
              title={t("Last {{kind}} ({{asset}})", {
                kind: pending.kind,
                asset: pending.asset.toUpperCase(),
              })}
            >
              {pending.hash ? (
                <a
                  href={getExplorerUrl(pending.hash, networkDetails)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {pending.hash}
                </a>
              ) : (
                <span>
                  {pending.status === "PENDING"
                    ? t("Building transaction…")
                    : null}
                </span>
              )}
              {pending.error ? (
                <div className="YieldHub__pending__error">{pending.error}</div>
              ) : null}
            </Notification>
          </div>
        )}
      </div>
    </Shell>
  );
};
