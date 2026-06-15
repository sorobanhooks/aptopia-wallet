import {
  Keypair,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Horizon,
} from 'stellar-sdk';
import {
  IChainService,
  Balances,
  TradeDirection,
  AssetTransferResult,
  AssetSkipResult,
} from './types';

/** Extract a readable reason from a Horizon submit error (op_no_trust, etc.). */
function stellarSubmitErrorReason(err: unknown): string {
  const e = err as {
    response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } };
    message?: string;
  };
  const rc = e?.response?.data?.extras?.result_codes;
  if (rc) {
    const ops = (rc.operations ?? []).filter(Boolean);
    if (ops.length) return ops.join(', ');
    if (rc.transaction) return rc.transaction;
  }
  return e?.message ?? 'unknown error';
}

const PATH_SLIPPAGE_BPS = 100; // 1%
const STELLAR_SCALE = 7;
const BASE_RESERVE_XLM = Number(process.env.STELLAR_BASE_RESERVE_XLM || 0.5);
const XLM_FEE_BUFFER = Number(process.env.STELLAR_XLM_FEE_BUFFER || 0.01);

/** Circle USDC on Stellar (see https://centre.io/.well-known/stellar.toml) */
const STELLAR_MAINNET_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
/** Common testnet USDC issuer (Circle / docs; ends in FLA5) */
const STELLAR_TESTNET_USDC_ISSUER =
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function resolveUsdcIssuer(isPubnet: boolean): string {
  const fromEnv = process.env.USDC_ASSET_ISSUER?.trim();
  if (fromEnv) {
    if (isPubnet && fromEnv === STELLAR_TESTNET_USDC_ISSUER) {
      console.warn(
        '[StellarService] USDC_ASSET_ISSUER is the known testnet Circle USDC address; using mainnet issuer because NETWORK=stellar:pubnet.'
      );
      return STELLAR_MAINNET_USDC_ISSUER;
    }
    if (!isPubnet && fromEnv === STELLAR_MAINNET_USDC_ISSUER) {
      console.warn(
        '[StellarService] USDC_ASSET_ISSUER is the known mainnet Circle USDC address; using testnet issuer on testnet.'
      );
      return STELLAR_TESTNET_USDC_ISSUER;
    }
    return fromEnv;
  }
  return isPubnet ? STELLAR_MAINNET_USDC_ISSUER : STELLAR_TESTNET_USDC_ISSUER;
}

export class StellarService implements IChainService {
  private server: Horizon.Server;
  private networkPassphrase: string;
  private usdcAsset: Asset;

  constructor() {
    const network = process.env.NETWORK || 'stellar:testnet';
    const isPubnet = network === 'stellar:pubnet';
    this.networkPassphrase = isPubnet ? Networks.PUBLIC : Networks.TESTNET;
    this.server = new Horizon.Server(
      isPubnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org'
    );
    this.usdcAsset = new Asset(
      process.env.USDC_ASSET_CODE || 'USDC',
      resolveUsdcIssuer(isPubnet)
    );
  }

  async createAgentWallet(): Promise<{ address: string; secret: string }> {
    const pair = Keypair.random();
    return { address: pair.publicKey(), secret: pair.secret() };
  }

  private accountHasUsdcTrustline(account: Horizon.AccountResponse): boolean {
    for (const balance of account.balances) {
      if (balance.asset_type === 'native' || balance.asset_type === 'liquidity_pool_shares') {
        continue;
      }
      const b = balance as { asset_code?: string; asset_issuer?: string };
      if (
        b.asset_code === this.usdcAsset.getCode() &&
        b.asset_issuer === this.usdcAsset.getIssuer()
      ) {
        return true;
      }
    }
    return false;
  }

