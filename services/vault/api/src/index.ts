// Baku API entry point.
//
// HANDOFF.md §I8: Bun + Hono. NO client auth (a static key shipped in the
// wallet bundle is theatre; the 3s cache + Soroban RPC's own rate limits are
// the real DoS mitigation). Single source of truth for addresses is
// src/addresses.ts (mirrored from crates/addresses/src/lib.rs).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { balanceRoutes } from "./routes/balance";
import { submitRoutes } from "./routes/submit";
import { swapRoutes } from "./routes/swap";
import { vaultRoutes } from "./routes/vault";

const PORT = Number(process.env.PORT ?? 8787);

const app = new Hono();
app.use("*", logger());
// Allow browser clients (the xyra-wallet-sdk extension popup, local dashboards)
// to call the API cross-origin. Read-only data + build-tx (no signing here), so
// a permissive policy is fine; tighten the origin allow-list for production.
app.use("*", cors());

app.get("/", (c) =>
  c.json({
    name: "baku-api",
    version: "0.1.0",
    docs: "see API.md in the repo root",
    endpoints: [
      "GET  /addresses",
      "GET  /vault/:asset/state",
      "GET  /vault/:asset/strategies",
      "POST /vault/:asset/deposit/build-tx",
      "POST /vault/:asset/withdraw/build-tx",
      "GET  /balance/:address",
      "POST /tx/submit",
      "POST /swap/build-tx",
      "GET  /health",
    ],
  }),
);

app.get("/health", (c) => c.json({ ok: true, t: new Date().toISOString() }));

app.route("/", vaultRoutes);
app.route("/", balanceRoutes);
app.route("/", submitRoutes);
app.route("/", swapRoutes);

console.log(`baku-api listening on http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
