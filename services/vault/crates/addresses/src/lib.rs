//! Single source of truth for Baku contract addresses.
//!
//! Consumed by deploy scripts, integration tests, and the HTTP API (via a
//! mirrored `addresses.ts`). Contracts themselves do NOT hardcode addresses;
//! they receive their dependencies as constructor args at instantiation.
//!
//! `Network::Testnet` is the demo target. Mainnet entries are placeholders
//! until the project goes through audit and SCF submission.

#![no_std]

/// Network we are addressing. Mirrored as a TypeScript enum in `api/src/addresses.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Testnet,
    Mainnet,
}

/// All contract / asset addresses for one network.
#[derive(Debug, Clone, Copy)]
pub struct NetworkAddresses {
    /// Native XLM Stellar Asset Contract (SAC).
    pub xlm_sac: &'static str,
    /// Blend's testnet USDC SAC (NOT Circle's). The Blend lending pool's USDC
    /// reserve recognises this token; vault-usdc + blend-strategy-usdc share it.
    pub usdc_sac: &'static str,
    /// Circle's testnet USDC SAC. Distinct from `usdc_sac`. The Soroswap
    /// strategy pairs XLM ↔ Circle USDC (the deep XLM/USDC pool on testnet
    /// uses Circle's token, not Blend's).
    pub circle_usdc_sac: &'static str,
    /// Blend lending pool — single-asset XLM lending.
    pub blend_pool_xlm: &'static str,
    /// Blend lending pool — single-asset USDC lending.
    pub blend_pool_usdc: &'static str,
    /// BLND reward token (claim destination).
    pub blnd_token: &'static str,
    /// Soroswap AMM pair — XLM ↔ Circle USDC.
    pub soroswap_pool_xlm_circle_usdc: &'static str,
    /// Soroswap V2 Router (for swap + add/remove liquidity calls).
    pub soroswap_router: &'static str,
    /// Deployed Baku contracts (filled in post-deploy).
    pub vault_xlm: &'static str,
    pub vault_usdc: &'static str,
    pub blend_strategy_xlm: &'static str,
    pub blend_strategy_usdc: &'static str,
    /// Soroswap LP strategy registered on vault-xlm. Pairs XLM with Circle USDC.
    pub soroswap_strategy_xlm: &'static str,
    /// DeFindex adapter strategy registered on vault-usdc as a second
    /// protocol alongside BlendStrategy USDC. Relays to DeFindex's testnet
    /// Blend-USDC strategy contract (paltalabs reference deployment).
    pub defindex_strategy_usdc: &'static str,
}

/// Convenience accessor.
pub const fn for_network(net: Network) -> NetworkAddresses {
    match net {
        Network::Testnet => TESTNET,
        Network::Mainnet => MAINNET,
    }
}

// ============================================================================
// TESTNET
// ============================================================================
//
// The asset SACs are deterministic per Stellar network. The protocol pool
// addresses come from Blend Capital and Soroswap docs. The vault / strategy
// addresses are filled in post-deploy (the deploy script writes them back here
// as part of the deployment record). VERIFY each address against current docs
// during the pre-hackathon spike — testnet addresses can change.

