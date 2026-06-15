# Agent Strategy Framework — Telegram UX Redesign (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on Plan 1** (`2026-06-13-agent-strategy-framework-dca-backend.md`) — the `strategies[]` schema, `strategy-types.ts`, `strategy-engine.ts`, and the worker engine MUST be implemented first.

**Goal:** Replace the 7-step typed `/setrules` interrogation with a button-driven Telegram flow — main menu, an Add-Strategy wizard (DCA in two taps), a one-tap "Accumulator" preset, and a live "My Strategies" manager (pause / enable / remove) — so configuring the agent (incl. DCA) is friendly.

**Architecture:** All keyboard layouts and wizard state transitions live in a **pure** `telegram-menu.ts` module (unit-tested with `node:test`). `bot.ts` becomes a thin adapter: a single `callback_query` dispatcher routes by `action` prefix, calls the pure helpers to compute the next screen, and performs DB side effects (add/toggle/remove a strategy on the `Agent` doc, then `WorkerManager.startAgentWorker`). The existing Tier-2 trade-confirm callbacks (`confirm_buy`/`confirm_sell`/`reject_trade`) are preserved verbatim, just moved behind the dispatcher.

**Tech Stack:** Telegraf 4 inline keyboards, TypeScript, Mongoose. Tests: `node:test` via `tsx` (`npm run test:node`).

**Spec:** `docs/superpowers/specs/2026-06-13-agent-strategy-framework-dca-design.md` (§9).

---

## File Structure (decomposition)

**New files (under `agent/`):**
- `src/services/telegram-menu.ts` — pure: `parseCallback`, keyboard builders, the add-strategy wizard state machine, strategy-list renderer, and the Accumulator preset builder. No Telegraf, no DB.
- `__tests__/telegram-menu.test.ts` — `node:test` suite for the pure module.

**Modified files:**
- `src/services/bot.ts` — add `/menu`; rewrite `bot.start`; add a prefix-routing `callback_query` dispatcher; add the wizard `bot.on('text')` capture; retire the `/setrules` text FSM (`setRulesSessions`) to a menu shim.
- `package.json` — register `telegram-menu.test.ts` in `test:node`.

**Callback-data scheme** (all `action:arg`): `menu:main|strategies|add|limits|status` · `add:<type>` · `dca_int:<minutes>` · `dca_amt:<usdc>` · `review:activate|cancel` · `strat_toggle:<id>` · `strat_remove:<id>` · `preset:accumulator` · plus the **unchanged** `confirm_buy:<agentId>` / `confirm_sell:<agentId>` / `reject_trade:<agentId>`.

---

## Task 1: Pure `telegram-menu` module (keyboards + wizard state machine)

