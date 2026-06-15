import { useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch } from "popup/App";
import { signFreighterSorobanTransaction } from "popup/ducks/transactionSubmission";
import { settingsNetworkDetailsSelector } from "popup/ducks/settings";

/** Sign an unsigned Soroban XDR with the in-extension wallet (background worker).
 * Returns the signed XDR. Shared by YieldHub and AI Copilot. */
export const useSignSorobanXdr = () => {
  const dispatch: AppDispatch = useDispatch();
  const networkDetails = useSelector(settingsNetworkDetailsSelector);
  return useCallback(
    async (xdr: string): Promise<string> => {
      const res = await dispatch(
        signFreighterSorobanTransaction({
          transactionXDR: xdr,
          network: networkDetails.networkPassphrase,
        }),
      );
      if (signFreighterSorobanTransaction.fulfilled.match(res)) {
        return res.payload.signedTransaction;
      }
      throw new Error(
        res.payload?.errorMessage || "Failed to sign transaction with internal wallet.",
      );
    },
    [dispatch, networkDetails.networkPassphrase],
  );
};
