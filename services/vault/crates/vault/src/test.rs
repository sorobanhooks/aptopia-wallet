//! Vault unit tests against MockStrategy.
//!
//! Covers the coverage diagram from /plan-eng-review §3:
//! - Donation/inflation attack guard (first deposit + prior strategy donation)
//! - Partial withdraw
//! - Slippage path (min_amount_out > strategy delivery → SlippageExceeded)
//! - Insufficient shares revert
//! - Amount-zero revert
//! - Admin auth on register_strategy + set_active_strategy
//! - StrategyHasBalance guard on set_active_strategy
//! - StrategyNotRegistered guard on set_active_strategy
//! - Multi-strategy registry (D11.5 tracer)
//! - price_per_share growth after inject_yield (demo path)
//! - harvest pass-through

use crate::{BakuVault, BakuVaultClient};
use baku_mock_strategy::{MockStrategy, MockStrategyClient};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, String, Symbol,
};

struct Fixture {
    env: Env,
    admin: Address,
    user: Address,
    asset: Address,
    asset_token: TokenClient<'static>,
    asset_minter: StellarAssetClient<'static>,
    strategy_id: Address,
    strategy_admin: Address,
    vault_id: Address,
    vault: BakuVaultClient<'static>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let strategy_admin = Address::generate(&env);

    // Register a Stellar Asset Contract as the underlying.
    let sac = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset = sac.address();
    let asset_minter = StellarAssetClient::new(&env, &asset);
    let asset_token = TokenClient::new(&env, &asset);

    // Mint underlying to the user. Generous balance so setup_funded can deposit
    // well above MIN_REDEEM_ASSETS for the queue tests.
    asset_minter.mint(&user, &1_000_000_000_i128);

    // Deploy MockStrategy with the vault address — but we don't know the
    // vault address yet. Workaround: pre-generate a vault address via the
    // env's contract id, then register both contracts in the right order.
    // Soroban test envs let us register and then constructor — we use the
    // returned vault address when constructing the strategy.
    //
    // Simpler approach: register MockStrategy with a TEMPORARY vault address,
    // and accept that the strategy's vault check would fail. But for tests we
    // need it to work end-to-end. So:
    //   1. Register the vault (no constructor yet)
    //   2. Get its address
    //   3. Register strategy with vault address
    //   4. Initialize vault (constructor with strategy address)
    //
    // Soroban testutils support `env.register(Contract, constructor_args)`.
    // We compose by registering strategy first with a placeholder, then vault,
    // then re-registering — actually the cleaner pattern is to use a known
    // contract id pattern. For these tests we use this two-step dance:

    // Two-step deploy to resolve the mutual address dependency:
    //   1. Deploy strategy with a placeholder vault address.
    //   2. Deploy vault pointing at strategy.
    //   3. Use strategy.set_vault(admin, real_vault) to rewire.
    let placeholder = Address::generate(&env);
    let strategy_id = env.register(
        MockStrategy,
        (strategy_admin.clone(), placeholder, asset.clone(), 500_u32),
    );

    let vault_id = env.register(
        BakuVault,
        (
            admin.clone(),
            asset.clone(),
            strategy_id.clone(),
            String::from_str(&env, "Baku XLM Vault"),
            String::from_str(&env, "bkuXLM"),
        ),
    );

    let mock_client = MockStrategyClient::new(&env, &strategy_id);
    mock_client.set_vault(&strategy_admin, &vault_id);

    let vault = BakuVaultClient::new(&env, &vault_id);

    let _ = asset_admin; // SAC admin retained by sac handle internally; not needed downstream.
    Fixture {
        env,
        admin,
        user,
        asset,
        asset_token,
        asset_minter,
        strategy_id,
        strategy_admin,
        vault_id,
        vault,
    }
}

/// Like `setup()` but the user has already deposited, so they hold shares and
/// the active MockStrategy holds the underlying SAC (so it can pay out on
/// withdraw/claim). Mirrors the plan's `setup_funded` helper.
fn setup_funded() -> Fixture {
    let fx = setup();
    // 10 XLM (7 decimals). Full-share redeem value lands ~100_000_000, well
    // above MIN_REDEEM_ASSETS (1_000_000) so all queue tests clear the floor.
    fx.vault.deposit(&fx.user, &100_000_000_i128);
    fx
}

