# Baku Weighted Meta-Allocator Strategy — Design Spec (V0)

- **Date:** 2026-06-05
- **Status:** Reviewed (brainstorm → /plan-eng-review → 3-lens adversarial sweep). Ready for implementation plan.
- **Scope:** New contract crate + comprehensive tests only. Deploy/API wiring deferred.
- **Vault impact:** ZERO. The audited `BakuVault` (`crates/vault/src/lib.rs`) is untouched.

---

## 1. Problem

Today the vault routes 100% of every deposit to a single active strategy
(`crates/vault/src/lib.rs:94` `deposit`, `DataKey::ActiveStrategy`). There is no
way to express a blended allocation like "30% Blend + 40% Soroswap + remaining
native." We want weighted multi-strategy allocation **without** touching the
audited vault or its ERC-4626 share math.

## 2. Approach — Meta-Allocator adapter

A new Soroban contract, crate **`crates/allocator-strategy`** (package
`baku-allocator-strategy`), that **implements the existing `StrategyInterface`**
(`crates/strategy-trait/src/lib.rs:33`). From the vault's view it is one strategy,
so the vault is untouched. Internally it holds N child strategies + a native cash
sleeve and splits funds by configurable weights.

It is a **router, not a share token** — it mints nothing. The parent vault's
share math keeps working because `vault.total_assets()` reads
`allocator.current_value()`.

**Dual role:**
- *Strategy* to the vault — the vault is its sole authorized caller of
  `deposit`/`withdraw`/`harvest`.
- *Vault* to its children — it is the address children `require_auth` on (same
  trust pattern the real vault uses with strategies today).

```
                 deposit/withdraw/harvest (vault is sole caller)
   BakuVault  ───────────────────────────────────────────►  Allocator
   (untouched,                                                 │
    ERC-4626                                                   │ pro-rata by weight (deposit)
    shares)    ◄───── current_value() (total_assets) ──────── │ pro-rata by value  (withdraw)
                                                               ▼
                              ┌──────────────┬──────────────┬───────────────┐
                              │ child[0]     │ child[1]     │ native sleeve │
                              │ Blend (auth) │ Soroswap(LP) │ raw underlying│
                              │ weight 6000  │ weight 0*    │ weight 4000   │
                              └──────────────┴──────────────┴───────────────┘
   * non-authoritative children are registrable but cannot hold weight in V0 (see §6 T1)
```

## 3. Locked decisions (from /plan-eng-review)

1. **Build the custom meta-allocator** (not DeFindex). Full in-house control.
2. **Two-pass atomic rebalance** (drain all overweight → native, then fund all
   underweight from native). Document the transient `InsufficientLiquidity` →
   admin-retry behavior inherited from LP estimate drift.
3. **LP-estimate risk** — upgraded from "document only" to an **on-chain guard**
   (see §6 T1). V0 live basket is Blend-only (authoritative value).
4. **Single source of truth** for weights: one ordered `Vec<ChildSlot>`. Dust
   sink is the **native sleeve** (not the last child); zero-rounding portions are
   skipped (see §6 T2).
5. **LP risk paths tested with the real `soroswap-strategy`** against a
   deterministically-seeded test pool. Faithful mocks for unit-level
   split/auth/lifecycle tests.
6. **`MAX_CHILDREN = 5`** cap (bounds `current_value()` O(N) cross-contract reads
   under Soroban budget; also bounds cumulative per-op rounding loss).

## 4. Storage / data model

```rust
#[contracttype]
struct ChildSlot {
    strategy: Address,
    weight_bps: u32,
    authoritative: bool, // true only if current_value() is a real balance (Blend),
                         // false for estimate-based LP children (Soroswap)
}

enum DataKey {
    Admin,            // allocator's own admin (NOT the vault): weights, rebalance, child mgmt, pause
    Vault,            // sole authorized caller of deposit/withdraw/harvest
    Asset,            // the single underlying (e.g. XLM); ALL children share it
    Children,         // Vec<ChildSlot> — single source of truth, ordered
    NativeBps,        // u32 — bps held as raw underlying
    PoolApyOverride,  // Option<u32>
    Paused,           // bool — fail-closed circuit breaker
}

const MAX_CHILDREN: u32 = 5;
const BPS_DENOM: u32 = 10_000;
```

**Invariants (enforced on every mutation):**
- `sum(child.weight_bps) + NativeBps == 10_000`
- any child with `weight_bps > 0` ⟹ `authoritative == true`
- `Children.len() <= MAX_CHILDREN`

## 5. Flows

### 5.1 Core (vault-authorized)

Auth pattern for `deposit`/`withdraw`/`harvest`: assert the passed `vault ==
stored Vault`, then `vault.require_auth()`. Mirrors the existing strategies.

