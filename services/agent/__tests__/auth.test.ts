import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Keypair } from 'stellar-sdk';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';

import {
  createChallenge,
  verifyAndIssue,
  verifyToken,
  isValidPubkey,
  _clearChallenges,
} from '../src/services/auth';
import { assertOwnsAgent, type AuthedRequest } from '../src/middleware/require-auth';
import { config } from '../src/config';

// Mirror the wallet's SEP-53 encoding so the test signs exactly what the
// server expects to verify.
const SEP53_PREFIX = 'Stellar Signed Message:\n';
function signSep53(kp: Keypair, message: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(SEP53_PREFIX, 'utf8'), Buffer.from(message, 'utf8')]))
    .digest();
  return kp.sign(digest).toString('base64');
}

test('createChallenge issues a nonce + canonical message for a valid pubkey', () => {
  _clearChallenges();
  const kp = Keypair.random();
  const ch = createChallenge(kp.publicKey());

  assert.ok(ch.nonce && ch.nonce.length >= 16, 'nonce present');
  assert.ok(ch.message.includes(kp.publicKey()), 'message embeds pubkey');
  assert.ok(ch.message.includes(ch.nonce), 'message embeds nonce');
  assert.ok(ch.domain && ch.statement, 'domain + statement present');
  assert.ok(new Date(ch.expiresAt).getTime() > new Date(ch.issuedAt).getTime(), 'expiry after issue');
});

test('createChallenge rejects an invalid pubkey', () => {
  _clearChallenges();
  assert.throws(() => createChallenge('not-a-valid-key'), /INVALID_PUBKEY/);
});

test('verifyAndIssue accepts a valid signature and issues a JWT', () => {
  _clearChallenges();
  const kp = Keypair.random();
  const ch = createChallenge(kp.publicKey());
  const signature = signSep53(kp, ch.message);

  const { token, expiresAt } = verifyAndIssue({
    pubkey: kp.publicKey(),
    signature,
    message: ch.message,
  });

  assert.ok(token && token.split('.').length === 3, 'JWT looks well-formed');
  assert.ok(new Date(expiresAt).getTime() > Date.now(), 'token not already expired');

  const claims = verifyToken(token);
  assert.equal(claims.pubkey, kp.publicKey(), 'sub matches signer pubkey');
});

test('verifyAndIssue rejects a bad signature (wrong signer)', () => {
  _clearChallenges();
  const kp = Keypair.random();
  const attacker = Keypair.random();
  const ch = createChallenge(kp.publicKey());
  // Attacker signs the message but claims to be kp.
  const badSig = signSep53(attacker, ch.message);

  assert.throws(
    () => verifyAndIssue({ pubkey: kp.publicKey(), signature: badSig, message: ch.message }),
    /BAD_SIGNATURE/,
  );
});

test('verifyAndIssue rejects a tampered message (unknown challenge)', () => {
  _clearChallenges();
  const kp = Keypair.random();
  const ch = createChallenge(kp.publicKey());
  const tampered = ch.message + 'x';
  const signature = signSep53(kp, tampered);

  assert.throws(
    () => verifyAndIssue({ pubkey: kp.publicKey(), signature, message: tampered }),
    /UNKNOWN_CHALLENGE/,
  );
});

test('verifyAndIssue rejects challenge reuse (single-use nonce)', () => {
  _clearChallenges();
  const kp = Keypair.random();
  const ch = createChallenge(kp.publicKey());
  const signature = signSep53(kp, ch.message);

  // First use succeeds.
  verifyAndIssue({ pubkey: kp.publicKey(), signature, message: ch.message });
  // Replay must fail — the challenge was consumed.
  assert.throws(
    () => verifyAndIssue({ pubkey: kp.publicKey(), signature, message: ch.message }),
    /UNKNOWN_CHALLENGE/,
  );
});

