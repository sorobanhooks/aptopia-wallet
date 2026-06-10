#![cfg(test)]
use crate::{BakuAllocator, BakuAllocatorClient};
use baku_mock_strategy::{MockStrategy, MockStrategyClient};
use soroban_sdk::{testutils::Address as _, vec, Address, Env, Vec};

pub(crate) struct Ctx {
    pub env: Env,
    pub admin: Address,
    pub vault: Address,
    pub asset: Address,
    pub asset_minter: soroban_sdk::token::StellarAssetClient<'static>,
    pub asset_token: soroban_sdk::token::TokenClient<'static>,
    pub allocator_id: Address,
    pub allocator: BakuAllocatorClient<'static>,
}

/// Deploy the allocator with `native_bps` and an (initially empty) child set.
pub(crate) fn setup(native_bps: u32) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let vault = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(asset_admin);
    let asset = sac.address();
    let asset_minter = soroban_sdk::token::StellarAssetClient::new(&env, &asset);
    let asset_token = soroban_sdk::token::TokenClient::new(&env, &asset);
    let empty: Vec<(Address, u32, bool)> = vec![&env];
    let allocator_id = env.register(
        BakuAllocator,
        (admin.clone(), vault.clone(), asset.clone(), empty, native_bps),
    );
    let allocator = BakuAllocatorClient::new(&env, &allocator_id);
    Ctx { env, admin, vault, asset, asset_minter, asset_token, allocator_id, allocator }
}

#[test]
fn buffer_reports_native_balance() {
    let ctx = setup(10_000);
    // mint 1_000 of the asset SAC to the allocator contract address
    ctx.asset_minter.mint(&ctx.allocator_id, &1_000);
    assert_eq!(ctx.allocator.buffer(), 1_000);
}

#[test]
fn constructor_stores_config() {
    let ctx = setup(10_000);
    assert_eq!(ctx.allocator.admin(), ctx.admin);
    assert_eq!(ctx.allocator.vault(), ctx.vault);
    assert_eq!(ctx.allocator.underlying(), ctx.asset);
    assert_eq!(ctx.allocator.native_bps(), 10_000);
    assert_eq!(ctx.allocator.children().len(), 0);
    assert!(!ctx.allocator.is_paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // WeightsSumInvalid
fn constructor_rejects_bad_weight_sum() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let vault = Address::generate(&env);
    let asset = Address::generate(&env);
    let empty: Vec<(Address, u32, bool)> = vec![&env];
    env.register(BakuAllocator, (admin, vault, asset, empty, 9_999_u32));
}

/// Register a MockStrategy child whose authorized vault is the allocator.
/// If `deposit_into > 0`, fund the child and record its internal balance.
pub(crate) fn add_mock_child(ctx: &Ctx, deposit_into: i128) -> Address {
    let child_admin = Address::generate(&ctx.env);
    let child = ctx.env.register(
        MockStrategy,
        (child_admin.clone(), ctx.allocator_id.clone(), ctx.asset.clone(), 500_u32),
    );
    if deposit_into > 0 {
        ctx.asset_minter.mint(&child, &deposit_into);
        MockStrategyClient::new(&ctx.env, &child).deposit(&ctx.allocator_id, &deposit_into);
    }
    child
}

#[test]
fn add_child_appends_with_zero_weight() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    let kids = ctx.allocator.children();
    assert_eq!(kids.len(), 1);
    assert_eq!(kids.get(0).unwrap().weight_bps, 0);
    assert!(kids.get(0).unwrap().authoritative);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // ChildAlreadyExists
fn add_child_rejects_duplicate() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // MaxChildrenExceeded
fn add_child_enforces_max() {
    let ctx = setup(10_000);
    for _ in 0..6 {
        let c = add_mock_child(&ctx, 0);
        ctx.allocator.add_child(&ctx.admin, &c, &true);
    }
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // AdminOnly
fn add_child_non_admin_reverts() {
    let ctx = setup(10_000);
    let imposter = Address::generate(&ctx.env);
    let c1 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&imposter, &c1, &true);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")] // ChildHasBalance
fn remove_child_blocked_with_balance() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 500);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.remove_child(&ctx.admin, &c1);
}

#[test]
fn force_remove_evicts_despite_balance() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 500);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.force_remove_child(&ctx.admin, &c1);
    assert_eq!(ctx.allocator.children().len(), 0);
}

#[test]
fn set_paused_toggles() {
    let ctx = setup(10_000);
    ctx.allocator.set_paused(&ctx.admin, &true);
    assert!(ctx.allocator.is_paused());
}

#[test]
fn current_value_sums_children_plus_native() {
    let ctx = setup(10_000);
    // Native sleeve: 300 raw underlying held by the allocator.
    ctx.asset_minter.mint(&ctx.allocator_id, &300_i128);
    // Two mock children holding 1_000 and 700.
    let c1 = add_mock_child(&ctx, 1_000);
    let c2 = add_mock_child(&ctx, 700);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    assert_eq!(ctx.allocator.current_value(), 300 + 1_000 + 700);
}

