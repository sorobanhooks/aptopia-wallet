# x402 Paywall Server

TypeScript Express server that wraps Sorobanhooks-style data endpoints with x402 payment middleware.

## Endpoints

- `GET /health`
- `GET /api/v1/alerts/:asset` (free)
- `GET /api/v1/enriched/:asset` (paid, `0.01 USDC`)
- `GET /api/v1/insight/:asset` (paid, `0.05 USDC`, stub insight response)
- `GET /api/v1/contract/mainnet/:address` (paid, returns decoded WASM + Gemini summary)
- `GET /api/v1/contract/testnet/:address` (paid, returns decoded WASM + Gemini summary)

## Setup

1. Copy env file:
   - `cp .env.example .env`
2. Install deps:
   - `npm install`
3. Run dev server:
   - `npm run dev`

## Notes

- If `FACILITATOR_URL` or `RECEIVER_WALLET` is missing, paid routes fall back to explicit `402` responses with helper headers.
- `GET /api/v1/alerts/:asset` now uses live indexer prices and requires `SOROBANHOOKS_INDEXER_API_KEY`.
- Alerts caching TTL is configured by `ALERTS_CACHE_TTL_SECONDS` (default 30s).
- Contract summary routes cache summaries in MongoDB by `(network, contract, wasmDigest)` so unchanged contracts are served from cache.

## Sample Requests

```bash
curl http://localhost:3000/api/v1/alerts/XLM
curl http://localhost:3000/api/v1/enriched/XLM
curl http://localhost:3000/api/v1/insight/XLM
curl http://localhost:3000/api/v1/contract/mainnet/CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
curl http://localhost:3000/api/v1/contract/testnet/CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```
