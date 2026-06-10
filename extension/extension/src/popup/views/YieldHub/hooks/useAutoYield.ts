// useAutoYield — owns the auto-deploy toggle state and orchestrates the
// background sweep loop that deposits idle wallet balance into the vault.
//
// Mental model: while the Yield Hub tab is mounted and auto-yield is ON for
// an asset, every AUTO_YIELD_TICK_MS the hook checks
//   surplus = wallet_balance - reserve_buffer
// and, if surplus is meaningful (>= AUTO_YIELD_MIN_DEPOSIT) and we are past
// the cooldown window, fires a single deposit for that surplus through the
// caller-provided `onSweep` function. The hook never owns signing /
// submission — it just decides "when" and "how much".
//
// Reserve buffers (whole tokens, base unit / 1e7):
//   XLM  : 5    — base reserve + headroom for fees + a few subentries
//   USDC : 0    — Stellar accounts hold USDC without per-asset reserve
//
// Persistence: the toggle and lastFired timestamp live in localStorage,
// keyed by network + publicKey + asset so different accounts / networks
// don't bleed into each other.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BigNumber from "bignumber.js";

import { VaultAsset } from "api/yieldHubTypes";

/** Base units per whole token across Baku (7 decimals). */
const ONE_TOKEN = new BigNumber("10000000");

/** Reserve buffer (whole tokens) per asset — surplus = wallet - buffer. */
const RESERVE_BUFFER: Record<VaultAsset, BigNumber> = {
  xlm: new BigNumber("5"),
  usdc: new BigNumber("0"),
};

/** Surplus floor (whole tokens). Skip dust to avoid wasted gas + RPC noise. */
const AUTO_YIELD_MIN_DEPOSIT = new BigNumber("1");

/** Tick cadence. Run the surplus check this often while the hub tab is mounted. */
const AUTO_YIELD_TICK_MS = 60_000;

/** Cooldown after a successful sweep before another fire is allowed. */
const AUTO_YIELD_COOLDOWN_MS = 5 * 60_000;

export type AutoYieldStatus =
  | "off"
  | "idle"
  | "ready"
  | "sweeping"
  | "cooldown"
  | "error";

export interface AutoYieldEntry {
  enabled: boolean;
  status: AutoYieldStatus;
  /** Surplus in whole tokens (BigNumber.toString()). "0" if none. */
  surplus: string;
  /** Reserve buffer this asset is keeping back (whole tokens). */
  reserveBuffer: string;
  /** Timestamp of last attempted sweep (ms epoch). 0 = never. */
  lastFiredAt: number;
  /** Last sweep error message, if any. */
  lastError: string | null;
}

export type AutoYieldState = Record<VaultAsset, AutoYieldEntry>;

const STORAGE_PREFIX = "aptopia:autoYield";

const enabledKey = (network: string, pk: string, asset: VaultAsset) =>
  `${STORAGE_PREFIX}:enabled:${network}:${pk}:${asset}`;
const lastFiredKey = (network: string, pk: string, asset: VaultAsset) =>
  `${STORAGE_PREFIX}:lastFired:${network}:${pk}:${asset}`;

const readEnabled = (network: string, pk: string, asset: VaultAsset): boolean => {
  if (!pk) return false;
  return localStorage.getItem(enabledKey(network, pk, asset)) === "1";
};

const readLastFired = (network: string, pk: string, asset: VaultAsset): number => {
  if (!pk) return 0;
  const v = localStorage.getItem(lastFiredKey(network, pk, asset));
  return v ? Number(v) || 0 : 0;
};

const writeEnabled = (
  network: string,
  pk: string,
  asset: VaultAsset,
  on: boolean,
) => {
  if (!pk) return;
  if (on) localStorage.setItem(enabledKey(network, pk, asset), "1");
  else localStorage.removeItem(enabledKey(network, pk, asset));
};

const writeLastFired = (
  network: string,
  pk: string,
  asset: VaultAsset,
  ts: number,
) => {
  if (!pk) return;
  localStorage.setItem(lastFiredKey(network, pk, asset), String(ts));
};

interface UseAutoYieldArgs {
  publicKey: string | undefined;
  network: string;
  /**
   * Current wallet balances in base units (i128 decimal strings, 7 decimals).
   * Pass `null` while the popup is loading — the hook treats null as "we
   * don't know the balance yet" and skips sweeping.
   */
  balances: { xlm: string; usdc: string } | null;
  /**
   * Caller-supplied sweep performer. Receives base-unit i128 decimal string
   * to deposit and resolves on either tx settlement or build failure. Any
   * thrown error is captured as `lastError` on the asset's entry.
   */
  onSweep: (asset: VaultAsset, baseUnits: string) => Promise<void>;
}

export interface UseAutoYieldResult {
  state: AutoYieldState;
  setEnabled: (asset: VaultAsset, on: boolean) => void;
  /** Force a sweep attempt now, regardless of cooldown (manual trigger). */
  sweepNow: (asset: VaultAsset) => Promise<void>;
}

