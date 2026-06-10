// Mirror of crates/addresses/src/lib.rs.
//
// Kept manually in sync — the deploy script writes
// scripts/deployed.testnet.env, the human is responsible for promoting
// addresses here AND into the Rust addresses module. Keeping the duplicate
// rather than auto-syncing is intentional: addresses are an auditable surface
// and we want every change to land in a reviewable commit.

export type Network = "testnet" | "mainnet";

export interface NetworkAddresses {
  /** Native XLM Stellar Asset Contract (SAC). Deterministic per network. */
  xlmSac: string;
  /** Blend's testnet USDC SAC (NOT Circle's). Used by vault-usdc + blend-strategy-usdc. */
  usdcSac: string;
  /**
   * Circle's testnet USDC SAC. Distinct from `usdcSac`. The Soroswap strategy
   * pairs XLM with this token (Circle's USDC pool has ~$950k testnet depth;
   * Blend's testnet USDC pool has only ~$4).
   */
  circleUsdcSac: string;
  /** Blend lending pool — single-asset XLM. */
  blendPoolXlm: string;
  /** Blend lending pool — single-asset USDC. */
  blendPoolUsdc: string;
  /** BLND reward token (claim destination). */
  blndToken: string;
  /** Soroswap AMM pair — XLM ↔ Circle USDC. */
  soroswapPoolXlmCircleUsdc: string;
  /** Soroswap V2 router (for swap + add/remove liquidity calls). */
  soroswapRouter: string;
  /** Deployed Baku contracts. PLACEHOLDER until scripts/deploy-testnet.sh runs. */
  vaultXlm: string;
  vaultUsdc: string;
  blendStrategyXlm: string;
  blendStrategyUsdc: string;
  /** Soroswap LP strategy registered on vault-xlm (pairs XLM with Circle USDC). */
  soroswapStrategyXlm: string;
  /**
   * Weighted meta-allocator that may be a vault's active strategy. Empty on the
   * canonical vault (active = plain Blend); set (via env) for the multi-tx demo
   * vault so the API can label it and render the per-child 30/40/30 breakdown.
   */
  allocatorXlm: string;
  /**
   * DeFindex adapter strategy registered on vault-usdc as a second protocol
   * alongside BlendStrategy USDC. Relays to paltalabs/defindex's testnet
   * Blend-USDC strategy contract.
   */
  defindexStrategyUsdc: string;
}

export const TESTNET: NetworkAddresses = {
  // Native XLM SAC — verify with: stellar contract id asset --asset native --network testnet
  xlmSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  // Blend's testnet USDC (NOT Circle's). Source: blend-utils testnet.contracts.json ids.USDC.
  usdcSac: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
  // Circle's testnet USDC SAC — issuer GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5.
  circleUsdcSac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  // Blend V2 testnet — single pool, multiple reserves. Both XLM and USDC
  // reserves live on the TestnetV2 pool. Source: ids.TestnetV2.
  blendPoolXlm: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
  blendPoolUsdc: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
  blndToken: "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF",
  // Pinned via scripts/soroswap-spike.sh --probe + --swap-test (2026-05-27).
  // Pair has ~$950k testnet depth — demo deposits up to a few hundred USDC
  // see sub-1% slippage. Source: factory.get_pair(XLM_SAC, CIRCLE_USDC_SAC).
  soroswapPoolXlmCircleUsdc: "CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS",
  soroswapRouter: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",

  // Live deployments — see scripts/deployed.testnet.env. Last refresh:
  // 2026-05-27 — scripts/deploy-vault-xlm-v2.sh stood up vault-xlm v2 with
  // vault.rebalance() and registered MockStrategy + BlendStrategy +
  // SoroswapStrategy.
  //
  // CANONICAL vault-xlm = v2 CCY337… (this entry). On-chain reconcile
  // 2026-06-02: v2 holds ~1,020.4 XLM (total_assets 10204308505 stroops),
  // active = BlendStrategy CAGIMEB3…; registry = [Mock CCPRW7VC,
  // Blend-v0-dead CCQOTUKV, Soroswap-v0-dead CASQ54NU, Blend CAGIMEB3
  // (active), Soroswap CA4SKYV4]. The two *-v0 entries revert on deposit
  // (Auth/InvalidAction) and must never be set active — kept in registry only.
  //
  // Legacy vault-xlm v1 (no rebalance) CCDEEXUU…OLD still holds ~103.7 XLM
  // (active strategy CBBUWT5E…) and is what `main` / the deployed Baku API
  // still point at until PR #6 merges. v1 is NOT canonical; bkuXLM holders
  // on v1 redeem from CCDEEXUU directly.
  vaultXlm: "CCY337D4WZ6OECCTQMWIMWT2CHBC73YY5JFRKBJ665O654KMUG3CP7YH",
  vaultUsdc: "CDEOKPUFZT7XL5XITZWUTVD2VBU2NDEVA5EL7XXLMKP6INML4EHIEXNL",
  // BlendStrategy V2 — includes authorize_as_current_contract pre-auth for
  // the SAC.transfer sub-invocation. End-to-end verified 2026-05-27 via
  // deposit + rebalance to/from Soroswap + redeem round-trip.
  blendStrategyXlm: "CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ",
  blendStrategyUsdc: "CDVPZOJTAP5X2XLRYWSLFCRKE5KNV4ZMPWB6NPSGWWT3YKSTQTM5YFSG",
  // SoroswapStrategy V2 — auth fix + swap-and-hold simplification. The
  // strategy holds (asset, paired) directly and exits via Router swap.
  soroswapStrategyXlm: "CA4SKYV4O34KJA7TEA36GRDZJK3OZ2FN6QON4QDRA27V7RMPLJTGQHOS",
  // Empty on the canonical vault (active = Blend). The multi-tx demo vault sets
  // this via BAKU_TESTNET_ALLOCATOR_XLM (see api/.env.demo).
  allocatorXlm: "",
  // DeFindex adapter on vault-usdc — registered (not active) as the second
  // protocol candidate. Relays to paltalabs/defindex testnet Blend-USDC
  // strategy contract CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY
  // (DEFINDEX_REF_BLEND_USDC in deployed.testnet.env). Deployed 2026-05-28
  // via scripts/deploy-defindex-strategy.sh.
  defindexStrategyUsdc: "CDXUHZ2FHLEV6G5YRUYNWKXMNGJUSHELYLQ2LOZRCGTJ6ZFMC2Z2YEAY",
};

