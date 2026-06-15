// POST /tx/submit — fallback for wallets that sign but cannot submit.
//
// Body: { signed_xdr: string }. Response: { hash, status, returnValue }.

import { Hono } from "hono";
import { submitSignedXdr } from "../rpc";

export const submitRoutes = new Hono();

submitRoutes.post("/tx/submit", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const signedXdr = String(body.signed_xdr ?? "");
  if (!signedXdr) {
    return c.json({ error: "body must include { signed_xdr }" }, 400);
  }
  try {
    const result = await submitSignedXdr(signedXdr);
    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});
