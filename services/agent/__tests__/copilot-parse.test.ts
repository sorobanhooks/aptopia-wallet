// agent/__tests__/copilot-parse.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIntent, parseModelText } from '../src/services/copilot-parse-ai';

test('valid swap passes the guardrail', () => {
  const r = validateIntent({ type: 'swap', venue: 'soroswap', amountIn: '5', tokenIn: 'usdc', tokenOut: 'xlm' });
  assert.deepEqual(r, { type: 'swap', venue: 'soroswap', amountIn: '5', tokenIn: 'USDC', tokenOut: 'XLM' });
});

test('unknown token → unsupported', () => {
  const r = validateIntent({ type: 'swap', amountIn: '5', tokenIn: 'doge', tokenOut: 'xlm' });
  assert.equal(r.type, 'unsupported');
});

test('non-swap action (injection) → unsupported', () => {
  const r = validateIntent({ type: 'send', to: 'GABC', amountIn: '999', tokenIn: 'xlm' });
  assert.equal(r.type, 'unsupported');
});

test('same token in/out → clarification', () => {
  const r = validateIntent({ type: 'swap', amountIn: '5', tokenIn: 'xlm', tokenOut: 'xlm' });
  assert.equal(r.type, 'clarification');
});

test('missing amount → clarification', () => {
  const r = validateIntent({ type: 'swap', tokenIn: 'usdc', tokenOut: 'xlm' });
  assert.equal(r.type, 'clarification');
});

test('out-of-range slippage → clarification', () => {
  const r = validateIntent({ type: 'swap', amountIn: '5', tokenIn: 'usdc', tokenOut: 'xlm', slippageBps: 99999 });
  assert.equal(r.type, 'clarification');
});

test('passes through a model clarification', () => {
  const r = validateIntent({ type: 'clarification', message: 'Which token?' });
  assert.deepEqual(r, { type: 'clarification', message: 'Which token?' });
});

test('garbage / non-object → unsupported', () => {
  assert.equal(validateIntent(null).type, 'unsupported');
  assert.equal(validateIntent('hello').type, 'unsupported');
});

test('parseModelText strips ```json fences', () => {
  assert.deepEqual(parseModelText('```json\n{"type":"unsupported"}\n```'), { type: 'unsupported' });
});

test('parseModelText strips plain ``` fences (no json tag)', () => {
  assert.deepEqual(parseModelText('```\n{"type":"unsupported"}\n```'), { type: 'unsupported' });
});

test('parseModelText returns null on invalid JSON', () => {
  assert.equal(parseModelText('not json'), null);
});
