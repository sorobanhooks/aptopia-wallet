import { applyGuardrail } from './narrate-log-ai';
import { geminiApiKey, geminiModel } from '../config';

// ---------------------------------------------------------------------------
// Rule-explainer types
// ---------------------------------------------------------------------------

export interface AgentRuleFields {
  buyBelowUsd: number;
  sellAboveUsd: number;
  tier1Max: number;
  tier2Max: number;
  dailyBudget: number;
}

// ---------------------------------------------------------------------------
// Deterministic fallback built purely from rule values (no model involved)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic rule-based explanation that never contains banned
 * advice/forecast words. Used when no API key is set, the model call fails,
 * or the guardrail rejects the model output.
 */
export function buildFallbackExplanation(rules: AgentRuleFields): string {
  const { buyBelowUsd, sellAboveUsd, tier1Max, tier2Max, dailyBudget } = rules;
  return (
    `Buys XLM when price ≤ $${buyBelowUsd} (automatic up to $${tier1Max}, confirmation required above $${tier1Max} up to $${tier2Max}). ` +
    `Sells XLM when price ≥ $${sellAboveUsd}. ` +
    `Daily cap $${dailyBudget}.`
  );
}

// ---------------------------------------------------------------------------
// Gemini rule explainer
// ---------------------------------------------------------------------------

/**
 * Call Gemini to produce a 2-3 sentence plain-English explanation of what the
 * agent will do given its trading rules.
 *
 * Returns an explanation string. On any error (no API key, HTTP error,
 * guardrail rejection) returns the deterministic fallback — never throws.
 */
export async function explainRulesWithGemini(rules: AgentRuleFields): Promise<string> {
  const apiKey = geminiApiKey;
  if (!apiKey) {
    console.warn('[explain-rules-ai] GEMINI_API_KEY not set (or placeholder) — using fallback explanation');
    return buildFallbackExplanation(rules);
  }

  const { buyBelowUsd, sellAboveUsd, tier1Max, tier2Max, dailyBudget } = rules;

  const prompt = [
    'Given these trading rules, write a 2-3 sentence plain-English explanation of what this agent will do.',
    'Factual only, no advice, no forecasts, no recommendations.',
    'Mention: buy condition, sell condition, automatic vs confirmation threshold, daily cap.',
    '',
    `Buy XLM when price is at or below: $${buyBelowUsd}`,
    `Sell XLM when price is at or above: $${sellAboveUsd}`,
    `Auto (Tier 1) max USDC per buy: $${tier1Max}`,
    `Confirmation (Tier 2) max USDC per buy: $${tier2Max}`,
    `Daily USDC spend cap: $${dailyBudget}`,
  ].join('\n');

  try {
    const model = geminiModel;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      },
    );

    if (!response.ok) {
      console.warn(`[explain-rules-ai] Gemini HTTP ${response.status} — using fallback`);
      return buildFallbackExplanation(rules);
    }

    const result = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const raw = (result.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    if (!raw) {
      return buildFallbackExplanation(rules);
    }

    const safe = applyGuardrail(raw);
    if (safe === null) {
      console.warn('[explain-rules-ai] Guardrail rejected model output — using fallback');
      return buildFallbackExplanation(rules);
    }

    return safe;
  } catch (err) {
    console.error('[explain-rules-ai] Unexpected error — using fallback', err);
    return buildFallbackExplanation(rules);
  }
}
