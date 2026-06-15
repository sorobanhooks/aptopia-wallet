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

export interface AddSession {
  type: StrategyType;
  role: StrategyRole;
  params: Record<string, number>;
  step: 'interval' | 'amount' | 'price' | 'review';
}

export function startAddSession(type: StrategyType): AddSession {
  const role = STRATEGY_DEFAULTS[type].role;
  if (type === 'dca') return { type, role, params: {}, step: 'interval' };
  return { type, role, params: {}, step: 'price' };
}

export function applyDcaInterval(s: AddSession, minutes: number): AddSession {
  return { ...s, params: { ...s.params, intervalMin: minutes }, step: 'amount' };
}

export function applyDcaAmount(s: AddSession, usdc: number): AddSession {
  return { ...s, params: { ...s.params, amountUsdc: usdc }, step: 'review' };
}

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

export function pricePrompt(type: StrategyType): string {
  if (type === 'dip_buy') return 'Buy when the XLM price drops to or below… enter a USD price (e.g. 0.10):';
  if (type === 'take_profit') return 'Sell when the XLM price rises to or above… enter a USD price (e.g. 0.50):';
  return 'Protect: sell if the XLM price falls to or below… enter a USD price (e.g. 0.08):';
}

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

export function presetAccumulatorInputs(): NewStrategyInput[] {
  return [
    { type: 'dca', role: 'accumulate', enabled: true, lastRunAt: null, params: { intervalMin: 1440, amountUsdc: 5 } },
    { type: 'take_profit', role: 'sell', enabled: true, lastRunAt: null, params: { ...STRATEGY_DEFAULTS.take_profit.params } },
    { type: 'stop_loss', role: 'protect', enabled: true, lastRunAt: null, params: { ...STRATEGY_DEFAULTS.stop_loss.params } },
  ];
}
