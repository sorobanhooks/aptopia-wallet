//! Deployable Ed25519 verifier contract (M1 auth-digest tracer, P2).
//!
//! This is NOT custom crypto. Every entrypoint delegates to the OpenZeppelin
//! published, audited building blocks in `stellar_accounts::verifiers::ed25519`:
//!   * `verify`               -> e.crypto().ed25519_verify(pubkey, payload, sig)
//!   * `canonicalize_key`     -> 32 raw pubkey bytes
//!   * `batch_canonicalize_key`
//!
//! The OZ Smart Account talks to a verifier through the generated
//! `VerifierClient` (verifiers/mod.rs:182-188), whose ABI is:
//!   verify(hash: Bytes, key_data: Val, sig_data: Val) -> bool
//!   canonicalize_key(key_data: Val) -> Bytes
//!   batch_canonicalize_key(key_data: Vec<Val>) -> Vec<Bytes>
//! so the exported function names/arity below MUST match that interface exactly.
//!
//! For the Ed25519 scheme: key_data = 32 raw pubkey bytes (Bytes), sig_data =
//! 64 raw signature bytes (Bytes). The Smart Account's `authenticate`
//! (storage.rs:341-352) passes the agent pubkey as key_data and the 64-byte
//! Ed25519 signature over the auth_digest as sig_data; `hash` is
//! auth_digest.to_bytes() (32 raw bytes).

#![no_std]

use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, TryFromVal, Val, Vec};

use stellar_accounts::verifiers::ed25519;

#[contract]
pub struct Ed25519Verifier;

#[contractimpl]
impl Ed25519Verifier {
    /// Verify an Ed25519 signature over `hash`.
    ///
    /// * `hash`     - the data that was signed (the SA's auth_digest, 32 bytes).
    /// * `key_data` - 32 raw Ed25519 public-key bytes (as `Bytes`).
    /// * `sig_data` - 64 raw Ed25519 signature bytes (as `Bytes`).
    pub fn verify(e: &Env, hash: Bytes, key_data: Val, sig_data: Val) -> bool {
        // FAIL CLOSED on malformed input instead of trapping. `key_data` is the
        // on-chain rule signer (trusted, always 32 raw bytes), but `sig_data`
        // comes from the caller-supplied `AuthPayload.signers` map and is
        // therefore UNTRUSTED: a wrong Val type or a non-64-byte signature must
        // yield `false` (→ OZ `ExternalVerificationFailed`) rather than panic
        // under `panic = "abort"`. Returning false keeps `verify` a total
        // function over arbitrary `Val` and routes malformed sigs down the same
        // fail-closed path as a merely-wrong signature. (Security review
        // sa-verifier-dos-1.)
        let (Ok(key_bytes), Ok(sig_bytes)) = (
            Bytes::try_from_val(e, &key_data),
            Bytes::try_from_val(e, &sig_data),
        ) else {
            return false;
        };
        let Ok(public_key) = TryInto::<BytesN<32>>::try_into(key_bytes) else {
            return false;
        };
        let Ok(signature) = TryInto::<BytesN<64>>::try_into(sig_bytes) else {
            return false;
        };

        // Delegates to OZ's audited ed25519 verify (returns false on a
        // well-formed-but-invalid signature — the P4 negatives observe 3003).
        ed25519::verify(e, &hash, &public_key, &signature)
    }

    /// Canonical identity of an Ed25519 key = its 32 raw bytes.
    ///
    /// Unlike `verify`, `key_data` here flows in only from rule-signer
    /// management (`add_signer` / the constructor), an SA-self-authorized
    /// (trusted) path, and the OZ `VerifierClient` ABI fixes the return type to
    /// `Bytes` — a malformed value has no canonical key form. A failed 32-byte
    /// conversion is therefore a setup-time error that correctly fails loud
    /// (trap) rather than returning a bogus canonical identity. (Reviewed under
    /// sa-verifier-dos-1: not the untrusted auth path; `verify` is the one
    /// hardened to fail closed.)
    pub fn canonicalize_key(e: &Env, key_data: Val) -> Bytes {
        let key_bytes = Bytes::try_from_val(e, &key_data).unwrap();
        let public_key: BytesN<32> = key_bytes.try_into().unwrap();
        ed25519::canonicalize_key(e, &public_key)
    }

    /// Batched canonicalization, preserving input order.
    pub fn batch_canonicalize_key(e: &Env, key_data: Vec<Val>) -> Vec<Bytes> {
        let keys: Vec<BytesN<32>> = Vec::from_iter(
            e,
            key_data.iter().map(|v| {
                let b = Bytes::try_from_val(e, &v).unwrap();
                let k: BytesN<32> = b.try_into().unwrap();
                k
            }),
        );
        ed25519::batch_canonicalize_key(e, &keys)
    }
}