#[test]
fn set_target_weights_updates() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    let c2 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 3_000_u32), (c2.clone(), 4_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &3_000_u32);
    let kids = ctx.allocator.children();
    assert_eq!(kids.get(0).unwrap().weight_bps, 3_000);
    assert_eq!(kids.get(1).unwrap().weight_bps, 4_000);
    assert_eq!(ctx.allocator.native_bps(), 3_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // WeightsSumInvalid
fn set_target_weights_rejects_bad_sum() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 5_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &4_000_u32); // 9_000 != 10_000
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // NotAuthoritative
fn set_target_weights_rejects_weighting_non_authoritative() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &false); // NOT authoritative
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 6_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &4_000_u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // UnknownChild
fn set_target_weights_rejects_unknown_child() {
    let ctx = setup(10_000);
    let ghost = Address::generate(&ctx.env);
    let weights = soroban_sdk::vec![&ctx.env, (ghost, 5_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &5_000_u32);
}

#[test]
fn deposit_splits_pro_rata_dust_to_native() {
    // Constructor requires an all-native start (native_bps == 10_000); the target
    // 30%-native split is applied below via set_target_weights (matches the
    // pattern used by set_target_weights_updates). See design spec: "Can start
    // all-native (empty children, native_bps = 10_000)."
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    let c2 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 3_000_u32), (c2.clone(), 4_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &3_000_u32);

    // Caller transfers the deposit to the allocator first (mirrors vault.deposit).
    ctx.asset_minter.mint(&ctx.vault, &1_001_i128);
    ctx.asset_token.transfer(&ctx.vault, &ctx.allocator_id, &1_001_i128);
    ctx.allocator.deposit(&ctx.vault, &1_001_i128);

    // c1 = 1_001*3000/10000 = 300; c2 = 1_001*4000/10000 = 400; native = 1_001-700 = 301.
    assert_eq!(MockStrategyClient::new(&ctx.env, &c1).current_value(), 300);
    assert_eq!(MockStrategyClient::new(&ctx.env, &c2).current_value(), 400);
    assert_eq!(ctx.asset_token.balance(&ctx.allocator_id), 301);
    assert_eq!(ctx.allocator.current_value(), 1_001);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // map_alloc(Paused) -> StrategyError::PoolError (=3 in strategy-trait/src/errors.rs)
fn deposit_reverts_when_paused() {
    let ctx = setup(10_000);
    ctx.allocator.set_paused(&ctx.admin, &true);
    ctx.asset_minter.mint(&ctx.allocator_id, &100_i128);
    ctx.allocator.deposit(&ctx.vault, &100_i128);
}

#[test]
fn withdraw_serves_from_native_buffer() {
    let ctx = setup(10_000);
    ctx.asset_minter.mint(&ctx.allocator_id, &1_000); // native buffer = 1_000
    let got = ctx.allocator.withdraw(&ctx.vault, &600_i128);
    assert_eq!(got, 600);
    assert_eq!(ctx.allocator.buffer(), 400);
    assert_eq!(ctx.asset_token.balance(&ctx.vault), 600); // vault received 600
}

#[test]
// withdraw maps AllocatorError::InsufficientBuffer (=17) through map_alloc to
// StrategyError::PoolError (=3, strategy-trait/src/errors.rs) at the trait
// boundary, so the panic carries #3, not #17.
#[should_panic(expected = "Error(Contract, #3)")]
fn withdraw_above_buffer_reverts() {
    let ctx = setup(10_000);
    ctx.asset_minter.mint(&ctx.allocator_id, &100);
    ctx.allocator.withdraw(&ctx.vault, &101_i128); // exceeds buffer
}

#[test]
fn drain_child_pulls_into_native() {
    let ctx = setup(10_000);
    // Register a mock child seeded with 500 (authoritative).
    let child = add_mock_child(&ctx, 500);
    ctx.allocator.add_child(&ctx.admin, &child, &true);
    let pre_buf = ctx.allocator.buffer();
    let drained = ctx.allocator.drain_child(&ctx.admin, &child, &200_i128);
    assert_eq!(drained, 200);
    assert_eq!(ctx.allocator.buffer(), pre_buf + 200);
    assert_eq!(MockStrategyClient::new(&ctx.env, &child).current_value(), 300);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // AllocatorError::AdminOnly = 3
fn drain_child_non_admin_reverts() {
    let ctx = setup(10_000);
    let child = add_mock_child(&ctx, 500);
    ctx.allocator.add_child(&ctx.admin, &child, &true);
    let imposter = Address::generate(&ctx.env);
    ctx.allocator.drain_child(&imposter, &child, &1_i128);
}

#[test]
fn fund_child_moves_native_into_child() {
    let ctx = setup(10_000);
    let child = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &child, &true);
    ctx.asset_minter.mint(&ctx.allocator_id, &1_000); // native buffer
    let mock = MockStrategyClient::new(&ctx.env, &child);
    let pre = mock.current_value();
    ctx.allocator.fund_child(&ctx.admin, &child, &300_i128);
    assert_eq!(ctx.allocator.buffer(), 700);
    assert_eq!(mock.current_value(), pre + 300);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")] // InsufficientBuffer (returned directly, not mapped)
fn fund_child_above_buffer_reverts() {
    let ctx = setup(10_000);
    let child = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &child, &true);
    ctx.asset_minter.mint(&ctx.allocator_id, &100);
    ctx.allocator.fund_child(&ctx.admin, &child, &101_i128);
}

/// Register one authoritative mock child, seed it with `child_value`, weight it
/// at 5000 with native_bps 5000. Returns the child address. Mirrors the plan's
/// `setup_with_mock_child_weighted(5000, 5000)` + `seed_child_value`.
fn setup_weighted_child(ctx: &Ctx, child_value: i128) -> Address {
    let child = add_mock_child(ctx, child_value); // registers + seeds the child
    ctx.allocator.add_child(&ctx.admin, &child, &true);
    let weights = soroban_sdk::vec![&ctx.env, (child.clone(), 5_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &5_000_u32);
    child
}

#[test]
fn rebalance_step_drains_overweight_child_to_native() {
    let ctx = setup(10_000);
    // Make total = 1000: child holds 800 (overweight; target = 500), native 200.
    let child = setup_weighted_child(&ctx, 800);
    ctx.asset_minter.mint(&ctx.allocator_id, &200);
    ctx.allocator.rebalance_step(&ctx.admin, &child);
    // child back to target 500, excess 300 moved to native (200 -> 500)
    assert_eq!(MockStrategyClient::new(&ctx.env, &child).current_value(), 500);
    assert_eq!(ctx.allocator.buffer(), 500);
}

#[test]
fn rebalance_step_funds_underweight_child_from_native() {
    let ctx = setup(10_000);
    // total = 1000: child holds 200 (underweight; target 500), native 800.
    let child = setup_weighted_child(&ctx, 200);
    ctx.asset_minter.mint(&ctx.allocator_id, &800);
    ctx.allocator.rebalance_step(&ctx.admin, &child);
    assert_eq!(MockStrategyClient::new(&ctx.env, &child).current_value(), 500); // funded up to target
    assert_eq!(ctx.allocator.buffer(), 500);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // AdminOnly
fn rebalance_step_non_admin_reverts() {
    let ctx = setup(10_000);
    let child = setup_weighted_child(&ctx, 200);
    let imposter = Address::generate(&ctx.env);
    ctx.allocator.rebalance_step(&imposter, &child);
}

#[test]
fn pool_apy_weighted_avg_then_override() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0); // mock apy 500 bps
    let c2 = add_mock_child(&ctx, 0); // mock apy 500 bps
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 3_000_u32), (c2.clone(), 4_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &3_000_u32);
    // Weighted avg (no override): (500*3000 + 500*4000)/10000 = 350. Native contributes 0.
    assert_eq!(ctx.allocator.pool_apy(), 350);
    // Override takes precedence.
    ctx.allocator.set_pool_apy_bps(&ctx.admin, &900_u32);
    assert_eq!(ctx.allocator.pool_apy(), 900);
}

