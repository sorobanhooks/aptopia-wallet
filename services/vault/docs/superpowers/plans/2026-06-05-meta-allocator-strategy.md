# Meta-Allocator Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `baku-allocator-strategy`, a Soroban contract that implements `StrategyInterface` and splits a single deposit across N child strategies + a native cash sleeve by configurable weights — so the vault can hold a blended allocation without any change to the audited vault.

**Architecture:** The allocator is a router, not a share token. The parent `BakuVault` calls it through `StrategyClient` exactly like any strategy; internally it deposits pro-rata by target weight, withdraws pro-rata by current value (returning a *measured* balance delta), and exposes admin weight/rebalance/child-management. All cross-child reads use `try_*` so one bad child can't brick the vault; an `authoritative_value` flag + an admin pause keep pricing fail-closed.

**Tech Stack:** Rust `no_std`, `soroban-sdk = 25.3.1`, `baku-strategy-trait` (the `StrategyInterface` + generated `StrategyClient`). Tests use `soroban-sdk` testutils, `baku-mock-strategy` as faithful children, and `baku-soroswap-strategy` against a seeded test pool for slippage paths.

**Spec:** `docs/superpowers/specs/2026-06-05-meta-allocator-strategy-design.md`

---

## File Structure

- Create `crates/allocator-strategy/Cargo.toml` — crate manifest (mirrors `crates/mock-strategy/Cargo.toml`).
- Create `crates/allocator-strategy/src/errors.rs` — `AllocatorError` (one responsibility: typed errors).
- Create `crates/allocator-strategy/src/lib.rs` — the contract (storage, constructor, core `StrategyInterface`, admin methods, internal helpers).
- Create `crates/allocator-strategy/src/test.rs` — unit + vault-integration tests using mock children.
- Create `crates/allocator-strategy/src/test_lp.rs` — integration tests using the real `soroswap-strategy` (slippage / TOCTOU / rebalance-shortfall).
- Modify `Cargo.toml` (root) — add the workspace member + a `baku-allocator-strategy` workspace dependency entry.

**Invariants enforced everywhere weights mutate:**
`sum(child.weight_bps) + native_bps == 10_000`; `weight_bps > 0 ⟹ authoritative`; `children.len() <= MAX_CHILDREN (5)`.

---

## Task 1: Crate scaffold + errors + workspace registration

**Files:**
- Create: `crates/allocator-strategy/Cargo.toml`
- Create: `crates/allocator-strategy/src/errors.rs`
- Create: `crates/allocator-strategy/src/lib.rs`
- Modify: `Cargo.toml` (root)

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "baku-allocator-strategy"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
repository.workspace = true
description = "Weighted meta-allocator Strategy. Splits one deposit across N child strategies + a native sleeve by configurable bps weights."

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
soroban-sdk = { workspace = true }
baku-strategy-trait = { workspace = true }

[dev-dependencies]
soroban-sdk = { workspace = true, features = ["testutils"] }
baku-mock-strategy = { workspace = true }
baku-soroswap-strategy = { workspace = true }
baku-vault = { workspace = true }
```

- [ ] **Step 2: Write `src/errors.rs`**

```rust
//! Typed allocator errors. Disjoint from `StrategyError` and `VaultError`.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AllocatorError {
    /// Contract not initialized.
    NotInitialized = 1,
    /// Caller is not the expected vault (core fns) — distinct from AdminOnly.
    Unauthorized = 2,
    /// Caller is not the allocator's admin.
    AdminOnly = 3,
    /// Deposit / withdraw amount is zero or negative.
    AmountZero = 4,
    /// child weights + native_bps != 10_000.
    WeightsSumInvalid = 5,
    /// Referenced child address is not registered.
    UnknownChild = 6,
    /// Child already registered.
    ChildAlreadyExists = 7,
    /// remove_child while the child still holds target weight > 0.
    ChildHasWeight = 8,
    /// remove_child while the child still holds value > 0.
    ChildHasBalance = 9,
    /// A child.deposit sub-call failed.
    ChildDepositFailed = 10,
    /// A child.withdraw sub-call failed.
    ChildWithdrawFailed = 11,
    /// Adding a child would exceed MAX_CHILDREN.
    MaxChildrenExceeded = 12,
    /// Checked arithmetic overflowed.
    MathOverflow = 13,
    /// Non-authoritative child cannot hold weight > 0.
    NotAuthoritative = 14,
    /// Contract is paused (circuit breaker).
    Paused = 15,
    /// Total basket value is zero; cannot split a withdraw.
    EmptyBasket = 16,
}
```

- [ ] **Step 3: Write a minimal `src/lib.rs` that compiles**

```rust
//! Baku Weighted Meta-Allocator Strategy. See
//! docs/superpowers/specs/2026-06-05-meta-allocator-strategy-design.md
#![no_std]

