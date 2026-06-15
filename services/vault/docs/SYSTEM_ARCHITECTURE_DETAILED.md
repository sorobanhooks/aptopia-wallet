# Xyra — Detailed System Architecture

> **Audience:** engineers working across the three repos.
> **Scope:** low-level component internals, Mermaid system diagrams, per-flow
> data traces, security boundaries, and demo vs canonical configuration.
>
> **Companion docs:**
> - High-level shape → [`ARCHITECTURE_OVERVIEW.md`](./ARCHITECTURE_OVERVIEW.md)
> - API contracts, auth specs, SCF evidence → [`SCF_TECHNICAL_INTEGRATION.md`](./SCF_TECHNICAL_INTEGRATION.md)
> - Baku API reference → [`../API.md`](../API.md)
>
> **Last reconciled:** 2026-06-08 · Stellar testnet · all three repos merged to
> default branches.

---

## Table of contents

1. [Repository map](#1-repository-map)
2. [Full system diagram — all repos](#2-full-system-diagram--all-repos)
3. [Component 1 — Smart contracts (`crates/`)](#3-component-1--smart-contracts-crates)
4. [Component 2 — Baku API (`api/`)](#4-component-2--baku-api-api)
5. [Component 3 — Browser extension (`xyra-wallet-sdk`)](#5-component-3--browser-extension-xyra-wallet-sdk)
6. [Component 4 — Agent backend (`xyra-walllet`)](#6-component-4--agent-backend-xyra-walllet)
7. [End-to-end data flows](#7-end-to-end-data-flows)
8. [Security boundaries](#8-security-boundaries)
9. [External services](#9-external-services)
10. [Demo vs canonical configuration](#10-demo-vs-canonical-configuration)
11. [Testnet address book](#11-testnet-address-book)

---

## 1. Repository map

| # | Repo | Path / branch | Deployable unit | Holds a key? |
|---|------|---------------|-----------------|--------------|
| 1a | **xyra-vault** — contracts | `palmyra/crates/` · `main` | Rust → wasm32, deployed to Soroban | No |
| 1b | **xyra-vault** — Baku API | `palmyra/api/` · `main` | Docker · Bun 1.3-alpine · `:8787` | No |
| 2 | **xyra-walllet** | `SaaS-Repo/xyra-walllet` · `master` | Docker · Node/Express · `:3000` | Yes — per-user agent key (encrypted) |
| 3 | **xyra-wallet-sdk** | `Blockchain-AI-Apps/xyra-wallet-sdk` · `main` | Chrome Extension MV3 | Yes — user key (in-memory, background worker only) |

Repos 1a and 1b share a git repository (`xyra-vault`) but are distinct deployable
units with independent lifecycles. The address book is the only shared artifact
and is manually promoted (intentionally auditable — see §4.3).

---

## 2. Full system diagram — all repos

```mermaid
flowchart TB
    USER(["👤 User"])
    TGUSER(["📱 Telegram"])

    subgraph R3["xyra-wallet-sdk · Chrome Extension MV3"]
        direction TB
        UI["Popup UI\nYieldHub · Agent · Account"]
        BG(["Background Worker\nUser key custody\nsignSorobanXdr · signAuthMessage"])
        AY["useAutoYield\n60s ticker"]
    end

    subgraph R1b["xyra-vault — api/ · Bun :8787 · Stateless · No keys"]
        BAPI["Vault Routes\nread + build-tx + submit"]
    end

    subgraph R2["xyra-walllet · Node :3000 · MongoDB · Redis"]
        direction TB
        REST["REST API\nSIWE · rules · T2 confirm"]
        WORKER["WorkerManager\n30s agent loop"]
        TBOT["Telegram Bot"]
    end

    subgraph R1a["xyra-vault — crates/ · Stellar Testnet"]
        direction TB
        VAULT["BakuVault CCY337…\nSEP-41 share token"]
        STRATS["Strategies\nBlend · Soroswap · Allocator"]
        SA["Smart Account CCZ7LW…\nPillar 5"]
    end

    subgraph EXTERNAL["External Services"]
        RPC["Soroban RPC"]
        PROTOS["Blend V2 · Soroswap V2"]
        TGA["Telegram API"]
        FACIL["x402 Facilitator · Gemini"]
        DB[("MongoDB · Redis")]
    end

    USER -->|"deposit / withdraw / rules"| R3
    TGUSER <-->|"commands + callbacks"| TGA
    TGA <-->|"long-poll"| TBOT

    UI -->|"Seam A · no auth · HTTP/JSON\nGET state · POST build-tx · POST submit"| R1b
    UI -->|"Seam B · JWT Bearer · HTTP/JSON\nSIWE · rules · T2 confirm"| R2
    AY -->|"auto deposit"| R1b
    BG -. "signSorobanXdr USER key" .-> R1b
    BG -. "signAuthMessage USER key" .-> R2

    R1b -->|"Soroban RPC\nsimulate + send + poll"| RPC
    WORKER -->|"executeSwap agent key"| RPC
    WORKER -->|"x402 price fetch"| FACIL
    WORKER <--> DB
    TBOT --> DB

    RPC --> R1a
    VAULT --> STRATS
    SA -->|"scoped deposit · Pillar 5"| VAULT
    STRATS --> PROTOS
    WORKER -->|"swap"| PROTOS
```

---

## 3. Component 1 — Smart contracts (`crates/`)

### Role

The on-chain tier. Custodies all deposited funds through the vault + strategy
pattern. The vault IS the share token; strategies hold the underlying at external
protocols. No admin key can move user funds unilaterally — the vault only moves
funds to/from the registered active strategy, and users redeem their own shares.

### Workspace layout

```
crates/
├── addresses/          Canonical contract address book (Rust). Manually mirrored to api/src/addresses.ts.
├── strategy-trait/     #[contractclient] Strategy trait. All strategies implement this interface.
├── mock-strategy/      MockStrategy — unit tests + demo inject_yield.
├── vault/              BakuVault — OZ Vault composition. IS the SEP-41 bkuXLM/bkuUSDC share token.
├── blend-strategy/     BlendStrategy — live lending via blend-contract-sdk.
├── soroswap-strategy/  SoroswapStrategy — swap-and-hold (Soroswap V2 XLM/USDC pair).
├── defindex-strategy/  DeFindex adapter — registered on vault-usdc, currently inactive.
├── sa-account/         OZ Stellar Smart Account + Ed25519 verifier (Pillar 5).
└── sa-tracer/          Auth-digest shape/parity tracer (validation-only; no product logic).
```

### Vault contract — share math

```
VIRTUAL_SHARES = 1_000_000   (OZ ERC-4626 virtual offset, 7-decimal scale)
VIRTUAL_ASSETS = 1

deposit_shares = assets × (total_supply + VIRTUAL_SHARES)
                         ─────────────────────────────────
                         (total_assets + VIRTUAL_ASSETS)

redeem_assets  = shares × (total_assets + VIRTUAL_ASSETS)
                         ─────────────────────────────────
                         (total_supply + VIRTUAL_SHARES)
```

`total_assets` = `strategy.current_value()`, not the vault's own token balance
(which is always ~0 — funds flow depositor → strategy directly).

### Strategy trait (all strategies implement)

```rust
deposit(vault: Address, amount: i128) → Result<(), StrategyError>
withdraw(vault: Address, amount: i128) → Result<i128, StrategyError>
current_value() → i128
harvest(vault: Address) → Result<i128, StrategyError>
pool_apy() → u32
set_pool_apy_bps(admin: Address, bps: u32) → Result<(), StrategyError>
```

### Deployed strategies

| Strategy | Contract | Status | Protocol |
|----------|----------|--------|----------|
| BlendStrategy-XLM | `CAGIMEB3…` | **Active** | Blend V2 single-asset XLM lending |
| BlendStrategy-USDC | `CDVPZOJTAP…` | Active | Blend V2 USDC lending |
| SoroswapStrategy-XLM | `CA4SKYV4…` | Registered | Soroswap V2 XLM/Circle-USDC LP |
| DeFindex-USDC | `CDXUHZ2F…` | Registered | DeFindex adapter → Blend USDC |
| Allocator | via `BAKU_TESTNET_ALLOCATOR_XLM` | Demo vault only | Meta-allocator (30/40/30) |

### Weighted meta-allocator (demo vault)

```mermaid
flowchart TD
    DEP["Allocator.deposit(vault, total)"]
    B30["30% → BlendStrategy.deposit()\n→ Blend V2 Pool"]
    S40["40% → SoroswapStrategy.deposit()\n→ Soroswap V2 LP pair"]
    N30["30% held as native cash buffer\ninstant redemption"]

    DEP --> B30
    DEP --> S40
    DEP --> N30

    WD["Allocator.withdraw(vault, amount)"]
    CHK{amount ≤ buffer?}
    INSTANT["Pay from buffer instantly"]
    QUEUED["request_redeem() queued\nmulti-tx"]

    WD --> CHK
    CHK -->|Yes| INSTANT
    CHK -->|No| QUEUED

    API_READ["API reads for extension breakdown bar"]
    CH["children()\n→ weight_bps per sleeve"]
    NB["native_bps() → 3000"]
    BUF["buffer() → XLM held"]
    CV["child.current_value()\n→ per-sleeve value"]

    API_READ --> CH
    API_READ --> NB
    API_READ --> BUF
    API_READ --> CV
```

### Smart Account — Pillar 5

```mermaid
flowchart TD
    CALL["Agent calls vault.deposit(SA, assets)"]

    subgraph SA["Smart Account __check_auth  OZ do_check_auth"]
        CTX0["Auth context 0\nCallContract(VAULT_XLM)\ndeposit@VAULT_XLM"]
        CTX1["Auth context 1\nCallContract(XLM_SAC)\ntransfer@XLM_SAC nested"]
        R0{"Rule 0 matches\nCallContract(VAULT_XLM)?"}
        R1{"Rule 1 matches\nCallContract(XLM_SAC)?"}
        DIGEST["Compute auth_digest\nSHA-256(raw32(sig_payload) ‖ ScValXdr(rule_ids))"]
        VERIFY["ed25519.verify(digest, sig, agent_pubkey)"]
    end

    ERR3002["UnvalidatedContext 3002\nBEFORE signature check"]
    ERR3003["ExternalVerificationFailed 3003\nwrong sig or wrong ids"]
    OK["Auth passes\nvault.deposit proceeds"]

    CALL --> CTX0
    CALL --> CTX1
    CTX0 --> R0
    CTX1 --> R1
    R0 -->|No match| ERR3002
    R1 -->|No match| ERR3002
    R0 -->|Match| DIGEST
    R1 -->|Match| DIGEST
    DIGEST --> VERIFY
    VERIFY -->|Fail| ERR3003
    VERIFY -->|Pass| OK
```

Parity proof commands:
```bash
cargo test -p sa-tracer digest_reference   # writes digest_vectors.json (Rust ground truth)
bun run tracer:digest-parity               # TS ≡ Rust for all 6 adversarial vectors
```

---

## 4. Component 2 — Baku API (`api/`)

### Role

A **stateless, key-less read/build server**. It translates HTTP requests from the
extension into Soroban RPC simulations (reads) and unsigned transaction XDR
(build-tx). It never holds a private key and cannot initiate transfers. The only
secrets it uses are operational (RPC URL, network passphrase) — nothing that can
move funds.

### Architecture

```
src/index.ts            Hono app · CORS middleware (permissive, tighten for prod)
src/addresses.ts        Canonical NetworkAddresses · env override for demo vault
src/routes/
  vault.ts              /vault/:asset/* — state reads + build-tx
  balance.ts            /balance/:address — aggregated balances
  submit.ts             /tx/submit — relay signed XDR to RPC, poll result
src/rpc.ts              simulateRead / buildInvocationXdr / addrScVal / i128ScVal
src/cache.ts            TtlCache<T> — generic in-memory TTL cache
```

### Endpoint map

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/health` | — | `{ ok, t }` |
| `GET` | `/addresses` | — | `NetworkAddresses` (env-resolved) |
| `GET` | `/vault/:asset/state` | — | TVL + APY + pps + breakdown + strategyPositions |
| `GET` | `/vault/:asset/strategies` | — | registry + active marker |
| `POST` | `/vault/:asset/deposit/build-tx` | `{ user, amount }` | `{ xdr }` |
| `POST` | `/vault/:asset/withdraw/build-tx` | `{ user, shares, max_slippage_bps }` | `{ xdr, preview }` |
| `POST` | `/tx/submit` | `{ signed_xdr }` | `{ hash, status, returnValue }` |
| `GET` | `/balance/:address` | — | `{ stxlm, stusdc, xlm, usdc }` |
| `POST` | `/faucet/blend-testnet` | `{ userId }` | partially-signed classic XDR |

### `/vault/:asset/state` read fan-out

```mermaid
flowchart TD
    REQ["GET /vault/:asset/state"]

    subgraph P1["Parallel simulateRead ×4"]
        TA["vault.total_assets()\n→ strategy.current_value()\n→ protocol balance"]
        TS["vault.total_supply()\n→ SEP-41 total"]
        PPS["vault.price_per_share()\n→ total_assets ÷ total_supply"]
        AS["vault.active_strategy()\n→ strategy address"]
    end

    APY["strategy.pool_apy()\n→ admin-set bps"]

    CHK{"active_strategy\n== allocatorXlm?"}

    subgraph P2["Parallel allocator reads  30s cache"]
        CH["allocator.children()\n→ strategy · weight_bps · authoritative"]
        NB["allocator.native_bps() → 3000"]
        BF["allocator.buffer()\n→ XLM held"]
        CV["child.current_value() × N\n→ per-sleeve values"]
    end

    BD["Compute sharePercent\nper sleeve → breakdown[]"]

    subgraph P3["Strategy positions  30s cache"]
        REG["vault.strategy_registry()\n→ all addresses"]
        VALS["current_value()\nper registered strategy"]
    end

    RESP["Response\n{ totalAssets, totalSupply, pricePerShare,\npoolApyBps, breakdown, strategyPositions }"]

    REQ --> P1
    P1 --> APY
    APY --> CHK
    CHK -->|Yes| P2
    CHK -->|No| P3
    P2 --> BD
    BD --> P3
    P3 --> RESP
```

### Caching strategy

| Cache key | TTL | Content |
|-----------|-----|---------|
| `{net}:{asset}:breakdown` | 30s | Per-sleeve allocator breakdown |
| `{net}:{asset}` | 30s | Strategy position list |
| balance (per address) | 3s | stXLM/stUSDC/XLM/USDC balances |

### Address resolution + demo override

```typescript
// api/src/addresses.ts
TESTNET.allocatorXlm = ""  // empty on canonical vault

// api/.env.demo sets:
BAKU_TESTNET_VAULT_XLM=<demo vault address>
BAKU_TESTNET_ALLOCATOR_XLM=<allocator address>

// applyEnvOverrides() merges at runtime — canonical addresses unchanged
```

---

## 5. Component 3 — Browser extension (`xyra-wallet-sdk`)

### Role

The **only component that holds the user's private key**. All transaction signing
and auth-message signing happens inside the **background service worker**, which
is isolated from the popup and never exposes the raw key to any script. Both
backends are called from the popup, but only unsigned data crosses the popup↔worker
boundary.

### Runtime parts

```
popup/                  React 19 UI — all views, Redux state, API service calls
background.ts           Service worker — key custody + signing entry points
content.ts              Content script (<all_urls>) — inpage Freighter API
```

### Key signing paths (background worker only)

| Call | Signing primitive | Used for |
|------|-------------------|---------|
| `signSorobanXdr(xdr)` | Ed25519 · Soroban XDR | Vault deposit/redeem transactions |
| `signAuthMessage(msg)` | Ed25519 · SEP-53 `sha256("Stellar Signed Message:\n"+msg)` | SIWE challenge for agent backend |
| `signFreighterTransaction(xdr)` | Ed25519 · Classic XDR | Faucet co-sign, classic TXs |

### YieldHub tab — deposit and withdraw flows

```mermaid
sequenceDiagram
    actor User
    participant UI as YieldHub Tab
    participant BG as Background Worker
    participant API as Baku API :8787

    Note over UI: On mount / window focus / 60s ticker
    par loadAll
        UI->>API: GET /vault/xlm/state
        UI->>API: GET /vault/usdc/state
        UI->>API: GET /balance/:pubkey
    end
    API-->>UI: TVL · APY · pps · breakdown · balances
    Note over UI: Renders breakdown bar + balances

    rect rgb(230, 245, 255)
        Note over UI,API: Deposit
        User->>UI: Enter amount + click Deposit
        UI->>API: POST /vault/xlm/deposit/build-tx {user, amount}
        API-->>UI: { xdr }
        UI->>BG: signSorobanXdr(xdr)
        Note over BG: USER key · stays in worker
        BG-->>UI: signedXdr
        UI->>API: POST /tx/submit {signed_xdr}
        API-->>UI: { hash, status:SUCCESS, returnValue:shares }
        UI-->>User: bkuXLM balance updated
    end

    rect rgb(255, 245, 230)
        Note over UI,API: Withdraw
        User->>UI: Enter shares + click Withdraw
        UI->>API: POST /vault/xlm/withdraw/build-tx {user, shares, max_slippage_bps}
        API-->>UI: { xdr, preview:{ expected, minOut } }
        UI-->>User: Show preview ~9.87 XLM · min 9.77 XLM at 1%
        User->>UI: Confirm
        UI->>BG: signSorobanXdr(xdr)
        BG-->>UI: signedXdr
        UI->>API: POST /tx/submit {signed_xdr}
        API-->>UI: { hash, status:SUCCESS }
        UI-->>User: bkuXLM reduced · XLM restored
    end
```

### Auto-yield (useAutoYield.ts)

```mermaid
stateDiagram-v2
    [*] --> Off

    Off --> Idle : user enables toggle
    Idle --> Off : user disables toggle

    Idle --> Ready : 60s tick\nsurplus ≥ 1 XLM

    Ready --> Depositing : 60s tick · NOT in cooldown\nsurplus ≥ 1 XLM

    Depositing --> CoolingDown : deposit SUCCESS\nrecord lastFired in localStorage
    Depositing --> Failed : deposit error

    CoolingDown --> Idle : 5 min elapsed

    Failed --> Idle : next 60s tick\nsticky error badge shown

    Ready --> Idle : surplus drops below 1 XLM
```

### Direction-C tab — Tier-2 confirm flow

```mermaid
sequenceDiagram
    participant UI as Direction-C Tab
    participant API as Agent Backend :3000

    loop Every 15 seconds
        UI->>API: GET /v1/pending-tier2/:address
        API-->>UI: pending trade or null
    end

    Note over UI: Pending trade detected → show ConfirmTrade modal

    alt User confirms
        UI->>API: POST /v1/pending-tier2/:id/confirm { direction:"buy_xlm" }
        API-->>UI: { ok: true, txHash }
    else User rejects
        UI->>API: POST /v1/pending-tier2/:id/reject
        API-->>UI: { ok: true }
    end

    Note over UI,API: Same trade can also be confirmed via Telegram.\nRace guard C1 on server ensures only one executes.
```

---

## 6. Component 4 — Agent backend (`xyra-walllet`)

### Role

The **stateful, secret-holding middle tier**. It runs autonomous trading loops
for each user's agent, manages encrypted agent keys, provides a Telegram bot
interface, serves AI-narrated trade history, and gates premium data behind x402
micropayments. It never holds the user's key — only a per-user throwaway agent key
under envelope encryption.

### Architecture

```
src/index.ts              Express app · x402 middleware mount · startup init
src/config.ts             Fail-closed env validation (exit(1) on missing required vars)
src/routes/
  v1.ts                   All /v1/* endpoints
  alerts.ts               x402-paywalled price alert handler
  enriched.ts             Alert enrichment
  insight.ts              AI insight
src/middleware/
  require-auth.ts         JWT Bearer verification + ownership check
  x402.ts                 Legacy x402 middleware
src/services/
  bot.ts                  Telegram bot (Telegraf)
  worker-manager.ts       30s agent polling loop
  trade-routing.ts        Tier 1/2 routing logic
  stellar-service.ts      Stellar swap execution
  agent-secret-crypto.ts  AES-256-GCM envelope encryption
  x402-client.ts          x402 fetch client (agent pays for price data)
  auth.ts                 SIWE challenge/verify
  db.ts                   MongoDB models (Agent, AgentLog)
  redis.ts                Redis price cache
  narrate-log-ai.ts       Gemini trade narration
  explain-rules-ai.ts     Gemini rule explanation
  contract-summary-ai.ts  Gemini WASM analysis
  daily-spend.ts          UTC-day budget tracking
  pending-tier2.ts        In-memory Tier-2 queue
```

### x402 micropayment flow

```mermaid
sequenceDiagram
    participant W as WorkerManager
    participant R as Redis Cache
    participant X as x402 Middleware
    participant F as x402 Facilitator

    W->>R: check price cache (30s TTL)

    alt Cache hit
        R-->>W: { currentPrice }
        Note over W: No payment needed this tick
    else Cache miss
        W->>X: GET /api/v1/alerts/XLM  (no header)
        X-->>W: 402 Payment Required\n{ amount, asset, network, recipient }
        Note over W: Decrypt agent Ed25519 key\nBuild $0.001 USDC Stellar path-payment\nSign with agent key → PAYMENT-SIGNATURE header
        W->>X: GET /api/v1/alerts/XLM  + PAYMENT-SIGNATURE
        X->>F: HTTPFacilitatorClient.verify(payment)
        F-->>X: payment confirmed on-chain
        X-->>W: 200 { currentPrice, change24h }
        W->>R: cache price (30s TTL)
    end
```

### Worker loop — full decision tree

```mermaid
flowchart TD
    START(["30s tick fires"])
    LOAD["Reload agent from MongoDB"]
    ACTIVE{"agent.active\nAND trustlineReady?"}
    SKIP_I["Skip — agent inactive"]
    RESET["resetDailySpendIfNeeded()\nUTC midnight reset"]
    PRICE["fetchPrice() via x402-client\nRedis 30s cache"]
    SIGNAL{"getSignal(price,\nbuyBelow, sellAbove)"}
    SKIP_N["Skip — no signal"]
    COOL{"Same-zone\ncooldown active?"}
    SKIP_C["Skip — cooldown"]

    BUY["BUY signal\nplanned = min(buyAmount, tier2Max,\ndailyBudget, balance-reserve)"]
    SELL["SELL signal\nnotional = sellAmountXlm × price\nrouteSell()"]

    ROUTE{"planned vs\ntier1Max / tier2Max"}
    T1["TIER 1 AUTO\nexecuteSwap()\nAgentLog(success)\nTelegram notify ✅"]
    T2["TIER 2 CONFIRM\nsetPendingTier2()\nTelegram prompt\n[Confirm] [Reject]"]
    BLK["BLOCKED\n> tier2Max or budget exceeded"]

    DONE(["Wait 30s → repeat"])

    START --> LOAD --> ACTIVE
    ACTIVE -->|No| SKIP_I --> DONE
    ACTIVE -->|Yes| RESET --> PRICE --> SIGNAL
    SIGNAL -->|none| SKIP_N --> DONE
    SIGNAL -->|buy_xlm or sell_xlm| COOL
    COOL -->|Yes| SKIP_C --> DONE
    COOL -->|No| BUY
    COOL -->|No| SELL
    BUY --> ROUTE
    SELL --> ROUTE
    ROUTE -->|"≤ tier1Max"| T1 --> DONE
    ROUTE -->|"tier1Max < n ≤ tier2Max"| T2 --> DONE
    ROUTE -->|"> tier2Max"| BLK --> DONE
```

### Tier-2 dual-confirm race guard

```mermaid
flowchart TD
    SET["WorkerManager:\nsetPendingTier2Trade(agentId, trade)"]

    PA["Path A — Telegram\ncallback_query confirm_buy:id"]
    PB["Path B — Extension\nPOST /v1/pending-tier2/:id/confirm"]

    SET --> PA
    SET --> PB

    CLAIM["C1 claim-before-await\ntrade = getPendingTier2(agentId)\nclearPendingTier2(agentId)  ← synchronous"]
    PA --> CLAIM
    PB --> CLAIM

    EXISTS{"trade\nexists?"}
    EXEC["await executeSwap(direction)\n→ Stellar TX"]
    REJECT["404 / 409\nno double-execution"]

    LOG["AgentLog(success)\nclearTier2Direction()"]
    NOTIFY["Notify: Telegram + Extension\n✅ Executed  Tx: hash"]

    CLAIM --> EXISTS
    EXISTS -->|"No — second caller"| REJECT
    EXISTS -->|"Yes — first caller"| EXEC --> LOG --> NOTIFY
```

### Agent key lifecycle

```mermaid
flowchart TD
    subgraph CREATE["Creation — Telegram /createagent"]
        GEN["Keypair.random()\n→ publicKey + secretKey"]
        DEK_GEN["DEK = randomBytes(32)"]
        ENC["AES-256-GCM(DEK, secretKey)\n→ ciphertext + iv"]
        WRAP["AES-256-GCM(KEK, DEK)\n→ wrapped + dekIv"]
        STORE["MongoDB:\nagentSecretCiphertext · agentSecretIv\nagentSecretDekWrapped · agentSecretDekIv"]
        DISC["secretKey discarded from memory"]
        GEN --> DEK_GEN --> ENC --> WRAP --> STORE --> DISC
    end

    subgraph DECRYPT["Decryption — at swap time only"]
        UNWRAP["AES-256-GCM-decrypt(KEK, wrappedDEK)\n→ plaintext DEK"]
        PLAIN["AES-256-GCM-decrypt(DEK, ciphertext)\n→ plaintext secretKey"]
        SIGN_TX["sign Stellar TX"]
        DISC2["discard plaintext immediately"]
        UNWRAP --> PLAIN --> SIGN_TX --> DISC2
    end

    subgraph REVOKE["Revocation — POST /v1/revoke/:address"]
        STOP["Stop WorkerManager"]
        DRAIN["Decrypt key\ndrain XLM + USDC to targetWallet"]
        DISABLE["agent.active = false\nworker never restarts"]
        STOP --> DRAIN --> DISABLE
    end

    STORE -->|"swap triggered"| UNWRAP
    STORE -->|"revoke requested"| STOP
```

### Telegram bot commands

| Command / callback | Action |
|--------------------|--------|
| `/createagent <target>` | Generate agent keypair, encrypt, store in Mongo |
| `/createtrustline` | Setup USDC trustline on Stellar, start worker |
| `/setrules` | Multi-step conversation: buyBelow · sellAbove · tier1Max · tier2Max · dailyBudget · sellAmountXlm · buyAmountUsdc |
| `/status` | Balances + rules + worker state |
| `/agentlog` | Last 5 trade entries |
| `/revokeagent` | Drain + disable |
| `confirm_buy:id` | Execute queued Tier-2 buy (claim-before-await) |
| `confirm_sell:id` | Execute queued Tier-2 sell |
| `reject_trade:id` | Discard pending trade |

---

## 7. End-to-end data flows

### 7.1 Deposit — XLM into vault

```mermaid
sequenceDiagram
    actor User
    participant Ext as Extension (bg worker)
    participant API as Baku API :8787
    participant Vault as BakuVault CCY337…
    participant Strat as BlendStrategy
    participant Pool as Blend V2 Pool

    User->>Ext: click Deposit (10 XLM)
    Ext->>API: POST /vault/xlm/deposit/build-tx {user, amount:"100000000"}
    API->>Vault: simulateTransaction (assemble fees)
    Vault-->>API: fee data
    API-->>Ext: { xdr } unsigned TX
    Note over Ext: bg-worker.signSorobanXdr(xdr)\nUSER key · stays in worker
    Ext->>API: POST /tx/submit { signed_xdr }
    API->>Vault: RPC.sendTransaction(signedXdr)
    Note over Vault: require_auth(user) ✓
    Note over Vault: shares = assets×(supply+1M) ÷ (assets+1)
    Vault->>Strat: SAC.transfer(user → strategy, assets)
    Strat->>Strat: deposit(vault, assets)
    Strat->>Pool: Blend.supply(assets)
    Pool-->>Strat: confirmed
    Note over Vault: Base::update → mint bkuXLM to user
    API->>API: poll getTransaction ≤30s
    API-->>Ext: { hash, status:SUCCESS, returnValue:shares }
    Ext-->>User: bkuXLM +shares · XLM -10
```

### 7.2 Withdraw — redeem bkuXLM shares

```mermaid
sequenceDiagram
    actor User
    participant Ext as Extension (bg worker)
    participant API as Baku API :8787
    participant Vault as BakuVault CCY337…
    participant Strat as BlendStrategy
    participant Pool as Blend V2 Pool

    User->>Ext: click Withdraw (enter shares)
    Ext->>API: POST /vault/xlm/withdraw/build-tx {user, shares, max_slippage_bps:100}
    API->>Vault: simulateRead preview_redeem(shares) → expected
    Note over API: minOut = expected × 9900 ÷ 10000
    API-->>Ext: { xdr, preview:{ expected, minOut } }
    Ext-->>User: ~9.87 XLM · min 9.77 XLM at 1%
    User->>Ext: Confirm
    Note over Ext: bg-worker.signSorobanXdr(xdr)\nUSER key · stays in worker
    Ext->>API: POST /tx/submit { signed_xdr }
    API->>Vault: RPC.sendTransaction(signedXdr)
    Note over Vault: require_auth(owner) ✓
    Note over Vault: estimated = shares×(assets+1) ÷ (supply+1M)
    Note over Vault: guard: estimated ≥ minOut ✓
    Vault->>Strat: strategy.withdraw(vault, estimated)
    Strat->>Pool: Blend.withdraw(estimated)
    Pool-->>Strat: actual XLM
    Strat-->>Vault: actual
    Note over Vault: guard: actual ≥ minOut ✓
    Note over Vault: Base::update → burn shares from owner
    Vault->>Vault: SAC.transfer(vault → owner, actual)
    API-->>Ext: { hash, status:SUCCESS }
    Ext-->>User: bkuXLM reduced · XLM +actual
```

### 7.3 Agent trade — Tier-1 auto-execute

```mermaid
sequenceDiagram
    participant W as WorkerManager
    participant X as x402 Middleware
    participant F as x402 Facilitator
    participant R as Redis
    participant S as Stellar RPC
    participant TG as Telegram

    Note over W: 30s tick fires
    W->>R: check price cache
    R-->>W: cache miss
    W->>X: GET /api/v1/alerts/XLM
    X-->>W: 402 Payment Required
    Note over W: decrypt agent key\nsign $0.001 USDC payment
    W->>X: GET /api/v1/alerts/XLM + PAYMENT-SIGNATURE
    X->>F: verify payment
    F-->>X: confirmed on-chain
    X-->>W: { currentPrice: 0.089 }
    W->>R: cache price 30s

    Note over W: getSignal: 0.089 < buyBelowUsd(0.10) → buy_xlm
    Note over W: routeBuy: planned=5 USDC ≤ tier1Max(10) → TIER 1 AUTO
    Note over W: decrypt agent secret  KEK → DEK → secretKey

    W->>S: build + sign + submit pathPayment XLM←USDC
    S-->>W: { hash, xlmReceived:56.2 }
    Note over W: AgentLog(status:success, usdcSpent:5)\nrecordSuccessfulBuy(5 USDC)
    W->>TG: ✅ Bought 56.2 XLM at $0.089  Tx:abc…
```

### 7.4 Agent trade — Tier-2 human-confirm (dual path)

```mermaid
sequenceDiagram
    participant W as WorkerManager
    participant TG as Telegram Bot
    participant TGA as Telegram API
    participant TGUser as User (Telegram)
    participant Ext as Extension
    participant S as Stellar RPC

    Note over W: planned=25 USDC > tier1Max(10) → TIER 2
    W->>W: setPendingTier2(agentId, {direction:buy_xlm, buyUsdc:25})
    W->>TG: sendMessage "XLM at $0.089 — buy 25 USDC?"
    TG->>TGA: inline keyboard [Confirm Buy] [Reject]
    TGA->>TGUser: push notification

    par Path A — Telegram
        TGUser->>TGA: tap [Confirm Buy]
        TGA->>TG: callback_query confirm_buy:id
    and Path B — Extension polling
        Ext->>W: GET /v1/pending-tier2/:address
        W-->>Ext: { pending: { id, direction, plannedUsdc } }
        Ext-->>TGUser: ConfirmTrade modal
        TGUser->>Ext: click Confirm
        Ext->>W: POST /v1/pending-tier2/:id/confirm
    end

    Note over TG,W: C1 claim-before-await:\ntrade = getPending(agentId)\nclearPending(agentId) ← synchronous\nFirst caller wins · second gets 404

    W->>S: executeSwap(buy_xlm, 25 USDC)
    S-->>W: { hash, xlmReceived }
    W->>W: AgentLog(success) · clearTier2Direction()
    W->>TGA: ✅ Executed  Tx: hash
    TGA->>TGUser: push notification
    W-->>Ext: { ok: true, txHash }
```

---

## 8. Security boundaries

```mermaid
flowchart TB
    subgraph EXT_B["EXTENSION — xyra-wallet-sdk  background worker"]
        direction TB
        KEY["User Ed25519 keypair\ndecrypted in-memory after password unlock"]
        SIGN_O["signSorobanXdr — vault TXs\nsignAuthMessage — SIWE SEP-53"]
        ISO["Key NEVER sent to any backend\nCannot be extracted by popup or content script"]
    end

    subgraph BAKU_B["BAKU API — api/  key-less"]
        direction TB
        READS["Reads chain state via simulate\nBuilds UNSIGNED TX only"]
        NO_K["No private keys · No auth secrets\nSafe to expose publicly"]
        CANT["Compromise → zero fund movement\nCannot generate valid signed TX"]
    end

    subgraph AGENT_B["AGENT BACKEND — xyra-walllet"]
        direction TB
        AKEY["Per-user THROWAWAY agent key\nAES-256-GCM two-layer envelope\nKEK wraps per-agent DEK"]
        TRANS["Plaintext exists only during executeSwap()\nImmediately discarded after signing"]
        FENCE["On-chain power FENCED by Smart Account\nOnly: VAULT_XLM.deposit\n+ nested XLM_SAC.transfer"]
        GRD["Fail-closed: exit(1) on missing KEK or JWT\n403 if JWT pubkey ≠ targetWallet\nTier limits + hard daily USDC cap"]
    end

    subgraph CHAIN_B["ON-CHAIN — Soroban contracts"]
        direction TB
        AUTH_R["require_auth(depositor/owner)\nUser must sign every TX"]
        SLIP["On-chain slippage floor\nredeem reverts if actual < min_out"]
        SCOPE["Scope validated BEFORE signature\n3002 UnvalidatedContext fires first\n3003 ExternalVerificationFailed after"]
        BIND["auth_digest binds rule_ids into signature\nDowngrade-resistant\nrule-set cannot be swapped"]
    end

    EXT_B -->|"only unsigned XDR to Baku\nonly SIWE sig to agent backend"| BAKU_B
    EXT_B -->|"only SIWE sig\nproves wallet ownership"| AGENT_B
    AGENT_B -->|"agent key scoped by\nSmart Account rules"| CHAIN_B
    BAKU_B -->|"simulate reads +\nsubmit user-signed XDR"| CHAIN_B
```

---

## 9. External services

| Service | Used by | Purpose |
|---------|---------|---------|
| `soroban-testnet.stellar.org` | Baku API + agent backend | Soroban RPC (simulate + send + poll) |
| Telegram Bot API | agent backend · `bot.ts` | Long-poll for commands + callback confirms |
| X402 Facilitator | agent backend · `x402-client.ts` | Verify USDC micropayments for paywalled data |
| Sorobanhooks Indexer | agent backend · `sorobanhooks.ts` | Upstream token price / alert data |
| Gemini API | agent backend · `narrate-log-ai.ts` etc. | Trade narration, rule explanation, WASM analysis |
| MongoDB | agent backend | Agent config, AgentLog, contract summary cache |
| Redis | agent backend | XLM price cache (30s TTL) |
| Blend V2 Pool `CCEBVDYM…` | BlendStrategy | supply / withdraw / balance — earns BLND rewards |
| Soroswap V2 Router `CCJUD55A…` | SoroswapStrategy + agent swaps | add/remove liquidity · XLM↔USDC swaps |

---

## 10. Demo vs canonical configuration

| | Canonical (default) | Demo (`.env.demo`) |
|-|---------------------|--------------------|
| Vault | `CCY337D4WZ6…` (BlendStrategy active) | Separate demo vault (allocator active) |
| Active strategy | BlendStrategy `CAGIMEB3…` | Allocator (30/40/30) |
| Breakdown bar | `null` (single strategy) | `[{Blend,30%},{Soroswap,40%},{Native,30%}]` |
| Instant withdraw | Always | Only ≤ native buffer |
| Large withdraw | Immediate | Queued multi-tx |
| APY display | Blend lending rate | Blended 3.5% (admin-set) |

**Switch to demo:**
```bash
cp api/.env.demo api/.env && docker compose up -d
```
**Revert to canonical:**
```bash
rm api/.env && docker compose up -d
```

---

## 11. Testnet address book

Network: `Test SDF Network ; September 2015` · RPC `https://soroban-testnet.stellar.org`

**Mainnet: nothing deployed — all placeholders, gated on audit + SCF funding.**

| Contract | Address |
|----------|---------|
| vault-xlm v2 (canonical) | `CCY337D4WZ6OECCTQMWIMWT2CHBC73YY5JFRKBJ665O654KMUG3CP7YH` |
| vault-xlm v1 (legacy, redeem-only) | `CCDEEXUU25RUOZVSYCSJPX35QKPZTDBAT6UFW6GTC633LV3TLOXMDOLD` |
| vault-usdc | `CDEOKPUFZT7XL5XITZWUTVD2VBU2NDEVA5EL7XXLMKP6INML4EHIEXNL` |
| BlendStrategy-XLM (active) | `CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ` |
| BlendStrategy-USDC (active) | `CDVPZOJTAP5X2XLRYWSLFCRKE5KNV4ZMPWB6NPSGWWT3YKSTQTM5YFSG` |
| SoroswapStrategy-XLM (registered) | `CA4SKYV4O34KJA7TEA36GRDZJK3OZ2FN6QON4QDRA27V7RMPLJTGQHOS` |
| DeFindex-USDC (registered) | `CDXUHZ2FHLEV6G5YRUYNWKXMNGJUSHELYLQ2LOZRCGTJ6ZFMC2Z2YEAY` |
| Smart Account (hardened) | `CCZ7LWLZ67GSVYZNICUCIZJBQG4KDE4KVPX7C6E2M2WCOPJUQ5HTJXE4` |
| Ed25519 verifier (hardened) | `CBXBHFARMU5GOMDZV3XWPEZJY2NDUEHO6L6DAZNCDQCKZNAL26KPBP4V` |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Circle USDC SAC (Soroswap pairs) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Blend USDC SAC (Blend pool) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Blend V2 pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Soroswap V2 router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| Soroswap XLM/Circle-USDC pair | `CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS` |
| Admin / deployer (G-account) | `GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV` |
