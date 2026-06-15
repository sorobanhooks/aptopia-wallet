#!/usr/bin/env bun
// Live testnet tracer: build + simulate a real Soroswap swap via /swap/build-tx logic.
// Prereqs: vault/api/scripts/.swap-tracer.env with:
//   SWAP_TRACER_SECRET=S...        (funded testnet account)
//   SWAP_TRACER_TOKEN_IN=xlm      (the account must HOLD this token)
//   SWAP_TRACER_TOKEN_OUT=usdc    (and be able to receive this; requires USDC trustline)
//   SWAP_TRACER_AMOUNT_IN=10000000 (base units, 7 decimals — 1 XLM)
import { Keypair } from "@stellar/stellar-sdk";
import { forNetwork, swapTokenSacFor, type Network } from "../src/addresses";
import { addrScVal, buildInvocationXdr, i128ScVal, pathScVal, simulateRead, u64ScVal } from "../src/rpc";

const env = await Bun.file(`${import.meta.dir}/.swap-tracer.env`).text().catch(() => "");
for (const line of env.split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}

const net = (process.env.NETWORK ?? "testnet") as Network;
const secret = process.env.SWAP_TRACER_SECRET ?? "";
const tokenIn = (process.env.SWAP_TRACER_TOKEN_IN ?? "xlm") as "xlm" | "usdc";
const tokenOut = (process.env.SWAP_TRACER_TOKEN_OUT ?? "usdc") as "xlm" | "usdc";
const amountIn = process.env.SWAP_TRACER_AMOUNT_IN ?? "10000000";

console.log("=== swap-build tracer (testnet) ===");
if (!secret) { console.error("FAIL: SWAP_TRACER_SECRET not set"); process.exit(1); }

const user = Keypair.fromSecret(secret).publicKey();
const router = forNetwork(net).soroswapRouter;
const path = pathScVal([swapTokenSacFor(net, tokenIn), swapTokenSacFor(net, tokenOut)]);
const deadline = Math.floor(Date.now() / 1000) + 300;

try {
  console.log(`user=${user} ${tokenIn}->${tokenOut} amountIn=${amountIn} router=${router}`);
  const amounts = await simulateRead<bigint[]>({
    contractId: router,
    method: "swap_exact_tokens_for_tokens",
    args: [i128ScVal(amountIn), i128ScVal("0"), path, addrScVal(user), u64ScVal(deadline)],
    source: user,
  });
  const expectedOut = amounts[amounts.length - 1];
  const minOut = (expectedOut * 9950n) / 10000n;
  console.log(`expectedOut=${expectedOut} minOut(0.5%)=${minOut}`);
  const xdr = await buildInvocationXdr({
    source: user,
    contractId: router,
    method: "swap_exact_tokens_for_tokens",
    args: [i128ScVal(amountIn), i128ScVal(minOut), path, addrScVal(user), u64ScVal(deadline)],
  });
  console.log(`built XDR (${xdr.length} chars) OK`);
  console.log(`JSON_RESULT ${JSON.stringify({ ok: true, expectedOut: expectedOut.toString(), minOut: minOut.toString(), xdrLen: xdr.length })}`);
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err}`);
  console.log(`JSON_RESULT ${JSON.stringify({ ok: false, error: String(err) })}`);
  process.exit(1);
}