**Files:**
- Create: `agent/src/services/telegram-menu.ts`
- Test: `agent/__tests__/telegram-menu.test.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/__tests__/telegram-menu.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCallback,
  mainMenuKeyboard,
  addTypeKeyboard,
  dcaIntervalKeyboard,
  dcaAmountKeyboard,
  startAddSession,
  applyDcaInterval,
  applyDcaAmount,
  applyTypedPrice,
  sessionToNewStrategy,
  reviewText,
  strategyListText,
  strategyListKeyboard,
  presetAccumulatorInputs,
} from '../src/services/telegram-menu';
import type { StrategyConfig } from '../src/services/strategy-types';

test('parseCallback splits action and arg on the first colon', () => {
  assert.deepEqual(parseCallback('menu:strategies'), { action: 'menu', arg: 'strategies' });
  assert.deepEqual(parseCallback('dca_amt:0.5'), { action: 'dca_amt', arg: '0.5' });
  assert.deepEqual(parseCallback('menu'), { action: 'menu', arg: undefined });
});

test('mainMenuKeyboard exposes the core actions', () => {
  const flat = mainMenuKeyboard().flat().map((b) => b.callback_data);
  assert.ok(flat.includes('menu:strategies'));
  assert.ok(flat.includes('menu:add'));
  assert.ok(flat.includes('preset:accumulator'));
});

test('addTypeKeyboard offers all four strategy types', () => {
  const flat = addTypeKeyboard().flat().map((b) => b.callback_data);
  assert.ok(flat.includes('add:dca'));
  assert.ok(flat.includes('add:dip_buy'));
  assert.ok(flat.includes('add:take_profit'));
  assert.ok(flat.includes('add:stop_loss'));
});

test('dca keyboards carry preset values', () => {
  assert.ok(dcaIntervalKeyboard().flat().some((b) => b.callback_data === 'dca_int:2'));
  assert.ok(dcaAmountKeyboard().flat().some((b) => b.callback_data.startsWith('dca_amt:')));
});

test('DCA wizard: type → interval → amount → review builds a valid strategy', () => {
  let s = startAddSession('dca');
  assert.equal(s.type, 'dca');
  assert.equal(s.step, 'interval');
  s = applyDcaInterval(s, 60);
  assert.equal(s.params.intervalMin, 60);
  assert.equal(s.step, 'amount');
  s = applyDcaAmount(s, 5);
  assert.equal(s.params.amountUsdc, 5);
  assert.equal(s.step, 'review');
  const input = sessionToNewStrategy(s);
  assert.equal(input.type, 'dca');
  assert.equal(input.role, 'accumulate');
  assert.equal(input.enabled, true);
  assert.equal(input.params.intervalMin, 60);
  assert.equal(input.params.amountUsdc, 5);
  assert.match(reviewText(s), /hourly|60/i);
});

test('Sell wizard: take_profit collects one typed price then defaults the amount', () => {
  let s = startAddSession('take_profit');
  assert.equal(s.step, 'price');
  s = applyTypedPrice(s, 0.55);
  assert.equal(s.params.sellAboveUsd, 0.55);
  assert.ok(s.params.sellAmountXlm > 0, 'sell amount defaulted');
  assert.equal(s.step, 'review');
  assert.equal(sessionToNewStrategy(s).role, 'sell');
});

test('strategy list renders a line + toggle/remove buttons per strategy', () => {
  const strategies: StrategyConfig[] = [
    { id: 'a', type: 'dca', role: 'accumulate', enabled: true, params: { intervalMin: 60, amountUsdc: 5 }, lastRunAt: null },
    { id: 'b', type: 'stop_loss', role: 'protect', enabled: false, params: { sellBelowUsd: 0.08, sellAmountXlm: 1 }, lastRunAt: null },
  ];
  const text = strategyListText(strategies);
  assert.match(text, /dca/i);
  const cbs = strategyListKeyboard(strategies).flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('strat_toggle:a'));
  assert.ok(cbs.includes('strat_remove:a'));
  assert.ok(cbs.includes('strat_toggle:b'));
});

test('strategy list handles the empty case', () => {
  assert.match(strategyListText([]), /no strategies/i);
});

test('presetAccumulatorInputs returns DCA + take_profit + stop_loss with exactly one enabled accumulate', () => {
  const inputs = presetAccumulatorInputs();
  assert.equal(inputs.length, 3);
  assert.equal(inputs.filter((i) => i.role === 'accumulate' && i.enabled).length, 1);
  assert.ok(inputs.some((i) => i.type === 'take_profit'));
  assert.ok(inputs.some((i) => i.type === 'stop_loss'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && node --import tsx --test __tests__/telegram-menu.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure module**

Create `agent/src/services/telegram-menu.ts`:

```ts
import {
  StrategyType,
  StrategyRole,
  NewStrategyInput,
  StrategyConfig,
  STRATEGY_DEFAULTS,
  DCA_INTERVAL_PRESETS_MIN,
} from './strategy-types';

export interface InlineButton { text: string; callback_data: string; }
export type InlineKeyboard = InlineButton[][];

export const DCA_AMOUNT_PRESETS_USDC = [0.5, 1, 5, 10] as const;

export function parseCallback(data: string): { action: string; arg?: string } {
  const idx = data.indexOf(':');
  if (idx < 0) return { action: data, arg: undefined };
  return { action: data.slice(0, idx), arg: data.slice(idx + 1) };
}

function chunk(buttons: InlineButton[], perRow: number): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

export function mainMenuKeyboard(): InlineKeyboard {
  return [
    [{ text: '📊 My Strategies', callback_data: 'menu:strategies' }, { text: '➕ Add Strategy', callback_data: 'menu:add' }],
    [{ text: '⚡ Quick start: Accumulator', callback_data: 'preset:accumulator' }],
    [{ text: '⚙️ Limits & Safety', callback_data: 'menu:limits' }, { text: '💰 Status', callback_data: 'menu:status' }],
  ];
}

export function addTypeKeyboard(): InlineKeyboard {
  return [
    [{ text: '🔁 DCA — recurring buy', callback_data: 'add:dca' }],
    [{ text: '📈 Take-profit — sell high', callback_data: 'add:take_profit' }],
    [{ text: '🛡️ Stop-loss — protect', callback_data: 'add:stop_loss' }],
    [{ text: '📉 Dip-buy — buy low', callback_data: 'add:dip_buy' }],
    [{ text: '⬅︎ Back', callback_data: 'menu:main' }],
  ];
}