export const MAINNET: NetworkAddresses = {
  xlmSac: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  usdcSac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  circleUsdcSac: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  blendPoolXlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  blendPoolUsdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  blndToken: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  soroswapPoolXlmCircleUsdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  soroswapRouter: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  vaultXlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  vaultUsdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  blendStrategyXlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  blendStrategyUsdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  soroswapStrategyXlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  allocatorXlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
  defindexStrategyUsdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
};

/**
 * Optional runtime overrides so the API can point at a non-canonical vault
 * (e.g. the multi-tx buffer-redemption demo vault) WITHOUT editing the audited
 * canonical addresses above. Production leaves these env vars unset and gets the
 * defaults. Set e.g. `BAKU_TESTNET_VAULT_XLM=C...` (see api/.env.demo) to repoint.
 * Only testnet is overridable.
 */
function applyEnvOverrides(net: Network, base: NetworkAddresses): NetworkAddresses {
  if (net !== "testnet") return base;
  const env = (k: string): string | undefined =>
    typeof process !== "undefined" ? process.env?.[k] : undefined;
  return {
    ...base,
    vaultXlm: env("BAKU_TESTNET_VAULT_XLM") ?? base.vaultXlm,
    vaultUsdc: env("BAKU_TESTNET_VAULT_USDC") ?? base.vaultUsdc,
    blendStrategyXlm: env("BAKU_TESTNET_BLEND_STRATEGY_XLM") ?? base.blendStrategyXlm,
    soroswapStrategyXlm:
      env("BAKU_TESTNET_SOROSWAP_STRATEGY_XLM") ?? base.soroswapStrategyXlm,
    allocatorXlm: env("BAKU_TESTNET_ALLOCATOR_XLM") ?? base.allocatorXlm,
  };
}

export function forNetwork(net: Network): NetworkAddresses {
  const base = net === "testnet" ? TESTNET : MAINNET;
  return applyEnvOverrides(net, base);
}

/** Resolve a vault contract by short asset id used in the URL (`xlm` | `usdc`). */
export function vaultFor(net: Network, asset: "xlm" | "usdc"): string {
  const a = forNetwork(net);
  return asset === "xlm" ? a.vaultXlm : a.vaultUsdc;
}

/** Resolve the underlying SAC for a vault's asset. */
export function underlyingSacFor(net: Network, asset: "xlm" | "usdc"): string {
  const a = forNetwork(net);
  return asset === "xlm" ? a.xlmSac : a.usdcSac;
}
