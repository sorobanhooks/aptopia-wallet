// /balance/:address — aggregates user balances across the vault share tokens
// and the underlying SACs. Promise.all parallel; 3s TTL cache.

import { Hono } from "hono";
import { forNetwork, type Network } from "../addresses";
import { TtlCache } from "../cache";
import { addrScVal, simulateRead } from "../rpc";

const DEFAULT_NETWORK = (process.env.NETWORK ?? "testnet") as Network;
const READ_SOURCE = process.env.ADMIN_ADDR ?? "GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV";

interface BalanceResponse {
  network: Network;
  address: string;
  // i128 amounts as decimal strings to avoid Number precision loss.
  stxlm: string;
  stusdc: string;
  xlm: string;
  usdc: string;
}

const cache = new TtlCache<BalanceResponse>(3_000);

async function balanceOrZero(contractId: string, address: string): Promise<bigint> {
  if (contractId.startsWith("PLACEHOLDER_")) return 0n;
  try {
    return await simulateRead<bigint>({
      contractId,
      method: "balance",
      args: [addrScVal(address)],
      source: READ_SOURCE,
    });
  } catch {
    // Account may not have a balance entry yet — treat as 0 instead of 500ing.
    return 0n;
  }
}

export const balanceRoutes = new Hono();

balanceRoutes.get("/balance/:address", async (c) => {
  const address = c.req.param("address");
  if (!address.startsWith("G") || address.length !== 56) {
    return c.json({ error: "address must be a Stellar account public key (G...)" }, 400);
  }

  const cacheKey = `${DEFAULT_NETWORK}:${address}`;
  const result = await cache.getOrCompute(cacheKey, async () => {
    const a = forNetwork(DEFAULT_NETWORK);
    const [stxlm, stusdc, xlm, usdc] = await Promise.all([
      balanceOrZero(a.vaultXlm, address),
      balanceOrZero(a.vaultUsdc, address),
      balanceOrZero(a.xlmSac, address),
      balanceOrZero(a.usdcSac, address),
    ]);
    return {
      network: DEFAULT_NETWORK,
      address,
      stxlm: stxlm.toString(),
      stusdc: stusdc.toString(),
      xlm: xlm.toString(),
      usdc: usdc.toString(),
    };
  });
  return c.json(result);
});