export function dcaIntervalKeyboard(): InlineKeyboard {
  const btns = DCA_INTERVAL_PRESETS_MIN.map((p) => ({ text: p.label, callback_data: `dca_int:${p.minutes}` }));
  return [...chunk(btns, 2), [{ text: '⬅︎ Back', callback_data: 'menu:add' }]];
}

export function dcaAmountKeyboard(): InlineKeyboard {
  const btns = DCA_AMOUNT_PRESETS_USDC.map((a) => ({ text: `$${a}`, callback_data: `dca_amt:${a}` }));
  return chunk(btns, 2);
}

export function reviewKeyboard(): InlineKeyboard {
  return [[
    { text: '✅ Activate', callback_data: 'review:activate' },
    { text: '✖︎ Cancel', callback_data: 'review:cancel' },
  ]];
}

// --- Add-strategy wizard state machine (pure) ---

export interface AddSession {
  type: StrategyType;
  role: StrategyRole;
  params: Record<string, number>;
  step: 'interval' | 'amount' | 'price' | 'review';
}

export function startAddSession(type: StrategyType): AddSession {
  const role = STRATEGY_DEFAULTS[type].role;
  if (type === 'dca') return { type, role, params: {}, step: 'interval' };
  // dip_buy / take_profit / stop_loss all begin by collecting one typed price
  return { type, role, params: {}, step: 'price' };
}

export function applyDcaInterval(s: AddSession, minutes: number): AddSession {
  return { ...s, params: { ...s.params, intervalMin: minutes }, step: 'amount' };
}

export function applyDcaAmount(s: AddSession, usdc: number): AddSession {
  return { ...s, params: { ...s.params, amountUsdc: usdc }, step: 'review' };
}

/** For dip_buy/take_profit/stop_loss: set the price param + default the trade amount, then go to review. */
export function applyTypedPrice(s: AddSession, price: number): AddSession {
  const params = { ...s.params };
  if (s.type === 'dip_buy') {
    params.buyBelowUsd = price;
    params.amountUsdc = STRATEGY_DEFAULTS.dip_buy.params.amountUsdc;
  } else if (s.type === 'take_profit') {
    params.sellAboveUsd = price;
    params.sellAmountXlm = STRATEGY_DEFAULTS.take_profit.params.sellAmountXlm;
  } else if (s.type === 'stop_loss') {
    params.sellBelowUsd = price;
    params.sellAmountXlm = STRATEGY_DEFAULTS.stop_loss.params.sellAmountXlm;
  }
  return { ...s, params, step: 'review' };
}

export function sessionToNewStrategy(s: AddSession): NewStrategyInput {
  return { type: s.type, role: s.role, enabled: true, params: { ...s.params }, lastRunAt: null };
}

export function reviewText(s: AddSession): string {
  switch (s.type) {
    case 'dca': {
      const every = s.params.intervalMin === 1440 ? 'daily' : s.params.intervalMin === 60 ? 'hourly' : s.params.intervalMin === 10080 ? 'weekly' : `every ${s.params.intervalMin} min`;
      return `Review — DCA: buy $${s.params.amountUsdc} XLM ${every}. Runs automatically within your Tier-1 limit; pauses at the daily cap.`;
    }
    case 'dip_buy': return `Review — Dip-buy: buy $${s.params.amountUsdc} XLM when price ≤ $${s.params.buyBelowUsd}.`;
    case 'take_profit': return `Review — Take-profit: sell ${s.params.sellAmountXlm} XLM when price ≥ $${s.params.sellAboveUsd}.`;
    case 'stop_loss': return `Review — Stop-loss: sell ${s.params.sellAmountXlm} XLM when price ≤ $${s.params.sellBelowUsd}.`;
  }
}

/** Prompt asking for the typed price, by type. */
export function pricePrompt(type: StrategyType): string {
  if (type === 'dip_buy') return 'Buy when the XLM price drops to or below… enter a USD price (e.g. 0.10):';
  if (type === 'take_profit') return 'Sell when the XLM price rises to or above… enter a USD price (e.g. 0.50):';
  return 'Protect: sell if the XLM price falls to or below… enter a USD price (e.g. 0.08):';
}

// --- My Strategies rendering ---

