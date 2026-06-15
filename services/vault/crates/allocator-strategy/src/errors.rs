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
    /// Total basket value is zero; cannot split a withdraw. Retained for ABI
    /// stability — no longer constructed after withdraw became native-buffer-only.
    EmptyBasket = 16,
    /// withdraw/fund requested more than the native buffer holds.
    InsufficientBuffer = 17,
}
