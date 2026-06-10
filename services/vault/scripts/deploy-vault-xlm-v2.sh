#!/usr/bin/env bash
# Baku — deploy vault-xlm v2 (with vault.rebalance) and wire Blend + Soroswap.
#
# Why a separate script (not deploy-testnet.sh + the wire scripts):
#   The vault contract gained a `rebalance` admin method this iteration. To
#   activate it we have to redeploy vault-xlm (Soroban contracts have no
#   in-place upgrade story without an UpgradeableContract pattern, which V0
#   doesn't ship). The existing vault-xlm holds ~101 XLM of admin test funds;
#   per Option B (2026-05-27 design decision), we leave the old vault as a
#   legacy address and stand up a v2 alongside.
#
# What this script does, in order:
#   1. Source the existing deployed.testnet.env (preserves USDC entries).
#   2. Build all contracts to WASM (idempotent).
#   3. Deploy MockStrategy(XLM) fresh — needed as `initial_strategy` for the
#      vault constructor; immediately drained by the strategy-switch below.
#   4. Deploy Vault(XLM)-v2 with Mock as initial.
#   5. Mock.set_vault(vault-v2) — rewire after mutual-deploy.
#   6. Deploy BlendStrategy(XLM) fresh — vault arg = vault-v2 (no rewire).
#   7. vault-v2.register_strategy(blend)
#      vault-v2.set_active_strategy(blend) — Mock is empty, so the V0
#      StrategyHasBalance check passes.
#   8. Deploy SoroswapStrategy(XLM) fresh — vault arg = vault-v2, paired_asset
#      = Circle's testnet USDC, pool = the XLM/Circle-USDC pair (verified by
#      scripts/soroswap-spike.sh).
#   9. vault-v2.register_strategy(soroswap)
#  10. Smoke reads: active, registry, total_assets.
#  11. Rewrite deployed.testnet.env with the new XLM-track addresses while
#      preserving USDC-track entries.
#
# After this:
#   - api/src/addresses.ts and crates/addresses/src/lib.rs MUST be updated to
#     point at the v2 vault + new strategies (see end-of-run hint).
#   - Old vault-xlm `CCDEEXUU…OLD` keeps its 101 XLM under v1 code (no
#     rebalance). It's still redeem-able by whoever holds the bkuXLM shares.
#
# Usage:
#   ./scripts/deploy-vault-xlm-v2.sh [IDENTITY]   # default IDENTITY=admin

set -euo pipefail

IDENTITY="${1:-admin}"
NETWORK="testnet"
STELLAR_CLI="${STELLAR_CLI:-$HOME/.cargo/bin/stellar}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/scripts/deployed.testnet.env"

if [[ ! -x "$STELLAR_CLI" ]]; then
  echo "stellar CLI not found at $STELLAR_CLI. Override with STELLAR_CLI=/path/to/stellar." >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE missing. Run scripts/deploy-testnet.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${XLM_SAC:?XLM_SAC not set in $ENV_FILE}"
: "${ADMIN_ADDR:?ADMIN_ADDR not set in $ENV_FILE}"

# Preserve the existing USDC entries verbatim — this script only touches the
# XLM track. We snapshot them now to write back after the new XLM deploys.
USDC_SAC_VAL="${USDC_SAC:-}"
BLEND_POOL_VAL="${BLEND_POOL:-}"
BLND_TOKEN_VAL="${BLND_TOKEN:-}"
BLEND_STRATEGY_USDC_VAL="${BLEND_STRATEGY_USDC:-}"
VAULT_USDC_VAL="${VAULT_USDC:-}"

# Verified-live Soroswap testnet addresses (smoke test 2026-05-27 via
# scripts/soroswap-spike.sh --probe + --swap-test).
SOROSWAP_ROUTER="CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
SOROSWAP_POOL_XLM_CIRCLE_USDC="CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS"
CIRCLE_USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

# Blend V2 testnet — re-used from the existing deployment.
BLEND_POOL_TESTNET="${BLEND_POOL_VAL:-CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF}"
BLND_TOKEN_TESTNET="${BLND_TOKEN_VAL:-CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF}"

cli_version="$("$STELLAR_CLI" -V | head -1 | awk '{print $2}')"
maj="${cli_version%%.*}"
min_full="${cli_version#*.}"
min="${min_full%%.*}"
if (( maj < 25 )) || (( maj == 25 && min < 2 )); then
  echo "stellar CLI $cli_version too old (need >= 25.2.0)." >&2
  exit 1
fi

