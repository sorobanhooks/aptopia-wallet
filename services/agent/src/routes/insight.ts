import type { Request, Response } from "express";
import { generateStubInsight } from "../services/ai-insight";
import { enrichAlert } from "../services/enrichment";
import { fetchAlert } from "../services/sorobanhooks";

export async function insightHandler(req: Request, res: Response): Promise<void> {
  try {
    const alert = await fetchAlert(req.params.asset);
    const enriched = await enrichAlert(alert);
    const insight = await generateStubInsight(enriched);
    res.json(insight);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error in insight";
    res.status(502).json({ error: message });
  }
}
