/**
 * Local-testing seed: creates ONE real agent owned by a fresh testnet wallet,
 * so the extension can auth (SIWE) as that wallet and manage the agent without
 * the Telegram bot. Reuses the backend's own envelope-encryption (same KEK as
 * the running server) so the agent secret is decryptable in-app.
 *
 *   npx ts-node scripts/seed-agent.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Keypair } from 'stellar-sdk';
import { Agent, AgentLog } from '../src/services/db';
import { encryptAgentSecret } from '../src/services/agent-secret-crypto';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(uri);

  const owner = Keypair.random(); // the user's MAIN wallet (import this in the extension)
  const agent = Keypair.random(); // the agent worker wallet
  const enc = encryptAgentSecret(agent.secret());
  const telegramId = 'seed-local-' + Date.now();

  const doc = await Agent.create({
    telegramId,
    agentAddress: agent.publicKey(),
    ...enc,
    targetWallet: owner.publicKey(), // ownership == authed pubkey
    chain: 'stellar',
    token: 'XLM',
    tier1Max: 50,
    tier2Max: 200,
    buyBelowUsd: 0.1,
    sellAboveUsd: 0.2,
    requireTradeConfirmation: true,
    dailyBudget: 100,
    buyAmountUsdc: 5,
    sellAmountXlm: 10,
    active: true,
    usdcTrustlineReady: true,
    totalSuccessfulTrades: 2,
  });

  // A couple of trade logs so the ActivityLog + AI narration (C2) have content.
  await AgentLog.create([
    {
      agentId: doc._id,
      telegramId,
      workerAddress: agent.publicKey(),
      eventType: 'trade',
      status: 'success',
      token: 'XLM',
      amount: '12.5',
      reason: 'XLM price 0.085 USD fell below the buy threshold of 0.10 USD',
      txHash: 'seedtxsuccess0000000000000000000000000000000000000000000000000001',
    },
    {
      agentId: doc._id,
      telegramId,
      workerAddress: agent.publicKey(),
      eventType: 'trade',
      status: 'failure',
      token: 'USDC',
      amount: '5',
      reason: 'Daily USDC budget reached; trade skipped',
    },
  ]);

  let fund = 'skipped';
  try {
    const r = await fetch('https://friendbot.stellar.org/?addr=' + owner.publicKey());
    fund = 'HTTP ' + r.status;
  } catch (e) {
    fund = 'failed: ' + (e instanceof Error ? e.message : String(e));
  }

  console.log('=== SEEDED AGENT ===');
  console.log('OWNER_PUBKEY=' + owner.publicKey());
  console.log('OWNER_SECRET=' + owner.secret());
  console.log('AGENT_ADDRESS=' + agent.publicKey());
  console.log('AGENT_ID=' + doc._id);
  console.log('FRIENDBOT=' + fund);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('SEED FAILED:', e);
  process.exit(1);
});
