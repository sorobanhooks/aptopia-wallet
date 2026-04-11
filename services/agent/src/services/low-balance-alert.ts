import type { Types } from 'mongoose';
import { UsdcBalanceEvaluation } from './chains/usdc-balance-eval';
import { config } from '../config';
import { Agent } from './db';

export type AgentDoc = {
  _id: Types.ObjectId;
  id?: string;
  telegramId: string;
  agentAddress: string;
  lastLowBalanceAlertAt?: Date | null;
};

/**
 * Sends Telegram low-USDC alert if needed and respects cooldown.
 * Updates `lastLowBalanceAlertAt` in DB and mutates `agent.lastLowBalanceAlertAt` on success.
 */
export async function maybeSendLowBalanceAlert(
  agent: AgentDoc,
  evaluation: UsdcBalanceEvaluation
): Promise<void> {
  if (!evaluation.isLow) {
    return;
  }

  const last = agent.lastLowBalanceAlertAt;
  const now = Date.now();
  if (
    last &&
    now - new Date(last).getTime() < config.lowBalanceAlertCooldownMs
  ) {
    return;
  }

  const detailLines: string[] = [];
  if (evaluation.belowFloor) {
    detailLines.push(
      `• Below safe floor: need ≥ $${evaluation.floor.toFixed(2)} USDC`
    );
  }
  if (evaluation.cannotCoverNextPayment) {
    detailLines.push(
      `• Cannot cover next data fee: need ≥ $${evaluation.nextPayment.toFixed(
        4
      )} USDC per request`
    );
  }

  const addrShort = `${agent.agentAddress.slice(0, 6)}…${agent.agentAddress.slice(-4)}`;
  const message = [
    '⚠️ Low USDC on agent wallet',
    '',
    `Wallet: ${addrShort}`,
    `Balance: $${evaluation.usdc.toFixed(4)} USDC`,
    '',
    detailLines.join('\n'),
    '',
    'Top up this agent wallet with USDC (testnet) so price checks and trades keep working.',
  ].join('\n');

  try {
    const { bot } = require('./bot') as typeof import('./bot');
    await bot.telegram.sendMessage(agent.telegramId, message);
    const alertAt = new Date();
    await Agent.findByIdAndUpdate(agent._id, {
      lastLowBalanceAlertAt: alertAt,
    });
    agent.lastLowBalanceAlertAt = alertAt;
  } catch (err) {
    console.error('Low balance Telegram alert failed:', err);
  }
}