  async getBalance(address: string): Promise<Balances> {
    try {
      const account = await this.server.loadAccount(address);
      let native = '0';
      let usdc = '0';
      const assets: Record<string, string> = {};

      for (const balance of account.balances) {
        if (balance.asset_type === 'native') {
          native = balance.balance;
          assets.XLM = balance.balance;
        } else if (balance.asset_type !== 'liquidity_pool_shares') {
          // Now TS knows it's not a liquidity pool, but it might still be a union
          // Accessing asset_code/issuer safely
          const b = balance as any;
          if (b.asset_code && b.asset_issuer && balance.balance) {
            const tokenId = `${b.asset_code}:${b.asset_issuer}`;
            assets[tokenId] = balance.balance;
          }
          if (
            b.asset_code === this.usdcAsset.getCode() &&
            b.asset_issuer === this.usdcAsset.getIssuer()
          ) {
            usdc = balance.balance;
          }
        }
      }

      return { native, usdc, assets };
    } catch (e) {
      console.error(`Failed to fetch balance for ${address}`, e);
      return { native: '0', usdc: '0', assets: { XLM: '0' } };
    }
  }

  async setupAgent(secret: string): Promise<void> {
    const pair = Keypair.fromSecret(secret);
    const pubkey = pair.publicKey();
    const account = await this.server.loadAccount(pubkey);

    if (this.accountHasUsdcTrustline(account)) {
      console.log(`USDC trustline already present for ${pubkey}`);
      return;
    }

    this.assertNativeBalanceForNewTrustline(account);

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset: this.usdcAsset,
        })
      )
      .setTimeout(180)
      .build();

    transaction.sign(pair);
    await this.server.submitTransaction(transaction);
    console.log(`USDC Trustline established for ${pubkey}`);
  }

  /**
   * After adding one trustline, minimum balance is (2 + subentry_count + 1) × base_reserve.
   * Reject early with a clear message (avoids opaque Horizon tx failures when balance is ~1 XLM).
   */
  private assertNativeBalanceForNewTrustline(account: Horizon.AccountResponse): void {
    const native = account.balances.find((b) => b.asset_type === 'native') as
      | { balance: string }
      | undefined;
    const nativeBal = Number(native?.balance ?? 0);
    const subentries = account.subentry_count;
    const minBalanceAfter = (2 + subentries + 1) * BASE_RESERVE_XLM;
    const feeStroops = Number(BASE_FEE);
    const feeXlm = Number.isFinite(feeStroops) ? feeStroops / 10_000_000 : 0.000_01;
    const required = minBalanceAfter + feeXlm;
    if (nativeBal + 1e-8 < required) {
      throw new Error(
        `Insufficient XLM for a USDC trustline: balance is ${nativeBal} XLM but about ${required.toFixed(2)} XLM is needed after the trustline (ledger minimum balance + fee). Send more XLM to this address and run /createtrustline again.`
      );
    }
  }

  private floorStellarAmount(value: number): string {
    const factor = 10 ** STELLAR_SCALE;
    return (Math.floor(value * factor) / factor).toFixed(STELLAR_SCALE);
  }

  /**
   * Horizon path hops are plain objects; pathPaymentStrictSend requires Asset
   * instances with toXDRObject().
   */
  private pathFromHorizonRecord(path: unknown[] | undefined): Asset[] {
    if (!path?.length) {
      return [];
    }
    return path.map((hop) => {
      const h = hop as {
        asset_type?: string;
        asset_code?: string;
        asset_issuer?: string;
      };
      if (!h || h.asset_type === 'native') {
        return Asset.native();
      }
      if (!h.asset_code || !h.asset_issuer) {
        throw new Error(
          `Unsupported path hop (non-native missing code/issuer): ${JSON.stringify(h)}`
        );
      }
      return new Asset(h.asset_code, h.asset_issuer);
    });
  }

  async executeSwap(
    secret: string,
    direction: TradeDirection,
    amountSelling: string
  ): Promise<string> {
    const pair = Keypair.fromSecret(secret);
    const account = await this.server.loadAccount(pair.publicKey());
    const destination = pair.publicKey();

    const sendAsset =
      direction === 'buy_xlm' ? this.usdcAsset : Asset.native();
    const destAsset =
      direction === 'buy_xlm' ? Asset.native() : this.usdcAsset;

    const strictSendPathsCall = (this.server as any).strictSendPaths(
      sendAsset,
      amountSelling,
      [destAsset]
    );
    const strictSendPaths = await strictSendPathsCall.call();
    const bestPath = strictSendPaths?.records?.[0];

    if (!bestPath) {
      throw new Error(
        `No swap path found for ${direction} with amount ${amountSelling}`
      );
    }

    const destinationAmount = Number(
      bestPath.destination_amount ?? bestPath.destinationAmount
    );
    if (!Number.isFinite(destinationAmount) || destinationAmount <= 0) {
      throw new Error('Could not compute destination amount for swap path');
    }

    const slippage = PATH_SLIPPAGE_BPS / 10_000;
    const destMin = this.floorStellarAmount(destinationAmount * (1 - slippage));
    const pathAssets = this.pathFromHorizonRecord(bestPath.path);

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.pathPaymentStrictSend({
          destination,
          sendAsset,
          sendAmount: amountSelling,
          destAsset,
          destMin,
          path: pathAssets,
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(pair);
    const result = await this.server.submitTransaction(transaction);
    return result.hash;
  }

  async transferAllAssets(
    secret: string,
    destination: string
  ): Promise<{ transfers: AssetTransferResult[]; skipped: AssetSkipResult[] }> {
    const pair = Keypair.fromSecret(secret);
    const from = pair.publicKey();
    const initial = await this.server.loadAccount(from);
    const transfers: AssetTransferResult[] = [];
    const skipped: AssetSkipResult[] = [];

    // Transfer issued assets first. A per-asset payment can fail (most commonly
    // op_no_trust: the destination has no trustline for this asset and can't
    // receive it). Skip that asset and keep going instead of aborting the whole
    // revoke — otherwise the user is stuck: can't revoke, can't create a new
    // agent. The undrainable balance stays in the (now-disabled) agent.
    for (const balance of initial.balances) {
      if (balance.asset_type === 'native' || balance.asset_type === 'liquidity_pool_shares') {
        continue;
      }
      const b = balance as {
        asset_code?: string;
        asset_issuer?: string;
        balance?: string;
      };
      if (!b.asset_code || !b.asset_issuer) {
        continue;
      }
      const amountNum = Number(b.balance ?? '0');
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        continue;
      }
      const amount = this.floorStellarAmount(amountNum);
      const token = `${b.asset_code}:${b.asset_issuer}`;
      try {
        const asset = new Asset(b.asset_code, b.asset_issuer);
        const account = await this.server.loadAccount(from);
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            Operation.payment({
              destination,
              asset,
              amount,
            })
          )
          .setTimeout(30)
          .build();
        tx.sign(pair);
        const result = await this.server.submitTransaction(tx);
        transfers.push({ token, amount, txHash: result.hash });
      } catch (err) {
        skipped.push({ token, amount, reason: stellarSubmitErrorReason(err) });
      }
    }

    // Then transfer spendable XLM while preserving reserve and fee buffer.
    try {
      const afterAssets = await this.server.loadAccount(from);
      const nativeBalance = Number(
        afterAssets.balances.find((b) => b.asset_type === 'native')?.balance ?? '0'
      );
      const minReserve = (2 + afterAssets.subentry_count) * BASE_RESERVE_XLM;
      const spendableXlm = nativeBalance - minReserve - XLM_FEE_BUFFER;
      if (Number.isFinite(spendableXlm) && spendableXlm > 0) {
        const amount = this.floorStellarAmount(spendableXlm);
        if (Number(amount) > 0) {
          const account = await this.server.loadAccount(from);
          const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: this.networkPassphrase,
          })
            .addOperation(
              Operation.payment({
                destination,
                asset: Asset.native(),
                amount,
              })
            )
            .setTimeout(30)
            .build();
          tx.sign(pair);
          const result = await this.server.submitTransaction(tx);
          transfers.push({ token: 'XLM', amount, txHash: result.hash });
        }
      }
    } catch (err) {
      skipped.push({ token: 'XLM', amount: '0', reason: stellarSubmitErrorReason(err) });
    }

    return { transfers, skipped };
  }
}