const computeEntry = (
  asset: VaultAsset,
  enabled: boolean,
  walletBase: string | undefined,
  lastFiredAt: number,
  isSweeping: boolean,
  lastError: string | null,
): AutoYieldEntry => {
  const buffer = RESERVE_BUFFER[asset];
  const wallet = walletBase
    ? new BigNumber(walletBase).div(ONE_TOKEN)
    : new BigNumber(0);
  const surplus = wallet.minus(buffer);
  const hasSurplus = surplus.gte(AUTO_YIELD_MIN_DEPOSIT);
  const cooldownLeft = lastFiredAt
    ? AUTO_YIELD_COOLDOWN_MS - (Date.now() - lastFiredAt)
    : 0;
  const inCooldown = cooldownLeft > 0;

  let status: AutoYieldStatus;
  if (!enabled) status = "off";
  else if (isSweeping) status = "sweeping";
  else if (lastError) status = "error";
  else if (inCooldown) status = "cooldown";
  else if (hasSurplus) status = "ready";
  else status = "idle";

  return {
    enabled,
    status,
    surplus: surplus.isPositive() ? surplus.toFixed() : "0",
    reserveBuffer: buffer.toFixed(),
    lastFiredAt,
    lastError,
  };
};

export const useAutoYield = ({
  publicKey,
  network,
  balances,
  onSweep,
}: UseAutoYieldArgs): UseAutoYieldResult => {
  const [enabledMap, setEnabledMap] = useState<Record<VaultAsset, boolean>>({
    xlm: false,
    usdc: false,
  });
  const [lastFired, setLastFired] = useState<Record<VaultAsset, number>>({
    xlm: 0,
    usdc: 0,
  });
  const [sweeping, setSweeping] = useState<Record<VaultAsset, boolean>>({
    xlm: false,
    usdc: false,
  });
  const [errors, setErrors] = useState<Record<VaultAsset, string | null>>({
    xlm: null,
    usdc: null,
  });

  // Hydrate from localStorage on publicKey/network change. We keep this in a
  // ref-guarded effect so toggling values from the UI doesn't trigger a
  // re-hydration loop.
  const hydratedFor = useRef<string>("");
  useEffect(() => {
    const sig = `${network}:${publicKey || ""}`;
    if (hydratedFor.current === sig) return;
    hydratedFor.current = sig;
    if (!publicKey) {
      setEnabledMap({ xlm: false, usdc: false });
      setLastFired({ xlm: 0, usdc: 0 });
      return;
    }
    setEnabledMap({
      xlm: readEnabled(network, publicKey, "xlm"),
      usdc: readEnabled(network, publicKey, "usdc"),
    });
    setLastFired({
      xlm: readLastFired(network, publicKey, "xlm"),
      usdc: readLastFired(network, publicKey, "usdc"),
    });
    setErrors({ xlm: null, usdc: null });
  }, [publicKey, network]);

  const setEnabled = useCallback(
    (asset: VaultAsset, on: boolean) => {
      if (!publicKey) return;
      writeEnabled(network, publicKey, asset, on);
      setEnabledMap((prev) => ({ ...prev, [asset]: on }));
      if (!on) {
        // Clearing the toggle also clears any sticky error from a past sweep.
        setErrors((prev) => ({ ...prev, [asset]: null }));
      }
    },
    [publicKey, network],
  );

  // Latest-args ref so the interval tick sees up-to-date values without
  // resetting the timer every time balances change.
  const argsRef = useRef({ enabledMap, lastFired, balances, onSweep });
  argsRef.current = { enabledMap, lastFired, balances, onSweep };

  const trySweep = useCallback(
    async (asset: VaultAsset, force: boolean) => {
      const { balances: b, onSweep: cb, lastFired: lf, enabledMap: em } =
        argsRef.current;
      if (!publicKey) return;
      if (!em[asset] && !force) return;
      if (sweeping[asset]) return;
      if (!b) return;

      const wallet = new BigNumber(b[asset]).div(ONE_TOKEN);
      const buffer = RESERVE_BUFFER[asset];
      const surplus = wallet.minus(buffer);
      if (surplus.lt(AUTO_YIELD_MIN_DEPOSIT)) return;

      if (!force) {
        const elapsed = Date.now() - lf[asset];
        if (elapsed < AUTO_YIELD_COOLDOWN_MS) return;
      }

      const baseUnits = surplus.multipliedBy(ONE_TOKEN).integerValue(BigNumber.ROUND_DOWN).toFixed(0);
      setSweeping((prev) => ({ ...prev, [asset]: true }));
      setErrors((prev) => ({ ...prev, [asset]: null }));
      try {
        await cb(asset, baseUnits);
        const ts = Date.now();
        writeLastFired(network, publicKey, asset, ts);
        setLastFired((prev) => ({ ...prev, [asset]: ts }));
      } catch (e) {
        setErrors((prev) => ({
          ...prev,
          [asset]: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setSweeping((prev) => ({ ...prev, [asset]: false }));
      }
    },
    [publicKey, network, sweeping],
  );

  // Polling loop. Only the cadence depends on hook-level state; the actual
  // decision logic lives in trySweep, which reads fresh args via the ref.
  useEffect(() => {
    if (!publicKey) return;
    const tick = () => {
      trySweep("xlm", false);
      trySweep("usdc", false);
    };
    tick(); // immediate check on mount
    const id = window.setInterval(tick, AUTO_YIELD_TICK_MS);
    return () => window.clearInterval(id);
  }, [publicKey, trySweep]);

  const state: AutoYieldState = useMemo(
    () => ({
      xlm: computeEntry(
        "xlm",
        enabledMap.xlm,
        balances?.xlm,
        lastFired.xlm,
        sweeping.xlm,
        errors.xlm,
      ),
      usdc: computeEntry(
        "usdc",
        enabledMap.usdc,
        balances?.usdc,
        lastFired.usdc,
        sweeping.usdc,
        errors.usdc,
      ),
    }),
    [enabledMap, balances, lastFired, sweeping, errors],
  );

  const sweepNow = useCallback(
    async (asset: VaultAsset) => {
      await trySweep(asset, true);
    },
    [trySweep],
  );

  return { state, setEnabled, sweepNow };
};
