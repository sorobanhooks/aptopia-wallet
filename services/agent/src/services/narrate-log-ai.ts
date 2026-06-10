import type { IAgentLog } from './db';

// ---------------------------------------------------------------------------
// Conservative-refusal guardrail
// ---------------------------------------------------------------------------

/**
 * Words that constitute financial advice / prediction language.
 * Matched case-insensitively at word boundaries.
 */
const BANNED_WORD_RE =
  /\b(should|recommend(?:s|ed|ation|ations|ing)?|advis(?:e|es|ed|ing)|predict(?:s|ed|ion|ions|ing)?|will|forecast(?:s|ed|ing)?)\b/gi;

/**
 * Build a deterministic fallback narration from the log's structured fields.
 * Derives the trade direction from the `amount` field (e.g. "Buy XLM (2.50 USDC)")
 * and produces a plain factual sentence like "Bought 2.50 USDC of XLM."
 * Does NOT contain any banned advice/forecast words.
 */
export function buildFallbackNarration(log: Pick<IAgentLog, 'amount' | 'status' | 'token'>): string {
  const raw = (log.amount ?? '').trim();

  // Try to parse "Buy XLM (2.50 USDC)" or "Sell XLM (10.00 XLM)"
  const buyMatch = /buy\s+\w+\s*\(([0-9.]+)\s+USDC\)/i.exec(raw);
  if (buyMatch) {
    const usdc = parseFloat(buyMatch[1]).toFixed(2);
    return `Bought ${usdc} USDC of ${log.token ?? 'XLM'}.`;
  }

  const sellMatch = /sell\s+\w+\s*\(([0-9.]+)\s+XLM\)/i.exec(raw);
  if (sellMatch) {
    const xlm = parseFloat(sellMatch[1]).toFixed(2);
    return `Sold ${xlm} ${log.token ?? 'XLM'}.`;
  }

  // Generic fallback when amount field has an unexpected shape
  if (log.status === 'failure') {
    return `Trade attempt did not complete.`;
  }
  return `Trade executed: ${raw.slice(0, 60)}.`;
}

/**
 * Apply the conservative-refusal guardrail to model output.
 * If the text contains any banned words, return null (caller must use fallback).
 */
export function applyGuardrail(text: string): string | null {
  BANNED_WORD_RE.lastIndex = 0; // reset stateful regex
  if (BANNED_WORD_RE.test(text)) {
    return null;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Gemini narration
// ---------------------------------------------------------------------------

/**
 * Call Gemini to narrate a single trade log in plain English.
 *
 * Returns a narration string. On any error (no API key, HTTP error,
 * guardrail rejection) returns a deterministic fallback — never throws.
 */
export async function narrateLogWithGemini(
  log: Pick<IAgentLog, 'amount' | 'status' | 'token' | 'txHash' | 'reason'>,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[narrate-log-ai] GEMINI_API_KEY not set — using fallback narration');
    return buildFallbackNarration(log);
  }

  const prompt = [
    'Summarize this Stellar trade in one sentence for the wallet user.',
    'Be factual. No financial advice. No predictions. No recommendations.',
    'Output 1-2 sentences, 140 characters total maximum.',
    '',
    `Trade: ${log.amount}`,
    `Status: ${log.status}`,
    log.txHash ? `TxHash: ${log.txHash}` : '',
    log.reason ? `Reason: ${log.reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      },
    );

    if (!response.ok) {
      console.warn(`[narrate-log-ai] Gemini HTTP ${response.status} — using fallback`);
      return buildFallbackNarration(log);
    }

    const result = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const raw = (result.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    if (!raw) {
      return buildFallbackNarration(log);
    }

    const safe = applyGuardrail(raw);
    if (safe === null) {
      console.warn('[narrate-log-ai] Guardrail rejected model output — using fallback');
      return buildFallbackNarration(log);
    }

    // Truncate to 140 chars just in case
    return safe.length > 140 ? safe.slice(0, 137) + '...' : safe;
  } catch (err) {
    console.error('[narrate-log-ai] Unexpected error — using fallback', err);
    return buildFallbackNarration(log);
  }
}
