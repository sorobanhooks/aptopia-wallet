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
  /** AI-generated plain-English narration (populated lazily, cached server-side). */
  narration?: string;
}

/** Response from POST /v1/narrate-log/:address/:logId */
export interface NarrateLogResponse {
  narration: string;
  cached: boolean;
}

/** Response from POST /v1/explain-rules/:address */
export interface ExplainRulesResponse {
  explanation: string;
  cached: boolean;
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
}

export interface UpdateAgentRulesRequest {
  buyBelowUsd?: number;
  sellAboveUsd?: number;
  tier1Max?: number;
  tier2Max?: number;
  dailyBudget?: number;
}

export interface AgentMetrics {
  agentAddress: string;
  balances: {
    native: string;
    usdc: string;
  };
  dailySpentUsd: number;
  dailyLimitUsd: number;
  totalSuccessfulTrades: number;
  status: "healthy" | "disabled" | string;
  /** Number of Tier-2 trades awaiting user confirmation (0 or 1). */
  pendingTier2Count?: number;
  /** Account exists past the base reserve (native >= 1 XLM). */
  funded?: boolean;
  /** Agent has added its USDC trustline. */
  usdcTrustlineReady?: boolean;
}

// --- Tier-2 pending trade (C1a endpoint contract) ---

export interface PendingTier2Trade {
  id: string;
  side: "buy" | "sell";
  token: "XLM";
  amount: string;
  price: string | null;
  plannedUsdc: string | null;
  plannedXlm: string | null;
  createdAt: string | null;
}

export interface ConfirmTier2Response {
  ok: true;
  txHash: string;
}

export interface RejectTier2Response {
  ok: true;
}

export interface RevokeResponse {
  ok: boolean;
  txHash: string;
  amountTransferred: string;
  error?: string;
}

// --- Off-chain yield sources (B4) ---

/**
 * A hand-curated off-chain yield source returned by
 * GET /v1/yield-sources/off-chain (public, no auth required).
 * Rates are self-reported by providers; see disclaimer in YieldHub UI.
 */
export interface OffChainYieldSource {
  id: string;
  name: string;
  asset: string;
  apyPercent: number;
  url: string;
  asOf: string;
}

// --- SIWE-style auth (xyra-walllet /v1/auth) ---

/** Response of POST /v1/auth/challenge. */
export interface AuthChallengeResponse {
  nonce: string;
  domain: string;
  statement: string;
  issuedAt: string;
  expiresAt: string;
  /** Canonical string the wallet signs (SEP-53 hashed). */
  message: string;
}

/** Response of POST /v1/auth/verify. */
export interface AuthVerifyResponse {
  token: string;
  expiresAt: string;
}
