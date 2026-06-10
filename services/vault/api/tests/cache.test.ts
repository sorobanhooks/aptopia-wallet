// T5/T11 — TtlCache unit tests. Cache is the only thing protecting the API
// from a tight refresh-polling loop now that the static client key was
// dropped as theatre (HANDOFF.md outside-voice #7).

import { describe, expect, test } from "bun:test";
import { TtlCache } from "../src/cache";

describe("TtlCache", () => {
  test("set + get within TTL returns the stored value", () => {
    const c = new TtlCache<string>(1_000);
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
  });

  test("get returns undefined for missing keys", () => {
    const c = new TtlCache<string>(1_000);
    expect(c.get("nope")).toBeUndefined();
  });

  test("get evicts and returns undefined after TTL elapses", async () => {
    const c = new TtlCache<string>(20);
    c.set("k", "v");
    await new Promise((r) => setTimeout(r, 30));
    expect(c.get("k")).toBeUndefined();
  });

  test("getOrCompute caches the computed value (no second call within TTL)", async () => {
    const c = new TtlCache<number>(1_000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 42;
    };
    expect(await c.getOrCompute("k", compute)).toBe(42);
    expect(await c.getOrCompute("k", compute)).toBe(42);
    expect(calls).toBe(1);
  });

  test("getOrCompute re-runs compute after expiry", async () => {
    const c = new TtlCache<number>(15);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    expect(await c.getOrCompute("k", compute)).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(await c.getOrCompute("k", compute)).toBe(2);
  });
});
