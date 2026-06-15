import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_PRIORITY,
  STRATEGY_DEFAULTS,
  DCA_INTERVAL_PRESETS_MIN,
} from '../src/services/strategy-types';
import {
  isDcaDue,
  evaluateStrategies,
  selectAction,
} from '../src/services/strategy-engine';
import type { StrategyConfig } from '../src/services/strategy-types';

test('ROLE_PRIORITY orders protect > sell > accumulate', () => {
  assert.ok(ROLE_PRIORITY.protect > ROLE_PRIORITY.sell);
  assert.ok(ROLE_PRIORITY.sell > ROLE_PRIORITY.accumulate);
});

test('STRATEGY_DEFAULTS has an entry for every strategy type', () => {
  assert.ok(STRATEGY_DEFAULTS.dca);
  assert.ok(STRATEGY_DEFAULTS.dip_buy);
  assert.ok(STRATEGY_DEFAULTS.take_profit);
  assert.ok(STRATEGY_DEFAULTS.stop_loss);
  assert.equal(STRATEGY_DEFAULTS.dca.role, 'accumulate');
  assert.equal(STRATEGY_DEFAULTS.take_profit.role, 'sell');
  assert.equal(STRATEGY_DEFAULTS.stop_loss.role, 'protect');
});

test('DCA_INTERVAL_PRESETS_MIN includes a 2-minute demo and a daily option', () => {
  const minutes = DCA_INTERVAL_PRESETS_MIN.map((p) => p.minutes);
  assert.ok(minutes.includes(2));
  assert.ok(minutes.includes(1440));
});

const mk = (over: Partial<StrategyConfig>): StrategyConfig => ({
  id: 'id1', type: 'dca', role: 'accumulate', enabled: true,
  params: { intervalMin: 60, amountUsdc: 5 }, lastRunAt: null, ...over,
});

const HOUR = 60 * 60 * 1000;

test('isDcaDue: first run (lastRunAt null) is due', () => {
  assert.equal(isDcaDue(mk({}), 1_000_000), true);
});

test('isDcaDue: not due before the interval elapses', () => {
  const last = new Date(1_000_000);
  assert.equal(isDcaDue(mk({ lastRunAt: last }), 1_000_000 + 30 * 60 * 1000), false);
});

test('isDcaDue: due once the interval has elapsed', () => {
  const last = new Date(1_000_000);
  assert.equal(isDcaDue(mk({ lastRunAt: last }), 1_000_000 + HOUR), true);
});

test('isDcaDue: non-dca strategy is never "due"', () => {
  assert.equal(isDcaDue(mk({ type: 'take_profit', role: 'sell' }), 9_999_999), false);
});

test('evaluateStrategies: disabled strategies never act', () => {
  const s = mk({ enabled: false });
  assert.deepEqual(evaluateStrategies([s], { priceUsd: 0.2, now: HOUR }), []);
});

test('evaluateStrategies: dip_buy fires at/below threshold; take_profit at/above', () => {
  const dip = mk({ id: 'dip', type: 'dip_buy', role: 'accumulate', params: { buyBelowUsd: 0.1, amountUsdc: 3 } });
  const tp = mk({ id: 'tp', type: 'take_profit', role: 'sell', params: { sellAboveUsd: 0.5, sellAmountXlm: 7 } });
  const low = evaluateStrategies([dip, tp], { priceUsd: 0.09, now: 0 });
  assert.equal(low.length, 1);
  assert.equal(low[0].strategyId, 'dip');
  assert.equal(low[0].direction, 'buy_xlm');
  const high = evaluateStrategies([dip, tp], { priceUsd: 0.6, now: 0 });
  assert.equal(high.length, 1);
  assert.equal(high[0].strategyId, 'tp');
  assert.equal(high[0].direction, 'sell_xlm');
});

test('selectAction: protect beats sell beats accumulate', () => {
  const dca = mk({ id: 'dca', type: 'dca', role: 'accumulate', lastRunAt: null });
  const tp = mk({ id: 'tp', type: 'take_profit', role: 'sell', params: { sellAboveUsd: 0.5, sellAmountXlm: 1 } });
  const sl = mk({ id: 'sl', type: 'stop_loss', role: 'protect', params: { sellBelowUsd: 0.08, sellAmountXlm: 1 } });
  const actions = evaluateStrategies([dca, tp, sl], { priceUsd: 0.6, now: HOUR });
  const chosen = selectAction(actions);
  assert.equal(chosen?.strategyId, 'tp', 'sell beats accumulate');
  const tp2 = mk({ id: 'tp2', type: 'take_profit', role: 'sell', params: { sellAboveUsd: 0.05, sellAmountXlm: 1 } });
  const both = evaluateStrategies([tp2, sl], { priceUsd: 0.05, now: 0 });
  assert.equal(selectAction(both)?.strategyId, 'sl', 'protect beats sell');
});

test('selectAction: returns null when nothing fires', () => {
  assert.equal(selectAction([]), null);
});
