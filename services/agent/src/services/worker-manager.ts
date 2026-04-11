import { Agent, AgentLog } from './db';
import { fetchPrice } from './x402-client';
import { ChainFactory } from './chains/chain-factory';
import { evaluateUsdcBalance } from './chains/usdc-balance-eval';
import { bot } from './bot';
import { maybeSendLowBalanceAlert } from './low-balance-alert';
import { TradeDirection } from './chains/types';
import { resetDailySpendIfNeeded } from './daily-spend';
import {
  computePlannedBuyUsdc,
  routeBuy,
  routeSell,
} from './trade-routing';
import { recordSuccessfulBuy, recordSuccessfulSell } from './agent-stats';
import {
  setPendingTier2Trade,
  clearPendingTier2Trade,
} from './pending-tier2';

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

  private static getSignal(agent: any, currentPrice: number): PriceSignal {
    if (currentPrice <= agent.buyBelowUsd) {
      return 'buy_xlm';
    }
    if (currentPrice >= agent.sellAboveUsd) {
      return 'sell_xlm';
    }
    return 'none';
  }

  static async initAllWorkers() {
    const activeAgents = await Agent.find({ active: true });
    for (const agent of activeAgents) {
      this.startAgentWorker(agent);
    }
    console.log(`Started ${activeAgents.length} agent workers`);
  }

  static startAgentWorker(agent: any) {
    if (this.activeWorkers.has(agent.id)) {
      clearInterval(this.activeWorkers.get(agent.id)!);
    }

    const interval = setInterval(async () => {
      try {
        const fresh = await Agent.findById(agent.id);
        if (!fresh || !fresh.active) {
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

        const priceData = await fetchPrice(fresh.agentSecret);
        const currentPrice = parseUsdPriceFromAlert(priceData);
        if (currentPrice === null) {
          console.error(
            `Worker for agent ${fresh.agentAddress}: invalid or missing USD price in alert payload`,
            priceData
          );
          return;
        }
        const signal = this.getSignal(fresh, currentPrice);
        const previousSignal = this.lastSignalByAgent.get(fresh.id) ?? 'none';
        this.lastSignalByAgent.set(fresh.id, signal);

        if (signal === 'none') {
          this.pendingTier2ByAgent.delete(fresh.id);
          clearPendingTier2Trade(fresh.id);
          return;
        }

        const direction: TradeDirection = signal;

        if (direction === 'buy_xlm') {
          await this.handleBuySignal(
            fresh,
            chainService,
            currentPrice,
            previousSignal,
            parseFloat(balances.usdc) || 0
          );
        } else {
          await this.handleSellSignal(
            fresh,
            chainService,
            currentPrice,
            previousSignal
          );
        }
      } catch (error) {
        console.error(`Error in worker for agent ${agent.id}:`, error);
      }
    }, 30000);

    this.activeWorkers.set(agent.id, interval);
  }

  private static async handleBuySignal(
    agent: any,
    chainService: ReturnType<typeof ChainFactory.getService>,
    currentPrice: number,
    previousSignal: PriceSignal,
    usdcBalance: number
  ) {
    const planned = computePlannedBuyUsdc(agent, usdcBalance);
    const route = routeBuy(agent, planned);

    if (route.kind === 'skip') {
      console.log(
        `Buy skipped for agent ${agent.id}: ${route.reason} (planned=${planned.toFixed(4)}, usdcBalance=${usdcBalance})`
      );
      return;
    }
    if (route.kind === 'blocked') {
      console.log(
        `Buy blocked for agent ${agent.id}: ${route.reason} (planned=${planned})`
      );
      return;
    }

    const autoWithoutPrompt =
      route.kind === 'tier1_auto' ||
      (route.kind === 'tier2_confirm' && !agent.requireTradeConfirmation);

    if (autoWithoutPrompt) {
      const sameZone = previousSignal === 'buy_xlm';
      if (sameZone) {
        const lastAuto = this.lastTier1AutoTradeAtByAgent.get(agent.id) ?? 0;
        if (Date.now() - lastAuto < TIER1_SAME_ZONE_COOLDOWN_MS) {
          return;
        }
      }

      const tierLabel =
        route.kind === 'tier1_auto' ? 'Tier 1' : 'Tier 2 (auto, no confirm)';
      console.log(`${tierLabel} buy for ${agent.agentAddress}: ${route.usdc} USDC`);
      const actionLabel = 'Buy XLM';
      try {
        const txHash = await chainService.executeSwap(
          agent.agentSecret,
          'buy_xlm',
          route.usdc
        );
        await recordSuccessfulBuy(agent.id, route.usdcNum);
        await AgentLog.create({
          agentId: agent._id,
          telegramId: agent.telegramId,
          workerAddress: agent.agentAddress,
          eventType: 'trade',
          status: 'success',
          token: agent.token,
          amount: `${actionLabel} (${route.usdc} USDC)`,
          txHash,
        });
        await bot.telegram.sendMessage(
          agent.telegramId,
          `✅ ${tierLabel} trade executed\nAction: ${actionLabel}\nAmount: ${route.usdc} USDC\nCurrent XLM price: ${currentPrice} USD\nTx: ${txHash}`
        );
        this.lastTier1AutoTradeAtByAgent.set(agent.id, Date.now());
      } catch (tradeErr) {
        const reason =
          tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
        await AgentLog.create({
          agentId: agent._id,
          telegramId: agent.telegramId,
          workerAddress: agent.agentAddress,
          eventType: 'trade',
          status: 'failure',
          token: agent.token,
          amount: `${actionLabel} (${route.usdc} USDC)`,
          reason,
        });
        console.error(`${tierLabel} buy failed for agent ${agent.id}:`, tradeErr);
        try {
          await bot.telegram.sendMessage(
            agent.telegramId,
            `❌ ${tierLabel} trade failed\nAction: ${actionLabel}\nAmount: ${route.usdc} USDC\nReason: ${reason}`
          );
        } catch (msgErr) {
          console.error('Failed to notify user of trade failure:', msgErr);
        }
      }
      return;
    }

    // tier2_confirm — prompt only when entering buy zone (not every poll while price stays there)
    if (previousSignal === 'buy_xlm') {
      return;
    }
    const pendingDirection = this.pendingTier2ByAgent.get(agent.id);
    if (pendingDirection === 'buy_xlm') {
      return;
    }
    this.pendingTier2ByAgent.set(agent.id, 'buy_xlm');
    setPendingTier2Trade(agent.id, {
      direction: 'buy_xlm',
      buyUsdc: route.usdc,
    });

    await bot.telegram.sendMessage(
      agent.telegramId,
      `Current xlm price is ${currentPrice} usd, buy ${route.usdc} USDC ?\nAmount: ${route.usdc} USDC`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Confirm',
                callback_data: `confirm_buy:${agent.id}`,
              },
              {
                text: 'Reject',
                callback_data: `reject_trade:${agent.id}`,
              },
            ],
          ],
        },
      }
    );
  }

  private static async handleSellSignal(
    agent: any,
    chainService: ReturnType<typeof ChainFactory.getService>,
    currentPrice: number,
    previousSignal: PriceSignal
  ) {
    const route = routeSell(agent, currentPrice);

    if (route.kind === 'skip') {
      console.log(`Sell skipped for agent ${agent.id}: ${route.reason}`);
      return;
    }
    if (route.kind === 'blocked') {
      console.log(`Sell blocked for agent ${agent.id}: ${route.reason}`);
      return;
    }

    const autoSellWithoutPrompt =
      route.kind === 'tier1_auto' ||
      (route.kind === 'tier2_confirm' && !agent.requireTradeConfirmation);

    if (autoSellWithoutPrompt) {
      const sameZone = previousSignal === 'sell_xlm';
      if (sameZone) {
        const lastAuto = this.lastTier1AutoTradeAtByAgent.get(agent.id) ?? 0;
        if (Date.now() - lastAuto < TIER1_SAME_ZONE_COOLDOWN_MS) {
          return;
        }
      }

      const actionLabel = 'Sell XLM';
      const tierLabel =
        route.kind === 'tier1_auto' ? 'Tier 1' : 'Tier 2 (auto, no confirm)';
      console.log(`${tierLabel} sell for ${agent.agentAddress}: ${route.xlm} XLM`);
      try {
        const txHash = await chainService.executeSwap(
          agent.agentSecret,
          'sell_xlm',
          route.xlm
        );
        await recordSuccessfulSell(agent.id);
        await AgentLog.create({
          agentId: agent._id,
          telegramId: agent.telegramId,
          workerAddress: agent.agentAddress,
          eventType: 'trade',
          status: 'success',
          token: agent.token,
          amount: `${actionLabel} (${route.xlm} XLM)`,
          txHash,
        });
        await bot.telegram.sendMessage(
          agent.telegramId,
          `✅ ${tierLabel} trade executed\nAction: ${actionLabel}\nAmount: ${route.xlm} XLM\nCurrent XLM price: ${currentPrice} USD\nTx: ${txHash}`
        );
        this.lastTier1AutoTradeAtByAgent.set(agent.id, Date.now());
      } catch (tradeErr) {
        const reason =
          tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
        await AgentLog.create({
          agentId: agent._id,
          telegramId: agent.telegramId,
          workerAddress: agent.agentAddress,
          eventType: 'trade',
          status: 'failure',
          token: agent.token,
          amount: `${actionLabel} (${route.xlm} XLM)`,
          reason,
        });
        console.error(`${tierLabel} sell failed for agent ${agent.id}:`, tradeErr);
        try {
          await bot.telegram.sendMessage(
            agent.telegramId,
            `❌ ${tierLabel} trade failed\nAction: ${actionLabel}\nAmount: ${route.xlm} XLM\nReason: ${reason}`
          );
        } catch (msgErr) {
          console.error('Failed to notify user of trade failure:', msgErr);
        }
      }
      return;
    }

    if (previousSignal === 'sell_xlm') {
      return;
    }
    const pendingDirection = this.pendingTier2ByAgent.get(agent.id);
    if (pendingDirection === 'sell_xlm') {
      return;
    }
    this.pendingTier2ByAgent.set(agent.id, 'sell_xlm');
    setPendingTier2Trade(agent.id, {
      direction: 'sell_xlm',
      sellXlm: route.xlm,
    });

    await bot.telegram.sendMessage(
      agent.telegramId,
      `Current xlm price is ${currentPrice} usd, sell ${route.xlm} XLM ?\nAmount: ${route.xlm} XLM`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Confirm',
                callback_data: `confirm_sell:${agent.id}`,
              },
              {
                text: 'Reject',
                callback_data: `reject_trade:${agent.id}`,
              },
            ],
          ],
        },
      }
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
