import type { IAgent } from './db';
import type { Balances } from './chains/types';

export interface AgentMetricsBody {
  agentAddress: string;
  balances: { native: string; usdc: string; assets: Record<string, string> };
  dailySpentUsd: number;
  dailyLimitUsd: number;
  totalSuccessfulTrades: number;
  status: 'healthy' | 'disabled';
  pendingTier2Count: number;
  funded: boolean;
  usdcTrustlineReady: boolean;
}

/** Account exists past the base reserve once it holds >= 1 XLM. */
const MIN_FUNDED_NATIVE = 1;

export function buildAgentMetricsBody(
  agent: IAgent,
  balances: Balances,
  pendingTier2Count: number,
): AgentMetricsBody {
  return {
    agentAddress: agent.agentAddress,
    balances: {
      native: balances.native,
      usdc: balances.usdc,
      assets: balances.assets ?? {},
    },
    dailySpentUsd: agent.spentToday,
    dailyLimitUsd: agent.dailyBudget,
    totalSuccessfulTrades: agent.totalSuccessfulTrades ?? 0,
    status: agent.active ? 'healthy' : 'disabled',
    pendingTier2Count,
    funded: Number(balances.native) >= MIN_FUNDED_NATIVE,
    // legacy agents omit the field → treated as ready (matches schema semantics)
    usdcTrustlineReady: agent.usdcTrustlineReady !== false,
  };
}
