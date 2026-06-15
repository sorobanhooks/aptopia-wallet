import { Operation } from "stellar-sdk";
import { buildFundingOperation } from "../buildFundingOperation";

const DEST = "GBTKZLQQX57PCHPWNBPX7ZLBOV5R2ZOOJZ3Z65X33IEQFE443FZMWGPF";

describe("buildFundingOperation", () => {
  it("uses createAccount when the destination does not exist", () => {
    const op = buildFundingOperation({ destination: DEST, amount: "3", accountExists: false });
    const decoded = Operation.fromXDRObject(op) as any;
    expect(decoded.type).toBe("createAccount");
    expect(decoded.destination).toBe(DEST);
    expect(decoded.startingBalance).toBe("3.0000000"); // SDK normalizes to 7 decimals
  });
  it("uses native XLM payment when the destination already exists", () => {
    const op = buildFundingOperation({ destination: DEST, amount: "2.5", accountExists: true });
    const decoded = Operation.fromXDRObject(op) as any;
    expect(decoded.type).toBe("payment");
    expect(decoded.destination).toBe(DEST);
    expect(decoded.amount).toBe("2.5000000");
    expect(decoded.asset.isNative()).toBe(true);
  });
});
