//! Baku Weighted Meta-Allocator Strategy. See
//! docs/superpowers/specs/2026-06-05-meta-allocator-strategy-design.md
#![no_std]

pub mod errors;
pub use errors::AllocatorError;

use baku_strategy_trait::{StrategyClient, StrategyError, StrategyInterface};
use soroban_sdk::{
    contract, contractimpl, contracttype, panic_with_error, token, Address, Env, Vec,
};

pub const MAX_CHILDREN: u32 = 5;
pub const BPS_DENOM: i128 = 10_000;

#[contracttype]
#[derive(Clone)]
pub struct ChildSlot {
    pub strategy: Address,
    pub weight_bps: u32,
    /// true only if `current_value()` is an authoritative balance (e.g. Blend),
    /// false for estimate-based LP children (e.g. Soroswap).
    pub authoritative: bool,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Vault,
    Asset,
    Children,
    NativeBps,
    PoolApyOverride,
    Paused,
}

#[contract]
pub struct BakuAllocator;

#[contractimpl]
impl BakuAllocator {
    pub fn __constructor(
        env: Env,
        admin: Address,
        vault: Address,
        asset: Address,
        initial_children: Vec<(Address, u32, bool)>,
        native_bps: u32,
    ) {
        if initial_children.len() > MAX_CHILDREN {
            panic_with_error!(&env, AllocatorError::MaxChildrenExceeded);
        }
        let mut children: Vec<ChildSlot> = Vec::new(&env);
        let mut sum: u32 = native_bps;
        for entry in initial_children.iter() {
            let (strategy, weight_bps, authoritative) = entry;
            if weight_bps > 0 && !authoritative {
                panic_with_error!(&env, AllocatorError::NotAuthoritative);
            }
            sum = sum
                .checked_add(weight_bps)
                .unwrap_or_else(|| panic_with_error!(&env, AllocatorError::MathOverflow));
            children.push_back(ChildSlot { strategy, weight_bps, authoritative });
        }
        if sum != BPS_DENOM as u32 {
            panic_with_error!(&env, AllocatorError::WeightsSumInvalid);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Vault, &vault);
        s.set(&DataKey::Asset, &asset);
        s.set(&DataKey::Children, &children);
        s.set(&DataKey::NativeBps, &native_bps);
        s.set(&DataKey::Paused, &false);
    }

