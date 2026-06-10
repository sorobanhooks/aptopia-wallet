/**
 * One-time migration script: encrypt plaintext agentSecret → 4-field envelope encryption.
 *
 * Idempotent: documents that already have agentSecretCiphertext (and lack agentSecret)
 * are silently skipped.  Re-running is a no-op.
 *
 * Run after setting AGENT_SECRET_KEK_BASE64 and MONGODB_URI in env:
 *   ts-node -P tsconfig.scripts.json scripts/encrypt-existing-agents.ts
 *
 * Or after building with tsconfig.scripts.json:
 *   node dist-scripts/scripts/encrypt-existing-agents.js
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { encryptAgentSecret } from '../src/services/agent-secret-crypto.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || '';

if (!MONGO_URI) {
  console.error('MONGODB_URI (or MONGO_URI) env var is required');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const collection = mongoose.connection.collection('agents');

  // Find all documents that still have a plaintext agentSecret field.
  const cursor = collection.find({
    agentSecret: { $exists: true },
    agentSecretCiphertext: { $exists: false },
  });

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for await (const doc of cursor) {
    const plaintext = doc.agentSecret as string | undefined;
    if (!plaintext) {
      console.warn(`Doc ${doc._id}: agentSecret is empty — skipping`);
      skipped++;
      continue;
    }

    try {
      const encrypted = encryptAgentSecret(plaintext);
      await collection.updateOne(
        { _id: doc._id },
        {
          $set: encrypted,
          $unset: { agentSecret: '' },
        }
      );
      migrated++;
      console.log(`Migrated agent ${doc._id}`);
    } catch (err) {
      console.error(`Failed to migrate agent ${doc._id}:`, err);
      errors++;
    }
  }

  // Count already-migrated docs (has ciphertext, no plaintext secret).
  const alreadyMigrated = await collection.countDocuments({
    agentSecretCiphertext: { $exists: true },
    agentSecret: { $exists: false },
  });

  console.log(
    `\nMigration complete.\n  Migrated now: ${migrated}\n  Already migrated (skipped): ${alreadyMigrated}\n  Skipped (empty secret): ${skipped}\n  Errors: ${errors}`
  );

  await mongoose.disconnect();
  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
