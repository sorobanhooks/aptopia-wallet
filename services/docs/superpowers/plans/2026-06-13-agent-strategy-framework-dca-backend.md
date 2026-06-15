# Agent Strategy Framework + DCA — Backend Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the agent backend from one hardcoded price-threshold strategy into a role-based strategy framework, add DCA (time-triggered recurring buy), expose `/v1/strategies` CRUD, and keep `/v1/rules` (and the existing extension) working — all on Stellar testnet.

**Architecture:** Strategies are stored as a `strategies[]` array on the `Agent` Mongo document, each with a `role` (`accumulate` / `sell` / `protect`). A pure `strategy-engine` evaluates every enabled strategy on the existing 30s worker tick, selects **one** action by fixed priority (`protect > sell > accumulate`), and runs it through the *existing* tier-routing / daily-cap / Tier-2-confirm / `executeSwap` pipeline. DCA's trigger is purely time-based (`lastRunAt + intervalMin`) — no new scheduler. At most one enabled `accumulate` strategy spends the USDC budget, which makes the stack conflict-free.

**Tech Stack:** TypeScript, Express, Mongoose 9, Telegraf (untouched in this plan), Stellar SDK path payments. Tests: Node built-in test runner (`node:test`) executed via `tsx` (`npm run test:node`).

**Spec:** `docs/superpowers/specs/2026-06-13-agent-strategy-framework-dca-design.md`
**Companion plan (next):** Plan 2 — Telegram UX redesign (`bot.ts` menu/wizard) builds on this.

---

## File Structure (decomposition)

**New files (all under `agent/`):**
- `src/services/strategy-types.ts` — shared types + constants (`StrategyType`, `StrategyRole`, `StrategyConfig`, `StrategyAction`, `ROLE_PRIORITY`, `STRATEGY_DEFAULTS`, `DCA_INTERVAL_PRESETS_MIN`). One responsibility: the vocabulary every other module imports.
- `src/services/strategy-engine.ts` — pure decision logic: `isDcaDue`, `evaluateStrategies`, `selectAction`, `enabledAccumulateCount`, `wouldViolateSingleAccumulate`. No I/O.
- `src/services/strategy-mapping.ts` — pure mapping between the legacy flat rule fields and `strategies[]`: `flatRulesToStrategies`, `strategiesToFlatRules`, `applyFlatRulesToStrategies`.
- `scripts/migrate-strategies.ts` — one-time migration runner (thin wrapper over `flatRulesToStrategies`).
- `__tests__/strategy-engine.test.ts`, `__tests__/strategy-mapping.test.ts`, `__tests__/trade-routing.test.ts`, `__tests__/strategies-routes.test.ts` — `node:test` suites.

**Modified files:**
- `src/services/db.ts` — add the `StrategySubSchema` + `strategies[]` field + `IStrategy` interface to `IAgent`.
- `src/services/trade-routing.ts` — add amount-parameterized routing variants.
- `src/services/worker-manager.ts` — replace the price-threshold `getSignal`/`handleBuySignal`/`handleSellSignal` with engine-driven evaluation.
- `src/routes/v1.ts` — add `/v1/strategies` CRUD; re-point `/v1/rules` GET/PUT onto the mapping.
- `package.json` — register the new `node:test` files in the `test:node` script.

---

## Task 1: Shared strategy types + constants

**Files:**
- Create: `agent/src/services/strategy-types.ts`
- Test: `agent/__tests__/strategy-engine.test.ts` (this task adds the first assertions; Task 2 extends the same file)

- [ ] **Step 1: Write the failing test**

Create `agent/__tests__/strategy-engine.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_PRIORITY,
  STRATEGY_DEFAULTS,
  DCA_INTERVAL_PRESETS_MIN,
} from '../src/services/strategy-types';

test('ROLE_PRIORITY orders protect > sell > accumulate', () => {
  assert.ok(ROLE_PRIORITY.protect > ROLE_PRIORITY.sell);
  assert.ok(ROLE_PRIORITY.sell > ROLE_PRIORITY.accumulate);
});

test('STRATEGY_DEFAULTS has an entry for every strategy type', () => {
  assert.ok(STRATEGY_DEFAULTS.dca);
  assert.ok(STRATEGY_DEFAULTS.dip_buy);
  assert.ok(STRATEGY_DEFAULTS.take_profit);
  assert.ok(STRATEGY_DEFAULTS.stop_loss);
  assert.equal(STRATEGY_DEFAULTS.dca.role, 'accumulate');
  assert.equal(STRATEGY_DEFAULTS.take_profit.role, 'sell');
  assert.equal(STRATEGY_DEFAULTS.stop_loss.role, 'protect');
});

test('DCA_INTERVAL_PRESETS_MIN includes a 2-minute demo and a daily option', () => {
  const minutes = DCA_INTERVAL_PRESETS_MIN.map((p) => p.minutes);
  assert.ok(minutes.includes(2));
  assert.ok(minutes.includes(1440));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd agent && node --import tsx --test __tests__/strategy-engine.test.ts`
Expected: FAIL — `Cannot find module '../src/services/strategy-types'`.

- [ ] **Step 3: Create the types module**

Create `agent/src/services/strategy-types.ts`:

```ts
/** The four v1 strategy types. */
export type StrategyType = 'dca' | 'dip_buy' | 'take_profit' | 'stop_loss';

/** Slot a strategy occupies. Exactly one ENABLED `accumulate` is allowed per agent. */
export type StrategyRole = 'accumulate' | 'sell' | 'protect';

/**
 * A single configured strategy, as read from the Agent document.
 * `id` is the Mongo subdocument _id as a string (used for callback_data + REST).
 * `params` holds type-specific numbers (see STRATEGY_DEFAULTS for shapes).
 */
export interface StrategyConfig {
  id: string;
  type: StrategyType;
  role: StrategyRole;
  enabled: boolean;
  params: Record<string, number>;
  lastRunAt: Date | null;
}

/** Shape used when CREATING a strategy (Mongo assigns the _id, lastRunAt starts null). */
export interface NewStrategyInput {
  type: StrategyType;
  role: StrategyRole;
  enabled: boolean;
  params: Record<string, number>;
  lastRunAt: null;
}

/** Higher number wins when multiple strategies fire on the same tick. */
export const ROLE_PRIORITY: Record<StrategyRole, number> = {
  protect: 3,
  sell: 2,
  accumulate: 1,
};

/** Canonical role + default params per type. Used by the API, presets, and migration. */
export const STRATEGY_DEFAULTS: Record<
  StrategyType,
  { role: StrategyRole; params: Record<string, number> }
> = {
  dca: { role: 'accumulate', params: { intervalMin: 1440, amountUsdc: 1 } },
  dip_buy: { role: 'accumulate', params: { buyBelowUsd: 0.1, amountUsdc: 1 } },
  take_profit: { role: 'sell', params: { sellAboveUsd: 0.5, sellAmountXlm: 1 } },
  stop_loss: { role: 'protect', params: { sellBelowUsd: 0.08, sellAmountXlm: 1 } },
};

/** Quick-pick intervals offered in the UI (Plan 2). `2` is the live-demo option. */
export const DCA_INTERVAL_PRESETS_MIN: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: '2 min (demo)', minutes: 2 },
  { label: 'Hourly', minutes: 60 },
  { label: 'Daily', minutes: 1440 },
  { label: 'Weekly', minutes: 10080 },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent && node --import tsx --test __tests__/strategy-engine.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/services/strategy-types.ts agent/__tests__/strategy-engine.test.ts
git commit -m "feat(agent): add strategy types, roles, and constants"
```

