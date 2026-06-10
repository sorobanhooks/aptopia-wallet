# Multi-tx Buffer-First Redemption for the Weighted Allocator

- **Date:** 2026-06-06
- **Status:** Approved (design)
- **Crates:** `crates/allocator-strategy` (withdraw + new per-child primitives), `crates/vault` (additive queued-redemption entrypoints)
- **Builds on:** the Soroswap V1 real-LP strategy (`2026-06-06-soroswap-lp-strategy-v1-design.md`), already implemented and proven on-chain.

## 1. Motivation

Live testing showed that a user redemption routed through the 30/40/30 allocator
(`vault.redeem → allocator.withdraw → Blend pool.submit(Withdraw) + Soroswap
remove_liquidity + swap-back`, all in one tx) exceeds Soroban's per-transaction
memory budget (`Error(Budget, ExceededLimit)` / `Memory(OutOfBoundsGrowth)`). The
memory is dominated by the host loading the large **callee** contracts (Blend pool
~57 KB + Soroswap router ~34 KB + Soroswap pair ~28 KB) in one tx; it is NOT a
client-side issue (our strategy wasms are ~10-15 KB), so a lighter Blend client does
not help. Deposits (Blend supply + Soroswap add_liquidity, no Blend withdraw) DO fit
and are unchanged.

**Hard requirements (from product):**
- Deposit stays a single transaction that fans out across all strategies (30/40/30).
- The 30/40/30 single basket (Blend + Soroswap-LP + native) is preserved.
- Withdrawals may span multiple transactions.

**Approach:** never touch Blend `pool.submit` AND Soroswap `remove_liquidity` in the
same tx. The 30% native sleeve doubles as a redemption buffer (instant redeems). Any
draining of liquidity is **one heavy protocol per tx**. Allocation fidelity (and
therefore realized vs promised yield) is maintained by a **per-child** rebalance that
restores 30/40/30 pro-rata across separate txs — never structurally favoring one
provider.

### Note on yield honesty (design rationale)
The headline APY (`allocator.pool_apy`) is the target-weighted blend with the 0%-yield
native sleeve in the denominator: `Σ(child_apy × child_weight_bps) / 10000`. The 30%
native already drags the headline down to an honest number (e.g. Blend 500@30% +
Soroswap 500@40% ⇒ 350 bps, not 500). Buffer-first redemption reuses this existing
sleeve; it adds no new drag. Realized yield tracks the promise as long as the per-child
rebalance restores the target ratios after redemptions — which is why draining is
always pro-rata across providers, not single-provider-first. `native_bps` is the
operator's buffer-vs-drag dial (larger = more instant redeems + more drag).

## 2. Allocator changes (`baku-allocator-strategy`)

### 2.1 `withdraw` becomes native-only
`StrategyInterface::withdraw(vault, amount)` serves the redemption purely from the
allocator's own native (asset) balance:
- `assert_vault`, `require_not_paused`, `amount > 0`.
- `native = token.balance(self)`. If `amount > native` → `Err(InsufficientBuffer)`
  (new `AllocatorError` variant; mapped to `StrategyError::PoolError` on the trait
  boundary so the vault sees a failure). NO child calls.
- Else transfer `amount` to `vault`, return `amount`. Always fits memory.

The previous pro-rata-across-all-children withdraw is REMOVED (it was the memory
culprit). Pro-rata fairness is now restored by rebalancing, not per-redeem.

### 2.2 New per-child primitives (admin-gated, one heavy protocol per tx)
- **`drain_child(admin, child, amount) -> i128`**: require_admin; require child registered;
  `child.withdraw(self, amount)`; returns the measured amount delivered into native.
  Used to fund large queued claims (drain an arbitrary amount from ONE child).
- **`fund_child(admin, child, amount)`**: require_admin; require child registered;
  require `native >= amount`; `token.transfer(self, child, amount)`; `child.deposit(self, amount)`.
  Used to push idle native into a child.
- **`rebalance_step(admin, child)`**: require_admin; require_not_paused. Compute
  `total = native + Σ child_value` (value pass) and `target = total × child.weight_bps / 10000`.
  If `child_value > target` → drain the excess (`child.withdraw(self, excess)`); if
  `child_value < target` → fund the deficit from native (capped at available native).
  One child per tx. Calling it for each weighted child restores 30/40/30 across txs.
  This is the multi-tx replacement for the one-shot `rebalance` and also the
  buffer-refill mechanism (after redemptions, native is below target ⇒ children above ⇒
  each step drains the excess into native). Memory-safe: a value pass plus ONE child's
  drain/fund — equal to the LP-drain that already fit on-chain.

