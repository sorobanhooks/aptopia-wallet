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

/** An asset the revoke drain could NOT return (e.g. destination has no
 *  trustline → op_no_trust). Recorded instead of failing the whole revoke. */
export interface AssetSkipResult {
  token: string;
  amount: string;
  reason: string;
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
  /** Send all transferable balances from the signing account to `destination`.
   *  Assets the destination can't receive (no trustline) are returned in
   *  `skipped` rather than failing the whole drain. */
  transferAllAssets(
    secret: string,
    destination: string
  ): Promise<{ transfers: AssetTransferResult[]; skipped: AssetSkipResult[] }>;
}
