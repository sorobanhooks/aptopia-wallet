import { selectAgentViewState, AgentViewState } from "../selectAgentViewState";
import { AgentHttpError } from "api/agentBackendService";
import { AgentMetrics } from "api/types";

const metrics = (over: Partial<AgentMetrics>): AgentMetrics => ({
  agentAddress: "GAGENT",
  balances: { native: "0", usdc: "0" },
  dailySpentUsd: 0, dailyLimitUsd: 0, totalSuccessfulTrades: 0,
  status: "healthy", pendingTier2Count: 0, funded: false, usdcTrustlineReady: false,
  ...over,
});

describe("selectAgentViewState", () => {
  it("404 -> NO_AGENT", () => {
    expect(selectAgentViewState({ error: new AgentHttpError(404, "x") }))
      .toBe(AgentViewState.NO_AGENT);
  });
  it("non-404 error -> SERVICE_ERROR", () => {
    expect(selectAgentViewState({ error: new AgentHttpError(500, "x") }))
      .toBe(AgentViewState.SERVICE_ERROR);
    expect(selectAgentViewState({ error: new Error("network") }))
      .toBe(AgentViewState.SERVICE_ERROR);
  });
  it("found + unfunded -> NEEDS_ACTIVATION", () => {
    expect(selectAgentViewState({ metrics: metrics({ funded: false, usdcTrustlineReady: true }) }))
      .toBe(AgentViewState.NEEDS_ACTIVATION);
  });
  it("found + funded but no trustline -> NEEDS_ACTIVATION", () => {
    expect(selectAgentViewState({ metrics: metrics({ funded: true, usdcTrustlineReady: false }) }))
      .toBe(AgentViewState.NEEDS_ACTIVATION);
  });
  it("found + funded + trustline -> ACTIVE", () => {
    expect(selectAgentViewState({ metrics: metrics({ funded: true, usdcTrustlineReady: true }) }))
      .toBe(AgentViewState.ACTIVE);
  });
  it("undefined funded/usdcTrustlineReady (legacy/omitted) -> NEEDS_ACTIVATION", () => {
    expect(selectAgentViewState({ metrics: metrics({ funded: undefined, usdcTrustlineReady: undefined }) }))
      .toBe(AgentViewState.NEEDS_ACTIVATION);
  });
  it("funded true but usdcTrustlineReady omitted -> NEEDS_ACTIVATION", () => {
    expect(selectAgentViewState({ metrics: metrics({ funded: true, usdcTrustlineReady: undefined }) }))
      .toBe(AgentViewState.NEEDS_ACTIVATION);
  });
});