    // ----- Views -----
    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, AllocatorError::NotInitialized))
    }
    pub fn vault(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Vault)
            .unwrap_or_else(|| panic_with_error!(&env, AllocatorError::NotInitialized))
    }
    pub fn underlying(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Asset)
            .unwrap_or_else(|| panic_with_error!(&env, AllocatorError::NotInitialized))
    }
    pub fn children(env: Env) -> Vec<ChildSlot> {
        env.storage().instance().get(&DataKey::Children).unwrap_or_else(|| Vec::new(&env))
    }
    pub fn native_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::NativeBps).unwrap_or(0)
    }
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    /// Instantly-withdrawable amount = the allocator's native (asset) balance.
    /// The redemption buffer. Read by the vault for instant-vs-queued routing.
    pub fn buffer(env: Env) -> i128 {
        match load_asset(&env) {
            Ok(asset) => token::Client::new(&env, &asset)
                .balance(&env.current_contract_address()),
            Err(_) => 0,
        }
    }

    pub fn add_child(env: Env, admin: Address, strategy: Address, authoritative: bool)
        -> Result<(), AllocatorError>
    {
        require_admin(&env, &admin)?;
        let mut children = load_children(&env);
        if children.len() >= MAX_CHILDREN {
            return Err(AllocatorError::MaxChildrenExceeded);
        }
        for slot in children.iter() {
            if slot.strategy == strategy { return Err(AllocatorError::ChildAlreadyExists); }
        }
        children.push_back(ChildSlot { strategy, weight_bps: 0, authoritative });
        save_children(&env, &children);
        Ok(())
    }

    pub fn remove_child(env: Env, admin: Address, strategy: Address)
        -> Result<(), AllocatorError>
    {
        require_admin(&env, &admin)?;
        let children = load_children(&env);
        let (idx, slot) = find_child(&children, &strategy)?;
        if slot.weight_bps > 0 { return Err(AllocatorError::ChildHasWeight); }
        if child_value(&env, &slot) > 0 { return Err(AllocatorError::ChildHasBalance); }
        let mut next = children.clone();
        next.remove(idx);
        save_children(&env, &next);
        Ok(())
    }

    /// Evict a wedged/panicking child without reading its value. Requires
    /// weight 0. KNOWN LIMITATION: any funds still held by the child are abandoned.
    pub fn force_remove_child(env: Env, admin: Address, strategy: Address)
        -> Result<(), AllocatorError>
    {
        require_admin(&env, &admin)?;
        let children = load_children(&env);
        let (idx, slot) = find_child(&children, &strategy)?;
        if slot.weight_bps > 0 { return Err(AllocatorError::ChildHasWeight); }
        let mut next = children.clone();
        next.remove(idx);
        save_children(&env, &next);
        Ok(())
    }

    pub fn set_paused(env: Env, admin: Address, paused: bool) -> Result<(), AllocatorError> {
        require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    /// Test/init helper to rewire the authorized vault (mirrors MockStrategy::set_vault).
    pub fn set_vault(env: Env, admin: Address, new_vault: Address) -> Result<(), AllocatorError> {
        require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Vault, &new_vault);
        Ok(())
    }

    pub fn set_target_weights(
        env: Env,
        admin: Address,
        child_weights: Vec<(Address, u32)>,
        native_bps: u32,
    ) -> Result<(), AllocatorError> {
        require_admin(&env, &admin)?;
        let mut children = load_children(&env);
        // Reset all weights to 0, then apply the requested set.
        for i in 0..children.len() {
            let mut slot = children.get_unchecked(i);
            slot.weight_bps = 0;
            children.set(i, slot);
        }
        let mut sum: u32 = native_bps;
        for entry in child_weights.iter() {
            let (strategy, weight_bps) = entry;
            let (idx, mut slot) = find_child(&children, &strategy)?;
            if weight_bps > 0 && !slot.authoritative {
                return Err(AllocatorError::NotAuthoritative);
            }
            slot.weight_bps = weight_bps;
            children.set(idx, slot);
            sum = sum.checked_add(weight_bps).ok_or(AllocatorError::MathOverflow)?;
        }
        if sum != BPS_DENOM as u32 { return Err(AllocatorError::WeightsSumInvalid); }
        save_children(&env, &children);
        env.storage().instance().set(&DataKey::NativeBps, &native_bps);
        Ok(())
    }

    /// Admin: pull exactly `amount` of the underlying out of ONE child into the
    /// native buffer. One heavy protocol per tx — the memory-safe building block
    /// the vault's redemption queue uses to fund large claims. Returns the
    /// measured amount the child delivered.
    pub fn drain_child(env: Env, admin: Address, child: Address, amount: i128)
        -> Result<i128, AllocatorError>
    {
        require_admin(&env, &admin)?;
        require_not_paused(&env)?;
        if amount <= 0 { return Err(AllocatorError::AmountZero); }
        let children = load_children(&env);
        let (_idx, slot) = find_child(&children, &child)?;
        let asset = load_asset(&env)?;
        let token_client = token::Client::new(&env, &asset);
        let this = env.current_contract_address();
        let pre = token_client.balance(&this);
        let sc = StrategyClient::new(&env, &slot.strategy);
        match sc.try_withdraw(&this, &amount) {
            Ok(Ok(_)) => {}
            _ => return Err(AllocatorError::ChildWithdrawFailed),
        }
        let post = token_client.balance(&this);
        post.checked_sub(pre).ok_or(AllocatorError::MathOverflow)
    }

    /// Admin: push `amount` of native into ONE child (transfer + child.deposit).
    /// One heavy protocol per tx. Used with rebalance_step to restore weights.
    pub fn fund_child(env: Env, admin: Address, child: Address, amount: i128)
        -> Result<(), AllocatorError>
    {
        require_admin(&env, &admin)?;
        require_not_paused(&env)?;
        if amount <= 0 { return Err(AllocatorError::AmountZero); }
        let asset = load_asset(&env)?;
        let token_client = token::Client::new(&env, &asset);
        let this = env.current_contract_address();
        if token_client.balance(&this) < amount {
            return Err(AllocatorError::InsufficientBuffer);
        }
        let children = load_children(&env);
        let (_idx, slot) = find_child(&children, &child)?;
        token_client.transfer(&this, &slot.strategy, &amount);
        let sc = StrategyClient::new(&env, &slot.strategy);
        match sc.try_deposit(&this, &amount) {
            Ok(Ok(())) => Ok(()),
            _ => Err(AllocatorError::ChildDepositFailed),
        }
    }

    /// Admin: bring ONE child to its target weight in a single tx (drain excess
    /// to native, or fund deficit from native, capped at the buffer). Calling it
    /// for each weighted child completes a full 30/40/30 restore across txs and
    /// refills the buffer after redemptions. Memory-safe: a value pass + ONE
    /// child's drain/fund. The one-shot `rebalance` is NOT usable for a Blend+LP
    /// basket (exceeds memory); use this instead.
    pub fn rebalance_step(env: Env, admin: Address, child: Address)
        -> Result<(), AllocatorError>
    {
        require_admin(&env, &admin)?;
        require_not_paused(&env)?;
        let asset = load_asset(&env)?;
        let token_client = token::Client::new(&env, &asset);
        let this = env.current_contract_address();
        let children = load_children(&env);
        let (_idx, slot) = find_child(&children, &child)?;

        let mut total: i128 = token_client.balance(&this);
        for s in children.iter() {
            total = total
                .checked_add(child_value(&env, &s))
                .ok_or(AllocatorError::MathOverflow)?;
        }
        if total <= 0 { return Ok(()); }

        let target = mul_div(total, slot.weight_bps as i128, BPS_DENOM)?;
        let cv = child_value(&env, &slot);
        let sc = StrategyClient::new(&env, &slot.strategy);
        if cv > target {
            let excess = cv - target;
            if excess > 0 {
                match sc.try_withdraw(&this, &excess) {
                    Ok(Ok(_)) => {}
                    _ => return Err(AllocatorError::ChildWithdrawFailed),
                }
            }
        } else if target > cv {
            let deficit = target - cv;
            let native = token_client.balance(&this);
            let fund = if deficit > native { native } else { deficit };
            if fund > 0 {
                token_client.transfer(&this, &slot.strategy, &fund);
                match sc.try_deposit(&this, &fund) {
                    Ok(Ok(())) => {}
                    _ => return Err(AllocatorError::ChildDepositFailed),
                }
            }
        }
        Ok(())
    }

    /// Two-pass atomic rebalance to target weights:
    ///   Pass 1: drain every OVERWEIGHT child's excess into the native sleeve.
    ///   Pass 2: fund every UNDERWEIGHT child's deficit from the native sleeve.
    /// All-or-nothing in one tx. Transient note: for LP children, current_value
    /// is an estimate; a drain can revert (child InsufficientLiquidity) under
    /// reserve shift — admin retries once reserves settle. In V0 only
    /// authoritative (Blend) children carry weight, so no AMM swap leg.
    pub fn rebalance(env: Env, admin: Address) -> Result<(), AllocatorError> {
        require_admin(&env, &admin)?;
        require_not_paused(&env)?;
        let asset = load_asset(&env)?;
        let token_client = token::Client::new(&env, &asset);
        let this = env.current_contract_address();
        let children = load_children(&env);

        // Total across children + native sleeve.
        let mut values: Vec<i128> = Vec::new(&env);
        let mut total: i128 = token_client.balance(&this);
        for slot in children.iter() {
            let v = child_value(&env, &slot);
            values.push_back(v);
            total = total.checked_add(v).ok_or(AllocatorError::MathOverflow)?;
        }
        if total <= 0 { return Ok(()); } // nothing to move

        // Pass 1: drain overweight children into native.
        for i in 0..children.len() {
            let slot = children.get_unchecked(i);
            let cv = values.get_unchecked(i);
            let target = mul_div(total, slot.weight_bps as i128, BPS_DENOM)?;
            if cv > target {
                let excess = cv - target;
                if excess <= 0 { continue; }
                let child = StrategyClient::new(&env, &slot.strategy);
                match child.try_withdraw(&this, &excess) {
                    Ok(Ok(_)) => {}
                    _ => return Err(AllocatorError::ChildWithdrawFailed),
                }
            }
        }

        // Pass 2: fund underweight children from native.
        for i in 0..children.len() {
            let slot = children.get_unchecked(i);
            let cv = values.get_unchecked(i);
            let target = mul_div(total, slot.weight_bps as i128, BPS_DENOM)?;
            if target > cv {
                let deficit = target - cv;
                if deficit <= 0 { continue; }
                token_client.transfer(&this, &slot.strategy, &deficit);
                let child = StrategyClient::new(&env, &slot.strategy);
                match child.try_deposit(&this, &deficit) {
                    Ok(Ok(())) => {}
                    _ => return Err(AllocatorError::ChildDepositFailed),
                }
            }
        }
        Ok(())
    }
}

