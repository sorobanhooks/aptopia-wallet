import { Telegraf, Context } from 'telegraf';
import { NotFoundError, StrKey } from 'stellar-sdk';
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
import {
  parseCallback, mainMenuKeyboard, addTypeKeyboard, dcaIntervalKeyboard,
  dcaAmountKeyboard, reviewKeyboard, startAddSession, applyDcaInterval,
  applyDcaAmount, applyTypedPrice, sessionToNewStrategy, reviewText, pricePrompt,
  strategyListText, strategyListKeyboard, presetAccumulatorInputs, type AddSession,
} from './telegram-menu';
import { wouldViolateSingleAccumulate, enabledAccumulateCount } from './strategy-engine';
import type { StrategyConfig, StrategyType } from './strategy-types';

// Rebranded Aptopia bot. Hardcoded and taking precedence over the env var so
// the deploy switches the production bot without server access — the VM's
// gitignored agent/.env still holds the OLD token and the pipeline never
// overwrites it, so an env-first read would keep the old bot. TEMP for the
// demo: move back to process.env.TELEGRAM_BOT_TOKEN and ROTATE before real use.
const botToken = '8753522331:AAFDBhfKaxJkCOu2GvKfhQ8bmrvf-o1zoI0';
export const bot = new Telegraf(botToken);

const addStrategySessions = new Map<string, AddSession>();

function readAgentStrategies(agent: any): StrategyConfig[] {
  const raw = Array.isArray(agent.strategies) ? agent.strategies : [];
  return raw.map((s: any) => ({
    id: String(s._id), type: s.type, role: s.role, enabled: !!s.enabled,
    params: (s.params ?? {}) as Record<string, number>,
    lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
  }));
}

async function findActiveAgent(telegramId: string) {
  return Agent.findOne({ telegramId, active: true });
}

async function renderMainMenu(ctx: any) {
  await ctx.reply('🤖 Your Agent — pick an action:', { reply_markup: { inline_keyboard: mainMenuKeyboard() } });
}

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

const WELCOME_MESSAGE =
  'Welcome to X402 Proxy Agent Bot!\n\nCommands:\n/createagent <target_wallet> - Create agent keys; fund the address, then /createtrustline\n/createtrustline - Add USDC trustline after the agent wallet is funded\n/menu - Open the interactive strategy menu (add DCA, presets, manage strategies)\n/revokeagent - Drain transferable assets to main wallet and disable the agent\n/status - Check your agents\n/agentlog - Recent trade activity';

// Core createagent flow, shared between the /createagent command and the
// `?start=<wallet>` deep link the extension opens. `targetWallet` is the user's
// main/payout wallet; it must be a valid Stellar Ed25519 public key (G...).
async function createAgentForUser(ctx: Context, targetWallet: string) {
  if (!ctx.from?.id) {
    return ctx.reply('Could not determine your Telegram user id.');
  }

  const telegramId = ctx.from.id.toString();
  const token = 'XLM';

  if (!targetWallet) {
    return ctx.reply('Usage: /createagent <target_wallet>');
  }

  if (!StrKey.isValidEd25519PublicKey(targetWallet)) {
    return ctx.reply(
      `That target wallet doesn't look like a valid Stellar address (expected a G... public key):\n${targetWallet}`
    );
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
        `After that run /menu to configure strategies.`,
      ].join('\n')
    );
  } catch (error) {
    console.error('Failed to create agent:', error);
    ctx.reply('❌ Failed to create agent. Check console for details.');
  }
}

bot.start(async (ctx) => {
  // The extension's "Open Telegram" button opens t.me/<bot>?start=<wallet>,
  // which Telegram delivers here as ctx.startPayload. If it's a valid Stellar
  // address, kick off agent creation straight away; otherwise show the menu.
  const payload = ctx.startPayload?.trim();
  if (payload && StrKey.isValidEd25519PublicKey(payload)) {
    return createAgentForUser(ctx, payload);
  }
  const existing = await findActiveAgent(ctx.from!.id.toString());
  if (existing) return renderMainMenu(ctx);
  return ctx.reply(WELCOME_MESSAGE);
});

