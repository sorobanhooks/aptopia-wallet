# Xyra Smart Wallet — Architecture Overview

> **Audience:** high-level / non-deep-technical. Reviewers, partners, and SCF
> evaluators who want the shape of the system before the detail.
> For the byte-level integration spec, see [`SCF_TECHNICAL_INTEGRATION.md`](./SCF_TECHNICAL_INTEGRATION.md).
>
> **Last reconciled:** 2026-06-08 · Network: **Stellar testnet** (mainnet gated on audit + SCF)

---

## 1. What Xyra is

Xyra is a **non-custodial smart wallet on Stellar** that adds three things a
plain wallet doesn't have:

1. **One-click on-chain yield** — deposit XLM or USDC into an autonomous vault
   and receive a yield-bearing receipt token (`stXLM` / `stUSDC`) that grows in
   value as the underlying earns from real DeFi strategies (Blend lending,
   Soroswap LP/swap-and-hold).
2. **A scoped trading agent** — an off-chain agent that runs price-triggered
   rules, with a two-tier safety model (auto-execute small trades, ask the user
   to confirm larger ones) and hard daily spend caps.
3. **An AI copilot + pay-per-call data** — plain-English narration of trades and
   rules, Soroban contract summaries, and HTTP-402 paid data endpoints settled
   in USDC on Stellar.

Stellar has no native staking primitive, so the yield product is **liquid yield
aggregation**, not "liquid staking." `stXLM` / `stUSDC` are receipt tokens, not
staking derivatives.

---

## 2. The three repositories (and why they're separate)

The product is delivered as **three independently deployable repos**, each
owning one tier and one trust boundary.

| # | Repo | Tier | Owns | Runtime |
|---|------|------|------|---------|
| 1 | **xyra-vault** ("Baku")<br/>`shah-aman/xyra-vault` → `main` | On-chain + read/build API | Soroban smart contracts (vault, strategies, smart account) + a stateless transaction-building API | Rust/WASM on Soroban; Bun + Hono API |
| 2 | **xyra-walllet** (agent backend)<br/>`SaaS-Repo/xyra-walllet` → `master` | Off-chain agent / middle tier | Trading rules, encrypted agent keys, Tier-2 confirmation queue, AI copilot, x402 paywall, Telegram bot | Node + Express + MongoDB + Redis |
| 3 | **xyra-wallet-sdk** (extension)<br/>`Blockchain-AI-Apps/xyra-wallet-sdk` → `main` | Client / frontend | The browser-extension wallet UI; holds the user's key, signs all XDR, drives both backends | React 19, Manifest V3, Webpack |

**Why three, not one:** they sit on different trust boundaries.

- The **extension** is the only component that ever holds the user's private key.
  It signs everything locally; neither backend can move funds on the user's behalf.
- The **vault API** is *stateless and key-less* — it only **reads** chain state
  and **builds** unsigned transactions. It can be public because it can't sign.
- The **agent backend** is the only stateful, secret-holding server (it custodies
  a *separate, throwaway* agent key per user under envelope encryption). Isolating
  it lets the auto-trading blast radius be bounded by a smart-account policy
  rather than by trusting a server.

---

## 3. System map

