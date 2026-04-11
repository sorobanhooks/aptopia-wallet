import { Agent, IAgent } from './db';

function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Returns true if `lastReset` is on an earlier UTC calendar day than now. */
export function needsDailyReset(lastReset: Date): boolean {
  return utcYmd(new Date(lastReset)) < utcYmd(new Date());
}

/**
 * If the agent is on a new UTC day, reset spentToday in the DB and on the in-memory document.
 */
export async function resetDailySpendIfNeeded(agent: IAgent): Promise<void> {
  if (!needsDailyReset(agent.lastReset)) {
    return;
  }
  const now = new Date();
  await Agent.findByIdAndUpdate(agent._id, {
    $set: { spentToday: 0, lastReset: now },
  });
  agent.spentToday = 0;
  agent.lastReset = now;
}

export function remainingDailyBudgetUsd(agent: {
  dailyBudget: number;
  spentToday: number;
}): number {
  return Math.max(0, agent.dailyBudget - agent.spentToday);
}
