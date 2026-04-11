import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAgent extends Document {
  telegramId: string;
  agentAddress: string;
  agentSecret: string;
  targetWallet: string;
  chain: string;
  token: string;
  tier1Max: number;
  tier2Max: number;
  buyBelowUsd: number;
  sellAboveUsd: number;
  requireTradeConfirmation: boolean;
  dailyBudget: number;
  buyAmountUsdc: number;
  sellAmountXlm: number;
  spentToday: number;
  lastReset: Date;
  active: boolean;
  /** Lifetime count of successful trades (Tier 1 and confirmed Tier 2). */
  totalSuccessfulTrades: number;
  /** Throttles repeated low-USDC Telegram alerts */
  lastLowBalanceAlertAt?: Date;
}

const AgentSchema: Schema = new Schema({
  telegramId: { type: String, required: true },
  agentAddress: { type: String, required: true },
  agentSecret: { type: String, required: true },
  targetWallet: { type: String, required: true },
  chain: { type: String, default: 'stellar' },
  token: { type: String, default: 'XLM', enum: ['XLM'] },
  tier1Max: { type: Number, default: 0 },
  tier2Max: { type: Number, default: 0 },
  buyBelowUsd: { type: Number, default: 0 },
  sellAboveUsd: { type: Number, default: Number.MAX_SAFE_INTEGER },
  requireTradeConfirmation: { type: Boolean, default: false },
  dailyBudget: { type: Number, default: 0 },
  buyAmountUsdc: { type: Number, default: 1 },
  sellAmountXlm: { type: Number, default: 0.001 },
  spentToday: { type: Number, default: 0 },
  lastReset: { type: Date, default: Date.now },
  active: { type: Boolean, default: true },
  totalSuccessfulTrades: { type: Number, default: 0 },
  lastLowBalanceAlertAt: { type: Date, required: false },
});

AgentSchema.index(
  { telegramId: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);
AgentSchema.index({ agentAddress: 1 });

export const Agent = mongoose.model<IAgent>('Agent', AgentSchema);

export type AgentLogEventType = 'trade';
export type AgentLogStatus = 'success' | 'failure';

export interface IAgentLog extends Document {
  agentId: Types.ObjectId;
  telegramId: string;
  workerAddress: string;
  eventType: AgentLogEventType;
  status: AgentLogStatus;
  token: string;
  amount: string;
  txHash?: string;
  reason?: string;
  createdAt: Date;
}

const AgentLogSchema: Schema = new Schema(
  {
    agentId: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },
    telegramId: { type: String, required: true, index: true },
    workerAddress: { type: String, required: true },
    eventType: {
      type: String,
      enum: ['trade'],
      required: true,
    },
    status: {
      type: String,
      enum: ['success', 'failure'],
      required: true,
    },
    token: { type: String, required: true },
    amount: { type: String, required: true },
    txHash: { type: String, required: false },
    reason: { type: String, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AgentLogSchema.index({ telegramId: 1, createdAt: -1 });
AgentLogSchema.index({ agentId: 1, createdAt: -1 });
AgentLogSchema.index({ workerAddress: 1, createdAt: -1 });

export const AgentLog = mongoose.model<IAgentLog>('AgentLog', AgentLogSchema);

export const connectDB = async (uri: string) => {
  try {
    await mongoose.connect(uri);
    await Agent.syncIndexes();
    await AgentLog.syncIndexes();
    console.log('MongoDB Connected to Atlas');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};