```
┌────────────────────────────────────────────────────────────────────────────┐
│  REPO 3 — xyra-wallet-sdk  (browser extension, Manifest V3, React)          │
│  • Holds the user's Stellar key (decrypted in the background service worker) │
│  • Signs ALL transactions/messages locally (Soroban XDR + SEP-53 auth msgs)  │
│  • Two product surfaces: Yield Hub (vault) + Direction C (agent/AI)          │
└───────────┬───────────────────────────────────────────┬─────────────────────┘
            │ build-tx / submit / read state             │ SIWE auth + rules + AI
            │ (no auth — key-less API)                    │ (Bearer JWT)
            ▼                                             ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────────┐
│  REPO 1 — Baku API  (Bun + Hono) │   │  REPO 2 — Agent backend (Express)     │
│  • GET  /vault/:asset/state      │   │  • POST /v1/auth/{challenge,verify}   │
│  • POST /vault/:asset/deposit/   │   │  • GET/PUT /v1/rules/:addr            │
│         build-tx, withdraw/build │   │  • GET  /v1/pending-tier2 + confirm   │
│  • POST /tx/submit               │   │  • POST /v1/narrate-log, explain-rules│
│  • GET  /balance/:address        │   │  • GET  /api/v1/alerts (x402 paywall) │
│  • Stateless, no private keys    │   │  • Mongo (encrypted keys) + Redis     │
└───────────┬──────────────────────┘   └───────────┬──────────────────────────┘
            │ Soroban RPC                           │ signs trades w/ agent key
            │                                        │ + Soroban/Horizon RPC
            ▼                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  ON-CHAIN — Stellar Soroban (testnet)                                       │
│  ┌────────────────────┐   ┌────────────────────┐   ┌───────────────────────┐│
│  │ vault-xlm / -usdc  │   │ Strategies          │   │ Smart Account (OZ)    ││
│  │ OZ Vault + SEP-41  │──▶│ Blend · Soroswap ·  │   │ scoped agent rules,   ││
│  │ deposit/redeem/    │   │ DeFindex · Mock     │   │ fail-closed auth      ││
│  │ rebalance, registry│   │ (strategy-trait)    │   │ (Pillar 5, on testnet)││
│  └────────────────────┘   └────────────────────┘   └───────────────────────┘│
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. The two integration seams (this is the whole "3-repo integration")

Everything in the system reduces to **two contracts between repos**, both
crossed only by the extension:

### Seam A — Extension ⇄ Baku API (the yield path)

A **key-less, build-then-sign** protocol. The API never holds a key:

1. Extension asks the API to **build** an unsigned deposit/withdraw transaction
   (`POST /vault/:asset/deposit/build-tx`).
2. Extension **signs** the returned XDR locally with the user's key.
3. Extension **submits** the signed XDR (`POST /tx/submit`), and the API polls
   Soroban RPC for the result.
4. State and balances are plain reads (`/vault/:asset/state`, `/balance/:addr`),
   short-TTL cached to protect RPC quota.

Because the API can only *read* and *build*, it is safe to expose without auth —
a stolen API has no signing power.

### Seam B — Extension ⇄ Agent backend (the agent/AI path)

A **SIWE-style authenticated** protocol (Sign-In With a Stellar key, SEP-53):

1. Extension requests a challenge, **signs it** with the user's key, exchanges
   it for a short-lived **Bearer JWT**.
2. With the JWT it manages trading **rules**, reads **metrics/logs**, confirms or
   rejects **Tier-2** trades, and fetches **AI** narration/explanations.
3. The backend executes auto-trades itself using a **separate per-user agent key**
   it custodies under AES-256-GCM envelope encryption — never the user's key.

### The bridge between the seams — Smart Account (Pillar 5)

The agent backend's trading power is bounded on-chain by an **OpenZeppelin
Stellar smart account**: the agent key can only sign **scoped, fail-closed**
operations (e.g. deposit into one specific vault). This is the piece that turns
"trust the server" into "the server is cryptographically constrained." It is
**proven on testnet** today (auth-digest parity Rust↔TS, end-to-end deposit, and
four fail-closed negative tests) and is the bridge from the off-chain agent
(Seam B) back to the on-chain vault (Seam A).

---

## 5. The five product pillars

| Pillar | What the user gets | Where it lives | Status |
|--------|--------------------|----------------|--------|
| **1 — Yield Hub** | Deposit/redeem into multi-strategy vaults; live per-strategy breakdown; auto-yield sweep; slippage control | vault contracts + Baku API + extension Yield Hub | ✅ Live (testnet) |
| **2 — Money Flow / x402** | Pay-per-call data (price alerts, contract summaries) settled in USDC over HTTP-402 | agent backend | ✅ Live |
| **3 — Trade Automation** | Price-triggered agent; Tier-1 auto / Tier-2 confirm; daily caps; Telegram control | agent backend + extension Confirm UI | ✅ Live (needs keys/funding) |
| **4 — AI Copilot** | Plain-English trade narration, rule explainer, Soroban contract summaries (Gemini, advice-blocked) | agent backend + extension | ✅ Live (needs Gemini key) |
| **5 — Security / Smart Account** | Agent power bound by scoped, fail-closed on-chain rules | sa-account contract + tracer (vault repo) | ✅ Proven on testnet; mainnet design path next |

---

## 6. Trust & safety model (the one-paragraph version)

The **user's key never leaves the extension.** The **vault API can't sign**, so
it's harmless if compromised. The **agent backend holds only a throwaway agent
key**, encrypted at rest with a two-layer (KEK/DEK) envelope, and its on-chain
power is **fenced by a smart-account policy** that fails closed — an out-of-scope
call or a tampered signature reverts *before* any value moves. Auto-trading is
further bounded by **two tiers** (auto vs. user-confirm) and a **hard daily USDC
cap**. AI output is passed through an **advice-blocking guardrail** and falls
back to deterministic text if the model is unavailable. Secrets are validated
**fail-closed at startup** (the server refuses to boot with a missing/weak
JWT secret or KEK).

---

## 7. Deployment status at a glance

- **On-chain:** vault-xlm v2 (canonical), vault-usdc, Blend strategies (active),
  Soroswap + DeFindex (registered), and a hardened Smart Account — **all live on
  Stellar testnet**, verified on-chain. **Mainnet: nothing deployed yet**
  (placeholders; gated on a security audit + SCF funding).
- **Off-chain:** Baku API, agent backend, MongoDB, and Redis run as a
  Docker-composed local stack (`restart: unless-stopped`), with a VM deploy guide.
- **Client:** the extension builds via `yarn build:extension:production`
  (Chrome/Firefox), with CI release workflows.

All three repos are **integrated and merged** to their default branches; the
remaining work before a public demo is operational (set production keys, fund a
testnet account, record the walkthrough), not architectural.

---

## 8. Where to go next

- **Byte-level integration spec, API contracts, auth flows, contract methods,
  smart-account security proof, address book** → [`SCF_TECHNICAL_INTEGRATION.md`](./SCF_TECHNICAL_INTEGRATION.md)
- **Baku API reference** → [`../API.md`](../API.md)
- **Contract/vault layout** → [`../README.md`](../README.md)
- **Live feature & merge status (source of truth)** → `.context/STATUS.md`
