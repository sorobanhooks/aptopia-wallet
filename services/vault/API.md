# Baku API — testnet reference

Bun + Hono. No auth (per design doc — outside-voice review concluded a static
key shipped in the wallet bundle is theatre; the 3s TTL cache on `/balance`
plus Soroban RPC's own throttling are the real DoS mitigation).

## Live deployment (testnet)

Both vaults are live. **vault-xlm v2** (deployed **2026-05-27**) carries three
real strategies — Mock, Blend lending, and Soroswap LP — and supports atomic
fund rotation via `vault.rebalance`. **vault-usdc** carries BlendStrategy.

| Contract / Asset       | Address                                                    |
|------------------------|------------------------------------------------------------|
| Vault — bkuXLM (v2, rebalance-capable) | `CCY337D4WZ6OECCTQMWIMWT2CHBC73YY5JFRKBJ665O654KMUG3CP7YH` |
| BlendStrategy (XLM, auth-fixed) | `CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ` (active) |
| SoroswapStrategy (XLM ↔ Circle USDC, swap-and-hold) | `CA4SKYV4O34KJA7TEA36GRDZJK3OZ2FN6QON4QDRA27V7RMPLJTGQHOS` (registered) |
| MockStrategy (XLM)     | `CCPRW7VCQIU7SVR6EMRPDDYKZL5C5QM3NR56NKMQ44EFWNZS76QOR67X` (registered, inactive) |
| Pre-auth-fix Blend (registered, do-not-use) | `CCQOTUKV6OWMG5EHYR24SOWPVQ3W5D4NRTHAOQ6KXXQ27PUEEBEVVNYO` |
| Pre-auth-fix Soroswap (registered, do-not-use) | `CASQ54NUBCMPW74WNEPIF54SELTUHNRP7CU5FNZCN2RPTLGO7MLDMKBK` |
| Vault — stUSDC         | `CDEOKPUFZT7XL5XITZWUTVD2VBU2NDEVA5EL7XXLMKP6INML4EHIEXNL` |
| BlendStrategy (USDC)   | `CDVPZOJTAP5X2XLRYWSLFCRKE5KNV4ZMPWB6NPSGWWT3YKSTQTM5YFSG` (active) |
| Native XLM SAC         | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| USDC SAC (Blend testnet) | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| USDC SAC (Circle testnet) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Blend V2 pool (XLM + USDC reserves) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| BLND reward token      | `CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF` |
| Soroswap V2 router     | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| Soroswap pair — XLM ↔ Circle USDC | `CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS` |
| Admin / deployer       | `GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV` |
| Network passphrase     | `Test SDF Network ; September 2015` |
| Soroban RPC            | `https://soroban-testnet.stellar.org` |

> Legacy vault-xlm (v1, no `rebalance` method) lives at
> `CCDEEXUU25RUOZVSYCSJPX35QKPZTDBAT6UFW6GTC633LV3TLOXMDOLD`. It still holds
> ~101 XLM of admin test funds redeemable from the v1 contract address
> directly. The API now points at the v2 vault.

> `vault-xlm v2` carries MockStrategy, BlendStrategy and SoroswapStrategy in
> its registry; BlendStrategy is the active strategy at deploy time. Admin
> can rotate funds between Blend and Soroswap atomically with
> `vault.rebalance(admin, to_strategy)` — funds are withdrawn from the
> current active and deposited into `to_strategy` in a single transaction,
> bypassing the V0 "drain-first" constraint of `set_active_strategy`.

> SoroswapStrategy transacts against the Soroswap V2 XLM/Circle-USDC pair
> (`CCBX3NZT…7RQS`, ~$950k testnet depth) using a swap-and-hold design (no
> add_liquidity, no LP tokens). On deposit it swaps half of the XLM to Circle
> USDC via the router and holds the `(XLM, USDC)` basket; on withdraw it swaps
> the proportional USDC slice back to XLM and returns the asset. It earns no LP
> fees — it pays the ~0.30% swap fee per leg instead. Slippage tolerance is
> admin-tunable via `set_max_slippage_bps` (default 100 bps = 1%).

## Run the API locally

```bash
cd api
bun install
bun run dev    # http://localhost:8787
```

Environment variables (all optional, defaults shown):

| Var                  | Default                                  | Notes |
|----------------------|------------------------------------------|-------|
| `PORT`               | `8787`                                   | HTTP port |
| `NETWORK`            | `testnet`                                | `testnet` or `mainnet` |
| `SOROBAN_RPC_URL`    | `https://soroban-testnet.stellar.org`    | |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015`      | |
| `ADMIN_ADDR`         | the testnet admin                        | Used as source account for read-only simulations |

## Endpoints

### `GET /`
Inventory. Lists every endpoint.

### `GET /health`
```json
{ "ok": true, "t": "2026-05-23T09:42:07.722Z" }
```

### `GET /addresses`
Returns the full `NetworkAddresses` struct for the active network.

```bash
curl -s http://localhost:8787/addresses | jq
```

### `GET /vault/:asset/state`
Read-only on-chain state for a vault. `asset` ∈ {`xlm`, `usdc`}.

```bash
curl -s http://localhost:8787/vault/xlm/state | jq
```

```json
{
  "network": "testnet",
  "asset": "xlm",
  "vault": "CCY337D4WZ6OECCTQMWIMWT2CHBC73YY5JFRKBJ665O654KMUG3CP7YH",
  "activeStrategy": "CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ",
  "totalAssets": "1000000000",
  "totalSupply": "1000000000000000",
  "pricePerShare": "10000000",
  "poolApyBps": 500,
  "strategyPositions": [
    {
      "address": "CMOCKXXXXX...",
      "name": "Mock (CMOCKX…)",
      "isActive": false,
      "currentValue": "0",
      "sharePercent": 0
    },
    {
      "address": "CAGIMEB3MLO6AV5F2WZXGOI6KEQ7MNWA4TKOORP5IGDSTIR7UBRCKBUJ",
      "name": "Blend",
      "isActive": true,
      "currentValue": "1000000000",
      "sharePercent": 100
    },
    {
      "address": "CA4SKYV4O34KJA7TEA36GRDZJK3OZ2FN6QON4QDRA27V7RMPLJTGQHOS",
      "name": "Soroswap",
      "isActive": false,
      "currentValue": "0",
      "sharePercent": 0
    }
  ]
}
```

- `totalAssets`, `totalSupply`, `pricePerShare` are **i128 decimal strings** (BigInt-safe).
- `pricePerShare` is the underlying value of `10_000_000` shares (one whole token at 7 decimals). When the vault is empty the virtual-offset math returns `10` (10 base units of underlying per 10⁷ shares = 1.0 stXLM per XLM).
- `poolApyBps` is the strategy's admin-set APY in basis points (`500` = 5%).
- `strategyPositions` is a per-strategy breakdown of vault assets. Each entry:
  - `address` — strategy contract address.
  - `name` — human-readable label (`"Blend"`, `"Soroswap"`, `"DeFindex"`, or `"Mock (<prefix>…)"`).
  - `isActive` — `true` for the vault's currently active strategy.
  - `currentValue` — i128 decimal string; what `strategy.current_value()` returns right now.
  - `sharePercent` — `currentValue / sum(all currentValues) * 100`; 0 when vault TVL is zero.
- `strategyPositions` is cached **30 seconds** per `(network, asset)` pair to limit Soroban RPC fan-out.

### `GET /vault/:asset/strategies`
Registered strategy list with the active marker.

```bash
curl -s http://localhost:8787/vault/xlm/strategies | jq
```

```json
{
  "network": "testnet",
  "asset": "xlm",
  "vault": "CAJWBCG33MGN5EA7MKI27KDKUKLFYZS7OS47D4XRIAWBWSUIFVAAB7GL",
  "active": "CCLGXUI2L4IUNACRPHHX3LZJ5GKW2HDMXOXATVKO3VEIYVA6QLD65H7T",
  "registered": [
    { "address": "CCLGXUI2L4IUNACRPHHX3LZJ5GKW2HDMXOXATVKO3VEIYVA6QLD65H7T", "isActive": true }
  ]
}
```

### `POST /vault/:asset/deposit/build-tx`
Build (don't sign) a deposit transaction. Returns base64 XDR for the wallet to sign.

```bash
curl -s -X POST http://localhost:8787/vault/xlm/deposit/build-tx \
  -H 'content-type: application/json' \
  -d '{
    "user": "GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV",
    "amount": "1000000000"
  }' | jq
