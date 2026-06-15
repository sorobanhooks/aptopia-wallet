import { AgentHttpError } from "../agentBackendService";

describe("AgentHttpError", () => {
  it("carries the HTTP status and message", () => {
    const err = new AgentHttpError(404, "Agent not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Agent not found");
  });
});
