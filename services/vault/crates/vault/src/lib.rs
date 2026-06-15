//! Baku Vault contract.
//!
//! The vault IS the SEP-41 share token (no separate stToken contract). It does
//! NOT hold the underlying asset itself — all funds live in the active
//! strategy. The vault delegates deposit / withdraw to the strategy via the
//! typed `StrategyClient` and tracks ownership through share math.
//!
//! Share math: canonical ERC-4626 with the OZ-style virtual offsets baked in
//! to defeat the first-deposit donation/inflation attack.
//!
//!   shares = (assets * (total_supply + VIRTUAL_SHARES)) / (total_assets + VIRTUAL_ASSETS)
//!   assets = (shares * (total_assets + VIRTUAL_ASSETS)) / (total_supply + VIRTUAL_SHARES)
//!
//! `total_assets` is the strategy's `current_value()` — never the vault's own
//! token balance, which is always ~0 (funds flow vault → strategy → pool).
//!
//! Decisions reflected:
//! - D2: vault dispatches to strategy through typed `StrategyClient`.
//! - D4: `redeem(shares, min_amount_out)` is the user-facing entrypoint; the
//!   contract enforces the floor on what the strategy actually delivered.
//! - D5: typed `VaultError` (see `errors` module).
//! - D11.5: `register_strategy` exists and is testable end-to-end via the
//!   tracer multi-strategy test.
//! - V0 cut: `set_active_strategy` only works when active strategy is empty
//!   (no per-user migration).

#![no_std]

use baku_strategy_trait::StrategyClient;
use soroban_sdk::{
    contract, contractimpl, contracttype, panic_with_error, token, Address, Env, MuxedAddress,
    String, Vec,
};
use stellar_tokens::fungible::{Base, FungibleToken};

pub mod errors;
pub use errors::VaultError;

/// Virtual-shares offset (OpenZeppelin ERC-4626 default scaled to Stellar's
/// 7-decimal convention). Defeats the first-deposit inflation attack by
/// pricing the first share at `1 / (1 + VIRTUAL_SHARES)` of the assets — the
/// attacker would need to donate ~10^6 base units of the underlying to move
/// price-per-share even one unit.
pub const VIRTUAL_SHARES: i128 = 1_000_000;
pub const VIRTUAL_ASSETS: i128 = 1;

/// Minimum asset value (underlying base units) for a QUEUED redemption request.
/// Each request escrows shares + writes a persistent entry; this floor deters
/// dust-spam / storage griefing. Tunable. (0.1 XLM at 7 decimals.)
pub const MIN_REDEEM_ASSETS: i128 = 1_000_000;

// Optional buffer() probe. Strategies that expose an instant buffer (the
// allocator) return it; others trap and we fall back to current_value.
#[soroban_sdk::contractclient(name = "BufferClient")]
pub trait BufferProbe {
    fn buffer(env: Env) -> i128;
}

/// A queued (async) redemption. Shares are escrowed to the vault at request
/// time and burned at claim time; the owed asset amount is priced at claim.
#[contracttype]
#[derive(Clone)]
pub struct Pending {
    pub owner: Address,
    pub shares: i128,
    pub min_out: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Asset,
    ActiveStrategy,
    StrategyRegistry,
    NextRequestId,
    Pending(u64),
    TotalPendingShares,
}

#[contract]
pub struct BakuVault;

#[contractimpl]
impl BakuVault {
    /// One-shot initialization.
    pub fn __constructor(
        env: Env,
        admin: Address,
        asset: Address,
        initial_strategy: Address,
        name: String,
        symbol: String,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage()
            .instance()
            .set(&DataKey::ActiveStrategy, &initial_strategy);

        let mut registry: Vec<Address> = Vec::new(&env);
        registry.push_back(initial_strategy);
        env.storage()
            .instance()
            .set(&DataKey::StrategyRegistry, &registry);

        // OZ Base sets the token metadata. Vault uses 7 decimals to match the
        // underlying Stellar asset convention; we do NOT add a decimal offset
        // because the virtual-shares math above provides the inflation guard
        // and a decimal offset would complicate wallet display.
        Base::set_metadata(&env, 7_u32, name, symbol);
    }

