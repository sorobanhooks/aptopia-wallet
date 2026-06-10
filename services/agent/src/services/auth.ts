import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Keypair, StrKey } from 'stellar-sdk';
import { config } from '../config';

/**
 * SIWE-style authentication for the wallet-facing /v1/* API.
 *
 * Flow:
 *   1. Wallet POSTs /v1/auth/challenge { pubkey } → server returns a nonce +
 *      a canonical `message` string (SEP-53 style) to be signed.
 *   2. Wallet signs the SEP-53 hash of `message` with the account key and POSTs
 *      /v1/auth/verify { pubkey, signature, message }.
 *   3. Server re-derives the hash, verifies the ed25519 signature against
 *      `pubkey`, and issues a short-lived HS256 JWT keyed on { sub: pubkey }.
 *
 * The signing format mirrors the wallet's `encodeSep53Message`:
 *   sha256("Stellar Signed Message:\n" + message)
 * so the extension's existing message-signing primitive produces a signature
 * this server can verify with stellar-sdk's Keypair.verify.
 */

/** SEP-53 domain-separation prefix — MUST match the wallet's SIGN_MESSAGE_PREFIX. */
const SEP53_PREFIX = 'Stellar Signed Message:\n';

/** How long a challenge nonce stays valid before it must be re-requested. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Issued JWT lifetime. */
const JWT_TTL_SECONDS = 15 * 60; // 15 minutes

export interface AuthChallenge {
  nonce: string;
  domain: string;
  statement: string;
  issuedAt: string;
  expiresAt: string;
  /** Canonical string the wallet signs (SEP-53 hashed). */
  message: string;
}

export interface AuthTokenResult {
  token: string;
  expiresAt: string;
}

export interface AuthClaims {
  /** The authenticated Stellar public key (G...). */
  pubkey: string;
}

/**
 * In-memory store of issued challenges keyed by the exact canonical message.
 * Single-process server; an in-memory map is intentional for this sprint.
 * Entries are validated against their own expiry and pruned opportunistically.
 */
const challengeStore = new Map<string, { pubkey: string; expiresAtMs: number }>();

function pruneExpiredChallenges(now = Date.now()): void {
  for (const [message, entry] of challengeStore) {
    if (entry.expiresAtMs <= now) {
      challengeStore.delete(message);
    }
  }
}

/** Validate a Stellar account public key (G...). */
export function isValidPubkey(pubkey: unknown): pubkey is string {
  return typeof pubkey === 'string' && StrKey.isValidEd25519PublicKey(pubkey);
}

/** SEP-53 message hash: sha256(prefix || message). */
function sep53Hash(message: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(SEP53_PREFIX, 'utf8'), Buffer.from(message, 'utf8')]))
    .digest();
}

/**
 * Build the canonical SIWE-style message for a pubkey + nonce. Deterministic so
 * the server never has to trust the client's `message`: on verify we re-derive
 * the expected message from the stored challenge and compare.
 */
function buildMessage(params: {
  pubkey: string;
  nonce: string;
  domain: string;
  statement: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  const { pubkey, nonce, domain, statement, issuedAt, expiresAt } = params;
  return [
    `${domain} wants you to sign in with your Stellar account:`,
    pubkey,
    '',
    statement,
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join('\n');
}

/**
 * Create and store a challenge for the given pubkey.
 * @throws Error('INVALID_PUBKEY') if pubkey is not a valid G-address.
 */
export function createChallenge(pubkey: string): AuthChallenge {
  if (!isValidPubkey(pubkey)) {
    throw new Error('INVALID_PUBKEY');
  }

  pruneExpiredChallenges();

  const now = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const domain = config.authDomain;
  const statement = 'Sign in to manage your Xyra agent wallet.';
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CHALLENGE_TTL_MS).toISOString();

  const message = buildMessage({ pubkey, nonce, domain, statement, issuedAt, expiresAt });

  challengeStore.set(message, { pubkey, expiresAtMs: now + CHALLENGE_TTL_MS });

  return { nonce, domain, statement, issuedAt, expiresAt, message };
}

/**
 * Verify a signed challenge and, on success, issue a JWT.
 * @throws Error with a stable code: INVALID_PUBKEY | UNKNOWN_CHALLENGE |
 *   CHALLENGE_EXPIRED | PUBKEY_MISMATCH | BAD_SIGNATURE | INVALID_SIGNATURE_ENCODING
 */
export function verifyAndIssue(params: {
  pubkey: string;
  signature: string;
  message: string;
}): AuthTokenResult {
  const { pubkey, signature, message } = params;

  if (!isValidPubkey(pubkey)) {
    throw new Error('INVALID_PUBKEY');
  }

  const entry = challengeStore.get(message);
  if (!entry) {
    throw new Error('UNKNOWN_CHALLENGE');
  }

  // Single-use: consume the challenge regardless of outcome below.
  challengeStore.delete(message);

  if (entry.expiresAtMs <= Date.now()) {
    throw new Error('CHALLENGE_EXPIRED');
  }
  if (entry.pubkey !== pubkey) {
    throw new Error('PUBKEY_MISMATCH');
  }

  let signatureBuf: Buffer;
  try {
    signatureBuf = Buffer.from(signature, 'base64');
  } catch {
    throw new Error('INVALID_SIGNATURE_ENCODING');
  }
  if (signatureBuf.length === 0) {
    throw new Error('INVALID_SIGNATURE_ENCODING');
  }

  const digest = sep53Hash(message);
  const ok = Keypair.fromPublicKey(pubkey).verify(digest, signatureBuf);
  if (!ok) {
    throw new Error('BAD_SIGNATURE');
  }

  const token = jwt.sign({ sub: pubkey }, config.jwtSigningSecret, {
    algorithm: 'HS256',
    expiresIn: JWT_TTL_SECONDS,
  });
  const expiresAt = new Date(Date.now() + JWT_TTL_SECONDS * 1000).toISOString();

  return { token, expiresAt };
}

/**
 * Verify a bearer JWT and extract claims.
 * @throws Error('INVALID_TOKEN') on any verification failure (expired, bad sig, malformed).
 */
export function verifyToken(token: string): AuthClaims {
  try {
    const decoded = jwt.verify(token, config.jwtSigningSecret, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    const sub = decoded.sub;
    if (typeof sub !== 'string' || !isValidPubkey(sub)) {
      throw new Error('INVALID_TOKEN');
    }
    return { pubkey: sub };
  } catch {
    throw new Error('INVALID_TOKEN');
  }
}

/** Test/maintenance helper: clear all stored challenges. */
export function _clearChallenges(): void {
  challengeStore.clear();
}
