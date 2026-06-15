import { test, expect } from "./test-fixtures";
import { Page, Route } from "@playwright/test";
import { loginToTestAccount } from "./helpers/login";

/**
 * Stub the SIWE-style auth endpoints.
 *
 * - /v1/auth/challenge: must return a `message` string (the background service
 *   worker will sign it with the real test-account key; the signing is internal
 *   extension messaging, not an HTTP call, so page.route can't intercept it).
 * - /v1/auth/verify: we accept any signature and return a long-lived test JWT.
 */
const stubAgentAuth = async (page: Page) => {
  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await page.route("**/v1/auth/challenge", (route: Route) =>
    route.fulfill({
      json: {
        nonce: "testnonce",
        domain: "localhost",
        statement: "Sign in to Xyra Agent",
        issuedAt: new Date().toISOString(),
        expiresAt: futureExpiry,
        message: "Xyra Agent sign-in test",
      },
    }),
  );
  await page.route("**/v1/auth/verify", (route: Route) =>
    route.fulfill({
      json: {
        token: "test-jwt-token",
        expiresAt: futureExpiry,
      },
    }),
  );
};

/** Stub logs endpoint so Dashboard's post-metrics fetch doesn't hang. */
const stubAgentLogs = async (page: Page) => {
  await page.route("**/v1/logs/**", (route: Route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, limit: 20 } }),
  );
};

/** Minimum unfunded metrics — funded:false triggers NEEDS_ACTIVATION path. */
const UNFUNDED_METRICS = {
  agentAddress: "GDDTKU5X2MS2KH2ZMEECDKJGKYH6NMTE5RPBSZ2S7OZSY533KU23EYBK",
  balances: { native: "0", usdc: "0" },
  dailySpentUsd: 0,
  dailyLimitUsd: 0,
  totalSuccessfulTrades: 0,
  status: "healthy",
  pendingTier2Count: 0,
  funded: false,
  usdcTrustlineReady: false,
};

/**
 * Click the "Agents" tab in the Account view's tab strip.
 * data-testid is "account-tab-agent_dashboard" (TabsList.AGENT_DASHBOARD).
 */
const openAgentsTab = async (page: Page) => {
  await page.getByTestId("account-tab-agent_dashboard").click();
};

test.beforeEach(async ({ page, extensionId, context }) => {
  await loginToTestAccount({ page, extensionId, context });
  await stubAgentAuth(page);
  await stubAgentLogs(page);
});

test("unfunded agent shows the activation card with a Fund button", async ({
  page,
}) => {
  test.slow();
  await page.route("**/v1/metrics/**", (route: Route) =>
    route.fulfill({ json: UNFUNDED_METRICS }),
  );
  await openAgentsTab(page);
  await expect(page.getByText("Activate your agent")).toBeVisible();
  await expect(page.getByTestId("agent-fund-button")).toBeVisible();
});

test("no agent (404) shows Connect Your AI Agent", async ({ page }) => {
  test.slow();
  await page.route("**/v1/metrics/**", (route: Route) =>
    route.fulfill({ status: 404, json: { error: "Agent not found" } }),
  );
  await openAgentsTab(page);
  await expect(page.getByText("Connect Your AI Agent")).toBeVisible();
});

test("backend error (500) shows the retry state, not 'no agent'", async ({
  page,
}) => {
  test.slow();
  await page.route("**/v1/metrics/**", (route: Route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  await openAgentsTab(page);
  await expect(
    page.getByText("Couldn't reach the agent service"),
  ).toBeVisible();
});
