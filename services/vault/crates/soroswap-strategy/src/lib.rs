//! SoroswapStrategy — V1 LP adapter for Soroswap V2 pools.
//!
//! Provides real liquidity: on deposit it swaps ~half the asset to the paired
//! token, then calls `router.add_liquidity` and holds the pair's LP tokens,
//! earning the 0.30% trading fee that accrues into the pool reserves. On
//! withdraw it removes a pro-rata slice via `router.remove_liquidity` and swaps
//! the paired leg back, delivering a single asset to the vault.
//!
//! Auth: deposit pre-authorizes three sub-transfers (the swap leg + the two
//! add_liquidity transfers), withdraw pre-authorizes two (the LP-token burn +
//! the swap-back). Exact amounts are computed by replicating the router's
//! `quote` against POST-swap reserves (see `optimal_add_amounts`), so the
//! authorized amounts match what the router moves within the single atomic tx.
//!
//! `current_value` is a spot-reserve estimate of the position (idle + LP share,
//! paired side quoted to asset). It is panic-safe — pair reads use `try_`
//! variants and degrade to idle-asset-only on failure, so a wedged pool cannot
//! brick the allocator/vault (which treat an authoritative child's
//! current_value error as fatal). It is NOT manipulation-resistant — a TWAP /
//! oracle is the deferred V1→C hardening (see the design spec §9). Vault
//! `min_amount_out` is the actual withdrawal safety floor.

#![no_std]
#![allow(clippy::too_many_arguments)]

use baku_strategy_trait::{StrategyError, StrategyInterface};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, contracttype, token, vec, Address, Env, IntoVal,
    Symbol, Vec,
};

/// Soroswap V2 fee numerator/denominator. 0.30% fee → 997/1000 effective.
const SOROSWAP_FEE_NUM: i128 = 997;
const SOROSWAP_FEE_DEN: i128 = 1_000;
const BPS_DEN: i128 = 10_000;

/// Default slippage tolerance (1.00%) on swap legs. Admin-tunable via
/// `set_max_slippage_bps`. Soroswap's 0.30% protocol fee is separate.
const DEFAULT_MAX_SLIPPAGE_BPS: u32 = 100;

/// Deadline offset (seconds) added to the current ledger timestamp for the
/// Router's `deadline` parameter.
const DEADLINE_SECONDS: u64 = 60;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Vault,
    Asset,
    /// Soroswap pair contract for (asset, paired_asset).
    SoroswapPool,
    /// Soroswap router contract used for swaps.
    SoroswapRouter,
    /// The other side of the LP (e.g. Circle USDC when asset = XLM).
    PairedAsset,
    /// Admin-set APY estimate in basis points (informational; API surface).
    ApyBps,
    /// Admin-set slippage tolerance in basis points (applies to all swap legs).
    MaxSlippageBps,
}

// Hand-declared Soroswap Router interface — signatures verified against the
// deployed testnet router via `stellar contract info interface`. The router
// returns Result<_, CombinedRouterError>; the contractclient surfaces the Ok
// type on the panicking method and the full Result on the `try_` variant.
#[contractclient(name = "SoroswapRouterClient")]
pub trait SoroswapRouterInterface {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;

    #[allow(clippy::too_many_arguments)]
    fn add_liquidity(
        env: Env,
        token_a: Address,
        token_b: Address,
        amount_a_desired: i128,
        amount_b_desired: i128,
        amount_a_min: i128,
        amount_b_min: i128,
        to: Address,
        deadline: u64,
    ) -> (i128, i128, i128);

    fn remove_liquidity(
        env: Env,
        token_a: Address,
        token_b: Address,
        liquidity: i128,
        amount_a_min: i128,
        amount_b_min: i128,
        to: Address,
        deadline: u64,
    ) -> (i128, i128);
}

// Hand-declared Soroswap Pair interface. The pair IS the LP token (SEP-41), so
// balance/total_supply read the strategy's LP position.
#[contractclient(name = "SoroswapPairClient")]
pub trait SoroswapPairInterface {
    fn get_reserves(env: Env) -> (i128, i128);
    fn token_0(env: Env) -> Address;
    fn balance(env: Env, id: Address) -> i128;
    fn total_supply(env: Env) -> i128;
}

