import { fetchJson } from "popup/helpers/fetch";
import { BACKEND_URL } from "constants/env";
import {
  AgentLogsResponse,
  AgentRules,
  AgentMetrics,
  RevokeResponse,
  UpdateAgentRulesRequest,
} from "./types";

class AgentBackendService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = `${BACKEND_URL}/v1`;
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
    return fetchJson<AgentLogsResponse>(url);
  }

  /**
   * Returns non-secret trading rule fields for the agent.
   * GET /v1/rules/:address
   */
  async getRules(address: string): Promise<AgentRules> {
    const url = `${this.baseUrl}/rules/${address}`;
    return fetchJson<AgentRules>(url);
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
    return fetchJson<AgentRules>(url, {
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
    return fetchJson<AgentMetrics>(url);
  }

  /**
   * Drains all USDC from the agent wallet to the user's main wallet and disables the agent.
   * POST /v1/revoke/:address
   */
  async revokeAgent(address: string): Promise<RevokeResponse> {
    const url = `${this.baseUrl}/revoke/${address}`;
    return fetchJson<RevokeResponse>(url, {
      method: "POST",
    });
  }
}

export const agentBackendService = new AgentBackendService();