echo "→ stellar $cli_version, identity=$IDENTITY, network=$NETWORK"
echo "→ admin              : $ADMIN_ADDR"
echo "→ XLM SAC            : $XLM_SAC"
echo "→ Circle USDC SAC    : $CIRCLE_USDC_SAC"
echo "→ Blend pool         : $BLEND_POOL_TESTNET"
echo "→ Soroswap router    : $SOROSWAP_ROUTER"
echo "→ Soroswap pair      : $SOROSWAP_POOL_XLM_CIRCLE_USDC"
echo "→ Preserving USDC    : vault=$VAULT_USDC_VAL"

# ── Step 1: Build ───────────────────────────────────────────────────────
echo ""
echo "── Step 1: Build all contracts ─────────────────────────────────"
(cd "$ROOT" && "$STELLAR_CLI" contract build > /dev/null)
MOCK_WASM="$ROOT/target/wasm32v1-none/release/baku_mock_strategy.wasm"
VAULT_WASM="$ROOT/target/wasm32v1-none/release/baku_vault.wasm"
BLEND_WASM="$ROOT/target/wasm32v1-none/release/baku_blend_strategy.wasm"
SOROSWAP_WASM="$ROOT/target/wasm32v1-none/release/baku_soroswap_strategy.wasm"
for w in "$MOCK_WASM" "$VAULT_WASM" "$BLEND_WASM" "$SOROSWAP_WASM"; do
  [[ -f "$w" ]] || { echo "missing $w" >&2; exit 1; }
done
echo "  built: 4 WASM artifacts"

# ── Step 2: Deploy MockStrategy(XLM) ────────────────────────────────────
echo ""
echo "── Step 2: Deploy MockStrategy(XLM) ────────────────────────────"
PLACEHOLDER_VAULT="$ADMIN_ADDR" # rewired in step 4
MOCK_STRATEGY_XLM="$("$STELLAR_CLI" contract deploy \
  --wasm "$MOCK_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --vault "$PLACEHOLDER_VAULT" \
  --asset "$XLM_SAC" \
  --initial_apy_bps 500 \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → MockStrategy(XLM): $MOCK_STRATEGY_XLM"

# ── Step 3: Deploy Vault(XLM) v2 ───────────────────────────────────────
echo ""
echo "── Step 3: Deploy Vault(XLM) v2 with rebalance ─────────────────"
VAULT_XLM_V2="$("$STELLAR_CLI" contract deploy \
  --wasm "$VAULT_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --asset "$XLM_SAC" \
  --initial_strategy "$MOCK_STRATEGY_XLM" \
  --name "Baku Staked XLM" \
  --symbol "bkuXLM" \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → Vault(XLM) v2: $VAULT_XLM_V2"

# ── Step 4: Rewire Mock → vault-v2 ──────────────────────────────────────
echo ""
echo "── Step 4: MockStrategy.set_vault(vault-v2) ────────────────────"
"$STELLAR_CLI" contract invoke \
  --id "$MOCK_STRATEGY_XLM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_vault \
  --admin "$ADMIN_ADDR" \
  --new_vault "$VAULT_XLM_V2"
echo "  ✓ Mock.vault → $VAULT_XLM_V2"

# ── Step 5: Deploy BlendStrategy(XLM) ───────────────────────────────────
echo ""
echo "── Step 5: Deploy BlendStrategy(XLM) ───────────────────────────"
# Constructor takes the vault directly (no rewire dance needed here).
BLEND_STRATEGY_XLM="$("$STELLAR_CLI" contract deploy \
  --wasm "$BLEND_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --vault "$VAULT_XLM_V2" \
  --asset "$XLM_SAC" \
  --blend_pool "$BLEND_POOL_TESTNET" \
  --blnd_token "$BLND_TOKEN_TESTNET" \
  --initial_apy_bps 500 \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → BlendStrategy(XLM): $BLEND_STRATEGY_XLM"

# ── Step 6: register + activate Blend ──────────────────────────────────
echo ""
echo "── Step 6: register + activate Blend on vault-v2 ───────────────"
"$STELLAR_CLI" contract invoke \
  --id "$VAULT_XLM_V2" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  register_strategy \
  --admin "$ADMIN_ADDR" \
  --strategy "$BLEND_STRATEGY_XLM"
echo "  ✓ registered Blend"

"$STELLAR_CLI" contract invoke \
  --id "$VAULT_XLM_V2" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  set_active_strategy \
  --admin "$ADMIN_ADDR" \
  --new_strategy "$BLEND_STRATEGY_XLM"
echo "  ✓ active → Blend"

