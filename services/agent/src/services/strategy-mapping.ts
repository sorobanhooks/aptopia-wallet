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
