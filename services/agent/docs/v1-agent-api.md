# Agent HTTP API (`/v1`)

These routes are served by the paywall server Express app, mounted at **`/v1`**. They are **not** protected by the x402 payment middleware (that middleware only applies to `GET /api/v1/alerts/*`).

**Base URL:** `http://<host>:<PORT>/v1`  
Default `PORT` is `3000` unless overridden by the `PORT` environment variable.

**Path parameter `address`:** Stellar **agent wallet public key** (the `agentAddress` stored for the user). All endpoints resolve the agent with `Agent.findOne({ agentAddress: address })`.

**Security note:** There is no API key or auth on these endpoints today. Anyone who knows an agent address can read logs, rules, metrics, change rules, or trigger revoke. Treat agent addresses as sensitive identifiers if you expose this server publicly.

---

## GET `/v1/logs/:address`

Returns **paginated** `AgentLog` documents for trades and related events for that worker address.

### Query parameters

| Name   | Default | Description                                      |
|--------|---------|--------------------------------------------------|
| `page` | `1`     | Page number (1-based).                           |
| `limit`| `20`    | Page size, clamped between **1** and **100**.    |

### Success response — `200 OK`

```json
{
  "page": 1,
  "limit": 20,
  "total": 42,
  "items": [
    {
      "_id": "...",
      "agentId": "...",
      "telegramId": "...",
      "workerAddress": "G...",
      "eventType": "trade",
      "status": "success",
      "token": "XLM",
      "amount": "Buy XLM (1.0000000 USDC)",
      "txHash": "...",
      "createdAt": "2026-04-10T12:00:00.000Z"
    }
  ]
}
```

`items` are MongoDB documents (lean); fields match the `AgentLog` schema (`reason` may appear on failures).

---

## GET `/v1/rules/:address`

Returns **non-secret** trading rule fields for the agent.

### Success response — `200 OK`

```json
{
  "agentAddress": "G...",
  "buyBelowUsd": 0.1,
  "sellAboveUsd": 0.5,
  "tier1Max": 5,
  "tier2Max": 50,
  "dailyBudget": 10,
  "buyAmountUsdc": 1,
  "sellAmountXlm": 0.001
}
```

### Errors

| Status | Body                         |
|--------|------------------------------|
| `404`  | `{ "error": "Agent not found" }` |

---

## PUT `/v1/rules/:address`

Updates rules with **`findOneAndUpdate`** and **`{ new: true }`** so the response is the document **after** the update.

### Request body

JSON object. **At least one** of the following keys must be present. All values must be finite numbers.

| Field            | Description                                      |
|------------------|--------------------------------------------------|
| `buyBelowUsd`    | Buy when XLM price (USD) is at or below this.    |
| `sellAboveUsd`   | Sell when XLM price (USD) is at or above this.   |
| `tier1Max`       | Max USDC per **auto** (Tier 1) buy.              |
| `tier2Max`       | Max USDC per **confirm** (Tier 2) buy.           |
| `dailyBudget`    | Max USDC spend on buys **per UTC day**.          |
| `buyAmountUsdc`  | Fixed USDC amount to use for each buy trade.     |
| `sellAmountXlm`  | Fixed XLM amount to use for each sell trade.     |

### Validation

- After merging with the existing agent, **`tier2Max` must be strictly greater than `tier1Max`**, and **`tier1Max` must be positive**.
- **`sellAboveUsd` must be greater than `buyBelowUsd`** (using merged values for any field not sent in the body).

### Success response — `200 OK`

Same shape as **GET `/v1/rules/:address`** (updated values).

### Side effects

If the agent is **`active: true`**, the server calls **`WorkerManager.startAgentWorker(updated)`** so the polling worker picks up new rules.

### Errors

