// vault/api/src/routes/swap.ts
// POST /swap/build-tx — build (do not sign) a Soroswap router swap.
//
// Body: { user, tokenIn, tokenOut, amountIn (base units), maxSlippageBps? }
// Response: { xdr, router, preview: { venue, tokenIn, tokenOut, amountIn,
//             expectedOut, minOut, maxSlippageBps, rate } }

import { Hono } from "hono";
import { forNetwork, swapTokenSacFor, type Network } from "../addresses";
import {
  addrScVal,
  buildInvocationXdr,
  i128ScVal,
  pathScVal,
  simulateRead,
  u64ScVal,
} from "../rpc";

const DEFAULT_NETWORK = (process.env.NETWORK ?? "testnet") as Network;
const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
const DEADLINE_SECONDS = 300; // 5-minute buffer

export const swapRoutes = new Hono();

const SWAP_SYMBOLS = new Set(["xlm", "usdc"]);
function isSwapSymbol(s: string): s is "xlm" | "usdc" {
  return SWAP_SYMBOLS.has(s);
}

swapRoutes.post("/swap/build-tx", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = String(body.user ?? "");
  const tokenIn = String(body.tokenIn ?? "").toLowerCase();
  const tokenOut = String(body.tokenOut ?? "").toLowerCase();
  const amountIn = String(body.amountIn ?? "");
  const maxSlippageBps = Number(body.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS);

  if (!user || !amountIn) {
    return c.json({ error: "body must include { user, amountIn }" }, 400);
  }
  if (!isSwapSymbol(tokenIn) || !isSwapSymbol(tokenOut)) {
    return c.json({ error: "tokenIn/tokenOut must be 'xlm' or 'usdc'" }, 400);
  }
  if (tokenIn === tokenOut) {
    return c.json({ error: "tokenIn and tokenOut must differ" }, 400);
  }
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) {
    return c.json({ error: "maxSlippageBps must be integer in [0, 10000]" }, 400);
  }
  if (!/^\d+$/.test(amountIn) || BigInt(amountIn) <= 0n) {
    return c.json({ error: "amountIn must be a positive base-unit integer string" }, 400);
  }

  const net = DEFAULT_NETWORK;
  const router = forNetwork(net).soroswapRouter;
  const tokenInSac = swapTokenSacFor(net, tokenIn);
  const tokenOutSac = swapTokenSacFor(net, tokenOut);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const path = pathScVal([tokenInSac, tokenOutSac]);

  try {
    // NOTE: simulation runs with `source: user`; the router transfers `tokenIn`
    // from the user during the swap, so it only succeeds if `user` actually holds
    // `amountIn` of `tokenIn` (and can receive `tokenOut`). An unfunded/insufficient
    // user surfaces as a simulation error, mapped to a friendly message in the catch.
    // 1. Simulate the swap with min-out = 0 to read the expected output.
    const amounts = await simulateRead<bigint[]>({
      contractId: router,
      method: "swap_exact_tokens_for_tokens",
      args: [i128ScVal(amountIn), i128ScVal("0"), path, addrScVal(user), u64ScVal(deadline)],
      source: user,
    });
    const expectedOut = amounts[amounts.length - 1];
    if (expectedOut === undefined || expectedOut <= 0n) {
      return c.json({ error: "swap simulation returned no output" }, 400);
    }
    // 2. Apply slippage floor: minOut = expectedOut * (10000 - bps) / 10000.
    const minOut = (expectedOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;

    // 3. Build the real unsigned XDR with the enforced floor.
    const xdr = await buildInvocationXdr({
      source: user,
      contractId: router,
      method: "swap_exact_tokens_for_tokens",
      args: [i128ScVal(amountIn), i128ScVal(minOut), path, addrScVal(user), u64ScVal(deadline)],
    });

    return c.json({
      xdr,
      router,
      preview: {
        venue: "soroswap",
        tokenIn,
        tokenOut,
        amountIn,
        expectedOut: expectedOut.toString(),
        minOut: minOut.toString(),
        maxSlippageBps,
        rate: (Number(expectedOut) / Number(amountIn)).toString(), // display-only; minOut is the enforced value
      },
    });
  } catch (err) {
    console.error("[swap/build-tx] simulation/build failed:", err);
    const raw = String(err);
    const friendly = /insufficient|balance|trustline|transfer|auth|underfunded/i.test(raw)
      ? `Could not build the swap — check that your wallet holds enough ${tokenIn.toUpperCase()} and can receive ${tokenOut.toUpperCase()} on testnet.`
      : "Could not build the swap on Soroswap right now. Please try again.";
    return c.json({ error: friendly }, 400);
  }
});