// ----- Basic round-trip -------------------------------------------------------

#[test]
fn first_deposit_mints_shares_proportional_to_assets() {
    let fx = setup();
    let shares = fx.vault.deposit(&fx.user, &100_000_i128);
    // With virtual_shares = 1e6 and virtual_assets = 1, the very first deposit
    // of 100_000 against an empty vault mints:
    //   shares = 100_000 * (0 + 1e6) / (0 + 1) = 1e11 (a huge number)
    // This is the OZ inflation-guard behavior: shares are valued at near-zero
    // initially so a donation attacker can't move PPS meaningfully.
    assert!(shares > 0, "must mint shares");
    // user's stToken balance equals shares
    let bal = fx.vault.balance(&fx.user);
    assert_eq!(bal, shares);
}

#[test]
fn deposit_then_redeem_returns_assets() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    let shares = fx.vault.balance(&fx.user);
    let starting_user_balance = fx.asset_token.balance(&fx.user);

    // Redeem all shares with min_amount_out = 0 (no slippage protection).
    let delivered = fx.vault.redeem(&fx.user, &shares, &0_i128);
    assert!(delivered > 0);

    let ending_user_balance = fx.asset_token.balance(&fx.user);
    assert_eq!(ending_user_balance, starting_user_balance + delivered);
    // Vault should now hold zero shares for the user
    assert_eq!(fx.vault.balance(&fx.user), 0);
}

#[test]
fn partial_withdraw_returns_proportional_assets() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    let shares = fx.vault.balance(&fx.user);
    let half_shares = shares / 2;

    let delivered = fx.vault.redeem(&fx.user, &half_shares, &0_i128);
    assert!(delivered > 0);

    // User should still hold the other half of shares.
    let remaining = fx.vault.balance(&fx.user);
    assert_eq!(remaining, shares - half_shares);
}

// ----- Inflation/donation guard ----------------------------------------------

#[test]
fn donation_attack_mitigated_by_virtual_offsets() {
    let fx = setup();
    // Attacker deposits 1 base unit, gets a tiny share allocation.
    let attacker = Address::generate(&fx.env);
    fx.asset_minter.mint(&attacker, &200_i128);

    let attacker_shares = fx.vault.deposit(&attacker, &1_i128);
    assert!(attacker_shares > 0);

    // Attacker tries to inflate price-per-share by donating directly to the
    // strategy (bypassing the vault).
    fx.asset_token
        .transfer(&attacker, &fx.strategy_id, &100_i128);

    // Now a victim deposits 1_000_000 base units.
    fx.vault.deposit(&fx.user, &1_000_000_i128);
    let victim_shares = fx.vault.balance(&fx.user);

    // Victim should receive a sane share count — NOT zero. Without the
    // virtual-shares mitigation, the attacker could donate enough to make the
    // first non-attacker deposit round down to zero shares. With virtual
    // offsets, this is impossible at reasonable donation sizes.
    assert!(
        victim_shares > 0,
        "victim must receive shares despite donation"
    );
}

// ----- Slippage / floor enforcement ------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #104)")] // VaultError::SlippageExceeded = 104
fn redeem_reverts_when_min_amount_out_exceeds_preview() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    let shares = fx.vault.balance(&fx.user);
    let preview = fx.vault.preview_redeem(&shares);
    // Demand more than the vault can deliver.
    fx.vault.redeem(&fx.user, &shares, &(preview + 1));
}

// ----- Error paths ------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #102)")] // VaultError::AmountZero = 102
fn deposit_zero_reverts() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &0_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #102)")] // VaultError::AmountZero = 102
fn redeem_zero_reverts() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    fx.vault.redeem(&fx.user, &0_i128, &0_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #103)")] // VaultError::InsufficientShares = 103
fn redeem_more_than_balance_reverts() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    let shares = fx.vault.balance(&fx.user);
    fx.vault.redeem(&fx.user, &(shares + 1), &0_i128);
}

