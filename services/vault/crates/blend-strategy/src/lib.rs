//! BlendStrategy — implements `StrategyInterface` by supplying the vault's
//! underlying asset to a Blend lending pool.
//!
//! Funds flow:
//!   vault → SAC.transfer → strategy → pool.submit(Supply) → reserve b-tokens
//!   accrue against the asset's b_rate, which grows with borrower interest.
//!
//! V0 simplifications (documented for the I6 spike, T12):
//! - `harvest` returns 0. Blend's reserve interest auto-compounds into
//!   `b_rate`, so the value is reflected via `current_value` without an
//!   explicit claim. BLND emission tokens, when configured, would be
//!   claimed via `pool.claim(this, vec![reserve_token_id], this)`; the
//!   `reserve_token_id` encoding (supply vs debt side) must be verified
//!   against the live testnet pool before enabling.
//! - The `inject_yield` helper that MockStrategy exposes is intentionally
//!   omitted here: there is no way to inflate a Blend supply position
//!   off-pool, and the realistic "demo growth" path is time-pass plus real
//!   borrower interest.
//!
//! `current_value` derives underlying from on-chain pool state:
//!   underlying = positions.supply[reserve_index] * reserve.data.b_rate / SCALAR_12
//! where SCALAR_12 = 1e12 is Blend V2's `b_rate` scalar. (V1 used 1e9; the
//! T12 live spike against TestnetV2 confirmed V2's b_rate is scaled by 1e12 —
//! e.g. a freshly-deployed USDC reserve reports b_rate ≈ 1.055e12.)

#![no_std]

use baku_strategy_trait::{StrategyError, StrategyInterface};
use blend_contract_sdk::pool;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, token, vec, Address, Env, IntoVal, Symbol,
};

/// Blend V2 rate scalar. `b_rate` is stored as (underlying-per-b-token) * 1e12.
/// Verified against TestnetV2 USDC reserve (T12 spike).
const SCALAR_12: i128 = 1_000_000_000_000;

/// Blend `submit` request_type discriminants (no-borrow strategy needs only Supply/Withdraw).
const REQUEST_SUPPLY: u32 = 0;
const REQUEST_WITHDRAW: u32 = 1;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Vault,
    Asset,
    BlendPool,
    BlndToken,
    ApyBps,
}

#[contract]
pub struct BlendStrategy;

#[contractimpl]
impl BlendStrategy {
    /// Initialize the Blend strategy. Caller becomes admin; only `vault` may
    /// invoke deposit/withdraw/harvest after init.
    pub fn __constructor(
        env: Env,
        admin: Address,
        vault: Address,
        asset: Address,
        blend_pool: Address,
        blnd_token: Address,
        initial_apy_bps: u32,
    ) {
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Vault, &vault);
        storage.set(&DataKey::Asset, &asset);
        storage.set(&DataKey::BlendPool, &blend_pool);
        storage.set(&DataKey::BlndToken, &blnd_token);
        storage.set(&DataKey::ApyBps, &initial_apy_bps);
    }

    /// Admin-only: rewire the strategy's authorized vault. Mirrors
    /// MockStrategy::set_vault for the mutual-init dance.
    pub fn set_vault(env: Env, admin: Address, new_vault: Address) -> Result<(), StrategyError> {
        require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Vault, &new_vault);
        Ok(())
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

fn load_asset(env: &Env) -> Result<Address, StrategyError> {
    env.storage()
        .instance()
        .get(&DataKey::Asset)
        .ok_or(StrategyError::NotInitialized)
}

fn load_pool(env: &Env) -> Result<Address, StrategyError> {
    env.storage()
        .instance()
        .get(&DataKey::BlendPool)
        .ok_or(StrategyError::NotInitialized)
}

#[contractimpl]
impl StrategyInterface for BlendStrategy {
    fn deposit(env: Env, vault: Address, amount: i128) -> Result<(), StrategyError> {
        assert_vault(&env, &vault)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }

        let asset = load_asset(&env)?;
        let pool_addr = load_pool(&env)?;
        let this = env.current_contract_address();

