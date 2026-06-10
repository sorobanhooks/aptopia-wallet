import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAgent extends Document {
  telegramId: string;
  agentAddress: string;
  /** Envelope-encrypted secret (AES-256-GCM). Use decryptAgentSecret() to read. */
  agentSecretCiphertext: string;
  /** Base64 12-byte IV for agentSecretCiphertext. */
  agentSecretIv: string;
  /** Base64 AES-256-GCM-wrapped DEK (wrapped by AGENT_SECRET_KEK_BASE64). */
  agentSecretDekWrapped: string;
  /** Base64 12-byte IV for the DEK wrap. */
  agentSecretDekIv: string;
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
  /**
   * `false`: agent created but USDC trustline not created yet (/createtrustline).
   * Omitted/`true`: polling worker allowed (legacy agents omit this field).
   */
  usdcTrustlineReady?: boolean;
  /**
   * Write-through cache for the AI rule explanation.
   * Keyed by `hash` (SHA-256 hex of the 5 rule fields). Invalidated whenever
   * the hash of the current rules differs from the stored hash.
   */
  rulesExplanation?: {
    hash: string;
    text: string;
  };
}

const AgentSchema: Schema = new Schema({
  telegramId: { type: String, required: true },
  agentAddress: { type: String, required: true },
  agentSecretCiphertext: { type: String, required: true },
  agentSecretIv: { type: String, required: true },
  agentSecretDekWrapped: { type: String, required: true },
  agentSecretDekIv: { type: String, required: true },
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
  usdcTrustlineReady: { type: Boolean, required: false },
  rulesExplanation: {
    type: new Schema(
      {
        hash: { type: String, required: true },
        text: { type: String, required: true },
      },
      { _id: false }
    ),
    required: false,
  },
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
  /** AI-generated plain-English narration of the trade (write-through Mongo cache). */
  narration?: string;
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
    narration: { type: String, required: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AgentLogSchema.index({ telegramId: 1, createdAt: -1 });
AgentLogSchema.index({ agentId: 1, createdAt: -1 });
AgentLogSchema.index({ workerAddress: 1, createdAt: -1 });

export const AgentLog = mongoose.model<IAgentLog>('AgentLog', AgentLogSchema);

export interface IContractSummary extends Document {
  network: 'mainnet' | 'testnet';
  contract: string;
  wasmDigest: string;
  summary: {
    overview: string;
    keyPoints: string[];
    exposedFunctions: string[];
    riskSignals: string[];
    confidence: 'low' | 'medium' | 'high';
  };
}

const ContractSummarySchema: Schema = new Schema(
  {
    network: { type: String, enum: ['mainnet', 'testnet'], required: true },
    contract: { type: String, required: true },
    wasmDigest: { type: String, required: true },
    summary: {
      overview: { type: String, required: true },
      keyPoints: { type: [String], default: [] },
      exposedFunctions: { type: [String], default: [] },
      riskSignals: { type: [String], default: [] },
      confidence: { type: String, enum: ['low', 'medium', 'high'], required: true },
    },
  },
  { timestamps: true }
);

ContractSummarySchema.index({ network: 1, contract: 1, wasmDigest: 1 }, { unique: true });
ContractSummarySchema.index({ network: 1, contract: 1, updatedAt: -1 });

export const ContractSummary = mongoose.model<IContractSummary>(
  'ContractSummary',
  ContractSummarySchema
);

export const connectDB = async (uri: string) => {
  try {
    await mongoose.connect(uri);
    await Agent.syncIndexes();
    await AgentLog.syncIndexes();
    await ContractSummary.syncIndexes();
    console.log('MongoDB Connected to Atlas');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};
