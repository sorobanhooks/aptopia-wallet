//! Deployable OpenZeppelin Smart Account wrapper (M1 auth-digest tracer, P2/P4).
//!
//! `stellar-accounts` is a LIBRARY, not a deployable contract. This crate is the
//! thin deployable contract that wires it up, following the OZ-recommended
//! pattern exactly (no hand-rolled auth):
//!
//!   * `CustomAccountInterface::__check_auth` delegates verbatim to the OZ
//!     `do_check_auth` (stellar-accounts 0.7.1 smart_account/storage.rs:462).
//!     That function computes the rule-bound auth_digest
//!       auth_digest = sha256( raw32(signature_payload) || context_rule_ids.to_xdr() )
//!     and, for the External signer path, calls
//!       VerifierClient.verify(auth_digest.to_bytes(), key_data, sig_data)
//!     (storage.rs authenticate:341-352). The off-chain agent signs that digest.
//!
//!   * The `SmartAccount` contracttrait (smart_account/mod.rs:136) is implemented
//!     with `#[contractimpl(contracttrait)]` so its default management
//!     entrypoints — including `add_context_rule`, `get_context_rule`, and
//!     `get_context_rules_count` — are exported as real contract functions. Those
//!     management entrypoints require auth from the SA itself
//!     (`e.current_contract_address().require_auth()`), so post-deploy rule edits
//!     would need an SA self-auth. To keep the deploy single-shot we install both
//!     rules directly in `__constructor` via the lower-level
//!     `storage::add_context_rule` (which performs no require_auth — appropriate
//!     for initial setup inside the constructor's own contract context).
//!
//! TWO scoped rules (NO Default/master rule — that would break the
//! scoped-agent thesis). WHY two: a real `vault.deposit(SA, assets)` makes the
//! SA authorize TWO nested auth contexts, not one. `vault.deposit` does
//! `depositor.require_auth()` (context = deposit@VAULT_XLM) and then
//! `token.transfer(depositor -> strategy)`, whose SAC does `from.require_auth()`
//! on the SA (nested context = transfer@XLM_SAC). The OZ `do_check_auth`
//! validates EVERY context against an installed rule before any signature is
//! checked; with only the VAULT_XLM rule the nested SAC transfer context is
//! unmatched and validation reverts `UnvalidatedContext(3002)`. A second rule
//! scoped to `CallContract(XLM_SAC)` covers that nested transfer context. Both
//! rules carry the SAME External-Ed25519 agent signer and ZERO policies.
//!
//! Rule id 0 — "agent_xlm_vault":
//!   * context_type = ContextRuleType::CallContract(VAULT_XLM)  (scoped)
//!   * signers      = [ Signer::External(ed25519_verifier, agent_pubkey) ]
//!   * policies     = {}  (ZERO policies — policy-less)
//! Rule id 1 — "agent_xlm_sac":
//!   * context_type = ContextRuleType::CallContract(XLM_SAC)    (scoped)
//!   * signers      = [ Signer::External(ed25519_verifier, agent_pubkey) ]
//!   * policies     = {}  (ZERO policies — policy-less)

#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, Bytes, BytesN, Env, Map, String, Val, Vec,
};

use stellar_accounts::smart_account::{
    AuthPayload, ContextRule, ContextRuleType, Signer, SmartAccount, SmartAccountError,
};
// `do_check_auth` and `add_context_rule` are the OZ storage free functions.
use stellar_accounts::smart_account::{add_context_rule, do_check_auth};

#[contract]
pub struct SmartAccountContract;

#[contractimpl]
impl SmartAccountContract {
    /// Installs TWO policy-less, CallContract-scoped rules — one for VAULT_XLM
    /// (rule id 0) and one for the nested XLM_SAC transfer (rule id 1) — each
    /// bound to the SAME single External-Ed25519 agent signer, at deploy time.
    ///
    /// Two rules are required because a real `vault.deposit(SA, assets)` makes
    /// the SA authorize both `deposit@VAULT_XLM` and the nested
    /// `transfer@XLM_SAC` contexts; OZ `do_check_auth` validates every context
    /// against an installed rule before checking signatures, so the SAC transfer
    /// context needs its own scoped rule (otherwise: UnvalidatedContext 3002).
    ///
    /// # Arguments
    /// * `ed25519_verifier` - Address of the OZ Ed25519 verifier contract.
    /// * `agent_pubkey`     - The throwaway agent's 32-byte Ed25519 public key.
    /// * `vault_xlm`        - The contract rule 0 authorizes calls to
    ///                        (canonical VAULT_XLM v2).
    /// * `xlm_sac`          - The XLM Stellar Asset Contract rule 1 authorizes
    ///                        calls to (the nested transfer context).
    pub fn __constructor(
        e: &Env,
        ed25519_verifier: Address,
        agent_pubkey: BytesN<32>,
        vault_xlm: Address,
        xlm_sac: Address,
    ) {
        // External signer: (verifier contract address, raw public key bytes).
        // key_data for the OZ ed25519 verifier is the 32 raw pubkey bytes.
        // Both rules share the SAME signer; clone the cheap host handles so each
        // rule owns its own Signer Vec.
        let key_data: Bytes = Bytes::from_array(e, &agent_pubkey.to_array());

        // Rule id 0 — agent_xlm_vault: CallContract(VAULT_XLM).
        let vault_signer = Signer::External(ed25519_verifier.clone(), key_data.clone());
        let vault_signers: Vec<Signer> = Vec::from_array(e, [vault_signer]);
        let vault_policies: Map<Address, Val> = Map::new(e); // ZERO policies.
        add_context_rule(
            e,
            &ContextRuleType::CallContract(vault_xlm),
            &String::from_str(e, "agent_xlm_vault"),
            None, // no expiration
            &vault_signers,
            &vault_policies,
        );

        // Rule id 1 — agent_xlm_sac: CallContract(XLM_SAC) — the nested
        // transfer context from vault.deposit's token.transfer(SA -> strategy).
        let sac_signer = Signer::External(ed25519_verifier, key_data);
        let sac_signers: Vec<Signer> = Vec::from_array(e, [sac_signer]);
        let sac_policies: Map<Address, Val> = Map::new(e); // ZERO policies.
        add_context_rule(
            e,
            &ContextRuleType::CallContract(xlm_sac),
            &String::from_str(e, "agent_xlm_sac"),
            None, // no expiration
            &sac_signers,
            &sac_policies,
        );
    }
}

/// Delegate `__check_auth` to the OZ smart-account `do_check_auth`. This is the
/// auth core — it is NOT hand-rolled; it forwards to the audited OZ routine that
/// computes the rule-bound digest and enforces signers/policies.
#[contractimpl]
impl CustomAccountInterface for SmartAccountContract {
    type Signature = AuthPayload;
    type Error = SmartAccountError;

    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), SmartAccountError> {
        do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

/// Export the OZ `SmartAccount` management surface (add/get/remove context rules,
/// signers, policies, counts) as contract functions using their default
/// implementations. Read-back of Rule A uses the exported `get_context_rule`.
#[contractimpl(contracttrait)]
impl SmartAccount for SmartAccountContract {}