**`deposit(vault, amount)`**
- `require !Paused`; vault-auth; `amount > 0` else `AmountZero`.
- Vault has already transferred `amount` underlying to the allocator (same
  convention as vault→strategy today).
- For each child with `weight_bps > 0`: `slice = checked_mul/checked_div(amount,
  weight_bps, BPS_DENOM)` → `MathOverflow` on overflow. **Skip if `slice == 0`.**
  Transfer `slice` to child; `child.deposit(self, slice)`. Any failure →
  `ChildDepositFailed` (atomic revert).
- Native slice = `amount - sum(slice_i)` stays as raw balance (absorbs dust).

**`withdraw(vault, amount) -> actual`** (MEASURED DELTA — never returns `amount`)
- `require !Paused`; vault-auth; `amount > 0`.
- `pre = token.balance(self)`.
- **Single `current_value` pass:** read each child cv via `try_current_value`
  (authoritative failure → revert = fail-closed; non-authoritative → `0`).
  `total = sum(cv_i) + native_balance`. If `total <= 0` → `EmptyBasket`.
- For each weighted child: `portion = min(checked_mul/div(amount, cv_i, total),
  cv_i)` (clamp to just-read value — fixes TOCTOU). **Skip if `portion == 0`**
  (never call `child.withdraw(.., 0)` — children revert on it). Else
  `child.withdraw(self, portion)` (child delivers into self).
- `native_portion = checked_mul/div(amount, native_balance, total)`.
- `post = token.balance(self)`. `actual = (post - pre) + native_portion`.
- `token.transfer(self → vault, actual)`. Return `actual`. Vault enforces
  `min_amount_out` on top (`crates/vault/src/lib.rs:160`).

**`current_value() -> i128`**
- `sum over children of (authoritative ? try_current_value()? : try_current_value().unwrap_or(0)) + token.balance(self)`.
- Authoritative child read failure **reverts** (fail-closed: halts vault
  deposit+redeem rather than mispricing). This is why we do NOT fall to 0 for
  authoritative children (silent 0 enables a reverse deposit sandwich).

**`harvest(vault) -> i128`**
- vault-auth; fan out `try_harvest(self)` per child, sum successes (best-effort;
  a failing child is skipped, not fatal). Informational return only — never fed
  into price-per-share (PPS comes from measured `current_value`).

**`pool_apy() -> u32`**
- `PoolApyOverride` if set, else target-weight-weighted average of
  `try_pool_apy().unwrap_or(0)`. Display-only; child admins can set their own apy
  arbitrarily, so treat as untrusted display.

### 5.2 Admin-authorized

- **`set_target_weights(admin, weights: Vec<(Address,u32)>, native_bps)`** —
  reject unless sum == 10_000, every address is a known child, and no
  non-authoritative child gets `weight > 0` (`NotAuthoritative`). Targets only,
  no fund movement.
- **`rebalance(admin)`** — `require !Paused`; **two-pass atomic**: pass 1 drains
  every overweight child into the native sleeve; pass 2 funds every underweight
  child from native. Checked math throughout. In V0 only authoritative (Blend)
  children carry weight, so there is no AMM swap leg → the P1-G swap-sandwich
  vector is moot in V0 (re-enable per-leg `min_out` params when LP children are
  weighted in V1). Document the transient `InsufficientLiquidity` → retry.
- **`add_child(admin, strategy, authoritative)`** — dedupe (`ChildAlreadyExists`);
  enforce `MAX_CHILDREN`; append with `weight_bps = 0`. Admin asserts
  `authoritative` (trusted: true only for real-balance strategies like Blend).
- **`remove_child(admin, strategy)`** — require `weight_bps == 0` (`ChildHasWeight`)
  AND `try_current_value() == 0` (`ChildHasBalance`); remove. Freed bps already 0.
- **`force_remove_child(admin, strategy)`** — require `weight_bps == 0`; **skip the
  cv==0 check** (evicts a wedged/panicking child). KNOWN LIMITATION: any funds
  stuck in a force-removed child are abandoned — documented, V0-acceptable for a
  contract that is otherwise bricked by that child.
- **`set_paused(admin, bool)`** — circuit breaker; when paused, `deposit` and
  `withdraw` revert with `Paused`.
- **`set_pool_apy_bps(admin, bps)`** — sets `PoolApyOverride`.

### 5.3 Constructor

`__constructor(admin, vault, asset, initial_children: Vec<(Address,u32,bool)>,
native_bps)` — validate weight sum == 10_000, count <= MAX_CHILDREN, and every
weighted child is authoritative. Can start all-native (empty children,
native_bps = 10_000).

