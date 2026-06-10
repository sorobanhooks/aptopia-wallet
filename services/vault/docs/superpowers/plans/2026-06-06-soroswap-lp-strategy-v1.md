# SoroswapStrategy V1 (Real LP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `crates/soroswap-strategy` from swap-and-hold to real liquidity provision (`add_liquidity`/`remove_liquidity`), so the 40% Soroswap sleeve earns the 0.30% LP fee instead of only paying swap fees.

**Architecture:** Same `StrategyInterface`. Deposit swaps ~half the asset to the paired token, re-reads post-swap reserves, replicates the router's `quote` to compute the exact `(amount_a, amount_b)` it will consume, pre-authorizes those two transfers, and calls `add_liquidity` (holds LP tokens). Withdraw removes a pro-rata slice of the LP position, swaps the paired leg back, and delivers a single asset. `current_value` values idle balances + the LP share of reserves.

**Tech Stack:** Rust, `soroban-sdk` 25.3.1, Soroswap V2 router/pair (testnet), `stellar` CLI 26.1.

**Spec:** `docs/superpowers/specs/2026-06-06-soroswap-lp-strategy-v1-design.md`

---

## File Structure

- **Modify:** `crates/soroswap-strategy/src/lib.rs` — extend the router/pair `contractclient` traits; add pure helpers `ratio_quote`, `optimal_add_amounts`, `position_value`, and the `pre_auth_two_transfers` helper; rewrite `deposit`, `withdraw`, `current_value`; update the module doc-comment.
- **Tests:** same file, `#[cfg(test)] mod tests` — keep existing auth-boundary + `quote_amount_out`/`slippage_floor` pins; add pure-math tests for `optimal_add_amounts` and `position_value`.
- No new crate, no new dependency, no storage change.

All code below assumes the existing imports plus this addition at the top of the file:
```rust
use soroban_sdk::Vec; // already imported; listed for clarity
```

---

### Task 1: Extend the router + pair contractclient traits

**Files:**
- Modify: `crates/soroswap-strategy/src/lib.rs` (the `#[contractclient]` trait blocks)

- [ ] **Step 1: Add liquidity methods to the router client**

Replace the existing `SoroswapRouterInterface` trait block with:

```rust
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
```

- [ ] **Step 2: Add LP-token reads to the pair client**

Replace the existing `SoroswapPairInterface` trait block with:

```rust
// Hand-declared Soroswap Pair interface. The pair IS the LP token (SEP-41), so
// balance/total_supply read the strategy's LP position.
#[contractclient(name = "SoroswapPairClient")]
pub trait SoroswapPairInterface {
    fn get_reserves(env: Env) -> (i128, i128);
    fn token_0(env: Env) -> Address;
    fn balance(env: Env, id: Address) -> i128;
    fn total_supply(env: Env) -> i128;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p baku-soroswap-strategy`
Expected: builds (warnings about unused methods are fine at this stage).

- [ ] **Step 4: Commit**

```bash
git add crates/soroswap-strategy/src/lib.rs
git commit -m "feat(soroswap): declare add/remove_liquidity + LP-token reads on clients"
```

---

### Task 2: Pure helper — `ratio_quote` + `optimal_add_amounts`

