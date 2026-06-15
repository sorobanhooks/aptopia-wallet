import { Agent, IAgent } from './db';
import { ChainFactory } from './chains/chain-factory';
import { WorkerManager } from './worker-manager';
import { clearPendingTier2Trade } from './pending-tier2';
import { decryptAgentSecret } from './agent-secret-crypto';
import { isAccountNotFound } from './account-errors';

export type RevokeAgentResult = {
  transfers: { token: string; amount: string; txHash: string }[];
  /** Assets that couldn't be returned (e.g. destination has no trustline). */
  skipped: { token: string; amount: string; reason: string }[];
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
    const { transfers, skipped } = await chain.transferAllAssets(
      decryptAgentSecret(agent),
      agent.targetWallet
    );

    await Agent.findByIdAndUpdate(agent._id, { $set: { active: false } });

    return { transfers, skipped };
  } catch (err) {
    // Agent account was never created on-chain (unfunded) — there is nothing to
    // drain. Disable the agent and report no transfers instead of failing the
    // revoke (otherwise the user is stuck: can't revoke, can't create a new one).
    if (isAccountNotFound(err)) {
      await Agent.findByIdAndUpdate(agent._id, { $set: { active: false } });
      return { transfers: [], skipped: [] };
    }
    const fresh = await Agent.findById(agent._id);
    if (fresh?.active) {
      WorkerManager.startAgentWorker(fresh);
    }
    throw err;
  }
}
