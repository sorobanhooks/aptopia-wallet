import { remainingDailyBudgetUsd } from './daily-spend';

/** Keep a small USDC buffer on the agent for path payments / fees. */
export const USDC_BALANCE_RESERVE = Number(process.env.USDC_BALANCE_RESERVE || 0.01);

const STELLAR_SCALE = 7;

export function floorUsdcAmount(value: number): string {
  const factor = 10 ** STELLAR_SCALE;
  return (Math.floor(value * factor) / factor).toFixed(STELLAR_SCALE);
}

const MIN_PLANNED_USDC = Number(process.env.MIN_PLANNED_USDC || 0.0000001);

export type BuyRoute =
  | { kind: 'skip'; reason: string }
  | { kind: 'tier1_auto'; usdc: string; usdcNum: number }
  | { kind: 'tier2_confirm'; usdc: string; usdcNum: number }
  | { kind: 'blocked'; reason: string };

/** Planned USDC spend for a buy with an explicit requested USDC amount (per-strategy). */
export function computePlannedBuyUsdcForAmount(
  agent: { tier2Max: number; dailyBudget: number; spentToday: number },
  usdcBalance: number,
  requestedUsdc: number
): number {
  const dailyLeft = remainingDailyBudgetUsd(agent);
  const spendable = Math.max(0, usdcBalance - USDC_BALANCE_RESERVE);
  return Math.min(requestedUsdc, agent.tier2Max, dailyLeft, spendable);
}

export function routeBuy(
  agent: { tier1Max: number; tier2Max: number },
  plannedUsdc: number
): BuyRoute {
  if (!Number.isFinite(plannedUsdc) || plannedUsdc < MIN_PLANNED_USDC) {
    return {
      kind: 'skip',
      reason: 'Insufficient USDC, daily budget, or below minimum swap size',
    };
  }
  if (agent.tier2Max <= 0 || agent.tier1Max <= 0) {
    return { kind: 'skip', reason: 'Tier limits not configured; run /setrules' };
  }
  if (agent.tier1Max >= agent.tier2Max) {
    return { kind: 'skip', reason: 'Invalid rules: tier2 max must exceed tier1 max' };
  }

  const usdcNum = plannedUsdc;
  const usdc = floorUsdcAmount(usdcNum);

  if (usdcNum <= agent.tier1Max) {
    return { kind: 'tier1_auto', usdc, usdcNum };
  }
  if (usdcNum <= agent.tier2Max) {
    return { kind: 'tier2_confirm', usdc, usdcNum };
  }
  return { kind: 'blocked', reason: 'Trade exceeds tier 2 maximum' };
}

export type SellRoute =
  | { kind: 'skip'; reason: string }
  | { kind: 'tier1_auto'; xlm: string }
  | { kind: 'tier2_confirm'; xlm: string }
  | { kind: 'blocked'; reason: string };

/** Route a sell with an explicit XLM amount (per-strategy). */
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
