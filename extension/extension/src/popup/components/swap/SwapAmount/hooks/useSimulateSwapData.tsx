import { useReducer } from "react";
import { useDispatch, useSelector } from "react-redux";
import BigNumber from "bignumber.js";
import {
  BASE_FEE,
} from "stellar-sdk";

import { initialState, reducer } from "helpers/request";
import { NetworkDetails } from "@shared/constants/stellar";
import {
  getCanonicalFromAsset,
  stroopToXlm,
} from "helpers/stellar";

import {
  saveSimulation,
  saveSwapBestPath,
  transactionDataSelector,
} from "popup/ducks/transactionSubmission";
import { useScanTx } from "popup/helpers/blockaid";
import { BlockAidScanTxResult } from "@shared/api/types";
import { formatAmount, roundUsdValue } from "popup/helpers/formatters";
import { AppDispatch } from "popup/App";
import { buildSwapTransaction as internalBuildSwapTransaction } from "@shared/api/internal";

const scanUrlstub = "internal";

export const ERROR_TO_DISPLAY = {
  NO_PATH_FOUND: "No path found for swap.",
};

interface SimulationParams {
  sourceAsset: { code: string; issuer?: string };
  destAsset: { code: string; issuer?: string };
  amount: string;
  allowedSlippage: string;
  path: string[];
  transactionFee: string;
  transactionTimeout: number;
  memo?: string;
}

export interface SimulateTxData {
  transactionXdr: string;
  dstAmountPriceUsd: string;
  scanResult?: BlockAidScanTxResult | null;
}

function useSimulateTxData({
  publicKey,
  networkDetails,
  simParams,
}: {
  publicKey: string;
  networkDetails: NetworkDetails;
  simParams: SimulationParams;
}) {
  const { memo } = useSelector(transactionDataSelector);
  const reduxDispatch = useDispatch<AppDispatch>();

  const { scanTx } = useScanTx();
  const [state, dispatch] = useReducer(
    reducer<SimulateTxData, string>,
    initialState,
  );

  const fetchData = async ({
    amount,
    destinationRate,
  }: {
    amount: string;
    destinationRate?: string;
  }) => {
    dispatch({ type: "FETCH_DATA_START" });
    try {
      const payload = { transactionXdr: "" } as SimulateTxData;
      const { allowedSlippage, sourceAsset, destAsset, transactionTimeout } =
        simParams;

      const baseFee = new BigNumber(
        simParams.transactionFee || stroopToXlm(BASE_FEE),
      );

      // Call the background service to build and get quote
      const response = await internalBuildSwapTransaction({
        activePublicKey: publicKey,
        sourceAsset: getCanonicalFromAsset(sourceAsset.code, sourceAsset.issuer),
        destAsset: getCanonicalFromAsset(destAsset.code, destAsset.issuer),
        amount,
        networkDetails,
        slippagePercent: allowedSlippage,
        memo,
        fee: baseFee.toString(),
        timeoutSeconds: transactionTimeout,
      });

      const { xdr, quote, error: backgroundError } = response as any;

      if (backgroundError) {
        throw new Error(backgroundError);
      }

      if (!quote?.destAmount) {
        throw new Error(ERROR_TO_DISPLAY.NO_PATH_FOUND);
      }

      const destinationAmount = quote.destAmount;
      const path = quote.path;

      if (destinationRate) {
        payload.dstAmountPriceUsd = formatAmount(
          roundUsdValue(
            new BigNumber(destinationRate)
              .multipliedBy(new BigNumber(destinationAmount))
              .toString(),
          ),
        );
      }

      payload.transactionXdr = xdr;
      payload.scanResult = await scanTx(xdr, scanUrlstub, networkDetails);
      
      reduxDispatch(
        saveSimulation({
          preparedTransaction: xdr,
        }),
      );
      reduxDispatch(
        saveSwapBestPath({
          path,
          destinationAmount,
        }),
      );

      dispatch({ type: "FETCH_DATA_SUCCESS", payload });
      return payload;
    } catch (error: any) {
      console.error("Swap simulation failed:", error);
      const unknownErrorDisplay =
        "We had an issue retrieving your swap details. Please try again.";
      let payload: string;

      if (error instanceof Error) {
        const isKnownError = Object.values(ERROR_TO_DISPLAY).includes(
          error.message,
        );
        payload = isKnownError ? error.message : error.message || unknownErrorDisplay;
      } else if (typeof error === "string") {
        payload = Object.values(ERROR_TO_DISPLAY).includes(error)
          ? error
          : error || unknownErrorDisplay;
      } else {
        payload = unknownErrorDisplay;
      }

      dispatch({ type: "FETCH_DATA_ERROR", payload });
      return error;
    }
  };

  return {
    state,
    fetchData,
  };
}

export { useSimulateTxData };