```

- `user` — Stellar account public key (`G...`). Must exist on-chain (the simulator reads the seq num from the source account).
- `amount` — i128 decimal string, in base units of the underlying. For XLM that's stroops (1 XLM = 10⁷ stroops). The example deposits 100 XLM.

```json
{
  "xdr": "AAAAAgAAAACscAmvESvi...",
  "vault": "CAJWBCG33MGN5EA7MKI27KDKUKLFYZS7OS47D4XRIAWBWSUIFVAAB7GL",
  "asset": "xlm"
}
```

### `POST /vault/:asset/withdraw/build-tx`
Build a redeem transaction with on-chain slippage floor.

```bash
curl -s -X POST http://localhost:8787/vault/xlm/withdraw/build-tx \
  -H 'content-type: application/json' \
  -d '{
    "user": "GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV",
    "shares": "500000000000000",
    "max_slippage_bps": 100
  }' | jq
```

- `shares` — number of vault shares to burn (i128 decimal string).
- `max_slippage_bps` — optional, default `100` (= 1%). Server reads
  `vault.preview_redeem(shares)`, computes
  `min_out = expected * (10000 - max_slippage_bps) / 10000`, and bakes
  `min_out` into the contract call. The vault enforces the floor on-chain:
  if the strategy delivers less than `min_out`, the redeem reverts with
  `VaultError::SlippageExceeded` and the user keeps their shares.

```json
{
  "xdr": "AAAAAgAAAACscAmvESvi...",
  "vault": "CAJWBCG33MGN5EA7MKI27KDKUKLFYZS7OS47D4XRIAWBWSUIFVAAB7GL",
  "asset": "xlm",
  "preview": {
    "expected": "500000000",
    "minOut":   "495000000",
    "maxSlippageBps": 100
  }
}
```

### `POST /swap/build-tx`
Build (don't sign) a direct Soroswap token-swap transaction. Returns base64 XDR for the wallet to sign and submit via `POST /tx/submit`.

```bash
curl -s -X POST http://localhost:8787/swap/build-tx \
  -H 'content-type: application/json' \
  -d '{
    "user": "GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV",
    "tokenIn": "usdc",
    "tokenOut": "xlm",
    "amountIn": "5000000",
    "maxSlippageBps": 50
  }' | jq
