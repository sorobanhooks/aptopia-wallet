import { test, expect } from "./test-fixtures";
import { Page, Route } from "@playwright/test";
import { loginToTestAccount } from "./helpers/login";

/**
 * Stub the SIWE-style auth endpoints.
 *
 * - /v1/auth/challenge: must return a `message` string (the background service
 *   worker will sign it with the real test-account key; signing is internal
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

test.beforeEach(async ({ page, extensionId, context }) => {
  await loginToTestAccount({ page, extensionId, context });
  await stubAgentAuth(page);
  await page.route("**/v1/copilot/parse", (route: Route) =>
    route.fulfill({
      json: {
        type: "swap",
        venue: "soroswap",
        amountIn: "5",
        tokenIn: "USDC",
        tokenOut: "XLM",
      },
    }),
  );
  await page.route("**/swap/build-tx", (route: Route) =>
    route.fulfill({
      json: {
        xdr: "XDR",
        router: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
        preview: {
          venue: "soroswap",
          tokenIn: "usdc",
          tokenOut: "xlm",
          amountIn: "50000000",
          expectedOut: "380000000",
          minOut: "378100000",
          maxSlippageBps: 50,
          rate: "7.6",
        },
      },
    }),
  );
});

test("copilot turns a sentence into a swap preview", async ({ page }) => {
  test.slow();
  await page.getByTestId("account-tab-ai_copilot").click();
  await page.getByTestId("ai-copilot-input").fill("swap 5 usd to xlm on soroswap");
  await page.getByTestId("ai-copilot-send").click();
  await expect(page.getByTestId("ai-copilot-swap-card")).toBeVisible();
  await expect(page.getByTestId("ai-copilot-sign")).toBeVisible();
});
