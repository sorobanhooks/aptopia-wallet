import { wallet as sdkWallet } from "@shared/helpers/stellar";


import {
  SignFreighterSorobanTransactionMessage,
  SignFreighterTransactionMessage,
} from "@shared/api/types/message-request";
export const signFreighterTransaction = async ({
  request,
}: {
  request:
    | SignFreighterTransactionMessage
    | SignFreighterSorobanTransactionMessage;
}) => {
  const { transactionXDR } = request;


  // ── Preferred path: Use Stellar Wallet SDK ────────────────────────
  // The SDK uses its internal signing key set during restore() or import()
  try {
    const signedTransaction = await sdkWallet.signXDR(transactionXDR);
    return { signedTransaction };
  } catch (sdkError: any) {
    console.error("SDK signing failed:", sdkError);
    return { error: sdkError.message || "Signing failed" };
  }
};