test('verifyAndIssue rejects an expired challenge', async () => {
  _clearChallenges();
  const kp = Keypair.random();
  const ch = createChallenge(kp.publicKey());
  const signature = signSep53(kp, ch.message);

  // Simulate expiry by issuing a JWT path only after forcing the stored
  // challenge to be in the past. We can't easily fast-forward the internal
  // clock, so we assert the documented behavior via a freshly-built expired
  // challenge: re-sign a challenge whose Expires At is already past is covered
  // by the UNKNOWN_CHALLENGE path; here we verify the time-window guard by
  // monkeypatching Date.now to jump beyond the 5-min TTL.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6 * 60 * 1000; // +6 min, past the 5-min TTL
    assert.throws(
      () => verifyAndIssue({ pubkey: kp.publicKey(), signature, message: ch.message }),
      /CHALLENGE_EXPIRED/,
    );
  } finally {
    Date.now = realNow;
  }
});

test('verifyToken rejects an expired JWT', () => {
  const kp = Keypair.random();
  // Forge a token that is already expired using the same dev secret the
  // server uses when JWT_SIGNING_SECRET is unset.
  const expired = jwt.sign(
    { sub: kp.publicKey(), exp: Math.floor(Date.now() / 1000) - 10 },
    config.jwtSigningSecret,
    { algorithm: 'HS256' },
  );
  assert.throws(() => verifyToken(expired), /INVALID_TOKEN/);
});

test('verifyToken rejects a bogus token', () => {
  assert.throws(() => verifyToken('not.a.jwt'), /INVALID_TOKEN/);
});

test('isValidPubkey guards malformed inputs', () => {
  assert.equal(isValidPubkey(Keypair.random().publicKey()), true);
  assert.equal(isValidPubkey('G_invalid'), false);
  assert.equal(isValidPubkey(123 as unknown), false);
  assert.equal(isValidPubkey(undefined), false);
});

// CF-2 regression: assertOwnsAgent must DENY (not skip) when agentTargetWallet
// is null, undefined, or empty string — previously these were fail-open.
test('CF-2 regression: assertOwnsAgent denies when agentTargetWallet is null', () => {
  const kp = Keypair.random();
  const req = { auth: { pubkey: kp.publicKey() } } as AuthedRequest;
  let statusCode = 0;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json() { return this; },
  } as unknown as Response;

  const result = assertOwnsAgent(req, res, null);
  assert.equal(result, false, 'must return false for null targetWallet');
  assert.equal(statusCode, 403, 'must respond 403 for null targetWallet');
});

test('CF-2 regression: assertOwnsAgent denies when agentTargetWallet is undefined', () => {
  const kp = Keypair.random();
  const req = { auth: { pubkey: kp.publicKey() } } as AuthedRequest;
  let statusCode = 0;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json() { return this; },
  } as unknown as Response;

  const result = assertOwnsAgent(req, res, undefined);
  assert.equal(result, false, 'must return false for undefined targetWallet');
  assert.equal(statusCode, 403, 'must respond 403 for undefined targetWallet');
});

test('CF-2 regression: assertOwnsAgent denies when agentTargetWallet is empty string', () => {
  const kp = Keypair.random();
  const req = { auth: { pubkey: kp.publicKey() } } as AuthedRequest;
  let statusCode = 0;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json() { return this; },
  } as unknown as Response;

  const result = assertOwnsAgent(req, res, '');
  assert.equal(result, false, 'must return false for empty targetWallet');
  assert.equal(statusCode, 403, 'must respond 403 for empty targetWallet');
});

test('CF-2 regression: assertOwnsAgent allows when agentTargetWallet matches authed pubkey', () => {
  const kp = Keypair.random();
  const pubkey = kp.publicKey();
  const req = { auth: { pubkey } } as AuthedRequest;
  const res = {
    status() { return this; },
    json() { return this; },
  } as unknown as Response;

  const result = assertOwnsAgent(req, res, pubkey);
  assert.equal(result, true, 'must return true when targetWallet matches authed pubkey');
});
