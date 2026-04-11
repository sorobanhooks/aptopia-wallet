export interface TokenPriceData {
  currentPrice: number;
  percentagePriceChange24h: number | null;
}

interface TokenPriceResponse {
  data: Record<
    string,
    { currentPrice: string; percentagePriceChange24h: string | null } | null
  >;
}

export async function getTokenPrices(
  indexerBaseUrl: string,
  tokens: string[]
): Promise<Record<string, TokenPriceData | null>> {
  if (tokens.length === 0) return {};

  const base = indexerBaseUrl.replace(/\/$/, '');
  const url = `${base}/token-prices`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokens }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Token prices request failed (${res.status}): ${text || res.statusText}`
    );
  }

  const json = (await res.json()) as TokenPriceResponse;
  const data = json.data ?? {};
  const result: Record<string, TokenPriceData | null> = {};

  for (const [tokenId, entry] of Object.entries(data)) {
    if (entry === null) {
      result[tokenId] = null;
      continue;
    }

    result[tokenId] = {
      currentPrice: Number.parseFloat(entry.currentPrice),
      percentagePriceChange24h:
        entry.percentagePriceChange24h !== null
          ? Number.parseFloat(entry.percentagePriceChange24h)
          : null,
    };
  }

  return result;
}
