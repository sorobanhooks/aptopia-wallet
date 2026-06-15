// swapPreflight.ts
import BigNumber from "bignumber.js";
import { SwapSymbol } from "api/bakuSwapService";
import {
  ACCOUNT_BASE_MIN_XLM,
  FEE_BUFFER_XLM,
  PER_ENTRY_RESERVE_XLM,
  SWAP_USDC_ISSUER,
} from "./swapAssets";

export type SwapDirection = "xlm_to_usdc" | "usdc_to_xlm";

/** Minimal account view the copilot needs to diagnose a swap. All amounts are
 *  human units (matching Horizon balances and the parsed `amountIn`). */
export interface AccountState {
  funded: boolean;
  nativeXlm: string;
  usdc: { hasTrustline: boolean; balance: string };
}

export type Blocker =
  | { kind: "unfunded" }
  | { kind: "missing_usdc_trustline"; issuer: string }
  | { kind: "insufficient_xlm"; have: string; need: string; shortfall: string }
  | { kind: "insufficient_usdc"; have: string; need: string; shortfall: string };

export type PreflightResult =
  | { status: "ready" }
  | { status: "blocked"; blockers: Blocker[] };

/** The parsed swap carried across remediation steps so we can auto-continue. */
export interface PendingSwap {
  direction: SwapDirection;
  amountIn: string; // human units
  tokenIn: SwapSymbol;
  tokenOut: SwapSymbol;
  slippageBps?: number;
}

// Remediation precedence. `unfunded` is handled by an early return; the rest are
// sorted so the most fundamental blocker is presented first (a funded-but-low
// account can't friendbot-top-up, so insufficient_xlm must lead a missing
// trustline — adding the trustline would fail without the reserve).
const ORDER = ["insufficient_xlm", "insufficient_usdc", "missing_usdc_trustline"];

export function preflightSwap(params: {
  direction: SwapDirection;
  amountIn: string;
  account: AccountState;
}): PreflightResult {
  const { direction, amountIn, account } = params;

  // An account must exist before it can hold balances or trustlines. Fund first,
  // then re-preflight reveals any remaining blockers.
  if (!account.funded) {
    return { status: "blocked", blockers: [{ kind: "unfunded" }] };
  }

  const blockers: Blocker[] = [];
  const amt = new BigNumber(amountIn);
  const xlm = new BigNumber(account.nativeXlm);

  if (direction === "xlm_to_usdc") {
    const needsTrustline = !account.usdc.hasTrustline;
    if (needsTrustline) {
      blockers.push({ kind: "missing_usdc_trustline", issuer: SWAP_USDC_ISSUER });
    }
    const need = amt
      .plus(FEE_BUFFER_XLM)
      .plus(ACCOUNT_BASE_MIN_XLM)
      .plus(needsTrustline ? PER_ENTRY_RESERVE_XLM : 0);
    if (xlm.lt(need)) {
      blockers.push({
        kind: "insufficient_xlm",
        have: xlm.toString(),
        need: need.toString(),
        shortfall: need.minus(xlm).toString(),
      });
    }
  } else {
    const usdc = new BigNumber(account.usdc.balance);
    if (usdc.lt(amt)) {
      blockers.push({
        kind: "insufficient_usdc",
        have: usdc.toString(),
        need: amt.toString(),
        shortfall: amt.minus(usdc).toString(),
      });
    }
    const needXlm = new BigNumber(FEE_BUFFER_XLM).plus(ACCOUNT_BASE_MIN_XLM);
    if (xlm.lt(needXlm)) {
      blockers.push({
        kind: "insufficient_xlm",
        have: xlm.toString(),
        need: needXlm.toString(),
        shortfall: needXlm.minus(xlm).toString(),
      });
    }
  }

  if (blockers.length === 0) return { status: "ready" };
  blockers.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return { status: "blocked", blockers };
}
