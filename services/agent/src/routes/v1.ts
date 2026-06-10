import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import { Agent, AgentLog } from '../services/db';
import { resetDailySpendIfNeeded } from '../services/daily-spend';
import { ChainFactory } from '../services/chains/chain-factory';
import { WorkerManager } from '../services/worker-manager';
import { revokeAgentWallet } from '../services/revoke-agent';
import { bot } from '../services/bot';
import { createChallenge, verifyAndIssue } from '../services/auth';
import { requireAuth, assertOwnsAgent } from '../middleware/require-auth';
import { decryptAgentSecret } from '../services/agent-secret-crypto';
import { getPendingTier2Trade, clearPendingTier2Trade } from '../services/pending-tier2';
import { recordSuccessfulBuy, recordSuccessfulSell } from '../services/agent-stats';
import { narrateLogWithGemini } from '../services/narrate-log-ai';
import { explainRulesWithGemini, type AgentRuleFields } from '../services/explain-rules-ai';
import { createHash } from 'crypto';
import { OFF_CHAIN_YIELD_SOURCES } from '../services/off-chain-yield-sources';

const ALLOWED_RULE_KEYS = [
  'buyBelowUsd',
  'sellAboveUsd',
  'tier1Max',
  'tier2Max',
  'dailyBudget',
  'buyAmountUsdc',
  'sellAmountXlm',
] as const;

type RuleKey = (typeof ALLOWED_RULE_KEYS)[number];

function publicRules(agent: {
  agentAddress: string;
  buyBelowUsd: number;
  sellAboveUsd: number;
  tier1Max: number;
  tier2Max: number;
  dailyBudget: number;
  buyAmountUsdc: number;
  sellAmountXlm: number;
}) {
  return {
    agentAddress: agent.agentAddress,
    buyBelowUsd: agent.buyBelowUsd,
    sellAboveUsd: agent.sellAboveUsd,
    tier1Max: agent.tier1Max,
    tier2Max: agent.tier2Max,
    dailyBudget: agent.dailyBudget,
    buyAmountUsdc: agent.buyAmountUsdc,
    sellAmountXlm: agent.sellAmountXlm,
  };
}

function validateTierOrder(tier1: number, tier2: number): boolean {
  return tier1 > 0 && tier2 > tier1;
}