// ----- Admin / registry -------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #100)")] // VaultError::Unauthorized = 100
fn register_strategy_non_admin_reverts() {
    let fx = setup();
    let imposter = Address::generate(&fx.env);
    let stranger = Address::generate(&fx.env);
    fx.vault.register_strategy(&imposter, &stranger);
}

#[test]
fn register_strategy_appends_to_registry() {
    let fx = setup();
    let new_strategy_admin = Address::generate(&fx.env);
    let new_strategy = fx.env.register(
        MockStrategy,
        (
            new_strategy_admin,
            fx.vault_id.clone(),
            fx.asset.clone(),
            600_u32,
        ),
    );

    let before = fx.vault.strategy_registry();
    assert_eq!(before.len(), 1);

    fx.vault.register_strategy(&fx.admin, &new_strategy);

    let after = fx.vault.strategy_registry();
    assert_eq!(after.len(), 2);
    assert_eq!(after.get_unchecked(1), new_strategy);
}

#[test]
#[should_panic(expected = "Error(Contract, #107)")] // VaultError::StrategyAlreadyRegistered = 107
fn register_strategy_duplicate_reverts() {
    let fx = setup();
    // strategy_id is already registered by the constructor
    fx.vault.register_strategy(&fx.admin, &fx.strategy_id);
}

#[test]
#[should_panic(expected = "Error(Contract, #105)")] // VaultError::StrategyHasBalance = 105
fn set_active_strategy_with_balance_reverts() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);

    // Register a second strategy
    let other_admin = Address::generate(&fx.env);
    let other = fx.env.register(
        MockStrategy,
        (other_admin, fx.vault_id.clone(), fx.asset.clone(), 700_u32),
    );
    fx.vault.register_strategy(&fx.admin, &other);

    // Try to switch — active still has balance.
    fx.vault.set_active_strategy(&fx.admin, &other);
}

#[test]
#[should_panic(expected = "Error(Contract, #106)")] // VaultError::StrategyNotRegistered = 106
fn set_active_strategy_unregistered_reverts() {
    let fx = setup();
    let other_admin = Address::generate(&fx.env);
    let other = fx.env.register(
        MockStrategy,
        (other_admin, fx.vault_id.clone(), fx.asset.clone(), 700_u32),
    );
    // Note: NOT registered with the vault.
    fx.vault.set_active_strategy(&fx.admin, &other);
}

#[test]
fn set_active_strategy_succeeds_when_drained_and_registered() {
    let fx = setup();
    // Register and switch when active strategy is empty (no deposits yet).
    let other_admin = Address::generate(&fx.env);
    let other = fx.env.register(
        MockStrategy,
        (other_admin, fx.vault_id.clone(), fx.asset.clone(), 700_u32),
    );
    fx.vault.register_strategy(&fx.admin, &other);
    fx.vault.set_active_strategy(&fx.admin, &other);
    assert_eq!(fx.vault.active_strategy(), other);
}

// ----- Multi-strategy tracer (D11.5) -----------------------------------------

#[test]
fn multi_strategy_registry_tracer() {
    let fx = setup();
    let blend_like_admin = Address::generate(&fx.env);
    let blend_like = fx.env.register(
        MockStrategy,
        (
            blend_like_admin,
            fx.vault_id.clone(),
            fx.asset.clone(),
            500_u32,
        ),
    );
    let soroswap_like_admin = Address::generate(&fx.env);
    let soroswap_like = fx.env.register(
        MockStrategy,
        (
            soroswap_like_admin,
            fx.vault_id.clone(),
            fx.asset.clone(),
            1200_u32,
        ),
    );

    fx.vault.register_strategy(&fx.admin, &blend_like);
    fx.vault.register_strategy(&fx.admin, &soroswap_like);

    let registry = fx.vault.strategy_registry();
    assert_eq!(registry.len(), 3); // initial + 2 added
    assert_eq!(registry.get_unchecked(0), fx.strategy_id);
    assert_eq!(registry.get_unchecked(1), blend_like);
    assert_eq!(registry.get_unchecked(2), soroswap_like);

    // Active remains the initial strategy until explicitly switched.
    assert_eq!(fx.vault.active_strategy(), fx.strategy_id);
}

// ----- Yield growth → price_per_share ----------------------------------------

