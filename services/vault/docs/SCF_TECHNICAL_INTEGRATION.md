# Xyra Smart Wallet — Technical Integration Specification (SCF Review)

> **Audience:** technical reviewers, the Stellar Community Fund evaluation panel,
> and engineers integrating against any tier.
> **Scope:** the complete cross-repo integration of the three Xyra repositories —
> every API contract, auth flow, on-chain interface, data format, and the
> smart-account security model that binds them.
> **Companion:** high-level shape in [`ARCHITECTURE_OVERVIEW.md`](./ARCHITECTURE_OVERVIEW.md).
>
> **Network:** Stellar **testnet** (`Test SDF Network ; September 2015`). Mainnet
> placeholders only — gated on audit + SCF. **Last reconciled:** 2026-06-08.

---

## Table of contents

1. [Repository topology & ownership](#1-repository-topology--ownership)
2. [End-to-end data flows](#2-end-to-end-data-flows)
3. [Repo 1 — xyra-vault: contracts + Baku API](#3-repo-1--xyra-vault-contracts--baku-api)
4. [Repo 2 — xyra-walllet: agent backend](#4-repo-2--xyra-walllet-agent-backend)
5. [Repo 3 — xyra-wallet-sdk: extension](#5-repo-3--xyra-wallet-sdk-extension)
6. [Integration Seam A — Extension ⇄ Baku API](#6-integration-seam-a--extension--baku-api)
7. [Integration Seam B — Extension ⇄ Agent backend (SIWE)](#7-integration-seam-b--extension--agent-backend-siwe)
8. [The bridge — Smart Account (Pillar 5) security model](#8-the-bridge--smart-account-pillar-5-security-model)
9. [Cross-cutting data formats & conventions](#9-cross-cutting-data-formats--conventions)
10. [Security properties (consolidated)](#10-security-properties-consolidated)
11. [Deployment, configuration & build](#11-deployment-configuration--build)
12. [Testnet address book](#12-testnet-address-book)
13. [Verification & test evidence](#13-verification--test-evidence)
14. [Maturity, gaps & mainnet path](#14-maturity-gaps--mainnet-path)

---

## 1. Repository topology & ownership

| # | Repo (remote → branch) | Tier / trust boundary | Stack | Holds a private key? |
|---|------------------------|-----------------------|-------|----------------------|
| 1 | **xyra-vault** `shah-aman/xyra-vault` → `main` | On-chain contracts + stateless read/build API | Rust → wasm32 (soroban-sdk 25.3.1); Bun + Hono | **No** (API is key-less) |
| 2 | **xyra-walllet** `SaaS-Repo/xyra-walllet` → `master` | Off-chain agent / stateful middle tier | Node + Express + TS; MongoDB; Redis | Yes — *per-user throwaway agent key*, envelope-encrypted |
| 3 | **xyra-wallet-sdk** `Blockchain-AI-Apps/xyra-wallet-sdk` → `integration-direction-c`/`main` | Client / frontend | React 19, Manifest V3, Webpack 5 (Freighter fork) | Yes — *the user's key*, decrypted in-memory in the background service worker |

**Design invariant:** the user's key lives **only** in Repo 3. Repo 1 cannot sign.
Repo 2 holds only a *separate* agent key whose on-chain authority is fenced by the
Pillar-5 smart account. No backend can move user funds.

---

## 2. End-to-end data flows

### 2.1 Yield deposit (Seam A) — user deposits XLM into the vault

```
Extension (popup)                Baku API (Bun)            Soroban RPC / contracts
─────────────────                ──────────────            ───────────────────────
runDeposit(amount)
  └─ POST /vault/xlm/deposit/build-tx {user, amount} ─────▶ simulate vault.deposit
                                  ◀── { xdr, vault, asset }   (build + assemble fees)
  signSorobanXdr(xdr)  ── background service worker signs with USER key (ed25519)
  └─ POST /tx/submit {signed_xdr} ───────────────────────▶ sendTransaction + poll ≤30s
                                  ◀── { hash, status, returnValue }   (shares minted)
  refresh /vault/xlm/state, /balance/:address  (read-only, cached)
```

The API **builds and submits but never signs**. The only signer is the user's
key inside the extension's background worker.

### 2.2 Agent rule update + Tier-2 confirm (Seam B)

```
Extension                         Agent backend (Express)        Stellar
─────────                         ───────────────────────        ───────
(1) POST /v1/auth/challenge {pubkey} ─▶ issue nonce + SEP-53 message
    sign message w/ USER key (background worker, signMessage → SEP-53)
(2) POST /v1/auth/verify {pubkey, signature, message} ─▶ verify → HS256 JWT (15 min)
(3) PUT /v1/rules/:addr  (Bearer JWT)  ─▶ validate tiers, persist, restart worker
    ... worker polls XLM price every 30s; on Tier-2 signal queues a pending trade ...
(4) GET /v1/pending-tier2/:addr (Bearer) ─▶ [{ id, side, amount, plannedUsdc }]
(5) POST /v1/pending-tier2/:addr/:id/confirm {direction} ─▶ decrypt AGENT key,
                                                            executeSwap ─▶ Horizon tx
                                              ◀── { ok, txHash }
```

The backend signs the swap with the **decrypted per-user agent key**, not the
user's key. The user's key only ever signs the SIWE challenge.

### 2.3 The bridge — agent deposits into the vault via the Smart Account

When the agent (rather than the human) drives a vault deposit, the agent key
signs a **rule-bound auth digest** for an on-chain OZ Smart Account that only
permits the scoped call. Detailed in §8.

---

## 3. Repo 1 — xyra-vault: contracts + Baku API

### 3.1 Workspace layout (Rust)

```
crates/
├── addresses/         single source of truth for contract addresses (Rust)
├── strategy-trait/    Strategy trait + #[contractclient] + StrategyError + preview math
├── mock-strategy/     MockStrategy (unit tests + demo inject_yield)
├── vault/             OZ Vault composition (vault IS the SEP-41 share token)
├── blend-strategy/    BlendStrategy via blend-contract-sdk (live lending)
├── soroswap-strategy/ SoroswapStrategy (swap-and-hold against Soroswap V2)
├── defindex-strategy/ DeFindex adapter (registered, inactive)
├── sa-account/        OZ Stellar Smart Account + ed25519 verifier (Pillar 5)
└── sa-tracer/         auth-digest shape/parity tracer (validation only, no logic)
```

**Pinned deps:** `soroban-sdk 25.3.1`, `stellar-tokens 0.7.1` (OZ Vault, SEP-56),
`stellar-macros 0.7.1`, `blend-contract-sdk 2.25.0`, `stellar-accounts 0.7.1` (OZ
Smart Account).

### 3.2 Vault contract interface (`crates/vault/src/lib.rs`)

The vault **is** the share token (OZ Vault extension, SEP-41). Public methods:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `__constructor` | `(admin, underlying, initial_strategy, …)` | Initialize underlying SAC, admin, first active strategy |
| `deposit` | `(depositor: Address, assets: i128) -> i128` | Pull `assets` from depositor, route to active strategy, mint shares (virtual-offset math). Returns shares minted. |
| `redeem` | `(owner, shares, min_out, …) -> i128` | Burn shares, withdraw from active strategy, enforce `min_out` slippage floor on-chain. Returns assets delivered. |
| `harvest` | `() -> i128` | Realize strategy yield into the vault accounting |
| `register_strategy` | `(admin, strategy)` | Admin: add a strategy to the registry |
| `set_active_strategy` | `(admin, strategy)` | Admin: switch active (V0 drain-first path) |
| `rebalance` | `(admin, to_strategy) -> i128` | Admin: **atomic** move of funds active→`to_strategy` in one tx (bypasses drain-first) |
| `admin / underlying / active_strategy / strategy_registry` | views | Config reads |
| `total_assets / price_per_share` | views | Accounting reads (i128) |
| `preview_deposit / preview_redeem` | `(amount) -> i128` | Quote without state change (used by API to compute slippage floor) |

**Slippage enforcement** is on-chain: `redeem` reverts `VaultError::SlippageExceeded`
if the strategy delivers less than `min_out`, and the user keeps their shares.

### 3.3 Strategy trait (`crates/strategy-trait/src/lib.rs`)

All strategies implement one `#[contractclient]` trait, so the vault is
strategy-agnostic:

```rust
fn deposit(env, vault: Address, amount: i128) -> Result<(), StrategyError>;
fn withdraw(env, vault: Address, amount: i128) -> Result<i128, StrategyError>;
fn current_value(env) -> i128;
fn harvest(env, vault: Address) -> Result<i128, StrategyError>;
fn pool_apy(env) -> u32;
fn set_pool_apy_bps(env, admin: Address, bps: u32) -> Result<(), StrategyError>;
```

Strategies in the registry today: **Blend** (active, live lending via
`blend-contract-sdk`), **Soroswap** (swap-and-hold against the Soroswap V2
XLM/USDC pair, swaps half on deposit, ~0.30%/leg, admin-tunable slippage),
**DeFindex** (USDC adapter, registered-inactive), **Mock** (test/demo).

### 3.4 Baku API (`api/`, Bun + Hono)

- **Entry:** `api/src/index.ts`. Port `8787`. Mounts `vaultRoutes`, `balanceRoutes`,
  `submitRoutes`. **Permissive CORS** (read-only + build-tx, no signing) — tighten
  origin allow-list for production.
- **No client auth — by design.** A static key shipped in a wallet bundle is
  security theatre; the real DoS mitigations are the short-TTL caches plus
  Soroban RPC's own throttling. The API has **no signing capability**, so a
  compromised API cannot move funds.
- **Address source of truth:** `api/src/addresses.ts`, manually mirrored from
  `crates/addresses/src/lib.rs` (intentional duplication — addresses are an
  auditable surface; each promotion is a reviewable commit, not opaque codegen).

#### Endpoint contract

| Method · Path | Auth | Purpose | Response shape |
|---------------|------|---------|----------------|
| `GET /` | — | Inventory | `{ name, version, endpoints[] }` |
| `GET /health` | — | Liveness | `{ ok, t }` |
| `GET /addresses` | — | Active-network address struct | `NetworkAddresses` |
| `GET /vault/:asset/state` | — | TVL/APY/PPS + per-strategy breakdown (cached 30 s) | `{ vault, activeStrategy, totalAssets, totalSupply, pricePerShare, poolApyBps, strategyPositions[] }` |
| `GET /vault/:asset/strategies` | — | Registry + active marker | `{ vault, active, registered[] }` |
| `POST /vault/:asset/deposit/build-tx` | — | Build unsigned deposit XDR | `{ xdr, vault, asset }` |
| `POST /vault/:asset/withdraw/build-tx` | — | Build unsigned redeem XDR w/ slippage floor | `{ xdr, vault, asset, preview:{expected,minOut,maxSlippageBps} }` |
| `POST /tx/submit` | — | Submit signed XDR; poll ≤30 s | `{ hash, status, returnValue }` |
| `GET /balance/:address` | — | Aggregated balances (cached 3 s) | `{ stxlm, stusdc, xlm, usdc }` |
| `POST /faucet/blend-testnet` | — | Testnet faucet (partially-signed classic tx) | partially-signed XDR |

- `asset ∈ {xlm, usdc}`. All amounts are **i128 decimal strings** in base units
  (7 decimals).
- `withdraw/build-tx` server-side reads `preview_redeem(shares)`, computes
  `min_out = expected · (10000 − max_slippage_bps) / 10000` (default 100 bps),
  and bakes it into the contract call; the **vault enforces the floor on-chain**.
- Errors: `{ error }` with `400` (bad body / contract simulation error, typed
  enum discriminant embedded), `404` (placeholder/undeployed vault), `500`.

---

## 4. Repo 2 — xyra-walllet: agent backend

- **Stack:** Express + TypeScript. Entry `src/index.ts`, port `3000`. MongoDB
  (Mongoose), Redis (ioredis), Telegraf (Telegram), `jsonwebtoken` (HS256).
- **Boot is fail-closed:** the process `exit(1)`s if `MONGODB_URI` is missing,
  if `JWT_SIGNING_SECRET` is missing/placeholder/<16 chars/dev-fallback, or if
  `AGENT_SECRET_KEK_BASE64` is missing/placeholder/not exactly 32 bytes.

### 4.1 API surface

**Public (no token):**

| Method · Path | Purpose |
|---------------|---------|
| `POST /v1/auth/challenge` | Begin SIWE handshake → `{ nonce, domain, statement, issuedAt, expiresAt, message }` |
| `POST /v1/auth/verify` | Verify signature → `{ token (HS256 JWT, 15 min), expiresAt }` |
| `GET /v1/health` | Liveness |
| `GET /v1/yield-sources/off-chain` | Curated off-chain yield list |
| `GET /api/v1/alerts/:token` | **x402-paid** price + 24h change (Pillar 2) |
| `GET /api/v1/contract/{mainnet,testnet}/:address` | **x402-paid** Soroban contract summary (Pillar 4) |

**Authenticated (Bearer JWT; `requireAuth` + per-agent ownership check):**

| Method · Path | Purpose |
|---------------|---------|
| `GET/PUT /v1/rules/:address` | Read/update trading rules (`buyBelowUsd`, `sellAboveUsd`, `tier1Max`, `tier2Max`, `dailyBudget`, `buyAmountUsdc`, `sellAmountXlm`) |
| `GET /v1/logs/:address` | Paginated trade/event logs |
| `GET /v1/metrics/:address` | Live balances, daily spend vs cap, status, `pendingTier2Count` |
| `GET /v1/pending-tier2/:address` | Pending Tier-2 trade (0 or 1) |
| `POST /v1/pending-tier2/:address/:id/confirm` | Execute pending trade (`{ direction }`) → `{ ok, txHash }` |
| `POST /v1/pending-tier2/:address/:id/reject` | Discard |
| `POST /v1/narrate-log/:address/:logId` | AI narration (Pillar 4) |
| `POST /v1/explain-rules/:address` | AI rule explainer (Pillar 4) |
| `POST /v1/revoke/:address` | Stop worker, drain assets to user wallet, disable agent |

**Ownership check is fail-closed:** `assertOwnsAgent` returns `403` unless the
authed `pubkey === agent.targetWallet`, and **also 403 if the target is falsy**.

### 4.2 SIWE authentication (SEP-53)

1. `/v1/auth/challenge {pubkey}` → server validates the Stellar pubkey, mints a
   16-byte hex nonce (5-min TTL), builds a canonical SEP-53 message, stores it
   in an in-memory single-use map.
2. Wallet signs `sha256("Stellar Signed Message:\n" + message)` with ed25519.
3. `/v1/auth/verify {pubkey, signature, message}` → exact-message lookup, pubkey
   match, expiry check, `Keypair.verify()`; **challenge consumed on verify**
   (replay-safe); issues HS256 JWT `{ sub: pubkey }`, 15-min expiry.
4. `requireAuth` validates the Bearer JWT and attaches `req.auth = { pubkey }`.

### 4.3 Secret/key management — envelope encryption

Per-user **agent** Stellar secret keys are persisted in Mongo under
**two-layer AES-256-GCM** (`src/services/agent-secret-crypto.ts`):

- **DEK** — random 32-byte key per agent; encrypts the agent secret →
  `agentSecretCiphertext` + `agentSecretIv`.
- **KEK** — master 32-byte key from `AGENT_SECRET_KEK_BASE64`; wraps the DEK →
  `agentSecretDekWrapped` + `agentSecretDekIv`.

Decrypt = unwrap DEK with KEK, then decrypt secret with DEK. The plaintext agent
key exists only transiently in memory during a swap/revoke. The user's key is
**never** stored here.

### 4.4 Trade automation (Pillar 3)

- **WorkerManager** polls each active agent every **30 s**: reloads the agent,
  resets the daily budget on a UTC day change, fetches the XLM price (via the
  agent's own x402-paid `/api/v1/alerts/XLM` call), derives a `buy_xlm`/`sell_xlm`
  signal from `buyBelowUsd`/`sellAboveUsd`.
- **Tier routing** (`trade-routing.ts`): planned notional ≤ `tier1Max` →
  **Tier-1 auto-swap**; `tier1Max < n ≤ tier2Max` → **Tier-2 confirm** (queued,
  surfaced to the extension + Telegram); `> tier2Max` → **blocked**.
- **Guardrails:** hard **daily USDC cap** (`dailyBudget`, UTC reset), a
  same-zone cooldown (default 30 s) to avoid thrashing, a `0.01` USDC fee
  reserve, and a `100`-bps path-payment slippage cap on swaps.
- **Tier-2 race safety:** confirm uses a **claim-before-await** pattern — the
  pending slot is cleared synchronously before the async swap, preventing
  double-execution on concurrent confirms; swap errors return a generic `502`
  with no server-side detail leaked to the client.

### 4.5 AI copilot (Pillar 4)

- Google **Gemini** (`GEMINI_MODEL`, default `gemini-3.5-flash`),
  `GEMINI_API_KEY` read at startup (fail-soft).
- **Advice guardrail:** outputs matching `/\b(should|recommend|advise|predict|will|forecast)\b/i`
  are rejected and replaced by **deterministic fallback** text — so the copilot
  never appears to give financial advice, and never hard-fails if the model is down.
- Narration/explanation are **write-through cached** (on the log doc / by rules
  hash); contract summaries cache on `(network, contract, wasmDigest)` in Mongo.

### 4.6 x402 / Money Flow (Pillar 2)

- `@x402/express` payment middleware, **Exact Stellar** scheme (USDC), via an
  OpenZeppelin facilitator (`FACILITATOR_URL`/`FACILITATOR_API_KEY`), settling to
  `RECEIVER_WALLET`. Paid routes return `503` if the facilitator config is a
  placeholder (fail-soft disable). Default price `$0.01` USDC/request.

---

## 5. Repo 3 — xyra-wallet-sdk: extension

- **Freighter fork**, **Manifest V3**, **React 19** + Redux Toolkit, Webpack 5,
  yarn workspaces. `@stellar/stellar-sdk@14.4.3`.
- **Three runtime parts:** popup UI (`src/popup`), **background service worker**
  (`public/background.ts` → message listeners), content script (`<all_urls>`).
- **Key custody & signing:** the user's keypair is held by the **background
  worker**, decrypted in-memory after password unlock, and **never exposed to the
  popup or content script**. All signing is funneled through the worker:
  - `signFreighterSorobanTransaction` — Soroban XDR (vault deposits/redeems)
  - `signAuthMessage` — SEP-53 auth message (SIWE to the agent backend)
  - `signFreighterTransaction` / `signBlob` — classic tx / arbitrary blob

### 5.1 Backend wiring (build-time env, injected via Dotenv)

| Constant (`src/constants/env.ts`) | Default | Target |
|-----------------------------------|---------|--------|
| `BAKU_API_URL` | `http://localhost:8787` | Repo 1 — vault API (Seam A) |
| `BACKEND_URL` | `""` (set per-env) → `${BACKEND_URL}/v1` | Repo 2 — agent backend (Seam B) |
| `INDEXER_URL` / `INDEXER_V2_URL` | Stellar wallet-backend prd | Freighter indexer (balances, history, Blockaid scans) |
| `STELLAR_NETWORK` | `testnet` | Network selector |

- **`src/api/yieldHubService.ts`** wraps every Baku endpoint (Seam A).
- **`src/api/agentBackendService.ts`** wraps every agent-backend endpoint (Seam B),
  including the SIWE handshake, a per-pubkey **JWT cache** (refresh 10 s before
  expiry, single silent retry on `401`).

### 5.2 Product surfaces

- **Yield Hub** (`popup/views/YieldHub`): deposit/redeem forms, `StrategyMixPanel`
  (per-strategy/30-40-30 allocation bar), **auto-yield** toggle (sweeps idle
  balance every 60 s, 5-min cooldown), **withdraw slippage slider** (50–500 bps,
  persisted). Build → sign (worker) → submit. Testnet-gated.
- **Direction C** (`Dashboard`, `AgentConfig`, `ConfirmTrade`, `ActivityLog`):
  SIWE auth client, rules editor with AI explainer, **Tier-2 confirm** UI (polls
  every 15 s, maps UI side `buy/sell` → wire `buy_xlm/sell_xlm`) + dashboard
  badge (`pendingTier2Count`), per-row AI narration (lazy via IntersectionObserver).

### 5.3 Build

`yarn build:extension:production` (minified, Sentry upload) → `extension/build/`
(`background.min.js`, `index.min.js`, `contentScript.min.js` + V3 manifest). CI:
`submitProduction.yml` / `submitBeta.yml` / `newRelease.yml`.

---

## 6. Integration Seam A — Extension ⇄ Baku API

**Contract type:** key-less, build-then-sign. **Auth:** none (API can't sign).

| Step | Extension call | Baku endpoint | Notes |
|------|----------------|---------------|-------|
| Read state | `yieldHubService.getVaultState(asset)` | `GET /vault/:asset/state` | 30-s cached |
| Read balances | `getBalance(addr)` | `GET /balance/:address` | 3-s cached |
| Build deposit | `buildDeposit(asset, pubkey, amount)` | `POST …/deposit/build-tx` | returns unsigned XDR |
| Build redeem | `buildWithdraw(asset, pubkey, shares, bps)` | `POST …/withdraw/build-tx` | returns XDR + slippage `preview` |
| Sign | `signSorobanXdr(xdr)` (background worker, **user key**) | — | never leaves the extension |
| Submit | `submitSignedTx(signedXdr)` | `POST /tx/submit` | API polls RPC ≤30 s |

**Invariants:** amounts/shares are i128 decimal strings (7 decimals); slippage
floor is computed server-side but **enforced on-chain**; the API holds no key and
cannot initiate a transfer.

---

## 7. Integration Seam B — Extension ⇄ Agent backend (SIWE)

**Contract type:** SEP-53 Sign-In, Bearer JWT. **Two distinct keys never mix:**
the **user key** signs the SIWE challenge (proves wallet ownership); the
**agent key** (server-custodied) signs the actual trades.

| Phase | Extension | Agent backend |
|-------|-----------|---------------|
| Challenge | `POST /v1/auth/challenge {pubkey}` | nonce + SEP-53 `message` (5-min, single-use) |
| Sign | `signAuthMessage(message)` (worker, user key) | — |
| Verify | `POST /v1/auth/verify {pubkey, signature, message}` | `Keypair.verify()` → HS256 JWT (15 min) |
| Use | `Authorization: Bearer <jwt>` on all `/v1/*` | `requireAuth` + ownership (`pubkey===targetWallet`) |
| Confirm trade | `POST /v1/pending-tier2/:addr/:id/confirm {direction}` | decrypt agent key → `executeSwap` → `{ ok, txHash }` |

**Token lifecycle (client):** cached per pubkey, refreshed 10 s before expiry,
one silent retry on `401`. **CORS (server):** `WALLET_ORIGIN` allows
`chrome-extension://*` (or an exact extension id), methods `GET/POST/PUT/OPTIONS`,
headers `Content-Type, Authorization`.

---

## 8. The bridge — Smart Account (Pillar 5) security model

This is the load-bearing security innovation and the strongest SCF-relevant
asset: it converts "trust the agent backend" into "the agent is cryptographically
fenced on-chain." Built on **OpenZeppelin `stellar-accounts` 0.7.1** — **no
hand-rolled auth**.

### 8.1 Contract (`crates/sa-account/src/lib.rs`)

- `__check_auth` delegates **verbatim** to OZ `do_check_auth` (no custom logic).
- `__constructor` installs **exactly two policy-less, `CallContract`-scoped
  context rules**, both bound to the **same External-Ed25519 agent signer**, with
  **no Default/master rule**:
  - **Rule 0** → `CallContract(VAULT_XLM)` (the `deposit@VAULT_XLM` context).
  - **Rule 1** → `CallContract(XLM_SAC)` (the **nested** `transfer@XLM_SAC`
    context that `vault.deposit` triggers when it moves the asset to the strategy).
- **Why two rules:** a real `vault.deposit(SA, assets)` forces **two** nested
  auth contexts. OZ validates **every** context against an installed rule
  **before any signature is checked**; with only the vault rule, the nested SAC
  transfer context is unmatched and the call reverts `UnvalidatedContext(3002)`.

### 8.2 The rule-bound auth digest (the binding that prevents downgrade)

```
auth_digest = SHA-256( raw32(signature_payload) ‖ ScValXdr(context_rule_ids) )
```

- `signature_payload` = `sha256(XDR(HashIDPreimage::SorobanAuthorization{…}))` — 32 raw bytes.
- `context_rule_ids` = the **full soroban `ScVal` XDR of `Vec<u32>`** —
  `SCV_VEC` discriminant + present-flag + length + per-element `SCV_U32` framing
  (**12 + 8·N bytes**, e.g. 36 bytes for `[0,1,42]`), **not** a naive int-array.
- The agent signs the **digest**, not the raw host payload. Changing the
  presented rule-ids changes the digest, so the signature no longer verifies.

### 8.3 Rust ↔ TypeScript parity (proven)

- **Ground truth:** `crates/sa-tracer/tests/digest_reference.rs` computes the
  digest with native soroban-sdk crypto over **6 adversarial vectors** (empty,
  single, multi, ≥15-element, and `u32::MAX`/0 boundaries) and emits
  `tests/fixtures/digest_vectors.json`.
- **Off-chain replica:** `api/src/auth-digest.ts` reproduces it byte-for-byte
  using the **real `@stellar/stellar-sdk` `xdr.ScVal` types**
  (`xdr.ScVal.scvVec([scvU32(n)…]).toXDR()`) — hand-rolled bytes are forbidden.
- **Parity gate:** `bun run tracer:digest-parity` asserts byte-equality for
  **every** vector and enforces adversarial coverage (fails loudly otherwise).
- The `sa-tracer` crate is a fail-loud circuit breaker: a compile-time assertion
  pins the real OZ field name (`AuthPayload.signers: Map<Signer,Bytes>`), so a
  future OZ rename breaks the build instead of silently corrupting auth.

### 8.4 Ed25519 verifier (`crates/sa-account/verifier/src/lib.rs`)

Thin wrapper over OZ's audited `ed25519::verify`. **Hardened fail-closed:**
untrusted `sig_data` from the caller-supplied `AuthPayload.signers` map that is
the wrong `Val` type or not 64 bytes returns `false` (→ `ExternalVerificationFailed`)
**instead of trapping**. (This was the one HIGH from the security review, fixed
and redeployed; deployed wasm hash `38a118f9…` == source.)

### 8.5 End-to-end proof + fail-closed negatives (`api/scripts/tracer-deposit.ts`)

A real agent-signed `vault.deposit` succeeds e2e, and **four negatives each fail
closed with an AUTH error**:

| # | Negative | Expected revert |
|---|----------|-----------------|
| a | Tampered digest (flip a byte before signing) | `ExternalVerificationFailed(3003)` |
| b | Correct ids presented, signature over a **different** id permutation | `3003` (clean id-binding test) |
| c | Sign with an **unregistered** ed25519 key | `3003` |
| d | Deposit on an **out-of-scope** vault (legacy v1) | `UnvalidatedContext(3002)` — *before* signature check |

**Error semantics:** `3002` (UnvalidatedContext) fires when **no rule covers a
context** — scope is enforced *before* the signature, blocking rule downgrade.
`3003` (ExternalVerificationFailed) fires when the ed25519 check fails (tampered
digest, wrong ids, wrong key). No path escalates privilege or fails open.

### 8.6 Relationship to the off-chain agent

The agent backend (Repo 2) is the off-chain holder of the throwaway ed25519 key.
For an agent-driven deposit it: builds `vault.deposit(SA,…)`, simulates to extract
the SA auth entry, recomputes `signature_payload`, derives the per-context
`context_rule_ids` from the **on-chain rule map** (e.g. `[0,1]`), computes the
digest via the shared `auth-digest.ts`, signs it, attaches the `AuthPayload`, and
submits. Its on-chain authority is exactly the two scoped rules — nothing more.

---

## 9. Cross-cutting data formats & conventions

- **Numbers:** all on-chain amounts/shares are **i128 decimal strings** in base
  units, **7 decimals** everywhere (XLM, USDC, `stXLM`, `stUSDC`). BigInt-safe;
  never JS `number`.
- **Addresses:** Stellar `G…` (accounts), `C…` (contracts). The address book is
  triplicated and reconciled across `crates/addresses/src/lib.rs`,
  `api/src/addresses.ts`, and `scripts/deployed.testnet.env` (intentional,
  auditable).
- **Signing primitives:** Soroban XDR (transactions), SEP-53
  `sha256("Stellar Signed Message:\n"+msg)` (auth messages) — both ed25519, both
  performed only inside the extension's background worker.
- **Auth tokens:** HS256 JWT, `sub = pubkey`, 15-min expiry, Bearer header.
- **Network:** `Test SDF Network ; September 2015`; RPC `https://soroban-testnet.stellar.org`.

---

## 10. Security properties (consolidated)

| Property | Mechanism | Where |
|----------|-----------|-------|
| User key isolation | Key only in extension background worker; never sent to any backend | Repo 3 |
| Key-less API | Baku API only reads + builds; cannot sign/move funds | Repo 1 |
| Encryption at rest | AES-256-GCM envelope (KEK wraps per-agent DEK) for agent keys | Repo 2 |
| Fail-closed boot | `exit(1)` on missing/weak `JWT_SIGNING_SECRET`, `KEK`, `MONGODB_URI` | Repo 2 |
| Replay-safe auth | Single-use 5-min SIWE challenge; signature verify; 15-min JWT | Repo 2 |
| Ownership enforcement | `pubkey === targetWallet`, 403 on falsy target | Repo 2 |
| Bounded auto-trading | Two-tier (auto/confirm) + hard daily USDC cap + slippage cap + cooldown | Repo 2 |
| Race safety | Claim-before-await on Tier-2 confirm | Repo 2 |
| On-chain agent fencing | Scoped, policy-less, fail-closed OZ smart-account rules | Repo 1 (SA) |
| Downgrade resistance | Rule-bound auth digest (ids in the SHA-256 preimage) | Repo 1 (SA) |
| Scope-before-signature | Context validated (`3002`) before ed25519 check (`3003`) | OZ `do_check_auth` |
| Hardened verifier | Malformed untrusted sig → `false`, never traps | Repo 1 (verifier) |
| On-chain slippage floor | `redeem` reverts `SlippageExceeded` below `min_out` | Repo 1 (vault) |
| AI advice guardrail | Banned-word regex → deterministic fallback | Repo 2 |
| No detail leakage | Swap errors → generic 502, reason server-side only | Repo 2 |

---

## 11. Deployment, configuration & build

### 11.1 Local stack (Docker)

| Service | Port | Notes |
|---------|------|-------|
| baku-api | 8787 | `cd api && docker compose up -d`; `restart: unless-stopped` |
| agent-backend | 3000 | Express; `host.docker.internal` → host Mongo/Redis; healthcheck `/health` |
| xyra-mongo | 27017 | encrypted agent keys, logs, contract summaries |
| Redis | 6379 | price cache (30-s TTL) |

### 11.2 Key environment variables

- **Baku API:** `PORT`, `NETWORK`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`, `ADMIN_ADDR`.
- **Agent backend (fail-closed):** `MONGODB_URI`, `JWT_SIGNING_SECRET`,
  `AGENT_SECRET_KEK_BASE64`. **(fail-soft):** `GEMINI_API_KEY`, `GEMINI_MODEL`,
  `FACILITATOR_URL`/`FACILITATOR_API_KEY`/`RECEIVER_WALLET`,
  `SOROBANHOOKS_INDEXER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `WALLET_ORIGIN`,
  `REDIS_URL`, tier/cooldown/cap tunables.
- **Extension (build-time):** `BAKU_API_URL`, `BACKEND_URL`, `INDEXER_URL`,
  `INDEXER_V2_URL`, `STELLAR_NETWORK`, `AMPLITUDE_KEY`, `SENTRY_KEY`.

### 11.3 Build/deploy commands

- Contracts: `cargo build --release --target wasm32-unknown-unknown`; deploy via
  `scripts/deploy-testnet.sh`, `scripts/wire-blend-xlm.sh`,
  `scripts/deploy-smart-account-tracer.sh` (Stellar CLI ≥ 25.2; repo validated on 26.1.0).
- API: `bun install && bun run dev` (or Docker).
- Extension: `yarn build:extension:production`.

> **Address promotion is manual and reviewable:** after a redeploy, copy the new
> ids from `scripts/deployed.testnet.env` into **both**
> `crates/addresses/src/lib.rs` and `api/src/addresses.ts` in one commit.

---

## 12. Testnet address book

Network: `Test SDF Network ; September 2015` · RPC `https://soroban-testnet.stellar.org`.
**Mainnet: nothing deployed (placeholders, gated on audit + SCF).** Verified on-chain 2026-06-02.

| Contract | Address |
|----------|---------|
| **vault-xlm v2 (CANONICAL, rebalance-capable)** | `CCY337D4WZ6OECCTQMWIMWT2CHBC73YY5JFRKBJ665O654KMUG3CP7YH` |
| legacy vault-xlm v1 (redeem-only) | `CCDEEXUU25RUOZVSYCSJPX35QKPZTDBAT6UFW6GTC633LV3TLOXMDOLD` |
| vault-usdc | `CDEOKPUFZT7XL5XITZWUTVD2VBU2NDEVA5EL7XXLMKP6INML4EHIEXNL` |
| BlendStrategy-XLM (active) | `CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ` |
| BlendStrategy-USDC (active) | `CDVPZOJTAP5X2XLRYWSLFCRKE5KNV4ZMPWB6NPSGWWT3YKSTQTM5YFSG` |
| SoroswapStrategy-XLM (registered) | `CA4SKYV4O34KJA7TEA36GRDZJK3OZ2FN6QON4QDRA27V7RMPLJTGQHOS` |
| DeFindex-USDC (registered) | `CDXUHZ2FHLEV6G5YRUYNWKXMNGJUSHELYLQ2LOZRCGTJ6ZFMC2Z2YEAY` |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Smart Account (hardened, 2 scoped rules) | `CCZ7LWLZ67GSVYZNICUCIZJBQG4KDE4KVPX7C6E2M2WCOPJUQ5HTJXE4` |
| Ed25519 verifier (hardened) | `CBXBHFARMU5GOMDZV3XWPEZJY2NDUEHO6L6DAZNCDQCKZNAL26KPBP4V` |
| Blend V2 pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Soroswap V2 router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| Admin / deployer (G-account) | `GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV` |

---

## 13. Verification & test evidence

- **Vault e2e:** deposit/redeem validated against vault-xlm v2 (shares minted,
  on-chain `totalAssets` moved, redeem `returnValue` delivered) — see `API.md`.
- **Digest parity (AC3):** `bun run tracer:digest-parity` — TS ≡ Rust for all 6
  adversarial vectors; `cargo test -p sa-tracer oz_api_shape` 5/5.
- **Smart-account R5a (AC4/AC5):** agent-signed `vault.deposit` succeeds e2e
  (tx `0707420f…`) against the **hardened** SA + verifier; **all four negatives
  fail closed** (`3003×3` + `3002`); independently re-verified on-chain.
- **Security review:** PASS after the one HIGH (verifier trap on malformed sig)
  was fixed to fail-closed; deployed wasm hash `38a118f9…` == source.
- **Integration:** all three repos merged to default branches; STATUS.md is the
  evidence-linked source of truth (PR `mergedAt`, on-chain reads, passing tests).

---

## 14. Maturity, gaps & mainnet path

**Live on testnet:** multi-strategy vaults (Blend active; Soroswap/DeFindex
registered), the full Baku API, the agent backend (all 5 pillars), the extension
(Yield Hub + Direction C), and a hardened, adversarially-tested Smart Account.

**Known gaps / honest scope:**
- **Mainnet:** nothing deployed — deliberately gated on a security audit + SCF.
- **Operational, not architectural, remaining:** set production keys
  (`JWT_SIGNING_SECRET`, `KEK`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`,
  facilitator), fund a testnet account, record the demo.
- Soroswap USDC strategy is a stub; legacy vault-xlm v1 remains a documented
  redeem-only path; strategy-name labels for unknown addresses are cosmetic.
- Smart-account **policies** (per-call argument limits) and an admin-management
  rule are the next on-chain frontier (Cycle-2); Turnkey signing / Mongo→SA
  migration are design-only and deferred.

**Why the architecture is mainnet-ready in shape:** the trust boundaries are
already correct (key isolation, key-less API, fenced agent), the auth path is OZ
audited code (not hand-rolled), the digest binding is proven byte-identical
across languages with adversarial coverage, and every failure path is fail-closed
and verified on-chain. The path to mainnet is audit + funding + ops, not redesign.