#[contractimpl]
impl StrategyInterface for BakuAllocator {
    fn deposit(env: Env, vault: Address, amount: i128) -> Result<(), StrategyError> {
        if require_not_paused(&env).is_err() { return Err(map_alloc(AllocatorError::Paused)); }
        assert_vault(&env, &vault).map_err(map_alloc)?;
        if amount <= 0 { return Err(StrategyError::InvalidAmount); }

        let asset = load_asset(&env).map_err(map_alloc)?;
        let token_client = token::Client::new(&env, &asset);
        let this = env.current_contract_address();
        let children = load_children(&env);

        for slot in children.iter() {
            if slot.weight_bps == 0 { continue; }
            let slice = mul_div(amount, slot.weight_bps as i128, BPS_DENOM).map_err(map_alloc)?;
            if slice <= 0 { continue; } // skip zero portions
            token_client.transfer(&this, &slot.strategy, &slice);
            let child = StrategyClient::new(&env, &slot.strategy);
            match child.try_deposit(&this, &slice) {
                Ok(Ok(())) => {}
                _ => return Err(map_alloc(AllocatorError::ChildDepositFailed)),
            }
        }
        // Native slice stays as the allocator's raw balance. No action needed.
        Ok(())
    }
    fn withdraw(env: Env, vault: Address, amount: i128) -> Result<i128, StrategyError> {
        if require_not_paused(&env).is_err() {
            return Err(map_alloc(AllocatorError::Paused));
        }
        assert_vault(&env, &vault).map_err(map_alloc)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }
        // Native-buffer-only. Pulling pro-rata from children here would load
        // Blend pool + Soroswap router/pair in one tx and exceed Soroban's
        // per-tx memory. Redemptions beyond the buffer go through the vault's
        // queue (request_redeem) funded by per-child drain_child across txs.
        let asset = load_asset(&env).map_err(map_alloc)?;
        let token_client = token::Client::new(&env, &asset);
        let this = env.current_contract_address();
        let native = token_client.balance(&this);
        if amount > native {
            return Err(map_alloc(AllocatorError::InsufficientBuffer));
        }
        token_client.transfer(&this, &vault, &amount);
        Ok(amount)
    }
    fn current_value(env: Env) -> i128 {
        let children = load_children(&env);
        let mut total: i128 = 0;
        for slot in children.iter() {
            total = total.saturating_add(child_value(&env, &slot));
        }
        let raw = match load_asset(&env) {
            Ok(asset) => token::Client::new(&env, &asset)
                .balance(&env.current_contract_address()),
            Err(_) => 0,
        };
        total.saturating_add(raw)
    }
    fn harvest(env: Env, vault: Address) -> Result<i128, StrategyError> {
        assert_vault(&env, &vault).map_err(map_alloc)?;
        let this = env.current_contract_address();
        let children = load_children(&env);
        let mut total: i128 = 0;
        for slot in children.iter() {
            let child = StrategyClient::new(&env, &slot.strategy);
            if let Ok(Ok(amount)) = child.try_harvest(&this) {
                total = total.saturating_add(amount);
            }
        }
        Ok(total) // informational only; never fed into price-per-share
    }

    fn pool_apy(env: Env) -> u32 {
        if let Some(override_bps) = env.storage().instance()
            .get::<_, u32>(&DataKey::PoolApyOverride)
        {
            return override_bps;
        }
        let children = load_children(&env);
        let mut acc: u64 = 0;
        for slot in children.iter() {
            let child = StrategyClient::new(&env, &slot.strategy);
            let apy = match child.try_pool_apy() { Ok(Ok(v)) => v, _ => 0 };
            acc += (apy as u64) * (slot.weight_bps as u64);
        }
        (acc / (BPS_DENOM as u64)) as u32
    }

    fn set_pool_apy_bps(env: Env, admin: Address, bps: u32) -> Result<(), StrategyError> {
        require_admin(&env, &admin).map_err(map_alloc)?;
        if bps > 10_000 { return Err(StrategyError::InvalidApyBps); }
        env.storage().instance().set(&DataKey::PoolApyOverride, &bps);
        Ok(())
    }
}

