import { BuildPaymentTransactionMessage } from "@shared/api/types/message-request";
import { Asset, Horizon, Memo, Operation, TransactionBuilder } from "stellar-sdk";

import { wallet } from "@shared/helpers/stellar";
import { DataStorageAccess } from "background/helpers/dataStorageAccess";
import { NETWORK_ID } from "constants/localStorageTypes";
import { NetworkDetails } from "@shared/constants/stellar";

export const buildPaymentTransaction = async ({
  request,
  localStore,
}: {
  request: BuildPaymentTransactionMessage;
  localStore: DataStorageAccess;
}) => {
  const { destination, assetCode, assetIssuer, amount, memo, activePublicKey } =
    request;

  if (activePublicKey) {
    try {
      wallet.selectAccount(activePublicKey);
    } catch (e) {
      // ignore
    }
  }

  try {
    // 1. DEFAULT: Try with SDK wallet first (proxy-based)
    return await wallet.buildPaymentTransaction({
      destination,
      assetCode,
      assetIssuer,
      amount,
      memo,
    });
  } catch (sdkErr: any) {
    console.warn("Wallet SDK build failed, trying direct Horizon fallback:", sdkErr);

    // 2. FALLBACK: Direct Horizon build to bypass proxy restrictions
    try {
      const networkDetails: NetworkDetails = await localStore.getItem(NETWORK_ID);

      if (networkDetails) {
        const server = new Horizon.Server(networkDetails.networkUrl);
        const sourceAccount = await server.loadAccount(activePublicKey);
        const asset =
          assetCode === "native"
            ? Asset.native()
            : new Asset(assetCode, assetIssuer);

        // Fetch base fee and multiply to ensure confirmation during congestion
        let baseFee = 100;
        try {
          baseFee = Number(await server.fetchBaseFee()) || 100;
        } catch (e) {
          // ignore
        }

        const transaction = new TransactionBuilder(sourceAccount, {
          fee: (baseFee * 10).toString(),
          networkPassphrase: networkDetails.networkPassphrase,
        })
          .addOperation(
            Operation.payment({
              destination,
              asset,
              amount,
            }),
          )
          .setTimeout(180);

        if (memo) {
          transaction.addMemo(Memo.text(memo));
        }

        return transaction.build().toXDR();
      }
    } catch (fallbackErr) {
      console.error("Direct Horizon build fallback also failed:", fallbackErr);
    }
    
    // If fallback fails, rethrow original SDK error
    throw sdkErr;
  }
};
