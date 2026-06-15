# Agent Multi-Strategy Framework + DCA (Telegram-first) — Design

- **Date:** 2026-06-13
- **Status:** Approved in brainstorming — ready for implementation planning
- **Scope of this slice:** `agent/` backend + Telegram bot. `extension/` is touched for backward-compatibility only.
- **Network:** Stellar **testnet** only. Never deploy to mainnet.

---

## 1. Problem & motivation

The autonomous trading agent (`agent/`, Express + MongoDB + Telegraf) supports exactly **one hardcoded strategy**: a price-threshold swap — buy XLM when price ≤ `buyBelowUsd`, sell when ≥ `sellAboveUsd`, executed as a USDC↔XLM path payment. It is configured through a **7-step linear text Q&A** in Telegram (`/setrules`).

Two problems to solve:

1. **The Telegram setup is not user-friendly.** Seven sequential typed answers, no menu, no presets, no review screen, and no way to see or edit the current configuration.
2. **Only the one swap strategy exists.** There is no way to run common automated strategies such as DCA (dollar-cost averaging).

## 2. Goals (this slice)

- Generalize the agent from one hardcoded strategy into a small **strategy framework** built on **role-based slots**.
- Add **DCA** as the first time-triggered strategy.
- Redesign the **Telegram setup** into a friendly, button-driven flow (menu, wizard, presets, manage/edit).
- **Preserve all existing safety behavior** and keep the **existing extension config working** (backward-compatible API).

## 3. Non-goals / explicit follow-ups (out of scope here)

- **Extension slot/DCA UI.** The extension keeps working via the backward-compatible `/v1/rules` API; a rich slot/DCA UI is a later spec.
- **Multiple concurrent buy-side strategies** and full shared-budget arbitration. v1 enforces exactly one enabled accumulate strategy.
- **Calendar/timezone DCA schedules.** v1 is interval-based only.
- **Additional strategy types** (grid, limit orders, range/band, rebalance).
- **Mainnet.**

## 4. Key decisions (with rationale)

1. **Concurrency = role-based slots.** Each strategy has a `role`: `accumulate` (buy-side), `sell`, or `protect`. **At most one enabled `accumulate` strategy** may spend the USDC budget. Sell-side strategies generate USDC and are prioritized among themselves. This makes the stack **conflict-free by construction** — no budget-splitting engine, no buy-vs-sell signal arbitration — while still presenting a real multi-strategy "stack" to the user.
2. **Reuse the existing 30s per-agent worker tick as the scheduler.** DCA's trigger is purely time-based (`now − lastRunAt ≥ intervalMin`), evaluated on the same loop as the price triggers. **No cron, no queue, no new infra.**
3. **One trade per tick, fixed priority `protect > sell > accumulate`.** Simple and safe; if a protect and a DCA buy are both due in the same tick, protect fires and DCA waits one tick.
4. **DCA schedule = interval + quick-picks** (2 min / hourly / daily / weekly + custom). Demos live within minutes; no timezone handling.
5. **DCA runs auto within Tier-1.** A scheduled buy executes automatically as long as its size ≤ `tier1Max` (the user pre-authorized the schedule, amount, and daily cap), so it never nags per interval. Larger sizes fall through to the existing Tier-2 confirm path.
6. **Telegram-first.** Redesign the Telegram flow now; keep `/v1/rules` backward-compatible so the current extension form keeps working; defer the extension's slot UI.

## 5. Data model

Add a `strategies[]` array to the `Agent` document (`agent/src/services/db.ts`). Each entry:

```
{
  id:        ObjectId,        // stable id for edit/toggle/remove + callback_data
  type:      'dca' | 'dip_buy' | 'take_profit' | 'stop_loss',
  role:      'accumulate' | 'sell' | 'protect',
  enabled:   boolean,
  params:    { ... },         // type-specific (see below)
  lastRunAt: Date | null,     // DCA scheduling; null until first run
  createdAt: Date,
}
```

Type-specific `params`:

| type          | role       | params |
|---------------|------------|--------|
| `dca`         | accumulate | `{ intervalMin: number, amountUsdc: number }` |
| `dip_buy`     | accumulate | `{ buyBelowUsd: number, amountUsdc: number }` |
| `take_profit` | sell       | `{ sellAboveUsd: number, sellAmountXlm: number }` |
| `stop_loss`   | protect    | `{ sellBelowUsd: number, sellAmountXlm: number }` |

**Unchanged, agent-level, shared by all strategies:** `agentAddress`, encrypted secret fields, `targetWallet`, `tier1Max`, `tier2Max`, `dailyBudget`, `spentToday`, `lastReset`, `usdcTrustlineReady`, `active`, `totalSuccessfulTrades`, low-balance alert state.