**Files:**
- Modify: `crates/soroswap-strategy/src/lib.rs` (add free fns near `quote_amount_out`)
- Test: same file `mod tests`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests`:

```rust
#[test]
fn ratio_quote_basic_and_guards() {
    // amount_a * reserve_b / reserve_a, integer floor.
    assert_eq!(ratio_quote(100, 1_000, 4_000), 400);
    assert_eq!(ratio_quote(3, 1_000, 4_000), 12);
    assert_eq!(ratio_quote(0, 1_000, 1_000), 0);
    assert_eq!(ratio_quote(100, 0, 1_000), 0);
    assert_eq!(ratio_quote(100, 1_000, 0), 0);
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
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p baku-soroswap-strategy ratio_quote optimal_add`
Expected: FAIL — `ratio_quote` / `optimal_add_amounts` not found.

- [ ] **Step 3: Implement the helpers**

Add near `quote_amount_out`:

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p baku-soroswap-strategy ratio_quote optimal_add`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/soroswap-strategy/src/lib.rs
git commit -m "feat(soroswap): add ratio_quote + optimal_add_amounts (LP zap math)"
```

---

### Task 3: Pure helper — `position_value`

**Files:**
- Modify: `crates/soroswap-strategy/src/lib.rs`
- Test: same file `mod tests`

- [ ] **Step 1: Write the failing tests**

```rust
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
    assert_eq!(position_value(0, 0, 500, 0, 1_000, 4_000), 0);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p baku-soroswap-strategy position_value`
Expected: FAIL — `position_value` not found.

- [ ] **Step 3: Implement**

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p baku-soroswap-strategy position_value`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/soroswap-strategy/src/lib.rs
git commit -m "feat(soroswap): add position_value (idle + LP-share valuation)"
```

---

### Task 4: `pre_auth_two_transfers` helper

**Files:**
- Modify: `crates/soroswap-strategy/src/lib.rs` (near `pre_auth_swap_transfer`)

- [ ] **Step 1: Implement (no unit test — exercised live via deposit)**

```rust
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p baku-soroswap-strategy`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add crates/soroswap-strategy/src/lib.rs
git commit -m "feat(soroswap): add pre_auth_two_transfers for add_liquidity auth"
```

---

### Task 5: Rewrite `deposit` to provide liquidity

**Files:**
- Modify: `crates/soroswap-strategy/src/lib.rs` (the `fn deposit` in `impl StrategyInterface`)

- [ ] **Step 1: Replace the deposit body**

```rust
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
```

- [ ] **Step 2: Verify it compiles + auth-boundary tests still pass**

Run: `cargo test -p baku-soroswap-strategy`
Expected: PASS (existing `deposit_from_non_vault_reverts`, `deposit_zero_amount_reverts`, `deposit_one_stroop_reverts` still hold; pure-math tests pass).

- [ ] **Step 3: Commit**

```bash
git add crates/soroswap-strategy/src/lib.rs
git commit -m "feat(soroswap): deposit provides real liquidity via add_liquidity"
```

---

### Task 6: Rewrite `withdraw` to remove liquidity pro-rata

**Files:**
- Modify: `crates/soroswap-strategy/src/lib.rs` (the `fn withdraw`)

- [ ] **Step 1: Replace the withdraw body**

```rust
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
```

Note: `pre_auth_swap_transfer(env, pool, this, pool, lp_take)` authorizes
`pool.transfer(this, pool, lp_take)` — the LP token (the pair) transferring itself
to the pair for burning. If live testing shows the router routes the LP transfer to a
different target, adjust the `to` argument to match the router's actual sub-invocation
(verify with the failing auth error's expected context).

- [ ] **Step 2: Verify it compiles + auth-boundary tests pass**

Run: `cargo test -p baku-soroswap-strategy`
Expected: PASS (`withdraw_from_non_vault_reverts` etc. still hold).

- [ ] **Step 3: Commit**

```bash
git add crates/soroswap-strategy/src/lib.rs
git commit -m "feat(soroswap): withdraw removes LP pro-rata + swaps back to asset"
```

---

### Task 7: Rewrite `current_value` to use `position_value`

**Files:**
- Modify: `crates/soroswap-strategy/src/lib.rs` (the `fn current_value`)

- [ ] **Step 1: Replace the current_value body**

```rust
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
    let idle_asset = token::Client::new(&env, &asset).balance(&this);
    let idle_paired = token::Client::new(&env, &paired).balance(&this);
    let pair = SoroswapPairClient::new(&env, &pool_addr);
    let lp_bal = pair.balance(&this);
    let ts = pair.total_supply();
    let (r_asset, r_paired) = ordered_reserves(&pair, &asset);
    position_value(idle_asset, idle_paired, lp_bal, ts, r_asset, r_paired)
}
```

- [ ] **Step 2: Run the full crate test suite**

Run: `cargo test -p baku-soroswap-strategy`
Expected: PASS (all auth/admin/pure-math tests).

- [ ] **Step 3: Commit**

```bash
git add crates/soroswap-strategy/src/lib.rs
git commit -m "feat(soroswap): current_value reflects LP position + idle"
```

---

### Task 8: Update module doc, full build + clippy

**Files:**
- Modify: `crates/soroswap-strategy/src/lib.rs` (the `//!` header)

- [ ] **Step 1: Replace the V0 "swap-and-hold" header doc**

Replace the top-of-file `//!` block's "Why swap-and-hold" / "Funds flow" sections with a
V1 description:

```rust
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
//! `quote` against POST-swap reserves (see optimal_add_amounts), so the
//! authorized amounts match what the router moves within the single atomic tx.
//!
//! `current_value` is a spot-reserve estimate of the position (idle + LP share,
//! paired side quoted to asset). It is NOT manipulation-resistant — a TWAP /
//! oracle is the deferred V1→C hardening (see the design spec §9). Vault
//! `min_amount_out` is the actual withdrawal safety floor.
```

- [ ] **Step 2: Full workspace build to wasm + clippy**

Run: `stellar contract build`
Expected: `✅ Build Complete`, `baku_soroswap_strategy.wasm` emitted.

Run: `cargo clippy -p baku-soroswap-strategy --all-targets -- -D warnings`
Expected: no warnings.

- [ ] **Step 3: Run the whole workspace test suite (regression)**

Run: `cargo test`
Expected: all crates pass (allocator's 29 + others unaffected).

- [ ] **Step 4: Commit**

```bash
git add crates/soroswap-strategy/src/lib.rs
git commit -m "docs(soroswap): V1 LP module doc; build + clippy clean"
```

---

### Task 9: Deploy + live testnet demo (swap the child into the live allocator)

**Files:**
- Modify: `scripts/deployed.allocator.testnet.env` (record new child + tx hashes)

Addresses (from `scripts/deployed.allocator.testnet.env`): `ALLOCATOR_XLM=CDN5KSWY…`,
old soroswap child `CAI5MA4F…`, blend child `CAASZTCS…`, admin `GCWHAC…`,
`XLM_SAC=CDLZFC3S…`, pool `CCBX3NZT…`, router `CCJUD55A…`, circle USDC `CBIELTK6…`.
`VAULT_XLM=CCY337…` is currently active on the allocator.

- [ ] **Step 1: Drain the old swap-and-hold child to native, then remove it**

```bash
# weight old soroswap -> 0, native -> 7000 (blend stays 3000)
stellar contract invoke --id <ALLOC> --source admin --network testnet -- \
  set_target_weights --admin <ADMIN> \
  --child_weights "[[\"<BLEND_CHILD>\",3000],[\"<OLD_SORO>\",0]]" --native_bps 7000
# move the old child's funds into the native sleeve
stellar contract invoke --id <ALLOC> --source admin --network testnet -- rebalance --admin <ADMIN>
# now weight 0 + balance 0 → remove
stellar contract invoke --id <ALLOC> --source admin --network testnet -- \
  remove_child --admin <ADMIN> --strategy <OLD_SORO>
```
Expected: each tx succeeds; `children` no longer lists `<OLD_SORO>`.

- [ ] **Step 2: Deploy the new LP Soroswap child (vault = allocator)**

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/baku_soroswap_strategy.wasm \
  --source admin --network testnet -- \
  --admin <ADMIN> --vault <ALLOC> --asset <XLM_SAC> \
  --soroswap_pool <POOL> --soroswap_router <ROUTER> \
  --paired_asset <CIRCLE_USDC> --initial_apy_bps 500
```
Expected: prints the new child contract id → `NEW_SORO`.

- [ ] **Step 3: Register + re-weight 30/40/30**

```bash
stellar contract invoke --id <ALLOC> --source admin --network testnet -- \
  add_child --admin <ADMIN> --strategy <NEW_SORO> --authoritative true
stellar contract invoke --id <ALLOC> --source admin --network testnet -- \
  set_target_weights --admin <ADMIN> \
  --child_weights "[[\"<BLEND_CHILD>\",3000],[\"<NEW_SORO>\",4000]]" --native_bps 3000
```

- [ ] **Step 4: Rebalance to fund the LP child (real add_liquidity)**

```bash
stellar contract invoke --id <ALLOC> --source admin --network testnet -- rebalance --admin <ADMIN>
```
Expected: event log shows `add_liquidity` / pair `deposit` + a `sync`; no revert.

- [ ] **Step 5: Verify the LP position on-chain**

```bash
# LP-token balance of the new child must be > 0
stellar contract invoke --id <POOL> --source admin --network testnet -- balance --id <NEW_SORO>
# child value reflects the position
stellar contract invoke --id <NEW_SORO> --source admin --network testnet -- current_value
# vault still consistent
stellar contract invoke --id <VAULT_XLM> --source admin --network testnet -- total_assets
```
Expected: pair `balance(<NEW_SORO>) > 0` (holds LP tokens — the proof it's a real LP);
`current_value` ≈ the 40% sleeve; vault `total_assets` consistent with the split.

- [ ] **Step 6: Round-trip proof — small user deposit + redeem through the vault**

```bash
# deposit 50 XLM as test-user-1 (auto-splits; soroswap leg now adds liquidity)
stellar contract invoke --id <VAULT_XLM> --source test-user-1 --network testnet -- \
  deposit --depositor <U1> --assets 500000000
# read U1 share balance, then redeem it all (min_amount_out 0)
stellar contract invoke --id <VAULT_XLM> --source test-user-1 --network testnet -- \
  redeem --owner <U1> --shares <SHARES> --min_amount_out 0
```
Expected: deposit event log shows `add_liquidity`; redeem shows `remove_liquidity` + swap-back;
funds returned to U1.

- [ ] **Step 7: Record + commit**

Update `scripts/deployed.allocator.testnet.env` with `ALLOC_SOROSWAP_CHILD_XLM=<NEW_SORO>`
(replacing the old), a note that it is the LP version, and the new tx hashes.

```bash
git add scripts/deployed.allocator.testnet.env
git commit -m "chore(allocator): swap in real-LP soroswap child on testnet"
```

---

## Self-Review

**Spec coverage:** §5 deposit → Task 5; §6 withdraw → Task 6; §7 current_value/views → Task 7 (+ harvest/pool_apy unchanged, still correct); §3 interfaces → Task 1; §4 storage (no change) → n/a; §8 errors/slippage → reused throughout; §10 testing → Tasks 2,3 (pure) + existing auth-boundary + Task 9 (live integration); §11 deploy/demo → Task 9; §12 acceptance → Tasks 8 (build/clippy/tests) + 9 (LP balance > 0, round-trip). §9 Path-to-C is intentionally out of scope (documented only). ✓ no gaps.

**Placeholder scan:** Task 9 uses `<ALLOC>`, `<NEW_SORO>`, etc. — these are runtime values resolved from `scripts/deployed.allocator.testnet.env` at execution, not plan placeholders for code. All code steps contain complete code. ✓

**Type consistency:** `ratio_quote(amount_a, reserve_a, reserve_b)`, `optimal_add_amounts(asset_bal, paired_bal, reserve_asset, reserve_paired) -> (i128,i128)`, `position_value(idle_asset, idle_paired, lp_bal, total_supply, reserve_asset, reserve_paired) -> i128`, `pre_auth_two_transfers(env, token_a, token_b, strategy, pair, amount_a, amount_b)` — names/signatures consistent across Tasks 2,3,4,5,6,7. Router client methods `add_liquidity`/`remove_liquidity` and pair `balance`/`total_supply` declared in Task 1 and used in 5,6,7. ✓