function describe(s: StrategyConfig): string {
  switch (s.type) {
    case 'dca': return `DCA · $${s.params.amountUsdc} every ${s.params.intervalMin}m`;
    case 'dip_buy': return `Dip-buy · $${s.params.amountUsdc} ≤ $${s.params.buyBelowUsd}`;
    case 'take_profit': return `Take-profit · ${s.params.sellAmountXlm} XLM ≥ $${s.params.sellAboveUsd}`;
    case 'stop_loss': return `Stop-loss · ${s.params.sellAmountXlm} XLM ≤ $${s.params.sellBelowUsd}`;
  }
}

export function strategyListText(strategies: StrategyConfig[]): string {
  if (strategies.length === 0) return 'You have no strategies yet. Tap ➕ Add Strategy or ⚡ Quick start.';
  return strategies.map((s) => `${s.enabled ? '🟢' : '⚪'} ${describe(s)}`).join('\n');
}

export function strategyListKeyboard(strategies: StrategyConfig[]): InlineKeyboard {
  const rows: InlineKeyboard = strategies.map((s) => ([
    { text: `${s.enabled ? 'Pause' : 'Enable'} ${s.type}`, callback_data: `strat_toggle:${s.id}` },
    { text: '🗑 Remove', callback_data: `strat_remove:${s.id}` },
  ]));
  rows.push([{ text: '➕ Add', callback_data: 'menu:add' }, { text: '⬅︎ Menu', callback_data: 'menu:main' }]);
  return rows;
}

// --- Accumulator preset ---