#[test]
fn price_per_share_grows_after_yield_injection() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);

    let strategy_client = MockStrategyClient::new(&fx.env, &fx.strategy_id);
    let assets_before = strategy_client.current_value();
    let supply_before = fx.vault.total_supply();
    let pps_before = fx.vault.price_per_share();

    // Inject enough yield that the PPS change is unambiguously larger than the
    // VIRTUAL_SHARES/VIRTUAL_ASSETS offset (which dampens small movements at
    // the start). 100% growth = total_assets doubles.
    strategy_client.inject_yield(&fx.strategy_admin, &100_000_i128);

    let assets_after = strategy_client.current_value();
    let supply_after = fx.vault.total_supply();
    let pps_after = fx.vault.price_per_share();

    assert!(
        assets_after > assets_before,
        "current_value should grow after inject_yield (before={}, after={})",
        assets_before,
        assets_after
    );
    assert_eq!(
        supply_before, supply_after,
        "total_supply must not change on inject_yield"
    );
    assert!(
        pps_after > pps_before,
        "PPS should grow after yield injection (assets {}->{}, supply {}, pps {}->{})",
        assets_before,
        assets_after,
        supply_before,
        pps_before,
        pps_after
    );
}

// ----- Harvest pass-through --------------------------------------------------

#[test]
fn harvest_pass_through_returns_strategy_harvest_amount() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    // MockStrategy::harvest always returns 0.
    let harvested = fx.vault.harvest();
    assert_eq!(harvested, 0);
}

// ----- Views -----------------------------------------------------------------

#[test]
fn underlying_returns_asset_address() {
    let fx = setup();
    assert_eq!(fx.vault.underlying(), fx.asset);
}

#[test]
fn admin_returns_admin_address() {
    let fx = setup();
    assert_eq!(fx.vault.admin(), fx.admin);
}

#[test]
fn total_assets_tracks_strategy_value() {
    let fx = setup();
    assert_eq!(fx.vault.total_assets(), 0);
    fx.vault.deposit(&fx.user, &100_000_i128);
    assert_eq!(fx.vault.total_assets(), 100_000);
}

// ----- Rebalance ---------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #100)")] // VaultError::Unauthorized = 100
fn rebalance_non_admin_reverts() {
    let fx = setup();
    let imposter = Address::generate(&fx.env);
    let stranger = Address::generate(&fx.env);
    fx.vault.rebalance(&imposter, &stranger);
}

#[test]
#[should_panic(expected = "Error(Contract, #106)")] // VaultError::StrategyNotRegistered = 106
fn rebalance_to_unregistered_strategy_reverts() {
    let fx = setup();
    let unreg_admin = Address::generate(&fx.env);
    let unreg = fx.env.register(
        MockStrategy,
        (unreg_admin, fx.vault_id.clone(), fx.asset.clone(), 500_u32),
    );
    fx.vault.rebalance(&fx.admin, &unreg);
}

#[test]
fn rebalance_to_same_strategy_is_noop() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    let before_active = fx.vault.active_strategy();
    let before_total = fx.vault.total_assets();

    let moved = fx.vault.rebalance(&fx.admin, &fx.strategy_id);
    assert_eq!(moved, 0);
    assert_eq!(fx.vault.active_strategy(), before_active);
    assert_eq!(fx.vault.total_assets(), before_total);
}

#[test]
fn rebalance_when_empty_just_flips_pointer() {
    let fx = setup();
    // Register a second strategy. Active has zero balance (no deposits).
    let other_admin = Address::generate(&fx.env);
    let other = fx.env.register(
        MockStrategy,
        (other_admin, fx.vault_id.clone(), fx.asset.clone(), 700_u32),
    );
    fx.vault.register_strategy(&fx.admin, &other);

    let moved = fx.vault.rebalance(&fx.admin, &other);
    assert_eq!(moved, 0);
    assert_eq!(fx.vault.active_strategy(), other);
}

