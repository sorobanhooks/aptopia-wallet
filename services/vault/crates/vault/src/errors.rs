//! Vault errors. Surface as Soroban contract errors to callers (wallet, API).
//!
//! Strategy-side errors live in `baku_strategy_trait::StrategyError`. When a
//! strategy call fails, the vault catches the error and bubbles up
//! `VaultError::StrategyFailed` rather than leaking the strategy's internal
//! code — keeps the user-facing error surface stable across strategy types.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    /// Caller is not the vault's admin.
    Unauthorized = 100,
    /// Vault not initialized (constructor never ran).
    NotInitialized = 101,
    /// Deposit / redeem amount is zero or negative.
    AmountZero = 102,
    /// Owner does not have enough share token balance for this redeem.
    InsufficientShares = 103,
    /// Strategy delivered fewer underlying than the caller's min_amount_out floor.
    SlippageExceeded = 104,
    /// Strategy switch attempted while active strategy holds non-zero balance.
    StrategyHasBalance = 105,
    /// Strategy address was not registered with `register_strategy`.
    StrategyNotRegistered = 106,
    /// Attempted to register a strategy address that is already in the registry.
    StrategyAlreadyRegistered = 107,
    /// Downstream strategy call returned an error (see strategy logs for the typed code).
    StrategyFailed = 108,
    /// Math overflow in share / asset conversion. Should not happen with i128 but caught defensively.
    MathOverflow = 109,
    /// No pending redemption with the given id.
    RequestNotFound = 110,
    /// Caller is not the owner of the referenced pending redemption.
    NotRequestOwner = 111,
    /// Queued redemption value is below the MIN_REDEEM_ASSETS floor (anti-dust / storage griefing).
    RedemptionTooSmall = 112,
}
