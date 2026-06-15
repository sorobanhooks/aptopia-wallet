# Multi-tx Buffer-First Redemption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the 30/40/30 allocator-backed vault service redemptions across multiple transactions (instant from a native buffer; queued request→drain→claim for large redeems) so no single tx touches Blend `pool.submit` + Soroswap `remove_liquidity` together and busts Soroban's per-tx memory limit.

**Architecture:** Allocator `withdraw` becomes native-buffer-only; new admin per-child `drain_child`/`fund_child`/`rebalance_step` move liquidity one heavy protocol per tx and restore 30/40/30 pro-rata. Vault gains an additive escrow-based redemption queue (`request_redeem`/`claim_redeem`/`cancel_request`) that prices+burns at claim. Deposit and the 30/40/30 basket are unchanged.

**Tech Stack:** Rust, soroban-sdk 25.3.1, stellar-tokens 0.7.1 (OZ Base/FungibleToken), stellar CLI 26.1.

**Spec:** `docs/superpowers/specs/2026-06-06-multitx-buffer-redemption-design.md`

---

## File Structure
- **Modify** `crates/allocator-strategy/src/errors.rs` — add `InsufficientBuffer = 17`.
- **Modify** `crates/allocator-strategy/src/lib.rs` — native-only `withdraw`; new `buffer`, `drain_child`, `fund_child`, `rebalance_step`.
- **Modify** `crates/allocator-strategy/src/test.rs` — rewrite the withdraw tests for native-only semantics; add tests for the new primitives.
- **Modify** `crates/vault/src/errors.rs` — add `RequestNotFound = 110`, `NotRequestOwner = 111`.
- **Modify** `crates/vault/src/lib.rs` — `Pending` type, `DataKey` additions, `request_redeem`/`claim_redeem`/`cancel_request`, views `pending_redemption`/`total_pending_shares`/`instant_redeemable_assets` + a `BufferClient`.
- **Modify** `crates/vault/src/test.rs` — tests for the queue.
- Deploy/demo is operational (Group C), no new files except updating `scripts/deployed.allocator.testnet.env`.

No new crates, no new dependencies.

---

# GROUP A — Allocator: native-buffer withdraw + per-child primitives

### Task A1: Add `InsufficientBuffer` error + `buffer()` view

**Files:** Modify `crates/allocator-strategy/src/errors.rs`, `crates/allocator-strategy/src/lib.rs`; Test `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Add the error variant**

In `crates/allocator-strategy/src/errors.rs`, after `EmptyBasket = 16,` add:
```rust
    /// withdraw/fund requested more than the native buffer holds.
    InsufficientBuffer = 17,
```

- [ ] **Step 2: Write the failing test for `buffer()`**

In `crates/allocator-strategy/src/test.rs` `mod test`, add (mirror the existing setup helpers in that file for SAC + allocator construction):
```rust
#[test]
fn buffer_reports_native_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_basic(&env); // existing helper: deploys allocator + asset SAC, admin, vault
    // mint 1_000 of the asset SAC to the allocator contract address
    ctx.asset_admin.mint(&ctx.allocator_id, &1_000);
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    assert_eq!(client.buffer(), 1_000);
}
```
(If the existing test file's setup helper has a different name/shape, adapt the call but keep the assertion: after minting 1_000 asset to the allocator, `buffer() == 1_000`.)

- [ ] **Step 3: Run it to confirm it fails**

Run: `cargo test -p baku-allocator-strategy buffer_reports_native_balance`
Expected: FAIL — `buffer` not found.

- [ ] **Step 4: Implement `buffer()`**

In `crates/allocator-strategy/src/lib.rs`, in `#[contractimpl] impl BakuAllocator` (the inherent impl, near the other views like `native_bps`), add:
```rust
    /// Instantly-withdrawable amount = the allocator's native (asset) balance.
    /// The redemption buffer. Read by the vault for instant-vs-queued routing.
    pub fn buffer(env: Env) -> i128 {
        match load_asset(&env) {
            Ok(asset) => token::Client::new(&env, &asset)
                .balance(&env.current_contract_address()),
            Err(_) => 0,
        }
    }
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `cargo test -p baku-allocator-strategy buffer_reports_native_balance`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add crates/allocator-strategy/src/errors.rs crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): add InsufficientBuffer error + buffer() view"
```

