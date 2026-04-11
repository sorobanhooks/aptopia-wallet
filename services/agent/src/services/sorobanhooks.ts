import { config } from "../config";
import type { AlertPayload } from "../types";

const FALLBACK_EVENT = "price_drop";

function normalizeAsset(asset: string): string {
  return asset.trim().toUpperCase();
}

function mockAlert(asset: string): AlertPayload {
  return {
    asset: normalizeAsset(asset),
    event: FALLBACK_EVENT,
    change_pct: -5.2,
    price_usd: 0.38,
    timestamp: new Date().toISOString(),
  };
}

export async function fetchAlert(asset: string): Promise<AlertPayload> {
  const normalized = normalizeAsset(asset);
  if (!config.sorobanhooksBaseUrl) {
    return mockAlert(normalized);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const url = `${config.sorobanhooksBaseUrl.replace(/\/$/, "")}/alerts/${encodeURIComponent(
      normalized
    )}`;

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Sorobanhooks alert endpoint returned ${response.status}`);
    }

    const json = (await response.json()) as AlertPayload;
    return {
      asset: normalizeAsset(json.asset ?? normalized),
      event: json.event,
      change_pct: json.change_pct,
      price_usd: json.price_usd,
      timestamp: json.timestamp,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown upstream error";
    throw new Error(`Unable to fetch alert from Sorobanhooks: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
