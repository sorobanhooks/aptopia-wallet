// useUnifiedBalances — fetches the user's Yield Hub vault positions and
// returns them in a shape AccountAssets can merge into each token row.
//
// The Tokens tab on the main account screen aggregates wallet + vault
// position per asset:
//   aggregate = wallet_balance + (shares * pricePerShare / 1e7)
// The accordion in the row shows the split (wallet + vault) on demand.
//
// On mainnet — and when the Baku API is unreachable — we silently return an
// empty result so the Tokens list degrades to pure-wallet view without
// blocking the render or surfacing a "Yield Hub down" panel here. The
// dedicated Yield Hub tab still handles that messaging.

import { useCallback, useEffect, useState } from "react";
import BigNumber from "bignumber.js";

import { yieldHubService } from "api/yieldHubService";
import {
  VaultAsset,
  VaultState,
  BalanceResponse,
} from "api/yieldHubTypes";

/**
 * Base units per whole token in Baku. XLM, USDC and the share tokens
 * (stXLM/stUSDC) all use 7 decimals, matching Stellar's native scalar.
 */
const ONE_TOKEN = new BigNumber("10000000");

/**
 * Blend testnet USDC issuer key. The Baku vault wraps this asset's SAC
 * (CAQCFVLO...), so to match it against the user's Horizon balances we have
 * to recognise the classic issuer too. Source: stellar contract invoke …
 * name() on the SAC at deploy time returned "USDC:GATALTGT...".
 */
export const BLEND_TESTNET_USDC_ISSUER =
  "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";

export interface VaultPositionEntry {
  /** Vault share token balance (stXLM / stUSDC) in base units. */
  shares: string;
  /** Underlying value of those shares in base units (shares * pps / 1e7). */
  underlying: string;
  /** Per-share price in base units (1e7 = parity). */
  pricePerShare: string;
  /** APY in basis points exposed by the active strategy. */
  apyBps: number;
}

export type VaultPositions = Partial<Record<VaultAsset, VaultPositionEntry>>;

export interface UseUnifiedBalancesResult {
  positions: VaultPositions;
  isReady: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const computeUnderlying = (shares: string, pricePerShare: string): string =>
  new BigNumber(shares)
    .multipliedBy(new BigNumber(pricePerShare))
    .div(ONE_TOKEN)
    .toFixed(0);

interface UseUnifiedBalancesArgs {
  publicKey: string | undefined;
  isTestnet: boolean;
}

export const useUnifiedBalances = ({
  publicKey,
  isTestnet,
}: UseUnifiedBalancesArgs): UseUnifiedBalancesResult => {
  const [positions, setPositions] = useState<VaultPositions>({});
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!publicKey || !isTestnet) {
      // Skip silently on mainnet / unauthenticated.
      setPositions({});
      setIsReady(true);
      return;
    }

    setError(null);
    try {
      // Health probe gates the other calls — without it we'd spam four 5s
      // timeouts when Baku is down.
      await yieldHubService.getHealth();

      const [balance, xlmState, usdcState] = await Promise.all([
        yieldHubService.getBalance(publicKey) as Promise<BalanceResponse>,
        yieldHubService.getVaultState("xlm") as Promise<VaultState>,
        yieldHubService.getVaultState("usdc") as Promise<VaultState>,
      ]);

      const next: VaultPositions = {};
      const xlmShares = balance.stxlm || "0";
      const usdcShares = balance.stusdc || "0";
      if (!new BigNumber(xlmShares).isZero()) {
        next.xlm = {
          shares: xlmShares,
          underlying: computeUnderlying(xlmShares, xlmState.pricePerShare),
          pricePerShare: xlmState.pricePerShare,
          apyBps: xlmState.poolApyBps,
        };
      }
      if (!new BigNumber(usdcShares).isZero()) {
        next.usdc = {
          shares: usdcShares,
          underlying: computeUnderlying(usdcShares, usdcState.pricePerShare),
          pricePerShare: usdcState.pricePerShare,
          apyBps: usdcState.poolApyBps,
        };
      }
      setPositions(next);
    } catch (e) {
      // Treat backend unavailability as "no vault data" rather than
      // surfacing an error — the Yield Hub tab is the right place to
      // surface Baku status, not the Tokens list.
      setError(e instanceof Error ? e.message : String(e));
      setPositions({});
    } finally {
      setIsReady(true);
    }
  }, [publicKey, isTestnet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { positions, isReady, error, refresh };
};
