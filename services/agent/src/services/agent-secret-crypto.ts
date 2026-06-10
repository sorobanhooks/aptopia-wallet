/**
 * Envelope encryption helpers for agent secrets.
 *
 * Each agent secret is encrypted with a randomly-generated per-agent data key
 * (DEK).  The DEK itself is wrapped (encrypted) by a master key held in the
 * environment variable AGENT_SECRET_KEK_BASE64 (32-byte base64-encoded key).
 *
 * All encryption uses AES-256-GCM from Node's built-in `crypto` module.
 *
 * Layout:
 *   agentSecretCiphertext — base64(ciphertext || authTag)   (secret encrypted by DEK)
 *   agentSecretIv         — base64(12-byte IV for above)
 *   agentSecretDekWrapped — base64(ciphertext || authTag)   (DEK encrypted by KEK)
 *   agentSecretDekIv      — base64(12-byte IV for above)
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const GCM_IV_BYTES = 12;
const KEY_BYTES = 32; // AES-256
const AUTH_TAG_BYTES = 16;

export interface EncryptedSecret {
  agentSecretCiphertext: string;
  agentSecretIv: string;
  agentSecretDekWrapped: string;
  agentSecretDekIv: string;
}

function getKek(): Buffer {
  const raw = process.env.AGENT_SECRET_KEK_BASE64;
  if (!raw) {
    throw new Error('AGENT_SECRET_KEK_BASE64 is not set');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `AGENT_SECRET_KEK_BASE64 must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`
    );
  }
  return key;
}

/** AES-256-GCM encrypt; returns base64(ciphertext || authTag) and base64 IV. */
function gcmEncrypt(
  key: Buffer,
  plaintext: Buffer
): { ciphertextAndTag: string; iv: string } {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertextAndTag: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/** AES-256-GCM decrypt; expects base64(ciphertext || authTag) and base64 IV. */
function gcmDecrypt(
  key: Buffer,
  ciphertextAndTagB64: string,
  ivB64: string
): Buffer {
  const iv = Buffer.from(ivB64, 'base64');
  const blob = Buffer.from(ciphertextAndTagB64, 'base64');
  if (blob.length < AUTH_TAG_BYTES) {
    throw new Error('Encrypted blob too short to contain auth tag');
  }
  const ciphertext = blob.subarray(0, blob.length - AUTH_TAG_BYTES);
  const tag = blob.subarray(blob.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypts a plaintext agent secret using envelope encryption.
 * Generates a fresh random DEK per call; wraps DEK with the KEK from env.
 */
export function encryptAgentSecret(plaintext: string): EncryptedSecret {
  const kek = getKek();
  const dek = randomBytes(KEY_BYTES);

  // Encrypt the secret with the DEK.
  const { ciphertextAndTag: agentSecretCiphertext, iv: agentSecretIv } =
    gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'));

  // Wrap the DEK with the KEK.
  const { ciphertextAndTag: agentSecretDekWrapped, iv: agentSecretDekIv } =
    gcmEncrypt(kek, dek);

  return {
    agentSecretCiphertext,
    agentSecretIv,
    agentSecretDekWrapped,
    agentSecretDekIv,
  };
}

/**
 * Decrypts an encrypted agent secret record.
 * Throws if the KEK is wrong (GCM authentication failure).
 */
export function decryptAgentSecret(record: EncryptedSecret): string {
  const kek = getKek();

  // Unwrap the DEK.
  const dek = gcmDecrypt(kek, record.agentSecretDekWrapped, record.agentSecretDekIv);

  // Decrypt the secret with the DEK.
  const plaintext = gcmDecrypt(dek, record.agentSecretCiphertext, record.agentSecretIv);
  return plaintext.toString('utf8');
}
