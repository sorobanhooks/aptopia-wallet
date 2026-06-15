import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNewStrategy, validateParamPatch } from '../src/routes/strategy-validation';
import type { StrategyConfig } from '../src/services/strategy-types';

const existing: StrategyConfig[] = [
  { id: 'dca1', type: 'dca', role: 'accumulate', enabled: true, params: { intervalMin: 60, amountUsdc: 1 }, lastRunAt: null },
];

test('rejects unknown type', () => {
  const r = validateNewStrategy({ type: 'martingale', params: {} } as any, []);
  assert.equal(r.ok, false);
  assert.match(r.error!, /type/);
});

test('fills role from type and accepts a valid take_profit', () => {
  const r = validateNewStrategy({ type: 'take_profit', enabled: true, params: { sellAboveUsd: 0.5, sellAmountXlm: 1 } }, []);
  assert.equal(r.ok, true);
  assert.equal(r.value!.role, 'sell');
});

test('rejects a 2nd enabled accumulate (single-accumulate invariant)', () => {
  const r = validateNewStrategy({ type: 'dip_buy', enabled: true, params: { buyBelowUsd: 0.1, amountUsdc: 1 } }, existing);
  assert.equal(r.ok, false);
  assert.match(r.error!, /accumulate/);
});

test('allows a disabled accumulate even when one is already enabled', () => {
  const r = validateNewStrategy({ type: 'dip_buy', enabled: false, params: { buyBelowUsd: 0.1, amountUsdc: 1 } }, existing);
  assert.equal(r.ok, true);
});

test('rejects non-finite params', () => {
  const r = validateNewStrategy({ type: 'dca', enabled: true, params: { intervalMin: NaN, amountUsdc: 1 } }, []);
  assert.equal(r.ok, false);
});

test('validateParamPatch: accepts known positive params', () => {
  const r = validateParamPatch('dca', { intervalMin: 120, amountUsdc: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { intervalMin: 120, amountUsdc: 2 });
});

test('validateParamPatch: rejects an unknown key', () => {
  const r = validateParamPatch('dca', { intervalMin: 60, bogus: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /Unknown param/);
});

test('validateParamPatch: rejects zero / negative / NaN', () => {
  assert.equal(validateParamPatch('dca', { intervalMin: 0 }).ok, false);
  assert.equal(validateParamPatch('take_profit', { sellAboveUsd: -1 }).ok, false);
  assert.equal(validateParamPatch('dca', { amountUsdc: NaN }).ok, false);
});
