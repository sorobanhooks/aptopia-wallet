// agent/src/services/copilot-parse-ai.ts
// Natural-language → structured Soroswap swap intent, via Gemini.
// The pure functions (validateIntent, parseModelText) are unit-tested; the
// fetch wrapper mirrors the other *-ai.ts services and is not exercised in tests.

import { geminiApiKey, geminiModel } from '../config';

export type SwapIntent = {
  type: 'swap';
  venue: 'soroswap';
  amountIn: string; // human units as typed, e.g. "5"
  tokenIn: 'XLM' | 'USDC';
  tokenOut: 'XLM' | 'USDC';
  slippageBps?: number;
};
export type Clarification = { type: 'clarification'; message: string };
export type Unsupported = { type: 'unsupported'; message: string };
export type ParseResult = SwapIntent | Clarification | Unsupported;

const SUPPORTED = new Set(['XLM', 'USDC']);

export function unsupported(message = 'I can only do Soroswap swaps right now.'): Unsupported {
  return { type: 'unsupported', message };
}
export function clarification(message: string): Clarification {
  return { type: 'clarification', message };
}

/** Deterministic guardrail over raw model output. Never trusts the model blindly. */
export function validateIntent(parsed: unknown): ParseResult {
  if (!parsed || typeof parsed !== 'object') return unsupported();
  const p = parsed as Record<string, unknown>;

  if (p.type === 'clarification' && typeof p.message === 'string' && p.message.trim().length > 0) {
    return clarification(p.message);
  }
  if (p.type === 'unsupported') {
    return unsupported(typeof p.message === 'string' ? p.message : undefined);
  }
  if (p.type !== 'swap') return unsupported();

  const tokenIn = String(p.tokenIn ?? '').toUpperCase();
  const tokenOut = String(p.tokenOut ?? '').toUpperCase();
  if (!SUPPORTED.has(tokenIn) || !SUPPORTED.has(tokenOut)) {
    return unsupported('I can only swap XLM and USDC right now.');
  }
  if (tokenIn === tokenOut) {
    return clarification('Which two different tokens do you want to swap?');
  }
  const amountIn = String(p.amountIn ?? '');
  if (!/^\d+(\.\d+)?$/.test(amountIn) || Number(amountIn) <= 0) {
    return clarification('How much do you want to swap?');
  }
  let slippageBps: number | undefined;
  if (p.slippageBps !== undefined) {
    const n = Number(p.slippageBps);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) {
      return clarification('What slippage tolerance would you like, in percent?');
    }
    slippageBps = n;
  }
  return {
    type: 'swap',
    venue: 'soroswap',
    amountIn,
    tokenIn: tokenIn as 'XLM' | 'USDC',
    tokenOut: tokenOut as 'XLM' | 'USDC',
    ...(slippageBps !== undefined ? { slippageBps } : {}),
  };
}

/** Tolerant JSON parse (strips code fences), mirrors contract-summary-ai. */
export function parseModelText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function buildPrompt(message: string, context: { role: string; text: string }[]): string {
  const history = context.map((t) => `${t.role}: ${t.text}`).join('\n');
  return `You convert a user's message into a Soroswap swap intent on Stellar testnet.
Supported tokens: XLM, USDC. Only token-to-token swaps on Soroswap are supported.
Return ONLY JSON, exactly one of:
{"type":"swap","venue":"soroswap","amountIn":"<number as string>","tokenIn":"XLM|USDC","tokenOut":"XLM|USDC","slippageBps":<optional integer bps>}
{"type":"clarification","message":"<one short question>"}
{"type":"unsupported","message":"<one short sentence>"}
Rules: amountIn is the number the user said (human units, not base units). If the request is anything other than a Soroswap swap of XLM/USDC, return unsupported. If information is missing or ambiguous, return clarification. Never invent amounts or tokens.
${history ? `Conversation so far:\n${history}\n` : ''}User message: ${message}`;
}

export async function parseSwapMessage(
  message: string,
  context: { role: string; text: string }[] = [],
): Promise<ParseResult> {
  const apiKey = geminiApiKey;
  if (!apiKey) {
    console.warn('[copilot-parse-ai] GEMINI_API_KEY not set (or placeholder)');
    return unsupported('Copilot is unavailable right now.');
  }
  try {
    const model = geminiModel;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(message, context) }] }],
          generationConfig: { temperature: 0.1 },
        }),
      },
    );
    if (!response.ok) {
      console.warn('[copilot-parse-ai] Gemini returned non-OK status', response.status);
      return unsupported('Copilot is unavailable right now.');
    }
    const result = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return validateIntent(parseModelText(raw));
  } catch (e) {
    console.error('[copilot-parse-ai] parse failed:', e);
    return unsupported('Copilot is unavailable right now.');
  }
}
