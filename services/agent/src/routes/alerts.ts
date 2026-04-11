import type { Request, Response } from "express";
import { fetchAlert } from "../services/sorobanhooks";

export async function alertsHandler(req: Request, res: Response): Promise<void> {
  try {
    const payload = await fetchAlert(req.params.asset);
    res.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error in alerts";
    res.status(502).json({ error: message });
  }
}