The existing one-shot `rebalance` is retained for light baskets but documented as
**unusable for a Blend+LP basket** (exceeds memory); operators use `rebalance_step`.

### 2.3 New view
- **`buffer() -> i128`**: the allocator's current native (asset) balance — i.e. the
  instantly-withdrawable amount. Read by the vault's `instant_redeemable_assets()` for
  dApp routing.

### 2.4 Unchanged
`deposit` (single-tx fan-out), `current_value` (panic-safe), `add_child`,
`remove_child`, `force_remove_child`, `set_target_weights`, `set_paused`, `set_vault`,
`harvest`, `pool_apy`, `set_pool_apy_bps`, all views.

## 3. Vault changes (`baku-vault`) — additive; `deposit` untouched

### 3.1 `redeem` (instant path) — logic unchanged
`redeem(owner, shares, min_out)` still calls `strategy.try_withdraw(vault, estimated)`.
With the allocator now native-only, this succeeds in one tx when the buffer covers the
redemption, and reverts cleanly (`StrategyFailed`) when it does not — the signal to use
the queue. Add a view:
- **`instant_redeemable_assets() -> i128`** = the active strategy's instantly-withdrawable
  amount. For the allocator this is its native balance. The dApp/API compares
  `preview_redeem(shares)` against this to route a user to `redeem` vs `request_redeem`.

(Implementation: the allocator exposes a view `buffer() -> i128` returning native; the
vault's `instant_redeemable_assets` reads it. For non-allocator strategies it may return
`current_value`.)

### 3.2 Queued redemption — new entrypoints + ledger
Storage: `PendingRedemptions: Map<u64, Pending>` where
`Pending { owner: Address, shares: i128, min_out: i128 }`, plus a `NextRequestId: u64`.

- **`request_redeem(owner, shares, min_out) -> u64`**: `owner.require_auth`; `shares > 0`;
  `Base::balance(owner) >= shares`. **Escrow the shares**: `Base::update(Some(owner),
  Some(vault_self), shares)` (transfer owner → vault; NOT burned, so they keep earning
  yield while queued). Record `Pending`; return the new id. Light tx — no strategy calls.
- **`claim_redeem(id)`**: load `Pending`; `owner.require_auth` (only owner claims).
  Compute `owed = convert_to_assets(shares, total_assets, total_supply)` at the CURRENT
  price-per-share. If `owed < min_out` → `SlippageExceeded`. Call
  `strategy.try_withdraw(vault, owed)` (native-only; reverts if buffer not yet funded →
  surfaces as "not ready, wait for drain"). On success: burn the escrowed shares
  (`Base::update(Some(vault_self), None, shares)`), transfer `owed` to `owner`, remove
  the pending entry. Solvent by construction (pays only current basket value, only when
  the buffer holds it).
- **`cancel_request(id)`**: `owner.require_auth`; return the escrowed shares
  (`Base::update(Some(vault_self), Some(owner), shares)`); remove the entry. Liveness
  escape hatch if a claim is never funded.
- Views: **`pending_redemption(id) -> Option<Pending>`**, **`total_pending_shares() -> i128`**.

### 3.3 Funding the queue (off-chain keeper, on-chain primitives)
A keeper (admin) services the queue using the allocator's `drain_child` /
`rebalance_step` (Section 2.2): drain children one-per-tx until the allocator's native
buffer covers the pending claims, then users `claim_redeem`. After servicing, a
`rebalance_step` round restores 30/40/30. **V1 decision: draining is admin-gated**
(matches existing `rebalance`/`set_target_weights` gating). KNOWN LIMITATION: large
redemptions depend on the keeper; a future "permissionless-but-bounded-to-pending"
drain removes that dependency (deferred).

## 4. The three flows (end to end)

1. **Deposit** (1 tx, unchanged): user → vault → allocator splits 30/40/30 (Blend supply
   + Soroswap add_liquidity + native retained). Fits memory.
