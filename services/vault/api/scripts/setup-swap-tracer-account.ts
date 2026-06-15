#!/usr/bin/env bun
// One-off setup: generate a funded testnet account with a USDC trustline,
// then write vault/api/scripts/.swap-tracer.env so tracer-swap-build.ts can run.
//
// Usage: bun run scripts/setup-swap-tracer-account.ts
// Safe to run multiple times — if the account already exists on-chain, friendbot
// will return an error we ignore (it already has funds).

import { Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { Horizon } from "@stellar/stellar-sdk";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_OUT = resolve(__dirname, ".swap-tracer.env");

// Circle USDC on testnet (the token in the Soroswap XLM/USDC pool)
const CIRCLE_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const CIRCLE_USDC = new Asset("USDC", CIRCLE_USDC_ISSUER);

const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

// 1. Generate a fresh keypair
const kp = Keypair.random();
const pub = kp.publicKey();
const secret = kp.secret();
console.log(`Generated keypair: public=${pub}`);

// 2. Fund via friendbot (gives ~10,000 XLM on testnet)
console.log("Funding via friendbot...");
let funded = false;
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    const resp = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(pub)}`);
    if (resp.ok) {
      console.log(`  Friendbot funded on attempt ${attempt}`);
      funded = true;
      break;
    } else {
      const text = await resp.text();
      console.warn(`  Friendbot attempt ${attempt} failed (${resp.status}): ${text.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`  Friendbot attempt ${attempt} threw: ${e}`);
  }
  if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
}
if (!funded) {
  console.error("BLOCKED: friendbot failed after 2 attempts");
  process.exit(1);
}

// Wait briefly for the account to propagate on Horizon
await new Promise((r) => setTimeout(r, 3000));

// 3. Establish USDC trustline so the account can receive Circle USDC as swap output
console.log("Establishing Circle USDC trustline...");
let trustlineOk = false;
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    const account = await horizon.loadAccount(pub);
    const tx = new TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: CIRCLE_USDC }))
      .setTimeout(120)
      .build();
    tx.sign(kp);
    const result = await horizon.submitTransaction(tx);
    if (result.successful) {
      console.log(`  Trustline established on attempt ${attempt} (hash: ${result.hash})`);
      trustlineOk = true;
      break;
    } else {
      console.warn(`  Trustline attempt ${attempt}: not successful`, JSON.stringify((result as any).extras?.result_codes));
    }
  } catch (e) {
    console.warn(`  Trustline attempt ${attempt} threw: ${e}`);
  }
  if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
}
if (!trustlineOk) {
  console.error("BLOCKED: trustline submission failed after 2 attempts");
  process.exit(1);
}

// 4. Write .swap-tracer.env (gitignored)
const envContent = [
  `SWAP_TRACER_SECRET=${secret}`,
  `SWAP_TRACER_TOKEN_IN=xlm`,
  `SWAP_TRACER_TOKEN_OUT=usdc`,
  `SWAP_TRACER_AMOUNT_IN=10000000`,
  "",
].join("\n");

writeFileSync(ENV_OUT, envContent, { encoding: "utf8" });
console.log(`Written: ${ENV_OUT}`);
console.log("Setup complete. Run: bun run tracer:swap-build");
