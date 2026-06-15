# AI Copilot — Natural-Language Soroswap Swaps

- **Date:** 2026-06-13
- **Status:** Approved design, ready for implementation planning
- **Scope:** v1 — Soroswap token→token swaps only
- **Network:** Stellar **testnet** only (mainnet is gated on audit/SCF — never deploy)

## 1. Goal

Add a new **"AI Copilot"** tab to the browser extension. The user types a
natural-language instruction such as *"swap 5 usd to xlm on soroswap"*. The
copilot detects the intent, builds an **unsigned** Soroswap swap transaction,
shows a human-readable preview, and the user signs it with their existing
in-extension key. One sentence in, one signed swap out.

## 2. Background — current state

This feature is new plumbing across all three subsystems. What exists today:

| Layer | Exists | Missing for this feature |
|-------|--------|--------------------------|
| **Extension** (`extension/extension/`) | 4-tab system; YieldHub already does *build-via-Baku → sign → submit*; SIWE JWT client (`agentBackendService`); Baku client (`yieldHubService`) | No copilot/chat UI |
| **Baku API** (`vault/api/`) | Key-less build-tx (deposit/withdraw) with simulate+assemble; Soroswap router address pinned; `/tx/submit` | No swap endpoint; no quote; no token-symbol→address resolver |
| **Agent backend** (`agent/`) | Gemini wired (HTTP, `gemini-3.5-flash`), one structured-output example (`contract-summary-ai.ts`); SIWE JWT auth | No NL→intent parsing; no copilot endpoint |

**Canonical internal pattern to reuse (from YieldHub):** an unsigned Soroban
XDR is signed **inline** via the `signFreighterSorobanTransaction` Redux thunk →
background worker (the user key never leaves the worker), then the signed XDR is
POSTed to Baku `/tx/submit`, which relays and polls RPC for terminal status. The
copilot mirrors this exactly. It does **not** use the dApp `SignTransaction`
review screen — the in-chat preview card is the confirmation surface.

## 3. Scope

**In scope (v1):**
- One intent type: a Soroswap swap (`tokenIn → tokenOut`, exact-in).
- Two tokens: **XLM** and **USDC (Circle)** — the only deep Soroswap testnet pool.
- Conversational chat UI with follow-ups (e.g. "make it 10 instead").
- Quote/preview (expected out, min received, rate, slippage) before signing.

**Out of scope (v1, YAGNI):**
- Deposit/withdraw/send via copilot; other DEXs/venues; multi-hop paths.
- Tokens beyond XLM and Circle USDC.
- Server-side conversation persistence; streaming LLM responses.
- Portfolio / price / "what's my APY" Q&A.

## 4. Chosen architecture — "thin services, extension orchestrates"

Two responsibilities, kept separate: **parse** (LLM turns words into a
structured intent) and **build** (deterministically produce the unsigned XDR).
The extension orchestrates; each backend keeps its existing role.

```
You → Extension → Agent /v1/copilot/parse (Gemini)   ── parse (no tx yet)
                → Extension validates intent
                → Baku /swap/build-tx                  ── build + quote
                → Background worker signs (inline)
                → Baku /tx/submit → Soroswap           ── relay + poll
```