pub mod errors;
pub use errors::AllocatorError;

use soroban_sdk::{contract, contractimpl};

#[contract]
pub struct BakuAllocator;

#[contractimpl]
impl BakuAllocator {}
```

- [ ] **Step 4: Register the crate in the root `Cargo.toml`**

In `[workspace] members` add `"crates/allocator-strategy",`. In `[workspace.dependencies]` (Internal crates block) add:
```toml
baku-allocator-strategy = { path = "crates/allocator-strategy" }
```

- [ ] **Step 5: Verify it compiles**

Run: `cargo build -p baku-allocator-strategy`
Expected: builds clean (warnings about unused are fine).

- [ ] **Step 6: Commit**

```bash
git add crates/allocator-strategy/Cargo.toml crates/allocator-strategy/src/errors.rs crates/allocator-strategy/src/lib.rs Cargo.toml
git commit -m "feat(allocator): scaffold baku-allocator-strategy crate + AllocatorError"
```

---

## Task 2: Storage model, constructor, view getters

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`
- Test: `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write the failing test** (create `src/test.rs`)

```rust
#![cfg(test)]
use crate::{BakuAllocator, BakuAllocatorClient};
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
fn constructor_stores_config() {
    let ctx = setup(10_000);
    assert_eq!(ctx.allocator.admin(), ctx.admin);
    assert_eq!(ctx.allocator.vault(), ctx.vault);
    assert_eq!(ctx.allocator.underlying(), ctx.asset);
    assert_eq!(ctx.allocator.native_bps(), 10_000);
    assert_eq!(ctx.allocator.children().len(), 0);
    assert_eq!(ctx.allocator.is_paused(), false);
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
    // native_bps 9_999 with no children → sum 9_999 != 10_000.
    env.register(BakuAllocator, (admin, vault, asset, empty, 9_999_u32));
}
```

Wire the module: add `mod test;` to the bottom of `src/lib.rs`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p baku-allocator-strategy constructor_stores_config`
Expected: FAIL — `admin`/`vault`/etc. methods and `ChildSlot` don't exist yet.

- [ ] **Step 3: Implement storage, `ChildSlot`, constructor, getters**

Replace `src/lib.rs` body (keep the header + `pub mod errors`):

```rust
#![no_std]

pub mod errors;
pub use errors::AllocatorError;

use baku_strategy_trait::StrategyClient;
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
}

mod test;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p baku-allocator-strategy constructor_`
Expected: both `constructor_stores_config` and `constructor_rejects_bad_weight_sum` PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): storage model, constructor with invariant validation, views"
```

---

## Task 3: Internal helpers — auth, child lookup, checked mul_div

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`

These are consumed by later tasks; tested indirectly through them. No standalone test task — they have no externally observable behavior.

- [ ] **Step 1: Add helpers above `mod test;`**

```rust
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
```

- [ ] **Step 2: Verify it still compiles**

Run: `cargo build -p baku-allocator-strategy`
Expected: builds (helpers may warn as unused until later tasks use them — acceptable mid-plan).

- [ ] **Step 3: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs
git commit -m "feat(allocator): internal auth/lookup/checked-math helpers"
```

---

## Task 4: `current_value()` (try_ fan-out, fail-closed)

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`
- Test: `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write the failing test** (append to `src/test.rs`)

Add a helper that registers a mock child and funds the allocator's raw balance:

```rust
use baku_mock_strategy::{MockStrategy, MockStrategyClient};

/// Register a MockStrategy child whose authorized vault is the allocator.
pub(crate) fn add_mock_child(ctx: &Ctx, deposit_into: i128) -> Address {
    let child_admin = Address::generate(&ctx.env);
    let child = ctx.env.register(
        MockStrategy,
        (child_admin.clone(), ctx.allocator_id.clone(), ctx.asset.clone(), 500_u32),
    );
    if deposit_into > 0 {
        // Fund the child contract and record its internal balance.
        ctx.asset_minter.mint(&child, &deposit_into);
        MockStrategyClient::new(&ctx.env, &child).deposit(&ctx.allocator_id, &deposit_into);
    }
    child
}

