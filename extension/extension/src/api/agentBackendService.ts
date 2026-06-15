import { BACKEND_URL } from "constants/env";
import { signAuthMessage as internalSignAuthMessage } from "@shared/api/internal";
import {
  AgentLogsResponse,
  AgentRules,
  AgentMetrics,
  RevokeResponse,
  UpdateAgentRulesRequest,
  AuthChallengeResponse,
  AuthVerifyResponse,
  PendingTier2Trade,
  ConfirmTier2Response,
  RejectTier2Response,
  NarrateLogResponse,
  ExplainRulesResponse,
  OffChainYieldSource,
} from "./types";

export type CopilotParseResult =
  | {
      type: "swap";
      venue: "soroswap";
      amountIn: string; // human units as typed by the user, e.g. "5" — NOT base units (convert before buildSwap)
      tokenIn: "XLM" | "USDC";
      tokenOut: "XLM" | "USDC";
      slippageBps?: number;
    }
  | { type: "clarification"; message: string }
  | { type: "unsupported"; message: string };

/** Error thrown by agent-backend calls, carrying the HTTP status so views can
 *  distinguish 404 (no agent for this wallet) from transient/auth failures. */
export class AgentHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AgentHttpError";
  }
}

interface CachedToken {
  token: string;
  /** epoch ms when the JWT expires */
  expiresAtMs: number;
}

/**
 * Client for the xyra-walllet agent backend (/v1/*).
 *
 * All /v1/* endpoints (except /v1/auth/* and /v1/health) require a SIWE-style
 * bearer JWT. This client transparently performs the challenge → sign → verify
 * handshake on first use, caches the JWT keyed by the signing public key, sets
 * `Authorization: Bearer <jwt>` on every request, and refreshes once on a 401.
 *
 * Views must call `setSigningKey(publicKey)` (the user's active G-address)
 * before making requests — the Dashboard/AgentConfig/ActivityLog views already
 * have `publicKey` from the redux selector.
 */
class AgentBackendService {
  private baseUrl: string;
  /** The active account public key used to sign auth challenges. */
  private signingKey: string | null = null;
  /** JWT cache keyed by signing public key. */
  private tokenCache = new Map<string, CachedToken>();
  /** De-duplicates concurrent token fetches per pubkey. */
  private inflight = new Map<string, Promise<string>>();

  constructor() {
    this.baseUrl = `${BACKEND_URL}/v1`;
  }

  /**
   * Set the public key used to authenticate requests. Idempotent; safe to call
   * on every view mount. Clearing (null/empty) drops the active signing key but
   * leaves cached tokens intact.
   */
  setSigningKey(publicKey: string | null): void {
    this.signingKey = publicKey || null;
  }

  /**
   * Returns a valid JWT for `publicKey` (defaults to the active signing key),
   * performing the challenge → sign → verify handshake if there is no fresh
   * cached token. Caches the token until ~10s before its server-side expiry.
   */
  async getAuthToken(publicKey?: string): Promise<string> {
    const pk = publicKey || this.signingKey;
    if (!pk) {
      throw new Error("No signing key set for agent backend auth");
    }

    const cached = this.tokenCache.get(pk);
    // Refresh 10s early to avoid races with server-side expiry.
    if (cached && cached.expiresAtMs - 10_000 > Date.now()) {
      return cached.token;
    }

    // Collapse concurrent fetches for the same pubkey.
    const existing = this.inflight.get(pk);
    if (existing) return existing;

    const p = this.fetchFreshToken(pk).finally(() => this.inflight.delete(pk));
    this.inflight.set(pk, p);
    return p;
  }

