import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentMetricsBody } from '../src/services/agent-metrics';

const baseAgent = {
  agentAddress: 'GAGENT', targetWallet: 'GTARGET',
  spentToday: 0, dailyBudget: 5, totalSuccessfulTrades: 2, active: true,
};
const bal = (native: string, usdc = '0') => ({ native, usdc, assets: {} });

test('funded is false when native balance < 1 XLM (account not created)', () => {
  const body = buildAgentMetricsBody({ ...baseAgent, usdcTrustlineReady: false } as any, bal('0'), 0);
  assert.equal(body.funded, false);
  assert.equal(body.usdcTrustlineReady, false);
});

test('funded is true when native balance >= 1 XLM', () => {
  const body = buildAgentMetricsBody({ ...baseAgent, usdcTrustlineReady: true } as any, bal('3.0000000'), 0);
  assert.equal(body.funded, true);
  assert.equal(body.usdcTrustlineReady, true);
});

test('legacy agents (usdcTrustlineReady undefined) are treated as ready', () => {
  const body = buildAgentMetricsBody({ ...baseAgent } as any, bal('10'), 1);
  assert.equal(body.usdcTrustlineReady, true);
  assert.equal(body.pendingTier2Count, 1);
  assert.equal(body.agentAddress, 'GAGENT');
});
