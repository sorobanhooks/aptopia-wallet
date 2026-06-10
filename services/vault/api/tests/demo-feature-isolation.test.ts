// T5 — Demo-feature isolation invariant.
//
// HANDOFF.md called for a `--features demo` Cargo flag to gate the
// `inject_yield` admin entrypoint. After T8 we documented (README +
// scripts/deploy-testnet.sh) that no such Cargo feature exists — the
// equivalent design is: inject_yield lives ONLY on crates/mock-strategy,
// which is a test-and-demo-only adapter never registered as a production
// strategy. Production strategies (blend-strategy, soroswap-strategy) must
// never expose inject_yield.
//
// This test enforces that invariant at source level. If a future PR adds
// inject_yield to a production strategy (intentionally or via copy-paste
// from MockStrategy), this test fails loudly.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const INJECT_YIELD_FN = /\bfn\s+inject_yield\s*\(/;

describe("Demo-feature isolation invariant", () => {
  test("MockStrategy DOES expose inject_yield (used by XLM demo flow)", () => {
    expect(read("crates/mock-strategy/src/lib.rs")).toMatch(INJECT_YIELD_FN);
  });

  test("BlendStrategy does NOT expose inject_yield", () => {
    expect(read("crates/blend-strategy/src/lib.rs")).not.toMatch(INJECT_YIELD_FN);
  });

  test("SoroswapStrategy does NOT expose inject_yield", () => {
    expect(read("crates/soroswap-strategy/src/lib.rs")).not.toMatch(INJECT_YIELD_FN);
  });

  test("Cargo.toml files declare no 'demo' feature (T8 reality check)", () => {
    for (const crate of ["mock-strategy", "blend-strategy", "soroswap-strategy", "vault"]) {
      const toml = read(`crates/${crate}/Cargo.toml`);
      // [features] section with a 'demo' key would look like `demo = [...]`
      // anywhere in the file. None of our crates should declare it.
      expect(toml).not.toMatch(/^\s*demo\s*=/m);
    }
  });
});
