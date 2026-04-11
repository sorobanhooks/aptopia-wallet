# X402 Proxy Agent: Autonomous Stellar Trading Bot

A sophisticated Trading Agent for the Stellar network that uses the **X402 Protocol** to paywall price data. The system features a Telegram-based interface for management and an autonomous background worker for executing trades based on user-defined rules.

## ✨ Key Features

- **Autonomous Trading**: Background workers poll prices every 30s and execute swaps automatically or via prompts.
- **Telegram Control**: Complete management via bot commands (`/setrules`, `/status`, `/agentlog`).
- **Tiered Risk Management**:
  - **Tier 1 (Auto)**: Micro-trades executed instantly without user intervention.
  - **Tier 2 (Confirmed)**: Larger trades that require a "Confirm" button click in Telegram.
- **X402 Paywall Proxy**: A built-in Express server that monitors and paywalls data requests, ensuring a "Pay-for-Data" ecosystem.
- **Asset Protection**: `/revokeagent` drains all agent funds back to a secure target wallet and disables the worker.

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18+
- **MongoDB**: For storing agent configurations and trade logs.
- **Redis**: For price caching and upstream protection.
- **Telegram Bot Token**: Obtain from [@BotFather](https://t.me/botfather).

### 2. Setup
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Configure your environment:
   ```bash
   cp .env.example .env
   # Edit .env with your MONGODB_URI, REDIS_URL, and TELEGRAM_BOT_TOKEN
   ```
3. Start the system:
   ```bash
   # Development
   npm run dev

   # Production
   npm run build
   npm start
   ```

## 🤖 Telegram Commands

- `/createagent <target_wallet>` - Setup a new XLM trading agent wallet.
- `/setrules` - Interactive setup for price thresholds, tier limits, and daily budgets.
- `/status` - Check balances, active rules, and lifetime success stats.
- `/agentlog` - View the last 5 trade actions (success or failure reasons).
- `/revokeagent` - Drain agent assets to your main wallet and disable the bot.

## 🛠 Management & Dashboard API

These routes provide programmatic access to agent data and are typically used by a dashboard frontend. Note: These routes are **not** paywalled.

| Route | Method | Description |
| :--- | :--- | :--- |
| `/v1/rules/:address` | `GET` | Fetch trading thresholds and tier limits. |
| `/v1/rules/:address` | `PUT` | Update thresholds, tiers, and budget rules. |
| `/v1/metrics/:address` | `GET` | Get live balances, success stats, and health status. |
| `/v1/logs/:address` | `GET` | Get paginated history of all trade attempts. |
| `/v1/revoke/:address` | `POST` | Disables the agent and drains funds to target wallet. |

> [!TIP]
> For full technical details, including JSON request/response schemas and validation rules, please refer to the **[Extended API Documentation](./docs/v1-agent-api.md)**.

## 🛠 Technical Flow

For a deep dive into the system architecture, polling cycles, and security mechanisms, see the **[FLOW.md](./FLOW.md)** file.

## 📡 API Endpoints (Paywalled)

The system also acts as a proxy for Sorobanhooks data:
- `GET /api/v1/alerts/:token` - Requires a micro-payment via X402 (Standard price $0.001 USDC).
- `GET /health` - System health check.

---

*Note: This project is designed for the Stellar Network (Testnet by default). Ensure you configure the `NETWORK` env var correctly for Mainnet usage.*