---

## Task 2: Pure strategy engine — trigger evaluation + action selection

**Files:**
- Create: `agent/src/services/strategy-engine.ts`
- Test: `agent/__tests__/strategy-engine.test.ts` (extend)

- [ ] **Step 1: Add failing tests** (append to `agent/__tests__/strategy-engine.test.ts`):

```ts
import {
  isDcaDue,
  evaluateStrategies,
  selectAction,
} from '../src/services/strategy-engine';
import type { StrategyConfig } from '../src/services/strategy-types';

const mk = (over: Partial<StrategyConfig>): StrategyConfig => ({
  id: 'id1', type: 'dca', role: 'accumulate', enabled: true,
  params: { intervalMin: 60, amountUsdc: 5 }, lastRunAt: null, ...over,
});

const HOUR = 60 * 60 * 1000;

test('isDcaDue: first run (lastRunAt null) is due', () => {
  assert.equal(isDcaDue(mk({}), 1_000_000), true);
});

test('isDcaDue: not due before the interval elapses', () => {
  const last = new Date(1_000_000);
  assert.equal(isDcaDue(mk({ lastRunAt: last }), 1_000_000 + 30 * 60 * 1000), false);
});

test('isDcaDue: due once the interval has elapsed', () => {
  const last = new Date(1_000_000);
  assert.equal(isDcaDue(mk({ lastRunAt: last }), 1_000_000 + HOUR), true);
});

test('isDcaDue: non-dca strategy is never "due"', () => {
  assert.equal(isDcaDue(mk({ type: 'take_profit', role: 'sell' }), 9_999_999), false);
});

test('evaluateStrategies: disabled strategies never act', () => {
  const s = mk({ enabled: false });
  assert.deepEqual(evaluateStrategies([s], { priceUsd: 0.2, now: HOUR }), []);
});

test('evaluateStrategies: dip_buy fires at/below threshold; take_profit at/above', () => {
  const dip = mk({ id: 'dip', type: 'dip_buy', role: 'accumulate', params: { buyBelowUsd: 0.1, amountUsdc: 3 } });
  const tp = mk({ id: 'tp', type: 'take_profit', role: 'sell', params: { sellAboveUsd: 0.5, sellAmountXlm: 7 } });
  const low = evaluateStrategies([dip, tp], { priceUsd: 0.09, now: 0 });
  assert.equal(low.length, 1);
  assert.equal(low[0].strategyId, 'dip');
  assert.equal(low[0].direction, 'buy_xlm');
  const high = evaluateStrategies([dip, tp], { priceUsd: 0.6, now: 0 });
  assert.equal(high.length, 1);
  assert.equal(high[0].strategyId, 'tp');
  assert.equal(high[0].direction, 'sell_xlm');
});

test('selectAction: protect beats sell beats accumulate', () => {
  const dca = mk({ id: 'dca', type: 'dca', role: 'accumulate', lastRunAt: null });
  const tp = mk({ id: 'tp', type: 'take_profit', role: 'sell', params: { sellAboveUsd: 0.5, sellAmountXlm: 1 } });
  const sl = mk({ id: 'sl', type: 'stop_loss', role: 'protect', params: { sellBelowUsd: 0.08, sellAmountXlm: 1 } });
  // price triggers tp AND sl; dca is time-due — all three want to act
  const actions = evaluateStrategies([dca, tp, sl], { priceUsd: 0.6, now: HOUR });
  // tp fires (>=0.5); sl does NOT (price not <=0.08); dca due → expect 2 actions
  const chosen = selectAction(actions);
  assert.equal(chosen?.strategyId, 'tp', 'sell beats accumulate');
  // Now force both protect and sell to fire at a crash price under both thresholds
  const tp2 = mk({ id: 'tp2', type: 'take_profit', role: 'sell', params: { sellAboveUsd: 0.05, sellAmountXlm: 1 } });
  const both = evaluateStrategies([tp2, sl], { priceUsd: 0.05, now: 0 });
  assert.equal(selectAction(both)?.strategyId, 'sl', 'protect beats sell');
});

test('selectAction: returns null when nothing fires', () => {
  assert.equal(selectAction([]), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && node --import tsx --test __tests__/strategy-engine.test.ts`
Expected: FAIL — `Cannot find module '../src/services/strategy-engine'`.

- [ ] **Step 3: Implement the engine**

Create `agent/src/services/strategy-engine.ts`:

```ts
import {
  StrategyConfig,
  StrategyType,
  ROLE_PRIORITY,
} from './strategy-types';

export interface EvalContext {
  /** Current XLM price in USD. */
  priceUsd: number;
  /** Epoch milliseconds (pass Date.now() at the call site). */
  now: number;
}

export type StrategyAction =
  | {
      strategyId: string;
      type: StrategyType;
      role: 'accumulate';
      direction: 'buy_xlm';
      amountUsdc: number;
    }
  | {
      strategyId: string;
      type: StrategyType;
      role: 'sell' | 'protect';
      direction: 'sell_xlm';
      amountXlm: number;
    };

/** A DCA strategy is due when its interval has elapsed since lastRunAt (first run if null). */
export function isDcaDue(s: StrategyConfig, now: number): boolean {
  if (s.type !== 'dca') return false;
  const intervalMs = (Number(s.params.intervalMin) || 0) * 60_000;
  if (intervalMs <= 0) return false;
  if (!s.lastRunAt) return true;
  return now - new Date(s.lastRunAt).getTime() >= intervalMs;
}

/** Build the list of actions that enabled strategies want to take this tick. */
export function evaluateStrategies(
  strategies: StrategyConfig[],
  ctx: EvalContext
): StrategyAction[] {
  const out: StrategyAction[] = [];
  for (const s of strategies) {
    if (!s.enabled) continue;
    switch (s.type) {
      case 'dca':
        if (isDcaDue(s, ctx.now)) {
          out.push({ strategyId: s.id, type: 'dca', role: 'accumulate', direction: 'buy_xlm', amountUsdc: Number(s.params.amountUsdc) || 0 });
        }
        break;
      case 'dip_buy':
        if (ctx.priceUsd <= Number(s.params.buyBelowUsd)) {
          out.push({ strategyId: s.id, type: 'dip_buy', role: 'accumulate', direction: 'buy_xlm', amountUsdc: Number(s.params.amountUsdc) || 0 });
        }
        break;
      case 'take_profit':
        if (ctx.priceUsd >= Number(s.params.sellAboveUsd)) {
          out.push({ strategyId: s.id, type: 'take_profit', role: 'sell', direction: 'sell_xlm', amountXlm: Number(s.params.sellAmountXlm) || 0 });
        }
        break;
      case 'stop_loss':
        if (ctx.priceUsd <= Number(s.params.sellBelowUsd)) {
          out.push({ strategyId: s.id, type: 'stop_loss', role: 'protect', direction: 'sell_xlm', amountXlm: Number(s.params.sellAmountXlm) || 0 });
        }
        break;
    }
  }
  return out;
}

/** Pick exactly one action by fixed role priority (protect > sell > accumulate). Ties: first listed. */
export function selectAction(actions: StrategyAction[]): StrategyAction | null {
  if (actions.length === 0) return null;
  return actions.reduce((best, a) =>
    ROLE_PRIORITY[a.role] > ROLE_PRIORITY[best.role] ? a : best
  );
}

/** Count of ENABLED accumulate-role strategies (the invariant cares about this). */
export function enabledAccumulateCount(strategies: StrategyConfig[]): number {
  return strategies.filter((s) => s.enabled && s.role === 'accumulate').length;
}

/**
 * True if adding/enabling `candidate` would make 2+ enabled accumulate strategies.
 * `existing` should EXCLUDE the candidate (for updates, exclude the one being edited).
 */
export function wouldViolateSingleAccumulate(
  existing: StrategyConfig[],
  candidate: { role: string; enabled: boolean }
): boolean {
  if (!(candidate.enabled && candidate.role === 'accumulate')) return false;
  return enabledAccumulateCount(existing) >= 1;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent && node --import tsx --test __tests__/strategy-engine.test.ts`