export function presetAccumulatorInputs(): NewStrategyInput[] {
  return [
    { type: 'dca', role: 'accumulate', enabled: true, lastRunAt: null, params: { intervalMin: 1440, amountUsdc: 5 } },
    { type: 'take_profit', role: 'sell', enabled: true, lastRunAt: null, params: { ...STRATEGY_DEFAULTS.take_profit.params } },
    { type: 'stop_loss', role: 'protect', enabled: true, lastRunAt: null, params: { ...STRATEGY_DEFAULTS.stop_loss.params } },
  ];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent && node --import tsx --test __tests__/telegram-menu.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/services/telegram-menu.ts agent/__tests__/telegram-menu.test.ts
git commit -m "feat(agent): pure telegram-menu module (keyboards + add-strategy wizard)"
```

---

## Task 2: Main menu + dispatcher skeleton (preserve trade confirms)

**Files:**
- Modify: `agent/src/services/bot.ts`

- [ ] **Step 1: Add imports** at the top of `agent/src/services/bot.ts`:

```ts
import { Types } from 'mongoose';
import {
  parseCallback, mainMenuKeyboard, addTypeKeyboard, dcaIntervalKeyboard,
  dcaAmountKeyboard, reviewKeyboard, startAddSession, applyDcaInterval,
  applyDcaAmount, applyTypedPrice, sessionToNewStrategy, reviewText, pricePrompt,
  strategyListText, strategyListKeyboard, presetAccumulatorInputs, type AddSession,
} from './telegram-menu';
import { wouldViolateSingleAccumulate, enabledAccumulateCount } from './strategy-engine';
import type { StrategyConfig, StrategyType } from './strategy-types';
```

- [ ] **Step 2: Add a strategies reader + a wizard session map** (near `setRulesSessions`):

```ts
const addStrategySessions = new Map<string, AddSession>();

function readAgentStrategies(agent: any): StrategyConfig[] {
  const raw = Array.isArray(agent.strategies) ? agent.strategies : [];
  return raw.map((s: any) => ({
    id: String(s._id), type: s.type, role: s.role, enabled: !!s.enabled,
    params: (s.params ?? {}) as Record<string, number>,
    lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
  }));
}

async function findActiveAgent(telegramId: string) {
  return Agent.findOne({ telegramId, active: true });
}

async function renderMainMenu(ctx: any) {
  await ctx.reply('🤖 Your Agent — pick an action:', { reply_markup: { inline_keyboard: mainMenuKeyboard() } });
}
```

- [ ] **Step 3: Add `/menu` and update `/start`** — add a `bot.command('menu', ...)` and change the non-payload branch of `bot.start` to show the menu instead of the plain `WELCOME_MESSAGE`:

```ts
bot.command('menu', async (ctx) => {
  if (!ctx.from?.id) return ctx.reply('Could not determine your Telegram user id.');
  const agent = await findActiveAgent(ctx.from.id.toString());
  if (!agent) return ctx.reply('No active agent yet. Use /createagent <target_wallet> first.');
  return renderMainMenu(ctx);
});
```

In `bot.start`, replace `return ctx.reply(WELCOME_MESSAGE);` with:

```ts
  const existing = await findActiveAgent(ctx.from!.id.toString());
  if (existing) return renderMainMenu(ctx);
  return ctx.reply(WELCOME_MESSAGE);
```

- [ ] **Step 4: Extract the existing trade-confirm logic, then add the dispatcher.** In `agent/src/services/bot.ts`, rename the current `bot.on('callback_query', async (ctx: any) => { ... })` handler to a standalone function and replace the registration with a prefix dispatcher:

```ts
// Existing Tier-2 trade confirm/reject logic — body unchanged, just extracted.
async function handleTradeConfirmCallback(ctx: any, action: string, agentId: string) {
  // <-- MOVE the entire existing callback_query body here VERBATIM, but use the
  //     `action` and `agentId` passed in instead of re-splitting ctx.callbackQuery.data.
  //     (It already does `const [action, agentId] = ctx.callbackQuery.data.split(':')`.)
}

bot.on('callback_query', async (ctx: any) => {
  const data: string = ctx.callbackQuery?.data ?? '';
  const { action, arg } = parseCallback(data);

  // Preserve the existing trade-confirm behavior.
  if (action === 'confirm_buy' || action === 'confirm_sell' || action === 'reject_trade') {
    return handleTradeConfirmCallback(ctx, action, arg ?? '');
  }

  await ctx.answerCbQuery().catch(() => {});
  try {
    switch (action) {
      case 'menu': return await handleMenu(ctx, arg);
      case 'add': return await handleAddType(ctx, arg as StrategyType);
      case 'dca_int': return await handleDcaInterval(ctx, Number(arg));
      case 'dca_amt': return await handleDcaAmount(ctx, Number(arg));
      case 'review': return await handleReview(ctx, arg);
      case 'strat_toggle': return await handleToggle(ctx, arg ?? '');
      case 'strat_remove': return await handleRemove(ctx, arg ?? '');
      case 'preset': return await handlePreset(ctx, arg);
      default: return;
    }
  } catch (e) {
    console.error('callback dispatch error:', e);
    try { await ctx.reply('Something went wrong. Try /menu again.'); } catch {}
  }
});
```

> The `handle*` functions are added in Tasks 3–5. This task only compiles once those exist, so do Steps 5 below to stub them minimally, OR implement Tasks 3–5 before typechecking. Recommended: implement Tasks 3–5, then typecheck once at the end of Task 5.

- [ ] **Step 5: Add `handleMenu`** (the only menu handler needed for this task; reuses the existing `/status` text builder):

```ts
async function handleMenu(ctx: any, which?: string) {
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent. Use /createagent first.');

  if (which === 'strategies') {
    const strategies = readAgentStrategies(agent);
    return ctx.reply(strategyListText(strategies), { reply_markup: { inline_keyboard: strategyListKeyboard(strategies) } });
  }
  if (which === 'add') {
    return ctx.reply('Pick a strategy to add:', { reply_markup: { inline_keyboard: addTypeKeyboard() } });
  }
  if (which === 'limits') {
    return ctx.reply(`Limits & Safety:\nTier-1 (auto) max: $${agent.tier1Max}\nTier-2 (confirm) max: $${agent.tier2Max}\nDaily USDC cap: $${agent.dailyBudget}\n\n(Edit limits via the extension or /setrules → menu.)`, { reply_markup: { inline_keyboard: [[{ text: '⬅︎ Menu', callback_data: 'menu:main' }]] } });
  }
  if (which === 'status') {
    return ctx.reply(`Daily USDC: ${agent.spentToday.toFixed(4)} / ${agent.dailyBudget > 0 ? agent.dailyBudget.toFixed(2) : '—'} · Lifetime trades: ${agent.totalSuccessfulTrades ?? 0} · Strategies: ${enabledAccumulateCount(readAgentStrategies(agent))} accumulate enabled`, { reply_markup: { inline_keyboard: [[{ text: '⬅︎ Menu', callback_data: 'menu:main' }]] } });
  }
  return renderMainMenu(ctx);
}
```

- [ ] **Step 6: Commit** (typecheck deferred to end of Task 5)

```bash
git add agent/src/services/bot.ts
git commit -m "feat(agent): telegram main menu + callback dispatcher (trade confirms preserved)"
```

---

## Task 3: Add-Strategy wizard handlers

**Files:**
- Modify: `agent/src/services/bot.ts`

- [ ] **Step 1: Add the wizard handlers** (`handleAddType`, `handleDcaInterval`, `handleDcaAmount`, `handleReview`) plus a shared `persistNewStrategy` helper:

```ts
async function handleAddType(ctx: any, type: StrategyType) {
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent. Use /createagent first.');

  const session = startAddSession(type);
  addStrategySessions.set(telegramId, session);

  if (type === 'dca') {
    return ctx.reply('How often should I buy?', { reply_markup: { inline_keyboard: dcaIntervalKeyboard() } });
  }
  // sell/dip → ask for the typed price (handled by bot.on('text') in Task 6)
  return ctx.reply(pricePrompt(type));
}

async function handleDcaInterval(ctx: any, minutes: number) {
  const telegramId = ctx.from.id.toString();
  const session = addStrategySessions.get(telegramId);
  if (!session || session.type !== 'dca') return ctx.reply('Start again with ➕ Add Strategy.');
  const next = applyDcaInterval(session, minutes);
  addStrategySessions.set(telegramId, next);
  return ctx.reply('How much per buy?', { reply_markup: { inline_keyboard: dcaAmountKeyboard() } });
}

async function handleDcaAmount(ctx: any, usdc: number) {
  const telegramId = ctx.from.id.toString();
  const session = addStrategySessions.get(telegramId);
  if (!session || session.type !== 'dca') return ctx.reply('Start again with ➕ Add Strategy.');
  const next = applyDcaAmount(session, usdc);
  addStrategySessions.set(telegramId, next);
  return ctx.reply(reviewText(next), { reply_markup: { inline_keyboard: reviewKeyboard() } });
}

async function handleReview(ctx: any, decision?: string) {
  const telegramId = ctx.from.id.toString();
  const session = addStrategySessions.get(telegramId);
  if (!session) return ctx.reply('Nothing to review. Tap ➕ Add Strategy.');

  if (decision === 'cancel') {
    addStrategySessions.delete(telegramId);
    return ctx.reply('Cancelled.', { reply_markup: { inline_keyboard: mainMenuKeyboard() } });
  }
  // activate
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent. Use /createagent first.');
  const input = sessionToNewStrategy(session);

  // Enforce single-accumulate: auto-switch — disable any other enabled accumulate.
  if (input.role === 'accumulate' && input.enabled) {
    if (wouldViolateSingleAccumulate(readAgentStrategies(agent), { role: 'accumulate', enabled: true })) {
      for (const s of (agent as any).strategies) {
        if (s.enabled && s.role === 'accumulate') s.enabled = false;
      }
    }
  }
  (agent as any).strategies.push(input);
  await agent.save();
  addStrategySessions.delete(telegramId);
  if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);

  return ctx.reply(`✅ Activated.\n${reviewText(session)}`, { reply_markup: { inline_keyboard: mainMenuKeyboard() } });
}
```

- [ ] **Step 2: Commit** (typecheck at end of Task 5)

```bash
git add agent/src/services/bot.ts
git commit -m "feat(agent): add-strategy wizard handlers (dca quick-picks + review/activate)"
```

---

## Task 4: My-Strategies management handlers (toggle / remove)

**Files:**
- Modify: `agent/src/services/bot.ts`

- [ ] **Step 1: Add `handleToggle` and `handleRemove`:**

```ts
async function handleToggle(ctx: any, strategyId: string) {
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent.');
  const sub = (agent as any).strategies.id(strategyId);
  if (!sub) return ctx.reply('Strategy not found.');

  const willEnable = !sub.enabled;
  if (willEnable && sub.role === 'accumulate') {
    // auto-switch: disable other enabled accumulate strategies
    for (const s of (agent as any).strategies) {
      if (String(s._id) !== strategyId && s.enabled && s.role === 'accumulate') s.enabled = false;
    }
  }
  sub.enabled = willEnable;
  await agent.save();
  if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);

  const strategies = readAgentStrategies(agent);
  return ctx.reply(strategyListText(strategies), { reply_markup: { inline_keyboard: strategyListKeyboard(strategies) } });
}