**Write-time invariant:** at most one **enabled** strategy with `role === 'accumulate'`. Enabling a second accumulate either rejects (API) or disables the previously-enabled one (Telegram "switch" affordance) — see §9/§10.

After migration, the **strategy entries are the single source of truth.** The legacy flat fields (`buyBelowUsd`, `sellAboveUsd`, `buyAmountUsdc`, `sellAmountXlm`) are retained on the schema only as a transitional backing store for migration; the backward-compatible `/v1/rules` view (see §10/§11) reads and writes the `dip_buy` + `take_profit` strategy entries — **not** the flat fields.

## 6. Strategy engine

Generalize `WorkerManager` (`agent/src/services/worker-manager.ts`) from "evaluate price thresholds" to "evaluate strategies." Per 30s tick, per active agent:

1. Load the fresh agent; reset daily spend if needed; fetch the XLM price via x402 (`fetchPrice`). Price is still required for sell/dip evaluation. Fail-closed on missing/invalid price (unchanged).
2. **Evaluate each enabled strategy's trigger**, producing 0+ candidate actions:
   - `dca` → due if `now − lastRunAt ≥ intervalMin` (first run when `lastRunAt == null`). Action: buy `amountUsdc`.
   - `dip_buy` → `price ≤ buyBelowUsd`. Action: buy `amountUsdc`.
   - `take_profit` → `price ≥ sellAboveUsd`. Action: sell `sellAmountXlm`.
   - `stop_loss` → `price ≤ sellBelowUsd`. Action: sell `sellAmountXlm`.
3. **Select ONE action** by fixed priority **protect > sell > accumulate**. (At most one accumulate is enabled, so accumulate is unambiguous.)
4. **Route through the existing safety pipeline** unchanged: `trade-routing` tier logic (`tier1_auto` / `tier2_confirm` / `blocked`), daily USDC cap for buys, same-zone cooldown to prevent thrashing.
5. **Execute** via the existing `chainService.executeSwap` path payment; write `AgentLog`; send the Telegram notification. On DCA success, set that strategy's `lastRunAt = now`.

Reuses today's worker loop, tier routing, daily-cap accounting, Tier-2 confirm flow (`pending-tier2`), the claim-before-`await` double-execute guard, and the swap primitive. This is a generalization, not a rewrite.

## 7. DCA behavior

- Buys `amountUsdc` of XLM every `intervalMin`. Quick-picks: **2 min (demo) / hourly / daily / weekly**, plus custom minutes.
- Executes **auto** while `amountUsdc ≤ tier1Max`; otherwise uses the Tier-2 confirm path.
- Honors the shared **daily USDC cap**: when the cap is reached it skips and resumes next UTC day (existing `resetDailySpendIfNeeded`).
- If USDC is insufficient at fire time, it **skips that occurrence and logs the reason** (no crash, no retry storm). `lastRunAt` only advances on a successful buy, so a skipped tick retries next tick — bounded by the cap and cooldown.
- Disable/enable/edit anytime from Telegram.

## 8. v1 strategy catalog

Four types across three roles:

- **`dca`** (accumulate) — the headline new strategy.
- **`dip_buy`** (accumulate) — exactly today's `buyBelowUsd` behavior; preserved so nothing regresses. Shares the accumulate slot with DCA (only one enabled at a time).
- **`take_profit`** (sell) — exactly today's `sellAboveUsd` behavior.
- **`stop_loss`** (protect) — new; provides the 3-strategy "intelligent stack" demo and the priority story.

## 9. Telegram UX redesign

Replace the linear text FSM (`setRulesSessions` step machine in `agent/src/services/bot.ts`) with a **callback-query-driven menu** using inline keyboards (the same mechanism already used for Tier-2 confirms).