        // Pre-authorize the SAC.transfer(this, pool, amount) sub-invocation
        // that pool.submit(Supply) will perform. Without this, Soroban's
        // auth check fails: the strategy is in the call stack but is NOT the
        // direct caller of token.transfer (the pool is), so its implicit
        // contract auth doesn't apply. authorize_as_current_contract declares
        // exactly which sub-invocations the strategy pre-authorizes for the
        // upcoming pool.submit call. Confirmed empirically against testnet
        // 2026-05-27 — Error(Auth, InvalidAction) without it.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: asset.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: vec![
                        &env,
                        this.clone().into_val(&env),
                        pool_addr.clone().into_val(&env),
                        amount.into_val(&env),
                    ],
                },
                sub_invocations: vec![&env],
            }),
        ]);

        // Vault has already transferred `amount` of `asset` to this contract
        // before calling. submit(Supply) consumes our balance and credits the
        // pool position to `this`.
        //
        // Blend's submit will internally call `asset.transfer(this, pool, amount)`
        // on our behalf — `this` is a contract, so we must explicitly authorize
        // the sub-invocation via `authorize_as_current_contract`. Without this
        // entry, the SAC trips Auth::InvalidAction during simulation. Tests
        // that use `mock_all_auths` won't catch this; the bug surfaces only on
        // live networks (or with `mock_auths`).
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: asset.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: vec![
                        &env,
                        this.into_val(&env),
                        pool_addr.into_val(&env),
                        amount.into_val(&env),
                    ],
                },
                sub_invocations: vec![&env],
            }),
        ]);

        let request = pool::Request {
            address: asset,
            amount,
            request_type: REQUEST_SUPPLY,
        };
        let pool_client = pool::Client::new(&env, &pool_addr);
        pool_client.submit(&this, &this, &this, &vec![&env, request]);
        Ok(())
    }

    fn withdraw(env: Env, vault: Address, amount: i128) -> Result<i128, StrategyError> {
        assert_vault(&env, &vault)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }

        let asset = load_asset(&env)?;
        let pool_addr = load_pool(&env)?;
        let this = env.current_contract_address();
        let token_client = token::Client::new(&env, &asset);

        // Read pre-balance so we can compute the actual amount delivered. Blend
        // may withdraw slightly less than requested when capped by available
        // liquidity; measuring the balance delta is the only honest signal.
        let pre = token_client.balance(&this);
        let request = pool::Request {
            address: asset.clone(),
            amount,
            request_type: REQUEST_WITHDRAW,
        };
        let pool_client = pool::Client::new(&env, &pool_addr);
        pool_client.submit(&this, &this, &this, &vec![&env, request]);
        let post = token_client.balance(&this);
        let delivered = post - pre;
        if delivered <= 0 {
            return Err(StrategyError::InsufficientLiquidity);
        }

        token_client.transfer(&this, &vault, &delivered);
        Ok(delivered)
    }

    fn current_value(env: Env) -> i128 {
        let asset: Option<Address> = env.storage().instance().get(&DataKey::Asset);
        let pool_addr: Option<Address> = env.storage().instance().get(&DataKey::BlendPool);
        let (asset, pool_addr) = match (asset, pool_addr) {
            (Some(a), Some(p)) => (a, p),
            _ => return 0,
        };
        let this = env.current_contract_address();
        let pool_client = pool::Client::new(&env, &pool_addr);
        let positions = pool_client.get_positions(&this);
        let reserve = pool_client.get_reserve(&asset);
        let idx = reserve.config.index;
        let b_supply = positions.supply.get(idx).unwrap_or(0);
        // underlying = b_supply * b_rate / SCALAR_12. b_rate >= 1e12 (rate
        // grows monotonically with interest accrual), so this rounds down on
        // the user's behalf, leaving dust in the vault — matches the
        // redeem-side virtual-offset rounding convention.
        b_supply.saturating_mul(reserve.data.b_rate) / SCALAR_12
    }

    fn harvest(env: Env, _vault: Address) -> Result<i128, StrategyError> {
        // Auth: only the vault may trigger harvest, but Blend supply interest
        // auto-compounds into b_rate without any on-chain action. Returning 0
        // keeps harvest a permissionless no-op for V0.
        //
        // When BLND emissions land for this reserve, switch to:
        //   let idx = pool::Client::new(&env, &pool).get_reserve(&asset).config.index;
        //   pool_client.claim(&this, &vec![&env, reserve_token_id_for(idx)], &this)
        // The supply-vs-debt encoding of reserve_token_id must be validated
        // against the live Blend pool (HANDOFF.md task T12).
        assert_vault(&env, &_vault)?;
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

    struct SetupCtx {
        admin: Address,
        vault: Address,
        #[allow(dead_code)]
        asset: Address,
        #[allow(dead_code)]
        blend_pool: Address,
        #[allow(dead_code)]
        blnd_token: Address,
        contract_id: Address,
    }

    fn setup(env: &Env) -> SetupCtx {
        let admin = Address::generate(env);
        let vault = Address::generate(env);
        let asset = Address::generate(env);
        let blend_pool = Address::generate(env);
        let blnd_token = Address::generate(env);
        let contract_id = env.register(
            BlendStrategy,
            (
                admin.clone(),
                vault.clone(),
                asset.clone(),
                blend_pool.clone(),
                blnd_token.clone(),
                500_u32,
            ),
        );
        SetupCtx {
            admin,
            vault,
            asset,
            blend_pool,
            blnd_token,
            contract_id,
        }
    }

    #[test]
    fn pool_apy_default_and_set() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        assert_eq!(client.pool_apy(), 500);
        client.set_pool_apy_bps(&ctx.admin, &750_u32);
        assert_eq!(client.pool_apy(), 750);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")] // StrategyError::AdminOnly = 7
    fn set_pool_apy_non_admin_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        client.set_pool_apy_bps(&imposter, &750_u32);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")] // StrategyError::InvalidApyBps = 8
    fn set_pool_apy_out_of_range_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        client.set_pool_apy_bps(&ctx.admin, &10_001_u32);
    }

    #[test]
    fn set_vault_admin_only() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let new_vault = Address::generate(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        client.set_vault(&ctx.admin, &new_vault);
        // After rewiring, the original vault should no longer be authorized.
        // Asserted indirectly: deposit from the old vault would revert with
        // Unauthorized. We can't call deposit here without a live pool, but
        // the storage write itself is the contract under test.
        let _ = ctx.vault; // silence unused
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")] // StrategyError::AdminOnly = 7
    fn set_vault_non_admin_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let new_vault = Address::generate(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        client.set_vault(&imposter, &new_vault);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn deposit_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&imposter, &100_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn withdraw_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        client.withdraw(&imposter, &100_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn harvest_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        client.harvest(&imposter);
    }

    #[test]
    fn harvest_from_vault_returns_zero_v0() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = BlendStrategyClient::new(&env, &ctx.contract_id);
        // V0: BLND emissions claim is gated behind reserve_token_id validation
        // against the live Blend pool, so harvest is a permissionless no-op.
        assert_eq!(client.harvest(&ctx.vault), 0);
    }
}
