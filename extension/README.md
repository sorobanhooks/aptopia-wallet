# Freighter Web Extension

Freighter is a secure web extension for the Stellar network that enables users to manage their assets, interact with decentralized applications, and utilize automated trading agents.

# Sorobanhooks Smart Wallet

A secure Stellar wallet extension for managing assets, interacting with decentralized applications, and utilizing automated trading agents.

## Core Technology
This extension leverages the **[stellar-wallet-sdk](https://www.npmjs.com/package/stellar-wallet-sdk)** for core wallet functionalities. While the SDK covers most wallet operations, this project extends it to support advanced features like the Agent Dashboard and custom automation.

## Agent Dashboard
The Agent Dashboard provides a comprehensive interface for managing automated trading agents:
- **Activity Monitoring**: View real-time, paginated logs for agent trades and events.
- **Rule Management**: Dynamically configure trading thresholds, including:
    - `buyBelowUsd` / `sellAboveUsd` price targets.
    - Tiered trade limits (`tier1Max`, `tier2Max`).
    - `dailyBudget` caps.
- **Live Metrics**: Monitor agent health, including XLM/USDC balances, daily spending, and lifetime trade success stats.
- **One-Click Revocation**: Instantly disable agents and drain USDC back to the main wallet in case of emergencies.

## Integration Details
- **Backend Service**: Dedicated instance running at [https://agent.sorobanhooks.xyz](https://agent.sorobanhooks.xyz)
- **Telegram Bot**: Interface with your wallet via the Xyra Bot: [https://t.me/Sorobanhooks_wallet_agent_bot](https://t.me/Sorobanhooks_wallet_agent_bot)

## Demo

[![Sorobanhooks Smart Wallet Demo](https://img.youtube.com/vi/_CUyHERtdqw/0.jpg)](https://www.youtube.com/watch?v=_CUyHERtdqw)

## Get Started

### Configure the Environment

You will need to configure the backend and bot settings by creating an `.env` file at the path `extension/.env`. Use `.env.example` as a template.

Key configuration variables:
- `INDEXER_URL`: Primary backend API (e.g., `https://freighter-backend-prd.stellar.org/api/v1`)
- `BACKEND_URL`: Agent API host (`https://agent.sorobanhooks.xyz`)
- `TELEGRAM_BOT`: Bot link (`https://t.me/Sorobanhooks_wallet_agent_bot`)
- `STELLAR_NETWORK`: Target network (e.g., `testnet` or `public`)
- `API_KEY`: Required for fetching token prices and Soroban RPC metadata.

#### How to get an API Key
1. Sign up at **[sorobanhooks.xyz](https://www.sorobanhooks.xyz/)**.
2. Navigate to **Account settings** in the sidebar (or go directly to [sorobanhooks.xyz/settings](https://www.sorobanhooks.xyz/settings)).
3. In the **Account Details** section, copy your existing API key or generate a new one.


### Build the extension and install it on your machine

We will compile the code for the extension and then load this package into your
browser.

Run

```
yarn build
```

You may also choose to enable some experimental features by alternatively
running

```
yarn build:experimental
```

To install on Chrome:

1. In Chrome, navigate to `chrome://extensions/`.

2. Toggle `Developer mode` to the ON position in the top right corner

3. You will now see a button in the top left titled `Load Unpacked`

4. Click `Load Unpacked` and it will open your file system.

5. Navigate to this folder (`/extension`) and click the `build` folder. Hit
   `Select`. You should now see an icon for the extension in Chrome.

To install on Firefox:

1. In Firefox, navigate to about:debugging#/runtime/this-firefox

2. Click `Load Temporary Add-On`

3. Navigate to this folder (`/extension`) and open the `build` folder and find
   `manifest.json`. Hit `Select`. You should now see an icon for the extension in
   Firefox

### Build the extension using production settings

When we build for the app store, we will minify our code and enable some
security guardrails. In order to do that, run

```
yarn build:production
```

Note that when you build using this setting and install locally, you will NOT be
able to connect to it using a dev server (mentioned in the next stop)

### Create a dev environment for the Popup and Playground to run in

Next we'll spin up a dev environment. Here, you can access the `popup` in your
browser, so you can make edits with the benefit of hot reloads. This dev
environment will be able to make calls to the installed version of the
extension, so it has all the capabilites of the `popup` inside the extension.

_NOTE: This dev environment only works for the `popup`_

Changes to `background` and `content script` will still require a production
build using `yarn build`, followed by reloading the extension in Chrome.

1. Start a local dev server by running

```
yarn start
```

You should be able to access the Popup by going to `localhost:9000/`

You can also set the `experimental` flag to true by running

```
yarn start:experimental
```

This will enable some features hidden by the `experimental` feature flag that
are still under development.

### Integration Tests

_WARNING: running the intergration tests will clear the apps data_

Steps:

1. Build the extension in experimental mode

```
yarn build:experimental
```

2. Start the dev server

```
yarn start
```

3. Go to the integration tests route

```
localhost:9000/#/integration-test
```

Errors, if any, will be in the console logs.

### Blockaid Debug Override (Development Only)

When developing or testing Blockaid security warnings, you can override the Blockaid scan results to simulate different security states. This feature is only available in development mode.

**Steps:**

1. Build the extension in development mode:

   ```
   yarn build
   ```

2. Start the dev server:

   ```
   yarn start
   ```

3. Navigate to the Debug page:

   ```
   localhost:9000/#/debug
   ```

4. In the "Blockaid Response Override" section, click one of the security level buttons:

   - **Safe**: Simulates a safe transaction (no warnings)
   - **Suspicious**: Simulates a suspicious transaction (warning banner)
   - **Malicious**: Simulates a malicious transaction (error banner)
   - **Unable to Scan**: Simulates an unable-to-scan state (warning banner)

5. The override will persist across page reloads and will affect all Blockaid scans until you click "Clear Override".

**Important Notes:**

- The override state is stored in local storage and only works in development builds. Production builds will ignore any override state.
- **Error messages/details are only injected for "Unable to Scan" overrides.** When overriding to "Malicious" or "Suspicious", the warning banners will appear, but the expanded detail view may show a blank list of rows. This is because the backend will not return actual malicious/suspicious threat data - it only returns real scan results. The override only forces the security level classification, not the detailed threat information.

### Analytics Debug Panel (Development Only)

The Debug page (`/#/debug`) includes an **Analytics Debug** section that shows real-time Amplitude event activity. This is useful for verifying that screen-view and interaction metrics fire correctly during development.

**What it shows:**

- **Initialized** — Whether the Amplitude SDK has been initialized.
- **API Key** — Whether an `AMPLITUDE_KEY` is configured (does not reveal the key).
- **User ID** — The anonymous metrics user ID stored in local storage.
- **Sending to Amplitude** — `Yes` only when the SDK is initialized, an API key is set, and the user has data sharing enabled.
- **Recent Events** — A scrollable list of the last 50 events with timestamps and expandable property payloads.

**How events are stored:**

- Events are persisted to `localStorage`, so they are **shared across all extension tabs** and survive page refreshes.
- Events are automatically flushed after **10 minutes** (TTL). Stale entries are filtered out on every read.
- Debug events are only recorded in development builds (`isDev`). Production builds never write to this buffer.
- Events are recorded regardless of the data-sharing preference, so you can test metrics in dev even with data sharing disabled.

**Testing events:**

1. Set up your `.env` with an `AMPLITUDE_KEY` (optional — events are logged to the debug panel even without a key):

   ```
   AMPLITUDE_KEY=your_key_here
   ```

2. Start the dev server:

   ```
   yarn start
   ```

3. Navigate around the extension (e.g., open Send, Swap, Settings). Each screen transition emits a `loaded screen: *` event.

4. Open the Debug page at `localhost:9000/#/debug` to see the captured events.

5. Click **Clear** to reset the event list.

## Project Setup

This app has 3 main components that are named using extension nomenclature. All
of these are located in the `src/` folder:

1. The UI that appears when you click on the extension in your browser. This
   code also controls the fullscreen authentiction flow and any popups triggered
   by the extension. This is all controlled by one React app. In web extension
   parlance, this is called the `popup` and is therefore located in `src/popup`.

2. The "backend" service. We want to do things like account creation and store
   sensitive data, like public keys, in a secure place away from the `popup` and
   away from the `content script`. We want this service to be a standalone
   entity that these other 2 can make requests to and receive only what the
   backend sees fit. In web extension terms, this is known as the `background`
   script and is instantiated by `public/background`. The code is located in
   `src/background`.

   This script is run by the extension on browser starts and continues running,
   storing data and listening/responding to messages from `popup` and
   `content script`, and only terminates on browser close (or extension
   uninstall/reload). It is run in a headless browser, so it has access to all
   Web APIs. It also has accessible dev tools, which can be reached by going to
   `chrome://extensions/` or `about:debugging#/runtime/this-firefox` and
   clicking `service worker`

3. The `content script` that allows external sites to send and receive messages
   to `background`. Using an event listener, it waits for an application to
   attempt to communicate using `@stellar/freighter-api`(under the hood,
   `window.postMessage`). Once it picks up a message and determines that this
   from `freighter-api`, it sends the message onto `background`.
