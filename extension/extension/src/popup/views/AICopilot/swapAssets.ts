// swapAssets.ts
// Single source of truth for the copilot swap's assets + reserve math.
//
// The swap pays out CIRCLE's testnet USDC (Soroswap `tokenOut`), issuer
// GBBD47IF… — see vault/api/src/addresses.ts (`circleUsdcSac` / `swapTokenSacFor`).
// This is DISTINCT from the Blend vault USDC (issuer GATALTGT…). The trustline we
// add during remediation MUST target this issuer, or the user still can't receive
// the swap output.

export const SWAP_USDC_CODE = "USDC";
export const SWAP_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Canonical balance-map key Freighter uses for this trustline ("CODE:ISSUER"). */
export const SWAP_USDC_CANONICAL = `${SWAP_USDC_CODE}:${SWAP_USDC_ISSUER}`;

// Stellar reserve math: base reserve is 0.5 XLM per subentry.
/** Bare-account minimum balance (2 × base reserve). */
export const ACCOUNT_BASE_MIN_XLM = 1;
/** Added to the minimum balance per trustline/subentry. */
export const PER_ENTRY_RESERVE_XLM = 0.5;
/** Headroom for classic + Soroban fees (human XLM). */
export const FEE_BUFFER_XLM = 0.5;
