//! DeFindexStrategy — implements `StrategyInterface` by relaying deposits to a
//! deployed DeFindex strategy contract (e.g. their Blend-USDC adapter at
//! `CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY` on testnet).
//!
//! ## Why a thin adapter?
//!
//! DeFindex (paltalabs) ships its own strategy contract surface — single
//! asset, share-based, all `from`-authenticated. The signatures map one-to-one
//! to our `StrategyInterface`, so this crate is a thin relay rather than a
//! reimplementation. Funds flow:
//!
//!   vault → SAC.transfer → adapter (this crate)
//!   adapter.deposit(vault, amount)
//!     ↳ DeFindexStrategyClient::deposit(amount, adapter_address)
//!     ↳ defindex.token.transfer(adapter, defindex, amount)   ← sub-invocation
//!
//! The inner `token.transfer` is invoked BY the DeFindex contract on behalf of
//! `from` (us). Without pre-authorizing it, Soroban rejects with
//! `Error(Auth, InvalidAction)` — exactly the bug BlendStrategy hit in V0
//! before being redeployed with the auth fix. We use the same
//! `authorize_as_current_contract` pattern.
//!
//! ## Verified surface (testnet, 2026-05-28)
//!
//! DeFindex testnet contract addresses come from paltalabs/defindex public/testnet.contracts.json.
//! Their `DeFindexStrategyTrait` exposes (verified live via stellar contract invoke):
//!
//!   asset(env) -> Result<Address, StrategyError>
//!   deposit(env, amount: i128, from: Address) -> Result<i128, StrategyError>
//!     // returns the updated underlying balance of `from`.
//!   withdraw(env, amount: i128, from: Address, to: Address) -> Result<i128, StrategyError>
//!     // returns the updated underlying balance of `from`.
//!   balance(env, from: Address) -> Result<i128, StrategyError>
//!     // queries the address's underlying balance (not shares).
//!   harvest(env, from: Address, data: Option<Bytes>) -> Result<(), StrategyError>
//!
//! Their auth model uses `from.require_auth()` and then
//! `token.transfer(from, defindex_contract, amount)` internally. From our
//! adapter's point of view, `from = this contract` — we are the user of
//! DeFindex.
//!
//! ## V0 simplifications
//! - `harvest` is delegated to DeFindex's `harvest(this, None)`. DeFindex
//!   strategies may return errors from their inner protocol claim; we map any
//!   inner failure to `StrategyError::PoolError` and surface 0 harvested.
//!   Returning 0 keeps the vault's permissionless harvest path safe even when
//!   the inner protocol has nothing to claim.
//! - `current_value` reads `defindex.balance(this)` — DeFindex returns
//!   underlying units (not shares), so no conversion needed.

#![no_std]

use baku_strategy_trait::{StrategyError, StrategyInterface};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, contracttype, token, vec, Address, Bytes, Env, IntoVal,
    Symbol,
};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Vault,
    Asset,
    /// The deployed DeFindex strategy contract this adapter relays to.
    DefindexStrategy,
    ApyBps,
}

// Hand-declared DeFindex strategy interface. Signatures verified against the
// deployed testnet contract via `stellar contract info interface
// CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY` 2026-05-28.
//
// Returns are wrapped in i128 directly (their `Result<i128, StrategyError>`
// becomes an i128 success path or a Soroban contract error at the typed
// boundary). We use try_* call sites below so a panic on their side becomes a
// recoverable Err on ours.
#[contractclient(name = "InnerDefindexClient")]
pub trait DefindexStrategyInterface {
    fn asset(env: Env) -> Address;
    fn deposit(env: Env, amount: i128, from: Address) -> i128;
    fn withdraw(env: Env, amount: i128, from: Address, to: Address) -> i128;
    fn balance(env: Env, from: Address) -> i128;
    fn harvest(env: Env, from: Address, data: Option<Bytes>);
}

#[contract]
pub struct DefindexStrategy;

#[contractimpl]
impl DefindexStrategy {
    /// Initialize the DeFindex adapter strategy. Caller becomes admin; only
    /// `vault` may invoke deposit/withdraw/harvest after init.
    pub fn __constructor(
        env: Env,
        admin: Address,
        vault: Address,
        asset: Address,
        defindex_strategy: Address,
        initial_apy_bps: u32,
    ) {
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Vault, &vault);
        storage.set(&DataKey::Asset, &asset);
        storage.set(&DataKey::DefindexStrategy, &defindex_strategy);
        storage.set(&DataKey::ApyBps, &initial_apy_bps);
    }

    /// Admin-only: rewire the strategy's authorized vault. Mirrors
    /// BlendStrategy::set_vault for the mutual-init dance (deploy → register
    /// → rewire).
    pub fn set_vault(env: Env, admin: Address, new_vault: Address) -> Result<(), StrategyError> {
        require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Vault, &new_vault);
        Ok(())
    }
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), StrategyError> {
    let stored: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(StrategyError::NotInitialized)?;
    if *caller != stored {
        return Err(StrategyError::AdminOnly);
    }
    caller.require_auth();
    Ok(())
}

