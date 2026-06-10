#!/usr/bin/env bun
// tracer-deposit.ts — P4: the load-bearing END-TO-END proof of the M1
// auth-digest tracer (R5a / AC4 + AC5).
//
// Proves that an OpenZeppelin Smart Account (SA) can authorize a REAL
// `vault.deposit` via its scoped External-Ed25519 context rule, signing the
// rule-bound `auth_digest` (NOT the raw host payload), AND that the binding is
// ENFORCED: four negative paths each revert fail-closed with an AUTH error.
//
// Network: Stellar TESTNET. tx source / fee payer / funding source = `admin`
// (G-account, stellar CLI identity). The DEPOSITOR whose __check_auth authorizes
// the deposit is the SA (a C-address), not admin.
//
// ── auth-digest spec (ground truth: stellar-accounts 0.7.1 storage.rs:492-495) ──
//   auth_digest = SHA-256( raw32(signature_payload) || ScValXdr(context_rule_ids) )
//   - signature_payload = sha256(XDR(HashIDPreimage::SorobanAuthorization{
//       networkId, nonce, signatureExpirationLedger, invocation })) — 32 RAW bytes.
//   - context_rule_ids serialized as the soroban ScVal XDR of Vec<u32>.
//   We REUSE the proven, parity-tested builder api/src/auth-digest.ts (P3). The
//   agent signs auth_digest (External verifier path, storage.rs authenticate:341).
//
// ── AuthPayload ScVal (storage.rs:131-138) ──
//   AuthPayload { signers: Map<Signer, Bytes>, context_rule_ids: Vec<u32> }
//   - struct  -> ScVal::Map with symbol keys, sorted: context_rule_ids, signers
//   - Signer::External(verifier: Address, key_data: Bytes)
//                -> ScVal::Vec[ Symbol("External"), Address, Bytes ]
//   - value (signature) -> ScVal::Bytes(64-byte ed25519 sig over auth_digest)
//   This ScVal is set as the SA entry's SorobanAddressCredentials.signature.
//
// ── KNOWN INTEGRATION RISK (handled truthfully) ──
//   `vault.deposit(SA, assets)` does `depositor.require_auth()` (deposit@VAULT_XLM)
//   AND the underlying SAC transfer does `from.require_auth()` (transfer@XLM_SAC).
//   So the SA's __check_auth sees TWO auth contexts and context_rule_ids must have
//   length 2. Rule 0 is scoped CallContract(VAULT_XLM) only; the transfer context
//   is CallContract(XLM_SAC), which Rule 0 does NOT cover. This script first
//   attempts the deposit with Rule 0 alone, captures the precise outcome, then
//   (if needed and possible) adds the minimal SAC-scope rule and retries.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import { computeAuthDigest, fromHex, toHex } from "../src/auth-digest";

// ───────────────────────────── config / inputs ─────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// The agent env lives in the repo-root scripts dir (gitignored):
// api/scripts -> api -> repo root -> scripts/.sa-tracer.env
const ENV_PATH = resolve(__dirname, "../../scripts/.sa-tracer.env");
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET; // "Test SDF Network ; September 2015"

// Fixed testnet addresses (from the plan; also cross-checked vs the env / deployed).
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const ADMIN_ADDR = "GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV";
// Negative (d): contracts NOT in the rule scope.
const VAULT_XLM_V1 = "CCDEEXUU25RUOZVSYCSJPX35QKPZTDBAT6UFW6GTC633LV3TLOXMDOLD";

// Funding + deposit amounts (stroops; XLM has 7 decimals).
const FUND_AMOUNT = 50_000_000n; // 5 XLM to the SA (idempotent top-up)
const DEPOSIT_AMOUNT = 5_000_000n; // 0.5 XLM deposit (small testnet amount)

// ───────────────────────────── tiny helpers ─────────────────────────────

