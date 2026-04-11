import type { Request, Response } from "express";
import { enrichAlert } from "../services/enrichment";
import { fetchAlert } from "../services/sorobanhooks";

export async function enrichedHandler(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const alert = await fetchAlert(req.params.asset);
    const enriched = await enrichAlert(alert);
    res.json(enriched);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error in enriched";
    res.status(502).json({ error: message });
  }
}