    // ----- User-facing flows -----------------------------------------------

    /// Deposit `assets` of the underlying. Mints proportional shares to the
    /// depositor. Asset is transferred depositor → strategy directly; the
    /// vault never holds the asset.
    pub fn deposit(env: Env, depositor: Address, assets: i128) -> Result<i128, VaultError> {
        depositor.require_auth();
        if assets <= 0 {
            return Err(VaultError::AmountZero);
        }
        let active = require_strategy(&env)?;
        let total_supply = Base::total_supply(&env);
        let total_assets = current_total_assets(&env, &active);
        let shares = convert_to_shares(assets, total_assets, total_supply)?;

        // Pull asset directly to strategy. Strategy then commits the deposit.
        let asset = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::Asset)
            .ok_or(VaultError::NotInitialized)?;
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&depositor, &active, &assets);

        let strat = StrategyClient::new(&env, &active);
        match strat.try_deposit(&env.current_contract_address(), &assets) {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => return Err(VaultError::StrategyFailed),
        }

        // Mint shares using OZ Base (audited). Use the privileged update path
        // — vault's own code is the only caller, no external auth needed.
        Base::update(&env, None, Some(&depositor), shares);

        Ok(shares)
    }

    /// Redeem `shares` for underlying. Strategy is asked to deliver
    /// `convert_to_assets(shares)`; whatever it actually delivers (≥
    /// `min_amount_out`) is transferred to the owner. The full `shares`
    /// amount is burned — the user takes any positive slippage above the
    /// floor.
    pub fn redeem(
        env: Env,
        owner: Address,
        shares: i128,
        min_amount_out: i128,
    ) -> Result<i128, VaultError> {
        owner.require_auth();
        if shares <= 0 {
            return Err(VaultError::AmountZero);
        }
        if Base::balance(&env, &owner) < shares {
            return Err(VaultError::InsufficientShares);
        }

        let active = require_strategy(&env)?;
        let total_supply = Base::total_supply(&env);
        let total_assets = current_total_assets(&env, &active);
        let estimated = convert_to_assets(shares, total_assets, total_supply)?;

        // Early floor check before doing the strategy call.
        if estimated < min_amount_out {
            return Err(VaultError::SlippageExceeded);
        }

        let strat = StrategyClient::new(&env, &active);
        let actual = match strat.try_withdraw(&env.current_contract_address(), &estimated) {
            Ok(Ok(amount)) => amount,
            Ok(Err(_)) | Err(_) => return Err(VaultError::StrategyFailed),
        };
        if actual < min_amount_out {
            return Err(VaultError::SlippageExceeded);
        }

        // Burn the FULL shares amount — user eats slippage above the floor.
        Base::update(&env, Some(&owner), None, shares);

        // Strategy already moved the actual amount to the vault on its way out
        // (its withdraw delivers to the vault address). Forward to user.
        let asset = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::Asset)
            .ok_or(VaultError::NotInitialized)?;
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &owner, &actual);

        Ok(actual)
    }

    /// Trigger the active strategy to compound. Permissionless — anyone can
    /// nudge accrual; no security risk because the strategy only modifies
    /// its own accounting.
    pub fn harvest(env: Env) -> Result<i128, VaultError> {
        let active = require_strategy(&env)?;
        let strat = StrategyClient::new(&env, &active);
        match strat.try_harvest(&env.current_contract_address()) {
            Ok(Ok(amount)) => Ok(amount),
            Ok(Err(_)) | Err(_) => Err(VaultError::StrategyFailed),
        }
    }

    // ----- Async redemption queue ------------------------------------------

    /// Queue an async redemption. Escrows `shares` (owner -> vault) so they keep
    /// earning yield while queued, records a pending claim, and returns its id.
    /// Light tx — no strategy calls. Funded later by an operator draining
    /// children into the allocator buffer (drain_child), then `claim_redeem`.
    pub fn request_redeem(
        env: Env,
        owner: Address,
        shares: i128,
        min_out: i128,
    ) -> Result<u64, VaultError> {
        owner.require_auth();
        if shares <= 0 {
            return Err(VaultError::AmountZero);
        }
        if Base::balance(&env, &owner) < shares {
            return Err(VaultError::InsufficientShares);
        }

        // Anti-dust / storage-griefing floor: a queued request escrows shares and
        // writes a persistent entry, so reject sub-floor requests by asset value.
        let active = require_strategy(&env)?;
        let total_supply = Base::total_supply(&env);
        let total_assets = current_total_assets(&env, &active);
        let owed = convert_to_assets(shares, total_assets, total_supply)?;
        if owed < MIN_REDEEM_ASSETS {
            return Err(VaultError::RedemptionTooSmall);
        }

        let this = env.current_contract_address();
        // Escrow: move shares owner -> vault (not burned; still in total_supply).
        Base::update(&env, Some(&owner), Some(&this), shares);

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextRequestId)
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::Pending(id),
            &Pending { owner, shares, min_out },
        );
        env.storage().instance().set(
            &DataKey::NextRequestId,
            &id.checked_add(1).ok_or(VaultError::MathOverflow)?,
        );
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalPendingShares)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalPendingShares, &(total + shares));
        Ok(id)
    }

    pub fn pending_redemption(env: Env, id: u64) -> Option<Pending> {
        env.storage().persistent().get(&DataKey::Pending(id))
    }

    pub fn total_pending_shares(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalPendingShares)
            .unwrap_or(0)
    }

    /// Fulfill a queued redemption. Prices the escrowed shares at the CURRENT
    /// price-per-share, withdraws that amount from the active strategy (for the
    /// allocator: from its native buffer — reverts if not yet funded, so the
    /// caller waits for a drain), burns the escrowed shares, and pays the owner.
    pub fn claim_redeem(env: Env, id: u64) -> Result<i128, VaultError> {
        let pending: Pending = env
            .storage()
            .persistent()
            .get(&DataKey::Pending(id))
            .ok_or(VaultError::RequestNotFound)?;
        pending.owner.require_auth();

        let active = require_strategy(&env)?;
        let total_supply = Base::total_supply(&env);
        let total_assets = current_total_assets(&env, &active);
        let owed = convert_to_assets(pending.shares, total_assets, total_supply)?;
        if owed < pending.min_out {
            return Err(VaultError::SlippageExceeded);
        }

        // CEI: commit all state effects BEFORE any external call. A reentrant
        // claim_redeem(id) now hits RequestNotFound; any later revert rolls the
        // whole tx back (removal undone), preserving the retry-after-drain path.
        let this = env.current_contract_address();
        env.storage().persistent().remove(&DataKey::Pending(id));
        let total_pending: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalPendingShares)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalPendingShares, &(total_pending - pending.shares));
        Base::update(&env, Some(&this), None, pending.shares); // burn escrow

        // Interactions.
        let strat = StrategyClient::new(&env, &active);
        let actual = match strat.try_withdraw(&this, &owed) {
            Ok(Ok(amount)) => amount,
            Ok(Err(_)) | Err(_) => return Err(VaultError::StrategyFailed),
        };
        if actual < pending.min_out {
            return Err(VaultError::SlippageExceeded);
        }
        let asset = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::Asset)
            .ok_or(VaultError::NotInitialized)?;
        token::Client::new(&env, &asset).transfer(&this, &pending.owner, &actual);
        Ok(actual)
    }

    /// Owner-only: cancel a queued redemption and return the escrowed shares.
    /// Liveness escape hatch if a claim is never funded.
    pub fn cancel_request(env: Env, id: u64) -> Result<(), VaultError> {
        let pending: Pending = env
            .storage()
            .persistent()
            .get(&DataKey::Pending(id))
            .ok_or(VaultError::RequestNotFound)?;
        pending.owner.require_auth();
        let this = env.current_contract_address();
        Base::update(&env, Some(&this), Some(&pending.owner), pending.shares);
        env.storage().persistent().remove(&DataKey::Pending(id));
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalPendingShares)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalPendingShares, &(total - pending.shares));
        Ok(())
    }

    // ----- Admin -----------------------------------------------------------

    pub fn register_strategy(
        env: Env,
        admin: Address,
        strategy: Address,
    ) -> Result<(), VaultError> {
        assert_admin(&env, &admin)?;
        let mut registry: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::StrategyRegistry)
            .unwrap_or_else(|| Vec::new(&env));
        for i in 0..registry.len() {
            if registry.get_unchecked(i) == strategy {
                return Err(VaultError::StrategyAlreadyRegistered);
            }
        }
        registry.push_back(strategy);
        env.storage()
            .instance()
            .set(&DataKey::StrategyRegistry, &registry);
        Ok(())
    }

    pub fn set_active_strategy(
        env: Env,
        admin: Address,
        new_strategy: Address,
    ) -> Result<(), VaultError> {
        assert_admin(&env, &admin)?;

        // V0 invariant: active strategy must be drained before switching.
        let current_active = require_strategy(&env)?;
        let current_value = StrategyClient::new(&env, &current_active).current_value();
        if current_value > 0 {
            return Err(VaultError::StrategyHasBalance);
        }

        // Must be a previously-registered strategy.
        let registry: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::StrategyRegistry)
            .unwrap_or_else(|| Vec::new(&env));
        let mut found = false;
        for i in 0..registry.len() {
            if registry.get_unchecked(i) == new_strategy {
                found = true;
                break;
            }
        }
        if !found {
            return Err(VaultError::StrategyNotRegistered);
        }
        env.storage()
            .instance()
            .set(&DataKey::ActiveStrategy, &new_strategy);
        Ok(())
    }

    /// Atomically rotate the vault's funds from the current active strategy
    /// into `to_strategy` and flip the active pointer.
    ///
    /// Steps (all-or-nothing within one transaction):
    ///   1. Drain current active strategy via `withdraw(self, current_value)`.
    ///      The strategy returns assets to the vault and reports the amount
    ///      actually delivered (may be < current_value for LP strategies due
    ///      to swap-back slippage).
    ///   2. Transfer the delivered amount from the vault to `to_strategy`.
    ///   3. Call `to_strategy.deposit(self, delivered)` to commit.
    ///   4. Update `ActiveStrategy` to `to_strategy`.
    ///
    /// Returns the underlying amount that actually moved between strategies.
    /// `to_strategy` MUST be registered; the V0 invariant that only the
    /// active strategy holds funds is preserved because the drain in step 1
    /// is total.
    ///
    /// Costs: every rebalance pays the round-trip cost of the from-strategy's
    /// withdraw plus the to-strategy's deposit. For LP strategies this
    /// includes the 0.30% swap fee on each side. Admin should weigh that
    /// cost against the expected APY differential.
    ///
    /// Known limitation (estimate-driven withdraw amount): step 1 drains the
    /// active strategy by calling `withdraw(self, current_value())`. For LP /
    /// swap-and-hold strategies (e.g. SoroswapStrategy) `current_value()` is an
    /// *estimate* derived from instantaneous pool reserves, not an authoritative
    /// balance. Under pool volatility the reserves can shift between the
    /// `current_value()` read and the strategy's own re-read inside `withdraw`,
    /// so the requested amount may momentarily exceed what the pool can satisfy
    /// and the withdraw reverts with `StrategyError::InsufficientLiquidity`
    /// (surfaced here as `VaultError::StrategyFailed`). This is transient and
    /// self-correcting: the admin simply retries the `rebalance` once reserves
    /// settle. No funds are at risk — the whole rotation is atomic, so a revert
    /// leaves the active strategy and balances untouched.
    pub fn rebalance(env: Env, admin: Address, to_strategy: Address) -> Result<i128, VaultError> {
        assert_admin(&env, &admin)?;

        let current_active = require_strategy(&env)?;

        // `to_strategy` must be in the registry.
        let registry: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::StrategyRegistry)
            .unwrap_or_else(|| Vec::new(&env));
        let mut found = false;
        for i in 0..registry.len() {
            if registry.get_unchecked(i) == to_strategy {
                found = true;
                break;
            }
        }
        if !found {
            return Err(VaultError::StrategyNotRegistered);
        }

        // Same-strategy rebalance is a no-op (idempotent).
        if current_active == to_strategy {
            return Ok(0);
        }

        let from_client = StrategyClient::new(&env, &current_active);
        let estimated = from_client.current_value();

        // Empty strategy: just flip the pointer, no funds to move.
        if estimated <= 0 {
            env.storage()
                .instance()
                .set(&DataKey::ActiveStrategy, &to_strategy);
            return Ok(0);
        }

        let this = env.current_contract_address();

        // Step 1: drain. Strategy.withdraw delivers to the vault and reports
        // the actually-delivered amount (may be < estimated due to slippage).
        let actual = match from_client.try_withdraw(&this, &estimated) {
            Ok(Ok(amount)) => amount,
            Ok(Err(_)) | Err(_) => return Err(VaultError::StrategyFailed),
        };
        if actual <= 0 {
            return Err(VaultError::StrategyFailed);
        }

        // Step 2: transfer the delivered amount from vault → to_strategy.
        // Mirrors the deposit flow: the asset moves to the strategy address
        // before its `deposit` is called.
        let asset = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::Asset)
            .ok_or(VaultError::NotInitialized)?;
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&this, &to_strategy, &actual);

        // Step 3: commit on the destination.
        let to_client = StrategyClient::new(&env, &to_strategy);
        match to_client.try_deposit(&this, &actual) {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => return Err(VaultError::StrategyFailed),
        }

        // Step 4: flip the active pointer. After this, future deposits and
        // redeems route through `to_strategy`.
        env.storage()
            .instance()
            .set(&DataKey::ActiveStrategy, &to_strategy);

        Ok(actual)
    }

    // ----- Views -----------------------------------------------------------

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, VaultError::NotInitialized))
    }

    pub fn underlying(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Asset)
            .unwrap_or_else(|| panic_with_error!(&env, VaultError::NotInitialized))
    }

    pub fn active_strategy(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::ActiveStrategy)
            .unwrap_or_else(|| panic_with_error!(&env, VaultError::NotInitialized))
    }

    pub fn strategy_registry(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::StrategyRegistry)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn total_assets(env: Env) -> i128 {
        match env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::ActiveStrategy)
        {
            Some(active) => current_total_assets(&env, &active),
            None => 0,
        }
    }

    pub fn price_per_share(env: Env) -> i128 {
        // Returns the value (in underlying base units) of 10^7 shares (1 token
        // unit at 7 decimals). Useful for wallet display.
        let total_supply = Base::total_supply(&env);
        let active = match env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::ActiveStrategy)
        {
            Some(a) => a,
            None => return 10_000_000,
        };
        let total_assets = current_total_assets(&env, &active);
        convert_to_assets(10_000_000, total_assets, total_supply).unwrap_or(10_000_000)
    }

    pub fn preview_deposit(env: Env, assets: i128) -> i128 {
        let total_supply = Base::total_supply(&env);
        let active = match env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::ActiveStrategy)
        {
            Some(a) => a,
            None => return 0,
        };
        let total_assets = current_total_assets(&env, &active);
        convert_to_shares(assets, total_assets, total_supply).unwrap_or(0)
    }

    pub fn preview_redeem(env: Env, shares: i128) -> i128 {
        let total_supply = Base::total_supply(&env);
        let active = match env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::ActiveStrategy)
        {
            Some(a) => a,
            None => return 0,
        };
        let total_assets = current_total_assets(&env, &active);
        convert_to_assets(shares, total_assets, total_supply).unwrap_or(0)
    }

    /// Assets the active strategy can serve in a single (light) `redeem` tx,
    /// minus assets already earmarked for queued claims (the FREE buffer).
    ///
    /// For the allocator this is its native `buffer()`; for strategies without a
    /// `buffer()` view it is the full `current_value` (they serve synchronously).
    /// Queued claims have priority over instant redeems, so we subtract the
    /// asset value already owed to pending requests — routing never sends an
    /// instant redeem into native reserved for the queue. The dApp compares this
    /// with `preview_redeem` to route redeem vs request_redeem.
    pub fn instant_redeemable_assets(env: Env) -> i128 {
        let active = match env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::ActiveStrategy)
        {
            Some(a) => a,
            None => return 0,
        };
        let total_supply = Base::total_supply(&env);
        let total_assets = current_total_assets(&env, &active);
        let raw = match BufferClient::new(&env, &active).try_buffer() {
            Ok(Ok(v)) => v,
            _ => total_assets, // strategy serves synchronously (no buffer() view)
        };
        // Subtract assets already earmarked for queued claims (priority over instant).
        let pending_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalPendingShares)
            .unwrap_or(0);
        let pending_owed = convert_to_assets(pending_shares, total_assets, total_supply).unwrap_or(0);
        let free = raw.saturating_sub(pending_owed);
        if free < 0 {
            0
        } else {
            free
        }
    }
}

