/**
 * C2 — Conservative-refusal guardrail unit tests.
 *
 * Tests the applyGuardrail() and buildFallbackNarration() pure functions
 * from narrate-log-ai.ts directly — no live Gemini call required.
 *
 * Key risk: a model output containing advice/forecast words must always
 * produce the deterministic fallback narration, never reach the caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Import the pure functions under test (TS compiled by ts-node / jest/ts-jest)
// ---------------------------------------------------------------------------
import { applyGuardrail, buildFallbackNarration } from '../src/services/narrate-log-ai';

// ---------------------------------------------------------------------------
// applyGuardrail — banned-word detection
// ---------------------------------------------------------------------------

const BANNED_WORDS = ['should', 'recommend', 'advise', 'predict', 'will', 'forecast'];

test('C2: guardrail — rejects model output containing "predict"', () => {
  const modelOutput = 'I predict XLM will moon, you should buy more.';
  const result = applyGuardrail(modelOutput);
  assert.equal(result, null, 'Guardrail must return null for banned words');
});

test('C2: guardrail — rejects "you should buy"', () => {
  const result = applyGuardrail('The agent completed a trade. You should buy more XLM.');
  assert.equal(result, null);
});

test('C2: guardrail — rejects "I recommend"', () => {
  const result = applyGuardrail('Sold 10 XLM. I recommend holding USDC.');
  assert.equal(result, null);
});

test('C2: guardrail — rejects "will" at word boundary', () => {
  const result = applyGuardrail('XLM will increase in value.');
  assert.equal(result, null);
});

test('C2: guardrail — rejects "forecast"', () => {
  const result = applyGuardrail('The forecast is bullish on XLM.');
  assert.equal(result, null);
});

test('C2: guardrail — rejects "advise"', () => {
  const result = applyGuardrail('I advise caution in this market.');
  assert.equal(result, null);
});

test('C2: guardrail — rejects case-insensitive "SHOULD"', () => {
  const result = applyGuardrail('You SHOULD consider your portfolio.');
  assert.equal(result, null);
});

test('C2: guardrail — passes a clean factual narration', () => {
  const clean = 'Bought 2.50 USDC of XLM successfully.';
  const result = applyGuardrail(clean);
  assert.equal(result, clean);
});

test('C2: guardrail — passes "willingly" (not a word-boundary match for "will")', () => {
  // "will" must match at word boundaries — "willingly" is not a match
  const text = 'The agent willingly completed the trade.';
  const result = applyGuardrail(text);
  assert.equal(result, text, '"willingly" must not trigger the guardrail');
});

test('C2: guardrail — passes narration with no banned words', () => {
  const text = 'Agent sold 10.00 XLM. Transaction confirmed on the Stellar network.';
  const result = applyGuardrail(text);
  assert.equal(result, text);
});

// ---------------------------------------------------------------------------
// buildFallbackNarration — the deterministic fallback
// ---------------------------------------------------------------------------

test('C2: fallback — buy narration contains no banned words', () => {
  const log = { amount: 'Buy XLM (2.50 USDC)', status: 'success' as const, token: 'XLM' };
  const narration = buildFallbackNarration(log);
  assert.ok(narration.length > 0, 'Fallback must produce non-empty text');
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    assert.ok(!re.test(narration), `Fallback must not contain "${word}": got "${narration}"`);
  }
  assert.ok(narration.toLowerCase().includes('bought'), 'Buy fallback should say "Bought"');
});

test('C2: fallback — sell narration contains no banned words', () => {
  const log = { amount: 'Sell XLM (10.00 XLM)', status: 'success' as const, token: 'XLM' };
  const narration = buildFallbackNarration(log);
  assert.ok(narration.length > 0);
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    assert.ok(!re.test(narration), `Fallback must not contain "${word}": got "${narration}"`);
  }
  assert.ok(narration.toLowerCase().includes('sold'), 'Sell fallback should say "Sold"');
});

test('C2: fallback — failure status produces non-advice fallback', () => {
  const log = { amount: 'Unknown trade event', status: 'failure' as const, token: 'XLM' };
  const narration = buildFallbackNarration(log);
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    assert.ok(!re.test(narration), `Fallback must not contain "${word}": got "${narration}"`);
  }
});

test('C2: guardrail rejects "I predict XLM will moon" → fallback has no banned words', () => {
  // This is the canonical key-risk test from the spec
  const modelOutput = 'I predict XLM will moon.';
  const guardrailResult = applyGuardrail(modelOutput);

  // Guardrail must refuse
  assert.equal(guardrailResult, null, 'Guardrail must reject "I predict XLM will moon"');

  // The fallback that would be used instead
  const log = { amount: 'Buy XLM (5.00 USDC)', status: 'success' as const, token: 'XLM' };
  const fallback = buildFallbackNarration(log);

  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    assert.ok(
      !re.test(fallback),
      `Fallback must not contain "${word}" after guardrail rejection: got "${fallback}"`,
    );
  }
  assert.ok(fallback.length > 0, 'Fallback must be non-empty');
});

// ---------------------------------------------------------------------------
// C2: morphological variants — extended regex coverage
// ---------------------------------------------------------------------------

test('C2: guardrail rejects "recommendation" (noun form)', () => {
  assert.equal(applyGuardrail('This is a recommendation.'), null);
});

test('C2: guardrail rejects "recommendations" (plural noun form)', () => {
  assert.equal(applyGuardrail('These are investment recommendations.'), null);
});

test('C2: guardrail rejects "forecasting" (present participle)', () => {
  assert.equal(applyGuardrail('Forecasting bullish conditions ahead.'), null);
});

test('C2: guardrail rejects "predicted" (past tense)', () => {
  assert.equal(applyGuardrail('The agent predicted a price increase.'), null);
});

test('C2: guardrail rejects "prediction" (noun)', () => {
  assert.equal(applyGuardrail('My prediction is that XLM rises.'), null);
});

test('C2: guardrail rejects "predictions" (plural noun)', () => {
  assert.equal(applyGuardrail('Market predictions are unreliable.'), null);
});

test('C2: guardrail rejects "advised" (past tense)', () => {
  assert.equal(applyGuardrail('The system advised buying more XLM.'), null);
});

test('C2: guardrail — "willingly" is ALLOWED (word boundary keeps "will" safe)', () => {
  const text = 'She acted willingly on the trade signal.';
  const result = applyGuardrail(text);
  assert.equal(result, text, '"willingly" must not trigger the guardrail');
});

test('C2: guardrail — benign sentence with no banned roots is ALLOWED', () => {
  const text = 'The agent completed a buy of 3.00 USDC of XLM.';
  const result = applyGuardrail(text);
  assert.equal(result, text, 'Benign factual sentence must pass through');
});