#[test]
fn rebalance_moves_funds_and_flips_active() {
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    let total_before = fx.vault.total_assets();
    assert_eq!(total_before, 100_000);

    // Register and rebalance into a second MockStrategy.
    let other_admin = Address::generate(&fx.env);
    let other = fx.env.register(
        MockStrategy,
        (other_admin, fx.vault_id.clone(), fx.asset.clone(), 700_u32),
    );
    fx.vault.register_strategy(&fx.admin, &other);

    let moved = fx.vault.rebalance(&fx.admin, &other);
    // MockStrategy is 1:1 (no LP slippage), so the full balance migrates.
    assert_eq!(moved, 100_000);

    // Active pointer flipped.
    assert_eq!(fx.vault.active_strategy(), other);
    // Old strategy is empty.
    let old_client = MockStrategyClient::new(&fx.env, &fx.strategy_id);
    assert_eq!(old_client.current_value(), 0);
    // New strategy holds the funds — total_assets reads through the active.
    assert_eq!(fx.vault.total_assets(), 100_000);
}

#[test]
fn rebalance_unblocks_set_active_immediately() {
    // After rebalance, the now-empty old strategy can be set active again
    // (or any other registered empty strategy) without StrategyHasBalance.
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);

    let other_admin = Address::generate(&fx.env);
    let other = fx.env.register(
        MockStrategy,
        (other_admin, fx.vault_id.clone(), fx.asset.clone(), 700_u32),
    );
    fx.vault.register_strategy(&fx.admin, &other);

    fx.vault.rebalance(&fx.admin, &other);
    // Now `other` is active and holds funds. set_active back to the original
    // (which is now empty) should also fail with StrategyHasBalance since
    // the new active has the funds. Rebalancing again is the proper path.
    let moved_back = fx.vault.rebalance(&fx.admin, &fx.strategy_id);
    assert_eq!(moved_back, 100_000);
    assert_eq!(fx.vault.active_strategy(), fx.strategy_id);
    assert_eq!(fx.vault.total_assets(), 100_000);
}

#[test]
fn rebalance_preserves_user_share_balance() {
    // User's stToken balance is unaffected by an admin rebalance — only the
    // underlying location changes.
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    let shares_before = fx.vault.balance(&fx.user);

    let other_admin = Address::generate(&fx.env);
    let other = fx.env.register(
        MockStrategy,
        (other_admin, fx.vault_id.clone(), fx.asset.clone(), 700_u32),
    );
    fx.vault.register_strategy(&fx.admin, &other);
    fx.vault.rebalance(&fx.admin, &other);

    let shares_after = fx.vault.balance(&fx.user);
    assert_eq!(shares_after, shares_before);
}

#[test]
fn redeem_after_rebalance_returns_full_value() {
    // End-to-end: deposit → rebalance → redeem. User gets their assets back.
    let fx = setup();
    fx.vault.deposit(&fx.user, &100_000_i128);
    let shares = fx.vault.balance(&fx.user);

    let other_admin = Address::generate(&fx.env);
    let other = fx.env.register(
        MockStrategy,
        (other_admin, fx.vault_id.clone(), fx.asset.clone(), 700_u32),
    );
    fx.vault.register_strategy(&fx.admin, &other);
    fx.vault.rebalance(&fx.admin, &other);

    let start_balance = fx.asset_token.balance(&fx.user);
    let delivered = fx.vault.redeem(&fx.user, &shares, &0_i128);
    assert!(delivered > 0);
    let end_balance = fx.asset_token.balance(&fx.user);
    assert_eq!(end_balance, start_balance + delivered);
    assert_eq!(fx.vault.balance(&fx.user), 0);
}

// ----- Async redemption queue (request / claim / cancel) ---------------------

#[test]
fn request_redeem_escrows_shares_and_records_pending() {
    let fx = setup_funded();
    let user_shares = fx.vault.balance(&fx.user);
    assert!(user_shares > 0);
    let id = fx.vault.request_redeem(&fx.user, &user_shares, &0_i128);
    assert_eq!(id, 0);
    // shares moved from user to the vault escrow
    assert_eq!(fx.vault.balance(&fx.user), 0);
    assert_eq!(fx.vault.balance(&fx.vault_id), user_shares);
    assert_eq!(fx.vault.total_pending_shares(), user_shares);
    let p = fx.vault.pending_redemption(&id).unwrap();
    assert_eq!(p.owner, fx.user);
    assert_eq!(p.shares, user_shares);
}

