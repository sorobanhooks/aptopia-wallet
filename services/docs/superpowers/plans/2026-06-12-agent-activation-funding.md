# Agent Activation & Funding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension's Agents tab recognise a created-but-unfunded agent and let the user fund/activate it from a dedicated in-tab element (never the main Send button).

**Architecture:** The Agents tab (`Dashboard`) replaces its binary connected/unconnected logic with a pure state-selector that distinguishes `NO_AGENT` (404), `SERVICE_ERROR`, `NEEDS_ACTIVATION`, and `ACTIVE`. A new `AgentActivation` card renders a 3-step checklist; step 1 funds the agent via a `useFundAgent` hook that builds an explicit `createAccount` op and signs/submits through the existing `signFreighterTransaction`/`submitFreighterTransaction` redux thunks (same path YieldHub uses). The backend `/v1/metrics` response gains `funded` and `usdcTrustlineReady` so the client can choose the state.

**Tech Stack:** React 19 + Redux Toolkit (extension), `stellar-sdk` (tx build/sign/submit), Express + Mongoose (agent backend), Jest + Playwright (extension tests), `node:test`+`tsx` (agent tests).

---

## File Structure

- `agent/src/services/agent-metrics.ts` — **new**: pure `buildAgentMetricsBody()` (adds `funded`/`usdcTrustlineReady`).
- `agent/src/routes/v1.ts` — modify `/metrics/:address` to use the helper.
- `agent/__tests__/agent-metrics.test.ts` — **new**: unit tests for the helper.
- `extension/extension/src/api/types.ts` — add `funded?`/`usdcTrustlineReady?` to `AgentMetrics`.
- `extension/extension/src/api/agentBackendService.ts` — throw a typed `AgentHttpError` carrying `status`.
- `extension/extension/src/popup/views/Dashboard/selectAgentViewState.ts` — **new**: pure state-selector.
- `extension/extension/src/popup/views/Dashboard/__tests__/selectAgentViewState.test.ts` — **new**: unit tests.
- `extension/extension/src/popup/components/account/AgentActivation/index.tsx` — **new**: activation card.
- `extension/extension/src/popup/components/account/AgentActivation/buildFundingOperation.ts` — **new**: pure op builder.
- `extension/extension/src/popup/components/account/AgentActivation/useFundAgent.ts` — **new**: build→sign→submit hook.
- `extension/extension/src/popup/components/account/AgentActivation/__tests__/buildFundingOperation.test.ts` — **new**: unit tests.
- `extension/extension/src/popup/views/Dashboard/index.tsx` — wire states + activation card.
- `extension/extension/e2e-tests/agentActivation.test.ts` — **new**: e2e states.

---

## Task 1: Backend — `funded` + `usdcTrustlineReady` on `/v1/metrics`

**Files:**
- Create: `agent/src/services/agent-metrics.ts`
- Create: `agent/__tests__/agent-metrics.test.ts`
- Modify: `agent/src/routes/v1.ts:246-276`
- Modify: `agent/package.json:13` (add the new test file to `test:node`)

- [ ] **Step 1: Write the failing test**

`agent/__tests__/agent-metrics.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentMetricsBody } from '../src/services/agent-metrics';

const baseAgent = {
  agentAddress: 'GAGENT', targetWallet: 'GTARGET',
  spentToday: 0, dailyBudget: 5, totalSuccessfulTrades: 2, active: true,
};
const bal = (native: string, usdc = '0') => ({ native, usdc, assets: {} });

test('funded is false when native balance < 1 XLM (account not created)', () => {
  const body = buildAgentMetricsBody({ ...baseAgent, usdcTrustlineReady: false } as any, bal('0'), 0);
  assert.equal(body.funded, false);
  assert.equal(body.usdcTrustlineReady, false);
});

test('funded is true when native balance >= 1 XLM', () => {
  const body = buildAgentMetricsBody({ ...baseAgent, usdcTrustlineReady: true } as any, bal('3.0000000'), 0);
  assert.equal(body.funded, true);
  assert.equal(body.usdcTrustlineReady, true);
});

test('legacy agents (usdcTrustlineReady undefined) are treated as ready', () => {
  const body = buildAgentMetricsBody({ ...baseAgent } as any, bal('10'), 1);
  assert.equal(body.usdcTrustlineReady, true);
  assert.equal(body.pendingTier2Count, 1);
  assert.equal(body.agentAddress, 'GAGENT');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && node --import tsx --test __tests__/agent-metrics.test.ts`
