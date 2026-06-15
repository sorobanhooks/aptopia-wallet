import { agentBackendService } from "../agentBackendService";

describe("agentBackendService.parseCopilot", () => {
  it("returns the parsed result from an authed POST", async () => {
    // authedFetch is private; stub it via the prototype.
    const spy = jest
      .spyOn(agentBackendService as any, "authedFetch")
      .mockResolvedValue({ type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "USDC", tokenOut: "XLM" });

    const res = await agentBackendService.parseCopilot("swap 5 usd to xlm", []);
    expect(res).toEqual({ type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "USDC", tokenOut: "XLM" });
    const [url, opts] = spy.mock.calls[0];
    expect(url).toContain("/copilot/parse");
    expect(JSON.parse((opts as RequestInit).body as string).message).toBe("swap 5 usd to xlm");
    expect(JSON.parse((opts as RequestInit).body as string).context).toEqual([]);
  });
});
