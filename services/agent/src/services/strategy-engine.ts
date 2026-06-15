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
