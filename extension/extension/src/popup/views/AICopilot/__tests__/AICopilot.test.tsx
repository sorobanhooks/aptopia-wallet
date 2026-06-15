import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Wrapper } from "popup/__testHelpers__";
import {
  TESTNET_NETWORK_DETAILS,
  DEFAULT_NETWORKS,
} from "@shared/constants/stellar";
import * as agentService from "api/agentBackendService";
import * as swapService from "api/bakuSwapService";
import * as signHook from "popup/hooks/useSignSorobanXdr";
import * as accountStateModule from "../accountState";
import * as remediationModule from "../remediation";
import { AICopilot } from "../index";

const PUBKEY = "GBTYAFHGNZSTE4VBWZYAGB3SRGJEPTI5I4Y22KZ4JTVAN56LESB6JZOF";

const READY_ACCOUNT = { funded: true, nativeXlm: "100", usdc: { hasTrustline: true, balance: "100" } };

const renderCopilot = () =>
  render(
    <Wrapper
      routes={["/"]}
      state={{
        auth: { error: null, applicationState: "MNEMONIC_PHRASE_CONFIRMED", publicKey: PUBKEY, allAccounts: [] },
        settings: { networkDetails: TESTNET_NETWORK_DETAILS, networksList: DEFAULT_NETWORKS, hiddenAssets: {} },
      }}
    >
      <AICopilot mode="tab" />
    </Wrapper>,
  );

/** Shared swap preview mock data — tokenIn "usdc", tokenOut "xlm", amountIn 5 (50000000 base) */
const SWAP_PREVIEW = {
  xdr: "XDR",
  router: "CCJ",
  preview: {
    venue: "soroswap" as const,
    tokenIn: "usdc" as const,
    tokenOut: "xlm" as const,
    amountIn: "50000000",
    expectedOut: "380000000",
    minOut: "378100000",
    maxSlippageBps: 50,
    rate: "7.6",
  },
};