Expected: PASS (all engine tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/services/strategy-engine.ts agent/__tests__/strategy-engine.test.ts
git commit -m "feat(agent): pure strategy engine (trigger eval, priority select, invariant)"
```

---

## Task 3: Legacy ↔ strategies mapping (compat + migration source of truth)

**Files:**
- Create: `agent/src/services/strategy-mapping.ts`
- Test: `agent/__tests__/strategy-mapping.test.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/__tests__/strategy-mapping.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flatRulesToStrategies,
  strategiesToFlatRules,
  applyFlatRulesToStrategies,
} from '../src/services/strategy-mapping';
import type { StrategyConfig } from '../src/services/strategy-types';

const MAX = Number.MAX_SAFE_INTEGER;

test('flatRulesToStrategies: maps buy-below → dip_buy and sell-above → take_profit', () => {
  const out = flatRulesToStrategies({ buyBelowUsd: 0.1, sellAboveUsd: 0.5, buyAmountUsdc: 2, sellAmountXlm: 3 });
  assert.equal(out.length, 2);
  const dip = out.find((s) => s.type === 'dip_buy')!;
  const tp = out.find((s) => s.type === 'take_profit')!;
  assert.equal(dip.role, 'accumulate');
  assert.equal(dip.params.buyBelowUsd, 0.1);
  assert.equal(dip.params.amountUsdc, 2);
  assert.equal(tp.role, 'sell');
  assert.equal(tp.params.sellAboveUsd, 0.5);
  assert.equal(tp.params.sellAmountXlm, 3);
  assert.equal(dip.lastRunAt, null);
});

test('flatRulesToStrategies: skips unset buy (0) and sentinel sell (MAX)', () => {
  const out = flatRulesToStrategies({ buyBelowUsd: 0, sellAboveUsd: MAX, buyAmountUsdc: 1, sellAmountXlm: 1 });
  assert.equal(out.length, 0);
});

test('strategiesToFlatRules: reflects enabled dip_buy + take_profit, defaults otherwise', () => {
  const strategies: StrategyConfig[] = [
    { id: 'a', type: 'dip_buy', role: 'accumulate', enabled: true, params: { buyBelowUsd: 0.2, amountUsdc: 4 }, lastRunAt: null },
    { id: 'b', type: 'take_profit', role: 'sell', enabled: true, params: { sellAboveUsd: 0.7, sellAmountXlm: 9 }, lastRunAt: null },
    { id: 'c', type: 'dca', role: 'accumulate', enabled: true, params: { intervalMin: 60, amountUsdc: 1 }, lastRunAt: null },
  ];
  const flat = strategiesToFlatRules(strategies);
  assert.equal(flat.buyBelowUsd, 0.2);
  assert.equal(flat.buyAmountUsdc, 4);
  assert.equal(flat.sellAboveUsd, 0.7);
  assert.equal(flat.sellAmountXlm, 9);
});

test('strategiesToFlatRules: uses sentinels when no dip_buy/take_profit present', () => {
  const flat = strategiesToFlatRules([]);
  assert.equal(flat.buyBelowUsd, 0);
  assert.equal(flat.sellAboveUsd, MAX);
});

test('applyFlatRulesToStrategies: updates existing take_profit, leaves dca untouched', () => {
  const existing: StrategyConfig[] = [
    { id: 'tp', type: 'take_profit', role: 'sell', enabled: true, params: { sellAboveUsd: 0.5, sellAmountXlm: 1 }, lastRunAt: null },
    { id: 'dca', type: 'dca', role: 'accumulate', enabled: true, params: { intervalMin: 60, amountUsdc: 1 }, lastRunAt: null },
  ];
  const next = applyFlatRulesToStrategies(existing, { sellAboveUsd: 0.9 });
  const tp = next.find((s) => s.type === 'take_profit')!;
  assert.equal(tp.params.sellAboveUsd, 0.9);
  assert.ok(next.some((s) => s.type === 'dca'), 'dca preserved');
});

