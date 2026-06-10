import { Telegraf } from 'telegraf';
import { NotFoundError } from 'stellar-sdk';
import { Agent, AgentLog } from './db';
import { ChainFactory } from './chains/chain-factory';
import { encryptAgentSecret, decryptAgentSecret } from './agent-secret-crypto';
import { WorkerManager } from './worker-manager';
import { formatAgentLogLineTime } from '../utils/agent-log-display';
import { TradeDirection } from './chains/types';
import {
  getPendingTier2Trade,
  clearPendingTier2Trade,
} from './pending-tier2';
import { recordSuccessfulBuy, recordSuccessfulSell } from './agent-stats';
import { resetDailySpendIfNeeded } from './daily-spend';
import { revokeAgentWallet } from './revoke-agent';

const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
export const bot = new Telegraf(botToken);

type SetRulesSession = {
  agentId: string;
  step:
    | 'buy'
    | 'sell'
    | 'tier1_max'
    | 'tier2_max'
    | 'daily_limit'
    | 'sell_amount_xlm'
    | 'buy_amount_usdc';
  buyBelowUsd?: number;
  sellAboveUsd?: number;
  tier1Max?: number;
  tier2Max?: number;
  dailyBudget?: number;
  sellAmountXlm?: number;
  buyAmountUsdc?: number;
};

const setRulesSessions = new Map<string, SetRulesSession>();

