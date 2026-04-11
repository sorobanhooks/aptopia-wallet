import { Agent, IAgent } from './db';
import { ChainFactory } from './chains/chain-factory';
import { WorkerManager } from './worker-manager';
import { clearPendingTier2Trade } from './pending-tier2';

export type RevokeAgentResult = {
  transfers: { token: string; amount: string; txHash: string }[];
};

/**
 * Stops the worker, drains transferable assets to the agent's main wallet, sets `active: false`.
 * On transfer failure, restarts the worker if the agent is still active.
 */
export async function revokeAgentWallet(agent: IAgent): Promise<RevokeAgentResult> {
  const agentId = String(agent._id);
  WorkerManager.stopAgentWorker(agentId);
  clearPendingTier2Trade(agentId);

  const chain = ChainFactory.getService(agent.chain || 'stellar');

  try {
    const { transfers } = await chain.transferAllAssets(
      agent.agentSecret,
      agent.targetWallet
    );

    await Agent.findByIdAndUpdate(agent._id, { $set: { active: false } });

    return { transfers };
  } catch (err) {
    const fresh = await Agent.findById(agent._id);
    if (fresh?.active) {
      WorkerManager.startAgentWorker(fresh);
    }
    throw err;
  }
}