**Why this approach** (over a fat agent endpoint or putting the LLM in Baku):
- Baku stays **key-less / build-only**, per project rules.
- The agent backend stays the "AI brain"; no new agent→Baku coupling (the agent
  backend does not call Baku today, and won't).
- Clean trust boundary: the LLM only emits **parameters the extension
  validates**; a separate deterministic step builds the actual transaction.
- Reuses both existing extension API clients and their auth.

## 5. Component design

### 5.1 Agent backend — parse only

**`agent/src/services/copilot-parse-ai.ts`** (new)
- Calls Gemini over HTTP, following the existing `contract-summary-ai.ts`
  structured-output pattern: low temperature (~0.1), JSON-only response, tolerant
  JSON parse, deterministic safe fallback (never throws).
- System prompt constrains the model to the swap schema and the supported token
  set, and instructs it to return `clarification` when info is missing and
  `unsupported` for anything that is not a Soroswap swap.

**`POST /v1/copilot/parse`** (add to `agent/src/routes/v1.ts`)
- JWT-authed (reuse `requireAuth`).
- Request: `{ message: string, context?: { role: "user"|"copilot", text: string }[] }`
  (the last 1–2 turns for follow-up resolution).
- Calls the parse service, then applies **deterministic guardrails** independent
  of the LLM:
  - `tokenIn`/`tokenOut` must be in the allowlist `{XLM, USDC}` and differ.
  - `amountIn` must be a positive decimal string in **human units** as typed
    (e.g. `"5"` = 5 USDC), within sane bounds.
  - `slippageBps` (if present) within `[0, 10000]`; else the default is applied
    by the extension (§7).
  - Anything failing → coerce to `clarification` or `unsupported`. The LLM's raw
    output is never trusted to drive a build.
- Response is exactly one of:
  - `{ type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "USDC", tokenOut: "XLM", slippageBps?: 50 }`
  - `{ type: "clarification", message: "Did you mean USDC → XLM or XLM → USDC?" }`
  - `{ type: "unsupported", message: "I can only do Soroswap swaps right now." }`

### 5.2 Baku API — build only (stays key-less)

**`vault/api/src/routes/swap.ts`** (new) — `POST /swap/build-tx`
- Request: `{ user: "G…", tokenIn: "USDC", tokenOut: "XLM", amountIn: "50000000", maxSlippageBps?: 50 }`.
- **`amountIn` is base units** (i128 decimal string, 7 decimals). The extension
  converts the parsed human amount (×10^7) before calling — consistent with how
  YieldHub converts before `buildDeposit`/`buildWithdraw`. Baku never sees human
  units, honoring the project rule that API-boundary amounts are i128 strings.
- Resolve `tokenIn`/`tokenOut` symbols → SAC addresses via the resolver (§5.3).
- Build the Soroswap router invocation
  `swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline)`:
  - `path = [tokenIn_sac, tokenOut_sac]` (direct, single hop).
  - `to = user`; `deadline = latest_ledger_time + buffer`.
  - `amount_in` = `amountIn` as received (base-unit i128 string).
- Simulate to get the expected output and assemble Soroban resources/auth
  (reuses the existing `buildInvocationXdr` + `simulateTransaction` pipeline).
- `amount_out_min = floor(expectedOut * (10000 - slippageBps) / 10000)` in integer
  math; the slippage floor is thus enforced **on-chain** in the router call.
- Response: `{ xdr, preview: { tokenIn, tokenOut, amountIn, expectedOut, minOut, rate, maxSlippageBps, venue: "soroswap" } }`.
- Errors return structured messages (unknown token, insufficient liquidity,
  simulation failure).

**Soroban auth note:** the router pulls `tokenIn` from `user` within the same
invocation; simulation produces the required `SorobanAuthorizationEntry`s, and
the single user signature authorizes them. No separate ERC20-style "approve" tx.

**Submit:** reuse the existing `POST /tx/submit` unchanged.

### 5.3 Baku API — token resolver

- Extend `vault/api/src/addresses.ts` with a symbol→SAC map for the swap surface:
  - `XLM → xlmSac`
  - `USDC → circleUsdcSac` (`CBIELT…`) — the **Soroswap-paired** token.
- **Decision:** "usd"/"usdc" maps to **Circle USDC**, *not* Blend USDC. Rationale:
  the deep Soroswap testnet pool is XLM ↔ Circle USDC. The YieldHub "usdc" vault
  uses Blend USDC (a different token); the copilot preview will label the swap
  token **"USDC (Circle)"** to avoid confusion.

### 5.4 Extension

- **Tab wiring:** add `AI_COPILOT = "ai_copilot"` to the tab enum
  (`Account/contexts/activeTabContext.tsx`), a label + icon in
  `AccountTabs/index.tsx`, and a new pane in `Account/index.tsx`.
- **`src/popup/views/AICopilot/`** (new) — conversational chat UI:
  - Message list (user + copilot turns), text input, send.
  - Copilot turn renders one of: a **swap preview card** (From→To, expected &
    min received, rate, slippage, "Sign & Submit" / "Cancel"), a clarification
    message, an unsupported message, or an error.
  - Pending/success/error tracked in local `useState` (same shape as YieldHub's
    `PendingTx`). On success, show hash + actual received; optionally refresh
    balances.
  - Chat history is client-side; the last 1–2 turns are sent as `context` to the
    parse endpoint.
- **`src/api/copilotService.ts`** (new) — `parse(message, context)` → agent
  backend `/v1/copilot/parse`, reusing `agentBackendService`'s SIWE JWT auth.
- **`src/api/bakuSwapService.ts`** (new) — `buildSwap({ user, tokenIn, tokenOut, amountIn, maxSlippageBps })`
  → `/swap/build-tx`; reuse `submitSignedTx()` (extract/share with
  `yieldHubService` if convenient). The view converts the parsed human amount →
  base units (×10^7, i128 string) and applies the default slippage (§7) before
  calling, so `amountIn` here is already base units.
- **`src/popup/hooks/useSignAndSubmitSoroban.ts`** (new) — extract YieldHub's
  inline sign path (`dispatch(signFreighterSorobanTransaction({ transactionXDR, network }))`)
  into a shared hook used by both YieldHub and the copilot.
- **Intent↔preview cross-check:** before rendering "Sign & Submit", the extension
  verifies Baku's returned `preview` matches the intent it sent (same tokens,
  same `amountIn`). Mismatch → show an error instead of a sign button.

## 6. Data flow (happy path)