#[test]
fn current_value_sums_children_plus_native() {
    let ctx = setup(10_000);
    // Give the allocator a native sleeve of 300 raw underlying.
    ctx.asset_minter.mint(&ctx.allocator_id, &300_i128);
    // Two mock children holding 1_000 and 700.
    let c1 = add_mock_child(&ctx, 1_000);
    let c2 = add_mock_child(&ctx, 700);
    // Register them via admin (weight 0 is fine for a pure valuation test).
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    assert_eq!(ctx.allocator.current_value(), 300 + 1_000 + 700);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p baku-allocator-strategy current_value_sums`
Expected: FAIL — `current_value` and `add_child` not implemented (compile error).

- [ ] **Step 3: Implement `current_value` in the `StrategyInterface` impl**

Add the trait impl block (other trait methods are stubbed in later tasks; implement them as `unimplemented!()`-free minimal stubs so the trait is satisfied — see note). Add to `src/lib.rs`:

```rust
use baku_strategy_trait::{StrategyError, StrategyInterface};

#[contractimpl]
impl StrategyInterface for BakuAllocator {
    fn deposit(_env: Env, _vault: Address, _amount: i128) -> Result<(), StrategyError> {
        // Implemented in Task 6.
        Err(StrategyError::PoolError)
    }
    fn withdraw(_env: Env, _vault: Address, _amount: i128) -> Result<i128, StrategyError> {
        // Implemented in Task 7.
        Err(StrategyError::PoolError)
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
    fn harvest(_env: Env, _vault: Address) -> Result<i128, StrategyError> {
        // Implemented in Task 8.
        Ok(0)
    }
    fn pool_apy(_env: Env) -> u32 {
        // Implemented in Task 8.
        0
    }
    fn set_pool_apy_bps(env: Env, admin: Address, bps: u32) -> Result<(), StrategyError> {
        // Implemented in Task 8 (stub keeps trait satisfied).
        let _ = (&env, &admin, bps);
        Ok(())
    }
}
```

> Note: `add_child` is implemented in Task 5; for this test to compile you may temporarily run Task 5 Step 3 first, or stub `add_child`. If executing strictly in order, move the `current_value_sums_children_plus_native` test's `add_child` calls into Task 5 and assert `current_value` here against children seeded directly via the constructor instead. The reviewer should keep tasks 4 and 5 together in one subagent turn.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p baku-allocator-strategy current_value_sums`
Expected: PASS (after Task 5's `add_child` lands).

- [ ] **Step 5: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): current_value with try_ fan-out + fail-closed authoritative reads"
```

---

## Task 5: Child management — add / remove / force_remove / set_paused / set_pool_apy

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`
- Test: `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write the failing tests** (append to `src/test.rs`)

```rust
#[test]
fn add_child_appends_with_zero_weight() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    let kids = ctx.allocator.children();
    assert_eq!(kids.len(), 1);
    assert_eq!(kids.get(0).unwrap().weight_bps, 0);
    assert_eq!(kids.get(0).unwrap().authoritative, true);
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
    let c1 = add_mock_child(&ctx, 500); // holds 500
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
    assert_eq!(ctx.allocator.is_paused(), true);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p baku-allocator-strategy child`
Expected: FAIL — methods not implemented.

- [ ] **Step 3: Implement the admin methods** (add to the `impl BakuAllocator` block)

```rust
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
    /// weight 0 (set it via set_target_weights first). KNOWN LIMITATION: any
    /// funds still held by the child are abandoned.
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
```

Add the `find_child` helper near the other helpers:

```rust
fn find_child(children: &Vec<ChildSlot>, strategy: &Address)
    -> Result<(u32, ChildSlot), AllocatorError>
{
    for i in 0..children.len() {
        let slot = children.get_unchecked(i);
        if &slot.strategy == strategy { return Ok((i, slot)); }
    }
    Err(AllocatorError::UnknownChild)
}
```

- [ ] **Step 4: Run to verify they pass** (and the Task 4 valuation test)

Run: `cargo test -p baku-allocator-strategy`
Expected: child-management + `current_value_sums_children_plus_native` PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): child lifecycle (add/remove/force_remove) + pause + set_vault"
```

---

## Task 6: `set_target_weights` (sum + authoritative guard)

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`
- Test: `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write the failing tests**

```rust
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p baku-allocator-strategy set_target_weights`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement `set_target_weights`** (add to `impl BakuAllocator`)

```rust
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test -p baku-allocator-strategy set_target_weights`
Expected: all 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): set_target_weights with sum + authoritative + unknown-child guards"
```

---

## Task 7: `deposit` (pro-rata by weight, checked, skip-zero, dust→native)

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`
- Test: `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn deposit_splits_pro_rata_dust_to_native() {
    let ctx = setup(3_000); // native target 30%
    let c1 = add_mock_child(&ctx, 0);
    let c2 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 3_000_u32), (c2.clone(), 4_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &3_000_u32);

    // Vault transfers the deposit to the allocator first (mirrors vault.deposit).
    ctx.asset_minter.mint(&ctx.vault, &1_001_i128);
    ctx.asset_token.transfer(&ctx.vault, &ctx.allocator_id, &1_001_i128);
    let shares_irrelevant = ctx.allocator.deposit(&ctx.vault, &1_001_i128);
    let _ = shares_irrelevant;

    // c1 = 1_001*3000/10000 = 300; c2 = 1_001*4000/10000 = 400; native = 1_001-700 = 301.
    assert_eq!(MockStrategyClient::new(&ctx.env, &c1).current_value(), 300);
    assert_eq!(MockStrategyClient::new(&ctx.env, &c2).current_value(), 400);
    assert_eq!(ctx.asset_token.balance(&ctx.allocator_id), 301);
    // current_value reflects the whole basket.
    assert_eq!(ctx.allocator.current_value(), 1_001);
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")] // Paused
fn deposit_reverts_when_paused() {
    let ctx = setup(10_000);
    ctx.allocator.set_paused(&ctx.admin, &true);
    ctx.asset_minter.mint(&ctx.allocator_id, &100_i128);
    ctx.allocator.deposit(&ctx.vault, &100_i128);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p baku-allocator-strategy deposit_`
Expected: FAIL — deposit returns `PoolError` stub.

- [ ] **Step 3: Implement `deposit`** (replace the stub in the `StrategyInterface` impl)

```rust
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
        // Native slice = whatever was not routed to children; already sitting in
        // `this` as raw balance. No action needed.
        Ok(())
    }
```

Add the error-mapping helper near the other helpers (maps allocator errors onto the `StrategyError` surface the vault expects, since the trait signature returns `StrategyError`):

```rust
/// The trait returns StrategyError. We surface allocator-specific failures as
/// PoolError so the vault's `try_deposit`/`try_withdraw` match arms treat them
/// as StrategyFailed — except the cases the vault inspects directly. Tests assert
/// the *allocator's* own panics (admin/view paths) which use AllocatorError codes.
fn map_alloc(_e: AllocatorError) -> StrategyError {
    StrategyError::PoolError
}
```

> IMPORTANT (re-derive before coding): the `#[should_panic]` codes in the deposit/withdraw *core-path* tests must match what actually surfaces. Because the trait returns `StrategyError`, a paused/auth failure on `deposit` surfaces as `StrategyError` (PoolError=3 / Unauthorized=1), NOT `AllocatorError`. Adjust the `deposit_reverts_when_paused` expected code to the real surfaced code: run the test once, read the actual `Error(Contract, #N)`, and set the annotation to that N with a comment. Do not guess — the harness prints the real code on failure. (Admin-only methods like `add_child` DO surface `AllocatorError` codes, which is why Task 5's annotations use them.)

- [ ] **Step 4: Run to verify it passes** (fix the should_panic code per the note)

Run: `cargo test -p baku-allocator-strategy deposit_`
Expected: `deposit_splits_pro_rata_dust_to_native` PASS; `deposit_reverts_when_paused` PASS after the code annotation is corrected to the surfaced value.

- [ ] **Step 5: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): deposit — pro-rata split, checked math, skip-zero, dust to native, pause"
```

---

## Task 8: `withdraw` (measured delta, single cv pass, clamp, total<=0 guard)

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`
- Test: `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn withdraw_pro_rata_by_value_returns_measured() {
    let ctx = setup(3_000);
    let c1 = add_mock_child(&ctx, 0);
    let c2 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 3_000_u32), (c2.clone(), 4_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &3_000_u32);

    // Deposit 1_000: c1=300, c2=400, native=300.
    ctx.asset_minter.mint(&ctx.vault, &1_000_i128);
    ctx.asset_token.transfer(&ctx.vault, &ctx.allocator_id, &1_000_i128);
    ctx.allocator.deposit(&ctx.vault, &1_000_i128);

    // Withdraw 500 (half of total 1_000). Pro-rata by value:
    //   c1: 500*300/1000=150, c2: 500*400/1000=200, native: 500*300/1000=150.
    let delivered = ctx.allocator.withdraw(&ctx.vault, &500_i128);
    assert_eq!(delivered, 500); // mock delivers exactly; measured == requested here
    assert_eq!(MockStrategyClient::new(&ctx.env, &c1).current_value(), 150);
    assert_eq!(MockStrategyClient::new(&ctx.env, &c2).current_value(), 200);
    // Vault received the 500.
    assert_eq!(ctx.asset_token.balance(&ctx.vault), 500);
    // Allocator retains native sleeve 300-150 = 150.
    assert_eq!(ctx.asset_token.balance(&ctx.allocator_id), 150);
}

#[test]
#[should_panic(expected = "Error(Contract, #")] // EmptyBasket surfaced via StrategyError — see note
fn withdraw_empty_basket_guarded() {
    let ctx = setup(10_000);
    // No funds anywhere: total == 0.
    ctx.allocator.withdraw(&ctx.vault, &100_i128);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p baku-allocator-strategy withdraw_`
Expected: FAIL — withdraw returns `PoolError` stub.

- [ ] **Step 3: Implement `withdraw`** (replace the stub)

```rust
    fn withdraw(env: Env, vault: Address, amount: i128) -> Result<i128, StrategyError> {
        if require_not_paused(&env).is_err() { return Err(map_alloc(AllocatorError::Paused)); }
        assert_vault(&env, &vault).map_err(map_alloc)?;
        if amount <= 0 { return Err(StrategyError::InvalidAmount); }

        let asset = load_asset(&env).map_err(map_alloc)?;
        let token_client = token::Client::new(&env, &asset);
        let this = env.current_contract_address();
        let children = load_children(&env);

        let pre = token_client.balance(&this);          // includes the native sleeve
        let native_balance = pre;

        // Single value pass.
        let mut child_values: Vec<i128> = Vec::new(&env);
        let mut total: i128 = native_balance;
        for slot in children.iter() {
            let v = child_value(&env, &slot);
            child_values.push_back(v);
            total = total.checked_add(v).ok_or(map_alloc(AllocatorError::MathOverflow))?;
        }
        if total <= 0 { return Err(map_alloc(AllocatorError::EmptyBasket)); }

        // Pull pro-rata from children, clamped to just-read value (TOCTOU guard).
        for i in 0..children.len() {
            let slot = children.get_unchecked(i);
            let cv = child_values.get_unchecked(i);
            if cv <= 0 { continue; }
            let want = mul_div(amount, cv, total).map_err(map_alloc)?;
            let req = if want > cv { cv } else { want };
            if req <= 0 { continue; }              // skip zero portions
            let child = StrategyClient::new(&env, &slot.strategy);
            match child.try_withdraw(&this, &req) {
                Ok(Ok(_delivered)) => {}           // delivered measured below via balance delta
                _ => return Err(map_alloc(AllocatorError::ChildWithdrawFailed)),
            }
        }

        let native_portion = mul_div(amount, native_balance, total).map_err(map_alloc)?;
        let post = token_client.balance(&this);
        // delivered_from_children = post - pre; native_portion already in `pre`.
        let actual = (post - pre)
            .checked_add(native_portion)
            .ok_or(map_alloc(AllocatorError::MathOverflow))?;
        if actual <= 0 { return Err(map_alloc(AllocatorError::EmptyBasket)); }

        token_client.transfer(&this, &vault, &actual);
        Ok(actual)
    }
```

> Re-derive the `withdraw_empty_basket_guarded` panic code the same way as Task 7 (it surfaces through `StrategyError`). Run once, read the real `#N`, set it.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p baku-allocator-strategy withdraw_`
Expected: both PASS (after the panic-code annotation is corrected).

- [ ] **Step 5: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): withdraw — measured delta, single cv pass, clamp, total<=0 guard"
```

---

## Task 9: `harvest` + `pool_apy` (try_, best-effort, display-only)

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`
- Test: `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn pool_apy_weighted_average() {
    let ctx = setup(5_000);
    let c1 = add_mock_child(&ctx, 0); // mock apy 500 bps
    let c2 = add_mock_child(&ctx, 0); // mock apy 500 bps
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    // c1 apy 800, c2 apy 1200 (set on the mock's own admin path is awkward; use
    // the allocator override instead to assert override precedence).
    ctx.allocator.set_pool_apy_bps(&ctx.admin, &900_u32);
    assert_eq!(ctx.allocator.pool_apy(), 900); // override wins
}

#[test]
fn harvest_sums_children() {
    let ctx = setup(10_000);
    let c1 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    // Mock harvest returns 0; allocator harvest sums → 0. Asserts the fan-out path runs.
    assert_eq!(ctx.allocator.harvest(&ctx.vault), 0);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p baku-allocator-strategy "pool_apy_weighted_average|harvest_sums"`
Expected: FAIL — stubs return 0 / no override storage.

- [ ] **Step 3: Implement `harvest`, `pool_apy`, `set_pool_apy_bps`** (replace stubs)

```rust
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
        Ok(total) // informational only; never fed into PPS
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p baku-allocator-strategy "pool_apy_weighted_average|harvest_sums"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): harvest fan-out + pool_apy (override or weighted avg)"
```

---

## Task 10: `rebalance` (two-pass atomic)

**Files:**
- Modify: `crates/allocator-strategy/src/lib.rs`
- Test: `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn rebalance_realigns_to_target() {
    let ctx = setup(0); // no native target for a clean two-child realign
    let c1 = add_mock_child(&ctx, 0);
    let c2 = add_mock_child(&ctx, 0);
    ctx.allocator.add_child(&ctx.admin, &c1, &true);
    ctx.allocator.add_child(&ctx.admin, &c2, &true);
    // Target 50/50.
    let weights = soroban_sdk::vec![&ctx.env, (c1.clone(), 5_000_u32), (c2.clone(), 5_000_u32)];
    ctx.allocator.set_target_weights(&ctx.admin, &weights, &0_u32);

    // Deposit 1_000 → 500/500.
    ctx.asset_minter.mint(&ctx.vault, &1_000_i128);
    ctx.asset_token.transfer(&ctx.vault, &ctx.allocator_id, &1_000_i128);
    ctx.allocator.deposit(&ctx.vault, &1_000_i128);

    // Simulate differential yield: inject 200 into c1 (now 700/500, total 1_200).
    let c1_admin_view = MockStrategyClient::new(&ctx.env, &c1);
    // inject_yield needs the child's admin; re-derive: add_mock_child generated it
    // internally. For the test, fund the child contract + deposit instead:
    ctx.asset_minter.mint(&c1, &200_i128);
    c1_admin_view.deposit(&ctx.allocator_id, &200_i128); // c1 now 700

    // Rebalance to target 50/50 of 1_200 = 600 each. c1 drains 100 → native →
    // funds c2 with 100. Mock children deliver exactly, so result is exact.
    ctx.allocator.rebalance(&ctx.admin);
    assert_eq!(MockStrategyClient::new(&ctx.env, &c1).current_value(), 600);
    assert_eq!(MockStrategyClient::new(&ctx.env, &c2).current_value(), 600);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // AdminOnly
fn rebalance_non_admin_reverts() {
    let ctx = setup(10_000);
    let imposter = Address::generate(&ctx.env);
    ctx.allocator.rebalance(&imposter);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p baku-allocator-strategy rebalance_`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement `rebalance`** (add to `impl BakuAllocator`)

```rust
    /// Two-pass atomic rebalance to target weights:
    ///   Pass 1: drain every OVERWEIGHT child's excess into the native sleeve.
    ///   Pass 2: fund every UNDERWEIGHT child's deficit from the native sleeve.
    /// All-or-nothing in one tx. Transient note: for LP children, current_value
    /// is an estimate; a drain can revert with the child's InsufficientLiquidity
    /// under reserve shift — admin retries once reserves settle. (In V0 only
    /// authoritative/Blend children carry weight, so no AMM swap leg.)
    pub fn rebalance(env: Env, admin: Address) -> Result<(), AllocatorError> {
        require_admin(&env, &admin)?;
        require_not_paused(&env)?;
        let asset = load_asset(&env)?;
        let token_client = token::Client::new(&env, &asset);
        let this = env.current_contract_address();
        let children = load_children(&env);

        // Compute total across children + native.
        let mut values: Vec<i128> = Vec::new(&env);
        let mut total: i128 = token_client.balance(&this);
        for slot in children.iter() {
            let v = child_value(&env, &slot);
            values.push_back(v);
            total = total.checked_add(v).ok_or(AllocatorError::MathOverflow)?;
        }
        if total <= 0 { return Ok(()); } // nothing to move

        // Pass 1: drain overweight into native (allocator raw balance).
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

        // Pass 2: fund underweight from native.
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p baku-allocator-strategy rebalance_`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): two-pass atomic rebalance to target weights"
```

---

## Task 11: Vault integration — round-trip, monotonicity, edge baskets

**Files:**
- Test: `crates/allocator-strategy/src/test.rs` (new `mod vault_integration`)

These wire a real `BakuVault` → allocator → mock children, mirroring the harness in `crates/vault/src/test.rs:37-113` (two-step deploy + `set_vault`).

- [ ] **Step 1: Write the failing tests**

```rust
mod vault_integration {
    use super::*;
    use baku_vault::{BakuVault, BakuVaultClient};
    use soroban_sdk::String;

    struct Vfx {
        env: Env,
        admin: Address,
        user: Address,
        asset_minter: soroban_sdk::token::StellarAssetClient<'static>,
        asset_token: soroban_sdk::token::TokenClient<'static>,
        vault: BakuVaultClient<'static>,
        allocator: BakuAllocatorClient<'static>,
        allocator_id: Address,
    }

    fn setup_vault_with_allocator() -> Vfx {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let alloc_admin = Address::generate(&env);
        let user = Address::generate(&env);
        let asset_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(asset_admin);
        let asset = sac.address();
        let asset_minter = soroban_sdk::token::StellarAssetClient::new(&env, &asset);
        let asset_token = soroban_sdk::token::TokenClient::new(&env, &asset);
        asset_minter.mint(&user, &1_000_000_i128);

        // 1) allocator with a placeholder vault, all-native to start.
        let placeholder = Address::generate(&env);
        let empty: soroban_sdk::Vec<(Address, u32, bool)> = soroban_sdk::vec![&env];
        let allocator_id = env.register(
            BakuAllocator,
            (alloc_admin.clone(), placeholder, asset.clone(), empty, 10_000_u32),
        );
        // 2) vault pointing at the allocator as its single active strategy.
        let vault_id = env.register(
            BakuVault,
            (admin.clone(), asset.clone(), allocator_id.clone(),
             String::from_str(&env, "Baku Allocated XLM"),
             String::from_str(&env, "bkuALLOC")),
        );
        let allocator = BakuAllocatorClient::new(&env, &allocator_id);
        allocator.set_vault(&alloc_admin, &vault_id);

        // 3) two authoritative mock children, weighted 30/40, native 30.
        let mk = |vault: &Address| {
            let a = Address::generate(&env);
            env.register(MockStrategy, (a, vault.clone(), asset.clone(), 500_u32))
        };
        let c1 = mk(&allocator_id);
        let c2 = mk(&allocator_id);
        allocator.add_child(&alloc_admin, &c1, &true);
        allocator.add_child(&alloc_admin, &c2, &true);
        let weights = soroban_sdk::vec![&env, (c1, 3_000_u32), (c2, 4_000_u32)];
        allocator.set_target_weights(&alloc_admin, &weights, &3_000_u32);

        Vfx { env, admin, user, asset_minter, asset_token, vault,
              allocator, allocator_id }
            .with(BakuVaultClient::new(&env, &vault_id))
    }
    // (helper to attach the vault client — inline if preferred)

    #[test]
    fn deposit_redeem_round_trip_is_monotonic() {
        let fx = setup_vault_with_allocator();
        fx.vault.deposit(&fx.user, &100_000_i128);
        let shares = fx.vault.balance(&fx.user);
        let before = fx.asset_token.balance(&fx.user);
        let got = fx.vault.redeem(&fx.user, &shares, &0_i128);
        // No yield: user must never get MORE than deposited (round-down dust stays).
        assert!(got <= 100_000, "round-trip must not mint value");
        assert!(got >= 100_000 - 5, "dust loss bounded by child count");
        let _ = before;
    }

    #[test]
    fn small_redeems_do_not_revert() {
        let fx = setup_vault_with_allocator();
        fx.vault.deposit(&fx.user, &100_000_i128);
        let shares = fx.vault.balance(&fx.user);
        // Redeem 1 stroop-worth of shares repeatedly; must not revert on skip-zero.
        let one = shares / 100_000; // ~1 underlying unit of shares
        let _ = fx.vault.redeem(&fx.user, &one, &0_i128);
    }
}
```

> The `.with(...)` shape above is illustrative — when implementing, construct
> `Vfx` directly with the `BakuVaultClient` field set (the two-step deploy needs
> the `vault_id` in scope before building the struct). Keep all fields real; no
> placeholders.

- [ ] **Step 2: Run to verify they fail / compile-check the harness**

Run: `cargo test -p baku-allocator-strategy vault_integration`
Expected: compile + run; tests should pass once the harness is correct (they exercise already-built code). If they fail, the failure is a real integration bug — fix per systematic-debugging.

- [ ] **Step 3: Make them pass**

No new contract code expected. If `deposit_redeem_round_trip_is_monotonic` shows `got > 100_000`, that is a real rounding bug — stop and debug the split/measured-delta math before continuing.

- [ ] **Step 4: Commit**

```bash
git add crates/allocator-strategy/src/test.rs
git commit -m "test(allocator): vault integration — round-trip monotonicity + small-redeem no-revert"
```

---

## Task 12: Real-Soroswap LP integration — slippage, TOCTOU, rebalance shortfall

**Files:**
- Create: `crates/allocator-strategy/src/test_lp.rs`
- Modify: `crates/allocator-strategy/src/lib.rs` (add `mod test_lp;` under `mod test;`)

The mock cannot reproduce under-delivery; the real `soroswap-strategy` against a seeded test pool can. Read `crates/soroswap-strategy/src/lib.rs` constructor + its existing test harness for the exact router/pair/pool setup and reuse it verbatim — do not invent pool wiring.

- [ ] **Step 1: Read the Soroswap test harness**

Run: open `crates/soroswap-strategy/src/lib.rs` and locate its `#[cfg(test)]` module. Copy the pool/router/pair construction (token pair, router address, reserve seeding) into a `setup_lp_child()` helper in `test_lp.rs`. The child's authorized vault must be the allocator id.

- [ ] **Step 2: Write the failing tests**

```rust
#![cfg(test)]
use crate::{BakuAllocator, BakuAllocatorClient};
// + soroswap-strategy imports mirrored from its own test module.

// setup_lp_child(): registers a real SoroswapStrategy child + seeded pool, with
// the allocator as its vault. Returns (ctx-like fixture, lp_child_addr).

#[test]
fn withdraw_returns_measured_under_lp_slippage() {
    // Basket: one Blend-like authoritative mock (weight 5000) + native 5000.
    // Register the LP child as NON-authoritative (weight 0) but FUND it, then
    // withdraw — the measured delta must be < the naive pro-rata request because
    // the LP under-delivers (fees + double-floor). Assert delivered < requested
    // AND delivered == measured balance delta.
    // ... full body using setup_lp_child() ...
}

#[test]
fn withdraw_clamps_when_child_value_drops_between_reads() {
    // Move the pool reserves between the vault's total_assets read and the
    // allocator's re-read; assert the redeem does NOT revert (clamp to just-read
    // cv) and returns a sane measured amount.
}

#[test]
fn rebalance_tolerates_lp_drain_shortfall() {
    // With an LP child weighted (V1 path: register authoritative=true to bypass
    // the guard ONLY in this test to exercise the math), drive a drain that
    // under-delivers; assert the two-pass rebalance still lands funds in native
    // and the op is atomic (no partial state on revert).
}
```

> These three test bodies are intentionally specified by behavior + assertions
> rather than full code because the pool-seeding boilerplate must be copied from
> the live `soroswap-strategy` test module (which the implementer will read in
> Step 1). Each MUST end with concrete asserts: `assert!(delivered < requested)`,
> `assert_eq!(delivered, post - pre_plus_native)`, and an atomicity check
> (`should_panic` or pre/post equality on revert). No `assert!(true)` / smoke
> tests.

- [ ] **Step 3: Run to verify they fail, then make them pass**

Run: `cargo test -p baku-allocator-strategy --features testutils test_lp`
Expected: FAIL first (harness incomplete), then PASS. A failure in
`withdraw_returns_measured_under_lp_slippage` where delivered == requested means
the measured-delta path is wrong — debug before proceeding.

- [ ] **Step 4: Commit**

```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test_lp.rs
git commit -m "test(allocator): real-soroswap LP integration — slippage, TOCTOU clamp, rebalance shortfall"
```

---

## Task 13: Full suite + workspace build gate

**Files:** none (verification only)

- [ ] **Step 1: Run the whole crate suite**

Run: `cargo test -p baku-allocator-strategy`
Expected: ALL tests PASS.

- [ ] **Step 2: Build the whole workspace (nothing else broke)**

Run: `cargo build`
Expected: clean build across all crates.

- [ ] **Step 3: Clippy (match house style)**

Run: `cargo clippy -p baku-allocator-strategy -- -D warnings`
Expected: no warnings. Fix any.

- [ ] **Step 4: Final commit**

```bash
git add -u crates/allocator-strategy
git commit -m "chore(allocator): clippy clean + full suite green"
```

---

## Self-Review notes (carried from spec → plan)

- **Spec coverage:** every §5 flow maps to a task (deposit T7, withdraw T8,
  current_value T4, harvest/pool_apy T9, set_target_weights T6, rebalance T10,
  child mgmt T5, pause/force-remove T5, constructor T2). §6 folds: P0-A measured
  delta (T8), P0-C try_+fail-closed (T4) + pause/force-remove (T5), P1-D clamp
  (T8), P1-E checked math (T3 helper, used T7/T8/T10), P1-F total<=0 (T8),
  T1 authoritative guard (T6), T2 dust→native + skip-zero (T7/T8).
- **Known execution caveat:** the `#[should_panic]` codes on the *core-path*
  (deposit/withdraw) tests surface as `StrategyError` (trait return type), not
  `AllocatorError`. Tasks 7–8 instruct the implementer to run once and read the
  real `Error(Contract, #N)`. Admin/view paths surface `AllocatorError` codes
  directly (Tasks 2, 5, 6, 10) and are pinned. Do not guess codes.
- **map_alloc coarseness:** V0 collapses allocator-specific deposit/withdraw
  failures to `StrategyError::PoolError` so the vault treats them as
  `StrategyFailed` (matches `vault/src/lib.rs:116`). If finer vault-side
  reporting is wanted later, widen `StrategyError` — out of scope here.
