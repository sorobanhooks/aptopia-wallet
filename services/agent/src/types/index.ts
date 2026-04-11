export interface AlertPayload {
  asset: string;
  event: string;
  change_pct: number;
  price_usd: number;
  timestamp: string;
}

export interface RelatedContractEvent {
  id: string;
  event: string;
  amount: number;
}

export interface EnrichmentContext {
  volume_24h: number;
  volume_change_pct: number;
  whale_txs_last_1h: number;
  largest_tx_amount: number;
  related_contracts: RelatedContractEvent[];
  support_level_usd: number;
  resistance_level_usd: number;
}

export interface EnrichedPayload extends AlertPayload {
  context: EnrichmentContext;
}

export interface InsightPayload extends AlertPayload {
  insight: {
    summary: string;
    confidence: "low" | "medium" | "high";
    suggested_action: "buy_dip" | "hold" | "watch";
    risk_factors: string[];
  };
}
