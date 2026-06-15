import { Types } from 'mongoose';
import { Agent, AgentLog } from './db';
import { fetchPrice } from './x402-client';
import { ChainFactory } from './chains/chain-factory';
import { decryptAgentSecret } from './agent-secret-crypto';
import { evaluateUsdcBalance } from './chains/usdc-balance-eval';
import { bot } from './bot';
import { maybeSendLowBalanceAlert } from './low-balance-alert';
import { TradeDirection } from './chains/types';
import { resetDailySpendIfNeeded } from './daily-spend';
import {
  computePlannedBuyUsdcForAmount,
  routeBuy,
  routeSellForAmount,
} from './trade-routing';
import { recordSuccessfulBuy, recordSuccessfulSell } from './agent-stats';
import {
  setPendingTier2Trade,
  clearPendingTier2Trade,
} from './pending-tier2';
import { evaluateStrategies, selectAction, type StrategyAction } from './strategy-engine';
import type { StrategyConfig } from './strategy-types';
import { flatRulesToStrategies } from './strategy-mapping';

/** Tier 1: allow another auto-swap while price stays in buy/sell zone after this many ms. */
const TIER1_SAME_ZONE_COOLDOWN_MS = Number(
  process.env.TIER1_SAME_ZONE_COOLDOWN_MS || 30_000
);
const XLM_TOKEN = 'XLM';

