import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCallback,
  mainMenuKeyboard,
  addTypeKeyboard,
  dcaIntervalKeyboard,
  dcaAmountKeyboard,
  startAddSession,
  applyDcaInterval,
  applyDcaAmount,
  applyTypedPrice,
  sessionToNewStrategy,
  reviewText,
  strategyListText,
  strategyListKeyboard,
  presetAccumulatorInputs,
} from '../src/services/telegram-menu';
import type { StrategyConfig } from '../src/services/strategy-types';

test('parseCallback splits action and arg on the first colon', () => {
  assert.deepEqual(parseCallback('menu:strategies'), { action: 'menu', arg: 'strategies' });
  assert.deepEqual(parseCallback('dca_amt:0.5'), { action: 'dca_amt', arg: '0.5' });
  assert.deepEqual(parseCallback('menu'), { action: 'menu', arg: undefined });
});

test('mainMenuKeyboard exposes the core actions', () => {
  const flat = mainMenuKeyboard().flat().map((b) => b.callback_data);
  assert.ok(flat.includes('menu:strategies'));
  assert.ok(flat.includes('menu:add'));
  assert.ok(flat.includes('preset:accumulator'));
});

test('addTypeKeyboard offers all four strategy types', () => {
  const flat = addTypeKeyboard().flat().map((b) => b.callback_data);
  assert.ok(flat.includes('add:dca'));
  assert.ok(flat.includes('add:dip_buy'));
  assert.ok(flat.includes('add:take_profit'));
  assert.ok(flat.includes('add:stop_loss'));
});

test('dca keyboards carry preset values', () => {
  assert.ok(dcaIntervalKeyboard().flat().some((b) => b.callback_data === 'dca_int:2'));
  assert.ok(dcaAmountKeyboard().flat().some((b) => b.callback_data.startsWith('dca_amt:')));
});

test('DCA wizard: type → interval → amount → review builds a valid strategy', () => {
  let s = startAddSession('dca');
  assert.equal(s.type, 'dca');
  assert.equal(s.step, 'interval');
  s = applyDcaInterval(s, 60);
  assert.equal(s.params.intervalMin, 60);
  assert.equal(s.step, 'amount');
  s = applyDcaAmount(s, 5);
  assert.equal(s.params.amountUsdc, 5);
  assert.equal(s.step, 'review');
  const input = sessionToNewStrategy(s);
  assert.equal(input.type, 'dca');
  assert.equal(input.role, 'accumulate');
  assert.equal(input.enabled, true);
  assert.equal(input.params.intervalMin, 60);
  assert.equal(input.params.amountUsdc, 5);
  assert.match(reviewText(s), /hourly|60/i);
});

test('Sell wizard: take_profit collects one typed price then defaults the amount', () => {
  let s = startAddSession('take_profit');
  assert.equal(s.step, 'price');
  s = applyTypedPrice(s, 0.55);
  assert.equal(s.params.sellAboveUsd, 0.55);
  assert.ok(s.params.sellAmountXlm > 0, 'sell amount defaulted');
  assert.equal(s.step, 'review');
  assert.equal(sessionToNewStrategy(s).role, 'sell');
});

test('strategy list renders a line + toggle/remove buttons per strategy', () => {
  const strategies: StrategyConfig[] = [
    { id: 'a', type: 'dca', role: 'accumulate', enabled: true, params: { intervalMin: 60, amountUsdc: 5 }, lastRunAt: null },
    { id: 'b', type: 'stop_loss', role: 'protect', enabled: false, params: { sellBelowUsd: 0.08, sellAmountXlm: 1 }, lastRunAt: null },
  ];
  const text = strategyListText(strategies);
  assert.match(text, /dca/i);
  const cbs = strategyListKeyboard(strategies).flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('strat_toggle:a'));
  assert.ok(cbs.includes('strat_remove:a'));
  assert.ok(cbs.includes('strat_toggle:b'));
});

test('strategy list handles the empty case', () => {
  assert.match(strategyListText([]), /no strategies/i);
});

test('presetAccumulatorInputs returns DCA + take_profit + stop_loss with exactly one enabled accumulate', () => {
  const inputs = presetAccumulatorInputs();
  assert.equal(inputs.length, 3);
  assert.equal(inputs.filter((i) => i.role === 'accumulate' && i.enabled).length, 1);
  assert.ok(inputs.some((i) => i.type === 'take_profit'));
  assert.ok(inputs.some((i) => i.type === 'stop_loss'));
});
