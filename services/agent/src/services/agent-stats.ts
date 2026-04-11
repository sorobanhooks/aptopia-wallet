import { Agent } from './db';

export async function recordSuccessfulBuy(
  agentId: string,
  usdcSpent: number
): Promise<void> {
  if (!Number.isFinite(usdcSpent) || usdcSpent <= 0) {
    await Agent.findByIdAndUpdate(agentId, {
      $inc: { totalSuccessfulTrades: 1 },
    });
    return;
  }
  await Agent.findByIdAndUpdate(agentId, {
    $inc: { spentToday: usdcSpent, totalSuccessfulTrades: 1 },
  });
}

export async function recordSuccessfulSell(agentId: string): Promise<void> {
  await Agent.findByIdAndUpdate(agentId, {
    $inc: { totalSuccessfulTrades: 1 },
  });
}