  private async fetchFreshToken(publicKey: string): Promise<string> {
    // 1. Challenge
    const chRes = await fetch(`${this.baseUrl}/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: publicKey }),
    });
    if (!chRes.ok) {
      throw new Error(`Auth challenge failed (${chRes.status})`);
    }
    const challenge = (await chRes.json()) as AuthChallengeResponse;

    // 2. Sign the canonical message via the background service worker (SEP-53).
    const { signature } = await internalSignAuthMessage({
      message: challenge.message,
      activePublicKey: publicKey,
    });

    // 3. Verify → JWT
    const vRes = await fetch(`${this.baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pubkey: publicKey,
        signature,
        message: challenge.message,
      }),
    });
    if (!vRes.ok) {
      throw new Error(`Auth verify failed (${vRes.status})`);
    }
    const verified = (await vRes.json()) as AuthVerifyResponse;

    const ms = new Date(verified.expiresAt).getTime();
    this.tokenCache.set(publicKey, {
      token: verified.token,
      // Fall back to 30 min if the server returns a malformed/absent expiresAt.
      expiresAtMs: Number.isFinite(ms) ? ms : Date.now() + 30 * 60 * 1000,
    });
    return verified.token;
  }

  /** Drop the cached token for a pubkey (or the active signing key). */
  private invalidateToken(publicKey?: string): void {
    const pk = publicKey || this.signingKey;
    if (pk) this.tokenCache.delete(pk);
  }

  /**
   * fetch wrapper that injects the bearer token and retries once on 401 with a
   * freshly-minted token. Parses JSON, throwing on non-OK responses (mirroring
   * the previous fetchJson contract so callers/views are unchanged).
   */
  private async authedFetch<T>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    const doFetch = async (token: string): Promise<Response> =>
      fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`,
        },
      });

    let token = await this.getAuthToken();
    let res = await doFetch(token);

    // On 401 the token may be expired/invalid — refresh once and retry.
    if (res.status === 401) {
      this.invalidateToken();
      token = await this.getAuthToken();
      res = await doFetch(token);
    }

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");

    if (!res.ok) {
      let message = res.statusText;
      if (isJson) {
        const errorData = await res.json().catch(() => null);
        if (errorData?.error) message = errorData.error;
      }
      throw new AgentHttpError(res.status, message);
    }

    if (!isJson) {
      const content = await res.text();
      throw new Error(`Did not receive json error:${content}`);
    }

    return (await res.json()) as T;
  }

  /**
   * Returns paginated AgentLog documents for trades and related events.
   * GET /v1/logs/:address
   */
  async getLogs(
    address: string,
    page = 1,
    limit = 20,
  ): Promise<AgentLogsResponse> {
    const url = `${this.baseUrl}/logs/${address}?page=${page}&limit=${limit}`;
    return this.authedFetch<AgentLogsResponse>(url);
  }

  /**
   * Returns non-secret trading rule fields for the agent.
   * GET /v1/rules/:address
   */
  async getRules(address: string): Promise<AgentRules> {
    const url = `${this.baseUrl}/rules/${address}`;
    return this.authedFetch<AgentRules>(url);
  }

  /**
   * Updates rules for the agent.
   * PUT /v1/rules/:address
   */
  async updateRules(
    address: string,
    rules: UpdateAgentRulesRequest,
  ): Promise<AgentRules> {
    const url = `${this.baseUrl}/rules/${address}`;
    return this.authedFetch<AgentRules>(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rules),
    });
  }

  /**
   * Returns live balances, spend/limit/trade counters and agent status.
   * GET /v1/metrics/:address
   */
  async getMetrics(address: string): Promise<AgentMetrics> {
    const url = `${this.baseUrl}/metrics/${address}`;
    return this.authedFetch<AgentMetrics>(url);
  }

  /**
   * Drains all USDC from the agent wallet to the user's main wallet and disables the agent.
   * POST /v1/revoke/:address
   */
  async revokeAgent(address: string): Promise<RevokeResponse> {
    const url = `${this.baseUrl}/revoke/${address}`;
    return this.authedFetch<RevokeResponse>(url, {
      method: "POST",
    });
  }

  /**
   * Returns 0 or 1 pending Tier-2 trade awaiting user confirmation.
   * GET /v1/pending-tier2/:address
   */
  async getPendingTier2(address: string): Promise<PendingTier2Trade[]> {
    const url = `${this.baseUrl}/pending-tier2/${address}`;
    return this.authedFetch<PendingTier2Trade[]>(url);
  }

  /**
   * Confirms a pending Tier-2 trade, executing the swap on-chain.
   * The optional `direction` ('buy_xlm'|'sell_xlm') is validated server-side
   * against the stored trade — a mismatch returns 409 to prevent confirming a
   * stale/swapped pending entry.
   * POST /v1/pending-tier2/:address/:id/confirm
   */
  async confirmTier2(
    address: string,
    id: string,
    direction: "buy_xlm" | "sell_xlm",
  ): Promise<ConfirmTier2Response> {
    const url = `${this.baseUrl}/pending-tier2/${address}/${id}/confirm`;
    return this.authedFetch<ConfirmTier2Response>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    });
  }

  /**
   * Rejects a pending Tier-2 trade, discarding it without executing.
   * POST /v1/pending-tier2/:address/:id/reject
   */
  async rejectTier2(address: string, id: string): Promise<RejectTier2Response> {
    const url = `${this.baseUrl}/pending-tier2/${address}/${id}/reject`;
    return this.authedFetch<RejectTier2Response>(url, {
      method: "POST",
    });
  }

  /**
   * Fetches (or generates) a plain-English AI narration for a trade log entry.
   * Result is cached server-side — subsequent calls return `cached: true`.
   * POST /v1/narrate-log/:address/:logId
   */
  async narrateLog(
    address: string,
    logId: string,
  ): Promise<NarrateLogResponse> {
    const url = `${this.baseUrl}/narrate-log/${address}/${logId}`;
    return this.authedFetch<NarrateLogResponse>(url, {
      method: "POST",
    });
  }

  /**
   * Fetches (or generates) a plain-English AI explanation of the agent's
   * trading rules. Result is cached server-side keyed by (agentId, rulesHash)
   * — subsequent calls with the same rules return `cached: true`.
   * POST /v1/explain-rules/:address
   */
  async explainRules(address: string): Promise<ExplainRulesResponse> {
    const url = `${this.baseUrl}/explain-rules/${address}`;
    return this.authedFetch<ExplainRulesResponse>(url, {
      method: "POST",
    });
  }

  /**
   * Sends a natural-language message to the agent backend's copilot parser
   * and returns a structured swap intent (or clarification/unsupported).
   * POST /v1/copilot/parse
   */
  async parseCopilot(
    message: string,
    context: { role: "user" | "copilot"; text: string }[] = [],
  ): Promise<CopilotParseResult> {
    return this.authedFetch<CopilotParseResult>(`${this.baseUrl}/copilot/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, context }),
    });
  }

  /**
   * Returns the hand-curated list of off-chain yield sources (Wirex, Ultra
   * Stellar, etc.).
   *
   * Auth decision (B4): this endpoint is PUBLIC — it serves static, non-user-
   * scoped data. A plain fetch is used here intentionally; authedFetch would
   * require a valid JWT and unnecessarily block pre-auth display.
   *
   * GET /v1/yield-sources/off-chain
   */
  async getOffChainYieldSources(): Promise<OffChainYieldSource[]> {
    const url = `${this.baseUrl}/yield-sources/off-chain`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch off-chain yield sources (${res.status})`,
      );
    }
    return (await res.json()) as OffChainYieldSource[];
  }
}

export const agentBackendService = new AgentBackendService();
