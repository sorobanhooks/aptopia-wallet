import { useState, useCallback, useRef, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Horizon, TransactionBuilder } from "stellar-sdk";
import { isAccountNotFoundError } from "stellar-wallet-sdk";

import { AppDispatch } from "popup/App";
import { settingsNetworkDetailsSelector } from "popup/ducks/settings";
import { publicKeySelector } from "popup/ducks/accountServices";
import {
  signFreighterTransaction,
  submitFreighterTransaction,
} from "popup/ducks/transactionSubmission";
import { buildFundingOperation } from "./buildFundingOperation";

// Small margin over BASE_FEE (100 stroops) so a single funding op isn't dropped
// during testnet fee surges. 10,000 stroops = 0.001 XLM — negligible to the user.
const FUNDING_FEE = "10000";

interface FundArgs {
  agentAddress: string;
  amount: string; // whole XLM, e.g. "3"
}

export const useFundAgent = (onSuccess?: () => void) => {
  const dispatch: AppDispatch = useDispatch();
  const networkDetails = useSelector(settingsNetworkDetailsSelector);
  const publicKey = useSelector(publicKeySelector);
  const [isFunding, setIsFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  const fund = useCallback(
    async ({ agentAddress, amount }: FundArgs) => {
      setError(null);
      setIsFunding(true);
      try {
        const server = new Horizon.Server(networkDetails.networkUrl);
        const source = await server.loadAccount(publicKey);

        // Pre-flight: reject before building/signing if the wallet can't cover
        // amount + tx fee + base reserve headroom.
        const FUND_RESERVE_BUFFER_XLM = 1.1; // base reserve (~1 XLM) + fee headroom
        const nativeBalance = Number(
          (source.balances as any[]).find((b) => b.asset_type === "native")
            ?.balance ?? "0",
        );
        if (Number(amount) + FUND_RESERVE_BUFFER_XLM > nativeBalance) {
          setError(
            `Not enough XLM. You have ${nativeBalance} XLM; funding ${amount} needs ~${(Number(amount) + FUND_RESERVE_BUFFER_XLM).toFixed(2)} XLM including reserve + fee.`,
          );
          return;
        }

        let accountExists = true;
        try {
          await server.loadAccount(agentAddress);
        } catch (e) {
          // A Horizon 404 means the agent account isn't created on-chain yet ->
          // fund it with createAccount. Check the HTTP status directly: the SDK's
          // isAccountNotFoundError uses `instanceof NotFoundError`, which silently
          // fails here because multiple @stellar/stellar-base copies are installed
          // (the thrown error is a different NotFoundError class), so a brand-new
          // agent's 404 was being re-thrown as "Not Found".
          const status = (e as { response?: { status?: number } } | null)
            ?.response?.status;
          if (status === 404 || isAccountNotFoundError(e)) {
            accountExists = false;
          } else {
            throw e; // genuine network/other error -> surface it
          }
        }

        const op = buildFundingOperation({
          destination: agentAddress,
          amount,
          accountExists,
        });
        const xdrTx = new TransactionBuilder(source, {
          fee: FUNDING_FEE,
          networkPassphrase: networkDetails.networkPassphrase,
        })
          .addOperation(op)
          .setTimeout(180)
          .build()
          .toXDR();

        const signRes = await dispatch(
          signFreighterTransaction({
            transactionXDR: xdrTx,
            network: networkDetails.networkPassphrase,
          }),
        );
        if (!signFreighterTransaction.fulfilled.match(signRes)) {
          throw new Error(
            signRes.payload?.errorMessage || "Signing was cancelled.",
          );
        }

        const submitRes = await dispatch(
          submitFreighterTransaction({
            publicKey,
            signedXDR: signRes.payload.signedTransaction,
            networkDetails,
          }),
        );
        if (!submitFreighterTransaction.fulfilled.match(submitRes)) {
          throw new Error(
            submitRes.payload?.errorMessage || "Funding transaction failed.",
          );
        }

        onSuccessRef.current?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Funding failed.");
      } finally {
        setIsFunding(false);
      }
    },
    [dispatch, networkDetails, publicKey],
  );

  return { fund, isFunding, error };
};