export function createV1Router(): Router {
  const router = Router();

  // --- Public auth + health endpoints (bypass requireAuth) ---

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, t: new Date().toISOString() });
  });

  // POST /v1/auth/challenge { pubkey } -> { nonce, domain, statement, issuedAt, expiresAt, message }
  router.post('/auth/challenge', (req: Request, res: Response) => {
    const pubkey = req.body?.pubkey;
    try {
      const challenge = createChallenge(pubkey);
      return res.json(challenge);
    } catch (e: any) {
      if (e?.message === 'INVALID_PUBKEY') {
        return res.status(400).json({ error: 'Invalid Stellar public key' });
      }
      console.error('POST /v1/auth/challenge failed:', e);
      return res.status(500).json({ error: 'Failed to create challenge' });
    }
  });

  // GET /v1/yield-sources/off-chain
  // Public (no auth required) — returns hand-curated list of off-chain yield
  // sources (Wirex, Ultra Stellar). Intentionally mounted BEFORE requireAuth
  // because this is static, non-user-scoped public data. The wallet may show
  // it pre-login. Rates are manually reviewed; see
  // src/services/off-chain-yield-sources.ts for refresh cadence.
  router.get('/yield-sources/off-chain', (_req: Request, res: Response) => {
    res.json(OFF_CHAIN_YIELD_SOURCES);
  });

  // POST /v1/auth/verify { pubkey, signature, message } -> { token, expiresAt }
  router.post('/auth/verify', (req: Request, res: Response) => {
    const { pubkey, signature, message } = req.body ?? {};
    if (typeof signature !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'signature and message are required' });
    }
    try {
      const result = verifyAndIssue({ pubkey, signature, message });
      return res.json(result);
    } catch (e: any) {
      const code = e?.message;
      if (code === 'INVALID_PUBKEY') {
        return res.status(400).json({ error: 'Invalid Stellar public key' });
      }
      if (
        code === 'UNKNOWN_CHALLENGE' ||
        code === 'CHALLENGE_EXPIRED' ||
        code === 'PUBKEY_MISMATCH' ||
        code === 'BAD_SIGNATURE' ||
        code === 'INVALID_SIGNATURE_ENCODING'
      ) {
        return res.status(401).json({ error: 'Signature verification failed' });
      }
      console.error('POST /v1/auth/verify failed:', e);
      return res.status(500).json({ error: 'Failed to verify signature' });
    }
  });

  // --- Everything below requires a valid bearer JWT ---
  router.use(requireAuth);

  router.get('/logs/:address', async (req: Request, res: Response) => {
    const { address } = req.params;

    // Ownership: the agent identified by this worker/agent address must belong
    // to the authed wallet (targetWallet). Look it up to enforce, then 404 if
    // it doesn't exist.
    const owner = await Agent.findOne({ agentAddress: address })
      .select('targetWallet')
      .lean();
    if (!owner) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, owner.targetWallet)) return;

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20)
    );
    const skip = (page - 1) * limit;
    const filter = { workerAddress: address };

    const [items, total] = await Promise.all([
      AgentLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AgentLog.countDocuments(filter),
    ]);

    res.json({
      page,
      limit,
      total,
      items,
    });
  });

  router.get('/rules/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address }).lean();
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, (agent as any).targetWallet)) return;
    return res.json(publicRules(agent as any));
  });

  router.put('/rules/:address', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const updates: Partial<Record<RuleKey, number>> = {};

    for (const k of ALLOWED_RULE_KEYS) {
      if (body[k] !== undefined) {
        const n = Number(body[k]);
        if (!Number.isFinite(n)) {
          return res.status(400).json({ error: `Invalid number for ${k}` });
        }
        updates[k] = n;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid rule fields in body' });
    }

    const agent = await Agent.findOne({ agentAddress: req.params.address });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;

    const merged = {
      tier1Max: updates.tier1Max ?? agent.tier1Max,
      tier2Max: updates.tier2Max ?? agent.tier2Max,
    };

    if (!validateTierOrder(merged.tier1Max, merged.tier2Max)) {
      return res
        .status(400)
        .json({ error: 'tier2Max must be strictly greater than tier1Max (both positive)' });
    }

    const sellAbove =
      updates.sellAboveUsd !== undefined
        ? updates.sellAboveUsd
        : agent.sellAboveUsd;
    const buyBelow =
      updates.buyBelowUsd !== undefined ? updates.buyBelowUsd : agent.buyBelowUsd;
    if (sellAbove <= buyBelow) {
      return res
        .status(400)
        .json({ error: 'sellAboveUsd must be greater than buyBelowUsd' });
    }

    const buyAmountUsdc =
      updates.buyAmountUsdc !== undefined
        ? updates.buyAmountUsdc
        : agent.buyAmountUsdc;
    if (buyAmountUsdc <= 0) {
      return res.status(400).json({ error: 'buyAmountUsdc must be greater than 0' });
    }

    const sellAmountXlm =
      updates.sellAmountXlm !== undefined
        ? updates.sellAmountXlm
        : agent.sellAmountXlm;
    if (sellAmountXlm <= 0) {
      return res.status(400).json({ error: 'sellAmountXlm must be greater than 0' });
    }

    const updated = await Agent.findOneAndUpdate(
      { agentAddress: req.params.address },
      { $set: updates, $unset: { rulesExplanation: '' } },
      { new: true }
    );

    if (updated?.active && updated.usdcTrustlineReady !== false) {
      WorkerManager.startAgentWorker(updated);
    }

    return res.json(publicRules(updated!));
  });

  router.get('/metrics/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ targetWallet: req.params.address });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    // Here :address IS the targetWallet, so ownership = authed pubkey === :address.
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;

    await resetDailySpendIfNeeded(agent);

    const chain = ChainFactory.getService(agent.chain || 'stellar');
    const balances = await chain.getBalance(agent.agentAddress);

    const agentId = String(agent._id);
    const pendingEntry = getPendingTier2Trade(agentId);
    const pendingTier2Count = pendingEntry ? 1 : 0;

    return res.json({
      agentAddress: agent.agentAddress,
      balances: {
        native: balances.native,
        usdc: balances.usdc,
        assets: balances.assets ?? {},
      },
      dailySpentUsd: agent.spentToday,
      dailyLimitUsd: agent.dailyBudget,
      totalSuccessfulTrades: agent.totalSuccessfulTrades ?? 0,
      status: agent.active ? 'healthy' : 'disabled',
      pendingTier2Count,
    });
  });

  // --- Tier-2 wallet confirmation endpoints ---
  // :address = agentAddress (same convention as /logs, /rules, /revoke)

  router.get('/pending-tier2/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address }).lean();
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, (agent as any).targetWallet)) return;

    const agentId = String((agent as any)._id);
    const pending = getPendingTier2Trade(agentId);

    if (!pending) {
      return res.json([]);
    }

    const item = {
      id: agentId,
      side: pending.direction === 'buy_xlm' ? 'buy' : 'sell',
      token: 'XLM',
      amount: pending.direction === 'buy_xlm' ? (pending.buyUsdc ?? null) : (pending.sellXlm ?? null),
      price: null,
      plannedUsdc: pending.direction === 'buy_xlm' ? (pending.buyUsdc ?? null) : null,
      plannedXlm: pending.direction === 'sell_xlm' ? (pending.sellXlm ?? null) : null,
      createdAt: null,
    };

    return res.json([item]);
  });

  router.post('/pending-tier2/:address/:id/confirm', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;
    if (!agent.active) {
      return res.status(400).json({ error: 'Agent wallet is disabled' });
    }

    const agentId = String(agent._id);

    // I1: validate direction enum FIRST — before any pending lookup so an invalid
    // value always returns 400 regardless of whether a pending entry exists.
    const { direction: intentDirection } = req.body ?? {};
    if (
      intentDirection !== undefined &&
      intentDirection !== 'buy_xlm' &&
      intentDirection !== 'sell_xlm'
    ) {
      return res.status(400).json({ error: 'direction must be buy_xlm or sell_xlm' });
    }

    // :id must match the pending entry's id (agentId in the one-per-agent model)
    if (req.params.id !== agentId) {
      return res.status(404).json({ error: 'Pending trade not found' });
    }

    const pending = getPendingTier2Trade(agentId);
    if (!pending) {
      return res.status(404).json({ error: 'No pending Tier-2 trade for this agent' });
    }

    // I1: direction mismatch against known pending entry → 409
    if (intentDirection !== undefined && intentDirection !== pending.direction) {
      return res.status(409).json({ error: 'Trade direction mismatch; please refresh' });
    }

    const chainService = ChainFactory.getService(agent.chain || 'stellar');

    if (pending.direction === 'buy_xlm') {
      const amount = pending.buyUsdc;
      if (!amount) {
        // C1: claim synchronously before any await
        clearPendingTier2Trade(agentId);
        WorkerManager.clearTier2Direction(agentId);
        return res.status(422).json({ error: 'Missing buy amount; please wait for a new trade prompt' });
      }
      // C1: CLAIM — clear the pending slot BEFORE the async swap so a concurrent
      //     request (Telegram callback in the same event-loop window) cannot
      //     read the same pending entry and double-execute.
      const capturedAmount = amount;
      const capturedAgentId = agent._id;
      const capturedTelegramId = agent.telegramId;
      const capturedAgentAddress = agent.agentAddress;
      const capturedToken = agent.token;
      clearPendingTier2Trade(agentId);
      WorkerManager.clearTier2Direction(agentId);
      try {
        const txHash = await chainService.executeSwap(
          decryptAgentSecret(agent),
          'buy_xlm',
          capturedAmount
        );
        const usdcSpent = parseFloat(capturedAmount);
        await recordSuccessfulBuy(agentId, usdcSpent);
        await AgentLog.create({
          agentId: capturedAgentId,
          telegramId: capturedTelegramId,
          workerAddress: capturedAgentAddress,
          eventType: 'trade',
          status: 'success',
          token: capturedToken,
          amount: `Buy XLM (${capturedAmount} USDC)`,
          txHash,
        });
        return res.json({ ok: true, txHash });
      } catch (e: unknown) {
        // C3: log server-side, return generic code — do not leak e.message to caller
        console.error('[confirm] trade failed:', e);
        const reason = e instanceof Error ? e.message : String(e);
        await AgentLog.create({
          agentId: capturedAgentId,
          telegramId: capturedTelegramId,
          workerAddress: capturedAgentAddress,
          eventType: 'trade',
          status: 'failure',
          token: capturedToken,
          amount: `Buy XLM (${capturedAmount} USDC)`,
          reason,
        });
        return res.status(502).json({ error: 'Trade execution failed', code: 'SWAP_ERROR' });
      }
    } else {
      // sell_xlm
      const amount = pending.sellXlm;
      if (!amount) {
        // C1: claim synchronously before any await
        clearPendingTier2Trade(agentId);
        WorkerManager.clearTier2Direction(agentId);
        return res.status(422).json({ error: 'Missing sell amount; please wait for a new trade prompt' });
      }
      // C1: CLAIM — clear the pending slot BEFORE the async swap
      const capturedAmount = amount;
      const capturedAgentId = agent._id;
      const capturedTelegramId = agent.telegramId;
      const capturedAgentAddress = agent.agentAddress;
      const capturedToken = agent.token;
      clearPendingTier2Trade(agentId);
      WorkerManager.clearTier2Direction(agentId);
      try {
        const txHash = await chainService.executeSwap(
          decryptAgentSecret(agent),
          'sell_xlm',
          capturedAmount
        );
        await recordSuccessfulSell(agentId);
        await AgentLog.create({
          agentId: capturedAgentId,
          telegramId: capturedTelegramId,
          workerAddress: capturedAgentAddress,
          eventType: 'trade',
          status: 'success',
          token: capturedToken,
          amount: `Sell XLM (${capturedAmount} XLM)`,
          txHash,
        });
        return res.json({ ok: true, txHash });
      } catch (e: unknown) {
        // C3: log server-side, return generic code — do not leak e.message to caller
        console.error('[confirm] trade failed:', e);
        const reason = e instanceof Error ? e.message : String(e);
        await AgentLog.create({
          agentId: capturedAgentId,
          telegramId: capturedTelegramId,
          workerAddress: capturedAgentAddress,
          eventType: 'trade',
          status: 'failure',
          token: capturedToken,
          amount: `Sell XLM (${capturedAmount} XLM)`,
          reason,
        });
        return res.status(502).json({ error: 'Trade execution failed', code: 'SWAP_ERROR' });
      }
    }
  });

  router.post('/pending-tier2/:address/:id/reject', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;

    const agentId = String(agent._id);

    if (req.params.id !== agentId) {
      return res.status(404).json({ error: 'Pending trade not found' });
    }

    const pending = getPendingTier2Trade(agentId);
    if (!pending) {
      return res.status(404).json({ error: 'No pending Tier-2 trade for this agent' });
    }

    clearPendingTier2Trade(agentId);
    WorkerManager.clearTier2Direction(agentId);

    const amountDesc = pending.direction === 'buy_xlm'
      ? `Buy XLM (${pending.buyUsdc ?? '?'} USDC)`
      : `Sell XLM (${pending.sellXlm ?? '?'} XLM)`;

    await AgentLog.create({
      agentId: agent._id,
      telegramId: agent.telegramId,
      workerAddress: agent.agentAddress,
      eventType: 'trade',
      status: 'failure',
      token: agent.token,
      amount: amountDesc,
      reason: 'rejected_by_user',
    });

    return res.json({ ok: true });
  });

  // POST /v1/narrate-log/:address/:logId
  // Protected: requireAuth (applied at router level) + assertOwnsAgent.
  // Returns a plain-English AI narration of the trade log, cached on the AgentLog doc.
  router.post('/narrate-log/:address/:logId', async (req: Request, res: Response) => {
    const { address, logId } = req.params;

    // Look up the agent so we can enforce ownership
    const agent = await Agent.findOne({ agentAddress: address }).select('targetWallet').lean();
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, (agent as any).targetWallet)) return;

    // Reject non-ObjectId logId before hitting Mongo (prevents CastError)
    if (!Types.ObjectId.isValid(logId)) {
      return res.status(400).json({ error: 'Invalid log ID' });
    }

    // Look up the log — must belong to this agent's worker address
    const log = await AgentLog.findOne({ _id: logId, workerAddress: address });
    if (!log) {
      return res.status(404).json({ error: 'Log entry not found' });
    }

    // Write-through cache: if narration already exists, return it
    if (log.narration) {
      return res.json({ narration: log.narration, cached: true });
    }

    // Generate narration via Gemini (with fallback; never throws)
    const narration = await narrateLogWithGemini({
      amount: log.amount,
      status: log.status,
      token: log.token,
      txHash: log.txHash,
      reason: log.reason,
    });

    // Persist to Mongo (write-through cache)
    await AgentLog.updateOne({ _id: log._id }, { $set: { narration } });

    return res.json({ narration, cached: false });
  });

  // POST /v1/explain-rules/:address
  // Protected: requireAuth (applied at router level) + assertOwnsAgent.
  // Returns a plain-English AI explanation of the agent's trading rules,
  // cached on the Agent doc keyed by (agentId, rulesHash).
  router.post('/explain-rules/:address', async (req: Request, res: Response) => {
    const { address } = req.params;

    const agent = await Agent.findOne({ agentAddress: address });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;

    const ruleFields: AgentRuleFields = {
      buyBelowUsd: agent.buyBelowUsd,
      sellAboveUsd: agent.sellAboveUsd,
      tier1Max: agent.tier1Max,
      tier2Max: agent.tier2Max,
      dailyBudget: agent.dailyBudget,
    };

    // Stable hash of the 5 rule fields — cache key
    const rulesHash = createHash('sha256')
      .update(JSON.stringify(ruleFields))
      .digest('hex');

    // Cache hit: same rules hash — return stored explanation
    const cached = (agent as any).rulesExplanation;
    if (cached && cached.hash === rulesHash) {
      return res.json({ explanation: cached.text, cached: true });
    }

    // Generate explanation via Gemini (with fallback; never throws)
    const explanation = await explainRulesWithGemini(ruleFields);

    // Persist cache to Agent doc
    await Agent.updateOne(
      { agentAddress: address },
      { $set: { rulesExplanation: { hash: rulesHash, text: explanation } } },
    );

    return res.json({ explanation, cached: false });
  });

  router.post('/revoke/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!assertOwnsAgent(req, res, agent.targetWallet)) return;
    if (!agent.active) {
      return res.status(400).json({ error: 'Agent already disabled' });
    }

    try {
      const result = await revokeAgentWallet(agent);
      const transferredSummary =
        result.transfers.length > 0
          ? result.transfers.map((t) => `${t.amount} ${t.token}`).join(', ')
          : 'nothing (no transferable balances)';
      const msg = `✅ Revoked.\nTransferred ${transferredSummary} → your main wallet\nAgent wallet disabled.\nUse /createagent to set up a new agent wallet anytime.`;
      try {
        await bot.telegram.sendMessage(agent.telegramId, msg);
      } catch (e) {
        console.error('POST /v1/revoke: Telegram notify failed', e);
      }
      return res.json({ ok: true, ...result });
    } catch (e: any) {
      console.error('POST /v1/revoke failed:', e);
      if(e?.response?.data?.extras) {
        const extras = e.response.data.extras;
        console.error('POST /v1/revoke upstream extras:', extras);
        if(extras.result_codes?.operations?.includes('op_no_trust')) {
          return res.status(400).json({
            error: 'Destination wallet is missing a trustline for one of the assets',
          });
        }
        return res.status(500).json({
          error: 'revoke failed',
          code: 'REVOKE_UPSTREAM_ERROR',
        });
      }
      console.error('POST /v1/revoke error:', e);
      return res.status(500).json({
        error: 'revoke failed',
        code: 'REVOKE_UPSTREAM_ERROR',
      });
    }
  });

  return router;
}
