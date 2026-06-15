import { StrategyType, STRATEGY_DEFAULTS, NewStrategyInput, StrategyConfig } from '../services/strategy-types';
import { wouldViolateSingleAccumulate } from '../services/strategy-engine';

export const REQUIRED_PARAMS: Record<StrategyType, string[]> = {
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

/** Validate a partial params patch for an existing strategy of `type`:
 *  every key must be a known param for that type, and every value a positive finite number. */
export function validateParamPatch(
  type: StrategyType,
  patch: Record<string, unknown>
): { ok: boolean; value?: Record<string, number>; error?: string } {
  const allowed = new Set(REQUIRED_PARAMS[type] ?? []);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) {
      return { ok: false, error: `Unknown param "${k}" for ${type}` };
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `Invalid param "${k}" (must be a positive number)` };
    }
    out[k] = n;
  }
  return { ok: true, value: out };
}
