import { fetchJson } from "popup/helpers/fetch";
import { BAKU_API_URL } from "constants/env";
import {
  VaultAsset,
  VaultState,
  VaultStrategies,
  BuildTxResponse,
  WithdrawBuildTxResponse,
  SubmitResponse,
  BalanceResponse,
  AddressesResponse,
} from "./yieldHubTypes";

class YieldHubService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = BAKU_API_URL;
  }

  /**
   * Inventory — every endpoint Baku exposes.
   * GET /
   */
  async getInventory(): Promise<unknown> {
    return fetchJson<unknown>(`${this.baseUrl}/`);
  }

  /**
   * Health probe.
   * GET /health
   */
  async getHealth(): Promise<{ ok: boolean; t: string }> {
    return fetchJson<{ ok: boolean; t: string }>(`${this.baseUrl}/health`);
  }

  /**
   * Full NetworkAddresses struct for the active network.
   * GET /addresses
   */
  async getAddresses(): Promise<AddressesResponse> {
    return fetchJson<AddressesResponse>(`${this.baseUrl}/addresses`);
  }

  /**
   * Read-only on-chain state for a vault (totals, APY, price-per-share).
   * GET /vault/:asset/state
   */
  async getVaultState(asset: VaultAsset): Promise<VaultState> {
    return fetchJson<VaultState>(`${this.baseUrl}/vault/${asset}/state`);
  }

  /**
   * Registered strategy list with the active marker.
   * GET /vault/:asset/strategies
   */
  async getVaultStrategies(asset: VaultAsset): Promise<VaultStrategies> {
    return fetchJson<VaultStrategies>(
      `${this.baseUrl}/vault/${asset}/strategies`,
    );
  }

  /**
   * Aggregated balances across share tokens (stXLM/stUSDC) and underlying SACs.
   * Backed by a 3s TTL cache on the API side — safe to poll.
   * GET /balance/:address
   */
  async getBalance(address: string): Promise<BalanceResponse> {
    return fetchJson<BalanceResponse>(`${this.baseUrl}/balance/${address}`);
  }

  /**
   * Build (don't sign) a deposit transaction.
   * The wallet signs the returned XDR with the user's key, then submits it
   * back through `submitSignedTx()`.
   *
   * POST /vault/:asset/deposit/build-tx
   *
   * @param asset   "xlm" | "usdc"
   * @param user    Stellar G... pubkey of the depositor
   * @param amount  i128 decimal string in base units (1 XLM = 10⁷ stroops)
   */
  async buildDeposit(
    asset: VaultAsset,
    user: string,
    amount: string,
  ): Promise<BuildTxResponse> {
    return fetchJson<BuildTxResponse>(
      `${this.baseUrl}/vault/${asset}/deposit/build-tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, amount }),
      },
    );
  }

  /**
   * Build a redeem transaction with on-chain slippage floor.
   * Server computes `min_out = expected * (10000 - max_slippage_bps) / 10000`
   * and bakes it into the contract call — vault reverts with
   * `VaultError::SlippageExceeded` if the strategy delivers less.
   *
   * POST /vault/:asset/withdraw/build-tx
   *
   * @param asset             "xlm" | "usdc"
   * @param user              G... pubkey of the redeemer
   * @param shares            i128 decimal string — number of share tokens to burn
   * @param maxSlippageBps    Optional, default 100 (= 1%)
   */
  async buildWithdraw(
    asset: VaultAsset,
    user: string,
    shares: string,
    maxSlippageBps = 100,
  ): Promise<WithdrawBuildTxResponse> {
    return fetchJson<WithdrawBuildTxResponse>(
      `${this.baseUrl}/vault/${asset}/withdraw/build-tx`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user,
          shares,
          max_slippage_bps: maxSlippageBps,
        }),
      },
    );
  }

  /**
   * Submit a signed Soroban XDR. Baku polls Soroban RPC for up to 30s for
   * terminal status before returning.
   *
   * POST /tx/submit
   */
  async submitSignedTx(signedXdr: string): Promise<SubmitResponse> {
    return fetchJson<SubmitResponse>(`${this.baseUrl}/tx/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signed_xdr: signedXdr }),
    });
  }

  /**
   * Fetch a partially-signed (by the asset issuer) classic transaction that
   * opens trustlines + funds the user with Blend's testnet assets
   * (USDC, BLND, wETH, wBTC). The wallet co-signs as the user and submits.
   *
   * POST /faucet/blend-testnet
   */
  async getBlendTestnetFaucet(userId: string): Promise<{ xdr: string }> {
    return fetchJson<{ xdr: string }>(
      `${this.baseUrl}/faucet/blend-testnet`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
    );
  }
}

export const yieldHubService = new YieldHubService();