async function handleRemove(ctx: any, strategyId: string) {
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent.');
  const sub = (agent as any).strategies.id(strategyId);
  if (!sub) return ctx.reply('Strategy not found.');
  sub.deleteOne();
  await agent.save();
  if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);

  const strategies = readAgentStrategies(agent);
  return ctx.reply(`Removed.\n\n${strategyListText(strategies)}`, { reply_markup: { inline_keyboard: strategyListKeyboard(strategies) } });
}
```

- [ ] **Step 2: Commit** (typecheck at end of Task 5)

```bash
git add agent/src/services/bot.ts
git commit -m "feat(agent): My Strategies toggle/remove with accumulate auto-switch"
```

---

## Task 5: Accumulator preset + typecheck the wired bot

**Files:**
- Modify: `agent/src/services/bot.ts`

- [ ] **Step 1: Add `handlePreset`:**

```ts
async function handlePreset(ctx: any, name?: string) {
  if (name !== 'accumulator') return ctx.reply('Unknown preset.');
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent. Use /createagent first.');

  // Replace any existing enabled accumulate to honor the single-accumulate rule.
  for (const s of (agent as any).strategies) {
    if (s.enabled && s.role === 'accumulate') s.enabled = false;
  }
  for (const input of presetAccumulatorInputs()) {
    (agent as any).strategies.push(input);
  }
  await agent.save();
  if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);

  const strategies = readAgentStrategies(agent);
  return ctx.reply(`⚡ Accumulator activated:\n${strategyListText(strategies)}`, { reply_markup: { inline_keyboard: strategyListKeyboard(strategies) } });
}
```

- [ ] **Step 2: Typecheck the fully-wired bot**

Run: `cd agent && npm run typecheck`
Expected: PASS — all `handle*` functions referenced by the dispatcher now exist.

- [ ] **Step 3: Commit**

```bash
git add agent/src/services/bot.ts
git commit -m "feat(agent): one-tap Accumulator preset"
```

---

## Task 6: Capture typed inputs; retire the `/setrules` text FSM

**Files:**
- Modify: `agent/src/services/bot.ts`

The old `/setrules` walked users through 7 typed steps via `setRulesSessions` and a big `bot.on('text')` handler. We replace that text handler so it (a) feeds the new wizard's single typed-price/custom-amount step, and (b) no longer drives the retired FSM. `/setrules` becomes a shim that opens the menu.

- [ ] **Step 1: Replace the `bot.on('text', ...)` handler** entirely with the wizard-capture version:

```ts
bot.on('text', async (ctx, next) => {
  if (!ctx.from?.id) return next();
  const telegramId = ctx.from.id.toString();
  const session = addStrategySessions.get(telegramId);
  if (!session) return next();

  const text = ctx.message.text.trim();
  if (text.startsWith('/')) {
    return ctx.reply('Finish the current strategy first, or tap ✖︎ Cancel on the review card.');
  }

  // The only typed step is the price for dip_buy / take_profit / stop_loss.
  if (session.step === 'price') {
    const price = parsePositiveNumber(text);
    if (price === null) return ctx.reply('Please enter a valid positive USD price (e.g. 0.10).');
    const next2 = applyTypedPrice(session, price);
    addStrategySessions.set(telegramId, next2);
    return ctx.reply(reviewText(next2), { reply_markup: { inline_keyboard: reviewKeyboard() } });
  }

  return next();
});
```

- [ ] **Step 2: Turn `/setrules` into a menu shim** — replace the entire `bot.command('setrules', ...)` handler with:

```ts
bot.command('setrules', async (ctx) => {
  if (!ctx.from?.id) return ctx.reply('Could not determine your Telegram user id.');
  const agent = await findActiveAgent(ctx.from.id.toString());
  if (!agent) return ctx.reply('Please create an active agent first using /createagent.');
  await ctx.reply('Setup is button-driven now 🎉');
  return renderMainMenu(ctx);
});
```

- [ ] **Step 3: Delete the retired FSM** — remove the now-unused `SetRulesSession` type, the `setRulesSessions` Map, and any helper used only by the old step machine. Keep `parsePositiveNumber` (the new text handler uses it). Update the `WELCOME_MESSAGE` command list to mention `/menu` and drop the step-by-step `/setrules` description.

- [ ] **Step 4: Typecheck**

Run: `cd agent && npm run typecheck`
Expected: PASS — no references to `setRulesSessions`/`SetRulesSession` remain.

- [ ] **Step 5: Commit**

```bash
git add agent/src/services/bot.ts
git commit -m "refactor(agent): retire /setrules text FSM; menu-driven setup"
```

---

## Task 7: Register the test + green the full suite

**Files:**
- Modify: `agent/package.json`

- [ ] **Step 1: Add `telegram-menu.test.ts`** to the `test:node` script (append to the file list created in Plan 1 Task 10):

```json
    "test:node": "node --import tsx --test __tests__/auth.test.ts __tests__/narrate-log-guardrail.test.ts __tests__/pending-tier2-routes.test.ts __tests__/agent-metrics.test.ts __tests__/account-errors.test.ts __tests__/strategy-engine.test.ts __tests__/strategy-mapping.test.ts __tests__/trade-routing.test.ts __tests__/strategies-routes.test.ts __tests__/telegram-menu.test.ts",
