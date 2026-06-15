// vault/api/tests/scval-helpers.test.ts
import { describe, expect, test } from "bun:test";
import { scValToNative } from "@stellar/stellar-sdk";
import { pathScVal, u64ScVal } from "../src/rpc";

const A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const B = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

describe("scval helpers", () => {
  test("pathScVal builds a Vec<Address> that decodes back to the addresses", () => {
    const decoded = scValToNative(pathScVal([A, B])) as string[];
    expect(decoded).toEqual([A, B]);
  });
  test("u64ScVal decodes back to the numeric value", () => {
    expect(scValToNative(u64ScVal(300))).toBe(300n);
  });
});
