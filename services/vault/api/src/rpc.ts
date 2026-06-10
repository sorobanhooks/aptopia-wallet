// Soroban RPC helpers — thin wrappers over @stellar/stellar-sdk's rpc.Server.
//
// All Soroban writes follow the same shape:
//   1. build() — TransactionBuilder + contract.call(method, ...args)
//   2. simulate() — rpc.simulateTransaction() to get resource estimates
//   3. assemble() — rpc.assembleTransaction(tx, sim) to bake the resources in
//   4. return XDR to the caller (wallet signs externally)
//   5. submit() — rpc.sendTransaction(signed)
//
// All reads use simulate-only and parse the return value via scValToNative.

import {
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const TESTNET_RPC = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;

export const server = new rpc.Server(TESTNET_RPC);
export { NETWORK_PASSPHRASE };

/** Build (but do not sign or submit) a Soroban invocation. Returns XDR. */
export async function buildInvocationXdr(opts: {
  source: string;
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<string> {
  const account = await server.getAccount(opts.source);
  const contract = new Contract(opts.contractId);

  let tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(opts.method, ...opts.args))
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  tx = rpc.assembleTransaction(tx, sim).build();
  return tx.toXDR();
}

/**
 * Simulate a read-only invocation against an ephemeral source account.
 * Soroban simulation does not actually charge the account, so we synthesize
 * a no-op transaction from any funded testnet account to avoid requiring the
 * caller to be funded.
 */
export async function simulateRead<T = unknown>(opts: {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /**
   * Source account for the simulated tx. Must exist on-chain (have at least
   * one operation; the friendbot-funded admin works). For pure reads any
   * existing account works since fees are not collected.
   */
  source: string;
}): Promise<T> {
  const account = await server.getAccount(opts.source);
  const contract = new Contract(opts.contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(opts.method, ...opts.args))
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`read ${opts.method} failed: ${sim.error}`);
  }
  if (!("result" in sim) || !sim.result) {
    throw new Error(`read ${opts.method}: no return value`);
  }
  return scValToNative(sim.result.retval) as T;
}

/** Submit a signed transaction XDR and poll until SUCCESS or terminal failure. */
export async function submitSignedXdr(signedXdr: string) {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as Transaction;
  const send = await server.sendTransaction(tx);
  if (send.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(send.errorResult)}`);
  }

  // Poll. Default budget: 30s (15 × 2s) — Soroban testnet typically lands in
  // 5-10s; if it's slower the caller can retry the same hash.
  let result = await server.getTransaction(send.hash);
  for (let i = 0; i < 15 && result.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    result = await server.getTransaction(send.hash);
  }

  const native =
    result.status === "SUCCESS" && "returnValue" in result && result.returnValue
      ? scValToNative(result.returnValue)
      : null;
  return {
    hash: send.hash,
    status: result.status,
    // JSON.stringify can't serialize BigInt; stringify defensively. The shape
    // is opaque (i128, address, struct, etc.) so toString() across the board
    // is the simplest stable contract for downstream consumers.
    returnValue: stringifyBigInts(native),
  };
}

function stringifyBigInts(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(stringifyBigInts);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = stringifyBigInts(val);
    return out;
  }
  return v;
}

/** Convert a Stellar address string to ScVal. */
export function addrScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

/** Convert an i128 amount (string | number | bigint) to ScVal. */
export function i128ScVal(amount: string | number | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(amount), { type: "i128" });
}
