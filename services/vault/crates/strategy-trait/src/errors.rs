//! Typed strategy errors. Surfaces as Soroban error codes to callers.
//!
//! Vault-side errors live in `baku-vault::errors::VaultError`. Keep these
//! sets disjoint — the vault converts strategy errors into its own variants
//! when bubbling up to the wallet.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StrategyError {
    /// Caller is not the strategy's expected vault.
    Unauthorized = 1,
    /// Deposit / withdraw amount is zero or negative.
    InvalidAmount = 2,
    /// Downstream pool (Blend, Soroswap) returned an error or panicked.
    PoolError = 3,
    /// Pool does not have enough liquidity to satisfy the withdraw.
    InsufficientLiquidity = 4,
    /// Strategy was already initialized; init can only be called once.
    AlreadyInitialized = 5,
    /// Strategy was not initialized; cannot operate before init.
    NotInitialized = 6,
    /// Admin-only setter was called by a non-admin address.
    AdminOnly = 7,
    /// The APY value being set is out of bounds (e.g. > 10000 bps = 100%).
    InvalidApyBps = 8,
}
