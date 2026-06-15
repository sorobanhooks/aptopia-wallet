import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePlannedBuyUsdcForAmount,
  routeBuy,
  routeSellForAmount,
} from '../src/services/trade-routing';

test('computePlannedBuyUsdcForAmount caps by tier2, daily-left, and spendable balance', () => {
  const agent = { tier1Max: 1, tier2Max: 10, dailyBudget: 6, spentToday: 2 };
  // requested 8, but dailyLeft=4, balance spendable ~ 100 → expect 4
  const planned = computePlannedBuyUsdcForAmount(agent, 100, 8);
  assert.equal(planned, 4);
});

test('routeBuy: <= tier1 is auto, <= tier2 is confirm, above is blocked', () => {
  const agent = { tier1Max: 5, tier2Max: 20 };
  assert.equal(routeBuy(agent, 3).kind, 'tier1_auto');
  assert.equal(routeBuy(agent, 12).kind, 'tier2_confirm');
  assert.equal(routeBuy(agent, 50).kind, 'blocked');
});

test('routeSellForAmount uses notional = xlm * price for tiering', () => {
  const agent = { tier1Max: 5, tier2Max: 20 };
  // 10 XLM * $0.2 = $2 notional → tier1 auto
  assert.equal(routeSellForAmount(agent, 10, 0.2).kind, 'tier1_auto');
  // 100 XLM * $0.2 = $20 → tier2 confirm (<= 20)
  assert.equal(routeSellForAmount(agent, 100, 0.2).kind, 'tier2_confirm');
  // 1000 XLM * $0.2 = $200 → blocked
  assert.equal(routeSellForAmount(agent, 1000, 0.2).kind, 'blocked');
});