pub const TESTNET: NetworkAddresses = NetworkAddresses {
    // Native XLM SAC on testnet. Deterministic; verify with
    // `stellar contract asset id --asset native --network testnet`.
    xlm_sac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",

    // Blend's testnet USDC token. Used by vault-usdc + blend-strategy-usdc.
    // Source: github.com/blend-capital/blend-utils testnet.contracts.json (ids.USDC).
    usdc_sac: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",

    // Circle's testnet USDC SAC, derived from issuer
    //   USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
    // via `stellar contract id asset --asset USDC:<issuer> --network testnet`.
    // Used by the Soroswap LP strategy as the paired asset to XLM. NOT
    // interchangeable with `usdc_sac` (Blend's pool would reject this token).
    circle_usdc_sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",

    // Blend V2 uses a single lending pool per market with multiple reserves
    // (XLM, USDC, wETH, wBTC). Both pool-* fields therefore point at the same
    // `TestnetV2` pool — the per-asset distinction is just sugar for callers,
    // who additionally select the reserve via the asset address in submit().
    // Source: ids.TestnetV2.
    blend_pool_xlm: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
    blend_pool_usdc: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
    // Source: ids.BLND.
    blnd_token: "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF",

    // Pinned via scripts/soroswap-spike.sh --probe (2026-05-27) — verified
    // live by hand against the factory + router. Pool has ~$950k notional
    // depth, so demo deposits up to a few hundred USDC see sub-1% slippage.
    // Source: github.com/soroswap/core public/testnet.contracts.json (router)
    // + factory.get_pair(XLM_SAC, CIRCLE_USDC_SAC) (pair).
    soroswap_pool_xlm_circle_usdc: "CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS",
    soroswap_router: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",

    // Filled in post-deploy. See scripts/deployed.testnet.env for the live
    // deployment record. Last refresh: 2026-05-27 —
    // scripts/deploy-vault-xlm-v2.sh stood up vault-xlm v2 with rebalance()
    // and registered MockStrategy + BlendStrategy + SoroswapStrategy.
    //
    // CANONICAL vault-xlm = v2 CCY337… (this entry). On-chain reconcile
    // 2026-06-02: v2 holds ~1,020.4 XLM (total_assets 10204308505 stroops),
    // active = BlendStrategy CAGIMEB3…; registry = [Mock CCPRW7VC,
    // Blend-v0-dead CCQOTUKV, Soroswap-v0-dead CASQ54NU, Blend CAGIMEB3
    // (active), Soroswap CA4SKYV4]. The two *-v0 entries revert on deposit
    // (Auth/InvalidAction) and must never be set active.
    //
    // Legacy vault-xlm v1 `CCDEEXUU…OLD` (no rebalance) still holds
    // ~103.7 XLM (active strategy CBBUWT5E…) and is what `main`/the deployed
    // Baku API still point at until PR #6 merges. v1 is NOT canonical;
    // bkuXLM holders on v1 redeem from CCDEEXUU directly.
    vault_xlm: "CCY337D4WZ6OECCTQMWIMWT2CHBC73YY5JFRKBJ665O654KMUG3CP7YH",
    vault_usdc: "CDEOKPUFZT7XL5XITZWUTVD2VBU2NDEVA5EL7XXLMKP6INML4EHIEXNL",
    // BlendStrategy with authorize_as_current_contract auth fix (V2). The
    // earlier registered-on-v2 address (CCQOTUKV...VNYO) is a registry-dead
    // entry — it lacks the pre-auth for the SAC.transfer sub-invocation that
    // pool.submit triggers. The fixed version below is the active strategy.
    blend_strategy_xlm: "CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ",
    blend_strategy_usdc: "CDVPZOJTAP5X2XLRYWSLFCRKE5KNV4ZMPWB6NPSGWWT3YKSTQTM5YFSG",
    // SoroswapStrategy with the same auth fix + swap-and-hold simplification
    // (no add_liquidity; the strategy holds (asset, paired) directly and
    // current_value simulates a full exit via quote_amount_out). The earlier
    // registered-on-v2 address (CASQ54NU...DMKBK) is a registry-dead entry.
    soroswap_strategy_xlm: "CA4SKYV4O34KJA7TEA36GRDZJK3OZ2FN6QON4QDRA27V7RMPLJTGQHOS",
    // DeFindex adapter on vault-usdc. Registered (not active) as a second
    // protocol candidate; rotation is an operator decision via
    // vault.rebalance. Internally relays to paltalabs/defindex's testnet
    // Blend-USDC strategy contract
    //   CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY
    // (see DEFINDEX_REF_BLEND_USDC in scripts/deployed.testnet.env).
    // Deployed 2026-05-28 via scripts/deploy-defindex-strategy.sh.
    defindex_strategy_usdc: "CDXUHZ2FHLEV6G5YRUYNWKXMNGJUSHELYLQ2LOZRCGTJ6ZFMC2Z2YEAY",
};

// ============================================================================
// MAINNET — placeholders until audit + SCF submission complete.
// ============================================================================

pub const MAINNET: NetworkAddresses = NetworkAddresses {
    xlm_sac: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    usdc_sac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    circle_usdc_sac: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    blend_pool_xlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    blend_pool_usdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    blnd_token: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    soroswap_pool_xlm_circle_usdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    soroswap_router: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    vault_xlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    vault_usdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    blend_strategy_xlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    blend_strategy_usdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    soroswap_strategy_xlm: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
    defindex_strategy_usdc: "PLACEHOLDER_MAINNET_NOT_DEPLOYED",
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn testnet_addresses_are_non_empty() {
        let a = for_network(Network::Testnet);
        assert!(!a.xlm_sac.is_empty());
        assert!(!a.usdc_sac.is_empty());
    }

    #[test]
    fn for_network_dispatches_correctly() {
        assert_eq!(for_network(Network::Testnet).xlm_sac, TESTNET.xlm_sac);
        assert_eq!(for_network(Network::Mainnet).xlm_sac, MAINNET.xlm_sac);
    }
}