function parsePositiveNumber(input: string): number | null {
  const parsed = Number(input.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function getTradeActionLabel(direction: TradeDirection): string {
  return direction === 'buy_xlm' ? 'Buy XLM' : 'Sell XLM';
}

function stellarNetworkLabel(): string {
  const n = process.env.NETWORK || 'stellar:testnet';
  return n === 'stellar:pubnet' ? 'Stellar public (mainnet)' : 'Stellar testnet';
}

function horizonFailedTxExtras(error: unknown): unknown {
  const e = error as {
    response?: { data?: { extras?: unknown } };
    getResponse?: () => { data?: { extras?: unknown } };
  };
  return (
    e?.response?.data?.extras ??
    (typeof e?.getResponse === 'function' ? e.getResponse()?.data?.extras : undefined)
  );
}

function horizonOperationResultCodes(extras: unknown): string[] {
  if (!extras || typeof extras !== 'object') return [];
  const ops = (extras as { result_codes?: { operations?: unknown } }).result_codes?.operations;
  if (Array.isArray(ops)) return ops.filter((x): x is string => typeof x === 'string');
  if (typeof ops === 'string') return [ops];
  return [];
}

function formatTrustlineSetupError(error: unknown, agentAddress: string): string {
  if (error instanceof NotFoundError) {
    return `This address is not on the network yet. Fund the agent wallet with XLM first:\n${agentAddress}`;
  }

  const opCodes = horizonOperationResultCodes(horizonFailedTxExtras(error));
  if (opCodes.length > 0) {
    if (opCodes.some((c) => c === 'op_underfunded')) {
      return 'Not enough XLM for fees or reserve. Send more XLM (typically ~2+ XLM before /createtrustline on mainnet), then retry.';
    }
    if (opCodes.some((c) => c === 'op_low_reserve')) {
      return 'Insufficient reserve for adding a trustline (after the change, minimum balance rises). Send more XLM to the agent address (often ~2+ XLM total on mainnet) and retry.';
    }
  }

  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatAssetBalances(assets?: Record<string, string>): string {
  if (!assets || Object.keys(assets).length === 0) {
    return 'Balances:\n- unavailable';
  }

  const lines = Object.entries(assets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tokenId, amount]) => `- ${tokenId}: ${amount}`);

  return `Balances:\n${lines.join('\n')}`;
}

bot.start((ctx) => {
  ctx.reply(
    'Welcome to X402 Proxy Agent Bot!\n\nCommands:\n/createagent <target_wallet> - Create agent keys; fund the address, then /createtrustline\n/createtrustline - Add USDC trustline after the agent wallet is funded\n/setrules - Configure buy/sell thresholds, tier limits, daily USDC spend cap, and per-trade amounts\n/revokeagent - Drain transferable assets to main wallet and disable the agent\n/status - Check your agents\n/agentlog - Recent trade activity'
  );
});

bot.command('createagent', async (ctx) => {
  if (!ctx.from?.id) {
    return ctx.reply('Could not determine your Telegram user id.');
  }

  const telegramId = ctx.from.id.toString();
  const [targetWallet] = ctx.message.text.split(' ').slice(1);
  const token = 'XLM';

  if (!targetWallet) {
    return ctx.reply('Usage: /createagent <target_wallet>');
  }

  try {
    const activeAgent = await Agent.findOne({ telegramId, active: true });
    if (activeAgent) {
      return ctx.reply(
        'You already have an active agent wallet. Revoke it first with /revokeagent before creating a new agent wallet.'
      );
    }

    const chainService = ChainFactory.getService('stellar');
    const { address, secret } = await chainService.createAgentWallet();
    const encryptedSecret = encryptAgentSecret(secret);

    await Agent.create({
      telegramId,
      agentAddress: address,
      ...encryptedSecret,
      targetWallet,
      token,
      active: true,
      usdcTrustlineReady: false,
      tier1Max: 0,
      tier2Max: 0,
      buyBelowUsd: 0,
      sellAboveUsd: Number.MAX_SAFE_INTEGER,
      requireTradeConfirmation: false,
      dailyBudget: 0,
      buyAmountUsdc: 1,
      sellAmountXlm: 0.001,
      spentToday: 0,
      totalSuccessfulTrades: 0,
    });

    const network = stellarNetworkLabel();
    ctx.reply(
      [
        `✅ Agent wallet created (pending funding).`,
        '',
        `Network: ${network}`,
        `Fund this agent address with enough XLM (mainnet typically ~2 XLM minimum so that after adding a USDC trustline reserves + fee remain covered):`,
        address,
        '',
        `Payout / main wallet (target): ${targetWallet}`,
        '',
        `Next: send XLM to the agent address above, then run /createtrustline`,
        `After that run /setrules to configure trading limits.`,
      ].join('\n')
    );
  } catch (error) {
    console.error('Failed to create agent:', error);
    ctx.reply('❌ Failed to create agent. Check console for details.');
  }
});

bot.command('createtrustline', async (ctx) => {
  if (!ctx.from?.id) {
    return ctx.reply('Could not determine your Telegram user id.');
  }

  const telegramId = ctx.from.id.toString();

  try {
    const agent = await Agent.findOne({ telegramId, active: true });
    if (!agent) {
      return ctx.reply('No active agent. Create one with /createagent <target_wallet> first.');
    }

    if (agent.usdcTrustlineReady === true) {
      return ctx.reply(
        `USDC trustline is already set up for:\n${agent.agentAddress}\nRun /setrules if you still need to configure trading limits.`
      );
    }

    const chainService = ChainFactory.getService(agent.chain || 'stellar');
    await chainService.setupAgent(decryptAgentSecret(agent));

    const updated = await Agent.findByIdAndUpdate(
      agent._id,
      { $set: { usdcTrustlineReady: true } },
      { new: true }
    );

    if (updated?.active) {
      WorkerManager.startAgentWorker(updated);
    }

    return ctx.reply(
      `✅ USDC trustline added for:\n${agent.agentAddress}\n\nRun /setrules to configure limits. Trading worker is enabled.`
    );
  } catch (error) {
    console.error('createtrustline failed:', error);
    const fallbackAgent = await Agent.findOne({ telegramId, active: true });
    const addr = fallbackAgent?.agentAddress ?? '(unknown)';
    ctx.reply(`❌ Could not create USDC trustline.\n${formatTrustlineSetupError(error, addr)}`);
  }
});

bot.command('status', async (ctx) => {
  if (!ctx.from?.id) {
    return ctx.reply('Could not determine your Telegram user id.');
  }
  const agents = await Agent.find({ telegramId: ctx.from.id.toString() }).sort({
    active: -1,
    _id: -1,
  });
  if (agents.length === 0) {
    return ctx.reply('You have no agents.');
  }

  const lines: string[] = [];
  for (const a of agents) {
    await resetDailySpendIfNeeded(a);
    const chainService = ChainFactory.getService(a.chain || 'stellar');
    const balances = await chainService.getBalance(a.agentAddress);
    const balancesText = formatAssetBalances(balances.assets);
    const spendLine =
      a.dailyBudget > 0
        ? `Today USDC spend: ${a.spentToday.toFixed(4)} / ${a.dailyBudget.toFixed(2)} (limit)`
        : 'Today USDC spend: (set daily limit via /setrules)';
    const trustLine =
      a.usdcTrustlineReady === false
        ? 'USDC trustline: pending — fund agent, then /createtrustline'
        : 'USDC trustline: ready';
    lines.push(
      `🤖 Agent: ${a.agentAddress.slice(0, 6)}...${a.agentAddress.slice(-4)}\nToken: XLM\nTarget: ${a.targetWallet.slice(0, 6)}...\nStatus: ${a.active ? '✅ Active' : '❌ Disabled'}\n${trustLine}\n${balancesText}\n${spendLine}\nSuccessful trades (lifetime): ${a.totalSuccessfulTrades ?? 0}`
    );
  }

  ctx.reply(lines.join('\n\n'));
});

bot.command('setrules', async (ctx) => {
  if (!ctx.from?.id) {
    return ctx.reply('Could not determine your Telegram user id.');
  }
  const telegramId = ctx.from.id.toString();
  const agent = await Agent.findOne({ telegramId, active: true });
  if (!agent) {
    return ctx.reply('Please create an active agent first using /createagent.');
  }

  setRulesSessions.set(telegramId, {
    agentId: agent.id,
    step: 'buy',
  });

  return ctx.reply("What's the price in usd below which we should buy xlm?");
});

bot.command('revokeagent', async (ctx) => {
  if (!ctx.from?.id) {
    return ctx.reply('Could not determine your Telegram user id.');
  }
  const agent = await Agent.findOne({
    telegramId: ctx.from.id.toString(),
    active: true,
  });
  if (!agent) {
    return ctx.reply('No active agent wallet found.');
  }

  try {
    const { transfers } = await revokeAgentWallet(agent);
    const transferredSummary =
      transfers.length > 0
        ? transfers.map((t) => `${t.amount} ${t.token}`).join(', ')
        : 'nothing (no transferable balances)';
    await ctx.reply(
      `✅ Revoked.\nTransferred ${transferredSummary} → your main wallet\nAgent wallet disabled.\nUse /createagent to set up a new agent wallet anytime.`
    );
  } catch (e) {
    console.error('revokeagent failed:', e);
    ctx.reply(
      `❌ Revoke failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
});

bot.on('text', async (ctx, next) => {
  if (!ctx.from?.id) {
    return next();
  }

  const telegramId = ctx.from.id.toString();
  const session = setRulesSessions.get(telegramId);
  if (!session) {
    return next();
  }

  const text = ctx.message.text.trim();
  if (text.startsWith('/')) {
    return ctx.reply('Please finish /setrules first by entering the requested number.');
  }

  if (session.step === 'buy') {
    const buyBelowUsd = parsePositiveNumber(text);
    if (buyBelowUsd === null) {
      return ctx.reply("Please enter a valid positive number. What's the price in usd below which we should buy xlm?");
    }

    session.buyBelowUsd = buyBelowUsd;
    session.step = 'sell';
    setRulesSessions.set(telegramId, session);
    return ctx.reply("What's the price in usd above which we should sell xlm ?");
  }

  if (session.step === 'sell') {
    const sellAboveUsd = parsePositiveNumber(text);
    if (sellAboveUsd === null) {
      return ctx.reply("Please enter a valid positive number. What's the price in usd above which we should sell xlm ?");
    }
    if (!session.buyBelowUsd || sellAboveUsd <= session.buyBelowUsd) {
      return ctx.reply('Sell price must be greater than buy price. Please enter a valid sell-above USD value.');
    }

    session.sellAboveUsd = sellAboveUsd;
    session.step = 'tier1_max';
    setRulesSessions.set(telegramId, session);
    return ctx.reply(
      "What's the maximum trade size in USD for Tier 1 (executed automatically without asking)?"
    );
  }

  if (session.step === 'tier1_max') {
    const tier1 = parsePositiveNumber(text);
    if (tier1 === null) {
      return ctx.reply(
        'Please enter a valid positive number for the Tier 1 max trade size in USD.'
      );
    }
    session.tier1Max = tier1;
    session.step = 'tier2_max';
    setRulesSessions.set(telegramId, session);
    return ctx.reply(
      "What's the maximum trade size in USD for Tier 2 (you confirm each trade in Telegram)? Must be greater than Tier 1."
    );
  }

  if (session.step === 'tier2_max') {
    const tier2 = parsePositiveNumber(text);
    if (tier2 === null) {
      return ctx.reply(
        'Please enter a valid positive number for the Tier 2 max trade size in USD.'
      );
    }
    if (!session.tier1Max || tier2 <= session.tier1Max) {
      return ctx.reply(
        'Tier 2 max must be strictly greater than Tier 1 max. Enter a larger USD amount.'
      );
    }
    session.tier2Max = tier2;
    session.step = 'daily_limit';
    setRulesSessions.set(telegramId, session);
    return ctx.reply(
      'What is the daily limit the agent can spend in USD? (USDC spend on buys only.)'
    );
  }

  if (session.step === 'daily_limit') {
    const daily = parsePositiveNumber(text);
    if (daily === null) {
      return ctx.reply(
        'Please enter a valid positive number for the daily USDC spend limit.'
      );
    }

    if (
      session.buyBelowUsd === undefined ||
      session.sellAboveUsd === undefined ||
      session.tier1Max === undefined ||
      session.tier2Max === undefined
    ) {
      setRulesSessions.delete(telegramId);
      return ctx.reply('Session incomplete. Please run /setrules again.');
    }

    session.dailyBudget = daily;
    session.step = 'sell_amount_xlm';
    setRulesSessions.set(telegramId, session);
    return ctx.reply('What is the sell amount of xlm per trade?');
  }

  if (session.step === 'sell_amount_xlm') {
    const sellAmountXlm = parsePositiveNumber(text);
    if (sellAmountXlm === null) {
      return ctx.reply('Please enter a valid positive number. What is the sell amount of xlm ?');
    }
    session.sellAmountXlm = sellAmountXlm;
    session.step = 'buy_amount_usdc';
    setRulesSessions.set(telegramId, session);
    return ctx.reply('What is the buy amount of usdc per trade?');
  }

  if (session.step === 'buy_amount_usdc') {
    const buyAmountUsdc = parsePositiveNumber(text);
    if (buyAmountUsdc === null) {
      return ctx.reply('Please enter a valid positive number. What is the buy amount of usdc?');
    }

    if (
      session.buyBelowUsd === undefined ||
      session.sellAboveUsd === undefined ||
      session.tier1Max === undefined ||
      session.tier2Max === undefined ||
      session.dailyBudget === undefined ||
      session.sellAmountXlm === undefined
    ) {
      setRulesSessions.delete(telegramId);
      return ctx.reply('Session incomplete. Please run /setrules again.');
    }

    session.buyAmountUsdc = buyAmountUsdc;
    const now = new Date();
    const updatedAgent = await Agent.findByIdAndUpdate(
      session.agentId,
      {
        $set: {
          buyBelowUsd: session.buyBelowUsd,
          sellAboveUsd: session.sellAboveUsd,
          tier1Max: session.tier1Max,
          tier2Max: session.tier2Max,
          dailyBudget: session.dailyBudget,
          sellAmountXlm: session.sellAmountXlm,
          buyAmountUsdc: session.buyAmountUsdc,
          spentToday: 0,
          lastReset: now,
          requireTradeConfirmation: false,
        },
      },
      { new: true }
    );

    setRulesSessions.delete(telegramId);

    if (updatedAgent?.active && updatedAgent.usdcTrustlineReady !== false) {
      WorkerManager.startAgentWorker(updatedAgent);
    }

    return ctx.reply(
      `✅ Rules updated.\nBuy below: ${session.buyBelowUsd} USD\nSell above: ${session.sellAboveUsd} USD\nTier 1 (auto) max: ${session.tier1Max} USD per trade\nTier 2 (confirm) max: ${session.tier2Max} USD per trade\nDaily USDC spend limit: ${session.dailyBudget} USD\nSell amount: ${session.sellAmountXlm} XLM per trade\nBuy amount: ${session.buyAmountUsdc} USDC per trade${updatedAgent?.usdcTrustlineReady === false ? '\n\nNote: run /createtrustline after funding so the worker can trade.' : ''}`
    );
  }

  return next();
});

bot.command('agentlog', async (ctx) => {
  if (!ctx.from?.id) {
    return ctx.reply('Could not determine your Telegram user id.');
  }
  const telegramId = ctx.from.id.toString();
  const agent = await Agent.findOne({ telegramId, active: true });
  if (agent) {
    await resetDailySpendIfNeeded(agent);
  }

  const logs = await AgentLog.find({ telegramId })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  if (logs.length === 0) {
    const footer = agent
      ? `\n\nToday USDC: ${agent.spentToday.toFixed(4)} / ${agent.dailyBudget > 0 ? `${agent.dailyBudget.toFixed(2)} limit` : '—'} | Trades (lifetime): ${agent.totalSuccessfulTrades ?? 0}`
      : '';
    return ctx.reply(`No trade logs yet.${footer}`);
  }

  const lines = logs.map((log: any, idx: number) => {
    const rank = idx + 1;
    const timeStr = formatAgentLogLineTime(new Date(log.createdAt));
    if (log.status === 'success') {
      const txRef =
        log.txHash && log.txHash.length > 0
          ? ` — tx: ${log.txHash}`
          : '';
      return `${rank}. [${timeStr}] ${log.amount}${txRef}`;
    }
    const reason = log.reason ? ` (${log.reason})` : '';
    return `${rank}. [${timeStr}] Trade failed — ${log.amount}${reason}`;
  });

  const footer = agent
    ? `\n\nToday USDC: ${agent.spentToday.toFixed(4)} / ${agent.dailyBudget > 0 ? `${agent.dailyBudget.toFixed(2)} limit` : '—'} | Trades (lifetime): ${agent.totalSuccessfulTrades ?? 0}`
    : '';

  ctx.reply(
    `Last ${logs.length} trade action(s):\n\n${lines.join('\n')}${footer}`
  );
});

bot.on('callback_query', async (ctx: any) => {
  const [action, agentId] = ctx.callbackQuery.data.split(':');

  if (action === 'confirm_buy' || action === 'confirm_sell') {
    await ctx.answerCbQuery().catch(() => {});

    const agent = await Agent.findById(agentId);
    if (!agent) return ctx.reply('Agent not found.');
    if (!agent.active) {
      return ctx.reply('Agent wallet is disabled.');
    }

    const direction: TradeDirection =
      action === 'confirm_buy' ? 'buy_xlm' : 'sell_xlm';
    const pending = getPendingTier2Trade(agentId);
    if (!pending || pending.direction !== direction) {
      return ctx.reply('This trade confirmation is no longer valid.');
    }

    const chainService = ChainFactory.getService(agent.chain || 'stellar');

    if (direction === 'buy_xlm') {
      const amount = pending.buyUsdc;
      if (!amount) {
        // C1: claim synchronously before any await
        WorkerManager.clearTier2Direction(agentId);
        clearPendingTier2Trade(agentId);
        return ctx.reply('Missing buy amount; please wait for a new prompt.');
      }
      // C1: CLAIM — clear the pending slot BEFORE the async swap so a concurrent
      //     HTTP confirm in the same event-loop window cannot double-execute.
      const capturedAmount = amount;
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
          agentId: agent._id,
          telegramId: agent.telegramId,
          workerAddress: agent.agentAddress,
          eventType: 'trade',
          status: 'success',
          token: agent.token,
          amount: `${getTradeActionLabel(direction)} (${capturedAmount} USDC)`,
          txHash,
        });
        ctx.reply(
          `✅ ${getTradeActionLabel(direction)} confirmed and executed.\nAmount: ${capturedAmount} USDC\nTx: ${txHash}`
        );
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        await AgentLog.create({
          agentId: agent._id,
          telegramId: agent.telegramId,
          workerAddress: agent.agentAddress,
          eventType: 'trade',
          status: 'failure',
          token: agent.token,
          amount: `${getTradeActionLabel(direction)} (${capturedAmount} USDC)`,
          reason,
        });
        ctx.reply(`❌ Trade failed.\nAmount: ${capturedAmount} USDC\nReason: ${reason}`);
      }
    } else {
      const amount = pending.sellXlm;
      if (!amount) {
        // C1: claim synchronously before any await
        WorkerManager.clearTier2Direction(agentId);
        clearPendingTier2Trade(agentId);
        return ctx.reply('Missing sell amount; please wait for a new prompt.');
      }
      // C1: CLAIM — clear the pending slot BEFORE the async swap
      const capturedAmount = amount;
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
          agentId: agent._id,
          telegramId: agent.telegramId,
          workerAddress: agent.agentAddress,
          eventType: 'trade',
          status: 'success',
          token: agent.token,
          amount: `${getTradeActionLabel(direction)} (${capturedAmount} XLM)`,
          txHash,
        });
        ctx.reply(
          `✅ ${getTradeActionLabel(direction)} confirmed and executed.\nAmount: ${capturedAmount} XLM\nTx: ${txHash}`
        );
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        await AgentLog.create({
          agentId: agent._id,
          telegramId: agent.telegramId,
          workerAddress: agent.agentAddress,
          eventType: 'trade',
          status: 'failure',
          token: agent.token,
          amount: `${getTradeActionLabel(direction)} (${capturedAmount} XLM)`,
          reason,
        });
        ctx.reply(`❌ Trade failed.\nAmount: ${capturedAmount} XLM\nReason: ${reason}`);
      }
    }
  } else if (action === 'reject_trade') {
    await ctx.answerCbQuery().catch(() => {});
    clearPendingTier2Trade(agentId);
    WorkerManager.clearTier2Direction(agentId);
    ctx.reply('❌ Trade rejected.');
  }
});
