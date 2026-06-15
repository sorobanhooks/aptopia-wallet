# Aptopia

Aptopia is a **non-custodial smart wallet on the Stellar testnet**, built as a
fork of [Freighter](https://www.freighter.app/) and extended into a full DeFi
ecosystem: one-click yield vaults (`bkuXLM` / `bkuUSDC` receipt tokens), an
autonomous price-triggered trading agent with two-tier human confirmation, x402
pay-per-call data, an AI copilot, and an OpenZeppelin Smart Account that
cryptographically fences the agent's on-chain power.

The repo root is the Freighter-fork **browser-extension wallet**; the extra
backend services that power the extended ecosystem live under
[`services/`](services/).

> Mainnet is gated on audit + funding — **this codebase targets Stellar testnet only.**

---

## Repository layout

| Folder | What it is | Stack / port |
|--------|------------|--------------|
| **(repo root)** | The Freighter-fork wallet — a yarn-workspaces monorepo | React 19, Manifest V3 |
| [`extension/`](extension/) | The wallet workspace; buildable package at [`extension/extension/`](extension/extension/) | webpack build → `extension/extension/build` |
| [`@stellar/freighter-api/`](@stellar/freighter-api/) | Client-facing SDK published as `@stellar/freighter-api` | TypeScript npm module |
| [`@shared/`](@shared/) | Shared `api` / `constants` / `helpers` used across workspaces | TypeScript |
| [`docs/`](docs/) | The wallet docs site | Docusaurus on `:3000` |
| [`services/vault/`](services/vault/) | Soroban smart contracts **+** the Vault API | Rust contracts + Bun/Hono API on `:8787` |
| [`services/agent/`](services/agent/) | Autonomous trading-agent backend | Express + MongoDB + Redis on `:3000` |
| [`services/docs/`](services/docs/) | Cross-cutting workspace specs & plans | — |

### Repo root — the wallet (Freighter fork)

A fork of Freighter (Manifest V3, React 19) structured as yarn workspaces. The
buildable extension package lives at
[`extension/extension/`](extension/extension/), with source under
[`extension/extension/src/`](extension/extension/src/) (`background/` worker,
`popup/` UI, `contentScript/`, `api/`). The **user's key never leaves the
extension's background worker.**

### `services/vault/` — contracts + Vault API

The on-chain layer and the stateless API that fronts it.

- **`services/vault/crates/`** — the Soroban (Rust) contracts:
  - `vault` — the core deposit/redeem vault that mints receipt tokens
  - `allocator-strategy` — weighted meta-allocator splitting funds across strategies
  - `blend-strategy`, `defindex-strategy`, `soroswap-strategy`, `mock-strategy` — individual yield strategy adapters
  - `strategy-trait` — the shared strategy interface
  - `sa-account`, `sa-tracer` — the OpenZeppelin Smart Account and its tracer
  - `addresses` — the canonical Rust copy of deployed contract IDs
- **`services/vault/api/`** — the **Vault API** (Bun + Hono, port `:8787`).
  Stateless and **key-less**: it only reads chain state, builds transactions,
  and relays signed ones. Source in
  [`services/vault/api/src/`](services/vault/api/src/) (`routes/`, `rpc.ts`,
  `auth-digest.ts`, `cache.ts`, `addresses.ts`).
- **`services/vault/scripts/`** — deploy / wiring shell scripts and the
  `deployed.testnet.env` record of live contract IDs.
- **`services/vault/docs/`** — architecture docs (see below).
- **`services/vault/API.md`** — Vault API endpoint reference.

### `services/agent/` — trading-agent backend

Express server (port `:3000`, MongoDB + Redis) that runs the autonomous,
price-triggered trading agent with two-tier human confirmation, the AI copilot,
x402 pay-per-call data, and the Telegram bot surface. Source in
[`services/agent/src/`](services/agent/src/):

- `routes/` — HTTP API (`v1.ts`, `alerts.ts`, `enriched.ts`, `insight.ts`, `strategy-validation.ts`)
- `services/` — the engine internals: `strategy-engine.ts`, `trade-routing.ts`,
  `worker-manager.ts`, `pending-tier2.ts` (Tier-2 confirmations),
  `agent-secret-crypto.ts` (envelope-encrypted agent key), `bot.ts` /
  `telegram-menu.ts` (Telegram), `x402-client.ts`, and the `*-ai.ts` Gemini-backed
  insight/copilot helpers.

### Architecture docs

Start here before doing architecture work:

1. [`services/vault/docs/SYSTEM_ARCHITECTURE_DETAILED.md`](services/vault/docs/SYSTEM_ARCHITECTURE_DETAILED.md) — full Mermaid diagrams of every flow
2. [`services/vault/docs/ARCHITECTURE_OVERVIEW.md`](services/vault/docs/ARCHITECTURE_OVERVIEW.md) — high-level shape and trust boundaries
3. [`services/vault/docs/SCF_TECHNICAL_INTEGRATION.md`](services/vault/docs/SCF_TECHNICAL_INTEGRATION.md) — API contracts, SIWE/SEP-53 auth, Smart Account security proof
4. [`services/vault/API.md`](services/vault/API.md) — Vault API reference

---

## Running everything

### Prerequisites

- Docker Desktop running
- A MongoDB container publishing `27017` (`docker start aptopia-mongo`)
- Redis reachable on `6379`
- For the extension: Node ≥ 22 + Yarn

### Both backends (Vault API + agent backend)

The compose file lives in [`services/`](services/) and uses Compose `include:`
so each service's own compose file stays authoritative. Run it from `services/`:

```bash
cd services
docker compose up -d          # Vault API :8787 + agent backend :3000
docker compose up -d --build  # force rebuild after dependency changes
docker compose logs -f        # watch
docker compose down           # stop
```

### Browser extension

Build from the `extension/` workspace and load the output as an unpacked
extension in Chrome:

```bash
cd extension && yarn && yarn build
# Load extension/extension/build as an unpacked extension in Chrome.
```

### Demo & Download

### 🎥 Demo Video
Watch Aptopia in action:

https://youtu.be/eSo_nP8tlH8

### 📦 Download Wallet
Download the latest Aptopia wallet build:

https://drive.google.com/file/d/174leIg3TWIxe4n-kPBn9hKN7DDnDTijD/view?usp=sharing

### Contracts (Rust / Soroban)

```bash
cd services/vault
cargo test                                    # unit tests
cargo build --release --target wasm32v1-none  # wasm build
```

### API tests & Smart-Account parity gate

```bash
cd services/vault/api
bun run test                  # API tests (uses --isolate)
bun run tracer:digest-parity  # Smart Account digest parity gate (Rust ≡ TS)
```

### Agent backend (standalone)

```bash
cd services/agent
npm install
npm run dev        # nodemon + ts-node
npm test           # node:test + jest suites
```

---

## Demo vs canonical vault

The Vault API can point at either the demo vault (a 30/40/30 meta-allocator) or
the canonical Blend vault:

```bash
# demo (allocator 30/40/30)
cp services/vault/api/.env.demo services/vault/api/.env && (cd services && docker compose up -d)

# canonical (Blend, default)
rm services/vault/api/.env && (cd services && docker compose up -d)
```

---

## Secrets (gitignored — never commit)

| File | Holds |
|------|-------|
| `services/vault/scripts/.sa-tracer.env` | Throwaway agent Ed25519 secret for the SA tracer |
| `services/agent/.env` | KEK, JWT secret, Gemini key, Telegram token, facilitator + Mongo/Redis config (see [`services/agent/.env.example`](services/agent/.env.example)) |
| `extension/extension/.env` | `BAKU_API_URL` (the Vault API base URL), `BACKEND_URL`, `STELLAR_NETWORK` (build-time) |

---

## Conventions

- **On-chain amounts** are always `i128` decimal strings with 7 decimals — never a JS `number`.
- **Address promotion is manual + reviewable**: after a redeploy, copy IDs from
  `services/vault/scripts/deployed.testnet.env` into **both**
  `services/vault/crates/addresses/src/lib.rs` and
  `services/vault/api/src/addresses.ts` in one commit.
- The Vault API stays **key-less** (read + build-tx + relay only).
- The user's key never leaves the extension background worker; the agent key
  never leaves `services/agent/` (envelope-encrypted in Mongo).
- Vault `redeem` slippage floor is enforced **on-chain** — don't move it client-side.
- `soroban-sdk` is pinned to **25.3.1** and the OZ `stellar-*` crates to **0.7.1** —
  do not bump (Protocol 26 breaks both).

---

## Subprojects

Everything lives in this single repo as ordinary subfolders — there are no
separate branches or external upstreams to track. Each subproject is editable in
place:

| Subproject | Folder |
|------------|--------|
| Soroban contracts + Vault API | [`services/vault/`](services/vault/) |
| Trading-agent backend | [`services/agent/`](services/agent/) |
| Browser-extension wallet | [`extension/`](extension/) (buildable package: [`extension/extension/`](extension/extension/)) |
| Client SDK | [`@stellar/freighter-api/`](@stellar/freighter-api/) |
| Shared libraries | [`@shared/`](@shared/) |
| Cross-cutting specs & plans | [`services/docs/`](services/docs/) |
these 2 steps:

```
yarn install
yarn setup
```

followed by

```
yarn build:extension:production
```

This will generate the files that make up the extension in `extension/build`

## Configure environment variables

Before starting the dev server, you need to configure the backend URLs. Create a
file `extension/.env` with the following variables:

```
INDEXER_URL=https://freighter-backend-prd.stellar.org/api/v1
INDEXER_V2_URL=https://freighter-backend-v2-prd.stellar.org/api/v1
```

These URLs point to the production Freighter backend. For more details on
backend configuration, see
[extension/README.md](extension/README.md#configure-the-backend).

## Starting a dev environment

```
yarn setup
yarn start
```

This will start up multiple watching builds in parallel:

- The `@stellar/freighter-api` npm module
- The docs, serving on `localhost:3000`
- A dev server with the webapp running in the extension, serving on
  `localhost:9000`
- The actual built extension, able to be installed in Chrome or Firefox, in
  `build/`

Each of these will build in response to editing their source.

These can be started individually with `yarn start:\<workspace name\>` where
`\<workspace name\>` is one of:

- `freighter-api`
- `docs`
- `extension`

```
yarn build
```

This will produce final output for the docs, the `@stellar/freighter` npm
module, and the extension.

`yarn build:\<workspace name\>`, like the equivalent start commands, will build
an individual workspace.

### Testing for Safari

First you should allow unsigned extension in your safari session. This resets
every time Safari shuts down.
https://developer.apple.com/documentation/safariservices/safari_web_extensions/running_your_safari_web_extension#3744467

Next, run the Safari Extension Converter locally to convert Freighter to an
xcode project. Example from the project root -
`xcrun safari-web-extension-converter freighter/extension/build --project-location freighter-safari`

That should launch your project in xcode. You should run the project, with a
target of macos. If you have not allowed unsigned extensions, you will see a
related warning but otherwise you should see Freighter launched on your Safari
instance.

### Useful URLs:

[Configure the backend](https://github.com/stellar/freighter/blob/master/extension/README.md#configure-the-backend)

[Build the extension and install it on your machine](https://github.com/stellar/freighter/blob/master/extension/README.md#build-the-extension-and-install-it-on-your-machine)

[The popup webapp](http://localhost:9000/#/)

[The `setAllowed` playground](http://localhost:3000/docs/playground/setAllowed)

[The `requestAccess` playground](http://localhost:3000/docs/playground/requestAccess)

[The `getAddress` playground](http://localhost:3000/docs/playground/getAddress)

[The `signTransaction` playground](http://localhost:3000/docs/playground/signTransaction)

[The `addToken` playground](http://localhost:3000/docs/playground/addToken)

It's important to note that these last functions won't interact with the _dev
server_ popup UI on `localhost:9000` — you'll need to re-install the unpacked
extension each time you make a change.

### Importing a workspace

In some cases, you will want to import a workspace into another. For example, in
`extension` we need to import `@shared/constants`. To do this, simply add
`@shared/constants` to the dependencies list in package.json in `extension`.
Yarn symlinks all the workspaces, so doing so will allow you to import files
from the `@shared/constants` workspace as if it were a published npm package.

### Dependencies

Many dev dependencies (such as Typescript, linters, Webpack, etc.) have been
moved to the root `package.json` to allow devs to upgrade these libraries all in
one place.

### Pushing to repo

This repo will run a pre-push hook before pushing. This hook will run the cmd
`yarn build:extension:translations` to check if any strings in the extension
need to be added to the translations JSON. If there is no need to update the
translations JSON, the push will go through. If there is a need to update, the
changes will be automatically committed to your branch and the push will be
aborted. You will need to run `git push` again.

NOTE: If you're using nvm and run into an error where the git hook is using an
incompatible version of node, create a file `~/.huskryc` on your system and
added the following:

```
# This loads nvm.sh, sets the correct PATH before running hook, and ensures the project version of Node
export NVM_DIR="$HOME/.nvm"

[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# If you have an .nvmrc file, we use the relevant node version
if [[ -f ".nvmrc" ]]; then
  nvm use
fi
```

This will instruct the git hook to use the .nvmrc found in this repo.