/** Alerts JSON uses `price` (paywall handler) or `price_usd` (Sorobanhooks). */
function parseUsdPriceFromAlert(priceData: unknown): number | null {
  if (!priceData || typeof priceData !== 'object') return null;
  const o = priceData as Record<string, unknown>;
  const raw = o.price ?? o.price_usd;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type PriceSignal = 'none' | 'buy_xlm' | 'sell_xlm';

export class WorkerManager {
  private static activeWorkers: Map<string, NodeJS.Timeout> = new Map();
  private static lastSignalByAgent: Map<string, PriceSignal> = new Map();
  private static pendingTier2ByAgent: Map<string, TradeDirection> = new Map();
  private static lastTier1AutoTradeAtByAgent: Map<string, number> = new Map();

  /** Map Mongo subdocs → StrategyConfig. Lazy-on-read fallback (§11): if an agent
   *  has no strategies yet, synthesize them from its legacy flat fields so it trades
   *  before the one-time migration script runs. */
  private static readStrategies(fresh: any): StrategyConfig[] {
    const raw = Array.isArray(fresh.strategies) ? fresh.strategies : [];
    if (raw.length === 0) {
      return flatRulesToStrategies({
        buyBelowUsd: fresh.buyBelowUsd,
        sellAboveUsd: fresh.sellAboveUsd,
        buyAmountUsdc: fresh.buyAmountUsdc,
        sellAmountXlm: fresh.sellAmountXlm,
      }).map((s, i) => ({
        id: `legacy_${s.type}_${i}`,
        type: s.type,
        role: s.role,
        enabled: s.enabled,
        params: s.params,
        lastRunAt: s.lastRunAt,
      }));
    }
    return raw.map((s: any) => ({
      id: String(s._id),
      type: s.type,
      role: s.role,
      enabled: !!s.enabled,
      params: (s.params ?? {}) as Record<string, number>,
      lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
    }));
  }

  static async initAllWorkers() {
    const activeAgents = await Agent.find({
      active: true,
      usdcTrustlineReady: { $ne: false },
    });
    for (const agent of activeAgents) {
      this.startAgentWorker(agent);
    }
    console.log(`Started ${activeAgents.length} agent workers`);
  }

  static startAgentWorker(agent: any) {
    const agentId = String(agent.id ?? agent._id);

    if (agent.usdcTrustlineReady === false) {
      this.stopAgentWorker(agentId);
      return;
    }

    if (this.activeWorkers.has(agentId)) {
      clearInterval(this.activeWorkers.get(agentId)!);
    }

    const interval = setInterval(async () => {
      try {
        const fresh = await Agent.findById(agentId);
        if (!fresh || !fresh.active || fresh.usdcTrustlineReady === false) {
          return;
        }

        console.log(
          `Worker for agent ${fresh.agentAddress} polling for ${XLM_TOKEN}...`
        );

        await resetDailySpendIfNeeded(fresh);

        const chainName = fresh.chain || 'stellar';
        const chainService = ChainFactory.getService(chainName);

        const balances = await chainService.getBalance(fresh.agentAddress);
        const evaluation = evaluateUsdcBalance(balances.usdc);
        await maybeSendLowBalanceAlert(fresh, evaluation);

        const priceData = await fetchPrice(decryptAgentSecret(fresh));
        const currentPrice = parseUsdPriceFromAlert(priceData);
        if (currentPrice === null) {
          console.error(
            `Worker for agent ${fresh.agentAddress}: invalid or missing USD price in alert payload`,
            priceData
          );
          return;
        }

        const strategies = this.readStrategies(fresh);
        const action = selectAction(
          evaluateStrategies(strategies, { priceUsd: currentPrice, now: Date.now() })
        );

        const signal: PriceSignal = action ? action.direction : 'none';
        const previousSignal = this.lastSignalByAgent.get(fresh.id) ?? 'none';
        this.lastSignalByAgent.set(fresh.id, signal);

        if (!action) {
          this.pendingTier2ByAgent.delete(fresh.id);
          clearPendingTier2Trade(fresh.id);
          return;
        }

        if (action.direction === 'buy_xlm') {
          await this.handleBuyAction(fresh, chainService, action, currentPrice, previousSignal, parseFloat(balances.usdc) || 0);
        } else {
          await this.handleSellAction(fresh, chainService, action, currentPrice, previousSignal);
        }
      } catch (error) {
        console.error(`Error in worker for agent ${agentId}:`, error);
      }
    }, 30000);

    this.activeWorkers.set(agentId, interval);
  }

  private static async handleBuyAction(
    agent: any,
    chainService: ReturnType<typeof ChainFactory.getService>,
    action: Extract<StrategyAction, { direction: 'buy_xlm' }>,
    currentPrice: number,
    previousSignal: PriceSignal,
    usdcBalance: number
  ) {
    const planned = computePlannedBuyUsdcForAmount(agent, usdcBalance, action.amountUsdc);
    const route = routeBuy(agent, planned);

    if (route.kind === 'skip' || route.kind === 'blocked') {
      console.log(`Buy ${route.kind} for agent ${agent.id} (${action.type}): ${route.reason}`);
      return;
    }

    const autoWithoutPrompt =
      route.kind === 'tier1_auto' ||
      (route.kind === 'tier2_confirm' && !agent.requireTradeConfirmation);

    if (autoWithoutPrompt) {
      const sameZone = previousSignal === 'buy_xlm';
      if (sameZone) {
        const lastAuto = this.lastTier1AutoTradeAtByAgent.get(agent.id) ?? 0;
        if (Date.now() - lastAuto < TIER1_SAME_ZONE_COOLDOWN_MS) return;
      }
      const tierLabel = route.kind === 'tier1_auto' ? 'Tier 1' : 'Tier 2 (auto, no confirm)';
      try {
        const txHash = await chainService.executeSwap(decryptAgentSecret(agent), 'buy_xlm', route.usdc);
        await recordSuccessfulBuy(agent.id, route.usdcNum);
        if (action.type === 'dca') {
          await Agent.updateOne(
            { _id: agent._id, 'strategies._id': new Types.ObjectId(action.strategyId) },
            { $set: { 'strategies.$.lastRunAt': new Date() } }
          );
        }
        await AgentLog.create({
          agentId: agent._id, telegramId: agent.telegramId, workerAddress: agent.agentAddress,
          eventType: 'trade', status: 'success', token: agent.token,
          amount: `Buy XLM (${route.usdc} USDC) [${action.type}]`, txHash,
        });
        await bot.telegram.sendMessage(
          agent.telegramId,
          `✅ ${tierLabel} ${action.type} buy\nAmount: ${route.usdc} USDC\nXLM price: ${currentPrice} USD\nTx: ${txHash}`
        );
        this.lastTier1AutoTradeAtByAgent.set(agent.id, Date.now());
      } catch (tradeErr) {
        const reason = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
        await AgentLog.create({
          agentId: agent._id, telegramId: agent.telegramId, workerAddress: agent.agentAddress,
          eventType: 'trade', status: 'failure', token: agent.token,
          amount: `Buy XLM (${route.usdc} USDC) [${action.type}]`, reason,
        });
        console.error(`${tierLabel} ${action.type} buy failed for agent ${agent.id}:`, tradeErr);
        try {
          await bot.telegram.sendMessage(agent.telegramId, `❌ ${action.type} buy failed\nAmount: ${route.usdc} USDC\nReason: ${reason}`);
        } catch (msgErr) {
          console.error('Failed to notify user of trade failure:', msgErr);
        }
      }
      return;
    }

    // tier2_confirm — prompt only when entering the buy zone
    if (previousSignal === 'buy_xlm') return;
    if (this.pendingTier2ByAgent.get(agent.id) === 'buy_xlm') return;
    this.pendingTier2ByAgent.set(agent.id, 'buy_xlm');
    setPendingTier2Trade(agent.id, { direction: 'buy_xlm', buyUsdc: route.usdc });
    await bot.telegram.sendMessage(
      agent.telegramId,
      `Current xlm price is ${currentPrice} usd, buy ${route.usdc} USDC? (${action.type})\nAmount: ${route.usdc} USDC`,
      { reply_markup: { inline_keyboard: [[
        { text: 'Confirm', callback_data: `confirm_buy:${agent.id}` },
        { text: 'Reject', callback_data: `reject_trade:${agent.id}` },
      ]] } }
    );
  }

  private static async handleSellAction(
    agent: any,
    chainService: ReturnType<typeof ChainFactory.getService>,
    action: Extract<StrategyAction, { direction: 'sell_xlm' }>,
    currentPrice: number,
    previousSignal: PriceSignal
  ) {
    const route = routeSellForAmount(agent, action.amountXlm, currentPrice);
    if (route.kind === 'skip' || route.kind === 'blocked') {
      console.log(`Sell ${route.kind} for agent ${agent.id} (${action.type}): ${route.reason}`);
      return;
    }

    const autoWithoutPrompt =
      route.kind === 'tier1_auto' ||
      (route.kind === 'tier2_confirm' && !agent.requireTradeConfirmation);

    if (autoWithoutPrompt) {
      const sameZone = previousSignal === 'sell_xlm';
      if (sameZone) {
        const lastAuto = this.lastTier1AutoTradeAtByAgent.get(agent.id) ?? 0;
        if (Date.now() - lastAuto < TIER1_SAME_ZONE_COOLDOWN_MS) return;
      }
      const tierLabel = route.kind === 'tier1_auto' ? 'Tier 1' : 'Tier 2 (auto, no confirm)';
      try {
        const txHash = await chainService.executeSwap(decryptAgentSecret(agent), 'sell_xlm', route.xlm);
        await recordSuccessfulSell(agent.id);
        await AgentLog.create({
          agentId: agent._id, telegramId: agent.telegramId, workerAddress: agent.agentAddress,
          eventType: 'trade', status: 'success', token: agent.token,
          amount: `Sell XLM (${route.xlm} XLM) [${action.type}]`, txHash,
        });
        await bot.telegram.sendMessage(
          agent.telegramId,
          `✅ ${tierLabel} ${action.type} sell\nAmount: ${route.xlm} XLM\nXLM price: ${currentPrice} USD\nTx: ${txHash}`
        );
        this.lastTier1AutoTradeAtByAgent.set(agent.id, Date.now());
      } catch (tradeErr) {
        const reason = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
        await AgentLog.create({
          agentId: agent._id, telegramId: agent.telegramId, workerAddress: agent.agentAddress,
          eventType: 'trade', status: 'failure', token: agent.token,
          amount: `Sell XLM (${route.xlm} XLM) [${action.type}]`, reason,
        });
        console.error(`${tierLabel} ${action.type} sell failed for agent ${agent.id}:`, tradeErr);
        try {
          await bot.telegram.sendMessage(agent.telegramId, `❌ ${action.type} sell failed\nAmount: ${route.xlm} XLM\nReason: ${reason}`);
        } catch (msgErr) {
          console.error('Failed to notify user of trade failure:', msgErr);
        }
      }
      return;
    }

    if (previousSignal === 'sell_xlm') return;
    if (this.pendingTier2ByAgent.get(agent.id) === 'sell_xlm') return;
    this.pendingTier2ByAgent.set(agent.id, 'sell_xlm');
    setPendingTier2Trade(agent.id, { direction: 'sell_xlm', sellXlm: route.xlm });
    await bot.telegram.sendMessage(
      agent.telegramId,
      `Current xlm price is ${currentPrice} usd, sell ${route.xlm} XLM? (${action.type})\nAmount: ${route.xlm} XLM`,
      { reply_markup: { inline_keyboard: [[
        { text: 'Confirm', callback_data: `confirm_sell:${agent.id}` },
        { text: 'Reject', callback_data: `reject_trade:${agent.id}` },
      ]] } }
    );
  }

  /** Call when Tier 2 confirm/reject completes so the worker can prompt again if needed. */
  static clearTier2Direction(agentId: string) {
    this.pendingTier2ByAgent.delete(agentId);
  }

  static stopAgentWorker(agentId: string) {
    if (this.activeWorkers.has(agentId)) {
      clearInterval(this.activeWorkers.get(agentId)!);
      this.activeWorkers.delete(agentId);
      this.lastSignalByAgent.delete(agentId);
      this.pendingTier2ByAgent.delete(agentId);
      this.lastTier1AutoTradeAtByAgent.delete(agentId);
      clearPendingTier2Trade(agentId);
    }
  }
}
