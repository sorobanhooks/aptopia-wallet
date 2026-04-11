import type { AlertPayload, EnrichedPayload } from "../types";

export async function enrichAlert(alert: AlertPayload): Promise<EnrichedPayload> {
  return {
    ...alert,
    context: {
      volume_24h: 142000000,
      volume_change_pct: 32.5,
      whale_txs_last_1h: 3,
      largest_tx_amount: 2400000,
      related_contracts: [
        {
          id: "soroswap_xlm_usdc",
          event: "large_swap",
          amount: 850000,
        },
      ],
      support_level_usd: 0.35,
      resistance_level_usd: 0.42,
    },
  };
}
