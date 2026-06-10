import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectDB } from './services/db';
import { initRedis, getPrice, setPrice } from './services/redis';
import { bot } from './services/bot';
import { paymentMiddlewareFromConfig } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { WorkerManager } from './services/worker-manager';
import { config, validatePaidConfig } from './config';
import { createV1Router } from './routes/v1';
import { getTokenPrices } from './services/token-prices';
import { getOrCreateContractSummary } from './services/contract-summary';

const app = express();
const port = process.env.PORT || 3000;

// 1. Initialize DB & Redis
const mdbUri = process.env.MONGODB_URI || '';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

if (!mdbUri) {
  console.error('ERROR: MONGODB_URI is not set in .env');
  process.exit(1);
}

connectDB(mdbUri);
initRedis(redisUrl);

// 2. Start Bot & Workers
bot.launch()
  .then(() => console.log('Telegram bot launched'))
  .catch((err) => console.error('[bot] launch failed:', err instanceof Error ? err.message : err));
WorkerManager.initAllWorkers();

// 3. Express API with X402
app.use(express.json());

// CORS for the wallet extension. WALLET_ORIGIN may be a specific
// chrome-extension://<id> origin; defaults to allowing any chrome-extension
// origin (and same-origin / curl with no Origin header). Without this the
// extension cannot preflight /v1/* requests.
const walletOrigin = config.walletOrigin;
if (walletOrigin === '*') {
  console.warn(
    '[cors] WALLET_ORIGIN=* — CORS is open to all origins. Set a specific origin in production.'
  );
}
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin (curl, server-to-server, same-origin).
      if (!origin) return callback(null, true);
      if (walletOrigin === '*') return callback(null, true);
      // Wildcard chrome-extension origin: allow any extension id.
      if (walletOrigin === 'chrome-extension://*') {
        return callback(null, origin.startsWith('chrome-extension://'));
      }
      return callback(null, origin === walletOrigin);
    },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

const KNOWN_FALLBACK_SECRET = 'dev-only-insecure-jwt-secret-change-me';
const rawJwtSecret = process.env.JWT_SIGNING_SECRET;
if (
  !rawJwtSecret ||
  rawJwtSecret === KNOWN_FALLBACK_SECRET ||
  rawJwtSecret.startsWith('replace-with-') ||
  rawJwtSecret.length < 16
) {
  console.error(
    '[auth] FATAL: JWT_SIGNING_SECRET is missing, a placeholder, too short (<16), ' +
    'or equals the known insecure fallback. Set a strong random secret (>=16 chars) ' +
    'in JWT_SIGNING_SECRET before starting the server.'
  );
  process.exit(1);
}

// C2: KEK startup guard — must be present, not a placeholder, and exactly 32 bytes
const rawKek = process.env.AGENT_SECRET_KEK_BASE64;
if (
  !rawKek ||
  rawKek.startsWith('replace-with-') ||
  Buffer.from(rawKek, 'base64').length !== 32
) {
  console.error(
    '[crypto] FATAL: AGENT_SECRET_KEK_BASE64 is missing, a placeholder, or not 32 bytes. ' +
    'Generate a 32-byte random key (e.g. openssl rand -base64 32) and set it in ' +
    'AGENT_SECRET_KEK_BASE64 before starting the server.'
  );
  process.exit(1);
}

app.use('/v1', createV1Router());

const paywallEnabled = validatePaidConfig();

