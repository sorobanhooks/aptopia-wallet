import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  network: process.env.NETWORK ?? "stellar:testnet",
  usdcAssetCode: process.env.USDC_ASSET_CODE ?? "USDC",
  usdcAssetIssuer: process.env.USDC_ASSET_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  usdcDecimals: Number(process.env.USDC_DECIMALS ?? 7),
  facilitatorUrl: process.env.FACILITATOR_URL,
  facilitatorApiKey: process.env.FACILITATOR_API_KEY,
  receiverWallet: process.env.RECEIVER_WALLET,
  sorobanhooksBaseUrl: process.env.SOROBANHOOKS_BASE_URL,
  sorobanhooksIndexerApiKey: process.env.SOROBANHOOKS_INDEXER_API_KEY,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 10000),
  alertsCacheTtlSeconds: Number(process.env.ALERTS_CACHE_TTL_SECONDS ?? 30),
  /** Alert when agent wallet USDC falls below this (human units, e.g. 0.05) */
  usdcLowBalanceFloor: Number(process.env.USDC_LOW_BALANCE_FLOOR ?? 0.05),
  /**
   * Per-request x402 price in USDC — keep in sync with paywall `price` in index.ts (e.g. $0.01).
   */
  x402PaywallPriceUsdc: Number(process.env.X402_PAYWALL_PRICE_USDC ?? 0.001),
  /** Minimum ms between repeated low-balance Telegram alerts per agent */
  lowBalanceAlertCooldownMs: Number(
    process.env.LOW_BALANCE_ALERT_COOLDOWN_MS ?? 3600000
  ),
};

export const pricing = {
  enriched: "0.01",
  insight: "0.05",
} as const;

export function validatePaidConfig(): void {
  const missing: string[] = [];

  if (!config.facilitatorUrl) missing.push("FACILITATOR_URL");
  if (!config.receiverWallet) missing.push("RECEIVER_WALLET");
  if (!config.facilitatorApiKey) missing.push("FACILITATOR_API_KEY");
  if (!config.sorobanhooksIndexerApiKey) missing.push("SOROBANHOOKS_INDEXER_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for paid routes: ${missing.join(", ")}`
    );
  }
}
