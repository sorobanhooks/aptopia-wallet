import { toBaseUnits, fromBaseUnits, tokenLabel } from "../helpers";

describe("AICopilot helpers", () => {
  it("toBaseUnits multiplies by 10^7 and floors to integer string", () => {
    expect(toBaseUnits("5")).toBe("50000000");
    expect(toBaseUnits("0.5")).toBe("5000000");
    expect(toBaseUnits("1.2345678")).toBe("12345678");
  });
  it("fromBaseUnits divides by 10^7", () => {
    expect(fromBaseUnits("50000000")).toBe("5");
    expect(fromBaseUnits("37810000")).toBe("3.781");
  });
  it("toBaseUnits floors (truncates) input beyond 7 decimals — never overspends", () => {
    expect(toBaseUnits("1.99999999")).toBe("19999999");
    expect(toBaseUnits("0.00000005")).toBe("0");
  });
  it("tokenLabel disambiguates Circle USDC", () => {
    expect(tokenLabel("usdc")).toBe("USDC (Circle)");
    expect(tokenLabel("xlm")).toBe("XLM");
  });
});