#[contract]
pub struct SoroswapStrategy;

/// Pre-authorize the TWO token transfers add_liquidity performs on the
/// strategy's behalf: `token_a.transfer(strategy, pair, amount_a)` and
/// `token_b.transfer(strategy, pair, amount_b)`. Amounts must be the EXACT
/// values the router will move (see optimal_add_amounts), or the auth tree
/// fails on a live network.
fn pre_auth_two_transfers(
    env: &Env,
    token_a: &Address,
    token_b: &Address,
    strategy: &Address,
    pair: &Address,
    amount_a: i128,
    amount_b: i128,
) {
    let entry = |token: &Address, amount: i128| {
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: vec![
                    env,
                    strategy.clone().into_val(env),
                    pair.clone().into_val(env),
                    amount.into_val(env),
                ],
            },
            sub_invocations: vec![env],
        })
    };
    env.authorize_as_current_contract(vec![
        env,
        entry(token_a, amount_a),
        entry(token_b, amount_b),
    ]);
}

#[contractimpl]
impl SoroswapStrategy {
    pub fn __constructor(
        env: Env,
        admin: Address,
        vault: Address,
        asset: Address,
        soroswap_pool: Address,
        soroswap_router: Address,
        paired_asset: Address,
        initial_apy_bps: u32,
    ) {
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Vault, &vault);
        storage.set(&DataKey::Asset, &asset);
        storage.set(&DataKey::SoroswapPool, &soroswap_pool);
        storage.set(&DataKey::SoroswapRouter, &soroswap_router);
        storage.set(&DataKey::PairedAsset, &paired_asset);
        storage.set(&DataKey::ApyBps, &initial_apy_bps);
        storage.set(&DataKey::MaxSlippageBps, &DEFAULT_MAX_SLIPPAGE_BPS);
    }

    pub fn set_vault(env: Env, admin: Address, new_vault: Address) -> Result<(), StrategyError> {
        require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Vault, &new_vault);
        Ok(())
    }

    pub fn set_max_slippage_bps(env: Env, admin: Address, bps: u32) -> Result<(), StrategyError> {
        require_admin(&env, &admin)?;
        if bps > 10_000 {
            // A slippage bps out of [0, 10_000] is a malformed argument, not an
            // APY error. There is no dedicated slippage variant in StrategyError;
            // `InvalidAmount` is the closest generic "bad input value" code and
            // is reused here. (Adding a bespoke variant would shift no existing
            // discriminant, but is unwarranted churn for a single call site.)
            return Err(StrategyError::InvalidAmount);
        }
        env.storage().instance().set(&DataKey::MaxSlippageBps, &bps);
        Ok(())
    }

    pub fn max_slippage_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxSlippageBps)
            .unwrap_or(DEFAULT_MAX_SLIPPAGE_BPS)
    }
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), StrategyError> {
    let stored: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(StrategyError::NotInitialized)?;
    if *caller != stored {
        return Err(StrategyError::AdminOnly);
    }
    caller.require_auth();
    Ok(())
}

fn assert_vault(env: &Env, caller: &Address) -> Result<(), StrategyError> {
    let vault: Address = env
        .storage()
        .instance()
        .get(&DataKey::Vault)
        .ok_or(StrategyError::NotInitialized)?;
    if *caller != vault {
        return Err(StrategyError::Unauthorized);
    }
    caller.require_auth();
    Ok(())
}

struct StrategyAddresses {
    asset: Address,
    paired: Address,
    pool: Address,
    router: Address,
}

fn load_addresses(env: &Env) -> Result<StrategyAddresses, StrategyError> {
    let storage = env.storage().instance();
    Ok(StrategyAddresses {
        asset: storage
            .get(&DataKey::Asset)
            .ok_or(StrategyError::NotInitialized)?,
        paired: storage
            .get(&DataKey::PairedAsset)
            .ok_or(StrategyError::NotInitialized)?,
        pool: storage
            .get(&DataKey::SoroswapPool)
            .ok_or(StrategyError::NotInitialized)?,
        router: storage
            .get(&DataKey::SoroswapRouter)
            .ok_or(StrategyError::NotInitialized)?,
    })
}