if (paywallEnabled) {
  const facilitatorClient = new HTTPFacilitatorClient({
    url: config.facilitatorUrl!,
    createAuthHeaders: async () => {
      const headers = { Authorization: `Bearer ${config.facilitatorApiKey}` };
      return { verify: headers, settle: headers, supported: headers };
    },
  });

  app.use(
    paymentMiddlewareFromConfig(
      {
        'GET /api/v1/alerts/*': {
          accepts: {
            scheme: 'exact',
            // Quickguide format: human-readable USD price in USDC (sync with config.x402PaywallPriceUsdc).
            price: `$${config.x402PaywallPriceUsdc}`,
            network: config.network as `${string}:${string}`,
            payTo: config.receiverWallet!,
          },
          description: 'Token alert data',
          mimeType: 'application/json',
        },
        'GET /api/v1/contract/mainnet/*': {
          accepts: {
            scheme: 'exact',
            price: `$${config.x402PaywallPriceUsdc}`,
            network: config.network as `${string}:${string}`,
            payTo: config.receiverWallet!,
          },
          description: 'Mainnet contract WASM summary',
          mimeType: 'application/json',
        },
        'GET /api/v1/contract/testnet/*': {
          accepts: {
            scheme: 'exact',
            price: `$${config.x402PaywallPriceUsdc}`,
            network: config.network as `${string}:${string}`,
            payTo: config.receiverWallet!,
          },
          description: 'Testnet contract WASM summary',
          mimeType: 'application/json',
        },
      },
      facilitatorClient,
      [{ network: config.network as `${string}:${string}`, server: new ExactStellarScheme() }]
    )
  );
} else {
  console.warn(
    '[x402] FACILITATOR_API_KEY appears to be a placeholder — skipping paywall mount. /api/v1/alerts/:token and /api/v1/contract/* will return 503 until a valid key is provided.'
  );

  // Return 503 for paywalled endpoints when x402 is not configured
  app.get('/api/v1/alerts/:token', (_req, res) => {
    res.status(503).json({
      error: 'x402 paywall not configured',
      hint: 'set FACILITATOR_API_KEY',
    });
  });

  app.get('/api/v1/contract/mainnet/:address', (_req, res) => {
    res.status(503).json({
      error: 'x402 paywall not configured',
      hint: 'set FACILITATOR_API_KEY',
    });
  });

  app.get('/api/v1/contract/testnet/:address', (_req, res) => {
    res.status(503).json({
      error: 'x402 paywall not configured',
      hint: 'set FACILITATOR_API_KEY',
    });
  });
}

function normalizeToken(token: string): string {
  return token.trim().toUpperCase();
}

// Main Paywalled Price Endpoint
app.get('/api/v1/alerts/:token', async (req, res) => {
  const token = normalizeToken(req.params.token);
  if (token !== 'XLM') {
    return res.status(400).json({ error: 'Only XLM is supported.' });
  }

  try {
    // 1. Check Redis for cached price (Upstream Protection)
    const cached = await getPrice(token);
    if (cached) {
      console.log(`Serving cached price for ${token}`);
      return res.json(cached);
    }

    // 2. Not in cache, fetch from upstream indexer
    if (!config.sorobanhooksIndexerApiKey) {
      throw new Error('Missing SOROBANHOOKS_INDEXER_API_KEY');
    }
    const indexerBaseUrl = `https://api.sorobanhooks.xyz/v1/api/indexer/${config.sorobanhooksIndexerApiKey}`;
    const prices = await getTokenPrices(indexerBaseUrl, [token]);
    const entry = prices[token];
    if (!entry || !Number.isFinite(entry.currentPrice) || entry.currentPrice <= 0) {
      return res
        .status(502)
        .json({ error: `No valid upstream price available for ${token}` });
    }

    const priceData = {
      token,
      price: entry.currentPrice,
      percentagePriceChange24h: entry.percentagePriceChange24h,
      timestamp: new Date().toISOString(),
    };

    // 3. Store in Redis
    await setPrice(token, priceData, config.alertsCacheTtlSeconds);

    return res.json(priceData);
  } catch (error) {
    console.error(`Error fetching price for ${token}:`, error);
    res.status(502).json({ error: 'Unable to fetch token price from upstream' });
  }
});

async function handleContractSummaryRequest(
  network: 'mainnet' | 'testnet',
  address: string,
  res: express.Response
) {
  try {
    const result = await getOrCreateContractSummary(network, address);
    return res.json({
      network: result.network,
      contract: result.contract,
      source: result.source,
      wasmDigest: result.wasmDigest,
      summary: result.summary,
      decodedWasm: result.decoded,
    });
  } catch (error: any) {
    const status = Number(error?.statusCode) || 500;
    const message =
      error instanceof Error ? error.message : 'Unable to process contract summary request';
    return res.status(status).json({ error: message });
  }
}

app.get('/api/v1/contract/mainnet/:address', async (req, res) => {
  return handleContractSummaryRequest('mainnet', req.params.address, res);
});

app.get('/api/v1/contract/testnet/:address', async (req, res) => {
  return handleContractSummaryRequest('testnet', req.params.address, res);
});

app.get('/health', (_req, res) => res.json({ ok: true, t: new Date().toISOString() }));

app.listen(port, () => {
  console.log(`X402 Proxy Server running at http://localhost:${port}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
