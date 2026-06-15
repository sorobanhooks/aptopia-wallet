// accountState.ts
import { NetworkDetails } from "@shared/constants/stellar";
import { AccountState } from "./swapPreflight";
import { SWAP_USDC_CODE, SWAP_USDC_ISSUER } from "./swapAssets";

/** A single balance line from Horizon's `/accounts/{id}` `balances` array. */
export interface HorizonBalanceLine {
  asset_type: string;
  balance: string;
  asset_code?: string;
  asset_issuer?: string;
}

/** Map Horizon `balances[]` to the copilot's AccountState. Horizon balances are
 *  already human units. The swap USDC trustline is matched by BOTH code and
 *  issuer so it's never confused with the Blend vault USDC (a different issuer). */
export function accountStateFromHorizonBalances(
  balances: HorizonBalanceLine[] | undefined,
): AccountState {
  let nativeXlm = "0";
  const usdc = { hasTrustline: false, balance: "0" };
  for (const b of balances ?? []) {
    if (b.asset_type === "native") {
      nativeXlm = b.balance;
    } else if (b.asset_code === SWAP_USDC_CODE && b.asset_issuer === SWAP_USDC_ISSUER) {
      usdc.hasTrustline = true;
      usdc.balance = b.balance;
    }
  }
  return { funded: true, nativeXlm, usdc };
}

/** Fetch fresh on-chain state straight from Horizon (testnet) for the copilot's
 *  preflight. We deliberately bypass the Freighter indexer (`getAccountBalances`):
 *  its host is unreachable in this deployment, and the copilot only needs the
 *  native balance + the swap USDC trustline — both of which Horizon serves
 *  directly (and with permissive CORS). Horizon returns 404 for an account that
 *  doesn't exist yet → treat as not funded so remediation can friendbot it. */
export async function fetchAccountState(
  publicKey: string,
  networkDetails: NetworkDetails,
): Promise<AccountState> {
  const base = networkDetails.networkUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/accounts/${publicKey}`);
  if (res.status === 404) {
    return { funded: false, nativeXlm: "0", usdc: { hasTrustline: false, balance: "0" } };
  }
  if (!res.ok) {
    throw new Error(`Couldn't load your account from Horizon (${res.status}).`);
  }
  const data = (await res.json()) as { balances?: HorizonBalanceLine[] };
  return accountStateFromHorizonBalances(data.balances);
}
