import { rpc as SorobanRpc, TransactionBuilder } from "stellar-sdk";
import { SubmitFreighterSorobanTransactionMessage } from "@shared/api/types/message-request";
import { SorobanRpcNotSupportedError } from "@shared/constants/errors";

export const submitFreighterSorobanTransaction = async ({
  request,
}: {
  request: SubmitFreighterSorobanTransactionMessage;
}) => {
  const { signedXDR, networkDetails } = request;

  if (!networkDetails.sorobanRpcUrl) {
    throw new SorobanRpcNotSupportedError();
  }

  const server = new SorobanRpc.Server(networkDetails.sorobanRpcUrl);
  
  try {
    const tx = TransactionBuilder.fromXDR(signedXDR, networkDetails.networkPassphrase);
    const response = await server.sendTransaction(tx as any);
    return response;
  } catch (error: any) {
    console.error("Soroban submission failed:", error);
    return { error: error.message || "Soroban transaction submission failed" };
  }
};
