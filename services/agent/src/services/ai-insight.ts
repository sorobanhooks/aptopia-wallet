import type { EnrichedPayload, InsightPayload } from "../types";

export async function generateStubInsight(
  enriched: EnrichedPayload
): Promise<InsightPayload> {
  const summary = `${enriched.asset} moved ${enriched.change_pct}% with elevated on-chain activity. ` +
    `Volume shifted ${enriched.context.volume_change_pct}% and ${enriched.context.whale_txs_last_1h} whale transactions were detected. ` +
    `Price is near support ${enriched.context.support_level_usd}.`;

  return {
    asset: enriched.asset,
    event: enriched.event,
    change_pct: enriched.change_pct,
    price_usd: enriched.price_usd,
    timestamp: enriched.timestamp,
    insight: {
      summary,
      confidence: "medium",
      suggested_action: "buy_dip",
      risk_factors: [
        "high_volume_sell_pressure",
        "approaching_support",
      ],
    },
  };
}
