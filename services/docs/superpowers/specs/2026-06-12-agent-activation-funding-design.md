# Agent activation & funding in the Agents tab — design

- **Date:** 2026-06-12
- **Status:** Approved (pending spec review)
- **Scope:** Extension Agents tab (`Dashboard`) + one non-breaking field addition to `GET /v1/metrics`
- **Decision:** Option A — funding handled **in-extension**; trustline stays in Telegram; rules use the existing settings screen.

## Problem

After a user creates an agent via Telegram, the extension's **Agents** tab shows
"Connect Your AI Agent" as if no agent exists, and there is no in-app way to
**fund/activate** the agent. Two concrete failures observed:

1. **Detection.** The agent record exists (Mongo:
   `agentAddress=GDDTKU5X…`, `targetWallet=GBTKZLQQ…`, `usdcTrustlineReady:false`),
   but the tab still shows the "Connect Your AI Agent" empty state.
2. **Funding.** Sending XLM to the brand-new agent address via the main wallet
   **Send** button fails with `op_no_destination` ("Destination account doesn't
   exist"), because the first transfer to a never-created Stellar account must be
   a `createAccount` op, not a `payment`.

### Root causes

- **Detection:** `Dashboard` calls `agentBackendService.getMetrics(activeWallet)`
  and collapses **every** failure (404, network error, auth error, stale build
  with empty `BACKEND_URL`) into the single `UNCONNECTED` → "Connect Your AI
  Agent" state. So a transient/auth/build problem is indistinguishable from
  "this wallet has no agent." (`getMetrics` itself returns `200` with zero
  balances for an unfunded-but-existing agent — `getBalance` catches the missing
  account and returns zeros — so an existing agent should *not* normally produce
  the empty state.)
- **Funding:** the main Send flow already builds `Operation.createAccount` when
  it thinks the destination is unfunded (`useSimulateTxData.tsx:188`), but its
  `isFunded` check misfired for the new agent address and it sent a `payment` →
  `op_no_destination`. We will **not** alter the Send button; we add a dedicated
  agent-funding element that builds `createAccount` explicitly.

## Goals

- The Agents tab correctly recognises an existing agent and shows an
  **Activation card** when it is not yet funded / has no USDC trustline.
- A dedicated **"Fund agent"** element in the Agents tab transfers XLM to the
  agent address using a `createAccount` op (works for a brand-new account),
  signed in the extension — **without touching the main Send button**.
- Distinguish "no agent for this wallet" (404) from "couldn't reach the agent
  service" (network/auth) so the empty state is no longer misleading.

## Non-goals (YAGNI)

- No trustline-from-extension (the trustline is signed by the **agent's** key,
  server-side; stays in Telegram `/createtrustline`).
- No new backend endpoint; no server-side tx building (Baku stays key-less; the
  user key stays in the extension).
- No changes to the main Send button or a fix for its `isFunded` mis-detection
  (tracked separately).
- No auto-funding, no multi-asset funding.

## Design

### 1. Detection states (`Dashboard/index.tsx`)

Replace the binary `LOADING | UNCONNECTED | CONNECTED` with explicit states the
fetch can resolve to:

| State | Trigger | UI |
|---|---|---|
| `LOADING` | request in flight | loader (existing) |
| `NO_AGENT` | `getMetrics` → **404** | "Connect Your AI Agent" (existing) + Open Telegram |
| `SERVICE_ERROR` | network/auth/other non-404 failure | "Couldn't reach the agent service" + **Retry** |
| `NEEDS_ACTIVATION` | agent found AND (`!funded` OR `!usdcTrustlineReady`) | **Activation card** (new) |
| `ACTIVE` | agent found AND `funded` AND `usdcTrustlineReady` | Dashboard (existing) |

`agentBackendService.getMetrics` must surface the HTTP status (or throw a typed
error carrying `status`) so the view can tell 404 from other errors.

### 2. Activation card (new component)

Rendered for `NEEDS_ACTIVATION`. A 3-step checklist; each step shows
done/pending and only the first incomplete step is "active":

1. **Fund agent** — agent address (copyable) + amount input (**default 3 XLM**,
   helper text: "≥ ~1 XLM stays locked as the account reserve") + **"Fund
   agent"** button. Marked done when `funded`.
2. **Add USDC trustline** — done when `usdcTrustlineReady`; otherwise a button
   that opens Telegram to the bot (`TELEGRAM_BOT`) with instruction text to run
   `/createtrustline` (the trustline is signed by the agent key, server-side, so
   it cannot run in the extension). No `?start` param — that drives
   `/createagent`, not the trustline.
3. **Set rules** — links to the existing AgentConfig ("Manage Agent Settings").

A "Refresh" affordance re-fetches metrics; the existing window-focus refetch
(returning from Telegram) is retained.

### 3. Funding mechanism (in-extension, isolated)

A dedicated hook/component (`useFundAgent` + the card's Fund button) that:

1. Builds a transaction whose single op is
   `Operation.createAccount({ destination: agentAddress, startingBalance: amount })`
   on the **active network** (testnet here), with the user's active wallet as
   source. (Because the agent account is known-new; if it somehow already
   exists, fall back to `Operation.payment` of XLM.)
2. Signs via the existing background `signTransaction` path (same one Send uses)
   — the user key never leaves the background worker.
3. Submits to the active-network Horizon and waits for success.
4. On success: optimistic "Funded ✓", then re-fetch metrics (so the card
   advances / flips to `ACTIVE`).

Reuse existing helpers where they already exist (network details, Horizon
server construction, sign/submit) rather than duplicating them.

### 4. Backend change (one field add, non-breaking)

`GET /v1/metrics/:address` (`agent/src/routes/v1.ts`) gains two fields:

- `usdcTrustlineReady: boolean` — from the agent record (`agent.usdcTrustlineReady !== false`).
- `funded: boolean` — `Number(balances.native) >= 1` (account exists past the base reserve).

No shape removal; existing consumers keep working. This is an `agent/**` change,
so merging it triggers the live deploy.

### 5. Error handling

- Insufficient source balance for `amount` + fee → inline validation on the card,
  Fund button disabled.
- User rejects the signature prompt → no-op, card unchanged.
- Submit failure → toast with the Horizon result reason; card stays on step 1.
- `SERVICE_ERROR` → Retry button re-runs the fetch; never shows "no agent."

### 6. Testing

- **Unit:** state-selection (`404` → `NO_AGENT`, other error → `SERVICE_ERROR`,
  unfunded → `NEEDS_ACTIVATION`, funded+trustline → `ACTIVE`); funding op builder
  (`createAccount` vs `payment` by account existence).
- **Backend unit:** `/v1/metrics` returns `funded`/`usdcTrustlineReady` correctly
  for funded vs unfunded agents.
- **E2E (Playwright):** stub `/v1/metrics` in the "unfunded" shape → assert the
  Activation card + "Fund agent" button render; stub 404 → assert "Connect Your
  AI Agent"; stub a 500 → assert the Retry state. Keep the existing suite green.

## Files (anticipated)

- `extension/extension/src/popup/views/Dashboard/index.tsx` — state machine + render branches
- `extension/extension/src/popup/components/account/AgentActivation/` — new card + Fund button + `useFundAgent`
- `extension/extension/src/api/agentBackendService.ts` — surface HTTP status from `getMetrics`
- `extension/extension/src/api/types.ts` — `AgentMetrics` gains `funded`, `usdcTrustlineReady`
- `agent/src/routes/v1.ts` — add `funded` + `usdcTrustlineReady` to `/metrics`
- tests alongside each

## Open questions

None — default funding amount (3 XLM) and the `/v1/metrics` enrichment are
approved.