2. **Instant redeem** (1 tx): user → `vault.redeem` → `allocator.withdraw` from native
   buffer → user. No Blend/Soroswap calls. Fits.
3. **Queued redeem** (multi-tx): user → `vault.request_redeem` (escrow shares) → keeper
   `drain_child`/`rebalance_step` (1 tx each, repeat until native funded) → user
   `vault.claim_redeem`. Then keeper `rebalance_step(blend)` + `rebalance_step(soroswap)`
   to restore 30/40/30.

## 5. Key decisions (locked)
- **Share/price timing:** lock (escrow) shares at request; price (`convert_to_assets`)
  and burn at claim, at current price-per-share. Fair, solvent, and the owner keeps
  earning yield while queued. (Chosen over burn-at-request, which risks LP-exit-slippage
  insolvency.)
- **Draining authorization:** admin/keeper-gated for V1 (flagged limitation in §3.3).
- **Pro-rata fidelity:** draining/refill always restores target weights across providers
  (`rebalance_step` per child), so no provider is structurally favored and realized yield
  tracks `pool_apy`.

## 6. Error handling / edge cases
- `InsufficientBuffer` when `withdraw`/`claim` exceeds native; surfaces to the user as
  "use the queue" / "not yet funded, wait".
- `claim_redeem` reverts (no state change) if the buffer is not yet funded; the user
  retries after a drain, or `cancel_request`.
- `min_out` enforced at claim time (post-yield/price).
- Pending claims survive rebalances (independent ledger entries).
- Escrowed shares are excluded from a holder's transferable balance (held by the vault)
  but remain in `total_supply` until claim, so they keep earning — intended.
- Reentrancy: external calls (strategy withdraw, token transfer) happen after state reads;
  burn/transfer ordering in `claim_redeem` follows checks-effects-interactions where
  practical; document the trust boundary (strategy is vault-trusted).
- Zero/!registered/unknown-id inputs rejected with typed errors.

## 7. Testing strategy
- **Allocator units:** native-only `withdraw` (serves ≤ native; reverts `InsufficientBuffer`
  above); `drain_child` delivers measured amount; `fund_child` requires native;
  `rebalance_step` drains-when-over / funds-when-under to the correct target (pure target
  math + auth-boundary). Pool-touching paths validated live (no mock AMM/pool).
- **Vault units:** `request_redeem` escrows shares + records pending; `claim_redeem`
  prices at current PPS, burns escrow, pays, enforces `min_out`, reverts when buffer
  unfunded; `cancel_request` returns shares; `instant_redeemable_assets` reflects buffer;
  pending ledger CRUD; share-accounting invariants (total_supply, escrow balance).
- **Live testnet (the integration proof):** single-tx deposit; instant redeem from
  buffer; large redeem via `request_redeem` → multi-tx `drain_child`/`rebalance_step` →
  `claim_redeem`; a `rebalance_step` round restoring 30/40/30 — every tx within memory.

## 8. Deploy / demo (testnet)
Reuse the existing allocator `CDN5KSWY…` + LP child `CBOUW5FF…` + Blend child `CAASZTCS…`
(redeploy the allocator with the new withdraw/primitives; the children are unchanged).
Sequence: deploy new allocator wasm; (re)wire children + 30/40/30; register on a vault;
fund via single-tx deposit; demonstrate instant redeem from buffer; demonstrate a large
queued redeem (request → drain steps → claim); demonstrate `rebalance_step` restoring
30/40/30. Because activating on the canonical `VAULT_XLM` again carries the same
care as before (it currently safely runs plain Blend), the demo MAY use a fresh
test vault to avoid disturbing the canonical one — decided at plan time.

## 9. Acceptance criteria
- `cargo test` green (allocator + vault new tests); clippy clean at `-D warnings`;
  workspace builds to wasm.
- On testnet: a deposit, an instant buffer redeem, AND a full queued redeem
  (request → multi-tx drain → claim) all succeed within Soroban's per-tx memory limit.
- A `rebalance_step` round demonstrably returns the basket to ~30/40/30.
- The canonical `VAULT_XLM` is left in a safe, redeemable state.

## 10. Deferred (not in this spec)
- Permissionless-but-bounded draining (remove keeper dependency).
- The Soroswap-LP V1→C valuation hardening (TWAP/oracle) from the prior spec.
- Optimal zap-in; LP incentive claiming.
