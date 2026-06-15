# SoroswapStrategy V1 — Real LP Provision

- **Date:** 2026-06-06
- **Status:** Approved (design) — scope **B** (implement + deploy to testnet + live demo + re-activate on `VAULT_XLM`)
- **Crate:** `crates/soroswap-strategy` (modified in place)
- **Supersedes:** the V0 "swap-and-hold" behavior documented in the same crate.

## 1. Motivation

The V0 `SoroswapStrategy` is a **swap-and-hold** adapter: on deposit it swaps half the
asset to the paired token and just *holds* both. It never provides liquidity, so it
**earns no yield** — it only pays the ~0.30%/leg swap fee and carries XLM/USDC price
exposure on the held USDC. A real Soroswap LP earns 0.30% of all trades routed through
the pool, pro-rata to its LP share. This upgrade makes the strategy a genuine LP: the
40% Soroswap sleeve will deposit into the pool, hold LP tokens, and earn trading fees.

The `StrategyInterface` shape does not change — the vault and the meta-allocator drive
this strategy through the same `deposit/withdraw/current_value/harvest/pool_apy`
methods. Only the internals change.

## 2. Goals / Non-goals

**Goals (scope B):**
- Deposit provides real liquidity via `router.add_liquidity`; the strategy holds LP tokens.
- Withdraw removes liquidity pro-rata and returns a single asset (the underlying) to the caller.
- `current_value` reflects the LP position's worth in underlying terms.
- Deploy a fresh LP child, swap it into the live allocator, re-activate on `VAULT_XLM`, and
  demonstrate the 40% sleeve holding LP tokens on-chain.

**Non-goals (deferred to C — see §9):**
- Manipulation-resistant valuation (TWAP / oracle). V1 keeps a spot-reserve estimate.
- Optimal zap-in math. V1 uses the simple "swap ~half, add liquidity, hold the remainder."
- LP incentive/gauge reward claiming.
- A mock AMM router for deterministic CI integration tests.

## 3. On-chain interfaces (verified against the live testnet router/pair)

Router (`CCJUD55A…`):
```
add_liquidity(token_a, token_b, amount_a_desired, amount_b_desired,
              amount_a_min, amount_b_min, to, deadline) -> (used_a, used_b, lp_minted)
remove_liquidity(token_a, token_b, liquidity, amount_a_min, amount_b_min,
                 to, deadline) -> (out_a, out_b)
swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline) -> Vec<i128>
```

Pair (`CCBX3NZT…`) **is itself the LP token** (SEP-41):
```
balance(id) -> i128          // strategy's LP-share balance
total_supply() -> i128       // total LP shares
get_reserves() -> (i128, i128)
token_0() -> Address
```

The hand-declared `contractclient` traits in the crate are extended with
`add_liquidity` / `remove_liquidity` on the router client and `balance` /
`total_supply` on the pair client. No new dependency is added.

## 4. Storage

Unchanged. `SoroswapPool` (the pair address) doubles as the LP-token address, so no new
`DataKey` is required. Existing keys: `Admin, Vault, Asset, SoroswapPool,
SoroswapRouter, PairedAsset, ApyBps, MaxSlippageBps`.

## 5. Deposit — `deposit(vault, amount)`

1. `assert_vault(vault)`; require `amount > 0`; require `amount/2 > 0`.
2. Read ordered reserves. Compute `swap_amount = amount / 2`.
3. **Pre-auth #1:** `asset.transfer(self, pair, swap_amount)`. Swap `swap_amount` asset→paired
   via `swap_exact_tokens_for_tokens` with a slippage-floored `amount_out_min`.
4. Now hold `asset_bal = amount - swap_amount` and `paired_bal = received`.
5. `amount_a_desired = asset_bal`, `amount_b_desired = paired_bal`;
   `amount_a_min / amount_b_min = desired × (1 − max_slippage_bps)`.
6. **Pre-auth #2 and #3:** `asset.transfer(self, pair, amount_a_desired)` and
   `paired.transfer(self, pair, amount_b_desired)` — the two transfers `add_liquidity`
   performs internally.
7. `router.add_liquidity(asset, paired, …, to=self, deadline)` → mints LP tokens to the
   strategy. The router consumes the optimal ratio ≤ desired; the small one-sided
   remainder stays as **idle** balance on the strategy (counted by `current_value`).
8. If `lp_minted <= 0` → `Err(PoolError)`. Else `Ok(())`.

**Auth note:** deposit pre-authorizes **3** sub-transfers. `mock_all_auths` does not
exercise this; correctness is proven by the live testnet deposit (the codebase's standing
convention for pool-touching strategies).

## 6. Withdraw — `withdraw(vault, amount)`

1. `assert_vault(vault)`; require `amount > 0`.
2. `V = current_value()`. If `V <= 0` → `Err(InsufficientLiquidity)`. Clamp `amount` to `V`.
3. Fraction `f = amount / V`. Compute pro-rata takes:
   `lp_take = lp_bal × f`, `idle_asset_take = idle_asset × f`, `idle_paired_take = idle_paired × f`.
4. **Pre-auth:** LP-token transfer for the burn (`self → pair`, exact target verified live).
   `router.remove_liquidity(asset, paired, lp_take, mins, to=self, deadline)` → `(out_a, out_b)`
   (these are the *actual* asset/paired amounts returned by the router).
5. `paired_to_swap = out_b + idle_paired_take`. If `> 0`: **pre-auth** the swap transfer
   `paired.transfer(self, pair, paired_to_swap)`; swap paired→asset with a slippage-floored
   min; capture the *actual* `swapped_asset` returned.