/// The StrategyInterface trait returns StrategyError. We surface allocator-specific
/// deposit/withdraw failures as PoolError so the vault's try_deposit/try_withdraw
/// match arms treat them as StrategyFailed. (Admin/view paths use AllocatorError
/// codes directly.) V0 coarseness is intentional — see the plan footer.
fn map_alloc(_e: AllocatorError) -> StrategyError {
    StrategyError::PoolError
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), AllocatorError> {
    let stored: Address = env.storage().instance().get(&DataKey::Admin)
        .ok_or(AllocatorError::NotInitialized)?;
    if *caller != stored { return Err(AllocatorError::AdminOnly); }
    caller.require_auth();
    Ok(())
}

fn assert_vault(env: &Env, caller: &Address) -> Result<(), AllocatorError> {
    let vault: Address = env.storage().instance().get(&DataKey::Vault)
        .ok_or(AllocatorError::NotInitialized)?;
    if *caller != vault { return Err(AllocatorError::Unauthorized); }
    caller.require_auth();
    Ok(())
}

fn load_children(env: &Env) -> Vec<ChildSlot> {
    env.storage().instance().get(&DataKey::Children).unwrap_or_else(|| Vec::new(env))
}
fn save_children(env: &Env, children: &Vec<ChildSlot>) {
    env.storage().instance().set(&DataKey::Children, children);
}
fn load_asset(env: &Env) -> Result<Address, AllocatorError> {
    env.storage().instance().get(&DataKey::Asset).ok_or(AllocatorError::NotInitialized)
}
fn require_not_paused(env: &Env) -> Result<(), AllocatorError> {
    let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
    if paused { return Err(AllocatorError::Paused); }
    Ok(())
}