| Status | Example body |
|--------|----------------|
| `400`  | `{ "error": "No valid rule fields in body" }` |
| `400`  | `{ "error": "Invalid number for tier1Max" }` |
| `400`  | `{ "error": "tier2Max must be strictly greater than tier1Max (both positive)" }` |
| `400`  | `{ "error": "sellAboveUsd must be greater than buyBelowUsd" }` |
| `404`  | `{ "error": "Agent not found" }` |

### Example

```http
PUT /v1/rules/GABCDEFGH... HTTP/1.1
Content-Type: application/json

{
  "tier1Max": 5,
  "tier2Max": 25,
  "dailyBudget": 15
}
```

---

## GET `/v1/metrics/:address`

Returns **live balances** from the chain plus **stored** spend/limit/trade counters and agent status.

### Behavior

- Runs the same **UTC daily reset** helper as the worker: if the calendar day changed since `lastReset`, **`spentToday`** is reset to `0` in the database before the response values are read.

### Success response — `200 OK`

```json
{
  "agentAddress": "G...",
  "balances": {
    "native": "2.0000000",
    "usdc": "10.5000000",
    "assets": {
      "XLM": "2.0000000",
      "USDC:G...": "10.5000000"
    }
  },
  "dailySpentUsd": 2.31,
  "dailyLimitUsd": 10,
  "totalSuccessfulTrades": 7,
  "status": "healthy"
}
```

| Field                    | Description |
|--------------------------|-------------|
| `balances.native`        | XLM balance string from Horizon. |
| `balances.usdc`          | USDC balance string for the configured USDC asset. |
| `balances.assets`        | Full per-asset map (`XLM`, `CODE:ISSUER`). |
| `dailySpentUsd`          | USDC spent on **successful buys** today (UTC), after reset logic. |
| `dailyLimitUsd`          | Daily cap set in rules (`dailyBudget`). |
| `totalSuccessfulTrades`  | Lifetime successful trades (Tier 1 + confirmed Tier 2). |
| `status`                 | `"healthy"` if `active === true`, else `"disabled"`. |

### Errors

| Status | Body |
|--------|------|
| `404`  | `{ "error": "Agent not found" }` |

---

## POST `/v1/revoke/:address`

Drains **all transferable assets** from the agent wallet to the user’s **main wallet** (`targetWallet`), sets **`active: false`**, stops the worker, and clears Tier 2 pending state. Same core flow as the Telegram **`/revokeagent`** command.

### Success response — `200 OK`

```json
{
  "ok": true,
  "transfers": [
    {
      "token": "USDC:G...",
      "amount": "4.5000000",
      "txHash": "abc123..."
    },
    {
      "token": "XLM",
      "amount": "1.2345678",
      "txHash": "def456..."
    }
  ]
}
```

- `transfers` is empty when there are no transferable balances.

### Side effects

- Attempts to send a **Telegram message** to the agent’s `telegramId` with the standard revoke copy (including the transferred amount). Failures are logged only; the HTTP response can still be `200`.

### Errors

| Status | Body |
|--------|------|
| `404`  | `{ "error": "Agent not found" }` |
| `400`  | `{ "error": "Agent already disabled" }` |
| `500`  | `{ "error": "<message>" }` — e.g. chain / Horizon failure. |

If asset transfer **fails**, the implementation **restarts the worker** if the agent is still marked active, and returns **`500`**.

---

## Related (x402 paywall)

| Method | Path | Notes |
|--------|------|--------|
| `GET`  | `/api/v1/alerts/:token` | Paid via x402; **not** under `/v1`. |

---

## Quick reference

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/v1/logs/:address`    | Paginated agent logs |
| `GET`  | `/v1/rules/:address`   | Read rules |
| `PUT`  | `/v1/rules/:address`   | Update rules (`findOneAndUpdate`, `new: true`) |
| `GET`  | `/v1/metrics/:address` | Balances + daily spend/limit + trades + status |
| `POST` | `/v1/revoke/:address`  | Drain transferable assets, disable agent, notify Telegram |