# ── Step 7: Deploy SoroswapStrategy(XLM↔CircleUSDC) ─────────────────────
echo ""
echo "── Step 7: Deploy SoroswapStrategy(XLM↔CircleUSDC) ─────────────"
SOROSWAP_STRATEGY_XLM="$("$STELLAR_CLI" contract deploy \
  --wasm "$SOROSWAP_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  --admin "$ADMIN_ADDR" \
  --vault "$VAULT_XLM_V2" \
  --asset "$XLM_SAC" \
  --soroswap_pool "$SOROSWAP_POOL_XLM_CIRCLE_USDC" \
  --soroswap_router "$SOROSWAP_ROUTER" \
  --paired_asset "$CIRCLE_USDC_SAC" \
  --initial_apy_bps 500 \
  2>&1 | tee /dev/stderr | grep -oE 'C[A-Z0-9]{55}' | tail -1)"
echo "  → SoroswapStrategy(XLM): $SOROSWAP_STRATEGY_XLM"

# ── Step 8: register Soroswap ──────────────────────────────────────────
echo ""
echo "── Step 8: register Soroswap on vault-v2 ───────────────────────"
"$STELLAR_CLI" contract invoke \
  --id "$VAULT_XLM_V2" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- \
  register_strategy \
  --admin "$ADMIN_ADDR" \
  --strategy "$SOROSWAP_STRATEGY_XLM"
echo "  ✓ registered Soroswap"

# ── Step 9: Smoke reads ─────────────────────────────────────────────────
echo ""
echo "── Step 9: Smoke reads ─────────────────────────────────────────"
echo -n "  vault-v2.active_strategy()    = "
"$STELLAR_CLI" contract invoke --id "$VAULT_XLM_V2" --source "$IDENTITY" --network "$NETWORK" -- active_strategy
echo -n "  vault-v2.strategy_registry()  = "
"$STELLAR_CLI" contract invoke --id "$VAULT_XLM_V2" --source "$IDENTITY" --network "$NETWORK" -- strategy_registry
echo -n "  vault-v2.total_assets()       = "
"$STELLAR_CLI" contract invoke --id "$VAULT_XLM_V2" --source "$IDENTITY" --network "$NETWORK" -- total_assets
echo -n "  soroswap.current_value()      = "
"$STELLAR_CLI" contract invoke --id "$SOROSWAP_STRATEGY_XLM" --source "$IDENTITY" --network "$NETWORK" -- current_value

# ── Step 10: Rewrite env (preserve USDC entries) ────────────────────────
echo ""
echo "── Step 10: Rewrite $ENV_FILE ──────────────────────────────────"
cat > "$ENV_FILE" <<EOF
# Auto-written by scripts/deploy-vault-xlm-v2.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Source from the API: \`source scripts/deployed.testnet.env\`
NETWORK=$NETWORK
ADMIN_ADDR=$ADMIN_ADDR
XLM_SAC=$XLM_SAC
USDC_SAC=$USDC_SAC_VAL
BLEND_POOL=$BLEND_POOL_TESTNET
BLND_TOKEN=$BLND_TOKEN_TESTNET

# --- XLM track v2 (with vault.rebalance) ---
VAULT_XLM=$VAULT_XLM_V2
MOCK_STRATEGY_XLM=$MOCK_STRATEGY_XLM
BLEND_STRATEGY_XLM=$BLEND_STRATEGY_XLM
SOROSWAP_STRATEGY_XLM=$SOROSWAP_STRATEGY_XLM

# --- Soroswap shared addresses ---
SOROSWAP_ROUTER=$SOROSWAP_ROUTER
SOROSWAP_POOL_XLM_CIRCLE_USDC=$SOROSWAP_POOL_XLM_CIRCLE_USDC
CIRCLE_USDC_SAC=$CIRCLE_USDC_SAC

# --- USDC track (preserved from prior deploy; untouched by v2) ---
VAULT_USDC=$VAULT_USDC_VAL
BLEND_STRATEGY_USDC=$BLEND_STRATEGY_USDC_VAL
EOF

cat "$ENV_FILE"

echo ""
echo "── Done. ───────────────────────────────────────────────────────"
echo ""
echo "Old vault-xlm (legacy, no rebalance): CCDEEXUU25RUOZVSYCSJPX35QKPZTDBAT6UFW6GTC633LV3TLOXMDOLD"
echo "New vault-xlm v2:                     $VAULT_XLM_V2"
echo "Active strategy:                      Blend"
echo "Registry:                             [Mock, Blend, Soroswap]"
echo ""
echo "Next:"
echo "  1. Promote addresses into api/src/addresses.ts and"
echo "     crates/addresses/src/lib.rs (vaultXlm, blendStrategyXlm,"
echo "     soroswapStrategyXlm, plus the Circle USDC + Soroswap pool/router)"
echo "  2. Restart the API so it picks up the new vault address"
echo "  3. Demo rotation: stellar contract invoke --id $VAULT_XLM_V2 \\"
echo "       --source admin --network testnet \\"
echo "       -- rebalance --admin $ADMIN_ADDR --to_strategy $SOROSWAP_STRATEGY_XLM"