---

### Task A2: Native-only `withdraw` (replace pro-rata) + update its tests

**Files:** Modify `crates/allocator-strategy/src/lib.rs`; Modify `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Replace the `withdraw` body**

In `crates/allocator-strategy/src/lib.rs`, in `impl StrategyInterface for BakuAllocator`, replace the entire current `fn withdraw` with:
```rust
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
```

- [ ] **Step 2: Rewrite the withdraw tests for native-only semantics**

In `crates/allocator-strategy/src/test.rs`, the existing withdraw tests assert the OLD pro-rata behavior and will now fail. Replace them as follows (keep the test module's existing setup helpers; these names may already exist — if a same-named test exists, replace its body):

```rust
#[test]
fn withdraw_serves_from_native_buffer() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_basic(&env); // allocator + asset SAC + admin + vault
    ctx.asset_admin.mint(&ctx.allocator_id, &1_000); // native buffer = 1_000
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    let got = client.withdraw(&ctx.vault, &600_i128);
    assert_eq!(got, 600);
    assert_eq!(client.buffer(), 400);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")] // mapped to StrategyError::PoolError at trait boundary; underlying AllocatorError::InsufficientBuffer = 17
fn withdraw_above_buffer_reverts() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_basic(&env);
    ctx.asset_admin.mint(&ctx.allocator_id, &100);
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    client.withdraw(&ctx.vault, &101_i128); // exceeds buffer
}
```
Note on the `should_panic` code: `withdraw` returns `StrategyError` (PoolError=? — confirm the discriminant) via `map_alloc`. `map_alloc` maps ALL allocator errors to `StrategyError::PoolError`. So the panic will carry `StrategyError::PoolError`'s discriminant, NOT 17. Look up `StrategyError::PoolError`'s numeric value in `crates/strategy-trait/src/lib.rs` and use that in `expected` (e.g. if PoolError=5, use `"Error(Contract, #5)"`). Adjust the comment accordingly.

DELETE the now-obsolete old withdraw tests that asserted pro-rata splitting: `withdraw_pro_rata_by_value_returns_measured`, `withdraw_amount_exceeds_total_drains_all`, `withdraw_tiny_amount_served_from_native`, `withdraw_empty_basket_guarded`, and the `vault_integration` round-trip tests that relied on pro-rata redeem (`deposit_redeem_round_trip_is_monotonic`, `small_redeem_does_not_revert`). Their behavior is replaced by native-only withdraw (unit-tested above) + the live demo. Remove their `test_snapshots/*` files too if the harness complains about stale snapshots.

- [ ] **Step 3: Run the allocator tests**

Run: `cargo test -p baku-allocator-strategy 2>&1 | tail -20`
Expected: PASS (new withdraw tests pass; obsolete ones removed). If `should_panic` code mismatches, fix the expected discriminant per the note.

- [ ] **Step 4: Commit**
```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs crates/allocator-strategy/test_snapshots
git commit -m "feat(allocator): native-buffer-only withdraw; rework withdraw tests"
```

---

### Task A3: `drain_child` + `fund_child`

**Files:** Modify `crates/allocator-strategy/src/lib.rs`; Test `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write failing tests**

In `crates/allocator-strategy/src/test.rs` (the existing tests already register `MockStrategy` children with `inject_yield`/balances — mirror that setup, here referred to as `setup_with_mock_child` returning the allocator, admin, vault, and a mock child address + client):
```rust
#[test]
fn drain_child_pulls_into_native() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_with_mock_child(&env); // allocator + 1 mock child (authoritative)
    // fund the child with 500 via the allocator deposit path or mock seeding helper
    ctx.seed_child_value(&ctx.child, 500); // existing helper pattern (mint+deposit to child)
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    let pre_buf = client.buffer();
    let drained = client.drain_child(&ctx.admin, &ctx.child, &200_i128);
    assert_eq!(drained, 200);
    assert_eq!(client.buffer(), pre_buf + 200);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // AllocatorError::AdminOnly = 3
fn drain_child_non_admin_reverts() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_with_mock_child(&env);
    let imposter = Address::generate(&env);
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    client.drain_child(&imposter, &ctx.child, &1_i128);
}

#[test]
fn fund_child_moves_native_into_child() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_with_mock_child(&env);
    ctx.asset_admin.mint(&ctx.allocator_id, &1_000); // native buffer
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    let child = BakuStrategyMockClient::new(&env, &ctx.child); // mock client
    let pre = child.current_value();
    client.fund_child(&ctx.admin, &ctx.child, &300_i128);
    assert_eq!(client.buffer(), 700);
    assert_eq!(child.current_value(), pre + 300);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")] // InsufficientBuffer
fn fund_child_above_buffer_reverts() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_with_mock_child(&env);
    ctx.asset_admin.mint(&ctx.allocator_id, &100);
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    client.fund_child(&ctx.admin, &ctx.child, &101_i128);
}
```
(Use the mock client name actually exported by `baku-mock-strategy`; the existing allocator tests already import it — reuse that import.)

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p baku-allocator-strategy drain_child fund_child`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement both, in the inherent `impl BakuAllocator`**

Add (near `rebalance`):
```rust
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
        let this = env.current_contract_address();
        let sc = StrategyClient::new(&env, &slot.strategy);
        match sc.try_withdraw(&this, &amount) {
            Ok(Ok(delivered)) => Ok(delivered),
            _ => Err(AllocatorError::ChildWithdrawFailed),
        }
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `cargo test -p baku-allocator-strategy drain_child fund_child`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): per-child drain_child + fund_child (one protocol per tx)"
```

---

### Task A4: `rebalance_step` (per-child to-target)

**Files:** Modify `crates/allocator-strategy/src/lib.rs`; Test `crates/allocator-strategy/src/test.rs`

- [ ] **Step 1: Write failing tests**
```rust
#[test]
fn rebalance_step_drains_overweight_child_to_native() {
    let env = Env::default();
    env.mock_all_auths();
    // allocator with one authoritative child @ weight 5000, native_bps 5000.
    let ctx = setup_with_mock_child_weighted(&env, 5000, 5000);
    // Make total = 1000: child holds 800 (overweight; target = 500), native 200.
    ctx.seed_child_value(&ctx.child, 800);
    ctx.asset_admin.mint(&ctx.allocator_id, &200);
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    client.rebalance_step(&ctx.admin, &ctx.child);
    // child back to target 500, excess 300 moved to native (200 -> 500)
    let child = BakuStrategyMockClient::new(&env, &ctx.child);
    assert_eq!(child.current_value(), 500);
    assert_eq!(client.buffer(), 500);
}

#[test]
fn rebalance_step_funds_underweight_child_from_native() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_with_mock_child_weighted(&env, 5000, 5000);
    // total = 1000: child holds 200 (underweight; target 500), native 800.
    ctx.seed_child_value(&ctx.child, 200);
    ctx.asset_admin.mint(&ctx.allocator_id, &800);
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    client.rebalance_step(&ctx.admin, &ctx.child);
    let child = BakuStrategyMockClient::new(&env, &ctx.child);
    assert_eq!(child.current_value(), 500); // funded up to target
    assert_eq!(client.buffer(), 500);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // AdminOnly
fn rebalance_step_non_admin_reverts() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_with_mock_child_weighted(&env, 5000, 5000);
    let imposter = Address::generate(&env);
    let client = BakuAllocatorClient::new(&env, &ctx.allocator_id);
    client.rebalance_step(&imposter, &ctx.child);
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p baku-allocator-strategy rebalance_step`
Expected: FAIL — not found.

- [ ] **Step 3: Implement, in the inherent `impl BakuAllocator`**
```rust
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `cargo test -p baku-allocator-strategy rebalance_step`
Expected: PASS (3 tests).

- [ ] **Step 5: Full allocator suite + commit**

Run: `cargo test -p baku-allocator-strategy 2>&1 | tail -8` → all pass.
```bash
git add crates/allocator-strategy/src/lib.rs crates/allocator-strategy/src/test.rs
git commit -m "feat(allocator): rebalance_step (per-child to-target, multi-tx 30/40/30 restore)"
```

---

# GROUP B — Vault: escrow-based redemption queue

### Task B1: `Pending` type, `DataKey` + error variants

**Files:** Modify `crates/vault/src/errors.rs`, `crates/vault/src/lib.rs`

- [ ] **Step 1: Add vault error variants**

In `crates/vault/src/errors.rs`, after `MathOverflow = 109,` add:
```rust
    /// No pending redemption with the given id.
    RequestNotFound = 110,
    /// Caller is not the owner of the referenced pending redemption.
    NotRequestOwner = 111,
```

- [ ] **Step 2: Add the `Pending` type and `DataKey` variants**

In `crates/vault/src/lib.rs`, add `contracttype` to the `use soroban_sdk::{...}` import if not present, then add the struct near the top (after the `use` lines):
```rust
/// A queued (async) redemption. Shares are escrowed to the vault at request
/// time and burned at claim time; the owed asset amount is priced at claim.
#[contracttype]
#[derive(Clone)]
pub struct Pending {
    pub owner: Address,
    pub shares: i128,
    pub min_out: i128,
}
```
Extend the `DataKey` enum:
```rust
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
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p baku-vault`
Expected: builds (unused-variant warnings OK until B2-B4).

- [ ] **Step 4: Commit**
```bash
git add crates/vault/src/errors.rs crates/vault/src/lib.rs
git commit -m "feat(vault): Pending type + queue DataKeys + request error variants"
```

---

### Task B2: `request_redeem` (escrow shares)

**Files:** Modify `crates/vault/src/lib.rs`; Test `crates/vault/src/test.rs`

- [ ] **Step 1: Write the failing test**

In `crates/vault/src/test.rs` (mirror the existing harness that deploys the vault with a `MockStrategy` active + mints shares via a deposit). Referring to the existing setup as `setup_funded(&env)` returning `{vault_client, user, vault_id, ...}` where `user` already holds shares from a deposit:
```rust
#[test]
fn request_redeem_escrows_shares_and_records_pending() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_funded(&env); // user holds `user_shares` shares
    let user_shares = ctx.vault_client.balance(&ctx.user);
    assert!(user_shares > 0);
    let id = ctx.vault_client.request_redeem(&ctx.user, &user_shares, &0_i128);
    assert_eq!(id, 0);
    // shares moved from user to the vault escrow
    assert_eq!(ctx.vault_client.balance(&ctx.user), 0);
    assert_eq!(ctx.vault_client.balance(&ctx.vault_id), user_shares);
    assert_eq!(ctx.vault_client.total_pending_shares(), user_shares);
    let p = ctx.vault_client.pending_redemption(&id).unwrap();
    assert_eq!(p.owner, ctx.user);
    assert_eq!(p.shares, user_shares);
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p baku-vault request_redeem_escrows`
Expected: FAIL — not found.

- [ ] **Step 3: Implement `request_redeem` (+ the two views it asserts)**

In `crates/vault/src/lib.rs`, in `impl BakuVault`, add:
```rust
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
        env.storage()
            .instance()
            .set(&DataKey::NextRequestId, &(id + 1));
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `cargo test -p baku-vault request_redeem_escrows`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/vault/src/lib.rs crates/vault/src/test.rs
git commit -m "feat(vault): request_redeem escrows shares + pending ledger + views"
```

---

### Task B3: `claim_redeem` (price + burn at claim, pay from strategy)

**Files:** Modify `crates/vault/src/lib.rs`; Test `crates/vault/src/test.rs`

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn claim_redeem_pays_burns_and_clears() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_funded(&env); // MockStrategy active; user holds shares
    let user_shares = ctx.vault_client.balance(&ctx.user);
    let id = ctx.vault_client.request_redeem(&ctx.user, &user_shares, &0_i128);
    let supply_before = ctx.vault_client.total_supply();
    let user_asset_before = ctx.asset_client.balance(&ctx.user);

    let paid = ctx.vault_client.claim_redeem(&id);
    assert!(paid > 0);
    // escrowed shares burned
    assert_eq!(ctx.vault_client.balance(&ctx.vault_id), 0);
    assert_eq!(ctx.vault_client.total_supply(), supply_before - user_shares);
    assert_eq!(ctx.vault_client.total_pending_shares(), 0);
    assert!(ctx.vault_client.pending_redemption(&id).is_none());
    // user received the asset
    assert_eq!(ctx.asset_client.balance(&ctx.user), user_asset_before + paid);
}

#[test]
#[should_panic(expected = "Error(Contract, #104)")] // VaultError::SlippageExceeded = 104
fn claim_redeem_respects_min_out() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_funded(&env);
    let user_shares = ctx.vault_client.balance(&ctx.user);
    // request with an impossibly high min_out
    let id = ctx.vault_client.request_redeem(&ctx.user, &user_shares, &i128::MAX);
    ctx.vault_client.claim_redeem(&id);
}
```
(MockStrategy's `withdraw` serves synchronously in unit tests — the allocator's native-only buffer behavior is exercised at the allocator level (A2) and live. This test verifies the vault queue mechanics.)

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p baku-vault claim_redeem`
Expected: FAIL — not found.

- [ ] **Step 3: Implement `claim_redeem`**

In `impl BakuVault`:
```rust
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

        let this = env.current_contract_address();
        let strat = StrategyClient::new(&env, &active);
        let actual = match strat.try_withdraw(&this, &owed) {
            Ok(Ok(amount)) => amount,
            Ok(Err(_)) | Err(_) => return Err(VaultError::StrategyFailed), // buffer not yet funded → retry after drain
        };
        if actual < pending.min_out {
            return Err(VaultError::SlippageExceeded);
        }

        // Burn the escrowed shares now that we can pay.
        Base::update(&env, Some(&this), None, pending.shares);

        let asset = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::Asset)
            .ok_or(VaultError::NotInitialized)?;
        token::Client::new(&env, &asset).transfer(&this, &pending.owner, &actual);

        env.storage().persistent().remove(&DataKey::Pending(id));
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalPendingShares)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalPendingShares, &(total - pending.shares));
        Ok(actual)
    }
```

- [ ] **Step 4: Run to confirm pass**

Run: `cargo test -p baku-vault claim_redeem`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add crates/vault/src/lib.rs crates/vault/src/test.rs
git commit -m "feat(vault): claim_redeem (price+burn at claim, pay from strategy)"
```

---

### Task B4: `cancel_request`

**Files:** Modify `crates/vault/src/lib.rs`; Test `crates/vault/src/test.rs`

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn cancel_request_returns_escrowed_shares() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_funded(&env);
    let user_shares = ctx.vault_client.balance(&ctx.user);
    let id = ctx.vault_client.request_redeem(&ctx.user, &user_shares, &0_i128);
    assert_eq!(ctx.vault_client.balance(&ctx.user), 0);
    ctx.vault_client.cancel_request(&id);
    assert_eq!(ctx.vault_client.balance(&ctx.user), user_shares);
    assert_eq!(ctx.vault_client.total_pending_shares(), 0);
    assert!(ctx.vault_client.pending_redemption(&id).is_none());
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p baku-vault cancel_request`
Expected: FAIL — not found.

- [ ] **Step 3: Implement `cancel_request`**
```rust
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `cargo test -p baku-vault cancel_request`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/vault/src/lib.rs crates/vault/src/test.rs
git commit -m "feat(vault): cancel_request returns escrowed shares"
```

---

### Task B5: `instant_redeemable_assets` view + `BufferClient`

**Files:** Modify `crates/vault/src/lib.rs`; Test `crates/vault/src/test.rs`

- [ ] **Step 1: Write the failing test**
```rust
#[test]
fn instant_redeemable_assets_falls_back_to_current_value_for_plain_strategy() {
    let env = Env::default();
    env.mock_all_auths();
    let ctx = setup_funded(&env); // active = MockStrategy (no buffer() fn)
    // MockStrategy has no buffer(); the view must fall back to current_value.
    let cv = ctx.mock_client.current_value();
    assert_eq!(ctx.vault_client.instant_redeemable_assets(), cv);
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p baku-vault instant_redeemable_assets`
Expected: FAIL — not found.

- [ ] **Step 3: Implement the view + a hand-declared `BufferClient`**

Add near the top of `crates/vault/src/lib.rs` (after the `use` lines):
```rust
// Optional buffer() probe. Strategies that expose an instant buffer (the
// allocator) return it; others trap and we fall back to current_value.
#[soroban_sdk::contractclient(name = "BufferClient")]
pub trait BufferProbe {
    fn buffer(env: Env) -> i128;
}
```
In `impl BakuVault`:
```rust
    /// Amount the active strategy can serve in a single (light) `redeem` tx.
    /// For the allocator this is its native buffer; for strategies without a
    /// `buffer()` view it is the full `current_value` (they serve synchronously).
    /// The dApp compares this with `preview_redeem` to route redeem vs request_redeem.
    pub fn instant_redeemable_assets(env: Env) -> i128 {
        let active = match env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::ActiveStrategy)
        {
            Some(a) => a,
            None => return 0,
        };
        match BufferClient::new(&env, &active).try_buffer() {
            Ok(Ok(v)) => v,
            _ => current_total_assets(&env, &active),
        }
    }
```

- [ ] **Step 4: Run to confirm pass**

Run: `cargo test -p baku-vault instant_redeemable_assets`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add crates/vault/src/lib.rs crates/vault/src/test.rs
git commit -m "feat(vault): instant_redeemable_assets view (buffer probe + fallback)"
```

---

### Task B6: Build, clippy, full workspace test

**Files:** none (verification)

- [ ] **Step 1: Build all wasms**

Run: `stellar contract build`
Expected: `✅ Build Complete` (allocator, vault, soroswap, blend wasms emitted).

- [ ] **Step 2: Clippy clean on changed crates**

Run: `cargo clippy -p baku-allocator-strategy -p baku-vault --all-targets -- -D warnings`
Expected: no warnings.

- [ ] **Step 3: Full workspace test**

Run: `cargo test 2>&1 | grep -E "test result|error\[" | tail -30`
Expected: all crates green.

- [ ] **Step 4: Commit (if any fmt/lint touch-ups)**
```bash
git add -A
git commit -m "chore: build + clippy clean for multi-tx redemption" || echo "nothing to commit"
```

---

# GROUP C — Live testnet deploy + demo

Addresses live in `scripts/deployed.allocator.testnet.env` (allocator `CDN5KSWY…`, LP child `CBOUW5FF…`, blend child `CAASZTCS…`, admin `GCWHAC…`, asset `XLM_SAC`, pool/router/USDC) and `scripts/deployed.testnet.env` (`VAULT_XLM=CCY337…`, `BLEND_STRATEGY_XLM=CAGIMEB3…`). Use a FRESH demo vault (do not disturb the canonical `VAULT_XLM`, which safely runs plain Blend) unless told otherwise.

### Task C1: Deploy new allocator + fresh demo vault; single-tx deposit

- [ ] **Step 1: Build + deploy the updated allocator** (vault = the demo vault, set after vault deploy via `set_vault`). Deploy a fresh demo vault whose initial strategy is the new allocator. Wire fresh Blend + Soroswap-LP children (vault = allocator) and `set_target_weights` 3000/4000/3000 (reuse `deploy-allocator-xlm.sh` patterns; rebuild children from current wasm).

- [ ] **Step 2: Single-tx deposit** of e.g. 100 XLM via the demo vault; confirm event log shows Blend supply + Soroswap add_liquidity in ONE tx and shares minted. Read allocator `buffer()` (native sleeve ≈ 30 XLM), child current_values.
Expected: deposit succeeds in one tx (no memory error).

- [ ] **Step 3: Record** the demo vault + allocator + child addresses and the deposit tx hash in `scripts/deployed.allocator.testnet.env`. Commit.

### Task C2: Instant redeem from buffer (1 tx)

- [ ] **Step 1:** As a user, `vault.redeem(shares)` for an amount the native buffer covers (e.g. value < the ~30 XLM buffer). Confirm it succeeds in ONE tx, no Blend/Soroswap calls in the event log, user receives XLM.
- [ ] **Step 2:** Read `vault.instant_redeemable_assets()` and confirm it ≈ allocator `buffer()`.

### Task C3: Large queued redeem (request → drain → claim)

- [ ] **Step 1:** As a user, `vault.request_redeem(shares)` for an amount EXCEEDING the buffer; confirm shares escrow to the vault and `pending_redemption(id)` is recorded (light tx).
- [ ] **Step 2:** As admin/keeper, `allocator.drain_child(blend_child, amt)` and `allocator.drain_child(lp_child, amt)` — separate txs — until `allocator.buffer()` covers the owed amount. Confirm each drain is ONE protocol per tx (Blend pool.submit in one; Soroswap remove_liquidity+swap in another), no memory error.
- [ ] **Step 3:** As the user, `vault.claim_redeem(id)`; confirm escrowed shares burned, user paid, pending cleared. (This is the path that failed before — verify it now succeeds because draining was split across txs.)

### Task C4: rebalance_step restores 30/40/30

- [ ] **Step 1:** After the redemption drained the buffer/children, call `allocator.rebalance_step(blend_child)` then `allocator.rebalance_step(lp_child)` (separate txs). Read each child current_value + buffer and confirm the basket is back to ~30/40/30 within rounding.

### Task C5: Record + leave canonical vault safe

- [ ] **Step 1:** Update `scripts/deployed.allocator.testnet.env` with all demo addresses + tx hashes + a summary of the working multi-tx redemption.
- [ ] **Step 2:** Confirm the canonical `VAULT_XLM` is untouched and still on plain Blend (`active_strategy == CAGIMEB3…`). Commit the record.

---

## Self-Review

**Spec coverage:** §2.1 native-only withdraw → A2; §2.2 drain_child/fund_child → A3, rebalance_step → A4; §2.3 buffer() → A1; §3.1 redeem instant + instant_redeemable_assets → B5 (redeem itself unchanged, relies on A2); §3.2 request/claim/cancel + ledger + views → B1–B5; §3.3 keeper funding → C3 (drain_child) — admin-gated as specified; §4 flows → C1/C2/C3; §6 errors/edge cases → InsufficientBuffer (A1/A2), min_out + RequestNotFound (B3), cancel (B4); §7 testing → A1–A4, B2–B5 units + C live; §8 deploy/demo → C; §9 acceptance → B6 + C. §5 decisions (escrow-at-request/price-at-claim, admin-gated) → B2/B3 + C3. §10 deferred — out of scope. No gaps.

**Placeholder scan:** Group C uses runtime addresses resolved from env files (not code placeholders). The A2 `should_panic` discriminant must be confirmed against `StrategyError::PoolError`'s value (flagged inline in A2 Step 2) — that's a verification instruction, not a placeholder. Test setup helper names (`setup_basic`, `setup_with_mock_child`, `setup_funded`, `seed_child_value`) reference the existing test harness; the implementer maps them to the actual helpers in `test.rs` (flagged inline). All contract code is complete.

**Type consistency:** `buffer()`, `drain_child(admin, child, amount)->i128`, `fund_child(admin, child, amount)`, `rebalance_step(admin, child)` consistent A1/A3/A4 + used in C. Vault `Pending{owner,shares,min_out}`, `DataKey::{NextRequestId,Pending(u64),TotalPendingShares}`, `request_redeem(owner,shares,min_out)->u64`, `claim_redeem(id)->i128`, `cancel_request(id)`, `pending_redemption(id)->Option<Pending>`, `total_pending_shares()->i128`, `instant_redeemable_assets()->i128`, `BufferClient` consistent across B1–B5 + C. `AllocatorError::InsufficientBuffer=17`, `VaultError::{RequestNotFound=110,NotRequestOwner=111}` consistent.