/// Apply slippage tolerance: returns `amount * (1 - bps/10_000)`, rounded down.
fn slippage_floor(amount: i128, max_slippage_bps: u32) -> i128 {
    if amount <= 0 {
        return 0;
    }
    let bps = max_slippage_bps as i128;
    let bps = if bps > BPS_DEN { BPS_DEN } else { bps };
    amount.saturating_mul(BPS_DEN - bps) / BPS_DEN
}

/// Soroswap V2 constant-product amount-out formula with 0.30% fee.
fn quote_amount_out(amount_in: i128, reserve_in: i128, reserve_out: i128) -> i128 {
    if amount_in <= 0 || reserve_in <= 0 || reserve_out <= 0 {
        return 0;
    }
    let amount_in_with_fee = amount_in.saturating_mul(SOROSWAP_FEE_NUM);
    let numerator = amount_in_with_fee.saturating_mul(reserve_out);
    let denominator = reserve_in
        .saturating_mul(SOROSWAP_FEE_DEN)
        .saturating_add(amount_in_with_fee);
    if denominator <= 0 {
        return 0;
    }
    numerator / denominator
}

/// Soroswap/Uniswap `quote`: proportional amount of token_b for token_a at the
/// current reserve ratio (NO fee — this is the pool ratio, used for liquidity
/// provision). `amount_b = amount_a * reserve_b / reserve_a`, integer floor.
fn ratio_quote(amount_a: i128, reserve_a: i128, reserve_b: i128) -> i128 {
    if amount_a <= 0 || reserve_a <= 0 || reserve_b <= 0 {
        return 0;
    }
    amount_a.saturating_mul(reserve_b) / reserve_a
}

/// Given the balances we hold (asset_bal, paired_bal) and the current reserves,
/// compute the exact (amount_a, amount_b) the router will consume in
/// add_liquidity. We replicate the router's `_add_liquidity`/`quote` math so we
/// can pre-authorize the EXACT transfer amounts. Postcondition:
/// `amount_b == ratio_quote(amount_a, reserve_asset, reserve_paired)` and
/// `amount_b <= paired_bal` and `amount_a <= asset_bal` — so passing
/// `amount_a_desired = amount_a`, `amount_b_desired = paired_bal` makes the
/// router pick exactly (amount_a, amount_b).
///
/// Note: either component can truncate to zero when the holdings are dust
/// relative to the current reserves. Callers (deposit) must treat a zero
/// component as "cannot provide liquidity" and revert (so no swap loss), since
/// the router rejects a zero desired/min amount.
fn optimal_add_amounts(
    asset_bal: i128,
    paired_bal: i128,
    reserve_asset: i128,
    reserve_paired: i128,
) -> (i128, i128) {
    if asset_bal <= 0 || paired_bal <= 0 || reserve_asset <= 0 || reserve_paired <= 0 {
        return (0, 0);
    }
    let need_paired = ratio_quote(asset_bal, reserve_asset, reserve_paired);
    if need_paired <= paired_bal {
        (asset_bal, need_paired)
    } else {
        let amount_a = ratio_quote(paired_bal, reserve_paired, reserve_asset);
        let amount_b = ratio_quote(amount_a, reserve_asset, reserve_paired);
        (amount_a, amount_b)
    }
}

/// Value (in asset units) of a position consisting of idle balances plus an LP
/// share. LP share of each reserve is `reserve * lp_bal / total_supply`. The
/// paired side (idle + LP share) is valued via the swap quote (with fee), since
/// exiting requires a swap back to the asset. Spot-reserve estimate — V1 caveat.
fn position_value(
    idle_asset: i128,
    idle_paired: i128,
    lp_bal: i128,
    total_supply: i128,
    reserve_asset: i128,
    reserve_paired: i128,
) -> i128 {
    let (my_asset, my_paired) = if total_supply > 0 && lp_bal > 0 {
        (
            reserve_asset.saturating_mul(lp_bal) / total_supply,
            reserve_paired.saturating_mul(lp_bal) / total_supply,
        )
    } else {
        (0, 0)
    };
    let total_asset = idle_asset.saturating_add(my_asset);
    let total_paired = idle_paired.saturating_add(my_paired);
    total_asset.saturating_add(quote_amount_out(total_paired, reserve_paired, reserve_asset))
}

