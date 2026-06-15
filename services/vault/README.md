# Baku — Liquid-yield vaults on Stellar Soroban

Liquid yield aggregation protocol on Stellar. Deposit XLM or USDC, receive a yield-bearing receipt token (the vault contract IS the share token), and watch your balance auto-grow as the underlying assets earn yield from one of the registered strategies (Blend lending or Soroswap LP). One signed transaction per deposit; the vault and strategies run autonomously after.

Stellar has no native staking primitive, so this is **liquid yield aggregation**, not "liquid staking." stXLM and stUSDC are yield-bearing receipt tokens.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Wallet (xyra-wallet-sdk, separate repo)                            │
│  - Signs Soroban XDR                                                │
└──────────────┬──────────────────────────────────────────────────────┘
               │ build-tx / submit
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Baku API (Bun + Hono, this repo)                                   │
│  - POST /vault/:asset/deposit/build-tx                              │
│  - POST /vault/:asset/withdraw/build-tx (max_slippage_bps)          │
│  - POST /tx/submit                                                  │
│  - GET  /vault/:asset/state                                         │
│  - GET  /balance/:address (parallelized + 3s TTL cache)             │
└──────────────┬──────────────────────────────────────────────────────┘
               │ Soroban RPC
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Soroban Contracts (this repo, crates/)                             │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐     │
│  │ vault-xlm           │    │ vault-usdc                      │     │
│  │ (OZ Vault + SEP-41) │    │ (OZ Vault + SEP-41)             │     │
│  │ active_strategy ────┼──┐ │ active_strategy ─────────────┐  │     │
│  │ registry: [Blend]   │  │ │ registry: [Blend, Soroswap]  │  │     │
│  └─────────────────────┘  │ └─────────────────────────────────┘     │
│                           │                                  │      │
│                           ▼                                  ▼      │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐     │
│  │ BlendStrategy       │    │ SoroswapStrategy (USDC vault)   │     │
│  │ (XLM and USDC)      │    │ LPs into XLM/USDC pool          │     │
│  │ blend-contract-sdk  │    │ swap-half + add-liquidity       │     │
│  └─────────────────────┘    └─────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

## Repo layout

```
baku/
├── Cargo.toml                  # Workspace
├── crates/
│   ├── addresses/              # Single source of truth for contract addresses
│   ├── strategy-trait/         # Strategy trait + #[contractclient] + StrategyError
│   ├── mock-strategy/          # MockStrategy for vault unit tests
│   ├── vault/                  # OZ Vault composition + custom storage + VaultError
│   ├── blend-strategy/         # BlendStrategy via blend-contract-sdk
│   └── soroswap-strategy/      # SoroswapStrategy (LP-based)
├── api/                        # Bun + Hono HTTP API
└── scripts/                    # deploy-testnet.sh, reset-testnet.sh
```

## Dependencies (pinned)

| Crate | Version | Why |
|-------|---------|-----|
| `soroban-sdk` | `25.3.1` | Latest 25.x; both stellar-tokens and blend-contract-sdk require `^25.x`. Bump to 26.x when both ship Protocol 26 SDKs. |
| `stellar-tokens` | `0.7.1` | OZ Soroban Vault extension (vault IS the share token, SEP-56 standard) |
| `stellar-macros` | `0.7.1` | OZ macros |
| `blend-contract-sdk` | `2.25.0` | Typed Blend pool client via `contractimport!` |

## Build

```bash
cargo build --release --target wasm32-unknown-unknown
```

## Test

```bash
cargo test
```

## Deploy to testnet

Two scripts. Stellar CLI 25.2.0+ required (`stellar` not `soroban`).

1. `scripts/deploy-testnet.sh` — fresh full deploy. XLM track always (vault + MockStrategy); USDC track (vault + live BlendStrategy) gated behind `DEPLOY_USDC=1`. Writes `scripts/deployed.testnet.env`.
2. `scripts/wire-blend-xlm.sh` — additive: deploys live `BlendStrategy(XLM)` and switches `vault-xlm`'s active strategy from Mock to Blend. Run after step 1 once the testnet Blend SDK is validated. Preserves all existing vault addresses (does NOT redeploy vaults).

**Feature flags.** Testnet and mainnet build the same artifacts — no `--features demo` flag exists in this workspace. The `inject_yield` admin entrypoint lives on `crates/mock-strategy` only (always-on, used by the XLM vault for the 48h demo). `crates/blend-strategy` deliberately omits `inject_yield`: a real Blend supply position can't be inflated off-pool, and the honest "visible yield" path on Blend is time-pass plus real borrower interest. Any mainnet path swaps the active strategy from mock to `blend-strategy` (or another non-mock adapter) — same WASM, no feature-gated artifact.

## Design

Full design doc at `~/.gstack/projects/baku/darqlabs-shah-aman-backend-api-wallet-integration-design-*.md` (produced by `/office-hours` + `/plan-eng-review`).
