import { wallet } from "@shared/helpers/stellar";

/**
 * Token prices change slowly; serve a cached result for this long before
 * hitting the upstream indexer again.
 */
export const TOKEN_PRICE_TTL_MS = 60_000;

type TokenPriceData = {
  currentPrice: number;
  percentagePriceChange24h: number | null;
};
type PriceMap = Record<string, TokenPriceData | null>;

interface CacheEntry {
  at: number;
  value: PriceMap;
}

// Module-scoped, so every caller in this JS context (popup or background)
// shares one cache + one in-flight request per asset set.
const inflight = new Map<string, Promise<PriceMap>>();
const cache = new Map<string, CacheEntry>();

function assetKey(balance: any): string {
  if (balance?.assetType === "native") {
    return "native";
  }
  const code = balance?.assetCode ?? "";
  const issuer = balance?.assetIssuer ?? "";
  if (issuer) {
    return `${code}:${issuer}`;
  }
  return code || "native";
}

function cacheKeyFor(balances: any[]): string {
  return Array.from(new Set(balances.map(assetKey)))
    .sort()
    .join(",");
}

/**
 * Deduplicating, short-TTL wrapper around `wallet.getTokenPrices`.
 *
 * Many components and pollers ask for token prices independently; without this
 * every mount/interval/balance-refresh fired its own request to the indexer.
 * This collapses concurrent calls for the same asset set into a single request
 * and serves a cached result for {@link TOKEN_PRICE_TTL_MS} afterwards.
 */
export async function getTokenPricesDeduped(balances: any[]): Promise<PriceMap> {
  if (!balances || balances.length === 0) {
    return {};
  }

  const key = cacheKeyFor(balances);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TOKEN_PRICE_TTL_MS) {
    return cached.value;
  }

  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }

  const request = Promise.resolve()
    .then(() => wallet.getTokenPrices(balances) as Promise<PriceMap>)
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}

/** Test-only: clear the dedupe/cache state between cases. */
export function __resetTokenPriceDedupe(): void {
  inflight.clear();
  cache.clear();
}
