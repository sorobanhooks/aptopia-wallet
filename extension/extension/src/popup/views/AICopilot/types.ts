import { SwapBuildTxResponse, SwapSymbol } from "api/bakuSwapService";
import { Blocker, PendingSwap } from "./swapPreflight";

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
}

export type CopilotMessage =
  | { id: string; role: "copilot"; kind: "text"; text: string }
  | {
      id: string;
      role: "copilot";
      kind: "swap";
      humanAmountIn: string;
      tokenIn: SwapSymbol;
      tokenOut: SwapSymbol;
      build: SwapBuildTxResponse;
      status: "preview" | "signing" | "submitting" | "done" | "failed" | "cancelled";
      hash?: string;
      error?: string;
    }
  | {
      id: string;
      role: "copilot";
      kind: "remediation";
      blocker: Blocker;
      balancesLine: string;
      pendingIntent: PendingSwap;
      status: "preview" | "running" | "done" | "failed";
      error?: string;
    };

export type ChatMessage = UserMessage | CopilotMessage;