1. User types the message in the AI Copilot chat.
2. Extension → `copilotService.parse(message, recentContext)` → agent
   `/v1/copilot/parse` (JWT). No transaction is built yet.
3. Gemini (structured) + guardrails → `{ type: "swap", amountIn, tokenIn, tokenOut, slippageBps? }`
   (or `clarification` / `unsupported`, which render as a chat message and stop).
4. Extension validates the intent (supported tokens, sane amount).
5. Extension → `bakuSwapService.buildSwap(...)` → Baku `/swap/build-tx`.
6. Baku resolves tokens, simulates the Soroswap router swap, computes `minOut`,
   returns `{ xdr, preview }`.
7. Extension cross-checks `preview` vs intent, renders the preview card; user taps
   **Sign & Submit** → background worker signs the XDR inline.
8. Extension → `submitSignedTx(signedXdr)` → Baku `/tx/submit` → Soroswap; Baku
   polls RPC; chat shows result (hash + actual XLM received) or a clear error.

## 7. Defaults & conventions

- **Default slippage:** 0.5% (50 bps), overridable inline ("…with 1% slippage").
- **Amounts:** base units, **7 decimals**, **i128 decimal strings** — never JS
  `number` (e.g. 5 USDC → `"50000000"`).
- **Deadline:** latest ledger close time + a small buffer.

## 8. Security & trust boundary

- The LLM produces **parameters only** — it never builds or signs a transaction.
- The preview the user approves reflects **Baku's real built tx** (echoed params +
  simulated quote), not the LLM's text; the extension cross-checks them.
- Token **allowlist** + swap-only schema mean prompt injection's worst case is a
  refusal, never a rogue transaction.
- Slippage floor (`amount_out_min`) is enforced **on-chain** in the router call.
- Baku stays key-less; the agent backend signs nothing. The only secret involved
  is the Gemini key, which already lives in the agent backend.
- The user's key never leaves the background worker (unchanged).

## 9. Error handling

| Condition | Behavior |
|-----------|----------|
| Unparseable / missing info | `clarification` chat message; no tx |
| Out-of-scope / unknown token / prompt injection | `unsupported` chat message; guardrails enforce |
| Insufficient balance | Pre-flight balance check + clear chat error |
| Insufficient liquidity / simulation failure | Baku returns structured error → chat error |
| User rejects sign | Return to chat; nothing submitted |
| Submit `FAILED` / `TIMEOUT` | Show status + hash in chat |
| Agent backend or Baku unavailable | Graceful "copilot unavailable" (matches existing 503 fail-soft) |
| Reverse direction (XLM→USDC) trustline edge | Pre-flight check that `user` can receive the Circle USDC SAC; surface a clear message if not |

## 10. Testing strategy

- **Agent backend:** parse unit tests (mock Gemini) for swap / clarification /
  unsupported; **adversarial prompt-injection** cases; guardrail tests that run
  independent of the LLM.
- **Baku:** `/swap/build-tx` builds a valid XDR, correct `amount_out_min` math,
  token resolution, slippage bounds, unknown-token error. A **tracer** that
  builds + simulates a real testnet swap (per repo tracer convention).
- **Extension:** component tests for chat + preview + mocked sign; the
  intent↔preview cross-check.
- **E2E tracer:** "swap 5 usd to xlm" → parse → build → sign (test key) → submit
  on testnet → success. Tracer-first: run this one path end-to-end before
  parallelizing.

## 11. File-change checklist

**Agent backend**
- `agent/src/services/copilot-parse-ai.ts` (new)
- `agent/src/routes/v1.ts` (add `POST /v1/copilot/parse` + guardrails)
- tests

**Baku API**
- `vault/api/src/routes/swap.ts` (new — `POST /swap/build-tx`)
- `vault/api/src/addresses.ts` (token symbol→SAC resolver)
- `vault/api/src/index.ts` (register route)
- tests + tracer

**Extension** (paths under `extension/extension/`)
- `src/popup/views/Account/contexts/activeTabContext.tsx` (enum)
- `src/popup/components/account/AccountTabs/index.tsx` (label + icon)
- `src/popup/views/Account/index.tsx` (pane)
- `src/popup/views/AICopilot/` (new view + styles)
- `src/api/copilotService.ts` (new)
- `src/api/bakuSwapService.ts` (new)
- `src/popup/hooks/useSignAndSubmitSoroban.ts` (new; refactor YieldHub to share)
- tests

## 12. Open questions / future work

- **Quote freshness:** v1 builds immediately and shows the simulated preview; if
  the user waits a long time before signing, the on-chain `amount_out_min` still
  protects them (tx fails rather than fills badly). A "re-quote" affordance can
  come later.
- **More intents:** deposit/withdraw/send and read-only Q&A are natural follow-on
  scopes, each its own spec → plan cycle.
- **Trustline UX for XLM→USDC:** v1 surfaces a clear error; auto-establishing a
  trustline could be a later enhancement.