```

- `user` — Stellar account public key (`G...`). The simulator runs as this account, so the wallet must hold `amountIn` of `tokenIn` and be able to receive `tokenOut`.
- `tokenIn` / `tokenOut` — token symbol, must be `"xlm"` or `"usdc"`. The two must differ.
- `amountIn` — i128 decimal string in base units (7 decimals). `"5000000"` = 0.5 tokens. Must be a positive integer string (no decimals).
- `maxSlippageBps` — optional, default `50` (= 0.5%). The server simulates `swap_exact_tokens_for_tokens` with `amountOutMin = 0` to read `expectedOut`, then computes `minOut = expectedOut * (10000 - maxSlippageBps) / 10000` and bakes that floor into the XDR. The Soroswap router enforces it on-chain — if liquidity shifts before submission and the actual output falls below `minOut`, the transaction reverts.

> **Token note:** `usdc` resolves to the **Circle USDC** SAC (`CBIELTK6…XQDAMA`) used on the live Soroswap XLM/USDC pair — **not** the Blend-pool USDC SAC. Ensure the user's wallet holds Circle USDC (not Blend USDC) when selling USDC, and that it has a Circle USDC trustline established when buying USDC.

```json
{
  "xdr": "AAAAAgAAAACscAmvESvi...",
  "router": "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  "preview": {
    "venue": "soroswap",
    "tokenIn": "usdc",
    "tokenOut": "xlm",
    "amountIn": "5000000",
    "expectedOut": "38000000",
    "minOut": "37810000",
    "maxSlippageBps": 50,
    "rate": "7.6"
  }
}
```

- `xdr` — unsigned Soroban transaction envelope; pass to `POST /tx/submit` after the wallet signs it.
- `router` — Soroswap V2 router contract used (matches the `soroswapRouter` in `/addresses`).
- `preview.expectedOut` — simulated output in base units (i128 decimal string); display-only estimate.
- `preview.minOut` — the slippage floor baked into the XDR (i128 decimal string). The on-chain swap will revert if it cannot deliver at least this amount.
- `preview.rate` — `expectedOut / amountIn` as a string; display-only.

### `POST /tx/submit`
Submit a signed Soroban transaction. Use this when the wallet can sign but
not submit (e.g. an embedded signer). The API polls Soroban RPC for up to 30
seconds for terminal status.

```bash
# Sign locally with the stellar CLI:
SIGNED=$(echo "$XDR" | stellar tx sign --sign-with-key admin --network testnet)
curl -s -X POST http://localhost:8787/tx/submit \
  -H 'content-type: application/json' \
  -d "{\"signed_xdr\":\"$SIGNED\"}" | jq
