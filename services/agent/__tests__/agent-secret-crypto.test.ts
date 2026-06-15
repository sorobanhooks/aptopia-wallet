/**
 * Tests for envelope encryption helpers.
 *
 * Covers:
 * 1. Round-trip: encrypt → decrypt yields identical plaintext
 * 2. Wrong KEK throws (GCM auth failure)
 * 3. All 4 output fields are valid base64 strings
 * 4. Keypair round-trip: decrypt → Keypair.fromSecret produces expected public key
 *
 * The migration script idempotency is tested via the logic-level test below
 * (not requiring a live Mongo connection).
 */

import { encryptAgentSecret, decryptAgentSecret, EncryptedSecret } from '../src/services/agent-secret-crypto';
import { Keypair } from 'stellar-sdk';

// A well-formed Stellar test keypair (deterministic, safe to use in tests — not used in production).
const TEST_SECRET = 'SBKDAZ64N63E4V6CSJXOCZP2ZXDFZG5LBGCG5DCRQFZHRIXCES7FL2OD';
const TEST_PUBLIC = Keypair.fromSecret(TEST_SECRET).publicKey();

// 32 zero bytes as base64 — clearly fake, only for testing.
const FAKE_KEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
// 32 bytes of 0x01 — a different fake key for wrong-key tests.
const WRONG_KEK = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

function withKek(kek: string, fn: () => void) {
  const prev = process.env.AGENT_SECRET_KEK_BASE64;
  process.env.AGENT_SECRET_KEK_BASE64 = kek;
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env.AGENT_SECRET_KEK_BASE64;
    } else {
      process.env.AGENT_SECRET_KEK_BASE64 = prev;
    }
  }
}

describe('encryptAgentSecret / decryptAgentSecret', () => {
  test('round-trip: encrypt then decrypt yields original plaintext', () => {
    let encrypted: EncryptedSecret;
    withKek(FAKE_KEK, () => {
      encrypted = encryptAgentSecret(TEST_SECRET);
    });

    let decrypted: string;
    withKek(FAKE_KEK, () => {
      decrypted = decryptAgentSecret(encrypted!);
    });

    expect(decrypted!).toBe(TEST_SECRET);
  });

  test('all 4 output fields are non-empty valid base64 strings', () => {
    let encrypted: EncryptedSecret;
    withKek(FAKE_KEK, () => {
      encrypted = encryptAgentSecret(TEST_SECRET);
    });

    const fields: (keyof EncryptedSecret)[] = [
      'agentSecretCiphertext',
      'agentSecretIv',
      'agentSecretDekWrapped',
      'agentSecretDekIv',
    ];

    for (const field of fields) {
      const val = encrypted![field];
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
      // Must round-trip through base64 without data loss.
      expect(Buffer.from(val, 'base64').toString('base64')).toBe(val);
    }
  });

  test('decrypt with wrong KEK throws (GCM authentication failure)', () => {
    let encrypted: EncryptedSecret;
    withKek(FAKE_KEK, () => {
      encrypted = encryptAgentSecret(TEST_SECRET);
    });

    expect(() => {
      withKek(WRONG_KEK, () => {
        decryptAgentSecret(encrypted!);
      });
    }).toThrow();
  });

  test('encrypt produces different ciphertext each call (random IVs)', () => {
    let enc1: EncryptedSecret;
    let enc2: EncryptedSecret;
    withKek(FAKE_KEK, () => {
      enc1 = encryptAgentSecret(TEST_SECRET);
      enc2 = encryptAgentSecret(TEST_SECRET);
    });

    // Different random IVs → different ciphertexts.
    expect(enc1!.agentSecretIv).not.toBe(enc2!.agentSecretIv);
    expect(enc1!.agentSecretCiphertext).not.toBe(enc2!.agentSecretCiphertext);
  });

  test('missing AGENT_SECRET_KEK_BASE64 throws', () => {
    const prev = process.env.AGENT_SECRET_KEK_BASE64;
    delete process.env.AGENT_SECRET_KEK_BASE64;
    try {
      expect(() => encryptAgentSecret(TEST_SECRET)).toThrow(
        /AGENT_SECRET_KEK_BASE64 is not set/
      );
    } finally {
      if (prev !== undefined) {
        process.env.AGENT_SECRET_KEK_BASE64 = prev;
      }
    }
  });

  test('wrong-length KEK throws with clear message', () => {
    // 16 bytes — too short for AES-256.
    const shortKek = Buffer.alloc(16).toString('base64');
    expect(() => {
      withKek(shortKek, () => {
        encryptAgentSecret(TEST_SECRET);
      });
    }).toThrow(/32 bytes/);
  });

  test('Keypair.fromSecret(decrypted) produces expected public key', () => {
    let encrypted: EncryptedSecret;
    withKek(FAKE_KEK, () => {
      encrypted = encryptAgentSecret(TEST_SECRET);
    });

    let publicKey: string;
    withKek(FAKE_KEK, () => {
      const decrypted = decryptAgentSecret(encrypted!);
      publicKey = Keypair.fromSecret(decrypted).publicKey();
    });

    expect(publicKey!).toBe(TEST_PUBLIC);
  });
});

describe('Migration idempotency (logic-level)', () => {
  /**
   * Simulate the migration logic: a document with agentSecret should be
   * migrated; a document that already has agentSecretCiphertext + no agentSecret
   * should be skipped.
   */

  function shouldMigrate(doc: Record<string, unknown>): boolean {
    return (
      typeof doc['agentSecret'] === 'string' &&
      doc['agentSecretCiphertext'] === undefined
    );
  }

  test('unencrypted doc is selected for migration', () => {
    const doc = { agentSecret: TEST_SECRET };
    expect(shouldMigrate(doc)).toBe(true);
  });

  test('already-migrated doc is skipped', () => {
    let enc: EncryptedSecret;
    withKek(FAKE_KEK, () => {
      enc = encryptAgentSecret(TEST_SECRET);
    });
    const migratedDoc = { ...enc! }; // no agentSecret field
    expect(shouldMigrate(migratedDoc)).toBe(false);
  });

  test('re-encrypting already-migrated doc via shouldMigrate is a no-op', () => {
    // Simulate running migration twice: second pass should find nothing to do.
    let enc: EncryptedSecret;
    withKek(FAKE_KEK, () => {
      enc = encryptAgentSecret(TEST_SECRET);
    });
    const migratedDoc = { ...enc! };

    // Second "migration" check — must skip.
    expect(shouldMigrate(migratedDoc)).toBe(false);

    // Decrypt still works correctly (doc was not corrupted).
    let decrypted: string;
    withKek(FAKE_KEK, () => {
      decrypted = decryptAgentSecret(migratedDoc);
    });
    expect(decrypted!).toBe(TEST_SECRET);
  });
});