6. Deliver = `out_a + idle_asset_take + swapped_asset` — composed from the **actual**
   returned amounts (router + swap), NOT a naive balance delta (which would wrongly sweep
   the un-withdrawn fraction's pre-existing idle). The remaining `idle_asset × (1 − f)` and
   LP `× (1 − f)` stay. Transfer `Deliver` to `vault`; return it. If `Deliver <= 0` →
   `Err(InsufficientLiquidity)`.

## 7. Views

- **`current_value()`** =
  `idle_asset + quote(idle_paired → asset)`
  `+ (lp_bal/total_supply) × reserve_asset`
  `+ quote((lp_bal/total_supply) × reserve_paired → asset)`.
  Panic-safe (saturating math; returns 0 on missing storage / zero supply). **Spot-reserve
  estimate** — the V1 caveat (see §9).
- **`harvest(vault)`** = no-op returning 0. Soroswap fees auto-accrue into pool reserves,
  so the LP position's value rises through `current_value` without an explicit claim.
- **`pool_apy()`** = stored `ApyBps` (admin-set informational estimate; LP APY is an
  off-chain volume/fee signal, not computable on-chain).

## 8. Errors / config

- Reuse `StrategyError`: `Unauthorized, InvalidAmount, PoolError, InsufficientLiquidity, NotInitialized, AdminOnly, InvalidApyBps`.
- Reuse `DEFAULT_MAX_SLIPPAGE_BPS = 100` (1%), `DEADLINE_SECONDS = 60`. Every leg
  (swap in, add_liquidity, remove_liquidity, swap back) is floored by the slippage tolerance.

## 9. Path to C (deferred — what's left after B)

B ships a real LP that earns fees but values itself from **spot reserves**, so
`current_value` (and therefore the vault's price-per-share when this strategy is active)
is **manipulable within a single block** by moving the pool. Keeping `authoritative=true`
is acceptable for the testnet demo but is **not production-safe**. To reach C:

1. **Manipulation-resistant valuation.** Replace the spot-reserve read in `current_value`
   with one of:
   - a **TWAP** from the pair's cumulative-price accumulators (if exposed), or
   - an **external price oracle** (e.g. Reflector) to value the LP position independent of
     instantaneous reserves.
   Introduce a small `valuation` abstraction so the source is swappable.
2. **Sanity bounds.** Reject reads where spot deviates from TWAP/oracle beyond a threshold,
   and/or use `pair.k_last` + `get_reserves` invariant checks to detect manipulated state.
3. **Legitimize `authoritative`.** Only after (1)+(2) is `authoritative=true` truly
   justified; until then the allocator's weight guard is being overridden by the operator.
4. **Optimal zap-in.** Replace "swap half" with the closed-form swap amount that leaves
   minimal idle dust.
5. **Incentive claiming.** If Soroswap adds farming/gauges, implement reward claim +
   compounding in `harvest`.
6. **Deterministic tests.** Build a mock AMM router so add/remove/swap correctness can be
   unit/property/fuzz-tested in CI (today there is no mock; live demo is the only integration
   proof).
7. **MEV/slippage tuning.** Tighten per-leg min floors and deadline; document the residual
   sandwich exposure on deposit/withdraw legs.

## 10. Testing strategy (B)

- **Pure-math unit tests:** LP-share valuation, the swap-half/zap split, slippage floors,
  `quote_amount_out` pinning (retain existing). No live pool needed.
- **Auth-boundary tests:** deposit/withdraw/harvest from non-vault revert; admin-only
  setters — same pattern as V0 (these stop at the auth boundary because the real pool
  client can't be mocked).
- **Live integration (the real proof):** testnet deposit → redeem through the LP strategy,
  asserting the strategy holds **LP tokens > 0**, `current_value` tracks the position, and
  a round-trip returns approximately the deposit (minus one entry/exit swap on the
  rebalanced half + the LP fee the position now earns).

## 11. Deploy / demo sequence (B)

Operate on the **existing live allocator** `CDN5KSWY…` (currently active on `VAULT_XLM`
with the V0 swap-and-hold child `CAI5MA4F…` at 40%):

1. Build the new LP wasm.
2. `set_target_weights(blend=3000, soroswap_old=0, native=7000)` then
   `allocator.rebalance` → drains the old swap-and-hold child into the native sleeve.
3. `allocator.remove_child(soroswap_old)` (now weight 0, balance 0).
4. Deploy the new LP `SoroswapStrategy` child with `vault = allocator`.
5. `allocator.add_child(new_lp_child, authoritative=true)`;
   `set_target_weights(blend=3000, new_lp=4000, native=3000)`.
6. `allocator.rebalance` → funds the LP child, which calls `add_liquidity` for real.
7. Verify on-chain: the LP child's `pair.balance(child) > 0` (holds LP tokens),
   `child.current_value()` reflects the position, vault `total_assets` consistent.
8. Update `scripts/deployed.allocator.testnet.env` with the new child address + tx hashes.

The vault stays active on the same allocator throughout; only the Soroswap child is
replaced. This also demonstrates the allocator's child-lifecycle (`add/remove_child` +
`rebalance`) on-chain.

## 12. Acceptance criteria

- `cargo test -p baku-soroswap-strategy` green; `cargo clippy` clean at `-D warnings`;
  workspace builds to wasm.
- A fresh LP child deployed on testnet holds `pair.balance > 0` after funding.
- A testnet deposit→redeem round-trip through the LP child completes and returns funds.
- The live allocator's 40% sleeve is backed by an LP position (not a swap-and-hold basket).
- The Path-to-C section (§9) is recorded for the follow-up.