#[test]
fn harvest_sums_children() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    // Mock harvest returns 0; allocator harvest fans out and sums → 0.
    assert_eq!(ctx.allocator.harvest(&ctx.vault), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // AdminOnly
fn set_pool_apy_non_admin_reverts() {
    let ctx = setup(10_000);
    let imposter = Address::generate(&ctx.env);
    ctx.allocator.set_pool_apy_bps(&imposter, &500_u32);
}

#[test]
fn rebalance_realigns_to_target() {
    let ctx = setup(10_000); // start all-native, re-target to 50/50 native 0 below
    let c1 = add_mock_child(&ctx, 0);
    let c2 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 5_000_u32), (c2.clone(), 5_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &0_u32);

    // Deposit 1_000 → 500/500.
    ctx.asset_minter.mint(&ctx.vault, &1_000_i128);
    ctx.asset_token.transfer(&ctx.vault, &ctx.allocator_id, &1_000_i128);
    ctx.allocator.deposit(&ctx.vault, &1_000_i128);

    // Simulate differential yield: give c1 +200 (now 700/500, total 1_200).
    ctx.asset_minter.mint(&c1, &200_i128);
    MockStrategyClient::new(&ctx.env, &c1).deposit(&ctx.allocator_id, &200_i128);

    // Rebalance to 50/50 of 1_200 = 600 each. c1 drains 100 → native → funds c2 +100.
    ctx.allocator.rebalance(&ctx.admin);
    assert_eq!(MockStrategyClient::new(&ctx.env, &c1).current_value(), 600);
    assert_eq!(MockStrategyClient::new(&ctx.env, &c2).current_value(), 600);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // AdminOnly (rebalance returns AllocatorError directly)
fn rebalance_non_admin_reverts() {
    let ctx = setup(10_000);
    let imposter = Address::generate(&ctx.env);
    ctx.allocator.rebalance(&imposter);
}