Expected: FAIL — `Cannot find module '../src/services/agent-metrics'`.

- [ ] **Step 3: Write minimal implementation**

`agent/src/services/agent-metrics.ts`:
```ts
import type { IAgent } from './db';
import type { Balances } from './chains/types';

export interface AgentMetricsBody {
  agentAddress: string;
  balances: { native: string; usdc: string; assets: Record<string, string> };
  dailySpentUsd: number;
  dailyLimitUsd: number;
  totalSuccessfulTrades: number;
  status: 'healthy' | 'disabled';
  pendingTier2Count: number;
  funded: boolean;
  usdcTrustlineReady: boolean;
}

/** Account exists past the base reserve once it holds >= 1 XLM. */
const MIN_FUNDED_NATIVE = 1;

export function buildAgentMetricsBody(
  agent: IAgent,
  balances: Balances,
  pendingTier2Count: number,
): AgentMetricsBody {
  return {
    agentAddress: agent.agentAddress,
    balances: {
      native: balances.native,
      usdc: balances.usdc,
      assets: balances.assets ?? {},
    },
    dailySpentUsd: agent.spentToday,
    dailyLimitUsd: agent.dailyBudget,
    totalSuccessfulTrades: agent.totalSuccessfulTrades ?? 0,
    status: agent.active ? 'healthy' : 'disabled',
    pendingTier2Count,
    funded: Number(balances.native) >= MIN_FUNDED_NATIVE,
    // legacy agents omit the field → treated as ready (matches schema semantics)
    usdcTrustlineReady: agent.usdcTrustlineReady !== false,
  };
}
```

- [ ] **Step 4: Wire the route to use the helper**

In `agent/src/routes/v1.ts`, replace the body of `router.get('/metrics/:address', ...)` return (lines ~259-275) so that after computing `balances` and `pendingTier2Count` it does:
```ts
    return res.json(buildAgentMetricsBody(agent, balances, pendingTier2Count));
```
Add the import at the top of the file:
```ts
import { buildAgentMetricsBody } from '../services/agent-metrics';
```

- [ ] **Step 5: Add the test to the suite + run all agent tests**

In `agent/package.json`, append the new file to `test:node`:
```json
"test:node": "node --import tsx --test __tests__/auth.test.ts __tests__/narrate-log-guardrail.test.ts __tests__/pending-tier2-routes.test.ts __tests__/agent-metrics.test.ts",
```
Run: `cd agent && npm run test:node && npx tsc --noEmit`
Expected: all tests PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add agent/src/services/agent-metrics.ts agent/__tests__/agent-metrics.test.ts agent/src/routes/v1.ts agent/package.json
git commit -m "feat(agent): expose funded + usdcTrustlineReady on /v1/metrics"
```

---

## Task 2: Extension — `AgentMetrics` fields + typed 404 from `getMetrics`

**Files:**
- Modify: `extension/extension/src/api/types.ts:53-62`
- Modify: `extension/extension/src/api/agentBackendService.ts` (authedFetch throw + export error)
- Test: `extension/extension/src/api/__tests__/agentBackendService.test.ts` (**new**)

- [ ] **Step 1: Write the failing test**

`extension/extension/src/api/__tests__/agentBackendService.test.ts`:
```ts
import { AgentHttpError } from "../agentBackendService";

