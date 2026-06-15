/**
 * One-time migration: for every agent with an empty strategies[] but legacy
 * flat rules set, synthesize dip_buy + take_profit entries. Idempotent — skips
 * agents that already have strategies. Run with:
 *   cd agent && node --import tsx scripts/migrate-strategies.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Agent, connectDB } from '../src/services/db';
import { flatRulesToStrategies } from '../src/services/strategy-mapping';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await connectDB(uri);

  const agents = await Agent.find({});
  let migrated = 0;
  for (const a of agents) {
    if (Array.isArray((a as any).strategies) && (a as any).strategies.length > 0) continue;
    const synthesized = flatRulesToStrategies({
      buyBelowUsd: (a as any).buyBelowUsd,
      sellAboveUsd: (a as any).sellAboveUsd,
      buyAmountUsdc: (a as any).buyAmountUsdc,
      sellAmountXlm: (a as any).sellAmountXlm,
    });
    if (synthesized.length === 0) continue;
    (a as any).strategies = synthesized as any;
    await a.save();
    migrated++;
    console.log(`Migrated ${a.agentAddress}: ${synthesized.map((s) => s.type).join(', ')}`);
  }
  console.log(`Done. Migrated ${migrated} of ${agents.length} agents.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
