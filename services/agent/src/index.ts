import 'dotenv/config';
import express from 'express';
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
bot.launch();
console.log('Telegram bot launched');
WorkerManager.initAllWorkers();

// 3. Express API with X402
app.use(express.json());

app.use('/v1', createV1Router());

validatePaidConfig();
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
    },
    facilitatorClient,
    [{ network: config.network as `${string}:${string}`, server: new ExactStellarScheme() }]
  )
);

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

app.listen(port, () => {
  console.log(`X402 Proxy Server running at http://localhost:${port}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
