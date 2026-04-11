import { TradeDirection } from './chains/types';

export type PendingTier2Payload = {
  direction: TradeDirection;
  buyUsdc?: string;
  sellXlm?: string;
};

const pendingTier2ByAgentId = new Map<string, PendingTier2Payload>();

export function setPendingTier2Trade(
  agentId: string,
  payload: PendingTier2Payload
): void {
  pendingTier2ByAgentId.set(agentId, payload);
}

export function getPendingTier2Trade(
  agentId: string
): PendingTier2Payload | undefined {
  return pendingTier2ByAgentId.get(agentId);
}

export function clearPendingTier2Trade(agentId: string): void {
  pendingTier2ByAgentId.delete(agentId);
}