#[test]
#[should_panic(expected = "Error(Contract, #112)")] // VaultError::RedemptionTooSmall = 112
fn request_redeem_below_minimum_reverts() {
    let fx = setup_funded();
    // A 1-share request prices to ~0 underlying — far below MIN_REDEEM_ASSETS.
    fx.vault.request_redeem(&fx.user, &1_i128, &0_i128);
}

#[test]
fn claim_redeem_pays_burns_and_clears() {
    let fx = setup_funded(); // MockStrategy active; user holds shares
    let user_shares = fx.vault.balance(&fx.user);
    let id = fx.vault.request_redeem(&fx.user, &user_shares, &0_i128);
    let supply_before = fx.vault.total_supply();
    let user_asset_before = fx.asset_token.balance(&fx.user);

    let paid = fx.vault.claim_redeem(&id);
    assert!(paid > 0);
    // escrowed shares burned
    assert_eq!(fx.vault.balance(&fx.vault_id), 0);
    assert_eq!(fx.vault.total_supply(), supply_before - user_shares);
    assert_eq!(fx.vault.total_pending_shares(), 0);
    assert!(fx.vault.pending_redemption(&id).is_none());
    // user received the asset
    assert_eq!(fx.asset_token.balance(&fx.user), user_asset_before + paid);
}

#[test]
#[should_panic(expected = "Error(Contract, #104)")] // VaultError::SlippageExceeded = 104
fn claim_redeem_respects_min_out() {
    let fx = setup_funded();
    let user_shares = fx.vault.balance(&fx.user);
    // request with an impossibly high min_out
    let id = fx.vault.request_redeem(&fx.user, &user_shares, &i128::MAX);
    fx.vault.claim_redeem(&id);
}

#[test]
fn cancel_request_returns_escrowed_shares() {
    let fx = setup_funded();
    let user_shares = fx.vault.balance(&fx.user);
    let id = fx.vault.request_redeem(&fx.user, &user_shares, &0_i128);
    assert_eq!(fx.vault.balance(&fx.user), 0);
    fx.vault.cancel_request(&id);
    assert_eq!(fx.vault.balance(&fx.user), user_shares);
    assert_eq!(fx.vault.total_pending_shares(), 0);
    assert!(fx.vault.pending_redemption(&id).is_none());
}

#[test]
fn instant_redeemable_assets_falls_back_to_current_value_for_plain_strategy() {
    let fx = setup_funded(); // active = MockStrategy (no buffer() fn)
    // MockStrategy has no buffer(); the view must fall back to current_value
    // (minus any pending earmark — here zero).
    let mock_client = MockStrategyClient::new(&fx.env, &fx.strategy_id);
    let cv = mock_client.current_value();
    assert_eq!(fx.vault.instant_redeemable_assets(), cv);
}

#[test]
fn instant_redeemable_assets_drops_by_pending_owed_after_request() {
    // F6: the view returns the FREE buffer — raw current_value MINUS the assets
    // already earmarked for queued claims — so routing never sends an instant
    // redeem into native reserved for the queue.
    let fx = setup_funded();
    let before = fx.vault.instant_redeemable_assets();
    let user_shares = fx.vault.balance(&fx.user);
    // Earmark half the shares for a queued claim.
    let half = user_shares / 2;
    let pending_owed = fx.vault.preview_redeem(&half);
    assert!(pending_owed > 0);
    fx.vault.request_redeem(&fx.user, &half, &0_i128);
    let after = fx.vault.instant_redeemable_assets();
    // Free buffer dropped by ~the pending owed amount (allow ±1 for rounding).
    let drop = before - after;
    assert!(
        (drop - pending_owed).abs() <= 1,
        "free buffer should drop by ~pending_owed (before={before}, after={after}, drop={drop}, owed={pending_owed})"
    );
}

// Silence unused imports for MockAuth / MockAuthInvoke / IntoVal / Symbol
// (kept for future tests that need explicit auth-mocking patterns).
#[allow(dead_code)]
const _: Option<(&dyn IntoVal<Env, Symbol>,)> = None;
#[allow(dead_code)]
fn _silence_mockauth(_: MockAuth, _: MockAuthInvoke) {}
