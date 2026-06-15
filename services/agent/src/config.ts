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
  /**
   * HS256 secret for signing wallet-auth JWTs (/v1/auth). Falls back to a
   * dev-only constant so the server boots without config in local dev — a
   * warning is logged at startup when the fallback is used (see index.ts).
   */
  jwtSigningSecret: process.env.JWT_SIGNING_SECRET ?? "dev-only-insecure-jwt-secret-change-me",
  /** Domain shown in the SIWE challenge `message`. */
  authDomain: process.env.AUTH_DOMAIN ?? "xyra.wallet",
  /** Allowed CORS origin for the extension. Defaults to any chrome-extension. */
  walletOrigin: process.env.WALLET_ORIGIN ?? "chrome-extension://*",
};

/** True when JWT_SIGNING_SECRET is not set (server is using the dev fallback). */
export function isJwtSecretDefault(): boolean {
  return !process.env.JWT_SIGNING_SECRET;
}

export const pricing = {
  enriched: "0.01",
  insight: "0.05",
} as const;

/**
 * Check if a string looks like a placeholder (e.g., "replace-with-*" or "replace_with_*").
 */
function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  return /^replace[-_]/i.test(value);
}

/**
 * Validate paid config. Returns true if valid, false if placeholder/missing.
 * Only throws if a field is present but clearly broken (e.g., malformed URL).
 */
export function validatePaidConfig(): boolean {
  // If FACILITATOR_API_KEY is missing or a placeholder, paywall is disabled.
  if (isPlaceholder(config.facilitatorApiKey)) {
    return false;
  }

  // If paywall is enabled, all these must be present and valid.
  const missing: string[] = [];

  if (!config.facilitatorUrl) missing.push("FACILITATOR_URL");
  if (!config.receiverWallet) missing.push("RECEIVER_WALLET");
  if (!config.sorobanhooksIndexerApiKey) missing.push("SOROBANHOOKS_INDEXER_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for paid routes: ${missing.join(", ")}`
    );
  }

  return true;
}

/**
 * Gemini config shared by the AI services (copilot swap-intent parse, rule/log
 * narration, contract summary). Centralised here so the model id can't drift
 * across services.
 *
 * - `geminiApiKey` is `undefined` when GEMINI_API_KEY is unset OR still a
 *   `replace-with-*` placeholder, so callers fall back to their deterministic
 *   output instead of firing a request that 401/403s.
 * - `geminiModel` defaults to a current, valid flash model. The previous
 *   hard-coded default `gemini-3.5-flash` is NOT a real Gemini model id — every
 *   call 404'd, surfacing as "Copilot is unavailable right now." Override with
 *   the GEMINI_MODEL env var / deploy secret.
 */
export const geminiApiKey: string | undefined = isPlaceholder(
  process.env.GEMINI_API_KEY,
)
  ? undefined
  : process.env.GEMINI_API_KEY;
export const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
