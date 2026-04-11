export interface AgentLog {
  _id: string;
  agentId: string;
  telegramId: string;
  workerAddress: string;
  eventType: "trade" | string;
  status: "success" | "failure" | string;
  token: string;
  amount: string;
  txHash: string;
  createdAt: string;
  reason?: string;
}

export interface AgentLogsResponse {
  page: number;
  limit: number;
  total: number;
  items: AgentLog[];
}

export interface AgentRules {
  agentAddress: string;
  buyBelowUsd: number;
  sellAboveUsd: number;
  tier1Max: number;
  tier2Max: number;
  dailyBudget: number;
  buyAmountUsdc: number;
  sellAmountXlm: number;
}

export interface UpdateAgentRulesRequest {
  buyBelowUsd?: number;
  sellAboveUsd?: number;
  tier1Max?: number;
  tier2Max?: number;
  dailyBudget?: number;
  buyAmountUsdc?: number;
  sellAmountXlm?: number;
}

export interface AgentMetrics {
  agentAddress: string;
  balances: {
    native: string;
    usdc: string;
    assets: Record<string, string>;
  };
  dailySpentUsd: number;
  dailyLimitUsd: number;
  totalSuccessfulTrades: number;
  status: "healthy" | "disabled" | string;
}

export interface RevokeResponse {
  ok: boolean;
  transfers?: {
    token: string;
    amount: string;
    txHash: string;
  }[];
  error?: string;
}
