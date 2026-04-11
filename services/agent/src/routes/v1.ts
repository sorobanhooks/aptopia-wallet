import { Router, Request, Response } from 'express';
import { Agent, AgentLog } from '../services/db';
import { resetDailySpendIfNeeded } from '../services/daily-spend';
import { ChainFactory } from '../services/chains/chain-factory';
import { WorkerManager } from '../services/worker-manager';
import { revokeAgentWallet } from '../services/revoke-agent';
import { bot } from '../services/bot';

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

  router.get('/logs/:address', async (req: Request, res: Response) => {
    const { address } = req.params;
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
      { $set: updates },
      { new: true }
    );

    if (updated?.active) {
      WorkerManager.startAgentWorker(updated);
    }

    return res.json(publicRules(updated!));
  });

  router.get('/metrics/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ targetWallet: req.params.address });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    await resetDailySpendIfNeeded(agent);

    const chain = ChainFactory.getService(agent.chain || 'stellar');
    const balances = await chain.getBalance(agent.agentAddress);

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
    });
  });

  router.post('/revoke/:address', async (req: Request, res: Response) => {
    const agent = await Agent.findOne({ agentAddress: req.params.address });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
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
        console.error(extras);
        if(extras.result_codes?.operations?.includes('op_no_trust')) {
          return res.status(400).json({
            error: 'Destination wallet is missing a trustline for one of the assets',
          });
        }
        return res.status(500).json({
          error: extras,
        });
      }
      return res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return router;
}
