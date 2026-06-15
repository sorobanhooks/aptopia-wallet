// remediation.ts
import { Asset, BASE_FEE, Horizon, Operation, TransactionBuilder } from "stellar-sdk";
import { useDispatch } from "react-redux";
import { AppDispatch } from "popup/App";
import { NetworkDetails } from "@shared/constants/stellar";
import { signFreighterTransaction } from "popup/ducks/transactionSubmission";
import { SWAP_USDC_CODE, SWAP_USDC_ISSUER } from "./swapAssets";

const FRIENDBOT_URL = "https://friendbot.stellar.org";

/** Fund a brand-new/unfunded testnet account. Friendbot only funds accounts that
 *  don't exist yet; an already-funded account returns non-OK, surfaced as a
 *  friendly error. */
export async function fundWithFriendbot(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(
      "Couldn't fund this account from the testnet friendbot — it may already be funded.",
    );
  }
}

/** Build → sign → submit a changeTrust to the swap's Circle USDC, entirely via
 *  Horizon + stellar-sdk.
 *
 *  We deliberately do NOT use `buildTrustlineTransaction`/`submitFreighterTransaction`:
 *  those route through the Stellar Wallet SDK's backend (the Freighter indexer),
 *  whose host is unreachable in this deployment — the build returns an error
 *  object instead of an XDR, which then fails to sign. Horizon supplies the
 *  sequence number and accepts the submission directly. Signing still goes
 *  through the background worker (signFreighterTransaction) since the secret key
 *  never leaves it. Returns the submitted tx hash. */
export function useAddUsdcTrustline() {
  const dispatch = useDispatch<AppDispatch>();
  return async ({
    publicKey,
    networkDetails,
  }: {
    publicKey: string;
    networkDetails: NetworkDetails;
  }): Promise<string> => {
    const server = new Horizon.Server(networkDetails.networkUrl);
    const source = await server.loadAccount(publicKey);
    const xdr = new TransactionBuilder(source, {
      fee: (Number(BASE_FEE) * 100).toString(),
      networkPassphrase: networkDetails.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset: new Asset(SWAP_USDC_CODE, SWAP_USDC_ISSUER),
        }),
      )
      .setTimeout(180)
      .build()
      .toXDR();

    const signed = await dispatch(
      signFreighterTransaction({
        transactionXDR: xdr,
        network: networkDetails.networkPassphrase,
      }),
    );
    if (signFreighterTransaction.rejected.match(signed)) {
      // Surface the real reason (e.g. "Session timed out. Please unlock your wallet.").
      throw new Error(
        (signed.payload as { errorMessage?: string })?.errorMessage ||
          "Failed to sign the trustline transaction.",
      );
    }
    const signedXDR = (signed.payload as { signedTransaction: string })
      .signedTransaction;

    const submitted = await server.submitTransaction(
      TransactionBuilder.fromXDR(signedXDR, networkDetails.networkPassphrase),
    );
    return (submitted as { hash: string }).hash;
  };
}
