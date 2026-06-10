// T5 — POST /tx/submit. Wallet-fallback path for forks that can sign but
// not submit Soroban-flavored XDR.

import { describe, expect, mock, test } from "bun:test";

let lastSubmitted: string | null = null;
let submitResult: unknown = { hash: "HASH", status: "SUCCESS", returnValue: null };
let submitThrows = false;

mock.module("../src/rpc", () => ({
  simulateRead: async () => 0n,
  addrScVal: () => ({}),
  i128ScVal: () => ({}),
  buildInvocationXdr: async () => "FAKE_XDR",
  submitSignedXdr: async (xdr: string) => {
    lastSubmitted = xdr;
    if (submitThrows) throw new Error("send failed");
    return submitResult;
  },
}));

const { submitRoutes } = await import("../src/routes/submit");

async function postJson(body: unknown) {
  return submitRoutes.fetch(
    new Request("http://test/tx/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /tx/submit", () => {
  test("happy path: forwards signed_xdr and returns rpc result", async () => {
    lastSubmitted = null;
    submitThrows = false;
    submitResult = { hash: "ABC123", status: "SUCCESS", returnValue: "42" };

    const res = await postJson({ signed_xdr: "AAAA...SIGNED_PAYLOAD" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hash: "ABC123", status: "SUCCESS", returnValue: "42" });
    expect(lastSubmitted).toBe("AAAA...SIGNED_PAYLOAD");
  });

  test("missing signed_xdr → 400", async () => {
    const res = await postJson({});
    expect(res.status).toBe(400);
  });

  test("rpc failure → 400 with error message", async () => {
    submitThrows = true;
    const res = await postJson({ signed_xdr: "BADXDR" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("send failed");
  });
});
