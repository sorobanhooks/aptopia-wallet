/**
 * Vault assets supported by Baku. The API route segment matches these
 * lowercase strings exactly (`/vault/xlm/...`, `/vault/usdc/...`).
 */
export type VaultAsset = "xlm" | "usdc";

/**
 * Per-strategy asset breakdown returned inside `VaultState.strategyPositions`.
 * Added in B5 — describes where vault TVL is currently deployed.
 */
export interface StrategyPosition {
  /** Soroban contract address of the strategy. */
  address: string;
  /** Human-readable label: "Blend", "Soroswap", "DeFindex", or "Mock (<prefix>…)". */
  name: string;
  /** True if this is the vault's currently active (routing) strategy. */
  isActive: boolean;
  /** i128 decimal string — strategy.current_value() at time of request. */
  currentValue: string;
  /** Fraction of total vault TVL, in percent. 0 when TVL is zero. */
  sharePercent: number;
}

/**
 * Response from `GET /vault/:asset/state`.
 *
 * All i128 fields are returned as decimal strings to stay BigInt-safe.
 * `pricePerShare` is the underlying value of 10_000_000 shares (one whole
 * token at 7 decimals); empty vault returns "10" thanks to virtual-offset
 * math.
 *
 * `strategyPositions` was added in B5 — older API deployments omit it;
 * callers should treat its absence as an empty array.
 */
export interface VaultState {
  network: "testnet" | "mainnet";
  asset: VaultAsset;
  vault: string;
  activeStrategy: string;
  totalAssets: string;
  totalSupply: string;
  pricePerShare: string;
  poolApyBps: number;
  /** Per-strategy asset breakdown. Absent on older API deployments. */
  strategyPositions?: StrategyPosition[];
  /**
   * Per-sleeve breakdown when the active strategy is a weighted meta-allocator
   * (each child strategy by value + the native cash buffer). Absent for plain
   * single-strategy vaults / older API deployments.
   */
  breakdown?: BreakdownEntry[];
}

/** One sleeve of a weighted-allocator vault (child strategy or native buffer). */
export interface BreakdownEntry {
  /** Human-readable label: "Blend", "Soroswap LP", "Native (cash buffer)". */
  label: string;
  /** Sleeve class for styling. */
  kind: "blend" | "soroswap" | "native" | "other";
  /** Child strategy address (or the allocator address for the native sleeve). */
  address: string;
  /** Target weight in basis points (child weight, or native_bps for the buffer). */
  weightBps: number;
  /** i128 decimal string — current value of this sleeve. */
  currentValue: string;
  /** Actual share of the allocator's value, in percent. */
  sharePercent: number;
  /** True if the allocator treats this child's current_value as authoritative. */
  authoritative?: boolean;
}

export interface VaultStrategy {
  address: string;
  isActive: boolean;
}

export interface VaultStrategies {
  network: "testnet" | "mainnet";
  asset: VaultAsset;
  vault: string;
  active: string;
  registered: VaultStrategy[];
}

export interface BuildTxResponse {
  xdr: string;
  vault: string;
  asset: VaultAsset;
}

export interface WithdrawPreview {
  expected: string;
  minOut: string;
  maxSlippageBps: number;
}

export interface WithdrawBuildTxResponse extends BuildTxResponse {
  preview: WithdrawPreview;
}

export type SubmitStatus = "SUCCESS" | "FAILED" | "PENDING" | "TIMEOUT";

export interface SubmitResponse {
  hash: string;
  status: SubmitStatus;
  /**
   * Contract return value, encoded as a string (or recursive for structs).
   * For `deposit` it's the shares minted; for `redeem` it's the amount
   * delivered. Absent on failure.
   */
  returnValue?: string;
  error?: string;
}

/**
 * Response from `GET /balance/:address`. All values are i128 decimal strings
 * in base units (7 decimals across the board).
 */
export interface BalanceResponse {
  network: "testnet" | "mainnet";
  address: string;
  stxlm: string;
  stusdc: string;
  xlm: string;
  usdc: string;
}

/**
 * Mirror of `crates/addresses/src/lib.rs::TESTNET / MAINNET`.
 * Only the fields the popup actually reads are typed strictly — the API may
 * grow new fields without breaking the popup.
 */
export interface AddressesResponse {
  network: "testnet" | "mainnet";
  networkPassphrase: string;
  sorobanRpcUrl: string;
  vaultXlm: string;
  vaultUsdc: string;
  nativeXlmSac: string;
  usdcSac: string;
  blendStrategyXlm?: string;
  blendStrategyUsdc?: string;
  soroswapStrategyUsdc?: string;
  [key: string]: unknown;
}

/**
 * Convenience aggregate the YieldHub view assembles client-side from
 * `getVaultState()` + `getBalance()`. Not returned by any single endpoint.
 */
export interface VaultPosition {
  asset: VaultAsset;
  vault: string;
  activeStrategy: string;
  shares: string;
  pricePerShare: string;
  underlyingValue: string;
  apyBps: number;
  totalAssets: string;
}