/// `a * b / denom` with checked multiply. `denom` must be > 0 (caller guarantees).
fn mul_div(a: i128, b: i128, denom: i128) -> Result<i128, AllocatorError> {
    let prod = a.checked_mul(b).ok_or(AllocatorError::MathOverflow)?;
    prod.checked_div(denom).ok_or(AllocatorError::MathOverflow)
}

/// Read a child's value: authoritative children MUST succeed (fail-closed —
/// panics propagate to the vault and revert deposit/redeem). Non-authoritative
/// read failures degrade to 0 (they should hold ~no funds anyway).
fn child_value(env: &Env, slot: &ChildSlot) -> i128 {
    let client = StrategyClient::new(env, &slot.strategy);
    match client.try_current_value() {
        Ok(Ok(v)) => v,
        _ => {
            if slot.authoritative {
                panic_with_error!(env, AllocatorError::ChildWithdrawFailed);
            }
            0
        }
    }
}

fn find_child(children: &Vec<ChildSlot>, strategy: &Address)
    -> Result<(u32, ChildSlot), AllocatorError>
{
    for i in 0..children.len() {
        let slot = children.get_unchecked(i);
        if &slot.strategy == strategy { return Ok((i, slot)); }
    }
    Err(AllocatorError::UnknownChild)
}

mod test;
mod test_lp;
