import type { DecodedContractWasm } from './contract-wasm';
import { geminiApiKey, geminiModel } from '../config';

export type ContractSummaryPayload = {
  overview: string;
  keyPoints: string[];
  exposedFunctions: string[];
  riskSignals: string[];
  confidence: 'low' | 'medium' | 'high';
};

function parseJsonSummary(text: string): ContractSummaryPayload | null {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (
      typeof parsed?.overview === 'string' &&
      Array.isArray(parsed?.keyPoints) &&
      Array.isArray(parsed?.exposedFunctions) &&
      Array.isArray(parsed?.riskSignals)
    ) {
      const confidence =
        parsed.confidence === 'low' || parsed.confidence === 'high' ? parsed.confidence : 'medium';
      return {
        overview: parsed.overview,
        keyPoints: parsed.keyPoints.map((x: unknown) => String(x)),
        exposedFunctions: parsed.exposedFunctions.map((x: unknown) => String(x)),
        riskSignals: parsed.riskSignals.map((x: unknown) => String(x)),
        confidence,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function fallbackSummary(decoded: DecodedContractWasm): ContractSummaryPayload {
  const exported = decoded.interface.exportedFunctions.map((f) => f.name).slice(0, 20);
  return {
    overview: 'Contract summary generated with fallback mode because AI output was unavailable.',
    keyPoints: [
      `Detected ${decoded.interface.importedFunctions.length} imported functions.`,
      `Detected ${decoded.interface.exportedFunctions.length} exported functions.`,
      `Detected ${decoded.interface.globals.length} global declarations.`,
    ],
    exposedFunctions: exported,
    riskSignals: [
      'Fallback summary may miss behavior-level interpretation.',
      'Manual review recommended for security-sensitive contracts.',
    ],
    confidence: 'low',
  };
}

export async function summarizeContractWasmWithGemini(
  decoded: DecodedContractWasm
): Promise<ContractSummaryPayload> {
  const apiKey = geminiApiKey;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set (or placeholder)');
    return fallbackSummary(decoded);
  }

  const prompt = `
You are a Stellar Soroban smart-contract analyst.
Given this decoded WASM interface JSON, produce a concise structured summary.

Return ONLY valid JSON with this exact shape:
{
  "overview": "string",
  "keyPoints": ["string"],
  "exposedFunctions": ["string"],
  "riskSignals": ["string"],
  "confidence": "low|medium|high"
}

Rules:
- Keep overview to 2-4 short sentences.
- keyPoints should have 4-8 bullets.
- exposedFunctions should prioritize meaningful exported functions.
- riskSignals should mention suspicious low-level patterns if seen.
- Do not include markdown code fences.

Decoded contract JSON:
${JSON.stringify(decoded)}
`;

  try {
    const model = geminiModel;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { 
            temperature: 0.2,
          },
        }),
      }
    );
    console.log('response', response);
    if (!response.ok) {
      return fallbackSummary(decoded);
    }

    const result = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const raw = result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseJsonSummary(raw);
    return parsed ?? fallbackSummary(decoded);
  } catch {
    return fallbackSummary(decoded);
  }
}
