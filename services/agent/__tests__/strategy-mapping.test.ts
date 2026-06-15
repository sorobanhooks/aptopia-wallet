import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flatRulesToStrategies,
  strategiesToFlatRules,
  applyFlatRulesToStrategies,
} from '../src/services/strategy-mapping';
import type { StrategyConfig } from '../src/services/strategy-types';

const MAX = Number.MAX_SAFE_INTEGER;

test('flatRulesToStrategies: maps buy-below → dip_buy and sell-above → take_profit', () => {
  const out = flatRulesToStrategies({ buyBelowUsd: 0.1, sellAboveUsd: 0.5, buyAmountUsdc: 2, sellAmountXlm: 3 });
  assert.equal(out.length, 2);
  const dip = out.find((s) => s.type === 'dip_buy')!;
  const tp = out.find((s) => s.type === 'take_profit')!;
  assert.equal(dip.role, 'accumulate');
  assert.equal(dip.params.buyBelowUsd, 0.1);
  assert.equal(dip.params.amountUsdc, 2);
  assert.equal(tp.role, 'sell');
  assert.equal(tp.params.sellAboveUsd, 0.5);
  assert.equal(tp.params.sellAmountXlm, 3);
  assert.equal(dip.lastRunAt, null);
});

test('flatRulesToStrategies: skips unset buy (0) and sentinel sell (MAX)', () => {
  const out = flatRulesToStrategies({ buyBelowUsd: 0, sellAboveUsd: MAX, buyAmountUsdc: 1, sellAmountXlm: 1 });
  assert.equal(out.length, 0);
});

test('strategiesToFlatRules: reflects enabled dip_buy + take_profit, defaults otherwise', () => {
  const strategies: StrategyConfig[] = [
    { id: 'a', type: 'dip_buy', role: 'accumulate', enabled: true, params: { buyBelowUsd: 0.2, amountUsdc: 4 }, lastRunAt: null },
    { id: 'b', type: 'take_profit', role: 'sell', enabled: true, params: { sellAboveUsd: 0.7, sellAmountXlm: 9 }, lastRunAt: null },
    { id: 'c', type: 'dca', role: 'accumulate', enabled: true, params: { intervalMin: 60, amountUsdc: 1 }, lastRunAt: null },
  ];
  const flat = strategiesToFlatRules(strategies);
  assert.equal(flat.buyBelowUsd, 0.2);
  assert.equal(flat.buyAmountUsdc, 4);
  assert.equal(flat.sellAboveUsd, 0.7);
  assert.equal(flat.sellAmountXlm, 9);
});

test('strategiesToFlatRules: uses sentinels when no dip_buy/take_profit present', () => {
  const flat = strategiesToFlatRules([]);
  assert.equal(flat.buyBelowUsd, 0);
  assert.equal(flat.sellAboveUsd, MAX);
});

test('applyFlatRulesToStrategies: updates existing take_profit, leaves dca untouched', () => {
  const existing: StrategyConfig[] = [
    { id: 'tp', type: 'take_profit', role: 'sell', enabled: true, params: { sellAboveUsd: 0.5, sellAmountXlm: 1 }, lastRunAt: null },
    { id: 'dca', type: 'dca', role: 'accumulate', enabled: true, params: { intervalMin: 60, amountUsdc: 1 }, lastRunAt: null },
  ];
  const next = applyFlatRulesToStrategies(existing, { sellAboveUsd: 0.9 });
  const tp = next.find((s) => s.type === 'take_profit')!;
  assert.equal(tp.params.sellAboveUsd, 0.9);
  assert.ok(next.some((s) => s.type === 'dca'), 'dca preserved');
});

test('applyFlatRulesToStrategies: creates a dip_buy when buyBelowUsd is sent and none exists', () => {
  const next = applyFlatRulesToStrategies([], { buyBelowUsd: 0.15, buyAmountUsdc: 2 });
  const dip = next.find((s) => s.type === 'dip_buy')!;
  assert.equal(dip.params.buyBelowUsd, 0.15);
  assert.equal(dip.params.amountUsdc, 2);
});