/// Read pair reserves and return them ordered as `(reserve_of_asset, reserve_of_other)`.
fn ordered_reserves(pair: &SoroswapPairClient, asset: &Address) -> (i128, i128) {
    let (r0, r1) = pair.get_reserves();
    let token_0 = pair.token_0();
    if token_0 == *asset {
        (r0, r1)
    } else {
        (r1, r0)
    }
}

/// Build the single-entry auth pre-authorization list that the router needs:
/// the strategy is about to invoke router.swap_exact_tokens_for_tokens, which
/// will internally call `token_in.transfer(strategy, pair, amount_in)`. The
/// token's `require_auth(strategy)` walks the auth tree; with this entry the
/// strategy is recognised as the authorizing party.
fn pre_auth_swap_transfer(
    env: &Env,
    token_in: &Address,
    strategy: &Address,
    pair: &Address,
    amount_in: i128,
) {
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token_in.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: vec![
                    env,
                    strategy.clone().into_val(env),
                    pair.clone().into_val(env),
                    amount_in.into_val(env),
                ],
            },
            sub_invocations: vec![env],
        }),
    ]);
}

#[contractimpl]
impl StrategyInterface for SoroswapStrategy {
    fn deposit(env: Env, vault: Address, amount: i128) -> Result<(), StrategyError> {
        assert_vault(&env, &vault)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }
        let addrs = load_addresses(&env)?;
        let max_slippage = SoroswapStrategy::max_slippage_bps(env.clone());
        let this = env.current_contract_address();

        let swap_amount = amount / 2;
        if swap_amount <= 0 {
            return Err(StrategyError::InvalidAmount); // 1 stroop can't be split
        }

        // Leg 1: swap half asset -> paired (changes reserves).
        let pair = SoroswapPairClient::new(&env, &addrs.pool);
        let (r_asset, r_paired) = ordered_reserves(&pair, &addrs.asset);
        let expected_out = quote_amount_out(swap_amount, r_asset, r_paired);
        let min_out = slippage_floor(expected_out, max_slippage);
        pre_auth_swap_transfer(&env, &addrs.asset, &this, &addrs.pool, swap_amount);
        let router = SoroswapRouterClient::new(&env, &addrs.router);
        let deadline = env.ledger().timestamp().saturating_add(DEADLINE_SECONDS);
        let path = vec![&env, addrs.asset.clone(), addrs.paired.clone()];
        let swap_amounts =
            router.swap_exact_tokens_for_tokens(&swap_amount, &min_out, &path, &this, &deadline);
        if swap_amounts.get_unchecked(swap_amounts.len() - 1) <= 0 {
            return Err(StrategyError::PoolError);
        }