bot.command('createagent', async (ctx) => {
  const [targetWallet] = ctx.message.text.split(' ').slice(1);
  return createAgentForUser(ctx, targetWallet);
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
        `USDC trustline is already set up for:\n${agent.agentAddress}\nRun /menu to configure strategies.`
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
      `✅ USDC trustline added for:\n${agent.agentAddress}\n\nRun /menu to configure strategies. Trading worker is enabled.`
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
        : 'Today USDC spend: (set daily limit via /menu)';
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

bot.command('menu', async (ctx) => {
  if (!ctx.from?.id) return ctx.reply('Could not determine your Telegram user id.');
  const agent = await findActiveAgent(ctx.from.id.toString());
  if (!agent) return ctx.reply('No active agent yet. Use /createagent <target_wallet> first.');
  return renderMainMenu(ctx);
});

bot.command('setrules', async (ctx) => {
  if (!ctx.from?.id) return ctx.reply('Could not determine your Telegram user id.');
  const agent = await findActiveAgent(ctx.from.id.toString());
  if (!agent) return ctx.reply('Please create an active agent first using /createagent.');
  await ctx.reply('Setup is button-driven now 🎉');
  return renderMainMenu(ctx);
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
    const { transfers, skipped } = await revokeAgentWallet(agent);
    const transferredSummary =
      transfers.length > 0
        ? transfers.map((t) => `${t.amount} ${t.token}`).join(', ')
        : 'nothing (no transferable balances)';
    let message = `✅ Revoked.\nTransferred ${transferredSummary} → your main wallet\nAgent wallet disabled.`;
    if (skipped.length > 0) {
      const skippedSummary = skipped
        .map((s) => `${s.amount} ${s.token} (${s.reason})`)
        .join('; ');
      message += `\n⚠️ Could not return: ${skippedSummary}.\nAdd a trustline for that asset on your main wallet, then I can return it.`;
    }
    message += `\nUse /createagent to set up a new agent wallet anytime.`;
    await ctx.reply(message);
  } catch (e) {
    console.error('revokeagent failed:', e);
    ctx.reply(
      `❌ Revoke failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
});

bot.on('text', async (ctx, next) => {
  if (!ctx.from?.id) return next();
  const telegramId = ctx.from.id.toString();
  const session = addStrategySessions.get(telegramId);
  if (!session) return next();

  const text = ctx.message.text.trim();
  if (text.startsWith('/')) {
    return ctx.reply('Finish the current strategy first, or tap ✖︎ Cancel on the review card.');
  }

  // The only typed step is the price for dip_buy / take_profit / stop_loss.
  if (session.step === 'price') {
    const price = parsePositiveNumber(text);
    if (price === null) return ctx.reply('Please enter a valid positive USD price (e.g. 0.10).');
    const next2 = applyTypedPrice(session, price);
    addStrategySessions.set(telegramId, next2);
    return ctx.reply(reviewText(next2), { reply_markup: { inline_keyboard: reviewKeyboard() } });
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

// ---------------------------------------------------------------------------
// Tier-2 trade confirm/reject — body moved verbatim from the old callback_query
// handler. Uses action and agentId passed in by the dispatcher rather than
// re-splitting ctx.callbackQuery.data.
// ---------------------------------------------------------------------------
async function handleTradeConfirmCallback(ctx: any, action: string, agentId: string) {
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
}

// ---------------------------------------------------------------------------
// Menu handler — routes sub-actions from the main menu keyboard
// ---------------------------------------------------------------------------
async function handleMenu(ctx: any, which?: string) {
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent. Use /createagent first.');

  if (which === 'strategies') {
    const strategies = readAgentStrategies(agent);
    return ctx.reply(strategyListText(strategies), { reply_markup: { inline_keyboard: strategyListKeyboard(strategies) } });
  }
  if (which === 'add') {
    return ctx.reply('Pick a strategy to add:', { reply_markup: { inline_keyboard: addTypeKeyboard() } });
  }
  if (which === 'limits') {
    return ctx.reply(`Limits & Safety:\nTier-1 (auto) max: $${agent.tier1Max}\nTier-2 (confirm) max: $${agent.tier2Max}\nDaily USDC cap: $${agent.dailyBudget}\n\n(Edit limits in the extension's Agent Configuration.)`, { reply_markup: { inline_keyboard: [[{ text: '⬅︎ Menu', callback_data: 'menu:main' }]] } });
  }
  if (which === 'status') {
    return ctx.reply(`Daily USDC: ${agent.spentToday.toFixed(4)} / ${agent.dailyBudget > 0 ? agent.dailyBudget.toFixed(2) : '—'} · Lifetime trades: ${agent.totalSuccessfulTrades ?? 0} · Strategies: ${enabledAccumulateCount(readAgentStrategies(agent))} accumulate enabled`, { reply_markup: { inline_keyboard: [[{ text: '⬅︎ Menu', callback_data: 'menu:main' }]] } });
  }
  return renderMainMenu(ctx);
}

// ---------------------------------------------------------------------------
// Add-Strategy wizard handlers
// ---------------------------------------------------------------------------
async function handleAddType(ctx: any, type: StrategyType) {
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent. Use /createagent first.');

  const session = startAddSession(type);
  addStrategySessions.set(telegramId, session);

  if (type === 'dca') {
    return ctx.reply('How often should I buy?', { reply_markup: { inline_keyboard: dcaIntervalKeyboard() } });
  }
  // sell/dip → ask for the typed price (handled by bot.on('text'))
  return ctx.reply(pricePrompt(type));
}

async function handleDcaInterval(ctx: any, minutes: number) {
  const telegramId = ctx.from.id.toString();
  const session = addStrategySessions.get(telegramId);
  if (!session || session.type !== 'dca') return ctx.reply('Start again with ➕ Add Strategy.');
  const next = applyDcaInterval(session, minutes);
  addStrategySessions.set(telegramId, next);
  return ctx.reply('How much per buy?', { reply_markup: { inline_keyboard: dcaAmountKeyboard() } });
}

async function handleDcaAmount(ctx: any, usdc: number) {
  const telegramId = ctx.from.id.toString();
  const session = addStrategySessions.get(telegramId);
  if (!session || session.type !== 'dca') return ctx.reply('Start again with ➕ Add Strategy.');
  const next = applyDcaAmount(session, usdc);
  addStrategySessions.set(telegramId, next);
  return ctx.reply(reviewText(next), { reply_markup: { inline_keyboard: reviewKeyboard() } });
}

async function handleReview(ctx: any, decision?: string) {
  const telegramId = ctx.from.id.toString();
  const session = addStrategySessions.get(telegramId);
  if (!session) return ctx.reply('Nothing to review. Tap ➕ Add Strategy.');

  if (decision === 'cancel') {
    addStrategySessions.delete(telegramId);
    return ctx.reply('Cancelled.', { reply_markup: { inline_keyboard: mainMenuKeyboard() } });
  }
  // activate
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent. Use /createagent first.');
  const input = sessionToNewStrategy(session);

  // Enforce single-accumulate: auto-switch — disable any other enabled accumulate.
  if (input.role === 'accumulate' && input.enabled) {
    if (wouldViolateSingleAccumulate(readAgentStrategies(agent), { role: 'accumulate', enabled: true })) {
      for (const s of (agent as any).strategies) {
        if (s.enabled && s.role === 'accumulate') s.enabled = false;
      }
    }
  }
  (agent as any).strategies.push(input);
  await agent.save();
  addStrategySessions.delete(telegramId);
  if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);

  return ctx.reply(`✅ Activated.\n${reviewText(session)}`, { reply_markup: { inline_keyboard: mainMenuKeyboard() } });
}

// ---------------------------------------------------------------------------
// My-Strategies management handlers
// ---------------------------------------------------------------------------
async function handleToggle(ctx: any, strategyId: string) {
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent.');
  const sub = (agent as any).strategies.id(strategyId);
  if (!sub) return ctx.reply('Strategy not found.');

  const willEnable = !sub.enabled;
  if (willEnable && sub.role === 'accumulate') {
    // auto-switch: disable other enabled accumulate strategies
    for (const s of (agent as any).strategies) {
      if (String(s._id) !== strategyId && s.enabled && s.role === 'accumulate') s.enabled = false;
    }
  }
  sub.enabled = willEnable;
  await agent.save();
  if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);

  const strategies = readAgentStrategies(agent);
  return ctx.reply(strategyListText(strategies), { reply_markup: { inline_keyboard: strategyListKeyboard(strategies) } });
}

async function handleRemove(ctx: any, strategyId: string) {
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent.');
  const sub = (agent as any).strategies.id(strategyId);
  if (!sub) return ctx.reply('Strategy not found.');
  sub.deleteOne();
  await agent.save();
  if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);

  const strategies = readAgentStrategies(agent);
  return ctx.reply(`Removed.\n\n${strategyListText(strategies)}`, { reply_markup: { inline_keyboard: strategyListKeyboard(strategies) } });
}

// ---------------------------------------------------------------------------
// Accumulator preset handler
// ---------------------------------------------------------------------------
async function handlePreset(ctx: any, name?: string) {
  if (name !== 'accumulator') return ctx.reply('Unknown preset.');
  const telegramId = ctx.from.id.toString();
  const agent = await findActiveAgent(telegramId);
  if (!agent) return ctx.reply('No active agent. Use /createagent first.');

  // Replace any existing enabled accumulate to honor the single-accumulate rule.
  for (const s of (agent as any).strategies) {
    if (s.enabled && s.role === 'accumulate') s.enabled = false;
  }
  for (const input of presetAccumulatorInputs()) {
    (agent as any).strategies.push(input);
  }
  await agent.save();
  if (agent.active && agent.usdcTrustlineReady !== false) WorkerManager.startAgentWorker(agent);

  const strategies = readAgentStrategies(agent);
  return ctx.reply(`⚡ Accumulator activated:\n${strategyListText(strategies)}`, { reply_markup: { inline_keyboard: strategyListKeyboard(strategies) } });
}

// ---------------------------------------------------------------------------
// Unified callback_query dispatcher
// ---------------------------------------------------------------------------
bot.on('callback_query', async (ctx: any) => {
  const data: string = ctx.callbackQuery?.data ?? '';
  const { action, arg } = parseCallback(data);

  // Preserve the existing trade-confirm behavior.
  if (action === 'confirm_buy' || action === 'confirm_sell' || action === 'reject_trade') {
    return handleTradeConfirmCallback(ctx, action, arg ?? '');
  }

  await ctx.answerCbQuery().catch(() => {});
  try {
    switch (action) {
      case 'menu': return await handleMenu(ctx, arg);
      case 'add': return await handleAddType(ctx, arg as StrategyType);
      case 'dca_int': return await handleDcaInterval(ctx, Number(arg));
      case 'dca_amt': return await handleDcaAmount(ctx, Number(arg));
      case 'review': return await handleReview(ctx, arg);
      case 'strat_toggle': return await handleToggle(ctx, arg ?? '');
      case 'strat_remove': return await handleRemove(ctx, arg ?? '');
      case 'preset': return await handlePreset(ctx, arg);
      default: return;
    }
  } catch (e) {
    console.error('callback dispatch error:', e);
    try { await ctx.reply('Something went wrong. Try /menu again.'); } catch {}
  }
});