describe("AgentHttpError", () => {
  it("carries the HTTP status and message", () => {
    const err = new AgentHttpError(404, "Agent not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Agent not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension/extension && npx jest src/api/__tests__/agentBackendService.test.ts`
Expected: FAIL — `AgentHttpError` is not exported.

- [ ] **Step 3: Add the error class and throw it with status**

In `extension/extension/src/api/agentBackendService.ts`, add near the top (after imports):
```ts
/** Error thrown by agent-backend calls, carrying the HTTP status so views can
 *  distinguish 404 (no agent for this wallet) from transient/auth failures. */
export class AgentHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AgentHttpError";
  }
}
```
In `authedFetch`, replace the two throws in the `if (!res.ok)` block:
```ts
    if (!res.ok) {
      let message = res.statusText;
      if (isJson) {
        const errorData = await res.json().catch(() => null);
        if (errorData?.error) message = errorData.error;
      }
      throw new AgentHttpError(res.status, message);
    }
```

- [ ] **Step 4: Add the metrics fields to the type**

In `extension/extension/src/api/types.ts`, inside `interface AgentMetrics` add:
```ts
  /** Account exists past the base reserve (native >= 1 XLM). */
  funded?: boolean;
  /** Agent has added its USDC trustline. */
  usdcTrustlineReady?: boolean;
```

- [ ] **Step 5: Run test + typecheck**

Run: `cd extension/extension && npx jest src/api/__tests__/agentBackendService.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add extension/extension/src/api/agentBackendService.ts extension/extension/src/api/types.ts extension/extension/src/api/__tests__/agentBackendService.test.ts
git commit -m "feat(extension): AgentHttpError(status) + funded/usdcTrustlineReady on AgentMetrics"
```

---

## Task 3: Extension — Dashboard view-state selector

**Files:**
- Create: `extension/extension/src/popup/views/Dashboard/selectAgentViewState.ts`
- Test: `extension/extension/src/popup/views/Dashboard/__tests__/selectAgentViewState.test.ts`

- [ ] **Step 1: Write the failing test**

`extension/extension/src/popup/views/Dashboard/__tests__/selectAgentViewState.test.ts`:
```ts
import { selectAgentViewState, AgentViewState } from "../selectAgentViewState";
import { AgentHttpError } from "api/agentBackendService";
import { AgentMetrics } from "api/types";

const metrics = (over: Partial<AgentMetrics>): AgentMetrics => ({
  agentAddress: "GAGENT",
  balances: { native: "0", usdc: "0", assets: {} },
  dailySpentUsd: 0, dailyLimitUsd: 0, totalSuccessfulTrades: 0,
  status: "healthy", pendingTier2Count: 0, funded: false, usdcTrustlineReady: false,
  ...over,
});

describe("selectAgentViewState", () => {
  it("404 -> NO_AGENT", () => {
    expect(selectAgentViewState({ error: new AgentHttpError(404, "x") }))
      .toBe(AgentViewState.NO_AGENT);
  });
  it("non-404 error -> SERVICE_ERROR", () => {
    expect(selectAgentViewState({ error: new AgentHttpError(500, "x") }))
      .toBe(AgentViewState.SERVICE_ERROR);
    expect(selectAgentViewState({ error: new Error("network") }))
      .toBe(AgentViewState.SERVICE_ERROR);
  });
  it("found + unfunded -> NEEDS_ACTIVATION", () => {
    expect(selectAgentViewState({ metrics: metrics({ funded: false, usdcTrustlineReady: true }) }))
      .toBe(AgentViewState.NEEDS_ACTIVATION);
  });
  it("found + funded but no trustline -> NEEDS_ACTIVATION", () => {
    expect(selectAgentViewState({ metrics: metrics({ funded: true, usdcTrustlineReady: false }) }))
      .toBe(AgentViewState.NEEDS_ACTIVATION);
  });
  it("found + funded + trustline -> ACTIVE", () => {
    expect(selectAgentViewState({ metrics: metrics({ funded: true, usdcTrustlineReady: true }) }))
      .toBe(AgentViewState.ACTIVE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension/extension && npx jest src/popup/views/Dashboard/__tests__/selectAgentViewState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the selector**

`extension/extension/src/popup/views/Dashboard/selectAgentViewState.ts`:
```ts
import { AgentHttpError } from "api/agentBackendService";
import { AgentMetrics } from "api/types";

export enum AgentViewState {
  NO_AGENT = "NO_AGENT",
  SERVICE_ERROR = "SERVICE_ERROR",
  NEEDS_ACTIVATION = "NEEDS_ACTIVATION",
  ACTIVE = "ACTIVE",
}

/**
 * Decide which Agents-tab screen to show once the metrics fetch settles.
 * Pass `error` when the fetch threw, otherwise `metrics` from a 200 response.
 */
export const selectAgentViewState = ({
  metrics,
  error,
}: {
  metrics?: AgentMetrics | null;
  error?: unknown;
}): AgentViewState => {
  if (error) {
    if (error instanceof AgentHttpError && error.status === 404) {
      return AgentViewState.NO_AGENT;
    }
    return AgentViewState.SERVICE_ERROR;
  }
  if (!metrics) return AgentViewState.SERVICE_ERROR;
  const ready = metrics.funded === true && metrics.usdcTrustlineReady === true;
  return ready ? AgentViewState.ACTIVE : AgentViewState.NEEDS_ACTIVATION;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension/extension && npx jest src/popup/views/Dashboard/__tests__/selectAgentViewState.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/extension/src/popup/views/Dashboard/selectAgentViewState.ts extension/extension/src/popup/views/Dashboard/__tests__/selectAgentViewState.test.ts
git commit -m "feat(extension): Dashboard agent view-state selector (404 vs error vs activation vs active)"
```

---

## Task 4: Extension — funding operation builder (pure)

**Files:**
- Create: `extension/extension/src/popup/components/account/AgentActivation/buildFundingOperation.ts`
- Test: `extension/extension/src/popup/components/account/AgentActivation/__tests__/buildFundingOperation.test.ts`

- [ ] **Step 1: Write the failing test**

`.../AgentActivation/__tests__/buildFundingOperation.test.ts`:
```ts
import { Operation } from "stellar-sdk";
import { buildFundingOperation } from "../buildFundingOperation";

const DEST = "GBTKZLQQX57PCHPWNBPX7ZLBOV5R2ZOOJZ3Z65X33IEQFE443FZMWGPF";

describe("buildFundingOperation", () => {
  it("uses createAccount when the destination does not exist", () => {
    const op = buildFundingOperation({ destination: DEST, amount: "3", accountExists: false });
    // createAccount xdr op type
    expect((op as any).type).toBe("createAccount");
    expect((op as any).startingBalance).toBe("3");
    expect((op as any).destination).toBe(DEST);
  });
  it("uses payment of native XLM when the destination already exists", () => {
    const op = buildFundingOperation({ destination: DEST, amount: "2.5", accountExists: true });
    expect((op as any).type).toBe("payment");
    expect((op as any).amount).toBe("2.5");
    expect((op as any).asset.code).toBe("XLM");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension/extension && npx jest src/popup/components/account/AgentActivation/__tests__/buildFundingOperation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the builder**

`.../AgentActivation/buildFundingOperation.ts`:
```ts
import { Operation, Asset, xdr } from "stellar-sdk";

/**
 * Build the single operation that funds the agent address.
 * A brand-new Stellar account must be created with `createAccount` (a plain
 * `payment` fails with op_no_destination); an existing account takes a payment.
 */
export const buildFundingOperation = ({
  destination,
  amount,
  accountExists,
}: {
  destination: string;
  amount: string;
  accountExists: boolean;
}): xdr.Operation => {
  if (!accountExists) {
    return Operation.createAccount({ destination, startingBalance: amount });
  }
  return Operation.payment({ destination, asset: Asset.native(), amount });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension/extension && npx jest src/popup/components/account/AgentActivation/__tests__/buildFundingOperation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/extension/src/popup/components/account/AgentActivation/buildFundingOperation.ts extension/extension/src/popup/components/account/AgentActivation/__tests__/buildFundingOperation.test.ts
git commit -m "feat(extension): pure funding-operation builder (createAccount vs payment)"
```

---

## Task 5: Extension — `useFundAgent` hook (build → sign → submit)

**Files:**
- Create: `extension/extension/src/popup/components/account/AgentActivation/useFundAgent.ts`

This hook has no standalone unit test (it orchestrates redux thunks + the SDK; its pure logic lives in `buildFundingOperation`, already tested). It is exercised by the Task 7 e2e.

- [ ] **Step 1: Write the hook**

`.../AgentActivation/useFundAgent.ts`:
```ts
import { useState, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Horizon, TransactionBuilder, BASE_FEE } from "stellar-sdk";

import { settingsNetworkDetailsSelector } from "popup/ducks/settings";
import { publicKeySelector } from "popup/ducks/accountServices";
import {
  signFreighterTransaction,
  submitFreighterTransaction,
} from "popup/ducks/transactionSubmission";
import { AppDispatch } from "popup/App";
import { buildFundingOperation } from "./buildFundingOperation";

interface FundArgs {
  agentAddress: string;
  amount: string; // whole XLM, e.g. "3"
}

export const useFundAgent = (onSuccess?: () => void) => {
  const dispatch = useDispatch<AppDispatch>();
  const networkDetails = useSelector(settingsNetworkDetailsSelector);
  const publicKey = useSelector(publicKeySelector);
  const [isFunding, setIsFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fund = useCallback(
    async ({ agentAddress, amount }: FundArgs) => {
      setError(null);
      setIsFunding(true);
      try {
        const server = new Horizon.Server(networkDetails.networkUrl);
        const source = await server.loadAccount(publicKey);

        // Does the agent account already exist on this network?
        let accountExists = true;
        try {
          await server.loadAccount(agentAddress);
        } catch {
          accountExists = false;
        }

        const op = buildFundingOperation({ destination: agentAddress, amount, accountExists });
        const xdrTx = new TransactionBuilder(source, {
          fee: BASE_FEE,
          networkPassphrase: networkDetails.networkPassphrase,
        })
          .addOperation(op)
          .setTimeout(180)
          .build()
          .toXDR();

        const signRes = await dispatch(
          signFreighterTransaction({ transactionXDR: xdrTx, network: networkDetails.networkPassphrase }),
        );
        if (!signFreighterTransaction.fulfilled.match(signRes)) {
          throw new Error(signRes.payload?.errorMessage || "Signing was cancelled.");
        }

        const submitRes = await dispatch(
          submitFreighterTransaction({
            publicKey,
            signedXDR: signRes.payload.signedTransaction,
            networkDetails,
          }),
        );
        if (!submitFreighterTransaction.fulfilled.match(submitRes)) {
          throw new Error(submitRes.payload?.errorMessage || "Funding transaction failed.");
        }

        onSuccess?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Funding failed.");
      } finally {
        setIsFunding(false);
      }
    },
    [dispatch, networkDetails, publicKey, onSuccess],
  );

  return { fund, isFunding, error };
};
```

- [ ] **Step 2: Typecheck**

Run: `cd extension/extension && npx tsc --noEmit`
Expected: exits 0. (If `AppDispatch` is not exported from `popup/App`, use the project's existing dispatch type — grep `export type AppDispatch` and import from wherever it is defined; YieldHub already dispatches these thunks, mirror its import.)

- [ ] **Step 3: Commit**

```bash
git add extension/extension/src/popup/components/account/AgentActivation/useFundAgent.ts
git commit -m "feat(extension): useFundAgent hook builds createAccount and signs/submits via thunks"
```

---

## Task 6: Extension — AgentActivation card + wire into Dashboard

**Files:**
- Create: `extension/extension/src/popup/components/account/AgentActivation/index.tsx`
- Create: `extension/extension/src/popup/components/account/AgentActivation/styles.scss`
- Modify: `extension/extension/src/popup/views/Dashboard/index.tsx`

- [ ] **Step 1: Write the activation card**

`.../AgentActivation/index.tsx` (logic-complete; styling via `styles.scss`):
```tsx
import React, { useState } from "react";
import { Heading, Button, CopyText, Icon, Text } from "@stellar/design-system";
import { useTranslation } from "react-i18next";

import { truncatedPublicKey } from "helpers/stellar";
import { useFundAgent } from "./useFundAgent";
import "./styles.scss";

interface Props {
  agentAddress: string;
  funded: boolean;
  usdcTrustlineReady: boolean;
  onRefresh: () => void;
  onOpenTelegram: () => void;
  onManageRules: () => void;
}

const DEFAULT_FUND_AMOUNT = "3";

export const AgentActivation = ({
  agentAddress, funded, usdcTrustlineReady, onRefresh, onOpenTelegram, onManageRules,
}: Props) => {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(DEFAULT_FUND_AMOUNT);
  const { fund, isFunding, error } = useFundAgent(onRefresh);

  const amountValid = Number(amount) > 0;

  return (
    <div className="AgentActivation">
      <Heading as="h1" size="xs">{t("Activate your agent")}</Heading>

      {/* Step 1 — Fund */}
      <div className={`AgentActivation__step ${funded ? "is-done" : "is-active"}`}>
        <div className="AgentActivation__step__title">
          {funded ? <Icon.CheckCircle /> : <span>1</span>} {t("Fund agent")}
        </div>
        {!funded && (
          <>
            <div className="AgentActivation__addr">
              <span>{truncatedPublicKey(agentAddress, 8)}</span>
              <CopyText textToCopy={agentAddress} doneLabel={t("Copied!")}>
                <div className="AgentActivation__copy"><Icon.Copy01 /></div>
              </CopyText>
            </div>
            <input
              className="AgentActivation__amount"
              type="number" min="0" step="0.1" value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="agent-fund-amount"
            />
            <Text as="p" size="xs" color="gray-500">
              {t("~1 XLM stays locked as the account reserve.")}
            </Text>
            {error && <Text as="p" size="xs" color="red-500">{error}</Text>}
            <Button
              size="md" variant="primary" isFullWidth isLoading={isFunding}
              disabled={!amountValid || isFunding}
              data-testid="agent-fund-button"
              onClick={() => fund({ agentAddress, amount })}
            >
              {t("Fund agent")}
            </Button>
          </>
        )}
      </div>

      {/* Step 2 — Trustline */}
      <div className={`AgentActivation__step ${usdcTrustlineReady ? "is-done" : funded ? "is-active" : ""}`}>
        <div className="AgentActivation__step__title">
          {usdcTrustlineReady ? <Icon.CheckCircle /> : <span>2</span>} {t("Add USDC trustline")}
        </div>
        {funded && !usdcTrustlineReady && (
          <>
            <Text as="p" size="xs" color="gray-500">
              {t("Run /createtrustline in Telegram (the agent signs this itself).")}
            </Text>
            <Button size="md" variant="secondary" isFullWidth onClick={onOpenTelegram}>
              {t("Open Telegram")}
            </Button>
          </>
        )}
      </div>

      {/* Step 3 — Rules */}
      <div className="AgentActivation__step">
        <div className="AgentActivation__step__title"><span>3</span> {t("Set rules")}</div>
        {usdcTrustlineReady && (
          <Button size="md" variant="secondary" isFullWidth onClick={onManageRules}>
            {t("Set trading rules")}
          </Button>
        )}
      </div>

      <button className="AgentActivation__refresh" onClick={onRefresh}>{t("Refresh")}</button>
    </div>
  );
};
```

- [ ] **Step 2: Add minimal styles**

`.../AgentActivation/styles.scss` — basic vertical layout mirroring `Dashboard/styles.scss` card conventions:
```scss
.AgentActivation {
  display: flex; flex-direction: column; gap: 1rem; padding: 1rem;
  &__step { border: 1px solid var(--sds-clr-gray-06, #2b2b2b); border-radius: 12px; padding: 0.875rem; opacity: 0.6;
    &.is-active { opacity: 1; }
    &.is-done { opacity: 1; }
    &__title { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
  }
  &__addr { display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0; }
  &__amount { width: 100%; padding: 0.5rem; margin: 0.5rem 0; border-radius: 8px; }
  &__refresh { background: none; border: none; color: var(--sds-clr-gray-09, #888); cursor: pointer; }
}
```

- [ ] **Step 3: Wire into Dashboard**

In `extension/extension/src/popup/views/Dashboard/index.tsx`:
1. Replace the `AgentFetchStatus` enum usage with the new selector. Keep `metrics`/`recentLogs` state; add `fetchError` state.
2. In `getAgentDetails` catch, store the error: `setFetchError(e);` and on success `setFetchError(null);`.
3. Compute: `const viewState = status === AgentFetchStatus.LOADING ? "LOADING" : selectAgentViewState({ metrics, error: fetchError });` (keep a `loading` boolean separately).
4. Render branches:
   - `LOADING` → existing loader.
   - `NO_AGENT` → existing "Connect Your AI Agent" block.
   - `SERVICE_ERROR` → new block: message + `<Button onClick={getAgentDetails}>Retry</Button>`.
   - `NEEDS_ACTIVATION` → `<AgentActivation agentAddress={metrics!.agentAddress} funded={!!metrics!.funded} usdcTrustlineReady={!!metrics!.usdcTrustlineReady} onRefresh={getAgentDetails} onOpenTelegram={() => openTab(`${TELEGRAM_BOT}?start=${publicKey}`)} onManageRules={() => navigateTo(ROUTES.agentConfig, navigate)} />` (wrapped in `<Wrapper>`).
   - `ACTIVE` → existing dashboard JSX.

Concretely, add imports:
```tsx
import { AgentActivation } from "popup/components/account/AgentActivation";
import { selectAgentViewState, AgentViewState } from "./selectAgentViewState";
```
and a state field:
```tsx
const [fetchError, setFetchError] = useState<unknown>(null);
```

- [ ] **Step 4: Build the extension**

Run: `cd extension/extension && yarn build 2>&1 | tail -3`
Expected: `webpack compiled` with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add extension/extension/src/popup/components/account/AgentActivation/ extension/extension/src/popup/views/Dashboard/index.tsx
git commit -m "feat(extension): AgentActivation card + Dashboard activation/error states"
```

---

## Task 7: Extension — e2e for the activation states

**Files:**
- Create: `extension/extension/e2e-tests/agentActivation.test.ts`

- [ ] **Step 1: Write the e2e test**

`extension/extension/e2e-tests/agentActivation.test.ts` (mirrors `login.ts` helper + stub patterns in `test-fixtures.ts`):
```ts
import { test, expect } from "./test-fixtures";
import { loginToTestAccount } from "./helpers/login";

// Stub the agent backend /v1 auth + metrics so the Agents tab resolves
// deterministically without a live backend.
const stubAgentAuth = async (page: any) => {
  await page.route("**/v1/auth/challenge", (r: any) =>
    r.fulfill({ json: { nonce: "n", message: "m" } }));
  await page.route("**/v1/auth/verify", (r: any) =>
    r.fulfill({ json: { token: "t" } }));
};

const openAgentsTab = async (page: any) => {
  await page.getByText("Agents", { exact: true }).click();
};

test("unfunded agent shows the activation card with a Fund button", async ({ page, extensionId, context }) => {
  await loginToTestAccount({ page, extensionId, context });
  await stubAgentAuth(page);
  await page.route("**/v1/metrics/**", (r: any) =>
    r.fulfill({ json: {
      agentAddress: "GDDTKU5X2MS2KH2ZMEECDKJGKYH6NMTE5RPBSZ2S7OZSY533KU23EYBK",
      balances: { native: "0", usdc: "0", assets: {} },
      dailySpentUsd: 0, dailyLimitUsd: 0, totalSuccessfulTrades: 0,
      status: "healthy", pendingTier2Count: 0, funded: false, usdcTrustlineReady: false,
    } }));
  await page.route("**/v1/logs/**", (r: any) => r.fulfill({ json: { items: [] } }));
  await openAgentsTab(page);
  await expect(page.getByText("Activate your agent")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("agent-fund-button")).toBeVisible();
});

test("no agent (404) shows Connect Your AI Agent", async ({ page, extensionId, context }) => {
  await loginToTestAccount({ page, extensionId, context });
  await stubAgentAuth(page);
  await page.route("**/v1/metrics/**", (r: any) =>
    r.fulfill({ status: 404, json: { error: "Agent not found" } }));
  await openAgentsTab(page);
  await expect(page.getByText("Connect Your AI Agent")).toBeVisible({ timeout: 15000 });
});

test("backend error (500) shows the retry state, not 'no agent'", async ({ page, extensionId, context }) => {
  await loginToTestAccount({ page, extensionId, context });
  await stubAgentAuth(page);
  await page.route("**/v1/metrics/**", (r: any) =>
    r.fulfill({ status: 500, json: { error: "boom" } }));
  await openAgentsTab(page);
  await expect(page.getByText("Couldn't reach the agent service")).toBeVisible({ timeout: 15000 });
});
```

- [ ] **Step 2: Build then run the e2e**

Run: `cd extension/extension && yarn build && npx playwright test agentActivation.test.ts --retries=1 --workers=2 --reporter=line 2>&1 | tail -15`
Expected: 3 passed. (If the "Agents" tab label differs, confirm the tab trigger text in `AccountTabs`/`TabsList` and adjust `openAgentsTab`.)

- [ ] **Step 3: Commit**

```bash
git add extension/extension/e2e-tests/agentActivation.test.ts
git commit -m "test(extension): e2e for agent activation / no-agent / service-error states"
```

---

## Self-Review

**Spec coverage:**
- Detection states (NO_AGENT/SERVICE_ERROR/NEEDS_ACTIVATION/ACTIVE) → Tasks 2, 3, 6. ✓
- Activation card 3-step → Task 6. ✓
- In-extension funding via createAccount, isolated from Send → Tasks 4, 5, 6. ✓
- Backend `funded`/`usdcTrustlineReady` → Task 1. ✓
- Error handling (insufficient/reject/submit-fail/service-error retry) → Tasks 5 (hook error), 6 (retry branch). ✓
- Testing (unit + backend unit + e2e) → Tasks 1, 2, 3, 4, 7. ✓
- Non-goals respected (no trustline endpoint, no Send-button change). ✓

**Type consistency:** `AgentViewState` enum used identically in Task 3 and Task 6; `AgentHttpError(status)` defined in Task 2, used in Tasks 2 and 3; `buildFundingOperation({destination,amount,accountExists})` defined in Task 4, called in Task 5; `AgentMetrics.funded/usdcTrustlineReady` added in Task 2, produced by Task 1, consumed in Tasks 3 and 6.

**Placeholder scan:** Two intentional "if it differs, confirm…" notes (AppDispatch import in Task 5; Agents tab label in Task 7) are verification hints, not placeholders — every step has runnable code/commands.