        // Leg 2: add liquidity with the balances we now hold. Re-read POST-swap
        // reserves so the amounts we authorize match what the router will move.
        let asset_token = token::Client::new(&env, &addrs.asset);
        let paired_token = token::Client::new(&env, &addrs.paired);
        let asset_bal = asset_token.balance(&this);
        let paired_bal = paired_token.balance(&this);
        let (r_asset2, r_paired2) = ordered_reserves(&pair, &addrs.asset);
        let (amount_a, amount_b) =
            optimal_add_amounts(asset_bal, paired_bal, r_asset2, r_paired2);
        if amount_a <= 0 || amount_b <= 0 {
            return Err(StrategyError::PoolError);
        }
        let min_a = slippage_floor(amount_a, max_slippage);
        let min_b = slippage_floor(amount_b, max_slippage);
        // Authorize the EXACT transfers; pass amount_b_desired = paired_bal so the
        // router's quote(amount_a) == amount_b and it consumes exactly (amount_a, amount_b).
        pre_auth_two_transfers(&env, &addrs.asset, &addrs.paired, &this, &addrs.pool, amount_a, amount_b);
        let (_used_a, _used_b, lp) = router.add_liquidity(
            &addrs.asset,
            &addrs.paired,
            &amount_a,
            &paired_bal,
            &min_a,
            &min_b,
            &this,
            &deadline,
        );
        if lp <= 0 {
            return Err(StrategyError::PoolError);
        }
        // Any one-sided remainder stays idle (counted by current_value).
        Ok(())
    }

    fn withdraw(env: Env, vault: Address, amount: i128) -> Result<i128, StrategyError> {
        assert_vault(&env, &vault)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }
        let addrs = load_addresses(&env)?;
        let max_slippage = SoroswapStrategy::max_slippage_bps(env.clone());
        let this = env.current_contract_address();

        let asset_token = token::Client::new(&env, &addrs.asset);
        let paired_token = token::Client::new(&env, &addrs.paired);
        let pair = SoroswapPairClient::new(&env, &addrs.pool);

        let idle_asset = asset_token.balance(&this);
        let idle_paired = paired_token.balance(&this);
        let lp_bal = pair.balance(&this);
        let ts = pair.total_supply();
        let (r_asset, r_paired) = ordered_reserves(&pair, &addrs.asset);

        let total_value = position_value(idle_asset, idle_paired, lp_bal, ts, r_asset, r_paired);
        if total_value <= 0 {
            return Err(StrategyError::InsufficientLiquidity);
        }
        // Honor "withdraw up to amount": never request more than we hold.
        let amount = if amount > total_value { total_value } else { amount };

        // Pro-rata slice across LP + idle.
        let lp_take = lp_bal.saturating_mul(amount) / total_value;
        let idle_asset_take = idle_asset.saturating_mul(amount) / total_value;
        let idle_paired_take = idle_paired.saturating_mul(amount) / total_value;

        let deadline = env.ledger().timestamp().saturating_add(DEADLINE_SECONDS);

        // Remove LP slice.
        let mut out_a: i128 = 0;
        let mut out_b: i128 = 0;
        if lp_take > 0 && ts > 0 {
            let exp_a = r_asset.saturating_mul(lp_take) / ts;
            let exp_b = r_paired.saturating_mul(lp_take) / ts;
            let min_a = slippage_floor(exp_a, max_slippage);
            let min_b = slippage_floor(exp_b, max_slippage);
            pre_auth_swap_transfer(&env, &addrs.pool, &this, &addrs.pool, lp_take); // LP-token burn transfer
            let router = SoroswapRouterClient::new(&env, &addrs.router);
            let (a, b) = router.remove_liquidity(
                &addrs.asset, &addrs.paired, &lp_take, &min_a, &min_b, &this, &deadline,
            );
            out_a = a;
            out_b = b;
        }

        // Swap the paired leg (removed + idle slice) back to asset.
        let paired_to_swap = out_b.saturating_add(idle_paired_take);
        let mut swapped: i128 = 0;
        if paired_to_swap > 0 {
            let (r_a2, r_p2) = ordered_reserves(&pair, &addrs.asset);
            let exp = quote_amount_out(paired_to_swap, r_p2, r_a2);
            let min_out = slippage_floor(exp, max_slippage);
            pre_auth_swap_transfer(&env, &addrs.paired, &this, &addrs.pool, paired_to_swap);
            let router = SoroswapRouterClient::new(&env, &addrs.router);
            let path = vec![&env, addrs.paired.clone(), addrs.asset.clone()];
            let amts = router
                .swap_exact_tokens_for_tokens(&paired_to_swap, &min_out, &path, &this, &deadline);
            swapped = amts.get_unchecked(amts.len() - 1);
        }

        let deliver = out_a
            .saturating_add(idle_asset_take)
            .saturating_add(swapped);
        if deliver <= 0 {
            return Err(StrategyError::InsufficientLiquidity);
        }
        asset_token.transfer(&this, &vault, &deliver);
        Ok(deliver)
    }

    /// Spot-reserve estimate of the position: idle balances plus the LP share
    /// of the pool reserves, with the paired side quoted back to asset (post-
    /// fee). Pool reserves shift between this read and any subsequent withdraw,
    /// so callers must treat this as an *estimate*, not authoritative. Vault
    /// `min_amount_out` is the actual safety floor.
    fn current_value(env: Env) -> i128 {
        let storage = env.storage().instance();
        let asset: Option<Address> = storage.get(&DataKey::Asset);
        let paired: Option<Address> = storage.get(&DataKey::PairedAsset);
        let pool: Option<Address> = storage.get(&DataKey::SoroswapPool);
        let (asset, paired, pool_addr) = match (asset, paired, pool) {
            (Some(a), Some(p), Some(po)) => (a, p, po),
            _ => return 0,
        };
        let this = env.current_contract_address();
        // SAC reads don't trap for valid addresses — safe to call non-try.
        let idle_asset = token::Client::new(&env, &asset).balance(&this);
        let idle_paired = token::Client::new(&env, &paired).balance(&this);
        // Pair reads use the generated `try_` variants and degrade gracefully:
        // a trapping/archived/paused pair must NOT panic here, because the
        // allocator turns an authoritative child's current_value error into a
        // panic that would brick all vault deposits/redeems.
        let pair = SoroswapPairClient::new(&env, &pool_addr);
        let lp_bal = match pair.try_balance(&this) {
            Ok(Ok(v)) => v,
            _ => 0,
        };
        let ts = match pair.try_total_supply() {
            Ok(Ok(v)) => v,
            _ => 0,
        };
        // Need BOTH reserves and token_0 to value the paired side. If either
        // read fails the pool is unreadable, so fall back to idle-asset-only
        // value (paired side is unvaluable without a working pool).
        let (r_asset, r_paired) = match (pair.try_get_reserves(), pair.try_token_0()) {
            (Ok(Ok((r0, r1))), Ok(Ok(token_0))) => {
                if token_0 == asset {
                    (r0, r1)
                } else {
                    (r1, r0)
                }
            }
            _ => return idle_asset,
        };
        position_value(idle_asset, idle_paired, lp_bal, ts, r_asset, r_paired)
    }

    fn harvest(env: Env, vault: Address) -> Result<i128, StrategyError> {
        // No-op: Soroswap's 0.30% trading fee auto-accrues into the pool
        // reserves, so the LP position's value rises through current_value
        // without an explicit claim step.
        assert_vault(&env, &vault)?;
        Ok(0)
    }

    fn pool_apy(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::ApyBps).unwrap_or(0)
    }

    fn set_pool_apy_bps(env: Env, admin: Address, bps: u32) -> Result<(), StrategyError> {
        require_admin(&env, &admin)?;
        if bps > 10_000 {
            return Err(StrategyError::InvalidApyBps);
        }
        env.storage().instance().set(&DataKey::ApyBps, &bps);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    // Tests cover the auth boundary, admin operations, and the pure-math
    // helpers. Live LP / swap correctness is verified by the post-deploy
    // demo flow against the testnet Soroswap pool — same pattern as
    // BlendStrategy, whose tests also stop at the auth boundary because
    // deposit/withdraw hit an external pool client.

    struct SetupCtx {
        admin: Address,
        vault: Address,
        contract_id: Address,
    }

    fn setup(env: &Env) -> SetupCtx {
        let admin = Address::generate(env);
        let vault = Address::generate(env);
        let asset = Address::generate(env);
        let soroswap_pool = Address::generate(env);
        let soroswap_router = Address::generate(env);
        let paired_asset = Address::generate(env);
        let contract_id = env.register(
            SoroswapStrategy,
            (
                admin.clone(),
                vault.clone(),
                asset,
                soroswap_pool,
                soroswap_router,
                paired_asset,
                500_u32,
            ),
        );
        SetupCtx {
            admin,
            vault,
            contract_id,
        }
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn deposit_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&imposter, &100_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")] // StrategyError::InvalidAmount = 2
    fn deposit_zero_amount_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&ctx.vault, &0_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")] // StrategyError::InvalidAmount = 2
    fn deposit_one_stroop_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&ctx.vault, &1_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn withdraw_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.withdraw(&imposter, &100_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn harvest_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.harvest(&imposter);
    }

    #[test]
    fn harvest_from_vault_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        assert_eq!(client.harvest(&ctx.vault), 0);
    }

    #[test]
    fn pool_apy_default_and_set() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        assert_eq!(client.pool_apy(), 500);
        client.set_pool_apy_bps(&ctx.admin, &900_u32);
        assert_eq!(client.pool_apy(), 900);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")] // StrategyError::AdminOnly = 7
    fn set_pool_apy_non_admin_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.set_pool_apy_bps(&imposter, &900_u32);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")] // StrategyError::InvalidApyBps = 8
    fn set_pool_apy_out_of_range_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.set_pool_apy_bps(&ctx.admin, &10_001_u32);
    }

    #[test]
    fn max_slippage_bps_default_and_set() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        assert_eq!(client.max_slippage_bps(), DEFAULT_MAX_SLIPPAGE_BPS);
        client.set_max_slippage_bps(&ctx.admin, &300_u32);
        assert_eq!(client.max_slippage_bps(), 300);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")] // StrategyError::AdminOnly = 7
    fn set_max_slippage_bps_non_admin_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.set_max_slippage_bps(&imposter, &300_u32);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")] // StrategyError::InvalidAmount = 2
    fn set_max_slippage_bps_out_of_range_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.set_max_slippage_bps(&ctx.admin, &10_001_u32);
    }

    #[test]
    fn set_vault_admin_only() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let new_vault = Address::generate(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.set_vault(&ctx.admin, &new_vault);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")] // StrategyError::AdminOnly = 7
    fn set_vault_non_admin_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let new_vault = Address::generate(&env);
        let client = SoroswapStrategyClient::new(&env, &ctx.contract_id);
        client.set_vault(&imposter, &new_vault);
    }

    // --- Pure math pinning ---------------------------------------------

    #[test]
    fn quote_amount_out_matches_onchain_smoke_test() {
        // Pinned from a 2026-05-27 smoke test of the live Soroswap router.
        // With reserves (200_000_000, 40_000_000) and 10_000_000 in,
        // `router_get_amount_out` returns exactly 1_899_318.
        let got = quote_amount_out(10_000_000, 200_000_000, 40_000_000);
        assert_eq!(got, 1_899_318);
    }

    #[test]
    fn quote_amount_out_zero_inputs_return_zero() {
        assert_eq!(quote_amount_out(0, 1_000, 1_000), 0);
        assert_eq!(quote_amount_out(100, 0, 1_000), 0);
        assert_eq!(quote_amount_out(100, 1_000, 0), 0);
        assert_eq!(quote_amount_out(-1, 1_000, 1_000), 0);
    }

    #[test]
    fn slippage_floor_basic() {
        assert_eq!(slippage_floor(10_000, 100), 9_900);
        assert_eq!(slippage_floor(10_000, 0), 10_000);
        assert_eq!(slippage_floor(10_000, 10_000), 0);
        assert_eq!(slippage_floor(-1, 100), 0);
        assert_eq!(slippage_floor(10_000, 99_999), 0);
    }

    #[test]
    fn ratio_quote_basic_and_guards() {
        // amount_a * reserve_b / reserve_a, integer floor.
        assert_eq!(ratio_quote(100, 1_000, 4_000), 400);
        assert_eq!(ratio_quote(3, 1_000, 4_000), 12);
        assert_eq!(ratio_quote(0, 1_000, 1_000), 0);
        assert_eq!(ratio_quote(100, 0, 1_000), 0);
        assert_eq!(ratio_quote(100, 1_000, 0), 0);
        assert_eq!(ratio_quote(-1, 1_000, 4_000), 0);
    }

    #[test]
    fn optimal_add_asset_is_limiting() {
        // Reserves 1000 asset : 4000 paired. Hold 100 asset, 1000 paired.
        // need_paired = quote(100, 1000, 4000) = 400 <= 1000 → use (100, 400).
        let (a, b) = optimal_add_amounts(100, 1000, 1_000, 4_000);
        assert_eq!((a, b), (100, 400));
    }

    #[test]
    fn optimal_add_paired_is_limiting() {
        // Reserves 1000 asset : 4000 paired. Hold 100 asset, 200 paired.
        // need_paired = quote(100,1000,4000)=400 > 200 → reduce:
        //   amount_a = quote(200, 4000, 1000) = 50; amount_b = quote(50,1000,4000)=200.
        let (a, b) = optimal_add_amounts(100, 200, 1_000, 4_000);
        assert_eq!((a, b), (50, 200));
        // Invariant the router relies on: amount_b == quote(amount_a, r_asset, r_paired)
        assert_eq!(b, ratio_quote(a, 1_000, 4_000));
        assert!(b <= 200);
    }

    #[test]
    fn optimal_add_zero_inputs() {
        assert_eq!(optimal_add_amounts(0, 100, 1_000, 4_000), (0, 0));
        assert_eq!(optimal_add_amounts(100, 0, 1_000, 4_000), (0, 0));
        assert_eq!(optimal_add_amounts(100, 100, 0, 4_000), (0, 0));
        assert_eq!(optimal_add_amounts(100, 100, 4_000, 0), (0, 0));
    }

    #[test]
    fn position_value_idle_only() {
        // No LP (ts=0). Idle 100 asset + 400 paired; reserves 1000:4000.
        // value = 100 + quote_amount_out(400, 4000, 1000) (with 0.3% fee).
        let expected = 100 + quote_amount_out(400, 4_000, 1_000);
        assert_eq!(position_value(100, 400, 0, 0, 1_000, 4_000), expected);
    }

    #[test]
    fn position_value_lp_plus_idle() {
        // lp_bal=500 of ts=1000 → 50% of reserves (1000 asset, 4000 paired)
        //   my_asset=500, my_paired=2000. Plus idle 10 asset, 20 paired.
        // value = (10+500) + quote_amount_out(20+2000, 4000, 1000).
        let expected = 510 + quote_amount_out(2_020, 4_000, 1_000);
        assert_eq!(position_value(10, 20, 500, 1_000, 1_000, 4_000), expected);
    }

    #[test]
    fn position_value_zero_supply_safe() {
        // total_supply=0 → LP share ignored; only idle counts (paired quoted to asset).
        let expected = quote_amount_out(50, 4_000, 1_000);
        assert_eq!(position_value(0, 50, 500, 0, 1_000, 4_000), expected);
    }

    // --- current_value panic-safety ------------------------------------

    #[test]
    fn current_value_degrades_to_idle_when_pair_unavailable() {
        // The pool address is a freshly generated Address that is NOT a deployed
        // contract, so every pair read (balance/total_supply/get_reserves/token_0)
        // traps. current_value MUST NOT panic — it must degrade to idle-asset-only
        // value (the strategy can't value the paired side without a working pool).
        // This matters because the strategy runs as an authoritative allocator
        // child, where a current_value error would brick all vault flows.
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let vault = Address::generate(&env);

        // Real SAC for the asset so the idle balance read succeeds.
        let asset_admin = Address::generate(&env);
        let asset_sac = env.register_stellar_asset_contract_v2(asset_admin.clone());
        let asset = asset_sac.address();
        let asset_minter = soroban_sdk::token::StellarAssetClient::new(&env, &asset);

        // Real SAC for the paired side too (its idle read also runs).
        let paired_admin = Address::generate(&env);
        let paired_sac = env.register_stellar_asset_contract_v2(paired_admin.clone());
        let paired = paired_sac.address();

        // Bogus, undeployed pool + router → pair client reads trap.
        let bogus_pool = Address::generate(&env);
        let bogus_router = Address::generate(&env);

        let contract_id = env.register(
            SoroswapStrategy,
            (
                admin,
                vault,
                asset.clone(),
                bogus_pool,
                bogus_router,
                paired,
                500_u32,
            ),
        );

        // Mint idle asset to the strategy contract itself.
        asset_minter.mint(&contract_id, &1_000_i128);

        let client = SoroswapStrategyClient::new(&env, &contract_id);
        // Bogus pool ⇒ pair reads fail ⇒ fall back to idle asset only (1_000).
        assert_eq!(client.current_value(), 1_000_i128);
    }
}
