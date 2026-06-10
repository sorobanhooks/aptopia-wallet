// usePortfolioTotal — computes a USD-denominated portfolio total for the
// Account header. Includes both wallet balances and Yield Hub vault positions.
//
// Price source (reused, not new):
//   getTokenPrices(["XLM"]) from @shared/api/internal — the same Stellar
//   Wallet SDK path used by the mainnet token list. USDC is pegged at $1.
//
// Refresh: 60-second interval + window-focus event.
//
// Graceful degradation: if price fetch fails the total is null and the
// caller hides the display element rather than crashing.

import { useCallback, useEffect, useRef, useState } from "react";
import BigNumber from "bignumber.js";

import { getTokenPrices } from "@shared/api/internal";
import { AssetType } from "@shared/api/types/account-balance";
import { VaultPositions } from "./useUnifiedBalances";

/** Base units per whole token (7 decimals, Stellar/Baku standard). */
const ONE_TOKEN = new BigNumber("10000000");

const REFRESH_INTERVAL_MS = 60_000;

export interface UsePortfolioTotalResult {
  /**
   * Formatted total string ready for display (e.g. "$1,234.56").
   * null when a price fetch has failed or data isn't available yet.
   */
  formattedTotal: string | null;
  /** Raw numeric total in USD (may be used for accessibility). */
  totalUsd: BigNumber | null;
}

interface UsePortfolioTotalArgs {
  /** Raw Horizon/Soroban balance array from useGetAccountData. */
  balances: AssetType[] | null | undefined;
  /** Vault positions from useUnifiedBalances. */
  vaultPositions: VaultPositions;
  /**
   * Whether to attempt price fetch + total computation.
   * Pass false (e.g. on mainnet) when the existing tokenPrices-based total
   * should take precedence, or when the account data isn't resolved yet.
   */
  enabled: boolean;
}

/** Extract the XLM spot price from a getTokenPrices call result. */
const extractXlmPrice = (
  prices: Awaited<ReturnType<typeof getTokenPrices>>,
): BigNumber | null => {
  // getTokenPrices keys native XLM as "XLM" or "native"
  for (const key of ["XLM", "native", "XLM:"]) {
    if (prices[key]?.currentPrice) {
      const n = new BigNumber(prices[key]!.currentPrice);
      if (n.isFinite() && n.isPositive()) return n;
    }
  }
  // Try any key whose price is non-null (SDK may return "XLM:undefined")
  for (const [k, v] of Object.entries(prices)) {
    if ((k.startsWith("XLM") || k === "native") && v?.currentPrice) {
      const n = new BigNumber(v.currentPrice);
      if (n.isFinite() && n.isPositive()) return n;
    }
  }
  return null;
};

/**
 * Sum wallet balances: XLM × xlmPrice + USDC × 1.
 * Other assets are not priced here (no price feed for testnet custom tokens).
 */
const computeWalletUsd = (
  balances: AssetType[],
  xlmPrice: BigNumber,
): BigNumber => {
  let total = new BigNumber(0);
  for (const b of balances) {
    if (!("token" in b)) continue; // LP share — skip
    const code = "code" in b.token ? b.token.code : "";
    const isNative = "type" in b.token && b.token.type === "native";

    if (isNative || code === "XLM") {
      total = total.plus(new BigNumber(b.total).multipliedBy(xlmPrice));
    } else if (code === "USDC") {
      // USDC assumed $1 (stablecoin peg)
      total = total.plus(new BigNumber(b.total));
    }
  }
  return total;
};

/**
 * Sum vault positions.
 * - XLM vault: underlying (in base units) × xlmPrice / 1e7
 * - USDC vault: underlying (in base units) × 1 / 1e7
 */
const computeVaultUsd = (
  vaultPositions: VaultPositions,
  xlmPrice: BigNumber,
): BigNumber => {
  let total = new BigNumber(0);

  if (vaultPositions.xlm) {
    const underlyingWhole = new BigNumber(vaultPositions.xlm.underlying).div(
      ONE_TOKEN,
    );
    total = total.plus(underlyingWhole.multipliedBy(xlmPrice));
  }
  if (vaultPositions.usdc) {
    const underlyingWhole = new BigNumber(vaultPositions.usdc.underlying).div(
      ONE_TOKEN,
    );
    total = total.plus(underlyingWhole); // USDC = $1
  }
  return total;
};

const formatUsd = (value: BigNumber): string => {
  const num = value.toNumber();
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
};

export const usePortfolioTotal = ({
  balances,
  vaultPositions,
  enabled,
}: UsePortfolioTotalArgs): UsePortfolioTotalResult => {
  const [formattedTotal, setFormattedTotal] = useState<string | null>(null);
  const [totalUsd, setTotalUsd] = useState<BigNumber | null>(null);
  // Stable ref to the latest args so interval/focus handlers see current data
  const argsRef = useRef({ balances, vaultPositions, enabled });

  const compute = useCallback(async () => {
    const { balances: b, vaultPositions: vp, enabled: en } = argsRef.current;
    if (!en || !b) {
      return;
    }

    try {
      // Reuse the existing wallet SDK price path (same as the mainnet token list).
      const prices = await getTokenPrices(["XLM"]);
      const xlmPrice = extractXlmPrice(prices);

      if (!xlmPrice) {
        // Price fetch returned no usable XLM price — degrade gracefully.
        setFormattedTotal(null);
        setTotalUsd(null);
        return;
      }

      const walletUsd = computeWalletUsd(b, xlmPrice);
      const vaultUsd = computeVaultUsd(vp, xlmPrice);
      const total = walletUsd.plus(vaultUsd);

      setTotalUsd(total);
      setFormattedTotal(formatUsd(total));
    } catch {
      // Network or SDK error — hide the total rather than crash.
      setFormattedTotal(null);
      setTotalUsd(null);
    }
  }, []); // stable; reads from argsRef

  // Update argsRef and trigger compute in a single effect so the ref is always
  // current before compute() runs (avoids stale-args race from two separate effects).
  useEffect(() => {
    argsRef.current = { balances, vaultPositions, enabled };
    if (enabled) {
      compute();
    }
  }, [enabled, balances, vaultPositions, compute]);

  // 60-second refresh interval.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      compute();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, compute]);

  // On-focus refresh — matches the YieldHub / Dashboard pattern.
  useEffect(() => {
    if (!enabled) return;
    const handleFocus = () => compute();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [enabled, compute]);

  return { formattedTotal, totalUsd };
};