test('applyFlatRulesToStrategies: creates a dip_buy when buyBelowUsd is sent and none exists', () => {
  const next = applyFlatRulesToStrategies([], { buyBelowUsd: 0.15, buyAmountUsdc: 2 });
  const dip = next.find((s) => s.type === 'dip_buy')!;
  assert.equal(dip.params.buyBelowUsd, 0.15);
  assert.equal(dip.params.amountUsdc, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && node --import tsx --test __tests__/strategy-mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the mapping**

Create `agent/src/services/strategy-mapping.ts`:

```ts
import { StrategyConfig, NewStrategyInput } from './strategy-types';

const MAX = Number.MAX_SAFE_INTEGER;

export interface FlatRules {
  buyBelowUsd: number;
  sellAboveUsd: number;
  buyAmountUsdc: number;
  sellAmountXlm: number;
}

/** Migration: synthesize strategy entries from an agent's legacy flat fields. */
export function flatRulesToStrategies(rules: FlatRules): NewStrategyInput[] {
  const out: NewStrategyInput[] = [];
  if (Number(rules.buyBelowUsd) > 0) {
    out.push({
      type: 'dip_buy', role: 'accumulate', enabled: true, lastRunAt: null,
      params: { buyBelowUsd: rules.buyBelowUsd, amountUsdc: rules.buyAmountUsdc },
    });
  }
  if (Number(rules.sellAboveUsd) > 0 && Number(rules.sellAboveUsd) < MAX) {
    out.push({
      type: 'take_profit', role: 'sell', enabled: true, lastRunAt: null,
      params: { sellAboveUsd: rules.sellAboveUsd, sellAmountXlm: rules.sellAmountXlm },
    });
  }
  return out;
}

/** /v1/rules GET: present the dip_buy + take_profit entries as the legacy flat shape. */
export function strategiesToFlatRules(strategies: StrategyConfig[]): FlatRules {
  const dip = strategies.find((s) => s.type === 'dip_buy');
  const tp = strategies.find((s) => s.type === 'take_profit');
  return {
    buyBelowUsd: dip ? Number(dip.params.buyBelowUsd) : 0,
    buyAmountUsdc: dip ? Number(dip.params.amountUsdc) : 1,
    sellAboveUsd: tp ? Number(tp.params.sellAboveUsd) : MAX,
    sellAmountXlm: tp ? Number(tp.params.sellAmountXlm) : 0.001,
  };
}

/**
 * /v1/rules PUT: fold a partial legacy-rules body into the strategies array,
 * updating/creating only the dip_buy + take_profit entries. Other strategies
 * (dca, stop_loss) are returned unchanged. Returns a NEW array (no mutation).
 */
export function applyFlatRulesToStrategies(
  strategies: StrategyConfig[],
  body: Partial<FlatRules>
): Array<StrategyConfig | NewStrategyInput> {
  const next: Array<StrategyConfig | NewStrategyInput> = strategies.map((s) => ({ ...s, params: { ...s.params } }));

  const upsert = (
    type: 'dip_buy' | 'take_profit',
    role: 'accumulate' | 'sell',
    patch: Record<string, number>
  ) => {
    const idx = next.findIndex((s) => s.type === type);
    if (idx >= 0) {
      next[idx] = { ...next[idx], params: { ...next[idx].params, ...patch } };
    } else {
      next.push({ type, role, enabled: true, lastRunAt: null, params: patch });
    }
  };

  if (body.buyBelowUsd !== undefined || body.buyAmountUsdc !== undefined) {
    const patch: Record<string, number> = {};
    if (body.buyBelowUsd !== undefined) patch.buyBelowUsd = body.buyBelowUsd;
    if (body.buyAmountUsdc !== undefined) patch.amountUsdc = body.buyAmountUsdc;
    upsert('dip_buy', 'accumulate', patch);
  }
  if (body.sellAboveUsd !== undefined || body.sellAmountXlm !== undefined) {
    const patch: Record<string, number> = {};
    if (body.sellAboveUsd !== undefined) patch.sellAboveUsd = body.sellAboveUsd;
    if (body.sellAmountXlm !== undefined) patch.sellAmountXlm = body.sellAmountXlm;
    upsert('take_profit', 'sell', patch);
  }
  return next;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent && node --import tsx --test __tests__/strategy-mapping.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/services/strategy-mapping.ts agent/__tests__/strategy-mapping.test.ts
git commit -m "feat(agent): pure legacy-rules <-> strategies mapping"
```

---

## Task 4: Amount-parameterized trade routing

**Files:**
- Modify: `agent/src/services/trade-routing.ts`
- Test: `agent/__tests__/trade-routing.test.ts`

Today `computePlannedBuyUsdc` reads `agent.buyAmountUsdc` and `routeSell` reads `agent.sellAmountXlm`. The engine supplies a per-strategy amount, so we add explicit-amount variants and keep the originals as thin wrappers (no behavior change for existing callers).

- [ ] **Step 1: Write the failing test**

Create `agent/__tests__/trade-routing.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePlannedBuyUsdcForAmount,
  routeBuy,
  routeSellForAmount,
} from '../src/services/trade-routing';

test('computePlannedBuyUsdcForAmount caps by tier2, daily-left, and spendable balance', () => {
  const agent = { tier1Max: 1, tier2Max: 10, dailyBudget: 6, spentToday: 2 };
  // requested 8, but dailyLeft=4, balance spendable ~ 100 → expect 4
  const planned = computePlannedBuyUsdcForAmount(agent, 100, 8);
  assert.equal(planned, 4);
});

test('routeBuy: <= tier1 is auto, <= tier2 is confirm, above is blocked', () => {
  const agent = { tier1Max: 5, tier2Max: 20 };
  assert.equal(routeBuy(agent, 3).kind, 'tier1_auto');
  assert.equal(routeBuy(agent, 12).kind, 'tier2_confirm');
  assert.equal(routeBuy(agent, 50).kind, 'blocked');
});

test('routeSellForAmount uses notional = xlm * price for tiering', () => {
  const agent = { tier1Max: 5, tier2Max: 20 };
  // 10 XLM * $0.2 = $2 notional → tier1 auto
  assert.equal(routeSellForAmount(agent, 10, 0.2).kind, 'tier1_auto');
  // 100 XLM * $0.2 = $20 → tier2 confirm (<= 20)
  assert.equal(routeSellForAmount(agent, 100, 0.2).kind, 'tier2_confirm');
  // 1000 XLM * $0.2 = $200 → blocked
  assert.equal(routeSellForAmount(agent, 1000, 0.2).kind, 'blocked');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && node --import tsx --test __tests__/trade-routing.test.ts`
Expected: FAIL — `computePlannedBuyUsdcForAmount`/`routeSellForAmount` not exported.

- [ ] **Step 3: Add the variants** to `agent/src/services/trade-routing.ts`

Insert after the existing `computePlannedBuyUsdc` function:

```ts
/** Like computePlannedBuyUsdc but with an explicit requested USDC amount (per-strategy). */
export function computePlannedBuyUsdcForAmount(
  agent: { tier2Max: number; dailyBudget: number; spentToday: number },
  usdcBalance: number,
  requestedUsdc: number
): number {
  const dailyLeft = remainingDailyBudgetUsd(agent);
  const spendable = Math.max(0, usdcBalance - USDC_BALANCE_RESERVE);
  return Math.min(requestedUsdc, agent.tier2Max, dailyLeft, spendable);
}
```

Then refactor the existing `computePlannedBuyUsdc` to delegate (keeps current callers identical):

```ts
export function computePlannedBuyUsdc(
  agent: {
    tier1Max: number;
    tier2Max: number;
    dailyBudget: number;
    spentToday: number;
    buyAmountUsdc: number;
  },
  usdcBalance: number
): number {
  return computePlannedBuyUsdcForAmount(agent, usdcBalance, agent.buyAmountUsdc);
}
```

Add a sell variant after `routeSell`:

```ts
/** Like routeSell but with an explicit XLM amount (per-strategy). */
export function routeSellForAmount(
  agent: { tier1Max: number; tier2Max: number },
  sellAmountXlm: number,
  currentXlmPriceUsd: number
): SellRoute {
  if (agent.tier2Max <= 0 || agent.tier1Max <= 0) {
    return { kind: 'skip', reason: 'Tier limits not configured' };
  }
  if (agent.tier1Max >= agent.tier2Max) {
    return { kind: 'skip', reason: 'Invalid rules: tier2 max must exceed tier1 max' };
  }
  if (!Number.isFinite(sellAmountXlm) || sellAmountXlm <= 0) {
    return { kind: 'skip', reason: 'Sell amount not configured' };
  }
  const notionalUsd = sellAmountXlm * currentXlmPriceUsd;
  const xlmStr = floorUsdcAmount(sellAmountXlm);
  if (notionalUsd <= agent.tier1Max) return { kind: 'tier1_auto', xlm: xlmStr };
  if (notionalUsd <= agent.tier2Max) return { kind: 'tier2_confirm', xlm: xlmStr };
  return { kind: 'blocked', reason: 'Sell size exceeds tier 2 maximum' };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent && node --import tsx --test __tests__/trade-routing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/services/trade-routing.ts agent/__tests__/trade-routing.test.ts
git commit -m "feat(agent): amount-parameterized buy/sell routing for strategies"
```

---

## Task 5: Add `strategies[]` to the Agent schema

**Files:**
- Modify: `agent/src/services/db.ts`

- [ ] **Step 1: Add the `IStrategy` interface** to `agent/src/services/db.ts` — insert above `export interface IAgent`:

```ts
import { StrategyType, StrategyRole } from './strategy-types';

export interface IStrategy {
  _id?: Types.ObjectId;
  type: StrategyType;
  role: StrategyRole;
  enabled: boolean;
  /** Type-specific numeric params (see STRATEGY_DEFAULTS). */
  params: Record<string, number>;
  lastRunAt: Date | null;
  createdAt?: Date;
}
```

- [ ] **Step 2: Add `strategies` to the `IAgent` interface** — add this field inside `IAgent` (after `totalSuccessfulTrades`):

```ts
  /** Role-based strategy stack. Empty for legacy agents until migrated. */
  strategies: Types.DocumentArray<IStrategy & Document>;
```

- [ ] **Step 3: Define the subdocument schema + field** — in `agent/src/services/db.ts`, add a `StrategySubSchema` just before `const AgentSchema`:

```ts
const StrategySubSchema = new Schema<IStrategy>(
  {
    type: { type: String, required: true, enum: ['dca', 'dip_buy', 'take_profit', 'stop_loss'] },
    role: { type: String, required: true, enum: ['accumulate', 'sell', 'protect'] },
    enabled: { type: Boolean, default: true },
    params: { type: Schema.Types.Mixed, default: {} },
    lastRunAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
```

Then add the field inside the `AgentSchema` definition (after `totalSuccessfulTrades`):

```ts
  strategies: { type: [StrategySubSchema], default: [] },
```

- [ ] **Step 4: Typecheck**

Run: `cd agent && npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 5: Commit**

```bash
git add agent/src/services/db.ts
git commit -m "feat(agent): add strategies[] subdocument to Agent schema"
```

---

## Task 6: Drive the worker from the strategy engine

**Files:**
- Modify: `agent/src/services/worker-manager.ts`

Replace the price-threshold-specific `getSignal` / `handleBuySignal` / `handleSellSignal` with engine evaluation. Preserve: same-zone Tier-1 cooldown, Tier-2 prompt-on-entry, daily-cap accounting, AgentLog writes, Telegram notifications, and the pending-tier2 claim model. Add: persist DCA `lastRunAt` after a successful buy.

- [ ] **Step 1: Add imports** at the top of `agent/src/services/worker-manager.ts`:

```ts
import { Types } from 'mongoose';
import { evaluateStrategies, selectAction, type StrategyAction } from './strategy-engine';
import type { StrategyConfig } from './strategy-types';
import { computePlannedBuyUsdcForAmount, routeBuy, routeSellForAmount } from './trade-routing';
```

(Keep the existing `computePlannedBuyUsdc`/`routeBuy`/`routeSell` import line; you may consolidate to import all four from `./trade-routing`.)

- [ ] **Step 2: Add a helper to read strategies off the Mongo doc** — add as a `private static` method on `WorkerManager`:

```ts
  /** Map Mongo subdocs → plain StrategyConfig the pure engine understands. */
  private static readStrategies(fresh: any): StrategyConfig[] {
    const raw = Array.isArray(fresh.strategies) ? fresh.strategies : [];
    return raw.map((s: any) => ({
      id: String(s._id),
      type: s.type,
      role: s.role,
      enabled: !!s.enabled,
      params: (s.params ?? {}) as Record<string, number>,
      lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
    }));
  }
```

- [ ] **Step 3: Replace the body of the `setInterval` callback** in `startAgentWorker`. Find the block from `const signal = this.getSignal(...)` through the end of the `if (direction === 'buy_xlm') { ... } else { ... }` dispatch, and replace it with:

```ts
        const strategies = this.readStrategies(fresh);
        const action = selectAction(
          evaluateStrategies(strategies, { priceUsd: currentPrice, now: Date.now() })
        );

        const signal: PriceSignal = action ? action.direction : 'none';
        const previousSignal = this.lastSignalByAgent.get(fresh.id) ?? 'none';
        this.lastSignalByAgent.set(fresh.id, signal);

        if (!action) {
          this.pendingTier2ByAgent.delete(fresh.id);
          clearPendingTier2Trade(fresh.id);
          return;
        }

        if (action.direction === 'buy_xlm') {
          await this.handleBuyAction(fresh, chainService, action, currentPrice, previousSignal, parseFloat(balances.usdc) || 0);
        } else {
          await this.handleSellAction(fresh, chainService, action, currentPrice, previousSignal);
        }
```

(Delete the now-unused `getSignal` method.)

- [ ] **Step 4: Replace `handleBuySignal` with `handleBuyAction`** (same logic, but the amount comes from the action and DCA persists `lastRunAt`):

```ts
  private static async handleBuyAction(
    agent: any,
    chainService: ReturnType<typeof ChainFactory.getService>,
    action: Extract<StrategyAction, { direction: 'buy_xlm' }>,
    currentPrice: number,
    previousSignal: PriceSignal,
    usdcBalance: number
  ) {
    const planned = computePlannedBuyUsdcForAmount(agent, usdcBalance, action.amountUsdc);
    const route = routeBuy(agent, planned);

    if (route.kind === 'skip' || route.kind === 'blocked') {
      console.log(`Buy ${route.kind} for agent ${agent.id} (${action.type}): ${route.reason}`);
      return;
    }

    const autoWithoutPrompt =
      route.kind === 'tier1_auto' ||
      (route.kind === 'tier2_confirm' && !agent.requireTradeConfirmation);

    if (autoWithoutPrompt) {
      const sameZone = previousSignal === 'buy_xlm';
      if (sameZone) {
        const lastAuto = this.lastTier1AutoTradeAtByAgent.get(agent.id) ?? 0;
        if (Date.now() - lastAuto < TIER1_SAME_ZONE_COOLDOWN_MS) return;
      }
      const tierLabel = route.kind === 'tier1_auto' ? 'Tier 1' : 'Tier 2 (auto, no confirm)';
      try {
        const txHash = await chainService.executeSwap(decryptAgentSecret(agent), 'buy_xlm', route.usdc);
        await recordSuccessfulBuy(agent.id, route.usdcNum);
        if (action.type === 'dca') {
          await Agent.updateOne(
            { _id: agent._id, 'strategies._id': new Types.ObjectId(action.strategyId) },
            { $set: { 'strategies.$.lastRunAt': new Date() } }
          );
        }
        await AgentLog.create({
          agentId: agent._id, telegramId: agent.telegramId, workerAddress: agent.agentAddress,
          eventType: 'trade', status: 'success', token: agent.token,
          amount: `Buy XLM (${route.usdc} USDC) [${action.type}]`, txHash,
        });
        await bot.telegram.sendMessage(
          agent.telegramId,
          `✅ ${tierLabel} ${action.type} buy\nAmount: ${route.usdc} USDC\nXLM price: ${currentPrice} USD\nTx: ${txHash}`
        );
        this.lastTier1AutoTradeAtByAgent.set(agent.id, Date.now());
      } catch (tradeErr) {
        const reason = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
        await AgentLog.create({
          agentId: agent._id, telegramId: agent.telegramId, workerAddress: agent.agentAddress,
          eventType: 'trade', status: 'failure', token: agent.token,
          amount: `Buy XLM (${route.usdc} USDC) [${action.type}]`, reason,
        });
        console.error(`${tierLabel} ${action.type} buy failed for agent ${agent.id}:`, tradeErr);
        try {
          await bot.telegram.sendMessage(agent.telegramId, `❌ ${action.type} buy failed\nAmount: ${route.usdc} USDC\nReason: ${reason}`);
        } catch (msgErr) {
          console.error('Failed to notify user of trade failure:', msgErr);
        }
      }
      return;
    }

    // tier2_confirm — prompt only when entering the buy zone
    if (previousSignal === 'buy_xlm') return;
    if (this.pendingTier2ByAgent.get(agent.id) === 'buy_xlm') return;
    this.pendingTier2ByAgent.set(agent.id, 'buy_xlm');
    setPendingTier2Trade(agent.id, { direction: 'buy_xlm', buyUsdc: route.usdc });
    await bot.telegram.sendMessage(
      agent.telegramId,
      `Current xlm price is ${currentPrice} usd, buy ${route.usdc} USDC? (${action.type})\nAmount: ${route.usdc} USDC`,
      { reply_markup: { inline_keyboard: [[
        { text: 'Confirm', callback_data: `confirm_buy:${agent.id}` },
        { text: 'Reject', callback_data: `reject_trade:${agent.id}` },
      ]] } }
    );
  }
```

- [ ] **Step 5: Replace `handleSellSignal` with `handleSellAction`** (amount from the action, via `routeSellForAmount`):

```ts
  private static async handleSellAction(
    agent: any,
    chainService: ReturnType<typeof ChainFactory.getService>,
    action: Extract<StrategyAction, { direction: 'sell_xlm' }>,
    currentPrice: number,
    previousSignal: PriceSignal
  ) {
    const route = routeSellForAmount(agent, action.amountXlm, currentPrice);
    if (route.kind === 'skip' || route.kind === 'blocked') {
      console.log(`Sell ${route.kind} for agent ${agent.id} (${action.type}): ${route.reason}`);
      return;
    }

    const autoWithoutPrompt =
      route.kind === 'tier1_auto' ||
      (route.kind === 'tier2_confirm' && !agent.requireTradeConfirmation);

    if (autoWithoutPrompt) {
      const sameZone = previousSignal === 'sell_xlm';
      if (sameZone) {
        const lastAuto = this.lastTier1AutoTradeAtByAgent.get(agent.id) ?? 0;
        if (Date.now() - lastAuto < TIER1_SAME_ZONE_COOLDOWN_MS) return;
      }
      const tierLabel = route.kind === 'tier1_auto' ? 'Tier 1' : 'Tier 2 (auto, no confirm)';
      try {
        const txHash = await chainService.executeSwap(decryptAgentSecret(agent), 'sell_xlm', route.xlm);
        await recordSuccessfulSell(agent.id);
        await AgentLog.create({
          agentId: agent._id, telegramId: agent.telegramId, workerAddress: agent.agentAddress,
          eventType: 'trade', status: 'success', token: agent.token,
          amount: `Sell XLM (${route.xlm} XLM) [${action.type}]`, txHash,
        });
        await bot.telegram.sendMessage(
          agent.telegramId,
          `✅ ${tierLabel} ${action.type} sell\nAmount: ${route.xlm} XLM\nXLM price: ${currentPrice} USD\nTx: ${txHash}`
        );
        this.lastTier1AutoTradeAtByAgent.set(agent.id, Date.now());
      } catch (tradeErr) {
        const reason = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
        await AgentLog.create({
          agentId: agent._id, telegramId: agent.telegramId, workerAddress: agent.agentAddress,
          eventType: 'trade', status: 'failure', token: agent.token,
          amount: `Sell XLM (${route.xlm} XLM) [${action.type}]`, reason,
        });
        console.error(`${tierLabel} ${action.type} sell failed for agent ${agent.id}:`, tradeErr);
        try {
          await bot.telegram.sendMessage(agent.telegramId, `❌ ${action.type} sell failed\nAmount: ${route.xlm} XLM\nReason: ${reason}`);
        } catch (msgErr) {
          console.error('Failed to notify user of trade failure:', msgErr);
        }
      }
      return;
    }

    if (previousSignal === 'sell_xlm') return;
    if (this.pendingTier2ByAgent.get(agent.id) === 'sell_xlm') return;
    this.pendingTier2ByAgent.set(agent.id, 'sell_xlm');
    setPendingTier2Trade(agent.id, { direction: 'sell_xlm', sellXlm: route.xlm });
    await bot.telegram.sendMessage(
      agent.telegramId,
      `Current xlm price is ${currentPrice} usd, sell ${route.xlm} XLM? (${action.type})\nAmount: ${route.xlm} XLM`,
      { reply_markup: { inline_keyboard: [[
        { text: 'Confirm', callback_data: `confirm_sell:${agent.id}` },
        { text: 'Reject', callback_data: `reject_trade:${agent.id}` },
      ]] } }
    );
  }
```

- [ ] **Step 6: Typecheck + run the full unit suite**

Run: `cd agent && npm run typecheck && npm run test:node`
Expected: typecheck PASS; all `node:test` suites PASS (engine, mapping, routing, plus the pre-existing ones still referenced in `test:node`).

> Note: the Tier-2 confirm handlers in `bot.ts` (`confirm_buy`/`confirm_sell` callback) and `routes/v1.ts` are unchanged — they still execute the pending swap by `agentId` and remain valid since the worker still uses `setPendingTier2Trade`/`pendingTier2ByAgent` exactly as before.

- [ ] **Step 7: Commit**

```bash
git add agent/src/services/worker-manager.ts
git commit -m "feat(agent): evaluate the strategy stack on the worker tick"
```

---

## Task 7: `/v1/strategies` CRUD endpoints

**Files:**
- Modify: `agent/src/routes/v1.ts`
- Test: `agent/__tests__/strategies-routes.test.ts`

The validation logic is extracted into a pure helper so it can be unit-tested without Express/Mongo (mirroring `pending-tier2-routes.test.ts`).

- [ ] **Step 1: Write the failing test**

Create `agent/__tests__/strategies-routes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNewStrategy } from '../src/routes/strategy-validation';
import type { StrategyConfig } from '../src/services/strategy-types';

const existing: StrategyConfig[] = [
  { id: 'dca1', type: 'dca', role: 'accumulate', enabled: true, params: { intervalMin: 60, amountUsdc: 1 }, lastRunAt: null },
];

test('rejects unknown type', () => {
  const r = validateNewStrategy({ type: 'martingale', params: {} } as any, []);
  assert.equal(r.ok, false);
  assert.match(r.error!, /type/);
});

test('fills role from type and accepts a valid take_profit', () => {
  const r = validateNewStrategy({ type: 'take_profit', enabled: true, params: { sellAboveUsd: 0.5, sellAmountXlm: 1 } }, []);
  assert.equal(r.ok, true);
  assert.equal(r.value!.role, 'sell');
});

test('rejects a 2nd enabled accumulate (single-accumulate invariant)', () => {
  const r = validateNewStrategy({ type: 'dip_buy', enabled: true, params: { buyBelowUsd: 0.1, amountUsdc: 1 } }, existing);
  assert.equal(r.ok, false);
  assert.match(r.error!, /accumulate/);
});

test('allows a disabled accumulate even when one is already enabled', () => {
  const r = validateNewStrategy({ type: 'dip_buy', enabled: false, params: { buyBelowUsd: 0.1, amountUsdc: 1 } }, existing);
  assert.equal(r.ok, true);
});

test('rejects non-finite params', () => {
  const r = validateNewStrategy({ type: 'dca', enabled: true, params: { intervalMin: NaN, amountUsdc: 1 } }, []);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && node --import tsx --test __tests__/strategies-routes.test.ts`
Expected: FAIL — `../src/routes/strategy-validation` not found.

- [ ] **Step 3: Create the validation helper**

Create `agent/src/routes/strategy-validation.ts`:

```ts
import { StrategyType, STRATEGY_DEFAULTS, NewStrategyInput, StrategyConfig } from '../services/strategy-types';
import { wouldViolateSingleAccumulate } from '../services/strategy-engine';

const REQUIRED_PARAMS: Record<StrategyType, string[]> = {
  dca: ['intervalMin', 'amountUsdc'],
  dip_buy: ['buyBelowUsd', 'amountUsdc'],
  take_profit: ['sellAboveUsd', 'sellAmountXlm'],
  stop_loss: ['sellBelowUsd', 'sellAmountXlm'],
};

export interface ValidationResult {
  ok: boolean;
  value?: NewStrategyInput;
  error?: string;
}

export function validateNewStrategy(
  body: { type?: string; enabled?: boolean; params?: Record<string, unknown> },
  existing: StrategyConfig[]
): ValidationResult {
  const type = body.type as StrategyType;
  if (!type || !(type in STRATEGY_DEFAULTS)) {
    return { ok: false, error: 'Invalid or missing strategy type' };
  }
  const role = STRATEGY_DEFAULTS[type].role;
  const enabled = body.enabled !== false; // default enabled
  const required = REQUIRED_PARAMS[type];
  const params: Record<string, number> = {};
  for (const key of required) {
    const n = Number((body.params ?? {})[key]);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `Invalid or missing param "${key}" for ${type}` };
    }
    params[key] = n;
  }
  if (wouldViolateSingleAccumulate(existing, { role, enabled })) {
    return { ok: false, error: 'Only one enabled accumulate strategy is allowed; pause the other first' };
  }
  return { ok: true, value: { type, role, enabled, params, lastRunAt: null } };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent && node --import tsx --test __tests__/strategies-routes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the endpoints** into `agent/src/routes/v1.ts`. Add imports near the top:

```ts
import { validateNewStrategy } from './strategy-validation';
import { wouldViolateSingleAccumulate } from '../services/strategy-engine';
import type { StrategyConfig } from '../services/strategy-types';
```

Add a small reader helper near `publicRules`:

```ts
function readStrategies(agent: any): StrategyConfig[] {
  const raw = Array.isArray(agent.strategies) ? agent.strategies : [];
  return raw.map((s: any) => ({
    id: String(s._id), type: s.type, role: s.role, enabled: !!s.enabled,
    params: (s.params ?? {}) as Record<string, number>,
    lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
  }));
}

function publicStrategy(s: any) {
  return { id: String(s._id), type: s.type, role: s.role, enabled: !!s.enabled, params: s.params ?? {}, lastRunAt: s.lastRunAt ?? null };
}
```

Add the four routes inside `createV1Router()` (after the `/rules` routes, before `/metrics`):

```ts
  // GET /v1/strategies/:address — list strategies for the agent
  router.get('/strategies/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address }).lean();
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!assertOwnsAgent(req, res, (agent as any).targetWallet)) return;
    return res.json((agent as any).strategies?.map(publicStrategy) ?? []);
  });

  // POST /v1/strategies/:address — add a strategy
  router.post('/strategies/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;

    const result = validateNewStrategy(req.body ?? {}, readStrategies(agent));
    if (!result.ok) return res.status(400).json({ error: result.error });

    (agent as any).strategies.push(result.value);
    await agent.save();
    if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);
    const created = (agent as any).strategies[(agent as any).strategies.length - 1];
    return res.status(201).json(publicStrategy(created));
  });

  // PUT /v1/strategies/:address/:strategyId — update params / toggle enabled
  router.put('/strategies/:address/:strategyId', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;

    const sub = (agent as any).strategies.id(req.params.strategyId);
    if (!sub) return res.status(404).json({ error: 'Strategy not found' });

    const willEnable = req.body?.enabled !== undefined ? !!req.body.enabled : sub.enabled;
    if (willEnable && sub.role === 'accumulate') {
      const others = readStrategies(agent).filter((s) => s.id !== String(sub._id));
      if (wouldViolateSingleAccumulate(others, { role: 'accumulate', enabled: true })) {
        return res.status(400).json({ error: 'Only one enabled accumulate strategy is allowed; pause the other first' });
      }
    }
    if (req.body?.enabled !== undefined) sub.enabled = !!req.body.enabled;
    if (req.body?.params && typeof req.body.params === 'object') {
      for (const [k, v] of Object.entries(req.body.params)) {
        const n = Number(v);
        if (!Number.isFinite(n)) return res.status(400).json({ error: `Invalid param ${k}` });
        sub.params[k] = n;
      }
      sub.markModified('params');
    }
    await agent.save();
    if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);
    return res.json(publicStrategy(sub));
  });

  // DELETE /v1/strategies/:address/:strategyId
  router.delete('/strategies/:address/:strategyId', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;
    const sub = (agent as any).strategies.id(req.params.strategyId);
    if (!sub) return res.status(404).json({ error: 'Strategy not found' });
    sub.deleteOne();
    await agent.save();
    if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);
    return res.json({ ok: true });
  });
```

Also register `DELETE` in the CORS methods list in `agent/src/index.ts` — change `methods: ['GET', 'POST', 'PUT', 'OPTIONS']` to `methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']`.

- [ ] **Step 6: Typecheck**

Run: `cd agent && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/src/routes/v1.ts agent/src/routes/strategy-validation.ts agent/src/index.ts agent/__tests__/strategies-routes.test.ts
git commit -m "feat(agent): /v1/strategies CRUD with single-accumulate invariant"
```

---

## Task 8: Re-point `/v1/rules` onto the strategies (extension backward-compat)

**Files:**
- Modify: `agent/src/routes/v1.ts`

Keep the exact request/response shape the extension expects, but source/sink the data through the strategy mapping so the legacy form keeps working against the new model.

- [ ] **Step 1: Add the mapping import** to `agent/src/routes/v1.ts`:

```ts
import { strategiesToFlatRules, applyFlatRulesToStrategies } from '../services/strategy-mapping';
```

- [ ] **Step 2: Replace the GET `/rules/:address` handler body** so it derives the flat shape from strategies (falling back to flat fields only if no strategies exist yet — pre-migration safety):

```ts
  router.get('/rules/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address }).lean();
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!assertOwnsAgent(req, res, (agent as any).targetWallet)) return;

    const strategies = readStrategies(agent);
    const flat = strategies.length > 0
      ? strategiesToFlatRules(strategies)
      : { buyBelowUsd: (agent as any).buyBelowUsd, sellAboveUsd: (agent as any).sellAboveUsd, buyAmountUsdc: (agent as any).buyAmountUsdc, sellAmountXlm: (agent as any).sellAmountXlm };

    return res.json({ agentAddress: (agent as any).agentAddress, tier1Max: (agent as any).tier1Max, tier2Max: (agent as any).tier2Max, dailyBudget: (agent as any).dailyBudget, ...flat });
  });
```

- [ ] **Step 3: Update the PUT `/rules/:address` handler** so tier/budget keys still write the agent fields, while `buyBelowUsd`/`sellAboveUsd`/`buyAmountUsdc`/`sellAmountXlm` are folded into the dip_buy + take_profit strategies. Replace the final update block (from `const updated = await Agent.findOneAndUpdate(...)` to the `return res.json(...)`) with:

```ts
    // Split the validated `updates` into agent-level (tier/budget) vs strategy-level (price rules).
    const agentLevel: Record<string, number> = {};
    for (const k of ['tier1Max', 'tier2Max', 'dailyBudget'] as const) {
      if (updates[k] !== undefined) agentLevel[k] = updates[k]!;
    }
    const flatBody: Record<string, number> = {};
    for (const k of ['buyBelowUsd', 'sellAboveUsd', 'buyAmountUsdc', 'sellAmountXlm'] as const) {
      if (updates[k] !== undefined) flatBody[k] = updates[k]!;
    }

    if (Object.keys(agentLevel).length > 0) agent.set(agentLevel);
    if (Object.keys(flatBody).length > 0) {
      const nextStrategies = applyFlatRulesToStrategies(readStrategies(agent), flatBody);
      (agent as any).strategies = nextStrategies as any;
    }
    await agent.save();

    if (agent.active && agent.usdcTrustlineReady !== false) {
      WorkerManager.startAgentWorker(agent);
    }

    const flat = strategiesToFlatRules(readStrategies(agent));
    return res.json({ agentAddress: agent.agentAddress, tier1Max: agent.tier1Max, tier2Max: agent.tier2Max, dailyBudget: agent.dailyBudget, ...flat });
```

> The existing `validateTierOrder` / `sellAbove > buyBelow` / positive-amount validations above this block stay as-is; they still guard the incoming body.

- [ ] **Step 4: Typecheck + full unit suite**

Run: `cd agent && npm run typecheck && npm run test:node`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/routes/v1.ts
git commit -m "feat(agent): back /v1/rules with the strategy mapping (extension compat)"
```

---

## Task 9: Migration script for existing agents

**Files:**
- Create: `agent/scripts/migrate-strategies.ts`

- [ ] **Step 1: Implement the script** — create `agent/scripts/migrate-strategies.ts`:

```ts
/**
 * One-time migration: for every agent with an empty strategies[] but legacy
 * flat rules set, synthesize dip_buy + take_profit entries. Idempotent — skips
 * agents that already have strategies. Run with:
 *   cd agent && node --import tsx scripts/migrate-strategies.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Agent, connectDB } from '../src/services/db';
import { flatRulesToStrategies } from '../src/services/strategy-mapping';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await connectDB(uri);

  const agents = await Agent.find({});
  let migrated = 0;
  for (const a of agents) {
    if (Array.isArray((a as any).strategies) && (a as any).strategies.length > 0) continue;
    const synthesized = flatRulesToStrategies({
      buyBelowUsd: (a as any).buyBelowUsd,
      sellAboveUsd: (a as any).sellAboveUsd,
      buyAmountUsdc: (a as any).buyAmountUsdc,
      sellAmountXlm: (a as any).sellAmountXlm,
    });
    if (synthesized.length === 0) continue;
    (a as any).strategies = synthesized as any;
    await a.save();
    migrated++;
    console.log(`Migrated ${a.agentAddress}: ${synthesized.map((s) => s.type).join(', ')}`);
  }
  console.log(`Done. Migrated ${migrated} of ${agents.length} agents.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Typecheck the script**

Run: `cd agent && npx tsc --noEmit -p tsconfig.scripts.json` (the repo's script tsconfig) — Expected: PASS. If `migrate-strategies.ts` isn't picked up, confirm `tsconfig.scripts.json` includes `scripts/**/*`.

- [ ] **Step 3: Commit**

```bash
git add agent/scripts/migrate-strategies.ts
git commit -m "feat(agent): one-time strategies migration script"
```

---

## Task 10: Register tests + green full suite

**Files:**
- Modify: `agent/package.json`

- [ ] **Step 1: Add the new suites to `test:node`** — update the `test:node` script in `agent/package.json` to include the four new files:

```json
    "test:node": "node --import tsx --test __tests__/auth.test.ts __tests__/narrate-log-guardrail.test.ts __tests__/pending-tier2-routes.test.ts __tests__/agent-metrics.test.ts __tests__/account-errors.test.ts __tests__/strategy-engine.test.ts __tests__/strategy-mapping.test.ts __tests__/trade-routing.test.ts __tests__/strategies-routes.test.ts",
```

- [ ] **Step 2: Run the entire test + typecheck gate**

Run: `cd agent && npm run typecheck && npm test`
Expected: typecheck PASS; `test:node` PASS (all suites incl. the 4 new); `test:jest` PASS (unchanged crypto suite).

- [ ] **Step 3: Commit**

```bash
git add agent/package.json
git commit -m "test(agent): register strategy framework test suites"
```

---

## Task 11: Integration verification on testnet (manual)

**Files:** none (verification only)

- [ ] **Step 1: Boot the stack**

Run (repo root): `docker compose up -d && docker compose logs -f agent-backend`
Expected: `MongoDB connected`, `Telegram bot launching...`, `Started N agent workers`.

- [ ] **Step 2: Migrate any existing agents**

Run: `cd agent && node --import tsx scripts/migrate-strategies.ts`
Expected: prints migrated agents (or `Migrated 0` on a fresh DB).

- [ ] **Step 3: Confirm the existing extension still works**

Open the extension → Agent Configuration. Expected: the price-rule fields load (GET `/v1/rules`) and Save succeeds (PUT `/v1/rules`) — proving backward-compat. Verify via `GET /v1/strategies/:agentAddress` (authed) that a `dip_buy` and/or `take_profit` now exists.

- [ ] **Step 4: Add a DCA strategy via the API and watch it fire**

With a funded, trustline-ready testnet agent (per `CLAUDE.md` Run section), POST a 2-minute DCA whose amount is ≤ `tier1Max` (so it auto-executes):

```
POST /v1/strategies/<agentAddress>
{ "type": "dca", "enabled": true, "params": { "intervalMin": 2, "amountUsdc": 0.5 } }
```

Expected within ~2–3 worker ticks: an `AgentLog` success entry `Buy XLM (... USDC) [dca]`, a Telegram "✅ Tier 1 dca buy" message, the strategy's `lastRunAt` advances (re-GET `/v1/strategies`), and it repeats every ~2 minutes until the daily cap is hit. Confirm `spentToday` increments and stops at `dailyBudget`.

- [ ] **Step 5: Verify the stack is conflict-free**

Add `take_profit` (sellAbove just under current price so it triggers) alongside DCA. Expected: on a tick where both are due, the **sell** fires (priority) and DCA waits a tick — visible in the logs/notifications. Add `stop_loss` with `sellBelowUsd` above current price; expected: it fires first (protect priority).

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "chore(agent): testnet verification fixups for strategy framework"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §5 data model → Task 5; §6 engine → Tasks 2,6; §7 DCA → Tasks 2,6,11; §8 catalog → Tasks 1,7; §10 API + `/v1/rules` compat → Tasks 7,8; §11 migration → Tasks 3,9; §12 safety/invariants → Tasks 2,6,7 (single-accumulate, priority, one-trade-per-tick preserved; Tier-2 confirm path untouched); §13 tests → Tasks 1–4,7,10. §9 Telegram UX is intentionally **deferred to Plan 2** (noted in the header).
- **Placeholder scan:** none — every code/test step contains complete content.
- **Type consistency:** `StrategyConfig.id` (string of subdoc `_id`) is read consistently via `readStrategies` in both `worker-manager.ts` and `v1.ts`; `evaluateStrategies`/`selectAction`/`StrategyAction` signatures match between `strategy-engine.ts` and its callers; `computePlannedBuyUsdcForAmount`/`routeSellForAmount` signatures match between `trade-routing.ts` and `worker-manager.ts`; mapping function names match between `strategy-mapping.ts`, its test, and `v1.ts`.
