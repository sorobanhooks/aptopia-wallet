//! sa-tracer: shape-validating tracer for the OZ `stellar-accounts` Smart Account API.
//!
//! This crate contains NO contract logic. Its only job is to import the OZ
//! `stellar-accounts` v0.7.1 types we plan to depend on and assert our D1
//! design assumptions against the REAL published API. See the `oz_api_shape`
//! test module for the load-bearing assertions.
//!
//! Validated against:
//!   crate    : stellar-accounts = "=0.7.1"  (crates.io)
//!   git sha1 : 3f81125bed3114cc93f5fca6d13240082050269a
//!   path     : packages/accounts (OpenZeppelin/stellar-contracts)
//!   soroban  : soroban-sdk 25.3.0 (per crate manifest); workspace pins 25.3.1 — no skew.
#![no_std]

// Re-export the OZ types we intend to depend on so a compile of this crate is
// itself a shape check: if any of these paths/names change in a future bump,
// `cargo build -p sa-tracer` breaks loudly.
pub use stellar_accounts::smart_account::{
    AuthPayload, ContextRule, ContextRuleType, Signer, SmartAccountError,
};
pub use stellar_accounts::verifiers::Verifier;

#[cfg(test)]
mod oz_api_shape;