describe("AICopilot", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(accountStateModule, "fetchAccountState").mockResolvedValue(READY_ACCOUNT as any);
  });

  it("renders a swap preview card after a parseable message", async () => {
    jest.spyOn(agentService.agentBackendService, "parseCopilot").mockResolvedValue({
      type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "USDC", tokenOut: "XLM",
    });
    jest.spyOn(swapService.bakuSwapService, "buildSwap").mockResolvedValue({
      xdr: "XDR",
      router: "CCJ",
      preview: { venue: "soroswap", tokenIn: "usdc", tokenOut: "xlm", amountIn: "50000000", expectedOut: "380000000", minOut: "378100000", maxSlippageBps: 50, rate: "7.6" },
    });

    renderCopilot();
    fireEvent.change(screen.getByTestId("ai-copilot-input"), { target: { value: "swap 5 usd to xlm" } });
    fireEvent.click(screen.getByTestId("ai-copilot-send"));

    await waitFor(() => screen.getByTestId("ai-copilot-swap-card"));
    expect(screen.getByTestId("ai-copilot-sign")).toBeInTheDocument();
  });

  it("shows the copilot message for an unsupported request", async () => {
    jest.spyOn(agentService.agentBackendService, "parseCopilot").mockResolvedValue({
      type: "unsupported", message: "I can only do Soroswap swaps right now.",
    });

    renderCopilot();
    fireEvent.change(screen.getByTestId("ai-copilot-input"), { target: { value: "send 5 xlm to bob" } });
    fireEvent.click(screen.getByTestId("ai-copilot-send"));

    await waitFor(() => screen.getByText("I can only do Soroswap swaps right now."));
  });

  // --- New regression tests ---

  it("sign → submit success: calls submitSignedTx exactly once and shows Submitted", async () => {
    // Mock the sign hook before render so the component picks it up
    jest.spyOn(signHook, "useSignSorobanXdr").mockReturnValue(
      jest.fn().mockResolvedValue("SIGNED_XDR"),
    );
    jest.spyOn(agentService.agentBackendService, "parseCopilot").mockResolvedValue({
      type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "USDC", tokenOut: "XLM",
    });
    const buildSwapSpy = jest
      .spyOn(swapService.bakuSwapService, "buildSwap")
      .mockResolvedValue(SWAP_PREVIEW);
    const submitSpy = jest
      .spyOn(swapService.bakuSwapService, "submitSignedTx")
      .mockResolvedValue({ hash: "abc123", status: "SUCCESS" } as any);

    renderCopilot();
    fireEvent.change(screen.getByTestId("ai-copilot-input"), { target: { value: "swap 5 usdc to xlm" } });
    fireEvent.click(screen.getByTestId("ai-copilot-send"));

    // Wait for the swap card to appear — at this point buildSwap must have been called
    await waitFor(() => screen.getByTestId("ai-copilot-swap-card"));

    // Assert the orchestration layer transformed parse intent correctly:
    // human amount "5" → base units "50000000" (7 decimals), tokens lowercased
    expect(buildSwapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenIn: "usdc",
        tokenOut: "xlm",
        amountIn: "50000000",
        maxSlippageBps: 50,
      }),
    );

    // Then click Sign
    const signBtn = await screen.findByTestId("ai-copilot-sign");
    fireEvent.click(signBtn);

    // submitSignedTx must be called exactly once
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));

    // The status badge should show the completion message
    await waitFor(() => expect(screen.getByText(/Swap complete/i)).toBeInTheDocument());
  });

  it("double-click Sign submits only once (ref guard)", async () => {
    // Mock sign hook before render
    jest.spyOn(signHook, "useSignSorobanXdr").mockReturnValue(
      jest.fn().mockResolvedValue("SIGNED_XDR"),
    );
    jest.spyOn(agentService.agentBackendService, "parseCopilot").mockResolvedValue({
      type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "USDC", tokenOut: "XLM",
    });
    jest.spyOn(swapService.bakuSwapService, "buildSwap").mockResolvedValue(SWAP_PREVIEW);
    const submitSpy = jest
      .spyOn(swapService.bakuSwapService, "submitSignedTx")
      .mockResolvedValue({ hash: "deadbeef", status: "SUCCESS" } as any);

    renderCopilot();
    fireEvent.change(screen.getByTestId("ai-copilot-input"), { target: { value: "swap 5 usdc to xlm" } });
    fireEvent.click(screen.getByTestId("ai-copilot-send"));

    const signBtn = await screen.findByTestId("ai-copilot-sign");

    // Fire two clicks synchronously — the ref guard must absorb the second
    fireEvent.click(signBtn);
    fireEvent.click(signBtn);

    // Despite two clicks, submit must be called exactly once
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
  });

  it("cross-check mismatch hides Sign button and shows error bubble", async () => {
    jest.spyOn(agentService.agentBackendService, "parseCopilot").mockResolvedValue({
      type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "USDC", tokenOut: "XLM",
    });
    // Baku echoes back a different amountIn — triggers the mismatch guard
    jest.spyOn(swapService.bakuSwapService, "buildSwap").mockResolvedValue({
      ...SWAP_PREVIEW,
      preview: {
        ...SWAP_PREVIEW.preview,
        amountIn: "99999999", // mismatch: caller expects "50000000"
      },
    });

    renderCopilot();
    fireEvent.change(screen.getByTestId("ai-copilot-input"), { target: { value: "swap 5 usdc to xlm" } });
    fireEvent.click(screen.getByTestId("ai-copilot-send"));

    // The copilot should emit a mismatch error text bubble, not a swap card
    await waitFor(() => expect(screen.getByText(/Quote mismatch/i)).toBeInTheDocument());
    // There must be no Sign button
    expect(screen.queryByTestId("ai-copilot-sign")).toBeNull();
  });

  // --- Remediation flow ---

  it("blocked on trustline → add trustline → auto-continues to the swap card", async () => {
    jest.spyOn(signHook, "useSignSorobanXdr").mockReturnValue(jest.fn().mockResolvedValue("SIGNED_XDR"));
    jest.spyOn(agentService.agentBackendService, "parseCopilot").mockResolvedValue({
      type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "XLM", tokenOut: "USDC",
    });

    // First preflight: no trustline. After remediation: ready.
    const noTrustline = { funded: true, nativeXlm: "100", usdc: { hasTrustline: false, balance: "0" } };
    jest
      .spyOn(accountStateModule, "fetchAccountState")
      .mockResolvedValueOnce(noTrustline as any) // initial handleSend preflight
      .mockResolvedValue(READY_ACCOUNT as any);  // post-remediation polls

    const addTrustlineFn = jest.fn().mockResolvedValue("trusthash");
    jest.spyOn(remediationModule, "useAddUsdcTrustline").mockReturnValue(addTrustlineFn);

    const buildSwapSpy = jest.spyOn(swapService.bakuSwapService, "buildSwap").mockResolvedValue({
      xdr: "XDR", router: "CCJ",
      preview: { venue: "soroswap", tokenIn: "xlm", tokenOut: "usdc", amountIn: "50000000", expectedOut: "650000", minOut: "646000", maxSlippageBps: 50, rate: "0.13" },
    });

    renderCopilot();
    fireEvent.change(screen.getByTestId("ai-copilot-input"), { target: { value: "swap 5 xlm to usdc" } });
    fireEvent.click(screen.getByTestId("ai-copilot-send"));

    // Remediation card appears (no swap card / buildSwap yet)
    await waitFor(() => screen.getByTestId("ai-copilot-remediation-card"));
    expect(buildSwapSpy).not.toHaveBeenCalled();

    // Tap "Add USDC trustline & continue"
    fireEvent.click(screen.getByTestId("ai-copilot-remediate"));

    // It runs the trustline, re-preflights (now ready), and presents the swap card
    await waitFor(() => expect(addTrustlineFn).toHaveBeenCalledTimes(1));
    await waitFor(() => screen.getByTestId("ai-copilot-swap-card"));
    expect(buildSwapSpy).toHaveBeenCalledTimes(1);
  });

  it("shows a shortfall with no action when XLM is insufficient", async () => {
    jest.spyOn(agentService.agentBackendService, "parseCopilot").mockResolvedValue({
      type: "swap", venue: "soroswap", amountIn: "5", tokenIn: "XLM", tokenOut: "USDC",
    });
    jest
      .spyOn(accountStateModule, "fetchAccountState")
      .mockResolvedValue({ funded: true, nativeXlm: "1", usdc: { hasTrustline: true, balance: "0" } } as any);

    renderCopilot();
    fireEvent.change(screen.getByTestId("ai-copilot-input"), { target: { value: "swap 5 xlm to usdc" } });
    fireEvent.click(screen.getByTestId("ai-copilot-send"));

    await waitFor(() => screen.getByTestId("ai-copilot-remediation-card"));
    expect(screen.getByText(/Not enough XLM/i)).toBeInTheDocument();
    expect(screen.queryByTestId("ai-copilot-remediate")).toBeNull();
  });
});
