import { AgentHttpError } from "api/agentBackendService";
import { AgentMetrics } from "api/types";

export enum AgentViewState {
  NO_AGENT = "NO_AGENT",
  SERVICE_ERROR = "SERVICE_ERROR",
  NEEDS_ACTIVATION = "NEEDS_ACTIVATION",
  ACTIVE = "ACTIVE",
}

/**
 * Decide which Agents-tab screen to show once the metrics fetch settles.
 * Pass `error` when the fetch threw, otherwise `metrics` from a 200 response.
 */
export const selectAgentViewState = ({
  metrics,
  error,
}: {
  metrics?: AgentMetrics | null;
  error?: unknown;
}): AgentViewState => {
  if (error) {
    if (error instanceof AgentHttpError && error.status === 404) {
      return AgentViewState.NO_AGENT;
    }
    return AgentViewState.SERVICE_ERROR;
  }
  if (!metrics) return AgentViewState.SERVICE_ERROR;
  const ready = metrics.funded === true && metrics.usdcTrustlineReady === true;
  return ready ? AgentViewState.ACTIVE : AgentViewState.NEEDS_ACTIVATION;
};