## 6. Adversarial-review resolutions

### Folded in as correctness fixes (no decision needed)
- **P0-A** withdraw returns measured balance delta, never `amount`.
  (`vault/src/lib.rs:175` forwards exactly the returned value; every child
  under-delivers — Blend liquidity-capped at `blend-strategy/src/lib.rs:225`,
  Soroswap fees+double-floor.)
- **P0-C core** `try_*` per-child reads (a non-try read of one bad child bricks
  every vault op — the exact lesson `defindex-strategy/src/lib.rs:291-298`
  codified).
- **P1-D** single cv pass + clamp each request to just-read cv (withdraw TOCTOU).
- **P1-E** `checked_mul`/`checked_add → MathOverflow` in every `slice_i` /
  `portion_i` (`amount*cv` overflows i128 near large balances; mirrors
  `vault/src/lib.rs:490-520`). Never `saturating_mul` for share math.
- **P1-F** `total <= 0` typed guard before any division (mirrors
  `strategy-trait/src/lib.rs:80`).

### Decided (tensions — user chose)
- **T1 / P0-B** — on-chain `authoritative_value` guard; reject `weight > 0` for
  non-authoritative children. (Documentation is not a control: one
  `set_target_weights` could expose the whole vault to a ~7% deposit/redeem
  sandwich via Soroswap's instantaneous cv at `soroswap-strategy/src/lib.rs:400-422`.)
- **T2** — dust → native sleeve; skip zero-portion child calls (a `child.withdraw(.., 0)`
  reverts as `InvalidAmount` at blend:132 / soroswap:288,335).
- **P0-C operational** — fail-closed pause flag + admin `force_remove_child`
  (skip cv==0) so a wedged child can be evicted.

## 7. Errors (`AllocatorError`)

`NotInitialized, Unauthorized, AmountZero, WeightsSumInvalid, UnknownChild,
ChildAlreadyExists, ChildHasWeight, ChildHasBalance, ChildDepositFailed,
ChildWithdrawFailed, MaxChildrenExceeded, MathOverflow, NotAuthoritative, Paused,
EmptyBasket`.

## 8. Testing

Unit (faithful `mock-strategy` children): deposit pro-rata split + dust→native;
all-native config; auth negatives per function (non-vault on core, non-admin on
admin fns); amount<=0; `set_target_weights` sum/unknown/non-authoritative
rejection; `add_child`/`remove_child`/`force_remove_child` lifecycle; constructor
validation; `MAX_CHILDREN` enforcement; pause halts deposit+withdraw; pool_apy
weighted-avg + override.

Integration with **real `soroswap-strategy` + test pool** (locked #5 — the mock
can't reproduce under-delivery): withdraw `actual < estimated`; rebalance drain
shortfall; transient `InsufficientLiquidity` revert; child cv drops between vault
read and allocator re-read.

Integration `BakuVault → allocator → children`: deposit→redeem round-trip share
math holds; monotonicity (round-trip never returns > deposited); redeem amounts
1..k stroops against a 5-child basket never revert.

Adversarial-required: budget tracer at N=MAX_CHILDREN with heaviest child;
overflow at `total_assets ≈ i128::MAX/2` with 2 children; all-zero children +
zero native; single-child / `native_bps == 0` baskets.

## 9. NOT in scope (deferred, with rationale)

- **Deploy script + testnet registration/activation** on vault-xlm v2 — separate
  follow-up; this spec is contract + tests (tracer-first).
- **API surface** for per-child allocation breakdown / weight management — the
  existing `sharePercent` view already reports current allocation read-only.
- **Per-deposit auto-rebalance** — deposits are pro-rata by weight; drift is
  corrected by admin `rebalance` (locked).
- **LP children with weight (V1)** — V0 keeps weighted children Blend-only; LP
  registrable but unweightable until the V1 manipulation hardening (TWAP/oracle
  or per-leg min_out) lands.
- **Recovery of funds from a force-removed wedged child** — abandoned in V0;
  documented limitation.
- **Wasm build/publish pipeline** — distribution deferred with deploy.

## 10. What already exists (reuse, not rebuild)

- `StrategyInterface` + `StrategyClient` (`strategy-trait/src/lib.rs:33`) —
  implemented as-is.
- `mock-strategy` — reused as faithful test children.
- `soroswap-strategy` — reused as the real LP child in integration tests.
- Vault `rebalance` drain→transfer→deposit pattern (`vault/src/lib.rs:287-362`) —
  template for child fund movement + the measured-delta and transient-revert
  patterns.
- `preview_redeem` (`strategy-trait/src/lib.rs:79`) and the vault's
  `checked_mul`/virtual-offset math (`vault/src/lib.rs:483-521`) — math templates.
