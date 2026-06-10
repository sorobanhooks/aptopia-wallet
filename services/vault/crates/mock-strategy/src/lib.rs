//! MockStrategy — implements `StrategyInterface` with simple in-storage
//! accounting plus an admin `inject_yield` method for simulating yield accrual
//! in vault unit tests.
//!
//! NOT for testnet or mainnet deploy. Used only as a vault test fixture.

#![no_std]

use baku_strategy_trait::{StrategyError, StrategyInterface};
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Vault,
    Asset,
    Balance,
    ApyBps,
}

#[contract]
pub struct MockStrategy;

#[contractimpl]
impl MockStrategy {
    /// Initialize the mock strategy. Caller becomes admin; only `vault` may
    /// invoke state-changing methods after init.
    pub fn __constructor(
        env: Env,
        admin: Address,
        vault: Address,
        asset: Address,
        initial_apy_bps: u32,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage().instance().set(&DataKey::Balance, &0_i128);
        env.storage()
            .instance()
            .set(&DataKey::ApyBps, &initial_apy_bps);
    }

    /// Admin-only: rewire the strategy's authorized vault. Needed in tests
    /// because the strategy and vault have mutual address dependencies; we
    /// deploy strategy with a placeholder vault first, then call `set_vault`
    /// after deploying the real vault. Not a production pattern — production
    /// strategies are deployed once with the correct vault.
    pub fn set_vault(env: Env, admin: Address, new_vault: Address) -> Result<(), StrategyError> {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(StrategyError::NotInitialized)?;
        if admin != stored_admin {
            return Err(StrategyError::AdminOnly);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Vault, &new_vault);
        Ok(())
    }

    /// Admin-only: simulate yield accrual by inflating the balance directly.
    /// Used in vault tests to verify price-per-share growth without waiting on
    /// a real yield source.
    pub fn inject_yield(env: Env, admin: Address, amount: i128) -> Result<(), StrategyError> {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(StrategyError::NotInitialized)?;
        if admin != stored_admin {
            return Err(StrategyError::AdminOnly);
        }
        admin.require_auth();
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }
        let current: i128 = env.storage().instance().get(&DataKey::Balance).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Balance, &(current + amount));
        Ok(())
    }
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

#[contractimpl]
impl StrategyInterface for MockStrategy {
    fn deposit(env: Env, vault: Address, amount: i128) -> Result<(), StrategyError> {
        assert_vault(&env, &vault)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }
        let current: i128 = env.storage().instance().get(&DataKey::Balance).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Balance, &(current + amount));
        Ok(())
    }

    fn withdraw(env: Env, vault: Address, amount: i128) -> Result<i128, StrategyError> {
        assert_vault(&env, &vault)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }
        let current: i128 = env.storage().instance().get(&DataKey::Balance).unwrap_or(0);
        if current < amount {
            return Err(StrategyError::InsufficientLiquidity);
        }
        env.storage()
            .instance()
            .set(&DataKey::Balance, &(current - amount));

        // Transfer the underlying back to the vault. Real strategies (Blend,
        // Soroswap) do the equivalent: pull funds out of the protocol and
        // deliver them to the caller (vault).
        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(StrategyError::NotInitialized)?;
        token::Client::new(&env, &asset).transfer(&env.current_contract_address(), &vault, &amount);

        Ok(amount)
    }

    fn current_value(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::Balance).unwrap_or(0)
    }

    fn harvest(env: Env, vault: Address) -> Result<i128, StrategyError> {
        assert_vault(&env, &vault)?;
        // No-op: MockStrategy yield is admin-injected, not auto-compounded.
        Ok(0)
    }

    fn pool_apy(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::ApyBps).unwrap_or(0)
    }

    fn set_pool_apy_bps(env: Env, admin: Address, bps: u32) -> Result<(), StrategyError> {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(StrategyError::NotInitialized)?;
        if admin != stored_admin {
            return Err(StrategyError::AdminOnly);
        }
        admin.require_auth();
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

    fn setup(env: &Env) -> SetupCtx {
        let admin = Address::generate(env);
        let vault = Address::generate(env);
        let asset_admin = Address::generate(env);
        let sac = env.register_stellar_asset_contract_v2(asset_admin.clone());
        let asset = sac.address();
        let contract_id = env.register(
            MockStrategy,
            (admin.clone(), vault.clone(), asset.clone(), 500_u32),
        );
        SetupCtx {
            admin,
            vault,
            asset,
            asset_admin,
            contract_id,
        }
    }

    struct SetupCtx {
        admin: Address,
        vault: Address,
        asset: Address,
        #[allow(dead_code)]
        asset_admin: Address,
        contract_id: Address,
    }

    fn fund_strategy(env: &Env, ctx: &SetupCtx, amount: i128) {
        let minter = soroban_sdk::token::StellarAssetClient::new(env, &ctx.asset);
        minter.mint(&ctx.contract_id, &amount);
    }

    #[test]
    fn deposit_and_current_value() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = MockStrategyClient::new(&env, &ctx.contract_id);

        client.deposit(&ctx.vault, &1_000_i128);
        assert_eq!(client.current_value(), 1_000);

        client.deposit(&ctx.vault, &500_i128);
        assert_eq!(client.current_value(), 1_500);
    }

    #[test]
    fn withdraw_returns_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        // Fund the strategy contract directly so it has SAC balance for withdraw.
        fund_strategy(&env, &ctx, 1_000);
        let client = MockStrategyClient::new(&env, &ctx.contract_id);

        client.deposit(&ctx.vault, &1_000_i128);
        let delivered = client.withdraw(&ctx.vault, &400_i128);
        assert_eq!(delivered, 400);
        assert_eq!(client.current_value(), 600);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")] // StrategyError::InsufficientLiquidity = 4
    fn withdraw_more_than_balance_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = MockStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&ctx.vault, &100_i128);
        client.withdraw(&ctx.vault, &200_i128);
    }

    #[test]
    fn inject_yield_grows_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = MockStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&ctx.vault, &1_000_i128);
        client.inject_yield(&ctx.admin, &50_i128);
        assert_eq!(client.current_value(), 1_050);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn deposit_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = MockStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&imposter, &100_i128);
    }

    #[test]
    fn pool_apy_default_and_set() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = MockStrategyClient::new(&env, &ctx.contract_id);
        assert_eq!(client.pool_apy(), 500);
        client.set_pool_apy_bps(&ctx.admin, &750_u32);
        assert_eq!(client.pool_apy(), 750);
    }
}
