export interface Balances {
  native: string;
  usdc: string;
  /** Token balances keyed by canonical token id (e.g. XLM, USDC:G..., FOO:G...). */
  assets?: Record<string, string>;
}

export type TradeDirection = 'buy_xlm' | 'sell_xlm';

export interface AssetTransferResult {
  token: string;
  amount: string;
  txHash: string;
}

export interface IChainService {
  createAgentWallet(): Promise<{ address: string; secret: string }>;
  getBalance(address: string): Promise<Balances>;
  executeSwap(
    secret: string,
    direction: TradeDirection,
    amountSelling: string
  ): Promise<string>;
  setupAgent(secret: string): Promise<void>;
  /** Send all transferable balances from the signing account to `destination`. */
  transferAllAssets(
    secret: string,
    destination: string
  ): Promise<{ transfers: AssetTransferResult[] }>;
}