function loadEnv(): Record<string, string> {
  const raw = readFileSync(ENV_PATH, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

let adminSecretCache: string | null = null;
function adminSecret(): string {
  if (adminSecretCache) return adminSecretCache;
  const proc = Bun.spawnSync(["stellar", "keys", "secret", "admin"]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `could not read admin secret via stellar CLI: ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
  adminSecretCache = new TextDecoder().decode(proc.stdout).trim();
  return adminSecretCache;
}

const server = new rpc.Server(RPC_URL);

/** Extract the host-function XDR from an invokeHostFunction operation (typed narrowing). */
function invokeFunc(op: import("@stellar/stellar-sdk").Operation): xdr.HostFunction {
  return (op as Operation.InvokeHostFunction).func;
}

/** Decode the structured Soroban diagnostic / error from any thrown / failed result. */
function describeError(x: unknown): string {
  if (x instanceof Error) return x.message.split("\n").slice(0, 4).join(" | ");
  if (typeof x === "string") return x.split("\n").slice(0, 6).join(" | ");
  try {
    return JSON.stringify(x).slice(0, 600);
  } catch {
    return String(x);
  }
}

// ───────────────────────────── auth-entry assembly ─────────────────────────────

/**
 * Given a simulation-produced SA SorobanAuthorizationEntry, recompute the host
 * signature_payload (sha256 of HashIDPreimage::SorobanAuthorization) and return
 * BOTH the 32 raw bytes and the cloned entry whose expiration ledger has been
 * pinned. This mirrors stellar-base auth.js authorizeEntry exactly, but we set
 * our OWN OZ AuthPayload ScVal as the signature (auth.js forces the
 * stellar-account multisig ScVal, which is wrong for an OZ SA).
 */
function computeSignaturePayload(
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
): { clone: xdr.SorobanAuthorizationEntry; signaturePayload: Uint8Array } {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const addrAuth = clone.credentials().address();
  addrAuth.signatureExpirationLedger(validUntilLedger);
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE));
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: addrAuth.nonce(),
      invocation: clone.rootInvocation(),
      signatureExpirationLedger: addrAuth.signatureExpirationLedger(),
    }),
  );
  const signaturePayload = Uint8Array.from(hash(preimage.toXDR()));
  return { clone, signaturePayload };
}

/** Build the Signer::External(verifier, key_data) ScVal exactly as soroban-sdk emits it. */
function externalSignerScVal(
  verifierAddr: string,
  pubkeyBytes: Uint8Array,
): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(verifierAddr).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(pubkeyBytes)),
  ]);
}

/**
 * Build the OZ AuthPayload ScVal:
 *   { signers: Map{ signer => sig64 }, context_rule_ids: Vec<u32> }
 * struct map keys are symbols sorted lexicographically: context_rule_ids < signers.
 */
function authPayloadScVal(
  signerScVal: xdr.ScVal,
  sig64: Uint8Array,
  contextRuleIds: number[],
): xdr.ScVal {
  const idsVec = xdr.ScVal.scvVec(contextRuleIds.map((n) => xdr.ScVal.scvU32(n)));
  const signersMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: signerScVal, val: xdr.ScVal.scvBytes(Buffer.from(sig64)) }),
  ]);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: idsVec }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: signersMap }),
  ]);
}

interface SignSpec {
  /** the Keypair that produces the 64-byte ed25519 signature */
  signingKey: Keypair;
  /** the Signer ScVal that appears as the AuthPayload map key (registered identity) */
  signerScVal: xdr.ScVal;
  /** context_rule_ids that the entry PRESENTS (must align by index with auth_contexts) */
  presentedIds: number[];
  /** context_rule_ids that are SIGNED OVER (= presentedIds for honest path; differs for tamper case (b)) */
  signedIds: number[];
  /** if set, flip this byte index of auth_digest before signing (tamper case (a)) */
  tamperDigestByte?: number;
}

/**
 * Sign one SA auth entry per the OZ scheme and return a cloned, signed entry.
 * The signature_payload is recomputed from the entry; auth_digest is built via
 * the proven builder over `signedIds`; the agent signs auth_digest; the
 * AuthPayload ScVal presents `presentedIds`.
 */
function signSaEntry(
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
  spec: SignSpec,
): { signed: xdr.SorobanAuthorizationEntry; authDigestHex: string } {
  const { clone, signaturePayload } = computeSignaturePayload(entry, validUntilLedger);

  let authDigest = computeAuthDigest(signaturePayload, spec.signedIds);
  if (spec.tamperDigestByte !== undefined) {
    const t = new Uint8Array(authDigest);
    t[spec.tamperDigestByte] = t[spec.tamperDigestByte]! ^ 0xff;
    authDigest = t;
  }

  const sig64 = Uint8Array.from(spec.signingKey.sign(Buffer.from(authDigest)));
  if (sig64.length !== 64) throw new Error(`ed25519 sig must be 64 bytes, got ${sig64.length}`);

  const payload = authPayloadScVal(spec.signerScVal, sig64, spec.presentedIds);
  // Round-trip the ScVal back through XDR to PROVE it is well-formed and stable.
  const rt = xdr.ScVal.fromXDR(payload.toXDR());
  if (!rt.toXDR().equals(payload.toXDR())) {
    throw new Error("AuthPayload ScVal failed XDR round-trip");
  }
  clone.credentials().address().signature(payload);
  return { signed: clone, authDigestHex: toHex(authDigest) };
}

// ───────────────────────────── tx build / submit ─────────────────────────────

interface DepositBuildResult {
  tx: import("@stellar/stellar-sdk").Transaction;
  saEntry: xdr.SorobanAuthorizationEntry;
  validUntilLedger: number;
}

/**
 * Build a deposit tx against `vaultId`, simulate it, and extract the SA's
 * SorobanAuthorizationEntry (the entry whose credential address is the SA).
 */
async function buildDepositTx(
  vaultId: string,
  saAddress: string,
  assets: bigint,
): Promise<DepositBuildResult> {
  const acct = await server.getAccount(ADMIN_ADDR);
  const c = new Contract(vaultId);
  const op = c.call(
    "deposit",
    new Address(saAddress).toScVal(),
    nativeToScVal(assets, { type: "i128" }),
  );
  const tx = new TransactionBuilder(acct, {
    fee: "2000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new SimError(sim.error);
  }
  const auths = sim.result?.auth ?? [];
  // Locate the SA entry (address credentials whose address == SA).
  let saEntry: xdr.SorobanAuthorizationEntry | undefined;
  for (const a of auths) {
    const cred = a.credentials();
    if (cred.switch().name === "sorobanCredentialsAddress") {
      const addr = Address.fromScAddress(cred.address().address()).toString();
      if (addr === saAddress) saEntry = a;
    }
  }
  if (!saEntry) {
    throw new Error(
      `no SA SorobanAuthorizationEntry found in simulation (auth entries: ${auths.length})`,
    );
  }
  const latest = await server.getLatestLedger();
  const validUntilLedger = latest.sequence + 1000;
  // Re-attach the simulation transaction data so the final tx is fee/footprint correct.
  return { tx, saEntry, validUntilLedger };
}

class SimError extends Error {}

/** Count the SA-relevant auth contexts in an entry's invocation tree (root + sub-invocations). */
function countAuthContexts(entry: xdr.SorobanAuthorizationEntry): {
  total: number;
  scopes: string[];
} {
  const scopes: string[] = [];
  const walk = (inv: xdr.SorobanAuthorizedInvocation) => {
    const fn = inv.function();
    if (fn.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
      const ci = fn.contractFn();
      scopes.push(
        `${Address.fromScAddress(ci.contractAddress()).toString()}::${ci.functionName().toString()}`,
      );
    }
    for (const sub of inv.subInvocations()) walk(sub);
  };
  walk(entry.rootInvocation());
  return { total: scopes.length, scopes };
}

interface SubmitOutcome {
  success: boolean;
  hash: string;
  errorCode: string;
  raw: string;
}

/**
 * Re-simulate (to get correct footprint/resource fees with our auth attached),
 * assemble, sign with admin (the tx-level source signature), submit, and poll.
 */
async function submitDeposit(
  vaultId: string,
  saAddress: string,
  assets: bigint,
  buildSpec: (
    saEntry: xdr.SorobanAuthorizationEntry,
    validUntilLedger: number,
  ) => SignSpec,
): Promise<SubmitOutcome> {
  // 1) Build + simulate to obtain the SA entry & invocation tree.
  const acct = await server.getAccount(ADMIN_ADDR);
  const c = new Contract(vaultId);
  const op = c.call(
    "deposit",
    new Address(saAddress).toScVal(),
    nativeToScVal(assets, { type: "i128" }),
  );
  const baseTx = new TransactionBuilder(acct, {
    fee: "2000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(baseTx);
  if (rpc.Api.isSimulationError(sim)) {
    return { success: false, hash: "", errorCode: classifyError(sim.error), raw: sim.error };
  }
  const auths = (sim.result?.auth ?? []).map((a) =>
    xdr.SorobanAuthorizationEntry.fromXDR(a.toXDR()),
  );
  let saIdx = -1;
  for (let i = 0; i < auths.length; i++) {
    const cred = auths[i]!.credentials();
    if (cred.switch().name === "sorobanCredentialsAddress") {
      const addr = Address.fromScAddress(cred.address().address()).toString();
      if (addr === saAddress) saIdx = i;
    }
  }
  if (saIdx < 0) {
    return { success: false, hash: "", errorCode: "NoSAEntry", raw: "no SA auth entry in sim" };
  }

  const latest = await server.getLatestLedger();
  const validUntilLedger = latest.sequence + 1000;
  const spec = buildSpec(auths[saIdx]!, validUntilLedger);
  const { signed } = signSaEntry(auths[saIdx]!, validUntilLedger, spec);
  auths[saIdx] = signed;

  // 2) Rebuild the operation WITH our signed auth entries explicitly attached,
  //    then re-simulate with those auths so the host computes the footprint/fees
  //    for the real (signed) invocation, then assemble.
  const acct2 = await server.getAccount(ADMIN_ADDR);
  const op2 = Operation.invokeHostFunction({
    func: invokeFunc(baseTx.operations[0]!),
    auth: auths,
  });
  const tx2 = new TransactionBuilder(acct2, {
    fee: "3000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op2)
    .setTimeout(180)
    .build();

  const sim2 = await server.simulateTransaction(tx2);
  if (rpc.Api.isSimulationError(sim2)) {
    return { success: false, hash: "", errorCode: classifyError(sim2.error), raw: sim2.error };
  }

  // assembleTransaction merges resource fees + soroban data but PRESERVES our auth.
  const assembled = rpc.assembleTransaction(tx2, sim2).build();
  const adminKp = Keypair.fromSecret(adminSecret());
  assembled.sign(adminKp);

  // 3) Submit + poll.
  let send;
  try {
    send = await server.sendTransaction(assembled);
  } catch (e) {
    return { success: false, hash: "", errorCode: classifyError(describeError(e)), raw: describeError(e) };
  }
  if (send.status === "ERROR") {
    const raw = JSON.stringify(send.errorResult?.toXDR?.("base64") ?? send);
    return { success: false, hash: send.hash, errorCode: classifyError(raw), raw };
  }
  const final = await server.pollTransaction(send.hash, { attempts: 20, sleepStrategy: () => 2000 });
  if (final.status === "SUCCESS") {
    return { success: true, hash: send.hash, errorCode: "", raw: "SUCCESS" };
  }
  const raw =
    (final as any).resultXdr?.toXDR?.("base64") ??
    (final as any).resultMetaXdr?.toXDR?.("base64") ??
    JSON.stringify(final);
  // Pull diagnostic events if present for a richer error code.
  let diag = "";
  try {
    const ev = (final as any).resultMetaXdr;
    if (ev) diag = JSON.stringify(ev).slice(0, 200);
  } catch {
    /* ignore */
  }
  return { success: false, hash: send.hash, errorCode: classifyError(raw + " " + diag), raw: raw + " " + diag };
}

/** Map a raw soroban/rpc error string to a compact AUTH error code. */
function classifyError(raw: string): string {
  const s = raw.toLowerCase();
  // ── 1) Explicit semantic markers FIRST. The bare numeric-code substrings
  //       ("3003","3014",...) can incidentally collide with byte-hex inside a
  //       diagnostic event dump, so the OZ-emitted semantic strings and the
  //       ed25519-verify failure markers take precedence. ──
  if (s.includes("externalverification")) return "ExternalVerificationFailed(3003)";
  if (s.includes("unauthorizedsigner")) return "UnauthorizedSigner(3016)";
  if (s.includes("unvalidatedcontext")) return "UnvalidatedContext(3002)";
  if (s.includes("contextrulenotfound")) return "ContextRuleNotFound(3000)";
  if (s.includes("lengthmismatch")) return "ContextRuleIdsLengthMismatch(3014)";
  // The OZ External-Ed25519 signer path: when the agent signs the WRONG digest
  // (tampered (a), wrong ids (b), or wrong key (c)), the ed25519 verifier traps
  // with Error(Crypto, InvalidInput) ("failed ED25519 verification"), which the
  // SA's __check_auth escalates to Error(Auth, InvalidAction). This IS the
  // ExternalVerificationFailed (3003-equivalent) outcome — the external signature
  // verification of auth_digest failed. Verified via the diagnostic event log:
  // [verify -> verify_sig_ed25519 -> "failed ED25519 verification" -> Crypto,
  //  InvalidInput -> "failed account authentication" -> Auth, InvalidAction].
  if (
    s.includes("failed ed25519 verification") ||
    s.includes("verify_sig_ed25519") ||
    (s.includes("error(crypto, invalidinput)") && (s.includes("verify") || s.includes("check_auth")))
  ) {
    return "ExternalVerificationFailed(3003)";
  }
  // ── 2) Bare numeric contract-error codes (only reached if no semantic match). ──
  if (s.includes("3003")) return "ExternalVerificationFailed(3003)";
  if (s.includes("3016")) return "UnauthorizedSigner(3016)";
  if (s.includes("3002")) return "UnvalidatedContext(3002)";
  if (s.includes("3000")) return "ContextRuleNotFound(3000)";
  if (s.includes("3014")) return "ContextRuleIdsLengthMismatch(3014)";
  // ── 3) Generic auth-layer fallbacks. ──
  if (s.includes("invalidaction") || s.includes("error(auth")) return "Auth/InvalidAction";
  if (s.includes("txsorobaninvalid") || s.includes("invokehostfunctionauth")) return "InvokeHostFunctionAuthFailed";
  if (s.includes("error(contract, #10)") || s.includes("contract, #10")) return "BalanceInsufficient(non-auth!)";
  return `unmapped(${raw.slice(0, 80)})`;
}

// ───────────────────────────── on-chain read helpers ─────────────────────────────

async function readContractU32OrI128(
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<bigint | null> {
  const acct = await server.getAccount(ADMIN_ADDR);
  const c = new Contract(contractId);
  const tx = new TransactionBuilder(acct, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(c.call(fn, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return null;
  const retval = sim.result?.retval;
  if (!retval) return null;
  try {
    const native = require("@stellar/stellar-sdk").scValToNative(retval);
    return typeof native === "bigint" ? native : BigInt(native);
  } catch {
    return null;
  }
}

async function saShareBalance(saAddress: string): Promise<bigint | null> {
  return readContractU32OrI128("CCY337D4WZ6OECCTQMWIMWT2CHBC73YY5JFRKBJ665O654KMUG3CP7YH", "balance", [
    new Address(saAddress).toScVal(),
  ]);
}

async function saXlmBalance(saAddress: string): Promise<bigint | null> {
  return readContractU32OrI128(XLM_SAC, "balance", [new Address(saAddress).toScVal()]);
}

async function ensureSaFunded(saAddress: string): Promise<void> {
  const bal = (await saXlmBalance(saAddress)) ?? 0n;
  if (bal >= DEPOSIT_AMOUNT * 2n) {
    console.log(`  SA XLM balance = ${bal} stroops (already funded; skipping top-up)`);
    return;
  }
  console.log(`  SA XLM balance = ${bal} stroops; funding +${FUND_AMOUNT} via XLM SAC (admin -> SA)`);
  const acct = await server.getAccount(ADMIN_ADDR);
  const sac = new Contract(XLM_SAC);
  const op = sac.call(
    "transfer",
    new Address(ADMIN_ADDR).toScVal(),
    new Address(saAddress).toScVal(),
    nativeToScVal(FUND_AMOUNT, { type: "i128" }),
  );
  const tx = new TransactionBuilder(acct, {
    fee: "2000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(Keypair.fromSecret(adminSecret()));
  const send = await server.sendTransaction(prepared);
  const final = await server.pollTransaction(send.hash, { attempts: 20, sleepStrategy: () => 2000 });
  if (final.status !== "SUCCESS") {
    throw new Error(`SA funding tx failed: ${final.status} (${send.hash})`);
  }
  const after = (await saXlmBalance(saAddress)) ?? 0n;
  console.log(`  funded. SA XLM balance now = ${after} stroops (tx ${send.hash})`);
}

// ───────────────────────────── on-chain rule-map reader (two-rule model) ─────────────────────────────
//
// The SA is deployed with TWO scoped rules (NO Default/master rule):
//   rule 0 = CallContract(VAULT_XLM)   rule 1 = CallContract(XLM_SAC)
// We read them straight off the live SA (get_context_rules_count +
// get_context_rule for each, parsing the CallContract scope) and build the
// authoritative on-chain map { contract_address -> rule_id }. The positive
// context_rule_ids vector is then derived purely from this map and the
// simulation's ordered auth contexts — NOTHING is hardcoded.

interface RuleInfo {
  id: number;
  /** the CallContract target contract address, or null if not a CallContract rule */
  callContract: string | null;
  /** raw context_type description (for logging non-CallContract scopes) */
  scopeDesc: string;
}

/**
 * Parse one rule from `get_context_rule(id)`. `scValToNative` decodes the OZ
 * `ContextRuleType::CallContract(addr)` enum as the array form
 * `["CallContract", "<C-addr>"]` (NOT an object). We also defensively handle the
 * object form `{ CallContract: "<C-addr>" }` in case SDK behavior changes.
 */
async function getRule(saAddress: string, id: number): Promise<RuleInfo | null> {
  const acct = await server.getAccount(ADMIN_ADDR);
  const c = new Contract(saAddress);
  const tx = new TransactionBuilder(acct, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(c.call("get_context_rule", xdr.ScVal.scvU32(id)))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return null;
  const retval = sim.result?.retval;
  if (!retval) return null;
  try {
    const native = require("@stellar/stellar-sdk").scValToNative(retval);
    const ct = native.context_type;
    let callContract: string | null = null;
    if (Array.isArray(ct) && ct.length >= 2 && ct[0] === "CallContract") {
      callContract = String(ct[1]);
    } else if (ct && typeof ct === "object" && "CallContract" in ct) {
      callContract = String(ct.CallContract);
    }
    const scopeDesc = JSON.stringify(ct);
    return { id, callContract, scopeDesc };
  } catch {
    return null;
  }
}

/**
 * Read ALL the SA's rules and return the authoritative on-chain map
 * { CallContract-target-contract -> rule_id }.
 */
async function readRuleMap(
  saAddress: string,
): Promise<{ byContract: Map<string, number>; rules: RuleInfo[] }> {
  const count = await readContractU32OrI128(saAddress, "get_context_rules_count", []);
  const total = count === null ? 0 : Number(count);
  const rules: RuleInfo[] = [];
  const byContract = new Map<string, number>();
  for (let id = 0; id < total; id++) {
    const r = await getRule(saAddress, id);
    if (!r) continue;
    rules.push(r);
    if (r.callContract) byContract.set(r.callContract, r.id);
  }
  return { byContract, rules };
}

/** The per-context auth scope: the target contract address of each context. */
function authContextContracts(entry: xdr.SorobanAuthorizationEntry): string[] {
  const out: string[] = [];
  const walk = (inv: xdr.SorobanAuthorizedInvocation) => {
    const fn = inv.function();
    if (fn.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
      out.push(Address.fromScAddress(fn.contractFn().contractAddress()).toString());
    }
    for (const sub of inv.subInvocations()) walk(sub);
  };
  walk(entry.rootInvocation());
  return out;
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<number> {
  const env = loadEnv();
  const SA = env.SA_ADDRESS!;
  const VAULT_XLM = env.VAULT_XLM!;
  const VERIFIER = env.ED25519_VERIFIER!;
  // Two-rule model: rule 0 = CallContract(VAULT_XLM), rule 1 = CallContract(XLM_SAC).
  // These env values are the EXPECTED ids; the actual mapping used for the
  // positive path is read live off-chain (readRuleMap) and never hardcoded.
  const RULE_VAULT_ID = Number(env.RULE_VAULT_ID ?? env.RULE_A_ID ?? "0");
  const RULE_SAC_ID = Number(env.RULE_SAC_ID ?? "1");
  const AGENT_PUBKEY = env.AGENT_PUBKEY!;
  const AGENT_PUBKEY_HEX = env.AGENT_PUBKEY_HEX!;
  const AGENT_SECRET = env.AGENT_SECRET!; // never printed
  const pubkeyBytes = fromHex(AGENT_PUBKEY_HEX);
  const agentKp = Keypair.fromSecret(AGENT_SECRET);

  // sanity: agent secret <-> pubkey consistency (no secret printed)
  if (agentKp.publicKey() !== AGENT_PUBKEY) {
    throw new Error("AGENT_SECRET does not correspond to AGENT_PUBKEY in env");
  }
  if (toHex(Uint8Array.from(agentKp.rawPublicKey())) !== AGENT_PUBKEY_HEX) {
    throw new Error("AGENT_PUBKEY_HEX does not match agent raw pubkey");
  }

  const agentSignerScVal = externalSignerScVal(VERIFIER, pubkeyBytes);

  console.log("════════════════════════════════════════════════════════════════");
  console.log(" P4 — M1 Auth-Digest Tracer: SA-authorized vault.deposit (testnet)");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(` SA (depositor)   : ${SA}`);
  console.log(` VAULT_XLM        : ${VAULT_XLM}`);
  console.log(` XLM_SAC          : ${XLM_SAC}`);
  console.log(` ED25519_VERIFIER : ${VERIFIER}`);
  console.log(` agent pubkey     : ${AGENT_PUBKEY}`);
  console.log(` expected rules   : rule ${RULE_VAULT_ID}=CallContract(VAULT_XLM), rule ${RULE_SAC_ID}=CallContract(XLM_SAC)`);
  console.log(` tx source/admin  : ${ADMIN_ADDR}`);
  console.log(` deposit amount   : ${DEPOSIT_AMOUNT} stroops`);
  console.log("");

  // ── Step 1: fund the SA so it can transfer `assets` on deposit ──
  console.log("[1] Funding the SA with XLM (admin -> SA via XLM SAC)");
  await ensureSaFunded(SA);
  console.log("");

  // ── Step 2: read the SA's rules off-chain and build the authoritative map ──
  console.log("[2] Reading SA context rules on-chain (get_context_rules_count + get_context_rule)");
  const ruleMap = await readRuleMap(SA);
  for (const r of ruleMap.rules) {
    console.log(`    rule ${r.id}: scope=${r.scopeDesc}${r.callContract ? ` -> CallContract(${r.callContract})` : ""}`);
  }
  console.log(`    on-chain map { contract -> rule_id }: ${[...ruleMap.byContract.entries()].map(([c, id]) => `${c}=>${id}`).join(", ")}`);
  // Verify the env's expected ids match what is actually installed (no hardcode):
  if (ruleMap.byContract.get(VAULT_XLM) !== RULE_VAULT_ID) {
    console.log(`    WARNING: VAULT_XLM rule id on-chain (${ruleMap.byContract.get(VAULT_XLM)}) != env RULE_VAULT_ID (${RULE_VAULT_ID}); using on-chain.`);
  }
  if (ruleMap.byContract.get(XLM_SAC) !== RULE_SAC_ID) {
    console.log(`    WARNING: XLM_SAC rule id on-chain (${ruleMap.byContract.get(XLM_SAC)}) != env RULE_SAC_ID (${RULE_SAC_ID}); using on-chain.`);
  }
  console.log("");

  // ── Step 3: simulate deposit, inspect ordered auth contexts, derive per-context ids ──
  console.log("[3] Simulating deposit to obtain the SA's ordered auth contexts");
  const probe = await buildDepositTx(VAULT_XLM, SA, DEPOSIT_AMOUNT);
  const ctxInfo = countAuthContexts(probe.saEntry);
  const ctxContracts = authContextContracts(probe.saEntry);
  console.log(`    SA auth contexts (${ctxInfo.total}): ${ctxInfo.scopes.join("  |  ")}`);

  // PER-CONTEXT RULE MAPPING: context_rule_ids[i] = the rule id whose CallContract
  // scope == auth_contexts[i]'s target contract. Derived purely from the on-chain
  // rule map + the simulation's context order. For a normal deposit this is
  // [VAULT_rule, SAC_rule] (typically [0,1]) — NOT hardcoded to [0,0].
  const unmatchedContexts: string[] = [];
  const positiveContextIds = ctxContracts.map((contract) => {
    const id = ruleMap.byContract.get(contract);
    if (id === undefined) {
      unmatchedContexts.push(contract);
      return -1;
    }
    return id;
  });
  console.log(`    derived context_rule_ids = [${positiveContextIds.join(",")}] (by-scope map per context)`);
  if (unmatchedContexts.length > 0) {
    console.log(`    ERROR: ${unmatchedContexts.length} auth context(s) have NO matching rule scope: ${unmatchedContexts.join(", ")}`);
  }
  console.log("");

  // ── Step 4: positive deposit with the per-context rule ids ──
  console.log("[4] Positive deposit: agent signs auth_digest over the derived context_rule_ids");
  let positive: SubmitOutcome;
  if (unmatchedContexts.length > 0) {
    positive = {
      success: false,
      hash: "",
      errorCode: "ScopeGap(no-rule-for-context)",
      raw: `auth context(s) without a matching rule: ${unmatchedContexts.join(", ")}`,
    };
    console.log(`    -> aborted: ${positive.raw}`);
  } else {
    positive = await submitDeposit(VAULT_XLM, SA, DEPOSIT_AMOUNT, (entry, vu) => ({
      signingKey: agentKp,
      signerScVal: agentSignerScVal,
      presentedIds: positiveContextIds,
      signedIds: positiveContextIds,
    }));
    console.log(`    context_rule_ids presented = [${positiveContextIds.join(",")}]`);
    console.log(`    -> success=${positive.success} hash=${positive.hash || "-"} error=${positive.errorCode}`);
  }

  // ── Step 5: record on-chain effect of the positive deposit ──
  let depositEffect = "";
  if (positive.success) {
    const sharesAfter = await saShareBalance(SA);
    const xlmAfter = await saXlmBalance(SA);
    depositEffect =
      `SA vault-share balance after deposit = ${sharesAfter ?? "?"}; ` +
      `SA XLM balance after deposit = ${xlmAfter ?? "?"} stroops ` +
      `(shares minted to SA + SA XLM decreased by ~${DEPOSIT_AMOUNT} via deposit ${positive.hash})`;
    console.log("");
    console.log(`[5] On-chain effect: ${depositEffect}`);
  }

  // ── Step 7: negative paths (only meaningful if we have a working positive) ──
  console.log("");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(" NEGATIVE PATHS (AC5) — each MUST revert fail-closed (AUTH error)");
  console.log("════════════════════════════════════════════════════════════════");

  const negatives: Array<{ name: string; reverted: boolean; failedClosed: boolean; errorCode: string }> = [];

  // Only run negatives if the positive path is genuinely working (otherwise the
  // negatives can't be distinguished from the same scope failure).
  const canRunNegatives = positive.success;
  const wrongKp = Keypair.random(); // an UNregistered ed25519 key

  if (!canRunNegatives) {
    console.log(" Positive path did not succeed; negatives cannot be meaningfully isolated.");
    for (const name of ["tampered-digest", "wrong-context-rule-ids", "non-registered-key", "out-of-scope-contract"]) {
      negatives.push({ name, reverted: false, failedClosed: false, errorCode: "skipped(no-positive)" });
    }
  } else {
    // (a) tampered-digest: flip a byte of auth_digest before signing.
    console.log("[neg-a] tampered-digest (flip a byte of auth_digest before signing)");
    const negA = await submitDeposit(VAULT_XLM, SA, DEPOSIT_AMOUNT, (entry, vu) => ({
      signingKey: agentKp,
      signerScVal: agentSignerScVal,
      presentedIds: positiveContextIds,
      signedIds: positiveContextIds,
      tamperDigestByte: 0,
    }));
    const aFailClosed = !negA.success && isAuthError(negA.errorCode);
    console.log(`    -> reverted=${!negA.success} failClosed=${aFailClosed} error=${negA.errorCode}`);
    negatives.push({ name: "tampered-digest", reverted: !negA.success, failedClosed: aFailClosed, errorCode: negA.errorCode });

    // (b) wrong-context-rule-ids — CLEAN id-binding test that REACHES the signature
    //     check. Present the CORRECT context_rule_ids (so every context validates
    //     against an installed rule), but SIGN the auth_digest computed over a
    //     DIFFERENT valid permutation of the same ids (the reversed vector). The
    //     contract recomputes auth_digest from the PRESENTED ids; the signature was
    //     over the reversed ids -> external ed25519 verify of that digest fails ->
    //     ExternalVerificationFailed(3003). We intentionally AVOID non-existent ids
    //     like [7,7] (that yields a not-found error, not a digest-binding proof).
    console.log("[neg-b] wrong-context-rule-ids (present correct ids; sign over a DIFFERENT valid permutation)");
    const reversedSignedIds = [...positiveContextIds].reverse();
    // Guard: if the reversed permutation equals the original (e.g. all-equal ids),
    // this test would be a no-op; the two-rule deposit gives distinct ids [0,1].
    if (reversedSignedIds.join(",") === positiveContextIds.join(",")) {
      console.log(`    NOTE: reversed ids == presented ids ([${positiveContextIds.join(",")}]); digest would match — test not a binding proof.`);
    }
    const negB = await submitDeposit(VAULT_XLM, SA, DEPOSIT_AMOUNT, (entry, vu) => ({
      signingKey: agentKp,
      signerScVal: agentSignerScVal,
      presentedIds: positiveContextIds, // entry presents the CORRECT ids (contexts validate)
      signedIds: reversedSignedIds, // but the signature commits to a DIFFERENT valid permutation
    }));
    const bFailClosed = !negB.success && isAuthError(negB.errorCode);
    console.log(`    presented=[${positiveContextIds.join(",")}] signed-over=[${reversedSignedIds.join(",")}]`);
    console.log(`    -> reverted=${!negB.success} failClosed=${bFailClosed} error=${negB.errorCode}`);
    negatives.push({ name: "wrong-context-rule-ids", reverted: !negB.success, failedClosed: bFailClosed, errorCode: negB.errorCode });

    // (c) non-registered-key: sign with a DIFFERENT (unregistered) ed25519 key.
    //     Present the registered Signer identity but sign with the wrong key ->
    //     external ed25519 verify must fail.
    console.log("[neg-c] non-registered-key (sign auth_digest with an unregistered ed25519 key)");
    const negC = await submitDeposit(VAULT_XLM, SA, DEPOSIT_AMOUNT, (entry, vu) => ({
      signingKey: wrongKp, // wrong private key
      signerScVal: agentSignerScVal, // registered identity as the map key
      presentedIds: positiveContextIds,
      signedIds: positiveContextIds,
    }));
    const cFailClosed = !negC.success && isAuthError(negC.errorCode);
    console.log(`    -> reverted=${!negC.success} failClosed=${cFailClosed} error=${negC.errorCode}`);
    negatives.push({ name: "non-registered-key", reverted: !negC.success, failedClosed: cFailClosed, errorCode: negC.errorCode });

    // (d) out-of-scope-contract: SA authorizes a deposit on a DIFFERENT vault not
    //     in the rule scope (legacy vault-xlm v1). Even a correctly-signed digest
    //     must be rejected because no rule covers CallContract(v1).
    console.log("[neg-d] out-of-scope-contract (deposit on vault-xlm v1, not in any rule scope)");
    const negD = await submitDeposit(VAULT_XLM_V1, SA, DEPOSIT_AMOUNT, (entry, vu) => {
      // Present the agent's VAULT rule id for every context. No rule's CallContract
      // scope == VAULT_XLM_V1, so OZ do_check_auth fails to validate the
      // deposit@VAULT_XLM_V1 context -> UnvalidatedContext(3002), regardless of a
      // correct signature.
      const ids = countAuthContexts(entry).scopes.map(() => RULE_VAULT_ID);
      return {
        signingKey: agentKp,
        signerScVal: agentSignerScVal,
        presentedIds: ids,
        signedIds: ids,
      };
    });
    // For (d) the AUTH revert is the proof; a non-auth balance/setup error would
    // NOT count. classifyError flags BalanceInsufficient distinctly.
    const dIsAuth = isAuthError(negD.errorCode);
    const dFailClosed = !negD.success && dIsAuth;
    console.log(`    target vault = ${VAULT_XLM_V1}`);
    console.log(`    -> reverted=${!negD.success} failClosed=${dFailClosed} error=${negD.errorCode}`);
    negatives.push({ name: "out-of-scope-contract", reverted: !negD.success, failedClosed: dFailClosed, errorCode: negD.errorCode });
  }

  // ── Summary ──
  console.log("");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(" SUMMARY");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(` positive deposit SUCCEEDED : ${positive.success}`);
  console.log(` positive tx hash           : ${positive.hash || "-"}`);
  console.log(` context_rule_ids (positive): [${positiveContextIds.join(",")}]`);
  console.log(` deposit effect             : ${depositEffect || "(none — positive failed)"}`);
  for (const n of negatives) {
    console.log(`  neg ${n.name.padEnd(24)} reverted=${n.reverted} failClosed=${n.failedClosed} error=${n.errorCode}`);
  }
  const allNegFailClosed = negatives.length === 4 && negatives.every((n) => n.failedClosed);
  console.log(` all 4 negatives fail-closed: ${allNegFailClosed}`);

  const ok = positive.success && allNegFailClosed;
  console.log("");
  console.log(ok ? " RESULT: PASS (positive succeeded + all negatives fail-closed)" : " RESULT: FAIL");

  // Emit a machine-readable trailer for the orchestrator.
  console.log("");
  console.log("JSON_RESULT " + JSON.stringify({
    positiveDepositSucceeded: positive.success,
    positiveTxHash: positive.hash,
    contextRuleIds: positiveContextIds,
    onChainRuleMap: [...ruleMap.byContract.entries()].map(([c, id]) => ({ contract: c, ruleId: id })),
    depositEffect,
    negatives,
    allNegativesFailClosed: allNegFailClosed,
  }));

  return ok ? 0 : 1;
}

function isAuthError(code: string): boolean {
  const c = code.toLowerCase();
  if (c.includes("non-auth")) return false;
  return (
    c.includes("externalverification") ||
    c.includes("unauthorizedsigner") ||
    c.includes("unvalidatedcontext") ||
    c.includes("contextrulenotfound") ||
    c.includes("lengthmismatch") ||
    c.includes("auth(") ||
    c.includes("auth/") ||
    c.includes("invokehostfunctionauth")
  );
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL:", e?.stack || e);
    process.exit(2);
  });
