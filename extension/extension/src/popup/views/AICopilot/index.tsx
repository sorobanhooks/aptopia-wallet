import React, { useEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";
import { Button, Input, Loader } from "@stellar/design-system";

import { publicKeySelector } from "popup/ducks/accountServices";
import { settingsNetworkDetailsSelector } from "popup/ducks/settings";
import { useSignSorobanXdr } from "popup/hooks/useSignSorobanXdr";
import { emitBalancesChanged } from "popup/helpers/balanceEvents";
import { getStellarExpertUrl } from "popup/helpers/account";
import { agentBackendService } from "api/agentBackendService";
import { bakuSwapService, SwapSymbol } from "api/bakuSwapService";
import { ChatMessage, CopilotMessage } from "./types";
import { toBaseUnits, fromBaseUnits, tokenLabel } from "./helpers";
import { fetchAccountState } from "./accountState";
import { preflightSwap, Blocker, PendingSwap, SwapDirection } from "./swapPreflight";
import { fundWithFriendbot, useAddUsdcTrustline } from "./remediation";
import "./styles.scss";

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

interface Props {
  mode?: "tab" | "page";
}

export const AICopilot = ({ mode = "tab" }: Props) => {
  const publicKey = useSelector(publicKeySelector);
  const networkDetails = useSelector(settingsNetworkDetailsSelector);
  const onMainnet = networkDetails.networkPassphrase.includes("Public");
  const signSorobanXdr = useSignSorobanXdr();
  const addUsdcTrustline = useAddUsdcTrustline();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Fix 1: synchronous in-flight guard — a ref avoids the async-paint gap that
  // state-based guards expose to fast double-clicks.
  const signingIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (publicKey) agentBackendService.setSigningKey(publicKey);
  }, [publicKey]);

  useEffect(() => {
    if (scrollRef.current && typeof scrollRef.current.scrollTo === "function") {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages]);

  const push = (m: ChatMessage) => setMessages((prev) => [...prev, m]);
  const patchSwap = (id: string, patch: Partial<Extract<CopilotMessage, { kind: "swap" }>>) =>
    setMessages((prev) =>
      prev.map((m) => (m.id === id && m.role === "copilot" && m.kind === "swap" ? { ...m, ...patch } : m)),
    );
  const patchRem = (id: string, patch: Partial<Extract<CopilotMessage, { kind: "remediation" }>>) =>
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id && m.role === "copilot" && m.kind === "remediation" ? { ...m, ...patch } : m,
      ),
    );

  const balancesLineFor = (acct: { nativeXlm: string; usdc: { hasTrustline: boolean; balance: string } }) =>
    `${acct.nativeXlm} XLM · ${acct.usdc.balance} USDC${acct.usdc.hasTrustline ? "" : " (no trustline)"}`;

  const blockerText = (b: Blocker): string => {
    switch (b.kind) {
      case "unfunded":
        return "Your account isn't funded yet on testnet.";
      case "missing_usdc_trustline":
        return "You need a USDC trustline to receive USDC.";
      case "insufficient_xlm":
        return `Not enough XLM — you need about ${b.shortfall} more.`;
      case "insufficient_usdc":
        return `Not enough USDC — you're short ${b.shortfall}.`;
    }
  };

  // Fix 3: takes an explicit message list so the just-sent user message is
  // included (the state closure in the old zero-arg version was stale).
  const buildContext = (msgs: ChatMessage[]) =>
    msgs.slice(-4).map((m) => ({
      role: m.role,
      text:
        m.role === "user"
          ? m.text
          : m.kind === "text"
            ? m.text
            : m.kind === "swap"
              ? `swap ${m.humanAmountIn} ${m.tokenIn}->${m.tokenOut}`
              : `needs ${m.blocker.kind}`,
    })) as { role: "user" | "copilot"; text: string }[];

  // Fix 2: derive anyInFlight after messages is defined
  const anyInFlight =
    busy ||
    messages.some(
      (m) =>
        m.role === "copilot" &&
        ((m.kind === "swap" && (m.status === "signing" || m.status === "submitting")) ||
          (m.kind === "remediation" && m.status === "running")),
    );

  // Builds the swap on Baku and pushes the swap preview card. Reused by the
  // initial flow and by auto-continue after a remediation.
  const proceedToSwap = async (intent: PendingSwap) => {
    const tokenIn = intent.tokenIn;
    const tokenOut = intent.tokenOut;
    const baseAmountIn = toBaseUnits(intent.amountIn);
    const build = await bakuSwapService.buildSwap({
      user: publicKey!,
      tokenIn,
      tokenOut,
      amountIn: baseAmountIn,
      maxSlippageBps: intent.slippageBps ?? 50,
    });
    if (
      build.preview.tokenIn !== tokenIn ||
      build.preview.tokenOut !== tokenOut ||
      build.preview.amountIn !== baseAmountIn
    ) {
      push({ id: nextId(), role: "copilot", kind: "text", text: "Quote mismatch — please try again." });
      return;
    }
    push({
      id: nextId(),
      role: "copilot",
      kind: "swap",
      humanAmountIn: intent.amountIn,
      tokenIn,
      tokenOut,
      build,
      status: "preview",
    });
  };

  const handleSend = async () => {
    const text = input.trim();
    // Fix 2: block send while any swap is signing/submitting
    if (!text || anyInFlight) return;
    if (!publicKey) {
      push({ id: nextId(), role: "copilot", kind: "text", text: "Unlock your wallet first." });
      return;
    }
    if (onMainnet) {
      push({ id: nextId(), role: "copilot", kind: "text", text: "The copilot is testnet-only." });
      return;
    }
    setInput("");
    // Fix 3: create the user message before pushing so we can include it in context
    const userMsg = { id: nextId(), role: "user" as const, text };
    push(userMsg);
    setBusy(true);
    try {
      const intent = await agentBackendService.parseCopilot(text, buildContext([...messages, userMsg]));
      if (intent.type === "clarification" || intent.type === "unsupported") {
        push({ id: nextId(), role: "copilot", kind: "text", text: intent.message });
        return;
      }
      // intent.type === "swap" — preflight before building.
      const tokenIn = intent.tokenIn.toLowerCase() as SwapSymbol;
      const tokenOut = intent.tokenOut.toLowerCase() as SwapSymbol;
      const direction: SwapDirection = tokenIn === "xlm" ? "xlm_to_usdc" : "usdc_to_xlm";
      const pending: PendingSwap = {
        direction,
        amountIn: intent.amountIn,
        tokenIn,
        tokenOut,
        slippageBps: intent.slippageBps,
      };

      const account = await fetchAccountState(publicKey, networkDetails);
      const pre = preflightSwap({ direction, amountIn: intent.amountIn, account });
      if (pre.status === "blocked") {
        push({
          id: nextId(),
          role: "copilot",
          kind: "remediation",
          blocker: pre.blockers[0],
          balancesLine: balancesLineFor(account),
          pendingIntent: pending,
          status: "preview",
        });
        return;
      }
      await proceedToSwap(pending);
    } catch (e) {
      push({
        id: nextId(),
        role: "copilot",
        kind: "text",
        text: e instanceof Error ? e.message : "Something went wrong.",
      });
    } finally {
      setBusy(false);
    }
  };

  // Fix 1: synchronous guard prevents double-sign/double-submit.
  // The ref check is synchronous so a fast second click is blocked before any
  // awaits run, unlike a state-based guard which has an async-paint gap.
  const handleSign = async (m: Extract<CopilotMessage, { kind: "swap" }>) => {
    if (m.status !== "preview" || signingIds.current.has(m.id)) return;
    signingIds.current.add(m.id);
    try {
      patchSwap(m.id, { status: "signing" });
      const signed = await signSorobanXdr(m.build.xdr);
      patchSwap(m.id, { status: "submitting" });
      const res = await bakuSwapService.submitSignedTx(signed);
      if (res.error || res.status === "FAILED" || res.status === "TIMEOUT") {
        patchSwap(m.id, { status: "failed", hash: res.hash, error: res.error || res.status });
        return;
      }
      patchSwap(m.id, { status: "done", hash: res.hash });
      emitBalancesChanged();
    } catch (e) {
      patchSwap(m.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    } finally {
      signingIds.current.delete(m.id);
    }
  };

  // Performs the intermediate fix (friendbot fund / add USDC trustline), re-fetches
  // fresh state until the fix lands, re-runs preflight, and auto-continues to the
  // swap. Reuses the same synchronous in-flight guard as handleSign.
  const handleRemediate = async (m: Extract<CopilotMessage, { kind: "remediation" }>) => {
    if (m.status !== "preview" || signingIds.current.has(m.id) || !publicKey) return;
    signingIds.current.add(m.id);
    try {
      patchRem(m.id, { status: "running" });

      if (m.blocker.kind === "unfunded") {
        await fundWithFriendbot(publicKey);
      } else if (m.blocker.kind === "missing_usdc_trustline") {
        await addUsdcTrustline({ publicKey, networkDetails });
      }

      // Poll fresh state until the fix lands (Horizon lag), then re-preflight.
      let account = await fetchAccountState(publicKey, networkDetails);
      for (let i = 0; i < 3; i++) {
        const stillBlocked =
          (m.blocker.kind === "unfunded" && !account.funded) ||
          (m.blocker.kind === "missing_usdc_trustline" && !account.usdc.hasTrustline);
        if (!stillBlocked) break;
        await new Promise((r) => setTimeout(r, 1500));
        account = await fetchAccountState(publicKey, networkDetails);
      }

      patchRem(m.id, { status: "done" });
      const pre = preflightSwap({
        direction: m.pendingIntent.direction,
        amountIn: m.pendingIntent.amountIn,
        account,
      });
      if (pre.status === "ready") {
        await proceedToSwap(m.pendingIntent);
      } else {
        push({
          id: nextId(),
          role: "copilot",
          kind: "remediation",
          blocker: pre.blockers[0],
          balancesLine: balancesLineFor(account),
          pendingIntent: m.pendingIntent,
          status: "preview",
        });
      }
    } catch (e) {
      patchRem(m.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    } finally {
      signingIds.current.delete(m.id);
    }
  };

  return (
    <div className={`AICopilot AICopilot--${mode}`} data-testid="ai-copilot">
      <div className="AICopilot__thread" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="AICopilot__empty">
            Try: <em>"swap 5 usd to xlm on soroswap"</em>
          </p>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="AICopilot__bubble AICopilot__bubble--user">
              {m.text}
            </div>
          ) : m.kind === "text" ? (
            <div key={m.id} className="AICopilot__bubble AICopilot__bubble--copilot">
              {m.text}
            </div>
          ) : m.kind === "remediation" ? (
            <div key={m.id} className="AICopilot__card" data-testid="ai-copilot-remediation-card">
              <div className="AICopilot__card-row">{blockerText(m.blocker)}</div>
              <div className="AICopilot__card-meta">{m.balancesLine}</div>
              {m.status === "preview" &&
                (m.blocker.kind === "unfunded" || m.blocker.kind === "missing_usdc_trustline") && (
                  <div className="AICopilot__card-actions">
                    <Button
                      size="md"
                      variant="primary"
                      data-testid="ai-copilot-remediate"
                      disabled={anyInFlight}
                      onClick={() => handleRemediate(m)}
                    >
                      {m.blocker.kind === "unfunded" ? "Get testnet XLM & continue" : "Add USDC trustline & continue"}
                    </Button>
                  </div>
                )}
              {m.status === "running" && (
                <div className="AICopilot__card-status"><Loader size="1rem" /> working…</div>
              )}
              {m.status === "failed" && <div className="AICopilot__card-status">❌ {m.error}</div>}
            </div>
          ) : (
            <div key={m.id} className="AICopilot__card" data-testid="ai-copilot-swap-card">
              <div className="AICopilot__card-row">
                <span>{m.humanAmountIn} {tokenLabel(m.tokenIn)}</span>
                <span>→</span>
                <span>≈ {fromBaseUnits(m.build.preview.expectedOut)} {tokenLabel(m.tokenOut)}</span>
              </div>
              <div className="AICopilot__card-meta">
                Min received {fromBaseUnits(m.build.preview.minOut)} {tokenLabel(m.tokenOut)} ·
                slippage {(m.build.preview.maxSlippageBps / 100).toString()}%
              </div>
              {m.status === "preview" && (
                <div className="AICopilot__card-actions">
                  {/* Fix 2: disable Sign and Cancel while any swap is in flight */}
                  <Button size="md" variant="primary" data-testid="ai-copilot-sign" disabled={anyInFlight} onClick={() => handleSign(m)}>
                    Sign &amp; Submit
                  </Button>
                  <Button size="md" variant="secondary" disabled={anyInFlight} onClick={() => patchSwap(m.id, { status: "cancelled" })}>
                    Cancel
                  </Button>
                </div>
              )}
              {(m.status === "signing" || m.status === "submitting") && (
                <div className="AICopilot__card-status"><Loader size="1rem" /> {m.status}…</div>
              )}
              {m.status === "done" && (
                <div className="AICopilot__card-status">
                  ✅ Swap complete · received ~{fromBaseUnits(m.build.preview.expectedOut)} {tokenLabel(m.tokenOut)}
                  {m.hash && (
                    <>
                      {" · "}
                      <a
                        className="AICopilot__tx-link"
                        href={`${getStellarExpertUrl(networkDetails)}/tx/${m.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View transaction ↗
                      </a>
                    </>
                  )}
                </div>
              )}
              {m.status === "failed" && <div className="AICopilot__card-status">❌ {m.error}</div>}
              {m.status === "cancelled" && <div className="AICopilot__card-status">Cancelled</div>}
            </div>
          ),
        )}
        {busy && <div className="AICopilot__bubble AICopilot__bubble--copilot"><Loader size="1rem" /></div>}
      </div>

      <div className="AICopilot__composer">
        <Input
          id="ai-copilot-input"
          fieldSize="md"
          placeholder="Message the copilot…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
          data-testid="ai-copilot-input"
        />
        {/* Fix 2: disable Send while any swap is signing/submitting */}
        <Button size="md" variant="primary" disabled={anyInFlight} onClick={handleSend} data-testid="ai-copilot-send">
          Send
        </Button>
      </div>
    </div>
  );
};