```

- [ ] **Step 2: Run the full gate**

Run: `cd agent && npm run typecheck && npm test`
Expected: typecheck PASS; all `node:test` suites PASS (incl. `telegram-menu`); `test:jest` PASS.

- [ ] **Step 3: Commit**

```bash
git add agent/package.json
git commit -m "test(agent): register telegram-menu suite"
```

---

## Task 8: Manual Telegram verification (testnet)

**Files:** none (verification only)

> Requires a valid, non-stale `TELEGRAM_BOT_TOKEN`/hardcoded token in `bot.ts` and a funded, trustline-ready testnet agent. Per `CLAUDE.md`, the production token in `bot.ts` is a temporary hardcode — verify against a working bot before relying on this.

- [ ] **Step 1: Boot + open the bot**

Run (repo root): `docker compose up -d && docker compose logs -f agent-backend` → confirm `Telegram bot launching...`. In Telegram, send `/menu`.
Expected: the inline main menu (My Strategies · Add Strategy · Quick start · Limits · Status).

- [ ] **Step 2: Add DCA in two taps**

`➕ Add Strategy` → `DCA` → `2 min (demo)` → `$0.5` → review card → `✅ Activate`.
Expected: "Activated" + within ~2–3 min a `✅ Tier 1 dca buy` notification; `📊 My Strategies` shows `🟢 DCA · $0.5 every 2m`.

- [ ] **Step 3: Add a sell-side strategy (typed price)**

`➕ Add Strategy` → `Take-profit` → type a price just under the current XLM price → `✅ Activate`.
Expected: it sells on the next tick (priority over DCA), visible in notifications.

- [ ] **Step 4: One-tap preset**

`/menu` → `⚡ Quick start: Accumulator`.
Expected: My Strategies shows DCA + Take-profit + Stop-loss; exactly one accumulate is 🟢 (the preset disabled the prior DCA per the single-accumulate rule).

- [ ] **Step 5: Manage the stack**

In `📊 My Strategies`, `Pause` the DCA then `Enable` it; `Remove` the stop-loss. Enable a second accumulate and confirm the first auto-switches to ⚪.
Expected: list updates correctly after each tap; worker picks up changes (logs).

- [ ] **Step 6: Back-compat sanity**

`/setrules` → confirms it now just opens the menu. The extension Agent Configuration still loads/saves the price rule (Plan 1 `/v1/rules` compat).

- [ ] **Step 7: Final commit (if fixups were needed)**

```bash
git add -A && git commit -m "chore(agent): telegram UX verification fixups"
```

---

## Self-Review (completed during authoring)

- **Spec coverage (§9):** menu/dispatcher → Task 2; add-strategy wizard + quick-picks + review/activate → Tasks 1,3; Accumulator preset → Tasks 1,5; My Strategies pause/enable/remove + single-accumulate auto-switch → Tasks 1,4; in-memory wizard session + `/setrules` shim + retire text FSM → Task 6; Tier-2 confirm flow unchanged → Task 2 (extracted verbatim).
- **Placeholder scan:** the only non-literal step is Task 2 Step 4's instruction to **move existing, working trade-confirm code verbatim** into `handleTradeConfirmCallback` — this is a refactor-move of code already in `bot.ts`, not new hidden logic. Everything else is complete.
- **Type consistency:** `AddSession` shape and every `applyX`/`startAddSession`/`sessionToNewStrategy` signature match between `telegram-menu.ts`, its test, and `bot.ts`; `readAgentStrategies` returns the same `StrategyConfig` shape used in Plan 1; callback-data prefixes in `telegram-menu.ts` keyboards exactly match the `switch (action)` cases in the `bot.ts` dispatcher (`menu`/`add`/`dca_int`/`dca_amt`/`review`/`strat_toggle`/`strat_remove`/`preset`).
- **Cross-plan consistency:** reuses Plan 1's `strategy-types.ts`, `strategy-engine.ts` (`wouldViolateSingleAccumulate`, `enabledAccumulateCount`), `strategies[]` schema, and `WorkerManager.startAgentWorker` — no duplication.
```