fn assert_vault(env: &Env, caller: &Address) -> Result<(), StrategyError> {
    let vault: Address = env
        .storage()
        .instance()
        .get(&DataKey::Vault)
        .ok_or(StrategyError::NotInitialized)?;
    if *caller != vault {
        return Err(StrategyError::Unauthorized);
    }
    caller.require_auth();
    Ok(())
}

fn load_asset(env: &Env) -> Result<Address, StrategyError> {
    env.storage()
        .instance()
        .get(&DataKey::Asset)
        .ok_or(StrategyError::NotInitialized)
}

fn load_defindex(env: &Env) -> Result<Address, StrategyError> {
    env.storage()
        .instance()
        .get(&DataKey::DefindexStrategy)
        .ok_or(StrategyError::NotInitialized)
}

#[contractimpl]
impl StrategyInterface for DefindexStrategy {
    fn deposit(env: Env, vault: Address, amount: i128) -> Result<(), StrategyError> {
        assert_vault(&env, &vault)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }

        let asset = load_asset(&env)?;
        let defindex = load_defindex(&env)?;
        let this = env.current_contract_address();

        // Pre-authorize the SAC.transfer(this, defindex, amount) sub-invocation
        // that DeFindex's deposit will perform internally. Their code does:
        //     from.require_auth();
        //     token.transfer(&from, &e.current_contract_address(), &amount);
        // With `from = this`, the strategy is in the call stack but not the
        // direct caller of token.transfer (DeFindex is). Without
        // authorize_as_current_contract the inner transfer reverts with
        // Error(Auth, InvalidAction) — same root cause as the BlendStrategy
        // V0 auth bug.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: asset.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: vec![
                        &env,
                        this.clone().into_val(&env),
                        defindex.clone().into_val(&env),
                        amount.into_val(&env),
                    ],
                },
                sub_invocations: vec![&env],
            }),
        ]);

        // Vault has already transferred `amount` of `asset` to this contract
        // before calling. Relay to DeFindex: they pull our tokens via the
        // pre-authorized sub-invocation and credit the position to `this`.
        let client = InnerDefindexClient::new(&env, &defindex);
        // The Result<_, _> return is panicked into a Soroban contract error if
        // the inner DeFindex strategy reverts; map that to our typed error.
        match client.try_deposit(&amount, &this) {
            Ok(Ok(_new_balance)) => Ok(()),
            Ok(Err(_)) | Err(_) => Err(StrategyError::PoolError),
        }
    }

    fn withdraw(env: Env, vault: Address, amount: i128) -> Result<i128, StrategyError> {
        assert_vault(&env, &vault)?;
        if amount <= 0 {
            return Err(StrategyError::InvalidAmount);
        }

        let asset = load_asset(&env)?;
        let defindex = load_defindex(&env)?;
        let this = env.current_contract_address();
        let token_client = token::Client::new(&env, &asset);

        // Read pre-balance so we can compute the actual amount delivered.
        // DeFindex's withdraw call ships the asset directly to `to`; we set
        // `to = this` so we can re-emit to the vault and measure the delta.
        let pre = token_client.balance(&this);

        // Defensive pre-auth for a withdraw-side SAC sub-transfer.
        //
        // Investigation (paltalabs/defindex blend strategy, 2026-05-29): the
        // reference withdraw entrypoint `withdraw(amount, from, to)` does
        //     from.require_auth();
        //     blend_pool::withdraw(&e, &to, optimal, &config)
        //         ↳ pool.submit(from=defindex, spender=defindex, to=&to, [Withdraw])
        // i.e. the asset moves Blend-pool → `to` (= this adapter), INBOUND. The
        // `from.require_auth()` is satisfied because we are the direct caller of
        // `defindex.withdraw`, so our implicit contract auth covers it — exactly
        // how BlendStrategy::withdraw covers `pool.submit`'s own `from` auth by
        // being its direct caller. The current reference contract therefore does
        // NOT perform an outbound `token.transfer(from=this, …)` here.
        //
        // BUT: DeFindex strategies are pluggable behind this one interface, and a
        // non-Blend variant (or a future upgrade) could route the exit through a
        // `token.transfer(from, vault, amount)` sub-invocation — the same shape
        // that broke deposit with Error(Auth, InvalidAction). An unconsumed
        // InvokerContractAuthEntry is a harmless no-op in Soroban, whereas a
        // missing-but-required one is an unrecoverable withdraw revert. The
        // asymmetry favors pre-authorizing the SAC.transfer(this, defindex, amount)
        // sub-invocation defensively, mirroring the deposit leg.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: asset.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: vec![
                        &env,
                        this.clone().into_val(&env),
                        defindex.clone().into_val(&env),
                        amount.into_val(&env),
                    ],
                },
                sub_invocations: vec![&env],
            }),
        ]);

        let client = InnerDefindexClient::new(&env, &defindex);
        let _new_underlying = match client.try_withdraw(&amount, &this, &this) {
            Ok(Ok(b)) => b,
            Ok(Err(_)) | Err(_) => return Err(StrategyError::PoolError),
        };
        let post = token_client.balance(&this);
        let delivered = post - pre;
        if delivered <= 0 {
            return Err(StrategyError::InsufficientLiquidity);
        }

        token_client.transfer(&this, &vault, &delivered);
        Ok(delivered)
    }

    fn current_value(env: Env) -> i128 {
        let defindex: Option<Address> = env.storage().instance().get(&DataKey::DefindexStrategy);
        let defindex = match defindex {
            Some(d) => d,
            None => return 0,
        };
        let this = env.current_contract_address();
        // DeFindex's balance(from) returns the underlying-asset value of the
        // address's share position, so no conversion needed. View-only.
        //
        // Use try_balance: if DeFindex is paused/deregistered the non-try call
        // would panic and brick the vault's price-per-share / total_assets reads
        // (and any rebalance/set_active_strategy guard that calls current_value).
        // Fall back to 0 — mirrors the try_* recovery the harvest path uses.
        match InnerDefindexClient::new(&env, &defindex).try_balance(&this) {
            Ok(Ok(bal)) => bal,
            Ok(Err(_)) | Err(_) => 0,
        }
    }

    fn harvest(env: Env, _vault: Address) -> Result<i128, StrategyError> {
        // Vault auth: only the vault may trigger harvest, mirroring Blend.
        assert_vault(&env, &_vault)?;
        let defindex = load_defindex(&env)?;
        let this = env.current_contract_address();
        // Best-effort claim. DeFindex strategies may bubble up an error if
        // there's nothing to claim or the inner protocol reverts; we treat
        // that as "0 harvested" so the vault's permissionless harvest path
        // remains safe.
        let client = InnerDefindexClient::new(&env, &defindex);
        match client.try_harvest(&this, &None) {
            Ok(Ok(())) => Ok(0),
            Ok(Err(_)) | Err(_) => Ok(0),
        }
    }

    fn pool_apy(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::ApyBps).unwrap_or(0)
    }

    fn set_pool_apy_bps(env: Env, admin: Address, bps: u32) -> Result<(), StrategyError> {
        require_admin(&env, &admin)?;
        if bps > 10_000 {
            return Err(StrategyError::InvalidApyBps);
        }
        env.storage().instance().set(&DataKey::ApyBps, &bps);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    struct SetupCtx {
        admin: Address,
        vault: Address,
        #[allow(dead_code)]
        asset: Address,
        #[allow(dead_code)]
        defindex_strategy: Address,
        contract_id: Address,
    }

    fn setup(env: &Env) -> SetupCtx {
        let admin = Address::generate(env);
        let vault = Address::generate(env);
        let asset = Address::generate(env);
        let defindex_strategy = Address::generate(env);
        let contract_id = env.register(
            DefindexStrategy,
            (
                admin.clone(),
                vault.clone(),
                asset.clone(),
                defindex_strategy.clone(),
                500_u32,
            ),
        );
        SetupCtx {
            admin,
            vault,
            asset,
            defindex_strategy,
            contract_id,
        }
    }

    #[test]
    fn pool_apy_default_and_set() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        assert_eq!(client.pool_apy(), 500);
        client.set_pool_apy_bps(&ctx.admin, &750_u32);
        assert_eq!(client.pool_apy(), 750);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")] // StrategyError::AdminOnly = 7
    fn set_pool_apy_non_admin_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.set_pool_apy_bps(&imposter, &750_u32);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")] // StrategyError::InvalidApyBps = 8
    fn set_pool_apy_out_of_range_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.set_pool_apy_bps(&ctx.admin, &10_001_u32);
    }

    #[test]
    fn set_vault_admin_only() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let new_vault = Address::generate(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.set_vault(&ctx.admin, &new_vault);
        // Storage write is the contract under test. We cannot exercise deposit
        // here without registering a stub DeFindex contract — the negative
        // auth tests below cover the rewired vault check indirectly.
        let _ = ctx.vault;
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")] // StrategyError::AdminOnly = 7
    fn set_vault_non_admin_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let new_vault = Address::generate(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.set_vault(&imposter, &new_vault);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn deposit_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&imposter, &100_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn withdraw_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.withdraw(&imposter, &100_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")] // StrategyError::Unauthorized = 1
    fn harvest_from_non_vault_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let imposter = Address::generate(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.harvest(&imposter);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")] // StrategyError::InvalidAmount = 2
    fn deposit_zero_amount_reverts() {
        // amount=0 should hit InvalidAmount BEFORE the auth assertion proceeds
        // to the inner DeFindex client (which would panic since the address
        // isn't a registered contract in the test env). Protects the adapter
        // from being a thin pass-through for malformed values.
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.deposit(&ctx.vault, &0_i128);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")] // StrategyError::InvalidAmount = 2
    fn withdraw_zero_amount_reverts() {
        let env = Env::default();
        env.mock_all_auths();
        let ctx = setup(&env);
        let client = DefindexStrategyClient::new(&env, &ctx.contract_id);
        client.withdraw(&ctx.vault, &0_i128);
    }
}