// ----- SEP-41 token surface via OZ Base ---------------------------------------

#[contractimpl(contracttrait)]
impl FungibleToken for BakuVault {
    type ContractType = Base;
}

// ----- Internal helpers --------------------------------------------------------

fn assert_admin(env: &Env, caller: &Address) -> Result<(), VaultError> {
    let stored: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(VaultError::NotInitialized)?;
    if caller != &stored {
        return Err(VaultError::Unauthorized);
    }
    caller.require_auth();
    Ok(())
}

fn require_strategy(env: &Env) -> Result<Address, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::ActiveStrategy)
        .ok_or(VaultError::NotInitialized)
}

fn current_total_assets(env: &Env, strategy: &Address) -> i128 {
    StrategyClient::new(env, strategy).current_value()
}

/// `shares = assets * (total_supply + VIRTUAL_SHARES) / (total_assets + VIRTUAL_ASSETS)`
/// Rounds down. Defeats first-deposit donation attack via virtual offsets.
fn convert_to_shares(
    assets: i128,
    total_assets: i128,
    total_supply: i128,
) -> Result<i128, VaultError> {
    let numerator = assets
        .checked_mul(
            total_supply
                .checked_add(VIRTUAL_SHARES)
                .ok_or(VaultError::MathOverflow)?,
        )
        .ok_or(VaultError::MathOverflow)?;
    let denominator = total_assets
        .checked_add(VIRTUAL_ASSETS)
        .ok_or(VaultError::MathOverflow)?;
    Ok(numerator / denominator)
}

/// `assets = shares * (total_assets + VIRTUAL_ASSETS) / (total_supply + VIRTUAL_SHARES)`
/// Rounds down — protects the vault during withdrawal.
fn convert_to_assets(
    shares: i128,
    total_assets: i128,
    total_supply: i128,
) -> Result<i128, VaultError> {
    let numerator = shares
        .checked_mul(
            total_assets
                .checked_add(VIRTUAL_ASSETS)
                .ok_or(VaultError::MathOverflow)?,
        )
        .ok_or(VaultError::MathOverflow)?;
    let denominator = total_supply
        .checked_add(VIRTUAL_SHARES)
        .ok_or(VaultError::MathOverflow)?;
    Ok(numerator / denominator)
}

#[cfg(test)]
mod test;