- **`/menu` (and `/start`) → main menu:** `📊 My Strategies` · `➕ Add Strategy` · `⚙️ Limits & Safety` · `💰 Status`. Existing `/createagent`, `/createtrustline`, `/revokeagent`, `/agentlog`, `/status` remain.
- **Add Strategy wizard:** pick type (DCA / Take-profit / Stop-loss / Dip-buy) → set params via **quick-pick buttons** (DCA interval + amount fully button-driven; sell/dip types need one typed price — the only remaining typing) → **Review card** → `✅ Activate` / `✏️ Edit` / `Cancel`.
- **Quick-start preset:** one tap on **`Accumulator`** provisions DCA (daily $5) + take-profit + stop-loss with sensible defaults; tweakable afterward.
- **My Strategies:** one card per strategy with `Pause`/`Enable`, `Edit`, `Remove`. `callback_data` encodes `action:strategyId`. Enabling a second accumulate prompts to switch (disables the other).
- **State & compatibility:** lightweight in-memory per-user wizard session (same approach/limits as today's Map; lost-on-restart is acceptable for the demo). `/setrules` becomes a thin shim that opens the menu. The Tier-2 confirm flow is unchanged.

## 10. Backend API + extension compatibility

New endpoints (all behind the existing `requireAuth` + `assertOwnsAgent` in `agent/src/routes/v1.ts`):

- `GET    /v1/strategies/:address` — list strategies.
- `POST   /v1/strategies/:address` — add (validates `type`/`role`/params + the one-enabled-accumulate invariant).
- `PUT    /v1/strategies/:address/:strategyId` — update params / toggle `enabled`.
- `DELETE /v1/strategies/:address/:strategyId` — remove.

A successful create/update/toggle calls `WorkerManager.startAgentWorker(updated)` (as today) so the loop picks up changes.

**Backward-compatible `/v1/rules`:** keep `GET`/`PUT` working by **mapping onto the `dip_buy` (accumulate) + `take_profit` (sell) strategy entries**. The current extension `AgentConfig` form continues to function unchanged for the price rule. PUT updates (or creates) those two entries.

## 11. Migration

- **Lazy-on-read + one-time script** (mirror `agent/scripts/encrypt-existing-agents.ts`): for each existing agent, synthesize `strategies[]` — `buyBelowUsd`/`buyAmountUsdc` → a `dip_buy` entry, `sellAboveUsd`/`sellAmountXlm` → a `take_profit` entry — both `enabled`, preserving amounts. (Skip a `dip_buy` whose `buyBelowUsd` is 0 / unset; skip `take_profit` whose `sellAboveUsd` is the `MAX_SAFE_INTEGER` sentinel.)
- New agents start with an empty `strategies[]`.
- Existing demo-vault / live behavior is identical after migration.

## 12. Safety & invariants

**Preserved (do not regress):** tier routing (`tier1_auto`/`tier2_confirm`/`blocked`), daily USDC cap, the claim-before-`await` double-execute guard in the Tier-2 confirm paths, on-chain slippage floor in `executeSwap`, low-balance alerts, fail-closed on missing/invalid price, the key-isolation model (agent key never leaves `agent/`), and the i128 / 7-decimal string discipline for on-chain amounts.

**New invariants:** at most one enabled `accumulate` strategy; fixed priority `protect > sell > accumulate`; one trade per tick; DCA `lastRunAt` advances only on a successful buy; DCA skips + logs on insufficient USDC.

## 13. Testing (Jest, matching `agent/__tests__/` style)

- Strategy **trigger evaluation** + **priority selection** (protect > sell > accumulate; one-trade-per-tick).
- **DCA due-time** logic, including first-run (`lastRunAt == null`), interval boundary, daily-cap pause/resume, and insufficient-USDC skip.
- **One-enabled-accumulate invariant** enforcement on add/enable.
- **`/v1/rules` ↔ strategies backward-compat mapping** (GET reflects strategy entries; PUT writes them).
- **Migration mapping** (flat fields → `strategies[]`, including the skip sentinels).
- **Telegram menu logic** extracted into pure, testable handlers (callback routing → state transitions), isolated from the live bot — the way `trade-routing.ts` and `pending-tier2.ts` are already isolated.

## 14. Acceptance criteria

1. A user can, from Telegram, add a **DCA** strategy in a few taps and see it run on testnet (verifiable with a 2-min interval), with auto-execution within Tier-1 and notifications per buy.
2. A user can run **DCA + take-profit + stop-loss simultaneously**; they never conflict; protect/sell win over accumulate when due in the same tick.
3. The Telegram main menu, add-strategy wizard, `Accumulator` preset, and **My Strategies** management (pause/enable/edit/remove) all work via buttons; `/setrules` opens the menu.
4. The existing extension `AgentConfig` form still reads/writes the price rule unchanged via `/v1/rules`.
5. Existing agents are migrated with **no behavior change**; all preserved-safety items in §12 still hold.
6. New + existing Jest tests pass.

## 15. Primary files touched

- `agent/src/services/db.ts` — `strategies[]` subdocument + invariant.
- `agent/src/services/worker-manager.ts` — strategy evaluation/priority engine.
- `agent/src/services/trade-routing.ts` — reuse; minor adaptation for per-strategy amounts.
- `agent/src/services/bot.ts` — Telegram menu/wizard/manage flow (replaces the text FSM).
- `agent/src/routes/v1.ts` — `/v1/strategies` endpoints + `/v1/rules` compat mapping.
- `agent/src/services/strategy-engine.ts` *(new)* — pure trigger-eval + priority selection (testable).
- `agent/src/services/telegram-menu.ts` *(new)* — pure callback routing/state (testable).
- `agent/scripts/migrate-strategies.ts` *(new)* — one-time migration.
- `agent/__tests__/` — new test files per §13.
- `extension/` — no functional change this slice (relies on `/v1/rules` compat).
