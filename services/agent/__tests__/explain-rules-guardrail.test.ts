/**
 * C3 — explain-rules guardrail + fallback unit tests.
 *
 * Tests applyGuardrail() reuse and buildFallbackExplanation() from
 * explain-rules-ai.ts. No live Gemini call required.
 *
 * Key risk: model output containing banned advice/forecast words must
 * produce the deterministic rule-based fallback with no banned words.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyGuardrail } from '../src/services/narrate-log-ai';
import { buildFallbackExplanation, type AgentRuleFields } from '../src/services/explain-rules-ai';

const BANNED_WORDS = ['should', 'recommend', 'advise', 'predict', 'will', 'forecast'];

const sampleRules: AgentRuleFields = {
  buyBelowUsd: 0.1,
  sellAboveUsd: 0.5,
  tier1Max: 5,
  tier2Max: 50,
  dailyBudget: 20,
};

// ---------------------------------------------------------------------------
// C3: guardrail applied to rule explanation output
// ---------------------------------------------------------------------------

test('C3: guardrail rejects model output with "will" in rule explanation context', () => {
  const modelOutput = 'This agent will buy XLM when the price drops below $0.10.';
  const result = applyGuardrail(modelOutput);
  assert.equal(result, null, 'Guardrail must return null when "will" is present');
});

test('C3: guardrail rejects model output with "recommend" in rule explanation', () => {
  const modelOutput = 'We recommend setting tier1Max higher for better results.';
  const result = applyGuardrail(modelOutput);
  assert.equal(result, null);
});

test('C3: guardrail rejects model output with "forecast" in rule explanation', () => {
  const modelOutput = 'Based on the forecast, XLM looks bullish at these thresholds.';
  const result = applyGuardrail(modelOutput);
  assert.equal(result, null);
});

test('C3: guardrail passes a factual rule explanation with no banned words', () => {
  const clean =
    'The agent buys XLM automatically when the price is at or below $0.10 (up to $5 per trade). ' +
    'Trades above $5 up to $50 require confirmation. It sells when the price reaches $0.50 or higher. ' +
    'Total daily spending is capped at $20.';
  const result = applyGuardrail(clean);
  assert.equal(result, clean, 'Clean factual explanation must pass the guardrail');
});

// ---------------------------------------------------------------------------
// C3: buildFallbackExplanation — deterministic fallback from rule fields
// ---------------------------------------------------------------------------

test('C3: fallback explanation contains no banned words', () => {
  const explanation = buildFallbackExplanation(sampleRules);
  assert.ok(explanation.length > 0, 'Fallback must produce non-empty text');
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    assert.ok(
      !re.test(explanation),
      `Fallback must not contain "${word}": got "${explanation}"`,
    );
  }
});

test('C3: fallback explanation mentions buy condition', () => {
  const explanation = buildFallbackExplanation(sampleRules);
  assert.ok(
    explanation.includes('0.1') || explanation.toLowerCase().includes('buy'),
    `Fallback must mention buy condition: got "${explanation}"`,
  );
});

test('C3: fallback explanation mentions sell condition', () => {
  const explanation = buildFallbackExplanation(sampleRules);
  assert.ok(
    explanation.includes('0.5') || explanation.toLowerCase().includes('sell'),
    `Fallback must mention sell condition: got "${explanation}"`,
  );
});

test('C3: fallback explanation mentions daily cap', () => {
  const explanation = buildFallbackExplanation(sampleRules);
  assert.ok(
    explanation.includes('20') || explanation.toLowerCase().includes('daily'),
    `Fallback must mention daily cap: got "${explanation}"`,
  );
});

// ---------------------------------------------------------------------------
// C3: full guardrail-rejection → fallback path (the key risk test)
// ---------------------------------------------------------------------------

test('C3: guardrail rejects banned model output → fallback has no banned words', () => {
  const bannedModelOutput =
    'I predict this agent will forecast profits. You should recommend setting buyBelowUsd lower.';

  const guardrailResult = applyGuardrail(bannedModelOutput);
  assert.equal(guardrailResult, null, 'Guardrail must reject output with multiple banned words');

  // Simulate what the endpoint does: fall back to deterministic explanation
  const fallback = buildFallbackExplanation(sampleRules);

  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    assert.ok(
      !re.test(fallback),
      `Fallback must not contain "${word}" after guardrail rejection: got "${fallback}"`,
    );
  }
  assert.ok(fallback.length > 0, 'Fallback must be non-empty');
});
