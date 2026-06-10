#![cfg(test)]
//! LP-risk-path tests using a test-only LossyChild that under-delivers on
//! withdraw (real soroswap swaps can't be unit-tested — no mock router exists;
//! see soroswap-strategy tests which stop at the auth boundary). These exercise
//! the allocator's measured-delta withdraw and rebalance shortfall atomic-revert.

use crate::{BakuAllocator, BakuAllocatorClient};
use baku_mock_strategy::{MockStrategy, MockStrategyClient};
use baku_strategy_trait::{StrategyError, StrategyInterface};
use soroban_sdk::{
    contract, contractimpl, contracttype, token, testutils::Address as _, vec, Address, Env, Vec,
};

// ---- Test-only lossy child: under-delivers `slip_bps` on withdraw ----
#[contracttype]
enum LKey { Vault, Asset, Balance, SlipBps }

#[contract]
pub struct LossyChild;

#[contractimpl]
impl LossyChild {
    pub fn __constructor(env: Env, vault: Address, asset: Address, slip_bps: u32) {
        let s = env.storage().instance();
        s.set(&LKey::Vault, &vault);
        s.set(&LKey::Asset, &asset);
        s.set(&LKey::Balance, &0_i128);
        s.set(&LKey::SlipBps, &slip_bps);
    }
}

#[contractimpl]
impl StrategyInterface for LossyChild {
    fn deposit(env: Env, _vault: Address, amount: i128) -> Result<(), StrategyError> {
        // Assumes the allocator already transferred `amount` of asset to this contract.
        let bal: i128 = env.storage().instance().get(&LKey::Balance).unwrap_or(0);
        env.storage().instance().set(&LKey::Balance, &(bal + amount));
        Ok(())
    }
    fn withdraw(env: Env, vault: Address, amount: i128) -> Result<i128, StrategyError> {
        let bal: i128 = env.storage().instance().get(&LKey::Balance).unwrap_or(0);
        if bal < amount { return Err(StrategyError::InsufficientLiquidity); }
        let slip: u32 = env.storage().instance().get(&LKey::SlipBps).unwrap_or(0);
        let deliver = amount - (amount * (slip as i128) / 10_000); // under-deliver
        // Full `amount` leaves the position; the slippage is "lost" (stays as
        // untracked SAC on this contract), modeling swap-back loss.
        env.storage().instance().set(&LKey::Balance, &(bal - amount));
        let asset: Address = env.storage().instance().get(&LKey::Asset).unwrap();
        token::Client::new(&env, &asset)
            .transfer(&env.current_contract_address(), &vault, &deliver);
        Ok(deliver)
    }
    fn current_value(env: Env) -> i128 {
        env.storage().instance().get(&LKey::Balance).unwrap_or(0)
    }
    fn harvest(_env: Env, _vault: Address) -> Result<i128, StrategyError> { Ok(0) }
    fn pool_apy(_env: Env) -> u32 { 0 }
    fn set_pool_apy_bps(_env: Env, _admin: Address, _bps: u32) -> Result<(), StrategyError> { Ok(()) }
}

// ---- Tests ----

#[test]
fn lossy_child_rebalance_shortfall_reverts_atomically() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let vault = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let asset = sac.address();
    let minter = soroban_sdk::token::StellarAssetClient::new(&env, &asset);
    let tok = soroban_sdk::token::TokenClient::new(&env, &asset);

    let empty: Vec<(Address, u32, bool)> = vec![&env];
    let alloc_id = env.register(BakuAllocator,
        (admin.clone(), vault.clone(), asset.clone(), empty, 10_000_u32));
    let alloc = BakuAllocatorClient::new(&env, &alloc_id);

    // Lossy child @ 50% slippage + a faithful mock child, both weighted 50/50.
    let lossy = env.register(LossyChild, (alloc_id.clone(), asset.clone(), 5_000_u32));
    let mock = env.register(MockStrategy,
        (Address::generate(&env), alloc_id.clone(), asset.clone(), 500_u32));
    alloc.add_child(&admin, &lossy, &true);
    alloc.add_child(&admin, &mock, &true);
    let weights = vec![&env, (lossy.clone(), 5_000_u32), (mock.clone(), 5_000_u32)];
    alloc.set_target_weights(&admin, &weights, &0_u32);

    minter.mint(&vault, &1_000_i128);
    tok.transfer(&vault, &alloc_id, &1_000_i128);
    alloc.deposit(&vault, &1_000_i128); // lossy 500, mock 500

    // Make lossy overweight: +500 (now 1_000). total=1_500, targets 750/750.
    minter.mint(&lossy, &500_i128);
    LossyChildClient::new(&env, &lossy).deposit(&alloc_id, &500_i128);

    // Pass 1 drains lossy by 250 but it delivers only 125 (50% slip) into native.
    // Pass 2 needs 250 to fund mock but the allocator holds only 125 → transfer
    // underflows → the WHOLE rebalance reverts atomically.
    let res = alloc.try_rebalance(&admin);
    assert!(res.is_err(), "rebalance must revert on slippage shortfall");

    // Atomicity: state is unchanged — pass-1 drain was rolled back.
    assert_eq!(LossyChildClient::new(&env, &lossy).current_value(), 1_000);
    assert_eq!(MockStrategyClient::new(&env, &mock).current_value(), 500);
}