```

```json
{
  "hash": "d87899c79762136f694689ca91a985b02f4ef9b9690af58f6ef52956e97e5f1e",
  "status": "SUCCESS",
  "returnValue": "500000000"
}
```

`returnValue` is the contract's return (as a string for i128 / address, or
recursively for structs). For `deposit` it's the shares minted; for `redeem`
it's the actual amount delivered.

### `GET /balance/:address`
Aggregated balance across share tokens and underlying SACs. Backed by a
**3-second TTL cache** keyed on `network:address` (HANDOFF §I8) — protects
RPC quota from wallets that refresh in a tight loop.

```bash
curl -s "http://localhost:8787/balance/GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV" | jq
```

```json
{
  "network": "testnet",
  "address": "GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV",
  "stxlm": "1000000000000000",
  "stusdc": "0",
  "xlm": "99872029284",
  "usdc": "0"
}
```

- All values are i128 decimal strings in base units (7 decimals for XLM/USDC/vault-shares).
- A missing balance entry on-chain for an SAC (account never held the token) is swallowed to `"0"` rather than 5xxing.
- A missing balance entry on-chain (uninitialized SAC balance for the
  account) is returned as `0` rather than a 5xx — wallets should treat
  `"0"` as "no position yet."

## End-to-end demo (admin signer)

This is exactly the flow the API was validated against on 2026-05-23.

```bash
# 0. Confirm admin balance + vault is empty
curl -s http://localhost:8787/vault/xlm/state | jq

# 1. Build deposit tx for 100 XLM (= 10⁹ stroops)
XDR=$(curl -s -X POST http://localhost:8787/vault/xlm/deposit/build-tx \
  -H 'content-type: application/json' \
  -d '{"user":"GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV","amount":"1000000000"}' \
  | jq -r .xdr)

# 2. Sign with admin (any signing path the wallet supports works)
SIGNED=$(echo "$XDR" | stellar tx sign --sign-with-key admin --network testnet)

# 3. Submit through the API
curl -s -X POST http://localhost:8787/tx/submit \
  -H 'content-type: application/json' \
  -d "{\"signed_xdr\":\"$SIGNED\"}" | jq

# 4. Verify on-chain state moved
curl -s http://localhost:8787/vault/xlm/state | jq
# expect totalAssets = 1000000000, totalSupply = 1000000000000000 (virtual-offset share math)

# 5. Redeem half the shares
XDR=$(curl -s -X POST http://localhost:8787/vault/xlm/withdraw/build-tx \
  -H 'content-type: application/json' \
  -d '{"user":"GCWHACNPCEV6FPANBP3WMHFSR3LXMZO5CNIZNEKEKV7PAM2TBJ5HEVTV","shares":"500000000000000","max_slippage_bps":100}' \
  | jq -r .xdr)
SIGNED=$(echo "$XDR" | stellar tx sign --sign-with-key admin --network testnet)
curl -s -X POST http://localhost:8787/tx/submit \
  -H 'content-type: application/json' \
  -d "{\"signed_xdr\":\"$SIGNED\"}" | jq
# returnValue → "500000000"  (50 XLM delivered back to admin)
```

## Promoting addresses after a redeploy

The deploy script (`scripts/deploy-testnet.sh`) writes
`scripts/deployed.testnet.env` with the freshly minted contract IDs. Manually
copy them into **both** of:

- `crates/addresses/src/lib.rs::TESTNET` (Rust)
- `api/src/addresses.ts::TESTNET` (TypeScript)

The duplication is intentional — addresses are an auditable surface and we
want each promotion to land in a reviewable commit, not an opaque codegen
step.

## Error shapes

All errors are `{ "error": "<message>" }` with the appropriate HTTP status:

| Code | When |
|------|------|
| 400  | Bad body / params, simulation error from the contract |
| 404  | Placeholder vault address (asset not deployed yet) |
| 500  | Unexpected exception bubbling up |

Contract errors come through the simulation path with their typed enum
discriminant — e.g., `SlippageExceeded` will surface as a 400 with the
contract error code embedded in the message.
